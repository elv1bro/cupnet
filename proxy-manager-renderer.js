'use strict';

const api = window.electronAPI;
const pmModel = window.cupnetProxyManagerModel || {};
const psi = window.cupnetProxyStaticImport || {};

// ─── State ────────────────────────────────────────────────────────────────────
let profiles       = [];
let selectedId     = null;   // id of profile being edited
let isNew          = false;
let ephemeralVars  = {};     // {SID: 'value', ...} — not saved to profile
let lastResolvedVars = {};   // {SID: 'cupnet1234', RAND: '42351'} — values used in last connect
let _storedResolvedVars = {}; // persistent copy, survives profile switches
let connectedId    = null;   // id of currently connected profile
let currentIp      = '';
let searchQuery    = '';
let editorDirty    = false;
const unsavedDot   = document.getElementById('unsaved-dot');
const toastProxy   = document.getElementById('toast-proxy');

// Built-in: MITM без upstream (локальный прокси без внешней цепочки)
const DIRECT_ID = '__direct__';
const DIRECT_PROFILE = {
    id:          DIRECT_ID,
    name:        'MITM (no upstream)',
    url_display: 'Local MITM only — no upstream proxy',
    is_template: 0,
    tls_profile:    'chrome',
    tls_ja3_mode:   'template',
    tls_ja3_custom: null,
    traffic_mode: 'mitm',
    user_agent: null, timezone: null, language: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const profileList   = document.getElementById('profile-list');
const profileListBuiltIn = document.getElementById('profile-list-built-in');
const editorEmpty   = document.getElementById('editor-empty');
const editorWrap    = document.getElementById('editor-wrap');
const editorTitle   = document.getElementById('editor-title');

/** True when the profile editor panel is shown (inline style can be empty; use computed style). */
function isEditorPanelVisible() {
    if (editorWrap && getComputedStyle(editorWrap).display !== 'none') return true;
    const se = document.getElementById('simple-editor');
    return !!(se && getComputedStyle(se).display !== 'none');
}
const searchInput   = document.getElementById('search-profiles');

const fName         = document.getElementById('f-name');
const fTemplate     = document.getElementById('f-template');
const fNotes        = document.getElementById('f-notes');
const tplPreview    = document.getElementById('tpl-preview');
const varsSection   = document.getElementById('vars-section');
const varsTbody     = document.getElementById('vars-tbody');

// Provider mode DOM
const pp = window.cupnetProxyProviders || {};
const providerPanel     = document.getElementById('provider-panel');
const manualPanel       = document.getElementById('manual-panel');
const fProvider         = document.getElementById('f-provider');
const fProviderUser     = document.getElementById('f-provider-user');
const fProviderPass     = document.getElementById('f-provider-pass');
const fCountrySearch    = document.getElementById('f-country-search');
const fCountryCode      = document.getElementById('f-country-code');
const countryDropdown   = document.getElementById('country-picker-dropdown');
const countryPickerWrap = document.getElementById('country-picker-wrap');
const sessionSeg        = document.getElementById('session-seg');
const durationRow       = document.getElementById('duration-row');
const fDurationMin      = document.getElementById('f-duration-min');
const fDurationSlider   = document.getElementById('f-duration-slider');
const providerTypeHint  = document.getElementById('provider-type-hint');
const connModeSwitch    = document.getElementById('conn-mode-switch');
const providerCredsStatus = document.getElementById('provider-creds-status');
const providerOptionsPanel  = document.getElementById('provider-options-panel');
const filterProviderEl  = document.getElementById('filter-provider');
const filterCountryEl   = document.getElementById('filter-country');
const unsavedModalBackdrop = document.getElementById('unsaved-modal-backdrop');
const unsavedModalMessage  = document.getElementById('unsaved-modal-message');
const unsavedModalCancel     = document.getElementById('unsaved-modal-cancel');
const unsavedModalSave       = document.getElementById('unsaved-modal-save');
const unsavedModalClose      = document.getElementById('unsaved-modal-close');
const statusSep           = document.getElementById('status-sep');
const CUSTOM_LINK_ID      = pp.CUSTOM_LINK_PROVIDER_ID || '__custom__';
// Provider "accounts" (plaintext credentials in localStorage) were removed on 2026-09-24 (A-393):
// credentials are typed per profile and live only inside the safeStorage-encrypted proxy URL.
try {
    localStorage.removeItem('cupnet.proxy.providerAccounts');
    localStorage.removeItem('cupnet.proxy.providerAccounts.v2');
} catch { /* ignore */ }
const btnHeaderNew      = document.getElementById('btn-header-new');
const statusCard        = document.getElementById('status-card');
const msErrWrap         = document.getElementById('ms-err-wrap');

let connectionMode = 'provider'; // 'provider' | 'manual'
let _providerUiLock = false; // suppress dirty during programmatic load
let filterProvider = '';
let filterCountry = '';

// Fingerprint fields (per-profile identity OVERRIDE; the global identity lives in the Browser Identity window)
const fUa           = document.getElementById('f-ua');
const fTimezone     = document.getElementById('f-timezone');
const fLanguage     = document.getElementById('f-language');
const fpActiveBadge = document.getElementById('fp-active-badge');
const fpSection     = document.getElementById('fp-section');
const fpBody        = document.getElementById('fp-body');
const fIdentityOverride = document.getElementById('f-identity-override');
const btnOpenIdentity   = document.getElementById('btn-open-identity');
const simpleIdentityLine = document.getElementById('simple-identity-line');
const simpleIdentityText = document.getElementById('simple-identity-text');
const editorModeSeg      = document.getElementById('editor-mode-seg');
const providerCredsFields = document.getElementById('provider-creds-fields');

// ─── Editor mode: simple | advanced ──────────────────────────────────────────
let editorMode = pmModel.DEFAULT_EDITOR_MODE || 'simple';
function applyEditorMode(mode, { persist = true } = {}) {
    const next = pmModel.normalizeEditorMode ? pmModel.normalizeEditorMode(mode) : (mode === 'advanced' ? 'advanced' : 'simple');
    const wasOpen = isEditorPanelVisible();
    if (next !== editorMode && wasOpen && editorDirty && !confirmDiscardIfDirty()) {
        editorModeSeg?.querySelectorAll('[data-editor-mode]').forEach((b) => b.classList.toggle('active', b.dataset.editorMode === editorMode));
        return;
    }
    const changed = next !== editorMode;
    editorMode = next;
    document.body.dataset.editorMode = editorMode;
    editorModeSeg?.querySelectorAll('[data-editor-mode]').forEach((b) => b.classList.toggle('active', b.dataset.editorMode === editorMode));
    if (editorMode === 'simple') {
        // Simple mode is provider-only; manual profiles switch the editor to Advanced (see openEditor).
        if (connectionMode === 'manual' && (selectedId == null || isNew)) setConnectionMode('provider');
        document.getElementById('tab-btn-connection')?.click();
    }
    if (typeof populateProfileProviderSelect === 'function' && fProvider) {
        populateProfileProviderSelect(fProvider);
        updateProviderCredsFieldsVisibility();
    }
    if (persist && api.setUiPref) api.setUiPref(pmModel.EDITOR_MODE_PREF_KEY || 'proxyManager.editorMode', editorMode).catch(() => {});
    // Re-open the current selection in the editor that belongs to the new mode.
    if (changed && wasOpen) {
        setEditorDirty(false);
        if (selectedId === DIRECT_ID) openDirectEditor();
        else if (selectedId != null) openEditor(selectedId);
        else openNewEditor();
    }
}
editorModeSeg?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-editor-mode]');
    if (b) applyEditorMode(b.dataset.editorMode);
});
// Default synchronously (so the layout is right on first paint), then the persisted preference.
document.body.dataset.editorMode = editorMode;
if (api.getUiPref) {
    api.getUiPref(pmModel.EDITOR_MODE_PREF_KEY || 'proxyManager.editorMode', editorMode)
        .then((m) => applyEditorMode(m, { persist: false }))
        .catch(() => applyEditorMode(editorMode, { persist: false }));
}

/** Inline provider credentials are shown whenever a plain provider (not a saved account / custom URL) is selected. */
function updateProviderCredsFieldsVisibility() {
    if (!providerCredsFields) return;
    const val = fProvider?.value || '';
    const plainProvider = !!val && val !== CUSTOM_LINK_ID;
    providerCredsFields.style.display = plainProvider && connectionMode === 'provider' ? '' : 'none';
}

// ─── Global browser identity (read-only line in Simple mode) ─────────────────
function refreshSimpleIdentityLine(status) {
    if (!simpleIdentityText) return;
    const render = (st) => {
        simpleIdentityText.textContent = pmModel.describeIdentityForSimple
            ? pmModel.describeIdentityForSimple(st)
            : `Browser ID: ${st?.effective?.description || '—'}`;
    };
    if (status) { render(status); return; }
    if (api.getIdentity) api.getIdentity().then((st) => render(st && st.success ? st : null)).catch(() => render(null));
}
// Identity is managed only in Browser ID; the Proxy Manager no longer shows or edits it.
btnOpenIdentity?.addEventListener('click', () => api.openIdentityManager?.());

// Identity override checkbox → the per-profile fields only matter when it is on.
function syncIdentityOverrideUi() {
    const on = !!fIdentityOverride?.checked;
    fpBody?.classList.toggle('fp-disabled', !on);
    updateFpBadge();
}
fIdentityOverride?.addEventListener('change', syncIdentityOverrideUi);

// UA presets
const UA_PRESETS = {
    'chrome-win': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    'chrome-mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    'firefox':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
    'safari':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
    'mobile':     'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
};

document.querySelectorAll('.fp-preset').forEach(btn => {
    btn.addEventListener('click', () => {
        fUa.value = UA_PRESETS[btn.dataset.ua] || '';
        updateFpBadge();
    });
});

function updateFpBadge() {
    const on = !!fIdentityOverride?.checked;
    if (fpActiveBadge) fpActiveBadge.style.display = on ? '' : 'none';
}

[fUa, fTimezone, fLanguage].forEach(el => el?.addEventListener('change', updateFpBadge));
fUa?.addEventListener('input', updateFpBadge);

// ─── TLS Fingerprint ──────────────────────────────────────────────────────────
// Combined profile: TLS fingerprint + HTTP/2 settings + User-Agent
const TLS_TEMPLATE_DESCS = {
    chrome:  'Chrome 154 (Windows)\nUA: Chrome/154.0.0.0\nHTTP/2: Chrome SETTINGS · WINDOW=15663105 · m,a,s,p\nJA3: TLS 1.3+GREASE+X25519MLKEM768. Industry standard.',
    firefox: 'Firefox 156 (Windows)\nUA: Firefox/156.0\nHTTP/2: Firefox SETTINGS (WINDOW=12517377, MAX_FRAME=16384) · m,p,a,s\nJA3: no GREASE, unique extension order. Best privacy.',
    safari:  'Safari 27 (macOS)\nUA: Safari/605.1.15 Version/27.0\nHTTP/2: Safari SETTINGS (WINDOW=10420225) · m,s,a,p\nJA3: Apple TLS stack, fewer extensions.',
    ios:     'iOS 27 (Mobile Safari)\nUA: iPhone Mobile Safari\nHTTP/2: same as Safari · m,s,a,p\nJA3: mobile Apple fingerprint.',
    edge:    'Edge 153 (Windows)\nUA: Edg/153.0.0.0\nHTTP/2: identical to Chrome · m,a,s,p\nJA3: Chromium-based, Chrome-identical TLS.',
    opera:   'Opera 136 (Windows)\nUA: OPR/136.0.0.0\nHTTP/2: identical to Chrome · m,a,s,p\nJA3: Chromium-based, Chrome-identical TLS.',
};

// Real JA3 strings measured via tls.peet.ws for each AzureTLS profile
const TLS_JA3_PRESETS = {
    chrome:  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,18-10-5-13-27-51-45-17613-11-23-65037-43-16-0-35-65281,4588-29-23-24,0',
    firefox: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,17613-65037-13-11-45-35-10-65281-5-43-16-18-23-27-51-0,4588-29-23-24,0',
    safari:  '771,4865-4866-4867-49196-49195-52393-49200-49199-52392-49162-49161-49172-49171-157-156-53-47-255,0-11-10-35-16-22-23-13-43-45-51,29-23-24-25,0',
    ios:     '771,4865-4866-4867-49196-49195-52393-49200-49199-52392-49162-49161-49172-49171-157-156-53-47-255,0-11-10-35-16-22-23-13-43-45-51,29-23-24-25,0',
    edge:    '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,18-10-5-13-27-51-45-17613-11-23-65037-43-16-0-35-65281,4588-29-23-24,0',
    opera:   '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,18-10-5-13-27-51-45-17613-11-23-65037-43-16-0-35-65281,4588-29-23-24,0',
};

const tlsModeRadios   = document.querySelectorAll('input[name="tls-mode"]');
const tlsTemplateBlock = document.getElementById('tls-template-block');
const tlsCustomBlock  = document.getElementById('tls-custom-block');
const tlsTplDesc      = document.getElementById('tls-tpl-desc');
const fpTlsBadge      = document.getElementById('fp-tls-badge');

const ja3FullInput  = document.getElementById('tls-ja3-full');

function tlsGetMode()     { return document.querySelector('input[name="tls-mode"]:checked')?.value || 'template'; }
function tlsGetTemplate() { return document.querySelector('.tls-tpl-btn.active')?.dataset?.tls || 'chrome'; }

function tlsSetMode(mode) {
    document.querySelectorAll('input[name="tls-mode"]').forEach(r => { r.checked = r.value === mode; });
    if (tlsTemplateBlock) tlsTemplateBlock.style.display = mode === 'template' ? '' : 'none';
    if (tlsCustomBlock)   tlsCustomBlock.style.display   = mode === 'custom'   ? '' : 'none';
    if (fpTlsBadge) fpTlsBadge.style.display = mode === 'custom' ? '' : 'none';
}

function tlsSetTemplate(name) {
    document.querySelectorAll('.tls-tpl-btn').forEach(b => b.classList.toggle('active', b.dataset.tls === name));
    if (tlsTplDesc) tlsTplDesc.textContent = TLS_TEMPLATE_DESCS[name] || '';
}

function ja3BuildFull() {
    return ja3FullInput?.value.trim() || '';
}

function ja3ParseFull(str) {
    if (!str) return;
    if (ja3FullInput) ja3FullInput.value = str;
}

function ja3SyncFull() {
    // no-op: full string is the single source of truth
}

// Template buttons — only edit the profile's override; nothing is applied until Connect (A-170).
document.querySelectorAll('.tls-tpl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tpl = btn.dataset.tls;
        tlsSetTemplate(tpl);
        const sync = typeof window !== 'undefined' ? window.cupnetProxyTlsUaSync : null;
        if (sync && fUa && typeof sync.syncUserAgentFromTlsTemplate === 'function') {
            const { newUa } = sync.syncUserAgentFromTlsTemplate(tpl, fUa.value);
            if (newUa != null) fUa.value = newUa;
        }
        updateFpBadge();
    });
});

// Mode radio
tlsModeRadios.forEach(r => {
    r.addEventListener('change', () => {
        tlsSetMode(r.value);
        updateFpBadge();
    });
});

// Copy full JA3
document.getElementById('tls-ja3-copy')?.addEventListener('click', () => {
    const str = ja3FullInput?.value || ja3BuildFull();
    const onCopied = () => {
        const btn = document.getElementById('tls-ja3-copy');
        if (btn) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str).then(onCopied).catch(() => {
            try {
                const ta = document.createElement('textarea');
                ta.value = str;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                onCopied();
            } catch (_) { /* ignore */ }
        });
    } else {
        try {
            const ta = document.createElement('textarea');
            ta.value = str;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            onCopied();
        } catch (_) { /* ignore */ }
    }
});

// Prefill buttons (fill custom JA3 fields from preset)
document.querySelectorAll('.ja3-prefill').forEach(btn => {
    btn.addEventListener('click', () => {
        const ja3 = TLS_JA3_PRESETS[btn.dataset.ja3];
        if (ja3) {
            ja3ParseFull(ja3);
            ja3SyncFull();
        }
    });
});

// TLS getters/setters for save/load
function tlsGetSaveData() {
    const mode = tlsGetMode();
    return {
        tls_profile:    tlsGetTemplate(),
        tls_ja3_mode:   mode,
        tls_ja3_custom: mode === 'custom' ? ja3BuildFull() : null,
        force_http1:    document.getElementById('tls-force-http1')?.checked ? 1 : 0,
        identity_override: fIdentityOverride?.checked ? 1 : 0,
    };
}

function tlsLoadFromProfile(profile) {
    const mode = profile.tls_ja3_mode || 'template';
    const tpl  = profile.tls_profile  || 'chrome';
    tlsSetMode(mode);
    tlsSetTemplate(tpl);
    const http1Cb = document.getElementById('tls-force-http1');
    if (http1Cb) http1Cb.checked = !!(profile.force_http1);
    if (fIdentityOverride) fIdentityOverride.checked = !!profile.identity_override;
    syncIdentityOverrideUi();
    if (mode === 'custom' && profile.tls_ja3_custom) {
        ja3ParseFull(profile.tls_ja3_custom);
        ja3SyncFull();
    } else {
        // Show the preset JA3 for the selected template
        ja3ParseFull(TLS_JA3_PRESETS[tpl] || TLS_JA3_PRESETS.chrome);
        ja3SyncFull();
    }
}

// Init: default state
tlsSetMode('template');
tlsSetTemplate('chrome');

const btnAddProfile = document.getElementById('btn-add-profile') || btnHeaderNew;
const btnSave       = document.getElementById('btn-save');
const btnCancel     = document.getElementById('btn-cancel');
const btnDelete     = document.getElementById('btn-delete');
const btnDuplicate  = document.getElementById('btn-duplicate');
const btnTest       = document.getElementById('btn-test');
const btnConnectGlobal = document.getElementById('btn-connect-global');
const btnDisconnectGlobal = document.getElementById('btn-disconnect-global');
const btnDisconnect = document.getElementById('btn-disconnect');
const btnCheckIp    = document.getElementById('btn-check-ip');
const btnEmptyNew   = document.getElementById('btn-empty-new');
const statusPillBtn = document.getElementById('status-pill-btn');

const btnTestDefaultHtml = btnTest ? btnTest.innerHTML : '';
const btnCheckIpDefaultHtml = btnCheckIp ? btnCheckIp.innerHTML : '';

const statusDot     = document.getElementById('status-dot');
const statusLabel   = document.getElementById('status-label');
const statusIp      = document.getElementById('status-ip');
const saveStatus    = document.getElementById('save-status');
const testResult    = document.getElementById('test-result');

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

/** Host:port from stored url_display (masked template); empty if unparseable */
function proxyHostLineFromUrlDisplay(s) {
    if (!s || typeof s !== 'string') return '';
    const t = s.trim();
    if (!t) return '';
    try {
        const forParse = t.replace(/\{[^}]+\}/g, 'PLACEHOLDER');
        let u = forParse;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = 'http://' + u;
        const parsed = new URL(u);
        const host = parsed.hostname;
        if (!host) return '';
        return parsed.port ? `${host}:${parsed.port}` : host;
    } catch {
        return '';
    }
}

/** Tooltip: short host:name line + full template line */
function proxyProfileListTitle(hostLine, profileName, urlDisplay) {
    const name = String(profileName || '').trim();
    const full = String(urlDisplay || '').trim();
    const head = hostLine && name ? `${hostLine}: ${name}` : (hostLine || name || '');
    if (head && full) return `${head}\n${full}`;
    return full || head || '';
}

/** ISO 3166-1 alpha-2 → regional-indicator flag emoji (e.g. PL → 🇵🇱) */
function countryCodeToFlagEmoji(cc) {
    if (!cc || typeof cc !== 'string') return '';
    const s = cc.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(s)) return '';
    const base = 0x1F1E6;
    return String.fromCodePoint(base + s.charCodeAt(0) - 65) + String.fromCodePoint(base + s.charCodeAt(1) - 65);
}

function normalizeCountryCode(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const t = raw.trim();
    return /^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : '';
}

/** Stored last_geo is often "City, PL" — use trailing ISO2 when present */
function countryCodeFromLastGeoString(geoStr) {
    if (!geoStr) return '';
    const parts = String(geoStr).split(',').map(p => p.trim());
    const last = parts[parts.length - 1];
    return normalizeCountryCode(last);
}

function formatStatusIpLine(geo) {
    if (!geo || geo.ip === 'unknown') return '';
    const cc = normalizeCountryCode(geo.country);
    const flag = countryCodeToFlagEmoji(cc);
    const location = [geo.city, geo.country_name].filter(Boolean).join(', ');
    const tail = location ? ` · ${location}` : '';
    return `${flag ? `${flag} ` : ''}${geo.ip}${tail}`;
}

function formatTestLocationLine(d) {
    if (!d) return '—';
    const cc = normalizeCountryCode(d.country);
    const flag = countryCodeToFlagEmoji(cc);
    const loc = [d.city, d.region, d.country].filter(Boolean).join(', ');
    if (!loc) return '—';
    return `${flag ? `${flag} ` : ''}${loc}`;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function setSaveStatus(msg, type = '') {
    saveStatus.textContent = msg;
    saveStatus.style.color = type === 'ok' ? '#22c55e' : type === 'err' ? '#ef4444' : 'var(--dim)';
    if (type) setTimeout(() => { saveStatus.textContent = ''; }, 3000);
}

function setEditorDirty(dirty) {
    editorDirty = !!dirty;
    if (unsavedDot) unsavedDot.classList.toggle('visible', editorDirty);
    updateConnectDisconnectButtons();
}

function showToast(msg, kind = '') {
    if (!toastProxy) return;
    toastProxy.textContent = msg;
    toastProxy.classList.remove('ok', 'err');
    if (kind === 'ok') toastProxy.classList.add('ok');
    if (kind === 'err') toastProxy.classList.add('err');
    toastProxy.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastProxy.classList.remove('visible'); }, 3200);
}

function initEditorTabs() {
    const map = [
        { btnId: 'tab-btn-connection', panelId: 'tab-panel-connection' },
        { btnId: 'tab-btn-optimization', panelId: 'tab-panel-optimization' },
    ];
    function activate(selectedBtnId) {
        map.forEach(({ btnId, panelId }) => {
            const on = btnId === selectedBtnId;
            const b = document.getElementById(btnId);
            const p = document.getElementById(panelId);
            if (b) {
                b.setAttribute('aria-selected', on ? 'true' : 'false');
                b.tabIndex = on ? 0 : -1;
            }
            if (p) p.classList.toggle('active', on);
        });
    }
    map.forEach(({ btnId }) => {
        document.getElementById(btnId)?.addEventListener('click', () => activate(btnId));
    });
    activate('tab-btn-connection');
}

initEditorTabs();

function confirmDiscardIfDirty() {
    if (!editorDirty) return true;
    return confirm('Discard unsaved changes?');
}

function hasUnsavedEditorChanges() {
    if (!isEditorPanelVisible()) return false;
    return !!editorDirty || !!isNew;
}

let _unsavedModalFinish = null;

function closeUnsavedModal(choice = 'cancel') {
    if (unsavedModalBackdrop) {
        unsavedModalBackdrop.classList.remove('open');
        unsavedModalBackdrop.setAttribute('aria-hidden', 'true');
    }
    const finish = _unsavedModalFinish;
    _unsavedModalFinish = null;
    if (finish) finish(choice);
}

function openUnsavedChangesModal(actionLabel) {
    return new Promise((resolve) => {
        _unsavedModalFinish = resolve;
        if (unsavedModalMessage) {
            unsavedModalMessage.textContent = `You have unsaved changes. Save this profile and continue with ${actionLabel}?`;
        }
        unsavedModalBackdrop?.classList.add('open');
        unsavedModalBackdrop?.setAttribute('aria-hidden', 'false');
    });
}

async function ensureSavedBeforeAction(actionLabel, actionFn) {
    if (!hasUnsavedEditorChanges()) {
        await actionFn();
        return true;
    }
    const choice = await openUnsavedChangesModal(actionLabel);
    if (choice !== 'save') return false;
    const result = await saveProfileFromForm({ silent: true });
    if (!result.success) {
        setSaveStatus(result.error || 'Save failed', 'err');
        showToast(result.error || 'Save failed', 'err');
        return false;
    }
    setSaveStatus('Saved ✓', 'ok');
    await actionFn();
    return true;
}

unsavedModalCancel?.addEventListener('click', () => closeUnsavedModal('cancel'));
unsavedModalClose?.addEventListener('click', () => closeUnsavedModal('cancel'));
unsavedModalSave?.addEventListener('click', () => closeUnsavedModal('save'));
unsavedModalBackdrop?.addEventListener('click', (e) => {
    if (e.target === unsavedModalBackdrop) closeUnsavedModal('cancel');
});

const editorBodyEl = document.querySelector('.editor-body');
function wireEditorDirtyListeners() {
    if (!editorBodyEl) return;
    const mark = () => {
        if (!isEditorPanelVisible()) return;
        setEditorDirty(true);
    };
    editorBodyEl.addEventListener('input', mark);
    editorBodyEl.addEventListener('change', mark);
    editorBodyEl.addEventListener('click', (e) => {
        if (e.target.closest('.tls-tpl-btn, .ja3-prefill, .fp-preset')) mark();
    });
    const se = document.getElementById('simple-editor');
    if (se) {
        se.addEventListener('input', (e) => { if (e.target.closest('#se-card-profile')) mark(); });
        se.addEventListener('change', (e) => { if (e.target.closest('#se-card-profile')) mark(); });
    }
}

wireEditorDirtyListeners();

/** Parse template, return vars found: { name, type: 'sid'|'rand'|'saved', range? } */
function parseTemplateVars(template) {
    const result = [];
    const seen   = new Set();
    for (const m of (template || '').matchAll(/\{(RAND:(\d+)-(\d+)|([A-Z_][A-Z0-9_]*))\}/gi)) {
        const full = m[1];
        if (/^RAND:/i.test(full)) {
            const key = full.toUpperCase();
            if (!seen.has(key)) { seen.add(key); result.push({ name: full, type: 'rand', range: `${m[2]}–${m[3]}` }); }
        } else {
            const name = full.toUpperCase();
            if (!seen.has(name)) {
                seen.add(name);
                result.push({ name, type: name === 'SID' ? 'sid' : 'saved' });
            }
        }
    }
    return result;
}

/** Resolve template with current ephemeral + saved vars for preview */
function resolvePreview(template, savedVars) {
    if (!template) return '—';
    const merged = { ...savedVars, ...ephemeralVars };
    return template
        .replace(/\{RAND:(\d+)-(\d+)\}/gi, (_, mn, mx) => `<span class="var-rand">{RAND:${mn}-${mx}}</span>`)
        .replace(/\{SID\}/gi, () => {
            const v = ephemeralVars['SID'];
            if (v) return `<span style="color:#f9a8d4">${esc(v)}</span>`;
            return `<span style="color:#f9a8d4;opacity:.6" title="Auto: cupnet + 10 random digits">cupnet••••••••••</span>`;
        })
        .replace(/\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name) => {
            const key = Object.keys(merged).find(k => k.toUpperCase() === name.toUpperCase());
            if (key && merged[key]) return `<span style="color:#c4b5fd">${esc(merged[key])}</span>`;
            return `<span class="var-placeholder">${esc(match)}</span>`;
        });
}

/** Get current saved vars from vars table inputs + reserved provider keys */
function collectVarsFromForm() {
    const vars = {};
    if (varsTbody) {
        varsTbody.querySelectorAll('[data-varname]').forEach(inp => {
            const name = inp.dataset.varname;
            if (inp.dataset.vartype !== 'sid' && inp.dataset.vartype !== 'rand') {
                if (!pp.isReservedProviderVar?.(name)) vars[name] = inp.value.trim();
            } else if (inp.dataset.vartype === 'sid') {
                ephemeralVars['SID'] = inp.value.trim();
            }
        });
    }
    if (connectionMode === 'provider') {
        Object.assign(vars, getProviderStateVariables());
    } else {
        vars.__connectionMode = 'manual';
    }
    return vars;
}

/** Provider-only reserved variables from form (no credentials in profile) */
function resolveProviderSelectBinding() {
    const val = fProvider?.value || '';
    if (val === CUSTOM_LINK_ID) return { mode: 'manual', providerId: null, accountId: null };
    return { mode: 'provider', providerId: val || null, accountId: '' };
}

function collectProviderOptionsFromForm() {
    const provider = getActiveProvider();
    const raw = {};
    providerOptionsPanel?.querySelectorAll('[data-provider-opt]').forEach(el => {
        const key = el.dataset.providerOpt;
        if (el.type === 'checkbox') raw[key] = el.checked ? 'true' : '';
        else raw[key] = el.value.trim();
    });
    return pp.normalizeProviderOptions?.(provider, raw) || raw;
}

function renderProviderOptions(provider) {
    if (!providerOptionsPanel) return;
    const fields = pp.getProviderOptionFields?.(provider) || [];
    providerOptionsPanel.innerHTML = '';
    if (!fields.length) {
        providerOptionsPanel.style.display = 'none';
        return;
    }
    providerOptionsPanel.style.display = '';
    const title = document.createElement('div');
    title.className = 'provider-options-title';
    title.textContent = `${provider.name} options`;
    providerOptionsPanel.appendChild(title);
    for (const field of fields) {
        const row = document.createElement('div');
        row.className = 'form-row provider-opt-row';
        if (field.type === 'checkbox') {
            row.innerHTML = `
                <label>${esc(field.label)}</label>
                <div class="provider-opt-check">
                    <input type="checkbox" data-provider-opt="${esc(field.key)}" id="provider-opt-${esc(field.key)}">
                    <span>${esc(field.label)}</span>
                </div>`;
            if (field.hint) {
                const hint = document.createElement('div');
                hint.className = 'form-hint';
                hint.textContent = field.hint;
                row.appendChild(hint);
            }
        } else if (field.type === 'select') {
            const choices = (field.choices || []).map(c =>
                `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');
            row.innerHTML = `
                <label for="provider-opt-${esc(field.key)}">${esc(field.label)}</label>
                <select data-provider-opt="${esc(field.key)}" id="provider-opt-${esc(field.key)}">${choices}</select>`;
            if (field.hint) {
                const hint = document.createElement('div');
                hint.className = 'form-hint';
                hint.textContent = field.hint;
                row.appendChild(hint);
            }
        } else {
            row.innerHTML = `
                <label for="provider-opt-${esc(field.key)}">${esc(field.label)}</label>
                <input type="text" data-provider-opt="${esc(field.key)}" id="provider-opt-${esc(field.key)}"
                    placeholder="${esc(field.placeholder || '')}" autocomplete="off">`;
            if (field.hint) {
                const hint = document.createElement('div');
                hint.className = 'form-hint';
                hint.textContent = field.hint;
                row.appendChild(hint);
            }
        }
        providerOptionsPanel.appendChild(row);
        const input = row.querySelector('[data-provider-opt]');
        if (!input) continue;
        if (field.type === 'checkbox') {
            input.checked = field.default === true || field.default === 'true';
        } else {
            input.value = field.default != null ? String(field.default) : '';
        }
    }
}

function loadProviderOptionsFromVars(vars) {
    const provider = getActiveProvider();
    renderProviderOptions(provider);
    const saved = pp.extractProviderOptionsFromVars?.(vars) || {};
    const normalized = pp.normalizeProviderOptions?.(provider, saved) || saved;
    providerOptionsPanel?.querySelectorAll('[data-provider-opt]').forEach(el => {
        const key = el.dataset.providerOpt;
        const val = normalized[key];
        if (el.type === 'checkbox') el.checked = val === 'true' || val === true;
        else el.value = val != null ? String(val) : '';
    });
}

function onProviderOptionsChanged() {
    if (_providerUiLock || connectionMode !== 'provider') return;
    syncTemplateFromProviderIfNeeded();
    refreshProviderPreview();
    maybeAutoNameProfile();
    setEditorDirty(true);
}

function getProviderStateVariables() {
    const binding = resolveProviderSelectBinding();
    const sessionBtn = sessionSeg?.querySelector('.session-seg-btn.active');
    const sessionMode = sessionBtn?.dataset.session || 'rotating';
    const dur = fDurationMin?.value ?? '30';
    if (!binding.providerId) return { __connectionMode: 'manual' };
    const vars = pp.buildProviderVariables?.(binding.providerId, {
        countryCode: fCountryCode?.value || '',
        sessionMode,
        durationMin: dur,
        accountId: binding.accountId,
        options: collectProviderOptionsFromForm(),
    }) || { __connectionMode: 'manual' };
    // Inline credentials: keep the username (never the password) so the editor can show it again;
    // the password lives only inside the encrypted proxy URL.
    if (usesInlineCredentials() && fProviderUser?.value.trim()) vars.__username = fProviderUser.value.trim();
    return vars;
}

/** True when the editor uses credentials typed inline (plain provider selected, not a saved account). */
function usesInlineCredentials() {
    const binding = resolveProviderSelectBinding();
    return connectionMode === 'provider' && !!binding.providerId && !binding.accountId && !isCustomLinkSelected();
}

function getProviderCredentialsForCompile(profileVars) {
    const binding = resolveProviderSelectBinding();
    const vars = profileVars || getCurrentSavedVars();
    const providerId = binding.providerId || vars.__provider || '';
    if (usesInlineCredentials()) {
        const username = fProviderUser?.value.trim() || '';
        const password = fProviderPass?.value || '';
        if (username) return { username, password, fromAccount: false, inline: true, accountId: '' };
    }
    return pp.resolveProviderCredentials?.(providerId, vars) || { username: '', password: '', fromAccount: false };
}

function compileProviderTemplate(profileVars) {
    const provider = getActiveProvider();
    if (!provider) return '';
    const creds = getProviderCredentialsForCompile(profileVars || getCurrentSavedVars());
    const sessionBtn = sessionSeg?.querySelector('.session-seg-btn.active');
    return pp.buildProviderTemplate?.(provider.id, {
        countryCode: fCountryCode?.value || provider.countries[0]?.code,
        sessionMode: sessionBtn?.dataset.session || 'rotating',
        durationMin: fDurationMin?.value,
        username: creds.username,
        password: creds.password,
        options: collectProviderOptionsFromForm(),
    }) || '';
}

function countryCodeFromProfileLastGeo(profile) {
    return countryCodeFromLastGeoString(profile?.last_geo);
}

function syncStatusSepVisibility() {
    if (!statusSep || !statusIp) return;
    statusSep.style.display = statusIp.textContent?.trim() ? '' : 'none';
}

function isCustomLinkSelected() {
    return fProvider?.value === CUSTOM_LINK_ID;
}

function getActiveProvider() {
    if (isCustomLinkSelected()) return null;
    const binding = resolveProviderSelectBinding();
    let providerId = binding.providerId;
    if (!providerId) {
        const v = fProvider?.value || '';
        if (v && v !== CUSTOM_LINK_ID) providerId = v;
    }
    return providerId ? (pp.getProxyProviderById?.(providerId) || null) : null;
}

function updateProviderCredsStatus() {
    if (!providerCredsStatus) return;
    if (connectionMode !== 'provider' || isCustomLinkSelected()) {
        providerCredsStatus.innerHTML = connectionMode === 'manual' || isCustomLinkSelected()
            ? `<div class="provider-creds-ok">Using your own proxy URL. Edit the template below.</div>`
            : '';
        return;
    }
    const provider = getActiveProvider();
    const creds = getProviderCredentialsForCompile();
    updateProviderCredsFieldsVisibility();
    if (usesInlineCredentials()) {
        providerCredsStatus.innerHTML = creds.username
            ? `<div class="provider-creds-ok">Using the credentials entered below for <b>${esc(provider?.name || 'provider')}</b>.</div>`
            : `<div class="provider-creds-hint">Enter your ${esc(provider?.name || 'provider')} username and password below.</div>`;
        return;
    }
    providerCredsStatus.innerHTML = creds.username
        ? `<div class="provider-creds-ok">Using legacy credentials stored in this profile.</div>`
        : `<div class="provider-creds-hint">Select a provider and enter its credentials.</div>`;
}

function getEffectiveTemplate() {
    if (connectionMode === 'provider') return compileProviderTemplate();
    return fTemplate?.value?.trim() || '';
}

function setConnectionMode(mode) {
    connectionMode = mode === 'manual' ? 'manual' : 'provider';
    connModeSwitch?.querySelectorAll('.conn-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === connectionMode);
    });
    providerPanel?.classList.toggle('active', connectionMode === 'provider');
    manualPanel?.classList.toggle('active', connectionMode === 'manual');
    if (connectionMode === 'manual' && providerOptionsPanel) providerOptionsPanel.style.display = 'none';
    syncTemplateFromProviderIfNeeded();
    refreshProviderPreview();
    updateProviderCredsStatus();
}

function syncTemplateFromProviderIfNeeded() {
    if (connectionMode !== 'provider' || !fTemplate) return;
    fTemplate.value = compileProviderTemplate();
}

function refreshProviderPreview() {
    const tpl = getEffectiveTemplate();
    const saved = getCurrentSavedVars();
    if (tplPreview) tplPreview.innerHTML = tpl ? resolvePreview(tpl, saved) : '—';
    buildVarsTable(tpl, filterReservedFromVars(saved));
}

function filterReservedFromVars(vars) {
    if (pp.filterUserTemplateVars) return pp.filterUserTemplateVars(vars);
    const out = {};
    for (const [k, v] of Object.entries(vars || {})) {
        if (!pp.isReservedProviderVar?.(k)) out[k] = v;
    }
    return out;
}

function updateSessionUi(provider) {
    const sessionBtn = sessionSeg?.querySelector('.session-seg-btn.active');
    const sessionMode = sessionBtn?.dataset.session || 'rotating';
    const showDuration = provider?.duration?.supported && sessionMode === 'sticky';
    if (durationRow) durationRow.style.display = showDuration ? '' : 'none';
    if (provider && fDurationMin && fDurationSlider) {
        const min = provider.duration?.min ?? 1;
        const max = provider.duration?.max ?? 1440;
        fDurationMin.min = String(min);
        fDurationMin.max = String(max);
        fDurationSlider.min = String(min);
        fDurationSlider.max = String(max);
    }
}

function setSessionMode(mode) {
    sessionSeg?.querySelectorAll('.session-seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.session === mode);
    });
    updateSessionUi(getActiveProvider());
    if (!_providerUiLock) {
        syncTemplateFromProviderIfNeeded();
        refreshProviderPreview();
        maybeAutoNameProfile();
    }
}

function setCountrySelection(code) {
    const provider = getActiveProvider();
    const country = provider ? pp.getProviderCountry?.(provider, code) : null;
    if (fCountryCode) fCountryCode.value = country?.code || code || '';
    if (fCountrySearch && country) {
        const flag = countryCodeToFlagEmoji(country.code.toUpperCase());
        fCountrySearch.value = `${flag ? flag + ' ' : ''}${country.name}`;
    }
    countryDropdown?.querySelectorAll('.country-option').forEach(el => {
        el.classList.toggle('selected', el.dataset.code === (country?.code || code));
    });
    if (!_providerUiLock) {
        syncTemplateFromProviderIfNeeded();
        refreshProviderPreview();
        maybeAutoNameProfile();
    }
}

let _lastAutoName = '';
function maybeAutoNameProfile() {
    if (_providerUiLock || connectionMode !== 'provider') return;
    const provider = getActiveProvider();
    if (!provider || !fName) return;
    const sessionBtn = sessionSeg?.querySelector('.session-seg-btn.active');
    const suggested = pp.suggestProfileName?.(
        provider.id,
        fCountryCode?.value,
        sessionBtn?.dataset.session,
    );
    if (!suggested) return;
    const cur = fName.value.trim();
    // Replace the name only while it is still the auto-suggested one (any provider), never a user's edit.
    if (!cur || cur === 'New Profile' || cur === _lastAutoName || cur.startsWith(provider.name)) {
        fName.value = suggested;
        _lastAutoName = suggested;
    }
}

function renderCountryDropdown(provider) {
    if (!countryDropdown || !provider) {
        if (countryDropdown) countryDropdown.innerHTML = '';
        return;
    }
    countryDropdown.innerHTML = '';
    const groups = pp.groupCountriesByRegion?.(provider) || [];
    for (const { region, countries } of groups) {
        const label = document.createElement('div');
        label.className = 'country-region-label';
        label.textContent = region;
        countryDropdown.appendChild(label);
        for (const c of countries) {
            const opt = document.createElement('div');
            opt.className = 'country-option';
            opt.dataset.code = c.code;
            const flag = countryCodeToFlagEmoji(c.code.toUpperCase());
            opt.innerHTML = `<span class="country-option-flag">${flag}</span><span>${esc(c.name)}</span><span class="country-option-code">${esc(c.code.toUpperCase())}</span>`;
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                setCountrySelection(c.code);
                countryDropdown.classList.remove('open');
                fCountrySearch?.removeAttribute('readonly');
            });
            countryDropdown.appendChild(opt);
        }
    }
}

function initProviderDropdown() {
    if (!fProvider || !pp.getProxyProviders) return;
    populateProfileProviderSelect(fProvider);
    fProvider.addEventListener('change', () => {
        const val = fProvider.value;
        if (val === CUSTOM_LINK_ID) {
            setConnectionMode('manual');
            updateProviderCredsStatus();
            return;
        }
        if (connectionMode === 'manual') setConnectionMode('provider');
        const provider = getActiveProvider();
        if (providerTypeHint) {
            providerTypeHint.textContent = provider
                ? `${provider.type} · ${provider.countries.length} countries`
                : '';
        }
        renderCountryDropdown(provider);
        if (provider?.countries?.length) {
            setCountrySelection(provider.countries[0].code);
        }
        updateSessionUi(provider);
        renderProviderOptions(provider);
        updateProviderCredsFieldsVisibility();
        syncTemplateFromProviderIfNeeded();
        refreshProviderPreview();
        maybeAutoNameProfile();
        updateProviderCredsStatus();
        if (!_providerUiLock && isNew && usesInlineCredentials()) {
            prefillCredentialsFromExistingProfile(provider?.id).catch(() => {});
        }
    });
    [fProviderUser, fProviderPass].forEach((el) => el?.addEventListener('input', () => {
        if (_providerUiLock) return;
        syncTemplateFromProviderIfNeeded();
        refreshProviderPreview();
        updateProviderCredsStatus();
    }));
}

/** Provider select: providers (credentials typed inline) always; "Custom URL" only in Advanced mode. */
function populateProfileProviderSelect(selectEl) {
    if (!selectEl || !pp.getProxyProviders) return;
    const cur = selectEl.value;
    selectEl.innerHTML = '<option value="">Select provider…</option>';
    for (const prov of pp.getProxyProviders() || []) {
        const opt = document.createElement('option');
        opt.value = prov.id;
        opt.textContent = prov.name;
        selectEl.appendChild(opt);
    }
    if (editorMode !== 'simple') {
        const customOpt = document.createElement('option');
        customOpt.value = CUSTOM_LINK_ID;
        customOpt.textContent = pp.CUSTOM_LINK_PROVIDER_LABEL || 'Custom URL';
        selectEl.appendChild(customOpt);
    }
    if (cur) selectEl.value = cur;
    if (cur && selectEl.value !== cur) selectEl.value = '';
}

/** New profile for a provider: reuse the credentials of the newest existing profile of that provider. */
async function prefillCredentialsFromExistingProfile(providerId) {
    if (!providerId || !pmModel.findCredentialSourceProfile || !fProviderUser || !fProviderPass) return;
    if (fProviderUser.value.trim() || fProviderPass.value) return;
    const src = pmModel.findCredentialSourceProfile(profiles, providerId);
    if (!src) return;
    const username = src.variables?.__username || '';
    let password = '';
    try {
        const url = await api.getProxyProfileUrl(src.id);
        password = pmModel.extractCredentialsFromUrl?.(url || '').password || '';
    } catch { /* ignore */ }
    if (fProviderUser.value.trim() || fProviderPass.value) return; // user typed meanwhile
    fProviderUser.value = username;
    fProviderPass.value = password;
    syncTemplateFromProviderIfNeeded();
    refreshProviderPreview();
    updateProviderCredsStatus();
}

function populateProfileFilters() {
    if (!filterProviderEl && !filterCountryEl) return;
    const providerIds = new Set();
    const countries = new Map();
    for (const p of profiles) {
        const meta = pp.getProfileProviderMeta?.(p.variables);
        if (meta?.providerId && meta.providerId !== CUSTOM_LINK_ID) providerIds.add(meta.providerId);
        const cc = countryCodeFromProfileLastGeo(p);
        if (cc) countries.set(cc.toLowerCase(), cc.toUpperCase());
    }
    if (filterProviderEl) {
        const cur = filterProvider;
        filterProviderEl.innerHTML = '<option value="">All providers</option>';
        const optCustom = document.createElement('option');
        optCustom.value = CUSTOM_LINK_ID;
        optCustom.textContent = pp.CUSTOM_LINK_PROVIDER_LABEL || 'Custom URL';
        filterProviderEl.appendChild(optCustom);
        for (const id of [...providerIds].sort()) {
            const prov = pp.getProxyProviderById?.(id);
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = prov?.name || id;
            filterProviderEl.appendChild(opt);
        }
        const validValues = new Set([...providerIds, '', CUSTOM_LINK_ID]);
        filterProviderEl.value = validValues.has(cur) ? cur : '';
        if (!validValues.has(cur)) filterProvider = filterProviderEl.value;
    }
    if (filterCountryEl) {
        const cur = filterCountry;
        filterCountryEl.innerHTML = '<option value="">All countries</option>';
        for (const [code] of [...countries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const opt = document.createElement('option');
            opt.value = code;
            const flag = countryCodeToFlagEmoji(code.toUpperCase());
            opt.textContent = `${flag ? flag + ' ' : ''}${code.toUpperCase()}`;
            filterCountryEl.appendChild(opt);
        }
        filterCountryEl.value = countries.has(cur) ? cur : '';
        if (!countries.has(cur)) filterCountry = filterCountryEl.value;
    }
}

function initCountryPicker() {
    fCountrySearch?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!getActiveProvider()) return;
        fCountrySearch.removeAttribute('readonly');
        countryDropdown?.classList.add('open');
        fCountrySearch.select();
    });
    fCountrySearch?.addEventListener('input', () => {
        const q = (fCountrySearch.value || '').toLowerCase().replace(/[^\w\s]/g, '');
        countryDropdown?.querySelectorAll('.country-option').forEach(el => {
            const name = el.textContent.toLowerCase();
            el.style.display = !q || name.includes(q) ? '' : 'none';
        });
        countryDropdown?.classList.add('open');
    });
    document.addEventListener('click', () => {
        countryDropdown?.classList.remove('open');
        if (fCountrySearch?.value && fCountryCode?.value) fCountrySearch.setAttribute('readonly', '');
    });
}

function initSessionControls() {
    sessionSeg?.querySelectorAll('.session-seg-btn').forEach(btn => {
        btn.addEventListener('click', () => setSessionMode(btn.dataset.session));
    });
    const syncDur = (val) => {
        const n = Math.max(1, Math.min(1440, parseInt(val, 10) || 30));
        if (fDurationMin) fDurationMin.value = String(n);
        if (fDurationSlider) fDurationSlider.value = String(n);
        syncTemplateFromProviderIfNeeded();
        refreshProviderPreview();
    };
    fDurationMin?.addEventListener('input', () => syncDur(fDurationMin.value));
    fDurationSlider?.addEventListener('input', () => syncDur(fDurationSlider.value));
    [fProviderUser, fProviderPass].forEach(el => {
        el?.addEventListener('input', debounce(() => {
            syncTemplateFromProviderIfNeeded();
            refreshProviderPreview();
        }, 200));
    });
}

function loadProviderFromVariables(vars) {
    _providerUiLock = true;
    try {
        const v = vars || {};
        const mode = (v.__connectionMode === 'provider' && v.__provider) ? 'provider' : 'manual';
        if (mode === 'manual') {
            if (fProvider) fProvider.value = CUSTOM_LINK_ID;
            setConnectionMode('manual');
        } else {
            setConnectionMode('provider');
            populateProfileProviderSelect(fProvider);
            if (v.__provider && fProvider) fProvider.value = v.__provider;
            fProvider?.dispatchEvent(new Event('change'));
            if (v.__country) setCountrySelection(v.__country);
            if (v.__sessionMode) setSessionMode(v.__sessionMode);
            if (v.__durationMin != null) {
                if (fDurationMin) fDurationMin.value = String(v.__durationMin);
                if (fDurationSlider) fDurationSlider.value = String(v.__durationMin);
            }
            loadProviderOptionsFromVars(v);
            if (fProviderUser) fProviderUser.value = v.__username || '';
            if (fProviderPass) fProviderPass.value = v.__password || '';
        }
        updateProviderCredsFieldsVisibility();
        syncTemplateFromProviderIfNeeded();
        refreshProviderPreview();
        updateProviderCredsStatus();
    } finally {
        _providerUiLock = false;
    }
}

/** Fill the inline password from the decrypted template (credentials are never stored in variables). */
function loadInlinePasswordFromTemplate(template) {
    if (!fProviderPass || !usesInlineCredentials()) return;
    const creds = pmModel.extractCredentialsFromUrl ? pmModel.extractCredentialsFromUrl(template) : { password: '' };
    if (creds.password) fProviderPass.value = creds.password;
    if (!fProviderUser?.value.trim() && creds.username) fProviderUser.value = creds.username;
}

function shouldPreserveEditorSelection() {
    return isEditorPanelVisible() && (editorDirty || (selectedId != null && selectedId !== DIRECT_ID));
}

connModeSwitch?.querySelectorAll('.conn-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setConnectionMode(btn.dataset.mode));
});

initProviderDropdown();
initCountryPicker();
initSessionControls();
providerOptionsPanel?.addEventListener('input', onProviderOptionsChanged);
providerOptionsPanel?.addEventListener('change', onProviderOptionsChanged);
filterProviderEl?.addEventListener('change', () => {
    filterProvider = filterProviderEl.value;
    renderProfileList();
});
filterCountryEl?.addEventListener('change', () => {
    filterCountry = filterCountryEl.value;
    renderProfileList();
});

/** Build all current non-ephemeral vars (saved + current editor inputs) */
function getCurrentSavedVars() {
    const profile = profiles.find(p => p.id === selectedId);
    const base    = profile?.variables || {};
    return { ...base, ...collectVarsFromForm() };
}

/** Full resolution for connect/test (replaces RAND too) */
function resolveTemplateFull(template, savedVars) {
    const merged = { ...savedVars, ...ephemeralVars };
    return template
        .replace(/\{RAND:(\d+)-(\d+)\}/gi, (_, mn, mx) => {
            const min = parseInt(mn, 10), max = parseInt(mx, 10);
            return String(Math.floor(Math.random() * (max - min + 1)) + min);
        })
        .replace(/\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name) => {
            const key = Object.keys(merged).find(k => k.toUpperCase() === name.toUpperCase());
            return key !== undefined ? String(merged[key] ?? '') : match;
        });
}

// ─── Profile list ─────────────────────────────────────────────────────────────
function renderProfileList() {
    const q = searchQuery.toLowerCase();

    const directMatches = !q || 'direct'.includes(q) || 'default'.includes(q) || 'mitm'.includes(q) || 'no proxy'.includes(q) || 'upstream'.includes(q);
    if (profileListBuiltIn) {
        profileListBuiltIn.innerHTML = '';
        if (directMatches) {
            const el = document.createElement('div');
            el.className = 'profile-item profile-item-direct';
            if (selectedId === DIRECT_ID) el.classList.add('active-profile');
            if (connectedId === DIRECT_ID) el.classList.add('connected');
            const connLabel = connectedId === DIRECT_ID ? `<span class="pi-connected-label">● CONNECTED</span>` : '';
            el.innerHTML = `
            <div class="pi-name">Direct</div>
            <div class="pi-host" style="color:var(--dim)">No upstream proxy — MITM only</div>
            <div class="pi-meta">${connLabel}</div>`;
            el.addEventListener('click', () => tryOpenDirectEditor());
            profileListBuiltIn.appendChild(el);
        }
    }

    if (!profileList) return;
    profileList.innerHTML = '';

    const filtered = profiles.filter(p => {
        const meta = pp.getProfileProviderMeta?.(p.variables);
        if (filterProvider && (!meta || meta.providerId !== filterProvider)) return false;
        if (filterCountry) {
            const cc = countryCodeFromProfileLastGeo(p);
            if (!cc || cc.toLowerCase() !== filterCountry.toLowerCase()) return false;
        }
        if (!q) return true;
        return p.name.toLowerCase().includes(q);
    });

    const hasFilters = !!(q || filterProvider || filterCountry);
    if (!filtered.length) {
        profileList.innerHTML = hasFilters
            ? `<div class="empty-list">No matching profiles.</div>`
            : `<div class="empty-list">No profiles yet.<br><button type="button" class="btn primary sm empty-new-btn">New profile</button></div>`;
        return;
    }

    for (const p of filtered) {
        const el = document.createElement('div');
        el.className = 'profile-item';
        if (p.id === selectedId) el.classList.add('active-profile');
        if (p.id === connectedId) el.classList.add('connected');

        const latBadge = p.last_latency_ms != null
            ? `<span class="pi-badge lat">${p.last_latency_ms}ms</span>` : '';
        const geoCc = countryCodeFromLastGeoString(p.last_geo);
        const geoFlag = countryCodeToFlagEmoji(geoCc);
        const geoBadge = p.last_geo
            ? `<span class="pi-badge geo">${geoFlag ? `<span class="pi-flag" aria-hidden="true">${geoFlag}</span> ` : ''}${esc(p.last_geo)}</span>` : '';
        const ipBadge  = p.last_ip
            ? `<span class="pi-badge geo" style="color:#a5f3fc">${esc(p.last_ip)}</span>` : '';
        const connLabel = p.id === connectedId ? `<span class="pi-connected-label">● CONNECTED</span>` : '';
        const reSaveBadge = p.needsReSave
            ? `<span class="pi-badge" style="color:#fbbf24" title="Re-save required: upstream URL was stored without OS encryption">⚠ Re-save</span>`
            : '';

        const meta = pp.getProfileProviderMeta?.(p.variables);
        let providerBadge = '';
        let subtitle = '';
        if (meta) {
            const ccFlag = countryCodeToFlagEmoji(meta.countryCode?.toUpperCase());
            providerBadge = `<span class="pi-badge provider">${esc(meta.providerName)}</span>`;
            if (meta.countryName) {
                subtitle = `<div class="pi-subtitle">${ccFlag ? ccFlag + ' ' : ''}${esc(meta.countryName)}${meta.sessionMode === 'sticky' ? ' · Sticky' : ''}</div>`;
            }
        }

        const hostLine = meta
            ? (() => {
                const prov = pp.getProxyProviderById?.(meta.providerId);
                const c = prov ? pp.getProviderCountry?.(prov, meta.countryCode) : null;
                return c ? `${c.host}:${c.port}` : proxyHostLineFromUrlDisplay(p.url_display);
            })()
            : proxyHostLineFromUrlDisplay(p.url_display);
        const hostRow = hostLine
            ? `<div class="pi-host">${esc(hostLine)}</div>`
            : '';

        el.innerHTML = `
            <div class="pi-name">${esc(p.name)}</div>
            ${subtitle}
            ${hostRow}
            <div class="pi-meta">${providerBadge}${reSaveBadge}${geoBadge}${ipBadge}${latBadge}${connLabel}</div>`;

        el.title = proxyProfileListTitle(hostLine, p.name, p.url_display);

        el.addEventListener('click', () => tryOpenEditor(p.id));
        profileList.appendChild(el);
    }
}

function tryOpenDirectEditor() {
    if (selectedId === DIRECT_ID && isEditorPanelVisible()) return;
    if (!confirmDiscardIfDirty()) return;
    openDirectEditor();
}

function tryOpenEditor(id) {
    if (selectedId === id && isEditorPanelVisible()) return;
    if (!confirmDiscardIfDirty()) return;
    openEditor(id);
}

function tryOpenNewEditor() {
    if (isNew && isEditorPanelVisible()) return;
    ensureSavedBeforeAction('New Profile', () => openNewEditor());
}

// ─── Direct profile editor ────────────────────────────────────────────────────
function openDirectEditor() {
    selectedId    = DIRECT_ID;
    isNew         = false;
    ephemeralVars = {};
    lastResolvedVars = {};
    if (editorMode === 'simple') { seOpenDirect(); return; }
    seHide();

    // Direct = MITM without upstream. Identity is global (Browser Identity window), nothing to edit here.
    const profile = { ...DIRECT_PROFILE };
    document.body.dataset.direct = '1';
    document.getElementById('tab-btn-connection')?.click();

    editorEmpty.style.display  = 'none';
    editorWrap.style.display   = 'flex';
    editorTitle.textContent    = 'MITM (no upstream)';
    fName.value                = 'MITM (no upstream)';
    fTemplate.value            = '';
    fNotes.value               = '';
    varsSection.style.display  = 'none';
    varsTbody.innerHTML        = '';
    tplPreview.innerHTML       = '<span style="color:var(--green)">Local MITM — no upstream proxy URL</span>';

    // Hide proxy URL row, show read-only message
    const fTemplateRow = document.getElementById('f-template-row');
    if (fTemplateRow) fTemplateRow.style.display = 'none';
    if (connModeSwitch) connModeSwitch.style.display = 'none';
    if (providerPanel) providerPanel.classList.remove('active');
    if (manualPanel) manualPanel.classList.remove('active');

    btnDelete.style.display    = 'none';
    btnDuplicate.style.display = 'none';
    testResult.classList.remove('visible', 'ok', 'err');
    setSaveStatus('');
    updateEditorActionButtons();

    if (fUa)       fUa.value       = '';
    if (fTimezone) fTimezone.value = '';
    if (fLanguage) fLanguage.value = '';
    tlsLoadFromProfile(profile);
    updateFpBadge();
    setEditorDirty(false);
    renderProfileList();
}

// ─── Editor ───────────────────────────────────────────────────────────────────
function openEditor(id) {
    selectedId = id;
    isNew      = false;
    ephemeralVars = {};
    lastResolvedVars = (id === connectedId) ? { ..._storedResolvedVars } : {};

    const profile = profiles.find(p => p.id === id);
    if (!profile) return;

    // Manual / option-rich / identity-override profiles cannot be edited in Simple mode.
    if (editorMode === 'simple') {
        if (pmModel.editorModeForProfile && pmModel.editorModeForProfile(profile, 'simple', pp) === 'simple') {
            seOpenProfile(profile);
            return;
        }
        applyEditorMode('advanced');
        showToast('Switched to Advanced: this profile uses features not shown in Simple mode');
    }
    seHide();

    // Restore proxy URL row if was hidden by Direct editor
    const fTemplateRow = document.getElementById('f-template-row');
    if (fTemplateRow) fTemplateRow.style.display = '';
    if (connModeSwitch) connModeSwitch.style.display = '';
    delete document.body.dataset.direct;

    editorEmpty.style.display  = 'none';
    editorWrap.style.display   = 'flex';
    editorTitle.textContent    = profile.name;
    fName.value                = profile.name;
    fTemplate.value            = profile.url_display || '';  // show display (password masked) — real template comes from getProxyProfileUrl
    fNotes.value               = profile.notes || '';
    btnDelete.style.display    = '';
    btnDuplicate.style.display = '';
    updateEditorActionButtons();

    // Fingerprint fields
    if (fUa)       fUa.value       = profile.user_agent || '';
    if (fTimezone) fTimezone.value = profile.timezone   || '';
    if (fLanguage) fLanguage.value = profile.language   || '';
    tlsLoadFromProfile(profile);
    updateFpBadge();

    testResult.classList.remove('visible', 'ok', 'err');
    setSaveStatus('');

    // Fetch decrypted template for editor
    api.getProxyProfileUrl(id).then(template => {
        if (selectedId !== id) return; // user switched profiles meanwhile (A-352)
        if (template) fTemplate.value = template;
        loadProviderFromVariables(profile.variables || {});
        _providerUiLock = true;
        try { loadInlinePasswordFromTemplate(template || ''); } finally { _providerUiLock = false; }
        syncTemplateFromProviderIfNeeded();
        buildVarsTable(getEffectiveTemplate(), filterReservedFromVars(profile.variables || {}));
        updatePreview();
        updateProviderCredsStatus();
        setEditorDirty(false);
    });

    renderProfileList();
}

function openNewEditor() {
    selectedId = null;
    isNew      = true;
    ephemeralVars = {};
    lastResolvedVars = {};
    if (editorMode === 'simple') { seOpenNew(); return; }
    seHide();

    const fTemplateRow = document.getElementById('f-template-row');
    if (fTemplateRow) fTemplateRow.style.display = '';
    if (connModeSwitch) connModeSwitch.style.display = '';
    delete document.body.dataset.direct;

    editorEmpty.style.display  = 'none';
    editorWrap.style.display   = 'flex';
    editorTitle.textContent    = 'New Profile';
    fName.value                = '';
    fTemplate.value            = '';
    fNotes.value               = '';
    populateProfileProviderSelect(fProvider);
    const providersList = pp.getProxyProviders?.() || [];
    if (fProvider && providersList.length) {
        fProvider.value = providersList[0].id;
    } else if (fProvider) {
        fProvider.value = '';
    }
    if (fProviderUser) fProviderUser.value = '';
    if (fProviderPass) fProviderPass.value = '';
    setConnectionMode('provider');
    if (fProvider?.value) fProvider.dispatchEvent(new Event('change'));
    updateProviderCredsStatus();
    varsSection.style.display  = 'none';
    varsTbody.innerHTML        = '';
    tplPreview.innerHTML       = '—';
    btnDelete.style.display    = 'none';
    btnDuplicate.style.display = 'none';
    testResult.classList.remove('visible', 'ok', 'err');
    setSaveStatus('');
    updateEditorActionButtons();
    // Clear fingerprint fields
    if (fUa)       fUa.value       = '';
    if (fTimezone) fTimezone.value = '';
    if (fLanguage) fLanguage.value = '';
    tlsLoadFromProfile({});
    updateFpBadge();

    fName.focus();
    setEditorDirty(false);
    renderProfileList();
}

function closeEditor() {
    selectedId = null;
    isNew      = false;
    setEditorDirty(false);
    editorEmpty.style.display = '';
    editorWrap.style.display  = 'none';
    seHide();
    renderProfileList();
}

function buildVarsTable(template, savedVars) {
    const vars = parseTemplateVars(template || '');
    if (!vars.length) { varsSection.style.display = 'none'; varsTbody.innerHTML = ''; return; }
    varsSection.style.display = '';
    varsTbody.innerHTML = '';
    const isConnected = selectedId && selectedId === connectedId;
    for (const v of vars) {
        const tr = document.createElement('tr');
        if (v.type === 'rand') {
            const curVal = isConnected && lastResolvedVars['RAND'] ? lastResolvedVars['RAND'] : null;
            const curHtml = curVal
                ? `<span class="var-current-val">${esc(curVal)}</span>`
                : `<span class="var-current-hint">new on each connect</span>`;
            tr.innerHTML = `
                <td class="var-name-cell" style="color:#86efac">{RAND}</td>
                <td><span class="var-rand-range">${v.range}</span> ${curHtml}</td>
                <td><span class="var-badge-rand">AUTO</span></td>`;
        } else if (v.type === 'sid') {
            const val = ephemeralVars['SID'] || '';
            const curVal = isConnected && lastResolvedVars['SID'] ? lastResolvedVars['SID'] : null;
            const curHtml = curVal
                ? `<div class="var-current-val">${esc(curVal)}</div>`
                : '';
            tr.innerHTML = `
                <td class="var-name-cell" style="color:#f9a8d4">{SID}</td>
                <td><input class="var-input" type="text" placeholder="blank = cupnet + 10 random digits"
                     data-varname="SID" data-vartype="sid" value="${esc(val)}"
                     title="Leave blank to auto-generate: cupnet0123456789">${curHtml}</td>
                <td><span class="var-badge-sid">EPHEMERAL</span></td>`;
        } else {
            const val = savedVars[v.name] || '';
            const curVal = isConnected && lastResolvedVars[v.name] ? lastResolvedVars[v.name] : null;
            const curHtml = curVal && curVal !== val
                ? `<div class="var-current-val">${esc(curVal)}</div>`
                : '';
            tr.innerHTML = `
                <td class="var-name-cell">{${esc(v.name)}}</td>
                <td><input class="var-input" type="text" placeholder="value"
                     data-varname="${esc(v.name)}" data-vartype="saved" value="${esc(val)}">${curHtml}</td>
                <td><span class="var-badge-saved">SAVED</span></td>`;
        }
        varsTbody.appendChild(tr);
    }

    // Live update preview on var change
    varsTbody.querySelectorAll('.var-input').forEach(inp => {
        inp.addEventListener('input', () => {
            if (inp.dataset.vartype === 'sid') ephemeralVars['SID'] = inp.value;
            updatePreview();
        });
    });
}

function updatePreview() {
    if (connectionMode === 'provider') {
        refreshProviderPreview();
        return;
    }
    const tpl = fTemplate.value.trim();
    const saved = filterReservedFromVars(getCurrentSavedVars());
    tplPreview.innerHTML = tpl ? resolvePreview(tpl, saved) : '—';
}

fTemplate.addEventListener('input', debounce(() => {
    buildVarsTable(fTemplate.value, getCurrentSavedVars());
    updatePreview();
}, 300));

// ─── Save ─────────────────────────────────────────────────────────────────────
async function saveProfileFromForm({ silent = false } = {}) {
    if (seVisible()) return seSave({ silent });
    if (selectedId === DIRECT_ID) {
        // Nothing profile-specific to persist: Direct has no upstream and the identity is global.
        if (!silent) setSaveStatus('Direct has no settings to save', 'ok');
        setEditorDirty(false);
        return { success: true, id: DIRECT_ID };
    }

    if (connectionMode === 'provider' && !fName.value.trim()) maybeAutoNameProfile();
    const name = fName.value.trim();
    syncTemplateFromProviderIfNeeded();
    const template = getEffectiveTemplate();
    if (!name) {
        if (!silent) setSaveStatus('Name required', 'err');
        return { success: false, error: 'Name required' };
    }
    if (connectionMode === 'provider') {
        const binding = resolveProviderSelectBinding();
        if (!binding.providerId) {
            if (!silent) setSaveStatus('Select a provider', 'err');
            return { success: false, error: 'Provider required' };
        }
        const creds = getProviderCredentialsForCompile();
        if (usesInlineCredentials()) {
            const errs = pmModel.validateSimpleForm ? pmModel.validateSimpleForm({
                providerId: binding.providerId, username: creds.username, password: creds.password,
                countryCode: fCountryCode?.value || '',
                sessionMode: sessionSeg?.querySelector('.session-seg-btn.active')?.dataset.session,
                durationMin: fDurationMin?.value,
            }) : (creds.username && creds.password ? [] : ['Enter provider credentials']);
            if (errs.length) {
                if (!silent) setSaveStatus(errs[0], 'err');
                return { success: false, error: errs[0] };
            }
        } else if (!creds.username) {
            if (!silent) setSaveStatus('Add provider account on the left', 'err');
            return { success: false, error: 'Provider account required' };
        }
    }
    if (!template) {
        if (!silent) setSaveStatus('Proxy URL required', 'err');
        return { success: false, error: 'Proxy URL required' };
    }

    const savedVars = collectVarsFromForm();
    if (btnSave) btnSave.disabled = true;
    const profile = {
        id:         isNew ? undefined : selectedId,
        name,
        template,
        variables:  savedVars,
        notes:      fNotes.value.trim(),
        country:    (savedVars.__country || '').toLowerCase(),
        traffic_mode: 'mitm',
        // Browser identity is global (Browser ID) — a proxy profile stores none.
        user_agent: null, timezone: null, language: null,
        tls_profile: 'chrome', tls_ja3_mode: 'template', tls_ja3_custom: null, force_http1: 0, identity_override: 0,
    };
    try {
        const result = await api.saveProxyProfileFull(profile);
        if (result && result.success) {
            if (!silent) setSaveStatus('Saved ✓', 'ok');
            selectedId = result.id;
            isNew      = false;
            btnDelete.style.display = '';
            editorTitle.textContent = name;
            setEditorDirty(false);
            updateEditorActionButtons();
            await reloadProfilesFromMain();
            return { success: true, id: result.id };
        }
        if (!silent) setSaveStatus(`Error: ${result?.error || 'Save failed'}`, 'err');
        return { success: false, error: result?.error || 'Save failed' };
    } catch (e) {
        if (!silent) setSaveStatus(`Error: ${e?.message || String(e)}`, 'err');
        return { success: false, error: e?.message || String(e) };
    } finally {
        if (btnSave) btnSave.disabled = false;
    }
}

async function performConnectGlobal() {
    if (!selectedId && !isNew) return;
    if (isNew) return;
    const isReconnect = selectedId === connectedId;
    collectVarsFromForm();

    if (selectedId === DIRECT_ID) {
        btnConnectGlobal.disabled = true;
        btnConnectGlobal.textContent = 'Applying…';
        // Direct keeps the global browser identity (TLS included) — no per-profile values to pass.
        const result = await (api.connectDirect
            ? api.connectDirect()
            : api.disconnectProxy());

        if (result?.success !== false) connectedId = DIRECT_ID;
        updateEditorActionButtons();
        setSaveStatus(result?.success !== false ? 'Direct + MITM active ✓' : `Error: ${result?.error}`, result?.success !== false ? 'ok' : 'err');
        renderProfileList();
        return;
    }

    btnConnectGlobal.disabled = true;
    btnConnectGlobal.textContent = isReconnect ? 'Reconnecting…' : 'Connecting…';
    const result = await api.connectProxyTemplate(selectedId, ephemeralVars);
    if (result.success) {
        connectedId = selectedId;
        _storedResolvedVars = result.resolvedVars || {};
        lastResolvedVars = { ..._storedResolvedVars };
        updateEditorActionButtons();
        setSaveStatus('Connected ✓', 'ok');
        const profile = profiles.find(p => p.id === selectedId);
        if (profile) buildVarsTable(fTemplate.value, profile.variables || {});
    } else {
        updateEditorActionButtons();
        setSaveStatus(`Connect failed: ${result.error}`, 'err');
    }
    renderProfileList();
}

async function performTestProxy() {
    if (!selectedId && !isNew) return;
    if (isNew) return;
    btnTest.disabled = true;
    if (btnTestDefaultHtml) btnTest.innerHTML = 'Testing…';
    testResult.classList.remove('visible', 'ok', 'err');
    if (selectedId === DIRECT_ID) {
        setSaveStatus('Test applies to saved proxy profiles', 'err');
        btnTest.disabled = false;
        if (btnTestDefaultHtml) btnTest.innerHTML = btnTestDefaultHtml;
        return;
    }

    const result = await api.testProxyTemplate(selectedId, ephemeralVars);
    btnTest.disabled = false;
    if (btnTestDefaultHtml) btnTest.innerHTML = btnTestDefaultHtml;

    testResult.classList.add('visible');
    if (result.success && result.data) {
        testResult.classList.add('ok');
        const d = result.data;
        document.getElementById('tr-ip').textContent  = d.ip || '—';
        document.getElementById('tr-geo').textContent = formatTestLocationLine(d);
        document.getElementById('tr-org').textContent = d.org || '—';
        document.getElementById('tr-lat').textContent = result.latency ? `${result.latency}ms` : '—';
        document.getElementById('tr-url').textContent = result.resolvedUrl || '—';
        showToast('Test completed', 'ok');
    } else {
        testResult.classList.add('err');
        document.getElementById('tr-ip').textContent  = result.error || 'Failed';
        document.getElementById('tr-geo').textContent = '—';
        document.getElementById('tr-org').textContent = '—';
        document.getElementById('tr-lat').textContent = '—';
        document.getElementById('tr-url').textContent = result.resolvedUrl || '—';
        showToast(result.error || 'Test failed', 'err');
    }
    testResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    renderProfileList();
}

async function performDisconnectGlobal() {
    if (btnDisconnectGlobal.disabled) return;
    btnDisconnectGlobal.disabled = true;
    await api.disconnectProxy();
    btnDisconnectGlobal.disabled = false;
}

async function performDisconnectTopbar() {
    btnDisconnect.disabled = true;
    await api.disconnectProxy();
    btnDisconnect.disabled = false;
}

async function performDuplicateProfile() {
    if (!selectedId) return;
    const src = profiles.find(x => x.id === selectedId);
    if (!src) return;

    const realTemplate = await api.getProxyProfileUrl(selectedId).catch(() => '');

    selectedId = null;
    isNew      = true;
    ephemeralVars = {};
    lastResolvedVars = {};

    editorEmpty.style.display  = 'none';
    editorWrap.style.display   = 'flex';
    editorTitle.textContent    = `Copy of ${src.name}`;
    fName.value                = `${src.name} (copy)`;
    fTemplate.value            = realTemplate || src.url_display || '';
    fNotes.value               = src.notes || '';
    btnDelete.style.display    = 'none';
    btnDuplicate.style.display = 'none';
    testResult.classList.remove('visible', 'ok', 'err');
    setSaveStatus('');
    updateEditorActionButtons();

    if (fUa)       fUa.value       = src.user_agent || '';
    if (fTimezone) fTimezone.value = src.timezone    || '';
    if (fLanguage) fLanguage.value = src.language    || '';
    tlsLoadFromProfile(src);
    updateFpBadge();

    loadProviderFromVariables(src.variables || {});
    _providerUiLock = true;
    try { loadInlinePasswordFromTemplate(realTemplate || ''); } finally { _providerUiLock = false; }
    syncTemplateFromProviderIfNeeded();
    buildVarsTable(getEffectiveTemplate(), filterReservedFromVars(src.variables || {}));
    updatePreview();

    fName.focus();
    fName.select();
    setEditorDirty(true);
    renderProfileList();
}

// ─── Bulk / static list import (Advanced) ────────────────────────────────────
const bulkModalBackdrop = document.getElementById('bulk-modal-backdrop');
const bulkModalText     = document.getElementById('bulk-modal-text');
const bulkModalPrefix   = document.getElementById('bulk-modal-prefix');
const bulkModalCountry  = document.getElementById('bulk-modal-country');
const bulkModalStatus   = document.getElementById('bulk-modal-status');
const bulkModalImport   = document.getElementById('bulk-modal-import');
let _bulkParsed = null;

function openBulkModal() {
    if (!bulkModalBackdrop) return;
    if (bulkModalText) bulkModalText.value = '';
    if (bulkModalPrefix) bulkModalPrefix.value = '';
    if (bulkModalCountry) bulkModalCountry.value = '';
    _bulkParsed = null;
    if (bulkModalStatus) bulkModalStatus.textContent = 'Paste a list to see what will be imported.';
    if (bulkModalImport) { bulkModalImport.disabled = true; bulkModalImport.textContent = 'Import'; }
    bulkModalBackdrop.classList.add('open');
    bulkModalBackdrop.setAttribute('aria-hidden', 'false');
    bulkModalText?.focus();
}
function closeBulkModal() {
    bulkModalBackdrop?.classList.remove('open');
    bulkModalBackdrop?.setAttribute('aria-hidden', 'true');
}
function refreshBulkPreview() {
    if (!psi.parseStaticProxyLines) return;
    _bulkParsed = psi.parseStaticProxyLines(bulkModalText?.value || '');
    const { entries, errors, duplicates } = _bulkParsed;
    const parts = [`${entries.length} proxies ready`];
    if (duplicates) parts.push(`${duplicates} duplicate${duplicates > 1 ? 's' : ''} skipped`);
    if (errors.length) parts.push(`${errors.length} invalid line${errors.length > 1 ? 's' : ''}: ${errors.slice(0, 3).map((e) => `#${e.line} ${e.reason}`).join('; ')}${errors.length > 3 ? '…' : ''}`);
    if (bulkModalStatus) bulkModalStatus.textContent = parts.join(' · ');
    if (bulkModalImport) bulkModalImport.disabled = entries.length === 0;
}
async function runBulkImport() {
    if (!_bulkParsed || !_bulkParsed.entries.length) return;
    const names = psi.suggestStaticProfileNames ? psi.suggestStaticProfileNames(_bulkParsed.entries, bulkModalPrefix?.value) : _bulkParsed.entries.map((e) => `${e.host}:${e.port}`);
    const country = (bulkModalCountry?.value || '').trim().toLowerCase();
    if (bulkModalImport) { bulkModalImport.disabled = true; bulkModalImport.textContent = 'Importing…'; }
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < _bulkParsed.entries.length; i++) {
        const e = _bulkParsed.entries[i];
        try {
            const res = await api.saveProxyProfileFull({
                name: names[i],
                template: e.url,
                variables: { __connectionMode: 'manual' },
                notes: 'Imported from list',
                country,
                traffic_mode: 'mitm',
                tls_profile: 'chrome', tls_ja3_mode: 'template', tls_ja3_custom: null, force_http1: 0,
                identity_override: 0,
            });
            if (res && res.success) ok++; else failed++;
        } catch { failed++; }
    }
    closeBulkModal();
    showToast(`Imported ${ok} proxy profile${ok === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`, failed ? 'err' : 'ok');
    await reloadProfilesFromMain();
}
document.getElementById('btn-bulk-import')?.addEventListener('click', openBulkModal);
document.getElementById('bulk-modal-close')?.addEventListener('click', closeBulkModal);
document.getElementById('bulk-modal-cancel')?.addEventListener('click', closeBulkModal);
bulkModalBackdrop?.addEventListener('click', (e) => { if (e.target === bulkModalBackdrop) closeBulkModal(); });
bulkModalText?.addEventListener('input', refreshBulkPreview);
bulkModalImport?.addEventListener('click', () => runBulkImport());

btnSave.addEventListener('click', () => saveProfileFromForm());

btnCancel.addEventListener('click', () => {
    if (!confirmDiscardIfDirty()) return;
    closeEditor();
});

btnDelete.addEventListener('click', async () => {
    if (!selectedId) return;
    const p = profiles.find(x => x.id === selectedId);
    if (!confirm(`Delete profile "${p?.name}"?`)) return;
    await api.deleteProxyProfileById(selectedId);
    closeEditor();
});

btnDuplicate?.addEventListener('click', async () => {
    if (!selectedId) return;
    await ensureSavedBeforeAction('Copy', () => performDuplicateProfile());
});

// ─── Connect / Disconnect (global) + Apply to tab ───────────────────────────
function updateConnectDisconnectButtons() {
    if (!btnConnectGlobal || !btnDisconnectGlobal) return;

    [btnConnectGlobal, btnTest, btnDuplicate, btnHeaderNew, btnDisconnectGlobal].forEach(btn => {
        btn?.classList.remove('has-unsaved');
    });

    const unsaved = hasUnsavedEditorChanges();
    const unsavedTitle = 'Unsaved changes — save before continuing';

    if (btnHeaderNew && unsaved) {
        btnHeaderNew.classList.add('has-unsaved');
        btnHeaderNew.title = unsavedTitle;
    } else if (btnHeaderNew) {
        btnHeaderNew.title = 'New profile (⌘N)';
    }

    if (btnTest && unsaved) {
        btnTest.classList.add('has-unsaved');
        btnTest.title = unsavedTitle;
    } else if (btnTest) {
        btnTest.title = 'Test proxy (⌘⇧T)';
    }

    if (btnDuplicate && unsaved) {
        btnDuplicate.classList.add('has-unsaved');
        btnDuplicate.title = unsavedTitle;
    } else if (btnDuplicate) {
        btnDuplicate.title = 'Duplicate this profile';
    }

    btnConnectGlobal.classList.remove('connected-state', 'has-unsaved');

    if (!selectedId && !isNew) {
        btnConnectGlobal.disabled = true;
        btnConnectGlobal.textContent = 'Connect';
        btnConnectGlobal.title = 'Select a profile to connect';
    } else if (isNew) {
        btnConnectGlobal.disabled = false;
        btnConnectGlobal.textContent = 'Connect';
        btnConnectGlobal.title = unsaved ? unsavedTitle : 'Connect selected profile for all tabs';
        if (unsaved) btnConnectGlobal.classList.add('has-unsaved');
    } else if (selectedId === connectedId) {
        btnConnectGlobal.disabled = false;
        btnConnectGlobal.textContent = 'Reconnect';
        btnConnectGlobal.classList.add('connected-state');
        btnConnectGlobal.title = unsaved ? unsavedTitle : 'Re-apply this profile to all tabs';
        if (unsaved) btnConnectGlobal.classList.add('has-unsaved');
    } else {
        btnConnectGlobal.disabled = false;
        btnConnectGlobal.textContent = selectedId === DIRECT_ID ? 'Connect (Direct)' : 'Connect';
        btnConnectGlobal.title = unsaved ? unsavedTitle : 'Connect selected profile for all tabs';
        if (unsaved) btnConnectGlobal.classList.add('has-unsaved');
    }

    const hasGlobalConnection = connectedId != null;
    btnDisconnectGlobal.disabled = !hasGlobalConnection;
    if (btnDisconnectGlobal && hasGlobalConnection) {
        btnDisconnectGlobal.title = unsaved ? unsavedTitle : 'Disconnect global proxy / upstream';
        if (unsaved) btnDisconnectGlobal.classList.add('has-unsaved');
    }
    if (btnDisconnect) {
        btnDisconnect.title = unsaved && hasGlobalConnection ? unsavedTitle : 'Disconnect proxy';
        btnDisconnect.classList.toggle('has-unsaved', unsaved && hasGlobalConnection);
    }
}

function updateEditorActionButtons() {
    updateConnectDisconnectButtons();
    seUpdateButtons();
}

btnConnectGlobal.addEventListener('click', async () => {
    if (!selectedId && !isNew) return;
    const isReconnect = selectedId === connectedId;
    const label = isReconnect ? 'Reconnect' : 'Connect';
    await ensureSavedBeforeAction(label, () => performConnectGlobal());
});

btnDisconnectGlobal.addEventListener('click', async () => {
    await ensureSavedBeforeAction('Disconnect', () => performDisconnectGlobal());
});

// ─── Test ─────────────────────────────────────────────────────────────────────
btnTest.addEventListener('click', async () => {
    if (!selectedId && !isNew) return;
    await ensureSavedBeforeAction('Test', () => performTestProxy());
});

// ─── Disconnect button (topbar) ───────────────────────────────────────────────
btnDisconnect.addEventListener('click', async () => {
    await ensureSavedBeforeAction('Disconnect', () => performDisconnectTopbar());
});

async function runCheckIp() {
    btnCheckIp.disabled = true;
    btnCheckIp.classList.add('checking');
    try {
        const geo = await api.checkIpGeo();
        if (geo && geo.ip !== 'unknown') {
            currentIp = geo.ip;
            statusIp.textContent = formatStatusIpLine(geo);
            syncStatusSepVisibility();
        }
    } finally {
        btnCheckIp.disabled = false;
        btnCheckIp.classList.remove('checking');
    }
}

btnCheckIp.addEventListener('click', () => runCheckIp());
statusPillBtn?.addEventListener('click', () => runCheckIp());

btnEmptyNew?.addEventListener('click', () => tryOpenNewEditor());
document.getElementById('btn-simple-new')?.addEventListener('click', () => tryOpenNewEditor());

// ─── Search ───────────────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => { searchQuery = searchInput.value; renderProfileList(); });

// ─── Add new ──────────────────────────────────────────────────────────────────
btnAddProfile?.addEventListener('click', () => tryOpenNewEditor());
btnHeaderNew?.addEventListener('click', () => tryOpenNewEditor());
profileList?.addEventListener('click', (e) => {
    if (e.target.closest('.empty-new-btn')) tryOpenNewEditor();
});

document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 's') {
        e.preventDefault();
        if (isEditorPanelVisible()) btnSave.click();
    }
    if (mod && e.key === 'n') {
        e.preventDefault();
        tryOpenNewEditor();
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        if (isEditorPanelVisible()) btnTest?.click();
    }
    if (e.key === 'Escape' && unsavedModalBackdrop?.classList.contains('open')) {
        e.preventDefault();
        closeUnsavedModal('cancel');
        return;
    }
    if (e.key === 'Escape' && bulkModalBackdrop?.classList.contains('open')) {
        e.preventDefault();
        closeBulkModal();
        return;
    }
    if (e.key === 'Escape' && isEditorPanelVisible()) {
        e.preventDefault();
        if (!confirmDiscardIfDirty()) return;
        closeEditor();
    }
});

// ─── IPC events ───────────────────────────────────────────────────────────────
api.onProxyStatusChanged((info) => {
    const active    = info?.active;
    const isDirect  = info?.mode === 'direct';

    statusDot.className  = `status-dot ${active ? 'active' : (isDirect ? 'direct' : 'inactive')}`;
    if (statusCard) {
        statusCard.classList.remove('active', 'direct');
        if (active) statusCard.classList.add('active');
        else if (isDirect) statusCard.classList.add('direct');
    }
    statusLabel.textContent = active
        ? (info.proxyName || 'Proxy').slice(0, 48)
        : (isDirect ? 'Direct (MITM only)' : 'No proxy');
    btnDisconnect.style.display = active ? '' : 'none';

    if (!active && !isDirect) {
        connectedId = null;
        _storedResolvedVars = {};
        lastResolvedVars = {};
        renderProfileList();
    } else if (active && info.resolvedVars && Object.keys(info.resolvedVars).length) {
        _storedResolvedVars = info.resolvedVars;
        lastResolvedVars = { ..._storedResolvedVars };
    }
    if (isDirect) {
        connectedId = DIRECT_ID;
        if (selectedId !== DIRECT_ID && !shouldPreserveEditorSelection()) {
            openDirectEditor();
        } else {
            renderProfileList();
        }
    } else if (active) {
        connectedId = info.profileId || connectedId;
        renderProfileList();
    }

    // Refresh connect button text for the currently open editor
    updateEditorActionButtons();

    // Re-check IP automatically after proxy change
    statusIp.textContent = 'Checking…';
    syncStatusSepVisibility();
    setTimeout(async () => {
        try {
            const geo = await api.checkIpGeo();
            if (geo && geo.ip !== 'unknown') {
                currentIp = geo.ip;
                statusIp.textContent = formatStatusIpLine(geo);
            } else {
                statusIp.textContent = '—';
            }
        } catch { statusIp.textContent = 'Error'; }
        syncStatusSepVisibility();
    }, 1200);
});

// ─── AzureTLS live stats ──────────────────────────────────────────────────────
const msDot    = document.getElementById('mitm-dot');
const msRps    = document.getElementById('ms-rps');
const msAvg    = document.getElementById('ms-avg');
const msPend   = document.getElementById('ms-pend');
const msTotal  = document.getElementById('ms-total');
const msErr    = document.getElementById('ms-err');
const msBrowser= document.getElementById('ms-browser');

function applyMitmStats(s) {
    if (!s) return;
    // Worker status dot
    if (msDot) {
        if (!s.workerReady) {
            msDot.className = 'mitm-stat-dot error';
            msDot.title = 'Worker not ready';
        } else if (s.pending > 5) {
            msDot.className = 'mitm-stat-dot busy';
            msDot.title = `${s.pending} requests in flight`;
        } else {
            msDot.className = 'mitm-stat-dot ready';
            msDot.title = 'Worker ready';
        }
    }
    if (msRps)    msRps.textContent    = s.reqPerSec > 0 ? s.reqPerSec.toFixed(1) : '0';
    if (msAvg)    msAvg.textContent    = s.avgMs > 0 ? s.avgMs + 'ms' : '—';
    if (msPend)   msPend.textContent   = s.pending;
    if (msTotal)  msTotal.textContent  = s.requests;
    if (msErr)    msErr.textContent    = s.errors;
    if (msBrowser) msBrowser.textContent = s.browser || 'chrome';

    if (msErrWrap) msErrWrap.style.display = s.errors > 0 ? '' : 'none';
}

// Subscribe to live updates
api.onMitmStatsUpdate && api.onMitmStatsUpdate(applyMitmStats);

// Initial load
api.getMitmStats && api.getMitmStats().then(applyMitmStats).catch(() => {});

// ─── Init ─────────────────────────────────────────────────────────────────────
function reloadProfilesFromMain() {
    return api.getProxyProfiles().then((list) => {
        profiles = list || [];
        populateProfileFilters();
        renderProfileList();
    }).catch((e) => {
        console.error('[proxy-manager] getProxyProfiles failed', e);
        showToast('Could not load proxy profiles', 'err');
        renderProfileList();
    });
}
reloadProfilesFromMain();
api.onProxyProfilesList((list) => {
    profiles = Array.isArray(list) ? list : [];
    populateProfileFilters();
    renderProfileList();
});

// Load initial proxy state — select Direct if that's the current mode
api.getCurrentProxy().then(info => {
    if (!info) return;
    const isDirect = info.mode === 'direct' || (!info.active && !info.proxyName);
    if (info.resolvedVars && Object.keys(info.resolvedVars).length) {
        _storedResolvedVars = info.resolvedVars;
        lastResolvedVars = { ..._storedResolvedVars };
    }
    if (isDirect) {
        connectedId = DIRECT_ID;
        if (!shouldPreserveEditorSelection()) {
            openDirectEditor();
        }
    } else if (info.active) {
        connectedId = info.profileId || null;
        if (connectedId && !shouldPreserveEditorSelection()) {
            selectedId = connectedId;
            openEditor(connectedId);
        }
        renderProfileList();
    }
}).catch(() => {});

// Initial IP check
api.checkIpGeo().then(geo => {
    if (geo && geo.ip !== 'unknown') {
        currentIp = geo.ip;
        statusIp.textContent = formatStatusIpLine(geo);
        syncStatusSepVisibility();
    }
}).catch(() => {});

// ─── Traffic Optimization ─────────────────────────────────────────────────────
const trafficMaster   = document.getElementById('traffic-master-toggle');
const trafficToggles  = document.querySelectorAll('.traffic-opt');
const trafficGroup    = document.getElementById('traffic-toggles-group');
const captchaWLField  = document.getElementById('f-captcha-whitelist');
const trafficBadge    = document.getElementById('traffic-active-badge');

function updateTrafficUI() {
    const enabled = trafficMaster?.checked;
    if (trafficGroup) trafficGroup.classList.toggle('disabled', !enabled);
    if (trafficBadge) trafficBadge.style.display = enabled ? '' : 'none';
}

function collectTrafficOpts() {
    const opts = { trafficEnabled: !!trafficMaster?.checked };
    trafficToggles.forEach(t => { opts[t.dataset.opt] = t.checked; });
    opts.captchaWhitelist = (captchaWLField?.value || '')
        .split('\n').map(l => l.trim()).filter(Boolean);
    return opts;
}

function applyTrafficOptsToUI(opts) {
    if (!opts) return;
    if (trafficMaster) trafficMaster.checked = !!opts.trafficEnabled;
    trafficToggles.forEach(t => { t.checked = !!opts[t.dataset.opt]; });
    if (captchaWLField && opts.captchaWhitelist) {
        captchaWLField.value = opts.captchaWhitelist.join('\n');
    }
    updateTrafficUI();
}

trafficMaster?.addEventListener('change', () => {
    updateTrafficUI();
    api.saveTrafficOpts(collectTrafficOpts());
});

trafficToggles.forEach(t => {
    t.addEventListener('change', () => {
        api.saveTrafficOpts(collectTrafficOpts());
    });
});

let captchaWLTimer;
captchaWLField?.addEventListener('input', () => {
    clearTimeout(captchaWLTimer);
    captchaWLTimer = setTimeout(() => {
        api.saveTrafficOpts(collectTrafficOpts());
    }, 800);
});

api.getTrafficOpts().then(applyTrafficOptsToUI).catch(() => {});


// ─── Simple editor ────────────────────────────────────────────────────────────
// One card: provider chips, credentials, country, session, "Save & Connect". Profiles that need
// anything else (manual URLs, options, fallback lists, identity overrides) open in Advanced.
const seEl = {
    root: document.getElementById('simple-editor'),
    title: document.getElementById('se-title'),
    unsaved: document.getElementById('se-unsaved-dot'),
    state: document.getElementById('se-state'),
    cardProfile: document.getElementById('se-card-profile'),
    cardDirect: document.getElementById('se-card-direct'),
    providers: document.getElementById('se-providers'),
    user: document.getElementById('se-user'),
    pass: document.getElementById('se-pass'),
    passToggle: document.getElementById('se-pass-toggle'),
    country: document.getElementById('se-country'),
    sessionSeg: document.getElementById('se-session-seg'),
    duration: document.getElementById('se-duration'),
    durationMin: document.getElementById('se-duration-min'),
    name: document.getElementById('se-name'),
    saveConnect: document.getElementById('se-save-connect'),
    save: document.getElementById('se-save'),
    test: document.getElementById('se-test'),
    disconnect: document.getElementById('se-disconnect'),
    del: document.getElementById('se-delete'),
    status: document.getElementById('se-status'),
    useDirect: document.getElementById('se-use-direct'),
    directState: document.getElementById('se-direct-state'),
};
let seProviderId = null;
let seNameAuto = '';
let seLoading = false;

function seVisible() {
    return !!seEl.root && getComputedStyle(seEl.root).display !== 'none';
}

function seSetStatus(msg, kind = '') {
    if (!seEl.status) return;
    seEl.status.textContent = msg || '';
    seEl.status.className = `se-status ${kind}`.trim();
}

function seShow(kind) {
    if (!seEl.root) return;
    editorEmpty.style.display = 'none';
    editorWrap.style.display = 'none';
    seEl.root.style.display = 'flex';
    seEl.cardProfile.style.display = kind === 'direct' ? 'none' : '';
    seEl.cardDirect.style.display = kind === 'direct' ? '' : 'none';
    document.body.dataset.direct = kind === 'direct' ? '1' : '';
    if (kind !== 'direct') delete document.body.dataset.direct;
    seSetStatus('');
    testResult?.classList.remove('visible', 'ok', 'err');
    renderProfileList();
    seUpdateButtons();
}

function seHide() {
    if (seEl.root) seEl.root.style.display = 'none';
}

function seRenderProviders() {
    if (!seEl.providers || !pp.getProxyProviders) return;
    seEl.providers.innerHTML = '';
    for (const prov of pp.getProxyProviders()) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'se-chip' + (prov.id === seProviderId ? ' active' : '');
        b.dataset.provider = prov.id;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', prov.id === seProviderId ? 'true' : 'false');
        b.textContent = prov.name;
        b.addEventListener('click', () => seSelectProvider(prov.id));
        seEl.providers.appendChild(b);
    }
}

function seFillCountries(providerId, selectedCode) {
    if (!seEl.country) return;
    const prov = pp.getProxyProviderById?.(providerId);
    seEl.country.innerHTML = '';
    if (!prov) return;
    const groups = pp.groupCountriesByRegion?.(prov) || [{ region: 'Countries', countries: prov.countries || [] }];
    for (const { region, countries } of groups) {
        const og = document.createElement('optgroup');
        og.label = region;
        for (const c of countries) {
            const opt = document.createElement('option');
            opt.value = c.code;
            const flag = countryCodeToFlagEmoji(String(c.code || '').toUpperCase());
            opt.textContent = `${flag ? flag + ' ' : ''}${c.name}`;
            og.appendChild(opt);
        }
        seEl.country.appendChild(og);
    }
    const want = selectedCode && (prov.countries || []).some((c) => c.code === selectedCode) ? selectedCode : (prov.countries?.[0]?.code || '');
    seEl.country.value = want;
}

function seSessionMode() {
    return seEl.sessionSeg?.querySelector('.session-seg-btn.active')?.dataset.session || 'rotating';
}

function seSetSession(mode) {
    seEl.sessionSeg?.querySelectorAll('.session-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.session === mode));
    const prov = pp.getProxyProviderById?.(seProviderId);
    const showDuration = mode === 'sticky' && (prov?.duration?.supported ?? true);
    if (seEl.duration) seEl.duration.style.display = showDuration ? '' : 'none';
    if (prov?.duration && seEl.durationMin) {
        seEl.durationMin.min = String(prov.duration.min ?? 1);
        seEl.durationMin.max = String(prov.duration.max ?? 1440);
    }
}

function seAutoName() {
    if (seLoading || !seEl.name || !seProviderId) return;
    const suggested = pp.suggestProfileName?.(seProviderId, seEl.country?.value, seSessionMode()) || '';
    if (!suggested) return;
    const cur = seEl.name.value.trim();
    if (!cur || cur === seNameAuto) {
        seEl.name.value = suggested;
        seNameAuto = suggested;
    }
}

async function seMaybePrefillCredentials(providerId) {
    if (seLoading || !isNew || !providerId || !pmModel.findCredentialSourceProfile) return;
    if (seEl.user.value.trim() || seEl.pass.value) return;
    const src = pmModel.findCredentialSourceProfile(profiles, providerId);
    if (!src) return;
    let password = '';
    try {
        const url = await api.getProxyProfileUrl(src.id);
        password = pmModel.extractCredentialsFromUrl?.(url || '').password || '';
    } catch { /* ignore */ }
    if (!isNew || seProviderId !== providerId || seEl.user.value.trim() || seEl.pass.value) return;
    seEl.user.value = src.variables?.__username || '';
    seEl.pass.value = password;
    seSetStatus(`Credentials reused from "${src.name}"`, '');
}

function seSelectProvider(providerId, { countryCode, silent } = {}) {
    seProviderId = providerId || null;
    seRenderProviders();
    seFillCountries(seProviderId, countryCode);
    seSetSession(seSessionMode());
    seAutoName();
    if (!silent) {
        setEditorDirty(true);
        seMaybePrefillCredentials(seProviderId).catch(() => {});
    }
}

function seCollect() {
    return {
        providerId: seProviderId,
        username: seEl.user?.value.trim() || '',
        password: seEl.pass?.value || '',
        countryCode: seEl.country?.value || '',
        sessionMode: seSessionMode(),
        durationMin: seEl.durationMin?.value,
        name: seEl.name?.value.trim() || '',
    };
}

function seUpdateButtons() {
    if (!seEl.root || !seVisible()) return;
    const connected = selectedId != null && selectedId === connectedId;
    if (seEl.disconnect) seEl.disconnect.style.display = connected && selectedId !== DIRECT_ID ? '' : 'none';
    if (seEl.del) seEl.del.style.display = !isNew && selectedId != null && selectedId !== DIRECT_ID ? '' : 'none';
    if (seEl.state) seEl.state.textContent = connected ? '● CONNECTED' : '';
    if (seEl.saveConnect) seEl.saveConnect.textContent = connected ? 'Save & Reconnect' : 'Save & Connect';
    if (seEl.unsaved) seEl.unsaved.style.display = editorDirty ? 'inline-block' : 'none';
    const directActive = connectedId === DIRECT_ID;
    if (seEl.useDirect) seEl.useDirect.disabled = directActive;
    if (seEl.directState) seEl.directState.textContent = directActive ? '● Direct is active' : '';
}

function seOpenNew() {
    seLoading = true;
    try {
        seEl.title.textContent = 'New profile';
        seEl.user.value = '';
        seEl.pass.value = '';
        seEl.name.value = '';
        seNameAuto = '';
        seSetSession('rotating');
        if (seEl.durationMin) seEl.durationMin.value = '30';
        const first = pp.getProxyProviders?.()?.[0]?.id || null;
        seSelectProvider(first, { silent: true });
    } finally {
        seLoading = false;
    }
    seAutoName();
    seShow('profile');
    setEditorDirty(false);
    seMaybePrefillCredentials(seProviderId).catch(() => {});
    seEl.user.focus();
}

function seOpenProfile(profile) {
    const v = profile.variables || {};
    seLoading = true;
    try {
        seEl.title.textContent = profile.name || 'Profile';
        seEl.name.value = profile.name || '';
        seNameAuto = '';
        seEl.user.value = v.__username || '';
        seEl.pass.value = '';
        if (seEl.durationMin) seEl.durationMin.value = String(v.__durationMin || 30);
        seSelectProvider(v.__provider || null, { countryCode: v.__country, silent: true });
        seSetSession(v.__sessionMode === 'sticky' ? 'sticky' : 'rotating');
    } finally {
        seLoading = false;
    }
    seShow('profile');
    setEditorDirty(false);
    const id = profile.id;
    api.getProxyProfileUrl(id).then((template) => {
        if (selectedId !== id || !seVisible()) return;
        const creds = pmModel.extractCredentialsFromUrl ? pmModel.extractCredentialsFromUrl(template || '') : { username: '', password: '' };
        if (creds.password) seEl.pass.value = creds.password;
        if (!seEl.user.value.trim() && creds.username) seEl.user.value = creds.username;
        setEditorDirty(false);
    }).catch(() => {});
}

function seOpenDirect() {
    seShow('direct');
    setEditorDirty(false);
}

async function seSave({ silent = false, connectAfter = false } = {}) {
    if (!seVisible() || selectedId === DIRECT_ID) return { success: true, id: selectedId };
    const form = seCollect();
    const errs = pmModel.validateSimpleForm ? pmModel.validateSimpleForm(form) : [];
    if (errs.length) {
        if (!silent) seSetStatus(errs[0], 'err');
        return { success: false, error: errs[0] };
    }
    const existing = !isNew && selectedId != null ? profiles.find((p) => p.id === selectedId) : null;
    if (!form.name) { seAutoName(); form.name = seEl.name.value.trim(); }
    const built = pmModel.buildSimpleProfile(pp, { ...form, id: existing ? existing.id : undefined, notes: existing?.notes || '' });
    if (!built.profile) {
        const err = built.errors?.[0] || 'Cannot build the proxy URL';
        if (!silent) seSetStatus(err, 'err');
        return { success: false, error: err };
    }
    seSetStatus('Saving…', 'busy');
    [seEl.save, seEl.saveConnect, seEl.test].forEach((b) => { if (b) b.disabled = true; });
    try {
        const res = await api.saveProxyProfileFull(built.profile);
        if (!res || !res.success) {
            seSetStatus(`Save failed: ${res?.error || 'unknown error'}`, 'err');
            return { success: false, error: res?.error || 'Save failed' };
        }
        selectedId = res.id;
        isNew = false;
        seEl.title.textContent = built.profile.name;
        setEditorDirty(false);
        await reloadProfilesFromMain();
        if (!connectAfter) seSetStatus(silent ? '' : 'Saved ✓', 'ok');
        seUpdateButtons();
        return { success: true, id: res.id };
    } catch (e) {
        seSetStatus(`Save failed: ${e?.message || e}`, 'err');
        return { success: false, error: e?.message || String(e) };
    } finally {
        [seEl.save, seEl.saveConnect, seEl.test].forEach((b) => { if (b) b.disabled = false; });
    }
}

async function seSaveAndConnect() {
    const saved = await seSave({ silent: true, connectAfter: true });
    if (!saved.success) return;
    seSetStatus('Connecting…', 'busy');
    if (seEl.saveConnect) seEl.saveConnect.disabled = true;
    try {
        const result = await api.connectProxyTemplate(saved.id, {});
        if (result?.success) {
            connectedId = saved.id;
            _storedResolvedVars = result.resolvedVars || {};
            lastResolvedVars = { ..._storedResolvedVars };
            seSetStatus('Connected ✓ — all tabs now use this proxy. Checking the exit IP…', 'ok');
            renderProfileList();
        } else {
            seSetStatus(`Connect failed: ${result?.error || 'unknown error'}`, 'err');
        }
    } catch (e) {
        seSetStatus(`Connect failed: ${e?.message || e}`, 'err');
    } finally {
        if (seEl.saveConnect) seEl.saveConnect.disabled = false;
        seUpdateButtons();
    }
}

async function seTest() {
    const saved = editorDirty || isNew ? await seSave({ silent: true }) : { success: true, id: selectedId };
    if (!saved.success) return;
    seSetStatus('Testing…', 'busy');
    if (seEl.test) seEl.test.disabled = true;
    try {
        const result = await api.testProxyTemplate(saved.id, {});
        if (result?.success && result.data) {
            const d = result.data;
            const parts = [d.ip || '—', formatTestLocationLine(d), d.org || '', result.latency ? `${result.latency}ms` : ''].filter(Boolean);
            seSetStatus(`Test OK · ${parts.join(' · ')}`, 'ok');
        } else {
            seSetStatus(`Test failed: ${result?.error || 'unknown error'}`, 'err');
        }
        await reloadProfilesFromMain();
    } catch (e) {
        seSetStatus(`Test failed: ${e?.message || e}`, 'err');
    } finally {
        if (seEl.test) seEl.test.disabled = false;
    }
}

async function seDelete() {
    if (isNew || selectedId == null || selectedId === DIRECT_ID) return;
    const p = profiles.find((x) => x.id === selectedId);
    if (!confirm(`Delete profile "${p?.name || selectedId}"?`)) return;
    await api.deleteProxyProfileById(selectedId);
    closeEditor();
}

seEl.passToggle?.addEventListener('click', () => {
    if (!seEl.pass) return;
    seEl.pass.type = seEl.pass.type === 'password' ? 'text' : 'password';
});
seEl.sessionSeg?.addEventListener('click', (e) => {
    const b = e.target.closest('.session-seg-btn');
    if (!b) return;
    seSetSession(b.dataset.session);
    seAutoName();
    setEditorDirty(true);
});
seEl.country?.addEventListener('change', () => seAutoName());
seEl.name?.addEventListener('input', () => { seNameAuto = ''; });
seEl.save?.addEventListener('click', () => seSave());
seEl.saveConnect?.addEventListener('click', () => seSaveAndConnect());
seEl.test?.addEventListener('click', () => seTest());
seEl.disconnect?.addEventListener('click', async () => {
    seEl.disconnect.disabled = true;
    try { await api.disconnectProxy(); seSetStatus('Disconnected — traffic goes direct through the local MITM.', ''); }
    finally { seEl.disconnect.disabled = false; seUpdateButtons(); }
});
seEl.del?.addEventListener('click', () => seDelete());
seEl.useDirect?.addEventListener('click', async () => {
    seEl.useDirect.disabled = true;
    try {
        const r = await (api.connectDirect ? api.connectDirect() : api.disconnectProxy());
        if (r?.success !== false) connectedId = DIRECT_ID;
    } finally { seUpdateButtons(); renderProfileList(); }
});
