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

// One client per (browser+proxy) key (cached)
const clients = new Map();
const clientLru = [];

function touchClientKey(key) {
    const idx = clientLru.indexOf(key);
    if (idx !== -1) clientLru.splice(idx, 1);
    clientLru.push(key);
}

function evictClientsIfNeeded() {
    while (clientLru.length > networkPolicy.concurrency.workerClientCacheMax) {
        const evictKey = clientLru.shift();
        const client = clients.get(evictKey);
        if (client) {
            try { client.close(); } catch (err) {
                safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.client.close_failed', context: { key: evictKey } }, err);
            }
            clients.delete(evictKey);
        }
    }
}

function getClient(browser, proxy) {
    const profileName = browser || 'chrome';
    const key = `${profileName}::${proxy || ''}`;
    if (!clients.has(key)) {
        const c = new AzureTLSClient({
            browser: profileName,
            proxy:   proxy || null,
            debug:   false,
        });
        // Apply HTTP/2 fingerprint for this profile
        const profile = BROWSER_PROFILES[profileName];
        if (profile && profile.http2) {
            try { c.applyHTTP2Fingerprint(profile.http2); } catch (e) {
                process.stderr.write(`[worker] HTTP/2 apply error for ${profileName}: ${e.message}\n`);
            }
        }
        clients.set(key, c);
    }
    touchClientKey(key);
    evictClientsIfNeeded();
    return clients.get(key);
}

process.stdin.setEncoding('utf8');
let buf = '';

process.stdin.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
        if (!line.trim()) continue;
        handleLine(line);
    }
});

process.stdin.on('end', () => {
    for (const c of clients.values()) {
        try { c.close(); } catch (err) {
            safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.client.close_failed', context: { op: 'stdin_end' } }, err);
        }
    }
    clientLru.length = 0;
    process.exit(0);
});

async function handleLine(line) {
    let req;
    try { req = JSON.parse(line); } catch {
        send({ id: null, error: 'Invalid JSON' });
        return;
    }

    const { id, method, url, headers, orderedHeaders, body, bodyBase64, proxy, browser, ja3, disableRedirects, forceHttp1 } = req;

    // Control commands
    if (id === '__clear_sessions__') {
        for (const c of clients.values()) {
            try { c.close(); } catch (err) {
                safeCatch({ module: 'azure-tls-worker', eventCode: 'worker.client.close_failed', context: { op: 'clear_sessions' } }, err);
            }
        }
        clients.clear();
        clientLru.length = 0;
        send({ id: '__clear_sessions__', status: 'ok', cleared: true });
        return;
    }

    if (id === '__get_profiles__') {
        send({ id: '__get_profiles__', profiles: BROWSER_PROFILES });
        return;
    }

    try {
        const client = getClient(browser, proxy);

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
            forceHttp1:       forceHttp1 === true,
        };
        if (WORKER_VERBOSE) {
            process.stderr.write(`[worker-dbg] request: disableRedirects=${disableRedirects} forceHttp1=${!!opts.forceHttp1} url=${url}\n`);
        }
        debugLog(req, opts);

        const result = await client.request(opts);

        if (WORKER_VERBOSE) process.stderr.write(`[worker-dbg] response: status=${result.statusCode} url=${url} error=${result.error||''}\n`);
        if (WORKER_VERBOSE && result.headers) {
            const setCookie = result.headers['set-cookie'] || result.headers['Set-Cookie'] || '';
            const location  = result.headers['location']  || result.headers['Location']  || '';
            if (setCookie || location || result.statusCode >= 300) {
                process.stderr.write(`[worker-dbg]   set-cookie=${setCookie} location=${location}\n`);
            }
        }

        send({ id, statusCode: result.statusCode, bodyBase64: result.bodyBase64 || '', headers: result.headers, error: result.error || null });
    } catch (e) {
        send({ id, statusCode: 0, body: null, headers: {}, error: e.message });
    }
}

function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

// Signal ready
send({ id: '__init__', status: 'ready' });
