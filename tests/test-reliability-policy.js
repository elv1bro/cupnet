'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    networkPolicy,
    retryableStatus,
    computeBackoffMs,
} = require('../network-policy');

test('retryableStatus: marks transient statuses as retryable', () => {
    assert.equal(retryableStatus(408), true);
    assert.equal(retryableStatus(429), true);
    assert.equal(retryableStatus(502), true);
    assert.equal(retryableStatus(503), true);
    assert.equal(retryableStatus(504), true);
});

test('retryableStatus: skips non-retryable statuses', () => {
    assert.equal(retryableStatus(400), false);
    assert.equal(retryableStatus(401), false);
    assert.equal(retryableStatus(403), false);
    assert.equal(retryableStatus(404), false);
    assert.equal(retryableStatus(500), false);
});

test('computeBackoffMs: respects jitter range, base minimum, and cap', () => {
    for (let i = 0; i < 50; i++) {
        const val = computeBackoffMs(i);
        assert.ok(val >= networkPolicy.retry.baseDelayMs, 'backoff must be at least baseDelayMs');
        assert.ok(val <= networkPolicy.retry.maxDelayMs, 'backoff must stay below cap');
    }
});

test('networkPolicy: has sane timeout and concurrency guards', () => {
    assert.ok(networkPolicy.timeouts.workerRequestMs >= 1000);
    assert.ok(networkPolicy.timeouts.upstreamRequestMs >= 1000);
    assert.ok(networkPolicy.timeouts.tlsHandshakeMs >= 1000);
    assert.ok(networkPolicy.concurrency.workerMaxPending >= 1);
    assert.ok(networkPolicy.concurrency.workerMaxInflight >= 1);
    assert.ok(networkPolicy.concurrency.workerStdinQueueMax >= 1);
});

console.log('\n✓ All reliability policy tests passed\n');
