'use strict';

/**
 * CupNet MITM Proxy
 *
 * Architecture:
 *   Chromium (--proxy-server=127.0.0.1:PORT)
 *     ↓  HTTP/HTTPS upstream → AzureTLS via Go worker binary (azuretls-go/bin/azuretls-worker-*).
 *        Upstream TLS always goes through the Go worker binary (the legacy Node/FFI worker was removed).
 *     ↓  HTTPS CONNECT → MITM:
 *         1. Accept CONNECT, reply 200
 *         2. Terminate Chromium's TLS with fake domain cert (Electron trusts it)
 *         3. Re-make the real request to destination via AzureTLS worker
 *         4. Stream response back to Chromium
 *
 * All outbound requests go through AzureTLS (TLS fingerprint = Chrome/Firefox profile).
 * Supports upstream proxy chaining.
 *
 * Outbound User-Agent / client hints: rewritten in _doRequest from the active browser identity
 * (identity-headers.js applyIdentityToOutboundHeaders; engine mode = sanitize only via
 * user-agent-utils) before the worker — not via Chromium session.
 */

const net              = require('net');
const tls              = require('tls');
const https            = require('https');
const http             = require('http');
const { EventEmitter } = require('events');
const { safeCatch } = require('./sys-log');
const { networkPolicy, computeBackoffMs } = require('./network-policy');
const { connectThroughProxy } = require('./upstream-tunnel');
const {
    buildMitmGatewayErrorResponse,
    isLikelyDocumentNavigation,
    summarizeMitmGatewayError,
    resolveMitmGatewayDnsContext,
} = require('./mitm-gateway-error');
const { absolutizeMitmRedirectResponse } = require('./utils');

/**
 * Native Node.js HTTPS fallback when Go azureTLS library fails with connection errors.
 * No TLS fingerprinting, but reliable connection handling.
 */
function _nativeHttpsFallback(url, method, headers, orderedHeaders, body, bodyBase64, timeout, connectTo) {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const finalHeaders = {};
    if (orderedHeaders && Array.isArray(orderedHeaders)) {
        for (const [k, v] of orderedHeaders) finalHeaders[k] = v;
    } else if (headers) {
        Object.assign(finalHeaders, headers);
    }
    delete finalHeaders[':method'];
    delete finalHeaders[':path'];
    delete finalHeaders[':authority'];
    delete finalHeaders[':scheme'];
    // DNS override (dial mode): connect to the IP, keep the hostname for SNI and Host.
    if (connectTo && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'host')) finalHeaders.Host = parsed.host;

    return new Promise((resolve, reject) => {
        const reqOpts = {
            hostname: connectTo || parsed.hostname,
            ...(connectTo && isHttps ? { servername: parsed.hostname } : {}),
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname + parsed.search,
            method:   method || 'GET',
            headers:  finalHeaders,
            rejectUnauthorized: false,
            timeout:  timeout || networkPolicy.timeouts.upstreamRequestMs,
        };
        const req = mod.request(reqOpts, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers:    res.headers,
                    bodyBase64: Buffer.concat(chunks).toString('base64'),
                });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Native fallback timeout')));
        if (bodyBase64) req.write(Buffer.from(bodyBase64, 'base64'));
        else if (body) req.write(body);
        req.end();
    });
}
const { applyIdentityToOutboundHeaders } = require('./identity-headers');
const { relayWebSocket } = require('./ws-frames');
const { ClientHintsCache } = require('./client-hints-cache');

/** Reserved host served by the MITM itself (identity self-check page); never resolved or dialed. */
const IDENTITY_CHECK_HOST = 'identity-check.cupnet';
function _isIdentityCheckUrl(url) {
    try { return new URL(String(url || '')).hostname.toLowerCase() === IDENTITY_CHECK_HOST; } catch { return false; }
}
function _maskUpstreamForEcho(proxy) {
    if (!proxy) return null;
    try {
        const u = new URL(String(proxy));
        return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
    } catch { return 'configured'; }
}
const {
    generateCA,
    generateCAAsync,
    loadOrGenerateCA,
    getFakeCert,
    getFakeCertAsync,
    getCACertPem,
} = require('./mitm-ca');

/**
 * Strip internal CupNet request id before upstream; value is used for MITM vs CDP log dedup.
 * @returns {{ cupnetRid: string|null, headers: object, orderedHeaders: Array<[string,string]> }}
 */
function _stripCupnetRidFromParsedRequest(headers, orderedHeaders) {
    let cupnetRid = null;
    if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === 'x-cupnet-rid') {
                cupnetRid = String(headers[k] || '').trim() || null;
                delete headers[k];
                break;
            }
        }
    }
    let oh = orderedHeaders;
    if (Array.isArray(orderedHeaders)) {
        oh = orderedHeaders.filter(([k]) => String(k).toLowerCase() !== 'x-cupnet-rid');
    }
    return { cupnetRid, headers, orderedHeaders: oh };
}

/** tab-manager sets X-CupNet-Rid to `${tabId}_${uuid}`; derive tabId when CONNECT has no Proxy-Authorization. */
function _tabIdFromCupnetRid(rid) {
    const s = String(rid || '').trim();
    if (!s) return null;
    const m = s.match(/^(.*)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return m ? m[1] : null;
}

// ── AzureTLS worker pool ──────────────────────────────────────────────────────

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Апстрим TLS обслуживает единственный бэкенд — вынесенный Go worker-процесс
 * (azuretls-go/bin/azuretls-worker-*), общающийся по NDJSON через stdio.
 * Legacy Node/ffi worker удалён.
 */
function createMitmAzureBackend() {
    return new AzureTLSWorker();
}

function _parseDebugMitm() {
    const v = process.env.CUPNET_DEBUG_MITM;
    if (v === undefined || v === '') return 1;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 1;
}
let debugMitmLevel = _parseDebugMitm();

function getDebugMitmLevel() {
    return debugMitmLevel;
}

/** @param {number|string} n уровень 0–4; синхронизирует process.env.CUPNET_DEBUG_MITM */
function setDebugMitmLevel(n) {
    let v = typeof n === 'number' ? n : parseInt(String(n), 10);
    if (!Number.isFinite(v)) v = 1;
    v = Math.max(0, Math.min(4, Math.floor(v)));
    debugMitmLevel = v;
    process.env.CUPNET_DEBUG_MITM = String(v);
    return debugMitmLevel;
}

function dbg(msg) { if (debugMitmLevel >= 1) process.stderr.write(msg); }

/** stderr + префикс [mitm] → во вкладку MITM в System Console (stdout даёт только «System»). */
function mitmUserLog(chunk) {
    const raw = Array.isArray(chunk) ? chunk.join('\n') : String(chunk);
    for (const line of raw.split('\n')) {
        if (line === '') continue;
        process.stderr.write(`[mitm] ${line}\n`);
    }
}

/** Метка клиентского TCP-порта — в логе видно, что два одинаковых URL это разные соединения браузера. */
function _clientTag(socket) {
    const p = socket && socket.remotePort;
    return typeof p === 'number' && p > 0 ? ` (:${p})` : '';
}

function _fmtHeaders(h) {
    if (!h || typeof h !== 'object') return '';
    const lines = [];
    for (const [k, v] of Object.entries(h)) lines.push(`  ${k}: ${v}`);
    return lines.join('\n') + '\n';
}
function _fmtBody(body, bodyBase64, label, maxLen = 4096) {
    let text = body || null;
    if (!text && bodyBase64) {
        try { text = Buffer.from(bodyBase64, 'base64').toString('utf8'); } catch { text = `<base64 ${bodyBase64.length} chars>`; }
    }
    if (!text) return '';
    if (text.length > maxLen) text = text.slice(0, maxLen) + `\n  … (truncated, ${text.length} total)`;
    return `  [${label}]\n${text}\n`;
}


/**
 * Native Go upstream worker (azuretls-go): NDJSON protocol over stdio.
 * Built with `npm run build:go`. Packaged under `resources/azuretls-go/bin/` (see package.json extraResources).
 */
function _goWorkerBinaryName() {
    const arch = process.arch;
    const platform = process.platform;
    if (platform === 'darwin') {
        return arch === 'arm64' ? 'azuretls-worker-darwin-arm64' : 'azuretls-worker-darwin-amd64';
    }
    if (platform === 'linux') {
        return arch === 'arm64' ? 'azuretls-worker-linux-arm64' : 'azuretls-worker-linux-amd64';
    }
    if (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) {
        return 'azuretls-worker-win32-amd64.exe';
    }
    return null;
}

function _resolveGoWorkerBinary() {
    const name = _goWorkerBinaryName();
    if (!name) return null;
    const candidates = [];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'azuretls-go', 'bin', name));
    }
    candidates.push(path.join(__dirname, 'azuretls-go', 'bin', name));
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p;
        } catch { /* ignore */ }
    }
    return null;
}

/** True when the Go worker binary is available (the only supported upstream worker). */
function mitmPreferGoWorkerBinary() {
    return _resolveGoWorkerBinary() != null;
}

/**
 * Response streaming: eligible upstream bodies go to the client as they arrive (azuretls-go/stream.go)
 * instead of waiting for the whole body and shipping it base64 in one NDJSON line. On by default since
 * 2026-09-27; CUPNET_MITM_STREAM=0 is the kill switch (fully buffered path). Read when a worker starts,
 * so the stdout framing mode and the per-request mode of one worker always agree.
 */
function mitmStreamEnabled() {
    return process.env.CUPNET_MITM_STREAM !== '0';
}
/** Per-stream bytes queued toward the browser before the worker is asked to pause the upstream read. */
const STREAM_HIGH_WATER = 1024 * 1024;
const STREAM_LOW_WATER = 256 * 1024;
/**
 * Largest response body kept in the request log (buffered and streamed alike); bigger bodies are
 * logged without a body instead of being base64'd in memory and truncated by the DB.
 */
const LOG_BODY_MAX_BYTES = (() => {
    const n = parseInt(process.env.CUPNET_LOG_BODY_MAX_BYTES || '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 10 * 1024 * 1024;
})();

/** CUPNET_LOG_MEDIA_BODIES=1 logs video/audio bodies too (CupNet mini: "write everything"). */
const LOG_MEDIA_BODIES = process.env.CUPNET_LOG_MEDIA_BODIES === '1';

/** Media streams (video/audio) are huge and practically never inspected — keep them out of the log. */
function _isMediaContentType(ct) {
    if (LOG_MEDIA_BODIES) return false;
    return /^\s*(video|audio)\//i.test(String(ct || ''));
}

/**
 * Incremental decoder for the Go worker's stdout: NDJSON lines, where a line carrying `"chunk": N`
 * is followed by exactly N raw body bytes (streaming frames). Handles frames split at any byte.
 */
class WorkerFrameDecoder {
    /** @param {(hdr: object, body: Buffer|null) => void} onFrame */
    constructor(onFrame) {
        this._onFrame = onFrame;
        this._buf = null;
        this._pendingHdr = null;
        this._need = 0;
    }

    /** @param {Buffer} chunk */
    push(chunk) {
        this._buf = this._buf && this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
        for (;;) {
            if (this._pendingHdr) {
                if (this._buf.length < this._need) return;
                const body = this._buf.subarray(0, this._need);
                this._buf = this._buf.subarray(this._need);
                const hdr = this._pendingHdr;
                this._pendingHdr = null;
                this._need = 0;
                this._onFrame(hdr, body);
                continue;
            }
            const nl = this._buf.indexOf(0x0a);
            if (nl < 0) return;
            const line = this._buf.toString('utf8', 0, nl);
            this._buf = this._buf.subarray(nl + 1);
            if (!line.trim()) continue;
            let hdr;
            try { hdr = JSON.parse(line); } catch { continue; /* ignore malformed lines */ }
            const n = Number(hdr && hdr.chunk);
            if (Number.isInteger(n) && n > 0) {
                this._pendingHdr = hdr;
                this._need = n;
                continue;
            }
            this._onFrame(hdr, null);
        }
    }
}

/**
 * Body of one streamed upstream response. Chunks that arrive before a consumer attaches are queued
 * (the head frame resolves a promise, so the consumer only attaches a microtask later while chunk
 * frames of the same stdout read may already have been decoded).
 */
class WorkerBodyStream {
    constructor(worker, id, onFinish) {
        this._w = worker;
        this.id = id;
        this._onFinish = onFinish;
        this._queue = [];
        this._sink = null;
        this._paused = false;
        this.ended = false;
        this.error = null;
        this.bytes = 0;
    }

    _push(buf) {
        if (this.ended) return;
        this.bytes += buf.length;
        if (this._sink) this._sink.onData(buf);
        else this._queue.push(buf);
    }

    _end(err) {
        if (this.ended) return;
        this.ended = true;
        this.error = err ? String(err) : null;
        this._w._streams.delete(this.id);
        try { this._onFinish && this._onFinish(); } catch { /* ignore */ }
        if (this._sink) this._sink.onEnd(this.error);
    }

    /** @param {{ onData: (buf: Buffer) => void, onEnd: (err: string|null) => void }} sink */
    attach(sink) {
        this._sink = sink;
        const queued = this._queue;
        this._queue = [];
        for (const b of queued) sink.onData(b);
        if (this.ended) sink.onEnd(this.error);
    }

    pause() {
        if (this._paused || this.ended) return;
        this._paused = true;
        this._w.streamCtl(this.id, 'pause');
    }

    resume() {
        if (!this._paused || this.ended) return;
        this._paused = false;
        this._w.streamCtl(this.id, 'resume');
    }

    /** Stop the upstream download (browser went away / response no longer wanted). */
    cancel() {
        if (this.ended) return;
        this._w.streamCtl(this.id, 'cancel');
        this._end('cancelled');
    }
}

class AzureTLSWorker extends EventEmitter {
    constructor() {
        super();
        this.pending    = new Map();
        /** Live streamed response bodies by request id (CUPNET_MITM_STREAM). */
        this._streams   = new Map();
        this.ready      = false;
        this._stopped   = false;
        this._bufParts  = [];
        this._restartDelay = 1000;
        this._restartCount = 0;
        this._inflightRequests = 0;
        this._stdinQueue = [];
        this._stdinDraining = false;
        /** Set when Go binary is required but missing (Node FFI disabled). */
        this._fatalWorkerConfigError = null;
        this._start();
    }

    _start() {
        const env = {
            ...process.env,
            UV_THREADPOOL_SIZE: '32',
            NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || '',
        };

        const goBin = _resolveGoWorkerBinary();
        this._workerType = 'go';
        if (!goBin) {
            const expected = _goWorkerBinaryName() || '<platform-binary>';
            const msg =
                '[azure-worker] Upstream TLS requires the Go worker binary.\n' +
                '  Build: npm run build:go or npm run build:go:local\n' +
                `  Expected: azuretls-go/bin/${expected}`;
            console.error(msg);
            this._stopped = true;
            const err = new Error('AzureTLS: Go worker binary not found');
            this._fatalWorkerConfigError = err;
            process.nextTick(() => {
                try { this.emit('error', err); } catch (_) { /* ignore */ }
            });
            try {
                safeCatch(
                    { module: 'mitm-proxy', eventCode: 'azure.worker.go.missing', context: { expected } },
                    err,
                    'error',
                );
            } catch (_) { /* ignore */ }
            return;
        }
        const spawnExe = goBin;
        const spawnArgs = [];
        if (debugMitmLevel) {
            console.error(`[azure-worker] using Go upstream worker: ${goBin}`);
        }

        this.proc = spawn(spawnExe, spawnArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        this._stdinQueue = [];
        this._stdinDraining = false;

        this.proc.on('error', (err) => {
            const hint = err && err.code === 'ENOENT'
                ? ' No Go worker binary: run `npm run build:go` or add azuretls-go/bin to extraResources.'
                : '';
            console.error(`[azure-worker] spawn failed (${spawnExe}): ${err.message || err}.${hint}`);
            try {
                safeCatch(
                    {
                        module: 'mitm-proxy',
                        eventCode: 'worker.spawn.failed',
                        context: { spawnExe, workerKind: 'go' },
                    },
                    err,
                    'error',
                );
            } catch { /* ignore */ }
        });

        // Redirect worker stderr only in debug mode (very noisy in production)
        this.proc.stderr.on('data', d => { if (debugMitmLevel) process.stderr.write('[azure-worker] ' + d); });

        this._streaming = mitmStreamEnabled();
        if (this._streaming) {
            // Binary-safe framing: streamed bodies carry raw bytes after their header line.
            const decoder = new WorkerFrameDecoder((hdr, body) => this._onWorkerFrame(hdr, body));
            this.proc.stdout.on('data', chunk => decoder.push(chunk));
        } else {
            this.proc.stdout.setEncoding('utf8');
            this.proc.stdout.on('data', chunk => {
                this._bufParts.push(chunk);
                const joined = this._bufParts.join('');
                this._bufParts.length = 0;
                const lines = joined.split('\n');
                const remainder = lines.pop();
                if (remainder) this._bufParts.push(remainder);
                for (const line of lines) {
                    if (!line.trim()) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch { continue; /* ignore malformed lines */ }
                    this._onWorkerMessage(msg);
                }
            });
        }

        this.proc.on('exit', (code) => {
            this.ready = false;
            const queued = this._stdinQueue.splice(0, this._stdinQueue.length);
            for (const entry of queued) {
                try { entry.reject(new Error(`Worker exited (${code})`)); } catch (err) {
                    safeCatch({ module: 'mitm-proxy', eventCode: 'worker.callback.failed', context: { op: 'rejectPendingOnExit' } }, err);
                }
            }
            for (const [id, entry] of this.pending) {
                if (entry.timer) clearTimeout(entry.timer);
                const cb = typeof entry === 'function' ? entry : entry.cb;
                try { cb(new Error(`Worker exited (${code})`)); } catch (err) {
                    safeCatch({ module: 'mitm-proxy', eventCode: 'worker.callback.failed', context: { op: 'legacyCallbackOnExit' } }, err);
                }
            }
            this.pending.clear();
            for (const s of [...this._streams.values()]) s._end(`Worker exited (${code})`);
            this._streams.clear();
            this._inflightRequests = 0;
            if (this._stopped) return;
            const delay = this._restartDelay;
            this._restartDelay = Math.min(delay * 2, 30000);
            this._restartCount++;
            this.emit('worker-exited', { code, delayMs: delay, restartCount: this._restartCount });
            if (debugMitmLevel) console.error(`[azure-worker] exited (${code}), restart in ${delay}ms`);
            setTimeout(() => { if (!this._stopped) this._start(); }, delay);
        });
    }

    _drainStdinQueue() {
        if (this._stdinDraining) return;
        this._stdinDraining = true;
        const finish = () => { this._stdinDraining = false; };
        try {
            while (this._stdinQueue.length > 0) {
                if (!this.proc?.stdin?.writable) {
                    const err = new Error('Worker stdin not writable');
                    const queued = this._stdinQueue.splice(0, this._stdinQueue.length);
                    for (const q of queued) q.reject(err);
                    break;
                }
                const next = this._stdinQueue.shift();
                let ok = false;
                try {
                    ok = this.proc.stdin.write(next.payload);
                } catch (e) {
                    next.reject(e);
                    continue;
                }
                next.resolve();
                if (!ok) {
                    this.proc.stdin.once('drain', () => {
                        finish();
                        this._drainStdinQueue();
                    });
                    return;
                }
            }
        } finally {
            finish();
        }
    }

    /** One complete (non-chunk) message from the worker: ready signal or a reply to a pending id. */
    _onWorkerMessage(msg) {
        try {
            if (!msg) return;
            if (msg.id === '__init__') {
                this.ready = true;
                this._restartDelay = 1000;
                this.emit('worker-ready');
                this.emit('ready');
                return;
            }
            const entry = this.pending.get(msg.id);
            if (entry) {
                this.pending.delete(msg.id);
                const cb = typeof entry === 'function' ? entry : entry.cb;
                if (entry.timer) clearTimeout(entry.timer);
                cb(null, msg);
            }
        } catch { /* a failing callback must not take down the stdout reader */ }
    }

    /** Frame from the binary-safe decoder (CUPNET_MITM_STREAM): stream head / chunk / end or a message. */
    _onWorkerFrame(hdr, body) {
        if (!hdr) return;
        try {
            if (body) {
                const s = this._streams.get(hdr.id);
                if (s) s._push(body);
                return;
            }
            if (hdr.stream === 'head') {
                const entry = this.pending.get(hdr.id);
                if (entry && entry.onHead) {
                    this.pending.delete(hdr.id);
                    entry.onHead(hdr);
                } else {
                    // Nobody is waiting (timed out / gone) — stop the upstream download.
                    this.streamCtl(hdr.id, 'cancel');
                }
                return;
            }
            if (hdr.stream === 'end') {
                const s = this._streams.get(hdr.id);
                if (s) s._end(hdr.error || null);
                return;
            }
        } catch { /* a failing consumer must not take down the stdout reader */ }
        this._onWorkerMessage(hdr);
    }

    /** Send a per-stream control op (cancel / pause / resume) to the worker; best effort. */
    streamCtl(id, op) {
        if (!this.proc?.stdin?.writable) return;
        this._writeToWorker(JSON.stringify({ id: '__stream_ctl__', target: id, op }) + '\n').catch(() => {});
    }

    _writeToWorker(payload) {
        return new Promise((resolve, reject) => {
            if (this._stdinQueue.length >= networkPolicy.concurrency.workerStdinQueueMax) {
                this.emit('worker-overloaded', { reason: 'stdin_queue_overflow', queueDepth: this._stdinQueue.length });
                reject(new Error('Worker stdin queue overflow'));
                return;
            }
            this._stdinQueue.push({ payload, resolve, reject });
            this._drainStdinQueue();
        });
    }

    request(opts) {
        return new Promise((resolve, reject) => {
            if (!this.ready) return reject(new Error('Worker not ready'));
            if (this.pending.size >= networkPolicy.concurrency.workerMaxPending) {
                this.emit('worker-overloaded', { reason: 'pending_overflow', pending: this.pending.size });
                return reject(new Error('Worker pending overflow'));
            }
            if (this._inflightRequests >= networkPolicy.concurrency.workerMaxInflight) {
                this.emit('worker-overloaded', { reason: 'inflight_overflow', inflight: this._inflightRequests });
                return reject(new Error('Worker in-flight overflow'));
            }
            const id = `r_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this._inflightRequests = Math.max(0, this._inflightRequests - 1);
                this.emit('worker-request-timeout', { id, timeoutMs: networkPolicy.timeouts.workerRequestMs });
                reject(new Error(`Worker request timeout (${networkPolicy.timeouts.workerRequestMs}ms)`));
            }, networkPolicy.timeouts.workerRequestMs);
            this._inflightRequests++;
            this.pending.set(id, { timer, cb: (err, res) => {
                clearTimeout(timer);
                this._inflightRequests = Math.max(0, this._inflightRequests - 1);
                if (err) return reject(err);
                if (res.error) return reject(new Error(res.error));
                resolve(res);
            }});
            if (!this.proc?.stdin?.writable) {
                this.pending.delete(id);
                this._inflightRequests = Math.max(0, this._inflightRequests - 1);
                clearTimeout(timer);
                return reject(new Error('Worker stdin not writable'));
            }
            this._writeToWorker(JSON.stringify({ id, ...opts }) + '\n').catch((e) => {
                this.pending.delete(id);
                this._inflightRequests = Math.max(0, this._inflightRequests - 1);
                clearTimeout(timer);
                reject(e);
            });
        });
    }

    /**
     * Like request(), but asks the worker to stream the body. Resolves when headers arrive with
     * `{ statusCode, headers, stream }` (a WorkerBodyStream), or — if the worker fell back to the
     * buffered path (e.g. a connection-error retry) — with a normal `{ statusCode, headers, bodyBase64 }`.
     * The in-flight slot is held until the body ends.
     */
    requestStream(opts) {
        return new Promise((resolve, reject) => {
            if (!this.ready) return reject(new Error('Worker not ready'));
            if (this.pending.size >= networkPolicy.concurrency.workerMaxPending) {
                this.emit('worker-overloaded', { reason: 'pending_overflow', pending: this.pending.size });
                return reject(new Error('Worker pending overflow'));
            }
            if (this._inflightRequests >= networkPolicy.concurrency.workerMaxInflight) {
                this.emit('worker-overloaded', { reason: 'inflight_overflow', inflight: this._inflightRequests });
                return reject(new Error('Worker in-flight overflow'));
            }
            const id = `r_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            let released = false;
            const releaseSlot = () => {
                if (released) return;
                released = true;
                this._inflightRequests = Math.max(0, this._inflightRequests - 1);
            };
            const timer = setTimeout(() => {
                this.pending.delete(id);
                releaseSlot();
                this.streamCtl(id, 'cancel'); // headers may still arrive later — don't let it download
                this.emit('worker-request-timeout', { id, timeoutMs: networkPolicy.timeouts.workerRequestMs });
                reject(new Error(`Worker request timeout (${networkPolicy.timeouts.workerRequestMs}ms)`));
            }, networkPolicy.timeouts.workerRequestMs);
            this._inflightRequests++;
            this.pending.set(id, {
                timer,
                cb: (err, res) => { // buffered reply (fallback or error before headers)
                    clearTimeout(timer);
                    releaseSlot();
                    if (err) return reject(err);
                    if (res.error) return reject(new Error(res.error));
                    resolve(res);
                },
                onHead: (hdr) => {
                    clearTimeout(timer);
                    const stream = new WorkerBodyStream(this, id, releaseSlot);
                    this._streams.set(id, stream);
                    resolve({ statusCode: hdr.statusCode, headers: hdr.headers || {}, stream });
                },
            });
            if (!this.proc?.stdin?.writable) {
                this.pending.delete(id);
                releaseSlot();
                clearTimeout(timer);
                return reject(new Error('Worker stdin not writable'));
            }
            this._writeToWorker(JSON.stringify({ id, ...opts, stream: true }) + '\n').catch((e) => {
                this.pending.delete(id);
                releaseSlot();
                clearTimeout(timer);
                reject(e);
            });
        });
    }

    clearSessions() {
        return new Promise((resolve) => {
            if (!this.ready) return resolve(false);
            const id = '__clear_sessions__';
            const timer = setTimeout(() => { this.pending.delete(id); resolve(false); }, networkPolicy.timeouts.clearSessionsMs);
            this.pending.set(id, { timer, cb: (err) => { clearTimeout(timer); resolve(!err); } });
            if (this.proc?.stdin?.writable) this._writeToWorker(JSON.stringify({ id }) + '\n').catch(() => resolve(false));
            else resolve(false);
        });
    }

    shutdown() {
        this._stopped = true;
        this.ready = false;
        for (const [id, entry] of this.pending) {
            if (entry.timer) clearTimeout(entry.timer);
            const cb = typeof entry === 'function' ? entry : entry.cb;
            try { cb(new Error('Worker shutdown')); } catch (err) {
                safeCatch({ module: 'mitm-proxy', eventCode: 'worker.callback.failed', context: { op: 'legacyCallbackOnStop' } }, err);
            }
        }
        this.pending.clear();
        const proc = this.proc;
        this.proc = null;
        if (!proc) return;
        try {
            if (proc.stdin?.writable) proc.stdin.end();
        } catch (err) {
            safeCatch({ module: 'mitm-proxy', eventCode: 'worker.shutdown.failed', context: { op: 'stdin.end' } }, err);
        }
        const pid = proc.pid;
        try { proc.kill('SIGTERM'); } catch (err) {
            safeCatch({ module: 'mitm-proxy', eventCode: 'worker.shutdown.failed', context: { op: 'proc.kill' } }, err);
        }
        if (pid) {
            setTimeout(() => {
                try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already exited */ }
            }, 3000).unref?.();
        }
    }

    /**
     * @param {number} [timeoutMs] — packaged builds without `resources/cupnet-node` may hang in ffi;
     *   default 120s then reject with a actionable error.
     */
    waitReady(timeoutMs = 120_000) {
        if (this.ready) return Promise.resolve();
        if (this._fatalWorkerConfigError) return Promise.reject(this._fatalWorkerConfigError);
        return new Promise((resolve, reject) => {
            const onReady = () => {
                this.off('error', onErr);
                clearTimeout(timer);
                resolve();
            };
            const onErr = (e) => {
                this.off('ready', onReady);
                clearTimeout(timer);
                reject(e);
            };
            const timer = setTimeout(() => {
                this.off('ready', onReady);
                this.off('error', onErr);
                reject(new Error(
                    `AzureTLS worker did not become ready within ${timeoutMs}ms. `
                    + 'Ensure the Go worker binary exists (azuretls-go/bin/azuretls-worker-*): '
                    + 'run `npm run build:go` (or `build:go:local`), and that electron-builder '
                    + 'bundles `azuretls-go/bin` into extraResources.',
                ));
            }, timeoutMs);
            this.once('ready', onReady);
            this.once('error', onErr);
        });
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _headerVal(headers, name) {
    if (!headers) return '';
    const lc = name.toLowerCase();
    for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lc) {
            const v = headers[k];
            return Array.isArray(v) ? v[0] : String(v);
        }
    }
    return '';
}

/**
 * Chromium resourceType в MITM недоступен; CDP-строки с типом отбрасываются (см. cdp-network-logging shadow).
 * Подбираем тип под фильтры log-viewer (Document, Script, XHR, Fetch, …).
 */
function inferMitmResourceType(url, method, reqHeaders, resHeaders) {
    const m = String(method || 'GET').toUpperCase();
    if (m === 'OPTIONS') return 'Ping';

    let pathname = '';
    try {
        pathname = new URL(String(url || '')).pathname.toLowerCase();
    } catch { /* ignore */ }

    const ct = String(_headerVal(resHeaders, 'content-type') || '').toLowerCase().split(';')[0].trim();
    const accept = String(_headerVal(reqHeaders, 'accept') || '').toLowerCase();

    if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)(\?|$)/i.test(pathname)) return 'Image';
    if (/\.svg(\?|$)/i.test(pathname)) return 'Image';
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(pathname)) return 'Font';
    if (/\.css(\?|$)/i.test(pathname)) return 'Stylesheet';
    if (/\.(js|mjs|cjs)(\.map)?(\?|$)/i.test(pathname)) return 'Script';

    if (ct.includes('text/html')) return 'Document';
    if (ct.includes('text/css')) return 'Stylesheet';
    if (ct.includes('javascript') || ct.includes('ecmascript')) return 'Script';
    if (ct.startsWith('image/')) return 'Image';
    if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'Image';
    if (ct.includes('font') || ct.includes('woff')) return 'Font';
    if (ct.includes('application/json') || ct.endsWith('+json')) {
        return (m === 'GET' || m === 'HEAD') ? 'Fetch' : 'XHR';
    }

    if (accept.includes('text/html')) return 'Document';
    if (accept.includes('application/json')) return 'Fetch';

    if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') return 'XHR';

    return 'Fetch';
}

const _TEXT_CT = [
    'text/', 'application/json', 'application/javascript', 'application/ecmascript',
    'application/xml', 'application/xhtml', 'application/x-javascript',
    'application/ld+json', 'application/manifest+json', 'application/csp-report',
    'image/svg+xml',
];
function _isBinaryContentType(ct) {
    if (!ct) return false;
    const lc = ct.toLowerCase().split(';')[0].trim();
    if (lc.endsWith('+json') || lc.endsWith('+xml')) return false;
    for (const prefix of _TEXT_CT) {
        if (lc.startsWith(prefix) || lc.includes(prefix)) return false;
    }
    return true;
}

/**
 * Prepare request body for DB logging.
 * Binary bodies (multipart, gzip, binary CT) are stored with `__b64__:` prefix
 * so that the raw bytes survive TEXT column round-trip (same convention as response_body).
 */
function _reqBodyForLog(req) {
    if (req.body) return req.body;
    if (!req.bodyBase64) return null;
    const ct = (req.headers && (req.headers['content-type'] || '')) || '';
    if (_isBinaryContentType(ct) || ct.toLowerCase().startsWith('multipart/')) {
        return '__b64__:' + req.bodyBase64;
    }
    try { return Buffer.from(req.bodyBase64, 'base64').toString('utf8'); } catch { return '__b64__:' + req.bodyBase64; }
}

// ── MITM Proxy Server ─────────────────────────────────────────────────────────

// AzureTLS/Go sets these from actual body — passing browser values can cause Content-Length mismatch → 400
const SKIP_WHEN_BODY = ['content-length', 'transfer-encoding'];
const DEFAULT_TLS_PASSTHROUGH = ['challenges.cloudflare.com'];

function _matchHostPattern(pattern, hostname) {
    const p = String(pattern || '').trim().toLowerCase();
    const h = String(hostname || '').trim().toLowerCase();
    if (!p || !h) return false;
    if (p.startsWith('*.')) {
        const suffix = p.slice(2);
        return h === suffix || h.endsWith(`.${suffix}`);
    }
    return h === p;
}

function _sameHostname(a, b) {
    try { return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase(); } catch { return false; }
}

function _shouldAutoRetryHttp1(message) {
    const m = String(message || '').toLowerCase();
    return /upstream connect error|connection termination|reset reason|disconnect.*before headers|protocol_error|err_http2|http2.*error|stream error/i.test(m);
}

function _responseSuggestsHttp1Retry(res) {
    if (!res) return false;
    let body = '';
    try {
        body = res.bodyBase64 ? Buffer.from(res.bodyBase64, 'base64').toString('utf8').slice(0, 4096) : '';
    } catch { /* ignore */ }
    const hay = `${body}\n${res.error || ''}`;
    if (!_shouldAutoRetryHttp1(hay)) return false;
    const code = Number(res.statusCode);
    return !Number.isFinite(code) || code === 0 || code === 502 || code === 503 || code === 504;
}

class MitmProxy {
    constructor(opts = {}) {
        this.port       = opts.port != null ? opts.port : networkPolicy.mitmPort;
        this.browser    = opts.browser || 'chrome_120';
        this.upstream   = opts.upstream || null;
        /**
         * Fail-closed guard: when true, requests that would otherwise egress with no proxy
         * are refused (502) instead of leaking the real IP directly. Set only when a proxy
         * profile connect failed; cleared on any working upstream or intentional direct mode.
         */
        this._egressBlocked = false;
        this._egressBlockReason = '';
        this.onRequestLogged = opts.onRequestLogged || null;
        this.onGatewayError = opts.onGatewayError || null;
        // Optional embedder hooks (CupNet mini cookie manager): edit the outgoing request after identity
        // rewriting, and the response head before Chrome sees it. Both may mutate their arguments.
        this.onBeforeUpstream = opts.onBeforeUpstream || null;
        this.onResponseHead = opts.onResponseHead || null;
        /** Opt-in WebSocket tap: ({ requestId, url, tabId, requestHeaders, responseHeaders, relay }) after a 101. */
        this.onWebSocket = opts.onWebSocket || null;
        /**
         * Present the CupNet CA after the leaf in the TLS chain. Lets an external Chrome trust the MITM
         * via --ignore-certificate-errors-spki-list=<CA SPKI> (matched against any cert in the chain)
         * without installing the CA system-wide (CupNet mini).
         */
        this._sendCaChain = opts.sendCaChain === true;
        this.worker = createMitmAzureBackend();
        this._server    = null;
        this._activeJa3 = null;
        /**
         * Active browser identity for the wire (User-Agent, client hints, Accept-Language).
         * Resolved by browser-identity-catalog.resolveIdentity(); null = engine mode (sanitize only).
         * @type {import('./browser-identity-catalog').ResolvedIdentity|null}
         */
        this._identity = null;
        /** Accept-CH memory per origin (Chrome semantics) → high-entropy hints on later requests. */
        this._clientHintsCache = new ClientHintsCache();
        /** Global outbound HTTP version when connected profile sets force HTTP/1.1 */
        this.forceHttp1 = false;
        this._dnsOverrides = new Map();
        /** `*.suffix` overrides (setDnsOverrides wildcards option), longest suffix first. */
        this._dnsWildcards = [];
        /** Dial mode: keep the URL (SNI, Host, HTTP/2) and only connect to the override IP. */
        this._dnsDial = false;
        /** @type {string[]} паттерны хоста из DNS rules с mitm_inject_cors (exact или *.suffix, см. _matchHostPattern). */
        this._dnsCorsPatterns = [];
        /** When true, MITM injects CORS headers for all HTTPS responses (toolbar setting). */
        this._globalCorsEnabled = false;
        this._tlsPassthroughDomains = [...DEFAULT_TLS_PASSTHROUGH];

        // Per-tab upstream proxy overrides: tabId → { upstream, browser?, ja3? }
        this._tabProxyMap = new Map();

        // Detailed stats
        this.stats = {
            requests:  0,
            errors:    0,
            totalMs:   0,    // sum of response times
            minMs:     Infinity,
            maxMs:     0,
            // sliding window for req/s (last 60 ticks of 1s each)
            _window:   new Array(60).fill(0),
            _winIdx:   0,
            _winLast:  Date.now(),
            pending:   0,    // in-flight requests right now
        };

        // Tick the window every second
        this._statTimer = setInterval(() => {
            const now = Date.now();
            const elapsed = now - this.stats._winLast;
            if (elapsed >= 1000) {
                this.stats._winIdx = (this.stats._winIdx + 1) % 60;
                this.stats._window[this.stats._winIdx] = 0;
                this.stats._winLast = now;
            }
        }, 1000);
        if (this._statTimer.unref) this._statTimer.unref();
    }

    setUpstream(proxyUrl) {
        this.upstream = proxyUrl || null;
        // A working upstream means egress is routed again — lift any fail-closed block.
        if (this.upstream) this._egressBlocked = false;
    }

    /**
     * Fail-closed control. When blocked, MITM refuses to route requests that have no proxy
     * (global or per-tab) instead of falling back to direct egress.
     * @param {boolean} blocked
     * @param {string} [reason]
     */
    setEgressBlocked(blocked, reason = '') {
        this._egressBlocked = !!blocked;
        this._egressBlockReason = blocked ? String(reason || 'Proxy required but unavailable') : '';
    }

    isEgressBlocked() {
        return !!this._egressBlocked;
    }

    getEgressBlockReason() {
        return this._egressBlocked ? String(this._egressBlockReason || '') : '';
    }

    /** Force HTTP/1.1 for all upstream AzureTLS requests (global profile setting). */
    setForceHttp1(enabled) {
        this.forceHttp1 = !!enabled;
    }

    /**
     * Set the global wire identity (User-Agent + client hints + Accept-Language).
     * Pass null (or an identity without a User-Agent) to fall back to sanitize-only behaviour.
     * @param {import('./browser-identity-catalog').ResolvedIdentity|null} identity
     */
    setIdentity(identity) {
        this._identity = identity && identity.userAgent ? identity : null;
    }

    getIdentity() {
        return this._identity;
    }

    /** JSON echo of the outbound request (identity applied) for the built-in identity-check page. */
    _buildIdentityCheckResponse(opts, tabUpstream, url) {
        const headers = { ...(opts.headers || {}) };
        const ordered = Array.isArray(opts.orderedHeaders) ? opts.orderedHeaders.map((pair) => [...pair]) : null;
        applyIdentityToOutboundHeaders(headers, ordered, tabUpstream.identity, { url });
        const id = tabUpstream.identity || null;
        const payload = {
            ok: true,
            url,
            tabId: opts.tabId != null ? String(opts.tabId) : null,
            headers,
            ordered,
            identity: id ? {
                mode: id.mode || null,
                templateId: id.templateId || null,
                userAgent: id.userAgent || null,
                engineSynthesized: !!id.engineSynthesized,
                hasClientHints: !!id.clientHints,
                language: id.language || null,
                timezone: id.timezone || null,
            } : null,
            tls: {
                profile: tabUpstream.browser || this.browser || null,
                customJa3: !!tabUpstream.ja3,
                forceHttp1: !!tabUpstream.forceHttp1,
            },
            upstreamProxy: _maskUpstreamForEcho(tabUpstream.proxy),
            egressBlocked: !!this._egressBlocked,
            acceptChOrigins: this._clientHintsCache.size,
            ts: Date.now(),
        };
        const bodyBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
        return {
            statusCode: 200,
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'access-control-allow-origin': '*',
                'x-cupnet-identity-check': '1',
            },
            bodyBase64,
        };
    }

    /** Forget every origin's Accept-CH request (identity change, explicit reset). */
    clearClientHintsCache() {
        this._clientHintsCache.clear();
    }

    /** Global custom JA3 (null = template ClientHello of the current browser profile). */
    setActiveJa3(ja3) {
        this._activeJa3 = ja3 ? String(ja3) : null;
    }

    /**
     * Set per-tab upstream proxy override.
     * @param {string} tabId
     * @param {{ upstream: string|null, browser?: string, ja3?: string, forceHttp1?: boolean|null, identity?: object|null }} config
     */
    setTabUpstream(tabId, config) {
        if (!tabId) return;
        const prev = this._tabProxyMap.get(tabId);
        const identity = config.identity !== undefined
            ? (config.identity && config.identity.userAgent ? config.identity : null)
            : (prev ? prev.identity : null);
        this._tabProxyMap.set(tabId, {
            upstream: config.upstream || null,
            browser:  config.browser  || null,
            ja3:      config.ja3      || null,
            forceHttp1: config.forceHttp1 != null ? !!config.forceHttp1 : null,
            identity,
        });
    }

    /** Per-tab identity override without touching the tab's upstream proxy. */
    setTabIdentity(tabId, identity) {
        if (!tabId) return;
        const prev = this._tabProxyMap.get(tabId) || { upstream: null, browser: null, ja3: null, forceHttp1: null, identity: null };
        const next = identity && identity.userAgent ? identity : null;
        if (!next && !prev.upstream && !prev.browser && !prev.ja3 && prev.forceHttp1 == null) {
            this._tabProxyMap.delete(tabId);
            return;
        }
        this._tabProxyMap.set(tabId, { ...prev, identity: next });
    }

    removeTabUpstream(tabId) {
        this._tabProxyMap.delete(tabId);
    }

    _resolveUpstreamForTab(tabId) {
        const base = { proxy: this.upstream, browser: this.browser, ja3: this._activeJa3, forceHttp1: !!this.forceHttp1, identity: this._identity };
        if (!tabId) return base;
        const override = this._tabProxyMap.get(tabId);
        if (!override) return base;
        const forceHttp1 = override.forceHttp1 != null ? !!override.forceHttp1 : !!this.forceHttp1;
        return {
            proxy:   override.upstream ?? this.upstream,
            browser: override.browser  || this.browser,
            ja3:     override.ja3      || this._activeJa3,
            forceHttp1,
            identity: override.identity || this._identity,
        };
    }

    setTlsPassthroughDomains(domains = []) {
        const cleaned = Array.isArray(domains)
            ? domains
                .map((d) => String(d || '').trim().toLowerCase())
                .filter(Boolean)
            : [];
        this._tlsPassthroughDomains = cleaned.length ? cleaned : [...DEFAULT_TLS_PASSTHROUGH];
    }

    _shouldTlsPassthrough(hostname) {
        const host = String(hostname || '').toLowerCase();
        return this._tlsPassthroughDomains.some((p) => _matchHostPattern(p, host));
    }

    setBrowser(profile) {
        const next = profile || 'chrome_120';
        if (next !== this.browser) {
            this.browser = next;
            // Clear cached TLS sessions in the worker so the next request
            // does a fresh handshake with the new fingerprint profile
            this.worker.clearSessions().catch(() => {});
        }
    }

    /**
     * @param {Array<{ id?: string, host: string, ip?: string, enabled?: boolean, rewrite_host?: string, mitm_inject_cors?: boolean }>} rules
     * @param {{ dial?: boolean, wildcards?: boolean }} [o] - dial: connect to the IP but keep the URL
     *   (SNI, Host, HTTP/2 stay real; without it the URL host becomes the IP and HTTP/1.1 is forced);
     *   wildcards: `*.example.com` rules also override (otherwise they only select MITM CORS).
     */
    setDnsOverrides(rules = [], o = {}) {
        const next = new Map();
        const wild = [];
        const corsPatterns = [];
        for (const r of (rules || [])) {
            if (!r || r.enabled === false) continue;
            const host = String(r.host || '').trim().toLowerCase();
            const ip = String(r.ip || '').trim();
            if (!host) continue;
            const entry = { ip, rewriteHost: String(r.rewrite_host || '').trim() || null, id: r.id != null ? String(r.id) : undefined };
            if (ip && !host.startsWith('*.')) next.set(host, entry);
            else if (ip && o.wildcards) wild.push({ ...entry, pattern: host });
            if (r.mitm_inject_cors === true) corsPatterns.push(host);
        }
        this._dnsOverrides = next;
        this._dnsWildcards = wild.sort((a, b) => b.pattern.length - a.pattern.length);
        this._dnsDial = !!o.dial;
        this._dnsCorsPatterns = corsPatterns;
        if (corsPatterns.length || next.size || wild.length) {
            const rows = ['━━ DNS overrides · reload ━━', `  IP → ${next.size + wild.length} host(s)${this._dnsDial ? ' · dial' : ''}`];
            for (const [h, v] of [...next, ...wild.map((w) => [w.pattern, w])]) {
                const bits = [`${h} → ${v.ip}`];
                if (v.rewriteHost) bits.push(`Host: ${v.rewriteHost}`);
                rows.push(`    · ${bits.join(' · ')}`);
            }
            rows.push(
                `  MITM CORS: ${corsPatterns.length ? corsPatterns.join(', ') : '—'}`,
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
            );
            mitmUserLog(rows);
        }
        this.worker.clearSessions().catch(() => {});
    }

    setGlobalCorsEnabled(enabled) {
        this._globalCorsEnabled = !!enabled;
    }

    _mitmCorsEnabledForUrl(urlStr) {
        if (shouldSkipMitmCorsForUrl(urlStr)) return false;
        if (this._globalCorsEnabled) return true;
        let u;
        try { u = new URL(urlStr); } catch { return false; }
        const h = (u.hostname || '').toLowerCase();
        for (const p of this._dnsCorsPatterns) {
            if (_matchHostPattern(p, h)) return true;
        }
        return false;
    }

    /** @returns {{ host: string, pattern: string }|null} */
    _mitmCorsMatchDetail(urlStr) {
        if (shouldSkipMitmCorsForUrl(urlStr)) return null;
        let u;
        try { u = new URL(urlStr); } catch { return null; }
        const h = (u.hostname || '').toLowerCase();
        if (!h) return null;
        if (this._globalCorsEnabled) return { host: h, pattern: '*' };
        for (const p of this._dnsCorsPatterns) {
            if (_matchHostPattern(p, h)) return { host: h, pattern: p };
        }
        return null;
    }

    async start() {
        await this.worker.waitReady();

        this._server = net.createServer(socket => this._handleConnection(socket));
        await new Promise((res, rej) =>
            this._server.listen(this.port, '127.0.0.1', err => {
                if (!err) return res();
                if (err.code === 'EADDRINUSE') {
                    err.message = `MITM port 127.0.0.1:${this.port} is already in use (stale CupNet/Electron?). `
                        + 'Quit other CupNet instances or run: pkill -f "Electron.*cupnet2"';
                }
                rej(err);
            })
        );
        mitmUserLog(`Proxy listening 127.0.0.1:${this.port} · profile=${this.browser}`);
        return this;
    }

    stop() {
        if (this._statTimer) { clearInterval(this._statTimer); this._statTimer = null; }
        if (this._server) { this._server.close(); this._server = null; }
        if (this.worker) { this.worker.shutdown(); }
    }

    _handleConnection(socket) {
        dbg(`[mitm] TCP +${socket.remoteAddress}:${socket.remotePort}\n`);
        socket.setTimeout(networkPolicy.timeouts.upstreamRequestMs, () => socket.destroy());
        socket.once('data', data => {
            const head = data.toString('utf8', 0, 8192);
            if (head.startsWith('CONNECT ')) {
                const hostport = head.split('\r\n')[0].split(' ')[1] || '';
                dbg(`[mitm] CONNECT ${hostport}${_clientTag(socket)}\n`);
                this._handleConnect(socket, head, data);
            } else {
                this._readFullHttpRequestThenHandle(socket, data);
            }
        });
        socket.on('error', () => { try { socket.destroy(); } catch {} });
    }

    /**
     * Plain-HTTP requests can arrive with the body split across TCP segments. Accumulate until
     * headers + the full Content-Length body are buffered before dispatching; otherwise POST/PUT
     * bodies would be truncated or missing when they don't fit in the first segment.
     */
    _readFullHttpRequestThenHandle(socket, firstChunk) {
        const MAX_HTTP_REQ = 10 * 1024 * 1024;
        let buf = firstChunk;
        const contentLengthOf = (headerStr) => {
            for (const line of headerStr.split('\r\n')) {
                const idx = line.indexOf(':');
                if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === 'content-length') {
                    const n = parseInt(line.slice(idx + 1).trim(), 10);
                    return Number.isFinite(n) && n > 0 ? n : 0;
                }
            }
            return 0;
        };
        const onData = (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (buf.length > MAX_HTTP_REQ) {
                socket.removeListener('data', onData);
                try { socket.destroy(); } catch {}
                return;
            }
            tryDispatch();
        };
        const tryDispatch = () => {
            const sep = buf.indexOf('\r\n\r\n');
            if (sep === -1) return false; // headers not complete yet
            const cl = contentLengthOf(buf.toString('utf8', 0, sep));
            const bodyStart = sep + 4;
            if (cl > 0 && buf.length < bodyStart + cl) return false; // body not complete yet
            socket.removeListener('data', onData);
            const end = cl > 0 ? bodyStart + cl : buf.length;
            this._handleHttp(socket, buf.toString('utf8', 0, end), buf);
            return true;
        };
        if (!tryDispatch()) socket.on('data', onData);
    }

    // ── HTTPS CONNECT ──────────────────────────────────────────────────────────
    _handleConnect(socket, head) {
        const connectTabId = _mitmTabIdFromProxyAuthHead(head);
        const line     = head.split('\r\n')[0];
        const hostport = line.split(' ')[1] || '';
        const [hostname, portStr] = hostport.split(':');
        const port = parseInt(portStr) || 443;

        if (this._shouldTlsPassthrough(hostname)) {
            this._handleConnectPassthrough(socket, hostname, port, connectTabId);
            return;
        }

        socket.write('HTTP/1.0 200 Connection Established\r\n\r\n');
        socket.pause(); // Prevent losing TLS ClientHello before we're ready
        const ctag = _clientTag(socket);
        const hsTimer = setTimeout(() => {
            dbg(`[mitm] TLS handshake timeout ${hostname}:${port}${ctag}\n`);
            try { socket.destroy(); } catch {}
        }, networkPolicy.timeouts.tlsHandshakeMs);

        getFakeCertAsync(hostname).then(fakeCert => {
        const tlsSocket = new tls.TLSSocket(socket, {
            isServer:           true,
            key:                fakeCert.key,
            cert:               this._sendCaChain ? fakeCert.cert + getCACertPem() : fakeCert.cert,
            rejectUnauthorized: false,
        });
        tlsSocket.once('secure', () => clearTimeout(hsTimer));
        socket.resume();

        // Parallel pipeline: fire requests as they arrive, write responses in order
        // (createResponsePipeline — buffered responses and CUPNET_MITM_STREAM streams alike).
        let inBuf = Buffer.alloc(0);
        const pipe = createResponsePipeline(tlsSocket);

        const dispatchRequest = (req) => {
            const url = `https://${hostname}${port !== 443 ? ':' + port : ''}${req.path}`;
            const sessionId = null;
            const requestId = `mitm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const headers = { ...req.headers };
            delete headers['proxy-authorization'];
            const hasBody = !!(req.body || req.bodyBase64);
            const orderedHeaders = (req.orderedHeaders || []).filter(([k]) => {
                const kl = k.toLowerCase();
                if (kl === 'proxy-authorization') return false;
                if (hasBody && SKIP_WHEN_BODY.includes(kl)) return false;
                return true;
            });
            const { cupnetRid, orderedHeaders: orderedHeadersStripped } = _stripCupnetRidFromParsedRequest(headers, orderedHeaders);
            const tabId = connectTabId || _tabIdFromCupnetRid(cupnetRid);
            dbg(`[mitm] → ${req.method} ${url}${ctag}\n`);
            if (debugMitmLevel >= 2) mitmUserLog(_fmtHeaders(headers));
            if (debugMitmLevel >= 3) mitmUserLog(_fmtBody(req.body, req.bodyBase64, 'req body'));

            const entry = pipe.newEntry();
            const t0 = Date.now();

            const logResponse = (res, resOut, logBody) => this._logMitmResponse({
                url, req, headers, tabId, sessionId, requestId, cupnetRid, t0, res, resOut, logBody,
            });

            this._doRequest({ method: req.method, url, headers, orderedHeaders: orderedHeadersStripped, body: req.body, bodyBase64: req.bodyBase64, requestId, tabId, allowStream: true })
                .then(res  => {
                    dbg(`[mitm] ← ${url} status=${res.statusCode}${res.stream ? ' (stream)' : ''}${ctag}\n`);
                    if (debugMitmLevel >= 2) mitmUserLog(_fmtHeaders(res.headers));
                    if (debugMitmLevel >= 4 && !res.stream) mitmUserLog(_fmtBody(null, res.bodyBase64, 'res body'));
                    const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, res);
                    if (res.stream) {
                        pipeStreamIntoEntry(pipe, entry, tlsSocket, {
                            res, resOut, method: req.method, url, tag: ctag,
                            wantLogBody: !!this.onRequestLogged,
                            onComplete: (logBody) => logResponse(res, resOut, logBody),
                        });
                        return;
                    }
                    pipe.finish(entry, buildHttpResponse(resOut, url));
                    logResponse(res, resOut, this.onRequestLogged ? _logBodyFromResponse(resOut) : null);
                })
                .catch((e) => {
                    dbg(`[mitm] ✗ ${url} ${e.message}${ctag}\n`);
                    const errRes = this._build502Response(url, e.message, {
                        req, tabId, dnsOverride: e.mitmDnsOverride || null,
                    });
                    const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes);
                    pipe.finish(entry, buildHttpResponse(resOut, url));
                });
        };

        const MAX_INBUF = 10 * 1024 * 1024; // 10 MB
        const chunks = [];
        let chunksLen = 0;

        tlsSocket.on('data', chunk => {
            chunks.push(chunk);
            chunksLen += chunk.length;
            if (chunksLen > MAX_INBUF) {
                chunks.length = 0; chunksLen = 0;
                tlsSocket.destroy();
                return;
            }
            let inBuf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
            chunks.length = 0;

            while (inBuf.length > 0) {
                const sep = inBuf.indexOf('\r\n\r\n');
                if (sep === -1) break;
                const raw = inBuf.toString('utf8', 0, sep + 4);
                const req = parseHttpRequest(raw);
                if (!req) break;
                let consumed = sep + 4;
                const cl = parseInt(req.headers['content-length'] || '0', 10);
                if (cl > 0) {
                    if (inBuf.length < consumed + cl) break;
                    const bodyBuf = inBuf.subarray(consumed, consumed + cl);
                    const isGzip = bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b;
                    const ce = (req.headers['content-encoding'] || '').toLowerCase();
                    const ct = (req.headers['content-type'] || '').toLowerCase();
                    if (isGzip || ce === 'gzip' || ce === 'br' || ce === 'deflate'
                        || ct.startsWith('multipart/')
                        || _isBinaryContentType(ct)) {
                        req.bodyBase64 = bodyBuf.toString('base64');
                    } else {
                        req.body = bodyBuf.toString('utf8');
                    }
                    consumed += cl;
                }
                inBuf = inBuf.subarray(consumed);
                if (_isWebSocketUpgrade(req)) {
                    tlsSocket.removeAllListeners('data');
                    tlsSocket.removeAllListeners('close');
                    tlsSocket.removeAllListeners('error');
                    tlsSocket.removeAllListeners('drain');
                    pipe.reset();
                    chunks.length = 0;
                    chunksLen = 0;
                    const hdrWs = { ...req.headers };
                    const ohWs = Array.isArray(req.orderedHeaders) ? [...req.orderedHeaders] : [];
                    const { cupnetRid: ridWs } = _stripCupnetRidFromParsedRequest(hdrWs, ohWs);
                    const wsTabId = connectTabId || _tabIdFromCupnetRid(ridWs);
                    this._tunnelWebSocketUpgradeMitm({
                        clientTls: tlsSocket,
                        hostname,
                        port,
                        req,
                        tabId: wsTabId,
                        clientRemainder: inBuf,
                        hsTimer,
                    });
                    return;
                }
                dispatchRequest(req);
            }
            if (inBuf.length > 0) { chunks.push(inBuf); chunksLen = inBuf.length; }
            else { chunksLen = 0; }
        });
        tlsSocket.on('error', () => { clearTimeout(hsTimer); try { tlsSocket.destroy(); } catch {} });
        tlsSocket.on('close', () => { chunks.length = 0; chunksLen = 0; pipe.reset(); });
        }).catch((e) => { clearTimeout(hsTimer); dbg(`[mitm] cert error ${hostname}: ${e?.message}${ctag}\n`); socket.destroy(); });
    }

    _handleConnectPassthrough(clientSocket, hostname, port, tabId = null) {
        const target = `${hostname}:${port}`;
        const fail = (err) => {
            safeCatch({ module: 'mitm-proxy', eventCode: 'tls.passthrough.failed', context: { target } }, err, 'warn');
            try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch {}
            try { clientSocket.destroy(); } catch {}
        };
        const attachTunnel = (upstreamSocket, buffered = Buffer.alloc(0)) => {
            try { clientSocket.write('HTTP/1.0 200 Connection Established\r\n\r\n'); } catch {}
            if (buffered && buffered.length > 0) {
                try { clientSocket.write(buffered); } catch {}
            }
            clientSocket.pipe(upstreamSocket);
            upstreamSocket.pipe(clientSocket);
            clientSocket.on('error', () => { try { upstreamSocket.destroy(); } catch {} });
            upstreamSocket.on('error', () => { try { clientSocket.destroy(); } catch {} });
        };

        // Honour the tab's proxy and the fail-closed block like the MITM path does (A-042): a blocked
        // egress with no proxy must not open a direct connection (real IP).
        const proxyUrl = this._resolveUpstreamForTab(tabId).proxy || null;
        if (this._egressBlocked && !proxyUrl) {
            fail(new Error(`Egress blocked: ${this._egressBlockReason || 'proxy required'}`));
            return;
        }

        // DNS override (dial mode only; the classic mode rewrites URLs and never applied to tunnels).
        const dialHost = (this._dnsDial && this._lookupDnsOverride(hostname)?.ip) || hostname;

        if (!proxyUrl) {
            const upstreamSocket = net.connect(port, dialHost);
            upstreamSocket.setTimeout(networkPolicy.timeouts.upstreamRequestMs, () => upstreamSocket.destroy());
            upstreamSocket.once('connect', () => attachTunnel(upstreamSocket));
            upstreamSocket.once('error', fail);
            return;
        }

        // http / https / socks4(a) / socks5(h) upstreams (A-410: was HTTP CONNECT only).
        connectThroughProxy(proxyUrl, dialHost, port, { timeoutMs: networkPolicy.timeouts.upstreamRequestMs })
            .then(({ socket: upstreamSocket, buffered }) => {
                upstreamSocket.setTimeout(networkPolicy.timeouts.upstreamRequestMs, () => upstreamSocket.destroy());
                attachTunnel(upstreamSocket, buffered);
            })
            .catch(fail);
    }

    // ── Plain HTTP ─────────────────────────────────────────────────────────────
    _handleHttp(socket, head) {
        const req = parseHttpRequest(head);
        if (!req) { socket.destroy(); return; }

        const connectTabId = _mitmTabIdFromProxyAuthHead(head);
        const hostHeader = (req.headers['host'] || req.headers['Host'] || '');
        const url = req.path.startsWith('http') ? req.path : `http://${hostHeader}${req.path}`;
        const headers = { ...req.headers };
        delete headers['proxy-authorization'];
        const hasBody = !!(req.body || req.bodyBase64);
        const orderedHeaders = (req.orderedHeaders || []).filter(([k]) => {
            const kl = k.toLowerCase();
            if (kl === 'proxy-authorization') return false;
            if (hasBody && SKIP_WHEN_BODY.includes(kl)) return false;
            return true;
        });
        const { cupnetRid, orderedHeaders: orderedHeadersPlain } = _stripCupnetRidFromParsedRequest(headers, orderedHeaders);
        const tabId = connectTabId || _tabIdFromCupnetRid(cupnetRid);

        const ctagPlain = _clientTag(socket);
        dbg(`[mitm] → ${req.method} ${url}${ctagPlain}\n`);
        if (debugMitmLevel >= 2) mitmUserLog(_fmtHeaders(headers));
        if (debugMitmLevel >= 3) mitmUserLog(_fmtBody(req.body, req.bodyBase64, 'req body'));

        // One request per plain-HTTP proxy connection: end the socket once the response is written.
        const pipe = createResponsePipeline(socket, { endWhenDone: true });
        const entry = pipe.newEntry();
        socket.on('close', () => pipe.reset());
        const requestId = `mitm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const t0 = Date.now();
        const logResponse = (res, resOut, logBody) => this._logMitmResponse({
            url, req, headers, tabId, sessionId: null, requestId, cupnetRid, t0, res, resOut, logBody,
        });

        this._doRequest({
            method: req.method,
            url,
            headers,
            orderedHeaders: orderedHeadersPlain,
            body: req.body,
            bodyBase64: req.bodyBase64,
            requestId,
            tabId,
            allowStream: true,
        })
            .then(res => {
                dbg(`[mitm] ← ${url} status=${res.statusCode}${res.stream ? ' (stream)' : ''}${ctagPlain}\n`);
                if (debugMitmLevel >= 2) mitmUserLog(_fmtHeaders(res.headers));
                if (debugMitmLevel >= 4 && !res.stream) mitmUserLog(_fmtBody(null, res.bodyBase64, 'res body'));
                const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, res);
                if (res.stream) {
                    pipeStreamIntoEntry(pipe, entry, socket, {
                        res, resOut, method: req.method, url, tag: ctagPlain,
                        wantLogBody: !!this.onRequestLogged,
                        onComplete: (logBody) => logResponse(res, resOut, logBody),
                    });
                    return;
                }
                pipe.finish(entry, buildHttpResponse(resOut, url));
                logResponse(res, resOut, this.onRequestLogged ? _logBodyFromResponse(resOut) : null);
            })
            .catch((e) => {
                dbg(`[mitm] ✗ ${url} ${e.message}${ctagPlain}\n`);
                const errRes = this._build502Response(url, e.message, {
                    req, tabId, dnsOverride: e.mitmDnsOverride || null,
                });
                const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes);
                pipe.finish(entry, buildHttpResponse(resOut, url));
            });
    }

    /** Request-log entry (HTTPS inside CONNECT and plain HTTP); `logBody` is the decoded response body (string, `__b64__:` or null). */
    _logMitmResponse({ url, req, headers, tabId, sessionId, requestId, cupnetRid, t0, res, resOut, logBody }) {
        if (!this.onRequestLogged) return;
        const dnsCorsMatch = !res.dnsOverride ? this._mitmCorsMatchDetail(url) : null;
        const requestHeadersForLog = { ...headers };
        applyIdentityToOutboundHeaders(requestHeadersForLog, null, this._resolveUpstreamForTab(tabId).identity, { url });
        this.onRequestLogged({
            url, method: req.method, tabId, sessionId, requestId,
            cupnetRid: cupnetRid || null,
            status: resOut.statusCode, requestHeaders: requestHeadersForLog,
            responseHeaders: resOut.headers, requestBody: _reqBodyForLog(req),
            responseBody: logBody, duration: Date.now() - t0,
            type: inferMitmResourceType(url, req.method, requestHeadersForLog, resOut.headers),
            dnsOverride: res.dnsOverride || null,
            dnsCorsMatch,
        });
    }

    // ── HTTP request (AzureTLS worker — disableRedirects preserves Set-Cookie on 302) ─
    async _doRequest(opts) {
        const st = this.stats;
        st.requests++;
        st.pending++;
        st._window[st._winIdx]++;
        const t0 = Date.now();
        const dnsAdjusted = this._applyDnsOverride(opts);
        const url = dnsAdjusted.url || '';
        if (dnsAdjusted.dnsOverride && debugMitmLevel) {
            const d = dnsAdjusted.dnsOverride;
            const rw = d.rewriteHost ? ` · Host→${d.rewriteHost}` : '';
            dbg(`[mitm] dns  ${d.host}  →  ${d.ip}${rw}\n`);
        }
        const tabUpstream = this._resolveUpstreamForTab(opts.tabId);
        // Built-in identity self-check: https://identity-check.cupnet/… never leaves the MITM. It echoes
        // the request headers exactly as they would go upstream (after the identity rewrite) so the
        // identity-check page can compare the wire with navigator.*.
        if (_isIdentityCheckUrl(url)) {
            st.pending--;
            return this._buildIdentityCheckResponse(opts, tabUpstream, url);
        }
        // Fail closed: a proxy profile connect failed and no per-tab/global proxy is available.
        // Refuse rather than egress directly and leak the real IP.
        if (this._egressBlocked && !tabUpstream.proxy) {
            st.errors++;
            st.pending--;
            const reason = this._egressBlockReason || 'Proxy required but unavailable';
            return this._build502Response(url, `Egress blocked: ${reason}`, {
                req: opts, tabId: opts.tabId, dnsOverride: dnsAdjusted.dnsOverride || null,
            });
        }
        try {
            const { planMitmIntercept, finalizeMitmInterceptResponseAsync } = require('./request-interceptor');
            const mitmOpts = {
                ...dnsAdjusted,
                headers: { ...(dnsAdjusted.headers || {}) },
                orderedHeaders: Array.isArray(dnsAdjusted.orderedHeaders)
                    ? dnsAdjusted.orderedHeaders.map((pair) => [...pair])
                    : dnsAdjusted.orderedHeaders,
            };
            const plan = await planMitmIntercept(mitmOpts);
            if (plan.done) {
                const ms = Date.now() - t0;
                st.totalMs += ms;
                if (ms < st.minMs) st.minMs = ms;
                if (ms > st.maxMs) st.maxMs = ms;
                const delayMs = Number(plan.responseDelayMs) || 0;
                if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
                return plan.response;
            }

            const up = plan.opts;
            if (!up.headers) up.headers = {};
            const requestedHints = tabUpstream.identity?.clientHints ? this._clientHintsCache.requestedFor(up.url) : [];
            applyIdentityToOutboundHeaders(up.headers, up.orderedHeaders, tabUpstream.identity, { url: up.url, requestedHints });
            this._hookBeforeUpstream(up);
            const noBodyUp = /^(GET|HEAD)$/i.test(up.method || '');
            const retryCountUp = /^(GET|HEAD|OPTIONS)$/i.test(up.method || '')
                ? networkPolicy.retry.maxRetries
                : 0;
            const isIdempotent = /^(GET|HEAD|OPTIONS)$/i.test(up.method || '');
            const CONN_ERR = /\bEOF\b|connection reset|ECONNRESET|ETIMEDOUT|ECONNREFUSED|broken pipe|connection termination/i;

            // YouTube/googlevideo: HTTP/2 → PROTOCOL_ERROR; force HTTP/1.1
            // CUPNET_FORCE_HTTP1=1 — force for ALL requests (debug)
            // Profile setting force_http1 — per connected proxy profile
            let forceHttp1 = process.env.CUPNET_FORCE_HTTP1 === '1' || !!tabUpstream.forceHttp1;
            if (!forceHttp1) {
                try {
                    const host = new URL(url).hostname || '';
                    forceHttp1 = /\.(youtube|googlevideo)\.com$/i.test(host);
                } catch {}
            }
            // DNS override: HTTP/2 `:authority` from IP — force HTTP/1.1 so Host header is used. Dial mode
            // keeps the URL, so only a Host rewrite (which HTTP/2 would ignore) needs HTTP/1.1.
            const dnsO = dnsAdjusted.dnsOverride;
            if (dnsO && (!dnsO.dial || dnsO.rewriteHost)) forceHttp1 = true;
            // A rule that sent the request to another host drops the override.
            const connectTo = dnsAdjusted.connectTo && _sameHostname(up.url, url) ? dnsAdjusted.connectTo : undefined;

            const workerReqBase = {
                method:            up.method,
                url:               up.url,
                headers:           up.headers,
                orderedHeaders:    up.orderedHeaders || undefined,
                body:              noBodyUp ? undefined : (up.bodyBase64 ? undefined : (up.body || null)),
                bodyBase64:        noBodyUp ? undefined : (up.bodyBase64 || undefined),
                proxy:             tabUpstream.proxy || null,
                browser:           tabUpstream.browser,
                ja3:               tabUpstream.ja3 || undefined,
                tabId:             opts.tabId != null && opts.tabId !== '' ? String(opts.tabId) : undefined,
                requestId:         opts.requestId || undefined,
                maxRetries:        retryCountUp,
                timeout:           networkPolicy.timeouts.upstreamRequestMs,
                disableRedirects:  opts.disableRedirects !== false,
                connectTo,
            };
            // Stream the body (CUPNET_MITM_STREAM) only when nothing needs the whole response first:
            // no response-rewriting intercept rule (postProcess) and not HEAD (no body). The Critical-CH
            // retry below only needs headers, and a superseded stream is cancelled before the browser
            // has seen any of it, so document navigations stream too.
            const wantStream = this.worker?._streaming === true && opts.allowStream === true && !plan.postProcess
                && !/^HEAD$/i.test(up.method || '');
            const runWorker = (useHttp1) => (wantStream
                ? this.worker.requestStream({ ...workerReqBase, forceHttp1: !!useHttp1 })
                : this.worker.request({ ...workerReqBase, forceHttp1: !!useHttp1 }));

            let workerError = null;
            /** Set once a streamed head is received; cancelled if we fail before handing it back. */
            let streamedBody = null;
            try {
                let res;
                try {
                    res = await runWorker(forceHttp1);
                } catch (e) {
                    if (!forceHttp1 && _shouldAutoRetryHttp1(e.message)) {
                        dbg(`[mitm] ↻ http/1.1 retry after worker error ${url} (${e.message})\n`);
                        res = await runWorker(true);
                    } else {
                        throw e;
                    }
                }
                if (res.stream) streamedBody = res.stream;
                if (!forceHttp1 && !res.stream && _responseSuggestsHttp1Retry(res)) {
                    dbg(`[mitm] ↻ http/1.1 retry after gateway body ${url}\n`);
                    res = await runWorker(true);
                }
                // Accept-CH / Critical-CH (top-level navigations only): remember what the origin asked
                // for and, like Chrome, retry the navigation once when Critical-CH names hints we did not send.
                if (tabUpstream.identity?.clientHints) {
                    const ch = this._clientHintsCache.observeResponse(up.url, up.headers, res.headers || {});
                    if (ch.retryWith.length) {
                        dbg(`[mitm] ↻ Critical-CH retry ${url} (+${ch.retryWith.join(',')})\n`);
                        if (res.stream) res.stream.cancel(); // superseded by the buffered retry below
                        applyIdentityToOutboundHeaders(up.headers, up.orderedHeaders, tabUpstream.identity, { url: up.url, requestedHints: ch.retryWith });
                        res = await this.worker.request({ ...workerReqBase, headers: up.headers, orderedHeaders: up.orderedHeaders || undefined, forceHttp1: !!forceHttp1 });
                    }
                }
                const ms = Date.now() - t0;
                st.totalMs += ms;
                if (ms < st.minMs) st.minMs = ms;
                if (ms > st.maxMs) st.maxMs = ms;
                let out = {
                    statusCode: res.statusCode,
                    headers: res.headers || {},
                    bodyBase64: res.bodyBase64 || '',
                    dnsOverride: dnsAdjusted.dnsOverride || null,
                };
                // Streamed body: the caller writes the head now and pipes the body as it arrives.
                // (Never combined with postProcess — see wantStream.)
                if (res.stream) out.stream = res.stream;
                if (plan.postProcess) {
                    out = await finalizeMitmInterceptResponseAsync(out, plan.postProcess);
                }
                out = this._hookResponseHead(up, out);
                const delayMs = Number(plan.responseDelayMs) || Number(plan.postProcess || {}._responseDelayMs) || 0;
                if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
                return out;
            } catch (e) {
                if (streamedBody) streamedBody.cancel();
                workerError = e;
                // The native fallback below is a direct Node https request: never use it when traffic must
                // go through an upstream proxy or egress is blocked — it would reach the origin from the
                // real IP (A-008). Only a direct (no-proxy) tab may fall back.
                if (!isIdempotent || tabUpstream.proxy || this._egressBlocked
                    || !CONN_ERR.test(String(e.message || ''))) throw e;
            }

            // Worker failed with connection error — native Node.js https fallback
            dbg(`[mitm] ↻ native-fallback ${url} (${workerError.message})\n`);
            try {
                const nativeRes = await _nativeHttpsFallback(
                    url, up.method, up.headers, up.orderedHeaders,
                    noBodyUp ? null : (up.body || null),
                    noBodyUp ? null : (up.bodyBase64 || null),
                    undefined, connectTo
                );
                const ms = Date.now() - t0;
                st.totalMs += ms;
                if (ms < st.minMs) st.minMs = ms;
                if (ms > st.maxMs) st.maxMs = ms;
                dbg(`[mitm] ← ${url} status=${nativeRes.statusCode} (native-fallback)\n`);
                let out = {
                    statusCode: nativeRes.statusCode,
                    headers: nativeRes.headers || {},
                    bodyBase64: nativeRes.bodyBase64 || '',
                    dnsOverride: dnsAdjusted.dnsOverride || null,
                };
                if (plan.postProcess) {
                    out = await finalizeMitmInterceptResponseAsync(out, plan.postProcess);
                }
                out = this._hookResponseHead(up, out);
                const delayMs = Number(plan.responseDelayMs) || Number(plan.postProcess || {}._responseDelayMs) || 0;
                if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
                return out;
            } catch (fallbackErr) {
                dbg(`[mitm] ✗ native-fallback ${url} ${fallbackErr.message}\n`);
                throw workerError;
            }
        } catch (e) {
            st.errors++;
            if (dnsAdjusted?.dnsOverride) {
                try { e.mitmDnsOverride = dnsAdjusted.dnsOverride; } catch (_) { /* ignore */ }
            }
            throw e;
        } finally {
            st.pending--;
        }
    }

    _build502Response(url, errorMessage, { req, tabId, dnsOverride: explicitDnsOverride } = {}) {
        const dnsOverride = resolveMitmGatewayDnsContext({
            url,
            errorMessage,
            dnsOverride: explicitDnsOverride || this._applyDnsOverride({ url }).dnsOverride || null,
        });
        if (dnsOverride && /ECONNREFUSED|connection refused/i.test(String(errorMessage || ''))) {
            dbg(`[mitm] 502 ${url} — ${dnsOverride.inferred ? 'routed to' : 'DNS override'} `
                + `${dnsOverride.host} → ${dnsOverride.ip}: ${errorMessage}\n`);
        }
        // Whether this request actually egressed through an upstream proxy — the message for a
        // timeout / garbled response differs: via a proxy exit it is almost always the exit node.
        let viaProxy = false;
        try { viaProxy = !!this._resolveUpstreamForTab(tabId).proxy; } catch (_) { /* ignore */ }
        const errRes = buildMitmGatewayErrorResponse({ url, errorMessage, dnsOverride, viaProxy });
        if (this.onGatewayError && (!req || isLikelyDocumentNavigation(req))) {
            try {
                this.onGatewayError({
                    url,
                    errorMessage,
                    dnsOverride,
                    viaProxy,
                    tabId: tabId ?? null,
                    summary: summarizeMitmGatewayError({ url, errorMessage, dnsOverride, viaProxy }),
                });
            } catch (_) { /* ignore */ }
        }
        return errRes;
    }

    /** The override for a hostname: exact rule first, then the longest matching `*.suffix`. */
    _lookupDnsOverride(hostname) {
        const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
        if (!host) return null;
        const exact = this._dnsOverrides.get(host);
        if (exact?.ip) return exact;
        for (const w of this._dnsWildcards) if (_matchHostPattern(w.pattern, host)) return w;
        return null;
    }

    _applyDnsOverride(opts) {
        const sourceUrl = String(opts?.url || '');
        if (!sourceUrl || (this._dnsOverrides.size === 0 && this._dnsWildcards.length === 0)) return { ...opts };

        let u;
        try { u = new URL(sourceUrl); } catch { return { ...opts }; }
        const host = (u.hostname || '').toLowerCase();
        if (!host) return { ...opts };

        const entry = this._lookupDnsOverride(host);
        if (!entry?.ip) return { ...opts };

        const overrideIp = entry.ip;
        const rewriteHost = entry.rewriteHost || null;

        if (this._dnsDial) {
            const dnsOverride = { host, ip: overrideIp, rewriteHost: rewriteHost || undefined, dial: true, ...(entry.id ? { id: entry.id } : {}) };
            if (!rewriteHost) return { ...opts, connectTo: overrideIp, dnsOverride };
            const headers = { ...(opts.headers || {}) };
            for (const k of Object.keys(headers)) if (k.toLowerCase() === 'host') delete headers[k];
            headers.host = rewriteHost;
            let ordered = opts.orderedHeaders || undefined;
            if (Array.isArray(ordered) && ordered.length) {
                const i = ordered.findIndex(([k]) => String(k).toLowerCase() === 'host');
                ordered = i >= 0 ? ordered.map((pair, j) => (j === i ? [pair[0], rewriteHost] : pair)) : [['Host', rewriteHost], ...ordered];
            }
            return { ...opts, connectTo: overrideIp, headers, orderedHeaders: ordered, dnsOverride };
        }

        const overriddenUrl = new URL(sourceUrl);
        overriddenUrl.hostname = overrideIp;

        const explicitPort = u.port || (u.protocol === 'https:' ? '443' : '80');
        const includePort =
            (u.protocol === 'https:' && explicitPort !== '443') ||
            (u.protocol === 'http:' && explicitPort !== '80');
        const logicalHostHeader = rewriteHost
            ? rewriteHost
            : (includePort ? `${host}:${explicitPort}` : host);

        const nextHeaders = { ...(opts.headers || {}) };
        nextHeaders.host = logicalHostHeader;

        let nextOrdered = opts.orderedHeaders || undefined;
        if (Array.isArray(nextOrdered) && nextOrdered.length) {
            let replaced = false;
            nextOrdered = nextOrdered.map(([k, v]) => {
                if (String(k).toLowerCase() === 'host') {
                    replaced = true;
                    return [k, logicalHostHeader];
                }
                return [k, v];
            });
            if (!replaced) nextOrdered = [['Host', logicalHostHeader], ...nextOrdered];
        }

        return {
            ...opts,
            url: overriddenUrl.toString(),
            /** Исходный URL до подмены хоста на IP — для intercept rules (паттерны с доменом). */
            interceptMatchUrl: sourceUrl,
            headers: nextHeaders,
            orderedHeaders: nextOrdered,
            dnsOverride: { host, ip: overrideIp, rewriteHost: rewriteHost || undefined, ...(entry.id ? { id: entry.id } : {}) },
        };
    }

    /**
     * Прямой TLS к origin (или через upstream CONNECT), без AzureTLS — для WebSocket после Upgrade.
     */
    _openRawTlsToUpstream({ connectHost, connectPort, servername, proxyUrl }) {
        const to = networkPolicy.timeouts.upstreamRequestMs;
        if (!proxyUrl) {
            return new Promise((resolve, reject) => {
                const sock = tls.connect({
                    host: connectHost,
                    port: connectPort,
                    servername,
                    rejectUnauthorized: true,
                    ALPNProtocols: ['http/1.1'],
                });
                sock.setTimeout(to, () => {
                    try { sock.destroy(); } catch {}
                    reject(new Error('TLS connect timeout'));
                });
                sock.once('secureConnect', () => resolve(sock));
                sock.once('error', reject);
            });
        }
        // http / https / socks4(a) / socks5(h) upstreams (A-410: was HTTP CONNECT only).
        return connectThroughProxy(proxyUrl, connectHost, connectPort, { timeoutMs: to })
            .then(({ socket: upstreamSocket, buffered }) => new Promise((resolve, reject) => {
                if (buffered.length) upstreamSocket.unshift(buffered);
                const tlsSock = tls.connect({
                    socket: upstreamSocket,
                    servername,
                    rejectUnauthorized: true,
                    ALPNProtocols: ['http/1.1'],
                });
                tlsSock.setTimeout(to, () => {
                    try { tlsSock.destroy(); } catch {}
                    reject(new Error('TLS over proxy timeout'));
                });
                tlsSock.once('secureConnect', () => resolve(tlsSock));
                tlsSock.once('error', reject);
            }));
    }

    /**
     * После клиентского GET Upgrade: туннель к origin, ответ 101 и дальше raw duplex.
     */
    _tunnelWebSocketUpgradeMitm({ clientTls, hostname, port, req, tabId, clientRemainder, hsTimer }) {
        if (hsTimer) try { clearTimeout(hsTimer); } catch {}
        const url = `https://${hostname}${port !== 443 ? ':' + port : ''}${req.path}`;
        const headers = { ...req.headers };
        delete headers['proxy-authorization'];
        const orderedHeaders = (req.orderedHeaders || []).filter(
            ([k]) => String(k).toLowerCase() !== 'proxy-authorization'
        );
        let mitmOpts = { method: req.method, url, headers, orderedHeaders };
        mitmOpts = this._applyDnsOverride(mitmOpts);

        const { planMitmIntercept, finalizeMitmInterceptResponseAsync } = require('./request-interceptor');
        void (async () => {
            const plan = await planMitmIntercept(mitmOpts);
            if (plan.done) {
                const delayMs = Number(plan.responseDelayMs) || 0;
                if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
                const finishShort = async () => {
                    let out = plan.response;
                    if (plan.postProcess) {
                        out = await finalizeMitmInterceptResponseAsync(out, plan.postProcess);
                    }
                    const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, out);
                    try { clientTls.write(buildHttpResponse(resOut, url)); } catch {}
                    try { clientTls.end(); } catch {}
                };
                await finishShort().catch((err) => {
                    try { safeCatch({ module: 'mitm-proxy', eventCode: 'mitm.ws.shortCircuitFinalize.failed', context: { url } }, err, 'warn'); } catch (_) { /* ignore */ }
                    try { clientTls.end(); } catch {}
                });
                return;
            }
            this._continueWsTunnelAfterPlan({
                plan, mitmOpts, url, headers, req, clientTls, tabId, hsTimer, orderedHeaders, clientRemainder,
            });
        })().catch((err) => {
            safeCatch({ module: 'mitm-proxy', eventCode: 'mitm.ws.plan.failed', context: { url } }, err, 'warn');
            try { clientTls.end(); } catch {}
        });
        return;
    }

    _hookBeforeUpstream(up) {
        if (!this.onBeforeUpstream) return;
        try { this.onBeforeUpstream(up); } catch (e) {
            safeCatch({ module: 'mitm-proxy', eventCode: 'mitm.hook.beforeUpstream.failed', context: { url: up.url } }, e, 'warn');
        }
    }

    _hookResponseHead(up, out) {
        if (!this.onResponseHead) return out;
        try { return this.onResponseHead(up, out) || out; } catch (e) {
            safeCatch({ module: 'mitm-proxy', eventCode: 'mitm.hook.responseHead.failed', context: { url: up.url } }, e, 'warn');
            return out;
        }
    }

    _continueWsTunnelAfterPlan(ctx) {
        const { plan, mitmOpts, url, headers, req, clientTls, tabId, hsTimer, orderedHeaders, clientRemainder } = ctx;
        const up = plan.opts;
        if (!up.headers) up.headers = {};
        const tabUpstream = this._resolveUpstreamForTab(tabId);
        applyIdentityToOutboundHeaders(up.headers, up.orderedHeaders, tabUpstream.identity, { url: up.url });
        this._hookBeforeUpstream(up);
        const wire = _buildWireHttpRequest(up);
        const t0 = Date.now();
        const requestId = `mitm_ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const uObj = new URL(up.url);
        const logicalHost = uObj.hostname;
        const targetPort = uObj.port ? parseInt(uObj.port, 10) : 443;
        const connectHost = up.dnsOverride?.ip || logicalHost;
        const proxyUrl = tabUpstream.proxy || this.upstream;

        const fail = (err) => {
            dbg(`[mitm] ws tunnel ${url}: ${err?.message || err}\n`);
            safeCatch({ module: 'mitm-proxy', eventCode: 'mitm.wsTunnel.failed', context: { url } }, err, 'warn');
            try {
                this.stats.errors++;
            } catch { /* ignore */ }
            if (this.onRequestLogged) {
                try {
                    this.onRequestLogged({
                        url: up.url,
                        method: req.method || 'GET',
                        tabId,
                        sessionId: null,
                        requestId,
                        status: 502,
                        requestHeaders: { ...(up.headers || {}) },
                        responseHeaders: {},
                        responseBody: null,
                        duration: Date.now() - t0,
                        type: 'websocket',
                        dnsOverride: up.dnsOverride || null,
                    });
                } catch (_) { /* ignore */ }
            }
            try {
                const errRes = {
                    statusCode: 502,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    bodyBase64: Buffer.from(String(err?.message || 'WebSocket tunnel failed'), 'utf8').toString('base64'),
                };
                clientTls.write(buildHttpResponse(
                    applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes),
                    url,
                ));
            } catch {}
            try { clientTls.end(); } catch {}
        };

        // Fail closed like the MITM path (A-042): no proxy while egress is blocked → no direct socket.
        if (this._egressBlocked && !proxyUrl) {
            fail(new Error(`Egress blocked: ${this._egressBlockReason || 'proxy required'}`));
            return;
        }

        this._openRawTlsToUpstream({
            connectHost,
            connectPort: targetPort,
            servername: logicalHost,
            proxyUrl,
        })
            .then((upSock) => {
                upSock.setTimeout(0);
                upSock.write(wire, 'utf8');
                return _readOneHttpResponseFromSocket(upSock, networkPolicy.timeouts.upstreamRequestMs).then(
                    ({ response, remainder, status }) => ({ upSock, response, remainder, status })
                );
            })
            .then(({ upSock, response, remainder, status }) => {
                const parsed = _parseHttpResponseHead(response);
                const dur = Date.now() - t0;
                try {
                    const st = this.stats;
                    st.requests++;
                    st._window[st._winIdx]++;
                    st.totalMs += dur;
                    if (dur < st.minMs) st.minMs = dur;
                    if (dur > st.maxMs) st.maxMs = dur;
                } catch { /* ignore */ }
                if (this.onRequestLogged) {
                    try {
                        this.onRequestLogged({
                            url: up.url,
                            method: req.method || 'GET',
                            tabId,
                            sessionId: null,
                            requestId,
                            status: parsed.statusCode || status,
                            requestHeaders: { ...(up.headers || {}) },
                            responseHeaders: parsed.headers,
                            responseBody: null,
                            duration: dur,
                            type: 'websocket',
                            dnsOverride: up.dnsOverride || null,
                        });
                    } catch (_) { /* ignore */ }
                }
                try { clientTls.write(response); } catch {}
                if (status !== 101) {
                    dbg(`[mitm] ws non-101 status=${status} ${url}\n`);
                    try { upSock.end(); } catch {}
                    try { clientTls.end(); } catch {}
                    return;
                }
                const rem = clientRemainder && clientRemainder.length ? clientRemainder : Buffer.alloc(0);
                if (this.onWebSocket) {
                    // Frame-aware relay: same bytes on the wire, plus a message tap and injection.
                    const relay = relayWebSocket({
                        client: clientTls, upstream: upSock, responseHeaders: parsed.headers,
                        clientRemainder: rem, upstreamRemainder: remainder,
                    });
                    try {
                        this.onWebSocket({ requestId, url: up.url, tabId, requestHeaders: { ...(up.headers || {}) }, responseHeaders: parsed.headers, relay });
                    } catch (e) {
                        safeCatch({ module: 'mitm-proxy', eventCode: 'mitm.hook.webSocket.failed', context: { url } }, e, 'warn');
                    }
                    dbg(`[mitm] ws relay established ${url}\n`);
                    return;
                }
                if (remainder && remainder.length) {
                    try { clientTls.write(remainder); } catch {}
                }
                if (rem.length) {
                    try { upSock.write(rem); } catch {}
                }
                upSock.pipe(clientTls);
                clientTls.pipe(upSock);
                upSock.on('error', () => { try { clientTls.destroy(); } catch {} });
                clientTls.on('error', () => { try { upSock.destroy(); } catch {} });
                dbg(`[mitm] ws tunnel established ${url}\n`);
            })
            .catch(fail);
    }

    getStats() {
        const st = this.stats;
        const done = st.requests - st.errors;
        // req/s = sum of last 10 seconds in sliding window
        let recentReqs = 0;
        for (let i = 0; i < 10; i++) {
            recentReqs += st._window[(st._winIdx - i + 60) % 60];
        }
        return {
            requests:   st.requests,
            errors:     st.errors,
            pending:    st.pending,
            avgMs:      done > 0 ? Math.round(st.totalMs / done) : 0,
            minMs:      st.minMs === Infinity ? 0 : st.minMs,
            maxMs:      st.maxMs,
            reqPerSec:  Math.round(recentReqs / 10 * 10) / 10,
            workerReady: this.worker.ready,
            workerRestarts: this.worker._restartCount || 0,
            workerInFlight: this.worker._inflightRequests || 0,
            workerQueueDepth: this.worker._stdinQueue ? this.worker._stdinQueue.length : 0,
            browser:    this.browser,
        };
    }

    getProxyUrl()  { return `http://127.0.0.1:${this.port}`; }
    getCACert()    { return getCACertPem(); }
}

// ── HTTP parsing helpers ──────────────────────────────────────────────────────

function parseHttpRequest(raw) {
    try {
        const headerEnd = raw.indexOf('\r\n\r\n');
        const headerPart = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
        const body       = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';

        const lines   = headerPart.split('\r\n');
        const [method, path] = lines[0].split(' ');
        const headers = {};
        const orderedHeaders = []; // [[key, value], ...] — preserve order & casing for fingerprint
        for (let i = 1; i < lines.length; i++) {
            const idx = lines[i].indexOf(':');
            if (idx < 0) continue;
            const k = lines[i].slice(0, idx).trim();
            const v = lines[i].slice(idx + 1).trim();
            const kLower = k.toLowerCase();
            headers[kLower] = v;
            orderedHeaders.push([k, v]);
        }
        return { method, path, headers, orderedHeaders, body: body || null };
    } catch { return null; }
}

/** WebSocket upgrade: долгоживущий туннель; AzureTLS request/response этому не подходит. */
function _isWebSocketUpgrade(req) {
    if (!req || String(req.method || '').toUpperCase() !== 'GET') return false;
    const up = String(req.headers['upgrade'] || '').toLowerCase();
    if (!up.includes('websocket')) return false;
    const conn = String(req.headers['connection'] || '').toLowerCase();
    return conn.includes('upgrade');
}

function _buildWireHttpRequest(up) {
    const u = new URL(up.url);
    const path = u.pathname + (u.search || '');
    const lines = [`${up.method} ${path} HTTP/1.1`];
    const hop = new Set(['proxy-connection', 'proxy-authorization']);
    for (const [k, v] of (up.orderedHeaders || [])) {
        if (hop.has(String(k).toLowerCase())) continue;
        lines.push(`${k}: ${v}`);
    }
    const hasHost = (up.orderedHeaders || []).some(([k]) => String(k).toLowerCase() === 'host');
    if (!hasHost) {
        const h = (up.headers && up.headers.host) || u.host;
        lines.push(`Host: ${h}`);
    }
    lines.push('', '');
    return lines.join('\r\n');
}

/**
 * Читает один HTTP-ответ (заголовки + тело по Content-Length) с сокета после записи запроса.
 * @returns {{ response: Buffer, remainder: Buffer, status: number }}
 */
function _parseHttpResponseHead(rawBuf) {
    const sep = rawBuf.indexOf('\r\n\r\n');
    if (sep === -1) return { statusCode: 0, headers: {} };
    const headStr = rawBuf.slice(0, sep).toString('utf8');
    const lines = headStr.split('\r\n');
    const first = lines[0] || '';
    const m = first.match(/^HTTP\/\d\.\d\s+(\d+)/);
    const statusCode = m ? parseInt(m[1], 10) : 0;
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':');
        if (idx < 0) continue;
        const k = lines[i].slice(0, idx).trim();
        const v = lines[i].slice(idx + 1).trim();
        headers[k.toLowerCase()] = v;
    }
    return { statusCode, headers };
}

function _readOneHttpResponseFromSocket(sock, timeoutMs) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const t = setTimeout(() => {
            cleanup();
            try { sock.destroy(); } catch {}
            reject(new Error('HTTP response timeout'));
        }, timeoutMs);
        const onData = (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            const sep = buf.indexOf('\r\n\r\n');
            if (sep === -1) {
                if (buf.length > 1024 * 1024) {
                    cleanup();
                    reject(new Error('HTTP response headers too large'));
                }
                return;
            }
            const headStr = buf.slice(0, sep).toString('utf8');
            const firstLine = headStr.split('\r\n')[0] || '';
            const m = firstLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
            const status = m ? parseInt(m[1], 10) : 0;
            let cl = 0;
            for (const line of headStr.split('\r\n').slice(1)) {
                const ci = line.indexOf(':');
                if (ci < 0) continue;
                if (line.slice(0, ci).trim().toLowerCase() === 'content-length') {
                    cl = parseInt(line.slice(ci + 1).trim(), 10) || 0;
                }
            }
            const total = sep + 4 + cl;
            if (buf.length < total) return;
            const response = buf.slice(0, total);
            const remainder = buf.slice(total);
            cleanup();
            resolve({ response, remainder, status });
        };
        const onErr = (e) => { cleanup(); reject(e); };
        const cleanup = () => {
            clearTimeout(t);
            sock.removeListener('data', onData);
            sock.removeListener('error', onErr);
        };
        sock.on('data', onData);
        sock.once('error', onErr);
    });
}

/**
 * TabId из Proxy-Authorization (Basic), если есть и пароль верный.
 * Без заголовка или при неверном пароле — null (CONNECT разрешаем всегда: session.fetch и др. не шлют 407-login).
 */
function _mitmTabIdFromProxyAuthHead(rawHead) {
    const { globalUsername, password } = networkPolicy.mitmClientProxyAuth;
    if (!rawHead || typeof rawHead !== 'string') return null;
    const sep = rawHead.indexOf('\r\n\r\n');
    const blob = sep >= 0 ? rawHead.slice(0, sep + 4) : `${rawHead.replace(/\s+$/, '')}\r\n\r\n`;
    const req = parseHttpRequest(blob);
    if (!req?.headers) return null;
    const auth = req.headers['proxy-authorization'] || '';
    const m = String(auth).trim().match(/^Basic\s+(\S+)/i);
    if (!m) return null;
    let decoded;
    try {
        decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
        return null;
    }
    const colon = decoded.indexOf(':');
    let username = colon >= 0 ? decoded.slice(0, colon) : decoded;
    const pass = colon >= 0 ? decoded.slice(colon + 1) : '';
    if (pass !== password) return null;
    try {
        username = decodeURIComponent(username);
    } catch {
        return null;
    }
    if (!username || username === globalUsername) return null;
    return username;
}

// ── MITM CORS injection (optional; не трогать challenge/captcha хосты) ─────────
const _CORS_RESP_KEYS = new Set([
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-expose-headers',
    'access-control-max-age',
]);

function _reqHeader(headers, name) {
    const want = String(name || '').toLowerCase();
    if (!headers || typeof headers !== 'object') return '';
    for (const [k, v] of Object.entries(headers)) {
        if (String(k).toLowerCase() === want) return String(v == null ? '' : v).trim();
    }
    return '';
}

/** Origin для ACAO: заголовок Origin, иначе origin из Referer (часть клиентов/прокладок шлёт только Referer). */
function _resolveCorsAllowOrigin(requestHeaders) {
    let o = _reqHeader(requestHeaders, 'Origin');
    if (o && o !== 'null') return o;
    const ref = _reqHeader(requestHeaders, 'Referer');
    if (!ref) return '';
    try {
        return new URL(ref).origin;
    } catch {
        return '';
    }
}

function shouldSkipMitmCorsForUrl(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch { return true; }
    const host = (u.hostname || '').toLowerCase();
    const p = u.pathname || '';
    if (host === 'challenges.cloudflare.com') return true;
    if (p.includes('challenge-platform') || p.includes('cdn-cgi/challenge')) return true;
    if (host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com')) return true;
    if (host === 'turnstile.com' || host.endsWith('.turnstile.com')) return true;
    return false;
}

function applyMitmCorsToResponse(enabled, url, requestHeaders, requestMethod, res) {
    if (!enabled || !res) {
        if (debugMitmLevel && enabled === false) dbg(`[mitm-cors] SKIP (not enabled) ${url}\n`);
        return res;
    }
    if (shouldSkipMitmCorsForUrl(url)) return res;
    const origin = _resolveCorsAllowOrigin(requestHeaders);
    if (!origin) {
        if (debugMitmLevel) dbg(`[mitm-cors] SKIP (no origin/referer) ${url}\n`);
        return res;
    }
    if (debugMitmLevel) dbg(`[mitm-cors] INJECT origin=${origin} method=${requestMethod} status=${res.statusCode} ${url}\n`);

    const src = res.headers && typeof res.headers === 'object' ? res.headers : {};
    const merged = {};
    for (const k of Object.keys(src)) {
        if (_CORS_RESP_KEYS.has(String(k).toLowerCase())) continue;
        merged[k] = src[k];
    }

    merged['Access-Control-Allow-Origin'] = origin;
    merged['Access-Control-Allow-Credentials'] = 'true';

    const meth = String(requestMethod || '').toUpperCase();
    if (meth === 'OPTIONS') {
        const reqM = _reqHeader(requestHeaders, 'Access-Control-Request-Method');
        const reqH = _reqHeader(requestHeaders, 'Access-Control-Request-Headers');
        merged['Access-Control-Allow-Methods'] = reqM || 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
        merged['Access-Control-Allow-Headers'] = reqH || '*';
        merged['Access-Control-Max-Age'] = '86400';
    } else {
        merged['Access-Control-Allow-Methods'] = merged['Access-Control-Allow-Methods'] || 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
        merged['Access-Control-Allow-Headers'] = merged['Access-Control-Allow-Headers'] || '*';
    }

    return { ...res, headers: merged };
}

// Hop-by-hop + Content-Encoding (AzureTLS returns decompressed body; keeping it causes ERR_CONTENT_DECODING_FAILED)
const HOP_BY_HOP_HEADERS = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-length', 'content-encoding']);

const STATUS_TEXT = { 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 307: 'Temporary Redirect', 308: 'Permanent Redirect' };

// Streamed responses (CUPNET_MITM_STREAM): the body length is unknown up front, so the head carries
// Transfer-Encoding: chunked. The worker decodes known encodings (like the buffered path) and drops
// Content-Encoding; if one is still present it is an unknown encoding passed through raw, so keep it.
const STREAM_SKIP_HEADERS = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-length']);
const CRLF_BUF = Buffer.from('\r\n', 'latin1');
const CHUNK_TERMINATOR_BUF = Buffer.from('0\r\n\r\n', 'latin1');

/**
 * Status line + headers for a streamed response.
 * @param {{ statusCode?: number, headers?: object }} res
 * @param {string} requestUrl
 * @param {{ chunked: boolean }} opts - false for bodiless responses (HEAD / 1xx / 204 / 304)
 */
function buildHttpResponseHead(res, requestUrl, { chunked }) {
    const payload = requestUrl ? absolutizeMitmRedirectResponse(res, requestUrl) : res;
    const statusCode = payload.statusCode || 200;
    const statusText = STATUS_TEXT[statusCode] || 'OK';
    let headerStr = `HTTP/1.1 ${statusCode} ${statusText}\r\n`;
    headerStr += chunked ? 'Transfer-Encoding: chunked\r\n' : 'Content-Length: 0\r\n';
    for (const [k, v] of Object.entries(payload.headers || {})) {
        if (STREAM_SKIP_HEADERS.has(k.toLowerCase())) continue;
        const vals = Array.isArray(v) ? v : [v];
        for (const val of vals) headerStr += `${k}: ${val}\r\n`;
    }
    headerStr += '\r\n';
    return Buffer.from(headerStr, 'latin1');
}

/** Request-log body for a buffered response: text, `__b64__:` for binary types, or null. */
function _logBodyFromResponse(resOut) {
    if (!resOut || !resOut.bodyBase64) return null;
    const ct = _headerVal(resOut.headers, 'content-type');
    if (_isMediaContentType(ct)) return null;
    if (Math.floor(resOut.bodyBase64.length * 3 / 4) > LOG_BODY_MAX_BYTES) return null;
    if (_isBinaryContentType(ct)) return '__b64__:' + resOut.bodyBase64;
    try { return Buffer.from(resOut.bodyBase64, 'base64').toString('utf8'); } catch { return null; }
}

/**
 * In-order HTTP/1.1 response writer for one client connection (a browser tab or an External Proxy
 * client). Responses are written strictly in request order; each entry holds queued output. A buffered
 * response is one buffer + done; a streamed one (CUPNET_MITM_STREAM) grows as chunks arrive. Honours
 * sock.write() backpressure ('drain') and pauses/resumes the worker stream by queued size.
 * @param {import('net').Socket|import('tls').TLSSocket} sock
 * @param {{ endWhenDone?: boolean }} [opts] - end the socket once a response is fully written
 *        (plain-HTTP proxy requests are one request per connection)
 */
function createResponsePipeline(sock, { endWhenDone = false } = {}) {
    const entries = [];
    let writing = false;
    let blocked = false; // sock.write() returned false — wait for 'drain'
    let completed = 0;
    let ended = false;

    const applyBackpressure = (entry) => {
        if (!entry.stream || entry.done) return;
        if (entry.queued > STREAM_HIGH_WATER) entry.stream.pause();
        else if (entry.queued <= STREAM_LOW_WATER) entry.stream.resume();
    };

    const flush = () => {
        if (writing) return;
        writing = true;
        try {
            while (entries.length > 0 && !blocked) {
                const head = entries[0];
                while (head.out.length > 0) {
                    const buf = head.out.shift();
                    head.queued -= buf.length;
                    if (!sock.writable) continue; // connection gone — drop output
                    let ok = true;
                    try { ok = sock.write(buf); } catch { /* socket error handled by 'error' */ }
                    if (ok === false) { blocked = true; break; }
                }
                applyBackpressure(head);
                if (blocked || !head.done || head.out.length > 0) break;
                entries.shift();
                completed++;
            }
            if (endWhenDone && !ended && completed > 0 && entries.length === 0) {
                ended = true;
                try { sock.end(); } catch { /* ignore */ }
            }
        } finally {
            writing = false;
        }
    };
    sock.on('drain', () => { blocked = false; flush(); });

    const cancelStreams = () => {
        for (const e of entries) {
            if (e.stream && !e.done) {
                try { e.stream.cancel(); } catch { /* ignore */ }
            }
        }
    };

    return {
        newEntry() {
            const e = { out: [], queued: 0, done: false, stream: null };
            entries.push(e);
            return e;
        },
        enqueue(entry, buf) {
            entry.out.push(buf);
            entry.queued += buf.length;
        },
        /** Complete an entry with one whole response (replacing any partial/streamed output). */
        finish(entry, buf) {
            if (entry.stream && !entry.done) {
                try { entry.stream.cancel(); } catch { /* ignore */ }
            }
            entry.stream = null;
            entry.out.length = 0;
            entry.queued = 0;
            if (buf) { entry.out.push(buf); entry.queued = buf.length; }
            entry.done = true;
            flush();
        },
        flush,
        applyBackpressure,
        /** Connection closed / taken over: stop upstream downloads nobody will read. */
        reset() {
            cancelStreams();
            entries.length = 0;
        },
    };
}

/**
 * Write a streamed response (CUPNET_MITM_STREAM) into a pipeline entry: the head now, the chunked body
 * as it arrives, the terminator at the end. `onComplete(logBody)` fires after a successful body with the
 * body for the request log (null when not wanted, a media type, or bigger than LOG_BODY_MAX_BYTES). A body that
 * fails after the head was sent aborts the connection — the only honest signal left to the client.
 */
function pipeStreamIntoEntry(pipe, entry, sock, { res, resOut, method, url, wantLogBody = false, onComplete = null, tag = '' }) {
    const stream = res.stream;
    if (!sock.writable) {
        stream.cancel();
        pipe.finish(entry, null);
        return;
    }
    const status = Number(resOut.statusCode) || 200;
    const noBody = /^HEAD$/i.test(method || '') || status === 204 || status === 304 || (status >= 100 && status < 200);
    if (_isMediaContentType(_headerVal(resOut.headers, 'content-type'))) wantLogBody = false;
    entry.stream = stream;
    pipe.enqueue(entry, buildHttpResponseHead(resOut, url, { chunked: !noBody }));
    const logParts = [];
    let logBytes = 0;
    let logOverflow = false;
    stream.attach({
        onData: (buf) => {
            if (noBody) return;
            if (wantLogBody && !logOverflow) {
                if (logBytes + buf.length <= LOG_BODY_MAX_BYTES) { logParts.push(buf); logBytes += buf.length; }
                else { logOverflow = true; logParts.length = 0; }
            }
            pipe.enqueue(entry, Buffer.concat([Buffer.from(`${buf.length.toString(16)}\r\n`, 'latin1'), buf, CRLF_BUF]));
            pipe.applyBackpressure(entry);
            pipe.flush();
        },
        onEnd: (err) => {
            if (err) {
                dbg(`[mitm] ✗ stream ${url} ${err}${tag}\n`);
                entry.done = true;
                entry.out.length = 0;
                entry.queued = 0;
                if (err !== 'cancelled') { try { sock.destroy(); } catch { /* ignore */ } }
                return;
            }
            if (!noBody) pipe.enqueue(entry, CHUNK_TERMINATOR_BUF);
            entry.done = true;
            dbg(`[mitm] ⇣ ${url} streamed ${stream.bytes}B${tag}\n`);
            pipe.flush();
            if (!onComplete) return;
            let logBody = null;
            if (wantLogBody && !logOverflow && logBytes > 0) {
                const body = Buffer.concat(logParts);
                const ct = _headerVal(resOut.headers, 'content-type');
                logBody = _isBinaryContentType(ct) ? '__b64__:' + body.toString('base64') : body.toString('utf8');
            }
            try { onComplete(logBody); } catch { /* logging must not break the response */ }
        },
    });
}
function buildHttpResponse(res, requestUrl) {
    const payload = requestUrl ? absolutizeMitmRedirectResponse(res, requestUrl) : res;
    const statusCode = payload.statusCode || 200;
    const headers    = payload.headers || {};
    const statusText = STATUS_TEXT[statusCode] || 'OK';

    const bodyBuf = payload.bodyBase64 ? Buffer.from(payload.bodyBase64, 'base64') : Buffer.alloc(0);

    let headerStr = `HTTP/1.1 ${statusCode} ${statusText}\r\n`;
    headerStr += `Content-Length: ${bodyBuf.length}\r\n`;

    const skip = HOP_BY_HOP_HEADERS;
    for (const [k, v] of Object.entries(headers)) {
        if (!skip.has(k.toLowerCase())) {
            const vals = Array.isArray(v) ? v : [v];
            for (const val of vals) headerStr += `${k}: ${val}\r\n`;
        }
    }
    headerStr += '\r\n';
    return Buffer.concat([Buffer.from(headerStr, 'latin1'), bodyBuf]);
}

// ── External Proxy Port ──────────────────────────────────────────────────────
// Opens a MITM proxy on 0.0.0.0:PORT with Basic auth.
// Reuses the parent MitmProxy's AzureTLS worker + upstream proxy.
// Each port gets its own session in the DB for isolated logging.

class ExternalProxyPort {
    constructor(parentProxy, opts = {}) {
        this.parent     = parentProxy;
        this.port       = opts.port;
        this.login      = opts.login    || 'cupnet';
        this.password   = opts.password || '';
        this.name       = opts.name     || `ext:${opts.port}`;
        this.sessionId  = opts.sessionId || null;
        this.onRequestLogged = opts.onRequestLogged || null;
        this.followRedirects = opts.followRedirects || false;
        this._server    = null;
        this._connCount = 0;
        this._reqCount  = 0;
    }

    async start() {
        this._server = net.createServer(socket => this._handleConnection(socket));
        await new Promise((res, rej) => {
            this._server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    rej(new Error(`Port ${this.port} is already in use by another application`));
                } else {
                    rej(err);
                }
            });
            this._server.listen(this.port, '127.0.0.1', () => res());
        });
        console.log(`[ext-proxy] Listening on 127.0.0.1:${this.port} name="${this.name}"`);
        return this;
    }

    stop() {
        if (this._server) { this._server.close(); this._server = null; }
        console.log(`[ext-proxy] Stopped port ${this.port}`);
    }

    getStats() {
        return { port: this.port, name: this.name, connections: this._connCount, requests: this._reqCount, sessionId: this.sessionId };
    }

    _isLoopbackAddress(addr) {
        const a = String(addr || '').replace(/^::ffff:/i, '').toLowerCase();
        return a === '127.0.0.1' || a === '::1';
    }

    /**
     * Loopback clients (the port is bound to 127.0.0.1) skip Basic auth so a local
     * browser can use the port without a password. Any other remote address still
     * needs the configured login and password.
     */
    _checkAuth(headers, remoteAddress) {
        if (this._isLoopbackAddress(remoteAddress)) return true;
        const auth = headers['proxy-authorization'] || '';
        if (!auth) return false;
        const match = auth.match(/^Basic\s+(.+)$/i);
        if (!match) return false;
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const [login, ...passParts] = decoded.split(':');
        return login === this.login && passParts.join(':') === this.password;
    }

    _handleConnection(socket) {
        this._connCount++;
        socket.setTimeout(networkPolicy.timeouts.upstreamRequestMs, () => socket.destroy());
        socket.once('data', data => {
            const head = data.toString('utf8', 0, 8192);
            if (head.startsWith('CONNECT ')) {
                this._handleConnect(socket, head);
            } else {
                this._handleHttp(socket, head);
            }
        });
        socket.on('error', () => { try { socket.destroy(); } catch {} });
    }

    _rejectAuth(socket) {
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="CupNet External Proxy"\r\nContent-Length: 0\r\n\r\n');
        socket.end();
    }

    /** MITM not running (restart window) — answer instead of throwing on a null parent (A-106). */
    _rejectUnavailable(socket) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.end();
    }

    _logRequest(entry) {
        this._reqCount++;
        if (this.onRequestLogged) {
            this.onRequestLogged({
                ...entry,
                tabId: `ext_${this.port}`,
                sessionId: this.sessionId,
                source: 'external',
                extPort: this.port,
                extName: this.name,
            });
        }
    }

    _handleConnect(socket, head) {
        const req = parseHttpRequest(head);
        if (!req) { socket.destroy(); return; }
        if (!this._checkAuth(req.headers, socket.remoteAddress)) { this._rejectAuth(socket); return; }
        if (!this.parent) { this._rejectUnavailable(socket); return; }

        const line     = head.split('\r\n')[0];
        const hostport = line.split(' ')[1] || '';
        const [hostname, portStr] = hostport.split(':');
        const port = parseInt(portStr) || 443;
        const ctagExt = _clientTag(socket);

        socket.write('HTTP/1.0 200 Connection Established\r\n\r\n');
        socket.pause();
        const hsTimer = setTimeout(() => {
            dbg(`[ext-proxy] TLS handshake timeout ${hostname}:${port}\n`);
            try { socket.destroy(); } catch {}
        }, networkPolicy.timeouts.tlsHandshakeMs);

        getFakeCertAsync(hostname).then(fakeCert => {
            const tlsSocket = new tls.TLSSocket(socket, {
                isServer: true, key: fakeCert.key, cert: fakeCert.cert, rejectUnauthorized: false,
            });
            tlsSocket.once('secure', () => clearTimeout(hsTimer));
            socket.resume();

            // In-order responses; streams eligible bodies when CUPNET_MITM_STREAM is on.
            const pipe = createResponsePipeline(tlsSocket);

            const dispatchRequest = (r) => {
                const url = `https://${hostname}${port !== 443 ? ':' + port : ''}${r.path}`;
                const tabId = null;
                const headers = { ...r.headers };
                delete headers['proxy-authorization'];
                const hasBody = !!(r.body || r.bodyBase64);
                const orderedHeaders = (r.orderedHeaders || []).filter(([k]) => {
                    const kl = k.toLowerCase();
                    return kl !== 'proxy-authorization' && !(hasBody && SKIP_WHEN_BODY.includes(kl));
                });

                const entry = pipe.newEntry();
                const t0 = Date.now();
                const log = (res, resOut, logBody) => {
                    const dnsCorsMatch = !res.dnsOverride ? this.parent._mitmCorsMatchDetail(url) : null;
                    this._logRequest({
                        url, method: r.method, status: resOut.statusCode,
                        requestHeaders: headers, responseHeaders: resOut.headers,
                        requestBody: _reqBodyForLog(r), responseBody: logBody,
                        duration: Date.now() - t0,
                        type: inferMitmResourceType(url, r.method, headers, resOut.headers),
                        dnsOverride: res.dnsOverride || null,
                        dnsCorsMatch,
                    });
                };
                this.parent._doRequest({ method: r.method, url, headers, orderedHeaders, body: r.body, bodyBase64: r.bodyBase64, disableRedirects: !this.followRedirects, tabId, allowStream: true })
                    .then(res => {
                        const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, r.method, res);
                        if (res.stream) {
                            pipeStreamIntoEntry(pipe, entry, tlsSocket, {
                                res, resOut, method: r.method, url, tag: ctagExt,
                                wantLogBody: !!this.onRequestLogged,
                                onComplete: (logBody) => log(res, resOut, logBody),
                            });
                            return;
                        }
                        pipe.finish(entry, buildHttpResponse(resOut, url));
                        log(res, resOut, _logBodyFromResponse(resOut));
                    })
                    .catch((e) => {
                        dbg(`[mitm] ✗ ${url} ${e.message}${ctagExt}\n`);
                        const errRes = this.parent._build502Response(url, e.message, {
                            req: r, tabId, dnsOverride: e.mitmDnsOverride || null,
                        });
                        const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, r.method, errRes);
                        pipe.finish(entry, buildHttpResponse(resOut, url));
                    });
            };

            const MAX_INBUF = 10 * 1024 * 1024;
            const chunks = [];
            let chunksLen = 0;

            tlsSocket.on('data', chunk => {
                chunks.push(chunk);
                chunksLen += chunk.length;
                if (chunksLen > MAX_INBUF) { chunks.length = 0; chunksLen = 0; tlsSocket.destroy(); return; }
                let inBuf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
                chunks.length = 0;
                while (inBuf.length > 0) {
                    const sep = inBuf.indexOf('\r\n\r\n');
                    if (sep === -1) break;
                    const raw = inBuf.toString('utf8', 0, sep + 4);
                    const r = parseHttpRequest(raw);
                    if (!r) break;
                    let consumed = sep + 4;
                    const cl = parseInt(r.headers['content-length'] || '0', 10);
                    if (cl > 0) {
                        if (inBuf.length < consumed + cl) break;
                        const bodyBuf = inBuf.subarray(consumed, consumed + cl);
                        const isGzip = bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b;
                        const ce = (r.headers['content-encoding'] || '').toLowerCase();
                        const ct = (r.headers['content-type'] || '').toLowerCase();
                        if (isGzip || ce === 'gzip' || ce === 'br' || ce === 'deflate'
                            || ct.startsWith('multipart/')
                            || _isBinaryContentType(ct)) r.bodyBase64 = bodyBuf.toString('base64');
                        else r.body = bodyBuf.toString('utf8');
                        consumed += cl;
                    }
                    inBuf = inBuf.subarray(consumed);
                    dispatchRequest(r);
                }
                if (inBuf.length > 0) { chunks.push(inBuf); chunksLen = inBuf.length; }
                else chunksLen = 0;
            });
            tlsSocket.on('error', () => { clearTimeout(hsTimer); try { tlsSocket.destroy(); } catch {} });
            tlsSocket.on('close', () => { chunks.length = 0; chunksLen = 0; pipe.reset(); });
        }).catch(() => { clearTimeout(hsTimer); socket.destroy(); });
    }

    _handleHttp(socket, head) {
        const req = parseHttpRequest(head);
        if (!req) { socket.destroy(); return; }
        if (!this._checkAuth(req.headers, socket.remoteAddress)) { this._rejectAuth(socket); return; }
        if (!this.parent) { this._rejectUnavailable(socket); return; }

        const tabId = null;
        const hostHeader = (req.headers['host'] || req.headers['Host'] || '');
        const url = req.path.startsWith('http') ? req.path : `http://${hostHeader}${req.path}`;
        const headers = { ...req.headers };
        delete headers['proxy-authorization'];
        const hasBody = !!(req.body || req.bodyBase64);
        const orderedHeaders = (req.orderedHeaders || []).filter(([k]) => {
            const kl = k.toLowerCase();
            return kl !== 'proxy-authorization' && !(hasBody && SKIP_WHEN_BODY.includes(kl));
        });

        const ctagExtHttp = _clientTag(socket);
        const t0 = Date.now();
        // One request per plain-HTTP proxy connection: end the socket once the response is written.
        const pipe = createResponsePipeline(socket, { endWhenDone: true });
        const entry = pipe.newEntry();
        socket.on('close', () => pipe.reset());
        const log = (res, resOut, logBody) => {
            const dnsCorsMatch = !res.dnsOverride ? this.parent._mitmCorsMatchDetail(url) : null;
            this._logRequest({
                url, method: req.method, status: resOut.statusCode,
                requestHeaders: headers, responseHeaders: resOut.headers,
                requestBody: _reqBodyForLog(req), responseBody: logBody,
                duration: Date.now() - t0,
                type: inferMitmResourceType(url, req.method, headers, resOut.headers),
                dnsOverride: res.dnsOverride || null,
                dnsCorsMatch,
            });
        };
        this.parent._doRequest({ method: req.method, url, headers, orderedHeaders, body: req.body, bodyBase64: req.bodyBase64, disableRedirects: !this.followRedirects, tabId, allowStream: true })
            .then(res => {
                const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, req.method, res);
                if (res.stream) {
                    pipeStreamIntoEntry(pipe, entry, socket, {
                        res, resOut, method: req.method, url, tag: ctagExtHttp,
                        wantLogBody: !!this.onRequestLogged,
                        onComplete: (logBody) => log(res, resOut, logBody),
                    });
                    return;
                }
                pipe.finish(entry, buildHttpResponse(resOut, url));
                log(res, resOut, _logBodyFromResponse(resOut));
            })
            .catch((e) => {
                dbg(`[mitm] ✗ ${url} ${e.message}${ctagExtHttp}\n`);
                const errRes = this.parent._build502Response(url, e.message, {
                    req, tabId: null, dnsOverride: e.mitmDnsOverride || null,
                });
                const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes);
                pipe.finish(entry, buildHttpResponse(resOut, url));
            });
    }
}

// ── Module exports + standalone entry ────────────────────────────────────────

module.exports = {
    MitmProxy,
    ExternalProxyPort,
    generateCA,
    generateCAAsync,
    loadOrGenerateCA,
    getDebugMitmLevel,
    setDebugMitmLevel,
    buildMitmGatewayErrorResponse,
    isLikelyDocumentNavigation,
    summarizeMitmGatewayError,
    resolveMitmGatewayDnsContext,
    /** @internal used by tests/test-dns-mitm.js */
    _testApplyMitmCorsToResponse: applyMitmCorsToResponse,
    _testShouldSkipMitmCorsForUrl: shouldSkipMitmCorsForUrl,
    _testMatchHostPattern: _matchHostPattern,
    _shouldAutoRetryHttp1,
    _responseSuggestsHttp1Retry,
    IDENTITY_CHECK_HOST,
    /** @internal streaming (CUPNET_MITM_STREAM) — tests/unit/mitm-stream.test.mjs */
    _testWorkerFrameDecoder: WorkerFrameDecoder,
    _testWorkerBodyStream: WorkerBodyStream,
    _testBuildHttpResponseHead: buildHttpResponseHead,
    _testLogBodyFromResponse: _logBodyFromResponse,
    _testLogBodyMaxBytes: LOG_BODY_MAX_BYTES,
};

if (require.main === module) {
    const { caKeyPem, caCertPem } = generateCA();
    console.log('[mitm-proxy] CA cert generated');

    const proxy = new MitmProxy({
        browser:    'chrome',
    });

    proxy.start().then(() => {
        console.log('[mitm-proxy] Proxy URL:', proxy.getProxyUrl());
        console.log('[mitm-proxy] Use this URL in Chromium: --proxy-server=' + proxy.getProxyUrl());
        console.log('[mitm-proxy] CA cert PEM (trust this in Chromium):');
        console.log(proxy.getCACert());
    });
}
