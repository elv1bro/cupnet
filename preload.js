'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let _requestEditorCmCache = null;
function getRequestEditorCodeMirrorModules() {
    if (_requestEditorCmCache) return _requestEditorCmCache;
    const codemirror = require('codemirror');
    const { json } = require('@codemirror/lang-json');
    const { xml } = require('@codemirror/lang-xml');
    const { html } = require('@codemirror/lang-html');
    const { oneDark } = require('@codemirror/theme-one-dark');
    const { EditorState, Compartment } = require('@codemirror/state');
    const { searchKeymap, openSearchPanel } = require('@codemirror/search');
    _requestEditorCmCache = {
        ...codemirror,
        json, xml, html, oneDark, EditorState, Compartment, searchKeymap, openSearchPanel,
    };
    return _requestEditorCmCache;
}

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
    navStop:                 ()        => ipcRenderer.send('nav-stop'),
    navHome:                 ()        => ipcRenderer.send('nav-home'),
    onURLUpdate:             (cb)      => sub('url-updated', cb),
    onTabWillNavigate:       (cb)      => sub('tab-will-navigate', cb),
    onSetLoadingState:       (cb)      => sub('set-loading-state', cb),
    onTabLoadError:          (cb)      => sub('tab-load-error', cb),
    onPageGatewayError:      (cb)      => sub('page-gateway-error', cb),
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
    openLogViewerFocusRequest: (id)    => ipcRenderer.invoke('open-log-viewer-focus-request', id),
    getExistingLogs:         ()        => ipcRenderer.invoke('get-existing-logs'),
    getBrowserEvents:        (opts)    => ipcRenderer.invoke('get-browser-events', opts),
    getWsEvents:             (payload) => ipcRenderer.invoke('get-ws-events', payload),
    clearLogs:               ()        => ipcRenderer.invoke('clear-logs'),
    openJsonlFile:           ()        => ipcRenderer.invoke('open-jsonl-file'),
    onNewLogEntry:           (cb)      => sub('new-log-entry', cb),
    onNewLogEntryBatch:      (cb)      => sub('new-log-entry-batch', cb),
    onWsHandshakeMessageCount: (cb)   => sub('ws-handshake-message-count', cb),
    onFocusRequestUrl:       (cb)      => sub('focus-request-url', cb),
    onFocusRequestId:        (cb)      => sub('focus-request-id', cb),
    onInterceptRuleMatched:  (cb)      => sub('intercept-rule-matched', cb),
    onInterceptRuleMatchedBatch: (cb)  => sub('intercept-rule-matched-batch', cb),

    getDbRequests:           (f, l, o) => ipcRenderer.invoke('get-db-requests', f, l, o),
    countDbRequests:         (f)       => ipcRenderer.invoke('count-db-requests', f),
    getRequestDetail:        (id)      => ipcRenderer.invoke('get-request-detail', id),
    setRequestAnnotation:    (id, d)   => ipcRenderer.invoke('set-request-annotation', id, d),
    getScreenshotData:       (id)      => ipcRenderer.invoke('get-screenshot-data', id),
    ftsSearch:               (q, sid)  => ipcRenderer.invoke('fts-search', q, sid),
    getOmniboxTopHosts:      (limit)   => ipcRenderer.invoke('get-omnibox-top-hosts', limit),
    getOmniboxSuggestions:   (q, lim)   => ipcRenderer.invoke('get-omnibox-suggestions', q, lim),
    recordOmniboxVisit:      (payload) => ipcRenderer.invoke('record-omnibox-visit', payload),
    // ── Omnibox + browsing history (omnibox-history-ipc.js) ───────────────────
    omniboxSuggest:          (q, lim)  => ipcRenderer.invoke('omnibox-suggest', q, lim),
    omniboxZeroSuggest:      ()        => ipcRenderer.invoke('omnibox-zero-suggest'),
    omniboxNavigate:         (payload) => ipcRenderer.invoke('omnibox-navigate', payload),
    omniboxDeleteUrl:        (url)     => ipcRenderer.invoke('omnibox-delete-url', url),
    urlBarContextMenu:       (info)    => ipcRenderer.send('url-bar-context-menu', info),
    navHistoryMenu:          (info)    => ipcRenderer.send('nav-history-menu', info),
    onOmniboxClose:          (cb)      => sub('omnibox-close', cb),
    getSearchEngine:         ()        => ipcRenderer.invoke('get-search-engine'),
    openHistoryWindow:       ()        => ipcRenderer.invoke('open-history-window'),
    historyList:             (opts)    => ipcRenderer.invoke('history-list', opts),
    historyCount:            (opts)    => ipcRenderer.invoke('history-count', opts),
    historyStats:            ()        => ipcRenderer.invoke('history-stats'),
    historyDeleteUrl:        (url)     => ipcRenderer.invoke('history-delete-url', url),
    historyDeleteVisit:      (id)      => ipcRenderer.invoke('history-delete-visit', id),
    historyClear:            (range)   => ipcRenderer.invoke('history-clear', range),
    historyGetSettings:      ()        => ipcRenderer.invoke('history-get-settings'),
    historySetSettings:      (patch)   => ipcRenderer.invoke('history-set-settings', patch),
    historyRecentlyClosed:   ()        => ipcRenderer.invoke('history-recently-closed'),
    historyReopen:           (id)      => ipcRenderer.invoke('history-reopen', id),
    historyOpenUrl:          (url, disposition) => ipcRenderer.invoke('history-open-url', url, disposition),
    onHistoryChanged:        (cb)      => sub('history-changed', cb),
    onHistoryWindowInit:     (cb)      => sub('history-window-init', cb),
    getTabTlsInfo:           (tabId)   => ipcRenderer.invoke('get-tab-tls-info', tabId),
    toggleSiteInfoPopover:   (tabId, hint) => ipcRenderer.invoke('toggle-site-info-popover', tabId, hint),
    toggleCorsBypass:        ()        => ipcRenderer.invoke('toggle-cors-bypass'),
    getCorsBypassStatus:     ()        => ipcRenderer.invoke('get-cors-bypass-status'),
    onCorsBypassStatus:      (cb)      => sub('cors-bypass-status', cb),
    saveSearchEngineSettings: (opts)  => ipcRenderer.invoke('save-search-engine-settings', opts),
    getSessions:             ()        => ipcRenderer.invoke('get-sessions'),
    getSessionsWithStats:    ()        => ipcRenderer.invoke('get-sessions-with-stats'),
    getCurrentSessionId:     ()        => ipcRenderer.invoke('get-current-session-id'),
    renameSession:           (id, n)   => ipcRenderer.invoke('rename-session', id, n),
    deleteSession:           (id)      => ipcRenderer.invoke('delete-session', id),
    deleteUnnamedSessions:   ()        => ipcRenderer.invoke('delete-unnamed-sessions'),
    createSessionFromRequestIds: (ids, name) => ipcRenderer.invoke('create-session-from-request-ids', ids, name),
    openSessionInNewWindow:  (id)      => ipcRenderer.invoke('open-session-in-new-window', id),
    getInitialSessionId:     ()        => ipcRenderer.invoke('get-initial-session-id'),

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
    listSiteExportPaths:     (payload) => ipcRenderer.invoke('list-site-export-paths', payload),
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
    testInterceptUrlMatch:     (pattern, url) => ipcRenderer.invoke('test-intercept-url-match', pattern, url),
    exportInterceptRules:      ()     => ipcRenderer.invoke('export-intercept-rules'),
    importInterceptRules:      ()     => ipcRenderer.invoke('import-intercept-rules'),
    reorderInterceptRules:     (pairs) => ipcRenderer.invoke('reorder-intercept-rules', pairs),
    getInterceptRuleHistory:   (id, lim) => ipcRenderer.invoke('get-intercept-rule-history', id, lim),
    formatInterceptRuleDiffHtml: (l, r) => ipcRenderer.invoke('format-intercept-rule-diff-html', l, r),
    exportRulesActivityLog:   (payload) => ipcRenderer.invoke('export-rules-activity-log', payload || {}),
    getMonacoVsPath:          ()        => ipcRenderer.invoke('get-monaco-vs-path'),

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

    // ── Window switcher overlay ───────────────────────────────────────────────
    getOpenWindows:          (opts)    => ipcRenderer.invoke('get-open-windows', opts),
    focusWindowById:         (id)      => ipcRenderer.invoke('focus-window-by-id', id),
    setWindowSwitcherOverlayVisible: (visible) => ipcRenderer.invoke('set-window-switcher-overlay-visible', visible),
    showOmniboxOverlay:      ()        => ipcRenderer.invoke('omnibox-overlay-show'),
    hideOmniboxOverlay:      ()        => ipcRenderer.invoke('omnibox-overlay-hide'),
    updateOmniboxOverlay:    (payload) => ipcRenderer.invoke('omnibox-overlay-update', payload),
    onOmniboxOverlaySelect:  (cb)      => sub('omnibox-overlay-select', cb),
    onOmniboxOverlayDismiss: (cb)      => sub('omnibox-overlay-dismiss', cb),
    onOmniboxOverlayDelete:  (cb)      => sub('omnibox-overlay-delete', cb),
    onForceCloseOmnibox:     (cb)      => sub('force-close-omnibox', cb),
    onBrowserSettingsUpdated:(cb)      => sub('browser-settings-updated', cb),
    onToggleWindowSwitcher:  (cb)      => sub('toggle-window-switcher', cb),
    onToggleCommandPalette:  (cb)      => sub('toggle-command-palette', cb),

    // ── Homepage ───────────────────────────────────────────────────────────
    getHomepage:             ()        => ipcRenderer.invoke('get-homepage'),
    setHomepage:             (url)     => ipcRenderer.invoke('set-homepage', url),

    // ── Cookie Manager ─────────────────────────────────────────────────────
    getCookies:              (tid, f)  => ipcRenderer.invoke('get-cookies', tid, f),
    setCookie:               (tid, d)  => ipcRenderer.invoke('set-cookie', tid, d),
    removeCookie:            (tid,u,n) => ipcRenderer.invoke('remove-cookie', tid, u, n),
    clearCookies:            (tid, dm) => ipcRenderer.invoke('clear-cookies', tid, dm),
    consolidateCookies:      (tid, host) => ipcRenderer.invoke('consolidate-cookies', tid, host),
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
    openRequestEditor:       (idOrPayload) => ipcRenderer.invoke('open-request-editor', idOrPayload),
    openRequestEditorNewWindow: ()     => ipcRenderer.invoke('open-request-editor-new-window'),
    executeRequest:          (data)    => ipcRenderer.invoke('execute-request', data),
    cancelExecuteRequest:    (token)   => ipcRenderer.invoke('cancel-execute-request', token),
    getRequestEditorCodeMirror: () => getRequestEditorCodeMirrorModules(),
    requestEditorListCollections: () => ipcRenderer.invoke('request-editor-list-collections'),
    requestEditorSaveCollectionNode: (row) => ipcRenderer.invoke('request-editor-save-collection-node', row),
    requestEditorDeleteCollectionNode: (id) => ipcRenderer.invoke('request-editor-delete-collection-node', id),
    requestEditorListEnvironments: () => ipcRenderer.invoke('request-editor-list-environments'),
    requestEditorUpsertEnvironment: (row) => ipcRenderer.invoke('request-editor-upsert-environment', row),
    requestEditorDeleteEnvironment: (id) => ipcRenderer.invoke('request-editor-delete-environment', id),
    requestEditorPickFile:   ()        => ipcRenderer.invoke('request-editor-pick-file'),
    requestEditorBuildMultipart: (parts) => ipcRenderer.invoke('request-editor-build-multipart', parts),
    onRequestEditorInit:     (cb)      => sub('request-editor-init', cb),

    // ── TLS Fingerprint (AzureTLS) ─────────────────────────────────────────────
    getTlsProfile:           ()        => ipcRenderer.invoke('get-tls-profile'),
    setTlsProfile:           (profile) => ipcRenderer.invoke('set-tls-profile', profile),
    onTlsProfileChanged:     (cb)      => sub('tls-profile-changed', cb),

    // ── MITM / AzureTLS stats ──────────────────────────────────────────────────
    getMitmStats:            ()        => ipcRenderer.invoke('mitm-get-stats'),
    getMitmCaCert:           ()        => ipcRenderer.invoke('mitm-get-ca-cert'),
    restartMitm:             ()        => ipcRenderer.invoke('mitm-restart'),
    onMitmStatsUpdate:       (cb)      => sub('mitm-stats-update', cb),
    onMitmReadyChanged:      (cb)      => sub('mitm-ready-changed', cb),

    // ── Inline settings (browser toolbar) ──────────────────────────────────────
    setToolbarHeight:        (px)      => ipcRenderer.invoke('set-toolbar-height', px),
    setBottomChromeHeight:   (px)      => ipcRenderer.invoke('set-bottom-chrome-height', px),
    setRightChromeWidth:     (px)      => ipcRenderer.invoke('set-right-chrome-width', px),
    saveToolbarToolsPlacement: (p)     => ipcRenderer.invoke('save-toolbar-tools-placement', p),
    saveToolbarToolsMiniAlign: (a)     => ipcRenderer.invoke('save-toolbar-tools-mini-align', a),
    getSettingsAll:          ()        => ipcRenderer.invoke('get-settings-all'),
    saveActivityMonitorSettings: (opts) => ipcRenderer.invoke('save-activity-monitor-settings', opts),
    saveSecuritySettings:      (opts) => ipcRenderer.invoke('save-security-settings', opts),
    completeOnboarding:      ()        => ipcRenderer.invoke('onboarding-complete'),
    resetOnboardingWizard: ()        => ipcRenderer.invoke('reset-onboarding-wizard'),
    setAutoScreenshot:       (en)      => ipcRenderer.invoke('set-auto-screenshot', en),
    getTrackingSettings:     ()        => ipcRenderer.invoke('get-tracking-settings'),
    saveTrackingSettings:    (cfg)     => ipcRenderer.invoke('save-tracking-settings', cfg),
    saveFilterPatterns:      (pats)    => ipcRenderer.invoke('save-filter-patterns', pats),
    getSysLog:               (lvl, lim) => ipcRenderer.invoke('get-sys-log', lvl, lim),
    saveTrafficOpts:         (opts)    => ipcRenderer.invoke('save-traffic-opts', opts),
    getTrafficOpts:          ()        => ipcRenderer.invoke('get-traffic-opts'),
    setPasteUnlock:          (en)      => ipcRenderer.invoke('set-paste-unlock', en),
    setMaxTabsBeforeWarning: (n)       => ipcRenderer.invoke('set-max-tabs-before-warning', n),
    quickConnectProfile:     (id)      => ipcRenderer.invoke('quick-connect-profile', id),
    onInitSettings:          (cb)      => sub('init-settings', cb),
    getAppMetrics:           ()        => ipcRenderer.invoke('get-app-metrics'),
    getAppVersion:           ()        => ipcRenderer.invoke('get-app-version'),
    getUiPref:                 (key, def) => ipcRenderer.invoke('get-ui-pref', key, def),
    setUiPref:                 (key, value) => ipcRenderer.invoke('set-ui-pref', key, value),
    exportSettingsJson:      ()        => ipcRenderer.invoke('export-settings-json'),
    importSettingsJson:      (json)    => ipcRenderer.invoke('import-settings-json', json),
    resetSettingsToDefaults: ()        => ipcRenderer.invoke('reset-settings-to-defaults'),
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
    saveConsoleLogJson:      (content) => ipcRenderer.invoke('save-console-log-json', content),
    saveConsoleLogCsv:       (content) => ipcRenderer.invoke('save-console-log-csv', content),
    getConsoleLogsFromDb:    (opts)    => ipcRenderer.invoke('get-console-logs-db', opts || {}),
    getConsoleLogSessions:   ()        => ipcRenderer.invoke('get-console-log-sessions'),
    findRequestsNearTs:      (payload) => ipcRenderer.invoke('find-requests-near-ts', payload || {}),
    cupnetLog:               (level, module, message, meta) => ipcRenderer.invoke('cupnet-log', { level, module, message, meta }),

    // ── Page Analyzer ────────────────────────────────────────────────────────
    openPageAnalyzer:        ()        => ipcRenderer.invoke('open-page-analyzer'),
    injectActivePageHttpLab: (opts)    => ipcRenderer.invoke('inject-active-page-http-lab', opts || {}),
    injectPageHttpLab:       (tabId, opts) => ipcRenderer.invoke('inject-page-http-lab', tabId, opts || {}),
    analyzePageForms:        (tabId)   => ipcRenderer.invoke('analyze-page-forms', tabId),
    analyzePageCaptcha:      (tabId)   => ipcRenderer.invoke('analyze-page-captcha', tabId),
    solveTurnstileCaptcha:   (tabId, captcha, options) => ipcRenderer.invoke('solve-turnstile-captcha', tabId, captcha, options),
    injectTurnstileToken:    (tabId, payload) => ipcRenderer.invoke('inject-turnstile-token', tabId, payload),
    analyzePageMeta:         (tabId)   => ipcRenderer.invoke('analyze-page-meta', tabId),
    analyzePageStorage:      (tabId)   => ipcRenderer.invoke('analyze-page-storage', tabId),
    applyPageStorage:        (tabId, payload) => ipcRenderer.invoke('apply-page-storage', tabId, payload),
    analyzePageEndpoints:    (tabId)   => ipcRenderer.invoke('analyze-page-endpoints', tabId),
    pageAnalyzerAction:      (tabId, a) => ipcRenderer.invoke('page-analyzer-action', tabId, a),
    onAnalyzerTabsList:      (cb)      => sub('analyzer-tabs-list', cb),
    onAnalyzerTabsUpdated:   (cb)      => sub('analyzer-tabs-updated', cb),

    // ── Notes ──────────────────────────────────────────────────────────────────
    openNotesWindow:         ()        => ipcRenderer.invoke('open-notes-window'),
    notesList:               (f)       => ipcRenderer.invoke('notes-list', f),
    notesGet:                (id, pw)  => ipcRenderer.invoke('notes-get', id, pw),
    notesSave:               (p)       => ipcRenderer.invoke('notes-save', p),
    notesDelete:             (id)      => ipcRenderer.invoke('notes-delete', id),
    notesPin:                (id, v)   => ipcRenderer.invoke('notes-pin', id, v),
    notesExport:             (p)       => ipcRenderer.invoke('notes-export', p),
    notesEmbedRequest:       (data)    => ipcRenderer.invoke('notes-embed-request', data),
    notesGetRequestForEmbed: (id)     => ipcRenderer.invoke('notes-get-request-for-embed', id),
    onNotesInit:             (cb)      => sub('notes-init', cb),
    onNotesContextUpdate:    (cb)      => sub('notes-context-update', cb),
    onNotesEmbedBlock:       (cb)      => sub('notes-embed-block', cb),

    // ── CupNet profiles (sign-in gate) ────────────────────────────────────────
    profileList:               ()        => ipcRenderer.invoke('profile-list'),
    profileGateStatus:         ()        => ipcRenderer.invoke('profile-gate-status'),
    profileCompleteSetup:      (p)       => ipcRenderer.invoke('profile-complete-setup', p),
    profileLogin:              (p)       => ipcRenderer.invoke('profile-login', p),
    profileLogout:             ()        => ipcRenderer.invoke('profile-logout'),
    profileOpenSwitchGate:     ()        => ipcRenderer.invoke('profile-open-switch-gate'),
    profileSessionStatus:      ()        => ipcRenderer.invoke('profile-session-status'),
    profileGateQuit:           ()        => ipcRenderer.invoke('profile-gate-quit'),
    vaultSessionActivity:      ()        => ipcRenderer.invoke('vault-session-activity'),
    onProfileSessionChanged:   (cb)      => sub('profile-session-changed', cb),
    onCredentialsLocked:       (cb)      => sub('credentials-locked', cb),

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
    testProxyUrl:            (url, opts) => ipcRenderer.invoke('test-proxy-url', url, opts),
    deleteProxyProfileById:  (id)      => ipcRenderer.invoke('delete-proxy-profile', id),
    onProxyProfilesList:     (cb)      => sub('proxy-profiles-list', cb),
    onProxyStatusChanged:    (cb)      => sub('proxy-status-changed', cb),

    // ── Browser Identity (UA / client hints / TLS / timezone / language) ───────
    applyIdentity:           (patch, opts) => ipcRenderer.invoke('identity:apply', patch, opts && typeof opts === 'object' ? { autoCheck: !!opts.autoCheck } : undefined),
    openIdentityManager:     (opts)    => ipcRenderer.invoke('open-identity-manager', opts && typeof opts === 'object' ? { mode: String(opts.mode || '') } : undefined),
    onIdentityManagerCommand: (cb)     => sub('identity-manager-command', cb),
    getIdentity:             ()        => ipcRenderer.invoke('identity:get'),
    setIdentity:             (patch)   => ipcRenderer.invoke('identity:set', patch),
    previewIdentity:         (s)       => ipcRenderer.invoke('identity:preview', s),
    openIdentityCheck:       ()        => ipcRenderer.invoke('identity:open-check'),
    onIdentityChanged:       (cb)      => sub('identity-changed', cb),

    // ── Session profile / launch profile ─────────────────────────────────────
    openSessionProfileModal:  ()        => ipcRenderer.invoke('open-session-profile-modal'),
    exportLaunchProfileFromRequest: (requestId) => ipcRenderer.invoke('export-launch-profile-from-request', requestId),
    applyLaunchProfileFromRequest: (requestId, opts) => ipcRenderer.invoke('apply-launch-profile-from-request', requestId, opts),
    onSessionProfileLoaded:   (cb)      => sub('session-profile-loaded', cb),
    onSessionProfileLoadFailed: (cb)    => sub('session-profile-load-failed', cb),
});
