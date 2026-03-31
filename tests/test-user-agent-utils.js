'use strict';
/**
 * Тесты sanitizeUserAgentChromeOnly — UA без CupNet/Electron, только Chrome-стиль.
 * Run: node tests/test-user-agent-utils.js
 */

delete process.env.CUPNET_DISABLE_UA_SANITIZE;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeUserAgentChromeOnly, applyOutboundUserAgentToMitmHeaders } = require('../user-agent-utils');

/** Типичный UA Electron с брендом приложения (как до санитайза). */
const SAMPLE_ELECTRON_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'CupNet/2026.3.30-1 Chrome/120.0.6099.291 Electron/28.3.3 Safari/537.36';

/** Ожидаемая форма: только Gecko + Chrome + Safari, без Electron/CupNet. */
const CHROME_LIKE_UA =
    /^Mozilla\/5\.0 .+AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/[\d.]+$/;

function assertNoLeak(ua) {
    assert.match(ua, /Chrome\/[\d.]+/, 'должен остаться токен Chrome/…');
    assert.match(ua, /Safari\/[\d.]+/, 'должен остаться токен Safari/…');
    assert.doesNotMatch(ua, /CupNet/i, 'не должно быть CupNet');
    assert.doesNotMatch(ua, /\bElectron\//i, 'не должно быть Electron/');
}

test('sanitizeUserAgentChromeOnly: убирает CupNet и Electron, остаётся Chrome-стиль', () => {
    const out = sanitizeUserAgentChromeOnly(SAMPLE_ELECTRON_UA);
    assert.match(out, CHROME_LIKE_UA);
    assertNoLeak(out);
    assert.equal(
        out,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.291 Safari/537.36',
    );
});

test('sanitizeUserAgentChromeOnly: регистр CupNet (cupnet)', () => {
    const raw = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) cupnet/1.0'
        + ' Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36';
    const out = sanitizeUserAgentChromeOnly(raw);
    assertNoLeak(out);
    assert.match(out, CHROME_LIKE_UA);
});

test('sanitizeUserAgentChromeOnly: чистый Chrome UA не портит', () => {
    const clean = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    assert.equal(sanitizeUserAgentChromeOnly(clean), clean);
});

test('sanitizeUserAgentChromeOnly: пустая строка', () => {
    assert.equal(sanitizeUserAgentChromeOnly(''), '');
    assert.equal(sanitizeUserAgentChromeOnly(null), '');
});

test('sanitizeUserAgentChromeOnly: только Electron без CupNet (на всякий случай)', () => {
    const raw = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Electron/28.3.3 Safari/537.36';
    const out = sanitizeUserAgentChromeOnly(raw);
    assert.doesNotMatch(out, /\bElectron\//i);
    assert.match(out, /Chrome\/120\.0\.0\.0/);
});

test('applyOutboundUserAgentToMitmHeaders: правит headers и orderedHeaders', () => {
    const bad =
        'Mozilla/5.0 (KHTML, like Gecko) CupNet/1.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36';
    const headers = { Host: 'example.com', 'user-agent': bad };
    const orderedHeaders = [['Host', 'example.com'], ['User-Agent', bad]];
    applyOutboundUserAgentToMitmHeaders(headers, orderedHeaders);
    assert.doesNotMatch(headers['user-agent'], /cupnet/i);
    assert.doesNotMatch(orderedHeaders[1][1], /cupnet/i);
});
