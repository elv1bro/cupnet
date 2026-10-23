import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mirror = require('../../mirror-rewrite.js');

const {
    normalizeMirror,
    normalizeReplaceRules,
    validateMirrorParams,
    rewriteRequest,
    rewriteResponse,
    rewriteHeaders,
    shouldRewriteType,
    hostOnly,
    authority,
    replaceWords,
    replaceWordsInText,
    replaceSubstring,
    replaceRegex,
    swapHostText,
    swapPathText,
    undoUrlPath,
    rewriteCookieDomain,
} = mirror;

describe('host / url helpers', () => {
    it('hostOnly strips scheme, port, path and trailing dot', () => {
        expect(hostOnly('https://Shop.Example.com:8443/a?b')).toBe('shop.example.com');
        expect(hostOnly('example.com.')).toBe('example.com');
        expect(hostOnly('[::1]:443')).toBe('::1');
    });
    it('authority hides the default https port', () => {
        expect(authority('a.com', 443)).toBe('a.com');
        expect(authority('a.com', 8443)).toBe('a.com:8443');
        expect(authority('a.com', 0)).toBe('a.com');
    });
});

describe('word replacement', () => {
    it('is boundary-aware and case-insensitive, preserving replacement case', () => {
        expect(replaceWordsInText('Cat cats concatenate', 'cat', 'dog')).toEqual({ text: 'dog cats concatenate', hits: 1 });
    });
    it('replaceWords only touches text nodes, not tags, by default', () => {
        const html = '<a href="/cat">cat</a>';
        const out = replaceWords(Buffer.from(html), 'cat', 'dog');
        expect(out.body.toString()).toBe('<a href="/cat">dog</a>');
        expect(out.hits).toBe(1);
    });
    it('replaceWords with urls:true also rewrites url attributes', () => {
        const html = '<a href="/cat">cat</a>';
        const out = replaceWords(Buffer.from(html), '/cat', '/dog', { urls: true });
        expect(out.body.toString()).toBe('<a href="/dog">cat</a>');
    });
    it('replaceWords with tags:true rewrites the whole document', () => {
        const html = '<a data-x="cat">cat</a>';
        const out = replaceWords(Buffer.from(html), 'cat', 'dog', { tags: true });
        expect(out.body.toString()).toBe('<a data-x="dog">dog</a>');
    });
});

describe('substring replacement (default word mode)', () => {
    it('replaces a single letter inside words, case-insensitively', () => {
        expect(replaceSubstring('Banana', 'a', 'o')).toEqual({ text: 'Bonono', hits: 3 });
    });
    it('honours case-sensitivity when asked', () => {
        expect(replaceSubstring('Aa', 'a', 'o', true)).toEqual({ text: 'Ao', hits: 1 });
    });
    it('is the default engine mode: a partial match rewrites every occurrence', () => {
        const out = replaceWords(Buffer.from('concatenate the cat'), 'cat', 'dog');
        expect(out.body.toString()).toBe('condogenate the dog');
        expect(out.hits).toBe(2);
    });
    it('whole:true restores boundary-aware matching', () => {
        const out = replaceWords(Buffer.from('concatenate the cat'), 'cat', 'dog', { whole: true });
        expect(out.body.toString()).toBe('concatenate the dog');
        expect(out.hits).toBe(1);
    });
    it('cs:true matches case-sensitively through the rule pipeline', () => {
        const out = replaceWords(Buffer.from('Cat cat'), 'cat', 'dog', { cs: true });
        expect(out.body.toString()).toBe('Cat dog');
    });
});

describe('regex replacement', () => {
    it('expands $1 groups and refuses empty-matching patterns', () => {
        expect(replaceRegex('id=42', 'id=(\\d+)', 'ref=$1')).toEqual({ text: 'ref=42', hits: 1 });
        expect(replaceRegex('abc', 'x*', 'Z').hits).toBe(0);
    });
});

describe('host swap', () => {
    it('swapHostText rewrites http/https/protocol-relative and forces https', () => {
        expect(swapHostText('http://a.com/x', 'a.com', 443, 'b.com', 443)).toBe('https://b.com/x');
        expect(swapHostText('//a.com/x', 'a.com', 443, 'b.com', 443)).toBe('//b.com/x');
    });
    it('rewriteCookieDomain swaps the Domain attribute only', () => {
        expect(rewriteCookieDomain('id=1; Domain=a.com; Path=/', 'a.com', 'b.com'))
            .toBe('id=1; Domain=b.com; Path=/');
    });
});

describe('shouldRewriteType', () => {
    it('matches text/json/js/xml families only', () => {
        expect(shouldRewriteType('text/html; charset=utf-8')).toBe(true);
        expect(shouldRewriteType('application/json')).toBe(true);
        expect(shouldRewriteType('application/manifest+json')).toBe(true);
        expect(shouldRewriteType('image/png')).toBe(false);
        expect(shouldRewriteType('')).toBe(false);
    });
});

describe('normalize / validate', () => {
    it('drops bad rules and keeps good ones', () => {
        const rules = normalizeReplaceRules([
            { from: 'a', to: 'b' },
            { from: '', to: 'x' },          // no from
            { from: 'c', to: 'c' },          // from === to
            { from: 'x*', to: 'y', regex: true }, // empty-matching regex
            { from: '/p', to: '/q', kind: 'url' },
        ]);
        expect(rules.map((r) => r.from)).toEqual(['a', '/p']);
    });
    it('validateMirrorParams rejects missing/bad upstream host', () => {
        expect(validateMirrorParams({}).ok).toBe(false);
        expect(validateMirrorParams({ upstreamHost: 'a..b' }).ok).toBe(false);
        expect(validateMirrorParams({ upstreamHost: 'origin.example.com' }).ok).toBe(true);
    });
    it('validateMirrorParams surfaces a bad regex', () => {
        const res = validateMirrorParams({ upstreamHost: 'a.com', replace: [{ from: '(', to: 'x', regex: true }] });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/regex/i);
    });
});

describe('rewriteRequest', () => {
    const m = normalizeMirror({ upstreamHost: 'origin.example.com' });
    it('swaps the client host to the upstream host, keeping path + query', () => {
        const out = rewriteRequest({ url: 'https://shop.test/products?id=1', clientHost: 'shop.test', clientPort: 443 }, m);
        expect(out).toEqual({
            url: 'https://origin.example.com/products?id=1',
            host: 'origin.example.com',
            port: 443,
            path: '/products?id=1',
        });
    });
    it('reverses url-rewrite rules on the request path', () => {
        const withUrl = normalizeMirror({
            upstreamHost: 'origin.example.com',
            replace: [{ from: '/real', to: '/fake', urls: true }],
        });
        const out = rewriteRequest({ url: 'https://shop.test/fake/page', clientHost: 'shop.test' }, withUrl);
        expect(out.path).toBe('/real/page');
    });
    it('applies a kind:url path-swap on the way out', () => {
        const withPath = normalizeMirror({
            upstreamHost: 'origin.example.com',
            replace: [{ from: '/login', to: '/auth/v2/login', kind: 'url' }],
        });
        const out = rewriteRequest({ url: 'https://shop.test/login?next=/x', clientHost: 'shop.test' }, withPath);
        expect(out.path).toBe('/auth/v2/login?next=/x');
    });
    it('returns null when there is no upstream host', () => {
        expect(rewriteRequest({ url: 'https://shop.test/' }, normalizeMirror({}))).toBeNull();
    });
});

describe('rewriteResponse', () => {
    const m = normalizeMirror({ upstreamHost: 'origin.example.com' });
    const ctx = { clientHost: 'shop.test', clientPort: 443, clientUrl: '/products' };

    it('rewrites absolute upstream URLs in the body back to the client host', () => {
        const res = {
            statusCode: 200,
            headers: { 'content-type': 'text/html' },
            body: '<a href="https://origin.example.com/x">go</a>',
        };
        const out = rewriteResponse(res, m, ctx);
        expect(out.body.toString()).toBe('<a href="https://shop.test/x">go</a>');
        expect(out.rewrote).toBe(true);
    });
    it('does not touch binary bodies', () => {
        const res = { statusCode: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([1, 2, 3]) };
        const out = rewriteResponse(res, m, ctx);
        expect(out.rewrote).toBe(false);
        expect(out.body).toEqual(Buffer.from([1, 2, 3]));
    });
    it('rewrites Location and Set-Cookie Domain, and drops etag', () => {
        const res = {
            statusCode: 302,
            headers: {
                location: 'https://origin.example.com/next',
                'set-cookie': ['sid=1; Domain=origin.example.com; Path=/'],
                etag: '"abc"',
                'content-type': 'text/html',
            },
            body: '',
        };
        const out = rewriteResponse(res, m, ctx);
        expect(out.headers.location).toBe('https://shop.test/next');
        expect(out.headers['set-cookie'][0]).toBe('sid=1; Domain=shop.test; Path=/');
        expect(out.headers.etag).toBeUndefined();
    });
    it('applies word replace rules to the body', () => {
        const withWord = normalizeMirror({ upstreamHost: 'origin.example.com', replace: [{ from: 'Origin', to: 'Shop' }] });
        const res = { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<p>Welcome to Origin</p>' };
        const out = rewriteResponse(res, withWord, ctx);
        expect(out.body.toString()).toBe('<p>Welcome to Shop</p>');
    });
});

describe('round trip: request undo + response path-swap', () => {
    it('a url rule maps the client path out and back', () => {
        const m = normalizeMirror({
            upstreamHost: 'origin.example.com',
            replace: [{ from: '/catalog', to: '/shop', urls: true }],
        });
        const req = rewriteRequest({ url: 'https://shop.test/shop/42', clientHost: 'shop.test' }, m);
        expect(req.path).toBe('/catalog/42');
        const res = rewriteResponse(
            { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<a href="/catalog/42">x</a>' },
            m,
            { clientHost: 'shop.test', clientUrl: '/shop/42' },
        );
        expect(res.body.toString()).toBe('<a href="/shop/42">x</a>');
    });
});

describe('undoUrlPath directly', () => {
    it('reverses a simple url rule and leaves the query alone', () => {
        const rules = normalizeReplaceRules([{ from: '/a', to: '/b', urls: true }]);
        expect(undoUrlPath('/b/c?x=/b', rules)).toBe('/a/c?x=/b');
    });
    it('swapPathText only swaps a path at a boundary', () => {
        expect(swapPathText('go /auth/login now', '/auth/login', '/login')).toBe('go /login now');
        expect(swapPathText('/auth/loginx', '/auth/login', '/login')).toBe('/auth/loginx');
    });
});
