'use strict';

/**
 * Browser Identity service — the single place that decides WHICH browser CupNet claims to be
 * and pushes that decision into every layer:
 *
 *   MITM (wire)      → mitm.setIdentity / setTabIdentity (User-Agent, sec-ch-ua*, Accept-Language),
 *                      mitm.setBrowser / setActiveJa3 / setForceHttp1 (TLS + HTTP/2 fingerprint)
 *   Chromium session → session.setUserAgent(ua, acceptLanguage) (navigator.userAgent, workers)
 *   CDP (per tab)    → Emulation.setUserAgentOverride + userAgentMetadata (navigator.userAgentData,
 *                      navigator.platform, Chromium-emitted hints), setTimezoneOverride, setLocaleOverride
 *   Main world       → tiny navigator patch for non-Chromium identities (preload-view early inject)
 *
 * Precedence: per-tab proxy profile override > connected global proxy profile override
 *             > proxy geo hint (timezone / language only, when identity.followProxyGeo)
 *             > global identity (settings.identity) > engine (no override).
 * Engine mode still gets an "engine wire identity" on the MITM path (sanitized engine UA + client hints of
 * the running engine) when identity.engineHints is on. By default (identity.engineBrand = 'chrome') the
 * hints present the engine as Google Chrome, and a CDP UA-metadata override makes navigator.userAgentData
 * say the same; engineBrand = 'chromium' keeps the unbranded 2-brand list and no override.
 *
 * `ctx.activeFingerprint` is kept as a derived mirror `{user_agent, timezone, language}` for
 * legacy readers; nothing else should write it.
 *
 * Unit tests: tests/unit/identity-service.test.mjs
 */

const catalog = require('../../browser-identity-catalog');
const { applyRendererUserAgentToSession, resolveRendererUserAgent } = require('../../user-agent-utils');
const { previewIdentityHeaders } = require('../../identity-headers');
const { geoHintFromLookup } = require('../../geo-locale-defaults');
const { buildConsistencyScript, seedFromString } = require('./identity-consistency-script');

const SETTINGS_KEY = 'identity';

function _cdpEnabled() {
    return process.env.CUPNET_IDENTITY_CDP !== '0' && process.env.CUPNET_DISABLE_FINGERPRINT !== '1';
}

/**
 * @param {object} d
 * @param {() => object} d.loadSettings
 * @param {(s: object) => void} d.saveSettings
 * @param {() => object|null} d.getMitmProxy
 * @param {() => object|null} d.getTabManager
 * @param {(fp: object|null) => void} [d.setActiveFingerprint] - mirror for legacy readers
 * @param {(channel: string, payload: any) => void} [d.broadcast] - to all shell windows
 * @param {(profile: string) => void} [d.broadcastTlsProfileChanged]
 * @param {(wc: object, tabId: string) => Promise<void>} [d.ensureCdpAttached] - attaches the tab debugger (network-logging path)
 * @param {Function} d.sysLog
 * @param {Function} d.safeCatch
 */
function createIdentityService(d) {
    const sysLog = d.sysLog || (() => {});
    const safeCatch = d.safeCatch || (() => {});

    /** Connected global proxy profile row with identity_override=1 (or null). */
    let _proxyOverrideRow = null;
    /** Egress geo of the connected proxy ({country, timezone, language}) — used when followProxyGeo is on. */
    let _geoHint = null;
    /** tabId → proxy profile row with identity_override=1. */
    const _tabOverrideRows = new Map();
    /** Cache of the last applied per-webContents identity signature (skip redundant CDP calls). */
    const _appliedSig = new WeakMap();

    // ── settings ────────────────────────────────────────────────────────────────
    function getSettings() {
        const s = d.loadSettings() || {};
        const raw = s[SETTINGS_KEY];
        const norm = catalog.normalizeIdentitySettings(raw);
        // Legacy: settings.tlsProfile was the only TLS setting before the identity split.
        if (!raw && catalog.isValidTlsProfile(s.tlsProfile)) norm.tlsProfile = s.tlsProfile;
        return norm;
    }

    function setSettings(patch, opts = {}) {
        const s = d.loadSettings() || {};
        const p = patch && typeof patch === 'object' ? patch : {};
        const next = { ...getSettings(), ...p };
        // Picking a template / custom UA without an explicit TLS choice → TLS follows the identity.
        if (p.tlsProfile === undefined && next.mode !== 'engine'
            && (p.templateId !== undefined || p.mode !== undefined || p.userAgent !== undefined)) {
            next.tlsProfile = null;
        }
        const merged = catalog.normalizeIdentitySettings(next);
        s[SETTINGS_KEY] = merged;
        // Mirror the TLS profile into the legacy key (startup wiring + get-tls-profile IPC).
        s.tlsProfile = catalog.resolveIdentity(merged).tlsProfile;
        d.saveSettings(s);
        if (!opts.skipApply) return applyEffective({ reason: opts.reason || 'settings' }).then(() => merged);
        return Promise.resolve(merged);
    }

    // ── resolution ──────────────────────────────────────────────────────────────
    function getGlobalResolved() {
        return catalog.resolveIdentity(getSettings());
    }

    /** Global identity + the proxy geo hint (timezone / language) when the user opted in. */
    function _globalWithGeo() {
        const base = getGlobalResolved();
        if (_geoHint && getSettings().followProxyGeo) {
            return {
                ...base,
                timezone: _geoHint.timezone || base.timezone,
                language: _geoHint.language || base.language,
            };
        }
        return base;
    }

    /** Effective global identity (proxy override on top of the global settings + geo hint). */
    function getEffective() {
        const base = _globalWithGeo();
        if (_proxyOverrideRow) return catalog.resolveIdentityFromProfileRow(_proxyOverrideRow, base);
        return base;
    }

    function getEffectiveForTab(tabId) {
        const eff = getEffective();
        const row = tabId ? _tabOverrideRows.get(String(tabId)) : null;
        return row ? catalog.resolveIdentityFromProfileRow(row, eff) : eff;
    }

    /** "global" | "proxy-profile" | "tab-profile" — where the effective identity comes from. */
    function getSource(tabId) {
        if (tabId && _tabOverrideRows.has(String(tabId))) return 'tab-profile';
        if (_proxyOverrideRow) return 'proxy-profile';
        return 'global';
    }

    function _toLegacyFingerprint(resolved) {
        if (!resolved) return null;
        if (resolved.mode === 'engine' && !resolved.timezone && !resolved.language) return null;
        return {
            user_agent: resolved.userAgent || null,
            timezone: resolved.timezone || null,
            language: resolved.language || null,
        };
    }

    function _sig(resolved) {
        return JSON.stringify([resolved.mode, resolved.userAgent, resolved.timezone, resolved.language, resolved.navigatorPlatform,
            resolved.clientHints ? resolved.clientHints.brands : null, _engineNeedsUaMetadata(resolved)]);
    }

    /** Chromium major of the running engine: from the engine UA (what goes on the wire), else process.versions. */
    let _nativeLanguages = null;
    /**
     * The language list the engine itself exposes as `navigator.languages` in EVERY realm (page, iframes,
     * workers): Electron builds it from the app locale + the OS preferred languages
     * (e.g. ["ru","ru-BY","en-BY","pl-BY"]) and there is no switch to change it for workers. So without an
     * explicit identity language we keep this list everywhere and derive the wire Accept-Language from it
     * the way Chrome does, instead of overriding the page only (which made page ≠ worker ≠ wire).
     * @returns {string[]}
     */
    function nativeLanguageList() {
        if (_nativeLanguages) return _nativeLanguages.slice();
        let list = [];
        try {
            const electron = require('electron');
            const app = electron && typeof electron === 'object' ? electron.app : null;
            const locale = app && typeof app.getLocale === 'function' ? String(app.getLocale() || '') : '';
            const pref = app && typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [];
            list = [locale, ...(Array.isArray(pref) ? pref : [])];
        } catch { list = []; }
        const out = [];
        for (const raw of list) {
            const code = String(raw || '').replace(/_/g, '-').trim();
            if (!code || !/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(code)) continue;
            if (!out.some((c) => c.toLowerCase() === code.toLowerCase())) out.push(code);
        }
        _nativeLanguages = out.length ? out : ['en-US'];
        return _nativeLanguages.slice();
    }

    /**
     * Accept-Language when the identity has no explicit language: Chrome's header for the engine's own
     * language list (see nativeLanguageList), so the wire agrees with navigator.languages everywhere.
     * An explicit default is still required because the session keeps its previous Accept-Language
     * (setUserAgent(ua, '') keeps the previous value — A-059).
     */
    let _defaultAcceptLanguage = null;
    function defaultAcceptLanguage() {
        if (_defaultAcceptLanguage) return _defaultAcceptLanguage;
        _defaultAcceptLanguage = catalog.chromeAcceptLanguageHeader(nativeLanguageList()) || 'en-US,en;q=0.9';
        return _defaultAcceptLanguage;
    }

    /** Language codes for the Chromium side: the explicit identity language, else the engine's own list. */
    function _languageCodes(resolved) {
        return resolved && resolved.language ? catalog.acceptLanguageCodes(resolved.language) : nativeLanguageList();
    }

    function _engineChromiumMajor(ua) {
        const fromUa = parseInt((String(ua || resolveRendererUserAgent(null) || '').match(/Chrome\/(\d+)/) || [])[1], 10);
        if (Number.isFinite(fromUa) && fromUa > 0) return fromUa;
        const v = process.versions && process.versions.chrome;
        const m = v ? parseInt(String(v).split('.')[0], 10) : NaN;
        return Number.isFinite(m) ? m : 0;
    }

    /**
     * What the MITM should put on the wire for a resolved identity:
     *   - template / custom → the identity itself;
     *   - engine + engineHints → the sanitized engine UA plus the real engine's 2-brand hints
     *     (Electron emits no sec-ch-ua at all, so without this the wire and JS disagree);
     *   - engine without hints → null (legacy sanitize only).
     */
    function getWireIdentity(resolved) {
        if (!resolved) return null;
        const language = catalog.formatAcceptLanguageHeader(resolved.language || defaultAcceptLanguage()) || null;
        if (resolved.mode !== 'engine') return resolved.userAgent ? { ...resolved, language } : null;
        if (!getSettings().engineHints) return null;
        const eng = _engineHints();
        if (!eng) return null;
        return {
            ...resolved,
            userAgent: eng.ua,
            language,
            clientHints: eng.hints,
            navigatorPlatform: null,
            engineSynthesized: true,
        };
    }

    /**
     * Engine-mode client hints: the running engine's version/OS/arch, presented as Google Chrome unless
     * identity.engineBrand === 'chromium' (owner decision 2026-09-27). fullVersionList carries the real
     * engine version (process.versions.chrome), as a real Chrome build does.
     * @returns {{ ua: string, hints: object }|null}
     */
    function _engineHints(settings = getSettings()) {
        const ua = resolveRendererUserAgent(null);
        const major = _engineChromiumMajor(ua);
        if (!ua || !major) return null;
        return {
            ua,
            hints: catalog.engineClientHints({
                chromiumMajor: major,
                nodePlatform: process.platform,
                arch: process.arch,
                branded: settings.engineBrand !== 'chromium',
                fullVersion: (process.versions && process.versions.chrome) || '',
                // Real OS version (Chrome on macOS reports e.g. "15.7.9"); Windows/Linux keep the defaults.
                platformVersion: process.platform === 'darwin' && typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
            }),
        };
    }

    /**
     * Engine mode presenting as Google Chrome must also override navigator.userAgentData (CDP),
     * otherwise JavaScript keeps reporting Electron's unbranded Chromium list while the wire says Chrome.
     */
    function _engineNeedsUaMetadata(resolved, settings = getSettings()) {
        return !!resolved && resolved.mode === 'engine' && settings.engineHints !== false && settings.engineBrand !== 'chromium';
    }

    /** Whether a tab needs CDP Emulation.* for this identity (UA/metadata, timezone or locale). */
    function needsCdpEmulation(resolved) {
        if (!resolved) return false;
        return resolved.mode !== 'engine' || !!resolved.timezone || !!resolved.language || _engineNeedsUaMetadata(resolved);
    }

    // ── application ─────────────────────────────────────────────────────────────
    function _applyToMitm() {
        const mitm = d.getMitmProxy?.();
        if (!mitm) return;
        const eff = getEffective();
        try {
            mitm.clearClientHintsCache?.();
            mitm.setBrowser?.(eff.tlsProfile);
            if (typeof mitm.setActiveJa3 === 'function') mitm.setActiveJa3(eff.ja3);
            else mitm._activeJa3 = eff.ja3;
            mitm.setForceHttp1?.(eff.forceHttp1);
            mitm.setIdentity?.(getWireIdentity(eff));
            for (const [tabId, row] of _tabOverrideRows) {
                const tabEff = catalog.resolveIdentityFromProfileRow(row, eff);
                mitm.setTabIdentity?.(tabId, getWireIdentity(tabEff));
            }
        } catch (e) {
            safeCatch({ module: 'main', eventCode: 'identity.mitm.apply.failed' }, e, 'warn');
        }
    }

    /**
     * Apply an identity to one tab's Chromium side (session UA + CDP emulation).
     * @param {object} wc - webContents
     * @param {import('../../browser-identity-catalog').ResolvedIdentity} resolved
     */
    async function applyToWebContents(wc, resolved, { tabId } = {}) {
        if (!wc || wc.isDestroyed?.()) return;
        if (process.env.CUPNET_DISABLE_FINGERPRINT === '1') return;
        const sig = _sig(resolved);
        try {
            // Session level: Accept-Language for the whole partition + UA for WebContents created later.
            applyRendererUserAgentToSession(wc.session, resolved.userAgent || null, _languageCodes(resolved).join(','));
            // WebContents level: Electron snapshots the session UA into each WebContents at creation
            // (webContents.getUserAgent()), so an existing tab keeps its old UA unless set here.
            if (typeof wc.setUserAgent === 'function') {
                const ua = resolveRendererUserAgent(resolved.userAgent || null);
                if (ua && wc.getUserAgent?.() !== ua) wc.setUserAgent(ua);
            }
        } catch (e) {
            sysLog('warn', 'identity', 'setUserAgent failed: ' + (e?.message || e));
        }
        if (!_cdpEnabled()) return;
        const needsCdp = needsCdpEmulation(resolved);
        const dbg = wc.debugger;
        if (!dbg) return;
        if (!dbg.isAttached()) {
            if (!needsCdp) return; // nothing to clear
            // Attach here and queue the Emulation.* commands BEFORE the network-logging setup: commands
            // queued on a fresh WebContents are applied when its renderer starts, i.e. before the first
            // document runs any script. The logging path awaits Network.enable first, which only resolves
            // once the renderer exists — putting the identity after it lost the race against fast loads
            // (file:// pages showed the engine's userAgentData).
            try { dbg.attach('1.3'); } catch (e) { sysLog('info', 'identity', 'cdp attach skipped: ' + (e?.message || e)); return; }
            const emulation = applyCdpEmulation(dbg, resolved, { tabId });
            _appliedSig.set(wc, sig);
            if (typeof d.ensureCdpAttached === 'function') {
                try { await d.ensureCdpAttached(wc, tabId); } catch (e) { sysLog('info', 'identity', 'cdp logging setup skipped: ' + (e?.message || e)); }
            }
            await emulation;
            return;
        }
        if (_appliedSig.get(wc) === sig) return;
        await applyCdpEmulation(dbg, resolved, { tabId });
        _appliedSig.set(wc, sig);
    }

    /**
     * Send the CDP Emulation commands for an identity on an already attached debugger.
     * Exposed so cdp-network-logging can (re)apply after its own attach.
     */
    async function applyCdpEmulation(dbg, resolved, { tabId } = {}) {
        const send = async (cmd, params) => {
            try { await dbg.sendCommand(cmd, params); } catch (e) {
                safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: cmd, tabId } }, e, 'info');
            }
        };
        // All commands are dispatched synchronously (no await in between) so they sit in the session
        // queue in this order even when the renderer does not exist yet (fresh tab, see applyToWebContents).
        const pending = [];
        if (resolved.mode !== 'engine' && resolved.userAgent) {
            // acceptLanguage: language codes — Chromium derives navigator.languages from this list
            // (the wire header itself is rewritten by the MITM from the identity language).
            const params = {
                userAgent: resolved.userAgent,
                // Only an explicit identity language overrides navigator.languages: CDP reaches the page's
                // frames but not its workers, so the engine's own list is kept otherwise (consistent everywhere).
                acceptLanguage: resolved.language ? _languageCodes(resolved).join(',') : undefined,
                platform: resolved.navigatorPlatform || undefined,
            };
            const md = catalog.buildCdpUserAgentMetadata(resolved.clientHints);
            if (md) params.userAgentMetadata = md;
            pending.push(send('Emulation.setUserAgentOverride', params));
        } else if (_engineNeedsUaMetadata(resolved) && _engineHints()) {
            // Engine as Google Chrome: same UA the session already has, plus the branded metadata, so
            // navigator.userAgentData matches the sec-ch-ua the MITM puts on the wire.
            const eng = _engineHints();
            pending.push(send('Emulation.setUserAgentOverride', {
                userAgent: eng.ua,
                // Only an explicit identity language overrides navigator.languages: CDP reaches the page's
                // frames but not its workers, so the engine's own list is kept otherwise (consistent everywhere).
                acceptLanguage: resolved.language ? _languageCodes(resolved).join(',') : undefined,
                userAgentMetadata: catalog.buildCdpUserAgentMetadata(eng.hints),
            }));
        } else {
            // Clear a previous override (empty userAgent = no override).
            pending.push(send('Emulation.setUserAgentOverride', { userAgent: '' }));
        }
        pending.push(send('Emulation.setTimezoneOverride', { timezoneId: resolved.timezone || '' }));
        const primaryLocale = resolved.language ? String(resolved.language).split(',')[0].split(';')[0].trim() : '';
        pending.push(send('Emulation.setLocaleOverride', primaryLocale ? { locale: primaryLocale } : {}));
        await Promise.all(pending);
    }

    async function applyToAllTabs() {
        const tm = d.getTabManager?.();
        if (!tm) return;
        for (const tab of tm.getAllTabs?.() || []) {
            const wc = tab?.view?.webContents;
            if (!wc || wc.isDestroyed()) continue;
            await applyToWebContents(wc, getEffectiveForTab(tab.id), { tabId: tab.id }).catch((e) => {
                safeCatch({ module: 'main', eventCode: 'identity.apply.failed', context: { tabId: tab.id } }, e, 'info');
            });
        }
    }

    let _applyChain = Promise.resolve();
    /** Push the effective identity into MITM + every tab; serialized. */
    function applyEffective({ reason } = {}) {
        _applyChain = _applyChain.then(async () => {
            _applyToMitm();
            const eff = getEffective();
            d.setActiveFingerprint?.(_toLegacyFingerprint(eff));
            await applyToAllTabs();
            d.broadcastTlsProfileChanged?.(eff.tlsProfile);
            d.broadcast?.('identity-changed', getStatus());
            sysLog('info', 'identity', `applied (${reason || 'unspecified'}): ${catalog.describeIdentity(eff)} · tls=${eff.tlsProfile} · source=${getSource()}`);
        }).catch((e) => {
            safeCatch({ module: 'main', eventCode: 'identity.apply.failed', context: { reason } }, e, 'warn');
        });
        return _applyChain;
    }

    // ── overrides from proxy profiles ───────────────────────────────────────────
    /** Global proxy profile connected → its identity override (or null on disconnect). */
    function setProxyOverride(row, opts = {}) {
        _proxyOverrideRow = row && (row.identity_override == null || row.identity_override) ? { ...row } : null;
        if (opts.skipApply) return Promise.resolve();
        return applyEffective({ reason: opts.reason || (row ? 'proxy-connect' : 'proxy-disconnect') });
    }

    /** Per-tab proxy profile → per-tab identity override (null clears). */
    async function setTabOverride(tabId, row, opts = {}) {
        if (!tabId) return;
        const key = String(tabId);
        if (row && (row.identity_override == null || row.identity_override)) _tabOverrideRows.set(key, { ...row });
        else _tabOverrideRows.delete(key);
        const mitm = d.getMitmProxy?.();
        const tabEff = getEffectiveForTab(key);
        try { mitm?.setTabIdentity?.(key, _tabOverrideRows.has(key) ? getWireIdentity(tabEff) : null); } catch { /* ignore */ }
        if (opts.skipApply) return;
        const tm = d.getTabManager?.();
        const tab = tm?.getTab?.(key);
        const wc = tab?.view?.webContents;
        if (wc && !wc.isDestroyed()) await applyToWebContents(wc, tabEff, { tabId: key }).catch(() => {});
    }

    function clearTabOverride(tabId) {
        const key = String(tabId || '');
        if (!key) return;
        _tabOverrideRows.delete(key);
        try { d.getMitmProxy?.()?.setTabIdentity?.(key, null); } catch { /* ignore */ }
    }

    /**
     * Egress geo of the connected proxy (from check-ip-geo). Only used when identity.followProxyGeo
     * is on; kept regardless so toggling the setting applies immediately.
     * @param {{ country?: string, timezone?: string }|null} geo
     */
    function setGeoHint(geo, opts = {}) {
        const next = geo ? geoHintFromLookup(geo) : null;
        const changed = JSON.stringify(next) !== JSON.stringify(_geoHint);
        _geoHint = next;
        if (opts.skipApply || !changed || !getSettings().followProxyGeo) return Promise.resolve();
        return applyEffective({ reason: opts.reason || 'geo-hint' });
    }

    function getGeoHint() {
        return _geoHint ? { ..._geoHint } : null;
    }

    // ── hooks for tab-manager / preload ─────────────────────────────────────────
    /** UA + Accept-Language for a freshly created tab session (before any navigation). */
    function getIdentityForNewTab(tabId) {
        const eff = getEffectiveForTab(tabId);
        return { userAgent: eff.userAgent || null, language: _languageCodes(eff).join(',') };
    }

    /** Called by the runtime once a tab exists: CDP emulation for non-engine identities. */
    async function onTabCreated(tab) {
        const wc = tab?.view?.webContents;
        if (!wc || wc.isDestroyed()) return;
        const eff = getEffectiveForTab(tab.id);
        if (!needsCdpEmulation(eff)) return;
        await applyToWebContents(wc, eff, { tabId: tab.id }).catch(() => {});
    }

    /**
     * Main-world patch for a tab (returned to preload-view via sync IPC). Chromium still exposes
     * `navigator.userAgentData` even when the UA override describes Firefox/Safari; those browsers
     * do not have it at all, so hide it. Returns null when nothing needs patching.
     */
    function getNavigatorPatchScript(tabId, extra = {}) {
        if (process.env.CUPNET_DISABLE_FINGERPRINT === '1') return null;
        const eff = getEffectiveForTab(tabId);
        // Chromium-family identity ⟺ client hints resolved. Engine mode has no UA override but still
        // rides Electron's empty window.chrome, so it counts as Chromium here (fill only, no WebGL spoof).
        const chromium = eff.mode === 'engine' || !!eff.clientHints;
        if (eff.mode !== 'engine' && !eff.userAgent) return null;
        const mobile = !!eff.mobile;
        // navigator.languages must match the wire Accept-Language. Parse the identity's language
        // ("ru,en-US;q=0.9,en" → ["ru","en-US","en"]); empty for engine mode with no explicit
        // language, where the genuine device values are kept (honest).
        const languages = String(eff.language || '')
            .split(',')
            .map((t) => t.split(';')[0].trim())
            .filter(Boolean);
        return buildConsistencyScript({
            chromium,
            navigatorPlatform: eff.navigatorPlatform,
            hostNodePlatform: process.platform,
            fillChrome: true,
            languages,
            removeUserAgentData: !chromium, // non-Chromium: Chromium still leaks navigator.userAgentData
            // Hardware fields: a template/custom identity claims another machine, so pin plausible values.
            // Engine mode is the genuine device and keeps the real values — current Chrome (153) reports
            // the real rounded RAM (e.g. 16), so the old "cap at 8" made CupNet differ from Chrome on the
            // same machine (owner decision 2026-09-27).
            hardware: chromium && eff.mode !== 'engine',
            deviceMemory: 8,
            hardwareConcurrency: mobile ? 8 : 8,
            // Canvas/audio farbling only for a spoofing identity (template/custom), keyed off the identity
            // so it is stable per identity; engine mode stays the genuine device.
            farble: chromium && eff.mode !== 'engine',
            seed: seedFromString(eff.userAgent || eff.templateId || 'engine'),
            permissionDecisions: extra && extra.permissionDecisions ? extra.permissionDecisions : null,
        });
    }

    // ── status for UI ───────────────────────────────────────────────────────────
    function getStatus(tabId) {
        const settings = getSettings();
        const global = getGlobalResolved();
        const effective = tabId ? getEffectiveForTab(tabId) : getEffective();
        return {
            settings,
            global: { ...global, description: catalog.describeIdentity(global) },
            effective: { ...effective, description: catalog.describeIdentity(effective), headers: previewIdentityHeaders(getWireIdentity(effective)) },
            source: getSource(tabId),
            proxyOverrideName: _proxyOverrideRow?.name || null,
            proxyOverrideId: _proxyOverrideRow?.id != null ? _proxyOverrideRow.id : null,
            geoHint: getGeoHint(),
            geoApplied: !!(_geoHint && settings.followProxyGeo && !_proxyOverrideRow),
            cdpEnabled: _cdpEnabled(),
            engineChromiumMajor: _engineChromiumMajor(),
        };
    }

    /** Resolve arbitrary settings (editor preview) without applying them. */
    function preview(settings) {
        const norm = catalog.normalizeIdentitySettings(settings);
        const resolved = catalog.resolveIdentity(norm);
        let wire = resolved;
        if (resolved.mode === 'engine') {
            const eng = norm.engineHints ? _engineHints(norm) : null;
            wire = eng ? { ...resolved, userAgent: eng.ua, clientHints: eng.hints } : null;
        }
        if (wire) wire = { ...wire, language: catalog.formatAcceptLanguageHeader(resolved.language || defaultAcceptLanguage()) || null };
        return { ...resolved, description: catalog.describeIdentity(resolved), headers: previewIdentityHeaders(wire) };
    }

    return {
        SETTINGS_KEY,
        getSettings,
        setSettings,
        getGlobalResolved,
        getEffective,
        getEffectiveForTab,
        getSource,
        getStatus,
        preview,
        needsCdpEmulation,
        applyEffective,
        applyToWebContents,
        applyCdpEmulation,
        setProxyOverride,
        setTabOverride,
        clearTabOverride,
        setGeoHint,
        getGeoHint,
        getWireIdentity,
        getIdentityForNewTab,
        defaultAcceptLanguage,
        nativeLanguageList,
        onTabCreated,
        getNavigatorPatchScript,
        listTemplates: catalog.listTemplates,
        _catalog: catalog,
    };
}

module.exports = { createIdentityService, SETTINGS_KEY };
