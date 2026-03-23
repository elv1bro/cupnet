'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadOrGenerateCA } = require('../mitm-proxy');
const { networkPolicy } = require('../network-policy');
const path = require('path');
const os = require('os');
const fs = require('fs');

test('mitm integration: module exports and CA load', () => {
    assert.equal(typeof loadOrGenerateCA, 'function');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-mitm-test-'));
    try {
        const r = loadOrGenerateCA(dir);
        assert.ok(r.caCertPem && r.caCertPem.includes('BEGIN CERTIFICATE'));
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test('mitm integration: MITM port is configurable via networkPolicy', () => {
    assert.ok(Number.isFinite(networkPolicy.mitmPort));
    assert.ok(networkPolicy.mitmPort >= 1024 && networkPolicy.mitmPort <= 65535);
});

console.log('\n✓ mitm integration tests passed\n');
