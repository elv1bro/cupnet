'use strict';

const ProxyChain = require('proxy-chain');
const { networkPolicy } = require('../../network-policy');
const { withTimeout, sanitizeProxyUrl } = require('./network-helpers');

/** Legacy partition; вкладки по умолчанию сейчас в `persist:cg_*` (см. tab-manager `partitionForGroup`). */
const CUPNET_SHARED_PARTITION = 'persist:cupnet-shared';
/** Дефолтная группа cookies = partition `persist:cg_1` — совпадает с tab-manager. */
const DEFAULT_TAB_PARTITION = 'persist:cg_1';

/**
 * MITM startup, proxy-chain helpers, IP/geo checks.
 * @param {object} d — см. cupnet-runtime: buildProxyServiceDeps()
 */
function createProxyMitmService(d) {
    let _proxySwitchChain = Promise.resolve();
    let _lastIpGeoError = '';
    /** Полёт по ключу вкладки/профиля — разные вкладки не ждут чужой check-ip-geo. */
    let _checkIpGeoInFlight = new Map();
    /** UI (toolbar + new-tab) часто дергает check-ip-geo подряд — кэш снимает дубли TLS/логов. */
    let _ipGeoCache = { key: '', at: 0, value: null };
    const IP_GEO_CACHE_MS = 4000;

    function _maskUrlForLog(u) {
        if (!u) return '(none)';
        try {
            const raw = String(u);
            const x = new URL(raw.includes('://') ? raw : `http://${raw}`);
            if (x.password) x.password = '***';
            if (x.username) x.username = `${x.username.slice(0, 12)}…`;
            return x.toString();
        } catch {
            return '(unparseable)';
        }
    }

    /**
     * Резерв после session.fetch: навигация в Chromium с нужной session.
     * Раньше считалось, что fetch в main «не совпадает» с маршрутом — для ipinfo теперь сначала `_fetchIpinfoJsonViaSession`.
     */
    async function _loadJsonUrlThroughHiddenWindow(targetSession, url, timeoutMs = networkPolicy.timeouts.ipGeoMs) {
        let win = null;
        const timer = setTimeout(() => {
            try { win?.destroy(); } catch (_) { /* ignore */ }
        }, timeoutMs);
        try {
            win = new d.BrowserWindow({
                show: false,
                webPreferences: {
                    session: targetSession,
                    nodeIntegration: false,
                    contextIsolation: true,
                },
            });
            await win.loadURL(url);
            const text = await win.webContents.executeJavaScript('document.body.innerText');
            return JSON.parse(text);
        } finally {
            clearTimeout(timer);
            try { win?.destroy(); } catch (_) { /* ignore */ }
        }
    }

    /** session.fetch с bypass handlers — предпочтительнее hidden-window при MITM + intercept. */
    async function _fetchIpinfoJsonViaSession(sharedSess, timeoutMs = networkPolicy.timeouts.ipGeoMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await sharedSess.fetch('https://ipinfo.io/json', {
                signal: ctrl.signal,
                bypassCustomProtocolHandlers: true,
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            if (j && j.error === 'cupnet_pass_through') {
                throw new Error(String(j.message || 'cupnet_pass_through'));
            }
            return j;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * fetch из контекста вкладки — трафик идёт через Chromium proxy; tabId для MITM — Proxy-Authorization на CONNECT.
     * session.fetch из main без вкладочного прокси; выход по IP см. check-ip-geo.
     */
    async function _fetchIpinfoJsonViaWebContents(wc, timeoutMs = networkPolicy.timeouts.ipGeoMs) {
        if (!wc || wc.isDestroyed()) throw new Error('webContents gone');
        const code = '(async () => {\n'
            + '  const r = await fetch(\'https://ipinfo.io/json\', { credentials: \'omit\', cache: \'no-store\' });\n'
            + '  if (!r.ok) throw new Error(\'HTTP \' + r.status);\n'
            + '  return await r.json();\n'
            + '})()';
        return await Promise.race([
            wc.executeJavaScript(code, true),
            new Promise((_, rej) => setTimeout(() => rej(new Error('ipinfo webContents timeout')), timeoutMs)),
        ]);
    }

    async function startMitmProxy() {
        if (d.getMitmProxy()) return d.getMitmProxy();
        const s = d.settingsStore.getCached() || d.loadSettings();
        const mitm = new d.MitmProxy({
            port: networkPolicy.mitmPort,
            browser: 'chrome_120',
            workerPath: d.pathModule.join(d.cupnetRoot, 'azure-tls-worker.js'),
            onRequestLogged: (entry) => {
                let tabId = entry.tabId ?? null;
                if (!tabId) {
                    const active = d.getTabManager()?.getActiveTab();
                    if (active) tabId = active.id;
                }
                const sessionId = entry.sessionId != null ? entry.sessionId : d.getCurrentSessionId();
                d.recordLatencySample(entry.duration);
                if (entry?.dnsOverride?.host && entry?.dnsOverride?.ip) {
                    const dOv = entry.dnsOverride;
                    const rw = dOv.rewriteHost ? ` Host:${dOv.rewriteHost}` : '';
                    d.broadcastDnsRuleMatched({
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
                    d.broadcastDnsRuleMatched({
                        ruleName: `${cm.pattern} -> ${cm.host} (CORS)`,
                        host: cm.host,
                        ip: '',
                        url: entry.url || '',
                        method: entry.method || 'GET',
                        tabId: tabId || null,
                        sessionId: sessionId ?? null,
                    });
                }

                const s2 = d.settingsStore.getCached() || d.loadSettings();
                const db = d.getDb();
                if (s2.traceMode && db) {
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
                            browser: s2.tlsProfile || 'chrome',
                            proxy: d.getPersistentAnonymizedProxyUrl() ? '(set)' : null,
                        };
                        const insertPromise = typeof db.insertTraceEntryQueued === 'function'
                            ? db.insertTraceEntryQueued(traceRow)
                            : db.insertTraceEntryAsync(traceRow);
                        insertPromise.then((traceId) => {
                            if (!traceId || d.getTraceWindows().length === 0) return;
                            const summary = { id: traceId, ts: traceRow.ts, method: entry.method, url: entry.url, status: entry.status, duration_ms: entry.duration };
                            for (const w of d.getTraceWindows()) {
                                if (!w.isDestroyed()) w.webContents.send('new-trace-entry', summary);
                            }
                        }).catch((err) => {
                            d.safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'insertTraceEntryQueued' } }, err);
                        });
                    } catch (e) { console.error('[trace] insert failed:', e.message); }
                }

                if (!d.getIsLoggingEnabled() || !db) return;
                // В MITM CDP иногда не даёт loadingFinished/getResponseBody — строка терялась. Пишем из MITM;
                // дубликат от CDP отсекается в cdp-network-logging (mitm-cdp-dedup).
                if (!tabId || sessionId == null) return;
                const reqId = entry.requestId;
                const seenIds = d.getSeenRequestIds();
                const lastKeys = d.getLastMitmLogKey();
                if (reqId) {
                    if (seenIds.has(reqId)) return;
                    seenIds.add(reqId);
                    if (seenIds.size > 5000) {
                        const iter = seenIds.values();
                        for (let i = 0; i < 2500; i++) iter.next();
                        const keep = new Set();
                        for (const v of iter) keep.add(v);
                        seenIds.clear();
                        for (const v of keep) seenIds.add(v);
                    }
                } else {
                    const dedupKey = `${sessionId}:${tabId}:${entry.url}:${entry.method}:${entry.status}`;
                    const now = Date.now();
                    const last = lastKeys.get(dedupKey);
                    if (last != null && now - last < d.MITM_DEDUP_MS) return;
                    lastKeys.set(dedupKey, now);
                    if (lastKeys.size > 500) {
                        const cutoff = now - 2000;
                        for (const k of lastKeys.keys()) {
                            if (lastKeys.get(k) < cutoff) lastKeys.delete(k);
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
                        request: { headers: entry.requestHeaders || {}, body: entry.requestBody || null },
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
                        d.incrementLogEntryCount();
                        try {
                            const { markMitmLogged } = require('./mitm-cdp-dedup');
                            markMitmLogged(tabId, logEntry.url, logEntry.method, logEntry.status);
                        } catch (_) { /* ignore */ }
                        d.broadcastLogEntryToViewers({ ...logEntry, tabId, sessionId: sessId });
                    }).catch((err) => {
                        console.error('[main] MITM log insert failed:', err?.message || err);
                    });
                } catch (e) {
                    console.error('[main] MITM log insert failed:', e.message);
                }
            },
        });
        d.setMitmProxy(mitm);
        mitm.setTlsPassthroughDomains(s?.trafficOpts?.tlsPassthroughDomains || ['challenges.cloudflare.com']);
        if (mitm?.worker) {
            mitm.worker.on('worker-exited', (ev) => {
                const sm = d.getStabilityMetrics();
                sm.gauges.workerRestarts = Number(ev?.restartCount) || sm.gauges.workerRestarts;
                d.emitStabilityEvent('warn', 'worker.exited', {
                    code: ev?.code ?? null,
                    restartInMs: ev?.delayMs ?? null,
                    restartCount: ev?.restartCount ?? null,
                });
            });
            mitm.worker.on('worker-ready', () => {
                d.emitStabilityEvent('info', 'worker.ready');
            });
            mitm.worker.on('worker-request-timeout', (ev) => {
                const sm = d.getStabilityMetrics();
                sm.counters.workerTimeouts++;
                d.emitStabilityEvent('warn', 'worker.request_timeout', {
                    timeoutMs: ev?.timeoutMs ?? null,
                    requestId: ev?.id || '',
                });
            });
            mitm.worker.on('worker-overloaded', (ev) => {
                const sm = d.getStabilityMetrics();
                sm.counters.workerOverloaded++;
                if (ev?.queueDepth != null) sm.gauges.queueDepth = ev.queueDepth;
                d.emitStabilityEvent('warn', 'worker.overloaded', ev || {});
            });
        }
        await mitm.start();
        console.log('[main] MITM proxy started on', mitm.getProxyUrl());
        return mitm;
    }

    async function netFetchWithTimeout(url, options = {}, timeoutMs = networkPolicy.timeouts.upstreamRequestMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            return await d.net.fetch(url, { ...options, signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    function _getSharedBrowserSession() {
        return d.session.fromPartition(CUPNET_SHARED_PARTITION);
    }

    /**
     * Сессия, в которой реально настроен прокси для браузера.
     * Вкладки используют persist:cg_*; setProxyAll не трогает persist:cupnet-shared — из‑за этого
     * старый check-ip-geo всегда видел DIRECT и «домашний» IP.
     */
    function _pickSessionForIpGeo() {
        const tm = d.getTabManager?.();
        if (tm) {
            const tryTab = (tab) => {
                if (!tab) return null;
                try {
                    if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
                        return tab.view.webContents.session;
                    }
                } catch (_) { /* ignore */ }
                return tab.tabSession || null;
            };
            const active = tm.getActiveTab?.();
            let s = tryTab(active);
            if (s) return s;
            for (const tab of tm.getAllTabs?.() || []) {
                s = tryTab(tab);
                if (s) return s;
            }
        }
        try {
            return d.session.fromPartition(DEFAULT_TAB_PARTITION);
        } catch (_) { /* ignore */ }
        return _getSharedBrowserSession();
    }

    function _resolveTabForIpGeo(tabIdHint) {
        const tm = d.getTabManager?.();
        if (!tm) return null;
        if (tabIdHint) {
            const t = tm.getTab(tabIdHint);
            if (t) return t;
        }
        const active = tm.getActiveTab?.();
        if (active) return active;
        for (const t of tm.getAllTabs?.() || []) {
            if (t) return t;
        }
        return null;
    }

    function _resolveContextForIpGeo(tabIdHint) {
        const tab = _resolveTabForIpGeo(tabIdHint);
        if (tab) {
            let targetSess = null;
            try {
                if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
                    targetSess = tab.view.webContents.session;
                }
            } catch (_) { /* ignore */ }
            if (!targetSess) targetSess = tab.tabSession;
            const targetPath = targetSess?.getStoragePath?.() ?? targetSess?.storagePath ?? '';
            return { tab, targetSess, targetPath };
        }
        const targetSess = _pickSessionForIpGeo();
        const targetPath = targetSess?.getStoragePath?.() ?? targetSess?.storagePath ?? '';
        return { tab: null, targetSess, targetPath };
    }

    function _checkIpGeoFlightKey(tabIdHint) {
        const { tab, targetPath } = _resolveContextForIpGeo(tabIdHint);
        const anon = d.getPersistentAnonymizedProxyUrl?.() || '';
        const mode = typeof d.getCurrentTrafficMode === 'function' ? d.getCurrentTrafficMode() : '';
        const tid = tab?.id || 'none';
        const pid = tab?.proxyProfileId ?? 'global';
        return `${anon}|${mode}|${targetPath}|${tid}|${pid}`;
    }

    async function getRealIp() {
        try {
            const sess = _pickSessionForIpGeo();
            const j = await _fetchIpinfoJsonViaSession(sess);
            return j.ip || 'unknown';
        } catch {
            try {
                const sess = _pickSessionForIpGeo();
                const j = await _loadJsonUrlThroughHiddenWindow(sess, 'https://ipinfo.io/json');
                return j.ip || 'unknown';
            } catch { return 'unknown'; }
        }
    }

    async function checkCurrentIpGeo(tabIdHint) {
        const fk = _checkIpGeoFlightKey(tabIdHint);
        const existing = _checkIpGeoInFlight.get(fk);
        if (existing) return existing;
        const p = checkCurrentIpGeoInternal(tabIdHint).finally(() => {
            if (_checkIpGeoInFlight.get(fk) === p) _checkIpGeoInFlight.delete(fk);
        });
        _checkIpGeoInFlight.set(fk, p);
        return p;
    }

    async function checkCurrentIpGeoInternal(tabIdHint) {
        const empty = { ip: 'unknown', city: '', region: '', country: '', country_name: '', org: '', timezone: '' };
        /** sysLog('info'|'warn') не пишет в stdout — дублируем в консоль для npm start */
        function ipGeoOut(level, msg) {
            const line = `[check-ip-geo] ${msg}`;
            if (level === 'warn') console.warn(line);
            else console.log(line);
            d.sysLog(level === 'warn' ? 'warn' : 'info', 'check-ip-geo', msg);
        }

        const { tab: geoTab, targetSess, targetPath } = _resolveContextForIpGeo(tabIdHint);
        const anon = d.getPersistentAnonymizedProxyUrl?.() || null;
        const mode = typeof d.getCurrentTrafficMode === 'function' ? d.getCurrentTrafficMode() : '(n/a)';
        const pathStr = targetPath || (targetSess?.storagePath ?? targetSess?.getStoragePath?.() ?? '');

        const cacheKey = `${anon || ''}|${mode}|${pathStr}|${geoTab?.id || 'none'}|${geoTab?.proxyProfileId ?? 'global'}`;
        const nowMs = Date.now();
        const cached = _ipGeoCache.value;
        if (
            cached &&
            _ipGeoCache.key === cacheKey &&
            nowMs - _ipGeoCache.at < IP_GEO_CACHE_MS &&
            cached.ip &&
            cached.ip !== 'unknown'
        ) {
            return { ...cached };
        }

        ipGeoOut('info', [
            `trafficMode=${mode}`,
            `anonLocal=${_maskUrlForLog(anon)}`,
            `ipGeoSessionPath=${pathStr}`,
            geoTab?.id ? `tabId=${geoTab.id}` : '',
            geoTab?.proxyProfileId != null ? `tabProxyProfileId=${geoTab.proxyProfileId}` : '',
        ].filter(Boolean).join(' '));

        try {
            await targetSess.forceReloadProxyConfig();
        } catch (e) {
            ipGeoOut('warn', `forceReloadProxyConfig: ${e?.message || e}`);
        }

        try {
            const rp = await targetSess.resolveProxy('https://ipinfo.io/json');
            ipGeoOut('info', `resolveProxy(https://ipinfo.io/json)=${rp}`);
        } catch (e) {
            ipGeoOut('warn', `resolveProxy failed: ${e?.message || e}`);
        }

        const mitmP = d.getMitmStartPromise?.();
        if (mitmP && typeof d.getMitmReady === 'function' && !d.getMitmReady()) {
            try {
                await mitmP;
            } catch (e) {
                ipGeoOut('warn', `wait mitm start: ${e?.message || e}`);
            }
        }

        function mapIpinfo(j) {
            if (j && j.error === 'cupnet_pass_through') {
                throw new Error(String(j.message || 'cupnet_pass_through'));
            }
            if (!j?.ip) throw new Error('no ip');
            return {
                ip: j.ip,
                city: j.city || '',
                region: j.region || '',
                country: j.country || '',
                country_name: j.country || '',
                org: j.org || '',
                timezone: j.timezone || '',
            };
        }

        function rememberGeoOk(result) {
            if (result?.ip && result.ip !== 'unknown') {
                _ipGeoCache = { key: cacheKey, at: Date.now(), value: { ...result } };
            }
        }

        const wcGeo = geoTab?.view?.webContents;
        if (geoTab && wcGeo && !wcGeo.isDestroyed()) {
            try {
                const j = await _fetchIpinfoJsonViaWebContents(wcGeo);
                const result = mapIpinfo(j);
                ipGeoOut('info', `ok via=webContents.fetch source=ipinfo.io ip=${result.ip}`);
                _lastIpGeoError = '';
                rememberGeoOk(result);
                return result;
            } catch (e) {
                ipGeoOut('warn', `webContents.fetch ipinfo failed: ${e?.message || e}`);
            }
        }

        try {
            const j = await _fetchIpinfoJsonViaSession(targetSess);
            const result = mapIpinfo(j);
            ipGeoOut('info', `ok via=session.fetch source=ipinfo.io ip=${result.ip}`);
            _lastIpGeoError = '';
            rememberGeoOk(result);
            return result;
        } catch (e) {
            ipGeoOut('warn', `session.fetch ipinfo failed: ${e?.message || e}`);
        }

        try {
            const j = await _loadJsonUrlThroughHiddenWindow(targetSess, 'https://ipinfo.io/json');
            const result = mapIpinfo(j);
            ipGeoOut('info', `ok via=hidden-window source=ipinfo.io ip=${result.ip}`);
            _lastIpGeoError = '';
            rememberGeoOk(result);
            return result;
        } catch (e) {
            ipGeoOut('warn', `hidden-window ipinfo failed: ${e?.message || e}`);
        }

        async function fetchWithTimeout(url, timeoutMs = networkPolicy.timeouts.ipGeoMs) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                return await targetSess.fetch(url, {
                    signal: ctrl.signal,
                    bypassCustomProtocolHandlers: true,
                });
            } finally {
                clearTimeout(timer);
            }
        }

        const sources = [
            { name: 'ipinfo-fetch', run: async () => {
                const r = await fetchWithTimeout('https://ipinfo.io/json');
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const j = await r.json();
                if (j && j.error === 'cupnet_pass_through') {
                    throw new Error(String(j.message || 'cupnet_pass_through'));
                }
                return mapIpinfo(j);
            }},
            { name: 'myip-fetch', run: async () => {
                const r = await fetchWithTimeout('https://api.myip.com');
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const j = await r.json();
                if (j && j.error === 'cupnet_pass_through') {
                    throw new Error(String(j.message || 'cupnet_pass_through'));
                }
                if (!j.ip) throw new Error('no ip');
                return { ip: j.ip, city: '', region: '', country: j.country || '', country_name: j.country || '', org: '', timezone: '' };
            }},
            { name: 'ipapi-fetch', run: async () => {
                const r = await fetchWithTimeout('https://ipapi.co/json/');
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const j = await r.json();
                if (j && j.error === 'cupnet_pass_through') {
                    throw new Error(String(j.message || 'cupnet_pass_through'));
                }
                if (!j.ip) throw new Error('no ip');
                return { ip: j.ip, city: j.city || '', region: j.region || '', country: j.country || '', country_name: j.country_name || j.country || '', org: j.org || '', timezone: j.timezone || '' };
            }},
            { name: 'ipify-fetch', run: async () => {
                const r = await fetchWithTimeout('https://api.ipify.org?format=json');
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const j = await r.json();
                if (j && j.error === 'cupnet_pass_through') {
                    throw new Error(String(j.message || 'cupnet_pass_through'));
                }
                if (!j.ip) throw new Error('no ip');
                return { ip: j.ip, city: '', region: '', country: '', country_name: '', org: '', timezone: '' };
            }},
        ];

        let lastErr = null;
        for (const { name, run } of sources) {
            try {
                const result = await run();
                if (result?.ip && result.ip !== 'unknown') {
                    ipGeoOut('info', `ok via=session.fetch source=${name} ip=${result.ip}`);
                    _lastIpGeoError = '';
                    rememberGeoOk(result);
                    return result;
                }
            } catch (e) {
                lastErr = e;
                ipGeoOut('warn', `fetch failed source=${name}: ${e?.message || e}`);
            }
        }
        const errMsg = lastErr?.message || String(lastErr);
        if (errMsg !== _lastIpGeoError) {
            ipGeoOut('warn', `all sources failed: ${errMsg}`);
            _lastIpGeoError = errMsg;
        }
        return empty;
    }

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
            const testSession = d.session.fromPartition(partition, { cache: false });
            await testSession.setProxy({ proxyRules: anonUrl, proxyBypassRules: '<local>' });
            testWin = new d.BrowserWindow({ show: false, webPreferences: { session: testSession } });
            const loadTimer = setTimeout(() => {
                try { testWin?.destroy(); } catch (err) {
                    d.safeCatch({ module: 'main', eventCode: 'proxy.test.failed', context: { stage: 'timeout-destroy' } }, err, 'info');
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
            try { await d.session.fromPartition(partition).clearStorageData(); } catch (e) { d.sysLog('warn', 'proxy', 'clearStorageData after proxy test failed: ' + (e?.message || e)); }
        }
    }

    async function _doQuickChangeProxy(proxyUrl) {
        sanitizeProxyUrl(proxyUrl);
        const masked = sanitizeProxyUrl._lastMasked || proxyUrl;
        console.log('[Proxy] Connecting:', masked);
        const cur = d.getPersistentAnonymizedProxyUrl();
        const oldPort = cur ? Number(new URL(cur).port) : undefined;
        try {
            if (cur) {
                await withTimeout(
                    ProxyChain.closeAnonymizedProxy(cur, true),
                    networkPolicy.timeouts.proxyOperationMs,
                    'Proxy close timeout'
                );
                await new Promise(r => setTimeout(r, 120));
            }
            d.setActProxy(masked);
            const next = oldPort
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
            d.setPersistentAnonymizedProxyUrl(next);
            return next;
        } catch (err) {
            const isBusy = err.code === 'EADDRINUSE';
            try {
                const next = isBusy && oldPort
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
                d.setPersistentAnonymizedProxyUrl(next);
                return next;
            } catch (e2) {
                d.dialog.showErrorBox('Proxy Error', e2.message);
                throw e2;
            }
        }
    }

    function quickChangeProxy(proxyUrl) {
        const next = _proxySwitchChain.then(() => _doQuickChangeProxy(proxyUrl));
        _proxySwitchChain = next.catch(() => {});
        return next;
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
            ? d.proxyResilience.orderCandidates(candidates)
            : candidates;
        let lastErr = null;
        for (let i = 0; i < ordered.length; i++) {
            const candidate = ordered[i];
            if (networkPolicy.featureFlags.proxyBreaker && !d.proxyResilience.canAttempt(candidate)) {
                d.emitStabilityEvent('warn', 'proxy.candidate_skipped', { candidate });
                continue;
            }
            try {
                const startedAt = Date.now();
                const anonymized = await quickChangeProxy(candidate);
                const latencyMs = Date.now() - startedAt;
                d.proxyResilience.registerSuccess(candidate, latencyMs);
                d.emitStabilityEvent('info', 'proxy.connect_success', { candidate, latencyMs, attempt: i + 1 });
                return { anonymized, used: candidate, attempts: i + 1 };
            } catch (e) {
                lastErr = e;
                const sm = d.getStabilityMetrics();
                sm.counters.proxyConnectFailed++;
                const res = d.proxyResilience.registerFailure(candidate, e);
                if (res?.event === 'quarantined') {
                    sm.counters.proxyQuarantined++;
                    d.emitStabilityEvent('warn', 'proxy.quarantined', {
                        candidate,
                        untilTs: res.quarantinedUntil,
                        consecutiveFailures: res.consecutiveFailures,
                    });
                }
                if (res?.event === 'circuit_opened') {
                    sm.counters.proxyCircuitOpened++;
                    d.emitStabilityEvent('warn', 'proxy.circuit_opened', {
                        candidate,
                        openUntilTs: res.openUntil,
                        errorRatePct: res.errorRatePct,
                    });
                }
                d.emitStabilityEvent('warn', 'proxy.connect_failed', {
                    candidate,
                    attempt: i + 1,
                    total: ordered.length,
                    error: e?.message || String(e),
                });
            }
        }
        throw (lastErr || new Error('All proxy candidates failed'));
    }

    return {
        startMitmProxy,
        netFetchWithTimeout,
        getRealIp,
        checkCurrentIpGeo,
        testProxy,
        quickChangeProxy,
        parseFallbackProxyList,
        connectProxyWithFailover,
    };
}

module.exports = { createProxyMitmService };
