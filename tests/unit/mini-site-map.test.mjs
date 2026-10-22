import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractPage, ownHidden, normUrl, newState, updateState, listSites, siteView, SiteMapCache, decodeEntities } = require('../../mini/site-map.js');

const BASE = 'https://shop.test/';

describe('helpers', () => {
    it('normUrl drops fragments, default ports and non-http schemes', () => {
        expect(normUrl('https://Shop.Test:443/a#x')).toBe('https://shop.test/a');
        expect(normUrl('../b?q=1', 'https://shop.test/x/y')).toBe('https://shop.test/b?q=1');
        expect(normUrl('ftp://x/')).toBe('');
        expect(normUrl('::nope')).toBe('');
    });
    it('decodeEntities', () => {
        expect(decodeEntities('a&amp;b &lt;&#x41;&#66;&nbsp;&bogus;')).toBe('a&b <AB &bogus;');
    });
    it('ownHidden classifies hiding', () => {
        expect(ownHidden('input', { type: 'HIDDEN' })).toEqual({ vis: 'hidden', why: 'type=hidden' });
        expect(ownHidden('div', { hidden: '' })).toMatchObject({ vis: 'hidden' });
        expect(ownHidden('div', { hidden: 'until-found' })).toBeNull();
        expect(ownHidden('div', { style: 'color:red; display : none' })).toMatchObject({ why: 'display:none' });
        expect(ownHidden('div', { style: 'visibility:hidden' })).toMatchObject({ why: 'visibility:hidden' });
        expect(ownHidden('div', { style: 'opacity:0' })).toMatchObject({ why: 'opacity:0' });
        expect(ownHidden('div', { style: 'opacity:0.5' })).toBeNull();
        expect(ownHidden('div', { style: 'position:absolute;left:-9999px' })).toMatchObject({ why: 'off-screen' });
        expect(ownHidden('div', { class: 'row d-none' })).toEqual({ vis: 'likely', why: 'class .d-none' });
        expect(ownHidden('div', { class: 'my-honeypot-field' })).toMatchObject({ vis: 'likely' });
        expect(ownHidden('div', { 'aria-hidden': 'true' })).toEqual({ vis: 'likely', why: 'aria-hidden' });
        expect(ownHidden('div', { class: 'visible' })).toBeNull();
    });
});

describe('extractPage', () => {
    const html = `<!doctype html><html><head><title>Shop &amp; Co</title>
        <link rel="canonical" href="/home"><link rel="stylesheet" href="/s.css"></head><body>
        <a href="/about">About <b>us</b></a>
        <a href="javascript:void(0)">js</a><a href="#top">top</a><a href="mailto:a@b">m</a>
        <a href="https://cdn.other.test/x" rel="nofollow">ext</a>
        <div style="display:none"><a href="/secret">Secret</a></div>
        <div class="d-none"><a href="/maybe">Maybe</a></div>
        <a href="/img"><img alt="Logo"></a>
        <iframe src="/frame"></iframe>
        <script>var s = '<a href="/not-a-link">';</script>
        <form id="login" action="/login" method="post">
            <label for="u">User name</label><input id="u" name="user" required>
            <label>Password <input type="password" name="pass"></label>
            <input type="hidden" name="csrf" value="tok">
            <input name="website" style="position:absolute;left:-5000px">
            <span class="sr-only"><input name="hp"></span>
            <select name="lang"><option value="en" selected>English</option><option>Deutsch</option></select>
            <textarea name="msg">hi &amp; bye</textarea>
            <button type="submit">Sign in</button>
        </form>
        <form><input name="q"></form>
        <input name="outside" form="login">
        <input name="orphan">
        </body></html>`;
    const p = extractPage(html, BASE);

    it('reads the title and links', () => {
        expect(p.title).toBe('Shop & Co');
        const by = Object.fromEntries(p.links.map((l) => [l.url, l]));
        expect(by['https://shop.test/home'].tag).toBe('link:canonical');
        expect(by['https://shop.test/s.css']).toBeUndefined();
        expect(by['https://shop.test/about']).toMatchObject({ tag: 'a', text: 'About us', vis: 'visible' });
        expect(by['https://cdn.other.test/x'].nofollow).toBe(true);
        expect(by['https://shop.test/secret']).toMatchObject({ vis: 'hidden' });
        expect(by['https://shop.test/secret'].why).toMatch(/inside hidden <div>/);
        expect(by['https://shop.test/maybe']).toMatchObject({ vis: 'likely' });
        expect(by['https://shop.test/img'].text).toBe('Logo');
        expect(by['https://shop.test/frame'].tag).toBe('iframe');
        expect(by['https://shop.test/not-a-link']).toBeUndefined();
        expect(p.links.some((l) => /javascript|mailto|#top/.test(l.raw))).toBe(false);
        expect(by['https://shop.test/login']).toMatchObject({ tag: 'form', method: 'POST' });
    });

    it('reads forms, fields, labels and visibility', () => {
        expect(p.forms).toHaveLength(3);
        const [login, search, orphan] = p.forms;
        expect(login).toMatchObject({ id: 'login', method: 'POST', action: 'https://shop.test/login', vis: 'visible' });
        const f = Object.fromEntries(login.fields.map((x) => [x.name, x]));
        expect(f.user).toMatchObject({ type: 'text', label: 'User name', required: true, vis: 'visible' });
        expect(f.pass).toMatchObject({ type: 'password', label: 'Password', vis: 'visible' });
        expect(f.csrf).toMatchObject({ vis: 'hidden', why: 'type=hidden', value: 'tok' });
        expect(f.website).toMatchObject({ vis: 'hidden', why: 'off-screen' });
        expect(f.hp).toMatchObject({ vis: 'likely' });
        expect(f.lang.options).toEqual([{ value: 'en', text: 'English', selected: true }, { value: 'Deutsch', text: 'Deutsch', selected: undefined }]);
        expect(f.msg.value).toBe('hi & bye');
        expect(login.fields.find((x) => x.tag === 'button')).toMatchObject({ type: 'submit', label: 'Sign in' });
        expect(f.outside).toBeDefined(); // form="login" outside the form
        expect(search).toMatchObject({ method: 'GET', action: BASE });
        expect(orphan).toMatchObject({ idx: -1 });
        expect(orphan.fields.map((x) => x.name)).toEqual(['orphan']);
    });

    it('honours <base href>', () => {
        const q = extractPage('<base href="https://shop.test/sub/"><a href="x">x</a>', BASE);
        expect(q.base).toBe('https://shop.test/sub/');
        expect(q.links[0].url).toBe('https://shop.test/sub/x');
    });
});

/** Fake SessionLog: list(after, n) summaries, get(seq) full entries. */
function fakeSrc(entries) {
    const all = entries.map((e, i) => ({ seq: i + 1, kind: 'request', method: 'GET', ts: 1000 + i, ...e }));
    return {
        all,
        push(e) { all.push({ seq: all.length + 1, kind: 'request', method: 'GET', ts: 2000, ...e }); },
        list(after, n) { return all.filter((e) => e.seq > after).slice(0, n).map(({ responseBody, responseHeaders, ...s }) => s); },
        get(seq) { return all.find((e) => e.seq === seq) || null; },
    };
}

const doc = (url, body, extra = {}) => ({ url, type: 'Document', status: 200, mime: 'text/html', responseBody: body, ...extra });

describe('updateState + siteView', () => {
    const src = fakeSrc([
        doc('https://shop.test/', '<a href="/a">A</a><a href="/b">B</a><div hidden><a href="/c">C</a></div><a href="https://blog.shop.test/p">blog</a><a href="https://ext.test/">ext</a><a href="/f.pdf">pdf</a>'
            + '<form action="/s"><input name="q"><input type="hidden" name="t"></form>'),
        { url: 'https://shop.test/app.js', type: 'Script', status: 200, mime: 'application/javascript' },
        doc('https://shop.test/a', `__b64__:${Buffer.from('<a href="/b">B again</a><form action="/s"><input name="q"><input type="hidden" name="t"></form>').toString('base64')}`),
        { url: 'https://shop.test/old', type: 'Document', status: 301, mime: '', responseHeaders: { Location: '/new' } },
        { kind: 'ws', url: 'wss://shop.test/ws' },
    ]);
    const st = updateState(newState(), src);

    it('scans documents and counts requests', () => {
        expect(st.scanned).toBe(2);
        expect(st.visited.size).toBe(3);
        expect(st.requests.get('shop.test')).toBe(4);
        expect(st.visited.get('https://shop.test/old').redirect).toBe('https://shop.test/new');
    });

    it('splits opened and not opened pages', () => {
        const v = siteView(st, 'shop.test');
        const by = Object.fromEntries(v.pages.map((p) => [p.path, p]));
        expect(by['/']).toMatchObject({ opened: true, status: 200, seq: 1, out: 7, forms: 1 });
        expect(by['/a']).toMatchObject({ opened: true, refs: 1 });
        expect(by['/b']).toMatchObject({ opened: false, refs: 2, text: 'B' });
        expect(by['/b'].from).toEqual(['https://shop.test/', 'https://shop.test/a']);
        expect(by['/c']).toMatchObject({ opened: false, hiddenRefs: 1 });
        expect(by['/f.pdf'].file).toBe(true);
        expect(by['/new']).toMatchObject({ opened: false, kinds: ['redirect'] });
        expect(by['/s']).toMatchObject({ opened: false, kinds: ['form'] });
        expect(by['/p']).toBeUndefined();
        expect(v.stats).toMatchObject({ opened: 3, notOpened: v.pages.length - 3, documents: 2 });
        expect(v.external.map((x) => x.host).sort()).toEqual(['blog.shop.test', 'ext.test']);
    });

    it('groups identical forms across pages', () => {
        const v = siteView(st, 'shop.test');
        expect(v.forms).toHaveLength(1);
        expect(v.forms[0]).toMatchObject({ action: 'https://shop.test/s', method: 'GET', pageCount: 2, counts: { fields: 2, hidden: 1, likely: 0, visible: 1 } });
        expect(v.stats.hiddenFields).toBe(1);
    });

    it('includes subdomains on request', () => {
        const v = siteView(st, 'shop.test', { subs: true });
        expect(v.pages.some((p) => p.host === 'blog.shop.test')).toBe(true);
        expect(v.external.map((x) => x.host)).toEqual(['ext.test']);
    });

    it('lists sites', () => {
        const sites = listSites(st);
        expect(sites[0]).toMatchObject({ host: 'shop.test', opened: 3, requests: 4 });
        expect(sites.map((s) => s.host)).toEqual(expect.arrayContaining(['blog.shop.test', 'ext.test']));
    });

    it('SiteMapCache scans incrementally', () => {
        const c = new SiteMapCache(2);
        const s1 = c.state('s', src);
        expect(siteView(s1, 'shop.test').pages.find((p) => p.path === '/b').opened).toBe(false);
        src.push(doc('https://shop.test/b', '<a href="/d">D</a>'));
        const s2 = c.state('s', src);
        expect(s2).toBe(s1);
        const v = siteView(s2, 'shop.test');
        expect(v.pages.find((p) => p.path === '/b').opened).toBe(true);
        expect(v.pages.find((p) => p.path === '/d').opened).toBe(false);
        c.state('x', fakeSrc([]));
        c.state('y', fakeSrc([]));
        expect(c.states.has('s')).toBe(false);
    });
});
