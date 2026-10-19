const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Anti-Anti-Debug shim (Layer 2): main process decides per-URL whether to ship a
// `debugger`/console-trap-stripping IIFE for the current navigation. Must run
// FIRST so the page can't observe console.log being patched mid-flight.
// See main-process/services/{anti-anti-debug-script.js, devtools-hostile-sites.js}.
try {
    const aadData = ipcRenderer.sendSync('get-anti-anti-debug-sync', { url: location.href });
    if (aadData && aadData.script) {
        webFrame.executeJavaScript(aadData.script);
    }
} catch { /* ignore — internal pages, handler not ready, etc. */ }

// Camera filter: inject into main world BEFORE any page scripts.
// Uses synchronous IPC so it blocks until the script is ready — guaranteed early.
try {
    const camData = ipcRenderer.sendSync('get-device-permissions-sync');
    if (camData && camData.script) {
        webFrame.executeJavaScript(camData.script);
    }
} catch { /* ignore — e.g. internal pages where IPC handler may not be ready yet */ }

// Paste unlock: same early inject — must register capture listeners before site anti-paste scripts.
try {
    const pasteData = ipcRenderer.sendSync('get-paste-unlock-sync');
    if (pasteData && pasteData.script) {
        webFrame.executeJavaScript(pasteData.script);
    }
} catch { /* ignore */ }

// Browser identity: for non-Chromium identities (Firefox/Safari UA) hide navigator.userAgentData,
// which Chromium keeps exposing even under a CDP UA override. Chromium identities need nothing here.
try {
    const idData = ipcRenderer.sendSync('get-identity-navigator-patch-sync');
    if (idData && idData.script) {
        webFrame.executeJavaScript(idData.script);
    }
} catch { /* ignore */ }

// Listen for live settings changes — re-inject when user toggles cameras.
ipcRenderer.on('camera-filter-update', (_, payload) => {
    try {
        if (payload && payload.script) {
            webFrame.executeJavaScript(payload.script);
        }
    } catch { /* ignore */ }
});

ipcRenderer.on('paste-unlock-update', (_, payload) => {
    try {
        if (payload && payload.script) {
            webFrame.executeJavaScript(payload.script);
        }
    } catch { /* ignore */ }
});

// Expose the internal bridge ONLY to CupNet's own pages (new-tab.html, error-page.html,
// settings.html, …), never to untrusted web content. On an external site `window.electronAPI`
// would be (1) a unique, always-present "this is CupNet, not Chrome" fingerprint that anti-bot
// challenges enumerate, and (2) a privileged-IPC surface (setTabProxy, connectProxyTemplate,
// createCookieGroup, clearCookies, ext-proxy control, …) reachable from the page. Real Chrome
// exposes no such global. CupNet's internal pages are loaded from the app directory with
// loadFile(); tab-manager passes that directory as `--cupnet-internal-root=<file URL>`. Only a
// file: page under it gets the bridge — not about:blank (a site can window.open('about:blank') and
// script the same-origin popup) and not arbitrary local files. (A-009 / A-004; CLAUDE.md: keep this
// preload minimal for untrusted sites.)
function isInternalCupnetPage() {
    try {
        if (location.protocol !== 'file:') return false;
        const arg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith('--cupnet-internal-root='));
        if (!arg) return false;
        const root = arg.slice('--cupnet-internal-root='.length).replace(/\/+$/, '');
        return !!root && location.href.startsWith(root + '/');
    } catch {
        return false;
    }
}

// Preload for tab WebContentsView pages (including new-tab.html)
if (isInternalCupnetPage()) {
contextBridge.exposeInMainWorld('electronAPI', {
    // Mouse activity tracking
    reportMouseActivity: () => ipcRenderer.send('report-mouse-activity'),
    reportTabPointer:    (p) => ipcRenderer.send('report-tab-pointer', p),

    // App uptime — for delayed glow on first launch
    getUptime:       ()     => ipcRenderer.invoke('get-uptime'),
    consumeStartupSplash: () => ipcRenderer.invoke('consume-startup-splash'),
    getAppVersion:   ()     => ipcRenderer.invoke('get-app-version'),

    // Proxy & IP — needed by new-tab.html widget
    checkIpGeo:      (tabId) => ipcRenderer.invoke('check-ip-geo', tabId),
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
    // Read-only: the configured omnibox search engine (new-tab.html search box follows Settings).
    getSearchEngine: () => ipcRenderer.invoke('get-search-engine'),
    retryFailedNavigation: () => ipcRenderer.send('retry-failed-navigation'),

    reportHttpLabUiState: (state) => ipcRenderer.send('http-lab-ui-state', state),

    // Proxy profiles — needed by new-tab.html shortcut editor
    getProxyProfiles:     ()         => ipcRenderer.invoke('get-proxy-profiles'),
    connectProxyTemplate: (id, vars) => ipcRenderer.invoke('connect-proxy-template', id, vars),

    // Persistent UI preferences (shared across all tabs)
    getUiPref: (key, def)    => ipcRenderer.invoke('get-ui-pref', key, def),
    setUiPref: (key, value)  => ipcRenderer.invoke('set-ui-pref', key, value),

    // Cookie isolation: convert current tab to isolated session
    isolateTab: (tabId) => ipcRenderer.invoke('isolate-tab', tabId),

    // Notify when tab list changes (to detect isolation state from new-tab.html)
    onTabListUpdated: (cb) => {
        ipcRenderer.removeAllListeners('tab-list-updated');
        ipcRenderer.on('tab-list-updated', (_, tabs) => cb(tabs));
    },
    getTabs: () => ipcRenderer.invoke('get-tabs'),

    setTabProxy:        (id, pid, ephemeralVars) => ipcRenderer.invoke('set-tab-proxy', id, pid, ephemeralVars),
    setTabCookieGroup:  (id, gid) => ipcRenderer.invoke('set-tab-cookie-group', id, gid),
    getCookieGroups:    ()        => ipcRenderer.invoke('get-cookie-groups'),
    createCookieGroup:  (name)    => ipcRenderer.invoke('create-cookie-group', name),
    onCookieGroupsUpdated: (cb) => {
        ipcRenderer.removeAllListeners('cookie-groups-updated');
        ipcRenderer.on('cookie-groups-updated', () => cb());
    },

    // Cookie status bar on new-tab.html
    getCookies:        (tid, f)  => ipcRenderer.invoke('get-cookies', tid, f),
    clearCookies:      (tid, dm) => ipcRenderer.invoke('clear-cookies', tid, dm),
    openCookieManager: (tid)     => ipcRenderer.invoke('open-cookie-manager', tid),

    // External Proxy — status widget on new-tab.html
    extProxyList:      ()        => ipcRenderer.invoke('ext-proxy:list'),
    extProxyStart:     (port)    => ipcRenderer.invoke('ext-proxy:start', port),
    extProxyOpenBrowser: (port, url) => ipcRenderer.invoke('ext-proxy:open-browser', port, url),
    extProxyStop:      (port)    => ipcRenderer.invoke('ext-proxy:stop', port),
    extProxySetPort:   (oldPort, newPort) => ipcRenderer.invoke('ext-proxy:set-port', oldPort, newPort),
    extProxySetRedirects: (port, follow) => ipcRenderer.invoke('ext-proxy:set-redirects', port, follow),

    // UI prefs only (new-tab quick links) — no privileged settings export/import
    getUiPref: (key, fallback) => ipcRenderer.invoke('get-ui-pref', key, fallback),
    setUiPref: (key, value) => ipcRenderer.invoke('set-ui-pref', key, value),
});

/** Injected storage wrapper (tab-manager) reports localStorage/sessionStorage ops with stack traces. */
contextBridge.exposeInMainWorld('cupnetStorageActivity', {
    report: (payload) => {
        try {
            ipcRenderer.send('browser-storage-activity', payload);
        } catch (_) { /* ignore */ }
    },
});
} // end isInternalCupnetPage() bridge guard

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
