'use strict';

/** CupNet mini cookie manager (mini/cookie-jar.js): tracking, MITM overrides, queued browser ops. */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { CookieJar, parseSetCookie, serializeSetCookie, defaultPath, pathMatch } = require('../../mini/cookie-jar.js');

const tmpDirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'cupnet-cookies-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const jar = (o = {}) => new CookieJar({ now: () => NOW, ...o });
const byName = (j, name) => j.list().filter((c) => c.name === name);

describe('Set-Cookie parsing', () => {
    it('resolves defaults and attributes like RFC 6265', () => {
        const c = parseSetCookie('sid=abc; Path=/app; Domain=.Example.com; Secure; HttpOnly; SameSite=lax; Max-Age=60', 'https://www.example.com/x/y', NOW);
        expect(c).toMatchObject({ name: 'sid', value: 'abc', domain: 'example.com', hostOnly: false, path: '/app', secure: true, httpOnly: true, sameSite: 'Lax', expires: NOW + 60000, expired: false });
        expect(parseSetCookie('a=1', 'https://h.test/one/two', NOW)).toMatchObject({ domain: 'h.test', hostOnly: true, path: '/one', expires: null });
        // Max-Age wins over Expires; Max-Age=0 deletes.
        expect(parseSetCookie('a=1; Expires=Wed, 01 Jan 2099 00:00:00 GMT; Max-Age=0', 'https://h.test/', NOW).expired).toBe(true);
        // A foreign Domain is ignored by browsers.
        expect(parseSetCookie('a=1; Domain=evil.test', 'https://h.test/', NOW)).toBeNull();
        expect(defaultPath('/')).toBe('/');
        expect(pathMatch('/app/x', '/app')).toBe(true);
        expect(pathMatch('/apple', '/app')).toBe(false);
    });

    it('serializes a cookie and its removal', () => {
        const c = { name: 'a', value: 'b', domain: 'h.test', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: NOW + 1000 };
        expect(serializeSetCookie(c)).toBe(`a=b; Path=/; Domain=h.test; Expires=${new Date(NOW + 1000).toUTCString()}; Secure; HttpOnly; SameSite=None`);
        expect(serializeSetCookie({ ...c, hostOnly: true }, { remove: true })).toBe('a=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None');
    });
});

describe('CookieJar tracking', () => {
    it('tracks Set-Cookie (string or array), Cookie headers, value history and deletion', () => {
        const j = jar();
        j.observe({ url: 'https://www.example.com/login', requestHeaders: {}, responseHeaders: { 'Set-Cookie': ['sid=1; Path=/; Domain=example.com; HttpOnly', 'theme=dark'] } });
        j.observe({ url: 'https://api.example.com/me', requestHeaders: { cookie: 'sid=1' }, responseHeaders: { 'set-cookie': 'sid=2; Path=/; Domain=example.com' } });
        const [sid] = byName(j, 'sid');
        expect(sid).toMatchObject({ domain: 'example.com', hostOnly: false, value: '2', httpOnly: false, setCount: 2, sentCount: 1 });
        expect(sid.history.map((x) => [x.via, x.value])).toEqual([['set', '2'], ['set', '1']]);
        expect(byName(j, 'theme')[0]).toMatchObject({ domain: 'www.example.com', hostOnly: true, path: '/' });
        j.observe({ url: 'https://www.example.com/logout', requestHeaders: {}, responseHeaders: { 'Set-Cookie': 'sid=; Path=/; Domain=example.com; Max-Age=0' } });
        expect(byName(j, 'sid')[0]).toMatchObject({ deleted: true });
        expect(j.summary().cookies).toBe(1);
    });

    it('infers cookies seen only in requests and replaces them once Set-Cookie shows the real scope', () => {
        const j = jar();
        j.observe({ url: 'https://shop.example.com/', requestHeaders: { Cookie: 'cart=7; a=b' }, responseHeaders: {} });
        expect(byName(j, 'cart')[0]).toMatchObject({ inferred: true, domain: 'shop.example.com', sentCount: 1 });
        j.observe({ url: 'https://shop.example.com/', requestHeaders: {}, responseHeaders: { 'Set-Cookie': 'cart=8; Domain=example.com; Path=/' } });
        const carts = byName(j, 'cart');
        expect(carts).toHaveLength(1);
        expect(carts[0]).toMatchObject({ inferred: false, domain: 'example.com', value: '8' });
        // Never-seen cookie removed by the site: nothing recorded.
        j.observe({ url: 'https://x.test/', requestHeaders: {}, responseHeaders: { 'Set-Cookie': 'ghost=; Max-Age=0' } });
        expect(byName(j, 'ghost')).toHaveLength(0);
    });

    it('evicts the least recently seen cookies over the cap', () => {
        let t = NOW;
        const j = new CookieJar({ now: () => ++t, maxCookies: 3 });
        for (const n of ['a', 'b', 'c', 'd']) j.observe({ url: 'https://h.test/', requestHeaders: {}, responseHeaders: { 'Set-Cookie': `${n}=1` } });
        expect(j.list().map((c) => c.name)).toEqual(['b', 'c', 'd']);
    });
});

describe('CookieJar overrides (MITM hooks)', () => {
    const up = (cookie) => ({
        url: 'https://www.example.com/p',
        headers: { Accept: '*/*', ...(cookie != null ? { Cookie: cookie } : {}) },
        orderedHeaders: [['accept', '*/*'], ...(cookie != null ? [['cookie', cookie]] : []), ['priority', 'u=1']],
    });

    it('pins, strips and adds cookies in headers and orderedHeaders', () => {
        const j = jar();
        j.addOverride({ action: 'pin', domain: 'example.com', name: 'sid', value: 'PINNED' });
        j.addOverride({ action: 'strip', domain: 'www.example.com', name: '_ga' });
        const u = up('sid=real; _ga=1; x=2');
        expect(j.beforeUpstream(u)).toBe(true);
        expect(u.headers.Cookie).toBe('sid=PINNED; x=2');
        expect(u.orderedHeaders).toEqual([['accept', '*/*'], ['Cookie', 'sid=PINNED; x=2'], ['priority', 'u=1']]);
        // Missing cookie header: pin adds one before `priority`.
        const u2 = up(null);
        j.beforeUpstream(u2);
        expect(u2.headers.Cookie).toBe('sid=PINNED');
        expect(u2.orderedHeaders.map((x) => x[0].toLowerCase())).toEqual(['accept', 'cookie', 'priority']);
        // Other sites are untouched.
        const u3 = { ...up('sid=real'), url: 'https://other.test/' };
        expect(j.beforeUpstream(u3)).toBe(false);
        expect(j.overrides[0].hits).toBe(2);
    });

    it('strip * removes the whole Cookie header; disabled rules do nothing', () => {
        const j = jar();
        const o = j.addOverride({ action: 'strip', domain: '*', name: '*' });
        const u = up('a=1; b=2');
        j.beforeUpstream(u);
        expect(u.headers.Cookie).toBeUndefined();
        expect(u.orderedHeaders.some(([k]) => k.toLowerCase() === 'cookie')).toBe(false);
        j.updateOverride(o.id, { enabled: false });
        const u2 = up('a=1');
        expect(j.beforeUpstream(u2)).toBe(false);
        expect(u2.headers.Cookie).toBe('a=1');
    });

    it('blocks Set-Cookie by name before Chrome sees it', () => {
        const j = jar();
        j.addOverride({ action: 'block', domain: 'example.com', name: 'track' });
        const out = { statusCode: 200, headers: { 'Set-Cookie': ['track=1; Path=/', 'keep=1'] } };
        expect(j.responseHead({ url: 'https://example.com/', headers: {} }, out)).toBe(true);
        expect(out.headers['Set-Cookie']).toBe('keep=1');
        expect(() => j.addOverride({ action: 'pin', domain: 'x.test', name: '*' })).toThrow(/one cookie name/);
    });
});

describe('CookieJar browser ops', () => {
    const resp = () => ({ statusCode: 200, headers: { 'content-type': 'text/html' } });

    it('injects a queued set into the next first-party response from a matching host only', () => {
        const j = jar();
        const op = j.queueSet({ name: 'sid', value: 'new', domain: 'example.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
        expect(j.summary().pending).toBe(1);
        // Wrong host, cross-site subresource and plain http (Secure cookie) do not take it.
        for (const [url, hdr] of [['https://other.test/', {}], ['https://www.example.com/', { 'Sec-Fetch-Site': 'cross-site' }], ['http://www.example.com/', {}]]) {
            const out = resp();
            expect(j.responseHead({ url, headers: hdr }, out)).toBe(false);
            expect(out.headers['Set-Cookie']).toBeUndefined();
        }
        const out = resp();
        expect(j.responseHead({ url: 'https://www.example.com/a', headers: { 'sec-fetch-site': 'none' } }, out)).toBe(true);
        expect(out.headers['Set-Cookie']).toBe('sid=new; Path=/; Domain=example.com; Secure; HttpOnly; SameSite=Lax');
        expect(j.ops.find((x) => x.id === op.id)).toMatchObject({ state: 'applied', appliedUrl: 'https://www.example.com/a' });
        expect(byName(j, 'sid')[0]).toMatchObject({ value: 'new', source: 'manual' });
        expect(byName(j, 'sid')[0].history[0].via).toBe('manual');
    });

    it('keeps the site Set-Cookie lines next to injected ones, deletes every scope of an inferred cookie', () => {
        const j = jar();
        j.observe({ url: 'https://a.b.example.com/', requestHeaders: { Cookie: 'x=1' }, responseHeaders: {} });
        const [x] = byName(j, 'x');
        j.queueDelete({ ids: [x.id] });
        const out = { statusCode: 200, headers: { 'Set-Cookie': 'site=1' } };
        j.responseHead({ url: 'https://a.b.example.com/', headers: {} }, out);
        const lines = out.headers['Set-Cookie'];
        expect(lines[0]).toBe('site=1');
        expect(lines.slice(1).map((l) => (/Domain=([^;]+)/.exec(l) || [, '(host)'])[1])).toEqual(['(host)', 'a.b.example.com', 'b.example.com', 'example.com']);
        expect(lines.slice(1).every((l) => l.startsWith('x=; Path=/;') && l.includes('Max-Age=0'))).toBe(true);
        expect(byName(j, 'x')[0].deleted).toBe(true);
    });

    it('validates prefixes, replaces pending ops for the same cookie, clears a site, expires old ops', () => {
        let t = NOW;
        const j = new CookieJar({ now: () => t });
        expect(() => j.queueSet({ name: '__Host-a', value: '1', domain: 'h.test', hostOnly: false, secure: true })).toThrow(/__Host-/);
        expect(() => j.queueSet({ name: 'a', value: '1', domain: 'h.test', sameSite: 'none' })).toThrow(/SameSite=None/);
        const a = j.queueSet({ name: 'a', value: '1', domain: 'h.test' });
        j.queueSet({ name: 'a', value: '2', domain: 'h.test' });
        expect(j.ops.find((x) => x.id === a.id).state).toBe('replaced');
        j.queueClearSite('h.test');
        const out = resp();
        j.responseHead({ url: 'https://h.test/', headers: {} }, out);
        expect(out.headers['Clear-Site-Data']).toBe('"cookies"');
        expect(out.headers['Set-Cookie']).toBe('a=2; Path=/');
        const late = j.queueSet({ name: 'b', value: '1', domain: 'h.test' });
        t += 2 * 60 * 60 * 1000;
        j.responseHead({ url: 'https://h.test/', headers: {} }, resp());
        expect(j.ops.find((x) => x.id === late.id).state).toBe('expired');
        expect(j.cancelOp(late.id)).toBe(false);
    });
});

describe('CookieJar import / export / persistence', () => {
    it('round-trips JSON and Netscape exports through import', () => {
        const j = jar();
        j.observe({ url: 'https://www.example.com/', requestHeaders: {}, responseHeaders: { 'Set-Cookie': ['s=1; Domain=example.com; Secure; HttpOnly; SameSite=None; Max-Age=3600', 'h=2'] } });
        const json = JSON.parse(j.exportJson(j.list()));
        expect(json.find((c) => c.name === 's')).toMatchObject({ domain: '.example.com', hostOnly: false, sameSite: 'no_restriction', expirationDate: Math.floor((NOW + 3600e3) / 1000) });
        for (const text of [j.exportJson(j.list()), j.exportNetscape(j.list())]) {
            const { cookies, errors } = CookieJar.parseImport(text);
            expect(errors).toEqual([]);
            expect(cookies.map((c) => [c.name, c.domain, c.hostOnly, c.secure])).toEqual([['s', 'example.com', false, true], ['h', 'www.example.com', true, false]]);
        }
        expect(j.exportNetscape(j.list())).toContain('#HttpOnly_.example.com\tTRUE\t/\tTRUE\t');
        const bad = CookieJar.parseImport('[{"name":"a b","domain":"x.test"},{"name":"ok","value":"1","domain":"x.test"}]');
        expect(bad.cookies).toHaveLength(1);
        expect(bad.errors[0]).toMatch(/^#1: /);
        expect(CookieJar.parseImport('{"cookies":[{"name":"p","value":"1","domain":".x.test","expires":-1}]}').cookies[0]).toMatchObject({ hostOnly: false, expires: null });
    });

    it('persists cookies, overrides and pending ops to a 0600 file', () => {
        const file = path.join(tmp(), 'cookies.json');
        const a = jar({ file });
        a.observe({ url: 'https://h.test/', requestHeaders: {}, responseHeaders: { 'Set-Cookie': 'a=1' } });
        a.addOverride({ action: 'strip', domain: 'h.test', name: 'b' });
        a.queueSet({ name: 'c', value: '3', domain: 'h.test' });
        a.close();
        expect(statSync(file).mode & 0o777).toBe(0o600);
        const b = jar({ file });
        expect(b.summary()).toMatchObject({ cookies: 1, overrides: 1, pending: 1 });
        expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
    });
});
