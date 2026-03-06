'use strict';

const {
    app, BrowserWindow, ipcMain, session, Menu, dialog,
    net, shell, nativeImage, clipboard, safeStorage, Notification
} = require('electron');
const path = require('path');
const fs   = require('fs');
const ProxyChain = require('proxy-chain');
const crypto = require('crypto');

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

// Re-export shouldFilterUrl under the same name used throughout this file
const shouldFilterUrl = _shouldFilterUrl;

// ─── MITM Proxy (required lazily inside app.whenReady) ───────────────────────
let mitmProxy = null;

async function startMitmProxy() {
    if (mitmProxy) return mitmProxy;
    const { MitmProxy, generateCAAsync } = require('./mitm-proxy.js');
    // Async CA generation — doesn't block event loop / UI
    await generateCAAsync();
    mitmProxy = new MitmProxy({
        port:       8877,
        browser:    'chrome_120',
        workerPath: path.join(__dirname, 'azure-tls-worker.js'),
    });
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
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'default_public_interface_only');
app.commandLine.appendSwitch('enable-webrtc-hide-local-ips-with-mdns', 'true');
app.commandLine.appendSwitch('disable-webgl-debug-renderer-info');

// ─── App state ────────────────────────────────────────────────────────────────
let actProxy                   = '';
let mainWindow                 = null;
let logViewerWindow            = null; // kept for backward-compat (first window reference)
const logViewerWindows         = [];   // all open log-viewer windows
// Map<webContentsId, sessionId|null> for log-viewer windows opened on a specific session
const logViewerInitSessions    = new Map();
let rulesWindow                = null;
let cookieManagerWindow        = null;
let proxyManagerWindow         = null;
let loggingModalWindow         = null;
// Map<webContentsId, initData> for request editor windows
const requestEditorInitData    = new Map();
let persistentAnonymizedProxyUrl = null;
let isLoggingEnabled           = false;
let hadLoggingBeenStopped      = false; // true after first explicit stop; controls modal on re-enable
let currentSessionId           = null;
let logStatusInterval          = null;
let cachedSettings             = null;
let logEntryCount              = 0;
let autoScreenshotInterval     = 0;   // seconds; 0 = disabled
let screenshotTimer            = null;
let lastScreenshotBuffer       = null; // for dedup comparison
let activeFingerprint          = null; // { user_agent, timezone, language } or null
let mitmStartPromise           = null; // Promise resolving when MITM is ready
let isWindowActive             = false;
let lastMouseMoveTime          = 0;

const MOUSE_ACTIVITY_TIMEOUT = 90000;
const settingsFilePath = path.join(app.getPath('userData'), 'settings.json');
const iconPath = getAssetPath('img.png');

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
    const defaults = {
        lastLogPath: null,
        filterPatterns: ['*google.com*', '*cloudflare.com*', '*analytics*', '*tracking*'],
        autoScreenshot: 5,
        homepage: '',
        pasteUnlock: true,  // Don't F*** With Paste — unblocks copy/cut/paste on all pages
    };
    try {
        if (fs.existsSync(settingsFilePath)) {
            const raw = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
            cachedSettings = { ...defaults, ...raw };
            return cachedSettings;
        }
    } catch {}
    cachedSettings = defaults;
    return cachedSettings;
}

function saveSettings(s) {
    cachedSettings = s;
    try { fs.writeFileSync(settingsFilePath, JSON.stringify(s, null, 2)); } catch {}
}

/** Returns the URL to open in a new tab (homepage or built-in new-tab page). */
function getNewTabUrl() {
    const hp = cachedSettings?.homepage?.trim();
    if (hp) return hp;
    return `file://${path.join(__dirname, 'new-tab.html')}`;
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

async function getRealIp() {
    try {
        const r = await net.fetch('https://ipinfo.io/json');
        const d = await r.json();
        return d.ip || 'unknown';
    } catch { return 'unknown'; }
}

// parseProxyTemplate and extractTemplateVars imported from ./utils

/** Fetch current IP + geo info through the active proxy */
async function checkCurrentIpGeo() {
    const empty = { ip: 'unknown', city: '', region: '', country: '', country_name: '', org: '', timezone: '' };

    async function fetchWithTimeout(url, timeoutMs = 5000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            return await net.fetch(url, { signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    // Try three services in order — first one that returns a valid IP wins
    const sources = [
        async () => {
            const r = await fetchWithTimeout('https://ipapi.co/json/');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (!d.ip) throw new Error('no ip');
            return { ip: d.ip, city: d.city || '', region: d.region || '', country: d.country || '', country_name: d.country_name || d.country || '', org: d.org || '', timezone: d.timezone || '' };
        },
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
    ];

    for (const source of sources) {
        try { return await source(); } catch { /* try next */ }
    }
    return empty;
}

/** Broadcast proxy status to ALL windows, proxy manager, and all tab BrowserViews */
function notifyProxyStatus() {
    // `mode` distinguishes "Direct (through MITM)" from "no upstream set at all"
    const isDirect = !persistentAnonymizedProxyUrl && actProxy === '';
    const info = {
        active:    !!persistentAnonymizedProxyUrl,
        proxyName: actProxy || '',
        mode:      isDirect ? 'direct' : (persistentAnonymizedProxyUrl ? 'proxy' : 'none'),
    };
    // Broadcast to every BrowserWindow (main, proxy manager, request editor, log viewer…)
    for (const win of BrowserWindow.getAllWindows()) {
        try {
            if (!win.isDestroyed()) win.webContents.send('proxy-status-changed', info);
        } catch {}
    }
    // Also push to all open tab BrowserViews (e.g. new-tab.html proxy widget)
    if (tabManager) {
        for (const tab of tabManager.getAllTabs()) {
            try {
                if (tab.view && !tab.view.webContents.isDestroyed()) {
                    tab.view.webContents.send('proxy-status-changed', info);
                }
            } catch {}
        }
    }
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

// ─── CDP network logging ──────────────────────────────────────────────────────
async function setupNetworkLogging(webContents, tabId, sessionId) {
    if (!webContents || webContents.isDestroyed()) return;
    const ongoingRequests   = new Map();
    const ongoingWebsockets = new Map();
    const cdp = webContents.debugger;

    // Periodic stale-entry cleanup: requests that never got loadingFinished/Failed
    // (e.g. cancelled by navigation) would otherwise live in the Map forever.
    const _staleCleanupTimer = setInterval(() => {
        const cutoff = Date.now() - 5 * 60 * 1000; // 5 min
        for (const [id, entry] of ongoingRequests) {
            if ((entry._addedAt || 0) < cutoff) {
                ongoingRequests.delete(id);
            }
        }
    }, 60_000);
    webContents.once('destroyed', () => clearInterval(_staleCleanupTimer));

    // Detach existing listeners cleanly before re-attaching (e.g. after clear-logs)
    if (_cdpAttachedWc.has(webContents)) {
        try {
            cdp.removeAllListeners('message');
            cdp.removeAllListeners('detach');   // C1: prevent listener accumulation
        } catch {}
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
        maxTotalBufferSize:    100 * 1024 * 1024,  // 100 MB total across all resources
        maxResourceBufferSize:  10 * 1024 * 1024,  // 10 MB per individual resource
    }).catch(() => {});

    // Apply active fingerprint via CDP now that the debugger is attached
    if (activeFingerprint) {
        if (activeFingerprint.user_agent) {
            cdp.sendCommand('Emulation.setUserAgentOverride', {
                userAgent:      activeFingerprint.user_agent,
                acceptLanguage: activeFingerprint.language || '',
            }).catch(() => {});
        }
        if (activeFingerprint.timezone) {
            cdp.sendCommand('Emulation.setTimezoneOverride', {
                timezoneId: activeFingerprint.timezone,
            }).catch(() => {});
        }
    }

    const finalizeLog = (logEntry) => {
        logEntryCount++;

        // ── Write to SQLite ──
        try {
            if (logEntry.type === 'websocket_frame' || logEntry.type === 'websocket_closed' || logEntry.type === 'websocket_error') {
                db.insertWsEvent(sessionId, tabId, logEntry.url || '', logEntry.direction || 'recv', logEntry.data || logEntry.error || null);
            } else if (logEntry.type === 'screenshot') {
                db.insertScreenshot(sessionId, tabId, logEntry.path, logEntry.imageData || null);
            } else {
                db.insertRequest(sessionId, tabId, {
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
                    } catch {}
                }
            }
        } catch (e) {
            console.error('[DB] insertRequest failed:', e.message);
        }

        // ── Forward to log viewer (only if any window open) ──
        if (logViewerWindows.length > 0) {
            const msg = { ...logEntry, tabId, sessionId };
            for (const w of logViewerWindows) {
                if (!w.isDestroyed()) w.webContents.send('new-log-entry', msg);
            }
        }

        ongoingRequests.delete(logEntry.id);
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
            if (ws) finalizeLog({ type: 'websocket_frame', direction: 'send', url: ws.url, data: params.response.payloadData });
        }
        if (method === 'Network.webSocketFrameReceived') {
            const ws = ongoingWebsockets.get(params.requestId);
            if (ws) finalizeLog({ type: 'websocket_frame', direction: 'recv', url: ws.url, data: params.response.payloadData });
        }
        if (method === 'Network.webSocketClosed') {
            const ws = ongoingWebsockets.get(params.requestId);
            if (ws) {
                finalizeLog({ type: 'websocket_closed', url: ws.url, framesCount: ws.frames.length });
                ongoingWebsockets.delete(params.requestId);
            }
        }
        if (method === 'Network.webSocketFrameError') {
            const ws = ongoingWebsockets.get(params.requestId);
            if (ws) finalizeLog({ type: 'websocket_error', url: ws.url, error: params.errorMessage });
        }

        // ── HTTP requests ─────────────────────────────────────────────────────
        if (method === 'Network.requestWillBeSent') {
            const { requestId, request, timestamp, type, redirectResponse } = params;
            if (request.url.startsWith('data:')) return;

            // Redirect chain: Chrome reuses requestId. Finalize the previous entry
            // (with the redirect status 301/302) before creating the new one.
            if (redirectResponse) {
                const prevEntry = ongoingRequests.get(requestId);
                if (prevEntry && !prevEntry._finalizing) {
                    prevEntry._finalizing = true;
                    ongoingRequests.delete(requestId);
                    prevEntry.response = {
                        statusCode: redirectResponse.status,
                        headers:    redirectResponse.headers,
                        mimeType:   redirectResponse.mimeType || null,
                    };
                    prevEntry.duration = Math.round((timestamp - prevEntry.startTime) * 1000);
                    // Redirect responses have no body
                    prevEntry.responseBody = null;
                    finalizeLog(prevEntry);
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
        if (method === 'Network.responseReceived') {
            const entry = ongoingRequests.get(params.requestId);
            if (entry) entry.response = { statusCode: params.response.status, headers: params.response.headers, mimeType: params.response.mimeType };
        }
        if (method === 'Network.loadingFinished') {
            const entry = ongoingRequests.get(params.requestId);
            // Guard: remove from map immediately to prevent double-finalizeLog
            // if loadingFailed arrives while we await getResponseBody
            if (entry && !entry._finalizing) {
                entry._finalizing = true;
                ongoingRequests.delete(params.requestId);
                entry.duration = Math.round((params.timestamp - entry.startTime) * 1000);

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

    webContents.on('destroyed', () => { try { if (cdp.isAttached()) cdp.detach(); } catch {} });
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
            } catch {}
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
            captureScreenshot().catch(() => {});
        }
    }
}

// ─── Fingerprint / Identity ───────────────────────────────────────────────────

/** Apply UA + timezone + language overrides to a single webContents via CDP. */
async function applyFingerprintToWebContents(wc, fp) {
    if (!fp || !wc || wc.isDestroyed()) return;
    // Session-level UA changes HTTP headers + new tab defaults
    if (fp.user_agent) {
        try { wc.session.setUserAgent(fp.user_agent, fp.language || ''); } catch {}
    }
    // CDP-level overrides — works on already-attached debugger
    const cdp = wc.debugger;
    try {
        if (!cdp.isAttached()) cdp.attach('1.3');
        if (fp.user_agent) {
            await cdp.sendCommand('Emulation.setUserAgentOverride', {
                userAgent:      fp.user_agent,
                acceptLanguage: fp.language || '',
            });
        }
        if (fp.timezone) {
            await cdp.sendCommand('Emulation.setTimezoneOverride', { timezoneId: fp.timezone });
        }
    } catch {}
}

/** Apply fingerprint to all open tabs. */
async function applyFingerprintToAllTabs(fp) {
    if (!tabManager) return;
    for (const tab of tabManager.getAllTabs()) {
        if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
            await applyFingerprintToWebContents(tab.view.webContents, fp).catch(() => {});
        }
    }
}

/** Reset fingerprint overrides on a WebContents (when proxy is disconnected). */
async function resetFingerprintOnWebContents(wc) {
    if (!wc || wc.isDestroyed()) return;
    try {
        const cdp = wc.debugger;
        if (!cdp.isAttached()) return;
        // Restore empty UA override (falls back to Electron/Chromium default)
        await cdp.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
        await cdp.sendCommand('Emulation.setTimezoneOverride',  { timezoneId: '' }).catch(() => {});
    } catch {}
}

// ─── Log status updater ───────────────────────────────────────────────────────
function startLogStatusUpdater() {
    if (logStatusInterval) clearInterval(logStatusInterval);
    let _lastSentCount = -1;
    let _lastSentSession = null;
    logStatusInterval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const payload = isLoggingEnabled && currentSessionId
            ? { enabled: true, sessionId: currentSessionId, count: logEntryCount }
            : { enabled: false, sessionId: null, count: 0 };
        // Skip IPC if nothing changed
        if (payload.count === _lastSentCount && payload.sessionId === _lastSentSession) return;
        _lastSentCount   = payload.count;
        _lastSentSession = payload.sessionId;
        mainWindow.webContents.send('update-log-status', payload);
    }, 5000);
}

/** Send the current logging state immediately to the main window. */
function sendLogStatus() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const payload = isLoggingEnabled && currentSessionId
        ? { enabled: true, sessionId: currentSessionId, count: logEntryCount }
        : { enabled: false, sessionId: null, count: 0 };
    mainWindow.webContents.send('update-log-status', payload);
}

// ─── Screenshots ──────────────────────────────────────────────────────────────
/** Capture a screenshot of the active tab and save to DB (with dedup). */
async function captureScreenshot() {
    try {
        // H1: skip when window is not focused/visible — avoids GPU work in background
        if (!isWindowActive) return { success: false, skipped: true, reason: 'inactive' };

        const activeTab = tabManager ? tabManager.getActiveTab() : null;
        if (!activeTab || activeTab.view.webContents.isDestroyed()) throw new Error('No active tab');

        // Skip activity timeout check (always capture when timer fires)
        const wc = activeTab.view.webContents;

        // Skip home/new-tab page — don't photograph the start screen
        const currentUrl = wc.getURL() || '';
        const newTabPath = path.join(__dirname, 'new-tab.html').replace(/\\/g, '/');
        if (!currentUrl || currentUrl.startsWith('file://') && (
            currentUrl.includes('new-tab.html') || currentUrl === `file://${newTabPath}`
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
            const virtualPath = `autoscreen::/${autoScreenshotInterval}sec/${ts}.${ms}.png`;
            const b64 = buffer.toString('base64');
            const ssId = db.insertScreenshot(currentSessionId, activeTab.id, virtualPath, b64);
            logEntryCount++;
            // Don't send base64 in the live IPC event — viewer fetches it on demand to avoid memory bloat
            const entry = {
                type:       'screenshot',
                timestamp:  Date.now(),
                path:       virtualPath,
                ssDbId:     ssId,          // numeric DB id for lazy fetch
                tabId:      activeTab.id,
                session_id: currentSessionId,
                created_at: now.toISOString(),
            };
            for (const w of logViewerWindows) {
                if (!w.isDestroyed()) w.webContents.send('new-log-entry', entry);
            }
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

/**
 * Start / stop the auto-screenshot timer.
 * @param {number} seconds  0 = off; 1–60 = interval in seconds
 */
function toggleAutoScreenshot(seconds) {
    const intervalSec = Math.max(0, Math.min(60, Number(seconds) || 0));
    autoScreenshotInterval = intervalSec;
    if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
    if (intervalSec > 0) {
        screenshotTimer = setInterval(() => {
            captureScreenshot().catch(() => {});
        }, intervalSec * 1000);
    }
}

// ─── Proxy helpers ────────────────────────────────────────────────────────────
async function testProxy(upstreamProxyUrl) {
    let anonUrl = null;
    let testWin = null;
    const partition = `proxy-test-${Date.now()}`;
    try {
        anonUrl = await ProxyChain.anonymizeProxy(upstreamProxyUrl);
        const testSession = session.fromPartition(partition, { cache: false });
        await testSession.setProxy({ proxyRules: anonUrl, proxyBypassRules: '<local>' });
        testWin = new BrowserWindow({ show: false, webPreferences: { session: testSession } });
        await testWin.loadURL('https://ipinfo.io/json');
        const text = await testWin.webContents.executeJavaScript('document.body.innerText');
        const data = JSON.parse(text);
        if (!data.ip || !data.country) throw new Error('Incomplete response');
        return { success: true, data };
    } catch (err) {
        return { success: false, error: err.message };
    } finally {
        if (testWin) testWin.destroy();
        if (anonUrl) await ProxyChain.closeAnonymizedProxy(anonUrl, true);
        try { await session.fromPartition(partition).clearStorageData(); } catch {}
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
            await ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true);
            await new Promise(r => setTimeout(r, 120));
        }
        actProxy = masked; // store masked version — never expose password in state
        persistentAnonymizedProxyUrl = oldPort
            ? await ProxyChain.anonymizeProxy({ url: proxyUrl, port: oldPort })
            : await ProxyChain.anonymizeProxy(proxyUrl);
        return persistentAnonymizedProxyUrl;
    } catch (err) {
        const isBusy = err.code === 'EADDRINUSE';
        try {
            persistentAnonymizedProxyUrl = isBusy && oldPort
                ? await ProxyChain.anonymizeProxy({ url: proxyUrl, port: oldPort })
                : await ProxyChain.anonymizeProxy(proxyUrl);
            return persistentAnonymizedProxyUrl;
        } catch (e2) {
            dialog.showErrorBox('Proxy Error', e2.message);
            throw e2;
        }
    }
}

// ─── Window creation ──────────────────────────────────────────────────────────
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, minWidth: 900, minHeight: 600,
        icon: iconPath,
        webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });
    mainWindow.maximize();
    mainWindow.loadFile(getAssetPath('browser.html'));

    mainWindow.webContents.once('did-finish-load', async () => {
        // Wait for MITM to be ready so the first tab is immediately protected.
        // This typically takes < 500ms; the new-tab page (file://) loads fine
        // even if MITM is still starting because file:// is never proxied.
        try { await mitmStartPromise; } catch {}

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
        try { db.deleteEmptySessions(currentSessionId); } catch {}


        // Send initial data to browser toolbar
        const s = loadSettings();
        tabManager.setPasteUnlock(s.pasteUnlock !== false); // true by default
        mainWindow.webContents.send('init-settings', {
            filterPatterns: s.filterPatterns || [],
            autoScreenshot: s.autoScreenshot ?? 5,
            pasteUnlock:    s.pasteUnlock !== false,
        });
        notifyProxyProfilesList();
        notifyProxyStatus();
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
    toggleAutoScreenshot(cachedSettings?.autoScreenshot ?? 5);
}


function createRequestEditorWindow(data) {
    const win = new BrowserWindow({
        width: 1100, height: 780, minWidth: 760, minHeight: 540,
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
    // Keep backward-compat reference to last opened window
    logViewerWindow = win;

    win.on('closed', () => {
        logViewerInitSessions.delete(wcId);
        const idx = logViewerWindows.indexOf(win);
        if (idx !== -1) logViewerWindows.splice(idx, 1);
        if (logViewerWindow === win) logViewerWindow = logViewerWindows[logViewerWindows.length - 1] || null;
    });
}


/** Broadcast updated tab list to cookie manager — debounced to coalesce rapid bursts */
let _notifyTabsTimer = null;
function notifyCookieManagerTabs() {
    if (_notifyTabsTimer) clearTimeout(_notifyTabsTimer);
    _notifyTabsTimer = setTimeout(() => {
        _notifyTabsTimer = null;
        if (cookieManagerWindow && !cookieManagerWindow.isDestroyed()) {
            cookieManagerWindow.webContents.send('tabs-updated', tabManager.getTabList());
        }
    }, 150);   // coalesce bursts within 150ms
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
    rulesWindow.on('closed', () => { rulesWindow = null; });
}

function buildMenu() {
    const menu = Menu.buildFromTemplate([
        {
            label: 'File', submenu: [
                { label: 'Proxy Manager',        click: () => createProxyManagerWindow() },
                { label: 'Rules & Interceptor',  click: () => createRulesWindow() },
                { label: 'Cookie Manager', click: () => createCookieManagerWindow(tabManager?.getActiveTabId()) },
                { label: 'Enable Logging', type: 'checkbox', checked: isLoggingEnabled,
                  click: (item) => { isLoggingEnabled = item.checked; sendLogStatus(); } },
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
            { label: 'Network Activity', click: () => createLogViewerWindow() }
        ]}
    ]);
    Menu.setApplicationMenu(menu);
}

// ─── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    // Set dock / taskbar icon (important in dev mode — electron binary has no custom icon)
    // Use PNG — .icns is not accepted by app.dock.setIcon() in Electron 28
    if (process.platform === 'darwin' && app.dock) {
        try {
            const pngPath = getAssetPath('icons/icon.png');
            app.dock.setIcon(fs.existsSync(pngPath) ? pngPath : iconPath);
        } catch (e) {
            console.warn('[dock] setIcon failed:', e.message);
        }
    }

    // Load only the critical modules synchronously
    db         = require('./db');
    tabManager = require('./tab-manager');
    db.init();
    loadSettings();

    // Non-critical modules loaded after window is shown
    setImmediate(() => {
        harExporter = require('./har-exporter');
        rulesEngine = require('./rules-engine');
        interceptor = require('./request-interceptor');
    });

    // Start MITM proxy early — parallel with window load so it's ready
    // when the user first navigates. Stored as a Promise so did-finish-load
    // can await it before creating the first tab.
    mitmStartPromise = startMitmProxy().then(proxy => {
        const { session: electronSession } = require('electron');
        const caCertPem = proxy.getCACert(); // eslint-disable-line no-unused-vars

        function trustMitmCA(sess) {
            sess.setCertificateVerifyProc((_, callback) => callback(0));
        }

        trustMitmCA(electronSession.defaultSession);
        tabManager.setTrustMitmCA(trustMitmCA);

        const { session: s } = require('electron');
        const sharedSess = s.fromPartition('persist:cupnet-shared');
        trustMitmCA(sharedSess);
        sharedSess.setProxy({
            proxyRules: 'http=127.0.0.1:8877;https=127.0.0.1:8877',
        }).then(() => {
            console.log('[main] Shared session routed through MITM proxy');
        });

        const startupProfile = loadSettings().tlsProfile || 'chrome';
        proxy.setBrowser(startupProfile);
        console.log(`[main] MITM startup profile: ${startupProfile}`);

        // Push stats to all windows every second (only if something changed)
        let _prevStatsJson = '';
        const statsBroadcast = setInterval(() => {
            if (!mitmProxy) return;
            const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
            if (!wins.length) return;
            const stats = mitmProxy.getStats();
            const json  = `${stats.requests}|${stats.pending}|${stats.errors}|${stats.avgMs}|${stats.reqPerSec}|${stats.browser}`;
            if (json === _prevStatsJson) return;
            _prevStatsJson = json;
            wins.forEach(w => w.webContents.send('mitm-stats-update', stats));
        }, 1000);
        app.on('before-quit', () => clearInterval(statsBroadcast));

        return proxy;
    }).catch(e => {
        console.error('[main] MITM proxy failed to start:', e.message);
    });

    // ── Mouse activity ───────────────────────────────────────────────────────
    ipcMain.on('report-mouse-activity', () => { lastMouseMoveTime = Date.now(); });

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

    ipcMain.handle('close-tab', async (_, tabId) => {
        const tab = tabManager.getTab(tabId);
        if (tab) {
            try { interceptor.detachFromSession(tab.tabSession); } catch {}
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
        const url = resolveNavigationUrl(rawInput);
        if (!url) return;
        if (mainWindow && event.sender.id === mainWindow.webContents.id) {
            const tab = tabManager.getActiveTab();
            if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.loadURL(url).catch(() => {});
        } else {
            if (!event.sender.isDestroyed()) event.sender.loadURL(url).catch(() => {});
        }
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
            tab.view.webContents.loadURL(getNewTabUrl()).catch(() => {});
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
        db.renameSession(id, name);
        return { success: true };
    });

    // ── Logging toggle ───────────────────────────────────────────────────────
    ipcMain.handle('toggle-logging-start', async (_, hint) => {
        if (isLoggingEnabled) return { status: 'already_on' };

        // No session yet (truly first run) — create one and enable silently
        if (!currentSessionId) {
            const sess = db.createSession(actProxy || null, null);
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
        if (renameOld && currentSessionId) db.renameSession(currentSessionId, renameOld);
        if (currentSessionId) db.endSession(currentSessionId);
        const sess = db.createSession(actProxy || null, null);
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
        db.deleteSession(id);
        return { success: true };
    });

    ipcMain.handle('open-session-in-new-window', async (_, sessionId) => {
        createLogViewerWindow(sessionId || null);
        return { success: true };
    });

    ipcMain.handle('get-initial-session-id', async (e) => {
        return logViewerInitSessions.get(e.sender.id) ?? null;
    });

    // ── Existing logs (DB-backed) ────────────────────────────────────────────
    ipcMain.handle('get-existing-logs', async () => {
        if (!currentSessionId) return [];
        const requests    = db.queryRequests({ sessionId: currentSessionId }, 500, 0);
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
            if (currentSessionId) db.endSession(currentSessionId);
            const newSession = db.createSession(actProxy || null, null);
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
            return { success: true, path: filePath };
        } catch (e) { return { success: false, error: e.message }; }
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
            const resp = await net.fetch(req.url, {
                method: req.method || 'GET',
                headers: safeHeaders,
                body: isBodyless ? undefined : (req.request_body || undefined)
            });
            const text = await resp.text();
            return { success: true, status: resp.status, body: text, original: req.response_body };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // ── Rules ────────────────────────────────────────────────────────────────
    ipcMain.handle('get-rules', async () => db.getRules());
    ipcMain.handle('save-rule', async (_, rule) => db.saveRule(rule));
    ipcMain.handle('delete-rule', async (_, id) => { db.deleteRule(id); return true; });
    ipcMain.handle('toggle-rule', async (_, id, enabled) => { db.toggleRule(id, enabled); return true; });

    // ── Intercept rules ──────────────────────────────────────────────────────
    ipcMain.handle('get-intercept-rules', async () => db.getAllInterceptRules());
    ipcMain.handle('save-intercept-rule', async (_, rule) => db.saveInterceptRule(rule));
    ipcMain.handle('delete-intercept-rule', async (_, id) => { db.deleteInterceptRule(id); return true; });

    // ── Proxy Manager ────────────────────────────────────────────────────────
    ipcMain.handle('open-proxy-manager', async () => { createProxyManagerWindow(); return true; });

    ipcMain.handle('get-ui-pref', (_, key, def) => {
        const v = loadUiPrefs()[key];
        return v !== undefined ? v : (def !== undefined ? def : null);
    });
    ipcMain.handle('set-ui-pref', (_, key, value) => { saveUiPref(key, value); return true; });

    ipcMain.handle('check-ip-geo', async () => checkCurrentIpGeo());

    ipcMain.handle('get-current-proxy', async () => {
        const isDirect = !persistentAnonymizedProxyUrl && actProxy === '';
        return {
            active:    !!persistentAnonymizedProxyUrl,
            proxyName: actProxy || '',
            mode:      isDirect ? 'direct' : (persistentAnonymizedProxyUrl ? 'proxy' : 'none'),
        };
    });

    ipcMain.handle('connect-proxy-template', async (_, profileId, ephemeralVars) => {
        // Get the encrypted template URL from DB
        const row = db.getProxyProfileEncrypted(profileId);
        if (!row) return { success: false, error: 'Profile not found' };
        let template = null;
        if (row.url_encrypted && safeStorage.isEncryptionAvailable()) {
            try { template = safeStorage.decryptString(row.url_encrypted); } catch {}
        }
        if (!template) return { success: false, error: 'Cannot decrypt template' };

        // Merge saved variables with ephemeral overrides (e.g. SID)
        const savedVars  = row.variables ? JSON.parse(row.variables) : {};
        const mergedVars = { ...savedVars, ...(ephemeralVars || {}) };
        const resolvedUrl = parseProxyTemplate(template, mergedVars);

        try {
            await quickChangeProxy(resolvedUrl);
            // Apply to all tab sessions and also default session (for net.fetch IP checks)
            await tabManager.setProxyAll(persistentAnonymizedProxyUrl);
            try {
                const rules = persistentAnonymizedProxyUrl
                    ? (() => { const u = new URL(persistentAnonymizedProxyUrl); return `${u.hostname}:${u.port}`; })()
                    : null;
                if (rules) await session.defaultSession.setProxy({ proxyRules: rules });
            } catch {}

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
                        try { tab.view.webContents.session.setUserAgent(activeFingerprint.user_agent, activeFingerprint.language || ''); } catch {}
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
                BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tls-profile-changed', tlsProfile));
            }

            buildMenu();
            notifyProxyStatus();
            // No page reload needed: all tabs always connect via local MITM (:8877);
            // the MITM upstream switches instantly — new connections pick it up.

            // Fetch IP/geo and update profile
            checkCurrentIpGeo().then(geo => {
                db.updateProxyProfileGeo(profileId, geo.ip, `${geo.city}, ${geo.country_name}`);
                notifyProxyProfilesList();
            }).catch(() => {});
            return { success: true, resolvedUrl };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('apply-quick-proxy-change', async (_, proxyUrl) => {
        try {
            if (!proxyUrl || typeof proxyUrl !== 'string') return { success: false, error: 'Invalid proxy URL' };
            const anonymized = await quickChangeProxy(proxyUrl);
            await tabManager.setProxyAll(anonymized);
            try {
                const u = new URL(anonymized);
                await session.defaultSession.setProxy({ proxyRules: `${u.hostname}:${u.port}` });
            } catch {}
            buildMenu();
            notifyProxyStatus();
            return { success: true, message: 'Proxy applied successfully' };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('disconnect-proxy', async () => {
        try {
            if (persistentAnonymizedProxyUrl) {
                await ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true);
                persistentAnonymizedProxyUrl = null;
            }
            actProxy = '';
            await tabManager.setProxyAll(null);
            try { await session.defaultSession.setProxy({ mode: 'direct' }); } catch {}

            // Reset fingerprint overrides
            if (activeFingerprint) {
                for (const tab of tabManager.getAllTabs()) {
                    if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                        resetFingerprintOnWebContents(tab.view.webContents).catch(() => {});
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
                } catch {}
            }
        } catch {}

        if (profile.id) {
            db.updateProxyProfileById(profile.id, {
                name:          profile.name,
                url_encrypted: urlEncrypted,
                url_display:   urlDisplay,
                is_template:   1,
                variables:     profile.variables || {},
                notes:         profile.notes || '',
                country:       profile.country || '',
                user_agent:    profile.user_agent || null,
                timezone:      profile.timezone   || null,
                language:      profile.language   || null,
            });
            notifyProxyProfilesList();
            return { success: true, id: profile.id };
        }

        const id = db.saveProxyProfile(profile.name, urlEncrypted, urlDisplay, {
            isTemplate: 1,
            variables:  profile.variables || {},
            notes:      profile.notes || '',
            country:    profile.country || '',
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
            try { template = safeStorage.decryptString(row.url_encrypted); } catch {}
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
            db.updateProxyProfileTest(profileId, latency, ip, geo);
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
                } catch {}
            }
        } catch {}
        return db.saveProxyProfile(name, urlEncrypted, urlDisplay, country);
    });

    ipcMain.handle('get-proxy-profile-url', async (_, id) => {
        const row = db.getProxyProfileEncrypted(id);
        if (!row) return null;
        if (row.url_encrypted && safeStorage.isEncryptionAvailable()) {
            try { return safeStorage.decryptString(row.url_encrypted); } catch {}
        }
        return null;
    });

    ipcMain.handle('delete-proxy-profile', async (_, id) => { db.deleteProxyProfile(id); return true; });

    ipcMain.handle('test-proxy-profile', async (_, id) => {
        const row = db.getProxyProfileEncrypted(id);
        if (!row) return { success: false, error: 'Profile not found' };
        let url = null;
        if (row.url_encrypted && safeStorage.isEncryptionAvailable()) {
            try { url = safeStorage.decryptString(row.url_encrypted); } catch {}
        }
        if (!url) return { success: false, error: 'Cannot decrypt URL' };
        const start = Date.now();
        const result = await testProxy(url);
        const latency = Date.now() - start;
        if (result.success) db.updateProxyProfileTest(id, latency);
        return { ...result, latency };
    });

    // ── Screenshots ──────────────────────────────────────────────────────────
    ipcMain.handle('take-screenshot', async () => captureScreenshot());

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
                try { await tab.tabSession.cookies.remove(url, c.name); } catch {}
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
                try { await toTab.tabSession.cookies.set({ ...c, url }); count++; } catch {}
            }
            await toTab.tabSession.cookies.flushStore();
            return { success: true, count };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('isolate-tab', async (_, tabId) => {
        const tid = tabId || tabManager.getActiveTabId();
        const result = await tabManager.isolateTab(tid);
        // Attach interceptor to the new isolated session so request rules apply
        if (result?.success && interceptor) {
            const tab = tabManager.getTab(tid);
            if (tab) {
                try { interceptor.attachToSession(tab.tabSession, tid); } catch {}
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
                try { interceptor.attachToSession(tab.tabSession, tabId); } catch {}
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
        try { fs.mkdirSync(p, { recursive: true }); } catch {}
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
        createLogViewerWindow();
        return { success: true };
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
            } catch {}
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
                const dbId = db.insertRequest(currentSessionId, null, {
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
                });
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
                    for (const w of logViewerWindows) {
                        if (!w.isDestroyed()) w.webContents.send('new-log-entry', entry);
                    }
                }
            } catch (e) { /* non-fatal */ }
        }

        try {
            // Use AzureTLS worker when MITM proxy is available
            if (mitmProxy && mitmProxy.worker && mitmProxy.worker.ready) {
                const profile = tlsProfile || loadSettings().tlsProfile || 'chrome';
                const currentProxy = loadSettings().currentProxy || null;
                const res = await mitmProxy.worker.request({
                    method:  reqMethod,
                    url,
                    headers: headers || {},
                    body:    body || null,
                    proxy:   currentProxy,
                    browser: profile,
                });
                const duration = Date.now() - start;
                if (res.error) {
                    const out = { success: false, error: res.error, duration };
                    maybeLog(out);
                    return out;
                }
                const out = {
                    success: true,
                    status: res.statusCode,
                    statusText: '',
                    headers: res.headers || {},
                    body: typeof res.body === 'string' ? res.body : (res.body || ''),
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
            const resp = await net.fetch(url, {
                method:  reqMethod,
                headers: safe,
                body:    isBodyless ? undefined : (body || undefined),
            });
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
            autoScreenshot:  s.autoScreenshot  ?? 5,  // seconds (0=off)
            pasteUnlock:     s.pasteUnlock !== false,  // true by default
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
        const sec = Math.max(0, Math.min(60, Number(seconds) || 0));
        const s = loadSettings();
        s.autoScreenshot = sec;
        saveSettings(s);
        toggleAutoScreenshot(sec);
        return true;
    });

    ipcMain.handle('save-filter-patterns', async (_, patterns) => {
        const s = loadSettings();
        s.filterPatterns = Array.isArray(patterns) ? patterns : [];
        saveSettings(s);
        return true;
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
                    await ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true);
                    persistentAnonymizedProxyUrl = null;
                }
                actProxy = '';
                await tabManager.setProxyAll(null);
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
            await tabManager.setProxyAll(persistentAnonymizedProxyUrl);
            try {
                const u = new URL(persistentAnonymizedProxyUrl);
                await session.defaultSession.setProxy({ proxyRules: `${u.hostname}:${u.port}` });
            } catch {}
            // Apply fingerprint from this profile
            activeFingerprint = {
                user_agent: encData.user_agent || null,
                timezone:   encData.timezone   || null,
                language:   encData.language   || null,
            };
            await applyFingerprintToAllTabs(activeFingerprint);
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
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tls-profile-changed', p));
        return { success: true, profile: p };
    });

    ipcMain.handle('connect-direct', async (_, tlsProfile) => {
        try {
            if (persistentAnonymizedProxyUrl) {
                await ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true).catch(() => {});
                persistentAnonymizedProxyUrl = null;
            }
            actProxy = '';
            if (mitmProxy) {
                mitmProxy.setUpstream(null);
                mitmProxy._activeJa3 = null;
            }

            const { session: s } = require('electron');
            const sharedSess = s.fromPartition('persist:cupnet-shared');
            await sharedSess.setProxy({ proxyRules: 'http=127.0.0.1:8877;https=127.0.0.1:8877' });

            const p = ['chrome','firefox','safari','ios','edge','opera'].includes(tlsProfile) ? tlsProfile : 'chrome';
            mitmProxy?.setBrowser(p);
            const settings = loadSettings();
            settings.tlsProfile = p;
            saveSettings(settings);

            for (const tab of tabManager.getAllTabs()) {
                if (tab?.tabSession) {
                    try { await tab.tabSession.setProxy({ proxyRules: 'http=127.0.0.1:8877;https=127.0.0.1:8877' }); } catch {}
                }
            }

            buildMenu();
            notifyProxyStatus();
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tls-profile-changed', p));
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ── Start app immediately — window shows before heavy init ───────────────
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('will-quit', async () => {
    if (logStatusInterval) clearInterval(logStatusInterval);
    if (screenshotTimer) clearInterval(screenshotTimer);
    if (persistentAnonymizedProxyUrl) {
        await ProxyChain.closeAnonymizedProxy(persistentAnonymizedProxyUrl, true).catch(() => {});
    }
    if (tabManager) tabManager.destroyAll();
    if (db) {
        if (currentSessionId) db.endSession(currentSessionId);
        db.close();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});
