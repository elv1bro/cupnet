'use strict';

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createIdentityService } = require('../../main-process/services/identity-service.js');
const catalog = require('../../browser-identity-catalog.js');

/** Minimal fakes for mitm, tabs, debugger and settings. */
function makeWorld({ attached = true } = {}) {
    let settings = { tlsProfile: 'chrome' };
    const mitm = {
        browser: 'chrome', _activeJa3: null, forceHttp1: false, identity: null, tabIdentity: new Map(), clears: 0,
        setBrowser(p) { if (p !== this.browser) { this.browser = p; this.clears++; } },
        setActiveJa3(j) { this._activeJa3 = j; },
        setForceHttp1(v) { this.forceHttp1 = !!v; },
        setIdentity(i) { this.identity = i; },
        setTabIdentity(t, i) { if (i) this.tabIdentity.set(t, i); else this.tabIdentity.delete(t); },
    };
    const cdpCalls = [];
    function makeTab(id) {
        const session = { ua: null, lang: null, setUserAgent(ua, lang) { this.ua = ua; this.lang = lang; }, getUserAgent() { return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.210 Electron/34.5.8 Safari/537.36'; } };
        const dbg = {
            _attached: attached,
            isAttached() { return this._attached; },
            attach() { this._attached = true; },
            async sendCommand(cmd, params) { cdpCalls.push({ tab: id, cmd, params }); },
        };
        const wc = { session, debugger: dbg, isDestroyed: () => false, ua: null, getUserAgent() { return this.ua; }, setUserAgent(ua) { this.ua = ua; } };
        return { id, view: { webContents: wc } };
    }
    const tabs = new Map([['t1', makeTab('t1')], ['t2', makeTab('t2')]]);
    const tabManager = { getAllTabs: () => tabs.values(), getTab: (id) => tabs.get(id) };
    const broadcasts = [];
    let activeFp = 'unset';
    const svc = createIdentityService({
        loadSettings: () => settings,
        saveSettings: (s) => { settings = s; },
        getMitmProxy: () => mitm,
        getTabManager: () => tabManager,
        setActiveFingerprint: (fp) => { activeFp = fp; },
        broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
        broadcastTlsProfileChanged: (p) => broadcasts.push({ ch: 'tls', payload: p }),
        ensureCdpAttached: async (wc) => { wc.debugger.attach(); },
        sysLog: () => {},
        safeCatch: () => {},
    });
    return { svc, mitm, tabs, cdpCalls, broadcasts, get settings() { return settings; }, get activeFp() { return activeFp; } };
}

describe('identity-service: settings and resolution', () => {
    it('defaults to engine mode, honouring the legacy tlsProfile setting', () => {
        const w = makeWorld();
        const s = w.svc.getSettings();
        expect(s.mode).toBe('engine');
        expect(s.tlsProfile).toBe('chrome');
        expect(w.svc.getEffective().userAgent).toBeNull();
        expect(w.svc.getSource()).toBe('global');
    });

    it('setSettings normalizes, persists, mirrors tlsProfile and applies everywhere', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'firefox-win', timezone: 'Europe/Berlin', language: 'de-DE,de;q=0.9' });
        expect(w.settings.identity.mode).toBe('template');
        expect(w.settings.tlsProfile).toBe('firefox');
        // MITM
        expect(w.mitm.browser).toBe('firefox');
        expect(w.mitm.identity.userAgent).toBe(catalog.UA.firefoxWin);
        expect(w.mitm.forceHttp1).toBe(false);
        // sessions
        for (const t of w.tabs.values()) {
            expect(t.view.webContents.session.ua).toBe(catalog.UA.firefoxWin);
            expect(t.view.webContents.session.lang).toBe('de-DE,de'); // codes only — Electron adds q-values
            expect(t.view.webContents.ua).toBe(catalog.UA.firefoxWin);
        }
        // CDP
        const uaCalls = w.cdpCalls.filter((c) => c.cmd === 'Emulation.setUserAgentOverride');
        expect(uaCalls.length).toBe(2);
        expect(uaCalls[0].params.userAgent).toBe(catalog.UA.firefoxWin);
        expect(uaCalls[0].params.userAgentMetadata).toBeUndefined();
        expect(uaCalls[0].params.platform).toBe('Win32');
        expect(w.cdpCalls.find((c) => c.cmd === 'Emulation.setTimezoneOverride').params.timezoneId).toBe('Europe/Berlin');
        expect(w.cdpCalls.find((c) => c.cmd === 'Emulation.setLocaleOverride').params.locale).toBe('de-DE');
        // legacy mirror + broadcasts
        expect(w.activeFp).toEqual({ user_agent: catalog.UA.firefoxWin, timezone: 'Europe/Berlin', language: 'de-DE,de;q=0.9' });
        expect(w.broadcasts.some((b) => b.ch === 'identity-changed')).toBe(true);
        expect(w.broadcasts.some((b) => b.ch === 'tls' && b.payload === 'firefox')).toBe(true);
    });

    it('Chromium template sends userAgentMetadata to CDP', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-android' });
        const call = w.cdpCalls.find((c) => c.cmd === 'Emulation.setUserAgentOverride');
        expect(call.params.userAgentMetadata.platform).toBe('Android');
        expect(call.params.userAgentMetadata.mobile).toBe(true);
        expect(call.params.userAgentMetadata.brands.length).toBe(3);
    });

    it('switching back to engine clears overrides (empty UA, empty tz, empty locale)', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-win', timezone: 'UTC' });
        w.cdpCalls.length = 0;
        await w.svc.setSettings({ mode: 'engine', timezone: '' });
        // Engine mode still carries the synthesized engine wire identity (real engine UA + hints).
        expect(w.mitm.identity.mode).toBe('engine');
        expect(w.mitm.identity.engineSynthesized).toBe(true);
        expect(w.mitm.identity.userAgent).not.toMatch(/Windows|Firefox/);
        expect(w.activeFp).toBeNull();
        // Default engine brand = Google Chrome: the override keeps the engine UA and swaps in branded
        // userAgentMetadata so navigator.userAgentData matches the wire (owner decision 2026-09-27).
        const ua = w.cdpCalls.find((c) => c.cmd === 'Emulation.setUserAgentOverride');
        expect(ua.params.userAgent).toMatch(/Chrome\/\d+\.0\.0\.0/);
        expect(ua.params.userAgent).not.toMatch(/Windows|Firefox|Electron/);
        expect(ua.params.userAgentMetadata.brands.map((b) => b.brand)).toContain('Google Chrome');
        expect(w.cdpCalls.find((c) => c.cmd === 'Emulation.setTimezoneOverride').params.timezoneId).toBe('');
        expect(w.cdpCalls.find((c) => c.cmd === 'Emulation.setLocaleOverride').params).toEqual({});
        // Outside Electron the engine UA falls back to the default Chrome UA (never the old Firefox one).
        for (const t of w.tabs.values()) {
            expect(t.view.webContents.session.ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
            expect(t.view.webContents.session.ua).not.toMatch(/Firefox|Electron/);
            // WebContents-level UA (Electron snapshots the session UA per WebContents) is restored too.
            expect(t.view.webContents.ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
        }
    });

    it('explicit TLS choice survives a template change only when passed together', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-win', tlsProfile: 'firefox' });
        expect(w.svc.getEffective().tlsProfile).toBe('firefox');
        await w.svc.setSettings({ templateId: 'safari-mac' });
        expect(w.svc.getEffective().tlsProfile).toBe('safari');
        await w.svc.setSettings({ tlsProfile: 'edge' });
        expect(w.svc.getEffective().tlsProfile).toBe('edge');
        expect(w.svc.getEffective().userAgent).toBe(catalog.UA.safariMac);
    });

    it('clearing the identity language restores an explicit default Accept-Language on every session', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-win', language: 'ja-JP,ja;q=0.9' });
        for (const t of w.tabs.values()) expect(t.view.webContents.session.lang).toBe('ja-JP,ja');
        await w.svc.setSettings({ language: '' });
        const def = w.svc.defaultAcceptLanguage();
        expect(def).toMatch(/^[a-z]{2}(-[A-Z]{2})?,/);
        // Chromium side keeps the engine's own language list (same in page, iframes and workers);
        // the wire header is Chrome's expansion of that list.
        const native = w.svc.nativeLanguageList().join(',');
        for (const t of w.tabs.values()) expect(t.view.webContents.session.lang).toBe(native);
        expect(w.svc.getIdentityForNewTab('tX').language).toBe(native);
        expect(def).toBe(catalog.chromeAcceptLanguageHeader(w.svc.nativeLanguageList()));
    });

    it('does not re-send identical CDP overrides for the same tab', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-win' });
        const n = w.cdpCalls.length;
        await w.svc.applyEffective({ reason: 'again' });
        expect(w.cdpCalls.length).toBe(n);
    });

    it("engine mode with engineBrand 'chromium' and no tz/lang never attaches CDP", async () => {
        const w = makeWorld({ attached: false });
        await w.svc.setSettings({ mode: 'engine', engineBrand: 'chromium' });
        w.cdpCalls.length = 0;
        await w.svc.applyEffective({ reason: 'startup' });
        expect(w.cdpCalls.length).toBe(0);
        for (const t of w.tabs.values()) expect(t.view.webContents.debugger.isAttached()).toBe(false);
    });

    it('engine mode as Google Chrome (default) sets branded userAgentMetadata via CDP', async () => {
        const w = makeWorld({ attached: false });
        await w.svc.applyEffective({ reason: 'startup' });
        const ua = w.cdpCalls.find((c) => c.cmd === 'Emulation.setUserAgentOverride');
        expect(ua).toBeTruthy();
        const md = ua.params.userAgentMetadata;
        expect(md.brands.map((b) => b.brand)).toContain('Google Chrome');
        expect(md.brands).toHaveLength(3);
        // brands carry the major; fullVersionList carries a real full version, never "N.0.0.0" for Chrome
        const chromeFull = md.fullVersionList.find((b) => b.brand === 'Google Chrome');
        if (process.versions.chrome) expect(chromeFull.version).toBe(process.versions.chrome);
        // the wire says the same
        expect(w.mitm.identity.clientHints.brands).toEqual(md.brands);
    });

    it('non-engine identity attaches CDP through ensureCdpAttached', async () => {
        const w = makeWorld({ attached: false });
        await w.svc.setSettings({ mode: 'template', templateId: 'safari-mac' });
        for (const t of w.tabs.values()) expect(t.view.webContents.debugger.isAttached()).toBe(true);
        expect(w.cdpCalls.filter((c) => c.cmd === 'Emulation.setUserAgentOverride').length).toBe(2);
    });
});

describe('identity-service: proxy profile overrides', () => {
    let w;
    beforeEach(async () => {
        w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-win', timezone: 'UTC' });
        w.cdpCalls.length = 0;
    });

    it('connected profile with identity_override wins over the global identity, disconnect restores it', async () => {
        await w.svc.setProxyOverride({ id: 7, name: 'DE-proxy', identity_override: 1, user_agent: catalog.UA.firefoxWin, tls_profile: 'firefox', timezone: 'Europe/Berlin', force_http1: 1 });
        expect(w.svc.getSource()).toBe('proxy-profile');
        const eff = w.svc.getEffective();
        expect(eff.userAgent).toBe(catalog.UA.firefoxWin);
        expect(eff.tlsProfile).toBe('firefox');
        expect(eff.timezone).toBe('Europe/Berlin');
        expect(w.mitm.browser).toBe('firefox');
        expect(w.mitm.forceHttp1).toBe(true);
        expect(w.svc.getStatus().proxyOverrideName).toBe('DE-proxy');
        await w.svc.setProxyOverride(null);
        expect(w.svc.getSource()).toBe('global');
        expect(w.svc.getEffective().userAgent).toBe(catalog.UA.chromeWin);
        expect(w.mitm.browser).toBe('chrome');
        expect(w.mitm.forceHttp1).toBe(false);
    });

    it('a profile without identity_override does not change the identity', async () => {
        await w.svc.setProxyOverride({ id: 8, name: 'plain', identity_override: 0, user_agent: catalog.UA.firefoxWin, tls_profile: 'firefox' });
        expect(w.svc.getSource()).toBe('global');
        expect(w.svc.getEffective().userAgent).toBe(catalog.UA.chromeWin);
        expect(w.mitm.browser).toBe('chrome');
    });

    it('per-tab override applies only to that tab and to MITM tab identity', async () => {
        await w.svc.setTabOverride('t2', { id: 9, name: 'tab-proxy', identity_override: 1, user_agent: catalog.UA.iosSafari, tls_profile: 'ios' });
        expect(w.svc.getEffectiveForTab('t2').userAgent).toBe(catalog.UA.iosSafari);
        expect(w.svc.getEffectiveForTab('t1').userAgent).toBe(catalog.UA.chromeWin);
        expect(w.svc.getSource('t2')).toBe('tab-profile');
        expect(w.mitm.tabIdentity.get('t2').userAgent).toBe(catalog.UA.iosSafari);
        expect(w.tabs.get('t2').view.webContents.session.ua).toBe(catalog.UA.iosSafari);
        // Non-Chromium tab identity (iOS Safari): remove navigator.userAgentData + window.chrome.
        const s2 = w.svc.getNavigatorPatchScript('t2');
        expect(s2).toContain('userAgentData');
        expect(s2).toContain('delete window.chrome');
        // Chromium global identity (chrome-win): fill window.chrome so it does not look like Electron.
        const s1 = w.svc.getNavigatorPatchScript('t1');
        expect(s1).toContain('window.chrome');
        expect(s1).toContain('loadTimes');
        expect(s1).not.toContain('delete window.chrome');
        // Template identity (another machine): hardware fields are pinned.
        expect(s1).toContain('deviceMemory');
        w.svc.clearTabOverride('t2');
        expect(w.mitm.tabIdentity.has('t2')).toBe(false);
        expect(w.svc.getEffectiveForTab('t2').userAgent).toBe(catalog.UA.chromeWin);
    });

    it('getIdentityForNewTab / onTabCreated / status / preview', async () => {
        expect(w.svc.getIdentityForNewTab('tX')).toEqual({ userAgent: catalog.UA.chromeWin, language: w.svc.nativeLanguageList().join(',') });
        const st = w.svc.getStatus();
        expect(st.effective.description).toBe(`Chrome ${catalog.VERSIONS.chrome} · Windows`);
        expect(st.effective.headers['sec-ch-ua-platform']).toBe('"Windows"');
        expect(st.settings.templateId).toBe('chrome-win');
        const p = w.svc.preview({ mode: 'custom', userAgent: catalog.UA.edgeWin, language: 'en-GB' });
        expect(p.tlsProfile).toBe('edge');
        expect(p.headers['accept-language']).toBe('en-GB');
        // onTabCreated applies CDP to a new tab
        const t3 = { id: 't3', view: { webContents: w.tabs.get('t1').view.webContents } };
        w.cdpCalls.length = 0;
        // fresh webContents object so the applied-signature cache does not skip it
        const fresh = { ...t3.view.webContents, session: { setUserAgent() {} }, debugger: { isAttached: () => true, async sendCommand(cmd, params) { w.cdpCalls.push({ cmd, params }); } }, isDestroyed: () => false };
        await w.svc.onTabCreated({ id: 't3', view: { webContents: fresh } });
        expect(w.cdpCalls.some((c) => c.cmd === 'Emulation.setUserAgentOverride')).toBe(true);
    });
});

describe('identity-service: engine wire identity + proxy geo hint', () => {
    it('engine mode puts a synthesized engine identity on the MITM (Google Chrome brands by default)', async () => {
        const w = makeWorld({ attached: false });
        await w.svc.applyEffective({ reason: 'startup' });
        expect(w.mitm.identity).toBeTruthy();
        expect(w.mitm.identity.mode).toBe('engine');
        expect(w.mitm.identity.engineSynthesized).toBe(true);
        expect(w.mitm.identity.userAgent).toMatch(/Chrome\/\d+\.0\.0\.0/);
        const brands = w.mitm.identity.clientHints.brands.map((b) => b.brand);
        expect(brands).toContain('Google Chrome');
        expect(brands).toContain('Chromium');
        expect(brands).toHaveLength(3);
        // status/preview expose the wire headers for engine mode
        expect(w.svc.getStatus().effective.headers['sec-ch-ua']).toMatch(/"Google Chrome"/);
        expect(w.svc.preview({ mode: 'engine' }).headers['sec-ch-ua']).toMatch(/"Google Chrome"/);
    });

    it('engine mode keeps the genuine deviceMemory / hardwareConcurrency (no pinning)', async () => {
        const w = makeWorld({ attached: false });
        await w.svc.applyEffective({ reason: 'startup' });
        const script = w.svc.getNavigatorPatchScript([...w.tabs.keys()][0]) || '';
        expect(script).not.toContain('deviceMemory');
        expect(script).not.toContain('hardwareConcurrency');
        expect(script).toContain('loadTimes'); // still looks like Chrome
    });

    it("engineBrand 'chromium' keeps the unbranded 2-brand engine hints", async () => {
        const w = makeWorld({ attached: false });
        await w.svc.setSettings({ mode: 'engine', engineBrand: 'chromium' });
        await w.svc.applyEffective({ reason: 'startup' });
        const brands = w.mitm.identity.clientHints.brands.map((b) => b.brand);
        expect(brands).toContain('Chromium');
        expect(brands).not.toContain('Google Chrome');
        expect(brands).toHaveLength(2);
        expect(w.svc.preview({ mode: 'engine', engineBrand: 'chromium' }).headers['sec-ch-ua']).not.toMatch(/Google Chrome/);
    });
    it('engineHints off → legacy sanitize (null wire identity)', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ engineHints: false });
        expect(w.mitm.identity).toBeNull();
        expect(w.svc.getStatus().effective.headers).toBeNull();
        expect(w.svc.preview({ mode: 'engine', engineHints: false }).headers).toBeNull();
    });
    it('geo hint changes timezone/language only when followProxyGeo is on; profile override still wins', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-win', timezone: 'UTC', language: 'en-US' });
        await w.svc.setGeoHint({ country: 'DE', timezone: 'Europe/Berlin', ip: '1.2.3.4' });
        // off by default → untouched
        expect(w.svc.getEffective().timezone).toBe('UTC');
        expect(w.svc.getStatus().geoApplied).toBe(false);
        await w.svc.setSettings({ followProxyGeo: true });
        expect(w.svc.getEffective().timezone).toBe('Europe/Berlin');
        expect(w.svc.getEffective().language).toBe('de-DE,de;q=0.9,en;q=0.8');
        expect(w.svc.getEffective().userAgent).toBe(catalog.UA.chromeWin); // UA untouched
        expect(w.svc.getStatus().geoApplied).toBe(true);
        expect(w.svc.getStatus().geoHint.country).toBe('de');
        // legacy mirror + CDP carry the geo timezone
        expect(w.activeFp.timezone).toBe('Europe/Berlin');
        expect(w.cdpCalls.filter((c) => c.cmd === 'Emulation.setTimezoneOverride').pop().params.timezoneId).toBe('Europe/Berlin');
        // profile override with its own timezone wins over the geo hint
        await w.svc.setProxyOverride({ id: 1, name: 'p', identity_override: 1, timezone: 'Asia/Tokyo' });
        expect(w.svc.getEffective().timezone).toBe('Asia/Tokyo');
        expect(w.svc.getStatus().geoApplied).toBe(false);
        await w.svc.setProxyOverride(null);
        expect(w.svc.getEffective().timezone).toBe('Europe/Berlin');
        // disconnect clears the hint
        w.svc.setGeoHint(null, { skipApply: true });
        expect(w.svc.getEffective().timezone).toBe('UTC');
        expect(w.svc.getGeoHint()).toBeNull();
    });
    it('unknown egress country keeps the lookup timezone and a neutral language', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ followProxyGeo: true, timezone: '', language: '' });
        await w.svc.setGeoHint({ country: 'zz', timezone: 'Etc/UTC' });
        expect(w.svc.getEffective().timezone).toBe('Etc/UTC');
        expect(w.svc.getEffective().language).toBe('en-US,en;q=0.9');
    });
});

describe('identity-service: Accept-Language plumbing', () => {
    it('sessions and CDP get language codes; the wire identity carries a well-formed header', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-win', language: 'ru,en-US;q=0.8;q=0.9,en;q=0.7;q=0.8' });
        for (const t of w.tabs.values()) expect(t.view.webContents.session.lang).toBe('ru,en-US,en');
        const ua = w.cdpCalls.find((c) => c.cmd === 'Emulation.setUserAgentOverride');
        expect(ua.params.acceptLanguage).toBe('ru,en-US,en');
        expect(w.mitm.identity.language).toBe('ru,en-US;q=0.9,en;q=0.8');
        // engine wire identity also carries the default, well-formed header
        await w.svc.setSettings({ mode: 'engine', language: '' });
        expect(w.mitm.identity.language).toBe(catalog.formatAcceptLanguageHeader(w.svc.defaultAcceptLanguage()));
        expect(w.mitm.identity.language).not.toMatch(/;q=[\d.]+;q=/);
    });
    it('a Chromium identity always sends client hints + CDP metadata (clientHints:false is ignored — real Chrome always exposes them)', async () => {
        const w = makeWorld();
        await w.svc.setSettings({ mode: 'template', templateId: 'chrome-win', clientHints: false });
        expect(w.mitm.identity.userAgent).toBe(catalog.UA.chromeWin);
        expect(w.mitm.identity.clientHints).not.toBeNull();
        const ua = w.cdpCalls.find((c) => c.cmd === 'Emulation.setUserAgentOverride');
        expect(ua.params.userAgent).toBe(catalog.UA.chromeWin);
        expect(ua.params.userAgentMetadata).toBeTruthy();
    });
});
