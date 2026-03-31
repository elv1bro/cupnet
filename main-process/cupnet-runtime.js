'use strict';
const path = require('path');
const fs   = require('fs');
const { sysLog, safeCatch, flushOnExit, initIPC: initSysLogIPC } = require('../sys-log');

const {
    app, BrowserWindow, ipcMain, session, Menu, dialog,
    net, shell, nativeImage, clipboard, safeStorage, Notification
} = require('electron');
const ProxyChain = require('proxy-chain');
const { spawn } = require('child_process');
let _jsonDiffModulePromise = null;

async function loadJsonDiffModules() {
    if (!_jsonDiffModulePromise) {
        _jsonDiffModulePromise = Promise.all([
            import('jsondiffpatch'),
            import('jsondiffpatch/formatters/html'),
        ]).then(([jdp, htmlFmt]) => ({
            jsondiffpatch: jdp?.default || jdp,
            formatter: htmlFmt?.default || htmlFmt,
        }));
    }
    return _jsonDiffModulePromise;
}

/**
 * Full main-process bootstrap (Phase 0). Invoked from main-process/index.js after single-instance lock.
 */
function attachMainProcess() {

// ─── Module imports (loaded after app.whenReady for safeStorage) ─────────────
let db          = null;
let tabManager  = null;
let harExporter = null;
let rulesEngine = null;
let interceptor = null;

const _cupnetRoot = path.join(__dirname, '..');
const getAssetPath = (name) => path.join(_cupnetRoot, name);

// ─── Pure utilities (no Electron deps — also used by tests) ──────────────────
const {
    resolveNavigationUrl,
    parseProxyTemplate,
    extractTemplateVars,
    formatBytes,
    shouldFilterUrl: _shouldFilterUrl,
    SEARCH_ENGINE,
} = require('../utils');
const bundleUtils = require('../bundle-utils');
const diffUtils = require('../diff-utils');
const { solveTurnstileWithCapMonster, CaptchaSolverError } = require('../captcha-solver');
const { networkPolicy } = require('../network-policy');
const { ProxyResilienceManager } = require('../proxy-resilience');
const { normalizeTrafficMode, resolveSessionProxyConfig } = require('../traffic-mode-router');
const settingsStore = require('./services/settings-store');
const uiPrefsStore = require('./services/ui-prefs-store');
const extPortsStore = require('./services/ext-ports-store');
const { installConsoleCapture } = require('./services/console-capture');
const { createIpcBatchMessenger } = require('./services/ipc-batch-messenger');
const {
    getLocalIp,
    generatePassword,
    sanitizeProxyUrl,
    withTimeout,
} = require('./services/network-helpers');
const { createProxyNotifyBroadcast } = require('./services/proxy-notify-broadcast');
const { createCdpNetworkLogging } = require('./services/cdp-network-logging');
const { createFingerprintService } = require('./services/fingerprint-service');
const { createScreenshotService } = require('./services/screenshot-service');

const {
    _analyzeFormsScript,
    _analyzeCaptchaScript,
    _analyzeMetaScript,
    _analyzeEndpointsCollectScript,
} = require('./services/page-analyzer-injected-scripts');

// Re-export shouldFilterUrl under the same name used throughout this file
const shouldFilterUrl = _shouldFilterUrl;

const { createTrafficModeService } = require('./services/traffic-mode-service');
const { createProxyMitmService } = require('./services/proxy-service');
const { createSubWindowsApi } = require('./services/sub-windows');
const { createMainWindowApi } = require('./services/main-window');

// ─── MITM Proxy (required lazily inside app.whenReady) ───────────────────────
let mitmProxy = null;
const { MitmProxy, ExternalProxyPort } = require('../mitm-proxy.js');

// ─── Stealth debug: CUPNET_STEALTH_LEVEL=N отключает слои по одному для бисекции CF Turnstile ──
const STEALTH = Number(process.env.CUPNET_STEALTH_LEVEL || 0);
if (STEALTH) console.log(`[stealth] CUPNET_STEALTH_LEVEL=${STEALTH}`);

(function logCupnetBisectEnv() {
    const parts = [];
    const on = (k) => { if (process.env[k] === '1') parts.push(k); };
    on('CUPNET_DISABLE_TRAFFIC_WEBREQUEST');
    on('CUPNET_DISABLE_INTERCEPT_PROTOCOL');
    on('CUPNET_DISABLE_FINGERPRINT');
    on('CUPNET_TRAFFIC_FILTER_LOG');
    on('CUPNET_FORCE_HTTP1');
    if (STEALTH) parts.push(`CUPNET_STEALTH_LEVEL=${STEALTH}`);
    if (parts.length) console.log('[cupnet-bisect]', parts.join(' '));
})();

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// Read bypass domains early (before app.whenReady) for Chromium proxy bypass hints.
// Proxy route itself is controlled dynamically via session.setProxy (MITM vs browser proxy).
if (STEALTH < 7) {
    const earlySettingsPath = path.join(app.getPath('userData'), 'settings.json');
    let earlyBypass = [];
    try {
        earlyBypass = JSON.parse(fs.readFileSync(earlySettingsPath, 'utf8')).bypassDomains || [];
    } catch (err) {
        safeCatch({ module: 'main', eventCode: 'settings.parse.failed', context: { file: earlySettingsPath } }, err, 'info');
    }
    const bypassList = ['<local>', '*.youtube.com', '*.googlevideo.com', ...earlyBypass];
    app.commandLine.appendSwitch('proxy-bypass-list', [...new Set(bypassList)].join(','));
}
// MITM self-signed certs обрабатываются через setCertificateVerifyProc + certificate-error,
// а НЕ глобальным --ignore-certificate-errors (Cloudflare детектит этот флаг и блокирует challenge).
//
// WebRTC / WebGL ограничения теперь применяются только когда подключён прокси (через session-level webRequest),
// а НЕ глобальными Chromium-флагами. Причина: CF Turnstile детектит отсутствие WEBGL_debug_renderer_info
// и нестандартное WebRTC-поведение как признаки модифицированного браузера.

// ─── App state ────────────────────────────────────────────────────────────────
let actProxy                   = '';
let mainWindow                 = null;
let forceAppQuit               = false;
let logViewerWindow            = null; // kept for backward-compat (first window reference)
const logViewerWindows         = [];   // all open log-viewer windows
const traceWindows            = [];   // all open trace-viewer windows
// Map<webContentsId, sessionId|null> for log-viewer windows opened on a specific session
const logViewerInitSessions    = new Map();
let rulesWindow                = null;
let cookieManagerWindow        = null;
let dnsManagerWindow           = null;
let proxyManagerWindow         = null;
let compareViewerWindow        = null;
let consoleViewerWindow        = null;
let pageAnalyzerWindow         = null;
let notesWindow                = null;
let ivacScoutWindow            = null;
const comparePair              = { left: null, right: null };
let compareResult              = null;

const consoleCaptureApi = installConsoleCapture(() => consoleViewerWindow);
const ipcBatch = createIpcBatchMessenger({
    safeCatch,
    BrowserWindow,
    getMainWindow: () => mainWindow,
    getLogViewerWindows: () => logViewerWindows,
    getRulesWindow: () => rulesWindow,
    getDnsManagerWindow: () => dnsManagerWindow,
});
const _broadcastLogEntryToViewers = ipcBatch.broadcastLogEntryToViewers;
const broadcastInterceptRuleMatched = ipcBatch.broadcastInterceptRuleMatched;
const broadcastDnsRuleMatched = ipcBatch.broadcastDnsRuleMatched;
const broadcastTlsProfileChanged = ipcBatch.broadcastTlsProfileChanged;

let loggingModalWindow         = null;
/** Основной Request Editor (тулбар, Log → «в том же окне»). */
let requestEditorWindow        = null;
/** Доп. окна Request Editor («+ New window»). */
const requestEditorExtraWindows = [];
let ivacScoutProcess           = null;
let persistentAnonymizedProxyUrl = null;
let connectedProfileId           = null;
let connectedProfileName         = null;
let connectedResolvedVars        = {};
let currentTrafficMode           = 'mitm';
settingsStore.configure({ onEffectiveTrafficModeLoaded: (mode) => { currentTrafficMode = mode; } });
let isLoggingEnabled           = false;
let hadLoggingBeenStopped      = false; // true after first explicit stop; controls modal on re-enable
let currentSessionId           = null;
let logStatusInterval          = null;
let logEntryCount              = 0;
let activeFingerprint          = null; // { user_agent, timezone, language } or null
let mitmStartPromise           = null; // Promise resolving when MITM is ready
let mitmReady                  = false;
let startupMetrics             = {
    appReadyTs: 0,
    windowCreatedTs: 0,
    firstPaintTs: 0,
    mitmReadyTs: 0,
    longTaskCount: 0,
    logged: false,
};
let isWindowActive             = false;
let lastMouseMoveTime          = 0;
let _lastPendingForTracking    = null;
let appCtx                     = null;
const _wcIdToTabId             = new Map(); // webContents.id -> tabId
const _lastPointerByTabId      = new Map(); // tabId -> { xNorm, yNorm, ts }
function syncAppContextSnapshot() {
    if (!appCtx) return;
    appCtx.modules.db = db;
    appCtx.modules.tabManager = tabManager;
    appCtx.modules.harExporter = harExporter;
    appCtx.modules.rulesEngine = rulesEngine;
    appCtx.modules.interceptor = interceptor;
    appCtx.modules.mitmProxy = mitmProxy;

    appCtx.windows.main = mainWindow;
    appCtx.windows.logViewers = logViewerWindows;
    appCtx.windows.traceViewers = traceWindows;
    appCtx.windows.rules = rulesWindow;
    appCtx.windows.proxyManager = proxyManagerWindow;
    appCtx.windows.cookieManager = cookieManagerWindow;
    appCtx.windows.dnsManager = dnsManagerWindow;
    appCtx.windows.compareViewer = compareViewerWindow;
    appCtx.windows.consoleViewer = consoleViewerWindow;
    appCtx.windows.pageAnalyzer = pageAnalyzerWindow;
    appCtx.windows.notes = notesWindow;
    appCtx.windows.ivacScout = ivacScoutWindow;

    appCtx.proxy.actProxy = actProxy;
    appCtx.proxy.anonymizedUrl = persistentAnonymizedProxyUrl;
    appCtx.proxy.profileId = connectedProfileId;
    appCtx.proxy.profileName = connectedProfileName;
    appCtx.proxy.resolvedVars = connectedResolvedVars;
    appCtx.proxy.trafficMode = normalizeTrafficMode(currentTrafficMode);
    appCtx.proxy.resilience = proxyResilience;

    appCtx.logging.enabled = isLoggingEnabled;
    appCtx.logging.hadBeenStopped = hadLoggingBeenStopped;
    appCtx.logging.sessionId = currentSessionId;
    appCtx.logging.entryCount = logEntryCount;

    appCtx.fingerprint.active = activeFingerprint;
    appCtx.mitm.ready = mitmReady;
    appCtx.mitm.startPromise = mitmStartPromise;
    appCtx.settings.cached = settingsStore.getCached();

    appCtx.metrics.stability = stabilityMetrics;
    appCtx.metrics.startupMetrics = startupMetrics;

    appCtx.misc.forceAppQuit = forceAppQuit;
    appCtx.misc.isWindowActive = isWindowActive;
}
const proxyNotify = createProxyNotifyBroadcast({
    safeCatch,
    BrowserWindow,
    getTabManager: () => tabManager,
    getDb: () => db,
    getMainWindow: () => mainWindow,
    getProxyManagerWindow: () => proxyManagerWindow,
    getPersistentAnonymizedProxyUrl: () => persistentAnonymizedProxyUrl,
    getActProxy: () => actProxy,
    getConnectedProfileName: () => connectedProfileName,
    getConnectedProfileId: () => connectedProfileId,
    getConnectedResolvedVars: () => connectedResolvedVars,
    getCurrentTrafficMode: () => normalizeTrafficMode(currentTrafficMode),
    getMitmReady: () => mitmReady,
});
const { notifyProxyStatus, notifyMitmReady, notifyProxyProfilesList } = proxyNotify;
const proxyResilience = new ProxyResilienceManager(networkPolicy.breaker);
const stabilityMetrics = {
    counters: {
        proxyConnectFailed: 0,
        proxyQuarantined: 0,
        proxyCircuitOpened: 0,
        workerOverloaded: 0,
        workerTimeouts: 0,
        retriesExhausted: 0,
    },
    gauges: {
        queueDepth: 0,
        workerRestarts: 0,
        p95LatencyMs: 0,
        dbWriteQueueHighDepth: 0,
        dbWriteQueueLowDepth: 0,
        dbWriteQueueDroppedLow: 0,
        dbWriteQueueDroppedHigh: 0,
    },
    hist: {
        requestLatencyMs: [],
    },
};
const _lastSloAlertAt = new Map();

function _recordLatencySample(ms) {
    const v = Math.max(0, Number(ms) || 0);
    stabilityMetrics.hist.requestLatencyMs.push(v);
    if (stabilityMetrics.hist.requestLatencyMs.length > 500) {
        stabilityMetrics.hist.requestLatencyMs.splice(0, stabilityMetrics.hist.requestLatencyMs.length - 500);
    }
    const sorted = [...stabilityMetrics.hist.requestLatencyMs].sort((a, b) => a - b);
    const idx = Math.floor(Math.max(0, sorted.length - 1) * 0.95);
    stabilityMetrics.gauges.p95LatencyMs = sorted.length ? sorted[idx] : 0;
}

function emitStabilityEvent(level, eventName, data = {}) {
    const suffix = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    sysLog(level, 'stability', `${eventName}${suffix}`);
}

function emitSloWarnOnce(key, data, cooldownMs = 30000) {
    const now = Date.now();
    const prev = _lastSloAlertAt.get(key) || 0;
    if (now - prev < cooldownMs) return;
    _lastSloAlertAt.set(key, now);
    emitStabilityEvent('warn', key, data);
}

function maybeLogMockToNetworkActivity(info) {
    if (!info || info.type !== 'mock') return;
    if (!isLoggingEnabled || !db) return;
    const tab = info.tabId ? tabManager?.getTab(info.tabId) : null;
    const sessionId = tab?.sessionId ?? currentSessionId;
    if (!sessionId) return;
    const status = Number(info.status) || 200;
    const method = (info.method || 'GET').toUpperCase();
    const mimeType = info.mimeType || 'text/plain';
    const body = typeof info.body === 'string' ? info.body : '';
    try {
        db.insertRequestAsync(sessionId, info.tabId || null, {
            requestId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            url: info.url || '',
            method,
            status,
            type: 'mock',
            duration: 0,
            requestHeaders: null,
            responseHeaders: { 'content-type': mimeType },
            requestBody: null,
            responseBody: body,
            error: null,
        }).then((dbId) => {
            if (!dbId) return;
            _broadcastLogEntryToViewers({
                id: dbId,
                url: info.url || '',
                method,
                status,
                type: 'mock',
                duration: 0,
                duration_ms: 0,
                response: { statusCode: status, headers: { 'content-type': mimeType } },
                responseBody: body,
                tabId: info.tabId || null,
                sessionId,
            });
        }).catch((err) => {
            console.error('[main] mock log insert failed:', err?.message || err);
        });
    } catch (e) {
        console.error('[main] mock log insert failed:', e.message);
    }
}

// ─── Log status updater ───────────────────────────────────────────────────────
function startLogStatusUpdater() {
    if (logStatusInterval) clearInterval(logStatusInterval);
    let lastSentCount = -1;
    let lastSentSession = null;
    logStatusInterval = setInterval(() => {
        const payload = isLoggingEnabled && currentSessionId
            ? { enabled: true, sessionId: currentSessionId, count: logEntryCount }
            : { enabled: false, sessionId: null, count: 0 };
        if (payload.count === lastSentCount && payload.sessionId === lastSentSession) return;
        lastSentCount = payload.count;
        lastSentSession = payload.sessionId;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-log-status', payload);
        }
        for (const w of logViewerWindows) {
            if (!w.isDestroyed()) w.webContents.send('update-log-status', payload);
        }
    }, 5000);
}

function sendLogStatus() {
    const payload = isLoggingEnabled && currentSessionId
        ? { enabled: true, sessionId: currentSessionId, count: logEntryCount }
        : { enabled: false, sessionId: null, count: 0 };
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-log-status', payload);
    }
    for (const w of logViewerWindows) {
        if (!w.isDestroyed()) w.webContents.send('update-log-status', payload);
    }
}

function maybeLogStartupMetrics() {
    if (startupMetrics.logged) return;
    if (!startupMetrics.appReadyTs || !startupMetrics.windowCreatedTs || !startupMetrics.firstPaintTs) return;
    const appReadyToWindowCreatedMs = startupMetrics.windowCreatedTs - startupMetrics.appReadyTs;
    const windowCreatedToFirstPaintMs = startupMetrics.firstPaintTs - startupMetrics.windowCreatedTs;
    const firstPaintToMitmReadyMs = startupMetrics.mitmReadyTs
        ? (startupMetrics.mitmReadyTs - startupMetrics.firstPaintTs)
        : null;
    startupMetrics.logged = true;
    console.log('[perf] startup-metrics', JSON.stringify({
        appReadyToWindowCreatedMs,
        windowCreatedToFirstPaintMs,
        firstPaintToMitmReadyMs,
        uiLongTaskCountFirst10s: startupMetrics.longTaskCount || 0,
    }));
}

// ─── External Proxy Ports ────────────────────────────────────────────────────
const activeExtPorts = new Map(); // port → { instance: ExternalProxyPort, sessionId, config }
const extPortErrors  = new Map(); // port → error string (set when start fails)

const MOUSE_ACTIVITY_TIMEOUT = 90000;
const iconPath = fs.existsSync(getAssetPath('icons/icon.png'))
    ? getAssetPath('icons/icon.png')
    : getAssetPath('img.png');

// ─── Console capture: installConsoleCapture() above (consoleCaptureApi) ───────

// ─── Settings (store: main-process/services/settings-store.js) ────────────────
const { normalizeTrackingSettings, normalizeCapmonsterSettings } = settingsStore;

function loadSettings() {
    return settingsStore.loadSettings();
}

function saveSettings(s) {
    return settingsStore.saveSettings(s);
}

function getCapmonsterSettings() {
    const s = loadSettings();
    if (!s.capmonster || typeof s.capmonster !== 'object') {
        s.capmonster = normalizeCapmonsterSettings();
        saveSettings(s);
    } else {
        s.capmonster = normalizeCapmonsterSettings(s.capmonster);
    }
    return s.capmonster;
}

function getTrackingSettings() {
    const s = loadSettings();
    if (!s.tracking || typeof s.tracking !== 'object') {
        s.tracking = normalizeTrackingSettings();
        saveSettings(s);
    } else {
        s.tracking = normalizeTrackingSettings(s.tracking);
    }
    return s.tracking;
}

const fingerprintSvc = createFingerprintService({
    sysLog,
    safeCatch,
    getTabManager: () => tabManager,
    getDb: () => db,
});
const { applyFingerprintToAllTabs, applyFingerprintFromProfile, resetFingerprintOnWebContents } = fingerprintSvc;

const screenshotSvc = createScreenshotService({
    path,
    cupnetRoot: _cupnetRoot,
    getTabManager: () => tabManager,
    getIsWindowActive: () => isWindowActive,
    getLastPointerByTabId: () => _lastPointerByTabId,
    getIsLoggingEnabled: () => isLoggingEnabled,
    getCurrentSessionId: () => currentSessionId,
    getDb: () => db,
    incrementLogEntryCount: () => { logEntryCount++; },
    broadcastLogEntryToViewers: _broadcastLogEntryToViewers,
    getMainWindow: () => mainWindow,
    getTrackingSettings,
});
const { captureScreenshot, requestScreenshot } = screenshotSvc;

const _cdpNetworkLogging = createCdpNetworkLogging({
    safeCatch,
    shouldFilterUrl,
    Notification,
    getTabManager: () => tabManager,
    getMitmProxy: () => mitmProxy,
    getIsLoggingEnabled: () => isLoggingEnabled,
    getDb: () => db,
    getRulesEngine: () => rulesEngine,
    getSettings: () => settingsStore.getCached() || loadSettings(),
    getLogViewerWindows: () => logViewerWindows,
    broadcastLogEntryToViewers: _broadcastLogEntryToViewers,
    wcIdToTabId: _wcIdToTabId,
    incrementLogEntryCount: () => { logEntryCount++; },
    getActiveFingerprint: () => activeFingerprint,
    getMainWindow: () => mainWindow,
    requestScreenshot,
});
const setupNetworkLogging = _cdpNetworkLogging.setupNetworkLogging;

function getInternalPageUrl(pageName) {
    const name = String(pageName || '').trim().toLowerCase();
    let file = 'new-tab.html';
    if (name === 'settings') file = 'settings.html';
    else if (name === 'guide') file = 'cupnet-guide.html';
    return `file://${path.join(_cupnetRoot, file)}`;
}

/** Returns the URL to open in a new tab (homepage or built-in new-tab page). */
function getNewTabUrl() {
    const hp = settingsStore.getCached()?.homepage?.trim();
    if (hp) return hp;
    return getInternalPageUrl('new-tab');
}


// Deduplicate MITM logs (used by proxy-service MITM callback)
const _seenRequestIds = new Set();
const _lastMitmLogKey = new Map();
const MITM_DEDUP_MS = 400;

const trafficSvc = createTrafficModeService({
    settingsStore,
    loadSettings,
    saveSettings,
    sysLog,
    safeCatch,
    session,
    notifyProxyStatus,
    getMitmProxy: () => mitmProxy,
    getTabManager: () => tabManager,
    getInterceptor: () => interceptor,
    getPersistentAnonymizedProxyUrl: () => persistentAnonymizedProxyUrl,
    getCurrentTrafficModeRaw: () => currentTrafficMode,
    setCurrentTrafficModeRaw: (v) => { currentTrafficMode = v; },
});
const {
    getCurrentTrafficMode,
    getMitmProxyOpts,
    applyEffectiveTrafficMode,
    applyBypassDomains,
    applyTrafficFilters,
    buildBypassList,
} = trafficSvc;

const proxySvc = createProxyMitmService({
    settingsStore,
    loadSettings,
    pathModule: path,
    cupnetRoot: _cupnetRoot,
    MitmProxy,
    getCurrentTrafficMode,
    getTabManager: () => tabManager,
    getCurrentSessionId: () => currentSessionId,
    getDb: () => db,
    getTraceWindows: () => traceWindows,
    getPersistentAnonymizedProxyUrl: () => persistentAnonymizedProxyUrl,
    getIsLoggingEnabled: () => isLoggingEnabled,
    recordLatencySample: _recordLatencySample,
    broadcastDnsRuleMatched,
    getSeenRequestIds: () => _seenRequestIds,
    getLastMitmLogKey: () => _lastMitmLogKey,
    MITM_DEDUP_MS,
    broadcastLogEntryToViewers: _broadcastLogEntryToViewers,
    incrementLogEntryCount: () => { logEntryCount++; },
    getStabilityMetrics: () => stabilityMetrics,
    safeCatch,
    emitStabilityEvent,
    setMitmProxy: (v) => { mitmProxy = v; },
    getMitmProxy: () => mitmProxy,
    net,
    session,
    BrowserWindow,
    dialog,
    sysLog,
    proxyResilience,
    getMitmReady: () => mitmReady,
    getMitmStartPromise: () => mitmStartPromise,
    setActProxy: (v) => { actProxy = v; },
    setPersistentAnonymizedProxyUrl: (v) => { persistentAnonymizedProxyUrl = v; },
});
const {
    startMitmProxy,
    netFetchWithTimeout,
    getRealIp,
    checkCurrentIpGeo,
    testProxy,
    quickChangeProxy,
    parseFallbackProxyList,
    connectProxyWithFailover,
} = proxySvc;

const { insertSessionBootstrapTrafficRow } = require('./services/cupnet-network-meta-log');

/** SET PROXY/DIRECT snapshot when logging is already enabled (e.g. after reload); skipped while logging is off. */
async function bootstrapSessionTrafficMetaLog() {
    const ctx = {
        get db() { return db; },
        get currentSessionId() { return currentSessionId; },
        get isLoggingEnabled() { return isLoggingEnabled; },
        get logEntryCount() { return logEntryCount; },
        set logEntryCount(v) { logEntryCount = v; },
        _broadcastLogEntryToViewers,
        checkCurrentIpGeo,
        get persistentAnonymizedProxyUrl() { return persistentAnonymizedProxyUrl; },
        get actProxy() { return actProxy; },
        get connectedProfileId() { return connectedProfileId; },
        get connectedProfileName() { return connectedProfileName; },
    };
    await insertSessionBootstrapTrafficRow(ctx);
}

function rwWin(getter, setter) {
    return { get: getter, set: setter, enumerable: true, configurable: true };
}

/** Shared with sub-windows debounce + will-quit cleanup */
const notifyTabsDebounce = { id: null };

const dSub = {
    path,
    fs,
    app,
    BrowserWindow,
    spawn,
    getAssetPath,
    iconPath,
    cupnetRoot: _cupnetRoot,
    logViewerWindows,
    traceWindows,
    requestEditorExtraWindows,
    logViewerInitSessions,
    comparePair,
    loadSettings,
    ipcBatch,
    diffUtils,
    settingsStore,
    safeCatch,
    sysLog,
    notifyProxyProfilesList,
    notifyProxyStatus,
    get tabManager() { return tabManager; },
    get db() { return db; },
    get interceptor() { return interceptor; },
    get mitmProxy() { return mitmProxy; },
    get isLoggingEnabled() { return isLoggingEnabled; },
    set isLoggingEnabled(v) { isLoggingEnabled = v; },
    get currentSessionId() { return currentSessionId; },
    set currentSessionId(v) { currentSessionId = v; },
    get logEntryCount() { return logEntryCount; },
    set logEntryCount(v) { logEntryCount = v; },
    get persistentAnonymizedProxyUrl() { return persistentAnonymizedProxyUrl; },
    get connectedProfileName() { return connectedProfileName; },
    get compareResult() { return compareResult; },
    set compareResult(v) { compareResult = v; },
    get ivacScoutProcess() { return ivacScoutProcess; },
    set ivacScoutProcess(v) { ivacScoutProcess = v; },
    notifyTabsDebounce,
};
Object.defineProperties(dSub, {
    mainWindow: rwWin(() => mainWindow, (v) => { mainWindow = v; }),
    logViewerWindow: rwWin(() => logViewerWindow, (v) => { logViewerWindow = v; }),
    rulesWindow: rwWin(() => rulesWindow, (v) => { rulesWindow = v; }),
    cookieManagerWindow: rwWin(() => cookieManagerWindow, (v) => { cookieManagerWindow = v; }),
    dnsManagerWindow: rwWin(() => dnsManagerWindow, (v) => { dnsManagerWindow = v; }),
    proxyManagerWindow: rwWin(() => proxyManagerWindow, (v) => { proxyManagerWindow = v; }),
    compareViewerWindow: rwWin(() => compareViewerWindow, (v) => { compareViewerWindow = v; }),
    consoleViewerWindow: rwWin(() => consoleViewerWindow, (v) => { consoleViewerWindow = v; }),
    pageAnalyzerWindow: rwWin(() => pageAnalyzerWindow, (v) => { pageAnalyzerWindow = v; }),
    notesWindow: rwWin(() => notesWindow, (v) => { notesWindow = v; }),
    ivacScoutWindow: rwWin(() => ivacScoutWindow, (v) => { ivacScoutWindow = v; }),
    loggingModalWindow: rwWin(() => loggingModalWindow, (v) => { loggingModalWindow = v; }),
    requestEditorWindow: rwWin(() => requestEditorWindow, (v) => { requestEditorWindow = v; }),
});

const subApis = createSubWindowsApi(dSub);

const dMain = Object.create(dSub);
Object.assign(dMain, {
    sub: subApis,
    Menu,
    dialog,
    nativeImage,
    startupMetrics,
    setupNetworkLogging,
    getNewTabUrl,
    startLogStatusUpdater,
    applyBypassDomains,
    applyTrafficFilters,
    getTrackingSettings,
    sendLogStatus,
    requestScreenshot,
    bootstrapSessionTrafficMetaLog,
});
Object.defineProperties(dMain, {
    forceAppQuit:    { get() { return forceAppQuit; },    set(v) { forceAppQuit = v; },    enumerable: true, configurable: true },
    isWindowActive:  { get() { return isWindowActive; },  set(v) { isWindowActive = v; },  enumerable: true, configurable: true },
    lastMouseMoveTime: { get() { return lastMouseMoveTime; }, set(v) { lastMouseMoveTime = v; }, enumerable: true, configurable: true },
});

const {
    confirmExitDialog,
    applyRuntimeAppIcon,
    createMainWindow,
    buildMenu,
} = createMainWindowApi(dMain);

const {
    openRequestEditorWindow,
    openRequestEditorNewWindow,
    createRequestEditorWindow,
    createLogViewerWindow,
    _serializeCompareRowRequest,
    _comparePayload,
    _requestsForSessionAsc,
    _parseHeadersMaybe,
    _stripNoiseHeaders,
    _reqWithCompareOptions,
    _safeUrl,
    _queryKeys,
    _pathTokens,
    _tokenSimilarity,
    _statusClass,
    _pairScore,
    _confidence,
    _broadcastCompareUpdated,
    createCompareViewerWindow,
    getLiveLogViewerWindow,
    createTraceViewerWindow,
    createConsoleViewerWindow,
    createPageAnalyzerWindow,
    createNotesWindow,
    createIvacScoutWindow,
    sendIvacScoutLog,
    getIvacScoutContext,
    stopIvacScoutProcess,
    runIvacScoutProcess,
    _sendAnalyzerTabs,
    notifyCookieManagerTabs,
    notifyCookieGroupsListsUpdated,
    isValidDnsHost,
    isValidIpv4,
    syncDnsOverridesToMitm: syncDnsOverridesToMitm_raw,
    createCookieManagerWindow,
    createDnsManagerWindow,
    createLoggingModalWindow,
    createProxyManagerWindow,
    createRulesWindow,
    reattachInterceptorToAllTabs,
} = subApis;

function syncDnsOverridesToMitm(...args) {
    syncDnsOverridesToMitm_raw(...args);
    _syncDnsOverrideHostsSet();
}

// ─── Certificate verification ────────────────────────────────────────────────
// Принимаем cert-ошибки для:
//  1) localhost / 127.0.0.1 — MITM-прокси с self-signed CA
//  2) доменов с активным DNS override — хост резолвится на чужой IP, сертификат не совпадает
// Для остальных — стандартная проверка (CF Turnstile палит глобальное «принимай всё»).
const _dnsOverrideHosts = new Set();
function _syncDnsOverrideHostsSet() {
    _dnsOverrideHosts.clear();
    try {
        if (!db) return;
        for (const r of db.getDnsOverrides()) {
            if (r.enabled) _dnsOverrideHosts.add(r.host.toLowerCase());
        }
    } catch {}
}

if (STEALTH < 3) {
    app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
        try {
            const u = new URL(url);
            const host = u.hostname.toLowerCase();
            if (host === '127.0.0.1' || host === 'localhost' || _dnsOverrideHosts.has(host)) {
                event.preventDefault();
                callback(true);
                return;
            }
        } catch {}
        callback(false);
    });
}

// ─── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    startupMetrics.appReadyTs = Date.now();
    applyRuntimeAppIcon();

    const { isUaSanitizeDisabled } = require('../user-agent-utils');
    if (isUaSanitizeDisabled()) {
        console.log('[main] UA sanitize: OFF (CUPNET_DISABLE_UA_SANITIZE=1) — MITM leaves outbound User-Agent unchanged');
    } else {
        console.log('[main] Outbound User-Agent: CupNet/Electron stripped in MITM (navigator.userAgent may still show Electron)');
    }

    // Load only the critical modules synchronously
    db         = require('../db');
    tabManager = require('../tab-manager');
    db.init();
    _syncDnsOverrideHostsSet();
    loadSettings();
    tabManager.applyDevicePermissions();
    tabManager.setProxyAll(null).catch((err) => {
        safeCatch({ module: 'main', eventCode: 'traffic.mode.apply.failed', context: { source: 'startup.preload' } }, err, 'info');
    });
    initSysLogIPC();

    // Interceptor до первого attachToSession (первая вкладка): иначе гонка с setImmediate.
    interceptor = require('../request-interceptor');
    interceptor.setResolveTabIdFromDetails((details) => {
        const wcId = details && details.webContentsId;
        if (wcId == null) return null;
        return tabManager.getTabIdByWebContentsId(wcId) || null;
    });
    interceptor.setOnRuleMatch((info) => {
        broadcastInterceptRuleMatched(info);
        maybeLogMockToNetworkActivity(info);
    });
    interceptor.setTrafficMode(getCurrentTrafficMode());

    const { createAppContext } = require('./app-context');
    appCtx = createAppContext();
    syncAppContextSnapshot();
    globalThis.__cupnetAppContext = appCtx;

    // Non-critical modules loaded after window is shown
    setImmediate(() => {
        harExporter = require('../har-exporter');
        rulesEngine = require('../rules-engine');
        syncAppContextSnapshot();
    });

    // Start MITM proxy in background so first window appears immediately
    if (STEALTH >= 5) {
        console.log('[stealth] MITM startup skipped (level >= 5)');
        mitmReady = true;
        syncAppContextSnapshot();
        notifyMitmReady();
    }
    if (STEALTH < 5) mitmStartPromise = startMitmProxy().then(async proxy => {
        const { session: electronSession } = require('electron');
        const caCertPem = proxy.getCACert(); // eslint-disable-line no-unused-vars

        function trustMitmCA(sess) {
            sess.setCertificateVerifyProc((_, callback) => callback(0));
        }

        if (STEALTH < 4) {
            tabManager.setTrustMitmCA(trustMitmCA);
            tabManager.setMitmTabUpstreamCleanup((tid) => {
                if (mitmProxy && typeof mitmProxy.removeTabUpstream === 'function') mitmProxy.removeTabUpstream(tid);
            });
            trustMitmCA(electronSession.fromPartition(tabManager.partitionForGroup(1)));
            trustMitmCA(electronSession.fromPartition('persist:cupnet-shared'));
        } else {
            console.log('[stealth] trustMitmCA skipped (level >= 4)');
        }

        await applyEffectiveTrafficMode(getCurrentTrafficMode(), persistentAnonymizedProxyUrl, {
            source: 'startup',
            force: true,
        }).catch((e) => {
            safeCatch({ module: 'main', eventCode: 'traffic.mode.apply.failed', context: { source: 'startup' } }, e);
        });

        const startupProfile = loadSettings().tlsProfile || 'chrome';
        proxy.setBrowser(startupProfile);
        syncDnsOverridesToMitm();
        _syncDnsOverrideHostsSet();
        console.log(`[main] MITM startup profile: ${startupProfile}`);
        mitmReady = true;
        startupMetrics.mitmReadyTs = Date.now();
        syncAppContextSnapshot();
        notifyMitmReady();
        maybeLogStartupMetrics();

        // Push stats to all windows every second (only if something changed)
        let _prevStatsJson = '';
        const statsBroadcast = setInterval(() => {
            if (!mitmProxy) return;
            const stats = mitmProxy.getStats();
            stabilityMetrics.gauges.queueDepth = Number(stats.workerQueueDepth || 0);
            stabilityMetrics.gauges.workerRestarts = Number(stats.workerRestarts || 0);
            if (db?.getWriteQueueStats) {
                const q = db.getWriteQueueStats();
                stabilityMetrics.gauges.dbWriteQueueHighDepth = Number(q?.highPriorityDepth || 0);
                stabilityMetrics.gauges.dbWriteQueueLowDepth = Number(q?.lowPriorityDepth || 0);
                stabilityMetrics.gauges.dbWriteQueueDroppedLow = Number(q?.droppedLow || 0);
                stabilityMetrics.gauges.dbWriteQueueDroppedHigh = Number(q?.droppedHigh || 0);
            }
            if (networkPolicy.slo.enabled) {
                if (stabilityMetrics.gauges.queueDepth >= networkPolicy.slo.queueDepthWarn) {
                    emitSloWarnOnce('slo.queue_depth_high', {
                        queueDepth: stabilityMetrics.gauges.queueDepth,
                        threshold: networkPolicy.slo.queueDepthWarn,
                    });
                }
                if (stabilityMetrics.gauges.p95LatencyMs >= networkPolicy.slo.p95LatencyMsWarn) {
                    emitSloWarnOnce('slo.p95_latency_high', {
                        p95LatencyMs: stabilityMetrics.gauges.p95LatencyMs,
                        threshold: networkPolicy.slo.p95LatencyMsWarn,
                    });
                }
                if (stabilityMetrics.gauges.workerRestarts >= networkPolicy.slo.workerRestartsWarnPerHour) {
                    emitSloWarnOnce('slo.worker_restarts_high', {
                        restarts: stabilityMetrics.gauges.workerRestarts,
                        threshold: networkPolicy.slo.workerRestartsWarnPerHour,
                    });
                }
            }
            syncAppContextSnapshot();
            if (_lastPendingForTracking == null) {
                _lastPendingForTracking = Number(stats.pending) || 0;
            } else {
                const tracking = getTrackingSettings();
                const pendingNow = Number(stats.pending) || 0;
                const delta = Math.abs(pendingNow - _lastPendingForTracking);
                if (tracking.onNetworkPendingChange && delta >= tracking.pendingDeltaThreshold) {
                    requestScreenshot({
                        reason: 'network-pending',
                        meta: { pending: pendingNow, prevPending: _lastPendingForTracking, delta },
                    }).catch((err) => {
                        safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'network-pending' } }, err, 'info');
                    });
                }
                _lastPendingForTracking = pendingNow;
            }

            const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
            if (!wins.length) return;
            const json  = `${stats.requests}|${stats.pending}|${stats.errors}|${stats.avgMs}|${stats.reqPerSec}|${stats.browser}`;
            if (json === _prevStatsJson) return;
            _prevStatsJson = json;
            wins.forEach(w => w.webContents.send('mitm-stats-update', stats));
        }, 1000);
        app.on('before-quit', () => clearInterval(statsBroadcast));

        const mouseTrackingTimer = setInterval(() => {
            const tracking = getTrackingSettings();
            if (!tracking.onMouseActivity) return;
            if (!isWindowActive) return;
            if (Date.now() - lastMouseMoveTime > 6000) return;
            requestScreenshot({ reason: 'mouse-activity' }).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'mouse-activity' } }, err, 'info');
            });
        }, 5000);
        app.on('before-quit', () => clearInterval(mouseTrackingTimer));

        return proxy;
    }).catch(e => {
        console.error('[main] MITM proxy failed to start:', e.message);
        mitmReady = false;
        syncAppContextSnapshot();
        notifyMitmReady();
    });


    const { buildIpcScopeObject } = require('./ipc/build-ipc-scope-delegates.js');
    const ipcScopeWritableKeys = new Set(['actProxy', 'activeFingerprint', 'compareResult', 'connectedProfileId', 'connectedProfileName', 'connectedResolvedVars', 'currentSessionId', 'hadLoggingBeenStopped', 'isLoggingEnabled', 'lastMouseMoveTime', 'logEntryCount', 'persistentAnonymizedProxyUrl']);
    /** @type {string[]} */
    const ipcScopeKeyList = require('./ipc/ipc-scope-key-list.json');
    function ipcScopeGet(k) {
        switch (k) {
            case 'BrowserWindow': return BrowserWindow;
            case 'CaptchaSolverError': return CaptchaSolverError;
            case 'ExternalProxyPort': return ExternalProxyPort;
            case 'ProxyChain': return ProxyChain;
            case '_analyzeCaptchaScript': return _analyzeCaptchaScript;
            case '_analyzeEndpointsCollectScript': return _analyzeEndpointsCollectScript;
            case '_analyzeFormsScript': return _analyzeFormsScript;
            case '_analyzeMetaScript': return _analyzeMetaScript;
            case '_broadcastCompareUpdated': return _broadcastCompareUpdated;
            case '_broadcastLogEntryToViewers': return _broadcastLogEntryToViewers;
            case '_comparePayload': return _comparePayload;
            case '_confidence': return _confidence;
            case '_cupnetRoot': return _cupnetRoot;
            case '_lastPointerByTabId': return _lastPointerByTabId;
            case '_pairScore': return _pairScore;
            case '_reqWithCompareOptions': return _reqWithCompareOptions;
            case '_requestsForSessionAsc': return _requestsForSessionAsc;
            case '_serializeCompareRowRequest': return _serializeCompareRowRequest;
            case '_wcIdToTabId': return _wcIdToTabId;
            case 'actProxy': return actProxy;
            case 'activeExtPorts': return activeExtPorts;
            case 'activeFingerprint': return activeFingerprint;
            case 'app': return app;
            case 'applyBypassDomains': return applyBypassDomains;
            case 'applyEffectiveTrafficMode': return applyEffectiveTrafficMode;
            case 'applyFingerprintToAllTabs': return applyFingerprintToAllTabs;
            case 'applyFingerprintFromProfile': return applyFingerprintFromProfile;
            case 'applyTrafficFilters': return applyTrafficFilters;
            case 'broadcastInterceptRuleMatched': return broadcastInterceptRuleMatched;
            case 'broadcastTlsProfileChanged': return broadcastTlsProfileChanged;
            case 'buildMenu': return buildMenu;
            case 'bundleUtils': return bundleUtils;
            case 'checkCurrentIpGeo': return checkCurrentIpGeo;
            case 'clipboard': return clipboard;
            case 'comparePair': return comparePair;
            case 'compareResult': return compareResult;
            case 'compareViewerWindow': return compareViewerWindow;
            case 'connectProxyWithFailover': return connectProxyWithFailover;
            case 'connectedProfileId': return connectedProfileId;
            case 'connectedProfileName': return connectedProfileName;
            case 'connectedResolvedVars': return connectedResolvedVars;
            case 'cookieManagerWindow': return cookieManagerWindow;
            case 'consoleCaptureApi': return consoleCaptureApi;
            case 'consoleViewerWindow': return consoleViewerWindow;
            case 'createCompareViewerWindow': return createCompareViewerWindow;
            case 'createConsoleViewerWindow': return createConsoleViewerWindow;
            case 'createCookieManagerWindow': return createCookieManagerWindow;
            case 'createDnsManagerWindow': return createDnsManagerWindow;
            case 'createIvacScoutWindow': return createIvacScoutWindow;
            case 'createLogViewerWindow': return createLogViewerWindow;
            case 'createLoggingModalWindow': return createLoggingModalWindow;
            case 'createNotesWindow': return createNotesWindow;
            case 'createPageAnalyzerWindow': return createPageAnalyzerWindow;
            case 'createProxyManagerWindow': return createProxyManagerWindow;
            case 'createRequestEditorWindow': return createRequestEditorWindow;
            case 'openRequestEditorWindow': return openRequestEditorWindow;
            case 'openRequestEditorNewWindow': return openRequestEditorNewWindow;
            case 'createRulesWindow': return createRulesWindow;
            case 'createTraceViewerWindow': return createTraceViewerWindow;
            case 'currentSessionId': return currentSessionId;
            case 'db': return db;
            case 'dialog': return dialog;
            case 'diffUtils': return diffUtils;
            case 'dnsManagerWindow': return dnsManagerWindow;
            case 'extPortErrors': return extPortErrors;
            case 'extPortsStore': return extPortsStore;
            case 'fs': return fs;
            case 'generatePassword': return generatePassword;
            case 'getCapmonsterSettings': return getCapmonsterSettings;
            case 'getCurrentTrafficMode': return getCurrentTrafficMode;
            case 'getInternalPageUrl': return getInternalPageUrl;
            case 'getIvacScoutContext': return getIvacScoutContext;
            case 'getLiveLogViewerWindow': return getLiveLogViewerWindow;
            case 'getLocalIp': return getLocalIp;
            case 'getNewTabUrl': return getNewTabUrl;
            case 'getTrackingSettings': return getTrackingSettings;
            case 'hadLoggingBeenStopped': return hadLoggingBeenStopped;
            case 'harExporter': return harExporter;
            case 'interceptor': return interceptor;
            case 'ipcMain': return ipcMain;
            case 'isLoggingEnabled': return isLoggingEnabled;
            case 'isValidDnsHost': return isValidDnsHost;
            case 'isValidIpv4': return isValidIpv4;
            case 'ivacScoutWindow': return ivacScoutWindow;
            case 'lastMouseMoveTime': return lastMouseMoveTime;
            case 'loadJsonDiffModules': return loadJsonDiffModules;
            case 'loadSettings': return loadSettings;
            case 'loggingModalWindow': return loggingModalWindow;
            case 'logEntryCount': return logEntryCount;
            case 'logViewerInitSessions': return logViewerInitSessions;
            case 'logViewerWindow': return logViewerWindow;
            case 'logViewerWindows': return logViewerWindows;
            case 'mainWindow': return mainWindow;
            case 'maybeLogStartupMetrics': return maybeLogStartupMetrics;
            case 'mitmProxy': return mitmProxy;
            case 'mitmReady': return mitmReady;
            case 'nativeImage': return nativeImage;
            case 'netFetchWithTimeout': return netFetchWithTimeout;
            case 'networkPolicy': return networkPolicy;
            case 'normalizeCapmonsterSettings': return normalizeCapmonsterSettings;
            case 'normalizeTrackingSettings': return normalizeTrackingSettings;
            case 'normalizeTrafficMode': return normalizeTrafficMode;
            case 'notifyCookieManagerTabs': return notifyCookieManagerTabs;
            case 'notifyCookieGroupsListsUpdated': return notifyCookieGroupsListsUpdated;
            case 'notifyProxyProfilesList': return notifyProxyProfilesList;
            case 'notifyProxyStatus': return notifyProxyStatus;
            case 'notesWindow': return notesWindow;
            case 'pageAnalyzerWindow': return pageAnalyzerWindow;
            case 'parseFallbackProxyList': return parseFallbackProxyList;
            case 'parseProxyTemplate': return parseProxyTemplate;
            case 'path': return path;
            case 'persistentAnonymizedProxyUrl': return persistentAnonymizedProxyUrl;
            case 'proxyManagerWindow': return proxyManagerWindow;
            case 'proxyResilience': return proxyResilience;
            case 'quickChangeProxy': return quickChangeProxy;
            case 'reattachInterceptorToAllTabs': return reattachInterceptorToAllTabs;
            case 'requestScreenshot': return requestScreenshot;
            case 'resetFingerprintOnWebContents': return resetFingerprintOnWebContents;
            case 'resolveNavigationUrl': return resolveNavigationUrl;
            case 'requestEditorExtraWindows': return requestEditorExtraWindows;
            case 'requestEditorWindow': return requestEditorWindow;
            case 'rulesWindow': return rulesWindow;
            case 'runIvacScoutProcess': return runIvacScoutProcess;
            case 'safeCatch': return safeCatch;
            case 'safeStorage': return safeStorage;
            case 'saveSettings': return saveSettings;
            case 'sendLogStatus': return sendLogStatus;
            case 'session': return session;
            case 'settingsStore': return settingsStore;
            case 'setupNetworkLogging': return setupNetworkLogging;
            case 'shell': return shell;
            case 'solveTurnstileWithCapMonster': return solveTurnstileWithCapMonster;
            case 'stabilityMetrics': return stabilityMetrics;
            case 'startupMetrics': return startupMetrics;
            case 'stopIvacScoutProcess': return stopIvacScoutProcess;
            case 'syncDnsOverridesToMitm': return syncDnsOverridesToMitm;
            case 'sysLog': return sysLog;
            case 'tabManager': return tabManager;
            case 'testProxy': return testProxy;
            case 'traceWindows': return traceWindows;
            case 'uiPrefsStore': return uiPrefsStore;
            case 'withTimeout': return withTimeout;
            default: return undefined;
        }
    }
    function ipcScopeSet(k, v) {
        switch (k) {
            case 'actProxy': actProxy = v; break;
            case 'activeFingerprint': activeFingerprint = v; break;
            case 'compareResult': compareResult = v; break;
            case 'connectedProfileId': connectedProfileId = v; break;
            case 'connectedProfileName': connectedProfileName = v; break;
            case 'connectedResolvedVars': connectedResolvedVars = v; break;
            case 'currentSessionId': currentSessionId = v; break;
            case 'hadLoggingBeenStopped': hadLoggingBeenStopped = v; break;
            case 'isLoggingEnabled': isLoggingEnabled = v; break;
            case 'lastMouseMoveTime': lastMouseMoveTime = v; break;
            case 'logEntryCount': logEntryCount = v; break;
            case 'persistentAnonymizedProxyUrl': persistentAnonymizedProxyUrl = v; break;
            default: throw new Error("IPC read-only: " + k);
        }
        syncAppContextSnapshot();
    }
    const ipcScope = buildIpcScopeObject(ipcScopeKeyList, ipcScopeWritableKeys, ipcScopeGet, ipcScopeSet);
    const { registerAllMainIpc } = require('./ipc/register-all.js');
    registerAllMainIpc(ipcScope);


    // Ensure default external port exists on first run
    const extConfig = extPortsStore.loadExtPortsConfig();
    if (extConfig.ports.length === 0) {
        const defaultPort = { port: 7777, name: 'Default', login: 'cupnet', password: generatePassword(), autoStart: false };
        extConfig.ports.push(defaultPort);
        extPortsStore.saveExtPortsConfig(extConfig);
        sysLog('info', 'ext-proxy', `Created default external port 9001 (first run)`);
    }
    // External ports are started manually via the UI widget on new-tab page

    const { attachWindowSwitcherHotkey } = require('./services/window-switcher-hotkey.js');
    app.on('browser-window-created', (_, win) => {
        attachWindowSwitcherHotkey(win, () => mainWindow);
    });

    // Start app window after IPC handlers are registered, but without waiting for MITM readiness.
    createMainWindow();
    syncAppContextSnapshot();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
        syncAppContextSnapshot();
    });
});

app.on('before-quit', (e) => {
    if (forceAppQuit) return;
    e.preventDefault();
    if (!confirmExitDialog(mainWindow)) return;
    forceAppQuit = true;
    syncAppContextSnapshot();
    app.quit();
});

app.on('will-quit', () => {
    stopIvacScoutProcess();
    ipcBatch.disposePendingBatches();
    if (logStatusInterval) clearInterval(logStatusInterval);
    settingsStore.cancelPendingSave();
    if (typeof consoleCaptureApi.dispose === 'function') consoleCaptureApi.dispose();
    if (notifyTabsDebounce.id) { clearTimeout(notifyTabsDebounce.id); notifyTabsDebounce.id = null; }
    if (mitmProxy) {
        try { mitmProxy.stop(); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'worker.shutdown.failed', context: { stage: 'will-quit' } }, err);
        }
    }
    if (persistentAnonymizedProxyUrl) {
        try { require('proxy-chain').closeAnonymizedProxy(persistentAnonymizedProxyUrl, true); } catch (e) { sysLog('warn', 'proxy', 'closeAnonymizedProxy on quit failed: ' + (e?.message || e)); }
    }
    for (const [port, entry] of activeExtPorts) {
        try { entry.instance.stop(); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'proxy.shutdown.failed', context: { port } }, err);
        }
        try {
            if (entry.sessionId && db) {
                db.endSessionAsync(entry.sessionId).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'endSessionOnQuit', port } }, err);
                });
            }
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'endSessionOnQuit', port } }, err);
        }
    }
    activeExtPorts.clear();
    if (tabManager) tabManager.destroyAll();
    if (db) {
        if (currentSessionId) {
            db.endSessionAsync(currentSessionId).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'endCurrentSessionOnQuit', sessionId: currentSessionId } }, err);
            });
        }
        db.close();
    }
    flushOnExit();
});

app.on('window-all-closed', () => {
    app.quit();
});

} // end attachMainProcess

module.exports = { attachMainProcess };
