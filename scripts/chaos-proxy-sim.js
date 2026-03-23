#!/usr/bin/env node
'use strict';

const { ProxyResilienceManager } = require('../proxy-resilience');

const manager = new ProxyResilienceManager({
    enabled: true,
    minSamples: 6,
    consecutiveFailuresToOpen: 3,
    errorRateToOpenPct: 60,
    cooldownMs: 5000,
    quarantineMs: 12000,
});

const candidates = [
    'http://proxy-a:8080',
    'http://proxy-b:8080',
    'http://proxy-c:8080',
];

for (let i = 0; i < 60; i++) {
    const c = candidates[i % candidates.length];
    const fail = Math.random() < (c.includes('b') ? 0.5 : 0.2);
    if (fail) manager.registerFailure(c, new Error('simulated network drop'));
    else manager.registerSuccess(c, 40 + Math.floor(Math.random() * 400));
}

process.stdout.write(JSON.stringify({
    orderedCandidates: manager.orderCandidates(candidates),
    state: manager.snapshot(),
}, null, 2) + '\n');
