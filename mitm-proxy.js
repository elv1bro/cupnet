'use strict';

/**
 * CupNet MITM Proxy
 *
 * Architecture:
 *   Chromium (--proxy-server=127.0.0.1:PORT)
 *     ↓  HTTP  → forward via AzureTLS worker
 *     ↓  HTTPS CONNECT → MITM:
 *         1. Accept CONNECT, reply 200
 *         2. Terminate Chromium's TLS with fake domain cert (Electron trusts it)
 *         3. Re-make the real request to destination via AzureTLS worker
 *         4. Stream response back to Chromium
 *
 * All outbound requests go through AzureTLS (TLS fingerprint = Chrome/Firefox profile).
 * Supports upstream proxy chaining.
 */

const net              = require('net');
const tls              = require('tls');
const crypto           = require('crypto');
const { EventEmitter } = require('events');
const { safeCatch } = require('./sys-log');
const { networkPolicy } = require('./network-policy');

// ── Pure Node.js CA + cert generation (no openssl binary needed) ──────────────
// Works on macOS, Windows, Linux without any system dependencies.

let caKey, caCert, caKeyPem, caCertPem;

/**
 * Encode ASN.1 TLV
 */
function asn1(tag, ...contents) {
    const body = Buffer.concat(contents.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c)));
    const len  = body.length;
    let lenBuf;
    if (len < 0x80) {
        lenBuf = Buffer.from([len]);
    } else if (len < 0x100) {
        lenBuf = Buffer.from([0x81, len]);
    } else {
        lenBuf = Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
    }
    return Buffer.concat([Buffer.from([tag]), lenBuf, body]);
}

const SEQ  = c => asn1(0x30, ...c);
const SET  = c => asn1(0x31, ...c);
const OID  = b => asn1(0x06, b);
const INT  = b => asn1(0x02, b);
const BIT  = b => asn1(0x03, Buffer.concat([Buffer.from([0x00]), b]));
const OCT  = b => asn1(0x04, b);
const UTF8 = s => asn1(0x0c, Buffer.from(s, 'utf8'));
const ctx  = (n, b) => asn1(0xa0 | n, b);
const RAW  = b => b;

// OIDs
const OID_ecPublicKey    = Buffer.from('2a8648ce3d0201', 'hex');
const OID_prime256v1     = Buffer.from('2a8648ce3d030107', 'hex');
const OID_sha256withECDSA= Buffer.from('2a8648ce3d040302', 'hex');
const OID_commonName     = Buffer.from('550403', 'hex');  // 2.5.4.3
const OID_organization   = Buffer.from('55040a', 'hex'); // 2.5.4.10
const OID_countryName    = Buffer.from('550406', 'hex'); // 2.5.4.6
const OID_subjectAltName = Buffer.from('551d11', 'hex');
const OID_basicConstraints = Buffer.from('551d13', 'hex');
const OID_subjectKeyId   = Buffer.from('551d0e', 'hex');
const OID_authorityKeyId = Buffer.from('551d23', 'hex');

function encodeRDN(oidHex, value) {
    return SET([SEQ([OID(Buffer.from(oidHex, 'hex')), UTF8(value)])]);
}

function encodeTime(date) {
    // GeneralizedTime: YYYYMMDDHHmmssZ
    const s = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    return asn1(0x18, Buffer.from(s, 'ascii'));
}

function encodeSerial(n) {
    let h = n.toString(16);
    if (h.length % 2) h = '0' + h;
    let b = Buffer.from(h, 'hex');
    // Ensure positive (no high bit set)
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return INT(b);
}

function derPublicKey(keyObj) {
    // SubjectPublicKeyInfo for EC P-256
    const rawPub = keyObj.export({ type: 'spki', format: 'der' });
    return rawPub; // Node.js already gives us SPKI DER
}

function buildCert({ subjectCN, subjectOrg, issuerCN, serial, notBefore, notAfter,
                     pubKeyDer, signerKey, isCA, san, authorityKeyIdBytes }) {

    const subject = subjectOrg
        ? SEQ([encodeRDN('550403', subjectCN), encodeRDN('55040a', subjectOrg), encodeRDN('550406', 'US')])
        : SEQ([encodeRDN('550403', subjectCN)]);

    const issuer = issuerCN === subjectCN && subjectOrg
        ? subject
        : SEQ([encodeRDN('550403', issuerCN)]);

    const extensions = [];

    // Basic Constraints
    const bcValue = isCA
        ? SEQ([asn1(0x01, Buffer.from([0xff]))])  // cA=TRUE
        : SEQ([]);
    extensions.push(SEQ([OID(OID_basicConstraints),
        asn1(0x01, Buffer.from([0xff])),  // critical
        OCT(bcValue)]));

    // Subject Key Identifier
    const pubKeyHash = crypto.createHash('sha1')
        .update(Buffer.from(pubKeyDer).slice(-65)) // last 65 bytes = uncompressed EC point
        .digest();
    extensions.push(SEQ([OID(OID_subjectKeyId), OCT(OCT(pubKeyHash))]));

    // Authority Key Identifier (for domain certs)
    if (authorityKeyIdBytes) {
        extensions.push(SEQ([OID(OID_authorityKeyId),
            OCT(SEQ([ctx(0, authorityKeyIdBytes)]))]));
    }

    // Subject Alternative Name
    if (san) {
        const sanExt = SEQ([asn1(0x82, Buffer.from(san, 'ascii'))]);
        extensions.push(SEQ([OID(OID_subjectAltName), OCT(sanExt)]));
    }

    const tbsCert = SEQ([
        ctx(0, asn1(0x02, Buffer.from([0x02]))),  // version = v3
        encodeSerial(serial),
        SEQ([OID(OID_sha256withECDSA)]),
        issuer,
        SEQ([encodeTime(notBefore), encodeTime(notAfter)]),
        subject,
        RAW(Buffer.from(pubKeyDer)),
        ctx(3, SEQ(extensions)),
    ]);

    const sig = crypto.sign('SHA256', tbsCert, signerKey);
    return SEQ([RAW(tbsCert), SEQ([OID(OID_sha256withECDSA)]), BIT(sig)]);
}

function derToPem(tag, der) {
    const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN ${tag}-----\n${b64}\n-----END ${tag}-----\n`;
}

function generateCA() {
    caKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    _finishCA(caKey.publicKey, caKey.privateKey);
    return { caKeyPem, caCertPem };
}

/**
 * Load existing CA from disk or generate a new one and save it.
 * @param {string} dir — directory to store ca-key.pem + ca-cert.pem
 * @returns {{ caKeyPem: string, caCertPem: string, generated: boolean }}
 */
function loadOrGenerateCA(dir) {
    const keyFile  = path.join(dir, 'ca-key.pem');
    const certFile = path.join(dir, 'ca-cert.pem');

    try {
        if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
            const savedKey  = fs.readFileSync(keyFile, 'utf8');
            const savedCert = fs.readFileSync(certFile, 'utf8');
            caKey = crypto.createPrivateKey(savedKey);
            caKey = { publicKey: crypto.createPublicKey(caKey), privateKey: caKey };
            caKeyPem  = savedKey;
            caCertPem = savedCert;
            const certDer = Buffer.from(
                savedCert.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64'
            );
            caCert = certDer;
            return { caKeyPem, caCertPem, generated: false };
        }
    } catch (e) {
        // Corrupted files — regenerate
    }

    generateCA();
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(keyFile, caKeyPem, { mode: 0o600 });
        fs.writeFileSync(certFile, caCertPem, { mode: 0o644 });
    } catch (e) {
        // Non-fatal — CA works in memory, just won't persist
    }
    return { caKeyPem, caCertPem, generated: true };
}

function generateCAAsync() {
    // Async version — doesn't block event loop at all
    return new Promise((resolve, reject) => {
        crypto.generateKeyPair('ec', { namedCurve: 'P-256' }, (err, pubKey, privKey) => {
            if (err) return reject(err);
            caKey = { publicKey: pubKey, privateKey: privKey };
            _finishCA(pubKey, privKey);
            resolve({ caKeyPem, caCertPem });
        });
    });
}

function _finishCA(pubKey, privKey) {
    const pubDer = pubKey.export({ type: 'spki', format: 'der' });
    const now  = new Date();
    const then = new Date(now); then.setFullYear(then.getFullYear() + 10);

    const certDer = buildCert({
        subjectCN:  'CupNet MITM CA',
        subjectOrg: 'CupNet',
        issuerCN:   'CupNet MITM CA',
        serial:     Date.now(),
        notBefore:  now,
        notAfter:   then,
        pubKeyDer:  pubDer,
        signerKey:  privKey,
        isCA:       true,
        san:        null,
        authorityKeyIdBytes: null,
    });

    caKeyPem  = privKey.export({ type: 'pkcs8', format: 'pem' });
    caCertPem = derToPem('CERTIFICATE', certDer);
    caCert    = certDer;
}

// Domain cert cache — LRU capped at 500 entries to prevent unbounded growth
const CERT_CACHE_MAX = 500;
const domainCertCache = new Map();
function cacheCert(hostname, cert) {
    if (domainCertCache.size >= CERT_CACHE_MAX) {
        // Evict oldest entry (Map preserves insertion order)
        domainCertCache.delete(domainCertCache.keys().next().value);
    }
    domainCertCache.set(hostname, cert);
}

// Async version to avoid blocking event loop during parallel domain handshakes
const domainCertPending = new Map(); // hostname → Promise<cert>

function getFakeCert(hostname) {
    // Sync fast-path: already cached — LRU touch (move to end of Map insertion order)
    if (domainCertCache.has(hostname)) {
        const c = domainCertCache.get(hostname);
        domainCertCache.delete(hostname);
        domainCertCache.set(hostname, c);
        return c;
    }
    // Fallback: generate synchronously (first miss — should be rare with async path)
    return _generateDomainCert(hostname);
}

function getFakeCertAsync(hostname) {
    if (domainCertCache.has(hostname)) {
        const c = domainCertCache.get(hostname);
        domainCertCache.delete(hostname);
        domainCertCache.set(hostname, c);
        return Promise.resolve(c);
    }
    if (domainCertPending.has(hostname)) return domainCertPending.get(hostname);
    const p = new Promise((resolve, reject) => {
        crypto.generateKeyPair('ec', { namedCurve: 'P-256' }, (err, pubKey, privKey) => {
            if (err) return reject(err);
            try {
                const result = _buildDomainCert(hostname, pubKey, privKey);
                cacheCert(hostname, result);
                resolve(result);
            } catch (e) { reject(e); }
        });
    }).finally(() => domainCertPending.delete(hostname));
    domainCertPending.set(hostname, p);
    return p;
}

function _generateDomainCert(hostname) {
    const domKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const result = _buildDomainCert(hostname, domKey.publicKey, domKey.privateKey);
    cacheCert(hostname, result);
    return result;
}

function _buildDomainCert(hostname, pubKey, privKey) {
    const pubDer = pubKey.export({ type: 'spki', format: 'der' });
    const now    = new Date();
    const then   = new Date(now); then.setFullYear(then.getFullYear() + 2);
    const caPubDer = caKey.publicKey.export({ type: 'spki', format: 'der' });
    const caKeyId  = crypto.createHash('sha1').update(Buffer.from(caPubDer).slice(-65)).digest();
    const certDer  = buildCert({
        subjectCN:   hostname,
        subjectOrg:  null,
        issuerCN:    'CupNet MITM CA',
        serial:      Date.now() + Math.floor(Math.random() * 1000),
        notBefore:   now,
        notAfter:    then,
        pubKeyDer:   pubDer,
        signerKey:   caKey.privateKey,
        isCA:        false,
        san:         hostname,
        authorityKeyIdBytes: caKeyId,
    });
    return {
        key:  privKey.export({ type: 'pkcs8', format: 'pem' }),
        cert: derToPem('CERTIFICATE', certDer),
    };
}

// ── AzureTLS worker pool ──────────────────────────────────────────────────────

const { spawn } = require('child_process');
const path = require('path');
const DEBUG_MITM = process.env.CUPNET_DEBUG_MITM === '1';
function dbg(msg) { if (DEBUG_MITM) process.stderr.write(msg); }

class AzureTLSWorker extends EventEmitter {
    constructor(workerPath) {
        super();
        this.workerPath = workerPath;
        this.pending    = new Map();
        this.ready      = false;
        this._stopped   = false;
        this._bufParts  = [];
        this._restartDelay = 1000;
        this._restartCount = 0;
        this._inflightRequests = 0;
        this._stdinQueue = [];
        this._stdinDraining = false;
        this._start();
    }

    _start() {
        // Determine the correct node binary:
        //   1. Inside a packaged Electron app: use Electron's bundled Node.js
        //      (set ELECTRON_RUN_AS_NODE so the Electron binary acts as node)
        //   2. Development / system node available: use 'node'
        // The worker process loads ffi-napi compiled for the SAME node ABI,
        // so we must match the runtime that was used during npm install.
        const isPackaged  = process.defaultApp === false && !process.env.ELECTRON_IS_DEV;
        const isElectron  = !!(process.versions && process.versions.electron);
        let nodeBin, env;
        if (isPackaged && isElectron) {
            nodeBin = process.execPath;
            env = {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                UV_THREADPOOL_SIZE: '32',
                // main.js выставляет NODE_EXTRA_CA_CERTS до require('electron') — воркер наследует для TLS к MITM/upstream
                NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || '',
            };
        } else {
            nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
            env = {
                ...process.env,
                UV_THREADPOOL_SIZE: '32',
                NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || '',
            };
        }

        this.proc = spawn(nodeBin, [this.workerPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        this._stdinQueue = [];
        this._stdinDraining = false;

        // Redirect worker stderr only in debug mode (very noisy in production)
        this.proc.stderr.on('data', d => { if (DEBUG_MITM) process.stderr.write('[azure-worker] ' + d); });

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
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === '__init__') {
                        this.ready = true;
                        this._restartDelay = 1000;
                        this.emit('worker-ready');
                        this.emit('ready');
                    } else {
                        const entry = this.pending.get(msg.id);
                        if (entry) {
                            this.pending.delete(msg.id);
                            const cb = typeof entry === 'function' ? entry : entry.cb;
                            if (entry.timer) clearTimeout(entry.timer);
                            cb(null, msg);
                        }
                    }
                } catch (e) { /* ignore malformed lines */ }
            }
        });

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
            this._inflightRequests = 0;
            if (this._stopped) return;
            const delay = this._restartDelay;
            this._restartDelay = Math.min(delay * 2, 30000);
            this._restartCount++;
            this.emit('worker-exited', { code, delayMs: delay, restartCount: this._restartCount });
            if (DEBUG_MITM) console.error(`[azure-worker] exited (${code}), restart in ${delay}ms`);
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
        try { this.proc?.kill(); } catch (err) {
            safeCatch({ module: 'mitm-proxy', eventCode: 'worker.shutdown.failed', context: { op: 'proc.kill' } }, err);
        }
    }

    waitReady() {
        if (this.ready) return Promise.resolve();
        return new Promise(resolve => this.once('ready', resolve));
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

// ── MITM Proxy Server ─────────────────────────────────────────────────────────

const CUPNET_HEADERS = ['x-cupnet-tabid', 'x-cupnet-sessionid', 'x-cupnet-requestid'];
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

function _buildProxyAuthorizationHeader(upstreamUrl) {
    const username = upstreamUrl?.username ? decodeURIComponent(upstreamUrl.username) : '';
    const password = upstreamUrl?.password ? decodeURIComponent(upstreamUrl.password) : '';
    if (!username && !password) return '';
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

class MitmProxy {
    constructor(opts = {}) {
        this.port       = opts.port != null ? opts.port : networkPolicy.mitmPort;
        this.browser    = opts.browser || 'chrome_120';
        this.upstream   = opts.upstream || null;
        this.workerPath = opts.workerPath;
        this.onRequestLogged = opts.onRequestLogged || null;
        this.worker     = new AzureTLSWorker(this.workerPath);
        this._server    = null;
        this._activeJa3 = null;
        this._dnsOverrides = new Map();
        /** @type {string[]} паттерны хоста из DNS rules с mitm_inject_cors (exact или *.suffix, см. _matchHostPattern). */
        this._dnsCorsPatterns = [];
        this._tlsPassthroughDomains = [...DEFAULT_TLS_PASSTHROUGH];

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

    setUpstream(proxyUrl) { this.upstream = proxyUrl || null; }

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

    setDnsOverrides(rules = []) {
        const next = new Map();
        const corsPatterns = [];
        for (const r of (rules || [])) {
            if (!r || r.enabled === false) continue;
            const host = String(r.host || '').trim().toLowerCase();
            const ip = String(r.ip || '').trim();
            if (!host) continue;
            if (ip && !host.startsWith('*.')) next.set(host, ip);
            if (r.mitm_inject_cors === true) corsPatterns.push(host);
        }
        this._dnsOverrides = next;
        this._dnsCorsPatterns = corsPatterns;
        if (corsPatterns.length || next.size) {
            console.log(`[mitm-proxy] DNS overrides: ${next.size} IPs, CORS patterns: [${corsPatterns.join(', ')}]`);
        }
        this.worker.clearSessions().catch(() => {});
    }

    _mitmCorsEnabledForUrl(urlStr) {
        let u;
        try { u = new URL(urlStr); } catch { return false; }
        const h = (u.hostname || '').toLowerCase();
        for (const p of this._dnsCorsPatterns) {
            if (_matchHostPattern(p, h)) return true;
        }
        return false;
    }

    async start() {
        await this.worker.waitReady();

        this._server = net.createServer(socket => this._handleConnection(socket));
        await new Promise((res, rej) =>
            this._server.listen(this.port, '127.0.0.1', err => err ? rej(err) : res())
        );
        console.log(`[mitm-proxy] Listening on 127.0.0.1:${this.port} (browser=${this.browser})`);
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
                dbg(`[mitm] CONNECT ${hostport}\n`);
                this._handleConnect(socket, head, data);
            } else {
                this._handleHttp(socket, head, data);
            }
        });
        socket.on('error', () => { try { socket.destroy(); } catch {} });
    }

    // ── HTTPS CONNECT ──────────────────────────────────────────────────────────
    _handleConnect(socket, head) {
        const line     = head.split('\r\n')[0];
        const hostport = line.split(' ')[1] || '';
        const [hostname, portStr] = hostport.split(':');
        const port = parseInt(portStr) || 443;

        if (this._shouldTlsPassthrough(hostname)) {
            this._handleConnectPassthrough(socket, hostname, port);
            return;
        }

        socket.write('HTTP/1.0 200 Connection Established\r\n\r\n');
        socket.pause(); // Prevent losing TLS ClientHello before we're ready
        const hsTimer = setTimeout(() => {
            dbg(`[mitm] TLS handshake timeout ${hostname}:${port}\n`);
            try { socket.destroy(); } catch {}
        }, networkPolicy.timeouts.tlsHandshakeMs);

        getFakeCertAsync(hostname).then(fakeCert => {
        const tlsSocket = new tls.TLSSocket(socket, {
            isServer:           true,
            key:                fakeCert.key,
            cert:               fakeCert.cert,
            rejectUnauthorized: false,
        });
        tlsSocket.once('secure', () => clearTimeout(hsTimer));
        socket.resume();

        // Parallel pipeline: fire requests as they arrive, write responses in order
        let inBuf = Buffer.alloc(0);
        // Each entry: { promise, written: false }
        const pipeline = [];
        let writing = false;

        const flushPipeline = () => {
            if (writing) return;
            writing = true;
            while (pipeline.length > 0 && pipeline[0].done) {
                const entry = pipeline.shift();
                if (tlsSocket.writable) {
                    try { tlsSocket.write(entry.data); } catch {}
                }
            }
            writing = false;
            // If more entries finished while we were flushing, loop again
            if (pipeline.length > 0 && pipeline[0].done) flushPipeline();
        };

        const dispatchRequest = (req) => {
            const url = `https://${hostname}${port !== 443 ? ':' + port : ''}${req.path}`;
            const tabId = req.headers['x-cupnet-tabid'] || null;
            const sessionId = req.headers['x-cupnet-sessionid'] || null;
            const requestId = req.headers['x-cupnet-requestid'] || `mitm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const headers = { ...req.headers };
            for (const k of CUPNET_HEADERS) delete headers[k];
            const hasBody = !!(req.body || req.bodyBase64);
            const orderedHeaders = (req.orderedHeaders || []).filter(([k]) => {
                const kl = k.toLowerCase();
                if (CUPNET_HEADERS.includes(kl)) return false;
                if (hasBody && SKIP_WHEN_BODY.includes(kl)) return false;
                return true;
            });
            dbg(`[mitm] → ${req.method} ${url}\n`);

            // CORS preflight: отвечаем 204 локально — upstream может отклонить OPTIONS (SNI/Host),
            // а браузер требует 2xx на preflight, иначе считает CORS-ошибкой.
            if (req.method === 'OPTIONS' && this._mitmCorsEnabledForUrl(url)) {
                const origin = _resolveCorsAllowOrigin(headers);
                if (origin) {
                    const reqM = _reqHeader(headers, 'Access-Control-Request-Method');
                    const reqH = _reqHeader(headers, 'Access-Control-Request-Headers');
                    const preflightRes = {
                        statusCode: 204, bodyBase64: '',
                        headers: {
                            'Access-Control-Allow-Origin': origin,
                            'Access-Control-Allow-Credentials': 'true',
                            'Access-Control-Allow-Methods': reqM || 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
                            'Access-Control-Allow-Headers': reqH || '*',
                            'Access-Control-Max-Age': '86400',
                        },
                    };
                    dbg(`[mitm-cors] PREFLIGHT 204 origin=${origin} ${url}\n`);
                    const entry = { done: true, data: buildHttpResponse(preflightRes) };
                    pipeline.push(entry);
                    flushPipeline();
                    return;
                }
            }

            const entry = { done: false, data: null };
            pipeline.push(entry);
            const t0 = Date.now();
            this._doRequest({ method: req.method, url, headers, orderedHeaders, body: req.body, bodyBase64: req.bodyBase64, requestId })
                .then(res  => {
                    dbg(`[mitm] ← ${url} status=${res.statusCode}\n`);
                    const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, res);
                    entry.data = buildHttpResponse(resOut);
                    if (this.onRequestLogged) {
                        let logBody = null;
                        if (resOut.bodyBase64) {
                            const ct = _headerVal(resOut.headers, 'content-type');
                            if (_isBinaryContentType(ct)) {
                                logBody = '__b64__:' + resOut.bodyBase64;
                            } else {
                                try { logBody = Buffer.from(resOut.bodyBase64, 'base64').toString('utf8'); } catch {}
                            }
                        }
                        const reqBodyForLog = req.body || (req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64').toString('utf8') : null);
                        this.onRequestLogged({
                            url, method: req.method, tabId, sessionId, requestId,
                            status: resOut.statusCode, requestHeaders: headers,
                            responseHeaders: resOut.headers, requestBody: reqBodyForLog,
                            responseBody: logBody, duration: Date.now() - t0, type: 'Document',
                        });
                    }
                })
                .catch((e) => {
                    dbg(`[mitm] ✗ ${url} ${e.message}\n`);
                    const errRes = { statusCode: 502, headers: {}, bodyBase64: '' };
                    const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes);
                    entry.data = buildHttpResponse(resOut);
                })
                .finally(() => { entry.done = true; flushPipeline(); });
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
                    if (isGzip || ce === 'gzip' || ce === 'br' || ce === 'deflate') {
                        req.bodyBase64 = bodyBuf.toString('base64');
                    } else {
                        req.body = bodyBuf.toString('utf8');
                    }
                    consumed += cl;
                }
                inBuf = inBuf.subarray(consumed);
                dispatchRequest(req);
            }
            if (inBuf.length > 0) { chunks.push(inBuf); chunksLen = inBuf.length; }
            else { chunksLen = 0; }
        });
        tlsSocket.on('error', () => { clearTimeout(hsTimer); try { tlsSocket.destroy(); } catch {} });
        tlsSocket.on('close', () => { chunks.length = 0; chunksLen = 0; pipeline.length = 0; });
        }).catch((e) => { clearTimeout(hsTimer); dbg(`[mitm] cert error ${hostname}: ${e?.message}\n`); socket.destroy(); });
    }

    _handleConnectPassthrough(clientSocket, hostname, port) {
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

        if (!this.upstream) {
            const upstreamSocket = net.connect(port, hostname);
            upstreamSocket.setTimeout(networkPolicy.timeouts.upstreamRequestMs, () => upstreamSocket.destroy());
            upstreamSocket.once('connect', () => attachTunnel(upstreamSocket));
            upstreamSocket.once('error', fail);
            return;
        }

        let upstreamUrl;
        try {
            upstreamUrl = new URL(this.upstream);
        } catch (err) {
            fail(err);
            return;
        }
        const proxyHost = upstreamUrl.hostname;
        const proxyPort = Number(upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80));
        const upstreamSocket = net.connect(proxyPort, proxyHost);
        upstreamSocket.setTimeout(networkPolicy.timeouts.upstreamRequestMs, () => upstreamSocket.destroy());
        upstreamSocket.once('connect', () => {
            const proxyAuth = _buildProxyAuthorizationHeader(upstreamUrl);
            const lines = [
                `CONNECT ${target} HTTP/1.1`,
                `Host: ${target}`,
                'Proxy-Connection: Keep-Alive',
                'Connection: Keep-Alive',
            ];
            if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
            const connectReq = `${lines.join('\r\n')}\r\n\r\n`;
            upstreamSocket.write(connectReq);
        });
        upstreamSocket.once('error', fail);

        let respBuf = Buffer.alloc(0);
        const onResp = (chunk) => {
            respBuf = Buffer.concat([respBuf, chunk]);
            const sep = respBuf.indexOf('\r\n\r\n');
            if (sep === -1) {
                if (respBuf.length > 16 * 1024) {
                    upstreamSocket.removeListener('data', onResp);
                    fail(new Error('Upstream CONNECT response too large'));
                }
                return;
            }
            upstreamSocket.removeListener('data', onResp);
            const head = respBuf.toString('utf8', 0, sep);
            if (!/^HTTP\/1\.[01]\s+200\b/i.test(head)) {
                const firstLine = (head.split('\r\n')[0] || '').trim();
                fail(new Error(`Upstream CONNECT rejected for ${target}: ${firstLine || 'unknown status'}`));
                try { upstreamSocket.destroy(); } catch {}
                return;
            }
            const remaining = respBuf.subarray(sep + 4);
            attachTunnel(upstreamSocket, remaining);
        };
        upstreamSocket.on('data', onResp);
    }

    // ── Plain HTTP ─────────────────────────────────────────────────────────────
    _handleHttp(socket, head) {
        const req = parseHttpRequest(head);
        if (!req) { socket.destroy(); return; }

        // Reconstruct absolute URL
        const hostHeader = (req.headers['host'] || req.headers['Host'] || '');
        const url = req.path.startsWith('http') ? req.path : `http://${hostHeader}${req.path}`;
        const hasBody = !!(req.body || req.bodyBase64);
        const orderedHeaders = (req.orderedHeaders || []).filter(([k]) => {
            const kl = k.toLowerCase();
            if (CUPNET_HEADERS.includes(kl)) return false;
            if (hasBody && SKIP_WHEN_BODY.includes(kl)) return false;
            return true;
        });

        if (req.method === 'OPTIONS' && this._mitmCorsEnabledForUrl(url)) {
            const origin = _resolveCorsAllowOrigin(req.headers);
            if (origin) {
                const reqM = _reqHeader(req.headers, 'Access-Control-Request-Method');
                const reqH = _reqHeader(req.headers, 'Access-Control-Request-Headers');
                dbg(`[mitm-cors] PREFLIGHT 204 origin=${origin} ${url}\n`);
                socket.write(buildHttpResponse({
                    statusCode: 204, bodyBase64: '',
                    headers: {
                        'Access-Control-Allow-Origin': origin,
                        'Access-Control-Allow-Credentials': 'true',
                        'Access-Control-Allow-Methods': reqM || 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
                        'Access-Control-Allow-Headers': reqH || '*',
                        'Access-Control-Max-Age': '86400',
                    },
                }));
                socket.end();
                return;
            }
        }

        this._doRequest({
            method: req.method,
            url,
            headers: req.headers,
            orderedHeaders,
            body: req.body,
            bodyBase64: req.bodyBase64,
            requestId: req.headers['x-cupnet-requestid'] || `mitm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        })
            .then(res => {
                const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, req.headers, req.method, res);
                const resp = buildHttpResponse(resOut);
                socket.write(resp);
                socket.end();
            })
            .catch((e) => {
                dbg(`[mitm] ✗ ${url} ${e.message}\n`);
                const errRes = { statusCode: 502, headers: {}, bodyBase64: '' };
                const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, req.headers, req.method, errRes);
                socket.write(buildHttpResponse(resOut));
                socket.end();
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
        if (dnsAdjusted.dnsOverride && DEBUG_MITM) {
            const d = dnsAdjusted.dnsOverride;
            dbg(`[mitm][dns] ${d.host} -> ${d.ip}\n`);
        }
        // YouTube/googlevideo: HTTP/2 → PROTOCOL_ERROR; force HTTP/1.1
        // CUPNET_FORCE_HTTP1=1 — force for ALL requests (debug)
        let forceHttp1 = process.env.CUPNET_FORCE_HTTP1 === '1';
        if (!forceHttp1) {
            try {
                const host = new URL(url).hostname || '';
                forceHttp1 = /\.(youtube|googlevideo)\.com$/i.test(host);
            } catch {}
        }
        // DNS override: HTTP/2 `:authority` берётся из URL (IP) — шлюз его не маршрутизирует.
        // HTTP/1.1 + fhttp уважает Host из OrderedHeaders — форсируем HTTP/1.1.
        if (dnsAdjusted.dnsOverride) forceHttp1 = true;

        const noBody = /^(GET|HEAD)$/i.test(opts.method || '');
        const retryCount = /^(GET|HEAD|OPTIONS)$/i.test(opts.method || '')
            ? networkPolicy.retry.maxRetries
            : 0;
        try {
            const res = await this.worker.request({
                method:            dnsAdjusted.method,
                url:               dnsAdjusted.url,
                headers:           dnsAdjusted.headers,
                orderedHeaders:    dnsAdjusted.orderedHeaders || undefined,
                body:              noBody ? undefined : (dnsAdjusted.bodyBase64 ? undefined : (dnsAdjusted.body || null)),
                bodyBase64:        noBody ? undefined : (dnsAdjusted.bodyBase64 || undefined),
                proxy:             this.upstream || null,
                browser:           this.browser,
                ja3:               this._activeJa3 || undefined,
                requestId:         opts.requestId || undefined,
                maxRetries:        retryCount,
                timeout:           networkPolicy.timeouts.upstreamRequestMs,
                disableRedirects:  opts.disableRedirects !== false,
                forceHttp1:         forceHttp1,
            });
            const ms = Date.now() - t0;
            st.totalMs += ms;
            if (ms < st.minMs) st.minMs = ms;
            if (ms > st.maxMs) st.maxMs = ms;
            return {
                statusCode: res.statusCode,
                headers: res.headers || {},
                bodyBase64: res.bodyBase64 || '',
                dnsOverride: dnsAdjusted.dnsOverride || null,
            };
        } catch (e) {
            st.errors++;
            throw e;
        } finally {
            st.pending--;
        }
    }

    _applyDnsOverride(opts) {
        const sourceUrl = String(opts?.url || '');
        if (!sourceUrl || this._dnsOverrides.size === 0) return { ...opts };

        let u;
        try { u = new URL(sourceUrl); } catch { return { ...opts }; }
        const host = (u.hostname || '').toLowerCase();
        if (!host) return { ...opts };

        const overrideIp = this._dnsOverrides.get(host);
        if (!overrideIp) return { ...opts };

        const overriddenUrl = new URL(sourceUrl);
        overriddenUrl.hostname = overrideIp;

        const explicitPort = u.port || (u.protocol === 'https:' ? '443' : '80');
        const includePort =
            (u.protocol === 'https:' && explicitPort !== '443') ||
            (u.protocol === 'http:' && explicitPort !== '80');
        const logicalHostHeader = includePort ? `${host}:${explicitPort}` : host;

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
            headers: nextHeaders,
            orderedHeaders: nextOrdered,
            dnsOverride: { host, ip: overrideIp },
        };
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
    getCACert()    { return caCertPem; }
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
        if (DEBUG_MITM && enabled === false) dbg(`[mitm-cors] SKIP (not enabled) ${url}\n`);
        return res;
    }
    if (shouldSkipMitmCorsForUrl(url)) return res;
    const origin = _resolveCorsAllowOrigin(requestHeaders);
    if (!origin) {
        if (DEBUG_MITM) dbg(`[mitm-cors] SKIP (no origin/referer) ${url}\n`);
        return res;
    }
    if (DEBUG_MITM) dbg(`[mitm-cors] INJECT origin=${origin} method=${requestMethod} status=${res.statusCode} ${url}\n`);

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
function buildHttpResponse(res) {
    const statusCode = res.statusCode || 200;
    const headers    = res.headers || {};
    const statusText = STATUS_TEXT[statusCode] || 'OK';

    const bodyBuf = res.bodyBase64 ? Buffer.from(res.bodyBase64, 'base64') : Buffer.alloc(0);

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

    _checkAuth(headers) {
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
        if (!this._checkAuth(req.headers)) { this._rejectAuth(socket); return; }

        const line     = head.split('\r\n')[0];
        const hostport = line.split(' ')[1] || '';
        const [hostname, portStr] = hostport.split(':');
        const port = parseInt(portStr) || 443;

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

            const pipeline = [];
            let writing = false;

            const flushPipeline = () => {
                if (writing) return;
                writing = true;
                while (pipeline.length > 0 && pipeline[0].done) {
                    const entry = pipeline.shift();
                    if (tlsSocket.writable) { try { tlsSocket.write(entry.data); } catch {} }
                }
                writing = false;
                if (pipeline.length > 0 && pipeline[0].done) flushPipeline();
            };

            const dispatchRequest = (r) => {
                const url = `https://${hostname}${port !== 443 ? ':' + port : ''}${r.path}`;
                const headers = { ...r.headers };
                delete headers['proxy-authorization'];
                for (const k of CUPNET_HEADERS) delete headers[k];
                const hasBody = !!(r.body || r.bodyBase64);
                const orderedHeaders = (r.orderedHeaders || []).filter(([k]) => {
                    const kl = k.toLowerCase();
                    return kl !== 'proxy-authorization' && !CUPNET_HEADERS.includes(kl) && !(hasBody && SKIP_WHEN_BODY.includes(kl));
                });

                if (r.method === 'OPTIONS' && this.parent._mitmCorsEnabledForUrl(url)) {
                    const origin = _resolveCorsAllowOrigin(headers);
                    if (origin) {
                        const reqM = _reqHeader(headers, 'Access-Control-Request-Method');
                        const reqH = _reqHeader(headers, 'Access-Control-Request-Headers');
                        dbg(`[mitm-cors] PREFLIGHT 204 origin=${origin} ${url}\n`);
                        const entry = { done: true, data: buildHttpResponse({
                            statusCode: 204, bodyBase64: '',
                            headers: {
                                'Access-Control-Allow-Origin': origin,
                                'Access-Control-Allow-Credentials': 'true',
                                'Access-Control-Allow-Methods': reqM || 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
                                'Access-Control-Allow-Headers': reqH || '*',
                                'Access-Control-Max-Age': '86400',
                            },
                        }) };
                        pipeline.push(entry);
                        flushPipeline();
                        return;
                    }
                }

                const entry = { done: false, data: null };
                pipeline.push(entry);
                const t0 = Date.now();
                this.parent._doRequest({ method: r.method, url, headers, orderedHeaders, body: r.body, bodyBase64: r.bodyBase64, disableRedirects: !this.followRedirects })
                    .then(res => {
                        const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, r.method, res);
                        entry.data = buildHttpResponse(resOut);
                        let logBody = null;
                        if (resOut.bodyBase64) {
                            const ct = _headerVal(resOut.headers, 'content-type');
                            if (_isBinaryContentType(ct)) logBody = '__b64__:' + resOut.bodyBase64;
                            else { try { logBody = Buffer.from(resOut.bodyBase64, 'base64').toString('utf8'); } catch {} }
                        }
                        const reqBody = r.body || (r.bodyBase64 ? Buffer.from(r.bodyBase64, 'base64').toString('utf8') : null);
                        this._logRequest({
                            url, method: r.method, status: resOut.statusCode,
                            requestHeaders: headers, responseHeaders: resOut.headers,
                            requestBody: reqBody, responseBody: logBody,
                            duration: Date.now() - t0, type: 'Document',
                        });
                    })
                    .catch((e) => {
                        dbg(`[mitm] ✗ ${url} ${e.message}\n`);
                        const errRes = { statusCode: 502, headers: {}, bodyBase64: '' };
                        const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, r.method, errRes);
                        entry.data = buildHttpResponse(resOut);
                    })
                    .finally(() => { entry.done = true; flushPipeline(); });
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
                        if (isGzip || ce === 'gzip' || ce === 'br' || ce === 'deflate') r.bodyBase64 = bodyBuf.toString('base64');
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
            tlsSocket.on('close', () => { chunks.length = 0; chunksLen = 0; pipeline.length = 0; });
        }).catch(() => { clearTimeout(hsTimer); socket.destroy(); });
    }

    _handleHttp(socket, head) {
        const req = parseHttpRequest(head);
        if (!req) { socket.destroy(); return; }
        if (!this._checkAuth(req.headers)) { this._rejectAuth(socket); return; }

        const hostHeader = (req.headers['host'] || req.headers['Host'] || '');
        const url = req.path.startsWith('http') ? req.path : `http://${hostHeader}${req.path}`;
        const headers = { ...req.headers };
        delete headers['proxy-authorization'];
        const hasBody = !!(req.body || req.bodyBase64);
        const orderedHeaders = (req.orderedHeaders || []).filter(([k]) => {
            const kl = k.toLowerCase();
            return kl !== 'proxy-authorization' && !CUPNET_HEADERS.includes(kl) && !(hasBody && SKIP_WHEN_BODY.includes(kl));
        });

        if (req.method === 'OPTIONS' && this.parent._mitmCorsEnabledForUrl(url)) {
            const origin = _resolveCorsAllowOrigin(headers);
            if (origin) {
                const reqM = _reqHeader(headers, 'Access-Control-Request-Method');
                const reqH = _reqHeader(headers, 'Access-Control-Request-Headers');
                dbg(`[mitm-cors] PREFLIGHT 204 origin=${origin} ${url}\n`);
                socket.write(buildHttpResponse({
                    statusCode: 204, bodyBase64: '',
                    headers: {
                        'Access-Control-Allow-Origin': origin,
                        'Access-Control-Allow-Credentials': 'true',
                        'Access-Control-Allow-Methods': reqM || 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
                        'Access-Control-Allow-Headers': reqH || '*',
                        'Access-Control-Max-Age': '86400',
                    },
                }));
                socket.end();
                return;
            }
        }

        const t0 = Date.now();
        this.parent._doRequest({ method: req.method, url, headers, orderedHeaders, body: req.body, bodyBase64: req.bodyBase64, disableRedirects: !this.followRedirects })
            .then(res => {
                const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, req.method, res);
                socket.write(buildHttpResponse(resOut));
                socket.end();
                let logBody = null;
                if (resOut.bodyBase64) {
                    const ct = _headerVal(resOut.headers, 'content-type');
                    if (_isBinaryContentType(ct)) logBody = '__b64__:' + resOut.bodyBase64;
                    else { try { logBody = Buffer.from(resOut.bodyBase64, 'base64').toString('utf8'); } catch {} }
                }
                this._logRequest({
                    url, method: req.method, status: resOut.statusCode,
                    requestHeaders: headers, responseHeaders: resOut.headers,
                    requestBody: req.body || null, responseBody: logBody,
                    duration: Date.now() - t0, type: 'Document',
                });
            })
            .catch((e) => {
                dbg(`[mitm] ✗ ${url} ${e.message}\n`);
                const errRes = { statusCode: 502, headers: {}, bodyBase64: '' };
                const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes);
                socket.write(buildHttpResponse(resOut));
                socket.end();
            });
    }
}

// ── Module exports + standalone entry ────────────────────────────────────────

module.exports = { MitmProxy, ExternalProxyPort, generateCA, generateCAAsync, loadOrGenerateCA };

if (require.main === module) {
    const { caKeyPem, caCertPem } = generateCA();
    console.log('[mitm-proxy] CA cert generated');

    const proxy = new MitmProxy({
        browser:    'chrome_120',
        workerPath: path.join(__dirname, 'azure-tls-worker.js'),
    });

    proxy.start().then(() => {
        console.log('[mitm-proxy] Proxy URL:', proxy.getProxyUrl());
        console.log('[mitm-proxy] Use this URL in Chromium: --proxy-server=' + proxy.getProxyUrl());
        console.log('[mitm-proxy] CA cert PEM (trust this in Chromium):');
        console.log(proxy.getCACert());
    });
}
