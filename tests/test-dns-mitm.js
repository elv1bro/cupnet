'use strict';
/**
 * Unit tests: DNS overrides (host→IP, Rewrite Host), MITM CORS patterns, CORS response injection.
 * Run: node tests/test-dns-mitm.js
 *
 * Plain Node (не Electron): без нативного in-process AzureTLS конструктор MitmProxy падает —
 * по умолчанию включаем дочерний worker (см. mitm-proxy createMitmAzureBackend).
 */
if (!process.versions.electron && process.env.CUPNET_AZURETLS_CHILD_PROCESS == null) {
    process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1';
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
    MitmProxy,
    _testApplyMitmCorsToResponse: applyMitmCorsToResponse,
    _testShouldSkipMitmCorsForUrl: shouldSkipMitmCorsForUrl,
    _testMatchHostPattern: matchHostPattern,
} = require('../mitm-proxy');

function mkProxy() {
    const p = new MitmProxy({
        port: 19977,
        browser: 'chrome_120',
        workerPath: path.join(__dirname, '../azure-tls-worker.js'),
    });
    clearInterval(p._statTimer);
    if (p.worker?.proc) {
        p.worker.proc.stdout.destroy();
        p.worker.proc.stderr.destroy();
        p.worker.proc.kill('SIGKILL');
    }
    return p;
}

// ─── _matchHostPattern (same as mitm-proxy) ───────────────────────────────────

test('matchHostPattern: exact host', () => {
    assert.equal(matchHostPattern('api.example.com', 'api.example.com'), true);
    assert.equal(matchHostPattern('api.example.com', 'other.example.com'), false);
});

test('matchHostPattern: wildcard suffix', () => {
    assert.equal(matchHostPattern('*.example.com', 'api.example.com'), true);
    assert.equal(matchHostPattern('*.example.com', 'a.b.example.com'), true);
    assert.equal(matchHostPattern('*.example.com', 'example.com'), true);
    assert.equal(matchHostPattern('*.example.com', 'notexample.com'), false);
});

// ─── setDnsOverrides + _applyDnsOverride ─────────────────────────────────────

test('DNS override: URL host replaced with IP, Host header = logical hostname', () => {
    const p = mkProxy();
    p.setDnsOverrides([{ host: 'api.example.com', ip: '203.0.113.10', enabled: true }]);
    const out = p._applyDnsOverride({
        url: 'https://api.example.com/v1/x',
        headers: { host: 'api.example.com' },
    });
    assert.equal(out.url, 'https://203.0.113.10/v1/x');
    assert.equal(out.headers.host, 'api.example.com');
    assert.equal(out.dnsOverride.host, 'api.example.com');
    assert.equal(out.dnsOverride.ip, '203.0.113.10');
    assert.equal(out.dnsOverride.rewriteHost, undefined);
});

test('DNS override: non-default HTTPS port preserved in Host when no rewrite', () => {
    const p = mkProxy();
    p.setDnsOverrides([{ host: 'api.example.com', ip: '127.0.0.1', enabled: true }]);
    const out = p._applyDnsOverride({
        url: 'https://api.example.com:8443/path',
        headers: {},
    });
    assert.equal(out.url, 'https://127.0.0.1:8443/path');
    assert.equal(out.headers.host, 'api.example.com:8443');
});

test('DNS override: rewrite_host replaces Host header', () => {
    const p = mkProxy();
    p.setDnsOverrides([{
        host: 'public.example.com',
        ip: '198.51.100.2',
        enabled: true,
        rewrite_host: 'internal-vhost.local',
    }]);
    const out = p._applyDnsOverride({
        url: 'https://public.example.com/',
        headers: {},
    });
    assert.equal(out.url, 'https://198.51.100.2/');
    assert.equal(out.headers.host, 'internal-vhost.local');
    assert.deepEqual(out.dnsOverride, {
        host: 'public.example.com',
        ip: '198.51.100.2',
        rewriteHost: 'internal-vhost.local',
    });
});

test('DNS override: orderedHeaders Host replaced when present', () => {
    const p = mkProxy();
    p.setDnsOverrides([{ host: 'h.test', ip: '10.0.0.1', enabled: true, rewrite_host: 'v.internal' }]);
    const out = p._applyDnsOverride({
        url: 'https://h.test/z',
        headers: { host: 'h.test' },
        orderedHeaders: [['X-Foo', '1'], ['Host', 'h.test'], ['Accept', '*/*']],
    });
    const hostPairs = out.orderedHeaders.filter(([k]) => String(k).toLowerCase() === 'host');
    assert.equal(hostPairs.length, 1);
    assert.equal(hostPairs[0][1], 'v.internal');
});

test('DNS override: no rule for host → unchanged', () => {
    const p = mkProxy();
    p.setDnsOverrides([{ host: 'only.this', ip: '1.1.1.1', enabled: true }]);
    const out = p._applyDnsOverride({ url: 'https://other.com/', headers: {} });
    assert.equal(out.url, 'https://other.com/');
    assert.equal(out.dnsOverride, undefined);
});

test('DNS override: wildcard CORS-only rule does not redirect (no IP in map)', () => {
    const p = mkProxy();
    p.setDnsOverrides([{ host: '*.cdn.test', enabled: true, mitm_inject_cors: true }]);
    const out = p._applyDnsOverride({ url: 'https://x.cdn.test/r', headers: {} });
    assert.equal(out.url, 'https://x.cdn.test/r');
    assert.equal(out.dnsOverride, undefined);
});

// ─── _mitmCorsEnabledForUrl ───────────────────────────────────────────────────

test('MITM CORS pattern: exact host enables CORS for URL', () => {
    const p = mkProxy();
    p.setDnsOverrides([{ host: 'api.cors.test', enabled: true, mitm_inject_cors: true, ip: '192.0.2.1' }]);
    assert.equal(p._mitmCorsEnabledForUrl('https://api.cors.test/data'), true);
});

test('MITM CORS pattern: wildcard enables matching subdomains', () => {
    const p = mkProxy();
    p.setDnsOverrides([{ host: '*.wild.test', enabled: true, mitm_inject_cors: true }]);
    assert.equal(p._mitmCorsEnabledForUrl('https://a.b.wild.test/x'), true);
    assert.equal(p._mitmCorsEnabledForUrl('https://wild.test/x'), true);
    assert.equal(p._mitmCorsEnabledForUrl('https://nowild.test/x'), false);
});

// ─── shouldSkipMitmCorsForUrl + applyMitmCorsToResponse ───────────────────────

test('shouldSkipMitmCorsForUrl: Cloudflare challenge hosts skipped', () => {
    assert.equal(shouldSkipMitmCorsForUrl('https://challenges.cloudflare.com/turnstile/v0/api.js'), true);
});

test('applyMitmCorsToResponse: disabled → same object', () => {
    const res = { statusCode: 200, headers: { 'content-type': 'application/json' } };
    const out = applyMitmCorsToResponse(false, 'https://api.test/x', { Origin: 'https://app.test' }, 'GET', res);
    assert.strictEqual(out, res);
});

test('applyMitmCorsToResponse: no Origin/Referer → unchanged', () => {
    const res = { statusCode: 200, headers: {} };
    const out = applyMitmCorsToResponse(true, 'https://api.test/x', {}, 'GET', res);
    assert.strictEqual(out, res);
});

test('applyMitmCorsToResponse: injects ACAO from Origin, strips upstream CORS', () => {
    const res = {
        statusCode: 200,
        headers: {
            'access-control-allow-origin': 'https://evil.example',
            'content-type':                  'application/json',
        },
    };
    const out = applyMitmCorsToResponse(
        true,
        'https://api.test/x',
        { Origin: 'https://trusted.app' },
        'GET',
        res,
    );
    assert.equal(out.headers['Access-Control-Allow-Origin'], 'https://trusted.app');
    assert.equal(out.headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(out.headers['content-type'], 'application/json');
    assert.equal(out.headers['access-control-allow-origin'], undefined);
});

test('applyMitmCorsToResponse: OPTIONS preflight sets Allow-Methods/Headers', () => {
    const res = { statusCode: 204, headers: {} };
    const out = applyMitmCorsToResponse(
        true,
        'https://api.test/x',
        {
            Origin:                         'https://app.test',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization, content-type',
        },
        'OPTIONS',
        res,
    );
    assert.ok(out.headers['Access-Control-Allow-Methods'].includes('POST'));
    assert.ok(String(out.headers['Access-Control-Allow-Headers']).includes('authorization'));
    assert.equal(out.headers['Access-Control-Max-Age'], '86400');
});

test('applyMitmCorsToResponse: Referer used when Origin missing', () => {
    const res = { statusCode: 200, headers: {} };
    const out = applyMitmCorsToResponse(
        true,
        'https://api.test/x',
        { Referer: 'https://spa.example/page' },
        'GET',
        res,
    );
    assert.equal(out.headers['Access-Control-Allow-Origin'], 'https://spa.example');
});

