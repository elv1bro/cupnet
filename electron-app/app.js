const { sysLog, safeCatch, flushOnExit, initIPC: initSysLogIPC } = require('./sys-log');

const {
    app, BrowserWindow, ipcMain, session, Menu, dialog,
    net, shell, nativeImage, clipboard, safeStorage, Notification
} = require('electron');
const ProxyChain = require('proxy-chain');
const crypto = require('crypto');
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

// ─── Single instance lock (one CupNet per host/user session) ─────────────────
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
    process.exit(0);
}

app.on('second-instance', () => {
    // Prevent starting a second backend stack (MITM/AzureTLS ports).
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    sysLog('error', 'process', 'unhandledRejection: ' + msg);
});

process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    sysLog('critical', 'process', 'uncaughtException: ' + msg);
});

// ─── Module imports (loaded after app.whenReady for safeStorage) ─────────────
let db          = null;
let tabManager  = null;
let harExporter = null;
let rulesEngine = null;
let interceptor = null;

const getAssetPath = (name) => path.join(__dirname, name);

// ─── Pure utilities (no Electron deps — also used by tests) ──────────────────
const {
    resolveNavigationUrl,
    parseProxyTemplate,
    extractTemplateVars,
    formatBytes,
    shouldFilterUrl: _shouldFilterUrl,
    SEARCH_ENGINE,
} = require('./utils');
const bundleUtils = require('./bundle-utils');
const diffUtils = require('./diff-utils');
const { solveTurnstileWithCapMonster, CaptchaSolverError } = require('./captcha-solver');
const { networkPolicy } = require('./network-policy');
const { ProxyResilienceManager } = require('./proxy-resilience');
const { normalizeTrafficMode, resolveSessionProxyConfig } = require('./traffic-mode-router');

// Re-export shouldFilterUrl under the same name used throughout this file
const shouldFilterUrl = _shouldFilterUrl;

// ─── MITM Proxy (required lazily inside app.whenReady) ───────────────────────
let mitmProxy = null;
const { MitmProxy, ExternalProxyPort } = require('./mitm-proxy.js');

async function startMitmProxy() {
    if (mitmProxy) return mitmProxy;
    const s = cachedSettings || loadSettings();
    // CA already generated at startup (for NODE_EXTRA_CA_CERTS)
    mitmProxy = new MitmProxy({
        port:       8877,
        browser:    'chrome_120',
        workerPath: path.join(__dirname, 'azure-tls-worker.js'),
        onRequestLogged: (entry) => {
            let tabId = entry.tabId ?? null;
            if (!tabId) {
                const active = tabManager?.getActiveTab();
                if (active) tabId = active.id;
            }
            const sessionId = entry.sessionId != null ? entry.sessionId : currentSessionId;
            _recordLatencySample(entry.duration);
            if (entry?.dnsOverride?.host && entry?.dnsOverride?.ip) {
                const dOv = entry.dnsOverride;
                const rw = dOv.rewriteHost ? ` Host:${dOv.rewriteHost}` : '';
                broadcastDnsRuleMatched({
                    ruleName: `${dOv.host} -> ${dOv.ip}${rw}`,
                    host: dOv.host,
                    ip: dOv.ip,
                    url: entry.url || '',
                    method: entry.method || 'GET',
                    tabId: tabId || null,
                    sessionId: sessionId ?? null,
                });
            } else if (entry?.dnsCorsMatch?.host && entry?.dnsCorsMatch?.pattern) {
                const cm = entry.dnsCorsMatch;
                broadcastDnsRuleMatched({
                    ruleName: `${cm.pattern} -> ${cm.host} (CORS)`,
                    host: cm.host,
                    ip: '',
                    url: entry.url || '',
                    method: entry.method || 'GET',
                    tabId: tabId || null,
                    sessionId: sessionId ?? null,
                });
            }

            // Trace mode: full request/response to DB + live update to trace window
            const s = cachedSettings || loadSettings();
            if (s.traceMode && db) {
                try {
                    const traceRow = {
                        ts: new Date().toISOString(),
                        method: entry.method,
                        url: entry.url,
                        requestHeaders: entry.requestHeaders || {},
                        requestBody: entry.requestBody || null,
                        status: entry.status,
                        responseHeaders: entry.responseHeaders || {},
                        responseBody: entry.responseBody,
                        duration: entry.duration,
                        tabId: tabId || null,
                        sessionId: sessionId != null ? sessionId : null,
                        browser: s.tlsProfile || 'chrome',
                        proxy: persistentAnonymizedProxyUrl ? '(set)' : null,
                    };
                    const insertPromise = typeof db.insertTraceEntryQueued === 'function'
                        ? db.insertTraceEntryQueued(traceRow)
                        : db.insertTraceEntryAsync(traceRow);
                    insertPromise.then((traceId) => {
                        if (!traceId || traceWindows.length === 0) return;
                        const summary = { id: traceId, ts: traceRow.ts, method: entry.method, url: entry.url, status: entry.status, duration_ms: entry.duration };
                        for (const w of traceWindows) {
                            if (!w.isDestroyed()) w.webContents.send('new-trace-entry', summary);
                        }
                    }).catch((err) => {
                        safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'insertTraceEntryQueued' } }, err);
                    });
                } catch (e) { console.error('[trace] insert failed:', e.message); }
            }

            if (!isLoggingEnabled || !db) return;
            if (mitmProxy) return;
            if (!tabId || sessionId == null) return;
            const reqId = entry.requestId;
            if (reqId) {
                if (_seenRequestIds.has(reqId)) return;
                _seenRequestIds.add(reqId);
                if (_seenRequestIds.size > 5000) {
                    const iter = _seenRequestIds.values();
                    for (let i = 0; i < 2500; i++) iter.next();
                    const keep = new Set();
                    for (const v of iter) keep.add(v);
                    _seenRequestIds.clear();
                    for (const v of keep) _seenRequestIds.add(v);
                }
            } else {
                const dedupKey = `${sessionId}:${tabId}:${entry.url}:${entry.method}:${entry.status}`;
                const now = Date.now();
                const last = _lastMitmLogKey.get(dedupKey);
                if (last != null && now - last < MITM_DEDUP_MS) return;
                _lastMitmLogKey.set(dedupKey, now);
                if (_lastMitmLogKey.size > 500) {
                    const cutoff = now - 2000;
                    for (const k of _lastMitmLogKey.keys()) {
                        if (_lastMitmLogKey.get(k) < cutoff) _lastMitmLogKey.delete(k);
                    }
                }
            }
            try {
                const logEntry = {
                    id: entry.requestId || `mitm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                    url: entry.url,
                    method: entry.method,
                    status: entry.status,
                    type: entry.type || 'Document',
                    request:  { headers: entry.requestHeaders || {}, body: entry.requestBody || null },
                    response: { statusCode: entry.status, headers: entry.responseHeaders || {}, mimeType: null },
                    duration: entry.duration,
                    duration_ms: entry.duration,
                    responseBody: entry.responseBody || null,
                };
                const sessId = parseInt(String(sessionId), 10) || sessionId;
                db.insertRequestAsync(sessId, tabId, {
                    requestId: entry.requestId || logEntry.id,
                    url: logEntry.url,
                    method: logEntry.method,
                    status: logEntry.response?.statusCode,
                    type: logEntry.type,
                    duration: logEntry.duration,
                    requestHeaders: logEntry.request?.headers,
                    responseHeaders: logEntry.response?.headers,
                    requestBody: entry.requestBody || null,
                    responseBody: logEntry.responseBody,
                }).then((dbId) => {
                    if (dbId) logEntry.id = dbId;
                    logEntryCount++;
                    _broadcastLogEntryToViewers({ ...logEntry, tabId, sessionId: sessId });
                }).catch((err) => {
                    console.error('[main] MITM log insert failed:', err?.message || err);
                });
            } catch (e) {
                console.error('[main] MITM log insert failed:', e.message);
            }
        },
    });
    mitmProxy.setTlsPassthroughDomains(s?.trafficOpts?.tlsPassthroughDomains || ['challenges.cloudflare.com']);
    if (mitmProxy?.worker) {
        mitmProxy.worker.on('worker-exited', (ev) => {
            stabilityMetrics.gauges.workerRestarts = Number(ev?.restartCount) || stabilityMetrics.gauges.workerRestarts;
            emitStabilityEvent('warn', 'worker.exited', {
                code: ev?.code ?? null,
                restartInMs: ev?.delayMs ?? null,
                restartCount: ev?.restartCount ?? null,
            });
        });
        mitmProxy.worker.on('worker-ready', () => {
            emitStabilityEvent('info', 'worker.ready');
        });
        mitmProxy.worker.on('worker-request-timeout', (ev) => {
            stabilityMetrics.counters.workerTimeouts++;
            emitStabilityEvent('warn', 'worker.request_timeout', {
                timeoutMs: ev?.timeoutMs ?? null,
                requestId: ev?.id || '',
            });
        });
        mitmProxy.worker.on('worker-overloaded', (ev) => {
            stabilityMetrics.counters.workerOverloaded++;
            if (ev?.queueDepth != null) stabilityMetrics.gauges.queueDepth = ev.queueDepth;
            emitStabilityEvent('warn', 'worker.overloaded', ev || {});
        });
    }
    await mitmProxy.start();
    console.log('[main] MITM proxy started on', mitmProxy.getProxyUrl());
    return mitmProxy;
}

// ─── UI preferences (shared across all tabs, persisted to disk) ──────────────
let UI_PREFS_PATH = null;
let _uiPrefs = null;
function loadUiPrefs() {
    if (!UI_PREFS_PATH) UI_PREFS_PATH = path.join(app.getPath('userData'), 'ui-prefs.json');
    if (_uiPrefs) return _uiPrefs;
    try { _uiPrefs = JSON.parse(fs.readFileSync(UI_PREFS_PATH, 'utf8')); }
    catch { _uiPrefs = {}; }
    return _uiPrefs;
}
function saveUiPref(key, value) {
    const prefs = loadUiPrefs();
    prefs[key] = value;
    try { fs.writeFileSync(UI_PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf8'); }
    catch (e) { console.error('[ui-prefs] write error:', e.message); }
}

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// Read bypass domains early (before app.whenReady) for Chromium proxy bypass hints.
// Proxy route itself is controlled dynamically via session.setProxy (MITM vs browser proxy).
{
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
// Accept MITM self-signed certs (required when using proxy with fake TLS)
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'default_public_interface_only');
app.commandLine.appendSwitch('enable-webrtc-hide-local-ips-with-mdns', 'true');
app.commandLine.appendSwitch('disable-webgl-debug-renderer-info');

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
let ivacScoutWindow            = null;
const comparePair              = { left: null, right: null };

function confirmExitDialog(win) {
    const owner = (win && !win.isDestroyed()) ? win : (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]);
    const choice = dialog.showMessageBoxSync(owner, {
        type: 'question',
        buttons: ['Cancel', 'Exit'],
        defaultId: 1,
        cancelId: 0,
        title: 'Exit [CupNet]',
        message: 'Close [CupNet] and all windows?',
        detail: 'All browser windows, proxy workers, and active sessions will be closed.',
        noLink: true,
    });
    return choice === 1;
}
let loggingModalWindow         = null;
let ivacScoutProcess           = null;
let persistentAnonymizedProxyUrl = null;
let connectedProfileId           = null;
let connectedProfileName         = null;
let connectedResolvedVars        = {};
let currentTrafficMode           = 'mitm';
let isLoggingEnabled           = false;
let hadLoggingBeenStopped      = false; // true after first explicit stop; controls modal on re-enable
let currentSessionId           = null;
let logStatusInterval          = null;
let cachedSettings             = null;
let logEntryCount              = 0;
let lastScreenshotBuffer       = null; // for dedup comparison
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
const screenshotCooldownByReason = new Map();
let screenshotLimiterWindow    = [];
let _lastPendingForTracking    = null;
const _wcIdToTabId             = new Map(); // webContents.id -> tabId
const _lastPointerByTabId      = new Map(); // tabId -> { xNorm, yNorm, ts }
let _lastProxyStatusSig        = '';
let _lastTlsProfileBroadcast   = null;
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

// Batch log-entry IPC to avoid renderer jank on high traffic.
const LOG_IPC_BATCH_MS = 50;
const LOG_IPC_BATCH_MAX = 200;
const _logIpcQueues = new Map(); // webContents.id -> { entries, timer, win }
const INTERCEPT_IPC_BATCH_MS = 80;
const INTERCEPT_IPC_BATCH_MAX = 100;
const _interceptIpcQueues = new Map(); // webContents.id -> { entries, timer, win }
const _recentInterceptEvents = [];
const RECENT_INTERCEPT_MAX = 120;
const DNS_IPC_BATCH_MS = 80;
const DNS_IPC_BATCH_MAX = 100;
const _dnsIpcQueues = new Map(); // webContents.id -> { entries, timer, win }
const _recentDnsEvents = [];
const RECENT_DNS_MAX = 150;

function _flushLogIpcQueue(wcId) {
    const q = _logIpcQueues.get(wcId);
    if (!q) return;
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    const win = q.win;
    if (!win || win.isDestroyed()) {
        _logIpcQueues.delete(wcId);
        return;
    }
    const entries = q.entries.splice(0, q.entries.length);
    if (!entries.length) return;
    try {
        win.webContents.send('new-log-entry-batch', entries);
    } catch (err) {
        safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'new-log-entry-batch' } }, err);
    }
}

function _enqueueLogEntryIpc(win, entry) {
    if (!win || win.isDestroyed()) return;
    const wcId = win.webContents.id;
    let q = _logIpcQueues.get(wcId);
    if (!q) {
        q = { entries: [], timer: null, win };
        _logIpcQueues.set(wcId, q);
    } else {
        q.win = win;
    }
    q.entries.push(entry);
    if (q.entries.length >= LOG_IPC_BATCH_MAX) {
        _flushLogIpcQueue(wcId);
        return;
    }
    if (!q.timer) {
        q.timer = setTimeout(() => _flushLogIpcQueue(wcId), LOG_IPC_BATCH_MS);
    }
}

function _broadcastLogEntryToViewers(entry) {
    for (const w of logViewerWindows) {
        _enqueueLogEntryIpc(w, entry);
    }
}

function _flushInterceptIpcQueue(wcId) {
    const q = _interceptIpcQueues.get(wcId);
    if (!q) return;
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    const win = q.win;
    if (!win || win.isDestroyed()) {
        _interceptIpcQueues.delete(wcId);
        return;
    }
    const entries = q.entries.splice(0, q.entries.length);
    if (!entries.length) return;
    try {
        win.webContents.send('intercept-rule-matched-batch', entries);
    } catch (err) {
        safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'intercept-rule-matched-batch' } }, err);
    }
}

function _enqueueInterceptIpc(win, info) {
    if (!win || win.isDestroyed()) return;
    const wcId = win.webContents.id;
    let q = _interceptIpcQueues.get(wcId);
    if (!q) {
        q = { entries: [], timer: null, win };
        _interceptIpcQueues.set(wcId, q);
    } else {
        q.win = win;
    }
    q.entries.push(info);
    if (q.entries.length >= INTERCEPT_IPC_BATCH_MAX) {
        _flushInterceptIpcQueue(wcId);
        return;
    }
    if (!q.timer) {
        q.timer = setTimeout(() => _flushInterceptIpcQueue(wcId), INTERCEPT_IPC_BATCH_MS);
    }
}

function broadcastInterceptRuleMatched(info) {
    const event = { ...info, ts: info?.ts || Date.now() };
    _recentInterceptEvents.push(event);
    if (_recentInterceptEvents.length > RECENT_INTERCEPT_MAX) {
        _recentInterceptEvents.splice(0, _recentInterceptEvents.length - RECENT_INTERCEPT_MAX);
    }
    _enqueueInterceptIpc(mainWindow, event);
    for (const w of logViewerWindows) _enqueueInterceptIpc(w, event);
    _enqueueInterceptIpc(rulesWindow, event);
}

function _flushDnsIpcQueue(wcId) {
    const q = _dnsIpcQueues.get(wcId);
    if (!q) return;
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    const win = q.win;
    if (!win || win.isDestroyed()) {
        _dnsIpcQueues.delete(wcId);
        return;
    }
    const entries = q.entries.splice(0, q.entries.length);
    if (!entries.length) return;
    try {
        win.webContents.send('dns-rule-matched-batch', entries);
    } catch (err) {
        safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'dns-rule-matched-batch' } }, err);
    }
}

function _enqueueDnsIpc(win, info) {
    if (!win || win.isDestroyed()) return;
    const wcId = win.webContents.id;
    let q = _dnsIpcQueues.get(wcId);
    if (!q) {
        q = { entries: [], timer: null, win };
        _dnsIpcQueues.set(wcId, q);
    } else {
        q.win = win;
    }
    q.entries.push(info);
    if (q.entries.length >= DNS_IPC_BATCH_MAX) {
        _flushDnsIpcQueue(wcId);
        return;
    }
    if (!q.timer) {
        q.timer = setTimeout(() => _flushDnsIpcQueue(wcId), DNS_IPC_BATCH_MS);
    }
}

function broadcastDnsRuleMatched(info) {
    const event = { ...info, ts: info?.ts || Date.now() };
    _recentDnsEvents.push(event);
    if (_recentDnsEvents.length > RECENT_DNS_MAX) {
        _recentDnsEvents.splice(0, _recentDnsEvents.length - RECENT_DNS_MAX);
    }
    _enqueueDnsIpc(mainWindow, event);
    _enqueueDnsIpc(dnsManagerWindow, event);
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

function broadcastTlsProfileChanged(profile) {
    if (!profile) return;
    if (_lastTlsProfileBroadcast === profile) return;
    _lastTlsProfileBroadcast = profile;
    BrowserWindow.getAllWindows().forEach(w => {
        try { if (!w.isDestroyed()) w.webContents.send('tls-profile-changed', profile); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'tls-profile-changed' } }, err, 'info');
        }
    });
}

// ─── External Proxy Ports ────────────────────────────────────────────────────
const activeExtPorts = new Map(); // port → { instance: ExternalProxyPort, sessionId, config }
const extPortErrors  = new Map(); // port → error string (set when start fails)

function getExtPortsConfigPath() {
    return path.join(resolveUserDataDir(), 'ext-ports.json');
}

function loadExtPortsConfig() {
    try {
        const raw = fs.readFileSync(getExtPortsConfigPath(), 'utf8');
        return JSON.parse(raw);
    } catch { return { ports: [] }; }
}

function saveExtPortsConfig(config) {
    try { fs.writeFileSync(getExtPortsConfigPath(), JSON.stringify(config, null, 2)); } catch (e) {
        sysLog('warn', 'ext-proxy', 'Failed to save ext-ports config: ' + (e?.message || e));
    }
}

function getLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

function generatePassword(len = 8) {
    return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

const MOUSE_ACTIVITY_TIMEOUT = 90000;
const settingsFilePath = path.join(app.getPath('userData'), 'settings.json');
const iconPath = fs.existsSync(getAssetPath('icons/icon.png'))
    ? getAssetPath('icons/icon.png')
    : getAssetPath('img.png');

function applyRuntimeAppIcon() {
    try {
        const img = nativeImage.createFromPath(iconPath);
        if (img.isEmpty()) return;
        // macOS dev mode: Electron bundle icon is default, force Dock icon at runtime.
        if (process.platform === 'darwin' && app.dock) {
            app.dock.setIcon(img);
        }
    } catch (e) {
        console.warn('[icon] applyRuntimeAppIcon failed:', e.message);
    }
}

// ─── Console capture (stdout/stderr → console viewer window) ──────────────────
const _consoleBuffer = [];
const _CONSOLE_BUFFER_MAX = 3000;
let _consoleBatchTimer = null;
let _consoleBatch = [];

function _flushConsoleBatch() {
    _consoleBatchTimer = null;
    if (!_consoleBatch.length) return;
    const batch = _consoleBatch;
    _consoleBatch = [];
    if (consoleViewerWindow && !consoleViewerWindow.isDestroyed()) {
        consoleViewerWindow.webContents.send('console-log', batch);
    }
}

function captureConsoleLine(text) {
    const clean = text.replace(/\n+$/, '');
    if (!clean) return;
    const lines = clean.split('\n');
    for (const line of lines) {
        if (!line) continue;
        const entry = { text: line, ts: Date.now() };
        _consoleBuffer.push(entry);
        if (_consoleBuffer.length > _CONSOLE_BUFFER_MAX) {
            _consoleBuffer.splice(0, 1000);
        }
        _consoleBatch.push(entry);
    }
    if (!_consoleBatchTimer) {
        _consoleBatchTimer = setTimeout(_flushConsoleBatch, 60);
    }
}

const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = function (chunk, encoding, callback) {
    captureConsoleLine(typeof chunk === 'string' ? chunk : chunk.toString());
    return _origStdoutWrite(chunk, encoding, callback);
};
process.stderr.write = function (chunk, encoding, callback) {
    captureConsoleLine(typeof chunk === 'string' ? chunk : chunk.toString());
    return _origStderrWrite(chunk, encoding, callback);
};

// ─── Settings ─────────────────────────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
    lastLogPath: null,
    filterPatterns: ['*google.com*', '*cloudflare.com*', '*analytics*', '*tracking*'],
    homepage: '',
    pasteUnlock: true,
    traceMode: false,
    currentProxy: '',
    effectiveTrafficMode: 'mitm',
    tracking: {
        onUserClick: true,
        onPageLoadComplete: true,
        onNetworkPendingChange: true,
        onMouseActivity: false,
        onTypingEnd: true,
        onScrollEnd: false,
        onRuleMatchScreenshot: true,
        pendingDeltaThreshold: 3,
        cooldownMs: 2000,
        maxPerMinute: 12,
    },
    bypassDomains: ['challenges.cloudflare.com'],
    trafficOpts: {
        trafficEnabled: false,
        blockImages: false,
        blockCSS: false,
        blockFonts: false,
        blockMedia: false,
        blockWebSocket: false,
        tlsPassthroughDomains: ['challenges.cloudflare.com'],
        captchaWhitelist: [
            '*.google.com', '*.gstatic.com', '*.recaptcha.net',
            'challenges.cloudflare.com', '*.cloudflare.com',
            '*.hcaptcha.com', 'turnstile.com', '*.turnstile.com',
        ],
    },
    capmonster: {
        apiKey: '',
        autoInject: true,
        autoSubmit: false,
        pollTimeoutMs: 90000,
        pollIntervalMs: 3000,
    },
};

function loadSettings() {
    if (cachedSettings) return cachedSettings;
    try {
        if (fs.existsSync(settingsFilePath)) {
            const raw = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
            cachedSettings = {
                ...SETTINGS_DEFAULTS,
                ...raw,
                trafficOpts: { ...SETTINGS_DEFAULTS.trafficOpts, ...(raw.trafficOpts || {}) },
                tracking: normalizeTrackingSettings(raw.tracking),
                capmonster: normalizeCapmonsterSettings(raw.capmonster),
            };
            currentTrafficMode = normalizeTrafficMode(cachedSettings.effectiveTrafficMode);
            return cachedSettings;
        }
    } catch (e) {
        sysLog('warn', 'settings', 'Failed to load settings: ' + e.message);
    }
    cachedSettings = {
        ...SETTINGS_DEFAULTS,
        tracking: normalizeTrackingSettings(),
        capmonster: normalizeCapmonsterSettings(),
    };
    currentTrafficMode = normalizeTrafficMode(cachedSettings.effectiveTrafficMode);
    return cachedSettings;
}

let _saveSettingsTimer = null;
function saveSettings(s) {
    cachedSettings = s;
    if (_saveSettingsTimer) clearTimeout(_saveSettingsTimer);
    _saveSettingsTimer = setTimeout(() => {
        _saveSettingsTimer = null;
        fs.writeFile(settingsFilePath, JSON.stringify(s, null, 2), (err) => {
            if (err) sysLog('warn', 'settings', 'Failed to save: ' + err.message);
        });
    }, 300);
}

function normalizeTrackingSettings(raw) {
    const base = SETTINGS_DEFAULTS.tracking;
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        onUserClick: src.onUserClick !== false,
        onPageLoadComplete: src.onPageLoadComplete !== false,
        onNetworkPendingChange: src.onNetworkPendingChange !== false,
        onMouseActivity: src.onMouseActivity === true,
        onTypingEnd: src.onTypingEnd !== false,
        onScrollEnd: src.onScrollEnd === true,
        onRuleMatchScreenshot: src.onRuleMatchScreenshot !== false,
        pendingDeltaThreshold: Math.max(1, Math.min(50, Number(src.pendingDeltaThreshold) || base.pendingDeltaThreshold)),
        cooldownMs: Math.max(200, Math.min(30000, Number(src.cooldownMs) || base.cooldownMs)),
        maxPerMinute: Math.max(1, Math.min(120, Number(src.maxPerMinute) || base.maxPerMinute)),
    };
}

function normalizeCapmonsterSettings(raw) {
    const base = SETTINGS_DEFAULTS.capmonster;
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        apiKey: String(src.apiKey || '').trim(),
        autoInject: src.autoInject !== false,
        autoSubmit: src.autoSubmit === true,
        pollTimeoutMs: Math.max(30000, Math.min(180000, Number(src.pollTimeoutMs) || base.pollTimeoutMs)),
        pollIntervalMs: Math.max(1000, Math.min(10000, Number(src.pollIntervalMs) || base.pollIntervalMs)),
    };
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

function getInternalPageUrl(pageName) {
    const name = String(pageName || '').trim().toLowerCase();
    let file = 'new-tab.html';
    if (name === 'settings') file = 'settings.html';
    else if (name === 'guide') file = 'cupnet-guide.html';
    return `file://${path.join(__dirname, file)}`;
}

/** Returns the URL to open in a new tab (homepage or built-in new-tab page). */
function getNewTabUrl() {
    const hp = cachedSettings?.homepage?.trim();
    if (hp) return hp;
    return getInternalPageUrl('new-tab');
}

// ─── MITM bypass domains ──────────────────────────────────────────────────────
const HARDCODED_BYPASS = ['<local>', '*.youtube.com', '*.googlevideo.com'];

function getCurrentTrafficMode() {
    return normalizeTrafficMode(currentTrafficMode);
}

function buildBypassList(userDomains) {
    const all = [...HARDCODED_BYPASS, ...(userDomains || [])];
    return [...new Set(all)].join(',');
}

function getMitmProxyOpts() {
    return resolveSessionProxyConfig({
        bypassRules: buildBypassList((cachedSettings || loadSettings()).bypassDomains),
    });
}

async function applyEffectiveTrafficMode(mode, upstreamProxyUrl, context = {}) {
    const nextMode = normalizeTrafficMode(mode);
    const prevMode = getCurrentTrafficMode();
    const sameProxy = String(upstreamProxyUrl || '') === String(persistentAnonymizedProxyUrl || '');
    const sameMode = prevMode === nextMode;
    if (sameMode && sameProxy && !context.force) return;
    if (!sameMode) {
        sysLog('info', 'traffic.mode.changed', `mode ${prevMode} -> ${nextMode}`);
    }

    const defaultSessionOpts = getMitmProxyOpts();

    currentTrafficMode = nextMode;
    if (interceptor?.setTrafficMode) interceptor.setTrafficMode(nextMode);
    mitmProxy?.setUpstream(upstreamProxyUrl || null);

    if (tabManager?.setProxyAll) {
        await tabManager.setProxyAll(upstreamProxyUrl || null);
    }
    await session.defaultSession.setProxy(defaultSessionOpts);

    const s = loadSettings();
    s.currentProxy = upstreamProxyUrl || '';
    s.effectiveTrafficMode = nextMode;
    saveSettings(s);

    sysLog('info', 'traffic.mode.applied', `mode=${nextMode} source=${context.source || 'unknown'}`);
    notifyProxyStatus();
}

function applyBypassDomains(userDomains) {
    if (!tabManager) return;
    const bypassStr = buildBypassList(userDomains);
    tabManager.setBypassRules(bypassStr);
    applyEffectiveTrafficMode(getCurrentTrafficMode(), persistentAnonymizedProxyUrl, {
        source: 'bypass-domains',
        force: true,
    }).catch((err) => {
        safeCatch({ module: 'main', eventCode: 'traffic.mode.apply.failed', context: { source: 'bypass-domains' } }, err);
    });
    console.log('[main] bypass domains updated:', bypassStr);
}

// ─── Traffic content filters ──────────────────────────────────────────────────
function applyTrafficFilters(trafficOpts) {
    if (!tabManager) return;
    const opts = trafficOpts || {};
    tabManager.setTrafficOpts(opts);
    if (mitmProxy?.setTlsPassthroughDomains) {
        mitmProxy.setTlsPassthroughDomains(opts.tlsPassthroughDomains || ['challenges.cloudflare.com']);
    }
    console.log('[main] traffic filters updated:', JSON.stringify(opts));
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sanitizeProxyUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        throw new Error('Proxy URL must be a non-empty string');
    }
    let u;
    try {
        u = new URL(proxyUrl);
    } catch {
        // Try prepending scheme for bare host:port input like "socks5://..." without scheme
        try { u = new URL('http://' + proxyUrl); } catch {
            throw new Error(`Invalid proxy URL format: "${proxyUrl}"`);
        }
    }
    const allowed = ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'];
    if (!allowed.includes(u.protocol)) {
        throw new Error(`Unsupported proxy protocol "${u.protocol}". Allowed: ${allowed.join(', ')}`);
    }
    if (!u.hostname) throw new Error('Proxy URL is missing a hostname');
    // Return URL with password masked for safe logging
    const masked = u.password
        ? `${u.protocol}//${u.username}:***@${u.hostname}${u.port ? ':' + u.port : ''}`
        : proxyUrl;
    Object.defineProperty(sanitizeProxyUrl, '_lastMasked', { value: masked, writable: true, configurable: true });
    return proxyUrl; // original unchanged — caller uses it for actual connection
}

function withTimeout(promise, timeoutMs, timeoutMessage = 'Operation timeout') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        Promise.resolve(promise).then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}

async function netFetchWithTimeout(url, options = {}, timeoutMs = networkPolicy.timeouts.upstreamRequestMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await net.fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function getRealIp() {
    try {
        const r = await net.fetch('https://ipinfo.io/json');
        const d = await r.json();
        return d.ip || 'unknown';
    } catch { return 'unknown'; }
}

// parseProxyTemplate and extractTemplateVars imported from ./utils

/** Fetch current IP + geo info — uses direct session when no proxy is active */
let _lastIpGeoError = '';

async function checkCurrentIpGeo() {
    const empty = { ip: 'unknown', city: '', region: '', country: '', country_name: '', org: '', timezone: '' };

    const useDirectFetch = !persistentAnonymizedProxyUrl;

    async function fetchWithTimeout(url, timeoutMs = networkPolicy.timeouts.ipGeoMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            if (useDirectFetch) {
                const directSess = session.fromPartition('direct-ip-check');
                await directSess.setProxy({ mode: 'direct' });
                return await directSess.fetch(url, { signal: ctrl.signal });
            }
            return await net.fetch(url, { signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    const sources = [
        async () => {
            const r = await fetchWithTimeout('https://ipinfo.io/json');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (!d.ip) throw new Error('no ip');
            return { ip: d.ip, city: d.city || '', region: d.region || '', country: d.country || '', country_name: d.country || '', org: d.org || '', timezone: d.timezone || '' };
        },
        async () => {
            const r = await fetchWithTimeout('https://api.myip.com');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (!d.ip) throw new Error('no ip');
            return { ip: d.ip, city: '', region: '', country: d.country || '', country_name: d.country || '', org: '', timezone: '' };
        },
        async () => {
            const r = await fetchWithTimeout('https://ipapi.co/json/');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (!d.ip) throw new Error('no ip');
            return { ip: d.ip, city: d.city || '', region: d.region || '', country: d.country || '', country_name: d.country_name || d.country || '', org: d.org || '', timezone: d.timezone || '' };
        },
        async () => {
            const r = await fetchWithTimeout('https://api.ipify.org?format=json');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (!d.ip) throw new Error('no ip');
            return { ip: d.ip, city: '', region: '', country: '', country_name: '', org: '', timezone: '' };
        },
    ];

    let lastErr = null;
    for (const source of sources) {
        try {
            const result = await source();
            if (result?.ip && result.ip !== 'unknown') {
                _lastIpGeoError = '';
                return result;
            }
        } catch (e) { lastErr = e; }
    }
    const errMsg = lastErr?.message || String(lastErr);
    if (errMsg !== _lastIpGeoError) {
        console.warn('[checkIpGeo] all sources failed:', errMsg);
        _lastIpGeoError = errMsg;
    }
    return empty;
}

/** Broadcast proxy status to ALL windows, proxy manager, and all tab BrowserViews */
function notifyProxyStatus() {
    const isDirect = !persistentAnonymizedProxyUrl && actProxy === '';
    const info = {
        active:    !!persistentAnonymizedProxyUrl,
        proxyName: connectedProfileName || actProxy || '',
        mode:      isDirect ? 'direct' : (persistentAnonymizedProxyUrl ? 'proxy' : 'none'),
        trafficMode: getCurrentTrafficMode(),
        effectiveMode: getCurrentTrafficMode(),
        profileId: connectedProfileId || null,
        resolvedVars: connectedResolvedVars || {},
    };
    const sig = JSON.stringify(info);
    if (sig === _lastProxyStatusSig) return;
    _lastProxyStatusSig = sig;
    // Broadcast to every BrowserWindow (main, proxy manager, request editor, log viewer…)
    for (const win of BrowserWindow.getAllWindows()) {
        try {
            if (!win.isDestroyed()) win.webContents.send('proxy-status-changed', info);
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'proxy-status-changed.window' } }, err, 'info');
        }
    }
    // Also push to all open tab BrowserViews (e.g. new-tab.html proxy widget)
    if (tabManager) {
        for (const tab of tabManager.getAllTabs()) {
            try {
                if (tab.view && !tab.view.webContents.isDestroyed()) {
                    tab.view.webContents.send('proxy-status-changed', info);
                }
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'proxy-status-changed.tab' } }, err, 'info');
            }
        }
    }
}

function notifyMitmReady() {
    const info = { ready: !!mitmReady, ts: Date.now() };
    for (const win of BrowserWindow.getAllWindows()) {
        try {
            if (!win.isDestroyed()) win.webContents.send('mitm-ready-changed', info);
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'mitm-ready-changed.window' } }, err, 'info');
        }
    }
    if (tabManager) {
        for (const tab of tabManager.getAllTabs()) {
            try {
                if (tab.view && !tab.view.webContents.isDestroyed()) {
                    tab.view.webContents.send('mitm-ready-changed', info);
                }
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'mitm-ready-changed.tab' } }, err, 'info');
            }
        }
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

/** Broadcast updated proxy profiles list to proxy manager + main window */
function notifyProxyProfilesList() {
    const list = db.getProxyProfiles();
    if (proxyManagerWindow && !proxyManagerWindow.isDestroyed()) {
        proxyManagerWindow.webContents.send('proxy-profiles-list', list);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proxy-profiles-list', list);
    }
}

// Track webContents that already have CDP attached so we don't double-register
const _cdpAttachedWc = new WeakSet();
const _trackingLoadAttachedWc = new WeakSet();

// Deduplicate MITM logs: by requestId (Chrome's unique ID) when available; else by url+method+status within 400ms
const _seenRequestIds = new Set();
const _lastMitmLogKey = new Map(); // key -> timestamp (fallback when no requestId)
const MITM_DEDUP_MS = 400;

// ─── CDP network logging ──────────────────────────────────────────────────────
async function setupNetworkLogging(webContents, tabId, sessionId) {
    if (!webContents || webContents.isDestroyed()) return;
    if (!isLoggingEnabled && !activeFingerprint) return;
    _wcIdToTabId.set(webContents.id, tabId);
    const ongoingRequests   = new Map();
    const ongoingWebsockets = new Map();
    // ExtraInfo queue: for redirect chains Chrome fires responseReceivedExtraInfo
    // once per hop with the same requestId. We buffer them in arrival order and
    // consume one entry per finalized response (redirect or final).
    const extraInfoQueue    = new Map(); // requestId → [{headers}, ...]
    const cdp = webContents.debugger;

    if (!_trackingLoadAttachedWc.has(webContents)) {
        _trackingLoadAttachedWc.add(webContents);
        webContents.on('did-finish-load', () => {
            try {
                if (!tabManager || tabManager.getActiveTabId() !== tabId) return;
                requestScreenshot({ reason: 'page-load', meta: { tabId } }).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'page-load', tabId } }, err, 'info');
                });
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'page-load', tabId } }, err, 'info');
            }
        });
        webContents.once('destroyed', () => _trackingLoadAttachedWc.delete(webContents));
    }

    // Periodic stale-entry cleanup: requests that never got loadingFinished/Failed
    // (e.g. cancelled by navigation) would otherwise live in the Map forever.
    const _staleCleanupTimer = setInterval(() => {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [id, entry] of ongoingRequests) {
            if ((entry._addedAt || 0) < cutoff) ongoingRequests.delete(id);
        }
        for (const [id, entry] of ongoingWebsockets) {
            if ((entry.created || 0) < cutoff) ongoingWebsockets.delete(id);
        }
        for (const [id, queue] of extraInfoQueue) {
            if (queue._addedAt && queue._addedAt < cutoff) extraInfoQueue.delete(id);
        }
    }, 60_000);
    webContents.once('destroyed', () => {
        clearInterval(_staleCleanupTimer);
        _wcIdToTabId.delete(webContents.id);
        ongoingRequests.clear();
        ongoingWebsockets.clear();
        extraInfoQueue.clear();
    });

    // Detach existing listeners cleanly before re-attaching (e.g. after clear-logs)
    if (_cdpAttachedWc.has(webContents)) {
        try {
            cdp.removeAllListeners('message');
            cdp.removeAllListeners('detach');   // C1: prevent listener accumulation
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'cdp.detach.failed', context: { phase: 'reattach.remove-listeners', tabId } }, err, 'info');
        }
    } else {
        try {
            if (!cdp.isAttached()) cdp.attach('1.3');
        } catch (err) {
            console.error('[CDP] Failed to attach:', err.message);
            return;
        }
        _cdpAttachedWc.add(webContents);
        webContents.on('destroyed', () => _cdpAttachedWc.delete(webContents));
        // detach logger only on first attach — re-attaches remove it via removeAllListeners above
        cdp.on('detach', (_reason) => console.log('[CDP] Detached:', _reason));
    }

    // Large buffer sizes ensure HTML page bodies are retained for getResponseBody.
    // Without these Chrome discards most response bodies (default ≈ 0 bytes buffered).
    await cdp.sendCommand('Network.enable', {
        maxTotalBufferSize:    isLoggingEnabled ? 100 * 1024 * 1024 : 0,
        maxResourceBufferSize:  isLoggingEnabled ? 10 * 1024 * 1024 : 0,
    }).catch((err) => {
        safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Network.enable', tabId } }, err, 'info');
    });

    await cdp.sendCommand('Network.setCacheDisabled', { cacheDisabled: !!isLoggingEnabled }).catch((err) => {
        safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Network.setCacheDisabled', tabId } }, err, 'info');
    });

    await cdp.sendCommand('Fetch.disable', {}).catch((err) => {
        safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Fetch.disable', tabId } }, err, 'info');
    });
    await cdp.sendCommand('Network.setExtraHTTPHeaders', { headers: {} }).catch((err) => {
        safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Network.setExtraHTTPHeaders.clear', tabId } }, err, 'info');
    });

    // Apply active fingerprint via CDP now that the debugger is attached
    if (activeFingerprint) {
        if (activeFingerprint.user_agent) {
            cdp.sendCommand('Emulation.setUserAgentOverride', {
                userAgent:      activeFingerprint.user_agent,
                acceptLanguage: activeFingerprint.language || '',
            }).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Emulation.setUserAgentOverride', tabId } }, err, 'info');
            });
        }
        if (activeFingerprint.timezone) {
            cdp.sendCommand('Emulation.setTimezoneOverride', {
                timezoneId: activeFingerprint.timezone,
            }).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Emulation.setTimezoneOverride', tabId } }, err, 'info');
            });
        }
    }

    const _logQueue = [];
    let _logQueueScheduled = false;
    const _processLogQueue = async () => {
        _logQueueScheduled = false;
        const batch = _logQueue.splice(0, 50);
        for (const logEntry of batch) {
        const reqKey = logEntry.id;
        logEntryCount++;

        // ── Write to SQLite ──
        try {
            if (logEntry.type === 'websocket_frame' || logEntry.type === 'websocket_closed' || logEntry.type === 'websocket_error') {
                const pl = logEntry.type === 'websocket_closed'
                    ? `__cupnet_ws_meta__:${JSON.stringify({ kind: 'closed', frames: logEntry.framesCount ?? 0 })}`
                    : logEntry.type === 'websocket_error'
                        ? `__cupnet_ws_meta__:${JSON.stringify({ kind: 'error', error: String(logEntry.error || '') })}`
                        : (logEntry.data || null);
                const bump = await db.insertWsEventAsync(
                    sessionId, tabId, logEntry.url || '', logEntry.direction || 'recv', pl,
                    logEntry.connectionId || null
                );
                if (bump && logViewerWindows.length > 0) {
                    for (const w of logViewerWindows) {
                        if (!w.isDestroyed()) w.webContents.send('ws-handshake-message-count', bump);
                    }
                }
            } else if (logEntry.type === 'screenshot') {
                await db.insertScreenshotAsync(sessionId, tabId, logEntry.path, logEntry.imageData || null, logEntry.screenshotMeta || null);
            } else {
                // insertRequest returns the SQLite integer id — store it on logEntry
                // so the log viewer can call getRequestDetail(id) for lazy header/body load.
                const dbId = await db.insertRequestAsync(sessionId, tabId, {
                    requestId: logEntry.id,
                    url: logEntry.url,
                    method: logEntry.method,
                    status: logEntry.response?.statusCode || null,
                    type: logEntry.type,
                    duration: logEntry.duration || null,
                    requestHeaders: logEntry.request?.headers || null,
                    responseHeaders: logEntry.response?.headers || null,
                    requestBody: logEntry.request?.body || null,
                    responseBody: logEntry.responseBody || null,
                    error: logEntry.error || null
                });
                if (dbId) logEntry.id = dbId; // replace CDP string id with real DB integer id

                // Run rules engine (may not be loaded yet during early startup)
                if (rulesEngine) {
                    try {
                        const matched = rulesEngine.evaluate({
                            url: logEntry.url,
                            method: logEntry.method,
                            status: logEntry.response?.statusCode,
                            type: logEntry.type,
                            duration_ms: logEntry.duration,
                            response_body: logEntry.responseBody
                        });
                        if (matched.length) {
                            const actions = rulesEngine.buildActions(matched);
                            handleRuleActions(actions, logEntry);
                        }
                    } catch (err) {
                        safeCatch({ module: 'main', eventCode: 'rules.engine.failed', context: { tabId, url: logEntry.url || '' } }, err);
                    }
                }
            }
        } catch (e) {
            console.error('[DB] insertRequest failed:', e.message);
        }

        // ── Forward to log viewer (WS frames only in DB / Messages tab) ──
        if (logViewerWindows.length > 0) {
            const skipWs = logEntry.type === 'websocket_frame'
                || logEntry.type === 'websocket_closed'
                || logEntry.type === 'websocket_error';
            if (!skipWs) {
                const msg = { ...logEntry, tabId, sessionId };
                _broadcastLogEntryToViewers(msg);
            }
        }

        ongoingRequests.delete(reqKey);
        }
        if (_logQueue.length) {
            _logQueueScheduled = true;
            setImmediate(() => {
                _processLogQueue().catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'processLogQueue', tabId } }, err);
                });
            });
        }
    };
    const finalizeLog = (logEntry) => {
        _logQueue.push(logEntry);
        if (!_logQueueScheduled) {
            _logQueueScheduled = true;
            setImmediate(() => {
                _processLogQueue().catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'processLogQueue.schedule', tabId } }, err);
                });
            });
        }
    };

    cdp.on('message', async (_, method, params) => {
        if (!isLoggingEnabled) return;

        const settings      = cachedSettings || loadSettings();
        const filterPatterns = settings.filterPatterns || [];

        // ── WebSocket events ──────────────────────────────────────────────────
        if (method === 'Network.webSocketCreated') {
            if (shouldFilterUrl(params.url, filterPatterns)) return;
            ongoingWebsockets.set(params.requestId, {
                id: params.requestId, url: params.url, created: Date.now(), frames: []
            });
        }
        if (method === 'Network.webSocketFrameSent') {
            const ws = ongoingWebsockets.get(params.requestId);
            if (ws) finalizeLog({
                type: 'websocket_frame',
                direction: 'send',
                url: ws.url,
                data: params.response.payloadData,
                connectionId: params.requestId,
            });
        }
        if (method === 'Network.webSocketFrameReceived') {
            const ws = ongoingWebsockets.get(params.requestId);
            if (ws) finalizeLog({
                type: 'websocket_frame',
                direction: 'recv',
                url: ws.url,
                data: params.response.payloadData,
                connectionId: params.requestId,
            });
        }
        if (method === 'Network.webSocketClosed') {
            const ws = ongoingWebsockets.get(params.requestId);
            if (ws) {
                finalizeLog({
                    type: 'websocket_closed',
                    url: ws.url,
                    framesCount: ws.frames.length,
                    connectionId: params.requestId,
                });
                ongoingWebsockets.delete(params.requestId);
            }
        }
        if (method === 'Network.webSocketFrameError') {
            const ws = ongoingWebsockets.get(params.requestId);
            if (ws) finalizeLog({
                type: 'websocket_error',
                url: ws.url,
                error: params.errorMessage,
                connectionId: params.requestId,
            });
        }

        // ── HTTP requests ─────────────────────────────────────────────────────
        // Skip CDP HTTP logging when MITM is active — MITM logs all proxy traffic (302+200)
        // to avoid duplicates (CDP would report merged navigation as single 200)
        if (method === 'Network.requestWillBeSent' && mitmProxy) return;
        if (method === 'Network.requestWillBeSent') {
            const { requestId, request, timestamp, type, redirectResponse } = params;
            if (request.url.startsWith('data:')) return;

            // Redirect chain: Chrome reuses requestId. Finalize the previous entry
            // (with the redirect status 301/302) before creating the new one.
            if (redirectResponse) {
                const prevEntry = ongoingRequests.get(requestId);
                const queue = extraInfoQueue.get(requestId) || [];
                const extraH = queue.shift() || (prevEntry && prevEntry._extraHeaders) || {};
                if (!queue.length) extraInfoQueue.delete(requestId);

                if (prevEntry && !prevEntry._finalizing) {
                    prevEntry._finalizing = true;
                    ongoingRequests.delete(requestId);
                    // redirectResponse.headers is filtered — merge with full ExtraInfo set
                    prevEntry.response = {
                        statusCode: redirectResponse.status,
                        headers:    Object.assign({}, redirectResponse.headers, extraH),
                        mimeType:   redirectResponse.mimeType || null,
                    };
                    prevEntry.duration = Math.round((timestamp - prevEntry.startTime) * 1000);
                    prevEntry.responseBody = null;
                    finalizeLog(prevEntry);
                } else {
                    // prevEntry missing (e.g. first request filtered) — create synthetic redirect entry
                    // so 302 with Set-Cookie is always visible in Network Activity
                    const redirectUrl = redirectResponse.url || request.url;
                    if (!shouldFilterUrl(redirectUrl, filterPatterns)) {
                        finalizeLog({
                            id: requestId + '_redirect', url: redirectUrl, method: request.method,
                            startTime: timestamp - 0.001, type: type,
                            request:  { headers: {}, body: null },
                            response: {
                                statusCode: redirectResponse.status,
                                headers:    Object.assign({}, redirectResponse.headers, extraH),
                                mimeType:   redirectResponse.mimeType || null,
                            },
                            duration: 0, responseBody: null, _addedAt: Date.now(),
                        });
                    }
                }
            }

            if (shouldFilterUrl(request.url, filterPatterns)) return;
            ongoingRequests.set(requestId, {
                id: requestId, url: request.url, method: request.method,
                startTime: timestamp, type,
                request: { headers: request.headers, body: request.postData || null },
                response: null, responseBody: null,
                _addedAt: Date.now(),
            });
        }
        // Chrome strips Cookie from requestWillBeSent.request.headers.
        // requestWillBeSentExtraInfo has the FULL request headers including Cookie
        // and associatedCookies list. Fires after requestWillBeSent so entry exists.
        if (method === 'Network.requestWillBeSentExtraInfo') {
            const entry = ongoingRequests.get(params.requestId);
            if (entry) {
                // Overwrite with full headers (superset of filtered headers)
                if (params.headers) {
                    entry.request = entry.request || {};
                    entry.request.headers = Object.assign({}, entry.request.headers, params.headers);
                }
                // Store associated cookies explicitly for the Cookies tab
                if (params.associatedCookies?.length) {
                    entry._sentCookies = params.associatedCookies
                        .filter(ac => !ac.blockedReasons?.length)
                        .map(ac => ({ name: ac.cookie.name, value: ac.cookie.value }));
                    // Also inject into Cookie header so parseRequestCookies finds them
                    const cookieStr = entry._sentCookies.map(c => `${c.name}=${c.value}`).join('; ');
                    if (cookieStr) entry.request.headers['Cookie'] = cookieStr;
                }
            }
        }
        if (method === 'Network.responseReceived') {
            const entry = ongoingRequests.get(params.requestId);
            if (entry) entry.response = { statusCode: params.response.status, headers: params.response.headers, mimeType: params.response.mimeType };
        }
        // Chrome strips Set-Cookie (and others) from responseReceived.headers.
        // responseReceivedExtraInfo has the FULL response headers.
        // For redirect chains the same requestId fires ExtraInfo once per hop — use a queue.
        if (method === 'Network.responseReceivedExtraInfo') {
            const extraHeaders = params.headers || {};
            const queue = extraInfoQueue.get(params.requestId);
            if (queue) {
                queue.push(extraHeaders);
            } else {
                extraInfoQueue.set(params.requestId, [extraHeaders]);
            }
            // Merge immediately into ongoing entry if response already arrived
            const entry = ongoingRequests.get(params.requestId);
            if (entry) {
                entry._extraHeaders = extraHeaders;
                if (entry.response) {
                    entry.response.headers = Object.assign({}, entry.response.headers, extraHeaders);
                }
            }
        }
        if (method === 'Network.loadingFinished') {
            const entry = ongoingRequests.get(params.requestId);
            // Guard: remove from map immediately to prevent double-finalizeLog
            // if loadingFailed arrives while we await getResponseBody
            if (entry && !entry._finalizing) {
                entry._finalizing = true;
                ongoingRequests.delete(params.requestId);
                entry.duration = Math.round((params.timestamp - entry.startTime) * 1000);

                // Consume the remaining ExtraInfo for the final response
                {
                    const queue = extraInfoQueue.get(params.requestId) || [];
                    const extraH = queue.shift() || entry._extraHeaders || {};
                    extraInfoQueue.delete(params.requestId);
                    if (extraH && entry.response) {
                        entry.response.headers = Object.assign({}, entry.response.headers, extraH);
                    }
                }

                // Retry loop: HTML Document bodies are sometimes not yet available
                // on the first call right after loadingFinished (timing issue).
                let rb = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        rb = await cdp.sendCommand('Network.getResponseBody', { requestId: params.requestId });
                        break; // success
                    } catch (err) {
                        const msg = err?.message || '';
                        // "No data found" / "No resource with given identifier" — buffer not ready yet
                        const isRetryable = msg.includes('No data') || msg.includes('No resource');
                        if (isRetryable && attempt < 2) {
                            await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
                        } else {
                            // Permanent failure (e.g. body too large, already discarded)
                            if (!msg.includes('No data') && !msg.includes('No resource')) {
                                console.warn(`[CDP] getResponseBody failed for ${entry.url}: ${msg}`);
                            }
                            break;
                        }
                    }
                }

                if (rb) {
                    entry.responseBody = rb.base64Encoded
                        ? `<base64|mime|${entry.response?.mimeType}|${rb.body}>`
                        : rb.body;
                } else {
                    entry.responseBody = null;
                }
                finalizeLog(entry);
            }
        }
        if (method === 'Network.loadingFailed') {
            const entry = ongoingRequests.get(params.requestId);
            if (entry && !entry._finalizing) {
                ongoingRequests.delete(params.requestId);
                entry.error = params.errorText;
                finalizeLog(entry);
            }
        }
    });

    webContents.on('destroyed', () => {
        ongoingRequests.clear();
        ongoingWebsockets.clear();
        extraInfoQueue.clear();
        try { cdp.removeAllListeners('message'); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'cdp.detach.failed', context: { phase: 'destroy.remove-listeners', tabId } }, err, 'info');
        }
        try { if (cdp.isAttached()) cdp.detach(); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'cdp.detach.failed', context: { phase: 'destroy.detach', tabId } }, err, 'info');
        }
    });
}

function handleRuleActions(actions, logEntry) {
    for (const action of actions) {
        if (action.type === 'notification') {
            // System notification (may require bundle ID on macOS in production)
            try {
                if (Notification.isSupported()) {
                    new Notification({
                        title: `Rule matched: ${action.ruleName || 'unnamed'}`,
                        body:  (logEntry.url || '').slice(0, 120),
                    }).show();
                }
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'notification.send.failed', context: { ruleName: action.ruleName || 'unnamed' } }, err, 'info');
            }
            // Always send an in-app toast regardless of system support
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('rule-notification', {
                    ruleName: action.ruleName || 'unnamed',
                    url:      logEntry.url || '',
                });
            }
        }
        if (action.type === 'highlight') {
            for (const w of logViewerWindows) {
                if (!w.isDestroyed()) w.webContents.send('rule-highlight', {
                    url: logEntry.url, color: action.color, ruleName: action.ruleName
                });
            }
        }
        if (action.type === 'screenshot') {
            requestScreenshot({ reason: 'rule', meta: { ruleName: action.ruleName || '' } }).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'rule', ruleName: action.ruleName || '' } }, err, 'info');
            });
        }
    }
}

// ─── Fingerprint / Identity ───────────────────────────────────────────────────

/** Apply UA + language on session only (no CDP — Turnstile / CF детектит debugger). */
async function applyFingerprintToWebContents(wc, fp) {
    if (!fp || !wc || wc.isDestroyed()) return;
    if (fp.user_agent) {
        try { wc.session.setUserAgent(fp.user_agent, fp.language || ''); } catch (e) { sysLog('warn', 'fingerprint', 'setUserAgent failed: ' + (e?.message || e)); }
    }
}

/** Apply fingerprint to all open tabs. */
async function applyFingerprintToAllTabs(fp) {
    if (!tabManager) return;
    for (const tab of tabManager.getAllTabs()) {
        if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
            await applyFingerprintToWebContents(tab.view.webContents, fp).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'fingerprint.apply.failed', context: { tabId: tab.id } }, err, 'info');
            });
        }
    }
}

/** Reset fingerprint overrides on a WebContents (when proxy is disconnected). */
async function resetFingerprintOnWebContents(wc) {
    if (!wc || wc.isDestroyed()) return;
    try {
        const { session: electronSession } = require('electron');
        const def = electronSession.defaultSession.getUserAgent();
        wc.session.setUserAgent(def);
    } catch (e) { sysLog('warn', 'fingerprint', 'resetFingerprintOnWebContents failed: ' + (e?.message || e)); }
}

// ─── Log status updater ───────────────────────────────────────────────────────
function startLogStatusUpdater() {
    if (logStatusInterval) clearInterval(logStatusInterval);
    let _lastSentCount = -1;
    let _lastSentSession = null;
    logStatusInterval = setInterval(() => {
        const payload = isLoggingEnabled && currentSessionId
            ? { enabled: true, sessionId: currentSessionId, count: logEntryCount }
            : { enabled: false, sessionId: null, count: 0 };
        if (payload.count === _lastSentCount && payload.sessionId === _lastSentSession) return;
        _lastSentCount   = payload.count;
        _lastSentSession = payload.sessionId;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-log-status', payload);
        }
        for (const w of logViewerWindows) {
            if (!w.isDestroyed()) w.webContents.send('update-log-status', payload);
        }
    }, 5000);
}

/** Send the current logging state immediately to the main window AND all log-viewer windows. */
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

// ─── Screenshots ──────────────────────────────────────────────────────────────
/** Capture a screenshot of the active tab and save to DB (with dedup). */
async function captureScreenshot(opts = {}) {
    try {
        const reasonRaw = typeof opts.reason === 'string' ? opts.reason : 'manual';
        const reason = reasonRaw.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'manual';
        const screenshotMeta = (opts.meta && typeof opts.meta === 'object') ? { ...opts.meta } : {};
        screenshotMeta.trigger = reason;

        // H1: skip when window is not focused/visible — avoids GPU work in background
        if (!isWindowActive) return { success: false, skipped: true, reason: 'inactive' };

        const activeTab = tabManager ? tabManager.getActiveTab() : null;
        if (!activeTab || activeTab.view.webContents.isDestroyed()) throw new Error('No active tab');

        // Skip activity timeout check (always capture when timer fires)
        const wc = activeTab.view.webContents;

        if (reason === 'click' && !screenshotMeta.click) {
            const p = _lastPointerByTabId.get(activeTab.id);
            if (p && Number.isFinite(p.xNorm) && Number.isFinite(p.yNorm) && (Date.now() - (p.ts || 0) < 15000)) {
                screenshotMeta.click = {
                    xNorm: Math.max(0, Math.min(1, Number(p.xNorm))),
                    yNorm: Math.max(0, Math.min(1, Number(p.yNorm))),
                    ts: Number(p.ts) || Date.now(),
                };
            }
        }

        // Skip home/new-tab page — don't photograph the start screen
        const currentUrl = wc.getURL() || '';
        const newTabPath = path.join(__dirname, 'new-tab.html').replace(/\\/g, '/');
        if (!currentUrl || currentUrl.startsWith('file://') && (
            currentUrl.includes('new-tab.html')
            || currentUrl.includes('cupnet-guide.html')
            || currentUrl === `file://${newTabPath}`
        )) {
            return { success: false, skipped: true, reason: 'home' };
        }

        const image  = await wc.capturePage();
        const buffer = image.toPNG();

        // Dedup: skip if identical to previous screenshot
        if (lastScreenshotBuffer && buffer.equals(lastScreenshotBuffer)) {
            return { success: false, skipped: true, reason: 'duplicate' };
        }
        lastScreenshotBuffer = buffer;

        if (isLoggingEnabled && currentSessionId) {
            const now = new Date();
            const ts  = now.toTimeString().split(' ')[0].replace(/:/g, '-');
            const ms  = now.getMilliseconds().toString().padStart(3, '0');
            const virtualPath = `autoscreen::/${reason}/${ts}.${ms}.png`;
            screenshotMeta.pageUrl = currentUrl;
            screenshotMeta.virtualPath = virtualPath;
            const b64 = buffer.toString('base64');
            const ssId = await db.insertScreenshotAsync(currentSessionId, activeTab.id, currentUrl, b64, screenshotMeta);
            logEntryCount++;
            // Don't send base64 in the live IPC event — viewer fetches it on demand to avoid memory bloat
            const entry = {
                type:       'screenshot',
                timestamp:  Date.now(),
                path:       virtualPath,
                url:        currentUrl,
                ssDbId:     ssId,          // numeric DB id for lazy fetch
                tabId:      activeTab.id,
                session_id: currentSessionId,
                created_at: now.toISOString(),
                screenshotMeta,
            };
            _broadcastLogEntryToViewers(entry);
        }
        // Notify toolbar to play flash + reset visual countdown
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('screenshot-taken');
        }
        return { success: true };
    } catch (err) {
        console.error('[Screenshot]', err.message);
        return { success: false, error: err.message };
    }
}

function isScreenshotReasonEnabled(reason, tracking) {
    switch (reason) {
        case 'click': return !!tracking.onUserClick;
        case 'page-load': return !!tracking.onPageLoadComplete;
        case 'network-pending': return !!tracking.onNetworkPendingChange;
        case 'mouse-activity': return !!tracking.onMouseActivity;
        case 'typing-end': return tracking.onTypingEnd !== false;
        case 'scroll-end': return !!tracking.onScrollEnd;
        case 'rule': return !!tracking.onRuleMatchScreenshot;
        default: return true;
    }
}

async function requestScreenshot({ reason = 'manual', force = false, meta = null, skipRateLimit = false } = {}) {
    const now = Date.now();
    const tracking = getTrackingSettings();
    if (!force && !isScreenshotReasonEnabled(reason, tracking)) {
        return { success: false, skipped: true, reason: 'trigger_disabled' };
    }

    const key = String(reason || 'manual');
    const lastByReason = screenshotCooldownByReason.get(key) || 0;
    if (!force && !skipRateLimit && now - lastByReason < tracking.cooldownMs) {
        return { success: false, skipped: true, reason: 'cooldown' };
    }
    if (!skipRateLimit) screenshotCooldownByReason.set(key, now);

    if (!skipRateLimit) {
        screenshotLimiterWindow = screenshotLimiterWindow.filter(ts => now - ts < 60_000);
        if (!force && screenshotLimiterWindow.length >= tracking.maxPerMinute) {
            return { success: false, skipped: true, reason: 'rate_limit' };
        }
    }

    const res = await captureScreenshot({ reason, meta });
    if (res?.success && !skipRateLimit) screenshotLimiterWindow.push(now);
    return res;
}

// ─── Proxy helpers ────────────────────────────────────────────────────────────
async function testProxy(upstreamProxyUrl) {
    let anonUrl = null;
    let testWin = null;
    const partition = `proxy-test-${Date.now()}`;
    try {
        anonUrl = await withTimeout(
            ProxyChain.anonymizeProxy(upstreamProxyUrl),
            networkPolicy.timeouts.proxyOperationMs,
            'Proxy anonymize timeout'
        );
        const testSession = session.fromPartition(partition, { cache: false });
        await testSession.setProxy({ proxyRules: anonUrl, proxyBypassRules: '<local>' });
        testWin = new BrowserWindow({ show: false, webPreferences: { session: testSession } });
        const loadTimer = setTimeout(() => {
            try { testWin?.destroy(); } catch (err) {
                safeCatch({ module: 'main', eventCode: 'proxy.test.failed', context: { stage: 'timeout-destroy' } }, err, 'info');
            }
        }, networkPolicy.timeouts.proxyTestMs);
        let text = '';
        try {
            await testWin.loadURL('https://ipinfo.io/json');
            text = await testWin.webContents.executeJavaScript('document.body.innerText');
        } finally {
            clearTimeout(loadTimer);
        }
        const data = JSON.parse(text);
        if (!data.ip || !data.country) throw new Error('Incomplete response');
        return { success: true, data };
    } catch (err) {
        return { success: false, error: err.message };
    } finally {
        if (testWin) testWin.destroy();
        if (anonUrl) {
            await withTimeout(
                ProxyChain.closeAnonymizedProxy(anonUrl, true),
                networkPolicy.timeouts.proxyOperationMs,
                'Proxy close timeout'
            );
        }
        try { await session.fromPartition(partition).clearStorageData(); } catch (e) { sysLog('warn', 'proxy', 'clearStorageData after proxy test failed: ' + (e?.message || e)); }
    }
}

async function quickChangeProxy(proxyUrl) {
    // Validate early — throws with a clear message on bad format
    sanitizeProxyUrl(proxyUrl);
    const masked = sanitizeProxyUrl._lastMasked || proxyUrl;
    console.log('[Proxy] Connecting:', masked);
    const oldPort = persistentAnonymizedProxyUrl
        ? Number(new URL(persistentAnonymizedProxyUrl).port) : undefined;
    try {
        if (persistentAnonymizedProxyUrl) {
            await withTimeout(
                ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true),
                networkPolicy.timeouts.proxyOperationMs,
                'Proxy close timeout'
            );
            await new Promise(r => setTimeout(r, 120));
        }
        actProxy = masked; // store masked version — never expose password in state
        persistentAnonymizedProxyUrl = oldPort
            ? await withTimeout(
                ProxyChain.anonymizeProxy({ url: proxyUrl, port: oldPort }),
                networkPolicy.timeouts.proxyOperationMs,
                'Proxy anonymize timeout'
            )
            : await withTimeout(
                ProxyChain.anonymizeProxy(proxyUrl),
                networkPolicy.timeouts.proxyOperationMs,
                'Proxy anonymize timeout'
            );
        return persistentAnonymizedProxyUrl;
    } catch (err) {
        const isBusy = err.code === 'EADDRINUSE';
        try {
            persistentAnonymizedProxyUrl = isBusy && oldPort
                ? await withTimeout(
                    ProxyChain.anonymizeProxy({ url: proxyUrl, port: oldPort }),
                    networkPolicy.timeouts.proxyOperationMs,
                    'Proxy anonymize timeout'
                )
                : await withTimeout(
                    ProxyChain.anonymizeProxy(proxyUrl),
                    networkPolicy.timeouts.proxyOperationMs,
                    'Proxy anonymize timeout'
                );
            return persistentAnonymizedProxyUrl;
        } catch (e2) {
            dialog.showErrorBox('Proxy Error', e2.message);
            throw e2;
        }
    }
}

function parseFallbackProxyList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map(v => String(v || '').trim()).filter(Boolean);
    }
    return String(raw)
        .split(/[,\n;]/)
        .map(v => v.trim())
        .filter(Boolean);
}

async function connectProxyWithFailover(primaryUrl, fallbackUrls = []) {
    const candidates = [primaryUrl, ...fallbackUrls].filter(Boolean);
    const ordered = networkPolicy.featureFlags.proxyHealthWeighted
        ? proxyResilience.orderCandidates(candidates)
        : candidates;
    let lastErr = null;
    for (let i = 0; i < ordered.length; i++) {
        const candidate = ordered[i];
        if (networkPolicy.featureFlags.proxyBreaker && !proxyResilience.canAttempt(candidate)) {
            emitStabilityEvent('warn', 'proxy.candidate_skipped', { candidate });
            continue;
        }
        try {
            const startedAt = Date.now();
            const anonymized = await quickChangeProxy(candidate);
            const latencyMs = Date.now() - startedAt;
            proxyResilience.registerSuccess(candidate, latencyMs);
            emitStabilityEvent('info', 'proxy.connect_success', { candidate, latencyMs, attempt: i + 1 });
            return { anonymized, used: candidate, attempts: i + 1 };
        } catch (e) {
            lastErr = e;
            stabilityMetrics.counters.proxyConnectFailed++;
            const res = proxyResilience.registerFailure(candidate, e);
            if (res?.event === 'quarantined') {
                stabilityMetrics.counters.proxyQuarantined++;
                emitStabilityEvent('warn', 'proxy.quarantined', {
                    candidate,
                    untilTs: res.quarantinedUntil,
                    consecutiveFailures: res.consecutiveFailures,
                });
            }
            if (res?.event === 'circuit_opened') {
                stabilityMetrics.counters.proxyCircuitOpened++;
                emitStabilityEvent('warn', 'proxy.circuit_opened', {
                    candidate,
                    openUntilTs: res.openUntil,
                    errorRatePct: res.errorRatePct,
                });
            }
            emitStabilityEvent('warn', 'proxy.connect_failed', {
                candidate,
                attempt: i + 1,
                total: ordered.length,
                error: e?.message || String(e),
            });
        }
    }
    throw (lastErr || new Error('All proxy candidates failed'));
}

// ─── Window creation ──────────────────────────────────────────────────────────
function createMainWindow() {
    if (startupMetrics.windowCreatedTs === 0) startupMetrics.windowCreatedTs = Date.now();
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, minWidth: 900, minHeight: 600,
        show: false,
        backgroundColor: '#0f1117',
        icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });
    mainWindow.loadFile(getAssetPath('browser.html'));
    mainWindow.once('ready-to-show', () => {
        applyRuntimeAppIcon();
        try { mainWindow.maximize(); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'window.lifecycle.failed', context: { op: 'maximize' } }, err, 'info');
        }
        try { mainWindow.show(); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'window.lifecycle.failed', context: { op: 'show' } }, err, 'info');
        }
    });

    mainWindow.webContents.once('did-finish-load', async () => {
        // Create first tab (once — prevents duplicate tabs on reload)
        const firstTabId = await tabManager.createTab(persistentAnonymizedProxyUrl || null, getNewTabUrl());
        tabManager.switchTab(firstTabId);
        const tab = tabManager.getTab(firstTabId);
        if (tab) {
            setupNetworkLogging(tab.view.webContents, firstTabId, tab.sessionId);
            interceptor.attachToSession(tab.tabSession, firstTabId);
            currentSessionId = tab.sessionId;
        }
        startLogStatusUpdater();
        // Clean up empty sessions from previous runs (keep current session)
        try { db.deleteEmptySessions(currentSessionId); } catch (e) { sysLog('warn', 'db', 'deleteEmptySessions failed: ' + (e?.message || e)); }


        // Send initial data to browser toolbar
        const s = loadSettings();
        tabManager.setPasteUnlock(s.pasteUnlock !== false);
        if (s.bypassDomains?.length) applyBypassDomains(s.bypassDomains);
        if (s.trafficOpts) applyTrafficFilters(s.trafficOpts);
        mainWindow.webContents.send('init-settings', {
            filterPatterns: s.filterPatterns || [],
            pasteUnlock:    s.pasteUnlock !== false,
            bypassDomains:  s.bypassDomains || [],
            tracking:       getTrackingSettings(),
        });
        notifyProxyProfilesList();
        notifyProxyStatus();
        try {
            if (_recentDnsEvents.length > 0) {
                mainWindow.webContents.send('dns-rule-matched-batch', _recentDnsEvents.slice(-100));
            }
            if (_recentInterceptEvents.length > 0) {
                mainWindow.webContents.send('intercept-rule-matched-batch', _recentInterceptEvents.slice(-80));
            }
        } catch (_) { /* ignore */ }
    });

    // Forward F12 / F5 / Ctrl+R from toolbar to active BrowserView
    mainWindow.webContents.on('before-input-event', (event, input) => {
        const tab = tabManager ? tabManager.getActiveTab() : null;
        if (!tab || tab.view.webContents.isDestroyed()) return;
        if (input.key === 'F12' && input.type === 'keyDown') {
            tab.view.webContents.toggleDevTools();
            event.preventDefault();
        }
        if ((input.key === 'F5' || (input.key === 'r' && input.control)) && input.type === 'keyDown') {
            tab.view.webContents.reload();
            event.preventDefault();
        }
    });

    mainWindow.on('focus', () => { isWindowActive = true; lastMouseMoveTime = Date.now(); });
    mainWindow.on('blur', () => { isWindowActive = false; });
    mainWindow.on('resize', () => tabManager.relayout());
    mainWindow.on('close', (e) => {
        if (forceAppQuit) return;
        if (!confirmExitDialog(mainWindow)) {
            e.preventDefault();
            return;
        }
        forceAppQuit = true;
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
        // Close all secondary windows and terminate the process
        app.quit();
    });

    tabManager.init(mainWindow, async (event, tabId, data) => {
        if (event === 'open-in-new-tab') {
            // target=_blank link — open in new tab, reuse current session for logging
            const newTabId = await tabManager.createTab(persistentAnonymizedProxyUrl || null, data.url, false, currentSessionId);
            tabManager.switchTab(newTabId);
            const newTab = tabManager.getTab(newTabId);
            if (newTab) {
                setupNetworkLogging(newTab.view.webContents, newTabId, currentSessionId);
                interceptor.attachToSession(newTab.tabSession, newTabId);
            }
            notifyCookieManagerTabs();
            return;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(event, { tabId, ...data });
        }
        // Keep cookie manager tab list in sync on title/url changes too
        if (event === 'tab-title-changed' || event === 'tab-url-changed' || event === 'url-updated') {
            notifyCookieManagerTabs();
        }
        // Notify cookie manager when the active tab switches
        if (event === 'tab-switched') {
            notifyCookieManagerTabs();
            if (cookieManagerWindow && !cookieManagerWindow.isDestroyed()) {
                cookieManagerWindow.webContents.send('set-active-tab', tabId);
            }
        }
    });

    buildMenu();
    isWindowActive = true;
    lastMouseMoveTime = Date.now();
}


function createRequestEditorWindow(data) {
    const win = new BrowserWindow({
        width: 1250, height: 780, minWidth: 760, minHeight: 540,
        title: 'Request Editor', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    win.loadFile(getAssetPath('request-editor.html'));
    win.webContents.once('did-finish-load', () => {
        win.webContents.send('request-editor-init', data);
    });
}

function createLogViewerWindow(sessionId = null) {
    // Cascade offset: each new window is shifted so it's visibly separate
    const cascadeOffset = logViewerWindows.length * 30;
    const win = new BrowserWindow({
        width: 1200, height: 860, minWidth: 800, minHeight: 500,
        title: sessionId ? `Network Activity — Session #${sessionId}` : 'Network Activity',
        icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });

    // Position with cascade offset relative to main window (or screen center)
    if (cascadeOffset > 0) {
        const [x, y] = win.getPosition();
        win.setPosition(x + cascadeOffset, y + cascadeOffset);
    }

    win.loadFile(getAssetPath('log-viewer.html'));

    // Track preselected session for this window
    const wcId = win.webContents.id;
    logViewerInitSessions.set(wcId, sessionId);

    logViewerWindows.push(win);
    logViewerWindow = win;

    win.webContents.once('did-finish-load', () => {
        const payload = isLoggingEnabled && currentSessionId
            ? { enabled: true, sessionId: currentSessionId, count: logEntryCount }
            : { enabled: false, sessionId: null, count: 0 };
        win.webContents.send('update-log-status', payload);
    });

    win.on('closed', () => {
        logViewerInitSessions.delete(wcId);
        const idx = logViewerWindows.indexOf(win);
        if (idx !== -1) logViewerWindows.splice(idx, 1);
        if (logViewerWindow === win) logViewerWindow = logViewerWindows[logViewerWindows.length - 1] || null;
    });
}

function _serializeCompareRowRequest(req) {
    if (!req) return null;
    return {
        id: req.id,
        url: req.url || '',
        method: req.method || 'GET',
        status: req.status ?? null,
        created_at: req.created_at || null,
        session_id: req.session_id ?? null,
        match_key: diffUtils.requestMatchKey(req),
    };
}


let compareResult = null;

function _comparePayload() {
    return {
        left: comparePair.left ? { ...comparePair.left } : null,
        right: comparePair.right ? { ...comparePair.right } : null,
        result: compareResult,
    };
}

function _requestsForSessionAsc(sessionId) {
    if (!sessionId) return [];
    const rows = db.queryRequestsFull({ sessionId: Number(sessionId) }, 10000, 0);
    return rows.slice().reverse();
}

function _parseHeadersMaybe(h) {
    if (!h) return {};
    if (typeof h === 'string') {
        try { return JSON.parse(h); } catch { return {}; }
    }
    if (typeof h === 'object') return { ...h };
    return {};
}

function _stripNoiseHeaders(headers, enabled) {
    if (!enabled) return headers;
    const noise = new Set([
        'date', 'expires', 'last-modified', 'etag', 'age',
        'x-request-id', 'x-correlation-id', 'x-amzn-trace-id',
        'cf-ray', 'cf-cache-status', 'server-timing',
        'x-served-by', 'x-cache', 'x-cache-hits', 'x-timer',
        'set-cookie',
    ]);
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        if (!noise.has(String(k || '').toLowerCase())) out[k] = v;
    }
    return out;
}

function _reqWithCompareOptions(req, options) {
    const out = { ...req };
    out.request_headers = _stripNoiseHeaders(_parseHeadersMaybe(req.request_headers), !!options?.removeNoiseHeaders);
    out.response_headers = _stripNoiseHeaders(_parseHeadersMaybe(req.response_headers), !!options?.removeNoiseHeaders);
    return out;
}

function _safeUrl(url) {
    try { return new URL(String(url || '')); } catch { return null; }
}

function _queryKeys(url) {
    const u = _safeUrl(url);
    if (!u) return new Set();
    return new Set(Array.from(u.searchParams.keys()).map(k => k.toLowerCase()));
}

function _pathTokens(url) {
    const u = _safeUrl(url);
    const p = u?.pathname || String(url || '').split('?')[0] || '';
    return p.split('/').filter(Boolean).map(s => s.toLowerCase());
}

function _tokenSimilarity(aTokens, bTokens) {
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    if (!a.size && !b.size) return 1;
    const inter = [...a].filter(x => b.has(x)).length;
    const union = new Set([...a, ...b]).size || 1;
    return inter / union;
}

function _statusClass(code) {
    const n = Number(code || 0);
    if (!n) return 0;
    return Math.floor(n / 100);
}

function _pairScore(leftReq, rightReq, i, j, level = 'standard') {
    const leftKey = diffUtils.requestMatchKey(leftReq);
    const rightKey = diffUtils.requestMatchKey(rightReq);
    const exactKey = leftKey && rightKey && leftKey === rightKey;
    const leftMethod = String(leftReq.method || '').toUpperCase();
    const rightMethod = String(rightReq.method || '').toUpperCase();
    const sameMethod = leftMethod === rightMethod;
    const pathSim = _tokenSimilarity(_pathTokens(leftReq.url), _pathTokens(rightReq.url));
    const sameStatusClass = _statusClass(leftReq.status) === _statusClass(rightReq.status);
    const lq = _queryKeys(leftReq.url);
    const rq = _queryKeys(rightReq.url);
    const qInter = [...lq].filter(k => rq.has(k)).length;
    const qUnion = new Set([...lq, ...rq]).size || 1;
    const qSim = qInter / qUnion;
    const indexPenalty = Math.min(Math.abs(i - j), 40);
    let score = 0;
    if (exactKey) score += 100;
    if (sameMethod) score += 18;
    score += Math.round(pathSim * (level === 'deep' ? 24 : 12));
    score += Math.round(qSim * 14);
    if (sameStatusClass) score += 6;
    score -= indexPenalty;
    const allowFallback = level === 'deep';
    const acceptable = exactKey || (allowFallback && sameMethod && pathSim >= 0.55);
    return { score, acceptable, exactKey };
}

function _confidence(score, exactKey) {
    if (exactKey && score >= 105) return 'high';
    if (score >= 80) return 'high';
    if (score >= 60) return 'medium';
    return 'low';
}


function _broadcastCompareUpdated() {
    const payload = _comparePayload();
    try {
        if (compareViewerWindow && !compareViewerWindow.isDestroyed()) {
            compareViewerWindow.webContents.send('compare-updated', payload);
        }
    } catch (err) {
        safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'compare-updated.primary' } }, err, 'info');
    }
    for (const w of logViewerWindows) {
        try {
            if (!w.isDestroyed()) w.webContents.send('compare-updated', payload);
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'compare-updated.viewer' } }, err, 'info');
        }
    }
}

function createCompareViewerWindow() {
    if (compareViewerWindow && !compareViewerWindow.isDestroyed()) {
        compareViewerWindow.focus();
        _broadcastCompareUpdated();
        return compareViewerWindow;
    }
    compareViewerWindow = new BrowserWindow({
        width: 1360,
        height: 920,
        minWidth: 980,
        minHeight: 680,
        title: 'Compare',
        icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    compareViewerWindow.loadFile(getAssetPath('compare-viewer.html'));
    compareViewerWindow.webContents.once('did-finish-load', () => {
        _broadcastCompareUpdated();
    });
    compareViewerWindow.on('closed', () => { compareViewerWindow = null; });
    return compareViewerWindow;
}

function getLiveLogViewerWindow() {
    return logViewerWindows.find(w =>
        !w.isDestroyed() && !logViewerInitSessions.get(w.webContents.id)
    ) || null;
}

function createTraceViewerWindow() {
    const win = new BrowserWindow({
        width: 1100, height: 720, minWidth: 700, minHeight: 400,
        title: 'Trace', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    win.loadFile(getAssetPath('trace-viewer.html'));
    traceWindows.push(win);
    win.on('closed', () => {
        const idx = traceWindows.indexOf(win);
        if (idx !== -1) traceWindows.splice(idx, 1);
    });
}

function createConsoleViewerWindow() {
    if (consoleViewerWindow && !consoleViewerWindow.isDestroyed()) {
        consoleViewerWindow.focus();
        return;
    }
    consoleViewerWindow = new BrowserWindow({
        width: 1000, height: 600, minWidth: 600, minHeight: 300,
        title: 'System Console', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    consoleViewerWindow.loadFile(getAssetPath('console-viewer.html'));
    consoleViewerWindow.on('closed', () => { consoleViewerWindow = null; });
}

function createPageAnalyzerWindow() {
    if (pageAnalyzerWindow && !pageAnalyzerWindow.isDestroyed()) {
        pageAnalyzerWindow.focus();
        _sendAnalyzerTabs();
        return;
    }
    pageAnalyzerWindow = new BrowserWindow({
        width: 1020, height: 700, minWidth: 700, minHeight: 450,
        title: 'Page Analyzer', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    pageAnalyzerWindow.loadFile(getAssetPath('page-analyzer.html'));
    pageAnalyzerWindow.webContents.on('did-finish-load', () => _sendAnalyzerTabs());
    pageAnalyzerWindow.on('closed', () => { pageAnalyzerWindow = null; });
}

function createIvacScoutWindow() {
    if (ivacScoutWindow && !ivacScoutWindow.isDestroyed()) {
        ivacScoutWindow.focus();
        return;
    }
    ivacScoutWindow = new BrowserWindow({
        width: 980, height: 760, minWidth: 740, minHeight: 540,
        title: 'API Scout', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    ivacScoutWindow.loadFile(getAssetPath('ivac-scout.html'));
    ivacScoutWindow.webContents.once('did-finish-load', () => {
        ivacScoutWindow.webContents.send('ivac-scout-state', { running: !!ivacScoutProcess });
    });
    ivacScoutWindow.on('closed', () => { ivacScoutWindow = null; });
}

function sendIvacScoutLog(line) {
    if (ivacScoutWindow && !ivacScoutWindow.isDestroyed()) {
        ivacScoutWindow.webContents.send('ivac-scout-log', line);
    }
}

function getIvacScoutContext() {
    const active = tabManager?.getActiveTab?.();
    const activeUrl = active?.url || '';
    const url = /^https?:\/\//i.test(activeUrl) ? activeUrl : 'https://appointment.ivacbd.com/';

    const tlsProfile = loadSettings().tlsProfile || 'chrome';
    const proxyActive = !!persistentAnonymizedProxyUrl;
    const proxyLabel = proxyActive ? (connectedProfileName || 'Proxy') : 'Direct';
    const proxyUrl = proxyActive ? persistentAnonymizedProxyUrl : '';

    return { url, tlsProfile, proxyActive, proxyLabel, proxyUrl };
}

function stopIvacScoutProcess() {
    if (!ivacScoutProcess || ivacScoutProcess.killed) return false;
    try { ivacScoutProcess.kill('SIGTERM'); } catch (err) {
        safeCatch({ module: 'main', eventCode: 'process.kill.failed', context: { process: 'ivac-scout', signal: 'SIGTERM' } }, err);
    }
    return true;
}

function runIvacScoutProcess(opts = {}) {
    return new Promise((resolve, reject) => {
        if (ivacScoutProcess) {
            reject(new Error('Scout already running'));
            return;
        }

        const scriptPath = path.join(__dirname, 'scripts', 'debug-ivac.js');
        if (!fs.existsSync(scriptPath)) {
            reject(new Error('Scout script not found: ' + scriptPath));
            return;
        }

        const args = [scriptPath];
        const ctx = getIvacScoutContext();
        const runUrl = opts.url && /^https?:\/\//i.test(String(opts.url)) ? String(opts.url) : ctx.url;
        args.push('--url', runUrl);
        if (ctx.proxyUrl) args.push('--proxy', String(ctx.proxyUrl));
        args.push('--browser', String(ctx.tlsProfile || 'chrome'));

        // In packaged app run Electron binary as node; in dev use system node.
        const isPackaged = process.defaultApp === false && !process.env.ELECTRON_IS_DEV;
        const nodeBin = isPackaged ? process.execPath : (process.platform === 'win32' ? 'node.exe' : 'node');
        const env = isPackaged
            ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
            : { ...process.env };

        ivacScoutProcess = spawn(nodeBin, args, {
            cwd: __dirname,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (ivacScoutWindow && !ivacScoutWindow.isDestroyed()) {
            ivacScoutWindow.webContents.send('ivac-scout-state', { running: true });
        }

        let settled = false;
        const settle = (ok, payload) => {
            if (settled) return;
            settled = true;
            resolve({ ok, ...payload });
        };

        ivacScoutProcess.stdout.setEncoding('utf8');
        ivacScoutProcess.stderr.setEncoding('utf8');

        ivacScoutProcess.stdout.on('data', (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (line.trim()) sendIvacScoutLog(line);
            }
        });
        ivacScoutProcess.stderr.on('data', (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (line.trim()) sendIvacScoutLog('[stderr] ' + line);
            }
        });

        ivacScoutProcess.on('error', (err) => {
            sendIvacScoutLog('[main] spawn error: ' + err.message);
            ivacScoutProcess = null;
            if (ivacScoutWindow && !ivacScoutWindow.isDestroyed()) {
                ivacScoutWindow.webContents.send('ivac-scout-state', { running: false });
                ivacScoutWindow.webContents.send('ivac-scout-done', { ok: false, exitCode: -1, error: err.message });
            }
            settle(false, { exitCode: -1, error: err.message });
        });

        ivacScoutProcess.on('close', (code) => {
            const exitCode = Number.isInteger(code) ? code : -1;
            let summary = null;
            try {
                const summaryPath = path.join(__dirname, '_debug', 'summary.json');
                if (fs.existsSync(summaryPath)) {
                    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
                }
            } catch (e) {
                sendIvacScoutLog('[main] summary parse error: ' + e.message);
            }
            ivacScoutProcess = null;
            if (ivacScoutWindow && !ivacScoutWindow.isDestroyed()) {
                ivacScoutWindow.webContents.send('ivac-scout-state', { running: false });
                ivacScoutWindow.webContents.send('ivac-scout-done', { ok: exitCode === 0, exitCode, summary });
            }
            settle(exitCode === 0, { exitCode, summary });
        });
    });
}

function _sendAnalyzerTabs() {
    if (!pageAnalyzerWindow || pageAnalyzerWindow.isDestroyed() || !tabManager) return;
    pageAnalyzerWindow.webContents.send('analyzer-tabs-list', tabManager.getTabList());
}

const _analyzeFormsScript = `function(){
    var forms = document.querySelectorAll('form');
    var result = [];
    forms.forEach(function(form, fi) {
        var f = { index: fi, id: form.id||'', name: form.name||'', action: form.action||'', method: (form.method||'GET').toUpperCase(), className: form.className||'', fields: [] };
        var els = form.elements;
        for (var i=0; i<els.length; i++) {
            var el = els[i];
            var tag = el.tagName.toLowerCase();
            if (tag==='fieldset') continue;
            var cs = window.getComputedStyle(el);
            var visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && el.offsetWidth > 0;
            f.fields.push({
                index: i, tag: tag, type: el.type||'', name: el.name||'', id: el.id||'',
                value: (el.type==='file') ? '' : (el.value||'').substring(0,500),
                placeholder: el.placeholder||'',
                hidden: el.type==='hidden', readonly: el.readOnly||false, disabled: el.disabled||false,
                required: el.required||false, visible: visible,
                className: (el.className||'').substring(0,100),
                options: tag==='select' ? Array.from(el.options).map(function(o){return{value:o.value,text:o.text,selected:o.selected}}).slice(0,50) : undefined
            });
        }
        result.push(f);
    });
    return result;
}`;

const _analyzeCaptchaScript = `function(){
    var r = { recaptcha: [], hcaptcha: [], turnstile: [], other: [], pageUrl: location.href };
    function addTurnstile(item){
        if(!item) return;
        var sk = String(item.sitekey || '');
        var frame = String(item.iframeSrc || '');
        var ex = r.turnstile.some(function(x){
            return String(x.sitekey||'')===sk && String(x.iframeSrc||'')===frame && String(x.selector||'')===String(item.selector||'');
        });
        if(!ex) r.turnstile.push(item);
    }

    /* ── reCAPTCHA v2 (widget divs) ── */
    document.querySelectorAll('.g-recaptcha, [data-sitekey]').forEach(function(el){
        var sk = el.getAttribute('data-sitekey')||'';
        if (!sk) { var s=document.querySelector('script[src*="recaptcha"]'); if(s){var m=(s.src||'').match(/[?&]render=([^&]+)/);if(m)sk=m[1];} }
        r.recaptcha.push({ version:'v2', sitekey:sk, action:'', dataS:el.getAttribute('data-s')||'',
            callback:el.getAttribute('data-callback')||'', theme:el.getAttribute('data-theme')||'light',
            size:el.getAttribute('data-size')||'normal', selector:'.g-recaptcha', iframe:false });
    });

    /* ── reCAPTCHA v3 (script-based) ── */
    document.querySelectorAll('script[src*="recaptcha/api.js"]').forEach(function(s){
        var m=(s.src||'').match(/[?&]render=([^&]+)/);
        if(m && m[1]!=='explicit'){
            var exists=r.recaptcha.some(function(x){return x.sitekey===m[1]&&x.version==='v3'});
            if(!exists) r.recaptcha.push({version:'v3',sitekey:m[1],action:'',dataS:'',callback:'',theme:'',size:'invisible',selector:'script[src*=recaptcha]',iframe:false});
        }
    });

    /* ── reCAPTCHA v2 enterprise ── */
    document.querySelectorAll('script[src*="recaptcha/enterprise.js"]').forEach(function(s){
        var m=(s.src||'').match(/[?&]render=([^&]+)/);
        if(m){
            var exists=r.recaptcha.some(function(x){return x.sitekey===m[1]});
            if(!exists) r.recaptcha.push({version:'enterprise',sitekey:m[1],action:'',dataS:'',callback:'',theme:'',size:'',selector:'script[src*=enterprise]',iframe:false});
        }
    });

    /* ── hCaptcha ── */
    document.querySelectorAll('.h-captcha, [data-hcaptcha-widget-id]').forEach(function(el){
        r.hcaptcha.push({ sitekey:el.getAttribute('data-sitekey')||'', theme:el.getAttribute('data-theme')||'',
            size:el.getAttribute('data-size')||'normal', selector:'.h-captcha', iframe:false });
    });

    /* ── Cloudflare Turnstile (div-based) ── */
    document.querySelectorAll('.cf-turnstile, [data-turnstile-widget-id]').forEach(function(el){
        r.turnstile.push({ sitekey:el.getAttribute('data-sitekey')||'', action:el.getAttribute('data-action')||'',
            cData:el.getAttribute('data-cdata')||'', theme:el.getAttribute('data-theme')||'auto',
            size:el.getAttribute('data-size')||'normal', selector:'.cf-turnstile', iframe:false });
    });

    /* ── iframe-based detection (reCAPTCHA, hCaptcha, Turnstile / challenge-platform) ── */
    document.querySelectorAll('iframe').forEach(function(f){
        var s=f.src||'';
        if(s.includes('google.com/recaptcha') || s.includes('recaptcha/api2') || s.includes('recaptcha/enterprise')){
            var m=s.match(/[?&]k=([^&]+)/);
            var sk=m?m[1]:'';
            var isV3=s.includes('size=invisible');
            var exists=r.recaptcha.some(function(x){return x.sitekey===sk});
            if(!exists) r.recaptcha.push({version:isV3?'v3':'v2',sitekey:sk,action:'',dataS:'',callback:'',theme:'',size:isV3?'invisible':'normal',selector:'iframe',iframeSrc:s.substring(0,300),iframe:true});
        }
        if(s.includes('hcaptcha.com')){
            var m2=s.match(/[?&]sitekey=([^&]+)/);
            var exists2=r.hcaptcha.some(function(x){return x.sitekey===(m2?m2[1]:'')});
            if(!exists2) r.hcaptcha.push({sitekey:m2?m2[1]:'',theme:'',size:'normal',selector:'iframe',iframeSrc:s.substring(0,300),iframe:true});
        }
        if(s.includes('challenges.cloudflare.com') || s.includes('turnstile')){
            var m3=s.match(/\\/([0-9a-zA-Z_-]{20,})/);
            var sk3=m3?m3[1]:'';
            if(!sk3){var p=s.split('/');for(var i=0;i<p.length;i++){if(p[i]&&p[i].startsWith('0x')){sk3=p[i];break;}}}
            var exists3=r.turnstile.some(function(x){return x.sitekey===sk3&&x.iframeSrc===s.substring(0,300)});
            if(!exists3) r.turnstile.push({sitekey:sk3,action:'managed',cData:'',theme:'auto',size:'normal',selector:'iframe',iframeSrc:s.substring(0,300),iframe:true});
        }
    });

    /* ── Check scripts for dynamically loaded captchas ── */
    document.querySelectorAll('script').forEach(function(s){
        var src=s.src||'';
        if(src.includes('hcaptcha.com/1/api.js')){
            var m=src.match(/[?&]sitekey=([^&]+)/);
            if(m&&!r.hcaptcha.some(function(x){return x.sitekey===m[1]})){
                r.hcaptcha.push({sitekey:m[1],theme:'',size:'normal',selector:'script',iframe:false});
            }
        }
        if(src.includes('challenges.cloudflare.com/turnstile')){
            if(!r.turnstile.length) addTurnstile({sitekey:'',action:'',cData:'',theme:'auto',size:'normal',selector:'script[src*=turnstile]',iframe:false});
        }

        var txt = '';
        try { txt = (s.textContent || '').slice(0, 40000); } catch {}
        if(!txt) return;
        if(txt.indexOf('turnstile') === -1 && txt.indexOf('sitekey') === -1) return;
        var mSitekey = txt.match(/sitekey\\s*[:=]\\s*['"]([0-9a-zA-Z_-]{10,})['"]/i);
        if(!mSitekey){
            mSitekey = txt.match(/['"]sitekey['"]\\s*[:,]\\s*['"]([0-9a-zA-Z_-]{10,})['"]/i);
        }
        var mAction = txt.match(/action\\s*[:=]\\s*['"]([^'"]{1,80})['"]/i);
        var mCdata = txt.match(/cData\\s*[:=]\\s*['"]([^'"]{1,200})['"]/i);
        if(mSitekey && mSitekey[1]){
            addTurnstile({
                sitekey: mSitekey[1] || '',
                action: mAction ? mAction[1] : '',
                cData: mCdata ? mCdata[1] : '',
                theme: 'auto',
                size: 'normal',
                selector: 'script:inline:turnstile',
                iframe: false
            });
        }
    });

    r.found = r.recaptcha.length>0 || r.hcaptcha.length>0 || r.turnstile.length>0;
    r.totalCount = r.recaptcha.length + r.hcaptcha.length + r.turnstile.length;
    return r;
}`;

const _analyzeMetaScript = `function(){
    var r = { title: document.title||'', url: location.href, charset: document.characterSet||'', doctype: document.doctype?document.doctype.name:'',
        meta: [], links: [], scripts: { inline:0, external:0, srcs:[] }, iframes: [] };
    document.querySelectorAll('meta').forEach(function(m){
        r.meta.push({ name: m.name||m.getAttribute('property')||m.httpEquiv||'', content: (m.content||'').substring(0,200) });
    });
    document.querySelectorAll('link[rel]').forEach(function(l){
        r.links.push({ rel: l.rel, href: (l.href||'').substring(0,200), type: l.type||'' });
    });
    document.querySelectorAll('script').forEach(function(s){ if(s.src){r.scripts.external++;r.scripts.srcs.push(s.src.substring(0,200))}else{r.scripts.inline++} });
    document.querySelectorAll('iframe').forEach(function(f){ r.iframes.push({ src: (f.src||'').substring(0,200), id: f.id||'', name: f.name||'' }); });
    return r;
}`;

const _analyzeEndpointsScript = `async function(){
    function abs(url) { try { return new URL(url, location.href).toString(); } catch { return null; } }
    function extractApiEndpoints(jsCode) {
        var patterns = [
            /["'\`](\\/api\\/[^"'\\\`\\s]+)["'\\\`]/g,
            /["'\`](\\/auth[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/login[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/otp[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/verify[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/user[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/appointment[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/slot[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/queue[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/applicant[^"'\\\`\\s]*)["'\\\`]/g,
            /fetch\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
            /axios\\.[a-z]+\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
            /\\.post\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
            /\\.get\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
            /["'\`]((?:https?:\\/\\/[^"'\\\`\\s]+)?\\/[^"'\\\`\\s]*(?:api|auth|otp|appointment|slot|queue|user|profile|invoice|payment|verify|login)[^"'\\\`\\s]*)["'\\\`]/gi
        ];
        var found = new Set();
        var src = String(jsCode || '');
        // Minified bundles often store URLs as escaped strings (e.g. "\\/api\\/v1").
        var normalized = src.replace(/\\\\\\//g, '/').replace(/\\\\u002f/gi, '/');
        var variants = [src, normalized];
        for (var v = 0; v < variants.length; v++) {
            var code = variants[v];
            for (var i = 0; i < patterns.length; i++) {
                var p = patterns[i], m;
                p.lastIndex = 0;
                while ((m = p.exec(code)) !== null) found.add(m[1]);
            }
        }
        return Array.from(found);
    }
    function classifyEndpoint(ep) {
        var s = String(ep || '').toLowerCase();
        if (s.includes('/auth') || s.includes('/signin') || s.includes('/signup') || s.includes('/login')) return 'auth';
        if (s.includes('/otp') || s.includes('verifyotp') || s.includes('phone-otp')) return 'otp';
        if (s.includes('/slot') || s.includes('/appointment') || s.includes('/reserve')) return 'booking';
        if (s.includes('/payment') || s.includes('/invoice') || s.includes('/tran_')) return 'payment';
        if (s.includes('/profile') || s.includes('/user')) return 'profile';
        if (s.startsWith('/')) return 'api-path';
        return 'other';
    }
    function isLikelyApiEndpoint(ep) {
        if (!ep) return false;
        var s = String(ep).trim();
        if (!s) return false;
        var l = s.toLowerCase();
        if (l.startsWith('/assets/')) return false;
        if (l.startsWith('/cdn-cgi/')) return false;
        if (/\\.(png|jpg|jpeg|gif|svg|webp|css|js|map|woff2?|ttf|eot)(\\?|$)/i.test(l)) return false;
        if (l.startsWith('http://') || l.startsWith('https://')) {
            try { l = new URL(l).pathname.toLowerCase(); } catch {}
        }
        if (/^\\/(api|auth|otp|appointment|slot|queue|user|profile|invoice|payment|file|forgot-password|verify|login)\\b/.test(l)) return true;
        if (/\\/(api|auth|otp|appointment|slot|queue|invoice|payment|verify|login)\\b/.test(l)) return true;
        if (/\\$\\{[^}]+\\}/.test(s)) return true;
        return false;
    }

    var started = Date.now();
    var r = {
        pageUrl: location.href,
        statusHint: (document.body && /just a moment/i.test(document.body.innerText || '')) ? 'challenge' : 'ok',
        scriptUrls: [],
        scannedScripts: [],
        endpoints: [],
        endpointsDetailed: [],
        categoryCounts: {},
        durationMs: 0
    };
    var endpointSet = new Set();
    var endpointSources = {};
    var endpointHits = {};
    var endpointMeta = {};
    function addEndpoint(ep, source, line, preview) {
        if (!ep) return;
        endpointSet.add(ep);
        if (!endpointSources[ep]) endpointSources[ep] = new Set();
        if (source) endpointSources[ep].add(source);
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        if (!endpointHits[ep]) endpointHits[ep] = [];
        if (source || line || preview) {
            var key = (source || '') + '|' + (line || 0) + '|' + (preview || '');
            var exists = endpointHits[ep].some(function(h){
                return ((h.source || '') + '|' + (h.line || 0) + '|' + (h.preview || '')) === key;
            });
            if (!exists) {
                endpointHits[ep].push({
                    source: source || '',
                    line: line || 0,
                    preview: (preview || '').slice(0, 220),
                });
            }
        }
    }

    function addMethod(ep, method) {
        if (!ep || !method) return;
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        endpointMeta[ep].methods.add(String(method).toUpperCase());
    }
    function addPayloadKeys(ep, keys) {
        if (!ep || !keys || !keys.length) return;
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        for (var i = 0; i < keys.length; i++) endpointMeta[ep].payloadKeys.add(keys[i]);
    }
    function extractObjectKeysFromText(txt) {
        var s = String(txt || '');
        if (!s) return [];
        var m = s.match(/\{([^{}]{1,900})\}/);
        if (!m) return [];
        var body = m[1];
        var keys = [];
        var parts = body.split(',');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            var km = p.match(/["'\`]?(?:[A-Za-z_$][A-Za-z0-9_$-]*)["'\`]?\s*:/);
            if (!km) continue;
            var key = km[0].replace(/[:\s"'\`]/g, '');
            if (key && key.length < 60 && keys.indexOf(key) === -1) keys.push(key);
        }
        return keys.slice(0, 20);
    }
    function scanCodeByLines(code, sourceLabel) {
        var lines = String(code || '').split(/\\r?\\n/);
        for (var li = 0; li < lines.length; li++) {
            var lineText = lines[li];
            var patterns = [
                /["'\`](\\/api\\/[^"'\\\`\\s]+)["'\\\`]/g,
                /["'\`](\\/auth[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/login[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/otp[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/verify[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/user[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/appointment[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/slot[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/queue[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/applicant[^"'\\\`\\s]*)["'\\\`]/g,
                /fetch\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
                /axios\\.[a-z]+\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
                /\\.post\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
                /\\.get\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g
            ];
            for (var pi = 0; pi < patterns.length; pi++) {
                var re = patterns[pi];
                var m;
                while ((m = re.exec(lineText)) !== null) {
                    addEndpoint(m[1], sourceLabel, li + 1, lineText.trim());
                    if (pi <= 9) {
                        // direct path literal in code; method unknown
                    } else if (pi === 10) {
                        var mm = lineText.match(/method\s*:\s*["'\`]([A-Za-z]+)["'\`]/i);
                        addMethod(m[1], mm ? mm[1] : 'GET');
                        var km1 = lineText.match(/body\s*:\s*JSON\.stringify\((\{[^)]*\})\)/i);
                        if (km1) addPayloadKeys(m[1], extractObjectKeysFromText(km1[1]));
                    } else if (pi === 11 || pi === 12) {
                        addMethod(m[1], 'POST');
                        var km2 = lineText.match(/post\([^,]+,\s*(\{[^)]*\})/i);
                        if (km2) addPayloadKeys(m[1], extractObjectKeysFromText(km2[1]));
                    } else if (pi === 13) {
                        addMethod(m[1], 'GET');
                    }
                }
            }
        }
    }
    function addEndpointHitFromText(ep, sourceLabel, text) {
        var src = String(sourceLabel || '');
        var t = String(text || '');
        var idx = t.indexOf(ep);
        if (idx < 0) idx = t.toLowerCase().indexOf(String(ep || '').toLowerCase());
        if (idx < 0) {
            addEndpoint(ep, src, 1, '');
            return;
        }
        var before = t.slice(0, idx);
        var line = before.split(/\\r?\\n/).length;
        var from = Math.max(0, idx - 90);
        var to = Math.min(t.length, idx + Math.max(40, String(ep || '').length + 90));
        var preview = t.slice(from, to).replace(/\\s+/g, ' ').trim();
        addEndpoint(ep, src, line, preview);
    }

    var inline = Array.from(document.querySelectorAll('script:not([src])'));
    for (var i = 0; i < inline.length; i++) {
        var code = inline[i].textContent || '';
        var eps = extractApiEndpoints(code);
        for (var j = 0; j < eps.length; j++) {
            addEndpoint(eps[j], '(inline)');
            addEndpointHitFromText(eps[j], '(inline)', code);
        }
        scanCodeByLines(code, '(inline)');
        r.scannedScripts.push({ url: '(inline)', statusCode: 200, bodyLength: code.length, endpointHits: eps.length });
    }

    var srcEls = Array.from(document.querySelectorAll('script[src]'));
    var urls = srcEls.map(function(s){ return abs(s.getAttribute('src') || s.src); }).filter(Boolean);
    r.scriptUrls = Array.from(new Set(urls));

    for (var k = 0; k < r.scriptUrls.length; k++) {
        var u = r.scriptUrls[k];
        try {
            var resp = await fetch(u, { credentials: 'include', cache: 'no-store' });
            var txt = await resp.text();
            var fe = extractApiEndpoints(txt);
            for (var z = 0; z < fe.length; z++) {
                addEndpoint(fe[z], u);
                addEndpointHitFromText(fe[z], u, txt);
            }
            scanCodeByLines(txt, u);
            r.scannedScripts.push({ url: u, statusCode: resp.status, bodyLength: txt.length, endpointHits: fe.length });
        } catch (e) {
            r.scannedScripts.push({ url: u, statusCode: 0, bodyLength: 0, endpointHits: 0, error: e.message || String(e) });
        }
    }

    var perfRes = (performance.getEntriesByType('resource') || []);
    for (var p = 0; p < perfRes.length; p++) {
        var en = perfRes[p];
        var nm = en && en.name ? String(en.name) : '';
        if (!nm) continue;
        var low = nm.toLowerCase();
        if (low.includes('/api/') || low.includes('/auth') || low.includes('/otp') || low.includes('/appointment') || low.includes('/slot')) {
            try {
                var path = new URL(nm).pathname;
                if (path) addEndpoint(path, 'performance', 1, nm);
            } catch {}
        }
    }

    var rawEndpoints = Array.from(endpointSet);
    r.endpoints = rawEndpoints.filter(isLikelyApiEndpoint).sort();
    if (!r.endpoints.length && rawEndpoints.length) {
        // Fallback: keep potentially useful paths when strict classifier is too aggressive.
        r.endpoints = rawEndpoints.filter(function(ep){
            var s = String(ep || '').toLowerCase();
            if (!s) return false;
            if (s.startsWith('/assets/') || s.startsWith('/cdn-cgi/')) return false;
            if (/\\.(png|jpg|jpeg|gif|svg|webp|css|js|map|woff2?|ttf|eot)(\\?|$)/i.test(s)) return false;
            return s.includes('/') || s.includes('http://') || s.includes('https://');
        }).sort();
    }
    r.endpointsDetailed = r.endpoints.map(function(ep){
        var srcs = endpointSources[ep] ? Array.from(endpointSources[ep]) : [];
        var hits = endpointHits[ep] ? endpointHits[ep].slice(0, 5) : [];
        var methods = endpointMeta[ep] ? Array.from(endpointMeta[ep].methods) : [];
        var payloadKeys = endpointMeta[ep] ? Array.from(endpointMeta[ep].payloadKeys) : [];
        return { path: ep, sources: srcs, hits: hits, methods: methods, payloadKeys: payloadKeys };
    });
    for (var q = 0; q < r.endpoints.length; q++) {
        var cat = classifyEndpoint(r.endpoints[q]);
        r.categoryCounts[cat] = (r.categoryCounts[cat] || 0) + 1;
    }
    r.durationMs = Date.now() - started;
    return r;
}`;

/** Обновить mock handlers на каждой уникальной session (без дублирования webRequest). */
function reattachInterceptorToAllTabs() {
    if (!interceptor || !tabManager) return;
    const seen = new WeakSet();
    for (const tab of tabManager.getAllTabs()) {
        const ts = tab.tabSession;
        if (!ts || seen.has(ts)) continue;
        seen.add(ts);
        try { interceptor.syncMockProtocolHandlers(ts); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'interceptor.mock_sync.failed', context: { tabId: tab.id } }, err);
        }
    }
}

/** Broadcast updated tab list to cookie manager & page analyzer — debounced */
let _notifyTabsTimer = null;
function notifyCookieManagerTabs() {
    if (_notifyTabsTimer) clearTimeout(_notifyTabsTimer);
    _notifyTabsTimer = setTimeout(() => {
        _notifyTabsTimer = null;
        const list = tabManager.getTabList();
        if (cookieManagerWindow && !cookieManagerWindow.isDestroyed()) {
            cookieManagerWindow.webContents.send('tabs-updated', list);
        }
        if (pageAnalyzerWindow && !pageAnalyzerWindow.isDestroyed()) {
            pageAnalyzerWindow.webContents.send('analyzer-tabs-updated', list);
        }
    }, 150);
}

function isValidPlainDnsHost(value) {
    const parts = value.split('.');
    if (!parts.length || parts.some(p => !p || p.length > 63)) return false;
    return parts.every(p => /^[a-z0-9-]+$/i.test(p) && !p.startsWith('-') && !p.endsWith('-'));
}

function isValidDnsHost(host) {
    const value = String(host || '').trim().toLowerCase();
    if (!value || value.length > 253) return false;
    if (value.startsWith('*.')) {
        const rest = value.slice(2);
        return !!rest && isValidPlainDnsHost(rest) && rest.includes('.');
    }
    return isValidPlainDnsHost(value);
}

function isValidIpv4(ip) {
    const value = String(ip || '').trim();
    const m = value.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
    if (!m) return false;
    return value.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
}

function syncDnsOverridesToMitm() {
    if (!db || !mitmProxy || typeof mitmProxy.setDnsOverrides !== 'function') return;
    try {
        const rules = db.getDnsOverrides().filter(r => !!r.enabled);
        mitmProxy.setDnsOverrides(rules);
        if (dnsManagerWindow && !dnsManagerWindow.isDestroyed()) {
            dnsManagerWindow.webContents.send('dns-overrides-updated', db.getDnsOverrides());
        }
    } catch (e) {
        sysLog('warn', 'dns', 'syncDnsOverridesToMitm failed: ' + (e?.message || e));
    }
}

function createCookieManagerWindow(initialTabId) {
    if (cookieManagerWindow && !cookieManagerWindow.isDestroyed()) {
        cookieManagerWindow.focus();
        if (initialTabId) cookieManagerWindow.webContents.send('set-active-tab', initialTabId);
        return;
    }
    cookieManagerWindow = new BrowserWindow({
        width: 980, height: 680, minWidth: 700, minHeight: 480,
        title: 'Cookie Manager', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    cookieManagerWindow.loadFile(getAssetPath('cookie-manager.html'));
    cookieManagerWindow.webContents.on('did-finish-load', () => {
        if (initialTabId) cookieManagerWindow.webContents.send('set-active-tab', initialTabId);
        cookieManagerWindow.webContents.send('tabs-list', tabManager.getTabList());
    });
    cookieManagerWindow.on('closed', () => { cookieManagerWindow = null; });
}

function createDnsManagerWindow() {
    if (dnsManagerWindow && !dnsManagerWindow.isDestroyed()) {
        dnsManagerWindow.focus();
        return;
    }
    dnsManagerWindow = new BrowserWindow({
        width: 980, height: 660, minWidth: 760, minHeight: 480,
        title: 'DNS Manager', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    dnsManagerWindow.loadFile(getAssetPath('dns-manager.html'));
    dnsManagerWindow.webContents.on('did-finish-load', () => {
        if (db) dnsManagerWindow.webContents.send('dns-overrides-updated', db.getDnsOverrides());
        if (_recentDnsEvents.length > 0) {
            dnsManagerWindow.webContents.send('dns-rule-matched-batch', _recentDnsEvents.slice(-100));
        }
    });
    dnsManagerWindow.on('closed', () => { dnsManagerWindow = null; });
}

function createLoggingModalWindow(data, buttonHint) {
    // If already open, just focus and re-send data
    if (loggingModalWindow && !loggingModalWindow.isDestroyed()) {
        loggingModalWindow.webContents.send('modal-logging-init', data);
        loggingModalWindow.focus();
        return;
    }

    // Position near the button that triggered this modal.
    // buttonHint: { x, y, w, h } — button rect in browser.html viewport coords.
    // We convert to screen coords using mainWindow's screen position.
    const W = 330, H = 290;
    let x, y;
    if (mainWindow && !mainWindow.isDestroyed()) {
        const [wx, wy] = mainWindow.getPosition();
        if (buttonHint) {
            // Align modal right-edge with button right-edge, appear below button (+50px gap), shifted 200px right
            x = Math.round(wx + buttonHint.x + buttonHint.w - W + 200);
            y = Math.round(wy + buttonHint.y + buttonHint.h + 56);
        } else {
            // Fallback: center over window
            const [ww, wh] = mainWindow.getSize();
            x = Math.round(wx + (ww - W) / 2);
            y = Math.round(wy + (wh - H) / 2);
        }
    }

    loggingModalWindow = new BrowserWindow({
        width: W, height: H,
        x, y,
        resizable: false,
        minimizable: false,
        maximizable: false,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        parent: mainWindow || undefined,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    loggingModalWindow.loadFile(getAssetPath('modal-logging.html'));

    loggingModalWindow.webContents.once('did-finish-load', () => {
        loggingModalWindow.webContents.send('modal-logging-init', data);
        loggingModalWindow.show();
    });

    loggingModalWindow.on('closed', () => { loggingModalWindow = null; });
}

function createProxyManagerWindow() {
    if (proxyManagerWindow && !proxyManagerWindow.isDestroyed()) {
        proxyManagerWindow.focus(); return;
    }
    proxyManagerWindow = new BrowserWindow({
        width: 1060, height: 700, minWidth: 720, minHeight: 480,
        title: 'Proxy Manager', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    proxyManagerWindow.loadFile(getAssetPath('proxy-manager.html'));
    proxyManagerWindow.webContents.on('did-finish-load', () => {
        notifyProxyProfilesList();
        notifyProxyStatus();
    });
    proxyManagerWindow.on('closed', () => { proxyManagerWindow = null; });
}

function createRulesWindow() {
    if (rulesWindow) { rulesWindow.focus(); return; }
    rulesWindow = new BrowserWindow({
        width: 900, height: 700, minWidth: 640, minHeight: 480,
        parent: mainWindow, title: 'Rules & Interceptor', icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    rulesWindow.loadFile(getAssetPath('rules.html'));
    rulesWindow.webContents.once('did-finish-load', () => {
        if (_recentInterceptEvents.length > 0) {
            rulesWindow.webContents.send('intercept-rule-matched-batch', _recentInterceptEvents.slice(-80));
        }
    });
    rulesWindow.on('closed', () => { rulesWindow = null; });
}

function buildMenu() {
    const menu = Menu.buildFromTemplate([
        {
            label: 'File', submenu: [
                { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: async () => {
                    if (!tabManager || !mainWindow) return;
                    const id = await tabManager.createTab(persistentAnonymizedProxyUrl || null, getNewTabUrl(), false, currentSessionId);
                    tabManager.switchTab(id);
                    const tab = tabManager.getTab(id);
                    if (tab) { setupNetworkLogging(tab.view.webContents, id, currentSessionId); interceptor.attachToSession(tab.tabSession, id); }
                    notifyCookieManagerTabs();
                }},
                { label: 'New Isolated Tab', accelerator: 'CmdOrCtrl+Shift+T', click: async () => {
                    if (!tabManager || !mainWindow) return;
                    const id = await tabManager.createTab(persistentAnonymizedProxyUrl || null, getNewTabUrl(), true, null);
                    tabManager.switchTab(id);
                    const tab = tabManager.getTab(id);
                    if (tab) {
                        setupNetworkLogging(tab.view.webContents, id, currentSessionId);
                        if (interceptor) {
                            try { interceptor.attachToSession(tab.tabSession, id); } catch (e) {
                                safeCatch({ module: 'main', eventCode: 'interceptor.attach.failed', context: { tabId: id, source: 'menu.new-isolated-tab' } }, e);
                            }
                        }
                    }
                    notifyCookieManagerTabs();
                }},
                { label: 'New Tab', accelerator: 'CmdOrCtrl+Shift+D', click: async () => {
                    if (!tabManager || !mainWindow) return;
                    const id = await tabManager.createTab({ url: getNewTabUrl() || null, cookieGroupId: 1 });
                    tabManager.switchTab(id);
                    notifyCookieManagerTabs();
                }},
                { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => {
                    if (!tabManager) return;
                    const id = tabManager.getActiveTabId();
                    if (id) tabManager.closeTab(id);
                }},
                { type: 'separator' },
                { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => {
                    mainWindow?.webContents.send('focus-url-bar');
                }},
                { type: 'separator' },
                { label: 'Proxy Manager', accelerator: 'CmdOrCtrl+P', click: () => createProxyManagerWindow() },
                { label: 'Network Activity', accelerator: 'CmdOrCtrl+Shift+L', click: () => createLogViewerWindow() },
                { label: 'Cookie Manager', accelerator: 'CmdOrCtrl+Alt+C', click: () => createCookieManagerWindow(tabManager?.getActiveTabId()) },
                { label: 'DNS Manager', accelerator: 'CmdOrCtrl+Shift+M', click: () => createDnsManagerWindow() },
                { label: 'Rules & Interceptor', click: () => createRulesWindow() },
                { label: 'System Console', accelerator: 'CmdOrCtrl+Shift+K', click: () => createConsoleViewerWindow() },
                { label: 'Page Analyzer', accelerator: 'CmdOrCtrl+Shift+A', click: () => createPageAnalyzerWindow() },
                { label: 'API Scout', click: () => createIvacScoutWindow() },
                { type: 'separator' },
                { label: 'Enable Logging', type: 'checkbox', checked: isLoggingEnabled,
                  click: (item) => { isLoggingEnabled = item.checked; sendLogStatus(); } },
                { label: 'Take Screenshot', accelerator: 'F2', click: () => {
                    requestScreenshot({ reason: 'click' }).catch((err) => {
                        safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'click', source: 'app-activate' } }, err, 'info');
                    });
                }},
                { type: 'separator' },
                { role: 'quit', label: 'Exit' }
            ]
        },
        { label: 'Edit', submenu: [
            { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
            { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
        ]},
        { label: 'View', submenu: [
            { label: 'Reload Page', accelerator: 'CmdOrCtrl+R',
              click: () => tabManager?.getActiveTab()?.view.webContents.reload() },
            { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R',
              click: () => tabManager?.getActiveTab()?.view.webContents.reloadIgnoringCache() },
            { label: 'Developer Tools (Page)', accelerator: 'F12',
              click: () => tabManager?.getActiveTab()?.view.webContents.toggleDevTools() },
            { label: 'Developer Tools (Shell)', accelerator: 'CmdOrCtrl+Shift+I',
              click: () => mainWindow?.webContents.toggleDevTools() },
            { type: 'separator' },
            { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => { mainWindow?.webContents.send('switch-tab-rel', 1); }},
            { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => { mainWindow?.webContents.send('switch-tab-rel', -1); }},
            { type: 'separator' },
            { label: 'Trace', click: () => {
                const s = cachedSettings || loadSettings();
                if (s.traceMode || (db && db.countTraceEntries() > 0)) createTraceViewerWindow();
            }}
        ]}
    ]);
    Menu.setApplicationMenu(menu);
}

// ─── Certificate verification (must be before whenReady) ────────────────────────
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true); // Accept our MITM certs
});

// ─── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    startupMetrics.appReadyTs = Date.now();
    applyRuntimeAppIcon();

    // Load only the critical modules synchronously
    db         = require('./db');
    tabManager = require('./tab-manager');
    db.init();
    loadSettings();
    tabManager.setProxyAll(null).catch((err) => {
        safeCatch({ module: 'main', eventCode: 'traffic.mode.apply.failed', context: { source: 'startup.preload' } }, err, 'info');
    });
    initSysLogIPC();

    interceptor = require('./request-interceptor');
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

    // Non-critical modules loaded after window is shown
    setImmediate(() => {
        harExporter = require('./har-exporter');
        rulesEngine = require('./rules-engine');
    });

    // Start MITM proxy in background so first window appears immediately
    mitmStartPromise = startMitmProxy().then(async proxy => {
        const { session: electronSession } = require('electron');
        const caCertPem = proxy.getCACert(); // eslint-disable-line no-unused-vars

        function trustMitmCA(sess) {
            sess.setCertificateVerifyProc((_, callback) => callback(0));
        }

        trustMitmCA(electronSession.defaultSession);
        tabManager.setTrustMitmCA(trustMitmCA);
        tabManager.setMitmTabUpstreamCleanup((tid) => {
            if (mitmProxy && typeof mitmProxy.removeTabUpstream === 'function') mitmProxy.removeTabUpstream(tid);
        });
        trustMitmCA(electronSession.fromPartition(tabManager.partitionForGroup(1)));

        await applyEffectiveTrafficMode(getCurrentTrafficMode(), persistentAnonymizedProxyUrl, {
            source: 'startup',
            force: true,
        }).catch((e) => {
            safeCatch({ module: 'main', eventCode: 'traffic.mode.apply.failed', context: { source: 'startup' } }, e);
        });

        const startupProfile = loadSettings().tlsProfile || 'chrome';
        proxy.setBrowser(startupProfile);
        syncDnsOverridesToMitm();
        console.log(`[main] MITM startup profile: ${startupProfile}`);
        mitmReady = true;
        startupMetrics.mitmReadyTs = Date.now();
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
        notifyMitmReady();
    });

    ipcMain.handle('mitm-ready-state', () => ({ ready: !!mitmReady, ts: Date.now() }));
    ipcMain.on('ui-first-paint', () => {
        if (!startupMetrics.firstPaintTs) {
            startupMetrics.firstPaintTs = Date.now();
            maybeLogStartupMetrics();
        }
    });
    ipcMain.on('ui-long-task-count', (_, count) => {
        startupMetrics.longTaskCount = Number(count) || 0;
    });

    // ── Mouse activity ───────────────────────────────────────────────────────
    ipcMain.on('report-mouse-activity', () => { lastMouseMoveTime = Date.now(); });
    ipcMain.on('reset-toolbar-activity-badge', (_, tool) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
            mainWindow.webContents.send('toolbar-activity-badge-reset', tool);
        } catch (_) { /* ignore */ }
    });
    ipcMain.on('report-tab-pointer', (event, payload) => {
        try {
            const tabId = _wcIdToTabId.get(event.sender.id);
            if (!tabId || !payload || typeof payload !== 'object') return;
            const xNorm = Number(payload.xNorm);
            const yNorm = Number(payload.yNorm);
            if (!Number.isFinite(xNorm) || !Number.isFinite(yNorm)) return;
            _lastPointerByTabId.set(tabId, {
                xNorm: Math.max(0, Math.min(1, xNorm)),
                yNorm: Math.max(0, Math.min(1, yNorm)),
                ts: Number(payload.ts) || Date.now(),
            });
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'tracking.payload.invalid', context: { event: 'report-tab-pointer' } }, err, 'info');
        }
    });
    ipcMain.on('report-tab-click', (event, payload) => {
        try {
            const tabId = _wcIdToTabId.get(event.sender.id);
            if (!tabId || !payload || typeof payload !== 'object') return;
            if (!tabManager || tabManager.getActiveTabId() !== tabId) return;
            const xNorm = Number(payload.xNorm);
            const yNorm = Number(payload.yNorm);
            if (!Number.isFinite(xNorm) || !Number.isFinite(yNorm)) return;
            const click = {
                xNorm: Math.max(0, Math.min(1, xNorm)),
                yNorm: Math.max(0, Math.min(1, yNorm)),
                ts: Number(payload.ts) || Date.now(),
            };
            _lastPointerByTabId.set(tabId, click);
            requestScreenshot({
                reason: 'click',
                skipRateLimit: true,
                meta: {
                    tabId,
                    click,
                    button: Number.isFinite(Number(payload.button)) ? Number(payload.button) : 0,
                },
            }).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'click', tabId } }, err, 'info');
            });
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'tracking.payload.invalid', context: { event: 'report-tab-click' } }, err, 'info');
        }
    });
    ipcMain.on('report-tab-typing-end', (event, payload) => {
        try {
            const tabId = _wcIdToTabId.get(event.sender.id);
            if (!tabId || !payload || typeof payload !== 'object') return;
            if (!tabManager || tabManager.getActiveTabId() !== tabId) return;
            const xNorm = Number(payload.xNorm);
            const yNorm = Number(payload.yNorm);
            const click = {
                xNorm: Number.isFinite(xNorm) ? Math.max(0, Math.min(1, xNorm)) : 0.5,
                yNorm: Number.isFinite(yNorm) ? Math.max(0, Math.min(1, yNorm)) : 0.5,
                ts: Number(payload.ts) || Date.now(),
            };
            _lastPointerByTabId.set(tabId, click);
            requestScreenshot({
                reason: 'typing-end',
                skipRateLimit: true,
                meta: { tabId, click },
            }).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'typing-end', tabId } }, err, 'info');
            });
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'tracking.payload.invalid', context: { event: 'report-tab-typing-end' } }, err, 'info');
        }
    });
    ipcMain.on('report-tab-scroll-end', (event, payload) => {
        try {
            const tabId = _wcIdToTabId.get(event.sender.id);
            if (!tabId || !payload || typeof payload !== 'object') return;
            if (!tabManager || tabManager.getActiveTabId() !== tabId) return;
            const xNorm = Number(payload.xNorm);
            const yNorm = Number(payload.yNorm);
            const click = {
                xNorm: Number.isFinite(xNorm) ? Math.max(0, Math.min(1, xNorm)) : 0.5,
                yNorm: Number.isFinite(yNorm) ? Math.max(0, Math.min(1, yNorm)) : 0.5,
                ts: Number(payload.ts) || Date.now(),
            };
            _lastPointerByTabId.set(tabId, click);
            requestScreenshot({
                reason: 'scroll-end',
                skipRateLimit: true,
                meta: { tabId, click },
            }).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'scroll-end', tabId } }, err, 'info');
            });
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'tracking.payload.invalid', context: { event: 'report-tab-scroll-end' } }, err, 'info');
        }
    });

    // ── Tab management ───────────────────────────────────────────────────────
    ipcMain.handle('new-tab', async (_, proxyRules) => {
        const tabId = await tabManager.createTab(proxyRules || persistentAnonymizedProxyUrl || null, getNewTabUrl(), false, currentSessionId);
        tabManager.switchTab(tabId);
        const tab = tabManager.getTab(tabId);
        if (tab) {
            setupNetworkLogging(tab.view.webContents, tabId, currentSessionId);
            interceptor.attachToSession(tab.tabSession, tabId);
        }
        notifyCookieManagerTabs();
        return tabId;
    });

    ipcMain.handle('open-settings-tab', async () => {
        const settingsUrl = getInternalPageUrl('settings');
        for (const tab of tabManager.getAllTabs()) {
            const currentUrl = tab?.view?.webContents?.isDestroyed()
                ? ''
                : (tab?.view?.webContents?.getURL?.() || tab?.url || '');
            if (currentUrl && currentUrl.includes('settings.html')) {
                tabManager.switchTab(tab.id);
                return tab.id;
            }
        }
        const tabId = await tabManager.createTab(
            persistentAnonymizedProxyUrl || null,
            settingsUrl,
            false,
            currentSessionId
        );
        tabManager.switchTab(tabId);
        const tab = tabManager.getTab(tabId);
        if (tab) {
            setupNetworkLogging(tab.view.webContents, tabId, currentSessionId);
            if (interceptor) interceptor.attachToSession(tab.tabSession, tabId);
        }
        notifyCookieManagerTabs();
        return tabId;
    });

    ipcMain.handle('close-tab', async (_, tabId) => {
        const tab = tabManager.getTab(tabId);
        if (tab) {
            try { interceptor.detachFromSession(tab.tabSession); } catch (e) { sysLog('warn', 'tabs', 'interceptor detach on close-tab failed: ' + (e?.message || e)); }
        }
        const result = tabManager.closeTab(tabId);
        notifyCookieManagerTabs();
        return result;
    });

    ipcMain.handle('switch-tab', async (_, tabId) => {
        return tabManager.switchTab(tabId);
    });

    ipcMain.handle('get-tabs', async () => {
        return tabManager.getTabList();
    });

    // ── Navigation ───────────────────────────────────────────────────────────
    ipcMain.on('navigate-to', (event, rawInput) => {
        const raw = String(rawInput || '').trim();
        const alias = raw.toLowerCase();
        if (alias === 'cupnet://settings' || alias === 'cupnet:settings') {
            tabManager.navigate(getInternalPageUrl('settings'));
            return;
        }
        if (alias === 'cupnet://guide' || alias === 'cupnet:guide') {
            tabManager.navigate(getInternalPageUrl('guide'));
            return;
        }
        if (alias === 'cupnet://home'
            || alias === 'cupnet:home'
            || alias === 'cupnet://new-tab'
            || alias === 'cupnet:new-tab') {
            tabManager.navigate(getNewTabUrl());
            return;
        }
        const url = resolveNavigationUrl(rawInput);
        if (!url) return;
        // Always load in active tab — avoids sender-id confusion (URL bar vs new-tab)
        tabManager.navigate(url);
    });
    ipcMain.on('nav-back', () => {
        const tab = tabManager.getActiveTab();
        if (tab && tab.view.webContents.canGoBack()) tab.view.webContents.goBack();
    });
    ipcMain.on('nav-forward', () => {
        const tab = tabManager.getActiveTab();
        if (tab && tab.view.webContents.canGoForward()) tab.view.webContents.goForward();
    });
    ipcMain.on('nav-reload', () => {
        const tab = tabManager.getActiveTab();
        if (tab) tab.view.webContents.reload();
    });
    ipcMain.on('nav-home', () => {
        const tab = tabManager.getActiveTab();
        if (tab && !tab.view.webContents.isDestroyed()) {
            tab.view.webContents.loadURL(getNewTabUrl()).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'navigation.load.failed', context: { target: 'new-tab' } }, err, 'info');
            });
        }
    });

    // ── DB queries (for log viewer) ──────────────────────────────────────────
    ipcMain.handle('get-db-requests', async (_, filters, limit, offset) => {
        return db.queryRequests(filters || {}, limit || 100, offset || 0);
    });

    ipcMain.handle('count-db-requests', async (_, filters) => {
        return db.countRequests(filters || {});
    });

    ipcMain.handle('get-request-detail', async (_, id) => {
        return db.getRequest(id);
    });

    ipcMain.handle('set-request-annotation', async (_, id, data) => {
        if (!id) return { success: false, error: 'Invalid request id' };
        await db.setRequestAnnotationAsync(id, data || {});
        return { success: true };
    });

    ipcMain.handle('fts-search', async (_, query, sessionId) => {
        return db.ftsSearch(query, sessionId || null);
    });

    ipcMain.handle('get-sessions', async () => {
        return db.getSessions(50, 0);
    });

    ipcMain.handle('get-sessions-with-stats', async () => {
        return db.getSessionsWithStats(200, 0);
    });

    ipcMain.handle('get-current-session-id', async () => {
        return currentSessionId ?? null;
    });

    ipcMain.handle('rename-session', async (_, id, name) => {
        await db.renameSessionAsync(id, name);
        return { success: true };
    });

    // ── Logging toggle ───────────────────────────────────────────────────────
    ipcMain.handle('toggle-logging-start', async (_, hint) => {
        if (isLoggingEnabled) return { status: 'already_on' };

        // No session yet (truly first run) — create one and enable silently
        if (!currentSessionId) {
            const sess = await db.createSessionAsync(actProxy || null, null);
            currentSessionId = sess ? sess.id : null;
            logEntryCount = 0;
            for (const tab of tabManager.getAllTabs()) {
                tab.sessionId = currentSessionId;
                setupNetworkLogging(tab.view.webContents, tab.id, currentSessionId);
            }
            isLoggingEnabled = true;
            sendLogStatus();
            return { status: 'started' };
        }

        // If logging was explicitly stopped before — ALWAYS show choice modal
        // (even when logEntryCount === 0, e.g. after clear-logs)
        if (hadLoggingBeenStopped || logEntryCount > 0) {
            const sess = db.getSession(currentSessionId);
            const modalData = {
                sessionId:   currentSessionId,
                sessionName: sess?.notes || null,
                count:       logEntryCount,
            };
            createLoggingModalWindow(modalData, hint);
            return { status: 'modal_shown' };
        }

        // First enable ever with a pre-created empty session — start silently
        isLoggingEnabled = true;
        for (const tab of tabManager.getAllTabs()) {
            if (!tab.view?.webContents || tab.view.webContents.isDestroyed()) continue;
            const sid = currentSessionId ?? tab.sessionId;
            if (sid == null) continue;
            tab.sessionId = sid;
            setupNetworkLogging(tab.view.webContents, tab.id, sid);
        }
        sendLogStatus();
        return { status: 'started' };
    });

    ipcMain.handle('confirm-logging-start', async (_, { mode, renameOld }) => {
        if (mode === 'continue') {
            isLoggingEnabled = true;
            hadLoggingBeenStopped = false;
            // Re-attach logging for every tab so new tabs opened while paused also log
            for (const tab of tabManager.getAllTabs()) {
                tab.sessionId = currentSessionId;
                setupNetworkLogging(tab.view.webContents, tab.id, currentSessionId);
            }
            sendLogStatus();
            return { success: true };
        }
        // mode === 'new'
        if (renameOld && currentSessionId) await db.renameSessionAsync(currentSessionId, renameOld);
        if (currentSessionId) await db.endSessionAsync(currentSessionId);
        const sess = await db.createSessionAsync(actProxy || null, null);
        currentSessionId = sess ? sess.id : null;
        logEntryCount = 0;
        hadLoggingBeenStopped = false;
        for (const tab of tabManager.getAllTabs()) {
            tab.sessionId = currentSessionId;
            setupNetworkLogging(tab.view.webContents, tab.id, currentSessionId);
        }
        isLoggingEnabled = true;
        sendLogStatus();
        return { success: true };
    });

    ipcMain.handle('toggle-logging-stop', async () => {
        isLoggingEnabled = false;
        hadLoggingBeenStopped = true;
        sendLogStatus();
        return { success: true };
    });

    ipcMain.handle('delete-session', async (_, id) => {
        // Guard: cannot delete the currently active session
        if (id === currentSessionId) return { success: false, reason: 'active' };
        await db.deleteSessionAsync(id);
        return { success: true };
    });

    ipcMain.handle('open-session-in-new-window', async (_, sessionId) => {
        createLogViewerWindow(sessionId || null);
        return { success: true };
    });

    ipcMain.handle('get-initial-session-id', async (e) => {
        return logViewerInitSessions.get(e.sender.id) ?? null;
    });

    ipcMain.handle('get-log-status', () => {
        return isLoggingEnabled && currentSessionId
            ? { enabled: true, sessionId: currentSessionId, count: logEntryCount }
            : { enabled: false, sessionId: null, count: 0 };
    });

    // ── Existing logs (DB-backed) ────────────────────────────────────────────
    ipcMain.handle('get-existing-logs', async () => {
        if (!currentSessionId) return [];
        const requests    = db.queryRequests({ sessionId: currentSessionId }, 5000, 0);
        const screenshots = db.getScreenshotEntriesForSession(currentSessionId);
        // Merge and sort ascending by created_at so order is chronological
        return [...requests, ...screenshots].sort((a, b) => {
            const ta = a.created_at || '', tb = b.created_at || '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });
    });

    ipcMain.handle('clear-logs', async () => {
        // Start a new session; all open tabs will log into it
        try {
            if (currentSessionId) await db.endSessionAsync(currentSessionId);
            const newSession = await db.createSessionAsync(actProxy || null, null);
            currentSessionId = newSession ? newSession.id : null;
            logEntryCount = 0;
            // Re-attach logging for every open tab so they write to the new session
            for (const tab of tabManager.getAllTabs()) {
                tab.sessionId = currentSessionId;
                setupNetworkLogging(tab.view.webContents, tab.id, currentSessionId);
            }
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // ── HAR export ───────────────────────────────────────────────────────────
    ipcMain.handle('export-har', async (_, sessionId) => {
        const sid = sessionId || currentSessionId;
        const { canceled, filePath } = await dialog.showSaveDialog(logViewerWindow, {
            title: 'Export HAR',
            defaultPath: path.join(app.getPath('downloads'), `cupnet-session-${sid}.har`),
            filters: [{ name: 'HAR Files', extensions: ['har'] }]
        });
        if (canceled) return { success: false, canceled: true };
        try {
            const har = harExporter.exportHar(sid);
            fs.writeFileSync(filePath, JSON.stringify(har, null, 2));
            let sidecarPath = null;
            if (process.env.CUPNET_HAR_WS_SIDECAR === '1' && typeof harExporter.exportWebSocketSidecarPayload === 'function') {
                const side = harExporter.exportWebSocketSidecarPayload(sid);
                if (side) {
                    sidecarPath = filePath.replace(/\.har$/i, '-websocket.json');
                    fs.writeFileSync(sidecarPath, JSON.stringify(side, null, 2));
                }
            }
            return { success: true, path: filePath, sidecarPath };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // ── Incident bundle export/import ────────────────────────────────────────
    ipcMain.handle('export-bundle', async (_, payload = {}) => {
        const sid = payload.sessionId || currentSessionId || null;
        const protectionLevel = String(payload.protectionLevel || 'Raw');
        const requestIds = Array.isArray(payload.requestIds) ? payload.requestIds : [];
        const { canceled, filePath } = await dialog.showSaveDialog(logViewerWindow, {
            title: 'Export Incident Bundle',
            defaultPath: path.join(app.getPath('downloads'), `cupnet-bundle-${sid || 'manual'}-${Date.now()}.json`),
            filters: [{ name: 'Bundle Files', extensions: ['json', 'bundle'] }],
        });
        if (canceled) return { success: false, canceled: true };
        try {
            const bundle = bundleUtils.buildBundle({
                db,
                sessionId: sid,
                requestIds,
                protectionLevel,
                appVersion: app.getVersion(),
            });
            if (payload.notes && typeof payload.notes === 'object') {
                bundle.notes = { ...(bundle.notes || {}), ...payload.notes };
            }
            fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8');
            return {
                success: true,
                path: filePath,
                stats: {
                    requests: bundle.traffic?.requests?.length || 0,
                    websocketEvents: bundle.traffic?.websocketEvents?.length || 0,
                    protectionLevel: bundle.meta?.protectionLevel || protectionLevel,
                    redactedFields: bundle.meta?.redactionReport?.redactedFieldsCount || 0,
                },
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('import-bundle', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(logViewerWindow, {
            title: 'Import Incident Bundle',
            properties: ['openFile'],
            filters: [{ name: 'Bundle/JSON files', extensions: ['json', 'bundle'] }],
        });
        if (canceled || !filePaths.length) return { success: false, canceled: true };
        try {
            const raw = fs.readFileSync(filePaths[0], 'utf8');
            const bundle = JSON.parse(raw);
            const check = bundleUtils.validateBundle(bundle);
            if (!check.ok) return { success: false, error: check.error };
            const preview = {
                schemaVersion: bundle.schemaVersion,
                exportedAt: bundle.meta?.exportedAt || null,
                protectionLevel: bundle.meta?.protectionLevel || 'Raw',
                requests: Array.isArray(bundle.traffic?.requests) ? bundle.traffic.requests.length : 0,
                trace: Array.isArray(bundle.traffic?.trace) ? bundle.traffic.trace.length : 0,
                websocketEvents: Array.isArray(bundle.traffic?.websocketEvents) ? bundle.traffic.websocketEvents.length : 0,
            };
            return { success: true, filePath: filePaths[0], preview, bundle };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('diff-requests', async (_, leftId, rightId) => {
        const left = db.getRequest(Number(leftId));
        const right = db.getRequest(Number(rightId));
        if (!left || !right) return { success: false, error: 'Request not found for diff' };
        const result = diffUtils.compareRequests(left, right);
        if (!result.ok) return { success: false, error: result.error || 'Diff error' };
        return { success: true, diff: result };
    });

    ipcMain.handle('jsondiff-format-html', async (_, leftText, rightText) => {
        try {
            const mods = await loadJsonDiffModules();
            const left = JSON.parse(String(leftText || ''));
            const right = JSON.parse(String(rightText || ''));
            const delta = mods.jsondiffpatch.diff(left, right);
            const html = mods.formatter.format(delta, left);
            return { success: true, html };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ── Replay request ───────────────────────────────────────────────────────
    ipcMain.handle('replay-request', async (_, id) => {
        const req = db.getRequest(id);
        if (!req) return { success: false, error: 'Not found' };
        try {
            // Strip headers that break net.fetch or cause protocol errors
            const FORBIDDEN = new Set([
                'content-length', 'transfer-encoding', 'host', 'connection',
                'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization',
                'accept-encoding' // let Electron set this automatically
            ]);
            const rawHeaders = req.request_headers ? JSON.parse(req.request_headers) : {};
            const safeHeaders = {};
            for (const [k, v] of Object.entries(rawHeaders)) {
                if (!FORBIDDEN.has(k.toLowerCase())) safeHeaders[k] = v;
            }
            const isBodyless = ['GET', 'HEAD', 'OPTIONS'].includes((req.method || 'GET').toUpperCase());
            const resp = await netFetchWithTimeout(req.url, {
                method: req.method || 'GET',
                headers: safeHeaders,
                body: isBodyless ? undefined : (req.request_body || undefined)
            }, networkPolicy.timeouts.replayMs);
            const text = await resp.text();
            return { success: true, status: resp.status, body: text, original: req.response_body };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // ── Rules ────────────────────────────────────────────────────────────────
    ipcMain.handle('get-rules', async () => db.getRules());
    ipcMain.handle('save-rule', async (_, rule) => db.saveRuleAsync(rule));
    ipcMain.handle('delete-rule', async (_, id) => { await db.deleteRuleAsync(id); return true; });
    ipcMain.handle('toggle-rule', async (_, id, enabled) => { await db.toggleRuleAsync(id, enabled); return true; });

    // ── Intercept rules ──────────────────────────────────────────────────────
    ipcMain.handle('get-intercept-rules', async () => db.getAllInterceptRules());
    ipcMain.handle('save-intercept-rule', async (_, rule) => {
        const ri = require('../request-interceptor');
        const v = ri.validateInterceptRuleForSave(rule);
        if (!v.ok) return { error: v.error };

        const id = await db.saveInterceptRuleAsync(rule);
        if (interceptor) {
            interceptor.invalidateRulesCache();
            reattachInterceptorToAllTabs();
        }
        return { id };
    });
    ipcMain.handle('delete-intercept-rule', async (_, id) => {
        await db.deleteInterceptRuleAsync(id);
        if (interceptor) {
            interceptor.invalidateRulesCache();
            reattachInterceptorToAllTabs();
        }
        return true;
    });

    ipcMain.handle('test-intercept-notification', async () => {
        function broadcast(info) {
            broadcastInterceptRuleMatched(info);
        }
        broadcast({ type: 'mock', ruleName: 'Test Mock Rule', url: 'https://example.com/api/data', detail: '200 application/json', bodyPreview: '{"status":"ok","message":"mocked response"}' });
        setTimeout(() => broadcast({ type: 'block', ruleName: 'Test Block Rule', url: 'https://example.com/ads/tracker.js' }), 800);
        setTimeout(() => broadcast({ type: 'modifyHeaders', ruleName: 'Test Modify Rule', url: 'https://example.com/api/auth', detail: 'Set: X-Custom-Token; Remove: Cookie' }), 1600);
        return true;
    });
    ipcMain.handle('test-intercept-script', async (_, payload) => {
        try {
            const ri = require('../request-interceptor');
            return ri.runInterceptScriptSelfTest(payload || {});
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
    });

    // ── Proxy Manager ────────────────────────────────────────────────────────
    ipcMain.handle('open-proxy-manager', async () => { createProxyManagerWindow(); return true; });

    // ── Console Viewer ───────────────────────────────────────────────────────
    ipcMain.handle('open-console-viewer', async () => { createConsoleViewerWindow(); return true; });
    ipcMain.handle('get-console-history', () => _consoleBuffer.slice());
    ipcMain.handle('save-console-log', async (_, content) => {
        const { canceled, filePath } = await dialog.showSaveDialog(consoleViewerWindow || mainWindow, {
            title: 'Save Console Log',
            defaultPath: path.join(app.getPath('downloads'), `cupnet-console-${Date.now()}.log`),
            filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }]
        });
        if (canceled || !filePath) return false;
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    });

    // ── Page Analyzer ────────────────────────────────────────────────────────
    ipcMain.handle('open-page-analyzer', async () => { createPageAnalyzerWindow(); return true; });
    ipcMain.handle('open-ivac-scout', async () => { createIvacScoutWindow(); return true; });
    ipcMain.handle('get-ivac-scout-context', async () => getIvacScoutContext());
    ipcMain.handle('run-ivac-scout', async (_, opts) => runIvacScoutProcess(opts || {}));
    ipcMain.handle('stop-ivac-scout', async () => ({ stopped: stopIvacScoutProcess() }));
    ipcMain.handle('open-ivac-dump-folder', async () => {
        const dumpDir = path.join(__dirname, '_debug');
        fs.mkdirSync(dumpDir, { recursive: true });
        await shell.openPath(dumpDir);
        return true;
    });

    ipcMain.handle('analyze-page-forms', async (_, tabId) => {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return [];
        try {
            return await tab.view.webContents.executeJavaScript(`(${_analyzeFormsScript})()`);
        } catch { return []; }
    });

    ipcMain.handle('analyze-page-captcha', async (_, tabId) => {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return {};
        try {
            return await tab.view.webContents.executeJavaScript(`(${_analyzeCaptchaScript})()`);
        } catch { return {}; }
    });

    async function injectTurnstileTokenToTab(tabId, payload = {}) {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
            return { injected: false, submitted: false, updatedCount: 0, reason: 'tab-not-found' };
        }
        const tokenLiteral = JSON.stringify(String(payload.token || ''));
        const sitekeyLiteral = JSON.stringify(String(payload.sitekey || ''));
        const actionLiteral = JSON.stringify(String(payload.action || ''));
        const autoSubmitLiteral = payload.autoSubmit === true ? 'true' : 'false';
        const script = `(function(){
            var token = ${tokenLiteral};
            var sitekey = ${sitekeyLiteral};
            var action = ${actionLiteral};
            var autoSubmit = ${autoSubmitLiteral};
            if (!token) return { injected:false, submitted:false, updatedCount:0, reason:'missing-token' };
            var updated = 0;
            var callbacksInvoked = 0;
            var forms = [];
            var callbackFns = [];
            var callbackNames = [];
            function safePushCallback(fn, name){
                if (typeof fn !== 'function') return;
                if (callbackFns.indexOf(fn) !== -1) return;
                callbackFns.push(fn);
                callbackNames.push(name || 'anonymous');
            }
            function setNativeValue(inp, value) {
                try {
                    var proto = (inp && inp.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc && typeof desc.set === 'function') {
                        desc.set.call(inp, value);
                        return;
                    }
                } catch {}
                try { inp.value = value; } catch {}
            }
            function markInput(inp) {
                if (!inp) return;
                try {
                    setNativeValue(inp, token);
                    inp.setAttribute('value', token);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    inp.dispatchEvent(new Event('blur', { bubbles: true }));
                    updated++;
                    if (inp.form && forms.indexOf(inp.form) === -1) forms.push(inp.form);
                } catch {}
            }
            function all(sel) {
                try { return Array.from(document.querySelectorAll(sel)); } catch { return []; }
            }
            all('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').forEach(markInput);
            all('input[id$="_response"], textarea[id$="_response"]').forEach(function(el){
                var id = String(el.id || '').toLowerCase();
                if (id.indexOf('cf-chl-widget-') === 0) markInput(el);
            });
            all('.cf-turnstile, [data-turnstile-widget-id]').forEach(function(node){
                var nodeSitekey = String(node.getAttribute('data-sitekey') || '');
                var nodeAction = String(node.getAttribute('data-action') || '');
                var cbName = String(node.getAttribute('data-callback') || '').trim();
                if (cbName && typeof window[cbName] === 'function') safePushCallback(window[cbName], cbName);
                if (sitekey && nodeSitekey && sitekey !== nodeSitekey) return;
                if (action && nodeAction && action !== nodeAction) return;
                var form = node.closest('form');
                var holder = form || node.parentElement || document.body;
                if (!holder) return;
                var hidden = holder.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
                if (!hidden) {
                    hidden = document.createElement('input');
                    hidden.type = 'hidden';
                    hidden.name = 'cf-turnstile-response';
                    holder.appendChild(hidden);
                }
                markInput(hidden);
            });

            try {
                var knownCbNames = ['onTurnstileSuccess', 'turnstileCallback', 'onCaptchaSolved', 'onCaptchaSuccess'];
                knownCbNames.forEach(function(name){
                    if (typeof window[name] === 'function') safePushCallback(window[name], name);
                });
            } catch {}

            try {
                var cfg = window.___turnstile_cfg;
                var clients = cfg && cfg.clients ? cfg.clients : null;
                var visited = [];
                function walk(obj, depth) {
                    if (!obj || depth > 6) return;
                    if (visited.indexOf(obj) !== -1) return;
                    visited.push(obj);
                    var keys = [];
                    try { keys = Object.keys(obj); } catch { return; }
                    for (var i = 0; i < keys.length; i++) {
                        var k = keys[i];
                        var v = obj[k];
                        if (!v) continue;
                        if (typeof v === 'function') continue;
                        if (typeof v === 'object') {
                            try {
                                if (typeof v.callback === 'function') {
                                    var sk = String(v.sitekey || v.siteKey || '');
                                    var ac = String(v.action || '');
                                    var skOk = !sitekey || !sk || sk === sitekey;
                                    var acOk = !action || !ac || ac === action;
                                    if (skOk && acOk) safePushCallback(v.callback, '___turnstile_cfg.callback');
                                }
                            } catch {}
                            walk(v, depth + 1);
                        }
                    }
                }
                if (clients && typeof clients === 'object') walk(clients, 0);
            } catch {}

            callbackFns.forEach(function(fn){
                try {
                    fn(token);
                    callbacksInvoked++;
                } catch {}
            });
            var submitted = false;
            if (autoSubmit) {
                var form = forms.find(function(f){ return !!f; }) || document.querySelector('form');
                if (form) {
                    try {
                        if (typeof form.requestSubmit === 'function') form.requestSubmit();
                        else form.submit();
                        submitted = true;
                    } catch {}
                }
            }
            var injected = updated > 0 || callbacksInvoked > 0;
            return {
                injected: injected,
                submitted: submitted,
                updatedCount: updated,
                callbacksInvoked: callbacksInvoked,
                reason: injected ? 'ok' : 'no-input-found'
            };
        })()`;
        try {
            return await tab.view.webContents.executeJavaScript(script);
        } catch {
            return { injected: false, submitted: false, updatedCount: 0, reason: 'script-execution-failed' };
        }
    }

    function formatSolverError(err) {
        const fallback = { code: 'SOLVER_ERROR', message: 'Unknown solver error', retryable: true };
        if (!err) return fallback;
        const code = String(err.code || 'SOLVER_ERROR');
        const message = String(err.message || fallback.message);
        const nonRetryable = new Set(['MISSING_API_KEY', 'INVALID_API_KEY', 'MISSING_PAGE_URL', 'MISSING_SITEKEY', 'TASK_NOT_SUPPORTED']);
        return {
            code,
            message,
            retryable: !nonRetryable.has(code),
            details: err.details || {},
        };
    }

    function extractTurnstileSitekey(item = {}) {
        const direct = String(item.sitekey || '').trim();
        if (direct) return direct;
        const iframeSrc = String(item.iframeSrc || '').trim();
        if (!iframeSrc) return '';
        try {
            const u = new URL(iframeSrc);
            return String(
                u.searchParams.get('k')
                || u.searchParams.get('sitekey')
                || u.searchParams.get('render')
                || ''
            ).trim();
        } catch {
            return '';
        }
    }

    async function discoverTurnstilePayloadFromPage(tabId, fallbackPayload = {}) {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return fallbackPayload;
        const base = { ...(fallbackPayload || {}) };
        if (!base.pageUrl) {
            try { base.pageUrl = tab.view.webContents.getURL() || tab.url || ''; } catch (err) {
                safeCatch({ module: 'main', eventCode: 'captcha.context.discovery_failed', context: { field: 'pageUrl', tabId } }, err, 'info');
            }
        }
        if (base.sitekey) return base;
        try {
            const data = await tab.view.webContents.executeJavaScript(`(${_analyzeCaptchaScript})()`);
            const turns = Array.isArray(data?.turnstile) ? data.turnstile : [];
            const item = turns.find(x => extractTurnstileSitekey(x)) || turns[0] || {};
            const discoveredSitekey = extractTurnstileSitekey(item);
            return {
                ...base,
                sitekey: discoveredSitekey || base.sitekey || '',
                action: base.action || item.action || '',
                cData: base.cData || item.cData || '',
                iframeSrc: base.iframeSrc || item.iframeSrc || '',
                pageUrl: base.pageUrl || data?.pageUrl || '',
            };
        } catch {
            return base;
        }
    }

    ipcMain.handle('get-capmonster-settings', () => getCapmonsterSettings());
    ipcMain.handle('save-capmonster-settings', (_, cfg) => {
        const s = loadSettings();
        s.capmonster = normalizeCapmonsterSettings({ ...(s.capmonster || {}), ...(cfg || {}) });
        saveSettings(s);
        return s.capmonster;
    });
    ipcMain.handle('inject-turnstile-token', async (_, tabId, payload) => {
        return await injectTurnstileTokenToTab(tabId, payload || {});
    });
    ipcMain.handle('solve-turnstile-captcha', async (_, tabId, captcha, options = {}) => {
        try {
            const tab = tabManager.getTab(tabId);
            if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
                return { ok: false, error: { code: 'TAB_NOT_FOUND', message: 'Target tab not found.', retryable: false } };
            }
            const settings = getCapmonsterSettings();
            const merged = {
                ...settings,
                ...(options || {}),
                apiKey: String((options && options.apiKey) || settings.apiKey || '').trim(),
            };
            const hydratedCaptcha = await discoverTurnstilePayloadFromPage(tabId, {
                ...(captcha || {}),
                sitekey: extractTurnstileSitekey(captcha || {}),
            });
            const pageUrl = String(hydratedCaptcha.pageUrl || tab.url || tab.view.webContents.getURL() || '');
            const sitekey = String(hydratedCaptcha.sitekey || '');
            const action = String(hydratedCaptcha.action || '');
            const cData = String(hydratedCaptcha.cData || '');
            const userAgent = String(tab.view.webContents.getUserAgent() || '');

            const solved = await solveTurnstileWithCapMonster({
                apiKey: merged.apiKey,
                pageUrl,
                sitekey,
                action,
                cData,
                userAgent,
                timeoutMs: merged.pollTimeoutMs,
                pollIntervalMs: merged.pollIntervalMs,
            });

            let injectResult = { injected: false, submitted: false, updatedCount: 0, reason: 'auto-inject-disabled' };
            if (merged.autoInject) {
                injectResult = await injectTurnstileTokenToTab(tabId, {
                    token: solved.token,
                    sitekey,
                    action,
                    autoSubmit: merged.autoSubmit === true,
                });
            }

            return {
                ok: true,
                token: solved.token,
                taskId: solved.taskId,
                cost: solved.cost,
                solveCount: solved.solveCount,
                createdAt: solved.createdAt,
                endedAt: solved.endedAt,
                inject: injectResult,
            };
        } catch (err) {
            if (err instanceof CaptchaSolverError) {
                return { ok: false, error: formatSolverError(err) };
            }
            return { ok: false, error: formatSolverError(new CaptchaSolverError('SOLVER_ERROR', err?.message || 'Unknown solver error')) };
        }
    });

    ipcMain.handle('analyze-page-meta', async (_, tabId) => {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return {};
        try {
            return await tab.view.webContents.executeJavaScript(`(${_analyzeMetaScript})()`);
        } catch { return {}; }
    });

    const _dumpWebStorageScript = `(function(){
        function dump(store) {
            var o = {};
            try {
                var n = store.length;
                for (var i = 0; i < n; i++) {
                    var k = store.key(i);
                    if (k != null) o[k] = store.getItem(k);
                }
            } catch (e) {}
            return o;
        }
        return { sessionStorage: dump(sessionStorage), localStorage: dump(localStorage) };
    })`;

    ipcMain.handle('analyze-page-storage', async (_, tabId) => {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
            return { sessionStorage: {}, localStorage: {} };
        }
        try {
            return await tab.view.webContents.executeJavaScript(_dumpWebStorageScript + '()');
        } catch {
            return { sessionStorage: {}, localStorage: {} };
        }
    });

    ipcMain.handle('apply-page-storage', async (_, tabId, payload) => {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
            return { ok: false, error: 'no-tab' };
        }
        const target = payload?.target === 'local' ? 'local' : 'session';
        const entries = payload?.entries;
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
            return { ok: false, error: 'entries must be a plain object' };
        }
        const storeName = target === 'local' ? 'localStorage' : 'sessionStorage';
        let literal;
        try {
            literal = JSON.stringify(entries);
        } catch {
            return { ok: false, error: 'entries not serializable' };
        }
        const script = `(function(){
            try {
                var entries = ${literal};
                if (!entries || typeof entries !== 'object' || Array.isArray(entries))
                    return { ok:false, error:'bad-entries' };
                var store = window['${storeName}'];
                var nextKeys = Object.keys(entries);
                var nk = Object.create(null);
                for (var i = 0; i < nextKeys.length; i++) nk[nextKeys[i]] = true;
                for (var i = store.length - 1; i >= 0; i--) {
                    var k = store.key(i);
                    if (k != null && !nk[k]) store.removeItem(k);
                }
                for (var i = 0; i < nextKeys.length; i++) {
                    var k = nextKeys[i];
                    var v = entries[k];
                    store.setItem(k, v == null ? '' : String(v));
                }
                return { ok: true };
            } catch (e) {
                return { ok: false, error: String(e && e.message ? e.message : e) };
            }
        })()`;
        try {
            const out = await tab.view.webContents.executeJavaScript(script);
            if (out && out.ok) return { ok: true };
            return { ok: false, error: (out && out.error) || 'script-failed' };
        } catch (err) {
            return { ok: false, error: String(err?.message || err) };
        }
    });

    ipcMain.handle('analyze-page-endpoints', async (_, tabId) => {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return {};
        try {
            return await tab.view.webContents.executeJavaScript(`(${_analyzeEndpointsScript})()`);
        } catch { return {}; }
    });

    ipcMain.handle('page-analyzer-action', async (_, tabId, action) => {
        const tab = tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return false;
        try {
            const fi = Number(action.formIndex);
            const fld = Number(action.fieldIndex);
            const valueLiteral = JSON.stringify(action.value == null ? '' : String(action.value));
            const script = `(function(){
                var forms=document.querySelectorAll('form');
                if(!forms[${fi}]) return 'no-form';
                var el=forms[${fi}].elements[${fld}];
                if(!el) return 'no-field';
                var act='${action.type}';
                var newValue=${valueLiteral};
                function ensureVisible(node) {
                    if (!node || node.nodeType !== 1) return;
                    var cur = node;
                    while (cur && cur.nodeType === 1) {
                        var cs = window.getComputedStyle(cur);
                        if (cur.hidden) cur.hidden = false;
                        if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') cur.removeAttribute('aria-hidden');
                        if (cs.display === 'none') {
                            cur.style.display = '';
                            if (window.getComputedStyle(cur).display === 'none') cur.style.display = 'block';
                        }
                        if (cs.visibility === 'hidden') cur.style.visibility = 'visible';
                        if (cs.opacity === '0') cur.style.opacity = '1';
                        cur = cur.parentElement;
                    }
                }
                if(act==='focus'){
                    el.scrollIntoView({behavior:'smooth',block:'center'});
                    el.focus();
                    el.style.outline='3px solid #3b82f6';
                    el.style.outlineOffset='2px';
                    setTimeout(function(){el.style.outline='';el.style.outlineOffset=''},3000);
                } else if(act==='show'){
                    if(el.type==='hidden') el.type='text';
                    ensureVisible(el);
                    el.removeAttribute && el.removeAttribute('hidden');
                    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') el.removeAttribute('aria-hidden');
                    el.style.cssText='display:block !important;visibility:visible !important;opacity:1 !important;position:static !important;width:auto !important;height:auto !important;min-height:24px !important;border:2px dashed #f59e0b !important;padding:4px !important;background:rgba(245,158,11,0.08) !important;';
                    el.scrollIntoView({behavior:'smooth',block:'center'});
                } else if(act==='hide'){
                    el.hidden = true;
                    if (el.setAttribute) el.setAttribute('aria-hidden', 'true');
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('visibility', 'hidden', 'important');
                    el.style.setProperty('opacity', '0', 'important');
                } else if(act==='toggle-disabled'){
                    el.disabled = !el.disabled;
                } else if(act==='toggle-password-visibility'){
                    var t = (el.type || '').toLowerCase();
                    if (t === 'password') {
                        try { el.type = 'text'; } catch {}
                    } else if (t === 'text') {
                        try { el.type = 'password'; } catch {}
                    }
                } else if(act==='set-value'){
                    var tag = (el.tagName || '').toLowerCase();
                    var type = (el.type || '').toLowerCase();
                    if (type === 'checkbox' || type === 'radio') {
                        var v = String(newValue).toLowerCase();
                        el.checked = (v === '1' || v === 'true' || v === 'yes' || v === 'on');
                    } else if (tag === 'select') {
                        el.value = newValue;
                    } else {
                        el.value = newValue;
                    }
                    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                }
                return 'ok';
            })()`;
            const result = await tab.view.webContents.executeJavaScript(script);
            return result === 'ok';
        } catch { return false; }
    });

    const _appStartTime = Date.now();
    let _startupSplashConsumed = false;
    function consumeStartupSplashState() {
        if (_startupSplashConsumed) return { show: false, durationMs: 0 };
        _startupSplashConsumed = true;
        return { show: true, durationMs: 3000 };
    }
    ipcMain.handle('get-uptime', () => Date.now() - _appStartTime);
    ipcMain.handle('consume-startup-splash', () => consumeStartupSplashState());
    ipcMain.handle('get-app-version', () => app.getVersion());

    ipcMain.handle('get-ui-pref', (_, key, def) => {
        const v = loadUiPrefs()[key];
        return v !== undefined ? v : (def !== undefined ? def : null);
    });
    ipcMain.handle('set-ui-pref', (_, key, value) => { saveUiPref(key, value); return true; });

    ipcMain.handle('check-ip-geo', async () => checkCurrentIpGeo());

    ipcMain.handle('get-direct-ip', async () => {
        try {
            const directSess = session.fromPartition('direct-ip-check');
            await directSess.setProxy({ mode: 'direct' });
            const win = new BrowserWindow({ show: false, webPreferences: { session: directSess } });
            try {
                await win.loadURL('https://ipinfo.io/json');
                const text = await win.webContents.executeJavaScript('document.body.innerText');
                const d = JSON.parse(text);
                return { ip: d.ip || '', city: d.city || '', country: d.country || '', country_name: d.country || '', region: d.region || '', org: d.org || '' };
            } finally {
                win.destroy();
            }
        } catch (e) {
            sysLog('warn', 'direct-ip', 'Failed to get direct IP: ' + (e?.message || e));
            return { ip: '', city: '', country: '', country_name: '' };
        }
    });

    ipcMain.handle('get-current-proxy', async () => {
        const isDirect = !persistentAnonymizedProxyUrl && actProxy === '';
        return {
            active:    !!persistentAnonymizedProxyUrl,
            proxyName: connectedProfileName || actProxy || '',
            mode:      isDirect ? 'direct' : (persistentAnonymizedProxyUrl ? 'proxy' : 'none'),
            trafficMode: getCurrentTrafficMode(),
            effectiveMode: getCurrentTrafficMode(),
            profileId: connectedProfileId || null,
            resolvedVars: connectedResolvedVars || {},
        };
    });

    ipcMain.handle('connect-proxy-template', async (_, profileId, ephemeralVars) => {
        // Get the encrypted template URL from DB
        const row = db.getProxyProfileEncrypted(profileId);
        if (!row) return { success: false, error: 'Profile not found' };
        let template = null;
        if (row.url_encrypted && safeStorage.isEncryptionAvailable()) {
            try { template = safeStorage.decryptString(row.url_encrypted); } catch (e) { sysLog('warn', 'proxy', 'decrypt proxy template failed: ' + (e?.message || e)); }
        }
        if (!template) return { success: false, error: 'Cannot decrypt template' };

        const savedVars  = row.variables ? JSON.parse(row.variables) : {};
        const mergedVars = { ...savedVars, ...(ephemeralVars || {}) };
        const resolvedVars = {};
        const resolvedUrl = parseProxyTemplate(template, mergedVars, resolvedVars);
        const profileTrafficMode = normalizeTrafficMode(row.traffic_mode);
        if (row.traffic_mode && row.traffic_mode !== profileTrafficMode) {
            sysLog('warn', 'traffic.mode.fallback', `Invalid profile mode "${row.traffic_mode}" -> "${profileTrafficMode}"`);
        }
        const fallbackCandidates = parseFallbackProxyList(
            mergedVars.FALLBACK_PROXIES || mergedVars.fallback_proxies || mergedVars.fallbackProxies
        );

        try {
            const proxyConnect = await connectProxyWithFailover(resolvedUrl, fallbackCandidates);
            if (proxyConnect?.used && proxyConnect.used !== resolvedUrl) {
                resolvedVars.__usedFallbackProxy = proxyConnect.used;
            }
            await applyEffectiveTrafficMode(profileTrafficMode, persistentAnonymizedProxyUrl, {
                source: 'connect-proxy-template',
                profileId,
            });

            // Apply fingerprint from profile
            activeFingerprint = {
                user_agent: row.user_agent || null,
                timezone:   row.timezone   || null,
                language:   row.language   || null,
            };
            if (activeFingerprint.user_agent) {
                // Apply session-level UA for all tab sessions
                for (const tab of tabManager.getAllTabs()) {
                    if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                        try { tab.view.webContents.session.setUserAgent(activeFingerprint.user_agent, activeFingerprint.language || ''); } catch (e) { sysLog('warn', 'fingerprint', 'setUserAgent for tab failed: ' + (e?.message || e)); }
                    }
                }
            }
            await applyFingerprintToAllTabs(activeFingerprint);

            // Apply TLS fingerprint profile
            if (mitmProxy) {
                const tlsMode    = row.tls_ja3_mode   || 'template';
                const tlsProfile = row.tls_profile    || 'chrome';
                const tlsJa3     = row.tls_ja3_custom || null;
                if (tlsMode === 'custom' && tlsJa3) {
                    // Custom JA3 → apply via worker
                    mitmProxy.setBrowser(tlsProfile);
                    if (mitmProxy.worker && mitmProxy.worker.ready) {
                        // Send a dummy request with ja3 to pre-warm the session with the custom fingerprint
                        // The ja3 is applied per-request in azure-tls-worker.js
                        mitmProxy._activeJa3 = tlsJa3;
                    }
                } else {
                    mitmProxy.setBrowser(tlsProfile);
                    mitmProxy._activeJa3 = null;
                }
                // Notify toolbar
                broadcastTlsProfileChanged(tlsProfile);
            }

            connectedProfileId = profileId;
            connectedProfileName = row.name || null;
            connectedResolvedVars = resolvedVars || {};
            buildMenu();
            notifyProxyStatus();

            checkCurrentIpGeo().then(geo => {
                db.updateProxyProfileGeoAsync(profileId, geo.ip, `${geo.city}, ${geo.country_name}`).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'updateProxyProfileGeo', profileId } }, err);
                });
                notifyProxyProfilesList();
            }).catch(e => sysLog('warn', 'proxy', 'geo check after proxy connect failed: ' + (e?.message || e)));
            return { success: true, resolvedUrl, resolvedVars };
        } catch (e) {
            sysLog('warn', 'proxy', 'connect-proxy-template failed, switching to direct mode: ' + (e?.message || e));
            try {
                if (persistentAnonymizedProxyUrl) {
                    await withTimeout(
                        ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true),
                        networkPolicy.timeouts.proxyOperationMs,
                        'Proxy close timeout'
                    );
                    persistentAnonymizedProxyUrl = null;
                }
                actProxy = '';
                connectedProfileId = null;
                connectedProfileName = null;
                connectedResolvedVars = {};
                await applyEffectiveTrafficMode(profileTrafficMode, null, {
                    source: 'connect-proxy-template.fallback',
                    profileId,
                });
                buildMenu();
                notifyProxyStatus();
            } catch (fallbackErr) {
                sysLog('warn', 'proxy', 'direct fallback after proxy failure also failed: ' + (fallbackErr?.message || fallbackErr));
            }
            return { success: false, error: e.message, fallback: 'direct' };
        }
    });

    ipcMain.handle('apply-quick-proxy-change', async (_, proxyUrl) => {
        try {
            if (!proxyUrl || typeof proxyUrl !== 'string') return { success: false, error: 'Invalid proxy URL' };
            const anonymized = await quickChangeProxy(proxyUrl);
            await applyEffectiveTrafficMode(getCurrentTrafficMode(), anonymized, {
                source: 'quick-proxy-change',
            });
            buildMenu();
            notifyProxyStatus();
            return { success: true, message: 'Proxy applied successfully' };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('disconnect-proxy', async () => {
        try {
            if (persistentAnonymizedProxyUrl) {
                await withTimeout(
                    ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true),
                    networkPolicy.timeouts.proxyOperationMs,
                    'Proxy close timeout'
                );
                persistentAnonymizedProxyUrl = null;
            }
            actProxy = '';
            connectedProfileId = null;
            connectedProfileName = null;
            connectedResolvedVars = {};
            await applyEffectiveTrafficMode(getCurrentTrafficMode(), null, {
                source: 'disconnect-proxy',
            });

            // Reset fingerprint overrides
            if (activeFingerprint) {
                for (const tab of tabManager.getAllTabs()) {
                    if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                        resetFingerprintOnWebContents(tab.view.webContents).catch(e => sysLog('warn', 'fingerprint', 'reset fingerprint on disconnect failed: ' + (e?.message || e)));
                    }
                }
                activeFingerprint = null;
            }

            buildMenu();
            notifyProxyStatus();
            // No reload needed — MITM upstream switches instantly
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('save-proxy-profile-full', async (_, profile) => {
        // profile: { id?, name, template, variables, notes, country }
        let urlEncrypted = null, urlDisplay = profile.template;
        try {
            if (safeStorage.isEncryptionAvailable()) {
                urlEncrypted = safeStorage.encryptString(profile.template);
                // Mask password in display string
                try {
                    const u = new URL(profile.template.replace(/\{[^}]+\}/g, 'PLACEHOLDER'));
                    if (u.password) urlDisplay = profile.template.replace(u.password, '***');
                } catch (err) {
                    safeCatch({ module: 'main', eventCode: 'proxy.profile.parse.failed', context: { op: 'mask-password-template' } }, err, 'info');
                }
            }
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'proxy.profile.encrypt.failed', context: { op: 'save-proxy-profile-full' } }, err);
        }

        if (profile.id) {
            await db.updateProxyProfileByIdAsync(profile.id, {
                name:          profile.name,
                url_encrypted: urlEncrypted,
                url_display:   urlDisplay,
                is_template:   1,
                variables:     profile.variables || {},
                notes:         profile.notes || '',
                country:       profile.country || '',
                traffic_mode:  'mitm',
                user_agent:    profile.user_agent || null,
                timezone:      profile.timezone   || null,
                language:      profile.language   || null,
            });
            notifyProxyProfilesList();
            return { success: true, id: profile.id };
        }

        const id = await db.saveProxyProfileAsync(profile.name, urlEncrypted, urlDisplay, {
            isTemplate: 1,
            variables:  profile.variables || {},
            notes:      profile.notes || '',
            country:    profile.country || '',
            traffic_mode: 'mitm',
            user_agent: profile.user_agent || null,
            timezone:   profile.timezone   || null,
            language:   profile.language   || null,
        });
        notifyProxyProfilesList();
        return { success: true, id };
    });

    ipcMain.handle('test-proxy-template', async (_, profileId, ephemeralVars) => {
        const row = db.getProxyProfileEncrypted(profileId);
        if (!row) return { success: false, error: 'Profile not found' };
        let template = null;
        if (row.url_encrypted && safeStorage.isEncryptionAvailable()) {
            try { template = safeStorage.decryptString(row.url_encrypted); } catch (e) { sysLog('warn', 'proxy', 'decrypt test proxy template failed: ' + (e?.message || e)); }
        }
        if (!template) return { success: false, error: 'Cannot decrypt' };
        const savedVars  = row.variables ? JSON.parse(row.variables) : {};
        const resolved   = parseProxyTemplate(template, { ...savedVars, ...(ephemeralVars || {}) });
        const start      = Date.now();
        const result     = await testProxy(resolved);
        const latency    = Date.now() - start;
        if (result.success && result.data) {
            const ip  = result.data.ip || '';
            const geo = [result.data.city, result.data.country].filter(Boolean).join(', ');
            await db.updateProxyProfileTestAsync(profileId, latency, ip, geo);
            notifyProxyProfilesList();
        }
        return { ...result, latency, resolvedUrl: resolved };
    });

    // ── Proxy profiles ───────────────────────────────────────────────────────
    ipcMain.handle('get-proxy-profiles', async () => db.getProxyProfiles());

    ipcMain.handle('save-proxy-profile', async (_, name, url, country) => {
        let urlEncrypted = null;
        let urlDisplay   = url;
        try {
            if (safeStorage.isEncryptionAvailable()) {
                urlEncrypted = safeStorage.encryptString(url);
                // Strip password from display
                try {
                    const u = new URL(url);
                    if (u.password) u.password = '***';
                    urlDisplay = u.toString();
                } catch (err) {
                    safeCatch({ module: 'main', eventCode: 'proxy.profile.parse.failed', context: { op: 'mask-password' } }, err, 'info');
                }
            }
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'proxy.profile.encrypt.failed', context: { op: 'save-proxy-profile' } }, err);
        }
        return db.saveProxyProfileAsync(name, urlEncrypted, urlDisplay, country);
    });

    ipcMain.handle('get-proxy-profile-url', async (_, id) => {
        const row = db.getProxyProfileEncrypted(id);
        if (!row) return null;
        if (row.url_encrypted && safeStorage.isEncryptionAvailable()) {
            try { return safeStorage.decryptString(row.url_encrypted); } catch (e) { sysLog('warn', 'proxy', 'decrypt profile URL failed: ' + (e?.message || e)); }
        }
        return null;
    });

    ipcMain.handle('delete-proxy-profile', async (_, id) => { await db.deleteProxyProfileAsync(id); return true; });

    ipcMain.handle('test-proxy-profile', async (_, id) => {
        const row = db.getProxyProfileEncrypted(id);
        if (!row) return { success: false, error: 'Profile not found' };
        let url = null;
        if (row.url_encrypted && safeStorage.isEncryptionAvailable()) {
            try { url = safeStorage.decryptString(row.url_encrypted); } catch (e) { sysLog('warn', 'proxy', 'decrypt profile URL for test failed: ' + (e?.message || e)); }
        }
        if (!url) return { success: false, error: 'Cannot decrypt URL' };
        const start = Date.now();
        const result = await testProxy(url);
        const latency = Date.now() - start;
        if (result.success) await db.updateProxyProfileTestAsync(id, latency);
        return { ...result, latency };
    });

    // ── Screenshots ──────────────────────────────────────────────────────────
    ipcMain.handle('take-screenshot', async (_, reason, meta) => {
        const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'click';
        return requestScreenshot({ reason: normalizedReason, meta });
    });

    // Lazy-load single screenshot image data by DB id (avoids sending all base64 on log-viewer open)
    ipcMain.handle('get-screenshot-data', (_, id) => db.getScreenshotData(id) || null);

    ipcMain.handle('save-screenshot', async (_, imageData, filename) => {
        try {
            const { canceled, filePath } = await dialog.showSaveDialog({
                title: 'Save Screenshot',
                defaultPath: path.join(app.getPath('pictures'), filename.replace(/[^a-zA-Z0-9-_.]/g, '_') + '.png'),
                filters: [{ name: 'PNG Images', extensions: ['png'] }]
            });
            if (canceled) return { success: false };
            fs.writeFileSync(filePath, Buffer.from(imageData, 'base64'));
            return { success: true, path: filePath };
        } catch (err) { return { success: false, error: err.message }; }
    });

    ipcMain.handle('copy-screenshot', async (_, imageData) => {
        try {
            clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(imageData, 'base64')));
            return { success: true };
        } catch (err) { return { success: false, error: err.message }; }
    });

    // ── Trace mode (full req/res to cupnet-trace.jsonl) ───────────────────────
    ipcMain.handle('get-trace-mode', async () => (cachedSettings || loadSettings()).traceMode === true);
    ipcMain.handle('set-trace-mode', async (_, enabled) => {
        const s = loadSettings();
        s.traceMode = !!enabled;
        saveSettings(s);
        return true;
    });
    ipcMain.handle('get-trace-path', async () => path.join(app.getPath('userData'), 'cupnet-trace.jsonl'));
    ipcMain.handle('open-trace-file', async () => {
        const p = path.join(app.getPath('userData'), 'cupnet-trace.jsonl');
        if (fs.existsSync(p)) shell.openPath(p);
        else shell.showItemInFolder(app.getPath('userData'));
        return true;
    });
    ipcMain.handle('has-trace-data', async () => {
        const s = cachedSettings || loadSettings();
        if (s.traceMode) return true;
        return db && db.countTraceEntries() > 0;
    });
    ipcMain.handle('open-trace-viewer', () => {
        const live = traceWindows.find(w => !w.isDestroyed());
        if (live) { if (live.isMinimized()) live.restore(); live.focus(); return; }
        const s = cachedSettings || loadSettings();
        if (!s.traceMode && (!db || db.countTraceEntries() === 0)) return;
        createTraceViewerWindow();
    });
    ipcMain.handle('get-trace-entries', async (_, limit, offset) => {
        return db ? db.queryTraceEntries(limit ?? 300, offset ?? 0) : [];
    });
    ipcMain.handle('get-trace-entry', async (_, id) => {
        return db ? db.getTraceEntry(id) : null;
    });
    ipcMain.handle('count-trace-entries', async () => {
        return db ? db.countTraceEntries() : 0;
    });
    ipcMain.handle('clear-trace-entries', async () => {
        if (db) db.clearTraceEntries();
        return true;
    });

    // ── Homepage ─────────────────────────────────────────────────────────────
    ipcMain.handle('get-homepage', async () => cachedSettings?.homepage || '');

    ipcMain.handle('set-homepage', async (_, url) => {
        const settings = loadSettings();
        settings.homepage = (url || '').trim();
        saveSettings(settings);
        return true;
    });

    // ── Cookie Manager ───────────────────────────────────────────────────────
    ipcMain.handle('get-cookies', async (_, tabId, filter) => {
        const tab = tabId ? tabManager.getTab(tabId) : tabManager.getActiveTab();
        if (!tab) return [];
        return tab.tabSession.cookies.get(filter || {});
    });

    ipcMain.handle('set-cookie', async (_, tabId, details) => {
        const tab = tabId ? tabManager.getTab(tabId) : tabManager.getActiveTab();
        if (!tab) return { success: false, error: 'Tab not found' };
        try {
            await tab.tabSession.cookies.set(details);
            await tab.tabSession.cookies.flushStore();
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('remove-cookie', async (_, tabId, url, name) => {
        const tab = tabId ? tabManager.getTab(tabId) : tabManager.getActiveTab();
        if (!tab) return false;
        await tab.tabSession.cookies.remove(url, name);
        return true;
    });

    ipcMain.handle('clear-cookies', async (_, tabId, domain) => {
        const tab = tabId ? tabManager.getTab(tabId) : tabManager.getActiveTab();
        if (!tab) return { success: false, error: 'Tab not found' };
        try {
            const filter = domain ? { domain } : {};
            const cookies = await tab.tabSession.cookies.get(filter);
            for (const c of cookies) {
                const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
                try { await tab.tabSession.cookies.remove(url, c.name); } catch (e) { sysLog('warn', 'tabs', 'cookie remove failed: ' + (e?.message || e)); }
            }
            await tab.tabSession.cookies.flushStore();
            return { success: true, count: cookies.length };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('share-cookies', async (_, fromTabId, toTabId, domain) => {
        const fromTab = tabManager.getTab(fromTabId);
        const toTab   = tabManager.getTab(toTabId);
        if (!fromTab || !toTab) return { success: false, error: 'Tab not found' };
        try {
            const filter  = domain ? { domain } : {};
            const cookies = await fromTab.tabSession.cookies.get(filter);
            let count = 0;
            for (const c of cookies) {
                const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
                try { await toTab.tabSession.cookies.set({ ...c, url }); count++; } catch (e) { sysLog('warn', 'tabs', 'cookie share/set failed: ' + (e?.message || e)); }
            }
            await toTab.tabSession.cookies.flushStore();
            return { success: true, count };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // ── DNS Overrides ────────────────────────────────────────────────────────
    ipcMain.handle('open-dns-manager', async () => {
        createDnsManagerWindow();
        return true;
    });

    ipcMain.handle('dns-overrides-list', async () => {
        return db ? db.getDnsOverrides() : [];
    });

    ipcMain.handle('dns-overrides-save', async (_, payload) => {
        const host = String(payload?.host || '').trim().toLowerCase();
        const ip = String(payload?.ip || '').trim();
        const enabled = payload?.enabled !== false;
        const id = payload?.id ? Number(payload.id) : null;

        if (!isValidDnsHost(host)) return { success: false, error: 'Invalid host' };

        const mitm_inject_cors = payload?.mitm_inject_cors === true;
        const isWildcard = host.startsWith('*.');
        if (isWildcard && ip) return { success: false, error: 'Wildcard host (*.…) cannot be combined with IPv4' };
        if (isWildcard && !mitm_inject_cors) return { success: false, error: 'Wildcard host requires MITM CORS' };
        if (mitm_inject_cors) {
            if (ip && !isValidIpv4(ip)) return { success: false, error: 'Invalid IPv4 address' };
        } else {
            if (!isValidIpv4(ip)) return { success: false, error: 'Invalid IPv4 address' };
        }
        const rewrite_host = String(payload?.rewrite_host ?? '').trim();
        try {
            const savedId = await db.saveDnsOverrideAsync({ id, host, ip, enabled, mitm_inject_cors, rewrite_host });
            syncDnsOverridesToMitm();
            return { success: true, id: savedId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('dns-overrides-delete', async (_, id) => {
        try {
            await db.deleteDnsOverrideAsync(Number(id));
            syncDnsOverridesToMitm();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('dns-overrides-toggle', async (_, id, enabled) => {
        try {
            await db.toggleDnsOverrideAsync(Number(id), !!enabled);
            syncDnsOverridesToMitm();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('isolate-tab', async (_, tabId) => {
        const tid = tabId || tabManager.getActiveTabId();
        const result = await tabManager.isolateTab(tid);
        // Attach interceptor to the new isolated session so request rules apply
        if (result?.success && interceptor) {
            const tab = tabManager.getTab(tid);
            if (tab) {
                try { interceptor.attachToSession(tab.tabSession, tid); } catch (e) { sysLog('warn', 'tabs', 'interceptor attach on isolate-tab failed: ' + (e?.message || e)); }
            }
        }
        return result;
    });

    ipcMain.handle('new-isolated-tab', async () => {
        const tabId = await tabManager.createTab(
            persistentAnonymizedProxyUrl || null,
            getNewTabUrl(),
            true,           // isolated = true
            null            // no shared session — fresh empty cookies
        );
        tabManager.switchTab(tabId);
        const tab = tabManager.getTab(tabId);
        if (tab) {
            setupNetworkLogging(tab.view.webContents, tabId, currentSessionId);
            if (interceptor) {
                try { interceptor.attachToSession(tab.tabSession, tabId); } catch (e) { sysLog('warn', 'tabs', 'interceptor attach on new-isolated-tab failed: ' + (e?.message || e)); }
            }
        }
        notifyCookieManagerTabs();
        return tabId;
    });

    ipcMain.handle('open-cookie-manager', async (_, tabId) => {
        createCookieManagerWindow(tabId || tabManager.getActiveTabId());
        return true;
    });

    // ── DevTools for active tab ──────────────────────────────────────────────
    ipcMain.handle('open-devtools', async () => {
        const tab = tabManager?.getActiveTab();
        if (tab && !tab.view.webContents.isDestroyed()) {
            tab.view.webContents.openDevTools();
            return true;
        }
        return false;
    });

    // ── Misc ─────────────────────────────────────────────────────────────────
    ipcMain.handle('open-log-directory', async (_, dirPath) => {
        const p = dirPath || app.getPath('logs');
        try { fs.mkdirSync(p, { recursive: true }); } catch (err) {
            safeCatch({ module: 'main', eventCode: 'fs.mkdir.failed', context: { path: p } }, err);
        }
        await shell.openPath(p);
    });

    ipcMain.handle('select-log-directory', async () => {
        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        const { canceled, filePaths } = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] });
        if (!canceled && filePaths.length) {
            const p = filePaths[0];
            // Save to settings
            const s = loadSettings();
            s.lastLogPath = p;
            saveSettings(s);
            return { path: p };
        }
        return { path: null };
    });

    ipcMain.handle('open-log-viewer', () => {
        // Toolbar button: focus the existing live window instead of opening a new one
        const liveWin = getLiveLogViewerWindow();
        if (liveWin) {
            if (liveWin.isMinimized()) liveWin.restore();
            liveWin.focus();
            return { success: true };
        }
        createLogViewerWindow();
        return { success: true };
    });

    ipcMain.handle('open-log-viewer-with-url', (_, url) => {
        const sendFocus = (win) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('focus-request-url', { url: String(url || '') });
            }
        };
        let liveWin = getLiveLogViewerWindow();
        if (liveWin) {
            if (liveWin.isMinimized()) liveWin.restore();
            liveWin.focus();
            sendFocus(liveWin);
            return { success: true };
        }
        createLogViewerWindow();
        liveWin = getLiveLogViewerWindow();
        if (liveWin && !liveWin.webContents.isLoading()) {
            sendFocus(liveWin);
        } else if (liveWin) {
            liveWin.webContents.once('did-finish-load', () => sendFocus(liveWin));
        }
        return { success: true };
    });

    ipcMain.handle('open-compare-viewer', () => {
        createCompareViewerWindow();
        return { success: true };
    });

    ipcMain.handle('compare-get', () => {
        return _comparePayload();
    });

    ipcMain.handle('compare-set-slot', (_, side, requestId) => {
        const slot = String(side || '').toLowerCase();
        const reqId = Number(requestId);
        if (slot !== 'left' && slot !== 'right') return { success: false, error: 'Invalid side' };
        if (!Number.isInteger(reqId) || reqId <= 0) return { success: false, error: 'Invalid request id' };
        const req = db.getRequest(reqId);
        if (!req) return { success: false, error: 'Request not found' };
        comparePair[slot] = _serializeCompareRowRequest(req);
        compareResult = null;
        _broadcastCompareUpdated();
        return { success: true, ..._comparePayload() };
    });

    ipcMain.handle('compare-clear-slot', (_, side) => {
        const slot = String(side || '').toLowerCase();
        if (slot !== 'left' && slot !== 'right') return { success: false, error: 'Invalid side' };
        comparePair[slot] = null;
        compareResult = null;
        _broadcastCompareUpdated();
        return { success: true, ..._comparePayload() };
    });

    ipcMain.handle('compare-run', (_, options = {}) => {
        if (!comparePair.left || !comparePair.right) {
            return { success: false, error: 'Need both left and right anchors' };
        }
        const level = ['quick', 'standard', 'deep'].includes(String(options.level || '').toLowerCase())
            ? String(options.level).toLowerCase()
            : 'standard';
        const LEFT_COUNT = level === 'quick' ? 12 : (level === 'deep' ? 30 : 20);
        const RIGHT_SEARCH = level === 'quick' ? 60 : (level === 'deep' ? 140 : 100);

        const leftReqs = _requestsForSessionAsc(comparePair.left.session_id);
        const rightReqs = _requestsForSessionAsc(comparePair.right.session_id);
        const leftPos = leftReqs.findIndex(r => Number(r.id) === Number(comparePair.left.id));
        const rightPos = rightReqs.findIndex(r => Number(r.id) === Number(comparePair.right.id));

        const leftSlice = leftReqs.slice(Math.max(0, leftPos), leftPos + LEFT_COUNT);
        const rightPool = rightReqs.slice(Math.max(0, rightPos), rightPos + RIGHT_SEARCH);

        const leftList = leftSlice.map(r => _serializeCompareRowRequest(r));
        const rightUsed = new Set();
        const pairs = [];

        for (let i = 0; i < leftSlice.length; i++) {
            let best = { idx: -1, score: -Infinity, exactKey: false };
            for (let j = 0; j < rightPool.length; j++) {
                if (rightUsed.has(j)) continue;
                const s = _pairScore(leftSlice[i], rightPool[j], i, j, level);
                if (!s.acceptable) continue;
                if (s.score > best.score) best = { idx: j, score: s.score, exactKey: s.exactKey };
            }
            if (best.idx >= 0) {
                rightUsed.add(best.idx);
                const leftCmp = _reqWithCompareOptions(leftSlice[i], options);
                const rightCmp = _reqWithCompareOptions(rightPool[best.idx], options);
                const cmp = diffUtils.compareRequests(leftCmp, rightCmp);
                pairs.push({
                    type: 'match',
                    leftIndex: i,
                    rightId: rightPool[best.idx].id,
                    left: _serializeCompareRowRequest(leftSlice[i]),
                    right: _serializeCompareRowRequest(rightPool[best.idx]),
                    diff: cmp?.ok ? cmp : null,
                    summary: cmp?.summary || null,
                    score: best.score,
                    confidence: _confidence(best.score, best.exactKey),
                });
            } else {
                pairs.push({
                    type: 'missing-right',
                    leftIndex: i,
                    left: _serializeCompareRowRequest(leftSlice[i]),
                    right: null, diff: null, summary: null,
                });
            }
        }

        const rightList = rightPool.map((r, j) => {
            const ser = _serializeCompareRowRequest(r);
            ser._paired = rightUsed.has(j);
            return ser;
        });

        for (let j = 0; j < rightPool.length; j++) {
            if (!rightUsed.has(j)) {
                pairs.push({
                    type: 'missing-left',
                    leftIndex: -1,
                    left: null,
                    right: _serializeCompareRowRequest(rightPool[j]),
                    diff: null, summary: null,
                });
            }
        }

        compareResult = {
            options: {
                level,
                removeNoiseHeaders: !!options.removeNoiseHeaders,
            },
            leftList,
            rightList,
            pairs,
        };
        _broadcastCompareUpdated();
        return { success: true, ..._comparePayload() };
    });

    ipcMain.handle('open-jsonl-file', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(logViewerWindow, {
            title: 'Open JSONL Log File',
            filters: [{ name: 'JSONL Files', extensions: ['jsonl'] }, { name: 'All Files', extensions: ['*'] }],
            properties: ['openFile']
        });
        if (canceled || !filePaths.length) return { success: false, canceled: true };
        try {
            const logs = fs.readFileSync(filePaths[0], 'utf8')
                .split('\n').filter(Boolean)
                .map(l => { try { return JSON.parse(l); } catch { return null; } })
                .filter(Boolean);
            return { success: true, logs, filePath: filePaths[0] };
        } catch (err) { return { success: false, error: err.message }; }
    });

    ipcMain.handle('open-rules-window', () => { createRulesWindow(); return true; });

    ipcMain.handle('open-rules-window-with-mock', (_, data) => {
        createRulesWindow();
        const sendPrefill = () => {
            if (rulesWindow && !rulesWindow.isDestroyed()) {
                rulesWindow.webContents.send('prefill-intercept-rule', data);
            }
        };
        if (rulesWindow && !rulesWindow.isDestroyed() && !rulesWindow.webContents.isLoading()) {
            sendPrefill();
        } else if (rulesWindow) {
            rulesWindow.webContents.once('did-finish-load', sendPrefill);
        }
        return true;
    });

    // ── Request Editor ───────────────────────────────────────────────────────
    ipcMain.handle('open-request-editor', async (_, entryId) => {
        let data = { method: 'GET', url: '', headers: {}, body: '' };
        if (entryId) {
            try {
                const req = db.getRequest(entryId);
                if (req) {
                    data = {
                        method:  req.method  || 'GET',
                        url:     req.url     || '',
                        headers: req.request_headers  ? JSON.parse(req.request_headers)  : {},
                        body:    req.request_body     || '',
                    };
                }
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'request-editor.prefill.failed', context: { entryId } }, err, 'info');
            }
        }
        createRequestEditorWindow(data);
        return true;
    });

    const EXEC_FORBIDDEN = new Set([
        'content-length','transfer-encoding','host','connection',
        'keep-alive','upgrade','te','trailer','proxy-authorization','accept-encoding',
    ]);

    ipcMain.handle('execute-request', async (_, { method, url, headers, body, tlsProfile }) => {
        const start = Date.now();
        const reqMethod = (method || 'GET').toUpperCase();

        /** Log the result to DB and forward to open log viewer windows */
        function maybeLog(result) {
            if (!isLoggingEnabled || !currentSessionId) return;
            try {
                // insertRequest returns the SQLite integer id — use it for detail lookup
                db.insertRequestAsync(currentSessionId, null, {
                    requestId:       `re-${Date.now()}`,
                    url:             url || '',
                    method:          reqMethod,
                    status:          result.status || null,
                    type:            'request-editor',
                    duration:        result.duration || 0,
                    requestHeaders:  headers || {},
                    responseHeaders: result.headers || {},
                    requestBody:     body || null,
                    responseBody:    result.body || null,
                    error:           result.error || null,
                }).then((dbId) => {
                    logEntryCount++;
                    sendLogStatus();

                    // Forward to all open log viewer windows (live update)
                    if (logViewerWindows.length > 0) {
                        const entry = {
                            // Use the real SQLite id so detail panel can call getRequestDetail(id)
                            id:           dbId,
                            type:         'request-editor',
                            timestamp:    Date.now(),
                            url:          url || '',
                            method:       reqMethod,
                            response:     result.status ? { statusCode: result.status, headers: result.headers || {} } : null,
                            request:      { headers: headers || {}, body: body || null },
                            responseBody: result.body || null,
                            duration:     result.duration || 0,
                            error:        result.error || null,
                            tabId:        null,
                            sessionId:    currentSessionId,
                        };
                        _broadcastLogEntryToViewers(entry);
                    }
                }).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'request-editor.maybeLog' } }, err, 'info');
                });
            } catch (e) { /* non-fatal */ }
        }

        try {
            // AzureTLS worker (MITM)
            if (mitmProxy && mitmProxy.worker && mitmProxy.worker.ready) {
                const profile = tlsProfile || loadSettings().tlsProfile || 'chrome';
                const currentProxy = persistentAnonymizedProxyUrl || loadSettings().currentProxy || null;
                const res = await mitmProxy.worker.request({
                    method:            reqMethod,
                    url,
                    headers:           headers || {},
                    body:              body || undefined,
                    proxy:            currentProxy,
                    browser:          profile,
                    disableRedirects: true,
                    timeout:          networkPolicy.timeouts.requestEditorMs,
                });
                const duration = Date.now() - start;
                if (res.error) {
                    const out = { success: false, error: res.error, duration };
                    maybeLog(out);
                    return out;
                }
                let respBody = '';
                if (res.bodyBase64) {
                    try { respBody = Buffer.from(res.bodyBase64, 'base64').toString('utf8'); } catch (err) {
                        safeCatch({ module: 'main', eventCode: 'request-editor.decode.failed', context: { encoding: 'base64' } }, err, 'info');
                    }
                } else if (typeof res.body === 'string') {
                    respBody = res.body;
                }
                const out = {
                    success: true,
                    status: res.statusCode,
                    statusText: '',
                    headers: res.headers || {},
                    body: respBody,
                    duration,
                    tlsProfile: profile,
                };
                maybeLog(out);
                return out;
            }

            // Fallback: Electron net.fetch
            const safe = {};
            for (const [k, v] of Object.entries(headers || {})) {
                if (!EXEC_FORBIDDEN.has(k.toLowerCase())) safe[k] = v;
            }
            const isBodyless = ['GET','HEAD','OPTIONS'].includes(reqMethod);
            const resp = await netFetchWithTimeout(url, {
                method:  reqMethod,
                headers: safe,
                body:    isBodyless ? undefined : (body || undefined),
            }, networkPolicy.timeouts.requestEditorMs);
            const duration = Date.now() - start;
            const respHeaders = {};
            resp.headers.forEach((v, k) => { respHeaders[k] = v; });
            const text = await resp.text();
            const out = { success: true, status: resp.status, statusText: resp.statusText,
                          headers: respHeaders, body: text, duration };
            maybeLog(out);
            return out;
        } catch (e) {
            const out = { success: false, error: e.message, duration: Date.now() - start };
            maybeLog(out);
            return out;
        }
    });

    // ── Inline settings (browser toolbar) ───────────────────────────────────
    ipcMain.handle('get-settings-all', () => {
        const s = loadSettings();
        return {
            filterPatterns:  s.filterPatterns  || [],
            pasteUnlock:     s.pasteUnlock !== false,
            bypassDomains:   s.bypassDomains || [],
            trafficOpts:     s.trafficOpts || {},
            effectiveTrafficMode: getCurrentTrafficMode(),
            tracking:        getTrackingSettings(),
            capmonster:      getCapmonsterSettings(),
        };
    });

    ipcMain.handle('set-paste-unlock', (_, enabled) => {
        const s = loadSettings();
        s.pasteUnlock = !!enabled;
        saveSettings(s);
        tabManager.setPasteUnlock(s.pasteUnlock);
        return { success: true, pasteUnlock: s.pasteUnlock };
    });

    // Adjust BrowserView y-offset to reveal HTML overlay panels (e.g. settings)
    ipcMain.handle('set-toolbar-height', (_, extraPx) => {
        tabManager.setExtraTopOffset(extraPx || 0);
        return true;
    });

    ipcMain.handle('set-auto-screenshot', async (_, seconds) => {
        const s = loadSettings();
        s.autoScreenshot = Math.max(0, Math.min(60, Number(seconds) || 0)); // legacy compatibility
        saveSettings(s);
        return true;
    });

    ipcMain.handle('get-tracking-settings', () => getTrackingSettings());
    ipcMain.handle('save-tracking-settings', (_, cfg) => {
        const s = loadSettings();
        s.tracking = normalizeTrackingSettings(cfg);
        saveSettings(s);
        return s.tracking;
    });

    ipcMain.handle('save-filter-patterns', async (_, patterns) => {
        const s = loadSettings();
        s.filterPatterns = Array.isArray(patterns) ? patterns : [];
        saveSettings(s);
        return true;
    });

    ipcMain.handle('save-bypass-domains', async (_, domains) => {
        const s = loadSettings();
        s.bypassDomains = Array.isArray(domains) ? domains : [];
        saveSettings(s);
        applyBypassDomains(s.bypassDomains);
        return true;
    });

    ipcMain.handle('save-traffic-opts', async (_, opts) => {
        const s = loadSettings();
        s.trafficOpts = { ...(s.trafficOpts || {}), ...opts };
        saveSettings(s);
        applyTrafficFilters(s.trafficOpts);
        return true;
    });

    ipcMain.handle('get-traffic-opts', () => {
        const s = loadSettings();
        return s.trafficOpts || {};
    });

    // Performance metrics — all Chrome/Electron processes
    ipcMain.handle('get-app-metrics', () => {
        try {
            const metrics = app.getAppMetrics();
            return metrics.map(m => ({
                pid:         m.pid,
                type:        m.type,
                cpuPercent:  m.cpu?.percentCPUUsage ?? 0,
                cpuMs:       m.cpu?.cumulativeCPUUsage ?? 0,
                memWorkingSet: m.memory?.workingSetSize    ?? 0,
                memPrivate:    m.memory?.privateBytes      ?? 0,
                memShared:     m.memory?.sharedBytes       ?? 0,
                sandboxed:   m.sandboxed ?? false,
                name:        m.name || '',
            }));
        } catch { return []; }
    });

    // Quick-connect a proxy profile directly from the browser toolbar
    ipcMain.handle('quick-connect-profile', async (_, profileId) => {
        try {
            if (!profileId) {
                if (persistentAnonymizedProxyUrl) {
                    await withTimeout(
                        ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true),
                        networkPolicy.timeouts.proxyOperationMs,
                        'Proxy close timeout'
                    );
                    persistentAnonymizedProxyUrl = null;
                }
                actProxy = '';
                connectedProfileId = null;
                connectedProfileName = null;
                connectedResolvedVars = {};
                await applyEffectiveTrafficMode(getCurrentTrafficMode(), null, {
                    source: 'quick-connect-profile.disconnect',
                });
                buildMenu();
                notifyProxyStatus();
                return { success: true };
            }
            const encData = db.getProxyProfileEncrypted(profileId);
            if (!encData) return { success: false, error: 'Profile not found' };
            let raw = encData.url_encrypted
                ? safeStorage.decryptString(encData.url_encrypted)
                : encData.url_display || '';
            const savedVars = encData.variables
                ? (typeof encData.variables === 'string' ? JSON.parse(encData.variables) : encData.variables)
                : {};
            const resolvedUrl = parseProxyTemplate(raw, savedVars);
            await quickChangeProxy(resolvedUrl);
            const profileTrafficMode = normalizeTrafficMode(encData.traffic_mode);
            if (encData.traffic_mode && encData.traffic_mode !== profileTrafficMode) {
                sysLog('warn', 'traffic.mode.fallback', `Invalid profile mode "${encData.traffic_mode}" -> "${profileTrafficMode}"`);
            }
            await applyEffectiveTrafficMode(profileTrafficMode, persistentAnonymizedProxyUrl, {
                source: 'quick-connect-profile',
                profileId,
            });
            // Apply fingerprint from this profile
            activeFingerprint = {
                user_agent: encData.user_agent || null,
                timezone:   encData.timezone   || null,
                language:   encData.language   || null,
            };
            await applyFingerprintToAllTabs(activeFingerprint);
            connectedProfileId = profileId;
            connectedProfileName = encData.name || null;
            buildMenu();
            notifyProxyStatus();
            // No reload needed — MITM upstream switches instantly
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ── MITM IPC handlers — registered immediately so they work even before proxy starts ──
    const EMPTY_STATS = { requests:0, errors:0, pending:0, avgMs:0, minMs:0, maxMs:0, reqPerSec:0, workerReady:false, browser:'chrome' };
    ipcMain.handle('mitm-get-stats',    ()         => mitmProxy ? mitmProxy.getStats() : EMPTY_STATS);
    ipcMain.handle('stability-metrics-snapshot', () => ({
        counters: { ...stabilityMetrics.counters },
        gauges: { ...stabilityMetrics.gauges },
        p95LatencyMs: stabilityMetrics.gauges.p95LatencyMs || 0,
        proxyResilience: proxyResilience.snapshot(),
        policy: networkPolicy,
        ts: Date.now(),
    }));
    ipcMain.handle('stability-slo-status', () => ({
        enabled: !!networkPolicy.slo.enabled,
        thresholds: { ...networkPolicy.slo },
        current: {
            p95LatencyMs: stabilityMetrics.gauges.p95LatencyMs || 0,
            queueDepth: stabilityMetrics.gauges.queueDepth || 0,
            workerRestarts: stabilityMetrics.gauges.workerRestarts || 0,
            dbWriteQueueHighDepth: stabilityMetrics.gauges.dbWriteQueueHighDepth || 0,
            dbWriteQueueLowDepth: stabilityMetrics.gauges.dbWriteQueueLowDepth || 0,
            dbWriteQueueDroppedLow: stabilityMetrics.gauges.dbWriteQueueDroppedLow || 0,
            dbWriteQueueDroppedHigh: stabilityMetrics.gauges.dbWriteQueueDroppedHigh || 0,
        },
    }));
    ipcMain.handle('proxy-resilience-state', () => proxyResilience.snapshot());
    ipcMain.handle('mitm-get-ca-cert',  ()         => mitmProxy?.getCACert() || '');
    ipcMain.handle('mitm-set-browser',  (_, prof)  => { mitmProxy?.setBrowser(prof); return { success: true }; });
    ipcMain.handle('mitm-set-upstream', (_, url)   => { mitmProxy?.setUpstream(url);  return { success: true }; });

    ipcMain.handle('get-tls-profile', () => loadSettings().tlsProfile || 'chrome');
    ipcMain.handle('set-tls-profile', (_, profile) => {
        const valid = ['chrome','firefox','safari','ios','edge','opera'];
        const p = valid.includes(profile) ? profile : 'chrome';
        const s = loadSettings();
        s.tlsProfile = p;
        saveSettings(s);
        mitmProxy?.setBrowser(p);
        broadcastTlsProfileChanged(p);
        return { success: true, profile: p };
    });

    ipcMain.handle('connect-direct', async (_, tlsProfile) => {
        try {
            if (persistentAnonymizedProxyUrl) {
                await withTimeout(
                    ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true),
                    networkPolicy.timeouts.proxyOperationMs,
                    'Proxy close timeout'
                ).catch(e => sysLog('warn', 'proxy', 'closeAnonymizedProxy on connect-direct failed: ' + (e?.message || e)));
                persistentAnonymizedProxyUrl = null;
            }
            actProxy = '';
            connectedProfileId = null;
            connectedProfileName = null;
            connectedResolvedVars = {};
            if (mitmProxy) {
                mitmProxy.setUpstream(null);
                mitmProxy._activeJa3 = null;
            }

            const p = ['chrome','firefox','safari','ios','edge','opera'].includes(tlsProfile) ? tlsProfile : 'chrome';
            mitmProxy?.setBrowser(p);
            const settings = loadSettings();
            settings.tlsProfile = p;
            saveSettings(settings);

            await applyEffectiveTrafficMode('mitm', null, {
                source: 'connect-direct',
                force: true,
            });

            buildMenu();
            notifyProxyStatus();
            broadcastTlsProfileChanged(p);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ── External Proxy Ports ──────────────────────────────────────────────────

    async function startExtPort(config) {
        if (activeExtPorts.has(config.port)) return activeExtPorts.get(config.port);
        if (getCurrentTrafficMode() !== 'mitm') {
            throw new Error('External proxy ports require MITM traffic mode');
        }
        const sess = await db.createExternalSessionAsync(`ext:${config.port}`, `ext_${config.port}`, config.port);
        const instance = new ExternalProxyPort(mitmProxy, {
            port: config.port,
            login: config.login,
            password: config.password,
            name: config.name,
            sessionId: sess.id,
            followRedirects: config.followRedirects || false,
            onRequestLogged: (entry) => {
                if (!db) return;
                try {
                    const logEntry = {
                        id: `ext_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                        url: entry.url,
                        method: entry.method,
                        status: entry.status,
                        type: entry.type || 'Document',
                        request: { headers: entry.requestHeaders || {}, body: entry.requestBody || null },
                        response: { statusCode: entry.status, headers: entry.responseHeaders || {}, mimeType: null },
                        duration: entry.duration,
                        duration_ms: entry.duration,
                        responseBody: entry.responseBody || null,
                        source: 'external',
                        extPort: entry.extPort,
                        extName: entry.extName,
                    };
                    db.insertRequestAsync(entry.sessionId, entry.tabId, {
                        requestId: logEntry.id,
                        url: logEntry.url,
                        method: logEntry.method,
                        status: logEntry.response?.statusCode,
                        type: logEntry.type,
                        duration: logEntry.duration,
                        requestHeaders: logEntry.request?.headers,
                        responseHeaders: logEntry.response?.headers,
                        requestBody: entry.requestBody || null,
                        responseBody: logEntry.responseBody,
                    }).then((dbId) => {
                        if (dbId) logEntry.id = dbId;
                        _broadcastLogEntryToViewers({ ...logEntry, tabId: entry.tabId, sessionId: entry.sessionId });
                    }).catch((err) => {
                        sysLog('warn', 'ext-proxy', `Log insert failed for port ${config.port}: ${err?.message || err}`);
                    });
                } catch (e) { sysLog('warn', 'ext-proxy', `Log insert failed for port ${config.port}: ${e?.message}`); }
            },
        });
        try {
            await instance.start();
            extPortErrors.delete(config.port);
        } catch (e) {
            extPortErrors.set(config.port, e.message);
            sysLog('error', 'ext-proxy', `Failed to start port ${config.port}: ${e.message}`);
            throw e;
        }
        activeExtPorts.set(config.port, { instance, sessionId: sess.id, config });
        sysLog('info', 'ext-proxy', `Started external proxy on port ${config.port} → session #${sess.id}`);
        return activeExtPorts.get(config.port);
    }

    async function stopExtPort(port) {
        const entry = activeExtPorts.get(port);
        if (!entry) return;
        entry.instance.stop();
        if (entry.sessionId) await db.endSessionAsync(entry.sessionId);
        activeExtPorts.delete(port);
        extPortErrors.delete(port);
        sysLog('info', 'ext-proxy', `Stopped external proxy on port ${port}`);
    }

    function getExtPortsList() {
        const localIp = getLocalIp();
        const list = [];
        const config = loadExtPortsConfig();
        for (const c of config.ports) {
            const active = activeExtPorts.get(c.port);
            const reqCount = active?.sessionId ? (db.countRequests({ sessionId: active.sessionId }) || 0) : 0;
            list.push({
                port: c.port,
                name: c.name,
                login: c.login,
                password: c.password,
                autoStart: c.autoStart ?? false,
                followRedirects: c.followRedirects ?? false,
                active: !!active,
                sessionId: active?.sessionId || null,
                requestCount: reqCount,
                error: extPortErrors.get(c.port) || null,
                localIp,
                effectiveMode: getCurrentTrafficMode(),
            });
        }
        return list;
    }

    ipcMain.handle('ext-proxy:list', () => getExtPortsList());

    ipcMain.handle('ext-proxy:create', async (_, opts) => {
        try {
            const port = parseInt(opts.port, 10);
            if (!port || port < 1024 || port > 65535) return { success: false, error: 'Port must be 1024-65535' };
            const config = loadExtPortsConfig();
            if (config.ports.find(p => p.port === port)) return { success: false, error: `Port ${port} already configured` };
            const entry = {
                port,
                name: opts.name || `External :${port}`,
                login: opts.login || 'cupnet',
                password: opts.password || generatePassword(),
                autoStart: opts.autoStart ?? true,
            };
            config.ports.push(entry);
            saveExtPortsConfig(config);
            await startExtPort(entry);
            return { success: true, port, password: entry.password };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('ext-proxy:start', async (_, port) => {
        try {
            const config = loadExtPortsConfig();
            const entry = config.ports.find(p => p.port === port);
            if (!entry) return { success: false, error: 'Port not found' };
            if (activeExtPorts.has(port)) return { success: true, already: true };
            await startExtPort(entry);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('ext-proxy:stop', async (_, port) => {
        try {
            await stopExtPort(port);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('ext-proxy:delete', async (_, port) => {
        try {
            await stopExtPort(port);
            const config = loadExtPortsConfig();
            config.ports = config.ports.filter(p => p.port !== port);
            saveExtPortsConfig(config);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('ext-proxy:reset-session', async (_, port) => {
        try {
            const entry = activeExtPorts.get(port);
            if (!entry) return { success: false, error: 'Port not active' };
            if (entry.sessionId) await db.endSessionAsync(entry.sessionId);
            const sess = await db.createExternalSessionAsync(`ext:${port}`, `ext_${port}`, port);
            entry.sessionId = sess.id;
            entry.instance.sessionId = sess.id;
            entry.instance._reqCount = 0;
            sysLog('info', 'ext-proxy', `Reset session for port ${port} → new session #${sess.id}`);
            return { success: true, sessionId: sess.id };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('ext-proxy:get-local-ip', () => getLocalIp());

    ipcMain.handle('ext-proxy:set-port', async (_, oldPort, newPort) => {
        try {
            const port = parseInt(newPort, 10);
            if (!port || port < 1024 || port > 65535) return { success: false, error: 'Port must be 1024-65535' };
            const config = loadExtPortsConfig();
            const entry = config.ports.find(p => p.port === oldPort);
            if (!entry) return { success: false, error: 'Port config not found' };
            const wasActive = activeExtPorts.has(oldPort);
            if (wasActive) await stopExtPort(oldPort);
            entry.port = port;
            saveExtPortsConfig(config);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('ext-proxy:set-redirects', async (_, port, follow) => {
        try {
            const config = loadExtPortsConfig();
            const entry = config.ports.find(p => p.port === port);
            if (!entry) return { success: false, error: 'Port not found' };
            entry.followRedirects = !!follow;
            saveExtPortsConfig(config);
            const active = activeExtPorts.get(port);
            if (active?.instance) active.instance.followRedirects = !!follow;
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // Ensure default external port exists on first run
    const extConfig = loadExtPortsConfig();
    if (extConfig.ports.length === 0) {
        const defaultPort = { port: 7777, name: 'Default', login: 'cupnet', password: generatePassword(), autoStart: false };
        extConfig.ports.push(defaultPort);
        saveExtPortsConfig(extConfig);
        sysLog('info', 'ext-proxy', `Created default external port 9001 (first run)`);
    }
    // External ports are started manually via the UI widget on new-tab page

    // Start app window after IPC handlers are registered, but without waiting for MITM readiness.
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('before-quit', (e) => {
    if (forceAppQuit) return;
    e.preventDefault();
    if (!confirmExitDialog(mainWindow)) return;
    forceAppQuit = true;
    app.quit();
});

app.on('will-quit', () => {
    stopIvacScoutProcess();
    for (const q of _logIpcQueues.values()) {
        if (q.timer) clearTimeout(q.timer);
    }
    _logIpcQueues.clear();
    for (const q of _interceptIpcQueues.values()) {
        if (q.timer) clearTimeout(q.timer);
    }
    _interceptIpcQueues.clear();
    for (const q of _dnsIpcQueues.values()) {
        if (q.timer) clearTimeout(q.timer);
    }
    _dnsIpcQueues.clear();
    if (logStatusInterval) clearInterval(logStatusInterval);
    if (_saveSettingsTimer) { clearTimeout(_saveSettingsTimer); _saveSettingsTimer = null; }
    if (_consoleBatchTimer) { clearTimeout(_consoleBatchTimer); _consoleBatchTimer = null; }
    if (_notifyTabsTimer) { clearTimeout(_notifyTabsTimer); _notifyTabsTimer = null; }
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
