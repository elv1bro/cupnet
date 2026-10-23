import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const I = require('../../request-interceptor.js');

const mirrorRule = (params) => ({
    id: 'r1', name: 'mir', enabled: true, type: 'mirror',
    url_pattern: 'https://shop.test/*', method: '*', priority: 0,
    params: { upstreamHost: 'origin.example.com', ...params },
});

const resp = ({ body = '', headers = {}, statusCode = 200 } = {}) => ({
    statusCode,
    headers: { 'content-type': 'text/html', ...headers },
    bodyBase64: Buffer.from(body, 'utf8').toString('base64'),
});

async function run(params, requestOpts, response) {
    const captured = [];
    I.setMirrorAuditSink((e) => captured.push(e));
    try {
        const opts = {
            url: 'https://shop.test/',
            method: 'GET',
            headers: { Host: 'shop.test' },
            orderedHeaders: [[':authority', 'shop.test'], ['accept', '*/*']],
            ...requestOpts,
        };
        const plan = await I.planMitmIntercept(opts, { rulesOverride: [mirrorRule(params)] });
        const out = response ? await I.finalizeMitmInterceptResponseAsync(response, plan.postProcess) : null;
        return { plan, out, bodyText: out ? Buffer.from(out.bodyBase64, 'base64').toString('utf8') : '', audit: captured[0] };
    } finally {
        I.setMirrorAuditSink(null);
    }
}

describe('mirror intercept rule', () => {
    it('rewrites the outbound request to the upstream host', async () => {
        const { plan } = await run({}, { url: 'https://shop.test/products?id=1' });
        expect(plan.done).toBe(false);
        expect(plan.opts.url).toBe('https://origin.example.com/products?id=1');
        expect(plan.opts.headers.Host).toBe('origin.example.com');
        expect(plan.opts.orderedHeaders).toContainEqual([':authority', 'origin.example.com']);
        expect(plan.postProcess._mitmPost).toBe('mirror');
    });

    it('rewrites the response body + Location + Set-Cookie back to the client host', async () => {
        const { out, bodyText } = await run(
            {},
            { url: 'https://shop.test/x' },
            resp({
                body: '<a href="https://origin.example.com/y">go</a>',
                headers: {
                    location: 'https://origin.example.com/next',
                    'set-cookie': ['s=1; Domain=origin.example.com; Path=/'],
                    etag: '"abc"',
                },
            }),
        );
        expect(bodyText).toBe('<a href="https://shop.test/y">go</a>');
        expect(out.headers.location).toBe('https://shop.test/next');
        expect(out.headers['set-cookie'][0]).toBe('s=1; Domain=shop.test; Path=/');
        expect(out.headers.etag).toBeUndefined();
    });

    it('applies word replace rules and emits an audit record', async () => {
        const { bodyText, audit } = await run(
            { replace: [{ from: 'Origin', to: 'Shop' }] },
            { url: 'https://shop.test/x' },
            resp({ body: '<p>Welcome to Origin</p>' }),
        );
        expect(bodyText).toBe('<p>Welcome to Shop</p>');
        expect(audit).toMatchObject({ clientHost: 'shop.test', upstreamHost: 'origin.example.com', rewrote: true });
        expect(audit.hits).toBeGreaterThanOrEqual(1);
        expect(Buffer.isBuffer(audit.before)).toBe(true);
        expect(Buffer.isBuffer(audit.after)).toBe(true);
    });

    it('reverses a url-rewrite rule on the request path', async () => {
        const { plan } = await run(
            { replace: [{ from: '/catalog', to: '/shop', urls: true }] },
            { url: 'https://shop.test/shop/42' },
        );
        expect(plan.opts.url).toBe('https://origin.example.com/catalog/42');
    });

    it('validates on save', () => {
        expect(I.validateInterceptRuleForSave(mirrorRule({})).ok).toBe(true);
        expect(I.validateInterceptRuleForSave(mirrorRule({ upstreamHost: '' })).ok).toBe(false);
        expect(I.validateInterceptRuleForSave({
            ...mirrorRule({}), params: { upstreamHost: 'origin.example.com', replace: [{ from: '(', to: 'x', regex: true }] },
        }).ok).toBe(false);
    });

    it('matches a bare-host url_pattern (no scheme) typed by the user', async () => {
        // Regression: "example.com" used to compile to /^example\.com$/ and match no full URL, so the
        // mirror silently never fired (hit_count stayed 0).
        const rule = { ...mirrorRule({ upstreamHost: 'example.com' }), url_pattern: 'example.com' };
        const plan = await I.planMitmIntercept(
            { url: 'https://example.com/', method: 'GET', headers: { Host: 'example.com' }, orderedHeaders: [[':authority', 'example.com']] },
            { rulesOverride: [rule] },
        );
        expect(plan.postProcess?._mitmPost).toBe('mirror');
    });
});

describe('ruleMatchesUrl — bare host patterns', () => {
    it('matches the host with any scheme/port and path', () => {
        expect(I.ruleMatchesUrl('example.com', 'https://example.com/')).toBe(true);
        expect(I.ruleMatchesUrl('example.com', 'http://example.com/page?x=1')).toBe(true);
        expect(I.ruleMatchesUrl('example.com/app', 'https://example.com/app/x')).toBe(true);
        expect(I.ruleMatchesUrl('localhost', 'http://localhost:3000/')).toBe(true);
    });
    it('does not match a different or sibling host', () => {
        expect(I.ruleMatchesUrl('example.com', 'https://www.example.com/')).toBe(false);
        expect(I.ruleMatchesUrl('example.com', 'https://example.com.evil.com/')).toBe(false);
        expect(I.ruleMatchesUrl('example.com', 'https://notexample.com/')).toBe(false);
        expect(I.ruleMatchesUrl('example.com/app', 'https://example.com/apple')).toBe(false);
    });
});
