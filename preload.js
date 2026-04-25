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
    onForceCloseOmnibox:     (cb)      => sub('force-close-omnibox', cb),
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
    onMitmStatsUpdate:       (cb)      => sub('mitm-stats-update', cb),

    // ── Inline settings (browser toolbar) ──────────────────────────────────────
    setToolbarHeight:        (px)      => ipcRenderer.invoke('set-toolbar-height', px),
    getSettingsAll:          ()        => ipcRenderer.invoke('get-settings-all'),
    saveActivityMonitorSettings: (opts) => ipcRenderer.invoke('save-activity-monitor-settings', opts),
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

    // ── Credentials vault ─────────────────────────────────────────────────────
    openCredentialsWindow:   ()        => ipcRenderer.invoke('open-credentials-window'),
    credentialsVaultStatus:  ()        => ipcRenderer.invoke('credentials-vault-status'),
    credentialsVaultSetup:   (p)       => ipcRenderer.invoke('credentials-vault-setup', p),
    credentialsUnlock:       (pw, vid) => ipcRenderer.invoke('credentials-unlock', pw, vid),
    credentialsLock:         ()        => ipcRenderer.invoke('credentials-lock'),
    credentialsList:         (f)       => ipcRenderer.invoke('credentials-list', f),
    credentialsGet:          (id)      => ipcRenderer.invoke('credentials-get', id),
    credentialsSave:         (p)       => ipcRenderer.invoke('credentials-save', p),
    credentialsDelete:       (id, perm) => ipcRenderer.invoke('credentials-delete', id, perm),
    credentialsFavorite:     (id, v)   => ipcRenderer.invoke('credentials-favorite', id, v),
    credentialsGetTabProxyIp: ()       => ipcRenderer.invoke('credentials-get-tab-proxy-ip'),
    credentialsChangeMaster: (p)       => ipcRenderer.invoke('credentials-change-master', p),
    credentialsImportBatch:  (p)       => ipcRenderer.invoke('credentials-import-batch', p),
    credentialsExport:       (p)       => ipcRenderer.invoke('credentials-export', p),
    credentialsSiteMatchCount: (p)     => ipcRenderer.invoke('credentials-site-match-count', p),
    credentialsSiteMatches:  (p)       => ipcRenderer.invoke('credentials-site-matches', p),
    credentialsUnlockAndGetMatches: (p) => ipcRenderer.invoke('credentials-unlock-and-get-matches', p || {}),
    credentialsFillActiveTab: (payload) => ipcRenderer.invoke('credentials-fill-active-tab', payload || {}),
    // multi-vault management
    credentialsVaultList:    ()        => ipcRenderer.invoke('credentials-vault-list'),
    credentialsVaultCreate:  (p)       => ipcRenderer.invoke('credentials-vault-create', p),
    credentialsVaultSwitch:  (id, pw)  => ipcRenderer.invoke('credentials-vault-switch', id, pw),
    credentialsVaultDelete:  (id, pw)  => ipcRenderer.invoke('credentials-vault-delete', id, pw),
    credentialsVaultRename:  (id, n)   => ipcRenderer.invoke('credentials-vault-rename', id, n),
    // trash
    credentialsRestore:      (id)      => ipcRenderer.invoke('credentials-restore', id),
    credentialsPurgeTrash:   ()        => ipcRenderer.invoke('credentials-purge-trash'),
    credentialsCountTrash:   ()        => ipcRenderer.invoke('credentials-count-trash'),
    credentialsTypeCounts:   ()        => ipcRenderer.invoke('credentials-type-counts'),
    // folders
    credentialsFoldersList:  ()        => ipcRenderer.invoke('credentials-folders-list'),
    credentialsFolderCreate: (n, pid)  => ipcRenderer.invoke('credentials-folder-create', n, pid),
    credentialsFolderRename: (id, n)   => ipcRenderer.invoke('credentials-folder-rename', id, n),
    credentialsFolderDelete: (id)      => ipcRenderer.invoke('credentials-folder-delete', id),
    credentialsMoveToFolder: (cid, fid) => ipcRenderer.invoke('credentials-move-to-folder', cid, fid),
    // URIs + custom fields
    credentialsUrisGet:      (id)      => ipcRenderer.invoke('credentials-uris-get', id),
    credentialsUrisSave:     (id, u)   => ipcRenderer.invoke('credentials-uris-save', id, u),
    credentialsFieldsGet:    (id)      => ipcRenderer.invoke('credentials-fields-get', id),
    credentialsFieldsSave:   (id, f)   => ipcRenderer.invoke('credentials-fields-save', id, f),
    // vault hint
    credentialsVaultSetHint: (h)       => ipcRenderer.invoke('credentials-vault-set-hint', h),
    // capture prompt
    credentialCaptureConfirm:      ()     => ipcRenderer.invoke('credential-capture-confirm'),
    credentialCaptureDismiss:       ()     => ipcRenderer.invoke('credential-capture-dismiss'),
    credentialCaptureUnlockAndSave: (pw)  => ipcRenderer.invoke('credential-capture-unlock-and-save', pw),
    onShowCredentialSaveBar: (cb)         => sub('show-credential-save-bar', cb),
    // events
    onCredentialsInit:       (cb)      => sub('credentials-init', cb),
    onCredentialsContextUpdate: (cb)   => sub('credentials-context-update', cb),
    onCredentialsToolbarRefresh: (cb)  => sub('credentials-toolbar-refresh', cb),

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
