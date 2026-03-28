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
    assert.equal(typeof interceptor.planMitmIntercept, 'function');
    assert.equal(typeof interceptor.finalizeMitmInterceptResponse, 'function');
    assert.equal(typeof interceptor.finalizeMitmInterceptResponseAsync, 'function');
    assert.equal(typeof interceptor.runInterceptScriptSelfTest, 'function');
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

test('request-interceptor: strict URL validation', () => {
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

test('request-interceptor: ruleMatchesUrl plain URL ignores query (default glob mode)', () => {
    const pat = 'https://atlantis-absapi-ru.vfsglobal.com/v1/applications/capping/serviceLevel';
    const withQ = `${pat}?culture=en-AU&_=1730000000000`;
    assert.equal(interceptor.ruleMatchesUrl(pat, pat), true);
    assert.equal(interceptor.ruleMatchesUrl(pat, withQ), true);
    assert.equal(interceptor.ruleMatchesUrl(pat, `${pat}#frag`), true);
    // Still glob when * present
    assert.equal(interceptor.ruleMatchesUrl(`${pat}*`, withQ), true);
});

test('planMitmIntercept: mock uses interceptMatchUrl when wire URL is IP (DNS override)', () => {
    const logical = 'https://atlantis.example.com/v1/applications/capping/serviceLevel';
    const rules = [{
        enabled: true,
        name: 'dns-mock',
        url_pattern: logical,
        type: 'mock',
        params: { status: 200, mimeType: 'application/json', body: '{"mocked":true}' },
    }];
    const withLogical = {
        url: 'https://203.0.113.50/v1/applications/capping/serviceLevel',
        interceptMatchUrl: logical,
        method: 'GET',
        headers: {},
        orderedHeaders: [],
        dnsOverride: { host: 'atlantis.example.com', ip: '203.0.113.50' },
    };
    const plan = interceptor.planMitmIntercept(withLogical, { rulesOverride: rules });
    assert.equal(plan.done, true);
    assert.equal(plan.response.statusCode, 200);
    assert.equal(Buffer.from(plan.response.bodyBase64, 'base64').toString(), '{"mocked":true}');

    const ipOnly = {
        url: 'https://203.0.113.50/v1/applications/capping/serviceLevel',
        method: 'GET',
        headers: {},
        orderedHeaders: [],
    };
    const noMatch = interceptor.planMitmIntercept(ipOnly, { rulesOverride: rules });
    assert.equal(noMatch.done, false);
});

test('planMitmIntercept: script before adds header', () => {
    const opts = {
        url: 'https://api.example.com/path',
        method: 'GET',
        headers: { 'User-Agent': 't' },
        orderedHeaders: [['User-Agent', 't']],
    };
    const rules = [{
        enabled: true,
        name: 'r1',
        url_pattern: '*api.example.com*',
        type: 'script',
        params: {
            beforeSource: 'ctx.headers[\'X-Script-Test\'] = \'1\';',
            afterSource: '',
        },
    }];
    const plan = interceptor.planMitmIntercept(opts, { rulesOverride: rules });
    assert.equal(plan.done, false);
    assert.equal(plan.postProcess, null);
    assert.equal(plan.opts.headers['X-Script-Test'], '1');
});

test('planMitmIntercept: script shortCircuit', () => {
    const opts = {
        url: 'https://api.example.com/z',
        method: 'GET',
        headers: {},
        orderedHeaders: [],
    };
    const rules = [{
        enabled: true,
        name: 'r2',
        url_pattern: '*example.com*',
        type: 'script',
        params: {
            beforeSource: 'ctx.shortCircuit = { statusCode: 222, headers: { \'Content-Type\': \'text/plain\' }, body: \'hi\' };',
            afterSource: '',
        },
    }];
    const plan = interceptor.planMitmIntercept(opts, { rulesOverride: rules });
    assert.equal(plan.done, true);
    assert.equal(plan.response.statusCode, 222);
    assert.equal(Buffer.from(plan.response.bodyBase64, 'base64').toString(), 'hi');
});

test('finalizeMitmInterceptResponseAsync: script after', async () => {
    const post = {
        _mitmPost: 'scriptAfter',
        afterSource: 'ctx.response.statusCode = 418; ctx.response.headers[\'X-Teapot\'] = \'1\';',
        ruleName: 't',
        requestSnapshot: { url: 'https://ex.com', method: 'GET', headers: {}, orderedHeaders: [] },
    };
    const res = {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        bodyBase64: Buffer.from('x', 'utf8').toString('base64'),
    };
    const out = await interceptor.finalizeMitmInterceptResponseAsync(res, post);
    assert.equal(out.statusCode, 418);
    assert.equal(out.headers['X-Teapot'], '1');
});

test('validateInterceptRuleForSave: script needs one of before/after', () => {
    const r = { type: 'script', url_pattern: 'https://a.com/p/', params: { beforeSource: '', afterSource: '' } };
    const v = interceptor.validateInterceptRuleForSave(r);
    assert.equal(v.ok, false);
});

test('runInterceptScriptSelfTest', () => {
    const o = interceptor.runInterceptScriptSelfTest({
        beforeSource: 'ctx.headers[\'Q\'] = \'9\';',
        afterSource: 'ctx.response.statusCode = 300;',
    });
    assert.equal(o.ok, true);
    assert.match(o.summary, /300/);
});

console.log('\n✓ request-interceptor tests passed\n');
