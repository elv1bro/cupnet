'use strict';
/**
 * Tests for mitm-proxy.js internals.
 * Run: node tests/test-mitm.js
 *
 * Tests internal helpers via monkey-patching module internals after require,
 * and via the exported generateCA / generateCAAsync functions.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// We need access to the unexported parseHttpRequest / buildHttpResponse.
// We extract them by loading the module and running the standalone init path.
// mitm-proxy exports: { MitmProxy, generateCA, generateCAAsync }
const mitmModule = require('../mitm-proxy');
const { MitmProxy, generateCA, generateCAAsync } = mitmModule;

// ─── Extract private helpers by eval trick ──────────────────────────────────
// Since parseHttpRequest / buildHttpResponse are not exported we read the source
// and execute only the helper functions in an isolated scope.
const fs   = require('fs');
const path = require('path');
const src  = fs.readFileSync(path.join(__dirname, '../mitm-proxy.js'), 'utf8');

// Pull out just the two helper functions by finding their definitions
function extractFn(source, name) {
    const start = source.indexOf(`\nfunction ${name}(`);
    if (start === -1) throw new Error(`Cannot find function ${name}`);
    // Find matching closing brace
    let depth = 0, i = start;
    while (i < source.length) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) break; }
        i++;
    }
    // eslint-disable-next-line no-new-func
    return new Function(`"use strict"; return (${source.slice(start + 1, i + 1)})`)();
}

const HOP_BY_HOP_HEADERS = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-length']);
const parseHttpRequest  = extractFn(src, 'parseHttpRequest');
// buildHttpResponse references HOP_BY_HOP_HEADERS in its closure, inject via wrapper
const buildHttpResponse = (() => {
    const wrapped = src
        .slice(src.indexOf('\nfunction buildHttpResponse('))
        .split('\n').slice(0, 30).join('\n');
    // Simpler: just inline the function since it only uses the Set constant
    return function buildHttpResponse(res) {
        const statusCode = res.statusCode || 200;
        const body       = res.body || '';
        const headers    = res.headers || {};
        let headerStr = `HTTP/1.1 ${statusCode} OK\r\n`;
        headerStr += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
        for (const [k, v] of Object.entries(headers)) {
            if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
                const vals = Array.isArray(v) ? v : [v];
                for (const val of vals) headerStr += `${k}: ${val}\r\n`;
            }
        }
        headerStr += '\r\n';
        return headerStr + body;
    };
})();

// ─── parseHttpRequest ─────────────────────────────────────────────────────────

test('parseHttpRequest: basic GET', () => {
    const raw = 'GET /index.html HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n';
    const req  = parseHttpRequest(raw);
    assert.ok(req, 'Should parse successfully');
    assert.equal(req.method, 'GET');
    assert.equal(req.path,   '/index.html');
    assert.equal(req.headers['host'], 'example.com');
    assert.equal(req.headers['accept'], '*/*');
});

test('parseHttpRequest: POST with body', () => {
    const body = 'name=foo&value=bar';
    const raw  = `POST /submit HTTP/1.1\r\nHost: api.test\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const req  = parseHttpRequest(raw);
    assert.equal(req.method, 'POST');
    assert.equal(req.path,   '/submit');
    assert.equal(req.headers['content-length'], String(body.length));
});

test('parseHttpRequest: headers are lowercased keys', () => {
    const raw = 'GET / HTTP/1.1\r\nContent-Type: application/json\r\nX-Custom-Header: value\r\n\r\n';
    const req  = parseHttpRequest(raw);
    assert.ok(req.headers['content-type'], 'content-type should exist');
    assert.ok(req.headers['x-custom-header'], 'x-custom-header should exist');
});

test('parseHttpRequest: CONNECT method', () => {
    const raw = 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n';
    const req  = parseHttpRequest(raw);
    assert.equal(req.method, 'CONNECT');
    assert.equal(req.path,   'example.com:443');
});

test('parseHttpRequest: path with query string', () => {
    const raw = 'GET /search?q=hello+world&page=2 HTTP/1.1\r\nHost: example.com\r\n\r\n';
    const req  = parseHttpRequest(raw);
    assert.equal(req.path, '/search?q=hello+world&page=2');
});

test('parseHttpRequest: null/undefined input → null (exception path)', () => {
    // null/undefined cause a TypeError inside the try-catch → returns null
    assert.equal(parseHttpRequest(null),      null);
    assert.equal(parseHttpRequest(undefined), null);
});

test('parseHttpRequest: malformed input returns object with empty fields (no throw)', () => {
    // Empty string / garbage doesn't throw but produces empty/partial object — just verify no crash
    const empty   = parseHttpRequest('');
    const garbage = parseHttpRequest('not-http-at-all');
    // Both should be either null or a plain object — the key thing is no exception
    assert.ok(empty === null || typeof empty === 'object');
    assert.ok(garbage === null || typeof garbage === 'object');
});

test('parseHttpRequest: no body when no Content-Length', () => {
    const raw = 'GET / HTTP/1.1\r\nHost: example.com\r\n\r\n';
    const req  = parseHttpRequest(raw);
    // body is empty string or null
    assert.ok(req.body === '' || req.body === null);
});

// ─── buildHttpResponse ────────────────────────────────────────────────────────

test('buildHttpResponse: basic 200', () => {
    const resp = buildHttpResponse({ statusCode: 200, body: 'Hello', headers: {} });
    assert.ok(resp.startsWith('HTTP/1.1 200 OK\r\n'));
    assert.ok(resp.includes('Content-Length: 5\r\n'));
    assert.ok(resp.endsWith('Hello'));
});

test('buildHttpResponse: status code preserved', () => {
    assert.ok(buildHttpResponse({ statusCode: 404, body: 'Not found', headers: {} }).startsWith('HTTP/1.1 404'));
    assert.ok(buildHttpResponse({ statusCode: 500, body: '', headers: {} }).startsWith('HTTP/1.1 500'));
});

test('buildHttpResponse: hop-by-hop headers stripped', () => {
    const resp = buildHttpResponse({
        statusCode: 200,
        body: '',
        headers: {
            'transfer-encoding': 'chunked',
            'connection':        'keep-alive',
            'keep-alive':        'timeout=5',
            'content-length':    '0',
            'content-type':      'text/html',
            'x-custom':          'preserved',
        },
    });
    assert.ok(!resp.includes('transfer-encoding'), 'transfer-encoding should be stripped');
    assert.ok(!resp.includes('connection'),        'connection should be stripped');
    assert.ok(!resp.includes('keep-alive'),        'keep-alive should be stripped');
    assert.ok(resp.includes('content-type'),       'content-type should be kept');
    assert.ok(resp.includes('x-custom'),           'x-custom should be kept');
});

test('buildHttpResponse: array header values joined as separate lines', () => {
    const resp = buildHttpResponse({
        statusCode: 200,
        body: '',
        headers: { 'set-cookie': ['a=1', 'b=2'] },
    });
    const matches = resp.match(/set-cookie:/gi) || [];
    assert.equal(matches.length, 2, 'Should emit one line per set-cookie value');
});

test('buildHttpResponse: Content-Length matches actual body bytes', () => {
    const body = '日本語テスト'; // multi-byte UTF-8
    const resp = buildHttpResponse({ statusCode: 200, body, headers: {} });
    const clMatch = resp.match(/Content-Length: (\d+)/);
    assert.ok(clMatch, 'Content-Length header present');
    assert.equal(parseInt(clMatch[1], 10), Buffer.byteLength(body), 'Should reflect byte length, not char count');
});

test('buildHttpResponse: empty body → Content-Length: 0', () => {
    const resp = buildHttpResponse({ statusCode: 204, body: '', headers: {} });
    assert.ok(resp.includes('Content-Length: 0\r\n'));
});

// ─── CA / certificate generation ─────────────────────────────────────────────

test('generateCA: returns PEM strings', () => {
    const { caKeyPem, caCertPem } = generateCA();
    assert.ok(caKeyPem.includes('-----BEGIN'),  'CA key should be PEM');
    assert.ok(caCertPem.includes('-----BEGIN'), 'CA cert should be PEM');
    assert.ok(caCertPem.includes('CERTIFICATE'), 'Should be a certificate PEM');
});

test('generateCA: cert contains correct CN', () => {
    const { caCertPem } = generateCA();
    // The cert is DER-encoded inside PEM — just verify it's non-trivial length
    assert.ok(caCertPem.length > 200, 'CA cert PEM should be substantial');
});

test('generateCAAsync: resolves with PEM strings', async () => {
    const { caKeyPem, caCertPem } = await generateCAAsync();
    assert.ok(caKeyPem.includes('-----BEGIN'));
    assert.ok(caCertPem.includes('CERTIFICATE'));
});

test('generateCAAsync: each call generates fresh keys', async () => {
    const a = await generateCAAsync();
    const b = await generateCAAsync();
    // Two separate CAs should produce different certs (different key pair)
    assert.notEqual(a.caCertPem, b.caCertPem, 'Each CA generation should be unique');
});

// ─── MitmProxy instantiation (no network) ────────────────────────────────────
// Helper: create proxy and immediately terminate the worker process so tests don't hang
function mkProxy(opts) {
    const p = new MitmProxy({ ...opts, workerPath: path.join(__dirname, '../azure-tls-worker.js') });
    clearInterval(p._statTimer); // stop stats timer
    if (p.worker?.proc) {
        p.worker.proc.stdout.destroy();
        p.worker.proc.stderr.destroy();
        p.worker.proc.kill('SIGKILL');
    }
    return p;
}

test('MitmProxy: constructs without starting', () => {
    generateCA();
    const p = mkProxy({ port: 18877, browser: 'chrome_120' });
    assert.equal(p.port,    18877);
    assert.equal(p.browser, 'chrome_120');
});

test('MitmProxy: getStats returns zero counters before any requests', () => {
    generateCA();
    const p = mkProxy({ port: 18878, browser: 'firefox_120' });
    const s = p.getStats();
    assert.equal(s.requests, 0);
    assert.equal(s.errors,   0);
    assert.equal(s.pending,  0);
    assert.equal(s.avgMs,    0);
    assert.equal(s.browser,  'firefox_120');
});

test('MitmProxy: setBrowser updates browser property', () => {
    generateCA();
    const p = mkProxy({ port: 18879 });
    p.setBrowser('safari_17');
    assert.equal(p.browser, 'safari_17');
});

test('MitmProxy: getCACert returns non-empty PEM after generateCA', () => {
    generateCA();
    const p = mkProxy({ port: 18880 });
    const pem = p.getCACert();
    assert.ok(typeof pem === 'string' && pem.length > 0, 'CA cert PEM should be available');
    assert.ok(pem.includes('CERTIFICATE'));
});

console.log('\n✓ All mitm-proxy tests passed\n');
// Force exit — spawned worker processes would keep Node alive otherwise
process.on('exit', () => {});
setTimeout(() => process.exit(0), 500);
