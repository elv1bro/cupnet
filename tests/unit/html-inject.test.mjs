'use strict';

/**
 * html-inject.js (intercept rule type `inject`) and its wiring in request-interceptor:
 * insertion points, charset-safe byte handling, CSP nonce patching, compressed bodies, and that
 * only document requests get a postProcess (sub-resources keep streaming).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import zlib from 'zlib';

const require = createRequire(import.meta.url);
const {
    isDocumentRequest, escapeScriptSource, patchCspPolicy, injectScriptsIntoHtmlResponse,
} = require('../../html-inject.js');
const interceptor = require('../../request-interceptor.js');

const N = 'NONCE';
const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64');
const unb64 = (s, enc = 'utf8') => Buffer.from(s, 'base64').toString(enc);
const htmlRes = (html, headers = {}) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
    bodyBase64: b64(html),
});
const nonceOf = (html) => /<script nonce="([^"]+)" data-cupnet/.exec(html)?.[1];

describe('isDocumentRequest', () => {
    it('uses Sec-Fetch-Dest when present', () => {
        expect(isDocumentRequest('GET', { 'sec-fetch-dest': 'document' })).toBe(true);
        expect(isDocumentRequest('GET', { 'Sec-Fetch-Dest': 'iframe' })).toBe(true);
        expect(isDocumentRequest('GET', { 'sec-fetch-dest': 'script', accept: 'text/html' })).toBe(false);
        expect(isDocumentRequest('GET', { 'sec-fetch-dest': 'empty' })).toBe(false);
    });
    it('falls back to Accept and ignores non-GET', () => {
        expect(isDocumentRequest('GET', { accept: 'text/html,application/xhtml+xml' })).toBe(true);
        expect(isDocumentRequest('GET', { accept: '*/*' })).toBe(false);
        expect(isDocumentRequest('POST', { 'sec-fetch-dest': 'document' })).toBe(false);
    });
});

describe('escapeScriptSource', () => {
    it('cannot close the script element and is ASCII-only', () => {
        const out = escapeScriptSource('a = "</script><b>"; b = "привет"; c = "<!-- x"');
        expect(out).not.toMatch(/<\/script/i);
        expect(out).not.toContain('<!--');
        expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
        // eslint-disable-next-line no-new-func
        expect(new Function(`${out}; return b;`)()).toBe('привет');
    });
});

describe('patchCspPolicy', () => {
    it('adds the nonce to script-src', () => {
        expect(patchCspPolicy("default-src 'self'; script-src 'self' https://cdn.x", N))
            .toBe(`default-src 'self'; script-src 'self' https://cdn.x 'nonce-${N}'`);
    });
    it("leaves 'unsafe-inline' policies alone (a nonce would disable it)", () => {
        const p = "script-src 'self' 'unsafe-inline'";
        expect(patchCspPolicy(p, N)).toBe(p);
    });
    it("adds the nonce when 'unsafe-inline' is already neutralised by a nonce/hash", () => {
        expect(patchCspPolicy("script-src 'unsafe-inline' 'nonce-abc' 'strict-dynamic'", N))
            .toContain(`'nonce-${N}'`);
    });
    it("falls back to default-src and replaces 'none'", () => {
        expect(patchCspPolicy("default-src 'none'; img-src *", N)).toBe(`default-src 'nonce-${N}'; img-src *`);
    });
    it('patches script-src-elem and script-src both', () => {
        const out = patchCspPolicy("script-src 'self'; script-src-elem 'self'", N);
        expect(out.match(/'nonce-NONCE'/g)).toHaveLength(2);
    });
    it('returns policies without script restrictions unchanged', () => {
        expect(patchCspPolicy("img-src 'self'; frame-ancestors 'none'", N)).toBe("img-src 'self'; frame-ancestors 'none'");
    });
});

describe('injectScriptsIntoHtmlResponse', () => {
    const S = [{ source: 'window.__x = 1;', name: 'r1' }];

    it('inserts right after <head> with a nonce and drops length/encoding/etag', () => {
        const res = htmlRes('<!doctype html><html><head><title>t</title></head><body>hi</body></html>', {
            'Content-Length': '10', ETag: '"abc"',
        });
        const out = injectScriptsIntoHtmlResponse(res, S);
        const html = unb64(out.bodyBase64);
        expect(html).toMatch(/^<!doctype html><html><head><script nonce="[^"]+" data-cupnet data-cupnet-rule="r1">window.__x = 1;<\/script><title>/);
        expect(out.headers['Content-Length']).toBeUndefined();
        expect(out.headers.ETag).toBeUndefined();
    });

    it('does not mistake <header> for <head>; falls back to <html> / doctype / start', () => {
        expect(unb64(injectScriptsIntoHtmlResponse(htmlRes('<html lang="ru"><body><header>x</header></body></html>'), S).bodyBase64))
            .toMatch(/^<html lang="ru"><script nonce=/);
        expect(unb64(injectScriptsIntoHtmlResponse(htmlRes('<!DOCTYPE html><p>x'), S).bodyBase64))
            .toMatch(/^<!DOCTYPE html><script nonce=/);
        expect(unb64(injectScriptsIntoHtmlResponse(htmlRes('<p>x'), S).bodyBase64)).toMatch(/^<script nonce=/);
    });

    it("puts position 'body-end' scripts before </body>", () => {
        const out = injectScriptsIntoHtmlResponse(htmlRes('<html><head></head><body>a</body></html>'), [
            { source: 'h()' }, { source: 'e()', position: 'body-end' },
        ]);
        const html = unb64(out.bodyBase64);
        expect(html).toMatch(/<head><script[^>]*>h\(\)<\/script><\/head><body>a<script[^>]*>e\(\)<\/script><\/body>/);
    });

    it('preserves non-UTF-8 page bytes (windows-1251)', () => {
        const cp1251 = Buffer.from([0x3c, 0x68, 0x65, 0x61, 0x64, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // <head>Привет
        const res = { statusCode: 200, headers: { 'content-type': 'text/html; charset=windows-1251' }, bodyBase64: cp1251.toString('base64') };
        const out = Buffer.from(injectScriptsIntoHtmlResponse(res, [{ source: 'x = "ё"' }]).bodyBase64, 'base64');
        expect(out.subarray(out.length - 6)).toEqual(cp1251.subarray(6));
        expect(out.toString('latin1')).toContain('x = "\\u0451"');
    });

    it('patches the CSP header and <meta http-equiv> with the same nonce as the tag', () => {
        const res = htmlRes(
            `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head></html>`,
            { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'nonce-site'" },
        );
        const out = injectScriptsIntoHtmlResponse(res, S);
        const html = unb64(out.bodyBase64);
        const nonce = nonceOf(html);
        expect(nonce).toBeTruthy();
        expect(out.headers['Content-Security-Policy']).toBe(`default-src 'self'; script-src 'self' 'nonce-site' 'nonce-${nonce}'`);
        expect(html).toContain(`content="script-src 'self' 'nonce-${nonce}'"`);
    });

    it('decodes gzip/br bodies and drops Content-Encoding', () => {
        for (const [enc, fn] of [['gzip', zlib.gzipSync], ['br', zlib.brotliCompressSync]]) {
            const res = { statusCode: 200, headers: { 'content-type': 'text/html', 'content-encoding': enc }, bodyBase64: fn(Buffer.from('<head></head>')).toString('base64') };
            const out = injectScriptsIntoHtmlResponse(res, S);
            expect(out.headers['content-encoding']).toBeUndefined();
            expect(unb64(out.bodyBase64)).toMatch(/^<head><script /);
        }
    });

    it('bodyDecoded: treats a known Content-Encoding as stale (MITM path), still skips unknown ones', () => {
        const stale = htmlRes('<head></head>', { 'Content-Encoding': 'br' }); // plain body, stale header
        const out = injectScriptsIntoHtmlResponse(stale, S, { bodyDecoded: true });
        expect(out.headers['Content-Encoding']).toBeUndefined();
        expect(unb64(out.bodyBase64)).toMatch(/^<head><script /);
        expect(injectScriptsIntoHtmlResponse(stale, S)).toBe(stale); // without the flag: br decode fails → untouched
        const unknown = htmlRes('<head>', { 'content-encoding': 'compress' });
        expect(injectScriptsIntoHtmlResponse(unknown, S, { bodyDecoded: true })).toBe(unknown);
    });

    it('leaves non-HTML, non-2xx, empty and unknown-encoding responses untouched', () => {
        const js = { statusCode: 200, headers: { 'content-type': 'application/javascript' }, bodyBase64: b64('x') };
        expect(injectScriptsIntoHtmlResponse(js, S)).toBe(js);
        const redirect = { ...htmlRes('<head>'), statusCode: 302 };
        expect(injectScriptsIntoHtmlResponse(redirect, S)).toBe(redirect);
        const empty = { ...htmlRes(''), bodyBase64: '' };
        expect(injectScriptsIntoHtmlResponse(empty, S)).toBe(empty);
        const weird = htmlRes('<head>', { 'content-encoding': 'compress' });
        expect(injectScriptsIntoHtmlResponse(weird, S)).toBe(weird);
    });
});

describe('request-interceptor inject rules', () => {
    const rule = (over = {}) => ({
        name: 'hook', type: 'inject', url_pattern: 'https://example.com/*', enabled: true,
        params: { source: 'window.__cn = 1;' }, ...over,
    });
    const docReq = { url: 'https://example.com/page', method: 'GET', headers: { 'sec-fetch-dest': 'document' } };

    it('plans a postProcess with the scripts for document requests only', async () => {
        const plan = await interceptor.planMitmIntercept({ ...docReq }, { rulesOverride: [rule()] });
        expect(plan.done).toBe(false);
        expect(plan.postProcess._inject).toEqual([{ source: 'window.__cn = 1;', position: 'head', name: 'hook' }]);

        const sub = await interceptor.planMitmIntercept(
            { ...docReq, headers: { 'sec-fetch-dest': 'script' } }, { rulesOverride: [rule()] },
        );
        expect(sub.postProcess).toBeFalsy(); // sub-resources keep streaming
    });

    it('collects several inject rules when stop_on_match is off and combines with modifyHeaders', async () => {
        const plan = await interceptor.planMitmIntercept({ ...docReq }, {
            rulesOverride: [
                rule({ name: 'a', stop_on_match: false }),
                rule({ name: 'b', stop_on_match: false, params: { source: 'b()', position: 'body-end' } }),
                { name: 'h', type: 'modifyHeaders', url_pattern: '*', enabled: true, params: { responseHeaders: { 'X-A': '1' } } },
            ],
        });
        expect(plan.postProcess._inject.map((s) => s.name)).toEqual(['a', 'b']);
        const out = interceptor.finalizeMitmInterceptResponse(htmlRes('<head></head><body></body>'), plan.postProcess);
        expect(out.headers['X-A']).toBe('1');
        const html = unb64(out.bodyBase64);
        expect(html).toMatch(/<head><script[^>]*>window.__cn = 1;<\/script><\/head><body><script[^>]*>b\(\)<\/script><\/body>/);
    });

    it('applies inject after a script rule after-phase too', async () => {
        const plan = await interceptor.planMitmIntercept({ ...docReq }, {
            rulesOverride: [
                rule({ stop_on_match: false }),
                { name: 's', type: 'script', url_pattern: '*', enabled: true, params: { afterSource: "ctx.response.headers['X-S'] = '1';" } },
            ],
        });
        // As the Go worker hands it over: decoded body, stale Content-Encoding.
        const out = await interceptor.finalizeMitmInterceptResponseAsync(htmlRes('<head></head>', { 'Content-Encoding': 'br' }), plan.postProcess);
        expect(out.headers['X-S']).toBe('1');
        expect(out.headers['Content-Encoding']).toBeUndefined();
        expect(unb64(out.bodyBase64)).toMatch(/^<head><script /);
    });

    it('validates inject rules before save', () => {
        expect(interceptor.validateInterceptRuleForSave(rule()).ok).toBe(true);
        expect(interceptor.validateInterceptRuleForSave(rule({ params: { source: '  ' } })).ok).toBe(false);
        expect(interceptor.validateInterceptRuleForSave(rule({ params: { source: 'function (' } })).ok).toBe(false);
        expect(interceptor.validateInterceptRuleForSave(rule({ params: { source: 'x()', position: 'footer' } })).ok).toBe(false);
    });
});

describe('request-interceptor /__cupnet/ local endpoint', () => {
    it('short-circuits only when a handler is set', async () => {
        const req = { url: 'https://example.com/__cupnet/ping', method: 'GET', headers: {} };
        const none = await interceptor.planMitmIntercept({ ...req }, { rulesOverride: [] });
        expect(none.done).toBe(false);
        interceptor.setLocalEndpointHandler(async () => ({ statusCode: 200, headers: {}, bodyBase64: b64('ok') }));
        try {
            const hit = await interceptor.planMitmIntercept({ ...req }, { rulesOverride: [] });
            expect(hit.done).toBe(true);
            expect(unb64(hit.response.bodyBase64)).toBe('ok');
            const other = await interceptor.planMitmIntercept({ ...req, url: 'https://example.com/x/__cupnet/ping' }, { rulesOverride: [] });
            expect(other.done).toBe(false);
        } finally {
            interceptor.setLocalEndpointHandler(null);
        }
    });
});
