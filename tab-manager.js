'use strict';

const { BrowserView, session } = require('electron');
const path = require('path');
const db = require('./db');
const { networkPolicy } = require('./network-policy');

let mainWindow = null;
let onTabEventCb = null;

const NEW_TAB_PATH = path.join(__dirname, 'new-tab.html');

// Legacy constant — kept for backward compat with code that references it
const SHARED_PARTITION = 'persist:cupnet-shared';

const CG_PARTITION_PREFIX = 'persist:cg_';
function partitionForGroup(cookieGroupId) {
    return `${CG_PARTITION_PREFIX}${cookieGroupId}`;
}

/** Converts internal file:// URLs to a clean display string */
function displayUrl(url) {
    if (!url || url === 'about:blank') return '';
    if (url.startsWith('file://') && url.includes('new-tab.html')) return '';
    if (url.startsWith('file://') && url.includes('settings.html')) return 'cupnet://settings';
    return url;
}

const tabs = new Map();
let activeTabId = null;
let nextTabNumber = 1;
let extraTopOffset = 0;
let _broadcastTimer = null;
let _relayoutTimer = null;
let _currentBypassRules = '<local>,*.youtube.com,*.googlevideo.com,challenges.cloudflare.com';
let _trafficOpts = {};
let _trafficRouteMode = 'mitm';
let _upstreamProxyRules = null;

/** Локальный MITM без логина в proxyRules; tabId в Basic опционален (см. mitm-proxy _mitmTabIdFromProxyAuthHead). */
function mitmProxyRulesForTabId(_tabId) {
    const p = networkPolicy.mitmPort;
    const hostport = `127.0.0.1:${p}`;
    return `http=${hostport};https=${hostport}`;
}

function getMitmOpts() {
    return {
        proxyRules: mitmProxyRulesForTabId(null),
        proxyBypassRules: _currentBypassRules,
    };
}

function getProxyOptsForTab(tabLike = {}) {
    if (tabLike.direct || tabLike.cupnetEnabled === false) return { mode: 'direct' };
    if (_trafficRouteMode === 'browser_proxy') {
        if (_upstreamProxyRules) {
            return {
                proxyRules: _upstreamProxyRules,
                proxyBypassRules: _currentBypassRules,
            };
        }
        return { mode: 'direct' };
    }
    const tid = tabLike.id || null;
    return {
        proxyRules: mitmProxyRulesForTabId(tid),
        proxyBypassRules: _currentBypassRules,
    };
}

// ── Paste Unlock (Don't F*** With Paste) ──────────────────────────────────────
// Injects a capture-phase listener that prevents sites from blocking
// copy/cut/paste/contextmenu events. Enabled by default.
let _pasteUnlockEnabled = true;

/** Script injected into every page when paste-unlock is active. */
const PASTE_UNLOCK_SCRIPT = `(function () {
    if (window.__cupnetPasteUnlocked) return;
    window.__cupnetPasteUnlocked = true;
    const unblock = (e) => { e.stopImmediatePropagation(); return true; };
    ['copy', 'cut', 'paste', 'contextmenu'].forEach(t =>
        document.addEventListener(t, unblock, true)
    );
})();`;

function setPasteUnlock(enabled) {
    _pasteUnlockEnabled = !!enabled;
}

function getPasteUnlock() {
    return _pasteUnlockEnabled;
}

const _STEALTH = Number(process.env.CUPNET_STEALTH_LEVEL || 0);

/**
 * Единые webPreferences для вкладок.
 * webSecurity всегда true: webSecurity:false ломает Cloudflare Turnstile / PAT в Electron (серый виджет).
 */
function buildTabViewWebPreferences(tabSession) {
    const prefs = {
        contextIsolation: true,
        nodeIntegration: false,
        session: tabSession,
        webSecurity: true,
    };
    if (_STEALTH < 6) prefs.preload = path.join(__dirname, 'preload-view.js');
    return prefs;
}

function injectPasteUnlock(webContents) {
    if (_STEALTH >= 1) return;
    if (!_pasteUnlockEnabled) return;
    if (!webContents || webContents.isDestroyed()) return;
    webContents.executeJavaScript(PASTE_UNLOCK_SCRIPT).catch(() => {});
}

/**
 * Converts a proxy URL (http://host:port) to the simple HOST:PORT format.
 */
function proxyUrlToRules(proxyUrl) {
    if (!proxyUrl) return null;
    if (proxyUrl.includes('://')) {
        try {
            const u = new URL(proxyUrl);
            return `${u.hostname}:${u.port}`;
        } catch {}
    }
    return proxyUrl;
}

/**
 * WebRTC IP leak prevention — applied per-webContents when proxy is active.
 * Не через глобальный Chromium --force-webrtc-ip-handling-policy (Cloudflare детектит).
 */
function applyWebRtcPolicy(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    try {
        webContents.setWebRTCIPHandlingPolicy('default_public_interface_only');
        webContents.setWebRTCUDPPortRange?.({ min: 0, max: 0 });
    } catch {}
}

function resetWebRtcPolicy(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    try {
        webContents.setWebRTCIPHandlingPolicy('default');
    } catch {}
}

/** Dynamically adjust how far down the BrowserView starts (to reveal overlays). */
function setExtraTopOffset(px) {
    extraTopOffset = px || 0;
    resizeActiveView();
}

const TOOLBAR_HEIGHT = 95;

/**
 * @param {BrowserWindow} win
 * @param {Function} onEvent
 */
function init(win, onEvent) {
    mainWindow = win;
    onTabEventCb = onEvent || (() => {});
}

/**
 * Attaches all standard webContents event listeners to a tab object.
 * Extracted to allow reuse when recreating views (e.g. during isolation).
 */
function attachTabListeners(tab) {
    const { id: tabId, view } = tab;

    view.webContents.on('page-title-updated', (_, title) => {
        tab.title = title;
        broadcastTabList();
        onTabEventCb('tab-title-changed', tabId, { title });
    });

    view.webContents.on('page-favicon-updated', (_, favicons) => {
        tab.faviconUrl = favicons[0] || null;
        broadcastTabList();
    });

    // Fires when user clicks a link or JS sets window.location — before the page loads.
    // Use this to immediately update the address bar so typed-but-unsubmitted text is cleared.
    view.webContents.on('will-navigate', (_, url) => {
        if (tabId === activeTabId && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tab-will-navigate', { tabId, url: displayUrl(url) });
        }
    });

    view.webContents.on('did-navigate', (_, url) => {
        tab.url = url;
        broadcastTabList();
        const disp = displayUrl(url);
        onTabEventCb('tab-url-changed', tabId, { url: disp });
        if (tabId === activeTabId && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('url-updated', disp);
        }
    });

    view.webContents.on('did-navigate-in-page', (_, url) => {
        tab.url = url;
        broadcastTabList();
        const disp = displayUrl(url);
        onTabEventCb('tab-url-changed', tabId, { url: disp });
        if (tabId === activeTabId && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('url-updated', disp);
        }
    });

    view.webContents.on('did-start-loading', () => {
        if (tabId === activeTabId && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('set-loading-state', true);
        }
    });

    view.webContents.on('did-stop-loading', () => {
        if (tabId === activeTabId && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('set-loading-state', false);
        }
    });

    view.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
        if (tabId === activeTabId && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('set-loading-state', false);
        }
        onTabEventCb('tab-load-error', tabId, { errorCode, errorDescription, url: validatedURL });
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
        onTabEventCb('open-in-new-tab', tabId, { url });
        return { action: 'deny' };
    });

    // Inject paste-unlock script after every page load.
    // did-finish-load fires after all page scripts ran — our capture listener
    // still wins because capture phase fires before site bubble-phase listeners.
    view.webContents.on('did-finish-load', () => {
        injectPasteUnlock(view.webContents);
    });
}

let _trustMitmCA = null;
function setTrustMitmCA(fn) { _trustMitmCA = fn; }

/** Called when a tab is closed/destroyed so MITM can drop per-tab upstream state. */
let _mitmTabUpstreamCleanup = null;
function setMitmTabUpstreamCleanup(fn) {
    _mitmTabUpstreamCleanup = typeof fn === 'function' ? fn : null;
}

function reapplyMitmTrustToSharedSession() {
    if (_trafficRouteMode !== 'mitm' || !_trustMitmCA) return;
    try {
        const seen = new Set();
        const trustOnce = (s) => {
            if (!s || seen.has(s)) return;
            seen.add(s);
            try { _trustMitmCA(s); } catch (_) { /* ignore */ }
        };
        trustOnce(session.fromPartition(partitionForGroup(1)));
        trustOnce(session.fromPartition(SHARED_PARTITION));
        for (const tab of tabs.values()) {
            if (!tab.cupnetEnabled) continue;
            const sess = tab.view?.webContents && !tab.view.webContents.isDestroyed()
                ? tab.view.webContents.session
                : tab.tabSession;
            trustOnce(sess);
        }
    } catch (_) { /* ignore */ }
}

/**
 * Creates a new tab with per-tab settings.
 * @param {object} opts
 * @param {string}       [opts.url]             – initial URL (default: about:blank → new-tab.html)
 * @param {number}       [opts.cookieGroupId=1] – cookie group (maps to Electron partition)
 * @param {boolean}      [opts.cupnetEnabled=true] – CupNet mode (MITM + logging + filters)
 * @param {number|null}  [opts.proxyProfileId=null] – per-tab proxy profile (null = global)
 * @param {string|null}  [opts.proxyRules=null] – legacy: raw proxy rules for DB session
 * @param {number|null}  [opts.existingSessionId=null] – reuse a DB session
 * @returns {Promise<string>} tabId
 */
async function createTab(opts = {}) {
    // Support legacy call signature: createTab(proxyRules, initialUrl, isolated, existingSessionId)
    if (typeof opts === 'string' || opts === null) {
        const [proxyRules, initialUrl, isolated, existingSessionId] = arguments;
        let cookieGroupId = 1;
        if (isolated) {
            const newGroup = await db.createCookieGroupAsync(`Isolated ${Date.now()}`);
            if (!newGroup) throw new Error('Failed to create cookie group for isolated tab');
            cookieGroupId = newGroup.id;
        }
        return createTab({
            proxyRules: proxyRules || null,
            url: initialUrl || null,
            cookieGroupId,
            cupnetEnabled: true,
            existingSessionId: existingSessionId || null,
        });
    }

    const {
        url = null,
        cookieGroupId = 1,
        cupnetEnabled = true,
        proxyProfileId = null,
        proxyRules = null,
        existingSessionId = null,
    } = opts;

    const tabId    = `tab_${Date.now()}_${nextTabNumber++}`;
    const partition = partitionForGroup(cookieGroupId);
    const tabSession = session.fromPartition(partition);

    if (cupnetEnabled) {
        if (_trafficRouteMode === 'mitm' && _trustMitmCA) _trustMitmCA(tabSession);
        await tabSession.setProxy(getProxyOptsForTab({ cupnetEnabled: true, id: tabId })).catch(e => console.error('[tab] setProxy', e?.message));
        applyTrafficFiltersToSession(tabSession);
    } else {
        await tabSession.setProxy({ mode: 'direct' }).catch(() => {});
    }

    const view = new BrowserView({ webPreferences: buildTabViewWebPreferences(tabSession) });

    let sessionId = existingSessionId || null;
    if (!sessionId && cupnetEnabled) {
        const sessionRow = await db.createSessionAsync(proxyRules || null, tabId);
        sessionId = sessionRow ? sessionRow.id : null;
    }

    const tab = {
        id: tabId,
        view,
        tabSession,
        partition,
        cookieGroupId,
        cupnetEnabled,
        proxyProfileId,
        // Legacy compat fields
        isolated:   cookieGroupId !== 1,
        direct:     !cupnetEnabled,
        proxyRules: proxyRules || null,
        sessionId,
        title: 'New Tab',
        url:   url || 'about:blank',
        faviconUrl: null
    };

    tabs.set(tabId, tab);
    attachTabListeners(tab);

    if (view.webContents && !view.webContents.isDestroyed()) {
        const sess = view.webContents.session;
        if (cupnetEnabled && _trafficRouteMode === 'mitm' && _trustMitmCA) _trustMitmCA(sess);
        sess.setProxy(getProxyOptsForTab(tab)).catch(() => {});
        if (cupnetEnabled && _upstreamProxyRules) applyWebRtcPolicy(view.webContents);
        else resetWebRtcPolicy(view.webContents);
    }

    if (url && url !== 'about:blank') {
        view.webContents.loadURL(url).catch(() => {});
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.addBrowserView(view);
        resizeActiveView();
    }

    return tabId;
}

/**
 * Toggle CupNet mode on/off for a tab. Requires page reload.
 */
async function setTabCupNet(tabId, enabled) {
    const tab = tabs.get(tabId || activeTabId);
    if (!tab) return { success: false, error: 'Tab not found' };

    tab.cupnetEnabled = !!enabled;
    tab.direct = !tab.cupnetEnabled;

    const sess = tab.view?.webContents && !tab.view.webContents.isDestroyed()
        ? tab.view.webContents.session
        : tab.tabSession;

    if (tab.cupnetEnabled) {
        if (_trafficRouteMode === 'mitm' && _trustMitmCA) _trustMitmCA(sess);
        await sess.setProxy(getProxyOptsForTab(tab)).catch(() => {});
        applyTrafficFiltersToSession(sess);
        if (_upstreamProxyRules && tab.view?.webContents) applyWebRtcPolicy(tab.view.webContents);
        if (!tab.sessionId) {
            const sessionRow = await db.createSessionAsync(tab.proxyRules || null, tab.id);
            tab.sessionId = sessionRow ? sessionRow.id : null;
        }
    } else {
        await sess.setProxy({ mode: 'direct' }).catch(() => {});
        try { sess.webRequest.onBeforeRequest(null); } catch {}
        if (tab.view?.webContents) resetWebRtcPolicy(tab.view.webContents);
        tab.proxyProfileId = null;
    }

    broadcastTabList(true);
    if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
        try { tab.view.webContents.reload(); } catch (_) {}
    }
    return { success: true };
}

/**
 * Set per-tab proxy profile (null = use global proxy).
 * Fingerprint from the profile should be applied by the caller (via fingerprint-service).
 */
async function setTabProxy(tabId, proxyProfileId) {
    const tab = tabs.get(tabId || activeTabId);
    if (!tab) return { success: false, error: 'Tab not found' };
    if (!tab.cupnetEnabled) return { success: false, error: 'CupNet is disabled for this tab' };

    tab.proxyProfileId = proxyProfileId || null;
    broadcastTabList(true);
    return { success: true, proxyProfileId: tab.proxyProfileId };
}

/**
 * Change cookie group for a tab. Recreates BrowserView with new partition.
 * Requires page reload since Electron binds sessions at creation.
 */
async function setTabCookieGroup(tabId, cookieGroupId) {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (!tab) return { success: false, error: 'Tab not found' };
    if (tab.cookieGroupId === cookieGroupId) return { success: true };

    try {
        const ri = require('./request-interceptor');
        if (ri && typeof ri.detachFromSession === 'function') {
            ri.detachFromSession(tab.tabSession);
        }
    } catch (_) { /* ignore */ }

    const currentUrl = tab.view.webContents.getURL() || tab.url;

    const newPartition = partitionForGroup(cookieGroupId);
    const newSession   = session.fromPartition(newPartition);

    if (tab.cupnetEnabled) {
        if (_trafficRouteMode === 'mitm' && _trustMitmCA) _trustMitmCA(newSession);
        await newSession.setProxy(getProxyOptsForTab(tab)).catch(() => {});
        applyTrafficFiltersToSession(newSession);
    } else {
        await newSession.setProxy({ mode: 'direct' }).catch(() => {});
    }

    const newView = new BrowserView({ webPreferences: buildTabViewWebPreferences(newSession) });

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.removeBrowserView(tab.view);
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.destroy();

    tab.view          = newView;
    tab.tabSession    = newSession;
    tab.partition     = newPartition;
    tab.cookieGroupId = cookieGroupId;
    tab.isolated      = cookieGroupId !== 1;

    attachTabListeners(tab);

    if (tab.cupnetEnabled) {
        newView.webContents.session.setProxy(getProxyOptsForTab(tab)).catch(() => {});
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.addBrowserView(newView);
        if (tid === activeTabId) resizeActiveView();
    }

    if (currentUrl && currentUrl !== 'about:blank') {
        newView.webContents.loadURL(currentUrl).catch(() => {});
    } else {
        newView.webContents.loadURL(`file://${NEW_TAB_PATH}`).catch(() => {});
    }

    broadcastTabList(true);
    return { success: true };
}

/**
 * @deprecated Use setTabCookieGroup instead. Kept for backward compat.
 */
async function isolateTab(tabId) {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (!tab) return { success: false, error: 'Tab not found' };
    if (tab.isolated) return { success: false, error: 'Already isolated' };
    const newGroup = await db.createCookieGroupAsync(`Isolated ${Date.now()}`);
    if (!newGroup) return { success: false, error: 'Failed to create cookie group' };
    return setTabCookieGroup(tid, newGroup.id);
}

/**
 * Switches the active tab and brings its BrowserView to front.
 */
function switchTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return false;

    if (activeTabId && tabs.has(activeTabId)) {
        const prev = tabs.get(activeTabId);
        if (prev && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.removeBrowserView(prev.view);
        }
    }

    activeTabId = tabId;

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.addBrowserView(tab.view);
        resizeActiveView();
        mainWindow.webContents.send('url-updated', displayUrl(tab.url));
        mainWindow.webContents.send('set-loading-state', tab.view.webContents.isLoading());
    }

    broadcastTabList(true);
    onTabEventCb('tab-switched', tabId, { tabId, url: tab.url, title: tab.title });
    return true;
}

/**
 * Closes a tab.
 */
function closeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return false;

    if (_mitmTabUpstreamCleanup) {
        try { _mitmTabUpstreamCleanup(tabId); } catch (e) { console.error('[tab-manager] mitm tab cleanup:', e?.message || e); }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.removeBrowserView(tab.view);
    }

    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.destroy();
    tabs.delete(tabId);

    if (activeTabId === tabId) {
        activeTabId = null;
        const remaining = [...tabs.keys()];
        if (remaining.length) {
            switchTab(remaining[remaining.length - 1]);
        }
    }

    broadcastTabList(true);
    onTabEventCb('tab-closed', tabId, {});
    return true;
}

/**
 * Navigate the active (or specified) tab to a URL.
 */
function navigate(url, tabId) {
    const tid = tabId || activeTabId;
    if (!tid) return false;
    const tab = tabs.get(tid);
    if (!tab) return false;
    tab.view.webContents.loadURL(url).catch(() => {});
    return true;
}

/**
 * Returns serialisable list of all tabs (includes isolated flag).
 */
function getTabList() {
    return [...tabs.values()].map((t, i) => ({
        id:              t.id,
        num:             i + 1,
        title:           t.title,
        url:             displayUrl(t.url),
        faviconUrl:      t.faviconUrl || null,
        sessionId:       t.sessionId,
        proxyRules:      t.proxyRules,
        cookieGroupId:   t.cookieGroupId ?? 1,
        cupnetEnabled:   t.cupnetEnabled ?? false,
        proxyProfileId:  t.proxyProfileId ?? null,
        // Legacy compat
        isolated:        t.isolated || false,
        direct:          t.direct   || false,
        isActive:        t.id === activeTabId
    }));
}

function getActiveTabId() { return activeTabId; }
function getTab(tabId)    { return tabs.get(tabId) || null; }
function getActiveTab()   { return activeTabId ? tabs.get(activeTabId) || null : null; }

/** Для webRequest details.webContentsId → id вкладки (request-interceptor). */
function getTabIdByWebContentsId(webContentsId) {
    if (webContentsId == null || webContentsId === '') return null;
    const n = Number(webContentsId);
    for (const t of tabs.values()) {
        try {
            const wc = t.view?.webContents;
            if (wc && !wc.isDestroyed() && wc.id === n) return t.id;
        } catch (_) { /* ignore */ }
    }
    return null;
}

/**
 * Update proxy for a specific tab.
 */
async function setProxy(tabId, proxyRules) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.proxyRules = proxyRules;
    try {
        if (_trafficRouteMode === 'mitm' && _trustMitmCA) _trustMitmCA(tab.tabSession);
        await tab.tabSession.setProxy(getProxyOptsForTab(tab));
    } catch (e) {
        console.error('[tab-manager] setProxy error for', tabId, ':', e.message);
    }
}

/**
 * Update proxy for ALL tabs AND the shared session.
 * When proxyRules is null (Direct mode) traffic is still routed through the
 * local MITM proxy so that AzureTLS fingerprinting and logging remain active.
 */
async function setProxyAll(proxyRules, routeMode = _trafficRouteMode) {
    _trafficRouteMode = routeMode === 'browser_proxy' ? 'browser_proxy' : 'mitm';
    _upstreamProxyRules = proxyUrlToRules(proxyRules);
    for (const tab of tabs.values()) {
        if (!tab.cupnetEnabled) continue;
        try {
            if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
                const sess = tab.view.webContents.session;
                if (_trafficRouteMode === 'mitm' && _trustMitmCA) _trustMitmCA(sess);
                await sess.setProxy(getProxyOptsForTab(tab));
                if (_upstreamProxyRules) applyWebRtcPolicy(tab.view.webContents);
                else resetWebRtcPolicy(tab.view.webContents);
            } else {
                if (_trafficRouteMode === 'mitm' && _trustMitmCA) _trustMitmCA(tab.tabSession);
                await tab.tabSession.setProxy(getProxyOptsForTab(tab));
            }
        } catch (e) {
            console.error('[tab-manager] setProxy error for tab', tab.id, ':', e.message);
        }
    }
}

function resizeActiveView() {
    if (!mainWindow || mainWindow.isDestroyed() || !activeTabId) return;
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    const { width, height } = mainWindow.getContentBounds();
    const topY = TOOLBAR_HEIGHT + extraTopOffset;
    tab.view.setBounds({ x: 0, y: topY, width, height: Math.max(0, height - topY) });
    tab.view.setAutoResize({ width: true, height: true });
}

function relayout() {
    if (_relayoutTimer) return;
    _relayoutTimer = setTimeout(() => {
        _relayoutTimer = null;
        resizeActiveView();
    }, 16);
}

function _emitTabListUpdated(list) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.send('tab-list-updated', list); } catch (_) { /* ignore */ }
    for (const tab of tabs.values()) {
        try {
            const wc = tab.view?.webContents;
            if (wc && !wc.isDestroyed()) wc.send('tab-list-updated', list);
        } catch (_) { /* ignore */ }
    }
}

function broadcastTabList(immediate = false) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (immediate) {
        if (_broadcastTimer) { clearTimeout(_broadcastTimer); _broadcastTimer = null; }
        _emitTabListUpdated(getTabList());
        return;
    }
    // Debounce rapid bursts (title/favicon/url changes during page load)
    if (_broadcastTimer) return;
    _broadcastTimer = setTimeout(() => {
        _broadcastTimer = null;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        _emitTabListUpdated(getTabList());
    }, 80);
}

function destroyAll() {
    if (_relayoutTimer) { clearTimeout(_relayoutTimer); _relayoutTimer = null; }
    if (_broadcastTimer) { clearTimeout(_broadcastTimer); _broadcastTimer = null; }
    for (const tab of tabs.values()) {
        try {
            if (_mitmTabUpstreamCleanup) {
                try { _mitmTabUpstreamCleanup(tab.id); } catch (_) {}
            }
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(tab.view);
            if (!tab.view.webContents.isDestroyed()) tab.view.webContents.destroy();
        } catch {}
    }
    tabs.clear();
    activeTabId = null;
}

function getAllTabs() { return tabs.values(); }

// ── Bypass rules live update ──────────────────────────────────────────────────
function setBypassRules(bypassStr) {
    _currentBypassRules = bypassStr;
    for (const tab of tabs.values()) {
        if (!tab.cupnetEnabled) continue;
        try {
            if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
                tab.view.webContents.session.setProxy(getProxyOptsForTab(tab)).catch(() => {});
            } else {
                tab.tabSession.setProxy(getProxyOptsForTab(tab)).catch(() => {});
            }
        } catch {}
    }
}

// ── Traffic content filtering ─────────────────────────────────────────────────
const RESOURCE_TYPE_MAP = {
    blockImages:    'image',
    blockCSS:       'stylesheet',
    blockFonts:     'font',
    blockMedia:     'media',
    blockWebSocket: 'websocket',
};

const PLACEHOLDER_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect width='120' height='120' rx='4' fill='%23e5e7eb'/%3E%3Cline x1='35' y1='35' x2='85' y2='85' stroke='%239ca3af' stroke-width='3' stroke-linecap='round'/%3E%3Cline x1='85' y1='35' x2='35' y2='85' stroke='%239ca3af' stroke-width='3' stroke-linecap='round'/%3E%3Crect x='30' y='30' width='60' height='60' rx='6' fill='none' stroke='%239ca3af' stroke-width='2'/%3E%3C/svg%3E";

const SKIP_PROTOCOLS = ['file:', 'devtools:', 'chrome-devtools:', 'chrome-extension:', 'chrome:', 'data:'];

function matchesCaptchaWL(url, whitelist) {
    if (!whitelist || !whitelist.length) return false;
    let host;
    try { host = new URL(url).hostname; } catch { return false; }
    for (const p of whitelist) {
        if (p.startsWith('*.')) {
            const suffix = p.slice(1);
            if (host.endsWith(suffix) || host === suffix.slice(1)) return true;
        } else {
            if (host === p) return true;
        }
    }
    return false;
}

function applyTrafficFiltersToSession(sess) {
    // Глобальный onBeforeRequest на все http(s) — отдельный сигнал автоматизации (как <all_urls>).
    // CUPNET_DISABLE_TRAFFIC_WEBREQUEST=1 отключает блокировку картинок/CSS из traffic-фильтра, но сохраняет CF.
    if (process.env.CUPNET_DISABLE_TRAFFIC_WEBREQUEST === '1') {
        try { sess.webRequest.onBeforeRequest(null); } catch {}
        return;
    }
    if (!_trafficOpts.trafficEnabled) {
        try { sess.webRequest.onBeforeRequest(null); } catch {}
        return;
    }
    const blocked = [];
    for (const [key, resType] of Object.entries(RESOURCE_TYPE_MAP)) {
        if (_trafficOpts[key]) blocked.push(resType);
    }
    if (blocked.length === 0) {
        try { sess.webRequest.onBeforeRequest(null); } catch {}
        return;
    }
    const whitelist = _trafficOpts.captchaWhitelist || [];
    sess.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        if (blocked.includes(details.resourceType) && !matchesCaptchaWL(details.url, whitelist)) {
            if (details.resourceType === 'image') {
                return callback({ redirectURL: PLACEHOLDER_IMG });
            }
            return callback({ cancel: true });
        }
        callback({});
    });
}

function setTrafficOpts(opts) {
    _trafficOpts = opts;
    for (const tab of tabs.values()) {
        try {
            const sess = tab.view?.webContents && !tab.view.webContents.isDestroyed()
                ? tab.view.webContents.session
                : tab.tabSession;
            applyTrafficFiltersToSession(sess);
        } catch {}
    }
}

/**
 * @deprecated Use createTab({ cupnetEnabled: false }) instead.
 */
async function createDirectTab(initialUrl) {
    return createTab({ url: initialUrl || null, cupnetEnabled: false, cookieGroupId: 1 });
}

module.exports = {
    init, createTab, createDirectTab, isolateTab, switchTab, closeTab, navigate,
    getTabList, getActiveTabId, getTab, getActiveTab, getAllTabs, getTabIdByWebContentsId,
    setProxy, setProxyAll, relayout, destroyAll,
    broadcastTabList, setExtraTopOffset,
    setTrustMitmCA,
    setMitmTabUpstreamCleanup,
    reapplyMitmTrustToSharedSession,
    setPasteUnlock, getPasteUnlock,
    setBypassRules, setTrafficOpts,
    applyWebRtcPolicy, resetWebRtcPolicy,
    // New per-tab controls
    setTabCupNet, setTabProxy, setTabCookieGroup,
    partitionForGroup,
    SHARED_PARTITION,
};
