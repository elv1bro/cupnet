#!/usr/bin/env node
'use strict';

/**
 * AzureTLS Worker — runs as a child process under Electron.
 * Communicates via newline-delimited JSON on stdin/stdout.
 *
 * Protocol:
 *   stdin  ← { id, method, url, headers, body, proxy, browser, ja3 }
 *   stdout → { id, statusCode, body, headers, error }
 *
 * Control commands:
 *   { id: '__clear_sessions__' }  → close all cached sessions
 *   { id: '__get_profiles__' }    → return list of available profiles
 */

const path = require('path');
const { networkPolicy } = require('./network-policy');
const { safeCatch } = require('./sys-log');

// Redirect all console.log → stderr so stdout stays clean JSON-only
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');

const MITM_DEBUG = process.env.CUPNET_MITM_DEBUG === '1';
const WORKER_VERBOSE = process.env.CUPNET_WORKER_VERBOSE === '1';
/** Optional one-line operational logs to stderr (HTTP/2 vs HTTP/1.1 fallback, attempts). Set CUPNET_AZURETLS_LOG=1 */
const AZURE_OP_LOG =
    process.env.CUPNET_AZURETLS_LOG === '1' ||
    String(process.env.CUPNET_AZURETLS_LOG || '').toLowerCase() === 'true';

function trimOpUrl(u, max = 140) {
    const s = String(u || '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function opLog(line) {
    if (!AZURE_OP_LOG) return;
    process.stderr.write(`[azure-worker] op ${line}\n`);
}
function headerMap(orderedHeaders) {
    const m = {};
    for (const [k, v] of (orderedHeaders || [])) m[k.toLowerCase()] = v;
    return m;
}
function debugLog(req, opts) {
    if (!MITM_DEBUG) return;
    const h = req.headers || headerMap(req.orderedHeaders);
    const ct = (h['content-type'] || h['Content-Type'] || '').slice(0, 60);
    const cl = h['content-length'] || h['Content-Length'] || '-';
    const ce = h['content-encoding'] || h['Content-Encoding'] || '-';
    const bodyInfo = opts.body_base64
        ? `base64 ${opts.body_base64.length} chars → ~${Math.round(opts.body_base64.length * 3 / 4)} bytes`
        : opts.body ? `string ${opts.body.length} chars` : 'none';
    const oh = (req.orderedHeaders || []).map(([k]) => k).join(', ');
    process.stderr.write(`[mitm-debug] ${req.method || 'GET'} ${req.url}\n`);
    process.stderr.write(`[mitm-debug]   Content-Type: ${ct} | Content-Length: ${cl} | Content-Encoding: ${ce}\n`);
    process.stderr.write(`[mitm-debug]   body: ${bodyInfo}\n`);
    process.stderr.write(`[mitm-debug]   orderedHeaders: [${oh}]\n`);
    if (opts.body && typeof opts.body === 'string' && opts.body.length < 600) {
        process.stderr.write(`[mitm-debug]   body preview: ${JSON.stringify(opts.body.slice(0, 300))}\n`);
    } else if (opts.body_base64 && opts.body_base64.length < 200) {
        try {
            const decoded = Buffer.from(opts.body_base64, 'base64');
            process.stderr.write(`[mitm-debug]   decoded preview (hex): ${decoded.slice(0, 32).toString('hex')}\n`);
        } catch (err) {
            safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.decode.failed', context: { op: 'body_base64_preview' } }, err);
        }
    }
}

const AzureTLSClient = require(path.join(__dirname, './azuretls/azureTLS.js'));

// ── Combined browser profiles: TLS + HTTP/2 + User-Agent ─────────────────────
const BROWSER_PROFILES = {
    chrome: {
        browser:   'chrome',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        http2:     '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
        desc:      'Chrome 133 (Windows)',
    },
    firefox: {
        browser:   'firefox',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
        http2:     '1:65536;4:131072;5:16384|65536|0|m,p,s,a',
        desc:      'Firefox 138 (Windows)',
    },
    safari: {
        browser:   'safari',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
        http2:     '1:65536;4:4194304;6:65535|10485760|0|m,s,a,p',
        desc:      'Safari 18 (macOS)',
    },
    ios: {
        browser:   'ios',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
        http2:     '1:65536;4:4194304;6:65535|10485760|0|m,s,a,p',
        desc:      'iOS 18 (Mobile Safari)',
    },
    edge: {
        browser:   'edge',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0',
        http2:     '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
        desc:      'Edge 133 (Windows)',
    },
    opera: {
        browser:   'opera',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 OPR/119.0.0.0',
        http2:     '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
        desc:      'Opera 119 (Windows)',
    },
};

/**
 * Имена вроде chrome_120 (дефолт mitm-proxy) не совпадают с ключами BROWSER_PROFILES.
 * Без applyHTTP2Fingerprint Cloudflare/антиботы видят несогласованный H2 — как в azure-tls-inprocess.js.
 */
function http2FingerprintForBrowser(browser) {
    const b = browser || 'chrome';
    if (BROWSER_PROFILES[b]?.http2) return BROWSER_PROFILES[b].http2;
    if (String(b).startsWith('chrome')) return BROWSER_PROFILES.chrome.http2;
    if (String(b).startsWith('firefox')) return BROWSER_PROFILES.firefox.http2;
    if (String(b).startsWith('safari')) return BROWSER_PROFILES.safari.http2;
    if (String(b).startsWith('edge')) return BROWSER_PROFILES.edge.http2;
    if (String(b).startsWith('opera')) return BROWSER_PROFILES.opera.http2;
    if (String(b).startsWith('ios')) return BROWSER_PROFILES.ios.http2;
    return BROWSER_PROFILES.chrome.http2;
}

/**
 * Pool AzureTLSClient by (browser+proxy+ja3+tabId). Parallel requests need multiple clients per key.
 * tabId must be part of the key: reusing the same native client across tabs leaked HTTP state
 * (e.g. cookies on reused connections) while Electron cookie jars stayed per-partition.
 */
const BORROW_ABORT = Symbol('cupnet.worker.borrow_abort');
const pools = new Map();
const poolLru = [];
const IDLE_CLIENT_TTL_MS = 25_000;
const poolLastActivity = new Map();

function touchPoolKey(key) {
    const idx = poolLru.indexOf(key);
    if (idx !== -1) poolLru.splice(idx, 1);
    poolLru.push(key);
    poolLastActivity.set(key, Date.now());
}

function createAzureClient(profileName, proxy) {
    const c = new AzureTLSClient({
        browser: profileName,
        proxy:   proxy || null,
        debug:   false,
    });
    const h2 = http2FingerprintForBrowser(profileName);
    if (h2) {
        try { c.applyHTTP2Fingerprint(h2); } catch (e) {
            process.stderr.write(`[worker] HTTP/2 apply error for ${profileName}: ${e.message}\n`);
        }
    }
    return c;
}

function evictPoolsIfNeeded() {
    while (poolLru.length > networkPolicy.concurrency.workerClientCacheMax) {
        const evictKey = poolLru[0];
        const pool = pools.get(evictKey);
        if (pool && pool.inUse === 0 && pool.waiters.length === 0) {
            for (const c of pool.idle) {
                try { c.close(); } catch (err) {
                    safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.client.close_failed', context: { key: evictKey } }, err);
                }
            }
            pool.idle.length = 0;
            pools.delete(evictKey);
            poolLastActivity.delete(evictKey);
            poolLru.shift();
        } else {
            break;
        }
    }
}

function evictIdleClients() {
    const now = Date.now();
    for (const [key, pool] of pools) {
        if (pool.inUse > 0 || pool.waiters.length > 0) continue;
        const lastActive = poolLastActivity.get(key) || 0;
        if (now - lastActive < IDLE_CLIENT_TTL_MS) continue;
        for (const c of pool.idle) {
            try { c.close(); } catch (_) {}
        }
        pool.idle.length = 0;
        pools.delete(key);
        poolLastActivity.delete(key);
        const idx = poolLru.indexOf(key);
        if (idx !== -1) poolLru.splice(idx, 1);
    }
}

setInterval(evictIdleClients, 10_000).unref();

function poolJa3Segment(ja3) {
    const s = ja3 != null ? String(ja3).trim() : '';
    return s ? `j:${s}` : 't';
}

async function borrowClient(browser, proxy, ja3, tabId) {
    const profileName = browser || 'chrome';
    const tabSeg =
        tabId != null && String(tabId).trim() !== ''
            ? `tab:${String(tabId)}`
            : 'tab:__shared__';
    const key = `${profileName}::${proxy || ''}::${poolJa3Segment(ja3)}::${tabSeg}`;
    const max = networkPolicy.concurrency.workerFfiConcurrency;
    touchPoolKey(key);
    let pool = pools.get(key);
    if (!pool) {
        pool = { idle: [], waiters: [], inUse: 0 };
        pools.set(key, pool);
    }
    evictPoolsIfNeeded();

    for (;;) {
        if (pool.idle.length) {
            const c = pool.idle.pop();
            pool.inUse++;
            return { client: c, key };
        }
        if (pool.inUse < max) {
            pool.inUse++;
            return { client: createAzureClient(profileName, proxy), key };
        }
        const c = await new Promise((resolve) => pool.waiters.push(resolve));
        if (c === BORROW_ABORT) throw new Error('worker clearing');
        return { client: c, key };
    }
}

function releaseClient(key, client) {
    const pool = pools.get(key);
    if (!pool) {
        try { client.close(); } catch (err) {
            safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.client.close_failed', context: { key } }, err);
        }
        return;
    }
    if (pool.waiters.length) {
        const resolve = pool.waiters.shift();
        resolve(client);
    } else {
        pool.inUse--;
        pool.idle.push(client);
    }
}

function closeAllPoolClients() {
    for (const pool of pools.values()) {
        for (const resolve of pool.waiters.splice(0)) {
            try { resolve(BORROW_ABORT); } catch (err) {
                safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.pool.waiter_failed', context: { op: 'closeAllPoolClients' } }, err);
            }
        }
        for (const c of pool.idle) {
            try { c.close(); } catch (err) {
                safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.client.close_failed', context: { op: 'closeAllPoolClients' } }, err);
            }
        }
        pool.idle.length = 0;
        pool.inUse = 0;
    }
    pools.clear();
    poolLru.length = 0;
    poolLastActivity.clear();
}

let awaitClear = false;
const clearDoneWaiters = [];
let httpInflight = 0;
const zeroInflightWaiters = [];

async function waitIfClearing() {
    if (!awaitClear) return;
    await new Promise((r) => clearDoneWaiters.push(r));
}

function finishClearing() {
    awaitClear = false;
    for (const r of clearDoneWaiters.splice(0)) r();
}

async function waitZeroInflight() {
    if (httpInflight === 0) return;
    await new Promise((r) => zeroInflightWaiters.push(r));
}

function decHttpInflight() {
    httpInflight--;
    if (httpInflight === 0) {
        for (const r of zeroInflightWaiters.splice(0)) r();
    }
}

async function gracefulWorkerExit() {
    if (awaitClear) return;
    awaitClear = true;
    try {
        await waitZeroInflight();
    } catch (_) { /* ignore */ }
    closeAllPoolClients();
    finishClearing();
    process.exit(0);
}

/** Exit when parent CupNet/Electron dies so orphaned workers do not spin forever. */
function startParentWatchdog() {
    if (process.env.CUPNET_WORKER_NO_WATCHDOG === '1') return;
    const parentPid = process.ppid;
    if (!parentPid || parentPid <= 1) return;

    const tick = setInterval(() => {
        if (process.ppid === 1) {
            clearInterval(tick);
            gracefulWorkerExit();
            return;
        }
        try {
            process.kill(parentPid, 0);
        } catch {
            clearInterval(tick);
            gracefulWorkerExit();
        }
    }, 5000);
    if (tick.unref) tick.unref();
}

startParentWatchdog();

process.stdin.setEncoding('utf8');
let buf = '';

function enqueueLine(line) {
    handleLine(line).catch((err) => {
        safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.queue.failed', context: { op: 'enqueueLine' } }, err);
        let req;
        try { req = JSON.parse(line); } catch { return; }
        const rid = req?.id;
        if (rid != null && rid !== '__clear_sessions__' && rid !== '__get_profiles__') {
            send({ id: rid, statusCode: 0, bodyBase64: '', headers: {}, error: err?.message || String(err) });
        }
    });
}

process.stdin.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
        if (!line.trim()) continue;
        enqueueLine(line);
    }
});

process.stdin.on('end', async () => {
    awaitClear = true;
    await waitZeroInflight();
    closeAllPoolClients();
    finishClearing();
    process.exit(0);
});

async function handleLine(line) {
    let req;
    try { req = JSON.parse(line); } catch {
        send({ id: null, error: 'Invalid JSON' });
        return;
    }

    const { id, method, url, headers, orderedHeaders, body, bodyBase64, proxy, browser, ja3, disableRedirects, forceHttp1, tabId, maxRetries } = req;

    // Control commands
    if (id === '__clear_sessions__') {
        awaitClear = true;
        await waitZeroInflight();
        closeAllPoolClients();
        finishClearing();
        send({ id: '__clear_sessions__', status: 'ok', cleared: true });
        return;
    }

    if (id === '__get_profiles__') {
        send({ id: '__get_profiles__', profiles: BROWSER_PROFILES });
        return;
    }

    await waitIfClearing();

    const retryLimit = Number(maxRetries) || 0;
    const isIdempotent = /^(GET|HEAD|OPTIONS)$/i.test(method || 'GET');
    const CONNECTION_ERRORS = /\bEOF\b|connection reset|ECONNRESET|ETIMEDOUT|ECONNREFUSED|broken pipe/i;

    let lastError = null;
    let hadConnError = false;
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
        let poolKey;
        let client;
        const effectiveForceHttp1 = forceHttp1 === true;
        try {
            ({ client, key: poolKey } = await borrowClient(browser, proxy, ja3, tabId));
            httpInflight++;

            if (ja3) {
                try { client.applyJA3(ja3); } catch (err) {
                    safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.ja3.apply_failed', context: { browser: browser || 'chrome' } }, err);
                }
            }

            const opts = {
                method:           method  || 'GET',
                url,
                headers:          headers || undefined,
                orderedHeaders:   orderedHeaders || undefined,
                body:             bodyBase64 ? undefined : (body || undefined),
                body_base64:      bodyBase64 || undefined,
                proxy:            proxy   || undefined,
                timeout:          networkPolicy.timeouts.upstreamRequestMs,
                maxRetries:       0,
                disableRedirects: disableRedirects === true,
                maxRedirects:     disableRedirects === true ? 0 : undefined,
                forceHttp1:       effectiveForceHttp1,
            };
            if (WORKER_VERBOSE) {
                process.stderr.write(`[worker-dbg] request: disableRedirects=${disableRedirects} forceHttp1=${!!opts.forceHttp1} url=${url}\n`);
            }
            debugLog(req, opts);

            if (AZURE_OP_LOG) {
                opLog(
                    `start ${method || 'GET'} ${effectiveForceHttp1 ? 'http1.1' : 'h2'} attempt=${attempt + 1}/${retryLimit + 1} tab=${tabId || '-'} url=${trimOpUrl(url)}`
                );
            }

            const result = await client.request(opts);

            if (WORKER_VERBOSE) process.stderr.write(`[worker-dbg] response: status=${result.statusCode} url=${url} error=${result.error||''}\n`);
            if (WORKER_VERBOSE && result.headers) {
                const setCookie = result.headers['set-cookie'] || result.headers['Set-Cookie'] || '';
                const location  = result.headers['location']  || result.headers['Location']  || '';
                if (setCookie || location || result.statusCode >= 300) {
                    process.stderr.write(`[worker-dbg]   set-cookie=${setCookie} location=${location}\n`);
                }
            }

            const hasConnError = result.error && CONNECTION_ERRORS.test(result.error);
            if (hasConnError && isIdempotent) {
                console.error(`[azure-worker] conn_err ${result.error} — fresh-client retry`);
                try { client.close(); } catch (_) {}
                const pool = pools.get(poolKey);
                if (pool) pool.inUse = Math.max(0, pool.inUse - 1);
                client = null;
                decHttpInflight();

                // Step A: fresh client with original orderedHeaders (UA now guaranteed by MITM)
                const freshClient = createAzureClient(browser || 'chrome', proxy);
                const _brT0 = Date.now();
                try {
                    const freshRes = await freshClient.request({
                        method: method || 'GET', url, maxRetries: 0,
                        timeout: networkPolicy.timeouts.upstreamRequestMs,
                        headers:        headers || undefined,
                        orderedHeaders: orderedHeaders || undefined,
                        disableRedirects: disableRedirects === true,
                        maxRedirects:     disableRedirects === true ? 0 : undefined,
                    });
                    send({ id, statusCode: freshRes.statusCode, bodyBase64: freshRes.bodyBase64 || '', headers: freshRes.headers, error: freshRes.error || null });
                    releaseClient(poolKey, freshClient);
                    return;
                } catch (retryErr) {
                    try { freshClient.close(); } catch (_) {}
                }

                // Step B: bare request (session defaults) as last resort
                const bareClient = createAzureClient(browser || 'chrome', proxy);
                const _brT1 = Date.now();
                try {
                    const bareRes = await bareClient.request({
                        method: method || 'GET', url, maxRetries: 0,
                        timeout: networkPolicy.timeouts.upstreamRequestMs,
                        disableRedirects: disableRedirects === true,
                        maxRedirects:     disableRedirects === true ? 0 : undefined,
                    });
                    send({ id, statusCode: bareRes.statusCode, bodyBase64: bareRes.bodyBase64 || '', headers: bareRes.headers, error: bareRes.error || null });
                    try { bareClient.close(); } catch (_) {}
                    return;
                } catch (bareErr) {
                    try { bareClient.close(); } catch (_) {}
                    send({ id, statusCode: 0, body: null, headers: {}, error: bareErr.message });
                    return;
                }
            }

            if (AZURE_OP_LOG) {
                opLog(
                    `done status=${result.statusCode || 0} err=${result.error || '-'} ${effectiveForceHttp1 ? 'http1.1' : 'h2'} url=${trimOpUrl(url)}`
                );
            }

            send({ id, statusCode: result.statusCode, bodyBase64: result.bodyBase64 || '', headers: result.headers, error: result.error || null });
            releaseClient(poolKey, client);
            client = null;
            decHttpInflight();
            return;
        } catch (e) {
            lastError = e;
            const isConnErr = CONNECTION_ERRORS.test(e.message || '');
            if (isConnErr && isIdempotent) {
                console.error(`[azure-worker] exc ${e.message} — fresh-client retry`);
                if (client) {
                    try { client.close(); } catch (_) {}
                    const pool = pools.get(poolKey);
                    if (pool) pool.inUse = Math.max(0, pool.inUse - 1);
                }
                decHttpInflight();

                // Step A: fresh client with original orderedHeaders (UA now guaranteed by MITM)
                const freshClient = createAzureClient(browser || 'chrome', proxy);
                const _brT0e = Date.now();
                try {
                    const freshRes = await freshClient.request({
                        method: method || 'GET', url, maxRetries: 0,
                        timeout: networkPolicy.timeouts.upstreamRequestMs,
                        headers:        headers || undefined,
                        orderedHeaders: orderedHeaders || undefined,
                        disableRedirects: disableRedirects === true,
                        maxRedirects:     disableRedirects === true ? 0 : undefined,
                    });
                    send({ id, statusCode: freshRes.statusCode, bodyBase64: freshRes.bodyBase64 || '', headers: freshRes.headers, error: freshRes.error || null });
                    releaseClient(poolKey, freshClient);
                    return;
                } catch (retryErr) {
                    try { freshClient.close(); } catch (_) {}
                }

                // Step B: bare request (session defaults) as last resort
                const bareClient = createAzureClient(browser || 'chrome', proxy);
                const _brT1e = Date.now();
                try {
                    const bareRes = await bareClient.request({
                        method: method || 'GET', url, maxRetries: 0,
                        timeout: networkPolicy.timeouts.upstreamRequestMs,
                        disableRedirects: disableRedirects === true,
                        maxRedirects:     disableRedirects === true ? 0 : undefined,
                    });
                    send({ id, statusCode: bareRes.statusCode, bodyBase64: bareRes.bodyBase64 || '', headers: bareRes.headers, error: bareRes.error || null });
                    try { bareClient.close(); } catch (_) {}
                    return;
                } catch (bareErr) {
                    try { bareClient.close(); } catch (_) {}
                    send({ id, statusCode: 0, body: null, headers: {}, error: bareErr.message });
                    return;
                }
            }
            send({ id, statusCode: 0, body: null, headers: {}, error: e.message });
            if (client && poolKey) releaseClient(poolKey, client);
            decHttpInflight();
            return;
        }
    }
    send({ id, statusCode: 0, body: null, headers: {}, error: lastError?.message || 'Retry exhausted' });
}

function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

// Signal ready
send({ id: '__init__', status: 'ready' });
