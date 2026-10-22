import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildSnapshot } = require('../../mini/page-snapshot.js');

/** Minimal SessionLog stand-in. */
function fakeSrc(entries) {
    const all = entries.map((e, i) => ({ kind: 'request', status: 200, seq: i + 1, ts: 1000 + i, ...e }));
    return {
        list: (after, limit) => all.filter((e) => e.seq > after).slice(0, limit).map(({ responseBody, responseHeaders, ...s }) => s),
        get: (seq) => all.find((e) => e.seq === seq) || null,
    };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('buildSnapshot', () => {
    const page = {
        url: 'https://shop.test/a/',
        mime: 'text/html',
        responseHeaders: { 'Content-Type': 'text/html; charset=utf-8' },
        responseBody: '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.test/"><base href="/b/">'
            + '<link rel="stylesheet" href="s.css"><link rel="preload" href="x.js"><script>alert(1)</script></head>'
            + '<body style="background:url(bg.png)"><img src="i.png" srcset="i.png 1x, big.png 2x"><img src="gone.png">'
            + '<iframe src="https://ads.test/"></iframe><a href="/x">x</a></body></html>',
    };
    const src = fakeSrc([
        { url: 'https://shop.test/b/s.css', mime: 'text/css', responseHeaders: { 'content-type': 'text/css' }, responseBody: '@import "t.css"; .a{background:url("i.png")} .b{background:url("../none.png")}' },
        { url: 'https://shop.test/b/t.css', mime: 'text/css', responseHeaders: { 'content-type': 'text/css' }, responseBody: 'body{color:red}' },
        { url: 'https://shop.test/b/i.png', mime: 'image/png', responseHeaders: { 'content-type': 'image/png' }, responseBody: `__b64__:${PNG.toString('base64')}` },
        { url: 'https://shop.test/b/bg.png', mime: 'image/png', responseHeaders: { 'content-type': 'image/png' }, responseBody: `__b64__:${PNG.toString('base64')}` },
        page,
    ]);
    const r = buildSnapshot(src, 5);

    it('drops scripts, refresh, base and frames, and puts its own CSP after the doctype', () => {
        expect(r.html.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
        expect(r.html).not.toMatch(/<script|alert\(1\)|evil\.test|<base|<iframe|x\.js/);
        expect(r.html).toMatch(/iframe · https:\/\/ads\.test\//);
        expect(r.stats.scripts).toBe(1);
    });

    it('inlines captured CSS (with @import) and turns resources into data: URLs', () => {
        expect(r.html).toContain('body{color:red}');
        expect(r.html).not.toMatch(/https:\/\/shop\.test\/b\/(s|t)\.css/);
        expect((r.html.match(/data:image\/png;base64,/g) || []).length).toBeGreaterThanOrEqual(4);
        expect(r.stats.styles).toBe(2);
    });

    it('lists what was not captured', () => {
        expect(r.missing).toEqual(expect.arrayContaining(['https://shop.test/b/gone.png', 'https://shop.test/b/big.png', 'https://shop.test/none.png']));
        expect(r.html).not.toContain('gone.png');
    });

    it('refuses non-HTML entries', () => {
        expect(() => buildSnapshot(src, 1)).toThrow(/Not an HTML/);
        expect(() => buildSnapshot(src, 99)).toThrow(/no such/);
    });
});
