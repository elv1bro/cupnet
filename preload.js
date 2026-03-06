'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Helper: registers an ipcRenderer listener and returns an unsubscribe function.
 * Usage:
 *   const unsub = api.onTabListUpdated(renderTabs);
 *   // later:
 *   unsub();
 */
function sub(channel, cb) {
    const handler = (_, ...args) => cb(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {

    // ── Proxy selector / settings ──────────────────────────────────────────
    selectProxy:             (data)    => ipcRenderer.invoke('proxy-selected', data),
    onLoadProxies:           (cb)      => sub('load-proxies', cb),
    onLoadProxyProfiles:     (cb)      => sub('load-proxy-profiles', cb),
    onSetInitialLogPath:     (cb)      => sub('set-initial-log-path', cb),
    onSetFilterPatterns:     (cb)      => sub('set-filter-patterns', cb),
    onSetAutoScreenshotState:(cb)      => sub('set-auto-screenshot-state', cb),
    onSetAppInfo:            (cb)      => sub('set-app-info', cb),
    selectLogDirectory:      ()        => ipcRenderer.invoke('select-log-directory'),
    onLogDirectorySelected:  (cb)      => sub('log-directory-selected', cb),
    openLogDirectory:        (p)       => ipcRenderer.invoke('open-log-directory', p),

    // ── Navigation ─────────────────────────────────────────────────────────
    navigateTo:              (url)     => ipcRenderer.send('navigate-to', url),
    navBack:                 ()        => ipcRenderer.send('nav-back'),
    navForward:              ()        => ipcRenderer.send('nav-forward'),
    navReload:               ()        => ipcRenderer.send('nav-reload'),
    navHome:                 ()        => ipcRenderer.send('nav-home'),
    onURLUpdate:             (cb)      => sub('url-updated', cb),
    onTabWillNavigate:       (cb)      => sub('tab-will-navigate', cb),
    onSetLoadingState:       (cb)      => sub('set-loading-state', cb),
    onUpdateLogStatus:       (cb)      => sub('update-log-status', cb),

    // ── Tab management ─────────────────────────────────────────────────────
    newTab:                  (proxy)   => ipcRenderer.invoke('new-tab', proxy),
    newIsolatedTab:          ()        => ipcRenderer.invoke('new-isolated-tab'),
    closeTab:                (id)      => ipcRenderer.invoke('close-tab', id),
    switchTab:               (id)      => ipcRenderer.invoke('switch-tab', id),
    getTabs:                 ()        => ipcRenderer.invoke('get-tabs'),
    onTabListUpdated:        (cb)      => sub('tab-list-updated', cb),
    onTabUrlChanged:         (cb)      => sub('tab-url-changed', cb),
    onTabTitleChanged:       (cb)      => sub('tab-title-changed', cb),

    // ── Log viewer / DB data ───────────────────────────────────────────────
    openLogViewer:           ()        => ipcRenderer.invoke('open-log-viewer'),
    getExistingLogs:         ()        => ipcRenderer.invoke('get-existing-logs'),
    clearLogs:               ()        => ipcRenderer.invoke('clear-logs'),
    openJsonlFile:           ()        => ipcRenderer.invoke('open-jsonl-file'),
    onNewLogEntry:           (cb)      => sub('new-log-entry', cb),
    onRuleHighlight:         (cb)      => sub('rule-highlight', cb),

    getDbRequests:           (f, l, o) => ipcRenderer.invoke('get-db-requests', f, l, o),
    countDbRequests:         (f)       => ipcRenderer.invoke('count-db-requests', f),
    getRequestDetail:        (id)      => ipcRenderer.invoke('get-request-detail', id),
    getScreenshotData:       (id)      => ipcRenderer.invoke('get-screenshot-data', id),
    ftsSearch:               (q, sid)  => ipcRenderer.invoke('fts-search', q, sid),
    getSessions:             ()        => ipcRenderer.invoke('get-sessions'),
    getSessionsWithStats:    ()        => ipcRenderer.invoke('get-sessions-with-stats'),
    getCurrentSessionId:     ()        => ipcRenderer.invoke('get-current-session-id'),
    renameSession:           (id, n)   => ipcRenderer.invoke('rename-session', id, n),
    deleteSession:           (id)      => ipcRenderer.invoke('delete-session', id),
    openSessionInNewWindow:  (id)      => ipcRenderer.invoke('open-session-in-new-window', id),
    getInitialSessionId:     ()        => ipcRenderer.invoke('get-initial-session-id'),

    // ── Logging toggle ─────────────────────────────────────────────────────────
    toggleLoggingStart:      (hint)    => ipcRenderer.invoke('toggle-logging-start', hint),
    confirmLoggingStart:     (d)       => ipcRenderer.invoke('confirm-logging-start', d),
    toggleLoggingStop:       ()        => ipcRenderer.invoke('toggle-logging-stop'),
    onModalLoggingInit:      (cb)      => sub('modal-logging-init', cb),

    // ── HAR & Replay ──────────────────────────────────────────────────────
    exportHar:               (sid)     => ipcRenderer.invoke('export-har', sid),
    replayRequest:           (id)      => ipcRenderer.invoke('replay-request', id),

    // ── Rules ──────────────────────────────────────────────────────────────
    getRules:                ()        => ipcRenderer.invoke('get-rules'),
    saveRule:                (r)       => ipcRenderer.invoke('save-rule', r),
    deleteRule:              (id)      => ipcRenderer.invoke('delete-rule', id),
    toggleRule:              (id, en)  => ipcRenderer.invoke('toggle-rule', id, en),
    openRulesWindow:         ()        => ipcRenderer.invoke('open-rules-window'),

    // ── Intercept rules ────────────────────────────────────────────────────
    getInterceptRules:       ()        => ipcRenderer.invoke('get-intercept-rules'),
    saveInterceptRule:       (r)       => ipcRenderer.invoke('save-intercept-rule', r),
    deleteInterceptRule:     (id)      => ipcRenderer.invoke('delete-intercept-rule', id),

    // ── Proxy profiles ─────────────────────────────────────────────────────
    getProxyProfiles:        ()        => ipcRenderer.invoke('get-proxy-profiles'),
    saveProxyProfile:        (n, u, c) => ipcRenderer.invoke('save-proxy-profile', n, u, c),
    deleteProxyProfile:      (id)      => ipcRenderer.invoke('delete-proxy-profile', id),
    testProxyProfile:        (id)      => ipcRenderer.invoke('test-proxy-profile', id),
    getProxyProfileUrl:      (id)      => ipcRenderer.invoke('get-proxy-profile-url', id),

    // ── Screenshots ────────────────────────────────────────────────────────
    takeScreenshot:          ()        => ipcRenderer.invoke('take-screenshot'),
    saveScreenshot:          (d, f)    => ipcRenderer.invoke('save-screenshot', d, f),
    copyScreenshot:          (d)       => ipcRenderer.invoke('copy-screenshot', d),
    onScreenshotTaken:       (cb)      => sub('screenshot-taken', cb),

    // ── Proxy (quick change) ───────────────────────────────────────────────
    applyQuickProxyChange:   (url)     => ipcRenderer.invoke('apply-quick-proxy-change', url),

    // ── Activity ───────────────────────────────────────────────────────────
    reportMouseActivity:     ()        => ipcRenderer.send('report-mouse-activity'),

    // ── DevTools ───────────────────────────────────────────────────────────
    openDevTools:            ()        => ipcRenderer.invoke('open-devtools'),

    // ── Homepage ───────────────────────────────────────────────────────────
    getHomepage:             ()        => ipcRenderer.invoke('get-homepage'),
    setHomepage:             (url)     => ipcRenderer.invoke('set-homepage', url),

    // ── Cookie Manager ─────────────────────────────────────────────────────
    getCookies:              (tid, f)  => ipcRenderer.invoke('get-cookies', tid, f),
    setCookie:               (tid, d)  => ipcRenderer.invoke('set-cookie', tid, d),
    removeCookie:            (tid,u,n) => ipcRenderer.invoke('remove-cookie', tid, u, n),
    clearCookies:            (tid, dm) => ipcRenderer.invoke('clear-cookies', tid, dm),
    shareCookies:            (f,t,dm)  => ipcRenderer.invoke('share-cookies', f, t, dm),
    openCookieManager:       (tid)     => ipcRenderer.invoke('open-cookie-manager', tid),
    onSetActiveCookieTab:    (cb)      => sub('set-active-tab', cb),
    onCookieTabsList:        (cb)      => sub('tabs-list', cb),
    onTabsUpdated:           (cb)      => sub('tabs-updated', cb),

    // ── Request Editor ──────────────────────────────────────────────────────────
    openRequestEditor:       (id)      => ipcRenderer.invoke('open-request-editor', id),
    executeRequest:          (data)    => ipcRenderer.invoke('execute-request', data),
    onRequestEditorInit:     (cb)      => sub('request-editor-init', cb),

    // ── TLS Fingerprint (AzureTLS) ─────────────────────────────────────────────
    getTlsProfile:           ()        => ipcRenderer.invoke('get-tls-profile'),
    setTlsProfile:           (profile) => ipcRenderer.invoke('set-tls-profile', profile),
    onTlsProfileChanged:     (cb)      => sub('tls-profile-changed', cb),

    // ── MITM / AzureTLS stats ──────────────────────────────────────────────────
    getMitmStats:            ()        => ipcRenderer.invoke('mitm-get-stats'),
    onMitmStatsUpdate:       (cb)      => sub('mitm-stats-update', cb),

    // ── Inline settings (browser toolbar) ──────────────────────────────────────
    setToolbarHeight:        (px)      => ipcRenderer.invoke('set-toolbar-height', px),
    getSettingsAll:          ()        => ipcRenderer.invoke('get-settings-all'),
    setAutoScreenshot:       (en)      => ipcRenderer.invoke('set-auto-screenshot', en),
    saveFilterPatterns:      (pats)    => ipcRenderer.invoke('save-filter-patterns', pats),
    setPasteUnlock:          (en)      => ipcRenderer.invoke('set-paste-unlock', en),
    quickConnectProfile:     (id)      => ipcRenderer.invoke('quick-connect-profile', id),
    onInitSettings:          (cb)      => sub('init-settings', cb),
    getAppMetrics:           ()        => ipcRenderer.invoke('get-app-metrics'),
    onRuleNotification:      (cb)      => sub('rule-notification', cb),

    // ── Proxy Manager ──────────────────────────────────────────────────────────
    openProxyManager:        ()        => ipcRenderer.invoke('open-proxy-manager'),
    checkIpGeo:              ()        => ipcRenderer.invoke('check-ip-geo'),
    getCurrentProxy:         ()        => ipcRenderer.invoke('get-current-proxy'),
    connectProxyTemplate:    (id, ev)  => ipcRenderer.invoke('connect-proxy-template', id, ev),
    disconnectProxy:         ()        => ipcRenderer.invoke('disconnect-proxy'),
    connectDirect:           (profile) => ipcRenderer.invoke('connect-direct', profile),
    saveProxyProfileFull:    (p)       => ipcRenderer.invoke('save-proxy-profile-full', p),
    testProxyTemplate:       (id, ev)  => ipcRenderer.invoke('test-proxy-template', id, ev),
    deleteProxyProfileById:  (id)      => ipcRenderer.invoke('delete-proxy-profile', id),
    onProxyProfilesList:     (cb)      => sub('proxy-profiles-list', cb),
    onProxyStatusChanged:    (cb)      => sub('proxy-status-changed', cb),
});
