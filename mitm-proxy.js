'use strict';

/**
 * CupNet MITM Proxy
 *
 * Architecture:
 *   Chromium (--proxy-server=127.0.0.1:PORT)
 *     ↓  HTTP  → AzureTLS (дочерний azure-tls-worker.js на системном Node в Electron 21+;
 *               in-process только при CUPNET_AZURETLS_IN_PROCESS=1 — ffi ломается из‑за V8 memory cage)
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
const fs = require('fs');
const path = require('path');

/**
 * Дочерний worker: в Electron 21+ V8 memory cage не даёт загрузить ffi-napi/ref-napi
 * (в т.ч. под ELECTRON_RUN_AS_NODE) — нужен отдельный процесс на обычном Node и
 * аддоны, собранные под его ABI: npm run rebuild:azuretls:node
 *
 * Явно in-process: CUPNET_AZURETLS_IN_PROCESS=1 (только если рантайм без cage / эксперимент).
 */
function mitmUseChildAzureTlsWorker() {
    if (process.env.CUPNET_AZURETLS_CHILD_PROCESS === '1') return true;
    if (process.env.CUPNET_AZURETLS_IN_PROCESS === '1') return false;
    if (process.versions?.electron) return true;
    return false;
}

function createMitmAzureBackend(workerPath) {
    if (mitmUseChildAzureTlsWorker()) return new AzureTLSWorker(workerPath);
    try {
        const { AzureTLSInProcess } = require('./azure-tls-inprocess');
        return new AzureTLSInProcess();
    } catch (err) {
        const msg = err?.message || String(err);
        const archHint = /incompatible architecture|wrong ELF class|invalid ELF header/i.test(msg);
        const cageHint = /External buffers are not allowed/i.test(msg);
        console.error(
            '[mitm] AzureTLS in-process: не удалось загрузить нативный модуль (ref-napi / ffi-napi).\n' +
            (cageHint
                ? '  Electron 21+ (V8 memory cage): ffi-napi в процессе Electron не поддерживается.\n' +
                  '  Уберите CUPNET_AZURETLS_IN_PROCESS — по умолчанию используется worker на системном Node;\n' +
                  '  затем: npm run rebuild:azuretls:node (аддоны под тот node, что в PATH у воркера).\n'
                : '  Для worker на системном Node аддоны должны быть собраны под ABI этого Node:\n' +
                  '    npm run rebuild:azuretls:node\n') +
            (archHint
                ? '  Скорее всего *.node собран под другую архитектуру (например x86_64, а нужен arm64 для Apple Silicon).\n' +
                  '  Из корня репозитория: npm run rebuild:azuretls (на darwin+AS по умолчанию --arch arm64).\n' +
                  '  Явно: npm run rebuild:azuretls:arm64 или rebuild:azuretls:x64\n'
                : '') +
            '  Детали:',
            msg
        );
        throw err;
    }
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
        // Воркер грузит ffi-napi: в Electron 21+ тот же бинарник с ELECTRON_RUN_AS_NODE
        // всё равно под memory cage → «External buffers are not allowed».
        // Нужен обычный Node (PATH или CUPNET_AZURETLS_NODE / resources/cupnet-node/node).
        const isPackaged = process.defaultApp === false && !process.env.ELECTRON_IS_DEV;
        const isElectron = !!(process.versions && process.versions.electron);
        const baseEnv = {
            ...process.env,
            UV_THREADPOOL_SIZE: '32',
            NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || '',
        };

        let nodeBin;
        let env = baseEnv;

        if (process.env.CUPNET_AZURETLS_NODE) {
            nodeBin = process.env.CUPNET_AZURETLS_NODE;
        } else if (isElectron) {
            const bundledNode = path.join(
                process.resourcesPath || '',
                'cupnet-node',
                process.platform === 'win32' ? 'node.exe' : 'node'
            );
            if (isPackaged && fs.existsSync(bundledNode)) {
                nodeBin = bundledNode;
            } else if (isPackaged) {
                console.warn(
                    '[azure-worker] нет вложенного Node (resources/cupnet-node); fallback ELECTRON_RUN_AS_NODE — ' +
                        'ffi может не загрузиться. Добавьте Node в extraResources или CUPNET_AZURETLS_NODE.'
                );
                nodeBin = process.execPath;
                env = { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' };
            } else {
                nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
            }
        } else {
            nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
        }

        if (nodeBin !== process.execPath) {
            delete env.ELECTRON_RUN_AS_NODE;
        }

        this.proc = spawn(nodeBin, [this.workerPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        this._stdinQueue = [];
        this._stdinDraining = false;

        // Redirect worker stderr only in debug mode (very noisy in production)
        this.proc.stderr.on('data', d => { if (debugMitmLevel) process.stderr.write('[azure-worker] ' + d); });

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
        this.worker = createMitmAzureBackend(this.workerPath);
        this._server    = null;
        this._activeJa3 = null;
        this._dnsOverrides = new Map();
        /** @type {string[]} паттерны хоста из DNS rules с mitm_inject_cors (exact или *.suffix, см. _matchHostPattern). */
        this._dnsCorsPatterns = [];
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

    setUpstream(proxyUrl) { this.upstream = proxyUrl || null; }

    /**
     * Set per-tab upstream proxy override.
     * @param {string} tabId
     * @param {{ upstream: string|null, browser?: string, ja3?: string }} config
     */
    setTabUpstream(tabId, config) {
        if (!tabId) return;
        this._tabProxyMap.set(tabId, {
            upstream: config.upstream || null,
            browser:  config.browser  || null,
            ja3:      config.ja3      || null,
        });
    }

    removeTabUpstream(tabId) {
        this._tabProxyMap.delete(tabId);
    }

    _resolveUpstreamForTab(tabId) {
        if (!tabId) return { proxy: this.upstream, browser: this.browser, ja3: this._activeJa3 };
        const override = this._tabProxyMap.get(tabId);
        if (!override) return { proxy: this.upstream, browser: this.browser, ja3: this._activeJa3 };
        return {
            proxy:   override.upstream ?? this.upstream,
            browser: override.browser  || this.browser,
            ja3:     override.ja3      || this._activeJa3,
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

    setDnsOverrides(rules = []) {
        const next = new Map();
        const corsPatterns = [];
        for (const r of (rules || [])) {
            if (!r || r.enabled === false) continue;
            const host = String(r.host || '').trim().toLowerCase();
            const ip = String(r.ip || '').trim();
            if (!host) continue;
            if (ip && !host.startsWith('*.')) {
                const rw = String(r.rewrite_host || '').trim();
                next.set(host, { ip, rewriteHost: rw || null });
            }
            if (r.mitm_inject_cors === true) corsPatterns.push(host);
        }
        this._dnsOverrides = next;
        this._dnsCorsPatterns = corsPatterns;
        if (corsPatterns.length || next.size) {
            const rows = ['━━ DNS overrides · reload ━━', `  IPv4 → ${next.size} host(s)`];
            for (const [h, v] of next) {
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

    _mitmCorsEnabledForUrl(urlStr) {
        if (shouldSkipMitmCorsForUrl(urlStr)) return false;
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
        for (const p of this._dnsCorsPatterns) {
            if (_matchHostPattern(p, h)) return { host: h, pattern: p };
        }
        return null;
    }

    async start() {
        await this.worker.waitReady();

        this._server = net.createServer(socket => this._handleConnection(socket));
        await new Promise((res, rej) =>
            this._server.listen(this.port, '127.0.0.1', err => err ? rej(err) : res())
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
                this._handleHttp(socket, head, data);
            }
        });
        socket.on('error', () => { try { socket.destroy(); } catch {} });
    }

    // ── HTTPS CONNECT ──────────────────────────────────────────────────────────
    _handleConnect(socket, head) {
        const connectTabId = _mitmTabIdFromProxyAuthHead(head);
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
        const ctag = _clientTag(socket);
        const hsTimer = setTimeout(() => {
            dbg(`[mitm] TLS handshake timeout ${hostname}:${port}${ctag}\n`);
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
            const tabId = connectTabId;
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
            dbg(`[mitm] → ${req.method} ${url}${ctag}\n`);
            if (debugMitmLevel >= 2) mitmUserLog(_fmtHeaders(headers));
            if (debugMitmLevel >= 3) mitmUserLog(_fmtBody(req.body, req.bodyBase64, 'req body'));

            const entry = { done: false, data: null };
            pipeline.push(entry);
            const t0 = Date.now();
            this._doRequest({ method: req.method, url, headers, orderedHeaders, body: req.body, bodyBase64: req.bodyBase64, requestId, tabId })
                .then(res  => {
                    dbg(`[mitm] ← ${url} status=${res.statusCode}${ctag}\n`);
                    if (debugMitmLevel >= 2) mitmUserLog(_fmtHeaders(res.headers));
                    if (debugMitmLevel >= 4) mitmUserLog(_fmtBody(null, res.bodyBase64, 'res body'));
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
                        const dnsCorsMatch = !res.dnsOverride ? this._mitmCorsMatchDetail(url) : null;
                        this.onRequestLogged({
                            url, method: req.method, tabId, sessionId, requestId,
                            status: resOut.statusCode, requestHeaders: headers,
                            responseHeaders: resOut.headers, requestBody: reqBodyForLog,
                            responseBody: logBody, duration: Date.now() - t0,
                            type: inferMitmResourceType(url, req.method, headers, resOut.headers),
                            dnsOverride: res.dnsOverride || null,
                            dnsCorsMatch,
                        });
                    }
                })
                .catch((e) => {
                    dbg(`[mitm] ✗ ${url} ${e.message}${ctag}\n`);
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
                if (_isWebSocketUpgrade(req)) {
                    tlsSocket.removeAllListeners('data');
                    tlsSocket.removeAllListeners('close');
                    tlsSocket.removeAllListeners('error');
                    pipeline.length = 0;
                    chunks.length = 0;
                    chunksLen = 0;
                    this._tunnelWebSocketUpgradeMitm({
                        clientTls: tlsSocket,
                        hostname,
                        port,
                        req,
                        tabId: connectTabId,
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
        tlsSocket.on('close', () => { chunks.length = 0; chunksLen = 0; pipeline.length = 0; });
        }).catch((e) => { clearTimeout(hsTimer); dbg(`[mitm] cert error ${hostname}: ${e?.message}${ctag}\n`); socket.destroy(); });
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

        const tabId = _mitmTabIdFromProxyAuthHead(head);
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

        const ctagPlain = _clientTag(socket);
        dbg(`[mitm] → ${req.method} ${url}${ctagPlain}\n`);
        if (debugMitmLevel >= 2) mitmUserLog(_fmtHeaders(headers));
        if (debugMitmLevel >= 3) mitmUserLog(_fmtBody(req.body, req.bodyBase64, 'req body'));

        this._doRequest({
            method: req.method,
            url,
            headers,
            orderedHeaders,
            body: req.body,
            bodyBase64: req.bodyBase64,
            requestId: `mitm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            tabId,
        })
            .then(res => {
                dbg(`[mitm] ← ${url} status=${res.statusCode}${ctagPlain}\n`);
                if (debugMitmLevel >= 2) mitmUserLog(_fmtHeaders(res.headers));
                if (debugMitmLevel >= 4) mitmUserLog(_fmtBody(null, res.bodyBase64, 'res body'));
                const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, res);
                const resp = buildHttpResponse(resOut);
                socket.write(resp);
                socket.end();
            })
            .catch((e) => {
                dbg(`[mitm] ✗ ${url} ${e.message}${ctagPlain}\n`);
                const errRes = { statusCode: 502, headers: {}, bodyBase64: '' };
                const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes);
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
        if (dnsAdjusted.dnsOverride && debugMitmLevel) {
            const d = dnsAdjusted.dnsOverride;
            const rw = d.rewriteHost ? ` · Host→${d.rewriteHost}` : '';
            dbg(`[mitm] dns  ${d.host}  →  ${d.ip}${rw}\n`);
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

        const tabUpstream = this._resolveUpstreamForTab(opts.tabId);
        try {
            const { planMitmIntercept, finalizeMitmInterceptResponseAsync } = require('./request-interceptor');
            const mitmOpts = {
                ...dnsAdjusted,
                headers: { ...(dnsAdjusted.headers || {}) },
                orderedHeaders: Array.isArray(dnsAdjusted.orderedHeaders)
                    ? dnsAdjusted.orderedHeaders.map((pair) => [...pair])
                    : dnsAdjusted.orderedHeaders,
            };
            const plan = planMitmIntercept(mitmOpts);
            if (plan.done) {
                const ms = Date.now() - t0;
                st.totalMs += ms;
                if (ms < st.minMs) st.minMs = ms;
                if (ms > st.maxMs) st.maxMs = ms;
                return plan.response;
            }

            const up = plan.opts;
            const noBodyUp = /^(GET|HEAD)$/i.test(up.method || '');
            const retryCountUp = /^(GET|HEAD|OPTIONS)$/i.test(up.method || '')
                ? networkPolicy.retry.maxRetries
                : 0;
            const res = await this.worker.request({
                method:            up.method,
                url:               up.url,
                headers:           up.headers,
                orderedHeaders:    up.orderedHeaders || undefined,
                body:              noBodyUp ? undefined : (up.bodyBase64 ? undefined : (up.body || null)),
                bodyBase64:        noBodyUp ? undefined : (up.bodyBase64 || undefined),
                proxy:             tabUpstream.proxy || null,
                browser:           tabUpstream.browser,
                ja3:               tabUpstream.ja3 || undefined,
                requestId:         opts.requestId || undefined,
                maxRetries:        retryCountUp,
                timeout:           networkPolicy.timeouts.upstreamRequestMs,
                disableRedirects:  opts.disableRedirects !== false,
                forceHttp1:         forceHttp1,
            });
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
            if (plan.postProcess) {
                out = await finalizeMitmInterceptResponseAsync(out, plan.postProcess);
            }
            return out;
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

        const entry = this._dnsOverrides.get(host);
        if (!entry?.ip) return { ...opts };

        const overrideIp = entry.ip;
        const rewriteHost = entry.rewriteHost || null;

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
            dnsOverride: { host, ip: overrideIp, rewriteHost: rewriteHost || undefined },
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
        let upstreamUrl;
        try {
            upstreamUrl = new URL(proxyUrl);
        } catch (e) {
            return Promise.reject(e);
        }
        const proxyHost = upstreamUrl.hostname;
        const proxyPort = Number(upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80));
        const target = `${connectHost}:${connectPort}`;
        return new Promise((resolve, reject) => {
            const upstreamSocket = net.connect(proxyPort, proxyHost);
            upstreamSocket.setTimeout(to, () => upstreamSocket.destroy());
            upstreamSocket.once('error', reject);
            upstreamSocket.once('connect', () => {
                const proxyAuth = _buildProxyAuthorizationHeader(upstreamUrl);
                const lines = [
                    `CONNECT ${target} HTTP/1.1`,
                    `Host: ${target}`,
                    'Proxy-Connection: Keep-Alive',
                    'Connection: Keep-Alive',
                ];
                if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
                upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
            });
            let respBuf = Buffer.alloc(0);
            const onResp = (chunk) => {
                respBuf = Buffer.concat([respBuf, chunk]);
                const sep = respBuf.indexOf('\r\n\r\n');
                if (sep === -1) {
                    if (respBuf.length > 16 * 1024) {
                        upstreamSocket.removeListener('data', onResp);
                        reject(new Error('Upstream CONNECT response too large'));
                    }
                    return;
                }
                upstreamSocket.removeListener('data', onResp);
                const head = respBuf.toString('utf8', 0, sep);
                if (!/^HTTP\/1\.[01]\s+200\b/i.test(head)) {
                    const firstLine = (head.split('\r\n')[0] || '').trim();
                    reject(new Error(`Upstream CONNECT rejected: ${firstLine || 'unknown'}`));
                    try { upstreamSocket.destroy(); } catch {}
                    return;
                }
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
            };
            upstreamSocket.on('data', onResp);
        });
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
        const plan = planMitmIntercept(mitmOpts);
        if (plan.done) {
            const finishShort = async () => {
                let out = plan.response;
                if (plan.postProcess) {
                    out = await finalizeMitmInterceptResponseAsync(out, plan.postProcess);
                }
                const resOut = applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, out);
                try { clientTls.write(buildHttpResponse(resOut)); } catch {}
                try { clientTls.end(); } catch {}
            };
            void finishShort().catch((err) => {
                try { safeCatch({ module: 'mitm-proxy', eventCode: 'mitm.ws.shortCircuitFinalize.failed', context: { url } }, err, 'warn'); } catch (_) { /* ignore */ }
                try { clientTls.end(); } catch {}
            });
            return;
        }
        const up = plan.opts;
        const wire = _buildWireHttpRequest(up);
        const t0 = Date.now();
        const requestId = `mitm_ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const uObj = new URL(up.url);
        const logicalHost = uObj.hostname;
        const targetPort = uObj.port ? parseInt(uObj.port, 10) : 443;
        const connectHost = up.dnsOverride?.ip || logicalHost;
        const tabUpstream = this._resolveUpstreamForTab(tabId);
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
                    applyMitmCorsToResponse(this._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes)
                ));
            } catch {}
            try { clientTls.end(); } catch {}
        };

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
                if (remainder && remainder.length) {
                    try { clientTls.write(remainder); } catch {}
                }
                const rem = clientRemainder && clientRemainder.length ? clientRemainder : Buffer.alloc(0);
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
                const tabId = null;
                const headers = { ...r.headers };
                delete headers['proxy-authorization'];
                const hasBody = !!(r.body || r.bodyBase64);
                const orderedHeaders = (r.orderedHeaders || []).filter(([k]) => {
                    const kl = k.toLowerCase();
                    return kl !== 'proxy-authorization' && !(hasBody && SKIP_WHEN_BODY.includes(kl));
                });

                const entry = { done: false, data: null };
                pipeline.push(entry);
                const t0 = Date.now();
                this.parent._doRequest({ method: r.method, url, headers, orderedHeaders, body: r.body, bodyBase64: r.bodyBase64, disableRedirects: !this.followRedirects, tabId })
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
                        const dnsCorsMatch = !res.dnsOverride ? this.parent._mitmCorsMatchDetail(url) : null;
                        this._logRequest({
                            url, method: r.method, status: resOut.statusCode,
                            requestHeaders: headers, responseHeaders: resOut.headers,
                            requestBody: reqBody, responseBody: logBody,
                            duration: Date.now() - t0,
                            type: inferMitmResourceType(url, r.method, headers, resOut.headers),
                            dnsOverride: res.dnsOverride || null,
                            dnsCorsMatch,
                        });
                    })
                    .catch((e) => {
                        dbg(`[mitm] ✗ ${url} ${e.message}${ctagExt}\n`);
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
        this.parent._doRequest({ method: req.method, url, headers, orderedHeaders, body: req.body, bodyBase64: req.bodyBase64, disableRedirects: !this.followRedirects, tabId })
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
                const dnsCorsMatch = !res.dnsOverride ? this.parent._mitmCorsMatchDetail(url) : null;
                this._logRequest({
                    url, method: req.method, status: resOut.statusCode,
                    requestHeaders: headers, responseHeaders: resOut.headers,
                    requestBody: req.body || null, responseBody: logBody,
                    duration: Date.now() - t0,
                    type: inferMitmResourceType(url, req.method, headers, resOut.headers),
                    dnsOverride: res.dnsOverride || null,
                    dnsCorsMatch,
                });
            })
            .catch((e) => {
                dbg(`[mitm] ✗ ${url} ${e.message}${ctagExtHttp}\n`);
                const errRes = { statusCode: 502, headers: {}, bodyBase64: '' };
                const resOut = applyMitmCorsToResponse(this.parent._mitmCorsEnabledForUrl(url), url, headers, req.method, errRes);
                socket.write(buildHttpResponse(resOut));
                socket.end();
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
    /** @internal used by tests/test-dns-mitm.js */
    _testApplyMitmCorsToResponse: applyMitmCorsToResponse,
    _testShouldSkipMitmCorsForUrl: shouldSkipMitmCorsForUrl,
    _testMatchHostPattern: _matchHostPattern,
};

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
