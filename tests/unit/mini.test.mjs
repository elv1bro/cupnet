'use strict';

/**
 * CupNet mini: Chrome command line + profile prefs, CA helpers, CLI args, session log, and a hermetic
 * end-to-end run (MiniApp → MITM → Go worker → local HTTPS origin) covering the CA chain Chrome's
 * SPKI flag relies on, inject rules with CSP nonces, /__cupnet/event and the UI API access checks.
 * The end-to-end part skips when the Go worker binary is not built (`npm run build:go`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import zlib from 'zlib';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1';

const { buildChromeArgs, ensureProfilePrefs, WEBRTC_POLICY } = require('../../mini/chrome.js');
const { spkiHashFromCertPem, caInstructions } = require('../../mini/ca.js');
const { parseArgs } = require('../../mini/cupnet-mini.js');
const { SessionLog, newSessionId } = require('../../mini/session-log.js');

const tmpDirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'cupnet-mini-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

describe('buildChromeArgs', () => {
    it('isolates the profile, proxies through the MITM and pins the CA SPKI', () => {
        const args = buildChromeArgs({ mitmPort: 9001, profileDir: '/p', caSpki: 'abc=', url: 'https://x.test/' });
        expect(args).toEqual([
            '--user-data-dir=/p', '--proxy-server=http://127.0.0.1:9001', '--no-first-run',
            '--no-default-browser-check', '--ignore-certificate-errors-spki-list=abc=', 'https://x.test/',
        ]);
    });
    it('passes no trust flag for trust=system, requires the SPKI for spki, ignores non-http urls', () => {
        const sys = buildChromeArgs({ mitmPort: 1, profileDir: '/p', trust: 'system', url: 'javascript:alert(1)' });
        expect(sys.some((a) => a.includes('spki') || a.startsWith('javascript'))).toBe(false);
        expect(() => buildChromeArgs({ mitmPort: 1, profileDir: '/p' })).toThrow(/caSpki/);
    });
});

describe('ensureProfilePrefs', () => {
    it('sets the WebRTC policy once and keeps existing prefs', () => {
        const dir = tmp();
        mkdirSync(path.join(dir, 'Default'));
        writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ keep: 1, webrtc: { other: true } }));
        expect(ensureProfilePrefs(dir)).toBe(true);
        expect(ensureProfilePrefs(dir)).toBe(false);
        const prefs = JSON.parse(readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
        expect(prefs).toEqual({ keep: 1, webrtc: { other: true, ip_handling_policy: WEBRTC_POLICY } });
    });
});

describe('CA helpers', () => {
    it('spkiHashFromCertPem = base64(sha256(SPKI DER)) of the certificate key', () => {
        const { generateCA, getCACertPem } = require('../../mitm-ca.js');
        generateCA();
        const pem = getCACertPem();
        const der = new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
        expect(spkiHashFromCertPem(pem)).toBe(crypto.createHash('sha256').update(der).digest('base64'));
    });
    it('leaf certs chain to the CA (issuer = CA subject, AKI = SKI), also for a CA loaded from disk', () => {
        const mitmCa = require('../../mitm-ca.js');
        const dir = tmp();
        mitmCa.loadOrGenerateCA(dir); // generate + save
        const before = mitmCa.getFakeCert('chain.test').cert;
        mitmCa.generateCA(); // a different CA in memory: the cached leaf must not be reused
        mitmCa.loadOrGenerateCA(dir); // load the saved one back
        const ca = new crypto.X509Certificate(mitmCa.getCACertPem());
        const leaf = new crypto.X509Certificate(mitmCa.getFakeCert('chain.test').cert);
        expect(leaf.issuer).toBe(ca.subject);
        expect(leaf.checkIssued(ca)).toBe(true);
        expect(leaf.verify(ca.publicKey)).toBe(true);
        expect(new crypto.X509Certificate(before).checkIssued(ca)).toBe(true);
    });
    it('gives per-OS user-scope trust commands with the path quoted', () => {
        expect(caInstructions('/a b/ca.pem', 'darwin').install).toContain('login.keychain-db "/a b/ca.pem"');
        expect(caInstructions('C:\\ca.pem', 'win32').install).toMatch(/^certutil -user -addstore Root/);
        expect(caInstructions('/ca.pem', 'linux').install).toContain('sql:$HOME/.pki/nssdb');
    });
});

describe('parseArgs', () => {
    it('handles commands, --k v, --k=v and flags', () => {
        expect(parseArgs(['start', '--port', '9000', '--chrome', '--url=https://a/?x=1', '--trust', 'system']))
            .toEqual({ _: ['start'], port: '9000', chrome: true, url: 'https://a/?x=1', trust: 'system' });
    });
});

describe('SessionLog', () => {
    it('keeps a ring for the UI and a JSONL file per session', async () => {
        const dir = tmp();
        const log = new SessionLog({ dir });
        expect(log.sessionId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
        log.logRequest({ method: 'GET', url: 'https://a/', status: 200, duration: 5, responseBody: 'x'.repeat(600 * 1024) });
        log.logPageEvent('https://a/', { k: 1 });
        const list = log.list(1);
        expect(list.map((e) => e.kind)).toEqual(['request', 'page-event']);
        expect(list[0].responseBody).toBeUndefined(); // summaries only
        expect(log.get(2).responseBody).toMatch(/…\[truncated \d+ chars\]$/);
        log.close();
        await new Promise((r) => setTimeout(r, 50));
        const lines = readFileSync(log.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(lines.map((e) => e.kind)).toEqual(['session-start', 'request', 'page-event', 'session-end']);
        expect(SessionLog.listSessions(dir).map((s) => s.id)).toEqual([log.sessionId]);
        expect(newSessionId(new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^20260102-030405-/);
    });
});

// ─── end to end ───────────────────────────────────────────────────────────────────────────────────

function goWorkerBinary() {
    const { arch, platform } = process;
    const name = platform === 'darwin' ? `azuretls-worker-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}`
        : platform === 'linux' ? `azuretls-worker-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}`
            : platform === 'win32' ? 'azuretls-worker-win32-amd64.exe' : null;
    return name && path.join(repoRoot, 'azuretls-go', 'bin', name);
}
const haveBinary = existsSync(goWorkerBinary() || '');

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

/** One HTTPS request through the MITM (CONNECT + TLS). Resolves with status/headers/body and the peer cert chain. */
function viaMitm(mitmPort, targetPort, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(mitmPort, '127.0.0.1');
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 30_000);
        sock.on('error', reject);
        sock.once('connect', () => sock.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`));
        sock.once('data', (d) => {
            if (!/ 200 /.test(d.toString('latin1').split('\r\n')[0])) { clearTimeout(timer); reject(new Error(`CONNECT: ${d}`)); return; }
            const tlsSock = tls.connect({ socket: sock, servername: 'localhost', rejectUnauthorized: false }, () => {
                const peer = tlsSock.getPeerCertificate(true);
                const req = https.request({
                    createConnection: () => tlsSock, host: '127.0.0.1', port: targetPort, method, path: reqPath,
                    headers: { Host: `127.0.0.1:${targetPort}`, 'User-Agent': 'Mozilla/5.0 Chrome/140.0.0.0', Connection: 'close', ...headers },
                }, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        clearTimeout(timer);
                        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), peer });
                    });
                });
                req.on('error', (e) => { clearTimeout(timer); reject(e); });
                req.end(body);
            });
            tlsSock.on('error', (e) => { clearTimeout(timer); reject(e); });
        });
    });
}

function ui(app, method, p, { token = app.token, host = `127.0.0.1:${app.uiPort}`, json } = {}) {
    return new Promise((resolve, reject) => {
        const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
        const req = http.request({
            host: '127.0.0.1', port: app.uiPort, method, path: p,
            headers: { Host: host, ...(token ? { 'X-CupNet-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = text;
                try { data = JSON.parse(text); } catch { /* keep text */ }
                resolve({ status: res.statusCode, data });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

describe.skipIf(!haveBinary)('MiniApp end to end (local HTTPS origin)', () => {
    let app;
    let origin;
    let originPort;
    const PAGE = '<!doctype html><html><head><title>t</title></head><body><p>Привет</p></body></html>';
    const SITE_CSP = "default-src 'self'; script-src 'self' 'nonce-site'";

    beforeAll(async () => {
        const { MiniApp } = require('../../mini/mini-app.js');
        app = new MiniApp({ dataDir: tmp(), mitmPort: await freePort(), uiPort: 0 });
        await app.start();

        // Origin cert from the same CA module (any cert works: upstream TLS is not verified).
        const { getFakeCert } = require('../../mitm-ca.js');
        const cert = getFakeCert('127.0.0.1');
        origin = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
            if (req.url === '/page') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-security-policy': SITE_CSP });
                res.end(zlib.gzipSync(Buffer.from(PAGE)));
            } else if (req.url === '/app.js') {
                res.writeHead(200, { 'content-type': 'application/javascript' });
                res.end('console.log(1)');
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise((r) => origin.listen(0, '127.0.0.1', r));
        originPort = origin.address().port;
    }, 60_000);

    afterAll(async () => {
        await app?.stop();
        await new Promise((r) => (origin ? origin.close(() => r()) : r()));
    });

    it('presents leaf + CupNet CA, so the CA SPKI is in the chain Chrome checks', async () => {
        const r = await viaMitm(app.mitmPort, originPort, { reqPath: '/app.js' });
        expect(r.status).toBe(200);
        expect(r.body).toBe('console.log(1)');
        const issuer = r.peer.issuerCertificate;
        expect(issuer && issuer !== r.peer).toBeTruthy();
        expect(issuer.fingerprint256).toBe(app.ca.sha256);
        const caPem = readFileSync(app.caCertPath, 'utf8');
        expect(spkiHashFromCertPem(caPem)).toBe(app.ca.spki);
    });

    it('UI API rejects foreign Host headers and missing tokens', async () => {
        expect((await ui(app, 'GET', '/api/status', { host: `evil.test:${app.uiPort}` })).status).toBe(421);
        expect((await ui(app, 'GET', '/api/status', { token: null })).status).toBe(401);
        expect((await ui(app, 'GET', '/api/status', { token: 'x'.repeat(32) })).status).toBe(401);
        const ok = await ui(app, 'GET', '/api/status');
        expect(ok.status).toBe(200);
        expect(ok.data.ca.spki).toBe(app.ca.spki);
    });

    it('inject rule saved via the UI lands in documents with a CSP nonce; sub-resources untouched', async () => {
        const bad = await ui(app, 'POST', '/api/rules', { json: { name: 'x', type: 'inject', url_pattern: '*', params: { source: '' } } });
        expect(bad.status).toBe(400);
        const saved = await ui(app, 'POST', '/api/rules', {
            json: { name: 'hook', type: 'inject', url_pattern: `*127.0.0.1:${originPort}/*`, enabled: true, params: { source: 'window.__cn = "ок";' } },
        });
        expect(saved.status).toBe(200);
        expect((await ui(app, 'GET', '/api/rules')).data.some((r) => r.name === 'hook')).toBe(true);

        const doc = await viaMitm(app.mitmPort, originPort, { reqPath: '/page', headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } });
        expect(doc.status).toBe(200);
        expect(doc.headers['content-encoding']).toBeUndefined();
        const nonce = /<script nonce="([^"]+)" data-cupnet data-cupnet-rule="hook">window.__cn = "\\u043e\\u043a";<\/script>/.exec(doc.body)?.[1];
        expect(nonce).toBeTruthy();
        expect(doc.body).toContain('<head><script nonce=');
        expect(doc.body).toContain('<p>Привет</p>');
        expect(doc.headers['content-security-policy']).toBe(`${SITE_CSP} 'nonce-${nonce}'`);

        const js = await viaMitm(app.mitmPort, originPort, { reqPath: '/app.js', headers: { 'Sec-Fetch-Dest': 'script' } });
        expect(js.body).toBe('console.log(1)');

        const del = await ui(app, 'DELETE', `/api/rules/${saved.data.id}`);
        expect(del.status).toBe(200);
        const plain = await viaMitm(app.mitmPort, originPort, { reqPath: '/page', headers: { 'Sec-Fetch-Dest': 'document' } });
        expect(plain.body).not.toContain('data-cupnet');
    });

    it('/__cupnet/event is answered locally, write-only, and logged as a page event', async () => {
        const ev = await viaMitm(app.mitmPort, originPort, {
            method: 'POST', reqPath: '/__cupnet/event', body: JSON.stringify({ hello: 1 }),
            headers: { 'Content-Type': 'application/json', Referer: `https://127.0.0.1:${originPort}/page` },
        });
        expect(ev.status).toBe(204);
        expect((await viaMitm(app.mitmPort, originPort, { reqPath: '/__cupnet/event' })).status).toBe(405);
        expect((await viaMitm(app.mitmPort, originPort, { reqPath: '/__cupnet/log' })).status).toBe(404);

        const log = (await ui(app, 'GET', '/api/log')).data;
        const pe = log.filter((e) => e.kind === 'page-event');
        expect(pe).toHaveLength(1);
        expect((await ui(app, 'GET', `/api/log/${pe[0].seq}`)).data.data).toEqual({ hello: 1 });
        expect(log.some((e) => /\/__cupnet\//.test(e.url || '') && e.kind === 'request')).toBe(false);
        expect(log.some((e) => e.kind === 'request' && e.url?.endsWith('/page'))).toBe(true);

        const sessions = (await ui(app, 'GET', '/api/sessions')).data;
        expect(sessions.current).toBe(app.log.sessionId);
        const file = await ui(app, 'GET', `/api/sessions/${sessions.current}`);
        expect(file.status).toBe(200);
        expect(String(file.data)).toContain('"kind":"page-event"');
    });
});
