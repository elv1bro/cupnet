'use strict';

/**
 * Integration: browser identity on the wire through the real MITM + Go AzureTLS worker.
 *
 * Chromium-shaped request → MitmProxy (CONNECT + TLS terminate) → worker → local HTTPS echo server.
 * The echo server reports the exact headers it received, so we can assert that the identity
 * rewrote `User-Agent` / `sec-ch-ua*` / `Accept-Language` (or left them alone in engine mode).
 *
 * Hermetic: no public network. Skips when the Go worker binary is not built
 * (`npm run build:go:local`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { existsSync } from 'fs';
import net from 'net';
import tls from 'tls';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1';
process.env.CUPNET_DEBUG_MITM = process.env.CUPNET_DEBUG_MITM || '0';
// This suite checks request headers on the wire; its client frames responses by Content-Length, so it
// pins the buffered path (streaming has its own suite: mitm-stream.test.mjs).
process.env.CUPNET_MITM_STREAM = '0';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

function resolveGoWorkerBinary() {
    const arch = process.arch;
    const platform = process.platform;
    let name;
    if (platform === 'darwin') name = arch === 'arm64' ? 'azuretls-worker-darwin-arm64' : 'azuretls-worker-darwin-amd64';
    else if (platform === 'linux') name = arch === 'arm64' ? 'azuretls-worker-linux-arm64' : 'azuretls-worker-linux-amd64';
    else if (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) name = 'azuretls-worker-win32-amd64.exe';
    else return null;
    return path.join(repoRoot, 'azuretls-go', 'bin', name);
}
const goBin = resolveGoWorkerBinary();
const haveBinary = !!(goBin && existsSync(goBin));

const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CupNet/2.0 Chrome/132.0.6834.210 Electron/34.5.8 Safari/537.36';

/** Chromium-like header block (order matters, mirrors what a real tab sends). */
function chromiumHeaderLines(host, { withHints = true } = {}) {
    return [
        `Host: ${host}`,
        'Connection: close',
        ...(withHints ? [
            'sec-ch-ua: "Chromium";v="132", "Not A(Brand";v="8"',
            'sec-ch-ua-mobile: ?0',
            'sec-ch-ua-platform: "macOS"',
        ] : []),
        'Upgrade-Insecure-Requests: 1',
        `User-Agent: ${ELECTRON_UA}`,
        'Accept: application/json',
        'Accept-Language: en-US,en;q=0.9',
    ];
}

/** GET through the MITM: TCP → CONNECT → TLS → request; returns the parsed JSON body. */
function fetchViaMitm(proxyPort, targetPort, { tabId, withHints = true, host = '127.0.0.1', path = '/echo', navigate = false, method = 'GET', body = null, extraHeaders = [] } = {}) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(proxyPort, '127.0.0.1');
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 20_000);
        const done = (fn) => { clearTimeout(timer); try { sock.destroy(); } catch {} fn(); };
        sock.on('error', (e) => done(() => reject(e)));
        sock.once('connect', () => {
            const auth = tabId ? `Proxy-Authorization: Basic ${Buffer.from(`${tabId}:cupnet`).toString('base64')}\r\n` : '';
            sock.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n${auth}\r\n`);
        });
        let connectBuf = '';
        const onConnectData = (chunk) => {
            connectBuf += chunk.toString('latin1');
            if (!connectBuf.includes('\r\n\r\n')) return;
            sock.removeListener('data', onConnectData);
            if (!/ 200 /.test(connectBuf.split('\r\n')[0])) return done(() => reject(new Error(`CONNECT failed: ${connectBuf.split('\r\n')[0]}`)));
            // MITM keeps the terminated TLS socket alive (like a browser would), so frame the
            // response on Content-Length instead of waiting for the socket to end.
            const tlsSock = tls.connect({ socket: sock, servername: 'localhost', rejectUnauthorized: false }, () => {
                const lines = chromiumHeaderLines(host, { withHints });
                if (navigate) lines.push('Sec-Fetch-Mode: navigate', 'Sec-Fetch-Dest: document');
                lines.push(...extraHeaders);
                const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
                if (payload) lines.push(`Content-Length: ${payload.length}`);
                tlsSock.write(`${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
                if (payload) tlsSock.write(payload);
            });
            let buf = Buffer.alloc(0);
            const tryFinish = () => {
                const idx = buf.indexOf('\r\n\r\n');
                if (idx < 0) return false;
                const head = buf.slice(0, idx).toString('utf8');
                const m = head.match(/content-length:\s*(\d+)/i);
                const len = m ? parseInt(m[1], 10) : 0;
                const body = buf.slice(idx + 4);
                if (body.length < len) return false;
                try {
                    done(() => resolve({ status: parseInt(head.split(' ')[1], 10), body: JSON.parse(body.slice(0, len).toString('utf8')) }));
                } catch (e) {
                    done(() => reject(new Error(`bad body: ${body.toString('utf8').slice(0, 200)}`)));
                }
                return true;
            };
            tlsSock.on('data', (d) => { buf = Buffer.concat([buf, d]); tryFinish(); });
            tlsSock.on('error', (e) => done(() => reject(e)));
            tlsSock.on('end', () => { if (!tryFinish()) done(() => reject(new Error('socket ended before a full response'))); });
        };
        sock.on('data', onConnectData);
    });
}

describe.skipIf(!haveBinary)('MITM identity on the wire (Go worker + local HTTPS echo)', () => {
    let MitmProxy;
    let catalog;
    let echo;
    let echoPort;
    let mitm;
    let mitmPort;

    beforeAll(async () => {
        ({ MitmProxy } = require(path.join(repoRoot, 'mitm-proxy.js')));
        const { generateCA, getFakeCert } = require(path.join(repoRoot, 'mitm-ca.js'));
        catalog = require(path.join(repoRoot, 'browser-identity-catalog.js'));
        generateCA();
        const cert = getFakeCert('127.0.0.1');
        let hits = 0;
        echo = https.createServer({ key: cert.key, cert: cert.cert }, async (req, res) => {
            hits++;
            const ordered = [];
            for (let i = 0; i < req.rawHeaders.length; i += 2) ordered.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const payload = JSON.stringify({ method: req.method, url: req.url, headers: req.headers, ordered, httpVersion: req.httpVersion, hits, bodyBase64: Buffer.concat(chunks).toString('base64') });
            const extra = {};
            if (req.url.includes('acceptch=1')) extra['Accept-CH'] = 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch';
            if (req.url.includes('critical=1')) { extra['Accept-CH'] = 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Model'; extra['Critical-CH'] = 'Sec-CH-UA-Full-Version-List'; }
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extra });
            res.end(payload);
        });
        await new Promise((r) => echo.listen(0, '127.0.0.1', r));
        echoPort = echo.address().port;

        mitm = new MitmProxy({ port: 0, browser: 'chrome' });
        await mitm.start();
        mitmPort = mitm._server.address().port;
    }, 120_000);

    afterAll(async () => {
        try { mitm?.stop(); } catch {}
        await new Promise((r) => (echo ? echo.close(() => r()) : r()));
    });

    it('engine mode: UA sanitized, Chromium hints pass through unchanged', async () => {
        mitm.setIdentity(null);
        const { status, body } = await fetchViaMitm(mitmPort, echoPort);
        expect(status).toBe(200);
        expect(body.headers['user-agent']).not.toMatch(/CupNet|Electron/);
        expect(body.headers['user-agent']).toMatch(/Chrome\/132\.0\.0\.0/);
        expect(body.headers['sec-ch-ua']).toBe('"Chromium";v="132", "Not A(Brand";v="8"');
        expect(body.headers['sec-ch-ua-platform']).toBe('"macOS"');
    }, 30_000);

    it('Chrome Windows template: UA + sec-ch-ua* + Accept-Language rewritten, order kept', async () => {
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win', language: 'de-DE,de;q=0.8' }));
        const { status, body } = await fetchViaMitm(mitmPort, echoPort);
        expect(status).toBe(200);
        expect(body.headers['user-agent']).toBe(catalog.UA.chromeWin);
        expect(body.headers['sec-ch-ua']).toContain(`"Chromium";v="${catalog.VERSIONS.chrome}"`);
        expect(body.headers['sec-ch-ua-platform']).toBe('"Windows"');
        expect(body.headers['sec-ch-ua-mobile']).toBe('?0');
        expect(body.headers['accept-language']).toBe('de-DE,de;q=0.8');
        const names = body.ordered.map(([k]) => k.toLowerCase()).filter((k) => k !== 'host' && k !== 'connection');
        const uaIdx = names.indexOf('user-agent');
        const chIdx = names.indexOf('sec-ch-ua');
        expect(chIdx).toBeGreaterThanOrEqual(0);
        expect(chIdx).toBeLessThan(uaIdx);
    }, 30_000);

    it('Chromium identity synthesizes low-entropy hints when the client sent none (Electron)', async () => {
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'edge-win' }));
        const { body } = await fetchViaMitm(mitmPort, echoPort, { withHints: false });
        expect(body.headers['user-agent']).toBe(catalog.UA.edgeWin);
        expect(body.headers['sec-ch-ua']).toContain('"Microsoft Edge"');
        expect(body.headers['sec-ch-ua-platform']).toBe('"Windows"');
        expect(body.headers['sec-ch-ua-mobile']).toBe('?0');
        expect(body.headers['sec-ch-ua-arch']).toBeUndefined();
        const names = body.ordered.map(([k]) => k.toLowerCase());
        expect(names.indexOf('sec-ch-ua')).toBeLessThan(names.indexOf('user-agent'));
    }, 30_000);

    it('Firefox template: no sec-ch-ua* reaches the origin', async () => {
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'firefox-win' }));
        const { body } = await fetchViaMitm(mitmPort, echoPort);
        expect(body.headers['user-agent']).toBe(catalog.UA.firefoxWin);
        expect(Object.keys(body.headers).some((k) => k.startsWith('sec-ch-ua'))).toBe(false);
    }, 30_000);

    it('identity-check.cupnet is answered by the MITM itself with the rewritten headers (no upstream dial)', async () => {
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'custom', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36', language: 'en-GB,en;q=0.9' }));
        const { status, body } = await fetchViaMitm(mitmPort, 443, { host: 'identity-check.cupnet', withHints: false });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.headers['user-agent']).toMatch(/Chrome\/153\.0\.0\.0/);
        expect(body.headers['sec-ch-ua']).toMatch(/"Google Chrome";v="153"/);
        expect(body.headers['sec-ch-ua']).toMatch(/"Chromium";v="153"/);
        expect(body.headers['sec-ch-ua-platform']).toBe('"Windows"');
        expect(body.headers['accept-language']).toBe('en-GB,en;q=0.9');
        expect(body.identity.mode).toBe('custom');
        expect(body.tls.profile).toBeTruthy();
        expect(body.upstreamProxy).toBeNull();
        // the echo must not leak proxy credentials even when an upstream is configured
        mitm.setUpstream('http://user:secret@proxy.example:8080');
        const withProxy = await fetchViaMitm(mitmPort, 443, { host: 'identity-check.cupnet' });
        expect(withProxy.body.upstreamProxy).toBe('http://proxy.example:8080');
        expect(JSON.stringify(withProxy.body)).not.toContain('secret');
        mitm.setUpstream(null);
    }, 30_000);

    it('request integrity: raw query characters (| + / =) and a binary POST body reach the origin byte-for-byte', async () => {
        // Bot-protection validators (e.g. Qrator /__qrator/validate?pow=..&nonce=..|..+../..=) embed such
        // characters unescaped; any re-encoding by the MITM/worker would invalidate the nonce.
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'custom', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' }));
        const target = '/__qrator/validate?pow=256&nonce=v2.0.1790326145.071.029a09e8cMxXfge6|TQB3qzdsLuUyAch1|2gqdeKK7l3YzKny15N+fUjABq3E7ce/kk0kiO2KdpJgePeFtDYkK6d55LoPCAn==&x=%2B%7C%20';
        const body = Buffer.concat([Buffer.from('{"a":"ü|+/=","b":'), Buffer.from([0x00, 0xff, 0x10, 0x80]), Buffer.from('}')]);
        const { status, body: echoed } = await fetchViaMitm(mitmPort, echoPort, {
            path: target, method: 'POST', body, withHints: false,
            extraHeaders: ['Content-Type: application/octet-stream', 'Origin: https://127.0.0.1', 'Sec-Fetch-Mode: cors', 'Sec-Fetch-Dest: empty'],
        });
        expect(status).toBe(200);
        expect(echoed.method).toBe('POST');
        expect(echoed.url).toBe(target);
        expect(Buffer.from(echoed.bodyBase64, 'base64').equals(body)).toBe(true);
        expect(echoed.headers['content-type']).toBe('application/octet-stream');
        expect(echoed.headers['content-length']).toBe(String(body.length));
        expect(echoed.headers['origin']).toBe('https://127.0.0.1');
        expect(echoed.headers['user-agent']).toMatch(/Chrome\/153/);
    }, 30_000);

    it('Accept-CH on a navigation → later requests to that origin carry the requested high-entropy hints', async () => {
        mitm.clearClientHintsCache();
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }));
        const first = await fetchViaMitm(mitmPort, echoPort, { path: '/echo?acceptch=1', navigate: true });
        expect(first.body.headers['sec-ch-ua-full-version-list']).toBeUndefined();  // not requested yet
        const second = await fetchViaMitm(mitmPort, echoPort, { path: '/echo' });
        expect(second.body.headers['sec-ch-ua-full-version-list']).toContain('"Google Chrome";v="');
        expect(second.body.headers['sec-ch-ua-platform-version']).toBe('"15.0.0"');
        expect(second.body.headers['sec-ch-ua-arch']).toBe('"x86"');
        expect(second.body.headers['sec-ch-ua-bitness']).toBeUndefined();  // not requested
        // a Firefox identity never sends hints even though the origin asked
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'firefox-win' }));
        const ff = await fetchViaMitm(mitmPort, echoPort, { path: '/echo' });
        expect(Object.keys(ff.body.headers).some((k) => k.startsWith('sec-ch-ua'))).toBe(false);
        mitm.clearClientHintsCache();
    }, 40_000);

    it('Critical-CH on a navigation is retried once with the missing hint (Chrome behaviour)', async () => {
        mitm.clearClientHintsCache();
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }));
        const before = (await fetchViaMitm(mitmPort, echoPort, { path: '/echo' })).body.hits;
        const r = await fetchViaMitm(mitmPort, echoPort, { path: '/echo?critical=1', navigate: true });
        // the client got the RETRIED response: it carries the hint and the echo saw two requests
        expect(r.body.headers['sec-ch-ua-full-version-list']).toContain('"Chromium";v="');
        expect(r.body.headers['sec-ch-ua-model']).toBeUndefined(); // accepted but not critical, not on the retry either
        expect(r.body.hits).toBe(before + 2);
        // subsequent request to the origin carries both accepted hints
        const next = await fetchViaMitm(mitmPort, echoPort, { path: '/echo' });
        expect(next.body.headers['sec-ch-ua-full-version-list']).toBeTruthy();
        expect(next.body.headers['sec-ch-ua-model']).toBe('""');
        expect(next.body.hits).toBe(before + 3);
        mitm.clearClientHintsCache();
    }, 40_000);

    it('per-tab identity overrides the global one only for that tab', async () => {
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }));
        mitm.setTabIdentity('tab_ios', catalog.resolveIdentity({ mode: 'template', templateId: 'ios-safari' }));
        const tab = await fetchViaMitm(mitmPort, echoPort, { tabId: 'tab_ios' });
        expect(tab.body.headers['user-agent']).toBe(catalog.UA.iosSafari);
        expect(tab.body.headers['sec-ch-ua']).toBeUndefined();
        const other = await fetchViaMitm(mitmPort, echoPort, { tabId: 'tab_other' });
        expect(other.body.headers['user-agent']).toBe(catalog.UA.chromeWin);
        mitm.setTabIdentity('tab_ios', null);
        const cleared = await fetchViaMitm(mitmPort, echoPort, { tabId: 'tab_ios' });
        expect(cleared.body.headers['user-agent']).toBe(catalog.UA.chromeWin);
    }, 60_000);
});
