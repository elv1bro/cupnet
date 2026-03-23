'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProxyResilienceManager } = require('../proxy-resilience');

test('ProxyResilienceManager: opens circuit on consecutive failures', () => {
    const m = new ProxyResilienceManager({
        enabled: true,
        minSamples: 2,
        consecutiveFailuresToOpen: 2,
        errorRateToOpenPct: 50,
        cooldownMs: 200,
        quarantineMs: 1000,
    });
    m.registerFailure('http://a:1', new Error('f1'));
    const r2 = m.registerFailure('http://a:1', new Error('f2'));
    assert.equal(r2.circuit, 'open');
    assert.equal(m.canAttempt('http://a:1'), false);
});

test('ProxyResilienceManager: closes half-open after success', async () => {
    const m = new ProxyResilienceManager({
        enabled: true,
        minSamples: 2,
        consecutiveFailuresToOpen: 1,
        errorRateToOpenPct: 50,
        cooldownMs: 10,
        quarantineMs: 5,
    });
    m.registerFailure('http://b:2', new Error('boom'));
    await new Promise(r => setTimeout(r, 15));
    assert.equal(m.canAttempt('http://b:2'), true);
    const s = m.registerSuccess('http://b:2', 120);
    assert.equal(s.circuit, 'closed');
});

test('ProxyResilienceManager: orderCandidates prefers healthy proxies', () => {
    const m = new ProxyResilienceManager({});
    m.registerFailure('http://bad:1', new Error('x'));
    m.registerFailure('http://bad:1', new Error('y'));
    m.registerSuccess('http://good:1', 80);
    m.registerSuccess('http://good:1', 70);
    const ordered = m.orderCandidates(['http://bad:1', 'http://good:1']);
    assert.equal(ordered[0], 'http://good:1');
});

console.log('\n✓ All proxy resilience tests passed\n');
