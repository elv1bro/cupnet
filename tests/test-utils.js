'use strict';
/**
 * Tests for utils.js — pure utility functions, no Electron needed.
 * Run: node tests/test-utils.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const {
    resolveNavigationUrl,
    parseProxyTemplate,
    extractTemplateVars,
    formatBytes,
    shouldFilterUrl,
    sanitizeOutgoingRequestHeaders,
    SEARCH_ENGINE,
} = require('../utils');

// ─── resolveNavigationUrl ─────────────────────────────────────────────────────

test('resolveNavigationUrl: null / empty → null', () => {
    assert.equal(resolveNavigationUrl(null),      null);
    assert.equal(resolveNavigationUrl(''),        null);
    assert.equal(resolveNavigationUrl('   '),     null);
    assert.equal(resolveNavigationUrl(undefined), null);
    assert.equal(resolveNavigationUrl(42),        null);
});

test('resolveNavigationUrl: full URL returned as-is', () => {
    assert.equal(resolveNavigationUrl('https://example.com'), 'https://example.com');
    assert.equal(resolveNavigationUrl('http://foo.bar/baz?q=1'), 'http://foo.bar/baz?q=1');
    assert.equal(resolveNavigationUrl('ftp://files.example.com'), 'ftp://files.example.com');
});

test('resolveNavigationUrl: domain without protocol → prepend https', () => {
    assert.equal(resolveNavigationUrl('google.com'),       'https://google.com');
    assert.equal(resolveNavigationUrl('  example.org  '), 'https://example.org');
    assert.equal(resolveNavigationUrl('sub.domain.io'),   'https://sub.domain.io');
});

test('resolveNavigationUrl: search query → DuckDuckGo URL', () => {
    const url = resolveNavigationUrl('hello world');
    assert.ok(url.startsWith(SEARCH_ENGINE), `Expected DDG prefix, got: ${url}`);
    assert.ok(url.includes('hello'), `Expected "hello" in: ${url}`);
});

test('resolveNavigationUrl: single word without dot → search', () => {
    const url = resolveNavigationUrl('javascript');
    assert.ok(url.startsWith(SEARCH_ENGINE));
});

test('resolveNavigationUrl: IP address → prepend https', () => {
    assert.equal(resolveNavigationUrl('192.168.1.1'), 'https://192.168.1.1');
});

// ─── parseProxyTemplate ───────────────────────────────────────────────────────

test('parseProxyTemplate: no placeholders → unchanged', () => {
    const tpl = 'http://user:pass@proxy.example.com:8080';
    assert.equal(parseProxyTemplate(tpl), tpl);
});

test('parseProxyTemplate: {VAR} replaced from vars', () => {
    const result = parseProxyTemplate('http://user:{PASS}@host:8080', { PASS: 'secret' });
    assert.equal(result, 'http://user:secret@host:8080');
});

test('parseProxyTemplate: var lookup is case-insensitive', () => {
    const result = parseProxyTemplate('{user}:{password}@host', { User: 'admin', PASSWORD: '123' });
    assert.equal(result, 'admin:123@host');
});

test('parseProxyTemplate: missing var stays as placeholder', () => {
    const result = parseProxyTemplate('http://{USER}:{PASS}@host', { USER: 'admin' });
    assert.equal(result, 'http://admin:{PASS}@host');
});

test('parseProxyTemplate: {RAND:min-max} replaced with number in range', () => {
    for (let i = 0; i < 50; i++) {
        const result = parseProxyTemplate('port={RAND:1000-2000}');
        const num = parseInt(result.replace('port=', ''), 10);
        assert.ok(num >= 1000 && num <= 2000, `Out of range: ${num}`);
    }
});

test('parseProxyTemplate: {RAND} with equal bounds always returns that value', () => {
    const result = parseProxyTemplate('{RAND:42-42}');
    assert.equal(result, '42');
});

test('parseProxyTemplate: {SID} auto-generated when not in vars', () => {
    const result = parseProxyTemplate('session={SID}');
    assert.match(result, /^session=cupnet\d{10}$/);
});

test('parseProxyTemplate: {SID} overridable via vars', () => {
    const result = parseProxyTemplate('session={SID}', { SID: 'my-custom-sid' });
    assert.equal(result, 'session=my-custom-sid');
});

test('parseProxyTemplate: multiple placeholders in one template', () => {
    const tpl    = 'http://{USER}:{PASS}@{HOST}:{RAND:8000-9000}/{SID}';
    const result = parseProxyTemplate(tpl, { USER: 'u', PASS: 'p', HOST: 'proxy.io' });
    assert.match(result, /^http:\/\/u:p@proxy\.io:\d{4}\/cupnet\d{10}$/);
});

// ─── extractTemplateVars ──────────────────────────────────────────────────────

test('extractTemplateVars: extracts uppercase var names', () => {
    const vars = extractTemplateVars('http://{USER}:{PASS}@{HOST}');
    assert.deepEqual(vars.sort(), ['HOST', 'PASS', 'USER']);
});

test('extractTemplateVars: no duplicates', () => {
    const vars = extractTemplateVars('{X}/{X}/{X}');
    assert.equal(vars.length, 1);
    assert.equal(vars[0], 'X');
});

test('extractTemplateVars: empty template → empty array', () => {
    assert.deepEqual(extractTemplateVars('http://plain.host:8080'), []);
});

// ─── formatBytes ─────────────────────────────────────────────────────────────

test('formatBytes: zero / falsy → "0 B"', () => {
    assert.equal(formatBytes(0),    '0 B');
    assert.equal(formatBytes(null), '0 B');
    assert.equal(formatBytes(undefined), '0 B');
});

test('formatBytes: bytes', () => {
    assert.equal(formatBytes(512), '512.0 B');
});

test('formatBytes: kilobytes', () => {
    assert.equal(formatBytes(1024),      '1.0 KB');
    assert.equal(formatBytes(1536),      '1.5 KB');
    assert.equal(formatBytes(1024 * 10), '10.0 KB');
});

test('formatBytes: megabytes', () => {
    assert.equal(formatBytes(1024 * 1024),      '1.0 MB');
    assert.equal(formatBytes(1024 * 1024 * 2.5), '2.5 MB');
});

test('formatBytes: gigabytes', () => {
    assert.equal(formatBytes(1024 ** 3), '1.0 GB');
});

// ─── shouldFilterUrl ─────────────────────────────────────────────────────────

test('shouldFilterUrl: file:// always filtered', () => {
    assert.equal(shouldFilterUrl('file:///path/to/new-tab.html', []), true);
    assert.equal(shouldFilterUrl('file://localhost/app', ['*']), true);
});

test('shouldFilterUrl: no patterns → not filtered', () => {
    assert.equal(shouldFilterUrl('https://example.com', []),   false);
    assert.equal(shouldFilterUrl('https://example.com', null), false);
});

test('shouldFilterUrl: wildcard domain match', () => {
    const patterns = ['*google.com*'];
    assert.equal(shouldFilterUrl('https://www.google.com/search?q=1', patterns), true);
    assert.equal(shouldFilterUrl('https://google.com', patterns), true);
    assert.equal(shouldFilterUrl('https://example.com', patterns), false);
});

test('shouldFilterUrl: multiple patterns (OR logic)', () => {
    const patterns = ['*analytics*', '*tracking*', '*cloudflare*'];
    assert.equal(shouldFilterUrl('https://cdn.cloudflare.net/script.js', patterns), true);
    assert.equal(shouldFilterUrl('https://example.com/analytics/track', patterns), true);
    assert.equal(shouldFilterUrl('https://example.com/page', patterns), false);
});

test('shouldFilterUrl: case-insensitive matching', () => {
    const patterns = ['*GOOGLE.COM*'];
    assert.equal(shouldFilterUrl('https://www.google.com/', patterns), true);
});

test('shouldFilterUrl: dot in pattern escaped (not regex wildcard)', () => {
    const patterns = ['*google.com*'];
    // "googleXcom" should NOT match — the dot is literal
    assert.equal(shouldFilterUrl('https://googleXcom.net', patterns), false);
});

test('shouldFilterUrl: reuses cached compiled patterns', () => {
    const patterns = ['*example.com*'];
    // Call twice with same array reference — should not throw or recompile
    shouldFilterUrl('https://example.com', patterns);
    assert.equal(shouldFilterUrl('https://example.com/path', patterns), true);
    assert.equal(shouldFilterUrl('https://other.io', patterns), false);
});

test('sanitizeOutgoingRequestHeaders: strips HTTP/2 pseudo-headers', () => {
    const h = {
        ':authority': 'example.com',
        ':method': 'GET',
        ':path': '/x',
        ':scheme': 'https',
        'User-Agent': 'cupnet',
        Accept: 'application/json',
    };
    const o = sanitizeOutgoingRequestHeaders(h);
    assert.deepEqual(o, { 'User-Agent': 'cupnet', Accept: 'application/json' });
});

test('sanitizeOutgoingRequestHeaders: null / non-object → {}', () => {
    assert.deepEqual(sanitizeOutgoingRequestHeaders(null), {});
    assert.deepEqual(sanitizeOutgoingRequestHeaders(undefined), {});
});

console.log('\n✓ All utils tests passed\n');
