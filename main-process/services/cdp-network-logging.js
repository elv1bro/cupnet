'use strict';

const { isDevtoolsHostileUrl: _rawIsDevtoolsHostileUrl } = require('./devtools-hostile-sites');

/**
 * Layer-2 trial mode (Anti-Anti-Debug preload shim).
 * When set to "1", we keep CDP attached on hostile sites and rely on the
 * preload-injected `__cupnetAntiAntiDebug` IIFE (see preload-view.js +
 * main-process/services/anti-anti-debug-script.js) to neutralize the page's
 * `debugger;` / console-trap based detection. Used to verify whether Layer 2
 * alone is sufficient before promoting to default behavior.
 *
 *   CUPNET_AAD_KEEP_CDP=1 npm start    # test mode: CDP on + Layer 2
 *   npm start                           # safe default: CDP detached + Layer 2
 */
const _AAD_KEEP_CDP = process.env.CUPNET_AAD_KEEP_CDP === '1';

function isDevtoolsHostileUrl(url) {
    if (_AAD_KEEP_CDP) return false;
    return _rawIsDevtoolsHostileUrl(url);
}

/** CDP Network.* логирование, очередь записи в БД, rule actions из CDP-пути. */

function _remoteObjectToString(ro) {
    if (!ro || typeof ro !== 'object') return '';
    if (ro.unserializableValue != null) return String(ro.unserializableValue);
    if (ro.value !== undefined && ro.value !== null) {
        if (typeof ro.value === 'object') {
            try { return JSON.stringify(ro.value); } catch { return String(ro.description || '[Object]'); }
        }
        return String(ro.value);
    }
    if (ro.description) return String(ro.description);
    return '';
}

function _stackTraceFirstUrl(st) {
    if (!st || !Array.isArray(st.callFrames) || !st.callFrames.length) return { url: null, line: null };
    const f = st.callFrames[0];
    return { url: f.url || null, line: f.lineNumber != null ? f.lineNumber + 1 : null };
}

/** CDP Network.* логирование, очередь записи в БД, rule actions из CDP-пути. */
function createCdpNetworkLogging({
    safeCatch,
    shouldFilterUrl,
    getTabManager,
    getMitmProxy,
    getIsLoggingEnabled,
    getDb,
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
    /** DevTools и debugger API на одном webContents в Electron конфликтуют; Network может показывать запросы не той вкладки. */
    const _devtoolsCdpBridgeWc = new WeakSet();
    /** Per-webContents guard: detach CDP before loading pages that freeze on DevTools/debugger. */
    const _devtoolsHostileNavGuardWc = new WeakSet();
    /** Per webContents: один набор Map/таймер/очереди — повторный setupNetworkLogging не дублирует интервалы и destroyed */
    const _wcLogState = new WeakMap();

    function detachCdpForCompatibility(webContents, phase) {
        if (!webContents || webContents.isDestroyed()) return;
        try {
            const dbg = webContents.debugger;
            dbg.removeAllListeners('message');
            dbg.removeAllListeners('detach');
            if (dbg.isAttached()) dbg.detach();
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'cdp.detach.failed', context: { phase } }, err, 'info');
        }
        _cdpAttachedWc.delete(webContents);
    }

    function registerDevtoolsHostileNavigationGuard(webContents) {
        if (!webContents || webContents.isDestroyed()) return;
        if (_devtoolsHostileNavGuardWc.has(webContents)) return;
        _devtoolsHostileNavGuardWc.add(webContents);

        const detachIfHostile = (url, phase) => {
            if (isDevtoolsHostileUrl(url)) detachCdpForCompatibility(webContents, phase);
        };

        webContents.on('will-navigate', (_event, url) => {
            detachIfHostile(url, 'devtools-hostile.will-navigate');
        });
        webContents.on('did-navigate', (_event, url) => {
            detachIfHostile(url, 'devtools-hostile.did-navigate');
            if (isDevtoolsHostileUrl(url)) return;

            const st = _wcLogState.get(webContents);
            if (!st) return;
            const loggingEnabled = getIsLoggingEnabled();
            const activeFp = typeof getActiveFingerprint === 'function' ? getActiveFingerprint() : null;
            const activityOn = !!(getSettings() && getSettings().activityMonitorEnabled) && loggingEnabled;
            if (!loggingEnabled && !activeFp && !activityOn) return;
            setupNetworkLogging(webContents, st.tabId, st.sessionId).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'cdp.reattach.failed', context: { phase: 'devtools-hostile.did-navigate' } }, err, 'info');
            });
        });
        webContents.once('destroyed', () => {
            _devtoolsHostileNavGuardWc.delete(webContents);
        });
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

        registerDevtoolsHostileNavigationGuard(webContents);
        wcIdToTabId.set(webContents.id, tabId);

        const loggingEnabled = getIsLoggingEnabled();
        const activeFp = typeof getActiveFingerprint === 'function' ? getActiveFingerprint() : null;
        /** Activity Monitor CDP domains only while recording — same session as HTTP log. */
        const activityOn = !!(getSettings() && getSettings().activityMonitorEnabled) && loggingEnabled;
        // CDP: network log, fingerprint Emulation.*, or Activity Monitor (when recording + setting on).
        if (!loggingEnabled && !activeFp && !activityOn) return;

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
            state.activityRate = null;
        }
        const { ongoingRequests, ongoingWebsockets, extraInfoQueue } = state;

        const currentUrl = webContents.getURL();
        if (isDevtoolsHostileUrl(currentUrl)) {
            detachCdpForCompatibility(webContents, 'devtools-hostile.setup');
            return;
        }

        if (!_devtoolsCdpBridgeWc.has(webContents)) {
            _devtoolsCdpBridgeWc.add(webContents);
            webContents.on('devtools-opened', () => {
                if (webContents.isDestroyed()) return;
                try {
                    const dbg = webContents.debugger;
                    dbg.removeAllListeners('message');
                    dbg.removeAllListeners('detach');
                    if (dbg.isAttached()) dbg.detach();
                } catch (err) {
                    safeCatch({ module: 'main', eventCode: 'cdp.detach.failed', context: { phase: 'devtools-opened' } }, err, 'info');
                }
                _cdpAttachedWc.delete(webContents);
            });
                webContents.on('devtools-closed', () => {
                if (webContents.isDestroyed()) return;
                const st = _wcLogState.get(webContents);
                if (!st) return;
                const le = getIsLoggingEnabled();
                const activeFp = typeof getActiveFingerprint === 'function' ? getActiveFingerprint() : null;
                const am = !!(getSettings() && getSettings().activityMonitorEnabled) && le;
                if (!le && !activeFp && !am) return;
                setupNetworkLogging(webContents, st.tabId, st.sessionId).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'cdp.reattach.failed', context: { phase: 'devtools-closed' } }, err, 'info');
                });
            });
        }

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
                const { resolveRendererUserAgent } = require('../../user-agent-utils');
                cdp.sendCommand('Emulation.setUserAgentOverride', {
                    userAgent:      resolveRendererUserAgent(getActiveFingerprint().user_agent),
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

        const activityMonitorOn = !!(getSettings() && getSettings().activityMonitorEnabled) && loggingEnabled;
        if (activityMonitorOn) {
            await cdp.sendCommand('Runtime.enable', {}).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Runtime.enable', tabId: state.tabId } }, err, 'info');
            });
            await cdp.sendCommand('Log.enable', {}).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'Log.enable', tabId: state.tabId } }, err, 'info');
            });
            await cdp.sendCommand('DOMStorage.enable', {}).catch((err) => {
                safeCatch({ module: 'main', eventCode: 'cdp.command.failed', context: { command: 'DOMStorage.enable', tabId: state.tabId } }, err, 'info');
            });
        }

        function _cupnetRidFromHeaders(headers) {
            if (!headers || typeof headers !== 'object') return null;
            for (const k of Object.keys(headers)) {
                if (k.toLowerCase() === 'x-cupnet-rid') {
                    const v = String(headers[k] || '').trim();
                    return v || null;
                }
            }
            return null;
        }

        function _requestHeadersWithoutCupnetRid(headers) {
            if (!headers || typeof headers !== 'object') return null;
            const o = { ...headers };
            for (const k of Object.keys(o)) {
                if (k.toLowerCase() === 'x-cupnet-rid') delete o[k];
            }
            return o;
        }

        const finalizeBrowserActivityLog = (entry) => {
            entry._cupnetLogSid = state.sessionId;
            entry._cupnetLogTid = state.tabId;
            entry._browserEvent = true;
            state.logQueue.push(entry);
            if (!state.logQueueScheduled) {
                state.logQueueScheduled = true;
                setImmediate(() => {
                    _processLogQueue().catch((err) => {
                        safeCatch({ module: 'main', eventCode: 'getDb().write.failed', context: { op: 'processLogQueue.browser', tabId: state.tabId } }, err);
                    });
                });
            }
        };

        const _processLogQueue = async () => {
            state.logQueueScheduled = false;
            const batch = state.logQueue.splice(0, 50);
            for (const logEntry of batch) {
                const reqKey = logEntry.id;
                const sid = logEntry._cupnetLogSid;
                const tid = logEntry._cupnetLogTid;
                incrementLogEntryCount();

                try {
                    if (logEntry._browserEvent) {
                        const dbId = await getDb().insertBrowserEventAsync(sid, tid, {
                            event_type: logEntry.event_type,
                            level: logEntry.level,
                            summary: logEntry.summary,
                            detail: logEntry.detail,
                            source_url: logEntry.source_url,
                            source_line: logEntry.source_line,
                            origin: logEntry.origin,
                        });
                        if (dbId) logEntry.id = dbId;
                        logEntry.url = logEntry.summary || '';
                        const et = String(logEntry.event_type || '');
                        if (et === 'exception') logEntry.type = 'exception';
                        else if (et.startsWith('ls-') || et.startsWith('ss-')) logEntry.type = 'storage';
                        else logEntry.type = 'browser';
                    } else if (logEntry.type === 'websocket_frame' || logEntry.type === 'websocket_closed' || logEntry.type === 'websocket_error') {
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
                        let dbId;
                        try {
                            dbId = await getDb().insertRequestAsync(sid, tid, {
                                requestId: logEntry.id,
                                url: logEntry.url,
                                method: logEntry.method,
                                status: logEntry.response?.statusCode || null,
                                type: logEntry.type,
                                duration: logEntry.duration || null,
                                requestHeaders: _requestHeadersWithoutCupnetRid(logEntry.request?.headers),
                                responseHeaders: logEntry.response?.headers || null,
                                requestBody: logEntry.request?.body || null,
                                responseBody: logEntry.responseBody || null,
                                error: logEntry.error || null
                            });
                        } catch (insErr) {
                            const rid = logEntry._cupnetRid || _cupnetRidFromHeaders(logEntry.request?.headers);
                            if (rid) {
                                try {
                                    const { releaseRid } = require('./mitm-cdp-dedup');
                                    releaseRid(rid);
                                } catch (_) { /* ignore */ }
                            }
                            throw insErr;
                        }
                        if (dbId) logEntry.id = dbId;
                        try {
                            if (!logEntry._cupnetRid) {
                                const { markCdpLogged } = require('./mitm-cdp-dedup');
                                const st = logEntry.response?.statusCode ?? null;
                                markCdpLogged(tid, logEntry.url, logEntry.method, st);
                            }
                        } catch (_) { /* ignore */ }

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

                if (!logEntry._browserEvent) {
                    ongoingRequests.delete(reqKey);
                }
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
            const rid = logEntry._cupnetRid || _cupnetRidFromHeaders(logEntry.request?.headers);
            if (rid) logEntry._cupnetRid = rid;
            if (rid) {
                try {
                    const { tryClaimRid } = require('./mitm-cdp-dedup');
                    if (tryClaimRid(rid) === false) {
                        delete logEntry._mitmCdpShadow;
                        return;
                    }
                } catch (_) { /* ignore */ }
            } else if (logEntry._mitmCdpShadow) {
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
            if (logEntry.request && logEntry.request.headers) {
                logEntry.request.headers = _requestHeadersWithoutCupnetRid(logEntry.request.headers) || logEntry.request.headers;
            }
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
            const logNet = getIsLoggingEnabled();
            /** Activity + Network CDP events are tied to the same recording session. */
            if (!logNet) return;

            const activityMonitorEnabled = !!(getSettings() && getSettings().activityMonitorEnabled);
            const settings      = getSettings();
            const filterPatterns = settings.filterPatterns || [];
            const rateLimit = Math.max(1, Math.min(500, Number(settings.activityMonitorRateLimit) || 100));

            if (activityMonitorEnabled) {
                if (method === 'Runtime.consoleAPICalled') {
                    const w = state.activityRate || (state.activityRate = { windowStart: Date.now(), count: 0, suppressed: 0 });
                    const now = Date.now();
                    if (now - w.windowStart > 1000) {
                        if (w.suppressed > 0) {
                            finalizeBrowserActivityLog({
                                event_type: 'console',
                                level: 'info',
                                summary: `${w.suppressed} console message(s) suppressed (rate limit)`,
                                detail: JSON.stringify({ suppressed: w.suppressed, rateLimitPerSec: rateLimit }),
                                source_url: null,
                                source_line: null,
                                origin: null,
                            });
                        }
                        w.windowStart = now;
                        w.count = 0;
                        w.suppressed = 0;
                    }
                    w.count += 1;
                    if (w.count > rateLimit) {
                        w.suppressed += 1;
                        return;
                    }
                    const args = params.args || [];
                    const argStrs = args.map(_remoteObjectToString);
                    let summary = argStrs.join(' ');
                    if (summary.length > 500) summary = summary.slice(0, 497) + '...';
                    const st = _stackTraceFirstUrl(params.stackTrace);
                    const detail = {
                        args: args.map((a) => ({ type: a.type, description: a.description, value: a.value })),
                        stackTrace: params.stackTrace || null,
                    };
                    finalizeBrowserActivityLog({
                        event_type: 'console',
                        level: String(params.type || 'log'),
                        summary: summary || '(console)',
                        detail: JSON.stringify(detail),
                        source_url: st.url,
                        source_line: st.line,
                        origin: null,
                    });
                    return;
                }
                if (method === 'Runtime.exceptionThrown') {
                    const ex = params.exceptionDetails || {};
                    const exc = ex.exception || {};
                    const msg = String(exc.description || exc.value || ex.message || 'Exception');
                    const detail = JSON.stringify(ex);
                    const st = _stackTraceFirstUrl(ex.stackTrace);
                    finalizeBrowserActivityLog({
                        event_type: 'exception',
                        level: 'error',
                        summary: msg.slice(0, 8000),
                        detail,
                        source_url: ex.url || st.url,
                        source_line: ex.lineNumber != null ? ex.lineNumber + 1 : st.line,
                        origin: null,
                    });
                    return;
                }
                if (method === 'Log.entryAdded') {
                    const e = params.entry || {};
                    const src = String(e.source || '');
                    const isCsp = src === 'security' || String(e.text || '').toLowerCase().includes('content security policy');
                    const et = isCsp ? 'csp-violation' : 'log-entry';
                    finalizeBrowserActivityLog({
                        event_type: et,
                        level: String(e.level || 'info'),
                        summary: String(e.text || e.message || '').slice(0, 8000) || '(log)',
                        detail: JSON.stringify(e),
                        source_url: e.url || null,
                        source_line: e.lineNumber != null ? e.lineNumber : null,
                        origin: null,
                    });
                    return;
                }
                if (method === 'DOMStorage.domStorageItemAdded') {
                    const sid = params.storageId || {};
                    const ls = !!sid.isLocalStorage;
                    const prefix = ls ? 'ls' : 'ss';
                    const key = String(params.key || '');
                    const nv = params.newValue != null ? String(params.newValue) : '';
                    const sum = `${key} = ${nv.length > 200 ? `${nv.slice(0, 200)}…` : nv}`;
                    const storageKind = ls ? 'localStorage' : 'sessionStorage';
                    finalizeBrowserActivityLog({
                        event_type: `${prefix}-set`,
                        level: 'info',
                        summary: sum.slice(0, 8000),
                        detail: JSON.stringify({
                            key,
                            newValue: params.newValue,
                            storageKind,
                            isLocalStorage: ls,
                            storageId: sid,
                        }),
                        source_url: null,
                        source_line: null,
                        origin: sid.securityOrigin || null,
                    });
                    return;
                }
                if (method === 'DOMStorage.domStorageItemUpdated') {
                    const sid = params.storageId || {};
                    const ls = !!sid.isLocalStorage;
                    const prefix = ls ? 'ls' : 'ss';
                    const key = String(params.key || '');
                    const nv = params.newValue != null ? String(params.newValue) : '';
                    const ov = params.oldValue != null ? String(params.oldValue) : '';
                    const sum = `${key}: ${ov.length > 100 ? `${ov.slice(0, 100)}…` : ov} → ${nv.length > 100 ? `${nv.slice(0, 100)}…` : nv}`;
                    const storageKind = ls ? 'localStorage' : 'sessionStorage';
                    finalizeBrowserActivityLog({
                        event_type: `${prefix}-set`,
                        level: 'info',
                        summary: sum.slice(0, 8000),
                        detail: JSON.stringify({
                            key,
                            oldValue: params.oldValue,
                            newValue: params.newValue,
                            storageKind,
                            isLocalStorage: ls,
                            storageId: sid,
                        }),
                        source_url: null,
                        source_line: null,
                        origin: sid.securityOrigin || null,
                    });
                    return;
                }
                if (method === 'DOMStorage.domStorageItemRemoved') {
                    const sid = params.storageId || {};
                    const ls = !!sid.isLocalStorage;
                    const prefix = ls ? 'ls' : 'ss';
                    const key = String(params.key || '');
                    const storageKindRm = ls ? 'localStorage' : 'sessionStorage';
                    finalizeBrowserActivityLog({
                        event_type: `${prefix}-remove`,
                        level: 'info',
                        summary: `remove ${key}`.slice(0, 8000),
                        detail: JSON.stringify({
                            key,
                            storageKind: storageKindRm,
                            isLocalStorage: ls,
                            storageId: sid,
                        }),
                        source_url: null,
                        source_line: null,
                        origin: sid.securityOrigin || null,
                    });
                    return;
                }
                if (method === 'DOMStorage.domStorageItemsCleared') {
                    const sid = params.storageId || {};
                    const ls = !!sid.isLocalStorage;
                    const prefix = ls ? 'ls' : 'ss';
                    const storageKindClr = ls ? 'localStorage' : 'sessionStorage';
                    finalizeBrowserActivityLog({
                        event_type: `${prefix}-clear`,
                        level: 'info',
                        summary: 'storage cleared',
                        detail: JSON.stringify({
                            storageKind: storageKindClr,
                            isLocalStorage: ls,
                            storageId: sid,
                        }),
                        source_url: null,
                        source_line: null,
                        origin: sid.securityOrigin || null,
                    });
                    return;
                }
            }

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
                    _cupnetRid: _cupnetRidFromHeaders(request.headers || {}),
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
                    _cupnetRid: _cupnetRidFromHeaders(request.headers || {}),
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

        cdp.on('detach', (_reason) => {
            _cdpAttachedWc.delete(webContents);
            try {
                cdp.removeAllListeners('message');
                cdp.removeAllListeners('detach');
            } catch (_) { /* ignore */ }
            console.log('[CDP] Detached:', _reason);
        });

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
