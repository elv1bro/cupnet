'use strict';

const ProxyChain = require('proxy-chain');
const https = require('node:https');
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
    /** После полного провала источников — не бить MITM/worker подряд (типично при мёртвом прокси). */
    let _ipGeoFailCache = { key: '', at: 0 };
    const IP_GEO_CACHE_MS = envInt('CUPNET_IP_GEO_CACHE_MS', 60_000, 5_000, 600_000);
    const IP_GEO_FAIL_CACHE_MS = envInt('CUPNET_IP_GEO_FAIL_CACHE_MS', 45_000, 10_000, 600_000);

    function envInt(name, fallback, min, max) {
        const raw = process.env[name];
        if (raw == null || raw === '') return fallback;
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    /** Egress path key — без tab id: смена вкладки при том же прокси не должна дёргать ipinfo. */
    function _ipGeoEgressKey(geoTab, anon, mode, targetPath) {
        const pid = geoTab?.proxyProfileId ?? 'global';
        return `${anon || ''}|${mode}|${targetPath || ''}|${pid}`;
    }

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
        _trustSessionForMitm(targetSession);
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
        _trustSessionForMitm(sharedSess);
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
            onGatewayError: (info) => {
                const mw = d.getMainWindow?.();
                if (!mw || mw.isDestroyed()) return;
                const active = d.getTabManager()?.getActiveTab();
                if (info?.tabId != null && active && active.id !== info.tabId) return;
                try {
                    mw.webContents.send('page-gateway-error', info);
                } catch (_) { /* ignore */ }
            },
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

                const db = d.getDb();
                if (!d.getIsLoggingEnabled() || !db) return;
                // В MITM CDP иногда не даёт loadingFinished/getResponseBody — строка терялась. Пишем из MITM;
                // дубликат от CDP отсекается в cdp-network-logging (mitm-cdp-dedup).
                if (!tabId || sessionId == null) return;
                const cupnetRid = entry.cupnetRid || null;
                let ridClaimed = false;
                if (cupnetRid) {
                    try {
                        const { tryClaimRid } = require('./mitm-cdp-dedup');
                        const c = tryClaimRid(cupnetRid);
                        if (c === false) return;
                        if (c === true) ridClaimed = true;
                    } catch (_) { /* ignore */ }
                } else {
                    try {
                        const { shouldSkipMitmAsCdpDuplicate } = require('./mitm-cdp-dedup');
                        if (shouldSkipMitmAsCdpDuplicate(tabId, entry.url, entry.method, entry.status)) return;
                    } catch (_) { /* ignore */ }
                }
                const reqId = entry.requestId;
                const seenIds = d.getSeenRequestIds();
                const lastKeys = d.getLastMitmLogKey();
                if (!ridClaimed) {
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
                    // Sync before async insert: CDP shadow often has no X-CupNet-Rid in headers; finalizeLog may run
                    // before insertRequestAsync.then — legacy shouldSkipCdpShadowAsMitmDuplicate needs this key early.
                    try {
                        const { markMitmLogged } = require('./mitm-cdp-dedup');
                        markMitmLogged(tabId, logEntry.url, logEntry.method, logEntry.status);
                    } catch (_) { /* ignore */ }
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
                        d.broadcastLogEntryToViewers({ ...logEntry, tabId, sessionId: sessId });
                    }).catch((err) => {
                        if (ridClaimed && cupnetRid) {
                            try {
                                const { releaseRid } = require('./mitm-cdp-dedup');
                                releaseRid(cupnetRid);
                            } catch (_) { /* ignore */ }
                        }
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
        return _ipGeoEgressKey(tab, anon, mode, targetPath);
    }

    async function getRealIp() {
        const anon = d.getPersistentAnonymizedProxyUrl?.() || null;
        if (!anon) {
            try {
                const j = await _fetchIpinfoViaNodeDirect();
                return j.ip || 'unknown';
            } catch { /* fall through */ }
        } else {
            try {
                await _awaitWorkerReadyForIpGeo();
                const egress = _resolveEgressForIpGeo(null, anon);
                if (egress.proxy) {
                    const j = await _fetchIpinfoViaMitmWorker(egress);
                    return j.ip || 'unknown';
                }
            } catch { /* fall through to Chromium */ }
        }
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

    function clearIpGeoFailCache() {
        _ipGeoFailCache = { key: '', at: 0 };
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

    /** Node https — true direct egress, bypasses Chromium MITM/proxy stack. */
    async function _fetchIpinfoViaNodeDirect(timeoutMs = networkPolicy.timeouts.ipGeoMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                req.destroy();
                reject(new Error('ipinfo node https timeout'));
            }, timeoutMs);
            const req = https.get('https://ipinfo.io/json', {
                headers: { Accept: 'application/json', 'User-Agent': 'CupNet' },
            }, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    clearTimeout(timer);
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    clearTimeout(timer);
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });
        });
    }

    function _resolveEgressForIpGeo(geoTab, anon) {
        const mitm = d.getMitmProxy?.();
        const tabId = geoTab?.id || undefined;
        const settings = d.settingsStore?.getCached?.() || d.loadSettings?.() || {};
        const defaultBrowser = settings.tlsProfile || 'chrome';
        if (mitm && typeof mitm._resolveUpstreamForTab === 'function') {
            const up = mitm._resolveUpstreamForTab(tabId);
            return {
                proxy: up.proxy || anon || null,
                browser: up.browser || defaultBrowser,
                ja3: up.ja3 || undefined,
                tabId,
            };
        }
        return {
            proxy: anon || null,
            browser: defaultBrowser,
            ja3: undefined,
            tabId,
        };
    }

    /** AzureTLS worker — same egress path as MITM upstream (reliable with proxy). */
    async function _fetchIpinfoViaMitmWorker(egress, timeoutMs = networkPolicy.timeouts.ipGeoMs) {
        const mitm = d.getMitmProxy?.();
        const worker = mitm?.worker;
        if (!worker) throw new Error('mitm worker missing');
        if (!worker.ready) {
            await worker.waitReady(Math.max(timeoutMs, 15_000));
        }
        const proxyTimeout = Math.max(timeoutMs, 20_000);
        const res = await worker.request({
            method: 'GET',
            url: 'https://ipinfo.io/json',
            headers: { Accept: 'application/json' },
            proxy: egress.proxy || undefined,
            browser: egress.browser || 'chrome',
            ja3: egress.ja3 || undefined,
            tabId: egress.tabId != null ? String(egress.tabId) : undefined,
            disableRedirects: true,
            timeout: proxyTimeout,
        });
        if (res?.error) throw new Error(String(res.error));
        const status = Number(res.statusCode) || 0;
        if (status >= 400) throw new Error(`HTTP ${status}`);
        let body = '';
        if (res.bodyBase64) {
            body = Buffer.from(res.bodyBase64, 'base64').toString('utf8');
        } else if (typeof res.body === 'string') {
            body = res.body;
        }
        if (!body) throw new Error('empty ipinfo body');
        const j = JSON.parse(body);
        if (j && j.error === 'cupnet_pass_through') {
            throw new Error(String(j.message || 'cupnet_pass_through'));
        }
        return j;
    }

    async function _awaitWorkerReadyForIpGeo(timeoutMs = networkPolicy.timeouts.ipGeoMs) {
        const mitm = d.getMitmProxy?.();
        const worker = mitm?.worker;
        if (!worker) return;
        if (worker.ready) return;
        await worker.waitReady(Math.max(timeoutMs, 15_000));
    }

    function _trustSessionForMitm(sess) {
        if (!sess) return;
        try {
            sess.setCertificateVerifyProc((_, callback) => callback(0));
        } catch { /* ignore */ }
    }

    /** @deprecated net.fetch inherits defaultSession MITM proxy without reliable trust */
    async function _fetchIpinfoViaNet(timeoutMs = networkPolicy.timeouts.ipGeoMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await d.net.fetch('https://ipinfo.io/json', { signal: ctrl.signal });
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

    async function _awaitMitmEgressReady(ipGeoOut) {
        const deadline = Date.now() + 30_000;
        while (typeof d.getMitmReady === 'function' && !d.getMitmReady() && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (typeof d.getMitmReady === 'function' && !d.getMitmReady()) {
            ipGeoOut('warn', 'mitm not ready after wait — continuing anyway');
        }
        const mitm = d.getMitmProxy?.();
        if (mitm?.worker && !mitm.worker.ready) {
            try {
                await mitm.worker.waitReady(Math.max(networkPolicy.timeouts.ipGeoMs, 15_000));
            } catch (e) {
                ipGeoOut('warn', `wait worker ready: ${e?.message || e}`);
            }
        }
        try {
            d.getTabManager?.()?.reapplyMitmTrustToSharedSession?.();
        } catch (e) {
            ipGeoOut('warn', `reapplyMitmTrust: ${e?.message || e}`);
        }
        // Let Chromium settle proxy + cert verify proc after startup setProxy bursts.
        await new Promise((r) => setTimeout(r, 450));
    }

    function _isAbortError(err) {
        const msg = String(err?.message || err || '').toLowerCase();
        return msg.includes('aborted') || err?.name === 'AbortError';
    }

    async function _retryOnAbort(run, attempts = 3) {
        let lastErr = null;
        for (let i = 0; i < attempts; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 250 * i));
            try {
                return await run();
            } catch (e) {
                lastErr = e;
                if (!_isAbortError(e) || i >= attempts - 1) throw e;
            }
        }
        throw lastErr;
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

        const cacheKey = _ipGeoEgressKey(geoTab, anon, mode, pathStr);
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
                _ipGeoFailCache = { key: '', at: 0 };
            }
        }

        // No upstream proxy: Node direct HTTPS first — avoids Chromium MITM/cert races at startup.
        if (!anon) {
            try {
                const j = await _fetchIpinfoViaNodeDirect();
                const result = mapIpinfo(j);
                ipGeoOut('info', `ok via=node.https source=ipinfo.io ip=${result.ip}`);
                _lastIpGeoError = '';
                rememberGeoOk(result);
                return result;
            } catch (e) {
                ipGeoOut('warn', `node.https ipinfo failed: ${e?.message || e}`);
            }
        } else {
            // Proxy connected: AzureTLS worker (same path as MITM upstream), not Chromium fetch.
            try {
                await _awaitWorkerReadyForIpGeo();
                const egress = _resolveEgressForIpGeo(geoTab, anon);
                if (egress.proxy) {
                    const j = await _fetchIpinfoViaMitmWorker(egress);
                    const result = mapIpinfo(j);
                    ipGeoOut('info', `ok via=worker source=ipinfo.io ip=${result.ip}`);
                    _lastIpGeoError = '';
                    rememberGeoOk(result);
                    return result;
                }
            } catch (e) {
                ipGeoOut('warn', `worker ipinfo failed: ${e?.message || e}`);
            }
        }

        if (
            _ipGeoFailCache.key === cacheKey &&
            nowMs - _ipGeoFailCache.at < IP_GEO_FAIL_CACHE_MS
        ) {
            return { ...empty };
        }

        ipGeoOut('info', [
            `trafficMode=${mode}`,
            `anonLocal=${_maskUrlForLog(anon)}`,
            `ipGeoSessionPath=${pathStr}`,
            geoTab?.id ? `tabId=${geoTab.id}` : '',
            geoTab?.proxyProfileId != null ? `tabProxyProfileId=${geoTab.proxyProfileId}` : '',
        ].filter(Boolean).join(' '));

        _trustSessionForMitm(targetSess);
        await _awaitMitmEgressReady(ipGeoOut);
        _trustSessionForMitm(targetSess);

        try {
            const rp = await targetSess.resolveProxy('https://ipinfo.io/json');
            ipGeoOut('info', `resolveProxy(https://ipinfo.io/json)=${rp}`);
        } catch (e) {
            ipGeoOut('warn', `resolveProxy failed: ${e?.message || e}`);
        }

        const wcGeo = geoTab?.view?.webContents;
        if (geoTab && wcGeo && !wcGeo.isDestroyed()) {
            try {
                const j = await _retryOnAbort(() => _fetchIpinfoJsonViaWebContents(wcGeo));
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
            const j = await _retryOnAbort(() => _fetchIpinfoJsonViaSession(targetSess));
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

        // One lightweight fallback — avoid hammering MITM with 4+ geo services per UI refresh.
        const sources = [
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
                const result = await _retryOnAbort(run);
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
        _ipGeoFailCache = { key: cacheKey, at: Date.now() };
        return empty;
    }

    async function testProxy(upstreamProxyUrl, options = {}) {
        let anonUrl = null;
        let testWin = null;
        const partition = `proxy-test-${Date.now()}`;
        const primaryCheckUrl = options.checkUrl || 'https://ipinfo.io/json';
        const checkUrls = [primaryCheckUrl];
        if (primaryCheckUrl !== 'https://ipinfo.io/json') {
            checkUrls.push('https://ipinfo.io/json');
        }
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
            let usedCheckUrl = checkUrls[0];
            let lastErr = null;
            try {
                for (const checkUrl of checkUrls) {
                    try {
                        await testWin.loadURL(checkUrl);
                        text = await testWin.webContents.executeJavaScript('document.body.innerText');
                        usedCheckUrl = checkUrl;
                        lastErr = null;
                        break;
                    } catch (err) {
                        lastErr = err;
                        const msg = err?.message || String(err);
                        const retriable = /ERR_TUNNEL|ERR_PROXY|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(msg);
                        if (!retriable || checkUrl === checkUrls[checkUrls.length - 1]) throw err;
                    }
                }
                if (lastErr) throw lastErr;
            } finally {
                clearTimeout(loadTimer);
            }
            const data = parseProxyCheckResponse(text, usedCheckUrl);
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

    function parseProxyCheckResponse(text, checkUrl) {
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error('Invalid JSON response');
        }
        const url = String(checkUrl || '').toLowerCase();
        if (url.includes('ip.oxylabs.io')) {
            const ip = data.ip || data.query;
            let country = data.country || data.country_code || data.countryCode;
            let city = data.city;
            if (!country && data.providers && typeof data.providers === 'object') {
                for (const prov of Object.values(data.providers)) {
                    if (prov?.country || prov?.country_code) {
                        country = prov.country || prov.country_code;
                        city = city || prov.city;
                        break;
                    }
                }
            }
            if (!ip) throw new Error('Incomplete response');
            return { ip, country: country || '', city: city || '', org: data.org || data.isp || '' };
        }
        if (!data.ip || !data.country) throw new Error('Incomplete response');
        return { ip: data.ip, country: data.country, city: data.city || '', org: data.org || '' };
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
        // Mask credentials before anything is written to stability logs. The raw `candidate`
        // is still used for resilience tracking (health keyed by real URL) and the actual connect.
        const maskForLog = (url) => { sanitizeProxyUrl(url); return sanitizeProxyUrl._lastMasked || String(url); };
        for (let i = 0; i < ordered.length; i++) {
            const candidate = ordered[i];
            const candidateMasked = maskForLog(candidate);
            if (networkPolicy.featureFlags.proxyBreaker && !d.proxyResilience.canAttempt(candidate)) {
                d.emitStabilityEvent('warn', 'proxy.candidate_skipped', { candidate: candidateMasked });
                continue;
            }
            try {
                const startedAt = Date.now();
                const anonymized = await quickChangeProxy(candidate);
                const latencyMs = Date.now() - startedAt;
                d.proxyResilience.registerSuccess(candidate, latencyMs);
                d.emitStabilityEvent('info', 'proxy.connect_success', { candidate: candidateMasked, latencyMs, attempt: i + 1 });
                return { anonymized, used: candidate, attempts: i + 1 };
            } catch (e) {
                lastErr = e;
                const sm = d.getStabilityMetrics();
                sm.counters.proxyConnectFailed++;
                const res = d.proxyResilience.registerFailure(candidate, e);
                if (res?.event === 'quarantined') {
                    sm.counters.proxyQuarantined++;
                    d.emitStabilityEvent('warn', 'proxy.quarantined', {
                        candidate: candidateMasked,
                        untilTs: res.quarantinedUntil,
                        consecutiveFailures: res.consecutiveFailures,
                    });
                }
                if (res?.event === 'circuit_opened') {
                    sm.counters.proxyCircuitOpened++;
                    d.emitStabilityEvent('warn', 'proxy.circuit_opened', {
                        candidate: candidateMasked,
                        openUntilTs: res.openUntil,
                        errorRatePct: res.errorRatePct,
                    });
                }
                d.emitStabilityEvent('warn', 'proxy.connect_failed', {
                    candidate: candidateMasked,
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
        clearIpGeoFailCache,
        testProxy,
        quickChangeProxy,
        parseFallbackProxyList,
        connectProxyWithFailover,
    };
}

module.exports = { createProxyMitmService };
