'use strict';

const api = window.electronAPI;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const backBtn        = document.getElementById('back-btn');
const forwardBtn     = document.getElementById('forward-btn');
const reloadBtn      = document.getElementById('reload-btn');
const homeBtn        = document.getElementById('home-btn');
const urlInput       = document.getElementById('url-input');
const addressBarContainer = document.getElementById('address-bar-container');
const urlInputStack  = document.querySelector('.url-input-stack');
const urlDisplayEl   = document.getElementById('url-display');
const siteInfoBtn    = document.getElementById('site-info-btn');
const urlClearBtn    = document.getElementById('url-clear-btn');
const corsBtn        = document.getElementById('cors-btn');
const urlOmniboxDropdown = document.getElementById('url-omnibox-dropdown');
const omniboxListEl = document.getElementById('command-palette-list');
const omniboxHintEl = document.getElementById('url-omnibox-hint');
const URL_INPUT_PLACEHOLDER_DEFAULT = 'Type > for commands, or enter a URL…';
const URL_INPUT_PLACEHOLDER_OMNIBOX = 'Commands: > filter · URL: type and Enter';
const logSessionNum  = document.getElementById('log-session-num');
const logEntryBadge  = document.getElementById('log-entry-badge');
const logToggleBtn   = document.getElementById('log-toggle-btn');   // recording toggle
const logPill        = document.getElementById('log-pill');          // .tool-log-pill wrapper
const toolbar        = document.getElementById('browser-toolbar');
const tabList        = document.getElementById('tab-list');
const newTabBtn      = document.getElementById('new-tab-btn');
const logViewerBtn   = document.getElementById('log-viewer-btn');
const screenshotBtn  = document.getElementById('screenshot-btn');
const devtoolsBtn    = document.getElementById('devtools-btn');
const cookiesBtn     = document.getElementById('cookies-btn');
const dnsBtn         = document.getElementById('dns-btn');
const reqEditorBtn   = document.getElementById('req-editor-btn');
const rulesBtn       = document.getElementById('rules-btn');
const consoleBtn     = document.getElementById('console-btn');
const analyzerBtn    = document.getElementById('analyzer-btn');
const httpLabBtn     = document.getElementById('http-lab-btn');
const notesBtn       = document.getElementById('notes-btn');
const credUnifiedWrap = document.getElementById('cred-unified-wrap');
const credentialsBtn = document.getElementById('credentials-btn');
const credentialsSiteBadge = document.getElementById('credentials-site-badge');
const credPopup = document.getElementById('cred-popup');
const credPopupUnlock = document.getElementById('cred-popup-unlock');
const credPopupPw = document.getElementById('cred-popup-pw');
const credPopupUnlockBtn = document.getElementById('cred-popup-unlock-btn');
const credPopupUnlockErr = document.getElementById('cred-popup-unlock-err');
const credPopupList = document.getElementById('cred-popup-list');
const credPopupEmpty = document.getElementById('cred-popup-empty');
const credPopupOpenVault = document.getElementById('cred-popup-open-vault');
/** @type {Array<{ id: number, login: string, label: string }>} */
let credFillMatchesCache = [];
let credLongPressTimer = null;
let credLongPressFired = false;

// ─── Proxy pill refs ──────────────────────────────────────────────────────────
const pbStatusBtn    = document.getElementById('pb-status-btn');
const pbDot          = document.getElementById('pb-dot');
const pbName         = document.getElementById('pb-name');
const pbModeBadge    = document.getElementById('pb-mode-badge');
const settingsToggle = document.getElementById('settings-toggle-btn');

const statusPage      = document.getElementById('status-page');
const statusMitm      = document.getElementById('status-mitm');
const statusProxy     = document.getElementById('status-proxy');
const statusIp        = document.getElementById('status-ip');
const statusRequests  = document.getElementById('status-requests');
const statusErrors    = document.getElementById('status-errors');

const toastContainer  = document.getElementById('rule-toast-container');

// ─── Navigation ───────────────────────────────────────────────────────────────
backBtn.addEventListener('click',    () => api.navBack());
forwardBtn.addEventListener('click', () => api.navForward());
reloadBtn.addEventListener('click', () => {
    if (_toolbarLoading) {
        try { api.navStop?.(); } catch (_) { /* ignore */ }
    } else {
        api.navReload();
    }
});
if (homeBtn) homeBtn.addEventListener('click', () => api.navHome());

function isOmniboxDropdownVisible() {
    return addressBarContainer?.classList.contains('omnibox-open') ?? false;
}

urlInput.addEventListener('keydown', (e) => {
    const paletteOpen = isOmniboxDropdownVisible();
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab' && urlInput.selectionStart != null && urlInput.selectionEnd != null
        && urlInput.selectionEnd > urlInput.selectionStart
        && urlInput.selectionEnd === String(urlInput.value || '').length) {
        e.preventDefault();
        const len = urlInput.value.length;
        urlInput.setSelectionRange(len, len);
        return;
    }
    if (e.key === 'Enter' && (mod || e.altKey) && !paletteOpen) {
        e.preventDefault();
        const raw = urlInput.value.trim();
        if (!raw) return;
        hideCommandPalette();
        void (async () => {
            await api.newTab();
            api.navigateTo(raw);
        })();
        return;
    }
    if (!paletteOpen && e.key === 'Enter') {
        const raw = urlInput.value.trim();
        if (!raw) return;
        hideCommandPalette();
        _urlInputDirty = false;
        api.navigateTo(raw);
    }
});

function _normalizeToolbarUrl(url) {
    if (url === 'about:blank') return '';
    const u = String(url || '').trim().toLowerCase();
    if (u === 'cupnet://new-tab' || u === 'cupnet://newtab' || u === 'cupnet:new-tab') return '';
    return url || '';
}

const SEARCH_ENGINE_LABELS = {
    duckduckgo: 'DuckDuckGo',
    google: 'Google',
    brave: 'Brave',
    yandex: 'Yandex',
    custom: 'Custom',
};
let _cupnetSearchEngineKey = 'duckduckgo';

function _applyCorsToolbarVisual(on) {
    if (!corsBtn) return;
    const v = !!on;
    corsBtn.classList.toggle('cors-active', v);
    corsBtn.setAttribute('aria-pressed', v ? 'true' : 'false');
    corsBtn.title = v ? 'CORS bypass (MITM) — ON' : 'CORS bypass (MITM) — OFF';
}

api.onInitSettings?.((s) => {
    if (s && s.searchEngine) _cupnetSearchEngineKey = String(s.searchEngine);
    if (s && typeof s.corsBypassEnabled === 'boolean') _applyCorsToolbarVisual(s.corsBypassEnabled);
});

api.onCorsBypassStatus?.((on) => _applyCorsToolbarVisual(on));

corsBtn?.addEventListener('click', () => {
    void api.toggleCorsBypass?.();
});

function _searchEngineDisplayName() {
    return SEARCH_ENGINE_LABELS[_cupnetSearchEngineKey] || 'Search';
}

let _toolbarLoading = false;

function _looksLikeUrlOrHost(q) {
    const s = String(q || '').trim();
    if (!s) return false;
    if (/^[a-z][a-z\d+\-.]*:\/\//i.test(s)) return true;
    if (/^[^\s]+\.[^\s]{2,}$/.test(s) && !s.includes(' ')) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
    return false;
}

/** Origin-only input — keep in sync with utils.shouldSkipOmniboxInlineGhost */
function _shouldSkipInlineGhost(trimmed) {
    const t = String(trimmed || '').trim();
    if (!t) return true;
    return /^https?:\/\/[^/?#]+\/?$/i.test(t);
}

function _hasInlineGhostSelection() {
    if (!urlInput) return false;
    const start = urlInput.selectionStart;
    const end = urlInput.selectionEnd;
    return start != null && end != null && end > start && end === String(urlInput.value || '').length;
}

function _clearInlineGhostSelection() {
    if (!urlInput || !_hasInlineGhostSelection()) return false;
    const pos = urlInput.selectionStart ?? 0;
    urlInput.value = String(urlInput.value || '').slice(0, pos);
    urlInput.setSelectionRange(pos, pos);
    return true;
}

function _buildExactTypedUrlRow(q) {
    const trimmed = String(q || '').trim();
    if (!trimmed || !_looksLikeUrlOrHost(trimmed)) return null;
    return {
        kind: 'url',
        icon: 'url',
        label: `Open ${trimmed}`,
        sub: 'Typed URL',
        url: trimmed,
        _isExactTyped: true,
        match: null,
        urlPreview: trimmed,
    };
}

function _computeMatchRange(hay, needle) {
    const h = String(hay || '').toLowerCase();
    const n = String(needle || '').toLowerCase().trim();
    if (!n || !h) return null;
    const i = h.indexOf(n);
    if (i < 0) return null;
    return [i, i + n.length];
}

function _formatUrlForDisplay(raw) {
    const s = String(raw || '').trim();
    if (!s) return { html: '', plain: '' };
    try {
        const u = new URL(s);
        const host = u.hostname || '';
        if (!host) return { html: escapeAttr(s), plain: s };
        let rest = (u.pathname || '') + (u.search || '') + (u.hash || '');
        if (rest === '/') rest = '';
        return {
            html: `<span class="url-host">${escapeAttr(host)}</span><span class="url-rest">${escapeAttr(rest)}</span>`,
            plain: s,
        };
    } catch {
        return { html: escapeAttr(s), plain: s };
    }
}

function escapeAttr(t) {
    return String(t || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function escHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _updateUrlDisplayFromValue(raw) {
    if (!urlDisplayEl) return;
    const norm = _normalizeToolbarUrl(raw);
    if (!norm) {
        urlDisplayEl.innerHTML = '';
        return;
    }
    urlDisplayEl.innerHTML = _formatUrlForDisplay(norm).html;
}

function _updateSiteInfoBtn(urlRaw, faviconHint) {
    if (!siteInfoBtn) return;
    const u = String(urlRaw || '').trim().toLowerCase();
    siteInfoBtn.classList.remove('site-info-btn--insecure', 'site-info-btn--internal', 'site-info-btn--file');
    let mode = 'secure';
    if (!u || u === 'about:blank') mode = 'internal';
    else if (u.startsWith('file:')) { mode = 'file'; siteInfoBtn.classList.add('site-info-btn--file'); }
    else if (u.startsWith('http:')) { mode = 'insecure'; siteInfoBtn.classList.add('site-info-btn--insecure'); }
    else if (u.startsWith('cupnet:') || u.startsWith('devtools:')) {
        mode = 'internal';
        siteInfoBtn.classList.add('site-info-btn--internal');
    }
    const fc = window.CupNetFaviconCache;
    const fav = fc?.resolveSync(urlRaw, faviconHint) || null;
    if (fav && mode !== 'internal' && mode !== 'file') {
        siteInfoBtn.innerHTML = `<img class="site-info-favicon" src="${escapeAttr(fav)}" alt="" aria-hidden="true">`;
        void fc?.load(urlRaw, faviconHint).then((loaded) => {
            if (!loaded || loaded === fav) return;
            if (String(_committedToolbarUrl || '').trim().toLowerCase() !== u) return;
            const img = siteInfoBtn.querySelector('.site-info-favicon');
            if (img) img.src = loaded;
        });
        return;
    }
    const lock = '<svg class="site-info-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a3 3 0 00-3 3v2H4a1 1 0 00-1 1v6a1 1 0 001 1h8a1 1 0 001-1V7a1 1 0 00-1-1h-1V4a3 3 0 00-3-3zm-1 5V4a1 1 0 112 0v2H7z"/></svg>';
    const globe = '<svg class="site-info-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.5 1a5.6 5.6 0 012.9 1.2c-.3.4-.6.9-.9 1.3H6.5c-.3-.4-.6-.9-.9-1.3A5.6 5.6 0 017.5 2zM4.3 3.4c.3.5.7 1 1 1.6h5.4c.3-.6.7-1.1 1-1.6a6 6 0 014.1 5.1h-2.1c-.1-1.2-.4-2.3-.8-3.3H5.1c-.4 1-.7 2.1-.8 3.3H2.2a6 6 0 014.1-5.1zM2.2 9.9h2.1c.1 1.2.4 2.3.8 3.3h5.8c.4-1 .7-2.1.8-3.3h2.1a6 6 0 01-11.6 0zm4.6 4.7c.3-.4.6-.9.9-1.3h2.9c.3.4.6.9.9 1.3a5.6 5.6 0 01-4.7 0z"/></svg>';
    const info = '<svg class="site-info-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 100 14A7 7 0 008 1zm.8 3.2v1.6H7.2V4.2h1.6zM7.2 7h1.6v5H7.2V7z"/></svg>';
    if (mode === 'insecure') siteInfoBtn.innerHTML = info;
    else if (mode === 'internal' || mode === 'file') siteInfoBtn.innerHTML = info;
    else siteInfoBtn.innerHTML = u.startsWith('https:') ? lock : globe;
    if (fc && urlRaw && mode !== 'internal' && mode !== 'file') {
        const key = fc.hostKey(urlRaw);
        if (key && !fc.get(key)) {
            void fc.load(urlRaw, faviconHint).then((loaded) => {
                if (!loaded) return;
                if (String(_committedToolbarUrl || '').trim().toLowerCase() !== u) return;
                siteInfoBtn.innerHTML = `<img class="site-info-favicon" src="${escapeAttr(loaded)}" alt="" aria-hidden="true">`;
            });
        }
    }
}

let _committedToolbarUrl = '';
let _urlInputDirty = false;

function _activeTabFavicon() {
    const active = tabs.find((t) => t.isActive);
    return active?.faviconUrl || null;
}

function _syncUrlDisplayAndSiteInfo(url) {
    _updateUrlDisplayFromValue(url);
    _updateSiteInfoBtn(url, _activeTabFavicon());
}

function _setToolbarUrl(url, { forceInput = false, blur = false } = {}) {
    const normalized = _normalizeToolbarUrl(url);
    _committedToolbarUrl = normalized;
    _syncUrlDisplayAndSiteInfo(normalized);

    const inputFocused = document.activeElement === urlInput;
    const shouldUpdateInput = forceInput || !inputFocused || !_urlInputDirty;
    if (shouldUpdateInput && urlInput.value !== normalized) {
        urlInput.value = normalized;
        _urlInputDirty = false;
    }
    if (blur) urlInput.blur();
    if (urlClearBtn) {
        const show = !!(String(normalized || '').trim() && inputFocused);
        urlClearBtn.hidden = !show;
    }
}

function _setToolbarUrlIfChanged(url, { respectFocus = true, blur = false, forceInput = false } = {}) {
    if (respectFocus && !forceInput && document.activeElement === urlInput && _urlInputDirty) {
        _syncUrlDisplayAndSiteInfo(_normalizeToolbarUrl(url));
        return false;
    }
    _setToolbarUrl(url, { forceInput: forceInput || !respectFocus, blur });
    return true;
}

api.onURLUpdate((url) => {
    const normalized = _normalizeToolbarUrl(url);
    _setToolbarUrlIfChanged(normalized, { respectFocus: true });
    ssHandleUrlChange(normalized);
    hideCredPopup();
    scheduleCookiePageBadgeRefresh();
    scheduleCredentialsToolbarRefresh();
});

// Navigation started by a link click or JS (will-navigate).
// Force-update the address bar even if urlInput currently has focus
// (Tab WebContentsView clicks don't transfer focus to the chrome renderer).
api.onTabWillNavigate?.((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && active.id === data.tabId) {
        _clearPageError();
        const normalized = _normalizeToolbarUrl(data.url);
        _urlInputDirty = false;
        _setToolbarUrl(normalized, { forceInput: true, blur: true });
        ssHandleUrlChange(normalized);
        hideCredPopup();
        scheduleCookiePageBadgeRefresh();
        scheduleCredentialsToolbarRefresh();
    }
});

let _loadingApplied = false;
let _loadingPending = false;
let _loadingRaf = null;
let _loadingOffTimer = null;
let _pageErrorMessage = null;

function _clearPageError() {
    _pageErrorMessage = null;
    if (statusPage) statusPage.classList.remove('browser-status-item--error');
    if (addressBarContainer) addressBarContainer.classList.remove('address-bar-error');
}

function _showPageError(summary, { toast = true } = {}) {
    const msg = String(summary || 'Page failed to load').trim();
    if (!msg) return;
    _pageErrorMessage = msg;
    if (statusPage) {
        statusPage.textContent = 'Page: Error';
        statusPage.title = msg;
        statusPage.classList.remove('browser-status-item--loading', 'browser-status-item--ready');
        statusPage.classList.add('browser-status-item--error');
    }
    if (addressBarContainer) addressBarContainer.classList.add('address-bar-error');
    _toolbarLoading = false;
    if (reloadBtn) {
        reloadBtn.classList.remove('nav-btn--stop');
        reloadBtn.title = 'Reload (Ctrl+R)';
    }
    _applyToolbarLoading(false);
    if (toast && typeof showToast === 'function') {
        showToast(msg, { type: 'error', duration: 9000 });
    }
}

function _applyPageLoadStatus(loading) {
    if (!statusPage) return;
    if (_pageErrorMessage && !loading) return;
    const on = !!loading;
    if (on) _clearPageError();
    statusPage.textContent = on ? 'Page: Loading…' : 'Page: Ready';
    statusPage.classList.toggle('browser-status-item--loading', on);
    statusPage.classList.toggle('browser-status-item--ready', !on);
    statusPage.classList.remove('browser-status-item--error');
    statusPage.title = on ? 'Active tab is loading' : 'Active tab finished loading';
}

function _applyToolbarLoading(next) {
    const val = !!next;
    if (_loadingApplied === val) return;
    _loadingApplied = val;
    toolbar.classList.toggle('loading', val);
    if (addressBarContainer) addressBarContainer.classList.toggle('address-bar-loading', val);
    _applyPageLoadStatus(val);
}
function _scheduleToolbarLoading(next) {
    _loadingPending = !!next;
    if (_loadingRaf) return;
    _loadingRaf = requestAnimationFrame(() => {
        _loadingRaf = null;
        _applyToolbarLoading(_loadingPending);
    });
}
api.onSetLoadingState((loading) => {
    _toolbarLoading = !!loading;
    if (reloadBtn) {
        reloadBtn.classList.toggle('nav-btn--stop', _toolbarLoading);
        reloadBtn.title = _toolbarLoading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)';
    }
    if (loading) {
        if (_loadingOffTimer) { clearTimeout(_loadingOffTimer); _loadingOffTimer = null; }
        _scheduleToolbarLoading(true);
        return;
    }
    if (_loadingOffTimer) clearTimeout(_loadingOffTimer);
    // Keep spinner for a short grace period to avoid class flapping
    // on quick redirect/start-stop bursts.
    _loadingOffTimer = setTimeout(() => {
        _loadingOffTimer = null;
        _scheduleToolbarLoading(false);
    }, 90);
});

function _formatTabLoadError({ errorCode, errorDescription, url }) {
    const code = Number(errorCode);
    const desc = String(errorDescription || '').trim();
    let label = desc;
    if (!label) {
        if (code === -102) label = 'Connection refused';
        else if (code === -105) label = 'Host not found (DNS)';
        else if (code === -106) label = 'No internet connection';
        else if (code === -118) label = 'Connection timed out';
        else if (code === -200) label = 'Certificate error';
        else if (code === -501) label = 'HTTP response error';
        else if (code >= 400 && code < 500) label = `HTTP ${code} client error`;
        else if (code >= 500) label = `HTTP ${code} server error`;
        else label = `Load failed (${code})`;
    } else if (/^HTTP \d+$/.test(label)) {
        const m = label.match(/^HTTP (\d+)$/);
        if (m) {
            const sc = Number(m[1]);
            if (sc === 404) label = 'HTTP 404 Not Found';
            else if (sc >= 500) label = `HTTP ${sc} Server Error`;
            else if (sc >= 400) label = `HTTP ${sc} Client Error`;
        }
    }
    try {
        const u = new URL(String(url || ''));
        return `${label} — ${u.hostname}${u.pathname !== '/' ? u.pathname : ''}`;
    } catch {
        return url ? `${label} — ${url}` : label;
    }
}

api.onTabLoadError?.((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && data?.tabId != null && data.tabId !== active.id) return;
    _showPageError(_formatTabLoadError(data || {}));
});

api.onPageGatewayError?.((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && data?.tabId != null && data.tabId !== active.id) return;
    _showPageError(data?.summary || data?.errorMessage || 'Page failed to load (MITM gateway error)');
});

// ─── Logging toggle state ─────────────────────────────────────────────────────
let isLogging = false;
let _statusLogCount = 0;

function setLoggingVisual(on) {
    isLogging = on;
    // Unified log pill: add/remove 'recording' class for dot animation + color scheme
    if (logPill) logPill.classList.toggle('recording', on);
    if (logToggleBtn) {
        logToggleBtn.title = on ? 'Recording ON — click to stop' : 'Start recording (logging is OFF)';
    }
    // Screenshot button is only usable while logging is active
    if (screenshotBtn) {
        screenshotBtn.classList.toggle('tool-btn-disabled', !on);
        screenshotBtn.title = on
            ? 'Take screenshot · auto-captures active tab'
            : 'Logging is OFF — enable recording to use screenshots';
    }
    // Also hide/show the countdown badge when logging off
    if (!on && ssCountdownEl) ssCountdownEl.style.display = 'none';
}

api.onUpdateLogStatus((data) => {
    const on = !!(data && data.enabled);
    setLoggingVisual(on);
    _statusLogCount = (data && Number.isFinite(data.count)) ? data.count : 0;
    if (!on) {
        if (logSessionNum)  logSessionNum.textContent = '#—';
        if (logEntryBadge) { logEntryBadge.style.display = 'none'; logEntryBadge.textContent = '0'; }
        refreshBrowserStatusBar();
        return;
    }
    if (logSessionNum)  logSessionNum.textContent = `#${data.sessionId}`;
    if (logEntryBadge) {
        logEntryBadge.textContent = data.count >= 1000 ? `${Math.floor(data.count/1000)}k` : data.count;
        logEntryBadge.style.display = data.count > 0 ? '' : 'none';
    }
    refreshBrowserStatusBar();
});

logToggleBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isLogging) {
        await api.toggleLoggingStop().catch(console.error);
    } else {
        try {
            const r = logToggleBtn.getBoundingClientRect();
            await api.toggleLoggingStart({ x: r.left, y: r.top, w: r.width, h: r.height });
        } catch (err) {
            console.error('[LogToggle] toggleLoggingStart error:', err);
        }
    }
});

// ─── Tab bar ──────────────────────────────────────────────────────────────────
let tabs = [];

function _isHomePage(url) {
    return !url || url === 'about:blank' || url.includes('new-tab.html');
}

function _tabFallbackIcon(tab) {
    if (_isHomePage(tab.url)) return '⌂';
    if (tab.isolated) return '🍪';
    return '🌐';
}

function _formatTabTitle(tab) {
    const num = tab.num ? `#${tab.num}` : '';
    const name = tab.title || 'New Tab';
    return `${num} ${name}`;
}

function makeTabEl(tab) {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.isActive ? ' active' : '') + (tab.isolated ? ' isolated' : '');
    el.dataset.id = tab.id;
    el.title = (tab.url || '') + (tab.isolated ? ' [Isolated cookies]' : '');

    const fallbackIcon = _tabFallbackIcon(tab);
    const fc = window.CupNetFaviconCache;
    const faviconUrl = tab.faviconUrl || fc?.resolveSync(tab.url, null) || null;

    const faviconWrapper = document.createElement('span');
    faviconWrapper.className = 'tab-favicon-wrapper';
    if (faviconUrl) {
        const img = document.createElement('img');
        img.className = 'tab-favicon-img';
        img.src = faviconUrl;
        const fallback = document.createElement('span');
        fallback.className = 'tab-favicon';
        fallback.textContent = fallbackIcon;
        fallback.style.display = 'none';
        img.onerror = () => { img.style.display = 'none'; fallback.style.display = ''; };
        faviconWrapper.appendChild(img);
        faviconWrapper.appendChild(fallback);
    } else {
        const favicon = document.createElement('span');
        favicon.className = 'tab-favicon';
        favicon.textContent = fallbackIcon;
        faviconWrapper.appendChild(favicon);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = _formatTabTitle(tab);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close tab';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        api.closeTab(tab.id);
    });

    // Per-tab indicator dots
    const indicators = document.createElement('span');
    indicators.className = 'tab-indicators';
    {
        const dot = document.createElement('span');
        dot.className = 'tab-dot tab-dot-cupnet';
        dot.title = 'MITM / CupNet';
        indicators.appendChild(dot);
    }
    if (tab.proxyProfileId) {
        const dot = document.createElement('span');
        dot.className = 'tab-dot tab-dot-proxy';
        dot.title = 'Per-tab proxy';
        indicators.appendChild(dot);
    }
    if (tab.cookieGroupId && tab.cookieGroupId !== 1) {
        const dot = document.createElement('span');
        dot.className = 'tab-dot tab-dot-cookies';
        dot.title = 'Custom cookie group';
        indicators.appendChild(dot);
    }

    el.appendChild(faviconWrapper);
    if (indicators.childElementCount > 0) el.appendChild(indicators);
    el.appendChild(title);
    el.appendChild(closeBtn);
    el.addEventListener('click', () => {
        if (!el.classList.contains('active')) api.switchTab(tab.id);
    });
    return el;
}

function renderTabs(tabData) {
    tabs = tabData || [];

    // Build lookup of existing tab elements by id
    const existing = new Map();
    for (const el of tabList.querySelectorAll('.tab-item')) {
        existing.set(el.dataset.id, el);
    }

    const newIds = new Set(tabs.map(t => String(t.id)));

    // Remove tabs that no longer exist
    for (const [id, el] of existing) {
        if (!newIds.has(id)) el.remove();
    }

    // Insert/update/reorder tabs
    let insertBefore = newTabBtn || null;
    for (let i = tabs.length - 1; i >= 0; i--) {
        const tab = tabs[i];
        const idStr = String(tab.id);
        let el = existing.get(idStr);

        if (!el) {
            // New tab — create element
            el = makeTabEl(tab);
            tabList.insertBefore(el, insertBefore);
        } else {
            // Existing tab — patch in-place (avoid full rebuild)
            const wantClass = 'tab-item' + (tab.isActive ? ' active' : '') + (tab.isolated ? ' isolated' : '');
            if (el.className !== wantClass) el.className = wantClass;

            const wantTitle = (tab.url || '') + (tab.isolated ? ' [Isolated cookies]' : '');
            if (el.title !== wantTitle) el.title = wantTitle;

            const titleEl = el.querySelector('.tab-title');
            if (titleEl) {
                const want = _formatTabTitle(tab);
                if (titleEl.textContent !== want) titleEl.textContent = want;
            }

            const fallbackEl = el.querySelector('.tab-favicon');
            if (fallbackEl) {
                const wantIcon = _tabFallbackIcon(tab);
                if (fallbackEl.textContent !== wantIcon) fallbackEl.textContent = wantIcon;
            }

            const img = el.querySelector('.tab-favicon-img');
            if (img && tab.faviconUrl && img.src !== tab.faviconUrl) img.src = tab.faviconUrl;

            // Ensure correct order
            if (el !== tabList.children[i]) tabList.insertBefore(el, insertBefore);
        }
        insertBefore = el;
    }

    // Keep new-tab button at the end
    if (newTabBtn) tabList.appendChild(newTabBtn);
}

newTabBtn.addEventListener('click', () => {
    api.newTab(null);
});

// Legacy buttons removed — single "+" button creates regular tabs.
// CupNet ON/OFF is toggled via per-tab controls.

let _tabUiPending = null;
let _tabUiRaf = null;
function _scheduleTabUiUpdate(tabData) {
    _tabUiPending = tabData || [];
    if (_tabUiRaf) return;
    _tabUiRaf = requestAnimationFrame(() => {
        _tabUiRaf = null;
        const payload = _tabUiPending || [];
        _tabUiPending = null;
        window.CupNetFaviconCache?.ingestTabs(payload);
        renderTabs(payload);
        _onActiveTabChanged(payload);
        const active = payload.find(t => t.isActive);
        if (active) {
            const normalized = _normalizeToolbarUrl(active.url);
            _urlInputDirty = false;
            _setToolbarUrl(normalized, { forceInput: true });
            ssHandleUrlChange(normalized);
        }
        scheduleCookiePageBadgeRefresh();
        scheduleCredentialsToolbarRefresh();
    });
}

api.onTabListUpdated((tabData) => {
    _scheduleTabUiUpdate(tabData);
});

api.onTabUrlChanged((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && active.id === data.tabId) {
        const normalized = _normalizeToolbarUrl(data.url);
        _setToolbarUrlIfChanged(normalized, { respectFocus: true });
        ssHandleUrlChange(normalized);
        hideCredPopup();
        scheduleCookiePageBadgeRefresh();
        scheduleCredentialsToolbarRefresh();
    }
});

// ─── Right toolbar actions ────────────────────────────────────────────────────
if (logViewerBtn) {
    logViewerBtn.addEventListener('click', () => api.openLogViewer());
}

// ─── Screenshot countdown ─────────────────────────────────────────────────────

const ssCountdownEl = document.getElementById('screenshot-countdown');
const ssFlashEl     = document.getElementById('screenshot-flash');

let ssIntervalSec  = 0;   // configured interval (seconds)
let ssOnHomePage   = true; // pause countdown while on new-tab / home page

function ssFlash() {
    if (!ssFlashEl) return;
    // Cancel any running animation, remove class, then re-add on next frame
    // — avoids the forced synchronous reflow caused by offsetWidth read
    ssFlashEl.getAnimations().forEach(a => a.cancel());
    ssFlashEl.classList.remove('flash');
    requestAnimationFrame(() => ssFlashEl.classList.add('flash'));
}

function ssIsHomePage(url) {
    // Empty URL bar = new-tab.html, or explicit file:// path
    return !url || url === '' || url.includes('new-tab.html') || url.startsWith('file://');
}

function ssUpdateBadge(val) {
    if (!ssCountdownEl) return;
    if (!ssOnHomePage && ssIntervalSec > 0 && val > 0) {
        ssCountdownEl.style.display = '';
        ssCountdownEl.textContent   = val;
        ssCountdownEl.classList.toggle('urgent', val <= 1);
    } else {
        ssCountdownEl.style.display = 'none';
    }
}

function ssResetTimer(intervalSec) {
    ssIntervalSec = intervalSec;
    ssUpdateBadge(0);
}

function ssHandleUrlChange(url) {
    const onHome = ssIsHomePage(url);
    if (onHome === ssOnHomePage) return; // no change
    ssOnHomePage = onHome;
    if (onHome) {
        ssUpdateBadge(0);
    } else {
        ssUpdateBadge(0);
    }
}

// ─── Cookie count on toolbar (current page URL) ───────────────────────────────
const cookiePageBadge = document.getElementById('cookie-page-badge');
let _cookieBadgeTimer = null;
function scheduleCookiePageBadgeRefresh() {
    clearTimeout(_cookieBadgeTimer);
    _cookieBadgeTimer = setTimeout(() => { void refreshCookiePageBadge(); }, 450);
}
async function refreshCookiePageBadge() {
    if (!cookiePageBadge || !window.CupNetCookiePageMatch) return;
    const active = tabs.find(t => t.isActive);
    const url = active?.url || '';
    if (!active || ssIsHomePage(url)) {
        cookiePageBadge.style.display = 'none';
        cookiePageBadge.textContent = '';
        return;
    }
    try {
        const list = await api.getCookies(active.id, {});
        const n = window.CupNetCookiePageMatch.countCookiesForPageUrl(list, url);
        if (n > 0) {
            cookiePageBadge.textContent = n > 99 ? '99+' : String(n);
            cookiePageBadge.style.display = 'inline-flex';
        } else {
            cookiePageBadge.style.display = 'none';
            cookiePageBadge.textContent = '';
        }
    } catch {
        cookiePageBadge.style.display = 'none';
    }
}

// ─── Credentials toolbar: badge (matches for current site) + Fill button ───
let _credToolbarTimer = null;
function scheduleCredentialsToolbarRefresh() {
    clearTimeout(_credToolbarTimer);
    _credToolbarTimer = setTimeout(() => { void refreshCredentialsToolbarBadges(); }, 400);
}

function showCredToolbarToast(message, type) {
    if (!message) return;
    if (typeof showToast === 'function') {
        const t = type || (/could not|error|fail/i.test(String(message)) ? 'error' : 'success');
        showToast(String(message), { type: t, duration: 3200 });
        return;
    }
    if (!toastContainer) return;
    const el = document.createElement('div');
    el.className = 'rule-toast';
    el.style.whiteSpace = 'pre-wrap';
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 320);
    }, 3200);
}

function hideCredPopup() {
    if (!credPopup) return;
    credPopup.classList.add('hidden');
    if (credPopupUnlockErr) {
        credPopupUnlockErr.textContent = '';
        credPopupUnlockErr.classList.add('hidden');
    }
    if (credPopupPw) credPopupPw.value = '';
}

function showCredPopupUnlock() {
    if (!credPopup || !credPopupUnlock) return;
    credPopup.classList.remove('hidden');
    credPopupUnlock.classList.remove('hidden');
    if (credPopupList) credPopupList.classList.add('hidden');
    if (credPopupEmpty) credPopupEmpty.classList.add('hidden');
    setTimeout(() => {
        try {
            credPopupPw?.focus({ preventScroll: true });
        } catch {
            credPopupPw?.focus();
        }
    }, 30);
}

function showCredPopupList(matches) {
    if (!credPopup || !credPopupList) return;
    credPopup.classList.remove('hidden');
    if (credPopupUnlock) credPopupUnlock.classList.add('hidden');
    if (credPopupEmpty) credPopupEmpty.classList.add('hidden');
    credPopupList.classList.remove('hidden');
    credPopupList.innerHTML = (matches || []).map((row) => {
        const title = row.label || row.login || `Account ${row.id}`;
        const line2 = row.label && row.login ? row.login : '';
        return `<button type="button" class="cred-fill-menu-item" role="menuitem" data-cred-id="${row.id}">` +
            `<span class="cred-fill-menu-title">${escapeHtmlCred(title)}</span>` +
            (line2 ? `<span class="cred-fill-menu-sub">${escapeHtmlCred(line2)}</span>` : '') +
            '</button>';
    }).join('');
    credPopupList.querySelectorAll('.cred-fill-menu-item').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.getAttribute('data-cred-id'));
            hideCredPopup();
            try {
                const res = await api.credentialsFillActiveTab({ credentialId: id });
                if (res?.success) {
                    showCredToolbarToast('Filled login and password from vault.', 'success');
                } else {
                    showCredToolbarToast(res?.error || 'Could not fill this page.', 'error');
                }
            } catch (err) {
                showCredToolbarToast(String(err?.message || err), 'error');
            }
        });
    });
}

function showCredPopupEmpty() {
    if (!credPopup) return;
    credPopup.classList.remove('hidden');
    if (credPopupUnlock) credPopupUnlock.classList.add('hidden');
    if (credPopupList) {
        credPopupList.classList.add('hidden');
        credPopupList.innerHTML = '';
    }
    if (credPopupEmpty) credPopupEmpty.classList.remove('hidden');
}

function escapeHtmlCred(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

async function refreshCredentialsToolbarBadges() {
    if (!credentialsSiteBadge || !credUnifiedWrap) return;
    credFillMatchesCache = [];
    const active = tabs.find(t => t.isActive);
    const url = active?.url || '';
    if (!active || ssIsHomePage(url) || !/^https?:\/\//i.test(url)) {
        credentialsSiteBadge.style.display = 'none';
        credentialsSiteBadge.textContent = '';
        credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
        return;
    }
    if (!api.credentialsSiteMatchCount) {
        credentialsSiteBadge.style.display = 'none';
        credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
        return;
    }
    try {
        const r = await api.credentialsSiteMatchCount({ pageUrl: url });
        if (!r || !r.exists) {
            credentialsSiteBadge.style.display = 'none';
            credentialsSiteBadge.textContent = '';
            credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
            return;
        }
        const n = Number(r.count) || 0;
        const unlocked = r.unlocked === true;
        if (n > 0) {
            credentialsSiteBadge.textContent = n > 99 ? '99+' : String(n);
            credentialsSiteBadge.style.display = 'inline-flex';
            credentialsSiteBadge.classList.toggle('cred-badge-unlocked', unlocked);
            credentialsSiteBadge.classList.toggle('cred-badge-locked', !unlocked);
            if (unlocked && api.credentialsSiteMatches) {
                try {
                    const m = await api.credentialsSiteMatches({ pageUrl: url });
                    if (Array.isArray(m?.matches)) credFillMatchesCache = m.matches;
                } catch { /* ignore */ }
            }
        } else {
            credentialsSiteBadge.style.display = 'none';
            credentialsSiteBadge.textContent = '';
            credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
        }
    } catch {
        credentialsSiteBadge.style.display = 'none';
        credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
    }
}

// Main process took a scheduled screenshot → play flash + reset countdown
api.onScreenshotTaken(() => {
    ssFlash();
    ssResetTimer(ssIntervalSec);
});

if (screenshotBtn) {
    screenshotBtn.addEventListener('click', async () => {
        // If logging is off — ask user to start it first
        if (!isLogging) {
            try {
                const r = screenshotBtn.getBoundingClientRect();
                await api.toggleLoggingStart({ x: r.left, y: r.top, w: r.width, h: r.height });
            } catch (err) {
                console.error('[ScreenshotBtn] toggleLoggingStart error:', err);
            }
            return;
        }
        screenshotBtn.disabled = true;
        await api.takeScreenshot('click').catch(() => {});
        screenshotBtn.disabled = false;
        ssFlash();
        ssResetTimer(ssIntervalSec);
    });
}

if (devtoolsBtn) {
    devtoolsBtn.addEventListener('click', () => api.openDevTools());
}
if (cookiesBtn) {
    cookiesBtn.addEventListener('click', async () => {
        const tabs = await api.getTabs();
        const active = tabs.find(t => t.isActive);
        api.openCookieManager(active?.id || null);
    });
}
if (dnsBtn) {
    dnsBtn.addEventListener('click', () => {
        api.openDnsManager();
    });
}
if (reqEditorBtn) {
    reqEditorBtn.addEventListener('click', () => {
        api.openRequestEditor(null);
    });
}
if (rulesBtn) {
    rulesBtn.addEventListener('click', () => {
        api.openRulesWindow();
    });
}

if (consoleBtn) {
    consoleBtn.addEventListener('click', () => {
        api.openConsoleViewer();
    });
}

if (analyzerBtn) {
    analyzerBtn.addEventListener('click', () => {
        api.openPageAnalyzer();
    });
}

if (httpLabBtn) {
    httpLabBtn.addEventListener('click', () => {
        void api.injectActivePageHttpLab?.({}).catch((err) => {
            console.error('[HTTP Lab]', err);
            alert('Could not inject HTTP Lab: ' + (err?.message || err));
        });
    });
}

if (notesBtn) {
    notesBtn.addEventListener('click', () => {
        api.openNotesWindow();
    });
}

async function handleCredentialsToolbarPrimaryClick(ev) {
    ev.stopPropagation();
    if (credLongPressFired) {
        credLongPressFired = false;
        return;
    }
    const active = tabs.find(t => t.isActive);
    const url = active?.url || '';
    if (!active || ssIsHomePage(url) || !/^https?:\/\//i.test(url)) {
        showCredToolbarToast('Open a website to use saved credentials.', 'error');
        return;
    }
    if (!api.credentialsSiteMatchCount) return;
    let r;
    try {
        r = await api.credentialsSiteMatchCount({ pageUrl: url });
    } catch (e) {
        showCredToolbarToast(String(e?.message || e), 'error');
        return;
    }
    if (!r?.exists) {
        api.openCredentialsWindow();
        return;
    }
    const count = Number(r.count) || 0;
    const unlocked = r.unlocked === true;

    // If the dropdown was left open (e.g. empty state, SPA nav), the first click used to
    // only dismiss it — do nothing visible. For unlocked + exactly one match, dismiss then fill.
    const popupVisible = credPopup && !credPopup.classList.contains('hidden');
    if (popupVisible) {
        hideCredPopup();
        if (!(unlocked && count === 1)) {
            return;
        }
    }

    if (!unlocked) {
        showCredPopupUnlock();
        return;
    }

    if (count === 0) {
        showCredPopupEmpty();
        return;
    }
    if (count === 1) {
        try {
            const res = await api.credentialsFillActiveTab({});
            if (res?.success) {
                showCredToolbarToast('Filled login and password from vault.', 'success');
            } else {
                showCredToolbarToast(res?.error || 'Could not fill this page.', 'error');
            }
        } catch (e) {
            showCredToolbarToast(String(e?.message || e), 'error');
        }
        return;
    }
    let matches = credFillMatchesCache;
    if (matches.length !== count && api.credentialsSiteMatches) {
        try {
            const m = await api.credentialsSiteMatches({ pageUrl: url });
            if (Array.isArray(m?.matches)) matches = m.matches;
        } catch { /* use cache */ }
    }
    showCredPopupList(matches);
}

async function submitCredPopupUnlock() {
    const active = tabs.find(t => t.isActive);
    const url = active?.url || '';
    if (!credPopupPw || !api.credentialsUnlockAndGetMatches) return;
    const pw = credPopupPw.value;
    if (credPopupUnlockErr) {
        credPopupUnlockErr.textContent = '';
        credPopupUnlockErr.classList.add('hidden');
    }
    try {
        const r = await api.credentialsUnlockAndGetMatches({ password: pw, pageUrl: url });
        if (!r?.success) {
            if (credPopupUnlockErr) {
                credPopupUnlockErr.textContent = r?.error || 'Unlock failed';
                credPopupUnlockErr.classList.remove('hidden');
            }
            return;
        }
        credPopupPw.value = '';
        void scheduleCredentialsToolbarRefresh();
        const matches = Array.isArray(r.matches) ? r.matches : [];
        if (matches.length === 0) {
            showCredPopupEmpty();
            return;
        }
        if (matches.length === 1) {
            hideCredPopup();
            try {
                const res = await api.credentialsFillActiveTab({ credentialId: matches[0].id });
                if (res?.success) {
                    showCredToolbarToast('Filled login and password from vault.', 'success');
                } else {
                    showCredToolbarToast(res?.error || 'Could not fill this page.', 'error');
                }
            } catch (e) {
                showCredToolbarToast(String(e?.message || e), 'error');
            }
            return;
        }
        showCredPopupList(matches);
    } catch (e) {
        if (credPopupUnlockErr) {
            credPopupUnlockErr.textContent = String(e?.message || e);
            credPopupUnlockErr.classList.remove('hidden');
        }
    }
}

if (credentialsBtn) {
    credentialsBtn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        credLongPressFired = false;
        clearTimeout(credLongPressTimer);
        credLongPressTimer = setTimeout(() => {
            credLongPressTimer = null;
            credLongPressFired = true;
            hideCredPopup();
            api.openCredentialsWindow();
        }, 500);
    });
    credentialsBtn.addEventListener('pointerup', () => {
        clearTimeout(credLongPressTimer);
        credLongPressTimer = null;
    });
    credentialsBtn.addEventListener('pointerleave', () => {
        clearTimeout(credLongPressTimer);
        credLongPressTimer = null;
    });
    credentialsBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        hideCredPopup();
        api.openCredentialsWindow();
    });
    credentialsBtn.addEventListener('click', (ev) => void handleCredentialsToolbarPrimaryClick(ev));
}

if (credPopupUnlockBtn) {
    credPopupUnlockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void submitCredPopupUnlock();
    });
}
if (credPopupPw) {
    credPopupPw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void submitCredPopupUnlock();
        }
    });
    credPopupPw.addEventListener('click', (e) => e.stopPropagation());
}
if (credPopupOpenVault) {
    credPopupOpenVault.addEventListener('click', (e) => {
        e.stopPropagation();
        hideCredPopup();
        api.openCredentialsWindow();
    });
}
if (credPopup) {
    credPopup.addEventListener('click', (e) => e.stopPropagation());
}
document.addEventListener('click', (e) => {
    if (credUnifiedWrap && credUnifiedWrap.contains(e.target)) return;
    hideCredPopup();
});

if (api.onCredentialsToolbarRefresh) {
    api.onCredentialsToolbarRefresh(() => scheduleCredentialsToolbarRefresh());
}

// ─── Credential save bar (auto-capture prompt) ───────────────────────────────
const credSaveBar     = document.getElementById('credential-save-bar');
const credSaveDomain  = document.getElementById('cred-save-domain');
const credSaveLogin   = document.getElementById('cred-save-login');
const credSaveUnlockRow = document.getElementById('cred-save-unlock-row');
const credSavePw      = document.getElementById('cred-save-pw');
const credSaveYes     = document.getElementById('cred-save-yes');
const credSaveNever   = document.getElementById('cred-save-never');
const credSaveDismiss = document.getElementById('cred-save-dismiss');

/** Extra space above the tab WebContentsView when the credential save bar is visible. */
const CRED_SAVE_BAR_RESERVE_PX = 36;
const TOOLS_MINI_BAR_HEIGHT_PX = 34;
const TOOLS_SIDE_WIDTH_PX = 58;
const CHROME_TOP_BASE_PX = 95;
/** Overlay WebContentsView starts here (below tab bar + toolbar); matches tab-manager TOOLBAR_HEIGHT. */
const OMNIBOX_OVERLAY_TOP_PX = CHROME_TOP_BASE_PX;

const toolDockEl = document.querySelector('.tool-dock');
const toolDockMountInline = document.getElementById('tool-dock-mount-inline');
const toolDockMountSubbar = document.getElementById('tool-dock-mount-subbar');
const toolDockMountBottom = document.getElementById('tool-dock-mount-bottom');
const toolDockMountSeparate = document.getElementById('tool-dock-mount-separate');
const toolsSubbarEl = document.getElementById('browser-tools-subbar');
const toolsBottomEl = document.getElementById('browser-tools-bottom');
const toolsSeparateEl = document.getElementById('browser-tools-separate');
const TOOLBAR_PLACEMENTS = new Set(['inline', 'subbar', 'bottom', 'separate']);
let _toolbarToolsPlacement = 'subbar';
let _toolbarToolsMiniAlign = 'right';

function getCredSaveBarReservePx() {
    return credSaveBar && !credSaveBar.classList.contains('hidden') ? CRED_SAVE_BAR_RESERVE_PX : 0;
}

function updateShellChromeCssVars() {
    const top = CHROME_TOP_BASE_PX + getCredSaveBarReservePx();
    document.documentElement.style.setProperty('--shell-chrome-top', `${top}px`);
    document.documentElement.style.setProperty('--shell-status-height', '26px');
    document.documentElement.style.setProperty('--shell-tools-bar-height', `${TOOLS_MINI_BAR_HEIGHT_PX}px`);
    document.documentElement.style.setProperty('--shell-tools-side-width', `${TOOLS_SIDE_WIDTH_PX}px`);
}

async function applyChromeLayoutReserve() {
    updateShellChromeCssVars();
    const cred = getCredSaveBarReservePx();
    const subbar = _toolbarToolsPlacement === 'subbar' ? TOOLS_MINI_BAR_HEIGHT_PX : 0;
    const bottom = _toolbarToolsPlacement === 'bottom' ? TOOLS_MINI_BAR_HEIGHT_PX : 0;
    const side = _toolbarToolsPlacement === 'separate' ? TOOLS_SIDE_WIDTH_PX : 0;
    try {
        await api.setToolbarHeight(cred + subbar);
        await api.setBottomChromeHeight?.(bottom);
        await api.setRightChromeWidth?.(side);
    } catch (_) { /* ignore */ }
    if (addressBarContainer?.classList.contains('omnibox-open')) {
        syncOmniboxOverlay();
    }
}

function applyToolbarToolsMiniAlign(align) {
    const next = align === 'left' ? 'left' : 'right';
    _toolbarToolsMiniAlign = next;
    document.body.dataset.toolsMiniAlign = next;
    for (const el of [toolsSubbarEl, toolsBottomEl]) {
        if (el) el.dataset.miniAlign = next;
    }
}

function applyToolbarToolsPlacement(placement) {
    const next = TOOLBAR_PLACEMENTS.has(placement) ? placement : 'inline';
    _toolbarToolsPlacement = next;
    document.body.dataset.toolsPlacement = next;

    const mount = next === 'subbar' ? toolDockMountSubbar
        : next === 'bottom' ? toolDockMountBottom
        : next === 'separate' ? toolDockMountSeparate
        : toolDockMountInline;

    if (toolDockEl && mount && toolDockEl.parentElement !== mount) {
        mount.appendChild(toolDockEl);
    }

    const isMini = next !== 'inline';
    toolDockEl?.classList.toggle('tool-dock--mini', isMini);
    toolDockEl?.classList.toggle('tool-dock--side', next === 'separate');

    const subbarOn = next === 'subbar';
    const bottomOn = next === 'bottom';
    const separateOn = next === 'separate';
    if (toolsSubbarEl) {
        toolsSubbarEl.hidden = !subbarOn;
        toolsSubbarEl.setAttribute('aria-hidden', subbarOn ? 'false' : 'true');
    }
    if (toolsBottomEl) {
        toolsBottomEl.hidden = !bottomOn;
        toolsBottomEl.setAttribute('aria-hidden', bottomOn ? 'false' : 'true');
    }
    if (toolsSeparateEl) {
        toolsSeparateEl.hidden = !separateOn;
        toolsSeparateEl.setAttribute('aria-hidden', separateOn ? 'false' : 'true');
    }

    void applyChromeLayoutReserve();
    applyToolbarToolsMiniAlign(_toolbarToolsMiniAlign);
}

async function initToolbarToolsPlacement() {
    try {
        const data = await api.getSettingsAll?.();
        applyToolbarToolsPlacement(data?.toolbarToolsPlacement || 'subbar');
        applyToolbarToolsMiniAlign(data?.toolbarToolsMiniAlign || 'right');
    } catch {
        applyToolbarToolsPlacement('subbar');
        applyToolbarToolsMiniAlign('right');
    }
}

api.onBrowserSettingsUpdated?.((data) => {
    if (data?.toolbarToolsPlacement != null) {
        applyToolbarToolsPlacement(data.toolbarToolsPlacement);
    }
    if (data?.toolbarToolsMiniAlign != null) {
        applyToolbarToolsMiniAlign(data.toolbarToolsMiniAlign);
    }
});

void initToolbarToolsPlacement();

function hideCredSaveBar() {
    if (credSaveBar) credSaveBar.classList.add('hidden');
    if (credSavePw) credSavePw.value = '';
    void applyChromeLayoutReserve();
}

if (api.onShowCredentialSaveBar) {
    api.onShowCredentialSaveBar((data) => {
        if (!credSaveBar) return;
        credSaveBar.classList.remove('hidden');
        if (credSaveDomain) credSaveDomain.textContent = data.domain || '';
        if (credSaveLogin) credSaveLogin.textContent = data.login ? `(${data.login})` : '';
        if (data.needsUnlock) {
            if (credSaveUnlockRow) { credSaveUnlockRow.classList.remove('hidden'); credSaveUnlockRow.style.display = 'flex'; }
            if (credSaveYes) credSaveYes.textContent = 'Unlock & Save';
            setTimeout(() => credSavePw?.focus(), 60);
        } else {
            if (credSaveUnlockRow) { credSaveUnlockRow.classList.add('hidden'); credSaveUnlockRow.style.display = 'none'; }
            if (credSaveYes) credSaveYes.textContent = 'Save';
        }
        void applyChromeLayoutReserve();
    });
}

if (credSaveYes) {
    credSaveYes.addEventListener('click', async () => {
        const needsUnlock = credSaveUnlockRow && !credSaveUnlockRow.classList.contains('hidden');
        if (needsUnlock) {
            const pw = credSavePw?.value || '';
            if (!pw) { credSavePw?.focus(); return; }
            const res = await api.credentialCaptureUnlockAndSave(pw);
            if (res.success) {
                hideCredSaveBar();
                if (typeof showToast === 'function') showToast('Password saved to vault', { type: 'success' });
            } else {
                if (typeof showToast === 'function') showToast(res.error || 'Failed', { type: 'error' });
            }
        } else {
            const res = await api.credentialCaptureConfirm();
            if (res.success) {
                hideCredSaveBar();
                if (typeof showToast === 'function') showToast('Password saved to vault', { type: 'success' });
            } else {
                if (typeof showToast === 'function') showToast(res.error || 'Failed', { type: 'error' });
            }
        }
    });
}

if (credSaveNever) {
    credSaveNever.addEventListener('click', async () => {
        await api.credentialCaptureDismiss();
        hideCredSaveBar();
    });
}

if (credSaveDismiss) {
    credSaveDismiss.addEventListener('click', async () => {
        await api.credentialCaptureDismiss();
        hideCredSaveBar();
    });
}

if (credSavePw) {
    credSavePw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') credSaveYes?.click();
        if (e.key === 'Escape') { hideCredSaveBar(); api.credentialCaptureDismiss(); }
    });
}

// ─── Favicon support ──────────────────────────────────────────────────────────
function getFaviconHtml(tab) {
    if (tab.faviconUrl) {
        return `<img class="tab-favicon-img" src="${tab.faviconUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display=''">` +
               `<span class="tab-favicon" style="display:none">🌐</span>`;
    }
    return `<span class="tab-favicon">🌐</span>`;
}

// ─── Proxy pill + environment colors ──────────────────────────────────────────
const pbDetail = document.getElementById('pb-detail');

let _lastProxyInfo     = null;
let _proxyIpGeo        = null;
let _directIpGeo       = null;
let _isIsolatedTab     = false;
let _isNewTabPage      = false;
let _lastPillTabSig    = '';

const ENV_CLASSES = ['env-direct', 'env-proxy', 'env-isolated', 'env-newtab'];

function _setEnvClass(el, cls) {
    if (!el) return;
    ENV_CLASSES.forEach(c => el.classList.remove(c));
    if (cls) el.classList.add(cls);
}

function _currentEnvClass() {
    if (_isIsolatedTab) return 'env-isolated';
    if (_isNewTabPage) return 'env-newtab';
    if (_lastProxyInfo?.active) return 'env-proxy';
    return 'env-direct';
}

function _renderPill() {
    const envCls = _currentEnvClass();
    _setEnvClass(pbStatusBtn, envCls);
    _setEnvClass(urlInput, envCls);

    // Reset dot classes
    pbDot.classList.remove('active', 'direct', 'isolated');

    const info = _lastProxyInfo;
    if (!info) {
        refreshBrowserStatusBar();
        return;
    }
    const active = !!info.active;
    const label  = (info.displayProxyName || info.proxyName || 'Proxy');

    if (_isIsolatedTab) {
        pbDot.classList.add('isolated');
    } else if (active) {
        pbDot.classList.add('active');
    }

    pbName.textContent = active ? label : 'Direct';

    if (active && _proxyIpGeo && _proxyIpGeo.ip) {
        const loc = [_proxyIpGeo.city, _proxyIpGeo.country].filter(Boolean).join(', ');
        pbDetail.textContent = _proxyIpGeo.ip + (loc ? ' · ' + loc : '');
    } else if (!active && _directIpGeo && _directIpGeo.ip) {
        const loc = [_directIpGeo.city, _directIpGeo.country].filter(Boolean).join(', ');
        pbDetail.textContent = _directIpGeo.ip + (loc ? ' · ' + loc : '');
    } else if (!active && _directIpGeo && _directIpGeo._tried) {
        pbDetail.textContent = '—';
    } else if (!active) {
        pbDetail.textContent = 'checking…';
        _fetchDirectIpGeo();
    } else {
        pbDetail.textContent = '';
    }

    pbStatusBtn.title = active
        ? `${label} — click to manage`
        : 'No proxy — click to set up';

    _renderModeBadge(info);
    refreshBrowserStatusBar();
}

function _renderModeBadge(_info) {
    if (!pbModeBadge) return;
    pbModeBadge.textContent = '';
    pbModeBadge.style.display = 'none';
}

function updateProxyStatus(info) {
    if (!info) return;
    _lastProxyInfo = info;
    _renderPill();
}

function refreshBrowserStatusBar() {
    if (!statusMitm && !statusProxy) return;

    if (typeof api.getMitmStats === 'function') {
        api.getMitmStats().then((st) => {
            const ready = st && st.workerReady !== false;
            if (statusMitm) statusMitm.textContent = `MITM: ${ready ? 'Active' : 'Starting'}`;
            if (statusErrors) statusErrors.textContent = `Errors: ${st && st.errors != null ? st.errors : '—'}`;
        }).catch(() => {
            if (statusMitm) statusMitm.textContent = 'MITM: —';
        });
    }

    const info = _lastProxyInfo;
    if (statusProxy) {
        if (!info) {
            statusProxy.textContent = 'Proxy: —';
        } else {
            const active = !!info.active;
            const label = active ? (info.displayProxyName || info.proxyName || 'Proxy') : 'Direct';
            statusProxy.textContent = `Proxy: ${label}`;
        }
    }

    if (statusIp) {
        let txt = '—';
        if (info?.active && _proxyIpGeo && _proxyIpGeo.ip) {
            const loc = [_proxyIpGeo.city, _proxyIpGeo.country].filter(Boolean).join(', ');
            txt = _proxyIpGeo.ip + (loc ? ' · ' + loc : '');
        } else if (info && !info.active && _directIpGeo && _directIpGeo.ip) {
            const loc = [_directIpGeo.city, _directIpGeo.country].filter(Boolean).join(', ');
            txt = _directIpGeo.ip + (loc ? ' · ' + loc : '');
        } else if (info && !info.active && _directIpGeo && _directIpGeo._tried) {
            txt = '—';
        } else if (info && !info.active) {
            txt = 'checking…';
        }
        statusIp.textContent = `IP: ${txt}`;
    }

    if (statusRequests) {
        statusRequests.textContent = `Requests: ${isLogging ? _statusLogCount : 0}`;
    }
}

function _activeTabIdForIpGeo() {
    const a = tabs.find(t => t.isActive);
    return a?.id;
}

function _fetchProxyIpGeo() {
    const tid = _activeTabIdForIpGeo();
    api.checkIpGeo(tid).then(geo => {
        if (geo && geo.ip && geo.ip !== 'unknown') {
            _proxyIpGeo = geo;
            _renderPill();
        }
    }).catch(() => {});
}

function _fetchDirectIpGeo() {
    if (_directIpGeo && (_directIpGeo.ip || _directIpGeo._tried)) return;
    const tid = _activeTabIdForIpGeo();
    api.checkIpGeo(tid).then(geo => {
        if (geo && geo.ip && geo.ip !== 'unknown') {
            _directIpGeo = geo;
        } else {
            _directIpGeo = { _tried: true };
        }
        _renderPill();
    }).catch(() => {
        _directIpGeo = { _tried: true };
        _renderPill();
    });
}

function _onActiveTabChanged(tabData) {
    const list = tabData || tabs;
    const active = list.find(t => t.isActive);
    _isIsolatedTab     = !!(active?.isolated);

    const url = active?.url || '';
    _isNewTabPage = !url || url === 'about:blank' || url.includes('new-tab.html');

    _renderPill();

    const pillSig = `${active?.id || ''}|${active?.proxyProfileId ?? ''}`;
    if (pillSig !== _lastPillTabSig) {
        _lastPillTabSig = pillSig;
        _proxyIpGeo = null;
        _directIpGeo = null;
        api.getCurrentProxy().then((info) => {
            updateProxyStatus(info);
            if (info?.active) _fetchProxyIpGeo();
        }).catch(() => {});
    }
    if (!_lastProxyInfo?.active) _fetchDirectIpGeo();
    hideCredPopup();
    scheduleCookiePageBadgeRefresh();
    scheduleCredentialsToolbarRefresh();
}

// Click opens Proxy Manager
if (pbStatusBtn) {
    pbStatusBtn.addEventListener('click', () => api.openProxyManager());
}

// Live updates
api.onProxyStatusChanged((info) => {
    _proxyIpGeo = null;
    _directIpGeo = null;
    updateProxyStatus(info);
    if (info?.active) _fetchProxyIpGeo();
});
api.getCurrentProxy().then((info) => {
    updateProxyStatus(info);
    if (info?.active) _fetchProxyIpGeo();
}).catch(() => {});

setInterval(() => {
    refreshBrowserStatusBar();
}, 8000);

// ─── Settings ────────────────────────────────────────────────────────────────
settingsToggle?.addEventListener('click', () => {
    api.openSettingsTab?.();
});

// ─── Rule notification toasts ─────────────────────────────────────────────────
function showRuleToast(data) {
    if (!toastContainer) return;
    const el = document.createElement('div');
    el.className = 'rule-toast';
    // Use textContent to avoid any XSS via ruleName/url
    const icon = document.createElement('span');
    icon.className = 'rule-toast-icon';
    icon.textContent = '🔔';
    const body = document.createElement('div');
    body.className = 'rule-toast-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'rule-toast-name';
    nameEl.textContent = `Rule: ${data.ruleName || ''}`;
    const urlEl = document.createElement('div');
    urlEl.className = 'rule-toast-url';
    urlEl.title = data.url || '';
    urlEl.textContent = data.url || '';
    body.appendChild(nameEl);
    body.appendChild(urlEl);
    el.appendChild(icon);
    el.appendChild(body);
    toastContainer.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 320);
    }, 4000);
}

api.onRuleNotification && api.onRuleNotification(showRuleToast);

// ─── Intercept hit badge on Rules button ──────────────────────────────────────
const rulesHitBadge = document.getElementById('rules-hit-badge');
const dnsHitBadge = document.getElementById('dns-hit-badge');
let _interceptHitCount = 0;
let _dnsHitCount = 0;

const _BADGE_VISIBLE = 'inline-flex';

function updateRulesHitBadge() {
    if (!rulesHitBadge) return;
    if (_interceptHitCount > 0) {
        rulesHitBadge.textContent = _interceptHitCount > 99 ? '99+' : String(_interceptHitCount);
        rulesHitBadge.style.display = _BADGE_VISIBLE;
    } else {
        rulesHitBadge.style.display = 'none';
    }
}

function updateDnsHitBadge() {
    if (!dnsHitBadge) return;
    if (_dnsHitCount > 0) {
        dnsHitBadge.textContent = _dnsHitCount > 99 ? '99+' : String(_dnsHitCount);
        dnsHitBadge.style.display = _BADGE_VISIBLE;
    } else {
        dnsHitBadge.style.display = 'none';
    }
}

function _onInterceptRuleMatched(info) {
    _interceptHitCount++;
    updateRulesHitBadge();
}
api.onInterceptRuleMatched?.(_onInterceptRuleMatched);
api.onInterceptRuleMatchedBatch?.((items) => {
    if (!Array.isArray(items) || !items.length) return;
    _interceptHitCount += items.length;
    updateRulesHitBadge();
});

function _onDnsRuleMatched() {
    _dnsHitCount++;
    updateDnsHitBadge();
}
api.onDnsRuleMatched?.(_onDnsRuleMatched);
api.onDnsRuleMatchedBatch?.((items) => {
    if (!Array.isArray(items) || !items.length) return;
    _dnsHitCount += items.length;
    updateDnsHitBadge();
});
api.onToolbarActivityBadgeReset?.((tool) => {
    const t = String(tool || '');
    if (t === 'dns') {
        _dnsHitCount = 0;
        updateDnsHitBadge();
    } else if (t === 'rules') {
        _interceptHitCount = 0;
        updateRulesHitBadge();
    }
});


// ─── Hotkey-driven IPC from main process ──────────────────────────────────────
/** Set from omnibox block: open suggestions when main focuses the address bar (Ctrl+L). */
let _focusUrlBarOmniboxExtra = null;
api.onFocusUrlBar?.(() => {
    urlInput.focus();
    urlInput.select();
    if (typeof _focusUrlBarOmniboxExtra === 'function') _focusUrlBarOmniboxExtra();
});

api.onSwitchTabRel?.((delta) => {
    if (!tabs.length) return;
    const activeIdx = tabs.findIndex(t => t.isActive);
    if (activeIdx < 0) return;
    const next = (activeIdx + delta + tabs.length) % tabs.length;
    api.switchTab(tabs[next].id);
});

api.onTakeScreenshotNow?.(() => {
    api.takeScreenshot('click');
    ssFlash();
    ssResetTimer(ssIntervalSec);
});

// Ctrl+1..9 — switch to tab by index
document.addEventListener('keydown', (e) => {
    if (document.getElementById('win-switcher-overlay')?.classList.contains('win-switcher-overlay--open')) return;
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9 && tabs.length > 0) {
        const idx = n === 9 ? tabs.length - 1 : Math.min(n - 1, tabs.length - 1);
        api.switchTab(tabs[idx].id);
        e.preventDefault();
    }
});

// Report user activity to main process (throttled; used by tracking triggers)
let _lastMouseReportTs = 0;
document.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - _lastMouseReportTs < 5000) return;
    _lastMouseReportTs = now;
    api.reportMouseActivity?.();
});

// ─── Init: fetch current tabs ─────────────────────────────────────────────────
api.getTabs().then(td => { renderTabs(td); _onActiveTabChanged(td); scheduleCookiePageBadgeRefresh(); scheduleCredentialsToolbarRefresh(); }).catch(() => {});

// ─── Window switcher overlay (Ctrl+` from main) ─────────────────────────────
const winSwitcherOverlay = document.getElementById('win-switcher-overlay');
const winSwitcherList = document.getElementById('win-switcher-list');
let _winSwitcherCache = [];
/** First window index shown on the current grid page (0, 11, 22, … when >12 windows). */
let _winSwitcherPageOffset = 0;
let _lastWinSwitcherOpenedAt = 0;
/** Refresh window list while switcher is open (tab titles, DevTools #N, previews). */
let _winSwitcherRefreshTimer = null;
const WIN_SWITCHER_REFRESH_MS = 10000;
/** Bumps when switcher closes — ignore stale async preview loads. */
let _winSwitcherPreviewLoadGen = 0;
/** Ignore toggle-close right after open (duplicate IPC after tab → shell focus). */
const WIN_SWITCHER_TOGGLE_CLOSE_GRACE_MS = 220;

/** Physical keyboard left block: row1 1–3, then QWE, ASD, ZXC (`KeyboardEvent.code`). */
const WIN_SWITCHER_KEY_CODES = [
    'Digit1', 'Digit2', 'Digit3',
    'KeyQ', 'KeyW', 'KeyE',
    'KeyA', 'KeyS', 'KeyD',
    'KeyZ', 'KeyX', 'KeyC',
];
const WIN_SWITCHER_KEY_LABELS = ['1', '2', '3', 'Q', 'W', 'E', 'A', 'S', 'D', 'Z', 'X', 'C'];
const WIN_SWITCHER_CODE_TO_SLOT = new Map(WIN_SWITCHER_KEY_CODES.map((c, i) => [c, i]));

const WIN_SWITCHER_HINT_LINE1 =
    '4×3 grid: 1–3 / QWE / ASD / ZXC — pick a window; More… on the last key when needed';
const WIN_SWITCHER_HINT_LINE2 =
    'Arrow keys move · Enter to focus · Esc: back from More, or close · Ctrl+` — open from any CupNet window';

/** Keyboard highlight (0–11) in the 4×3 grid; reset when switching pages or closing. */
let _winSwitcherKeyboardSlot = 0;

function _winSwitcherMoveGrid(slot, dir) {
    const row = Math.floor(slot / 3);
    const col = slot % 3;
    if (dir === 'up') {
        if (row >= 1) return slot - 3;
        return slot;
    }
    if (dir === 'down') {
        if (row <= 2) return slot + 3;
        return slot;
    }
    if (dir === 'left') {
        if (col >= 1) return slot - 1;
        return slot;
    }
    if (dir === 'right') {
        if (col <= 1) return slot + 1;
        return slot;
    }
    return slot;
}

const CUPNET_LOGO_FALLBACK_SVG =
    '<svg viewBox="0 0 32 32" class="win-switcher-cupnet-fallback" aria-hidden="true"><defs><linearGradient id="wscg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#wscg)"/><path fill="#fff" d="M9 10.5c0-1.1.9-2 2-2h6.5c2.5 0 4.5 2 4.5 4.5S20 17.5 17.5 17.5H13v3h7v2.5H12c-1.1 0-2-.9-2-2v-5c0-1.1.9-2 2-2h4.5c1.4 0 2.5-1.1 2.5-2.5S18.4 9 17 9H11v1.5z"/></svg>';

/** Short English labels for window type (first line under each tile). */
const WIN_SWITCHER_KIND_LABELS = {
    'cupnet-main': 'CupNet',
    devtools: 'DevTools',
    'log-viewer': 'Log viewer',
    'cookie-manager': 'Cookie manager',
    'dns-manager': 'DNS manager',
    'proxy-manager': 'Proxy manager',
    rules: 'Rules',
    console: 'Console',
    'page-analyzer': 'Page analyzer',
    notes: 'Notes',
    'request-editor': 'Request editor',
    'compare-viewer': 'Compare viewer',
    'ivac-scout': 'IVAC scout',
    'logging-modal': 'Logging',
    unknown: 'Window',
};

/** Window title from main process (always show when present). */
function getSwitcherWindowTitle(w) {
    const t = (w.title && String(w.title).trim()) ? String(w.title).trim() : '';
    if (t) return t;
    if (w.type === 'cupnet-main') return 'CupNet';
    if (w.type === 'devtools' && w.devtoolsTabNum != null) return `DevTools #${w.devtoolsTabNum}`;
    return WIN_SWITCHER_KIND_LABELS[w.type] || w.type || 'Window';
}

/** Top title bar (like a window): text left, shortcut keycap right. */
function appendSwitcherTitleBar(row, w, keyLabel) {
    const kind = WIN_SWITCHER_KIND_LABELS[w.type] || w.type;
    const bar = document.createElement('div');
    bar.className = 'win-switcher-titlebar';

    const textCol = document.createElement('div');
    textCol.className = 'win-switcher-titlebar-text';

    const primary = document.createElement('span');
    primary.className = 'win-switcher-title-primary';
    primary.textContent = getSwitcherWindowTitle(w);
    primary.title = primary.textContent;
    textCol.appendChild(primary);

    if (w.type === 'devtools') {
        const n = w.devtoolsTabNum != null ? String(w.devtoolsTabNum) : '?';
        const tt = (w.tabTitle && String(w.tabTitle).trim()) ? String(w.tabTitle).trim() : '';
        const sub = document.createElement('span');
        sub.className = 'win-switcher-subtitle';
        sub.textContent = tt ? `Inspected · tab ${n} · ${tt}` : `Inspected · tab ${n}`;
        if (!tt) sub.classList.add('win-switcher-subtitle--dim');
        textCol.appendChild(sub);
    } else {
        const titleText = getSwitcherWindowTitle(w);
        if (kind && titleText.toLowerCase() !== kind.toLowerCase()) {
            const kindEl = document.createElement('span');
            kindEl.className = 'win-switcher-kind';
            kindEl.textContent = kind;
            textCol.appendChild(kindEl);
        }
    }

    const cap = document.createElement('span');
    cap.className = 'win-switcher-keycap';
    cap.textContent = keyLabel;

    bar.appendChild(textCol);
    bar.appendChild(cap);
    row.appendChild(bar);
}

const WIN_SWITCHER_ICONS = {
    'cupnet-main': '',
    devtools: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5L2 8l3.5 3.5"/><path d="M10.5 4.5L14 8l-3.5 3.5"/><path d="M9.5 2.5l-3 11"/></svg>',
    'log-viewer': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h12"/><path d="M2 8h7"/><path d="M2 12h10"/></svg>',
    'cookie-manager': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><circle cx="6" cy="6.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="10" cy="7" r="0.9" fill="currentColor" stroke="none"/><circle cx="7" cy="10.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="10.5" cy="10.5" r="0.7" fill="currentColor" stroke="none"/></svg>',
    'dns-manager': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5a8.2 8.2 0 0 1 0 11"/><path d="M8 2.5a8.2 8.2 0 0 0 0 11"/></svg>',
    'proxy-manager': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5" cy="8" r="2.5"/><circle cx="11" cy="8" r="2.5"/><path d="M7.3 8h1.4"/></svg>',
    rules: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5h12l-4.5 5v4l-3-1.5V8.5L2 3.5z"/></svg>',
    console: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2"/><path d="M8.5 10.5h3"/></svg>',
    'page-analyzer': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3 3"/><path d="M5 7h4"/><path d="M7 5v4"/></svg>',
    notes: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h8a1 1 0 0 1 1 1v10l-2.5-2H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M5 6h6M5 9h4"/></svg>',
    'request-editor': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M2 8h7"/><path d="M2 12h5"/><path d="M11 10l3 2-3 2"/></svg>',
    'compare-viewer': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="5" height="10" rx="1"/><rect x="9" y="3" width="5" height="10" rx="1"/></svg>',
    'ivac-scout': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5" cy="8" r="2.5"/><circle cx="11" cy="8" r="2.5"/><path d="M7.5 8h1"/></svg>',
    'logging-modal': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5v4"/><path d="M8 11v.5"/></svg>',
    unknown: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 5.5h12"/></svg>',
};

function _winSwitcherIconSvg(type) {
    return WIN_SWITCHER_ICONS[type] || WIN_SWITCHER_ICONS.unknown;
}

function _winSwitcherFillIcon(iconWrap, w) {
    iconWrap.innerHTML = '';
    iconWrap.className = 'win-switcher-icon';
    iconWrap.innerHTML = _winSwitcherIconSvg(w.type);
}

function getValidWinSwitcherOffsets(total) {
    if (total <= 12) return [0];
    const out = [];
    let off = 0;
    while (off < total) {
        out.push(off);
        const rem = total - off;
        if (rem <= 12) break;
        off += 11;
    }
    return out;
}

function clampWinSwitcherPageOffset() {
    const total = _winSwitcherCache.length;
    if (total <= 12) {
        _winSwitcherPageOffset = 0;
        return;
    }
    const valid = getValidWinSwitcherOffsets(total);
    if (!valid.includes(_winSwitcherPageOffset)) {
        _winSwitcherPageOffset = valid[valid.length - 1];
    }
}

/**
 * @returns {{ type: 'window', index: number } | { type: 'more', remaining: number } | { type: 'empty' }}
 */
function getSwitcherSlotKind(slotIndex, total, pageOffset) {
    const remaining = total - pageOffset;
    if (remaining <= 0) return { type: 'empty' };

    if (total <= 12 && pageOffset === 0) {
        if (slotIndex < total) return { type: 'window', index: slotIndex };
        return { type: 'empty' };
    }

    if (remaining <= 12) {
        if (slotIndex < remaining) return { type: 'window', index: pageOffset + slotIndex };
        return { type: 'empty' };
    }

    if (slotIndex < 11) return { type: 'window', index: pageOffset + slotIndex };
    if (slotIndex === 11) return { type: 'more', remaining: remaining - 11 };
    return { type: 'empty' };
}

function _winSwitcherAppendPreview(previewWrap, w) {
    if (w.previewDataUrl) {
        const pv = document.createElement('img');
        pv.className = 'win-switcher-preview-img';
        pv.src = w.previewDataUrl;
        pv.alt = '';
        pv.decoding = 'async';
        previewWrap.appendChild(pv);
    } else if (w.type === 'cupnet-main') {
        const fb = document.createElement('div');
        fb.className = 'win-switcher-preview-fallback win-switcher-preview-fallback--main';
        const img = document.createElement('img');
        img.className = 'win-switcher-cupnet-tile-logo';
        img.src = 'img.png';
        img.alt = '';
        img.onerror = () => {
            fb.innerHTML = CUPNET_LOGO_FALLBACK_SVG;
        };
        fb.appendChild(img);
        previewWrap.appendChild(fb);
    } else {
        const fb = document.createElement('div');
        fb.className = 'win-switcher-preview-fallback';
        const iconWrap = document.createElement('span');
        _winSwitcherFillIcon(iconWrap, w);
        fb.appendChild(iconWrap);
        previewWrap.appendChild(fb);
    }
}

/**
 * @param {{ type: 'window', index: number } | { type: 'more', remaining: number } | { type: 'empty' }} slot
 */
function buildSwitcherTile(slot, keyLabel) {
    const row = document.createElement('button');
    row.type = 'button';

    if (slot.type === 'empty') {
        row.className = 'win-switcher-tile win-switcher-tile--empty';
        row.disabled = true;
        row.setAttribute('tabindex', '-1');
        row.setAttribute('aria-hidden', 'true');
        const bar = document.createElement('div');
        bar.className = 'win-switcher-titlebar win-switcher-titlebar--empty-slot';
        const cap = document.createElement('span');
        cap.className = 'win-switcher-keycap';
        cap.textContent = keyLabel;
        bar.appendChild(cap);
        const previewWrap = document.createElement('div');
        previewWrap.className = 'win-switcher-preview-wrap win-switcher-preview-wrap--empty';
        row.appendChild(bar);
        row.appendChild(previewWrap);
        return row;
    }

    if (slot.type === 'more') {
        row.className = 'win-switcher-tile win-switcher-tile--more';
        row.setAttribute('aria-label', `More windows, ${slot.remaining} remaining`);
        const bar = document.createElement('div');
        bar.className = 'win-switcher-titlebar';
        const textCol = document.createElement('div');
        textCol.className = 'win-switcher-titlebar-text';
        const t1 = document.createElement('span');
        t1.className = 'win-switcher-title-primary';
        t1.textContent = 'More…';
        const t2 = document.createElement('span');
        t2.className = 'win-switcher-subtitle';
        t2.textContent = `${slot.remaining} more`;
        textCol.appendChild(t1);
        textCol.appendChild(t2);
        const cap = document.createElement('span');
        cap.className = 'win-switcher-keycap';
        cap.textContent = keyLabel;
        bar.appendChild(textCol);
        bar.appendChild(cap);
        const previewWrap = document.createElement('div');
        previewWrap.className = 'win-switcher-preview-wrap win-switcher-preview-wrap--more';
        const moreInner = document.createElement('span');
        moreInner.className = 'win-switcher-more-label';
        moreInner.textContent = 'More…';
        previewWrap.appendChild(moreInner);
        row.appendChild(bar);
        row.appendChild(previewWrap);
        row.addEventListener('click', () => {
            _winSwitcherPageOffset += 11;
            _winSwitcherKeyboardSlot = 0;
            renderWindowSwitcher();
        });
        return row;
    }

    const w = _winSwitcherCache[slot.index];
    const hasLivePreview = !!(w.previewDataUrl || w.type === 'cupnet-main');
    row.className = 'win-switcher-tile' + (w.type === 'cupnet-main' ? ' win-switcher-tile--main' : '');
    if (!hasLivePreview) row.classList.add('win-switcher-tile--no-preview');
    appendSwitcherTitleBar(row, w, keyLabel);
    const previewWrap = document.createElement('div');
    previewWrap.className = 'win-switcher-preview-wrap';
    _winSwitcherAppendPreview(previewWrap, w);
    row.appendChild(previewWrap);
    row.addEventListener('click', () => {
        api.focusWindowById(w.id).catch(() => {});
        hideWindowSwitcher();
    });
    return row;
}

function renderWindowSwitcher() {
    if (!winSwitcherList) return;
    winSwitcherList.innerHTML = '';
    winSwitcherList.classList.add('win-switcher-keyboard');

    const hintEl = document.getElementById('win-switcher-hint');
    if (hintEl) {
        hintEl.innerHTML = '';
        const line1 = document.createElement('span');
        line1.className = 'win-switcher-hint-line1';
        line1.textContent = WIN_SWITCHER_HINT_LINE1;
        const line2 = document.createElement('span');
        line2.className = 'win-switcher-hint-line2';
        line2.textContent = WIN_SWITCHER_HINT_LINE2;
        hintEl.appendChild(line1);
        hintEl.appendChild(line2);
    }

    clampWinSwitcherPageOffset();
    const total = _winSwitcherCache.length;
    if (total === 0) {
        const empty = document.createElement('div');
        empty.className = 'win-switcher-list-empty';
        empty.textContent = 'No windows';
        winSwitcherList.appendChild(empty);
        winSwitcherList.classList.remove('win-switcher-keyboard');
        return;
    }

    for (let slot = 0; slot < 12; slot++) {
        const kind = getSwitcherSlotKind(slot, total, _winSwitcherPageOffset);
        const label = WIN_SWITCHER_KEY_LABELS[slot];
        const tile = buildSwitcherTile(kind, label);
        if (slot === _winSwitcherKeyboardSlot) tile.classList.add('win-switcher-tile--kbd-focus');
        winSwitcherList.appendChild(tile);
    }
    try {
        const el = winSwitcherList.querySelector('.win-switcher-tile--kbd-focus');
        el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch (e) { /* ignore */ }
}

function hideWindowSwitcher() {
    if (!winSwitcherOverlay) return;
    _winSwitcherPreviewLoadGen++;
    if (_winSwitcherRefreshTimer != null) {
        clearInterval(_winSwitcherRefreshTimer);
        _winSwitcherRefreshTimer = null;
    }
    _winSwitcherPageOffset = 0;
    _winSwitcherKeyboardSlot = 0;
    try { api.setWindowSwitcherOverlayVisible?.(false); } catch (_) { /* ignore */ }
    winSwitcherOverlay.classList.remove('win-switcher-overlay--open');
    winSwitcherOverlay.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onWindowSwitcherKeydown, true);
}

function onWindowSwitcherKeydown(e) {
    if (!winSwitcherOverlay || !winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        if (_winSwitcherPageOffset > 0) {
            _winSwitcherPageOffset = 0;
            renderWindowSwitcher();
            return;
        }
        const main = _winSwitcherCache.find((x) => x.type === 'cupnet-main');
        if (main) api.focusWindowById(main.id).catch(() => {});
        hideWindowSwitcher();
        return;
    }
    const total = _winSwitcherCache.length;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _winSwitcherKeyboardSlot = _winSwitcherMoveGrid(_winSwitcherKeyboardSlot, 'down');
        renderWindowSwitcher();
        return;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        _winSwitcherKeyboardSlot = _winSwitcherMoveGrid(_winSwitcherKeyboardSlot, 'up');
        renderWindowSwitcher();
        return;
    }
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        _winSwitcherKeyboardSlot = _winSwitcherMoveGrid(_winSwitcherKeyboardSlot, 'left');
        renderWindowSwitcher();
        return;
    }
    if (e.key === 'ArrowRight') {
        e.preventDefault();
        _winSwitcherKeyboardSlot = _winSwitcherMoveGrid(_winSwitcherKeyboardSlot, 'right');
        renderWindowSwitcher();
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        if (total === 0) return;
        const kind = getSwitcherSlotKind(_winSwitcherKeyboardSlot, total, _winSwitcherPageOffset);
        if (kind.type === 'empty') return;
        if (kind.type === 'more') {
            _winSwitcherPageOffset += 11;
            _winSwitcherKeyboardSlot = 0;
            renderWindowSwitcher();
            return;
        }
        api.focusWindowById(_winSwitcherCache[kind.index].id).catch(() => {});
        hideWindowSwitcher();
        return;
    }
    const slot = WIN_SWITCHER_CODE_TO_SLOT.get(e.code);
    if (slot === undefined) return;
    if (total === 0) return;
    const kind = getSwitcherSlotKind(slot, total, _winSwitcherPageOffset);
    if (kind.type === 'empty') return;
    if (kind.type === 'more') {
        e.preventDefault();
        _winSwitcherPageOffset += 11;
        _winSwitcherKeyboardSlot = 0;
        renderWindowSwitcher();
        return;
    }
    e.preventDefault();
    api.focusWindowById(_winSwitcherCache[kind.index].id).catch(() => {});
    hideWindowSwitcher();
}

async function showWindowSwitcher() {
    if (!winSwitcherOverlay || !winSwitcherList) return;
    _winSwitcherPageOffset = 0;
    _winSwitcherKeyboardSlot = 0;
    const loadGen = ++_winSwitcherPreviewLoadGen;
    let res = { windows: [] };
    try { res = await api.getOpenWindows({ includePreviews: false }); } catch (_) { /* ignore */ }
    _winSwitcherCache = Array.isArray(res.windows) ? res.windows : [];

    try { await api.setWindowSwitcherOverlayVisible?.(true); } catch (_) { /* ignore */ }

    renderWindowSwitcher();
    winSwitcherOverlay.classList.add('win-switcher-overlay--open');
    _lastWinSwitcherOpenedAt = Date.now();
    winSwitcherOverlay.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', onWindowSwitcherKeydown, true);
    if (_winSwitcherRefreshTimer != null) {
        clearInterval(_winSwitcherRefreshTimer);
        _winSwitcherRefreshTimer = null;
    }
    _winSwitcherRefreshTimer = setInterval(async () => {
        if (!winSwitcherOverlay || !winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) return;
        try {
            const r = await api.getOpenWindows({ includePreviews: true });
            if (Array.isArray(r.windows)) {
                _winSwitcherCache = r.windows;
                renderWindowSwitcher();
            }
        } catch (_) { /* ignore */ }
    }, WIN_SWITCHER_REFRESH_MS);

    (async () => {
        try {
            const full = await api.getOpenWindows({ includePreviews: true });
            if (loadGen !== _winSwitcherPreviewLoadGen) return;
            if (!winSwitcherOverlay || !winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) return;
            if (Array.isArray(full.windows)) {
                _winSwitcherCache = full.windows;
                renderWindowSwitcher();
            }
        } catch (_) { /* ignore */ }
    })();
}

if (winSwitcherOverlay) {
    winSwitcherOverlay.addEventListener('click', (e) => {
        if (e.target === winSwitcherOverlay) hideWindowSwitcher();
    });
}

api.onToggleWindowSwitcher?.(() => {
    if (!winSwitcherOverlay) return;
    if (winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) {
        if (Date.now() - _lastWinSwitcherOpenedAt < WIN_SWITCHER_TOGGLE_CLOSE_GRACE_MS) return;
        hideWindowSwitcher();
    } else {
        showWindowSwitcher();
    }
});

document.getElementById('win-switcher-toolbar-btn')?.addEventListener('click', () => {
    if (!winSwitcherOverlay) return;
    if (winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) {
        hideWindowSwitcher();
    } else {
        showWindowSwitcher();
    }
});

// ─── Omnibox: `>` = commands; otherwise URL + history / tabs / search ──
const commandPaletteEl = document.getElementById('command-palette');
const commandPaletteBackdrop = document.getElementById('command-palette-backdrop');
let commandPaletteActiveIdx = 0;
/** @type {Array<any>} */
let omniboxRows = [];
/** True after ArrowUp/Down changed the highlighted suggestion (Enter then picks it). */
let _omniboxHighlightMoved = false;

const OMNIBOX_QUICK_LINKS = [
    { label: 'CupNet start page', keywords: 'home new tab dashboard', url: 'cupnet://newtab' },
    { label: 'Settings', keywords: 'preferences options', url: 'cupnet://settings' },
    { label: 'User guide', keywords: 'help documentation manual', url: 'cupnet://guide' },
];

function isCommandMode() {
    return String(urlInput?.value || '').trimStart().startsWith('>');
}

function getCommandFilterQuery() {
    const v = String(urlInput?.value || '');
    const i = v.indexOf('>');
    if (i < 0) return '';
    return v.slice(i + 1).trim();
}

function _cupnetFuzzyMatch(query, text) {
    const q = String(query || '').toLowerCase().trim();
    const t = String(text || '').toLowerCase();
    if (!q) return true;
    if (t.includes(q)) return true;
    let qi = 0;
    for (let i = 0; i < t.length && qi < q.length; i++) {
        if (t[i] === q[qi]) qi++;
    }
    return qi === q.length;
}

function getCommandPaletteCommands() {
    const active = tabs.find((x) => x.isActive);
    const activeTabId = active?.id;
    /** Curated list (not auto-generated from preload). `keywords` improves search. */
    return [
        { label: 'Back', category: 'Navigation', keywords: 'history previous', shortcut: '', run: () => api.navBack?.() },
        { label: 'Forward', category: 'Navigation', keywords: 'history next', shortcut: '', run: () => api.navForward?.() },
        { label: 'Reload page', category: 'Navigation', keywords: 'refresh', shortcut: '', run: () => api.navReload?.() },
        { label: 'Home', category: 'Navigation', keywords: 'start', shortcut: '', run: () => api.navHome?.() },
        { label: 'New tab', category: 'Navigation', keywords: '', shortcut: 'Ctrl+T', run: () => api.newTab() },
        { label: 'New isolated tab', category: 'Navigation', keywords: 'session isolate incognito', shortcut: '', run: () => api.newIsolatedTab?.() },
        { label: 'Close active tab', category: 'Navigation', keywords: '', shortcut: '', run: () => {
            if (activeTabId != null) void api.closeTab?.(activeTabId);
        } },
        { label: 'Focus address bar', category: 'Navigation', keywords: 'url omnibox location', shortcut: 'Ctrl+L', run: () => { urlInput.focus(); urlInput.select(); } },
        { label: 'Open Settings', category: 'Navigation', keywords: 'preferences options', shortcut: 'Ctrl+,', run: () => api.openSettingsTab?.() },
        { label: 'Open CupNet Guide', category: 'Navigation', keywords: 'help documentation manual', shortcut: '', run: () => api.navigateTo?.('cupnet://guide') },
        { label: 'Open start page', category: 'Navigation', keywords: 'new tab dashboard', shortcut: '', run: () => api.navigateTo?.('cupnet://newtab') },

        { label: 'Take screenshot', category: 'Page', keywords: 'capture screen shot', shortcut: '', run: () => { void api.takeScreenshot?.('click').catch(() => {}); } },
        { label: 'Import session bundle', category: 'Tools', keywords: 'har zip restore', shortcut: '', run: () => { void api.importBundle?.().catch(() => {}); } },
        { label: 'Launch profile', category: 'Tools', keywords: 'json cookies proxy bootstrap import file session launch', shortcut: '', run: () => { void api.openSessionProfileModal?.(); } },
        { label: 'Open Network Activity', category: 'Tools', keywords: 'log viewer database requests', shortcut: '', run: () => api.openLogViewer() },
        { label: 'Open Proxy Manager', category: 'Tools', keywords: 'profile tls fingerprint chain', shortcut: '', run: () => api.openProxyManager() },
        { label: 'Disconnect proxy', category: 'Proxy', keywords: 'offline mitm', shortcut: '', run: () => { void api.disconnectProxy?.().catch(() => {}); } },
        { label: 'Connect direct (no upstream proxy)', category: 'Proxy', keywords: 'direct tls local', shortcut: '', run: () => { void api.connectDirect?.().catch(() => {}); } },
        { label: 'Open Rules & Interceptor', category: 'Tools', keywords: 'highlight mock block', shortcut: '', run: () => api.openRulesWindow() },
        { label: 'Open Cookie Manager', category: 'Tools', keywords: 'storage jar', shortcut: '', run: () => api.openCookieManager(activeTabId) },
        { label: 'Open DNS Manager', category: 'Tools', keywords: 'hosts override', shortcut: '', run: () => api.openDnsManager() },
        { label: 'Toggle CORS bypass (MITM)', category: 'Tools', keywords: 'access-control mitm fetch', shortcut: '', run: () => { void api.toggleCorsBypass?.(); } },
        { label: 'Open Request Editor', category: 'Tools', keywords: 'replay http', shortcut: '', run: () => api.openRequestEditor() },
        { label: 'Open Request Editor (new window)', category: 'Tools', keywords: 'replay separate', shortcut: '', run: () => { void api.openRequestEditorNewWindow?.().catch(() => {}); } },
        { label: 'Open System Console', category: 'Tools', keywords: 'stdout stderr debug', shortcut: '', run: () => api.openConsoleViewer() },
        { label: 'Open Page Analyzer', category: 'Tools', keywords: 'forms captcha meta', shortcut: '', run: () => api.openPageAnalyzer() },
        { label: 'Open Notes', category: 'Tools', keywords: 'scratchpad quill', shortcut: '', run: () => api.openNotesWindow() },
        { label: 'Open Credentials vault', category: 'Tools', keywords: 'passwords secrets vault', shortcut: 'Ctrl+Alt+L', run: () => api.openCredentialsWindow() },
        { label: 'Autofill credentials (active tab)', category: 'Tools', keywords: 'fill login password', shortcut: '', run: () => { void api.credentialsFillActiveTab?.({}).catch(() => {}); } },
        { label: 'Open Compare viewer', category: 'Tools', keywords: 'diff two requests', shortcut: '', run: () => api.openCompareViewer() },
        { label: 'Open DevTools (active tab)', category: 'Tools', keywords: 'inspector chromium', shortcut: '', run: () => api.openDevTools() },
        { label: 'Open API Scout', category: 'Tools', keywords: 'ivac har dump', shortcut: '', run: () => api.openIvacScout() },
        { label: 'Toggle session recording', category: 'Logging', keywords: 'logging pause resume', shortcut: '', run: () => logToggleBtn?.click() },
        { label: 'Show my public IP', category: 'Proxy', keywords: 'wan address geoip', shortcut: '', run: async () => {
            try {
                const ip = await api.getDirectIp?.();
                if (typeof showToast === 'function' && ip) showToast(String(ip), { type: 'info' });
            } catch (_) { /* ignore */ }
        } },
        { label: 'Check IP / Geo (active tab)', category: 'Proxy', keywords: 'egress proxy ip', shortcut: '', run: () => {
            if (activeTabId != null && api.checkIpGeo) void api.checkIpGeo(activeTabId);
        } },
        { label: 'Reset first-run welcome wizard', category: 'App', keywords: 'onboarding tutorial', shortcut: '', run: () => { void api.resetOnboardingWizard?.().catch(() => {}); } },

        { label: 'Window switcher', category: 'Windows', keywords: 'alt-tab overview', shortcut: 'Ctrl+`', run: () => showWindowSwitcher() },
    ];
}

function getOmniboxHintText() {
    if (isCommandMode()) {
        return '↑↓ select · Enter run · Esc close · Shift+Enter as URL';
    }
    return '↑↓ select · Enter open · Tab complete · Esc close · Type > for commands';
}

let _omniboxOverlayReady = null;
let _omniboxFaviconLoadGen = 0;
let _omniboxSyncRaf = null;
let _omniboxRenderTimer = null;
let _omniboxFaviconTimer = null;
let _omniboxRenderGen = 0;

function _omniboxRowNeedsFavicon(row) {
    if (!row || row.kind === 'cmd' || row._isSearchUrl || row.icon === 'search') return false;
    return !!(row.url || row.urlPreview);
}

function attachOmniboxFaviconsSync(rows) {
    const fc = window.CupNetFaviconCache;
    if (!fc) return;
    for (const row of rows) {
        if (!_omniboxRowNeedsFavicon(row)) continue;
        const url = row.url || row.urlPreview;
        const tab = row.tabId != null ? tabs.find((t) => t.id === row.tabId) : null;
        const fav = fc.resolveSync(url, tab?.faviconUrl || null);
        if (fav) row.faviconUrl = fav;
        else delete row.faviconUrl;
    }
}

async function enrichOmniboxFaviconsAsync(expectedGen) {
    const fc = window.CupNetFaviconCache;
    if (!fc || !isOmniboxDropdownVisible() || expectedGen !== _omniboxFaviconLoadGen) return;
    const rows = omniboxRows;
    const entries = [];
    for (const row of rows) {
        if (!_omniboxRowNeedsFavicon(row) || row.faviconUrl) continue;
        const url = row.url || row.urlPreview;
        const tab = row.tabId != null ? tabs.find((t) => t.id === row.tabId) : null;
        entries.push({ url, tabFaviconUrl: tab?.faviconUrl || null });
    }
    if (!entries.length) return;
    await fc.loadMany(entries, 8, 3);
    if (expectedGen !== _omniboxFaviconLoadGen || !isOmniboxDropdownVisible()) return;
    attachOmniboxFaviconsSync(omniboxRows);
    syncOmniboxOverlay();
}

function scheduleEnrichOmniboxFavicons() {
    clearTimeout(_omniboxFaviconTimer);
    const gen = _omniboxFaviconLoadGen;
    _omniboxFaviconTimer = setTimeout(() => {
        _omniboxFaviconTimer = null;
        void enrichOmniboxFaviconsAsync(gen);
    }, 150);
}

function resetOmniboxOverlayReady() {
    _omniboxOverlayReady = null;
}

async function ensureOmniboxOverlay() {
    if (!isOmniboxDropdownVisible()) return false;
    if (!_omniboxOverlayReady) {
        _omniboxOverlayReady = api.showOmniboxOverlay?.().catch(() => false);
    }
    return !!(await _omniboxOverlayReady);
}

function paintInlineOmniboxList() {
    syncOmniboxOverlay();
}

function buildOmniboxOverlayPayload() {
    const anchor = addressBarContainer?.getBoundingClientRect();
    const left = anchor ? Math.round(anchor.left) : 0;
    const width = anchor ? Math.max(120, Math.round(anchor.width)) : undefined;
    const topGap = anchor
        ? Math.max(2, Math.round(anchor.bottom - OMNIBOX_OVERLAY_TOP_PX + 2))
        : 4;
    return {
        backdrop: false,
        attached: true,
        left,
        width,
        topGap,
        hint: getOmniboxHintText(),
        emptyText: isCommandMode() ? 'No commands match' : 'No suggestions yet',
        items: omniboxRows.map((row, i) => ({
            active: i === commandPaletteActiveIdx,
            icon: row.icon || row.kind || 'url',
            label: row.label,
            match: row.match,
            sub: row.kind === 'cmd' ? (row.category || '') : (row.sub || ''),
            shortcut: row.shortcut || '',
            urlPreview: row.urlPreview || '',
            faviconUrl: row.faviconUrl || '',
        })),
    };
}

function syncOmniboxOverlay() {
    if (!isOmniboxDropdownVisible()) return;
    if (_omniboxSyncRaf) return;
    _omniboxSyncRaf = requestAnimationFrame(() => {
        _omniboxSyncRaf = null;
        if (!isOmniboxDropdownVisible()) return;
        try {
            void api.updateOmniboxOverlay?.(buildOmniboxOverlayPayload());
        } catch (_) { /* ignore */ }
    });
}

function syncOmniboxHighlightOnly() {
    syncOmniboxOverlay();
}

function _applyInlineAutocompleteGhost() {
    if (!urlInput || isCommandMode()) return;
    const q = String(urlInput.value || '');
    const trimmed = q.trim();
    if (!trimmed || _shouldSkipInlineGhost(trimmed)) return;
    if (urlInput.selectionStart !== q.length) return;
    const top = omniboxRows.find((r) => r && r.kind === 'url' && r.url && !r._isSearchUrl && !r._isExactTyped && r.sub === 'History');
    if (!top || !top.url) return;
    const low = trimmed.toLowerCase();
    const ulow = String(top.url).toLowerCase();
    if (!ulow.startsWith(low) || top.url.length <= trimmed.length) return;
    const full = top.url;
    urlInput.value = full;
    urlInput.setSelectionRange(trimmed.length, full.length);
}

async function renderOmniboxList() {
    const renderGen = ++_omniboxRenderGen;
    if (isCommandMode()) {
        const q = getCommandFilterQuery();
        const all = getCommandPaletteCommands();
        const cmds = all.filter((c) => _cupnetFuzzyMatch(q, `${c.label} ${c.category} ${c.keywords || ''}`));
        omniboxRows = cmds.map((c) => ({
            kind: 'cmd',
            icon: 'cmd',
            label: c.label,
            category: c.category,
            shortcut: c.shortcut,
            run: c.run,
            match: _computeMatchRange(c.label, q),
        }));
        commandPaletteActiveIdx = Math.min(commandPaletteActiveIdx, Math.max(0, omniboxRows.length - 1));
    } else {
        const q = (urlInput?.value || '').trim();
        const ql = q.toLowerCase();
        let suggestions = [];
        try {
            suggestions = await api.getOmniboxSuggestions?.(q, 24);
        } catch {
            suggestions = [];
        }
        const quick = OMNIBOX_QUICK_LINKS.filter((x) => _cupnetFuzzyMatch(ql, `${x.label} ${x.keywords}`))
            .map((x) => ({
                kind: 'url',
                icon: 'quick',
                label: x.label,
                sub: 'Quick link',
                url: x.url,
                match: _computeMatchRange(x.label, q),
                urlPreview: x.url,
            }));
        const tabRows = [];
        const active = tabs.find((t) => t.isActive);
        const activeId = active?.id;
        if (ql) {
            for (const t of tabs) {
                if (t.id === activeId) continue;
                const tu = String(t.url || '');
                const tt = String(t.title || '');
                if (!tu.toLowerCase().includes(ql) && !tt.toLowerCase().includes(ql)) continue;
                const label = tt || tu || 'Tab';
                tabRows.push({
                    kind: 'tab',
                    icon: 'tab',
                    label,
                    sub: 'Switch to tab',
                    tabId: t.id,
                    url: tu,
                    match: _computeMatchRange(label, q) || _computeMatchRange(tu, q),
                    urlPreview: tu,
                });
                if (tabRows.length >= 4) break;
            }
        }
        const hist = (Array.isArray(suggestions) ? suggestions : []).map((row) => {
            const label = row.title ? String(row.title) : (row.host || row.url || '');
            const urlPreview = row.url || '';
            return {
                kind: 'url',
                icon: 'history',
                label,
                sub: 'History',
                url: row.url,
                match: _computeMatchRange(label, q) || _computeMatchRange(row.host || '', q) || _computeMatchRange(row.url || '', q),
                urlPreview,
            };
        });
        const searchRow = [];
        if (ql && !_looksLikeUrlOrHost(q)) {
            const seLabel = _searchEngineDisplayName();
            const line = `Search ${seLabel} for "${q}"`;
            searchRow.push({
                kind: 'url',
                icon: 'search',
                label: line,
                sub: 'Search',
                url: q,
                _isSearchUrl: true,
                match: _computeMatchRange(line, q),
                urlPreview: '',
            });
        }
        const exactRow = _buildExactTypedUrlRow(q);
        const typedRows = exactRow ? [exactRow] : [];
        omniboxRows = [...typedRows, ...searchRow, ...tabRows, ...quick, ...hist].slice(0, 24);
        commandPaletteActiveIdx = Math.min(commandPaletteActiveIdx, Math.max(0, omniboxRows.length - 1));
    }
    if (renderGen !== _omniboxRenderGen) return;
    attachOmniboxFaviconsSync(omniboxRows);
    await ensureOmniboxOverlay();
    if (renderGen !== _omniboxRenderGen) return;
    paintInlineOmniboxList();
    if (!isCommandMode()) _applyInlineAutocompleteGhost();
    scheduleEnrichOmniboxFavicons();
}

function scheduleRenderOmniboxList(immediate = false) {
    if (immediate) {
        clearTimeout(_omniboxRenderTimer);
        _omniboxRenderTimer = null;
        void renderOmniboxList();
        return;
    }
    clearTimeout(_omniboxRenderTimer);
    _omniboxRenderTimer = setTimeout(() => {
        _omniboxRenderTimer = null;
        void renderOmniboxList();
    }, 60);
}

function runOmniboxIndex(idx) {
    const row = omniboxRows[idx];
    if (!row) return;
    hideCommandPalette();
    try {
        if (row.kind === 'cmd') row.run();
        else if (row.kind === 'tab') void api.switchTab?.(row.tabId);
        else if (row.kind === 'url') api.navigateTo(row.url);
    } catch (e) {
        console.error('[Omnibox]', e);
        if (typeof showToast === 'function') showToast(String(e?.message || e), { type: 'error' });
    }
}

function showOmniboxShell() {
    if (!urlInput || !urlOmniboxDropdown) return;
    urlOmniboxDropdown.classList.add('hidden');
    urlOmniboxDropdown.setAttribute('aria-hidden', 'true');
    addressBarContainer?.classList.add('omnibox-open');
    urlInput.setAttribute('aria-expanded', 'true');
    if (!_omniboxOverlayReady) {
        _omniboxOverlayReady = api.showOmniboxOverlay?.().catch(() => false);
    }
    void _omniboxOverlayReady.then((ok) => {
        if (ok && isOmniboxDropdownVisible()) syncOmniboxOverlay();
    });
}

/** Focus address bar + `>` + command list (Cmd/Ctrl+K). */
async function openCommandOmniboxHotkey() {
    if (!urlInput) return;
    if (isOmniboxDropdownVisible() && isCommandMode() && String(urlInput.value || '').trim() === '>') {
        hideCommandPalette();
        return;
    }
    showOmniboxShell();
    urlInput.value = '>';
    commandPaletteActiveIdx = 0;
    _omniboxHighlightMoved = false;
    void scheduleRenderOmniboxList(true);
    urlInput.focus();
    urlInput.setSelectionRange(1, 1);
}

/** Suggestions for normal URL mode (focus / Ctrl+L). */
function openNavOmniboxOnFocus() {
    if (!urlInput || isCommandMode()) return;
    showOmniboxShell();
    commandPaletteActiveIdx = 0;
    _omniboxHighlightMoved = false;
    void scheduleRenderOmniboxList(true);
}

async function onUrlInputOmnibox() {
    _omniboxHighlightMoved = false;
    if (isCommandMode()) {
        if (!isOmniboxDropdownVisible()) showOmniboxShell();
        commandPaletteActiveIdx = 0;
        scheduleRenderOmniboxList();
        return;
    }
    if (!isOmniboxDropdownVisible()) return;
    commandPaletteActiveIdx = 0;
    scheduleRenderOmniboxList();
}

function hideCommandPalette() {
    resetOmniboxOverlayReady();
    _omniboxFaviconLoadGen++;
    _omniboxRenderGen++;
    clearTimeout(_omniboxRenderTimer);
    clearTimeout(_omniboxFaviconTimer);
    _omniboxRenderTimer = null;
    _omniboxFaviconTimer = null;
    if (_omniboxSyncRaf) {
        cancelAnimationFrame(_omniboxSyncRaf);
        _omniboxSyncRaf = null;
    }
    try {
        void api.hideOmniboxOverlay?.();
    } catch (_) { /* ignore */ }
    urlOmniboxDropdown?.classList.add('hidden');
    urlOmniboxDropdown?.setAttribute('aria-hidden', 'true');
    addressBarContainer?.classList.remove('omnibox-open');
    if (urlInput) {
        urlInput.placeholder = URL_INPUT_PLACEHOLDER_DEFAULT;
        urlInput.setAttribute('aria-expanded', 'false');
        if (!_urlInputDirty) {
            const active = tabs.find((t) => t.isActive);
            if (active) {
                const v = _normalizeToolbarUrl(active.url || '');
                urlInput.value = v;
                _committedToolbarUrl = v;
                _syncUrlDisplayAndSiteInfo(v);
            }
        }
        if (urlClearBtn) urlClearBtn.hidden = !String(urlInput.value || '').trim();
    }
    omniboxRows = [];
    _omniboxHighlightMoved = false;
    void applyChromeLayoutReserve();
}

_focusUrlBarOmniboxExtra = () => {
    void openNavOmniboxOnFocus();
};

urlInput.addEventListener('input', () => {
    _urlInputDirty = true;
    void onUrlInputOmnibox();
    if (urlClearBtn) urlClearBtn.hidden = !String(urlInput.value || '').trim();
});

urlInputStack?.addEventListener('mousedown', (e) => {
    if (e.target === urlClearBtn || urlClearBtn?.contains(e.target)) return;
    if (document.activeElement !== urlInput) {
        e.preventDefault();
        urlInput.focus();
        urlInput.select();
    }
});

urlInput.addEventListener('mousedown', (e) => {
    if (document.activeElement !== urlInput) {
        e.preventDefault();
        urlInput.focus();
        urlInput.select();
    }
});

urlClearBtn?.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    urlInput.value = '';
    _urlInputDirty = true;
    urlInput.focus();
    if (urlClearBtn) urlClearBtn.hidden = true;
    void onUrlInputOmnibox();
});

siteInfoBtn?.addEventListener('dragstart', (e) => {
    const active = tabs.find((t) => t.isActive);
    const u = active?.url ? String(active.url) : String(urlInput.value || '').trim();
    if (!u) {
        e.preventDefault();
        return;
    }
    try {
        e.dataTransfer.setData('text/uri-list', u);
        e.dataTransfer.setData('text/plain', u);
    } catch (_) { /* ignore */ }
});

siteInfoBtn?.addEventListener('click', (ev) => {
    ev.preventDefault();
    const active = tabs.find((t) => t.isActive);
    if (!active || !siteInfoBtn) return;
    const r = siteInfoBtn.getBoundingClientRect();
    void api.toggleSiteInfoPopover?.(active.id, { x: r.left, y: r.top, w: r.width, h: r.height });
});

urlInput.addEventListener('focus', () => {
    if (urlClearBtn) urlClearBtn.hidden = !String(urlInput.value || '').trim();
    if (isCommandMode()) {
        if (!isOmniboxDropdownVisible()) showOmniboxShell();
        void scheduleRenderOmniboxList(true);
        return;
    }
    openNavOmniboxOnFocus();
});

urlInput.addEventListener('blur', () => {
    setTimeout(() => {
        if (addressBarContainer && !addressBarContainer.contains(document.activeElement)) {
            hideCommandPalette();
        }
    }, 0);
    if (!_urlInputDirty) return;
    if (_normalizeToolbarUrl(urlInput.value) === _committedToolbarUrl) {
        _urlInputDirty = false;
        return;
    }
    _setToolbarUrl(_committedToolbarUrl, { forceInput: true });
});

api.onToggleCommandPalette?.(() => {
    void openCommandOmniboxHotkey();
});

api.onOmniboxOverlaySelect?.((idx) => {
    const i = Number(idx);
    if (Number.isFinite(i)) runOmniboxIndex(i);
});
api.onOmniboxOverlayDismiss?.(() => {
    hideCommandPalette();
});
api.onForceCloseOmnibox?.(() => {
    if (!isOmniboxDropdownVisible()) return;
    hideCommandPalette();
});

/** Capture phase: arrows / Enter when omnibox is open (list is under address bar). */
function onCommandPaletteGlobalKeydown(e) {
    if (!isOmniboxDropdownVisible()) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (omniboxRows.length) {
            _omniboxHighlightMoved = true;
            commandPaletteActiveIdx = Math.min(omniboxRows.length - 1, commandPaletteActiveIdx + 1);
            syncOmniboxHighlightOnly();
        }
        return;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        _omniboxHighlightMoved = true;
        commandPaletteActiveIdx = Math.max(0, commandPaletteActiveIdx - 1);
        syncOmniboxHighlightOnly();
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const raw = (urlInput?.value || '').trim();
        const modEnter = (e.metaKey || e.ctrlKey || e.altKey) && !e.shiftKey;
        if (isCommandMode()) {
            if (e.shiftKey) {
                const rest = raw.replace(/^>\s*/, '').trim();
                if (rest) api.navigateTo(rest);
                hideCommandPalette();
                return;
            }
            if (omniboxRows.length) runOmniboxIndex(commandPaletteActiveIdx);
            return;
        }
        if (modEnter && raw) {
            hideCommandPalette();
            void (async () => {
                await api.newTab();
                api.navigateTo(raw);
            })();
            return;
        }
        if (e.shiftKey) {
            if (raw) api.navigateTo(raw);
            hideCommandPalette();
            return;
        }
        if (_omniboxHighlightMoved && omniboxRows.length) {
            runOmniboxIndex(commandPaletteActiveIdx);
            return;
        }
        if (raw) {
            api.navigateTo(raw);
            hideCommandPalette();
            return;
        }
        if (omniboxRows.length) runOmniboxIndex(commandPaletteActiveIdx);
        hideCommandPalette();
    }
}
document.addEventListener('keydown', onCommandPaletteGlobalKeydown, true);

omniboxListEl?.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.command-palette-item');
    if (!item) return;
    e.preventDefault();
    const idx = Number(item.dataset.idx);
    if (Number.isFinite(idx)) runOmniboxIndex(idx);
});

document.addEventListener('mousedown', (e) => {
    if (!isOmniboxDropdownVisible()) return;
    if (addressBarContainer?.contains(e.target)) return;
    hideCommandPalette();
}, true);

let _omniboxResizeTimer = null;
window.addEventListener('resize', () => {
    if (!isOmniboxDropdownVisible()) return;
    clearTimeout(_omniboxResizeTimer);
    _omniboxResizeTimer = setTimeout(() => {
        syncOmniboxOverlay();
    }, 80);
});

document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === ',') {
        e.preventDefault();
        api.openSettingsTab?.();
        return;
    }
    if (e.key === 'Escape' && isOmniboxDropdownVisible()) {
        if (_clearInlineGhostSelection()) {
            e.preventDefault();
            _omniboxHighlightMoved = false;
            commandPaletteActiveIdx = 0;
            void onUrlInputOmnibox();
            return;
        }
        e.preventDefault();
        hideCommandPalette();
        return;
    }
    if (e.key === 'Escape' && _toolbarLoading && !isOmniboxDropdownVisible()) {
        e.preventDefault();
        try { api.navStop?.(); } catch (_) { /* ignore */ }
    }
}, true);

api.onSessionProfileLoaded?.((result) => {
    const parts = [`Session "${result?.name || 'loaded'}"`];
    if (result?.navigationStarted) parts.push('navigation started');
    if (result?.url) parts.push(result.url.replace(/^https?:\/\//, '').slice(0, 48));
    if (result?.cookiesOk) parts.push(`${result.cookiesOk} cookie(s)`);
    if (result?.cookiesFail) parts.push(`${result.cookiesFail} failed`);
    if (typeof showToast === 'function') {
        showToast(parts.join(' · '), { type: 'success', duration: 5000 });
    }
});

api.onSessionProfileLoadFailed?.((result) => {
    if (typeof showToast === 'function') {
        showToast(result?.error || 'Session load failed', { type: 'error', duration: 8000 });
    }
});
