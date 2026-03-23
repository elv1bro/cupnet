const { contextBridge, ipcRenderer } = require('electron');

// Preload for BrowserView tabs (including new-tab.html)
contextBridge.exposeInMainWorld('electronAPI', {
    // Mouse activity tracking
    reportMouseActivity: () => ipcRenderer.send('report-mouse-activity'),
    reportTabPointer:    (p) => ipcRenderer.send('report-tab-pointer', p),

    // App uptime — for delayed glow on first launch
    getUptime:       ()     => ipcRenderer.invoke('get-uptime'),
    consumeStartupSplash: () => ipcRenderer.invoke('consume-startup-splash'),
    getAppVersion:   ()     => ipcRenderer.invoke('get-app-version'),

    // Proxy & IP — needed by new-tab.html widget
    checkIpGeo:      ()     => ipcRenderer.invoke('check-ip-geo'),
    getDirectIp:     ()     => ipcRenderer.invoke('get-direct-ip'),
    getCurrentProxy: ()     => ipcRenderer.invoke('get-current-proxy'),
    getMitmReady:    ()     => ipcRenderer.invoke('mitm-ready-state'),
    openProxyManager:()     => ipcRenderer.invoke('open-proxy-manager'),
    onProxyStatusChanged: (cb) => {
        ipcRenderer.removeAllListeners('proxy-status-changed');
        ipcRenderer.on('proxy-status-changed', (_, info) => cb(info));
    },
    onMitmReadyChanged: (cb) => {
        ipcRenderer.removeAllListeners('mitm-ready-changed');
        ipcRenderer.on('mitm-ready-changed', (_, info) => cb(info));
    },
    reportUiFirstPaint: () => ipcRenderer.send('ui-first-paint'),
    reportUiLongTaskCount: (count) => ipcRenderer.send('ui-long-task-count', count),

    // Navigation from new-tab.html search bar — load URL in current tab
    navigateTo: (url) => ipcRenderer.send('navigate-to', url),

    // Proxy profiles — needed by new-tab.html shortcut editor
    getProxyProfiles:     ()         => ipcRenderer.invoke('get-proxy-profiles'),
    connectProxyTemplate: (id, vars) => ipcRenderer.invoke('connect-proxy-template', id, vars),

    // Persistent UI preferences (shared across all tabs)
    getUiPref: (key, def)    => ipcRenderer.invoke('get-ui-pref', key, def),
    setUiPref: (key, value)  => ipcRenderer.invoke('set-ui-pref', key, value),

    // Cookie isolation: convert current tab to isolated session
    isolateTab: () => ipcRenderer.invoke('isolate-tab'),

    // Notify when tab list changes (to detect isolation state from new-tab.html)
    onTabListUpdated: (cb) => {
        ipcRenderer.removeAllListeners('tab-list-updated');
        ipcRenderer.on('tab-list-updated', (_, tabs) => cb(tabs));
    },
    getTabs: () => ipcRenderer.invoke('get-tabs'),

    // Cookie status bar on new-tab.html
    getCookies:        (tid, f)  => ipcRenderer.invoke('get-cookies', tid, f),
    clearCookies:      (tid, dm) => ipcRenderer.invoke('clear-cookies', tid, dm),
    openCookieManager: (tid)     => ipcRenderer.invoke('open-cookie-manager', tid),

    // External Proxy — status widget on new-tab.html
    extProxyList:      ()        => ipcRenderer.invoke('ext-proxy:list'),
    extProxyStart:     (port)    => ipcRenderer.invoke('ext-proxy:start', port),
    extProxyStop:      (port)    => ipcRenderer.invoke('ext-proxy:stop', port),
    extProxySetPort:   (oldPort, newPort) => ipcRenderer.invoke('ext-proxy:set-port', oldPort, newPort),
    extProxySetRedirects: (port, follow) => ipcRenderer.invoke('ext-proxy:set-redirects', port, follow),

    // Settings page
    openSettingsTab:    ()        => ipcRenderer.invoke('open-settings-tab'),
    getSettingsAll:     ()        => ipcRenderer.invoke('get-settings-all'),
    setPasteUnlock:     (enabled) => ipcRenderer.invoke('set-paste-unlock', enabled),
    saveFilterPatterns: (patterns)=> ipcRenderer.invoke('save-filter-patterns', patterns),
    saveBypassDomains:  (domains) => ipcRenderer.invoke('save-bypass-domains', domains),
    saveTrackingSettings:(cfg)    => ipcRenderer.invoke('save-tracking-settings', cfg),
    getCapmonsterSettings: ()     => ipcRenderer.invoke('get-capmonster-settings'),
    saveCapmonsterSettings: (cfg) => ipcRenderer.invoke('save-capmonster-settings', cfg),
    solveTurnstileCaptcha: (tabId, captcha, options) => ipcRenderer.invoke('solve-turnstile-captcha', tabId, captcha, options),
    injectTurnstileToken: (tabId, payload) => ipcRenderer.invoke('inject-turnstile-token', tabId, payload),
    getAppMetrics:      ()        => ipcRenderer.invoke('get-app-metrics'),
});

let _lastPointerReportTs = 0;
let _lastPointerPayload = { xNorm: 0.5, yNorm: 0.5, ts: Date.now(), button: 0 };
function _pointerPayload(ev) {
    try {
        const w = Math.max(1, window.innerWidth || 1);
        const h = Math.max(1, window.innerHeight || 1);
        const x = Number(ev?.clientX);
        const y = Number(ev?.clientY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const p = {
            xNorm: Math.max(0, Math.min(1, x / w)),
            yNorm: Math.max(0, Math.min(1, y / h)),
            ts: Date.now(),
            button: Number.isFinite(Number(ev?.button)) ? Number(ev.button) : 0,
        };
        _lastPointerPayload = p;
        return p;
    } catch {}
    return null;
}

function _emitPointer(ev) {
    const payload = _pointerPayload(ev);
    if (!payload) return;
    ipcRenderer.send('report-tab-pointer', payload);
}

window.addEventListener('mousemove', (ev) => {
    const now = Date.now();
    if (now - _lastPointerReportTs < 120) return;
    _lastPointerReportTs = now;
    _emitPointer(ev);
}, { passive: true, capture: true });

window.addEventListener('mousedown', _emitPointer, { passive: true, capture: true });
window.addEventListener('pointerdown', (ev) => {
    const payload = _pointerPayload(ev);
    if (!payload) return;
    ipcRenderer.send('report-tab-pointer', payload);
    ipcRenderer.send('report-tab-click', payload);
}, { passive: true, capture: true });

let _typingEndTimer = null;
let _lastTypingPayload = null;
function _isTypingTarget(el) {
    if (!el || typeof el !== 'object') return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    const t = String(el.type || '').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(t);
}
function _scheduleTypingEnd(payload) {
    if (!payload) return;
    _lastTypingPayload = payload;
    if (_typingEndTimer) clearTimeout(_typingEndTimer);
    _typingEndTimer = setTimeout(() => {
        if (!_lastTypingPayload) return;
        ipcRenderer.send('report-tab-typing-end', _lastTypingPayload);
        _lastTypingPayload = null;
        _typingEndTimer = null;
    }, 700);
}
window.addEventListener('input', (ev) => {
    if (!_isTypingTarget(ev.target)) return;
    const payload = _pointerPayload(ev) || { xNorm: 0.5, yNorm: 0.5, ts: Date.now(), button: 0 };
    _scheduleTypingEnd(payload);
}, { passive: true, capture: true });
window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || !_isTypingTarget(ev.target)) return;
    const payload = _pointerPayload(ev) || { xNorm: 0.5, yNorm: 0.5, ts: Date.now(), button: 0 };
    _scheduleTypingEnd(payload);
}, { passive: true, capture: true });
window.addEventListener('blur', () => {
    if (!_lastTypingPayload) return;
    ipcRenderer.send('report-tab-typing-end', _lastTypingPayload);
    _lastTypingPayload = null;
    if (_typingEndTimer) { clearTimeout(_typingEndTimer); _typingEndTimer = null; }
}, { capture: true });

let _scrollEndTimer = null;
window.addEventListener('scroll', () => {
    if (_scrollEndTimer) clearTimeout(_scrollEndTimer);
    _scrollEndTimer = setTimeout(() => {
        const p = _lastPointerPayload || { xNorm: 0.5, yNorm: 0.5, ts: Date.now(), button: 0 };
        ipcRenderer.send('report-tab-scroll-end', { ...p, ts: Date.now() });
    }, 2000);
}, { passive: true, capture: true });
