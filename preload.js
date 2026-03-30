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
    openSettingsTab:         ()        => ipcRenderer.invoke('open-settings-tab'),
    closeTab:                (id)      => ipcRenderer.invoke('close-tab', id),
    switchTab:               (id)      => ipcRenderer.invoke('switch-tab', id),
    getTabs:                 ()        => ipcRenderer.invoke('get-tabs'),
    // Per-tab controls
    setTabProxy:             (id, pid, ephemeralVars) => ipcRenderer.invoke('set-tab-proxy', id, pid, ephemeralVars),
    setTabCookieGroup:       (id, gid) => ipcRenderer.invoke('set-tab-cookie-group', id, gid),
    // Cookie groups
    getCookieGroups:         ()        => ipcRenderer.invoke('get-cookie-groups'),
    createCookieGroup:       (name)    => ipcRenderer.invoke('create-cookie-group', name),
    copyCookieGroup:         (fid, n)  => ipcRenderer.invoke('copy-cookie-group', fid, n),
    renameCookieGroup:       (id, n)   => ipcRenderer.invoke('rename-cookie-group', id, n),
    deleteCookieGroup:       (id)      => ipcRenderer.invoke('delete-cookie-group', id),
    onTabListUpdated:        (cb)      => sub('tab-list-updated', cb),
    onCookieGroupsUpdated:   (cb)      => sub('cookie-groups-updated', cb),
    onTabUrlChanged:         (cb)      => sub('tab-url-changed', cb),
    onTabTitleChanged:       (cb)      => sub('tab-title-changed', cb),
    onFocusUrlBar:           (cb)      => sub('focus-url-bar', cb),
    onSwitchTabRel:          (cb)      => sub('switch-tab-rel', cb),
    onTakeScreenshotNow:    (cb)      => sub('take-screenshot-now', cb),

    // ── Log viewer / DB data ───────────────────────────────────────────────
    openLogViewer:           ()        => ipcRenderer.invoke('open-log-viewer'),
    openLogViewerWithUrl:    (url)     => ipcRenderer.invoke('open-log-viewer-with-url', url),
    getExistingLogs:         ()        => ipcRenderer.invoke('get-existing-logs'),
    getWsEvents:             (payload) => ipcRenderer.invoke('get-ws-events', payload),
    clearLogs:               ()        => ipcRenderer.invoke('clear-logs'),
    openJsonlFile:           ()        => ipcRenderer.invoke('open-jsonl-file'),
    onNewLogEntry:           (cb)      => sub('new-log-entry', cb),
    onNewLogEntryBatch:      (cb)      => sub('new-log-entry-batch', cb),
    onWsHandshakeMessageCount: (cb)   => sub('ws-handshake-message-count', cb),
    onRuleHighlight:         (cb)      => sub('rule-highlight', cb),
    onFocusRequestUrl:       (cb)      => sub('focus-request-url', cb),
    onInterceptRuleMatched:  (cb)      => sub('intercept-rule-matched', cb),
    onInterceptRuleMatchedBatch: (cb)  => sub('intercept-rule-matched-batch', cb),

    getDbRequests:           (f, l, o) => ipcRenderer.invoke('get-db-requests', f, l, o),
    countDbRequests:         (f)       => ipcRenderer.invoke('count-db-requests', f),
    getRequestDetail:        (id)      => ipcRenderer.invoke('get-request-detail', id),
    setRequestAnnotation:    (id, d)   => ipcRenderer.invoke('set-request-annotation', id, d),
    getScreenshotData:       (id)      => ipcRenderer.invoke('get-screenshot-data', id),
    ftsSearch:               (q, sid)  => ipcRenderer.invoke('fts-search', q, sid),
    getSessions:             ()        => ipcRenderer.invoke('get-sessions'),
    getSessionsWithStats:    ()        => ipcRenderer.invoke('get-sessions-with-stats'),
    getCurrentSessionId:     ()        => ipcRenderer.invoke('get-current-session-id'),
    renameSession:           (id, n)   => ipcRenderer.invoke('rename-session', id, n),
    deleteSession:           (id)      => ipcRenderer.invoke('delete-session', id),
    deleteUnnamedSessions:   ()        => ipcRenderer.invoke('delete-unnamed-sessions'),
    createSessionFromRequestIds: (ids, name) => ipcRenderer.invoke('create-session-from-request-ids', ids, name),
    openSessionInNewWindow:  (id)      => ipcRenderer.invoke('open-session-in-new-window', id),
    getInitialSessionId:     ()        => ipcRenderer.invoke('get-initial-session-id'),

    // ── Trace mode ────────────────────────────────────────────────────────────
    getTraceMode:            ()       => ipcRenderer.invoke('get-trace-mode'),
    setTraceMode:            (on)     => ipcRenderer.invoke('set-trace-mode', on),
    getTracePath:            ()       => ipcRenderer.invoke('get-trace-path'),
    openTraceFile:           ()       => ipcRenderer.invoke('open-trace-file'),
    openTraceViewer:         ()       => ipcRenderer.invoke('open-trace-viewer'),
    hasTraceData:            ()       => ipcRenderer.invoke('has-trace-data'),
    getTraceEntries:         (l, o)   => ipcRenderer.invoke('get-trace-entries', l, o),
    getTraceEntry:           (id)     => ipcRenderer.invoke('get-trace-entry', id),
    countTraceEntries:       ()       => ipcRenderer.invoke('count-trace-entries'),
    clearTraceEntries:       ()       => ipcRenderer.invoke('clear-trace-entries'),
    onNewTraceEntry:         (cb)     => sub('new-trace-entry', cb),
    onSysLogEntry:           (cb)     => sub('sys-log-entry', cb),

    // ── Logging toggle ─────────────────────────────────────────────────────────
    getLogStatus:            ()        => ipcRenderer.invoke('get-log-status'),
    toggleLoggingStart:      (hint)    => ipcRenderer.invoke('toggle-logging-start', hint),
    confirmLoggingStart:     (d)       => ipcRenderer.invoke('confirm-logging-start', d),
    toggleLoggingStop:       ()        => ipcRenderer.invoke('toggle-logging-stop'),
    onModalLoggingInit:      (cb)      => sub('modal-logging-init', cb),

    // ── HAR & Replay ──────────────────────────────────────────────────────
    exportHar:               (sid)     => ipcRenderer.invoke('export-har', sid),
    exportBundle:            (payload) => ipcRenderer.invoke('export-bundle', payload),
    importBundle:            ()        => ipcRenderer.invoke('import-bundle'),
    listSessionOrigins:      (sid)     => ipcRenderer.invoke('list-session-origins', sid),
    exportSiteZip:           (payload) => ipcRenderer.invoke('export-site-zip', payload),
    diffRequests:            (a, b)    => ipcRenderer.invoke('diff-requests', a, b),
    openCompareViewer:       ()        => ipcRenderer.invoke('open-compare-viewer'),
    getCompare:              ()        => ipcRenderer.invoke('compare-get'),
    setCompareSlot:          (side, requestId) => ipcRenderer.invoke('compare-set-slot', side, requestId),
    clearCompareSlot:        (side)    => ipcRenderer.invoke('compare-clear-slot', side),
    runCompare:              (options) => ipcRenderer.invoke('compare-run', options || {}),
    onCompareUpdated:        (cb)      => sub('compare-updated', cb),
    formatJsonDiffHtml:      (leftText, rightText) => ipcRenderer.invoke('jsondiff-format-html', leftText, rightText),
    replayRequest:           (id)      => ipcRenderer.invoke('replay-request', id),

    // ── Rules ──────────────────────────────────────────────────────────────
    getRules:                ()        => ipcRenderer.invoke('get-rules'),
    saveRule:                (r)       => ipcRenderer.invoke('save-rule', r),
    deleteRule:              (id)      => ipcRenderer.invoke('delete-rule', id),
    toggleRule:              (id, en)  => ipcRenderer.invoke('toggle-rule', id, en),
    openRulesWindow:         ()        => ipcRenderer.invoke('open-rules-window'),
    openRulesWithMock:       (data)    => ipcRenderer.invoke('open-rules-window-with-mock', data),
    onPrefillInterceptRule:  (cb)      => sub('prefill-intercept-rule', cb),

    // ── Intercept rules ────────────────────────────────────────────────────
    getInterceptRules:       ()        => ipcRenderer.invoke('get-intercept-rules'),
    saveInterceptRule:       (r)       => ipcRenderer.invoke('save-intercept-rule', r),
    deleteInterceptRule:     (id)      => ipcRenderer.invoke('delete-intercept-rule', id),
    testInterceptNotification: ()     => ipcRenderer.invoke('test-intercept-notification'),
    testInterceptScript:       (p)    => ipcRenderer.invoke('test-intercept-script', p || {}),
    selectMockFile:            ()     => ipcRenderer.invoke('select-mock-file'),

    // ── Proxy profiles ─────────────────────────────────────────────────────
    getProxyProfiles:        ()        => ipcRenderer.invoke('get-proxy-profiles'),
    saveProxyProfile:        (n, u, c) => ipcRenderer.invoke('save-proxy-profile', n, u, c),
    deleteProxyProfile:      (id)      => ipcRenderer.invoke('delete-proxy-profile', id),
    testProxyProfile:        (id)      => ipcRenderer.invoke('test-proxy-profile', id),
    getProxyProfileUrl:      (id)      => ipcRenderer.invoke('get-proxy-profile-url', id),

    // ── Screenshots ────────────────────────────────────────────────────────
    takeScreenshot:          (reason, meta) => ipcRenderer.invoke('take-screenshot', reason, meta),
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

    // ── DNS Manager ──────────────────────────────────────────────────────────
    openDnsManager:          ()        => ipcRenderer.invoke('open-dns-manager'),
    getDnsOverrides:         ()        => ipcRenderer.invoke('dns-overrides-list'),
    saveDnsOverride:         (rule)    => ipcRenderer.invoke('dns-overrides-save', rule),
    deleteDnsOverride:       (id)      => ipcRenderer.invoke('dns-overrides-delete', id),
    toggleDnsOverride:       (id, en)  => ipcRenderer.invoke('dns-overrides-toggle', id, en),
    onDnsOverridesUpdated:   (cb)      => sub('dns-overrides-updated', cb),
    onDnsRuleMatched:        (cb)      => sub('dns-rule-matched', cb),
    onDnsRuleMatchedBatch:   (cb)      => sub('dns-rule-matched-batch', cb),
    resetToolbarActivityBadge: (tool) => ipcRenderer.send('reset-toolbar-activity-badge', tool),
    onToolbarActivityBadgeReset: (cb) => sub('toolbar-activity-badge-reset', cb),

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
    getTrackingSettings:     ()        => ipcRenderer.invoke('get-tracking-settings'),
    saveTrackingSettings:    (cfg)     => ipcRenderer.invoke('save-tracking-settings', cfg),
    saveFilterPatterns:      (pats)    => ipcRenderer.invoke('save-filter-patterns', pats),
    saveBypassDomains:       (doms)    => ipcRenderer.invoke('save-bypass-domains', doms),
    getSysLog:               (lvl, lim) => ipcRenderer.invoke('get-sys-log', lvl, lim),
    saveTrafficOpts:         (opts)    => ipcRenderer.invoke('save-traffic-opts', opts),
    getTrafficOpts:          ()        => ipcRenderer.invoke('get-traffic-opts'),
    setPasteUnlock:          (en)      => ipcRenderer.invoke('set-paste-unlock', en),
    quickConnectProfile:     (id)      => ipcRenderer.invoke('quick-connect-profile', id),
    onInitSettings:          (cb)      => sub('init-settings', cb),
    getAppMetrics:           ()        => ipcRenderer.invoke('get-app-metrics'),
    enumerateMediaDevices:   ()        => ipcRenderer.invoke('enumerate-media-devices'),
    saveDevicePermissions:   (cfg)     => ipcRenderer.invoke('save-device-permissions', cfg),
    onRuleNotification:      (cb)      => sub('rule-notification', cb),

    // ── Direct IP check ────────────────────────────────────────────────────────
    getDirectIp:             ()        => ipcRenderer.invoke('get-direct-ip'),

    // ── Console Viewer ─────────────────────────────────────────────────────────
    openConsoleViewer:       ()        => ipcRenderer.invoke('open-console-viewer'),
    getConsoleHistory:       ()        => ipcRenderer.invoke('get-console-history'),
    getDebugMitmLevel:       ()        => ipcRenderer.invoke('get-debug-mitm-level'),
    setDebugMitmLevel:       (lvl)     => ipcRenderer.invoke('set-debug-mitm-level', lvl),
    onConsoleLog:            (cb)      => sub('console-log', cb),
    saveConsoleLog:          (content) => ipcRenderer.invoke('save-console-log', content),

    // ── Page Analyzer ────────────────────────────────────────────────────────
    openPageAnalyzer:        ()        => ipcRenderer.invoke('open-page-analyzer'),
    analyzePageForms:        (tabId)   => ipcRenderer.invoke('analyze-page-forms', tabId),
    analyzePageCaptcha:      (tabId)   => ipcRenderer.invoke('analyze-page-captcha', tabId),
    getCapmonsterSettings:   ()        => ipcRenderer.invoke('get-capmonster-settings'),
    saveCapmonsterSettings:  (cfg)     => ipcRenderer.invoke('save-capmonster-settings', cfg),
    solveTurnstileCaptcha:   (tabId, captcha, options) => ipcRenderer.invoke('solve-turnstile-captcha', tabId, captcha, options),
    injectTurnstileToken:    (tabId, payload) => ipcRenderer.invoke('inject-turnstile-token', tabId, payload),
    analyzePageMeta:         (tabId)   => ipcRenderer.invoke('analyze-page-meta', tabId),
    analyzePageStorage:      (tabId)   => ipcRenderer.invoke('analyze-page-storage', tabId),
    applyPageStorage:        (tabId, payload) => ipcRenderer.invoke('apply-page-storage', tabId, payload),
    analyzePageEndpoints:    (tabId)   => ipcRenderer.invoke('analyze-page-endpoints', tabId),
    pageAnalyzerAction:      (tabId, a) => ipcRenderer.invoke('page-analyzer-action', tabId, a),
    onAnalyzerTabsList:      (cb)      => sub('analyzer-tabs-list', cb),
    onAnalyzerTabsUpdated:   (cb)      => sub('analyzer-tabs-updated', cb),

    // ── API Scout ─────────────────────────────────────────────────────────────
    openIvacScout:           ()        => ipcRenderer.invoke('open-ivac-scout'),
    getIvacScoutContext:     ()        => ipcRenderer.invoke('get-ivac-scout-context'),
    runIvacScout:            (opts)    => ipcRenderer.invoke('run-ivac-scout', opts),
    stopIvacScout:           ()        => ipcRenderer.invoke('stop-ivac-scout'),
    openIvacDumpFolder:      ()        => ipcRenderer.invoke('open-ivac-dump-folder'),
    onIvacScoutLog:          (cb)      => sub('ivac-scout-log', cb),
    onIvacScoutDone:         (cb)      => sub('ivac-scout-done', cb),
    onIvacScoutState:        (cb)      => sub('ivac-scout-state', cb),

    // ── External Proxy Ports ────────────────────────────────────────────────────
    extProxyList:            ()        => ipcRenderer.invoke('ext-proxy:list'),
    extProxyCreate:          (opts)    => ipcRenderer.invoke('ext-proxy:create', opts),
    extProxyStart:           (port)    => ipcRenderer.invoke('ext-proxy:start', port),
    extProxyStop:            (port)    => ipcRenderer.invoke('ext-proxy:stop', port),
    extProxyDelete:          (port)    => ipcRenderer.invoke('ext-proxy:delete', port),
    extProxyResetSession:    (port)    => ipcRenderer.invoke('ext-proxy:reset-session', port),
    extProxyGetLocalIp:      ()        => ipcRenderer.invoke('ext-proxy:get-local-ip'),

    // ── Proxy Manager ──────────────────────────────────────────────────────────
    openProxyManager:        ()        => ipcRenderer.invoke('open-proxy-manager'),
    checkIpGeo:              (tabId)   => ipcRenderer.invoke('check-ip-geo', tabId),
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
