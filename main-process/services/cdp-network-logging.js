'use strict';

/**
 * CDP Network.* / Fetch.* логирование, очередь записи в БД, rule actions из CDP-пути.
 */
function createCdpNetworkLogging({
    safeCatch,
    shouldFilterUrl,
    Notification,
    getTabManager,
    getMitmProxy,
    /** 'mitm' | 'browser_proxy' — CDP HTTP пропускаем только когда трафик реально идёт через MITM */
    getCurrentTrafficMode,
    getIsLoggingEnabled,
    getDb,
    getRulesEngine,
    getSettings,
    getLogViewerWindows,
    broadcastLogEntryToViewers,
    wcIdToTabId,
    incrementLogEntryCount,
    getActiveFingerprint,
    getMainWindow,
    requestScreenshot,
}) {
    const _cdpAttachedWc = new WeakSet();
    const _trackingLoadAttachedWc = new WeakSet();

async function setupNetworkLogging(webContents, tabId, sessionId) {
    if (!webContents || webContents.isDestroyed()) return;
    // CDP-attach только при активном логировании — Cloudflare Turnstile детектит прикреплённый debugger
    // как сигнал автоматизации и блокирует challenge (ошибка 600010 «bot behavior»).
    if (!getIsLoggingEnabled()) return;
    wcIdToTabId.set(webContents.id, tabId);
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
                const __tm = getTabManager(); if (!__tm || __tm.getActiveTabId() !== tabId) return;
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
        wcIdToTabId.delete(webContents.id);
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
        maxTotalBufferSize:    100 * 1024 * 1024,  // 100 MB total across all resources
        maxResourceBufferSize:  10 * 1024 * 1024,  // 10 MB per individual resource
    }).catch((err) => {
        safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Network.enable', tabId } }, err, 'info');
    });

    // Fetch.enable: пауза на *каждом* запросе + заголовки X-CupNet-*.
    // В browser_proxy трафик идёт мимо MITM — эти заголовки уходят на реальные сайты (Cloudflare/Turnstile
    // часто отвечают ERR_BLOCKED_BY_RESPONSE / 600010). Включаем Fetch только в mitm, где MITM читает метки.
    const _trafficMode = typeof getCurrentTrafficMode === 'function' ? getCurrentTrafficMode() : 'mitm';
    const _mitm = typeof getMitmProxy === 'function' ? getMitmProxy() : null;
    const _useFetchMitmHeaders = _trafficMode === 'mitm' && !!_mitm;
    if (_useFetchMitmHeaders) {
        await cdp.sendCommand('Fetch.enable', {
            patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        }).catch((err) => {
            safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Fetch.enable', tabId } }, err, 'info');
        });
    } else {
        await cdp.sendCommand('Fetch.disable', {}).catch((err) => {
            safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Fetch.disable', tabId } }, err, 'info');
        });
    }

    // Apply active fingerprint via CDP now that the debugger is attached
    if (getActiveFingerprint()) {
        if (getActiveFingerprint().user_agent) {
            cdp.sendCommand('Emulation.setUserAgentOverride', {
                userAgent:      getActiveFingerprint().user_agent,
                acceptLanguage: getActiveFingerprint().language || '',
            }).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Emulation.setUserAgentOverride', tabId } }, err, 'info');
            });
        }
        if (getActiveFingerprint().timezone) {
            cdp.sendCommand('Emulation.setTimezoneOverride', {
                timezoneId: getActiveFingerprint().timezone,
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
        incrementLogEntryCount();

        // ── Write to SQLite ──
        try {
            if (logEntry.type === 'websocket_frame' || logEntry.type === 'websocket_closed' || logEntry.type === 'websocket_error') {
                await getDb().insertWsEventAsync(sessionId, tabId, logEntry.url || '', logEntry.direction || 'recv', logEntry.data || logEntry.error || null);
            } else if (logEntry.type === 'screenshot') {
                await getDb().insertScreenshotAsync(sessionId, tabId, logEntry.path, logEntry.imageData || null, logEntry.screenshotMeta || null);
            } else {
                // insertRequest returns the SQLite integer id — store it on logEntry
                // so the log viewer can call getRequestDetail(id) for lazy header/body load.
                const dbId = await getDb().insertRequestAsync(sessionId, tabId, {
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
                const re = getRulesEngine(); if (re) {
                    try {
                        const matched = re.evaluate({
                            url: logEntry.url,
                            method: logEntry.method,
                            status: logEntry.response?.statusCode,
                            type: logEntry.type,
                            duration_ms: logEntry.duration,
                            response_body: logEntry.responseBody
                        });
                        if (matched.length) {
                            const actions = re.buildActions(matched);
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

        // ── Forward to log viewer (only if any window open) ──
        if (getLogViewerWindows().length > 0) {
            const msg = { ...logEntry, tabId, sessionId };
            broadcastLogEntryToViewers(msg);
        }

        ongoingRequests.delete(reqKey);
        }
        if (_logQueue.length) {
            _logQueueScheduled = true;
            setImmediate(() => {
                _processLogQueue().catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'getDb().write.failed', context: { op: 'processLogQueue', tabId } }, err);
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
                    safeCatch({ module: 'main', eventCode: 'getDb().write.failed', context: { op: 'processLogQueue.schedule', tabId } }, err);
                });
            });
        }
    };

    cdp.on('message', async (_, method, params) => {
        // Fetch.requestPaused: inject X-CupNet-TabId/SessionId for MITM tab attribution
        if (method === 'Fetch.requestPaused') {
            const { requestId, request, responseStatusCode } = params;
            if (responseStatusCode == null) {
                const h = request.headers || {};
                const headers = Object.entries(h).map(([name, value]) => ({ name, value }));
                headers.push({ name: 'X-CupNet-TabId', value: String(tabId) });
                headers.push({ name: 'X-CupNet-SessionId', value: String(sessionId) });
                headers.push({ name: 'X-CupNet-RequestId', value: String(requestId) });
                cdp.sendCommand('Fetch.continueRequest', { requestId, headers }).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Fetch.continueRequest.headers', tabId } }, err, 'info');
                });
            } else {
                cdp.sendCommand('Fetch.continueResponse', { requestId }).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Fetch.continueResponse', tabId } }, err, 'info');
                    cdp.sendCommand('Fetch.continueRequest', { requestId }).catch((err2) => {
                        safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Fetch.continueRequest.fallback', tabId } }, err2, 'info');
                    });
                });
            }
        }

        if (!getIsLoggingEnabled()) return;

        const settings      = getSettings();
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
        // mitm: успешные запросы в БД пишет MITM; в CDP держим «тень» по requestId, чтобы loadingFailed не терялся.
        // browser_proxy: полный CDP-путь ниже (MITM трафик не видит).
        const _trafficMode = typeof getCurrentTrafficMode === 'function' ? getCurrentTrafficMode() : 'mitm';
        // В mitm трафик пишет MITM; CDP только для сбоев (loadingFailed), иначе дубли в логе.
        if (method === 'Network.requestWillBeSent' && _trafficMode === 'mitm' && getMitmProxy()) {
            const { requestId, request, timestamp, type, redirectResponse } = params;
            if (redirectResponse) return;
            if (request.url.startsWith('data:')) return;
            if (shouldFilterUrl(request.url, filterPatterns)) return;
            ongoingRequests.set(requestId, {
                id: requestId, url: request.url, method: request.method,
                startTime: timestamp, type,
                request: { headers: request.headers, body: request.postData || null },
                response: null, responseBody: null,
                _mitmCdpShadow: true,
                _addedAt: Date.now(),
            });
            return;
        }
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
                if (entry._mitmCdpShadow) {
                    entry._finalizing = true;
                    ongoingRequests.delete(params.requestId);
                    extraInfoQueue.delete(params.requestId);
                    return;
                }
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
                extraInfoQueue.delete(params.requestId);
                let errText = params.errorText || '';
                if (params.blockedReason) {
                    errText = errText ? `${errText} (${params.blockedReason})` : String(params.blockedReason);
                }
                entry.error = errText || 'loading failed';
                delete entry._mitmCdpShadow;
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
            const __mw = getMainWindow(); if (__mw && !__mw.isDestroyed()) {
                __mw.webContents.send('rule-notification', {
                    ruleName: action.ruleName || 'unnamed',
                    url:      logEntry.url || '',
                });
            }
        }
        if (action.type === 'highlight') {
            for (const w of getLogViewerWindows()) {
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
    return { setupNetworkLogging };
}

module.exports = { createCdpNetworkLogging };
