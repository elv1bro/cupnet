'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const interceptor = require('../request-interceptor');

test('request-interceptor: exports API', () => {
    assert.equal(typeof interceptor.attachToSession, 'function');
    assert.equal(typeof interceptor.detachFromSession, 'function');
    assert.equal(typeof interceptor.syncMockProtocolHandlers, 'function');
    assert.equal(typeof interceptor.matchesPattern, 'function');
    assert.equal(typeof interceptor.ruleMatchesUrl, 'function');
    assert.equal(typeof interceptor.invalidateRulesCache, 'function');
    assert.equal(typeof interceptor.setOnRuleMatch, 'function');
    assert.equal(typeof interceptor.setResolveTabIdFromDetails, 'function');
    assert.equal(typeof interceptor.resyncWebRequestHooks, 'function');
    assert.equal(typeof interceptor.isStrictInterceptMode, 'function');
    assert.equal(typeof interceptor.validateStrictInterceptUrlPattern, 'function');
    assert.equal(typeof interceptor.validateInterceptRuleForSave, 'function');
    assert.equal(typeof interceptor.urlMatchesStrictPattern, 'function');
    assert.equal(typeof interceptor.bypassInterceptMockBlockForSensitiveUrl, 'function');
});

test('request-interceptor: setOnRuleMatch accepts callback', () => {
    let called = false;
    interceptor.setOnRuleMatch(() => { called = true; });
    interceptor.setOnRuleMatch(null);
    assert.equal(called, false);
});

test('request-interceptor: matchesPattern', () => {
    assert.equal(interceptor.matchesPattern('*example.com*', 'https://example.com/foo'), true);
    assert.equal(interceptor.matchesPattern('https://api.test.com/data*', 'https://api.test.com/data/123'), true);
    assert.equal(interceptor.matchesPattern('https://api.test.com/data*', 'https://other.com/data'), false);
    assert.equal(interceptor.matchesPattern('<all_urls>', 'https://any.com'), true);
    assert.equal(interceptor.matchesPattern('*', 'https://any.com'), true);
    assert.equal(interceptor.matchesPattern(null, 'https://any.com'), false);
});

test('request-interceptor: strict URL — валидация', () => {
    assert.equal(interceptor.validateStrictInterceptUrlPattern('https://api.example.com/v1/').ok, true);
    assert.equal(interceptor.validateStrictInterceptUrlPattern('https://example.com').ok, true);
    assert.equal(interceptor.validateStrictInterceptUrlPattern('http://localhost:3000/api').ok, true);
    assert.equal(interceptor.validateStrictInterceptUrlPattern('*foo*').ok, false);
    assert.equal(interceptor.validateStrictInterceptUrlPattern('<all_urls>').ok, false);
    assert.equal(interceptor.validateStrictInterceptUrlPattern('example.com').ok, false);
    assert.equal(interceptor.validateStrictInterceptUrlPattern('').ok, false);
});

test('request-interceptor: bypassInterceptMockBlockForSensitiveUrl (CF / captcha)', () => {
    const b = interceptor.bypassInterceptMockBlockForSensitiveUrl;
    assert.equal(b('https://challenges.cloudflare.com/turnstile/v0/api.js'), true);
    assert.equal(b('https://shop.example/cdn-cgi/challenge-platform/h/b'), true);
    assert.equal(b('https://shop.example/cdn-cgi/scripts/foo.js'), true);
    assert.equal(b('https://shop.example/page?__cf_chl_tk=x'), true);
    assert.equal(b('https://api.example.com/v1/users'), false);
});

test('request-interceptor: urlMatchesStrictPattern', () => {
    assert.equal(interceptor.urlMatchesStrictPattern('https://ex.com/api/', 'https://ex.com/api/x'), true);
    assert.equal(interceptor.urlMatchesStrictPattern('https://ex.com/api/', 'https://ex.com/api/x/y'), true);
    assert.equal(interceptor.urlMatchesStrictPattern('https://ex.com/api', 'https://ex.com/api/x'), true);
    assert.equal(interceptor.urlMatchesStrictPattern('https://ex.com/api', 'https://ex.com/apix'), false);
    assert.equal(interceptor.urlMatchesStrictPattern('https://ex.com', 'https://ex.com/anything'), true);
    assert.equal(interceptor.urlMatchesStrictPattern('https://ex.com', 'https://other.com'), false);
});

console.log('\n✓ request-interceptor tests passed\n');
