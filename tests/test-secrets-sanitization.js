'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AZURE_TLS_FILE = path.join(ROOT, 'azuretls', 'azureTLS.js');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

test('azureTLS examples are sanitized from secret-like hardcoded values', () => {
    const src = fs.readFileSync(AZURE_TLS_FILE, 'utf8');
    assert.ok(!src.includes('Roxalana%4022'), 'Proxy credential sample must be removed');
    assert.ok(!src.includes('va22FBJqnag0w5vQf'), 'Proxy credential sample must be removed');
    assert.ok(!src.includes('eyJhbGciOiJSUzI1Ni'), 'Hardcoded JWT must be removed');
    assert.ok(src.includes('process.env.CUPNET_PROXY_URL'), 'Proxy should be loaded from env');
    assert.ok(src.includes('process.env.CUPNET_BEARER_TOKEN'), 'Bearer token should be loaded from env');
    assert.ok(src.includes('process.env.CUPNET_API_BASE_URL'), 'API base URL should be loaded from env');
});

test('.env.example contains expected security-related placeholders', () => {
    const src = fs.readFileSync(ENV_EXAMPLE, 'utf8');
    assert.ok(src.includes('CUPNET_PROXY_URL=<PROXY_URL>'));
    assert.ok(src.includes('CUPNET_BEARER_TOKEN=<BEARER_TOKEN>'));
    assert.ok(src.includes('CUPNET_API_BASE_URL=<API_BASE_URL>'));
});

console.log('\n✓ secrets sanitization tests passed\n');
