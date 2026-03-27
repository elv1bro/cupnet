'use strict';

/** CDP Network.* логирование, очередь записи в БД, rule actions из CDP-пути. */
function createCdpNetworkLogging({
    safeCatch,
    shouldFilterUrl,
    Notification,
    getTabManager,
    getMitmProxy,
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
    /** Per webContents: один набор Map/таймер/очереди — повторный setupNetworkLogging не дублирует интервалы и destroyed */
    const _wcLogState = new WeakMap();

    function handleRuleActions(actions, logEntry) {
        for (const action of actions) {
            if (action.type === 'notification') {
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

    function registerWcLoggingTeardownOnce(webContents, state) {
        if (state._teardownRegistered) return;
        state._teardownRegistered = true;
        webContents.once('destroyed', () => {
            if (state.staleCleanupTimer) {
                clearInterval(state.staleCleanupTimer);
                state.staleCleanupTimer = null;
            }
            try { wcIdToTabId.delete(webContents.id); } catch (_) { /* ignore */ }
            state.ongoingRequests.clear();
            state.ongoingWebsockets.clear();
            state.extraInfoQueue.clear();
            try {
                const dbg = webContents.debugger;
                dbg.removeAllListeners('message');
                dbg.removeAllListeners('detach');
                if (dbg.isAttached()) dbg.detach();
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'cdp.detach.failed', context: { phase: 'destroy.teardown' } }, err, 'info');
            }
            _cdpAttachedWc.delete(webContents);
            _trackingLoadAttachedWc.delete(webContents);
            _wcLogState.delete(webContents);
        });
    }

    async function setupNetworkLogging(webContents, tabId, sessionId) {
        if (!webContents || webContents.isDestroyed()) return;

        wcIdToTabId.set(webContents.id, tabId);

        const loggingEnabled = getIsLoggingEnabled();
        const activeFp = typeof getActiveFingerprint === 'function' ? getActiveFingerprint() : null;
        // Раньше CDP поднимали и без логов ради X-CupNet-*; теперь — ради Emulation.* при активном fingerprint.
        if (!loggingEnabled && !activeFp) return;

        let state = _wcLogState.get(webContents);
        if (!state) {
            state = {
                tabId,
                sessionId,
                ongoingRequests:   new Map(),
                ongoingWebsockets: new Map(),
                extraInfoQueue:    new Map(),
                logQueue:          [],
                logQueueScheduled: false,
                staleCleanupTimer: null,
                _teardownRegistered: false,
            };
            _wcLogState.set(webContents, state);
        } else {
            state.tabId = tabId;
            state.sessionId = sessionId;
            state.ongoingRequests.clear();
            state.ongoingWebsockets.clear();
            state.extraInfoQueue.clear();
        }
        const { ongoingRequests, ongoingWebsockets, extraInfoQueue } = state;
        const cdp = webContents.debugger;

        if (!_trackingLoadAttachedWc.has(webContents)) {
            _trackingLoadAttachedWc.add(webContents);
            webContents.on('did-finish-load', () => {
                try {
                    const st = _wcLogState.get(webContents);
                    const tid = st?.tabId;
                    if (tid == null) return;
                    const __tm = getTabManager(); if (!__tm || __tm.getActiveTabId() !== tid) return;
                    requestScreenshot({ reason: 'page-load', meta: { tabId: tid } }).catch((err) => {
                        safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'page-load', tabId: tid } }, err, 'info');
                    });
                } catch (err) {
                    safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'page-load' } }, err, 'info');
                }
            });
        }

        if (_cdpAttachedWc.has(webContents)) {
            try {
                cdp.removeAllListeners('message');
                cdp.removeAllListeners('detach');
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'cdp.detach.failed', context: { phase: 'reattach.remove-listeners', tabId: state.tabId } }, err, 'info');
            }
        } else {
            try {
                if (!cdp.isAttached()) cdp.attach('1.3');
            } catch (err) {
                console.error('[CDP] Failed to attach:', err.message);
                return;
            }
            _cdpAttachedWc.add(webContents);
        }

        await cdp.sendCommand('Fetch.disable', {}).catch((err) => {
            safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Fetch.disable', tabId: state.tabId } }, err, 'info');
        });
        await cdp.sendCommand('Network.enable', {
            maxTotalBufferSize:    loggingEnabled ? 100 * 1024 * 1024 : 0,
            maxResourceBufferSize:  loggingEnabled ? 10 * 1024 * 1024 : 0,
        }).catch((err) => {
            safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Network.enable', tabId: state.tabId } }, err, 'info');
        });

        // При включённом логе отключаем HTTP-кеш страницы — иначе document/JS часто не дают полноценных CDP-событий в лог.
        await cdp.sendCommand('Network.setCacheDisabled', { cacheDisabled: !!loggingEnabled }).catch((err) => {
            safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Network.setCacheDisabled', tabId: state.tabId } }, err, 'info');
        });

        // Сброс лишних заголовков (старые сборки с X-CupNet-*). TabId для MITM — Proxy-Authorization на CONNECT.
        await cdp.sendCommand('Network.setExtraHTTPHeaders', { headers: {} }).catch((err) => {
            safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Network.setExtraHTTPHeaders.clear', tabId: state.tabId } }, err, 'info');
        });

        if (getActiveFingerprint()) {
            if (getActiveFingerprint().user_agent) {
                cdp.sendCommand('Emulation.setUserAgentOverride', {
                    userAgent:      getActiveFingerprint().user_agent,
                    acceptLanguage: getActiveFingerprint().language || '',
                }).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Emulation.setUserAgentOverride', tabId: state.tabId } }, err, 'info');
                });
            }
            if (getActiveFingerprint().timezone) {
                cdp.sendCommand('Emulation.setTimezoneOverride', {
                    timezoneId: getActiveFingerprint().timezone,
                }).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Emulation.setTimezoneOverride', tabId: state.tabId } }, err, 'info');
                });
            }
        }

        const _processLogQueue = async () => {
            state.logQueueScheduled = false;
            const batch = state.logQueue.splice(0, 50);
            for (const logEntry of batch) {
                const reqKey = logEntry.id;
                const sid = logEntry._cupnetLogSid;
                const tid = logEntry._cupnetLogTid;
                incrementLogEntryCount();

                try {
                    if (logEntry.type === 'websocket_frame' || logEntry.type === 'websocket_closed' || logEntry.type === 'websocket_error') {
                        const pl = logEntry.type === 'websocket_closed'
                            ? `__cupnet_ws_meta__:${JSON.stringify({ kind: 'closed', frames: logEntry.framesCount ?? 0 })}`
                            : logEntry.type === 'websocket_error'
                                ? `__cupnet_ws_meta__:${JSON.stringify({ kind: 'error', error: String(logEntry.error || '') })}`
                                : (logEntry.data || null);
                        const bump = await getDb().insertWsEventAsync(
                            sid, tid, logEntry.url || '', logEntry.direction || 'recv', pl,
                            logEntry.connectionId || null
                        );
                        if (bump && getLogViewerWindows) {
                            for (const w of getLogViewerWindows()) {
                                if (!w.isDestroyed()) w.webContents.send('ws-handshake-message-count', bump);
                            }
                        }
                    } else if (logEntry.type === 'screenshot') {
                        await getDb().insertScreenshotAsync(sid, tid, logEntry.path, logEntry.imageData || null, logEntry.screenshotMeta || null);
                    } else {
                        const dbId = await getDb().insertRequestAsync(sid, tid, {
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
                        if (dbId) logEntry.id = dbId;

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
                                safeCatch({ module: 'main', eventCode: 'rules.engine.failed', context: { tabId: tid, url: logEntry.url || '' } }, err);
                            }
                        }
                    }
                } catch (e) {
                    console.error('[DB] insertRequest failed:', e.message);
                }

                // WS frames/meta: only in DB + Messages tab (not one row per frame in list)
                if (getLogViewerWindows().length > 0) {
                    const skipBroadcast = logEntry.type === 'websocket_frame'
                        || logEntry.type === 'websocket_closed'
                        || logEntry.type === 'websocket_error';
                    if (!skipBroadcast) {
                        const msg = { ...logEntry, tabId: tid, sessionId: sid };
                        broadcastLogEntryToViewers(msg);
                    }
                }

                ongoingRequests.delete(reqKey);
            }
            if (state.logQueue.length) {
                state.logQueueScheduled = true;
                setImmediate(() => {
                    _processLogQueue().catch((err) => {
                        safeCatch({ module: 'main', eventCode: 'getDb().write.failed', context: { op: 'processLogQueue', tabId: state.tabId } }, err);
                    });
                });
            }
        };

        const finalizeLog = (logEntry) => {
            logEntry._cupnetLogSid = state.sessionId;
            logEntry._cupnetLogTid = state.tabId;
            if (logEntry._mitmCdpShadow) {
                try {
                    const { shouldSkipCdpShadowAsMitmDuplicate } = require('./mitm-cdp-dedup');
                    const st = logEntry.response?.statusCode;
                    if (shouldSkipCdpShadowAsMitmDuplicate(state.tabId, logEntry.url, logEntry.method, st)) {
                        delete logEntry._mitmCdpShadow;
                        return;
                    }
                } catch (_) { /* ignore */ }
            }
            delete logEntry._mitmCdpShadow;
            state.logQueue.push(logEntry);
            if (!state.logQueueScheduled) {
                state.logQueueScheduled = true;
                setImmediate(() => {
                    _processLogQueue().catch((err) => {
                        safeCatch({ module: 'main', eventCode: 'getDb().write.failed', context: { op: 'processLogQueue.schedule', tabId: state.tabId } }, err);
                    });
                });
            }
        };

        cdp.on('message', async (_, method, params) => {
            if (!getIsLoggingEnabled()) return;

            const settings      = getSettings();
            const filterPatterns = settings.filterPatterns || [];

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

            if (method === 'Network.requestWillBeSent' && getMitmProxy()) {
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

                if (redirectResponse) {
                    const prevEntry = ongoingRequests.get(requestId);
                    const queue = extraInfoQueue.get(requestId) || [];
                    const extraH = queue.shift() || (prevEntry && prevEntry._extraHeaders) || {};
                    if (!queue.length) extraInfoQueue.delete(requestId);

                    if (prevEntry && !prevEntry._finalizing) {
                        prevEntry._finalizing = true;
                        ongoingRequests.delete(requestId);
                        prevEntry.response = {
                            statusCode: redirectResponse.status,
                            headers:    Object.assign({}, redirectResponse.headers, extraH),
                            mimeType:   redirectResponse.mimeType || null,
                        };
                        prevEntry.duration = Math.round((timestamp - prevEntry.startTime) * 1000);
                        prevEntry.responseBody = null;
                        finalizeLog(prevEntry);
                    } else {
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
            if (method === 'Network.requestWillBeSentExtraInfo') {
                const entry = ongoingRequests.get(params.requestId);
                if (entry) {
                    if (params.headers) {
                        entry.request = entry.request || {};
                        entry.request.headers = Object.assign({}, entry.request.headers, params.headers);
                    }
                    if (params.associatedCookies?.length) {
                        entry._sentCookies = params.associatedCookies
                            .filter(ac => !ac.blockedReasons?.length)
                            .map(ac => ({ name: ac.cookie.name, value: ac.cookie.value }));
                        const cookieStr = entry._sentCookies.map(c => `${c.name}=${c.value}`).join('; ');
                        if (cookieStr) entry.request.headers['Cookie'] = cookieStr;
                    }
                }
            }
            if (method === 'Network.responseReceived') {
                const entry = ongoingRequests.get(params.requestId);
                if (entry) entry.response = { statusCode: params.response.status, headers: params.response.headers, mimeType: params.response.mimeType };
            }
            if (method === 'Network.responseReceivedExtraInfo') {
                const extraHeaders = params.headers || {};
                const queue = extraInfoQueue.get(params.requestId);
                if (queue) {
                    queue.push(extraHeaders);
                } else {
                    extraInfoQueue.set(params.requestId, [extraHeaders]);
                }
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
                if (entry && !entry._finalizing) {
                    entry._finalizing = true;
                    const rid = params.requestId;
                    ongoingRequests.delete(rid);

                    entry.duration = Math.round((params.timestamp - entry.startTime) * 1000);

                    {
                        const queue = extraInfoQueue.get(rid) || [];
                        const extraH = queue.shift() || entry._extraHeaders || {};
                        extraInfoQueue.delete(rid);
                        if (extraH && entry.response) {
                            entry.response.headers = Object.assign({}, entry.response.headers, extraH);
                        }
                    }

                    const bodyTimeoutMs = 12_000;
                    let rb = null;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            rb = await Promise.race([
                                cdp.sendCommand('Network.getResponseBody', { requestId: rid }),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('getResponseBody timeout')), bodyTimeoutMs)),
                            ]);
                            break;
                        } catch (err) {
                            const msg = err?.message || '';
                            const isRetryable = (msg.includes('No data') || msg.includes('No resource')) && !msg.includes('timeout');
                            if (isRetryable && attempt < 2) {
                                await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
                            } else {
                                if (!msg.includes('No data') && !msg.includes('No resource') && !msg.includes('timeout')) {
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
                    finalizeLog(entry);
                }
            }
        });

        cdp.on('detach', (_reason) => console.log('[CDP] Detached:', _reason));

        if (!state.staleCleanupTimer) {
            state.staleCleanupTimer = setInterval(() => {
                const st = _wcLogState.get(webContents);
                if (!st) return;
                const cutoff = Date.now() - 5 * 60 * 1000;
                for (const [id, entry] of st.ongoingRequests) {
                    if ((entry._addedAt || 0) < cutoff) st.ongoingRequests.delete(id);
                }
                for (const [id, entry] of st.ongoingWebsockets) {
                    if ((entry.created || 0) < cutoff) st.ongoingWebsockets.delete(id);
                }
                for (const [id, queue] of st.extraInfoQueue) {
                    if (queue._addedAt && queue._addedAt < cutoff) st.extraInfoQueue.delete(id);
                }
            }, 60_000);
            registerWcLoggingTeardownOnce(webContents, state);
        }
    }

    return { setupNetworkLogging };
}

module.exports = { createCdpNetworkLogging };
