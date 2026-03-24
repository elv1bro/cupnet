'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeTrafficMode,
    toProxyRules,
    resolveSessionProxyConfig,
} = require('../traffic-mode-router');
const { networkPolicy } = require('../network-policy');

test('normalizeTrafficMode: defaults to browser_proxy', () => {
    assert.equal(normalizeTrafficMode('mitm'), 'mitm');
    assert.equal(normalizeTrafficMode('browser_proxy'), 'browser_proxy');
    assert.equal(normalizeTrafficMode('unknown'), 'browser_proxy');
    assert.equal(normalizeTrafficMode(null), 'browser_proxy');
});

test('toProxyRules: converts URL to host:port', () => {
    assert.equal(toProxyRules('http://127.0.0.1:8899'), '127.0.0.1:8899');
    assert.equal(toProxyRules('invalid-url'), null);
    assert.equal(toProxyRules(''), null);
});

test('toProxyRules: preserves SOCKS scheme for Chromium proxyRules', () => {
    assert.equal(toProxyRules('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
    assert.equal(toProxyRules('socks4://10.0.0.1'), 'socks5://10.0.0.1:1080');
});

test('resolveSessionProxyConfig: mitm mode uses local mitm endpoint', () => {
    const opts = resolveSessionProxyConfig({
        mode: 'mitm',
        upstreamProxyUrl: 'http://127.0.0.1:9999',
        bypassRules: '<local>',
    });
    const p = networkPolicy.mitmPort;
    const hp = `127.0.0.1:${p}`;
    assert.equal(opts.proxyRules, `http=${hp};https=${hp}`);
    assert.equal(opts.proxyBypassRules, '<local>');
});

test('resolveSessionProxyConfig: browser mode uses upstream or direct fallback', () => {
    const upstream = resolveSessionProxyConfig({
        mode: 'browser_proxy',
        upstreamProxyUrl: 'http://127.0.0.1:9012',
        bypassRules: '*.example.com',
    });
    assert.equal(upstream.proxyRules, '127.0.0.1:9012');
    assert.equal(upstream.proxyBypassRules, '*.example.com');

    const direct = resolveSessionProxyConfig({
        mode: 'browser_proxy',
        upstreamProxyUrl: null,
        bypassRules: '*.example.com',
    });
    assert.equal(direct.mode, 'direct');
});

console.log('\n✓ traffic mode router tests passed\n');
