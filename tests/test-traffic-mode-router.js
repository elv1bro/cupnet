'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeTrafficMode,
    toProxyRules,
    resolveSessionProxyConfig,
    TRAFFIC_MODE_MITM,
} = require('../traffic-mode-router');

test('normalizeTrafficMode: always mitm', () => {
    assert.equal(normalizeTrafficMode('mitm'), TRAFFIC_MODE_MITM);
    assert.equal(normalizeTrafficMode('browser_proxy'), TRAFFIC_MODE_MITM);
    assert.equal(normalizeTrafficMode('unknown'), TRAFFIC_MODE_MITM);
    assert.equal(normalizeTrafficMode(null), TRAFFIC_MODE_MITM);
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

test('resolveSessionProxyConfig: mitm rules to local proxy', () => {
    const cfg = resolveSessionProxyConfig({ bypassRules: 'a,b' });
    assert.ok(cfg.proxyRules && cfg.proxyRules.includes('127.0.0.1'));
    assert.equal(cfg.proxyBypassRules, 'a,b');
});
