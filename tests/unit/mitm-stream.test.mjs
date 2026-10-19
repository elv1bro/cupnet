'use strict';

/**
 * MITM response streaming (CUPNET_MITM_STREAM=1).
 *
 * 1) Pure units: the worker stdout frame decoder, the streamed-body queue, the chunked head builder.
 * 2) Hermetic integration: Chromium-shaped request → MitmProxy (CONNECT + TLS terminate) → Go worker
 *    → local HTTPS server. Checks decoded bodies, real streaming (first bytes before the upstream
 *    finishes) and that closing the browser socket cancels the upstream download.
 *    Skips when the Go worker binary is not built (`npm run build:go`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { existsSync } from 'fs';
import net from 'net';
import tls from 'tls';
import https from 'https';
import http from 'http';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1';
process.env.CUPNET_DEBUG_MITM = process.env.CUPNET_DEBUG_MITM || '0';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const mitmMod = require(path.join(repoRoot, 'mitm-proxy.js'));
const {
    _testWorkerFrameDecoder: WorkerFrameDecoder,
    _testWorkerBodyStream: WorkerBodyStream,
    _testBuildHttpResponseHead: buildHttpResponseHead,
    _testLogBodyFromResponse: logBodyFromResponse,
    _testLogBodyMaxBytes: LOG_BODY_MAX_BYTES,
} = mitmMod;

// ── pure units ──────────────────────────────────────────────────────────────────

function frameBytes() {
    const binary = Buffer.from([0x00, 0x0a, 0xff, 0x0a, 0x0a, 0x7b, 0x7d, 0x0d, 0x0a, 0x01]); // has \n and "{}"
    const text = Buffer.from('hello streamed world\n', 'utf8');
    const parts = [
        Buffer.from('{"id":"__init__","status":"ready"}\n'),
        Buffer.from('{"id":"r1","stream":"head","statusCode":200,"headers":{"Content-Type":"x"}}\n'),
        Buffer.from(`{"id":"r1","chunk":${binary.length}}\n`), binary,
        Buffer.from('{"id":"r2","statusCode":404,"bodyBase64":""}\n'),
        Buffer.from(`{"id":"r1","chunk":${text.length}}\n`), text,
        Buffer.from('{"id":"r1","stream":"end"}\n'),
    ];
    return { all: Buffer.concat(parts), binary, text };
}

function decodeWithSplits(buf, splitEvery) {
    const frames = [];
    const dec = new WorkerFrameDecoder((hdr, body) => frames.push({ hdr, body: body ? Buffer.from(body) : null }));
    for (let i = 0; i < buf.length; i += splitEvery) dec.push(buf.subarray(i, i + splitEvery));
    return frames;
}

describe('WorkerFrameDecoder', () => {
    it('decodes messages and binary chunk frames regardless of how the bytes are split', () => {
        const { all, binary, text } = frameBytes();
        for (const split of [1, 2, 3, 5, 7, 13, 64, all.length]) {
            const frames = decodeWithSplits(all, split);
            expect(frames.map((f) => f.hdr.id)).toEqual(['__init__', 'r1', 'r1', 'r2', 'r1', 'r1']);
            expect(frames[1].hdr.stream).toBe('head');
            expect(frames[2].body.equals(binary)).toBe(true);
            expect(frames[3].hdr.statusCode).toBe(404);
            expect(frames[3].body).toBeNull();
            expect(frames[4].body.equals(text)).toBe(true);
            expect(frames[5].hdr.stream).toBe('end');
        }
    });

    it('skips malformed lines and keeps going', () => {
        const frames = decodeWithSplits(Buffer.from('not json\n{"id":"a"}\n\n{"id":"b"}\n'), 4);
        expect(frames.map((f) => f.hdr.id)).toEqual(['a', 'b']);
    });
});

function fakeWorker() {
    return { _streams: new Map(), ctl: [], streamCtl(id, op) { this.ctl.push([id, op]); } };
}

describe('WorkerBodyStream', () => {
    it('queues chunks that arrive before a consumer attaches, then delivers in order', () => {
        const w = fakeWorker();
        let finished = 0;
        const s = new WorkerBodyStream(w, 'r1', () => { finished++; });
        w._streams.set('r1', s);
        s._push(Buffer.from('ab'));
        s._push(Buffer.from('cd'));
        s._end(null);
        const got = [];
        let endErr = 'unset';
        s.attach({ onData: (b) => got.push(b.toString()), onEnd: (e) => { endErr = e; } });
        expect(got).toEqual(['ab', 'cd']);
        expect(endErr).toBeNull();
        expect(finished).toBe(1);
        expect(w._streams.has('r1')).toBe(false);
        expect(s.bytes).toBe(4);
    });

    it('pause/resume/cancel send control ops once and cancel ends the stream', () => {
        const w = fakeWorker();
        let finished = 0;
        const s = new WorkerBodyStream(w, 'r9', () => { finished++; });
        w._streams.set('r9', s);
        let endErr = 'unset';
        s.attach({ onData: () => {}, onEnd: (e) => { endErr = e; } });
        s.pause(); s.pause(); s.resume(); s.resume();
        s.cancel(); s.cancel();
        expect(w.ctl).toEqual([['r9', 'pause'], ['r9', 'resume'], ['r9', 'cancel']]);
        expect(endErr).toBe('cancelled');
        expect(finished).toBe(1);
        s._push(Buffer.from('late')); // after end: ignored
        expect(s.bytes).toBe(0);
    });
});

describe('buildHttpResponseHead', () => {
    it('chunked head drops Content-Length/hop-by-hop, keeps an undecoded Content-Encoding', () => {
        const head = buildHttpResponseHead(
            { statusCode: 200, headers: { 'Content-Type': 'text/html', 'Content-Length': '999', Connection: 'keep-alive', 'Content-Encoding': 'x-custom', 'Set-Cookie': ['a=1', 'b=2'] } },
            'https://example.test/', { chunked: true },
        ).toString('latin1');
        expect(head.startsWith('HTTP/1.1 200 OK\r\n')).toBe(true);
        expect(head).toContain('Transfer-Encoding: chunked\r\n');
        expect(head).not.toMatch(/content-length/i);
        expect(head).not.toMatch(/^connection:/im);
        expect(head).toContain('Content-Encoding: x-custom\r\n');
        expect(head).toContain('Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n');
        expect(head.endsWith('\r\n\r\n')).toBe(true);
    });

    it('bodiless head uses Content-Length: 0 and absolutizes redirects', () => {
        const head = buildHttpResponseHead({ statusCode: 302, headers: { Location: '/next' } }, 'https://example.test/a/b', { chunked: false }).toString('latin1');
        expect(head).toContain('Content-Length: 0\r\n');
        expect(head).not.toContain('Transfer-Encoding');
        expect(head).toContain('Location: https://example.test/next\r\n');
    });
});


describe('request-log body policy', () => {
    const b64 = (str) => Buffer.from(str).toString('base64');
    it('keeps text, skips media types and bodies over the limit', () => {
        expect(logBodyFromResponse({ headers: { 'Content-Type': 'text/html' }, bodyBase64: b64('<p>hi</p>') })).toBe('<p>hi</p>');
        expect(logBodyFromResponse({ headers: { 'content-type': 'image/png' }, bodyBase64: b64('png') })).toBe('__b64__:' + b64('png'));
        expect(logBodyFromResponse({ headers: { 'content-type': 'video/mp4' }, bodyBase64: b64('frames') })).toBeNull();
        expect(logBodyFromResponse({ headers: { 'content-type': 'audio/mpeg' }, bodyBase64: b64('pcm') })).toBeNull();
        const big = Buffer.alloc(LOG_BODY_MAX_BYTES + 1024, 97).toString('base64');
        expect(logBodyFromResponse({ headers: { 'content-type': 'text/plain' }, bodyBase64: big })).toBeNull();
    });
});

// ── hermetic integration ───────────────────────────────────────────────────────

function resolveGoWorkerBinary() {
    const { arch, platform } = process;
    let name;
    if (platform === 'darwin') name = arch === 'arm64' ? 'azuretls-worker-darwin-arm64' : 'azuretls-worker-darwin-amd64';
    else if (platform === 'linux') name = arch === 'arm64' ? 'azuretls-worker-linux-arm64' : 'azuretls-worker-linux-amd64';
    else if (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) name = 'azuretls-worker-win32-amd64.exe';
    else return null;
    return path.join(repoRoot, 'azuretls-go', 'bin', name);
}
const goBin = resolveGoWorkerBinary();
const haveBinary = !!(goBin && existsSync(goBin));

const UA_LINE = 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/**
 * Parse as many complete HTTP/1.1 responses as `buf` holds (Content-Length or chunked framing).
 * @returns {{ responses: Array<{status:number, head:string, body:Buffer, bodyStart:number}>, firstBodyByte: boolean }}
 */
function parseResponses(buf) {
    const responses = [];
    let off = 0;
    let firstBodyByte = false;
    for (;;) {
        const idx = buf.indexOf('\r\n\r\n', off);
        if (idx < 0) break;
        const head = buf.subarray(off, idx).toString('latin1');
        const rest = buf.subarray(idx + 4);
        if (rest.length > 0) firstBodyByte = true;
        const status = parseInt(head.split(' ')[1], 10);
        if (/transfer-encoding:\s*chunked/i.test(head)) {
            // find the end of the chunked body
            let i = 0; const out = []; let complete = false;
            for (;;) {
                const nl = rest.indexOf('\r\n', i);
                if (nl < 0) break;
                const size = parseInt(rest.toString('latin1', i, nl).split(';')[0], 16);
                if (size === 0) {
                    if (rest.length >= nl + 4) { complete = true; i = nl + 4; }
                    break;
                }
                if (rest.length < nl + 2 + size + 2) break;
                out.push(rest.subarray(nl + 2, nl + 2 + size));
                i = nl + 2 + size + 2;
            }
            if (!complete) break;
            responses.push({ status, head, body: Buffer.concat(out) });
            off = idx + 4 + i;
        } else {
            const m = head.match(/content-length:\s*(\d+)/i);
            const len = m ? parseInt(m[1], 10) : 0;
            if (rest.length < len) break;
            responses.push({ status, head, body: rest.subarray(0, len) });
            off = idx + 4 + len;
        }
    }
    return { responses, firstBodyByte };
}

/**
 * Requests through a proxy port. Default: TCP → CONNECT → TLS → request(s) (HTTPS tunnel).
 * `plain: true`: an absolute-URI request straight to the proxy (plain-HTTP proxying).
 * `auth: 'user:pass'` adds Proxy-Authorization (External Proxy). Several `paths` are sent pipelined on
 * one connection. Resolves with the first response (or all of them as `all`), when the first body byte
 * arrived, and the total time. `onFirstBody(sock)` lets a test abort mid-stream.
 */
function getViaMitm(proxyPort, targetPort, reqPath, { method = 'GET', onFirstBody = null, extraHeaders = [], plain = false, auth = null, paths = null } = {}) {
    const wanted = paths || [reqPath];
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const sock = net.connect(proxyPort, '127.0.0.1');
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 30_000);
        const done = (fn) => { clearTimeout(timer); try { sock.destroy(); } catch {} fn(); };
        const authLine = auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : '';
        const requestText = (target) => `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n`
            + (plain ? authLine : '') + `${UA_LINE}\r\nAccept: */*\r\nAccept-Encoding: gzip, deflate, br, zstd\r\n`
            + extraHeaders.map((h) => `${h}\r\n`).join('') + '\r\n';
        let buf = Buffer.alloc(0);
        let firstBodyAt = null;
        const onData = (s) => (d) => {
            buf = Buffer.concat([buf, d]);
            const { responses, firstBodyByte } = parseResponses(buf);
            if (firstBodyAt == null && firstBodyByte) {
                firstBodyAt = Date.now() - t0;
                if (onFirstBody) {
                    onFirstBody(s);
                    done(() => resolve({ aborted: true, firstBodyAt }));
                    return;
                }
            }
            if (responses.length >= wanted.length) {
                done(() => resolve({ ...responses[0], all: responses, firstBodyAt, totalMs: Date.now() - t0 }));
            }
        };
        sock.on('error', (e) => done(() => reject(e)));
        if (plain) {
            sock.once('connect', () => sock.write(wanted.map((p) => requestText(`http://127.0.0.1:${targetPort}${p}`)).join('')));
            sock.on('data', onData(sock));
            return;
        }
        sock.once('connect', () => sock.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${authLine}\r\n`));
        let connectBuf = '';
        const onConnectData = (chunk) => {
            connectBuf += chunk.toString('latin1');
            if (!connectBuf.includes('\r\n\r\n')) return;
            sock.removeListener('data', onConnectData);
            const statusLine = connectBuf.split('\r\n')[0];
            if (!/ 200 /.test(statusLine)) return done(() => resolve({ connectStatus: parseInt(statusLine.split(' ')[1], 10) }));
            const tlsSock = tls.connect({ socket: sock, servername: 'localhost', rejectUnauthorized: false }, () => {
                tlsSock.write(wanted.map((p) => requestText(p)).join(''));
            });
            tlsSock.on('data', onData(tlsSock));
            tlsSock.on('error', (e) => done(() => reject(e)));
        };
        sock.on('data', onConnectData);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!haveBinary)('MITM streaming through the Go worker (local HTTPS)', () => {
    let upstream;
    let upstreamPort;
    let upstreamHttp;
    let upstreamHttpPort;
    let ext;
    let extPort;
    const extLogged = [];
    let mitm;
    let mitmPort;
    let bigPlain;
    let endlessClosed = false;
    let criticalHits = 0;
    let originHits = 0;
    let originConns = 0;
    const prevFlag = process.env.CUPNET_MITM_STREAM;

    beforeAll(async () => {
        const { generateCA, getFakeCert } = require(path.join(repoRoot, 'mitm-ca.js'));
        generateCA();
        const cert = getFakeCert('127.0.0.1');
        bigPlain = Buffer.from(Array.from({ length: 40000 }, (_, i) => `row ${i} of the streamed page\n`).join(''), 'utf8');
        const bigGz = zlib.gzipSync(bigPlain);
        const handler = async (req, res) => {
            if (req.url === '/big') {
                res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
                for (let off = 0; off < bigGz.length; off += 16384) {
                    res.write(bigGz.subarray(off, off + 16384));
                    await sleep(5);
                }
                res.end();
            } else if (req.url === '/slow') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.write('first-part;');
                await sleep(1500);
                res.end('second-part');
            } else if (req.url === '/critical') {
                criticalHits++;
                const payload = JSON.stringify({ hits: criticalHits, fullVersionList: req.headers['sec-ch-ua-full-version-list'] || null });
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'accept-ch': 'Sec-CH-UA-Full-Version-List',
                    'critical-ch': 'Sec-CH-UA-Full-Version-List',
                });
                await sleep(50); // body still in flight when the MITM decides to retry
                res.end(payload);
            } else if (req.url === '/setjar') {
                res.writeHead(200, { 'set-cookie': 'jarleak=1; Path=/', 'content-type': 'text/plain', 'content-length': '2' });
                res.end('ok');
            } else if (req.url === '/echocookie') {
                const c = String(req.headers.cookie || '');
                res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(c)) });
                res.end(c);
            } else if (req.url === '/video') {
                res.writeHead(200, { 'content-type': 'video/mp4' });
                res.end(Buffer.alloc(64 * 1024, 3));
            } else if (req.url === '/count') {
                originHits++;
                res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
                res.end('ok');
            } else if (req.url === '/cookies') {
                res.setHeader('Set-Cookie', ['sid=abc123; Path=/; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT', 'csrf=xyz789; Path=/; Secure']);
                res.setHeader('content-type', 'text/plain');
                res.end('ok');
            } else if (req.url === '/endless') {
                res.writeHead(200, { 'content-type': 'application/octet-stream' });
                req.on('close', () => { endlessClosed = true; });
                const blob = Buffer.alloc(32 * 1024, 7);
                while (!res.destroyed && !endlessClosed) {
                    res.write(blob);
                    await sleep(20);
                }
            } else {
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': '11' });
                res.end('{"ok":true}');
            }
        };
        upstream = https.createServer({ key: cert.key, cert: cert.cert }, handler);
        upstream.on('connection', () => { originConns++; });
        await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
        upstreamPort = upstream.address().port;
        upstreamHttp = http.createServer(handler);
        await new Promise((r) => upstreamHttp.listen(0, '127.0.0.1', r));
        upstreamHttpPort = upstreamHttp.address().port;

        process.env.CUPNET_MITM_STREAM = '1';
        mitm = new mitmMod.MitmProxy({ port: 0, browser: 'chrome' });
        await mitm.start();
        mitmPort = mitm._server.address().port;

        ext = new mitmMod.ExternalProxyPort(mitm, {
            port: 0, login: 'u', password: 'p', name: 'test',
            onRequestLogged: (e) => extLogged.push(e),
        });
        await ext.start();
        extPort = ext._server.address().port;
    }, 120_000);

    afterAll(async () => {
        if (prevFlag === undefined) delete process.env.CUPNET_MITM_STREAM; else process.env.CUPNET_MITM_STREAM = prevFlag;
        endlessClosed = true;
        try { ext?.stop(); } catch {}
        try { mitm?.stop(); } catch {}
        await new Promise((r) => (upstream ? upstream.close(() => r()) : r()));
        await new Promise((r) => (upstreamHttp ? upstreamHttp.close(() => r()) : r()));
    });

    it('streams a gzip body chunked and decoded (no Content-Encoding reaches the browser)', async () => {
        expect(mitm.worker._streaming).toBe(true);
        const r = await getViaMitm(mitmPort, upstreamPort, '/big');
        expect(r.status).toBe(200);
        expect(r.head).toMatch(/transfer-encoding: chunked/i);
        expect(r.head).not.toMatch(/content-encoding/i);
        expect(r.body.equals(bigPlain)).toBe(true);
    }, 30_000);

    it('delivers the first bytes before the upstream finishes (real streaming)', async () => {
        const r = await getViaMitm(mitmPort, upstreamPort, '/slow');
        expect(r.body.toString()).toBe('first-part;second-part');
        // The upstream holds the second part back for 1.5 s; the first bytes must not wait for it.
        expect(r.totalMs - r.firstBodyAt).toBeGreaterThan(1000);
    }, 30_000);

    it('non-streamable requests keep the buffered path (HEAD → Content-Length)', async () => {
        const r = await getViaMitm(mitmPort, upstreamPort, '/json', { method: 'HEAD' });
        expect(r.status).toBe(200);
        expect(r.head).toMatch(/content-length:/i);
        expect(r.head).not.toMatch(/transfer-encoding/i);
    }, 30_000);

    it('Critical-CH on a streamed navigation: stream is dropped, request retried with the hint', async () => {
        const catalog = require(path.join(repoRoot, 'browser-identity-catalog.js'));
        mitm.setIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }));
        try {
            criticalHits = 0;
            const r = await getViaMitm(mitmPort, upstreamPort, '/critical', {
                extraHeaders: ['Sec-Fetch-Mode: navigate', 'Sec-Fetch-Dest: document', 'Upgrade-Insecure-Requests: 1'],
            });
            expect(r.status).toBe(200);
            const body = JSON.parse(r.body.toString('utf8'));
            // The browser must receive the retried response (second hit, hint present), not the first.
            expect(body.hits).toBe(2);
            expect(body.fullVersionList).toBeTruthy();
        } finally {
            mitm.setIdentity(null);
        }
    }, 30_000);

    it('pipelined requests on one connection: streamed then buffered, answered in order', async () => {
        const r = await getViaMitm(mitmPort, upstreamPort, null, { paths: ['/slow', '/json'] });
        expect(r.all.map((x) => x.body.toString())).toEqual(['first-part;second-part', '{"ok":true}']);
        expect(r.all[0].head).toMatch(/transfer-encoding: chunked/i);
    }, 30_000);

    it('plain-HTTP through the tab proxy streams too', async () => {
        const r = await getViaMitm(mitmPort, upstreamHttpPort, '/slow', { plain: true });
        expect(r.status).toBe(200);
        expect(r.head).toMatch(/transfer-encoding: chunked/i);
        expect(r.body.toString()).toBe('first-part;second-part');
        expect(r.totalMs - r.firstBodyAt).toBeGreaterThan(1000);
        const big = await getViaMitm(mitmPort, upstreamHttpPort, '/big', { plain: true });
        expect(big.body.equals(bigPlain)).toBe(true);
    }, 30_000);

    it('External Proxy still requires its password', async () => {
        const r = await getViaMitm(extPort, upstreamPort, '/json');
        expect(r.connectStatus).toBe(407);
    }, 30_000);

    it('External Proxy HTTPS: streamed, decoded, and the body is logged', async () => {
        extLogged.length = 0;
        const slow = await getViaMitm(extPort, upstreamPort, '/slow', { auth: 'u:p' });
        expect(slow.body.toString()).toBe('first-part;second-part');
        expect(slow.head).toMatch(/transfer-encoding: chunked/i);
        expect(slow.totalMs - slow.firstBodyAt).toBeGreaterThan(1000);
        const big = await getViaMitm(extPort, upstreamPort, '/big', { auth: 'u:p' });
        expect(big.body.equals(bigPlain)).toBe(true);
        const deadline = Date.now() + 5000;
        while (extLogged.length < 2 && Date.now() < deadline) await sleep(25);
        const bigLog = extLogged.find((e) => String(e.url).endsWith('/big'));
        expect(bigLog?.status).toBe(200);
        expect(bigLog?.responseBody).toBe(bigPlain.toString('utf8'));
    }, 30_000);

    it('streamed media is delivered but logged without its body', async () => {
        extLogged.length = 0;
        const r = await getViaMitm(extPort, upstreamPort, '/video', { auth: 'u:p' });
        expect(r.body.length).toBe(64 * 1024);
        const deadline = Date.now() + 5000;
        while (!extLogged.some((e) => String(e.url).endsWith('/video')) && Date.now() < deadline) await sleep(25);
        const log = extLogged.find((e) => String(e.url).endsWith('/video'));
        expect(log?.status).toBe(200);
        expect(log?.responseBody).toBeNull();
    }, 30_000);

    it('A-014: the worker never replays upstream cookies the browser did not send', async () => {
        await getViaMitm(mitmPort, upstreamPort, '/setjar');
        const r = await getViaMitm(mitmPort, upstreamPort, '/echocookie'); // browser sends no Cookie
        expect(r.body.toString()).toBe('');
    }, 30_000);

    it('External Proxy plain-HTTP streams too', async () => {
        const r = await getViaMitm(extPort, upstreamHttpPort, '/slow', { plain: true, auth: 'u:p' });
        expect(r.status).toBe(200);
        expect(r.head).toMatch(/transfer-encoding: chunked/i);
        expect(r.body.toString()).toBe('first-part;second-part');
        expect(r.totalMs - r.firstBodyAt).toBeGreaterThan(1000);
    }, 30_000);

    it('External Proxy: closing the client cancels the upstream download', async () => {
        endlessClosed = false;
        const r = await getViaMitm(extPort, upstreamPort, '/endless', { auth: 'u:p', onFirstBody: (s) => s.destroy() });
        expect(r.aborted).toBe(true);
        const abortedAt = Date.now();
        while (!endlessClosed && Date.now() - abortedAt < 10_000) await sleep(25);
        expect(endlessClosed).toBe(true);
        expect(Date.now() - abortedAt).toBeLessThan(3000);
    }, 30_000);

    it('several Set-Cookie headers reach the browser as separate lines (streamed and buffered)', async () => {
        const want = ['sid=abc123; Path=/; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT', 'csrf=xyz789; Path=/; Secure'];
        const cookieLines = (head) => head.split('\r\n').filter((l) => /^set-cookie:/i.test(l)).map((l) => l.replace(/^set-cookie:\s*/i, ''));
        const streamed = await getViaMitm(mitmPort, upstreamPort, '/cookies');
        expect(streamed.head).toMatch(/transfer-encoding: chunked/i);
        expect(cookieLines(streamed.head)).toEqual(want);
        const buffered = await getViaMitm(mitmPort, upstreamPort, '/cookies', { method: 'HEAD' });
        expect(buffered.head).not.toMatch(/transfer-encoding/i);
        expect(cookieLines(buffered.head)).toEqual(want);
    }, 30_000);

    it('A-008: a dropping upstream proxy never falls back to a direct request (no real-IP leak)', async () => {
        // An upstream proxy that accepts and immediately drops every connection (rotation / auth hiccup).
        const dropper = net.createServer((s) => s.destroy());
        await new Promise((r) => dropper.listen(0, '127.0.0.1', r));
        mitm.setUpstream(`http://127.0.0.1:${dropper.address().port}`);
        try {
            originHits = 0;
            const r = await getViaMitm(mitmPort, upstreamPort, '/count');
            expect(r.status).toBe(502);
            expect(originHits).toBe(0);
        } finally {
            mitm.setUpstream(null);
            await new Promise((r) => dropper.close(() => r()));
        }
    }, 60_000);

    describe('A-042: TLS passthrough and WebSocket tunnels honour fail-closed egress and tab proxies', () => {
        const wsHeaders = ['Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
        let dropper; let dropperConns = 0;
        beforeAll(async () => {
            dropper = net.createServer((s) => { dropperConns++; s.destroy(); });
            await new Promise((r) => dropper.listen(0, '127.0.0.1', r));
        });
        afterAll(async () => {
            mitm.setEgressBlocked(false);
            mitm.setTlsPassthroughDomains([]);
            mitm.removeTabUpstream?.('tab_pt');
            await new Promise((r) => dropper.close(() => r()));
        });

        it('passthrough with egress blocked and no proxy: 502, no direct connection', async () => {
            mitm.setTlsPassthroughDomains(['127.0.0.1']);
            mitm.setEgressBlocked(true, 'test');
            try {
                originConns = 0;
                const r = await getViaMitm(mitmPort, upstreamPort, '/json');
                expect(r.connectStatus).toBe(502);
                await sleep(200);
                expect(originConns).toBe(0);
            } finally {
                mitm.setEgressBlocked(false);
                mitm.setTlsPassthroughDomains([]);
            }
        }, 30_000);

        it("passthrough on a tab with its own proxy goes through that proxy, not direct", async () => {
            mitm.setTlsPassthroughDomains(['127.0.0.1']);
            mitm.setTabUpstream('tab_pt', { upstream: `http://127.0.0.1:${dropper.address().port}` });
            try {
                originConns = 0; dropperConns = 0;
                const r = await getViaMitm(mitmPort, upstreamPort, '/json', { auth: 'tab_pt:cupnet' });
                expect(r.connectStatus).toBe(502); // the (dropping) tab proxy was used
                expect(dropperConns).toBeGreaterThan(0);
                expect(originConns).toBe(0);
            } finally {
                mitm.removeTabUpstream('tab_pt');
                mitm.setTlsPassthroughDomains([]);
            }
        }, 30_000);

        it('WebSocket upgrade with egress blocked: 502, no direct connection', async () => {
            mitm.setEgressBlocked(true, 'test');
            try {
                originConns = 0;
                const r = await getViaMitm(mitmPort, upstreamPort, '/ws', { extraHeaders: wsHeaders });
                expect(r.status).toBe(502);
                await sleep(200);
                expect(originConns).toBe(0);
            } finally {
                mitm.setEgressBlocked(false);
            }
        }, 30_000);
    });

    it('closing the browser socket cancels the upstream download', async () => {
        endlessClosed = false;
        const r = await getViaMitm(mitmPort, upstreamPort, '/endless', {
            onFirstBody: (tlsSock) => tlsSock.destroy(),
        });
        expect(r.aborted).toBe(true);
        const abortedAt = Date.now();
        while (!endlessClosed && Date.now() - abortedAt < 10_000) await sleep(25);
        expect(endlessClosed).toBe(true);
        // Cancel must reach the worker promptly, not after an idle/request timeout.
        expect(Date.now() - abortedAt).toBeLessThan(3000);
    }, 30_000);
});
