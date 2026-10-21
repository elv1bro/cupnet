'use strict';

/**
 * CupNet mini Console + Page analyzer: the page agent's value preview / serializer / prompt wrapping
 * and console capture (run under Node with a fake window), the PageAgents command channel, the
 * server half of the analyzer (security audit, header tech, agent stripping) and console log entries.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { pageAgentMain } = require('../../mini/page-agent.js');
const { PageAgents } = require('../../mini/page-agents.js');
const { auditSecurityHeaders, techFromHeaders, stripAgentFromLoggedDocument, AGENT_RULE_NAME } = require('../../mini/page-analyzer.js');
const { injectScriptsIntoHtmlResponse } = require('../../html-inject.js');
const { SessionLog } = require('../../mini/session-log.js');

const dirs = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the agent against a fake window; returns its test exports, the fake console and posted bodies. */
function agent() {
    const posts = [];
    const noop = () => {};
    const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug', 'group', 'groupCollapsed', 'groupEnd', 'count', 'time', 'timeEnd'].map((k) => [k, noop]));
    const W = {
        console, setTimeout, clearTimeout, Error, SyntaxError, EvalError,
        location: { href: 'https://site.test/page' },
        fetch: (url, o) => { posts.push({ url, body: JSON.parse(o.body) }); return Promise.resolve({ ok: true, json: () => ({}) }); },
    };
    let X;
    pageAgentMain({ doc: 'a'.repeat(24) }, { test: true, window: W, expose: (o) => { X = o; } });
    return { ...X, console, posts };
}

describe('page agent value preview (shortText / formatText)', () => {
    const A = agent();
    it('previews objects like DevTools, one level deep', () => {
        const v = { n: 3, s: 'q', d: new Date(0), r: /x/g, f: function foo() {}, m: new Map([[1, 2]]) };
        expect(A.shortText(v)).toBe('{n: 3, s: "q", d: 1970-01-01T00:00:00.000Z, r: /x/g, f: ƒ foo(), m: Map(1)}');
        expect(A.shortText({ b: 10n, bad: new Date(NaN) })).toBe('{b: 10n, bad: Invalid Date}');
        expect(A.shortText([1, 'a', [2, 3]])).toBe('(3) [1, "a", Array(2)]');
        expect(A.shortText(new Map([['k', { a: 1 }]]))).toBe('Map(1) {"k" => {…}}');
        expect(A.shortText(new Set([1, 2]))).toBe('Set(2) {1, 2}');
        expect(A.shortText('top-level strings are bare')).toBe('top-level strings are bare');
        class Point { constructor() { this.x = 1; } }
        expect(A.shortText(new Point())).toBe('Point {x: 1}');
    });
    it('cuts long objects with an ellipsis', () => {
        const o = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
        expect(A.shortText(o)).toMatch(/^\{k0: 0, .*k5: 5, …\}$/);
    });
    it('applies printf-style substitutions', () => {
        expect(A.formatText(['%s is %d', 'n', '42.5', { a: 1 }])).toBe('n is 42 {a: 1}');
        expect(A.formatText(['%c styled %%', 'color:red'])).toBe(' styled %');
        expect(A.formatText(['x'.repeat(600)])).toHaveLength(501);
    });
});

describe('page agent serializer', () => {
    const A = agent();
    it('keeps special numbers, maps and errors', () => {
        const v = A.serialize({ a: [1, NaN, -0], m: new Map([[1, 2]]), e: new Error('boom') });
        expect(v.t).toBe('obj');
        const p = Object.fromEntries(v.props);
        expect(p.a.items).toEqual([1, { t: 'n', v: 'NaN' }, { t: 'n', v: '-0' }]);
        expect(p.m).toMatchObject({ t: 'map', n: 1, entries: [[1, 2]] });
        expect(p.e).toMatchObject({ t: 'err', name: 'Error', msg: 'boom' });
    });
    it('marks cycles and does not run getters', () => {
        const c = {};
        c.self = c;
        expect(A.serialize(c).props).toEqual([['self', { t: 'cyc' }]]);
        let ran = false;
        const g = { get x() { ran = true; return 1; } };
        expect(A.serialize(g).props).toEqual([['x', { t: 'get' }]]);
        expect(ran).toBe(false);
    });
});

describe('page agent prompt wrapping (wrapBodies)', () => {
    const A = agent();
    const firstThatRuns = (bodies) => {
        for (const b of bodies) { try { return (0, eval)(b); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
        throw new Error('nothing parsed');
    };
    it('returns the value of the last statement', () => {
        expect(firstThatRuns(A.wrapBodies('1 + 2', false))).toBe(3);
        expect(firstThatRuns(A.wrapBodies('let a = 2; a * 21', false))).toBe(42);
        expect(firstThatRuns(A.wrapBodies('let a = 2;\na * 21;\n', false))).toBe(42);
        expect(firstThatRuns(A.wrapBodies('if (1) { 5 }', false))).toBeUndefined();
    });
    it('supports top-level await', async () => {
        expect(await firstThatRuns(A.wrapBodies('await Promise.resolve(41) + 1', true))).toBe(42);
        expect(await firstThatRuns(A.wrapBodies('const x = await Promise.resolve(6); x * 7', true))).toBe(42);
    });
});

describe('page agent console capture', () => {
    it('batches console calls with level, severity, args and group depth', async () => {
        const A = agent();
        A.console.log('hello %s', 'world', { n: 1 });
        A.console.warn('careful');
        A.console.group('g');
        A.console.error('inside');
        A.console.groupEnd();
        A.console.count('c');
        A.console.count('c');
        await new Promise((r) => setTimeout(r, 400));
        const sent = A.posts.filter((p) => p.url.endsWith('/__cupnet/console'));
        expect(sent).toHaveLength(1);
        const { body } = sent[0];
        expect(body).toMatchObject({ doc: 'a'.repeat(24), url: 'https://site.test/page' });
        const items = body.items.map(({ lvl, sev, text, g }) => ({ lvl, sev, text, g }));
        expect(items).toEqual([
            { lvl: 'log', sev: 'info', text: 'hello world {n: 1}', g: undefined },
            { lvl: 'warn', sev: 'warn', text: 'careful', g: undefined },
            { lvl: 'group', sev: 'info', text: 'g', g: undefined },
            { lvl: 'error', sev: 'error', text: 'inside', g: 1 },
            { lvl: 'count', sev: 'info', text: 'c: 1', g: undefined },
            { lvl: 'count', sev: 'info', text: 'c: 2', g: undefined },
        ]);
        expect(body.items[0].args[2]).toMatchObject({ t: 'obj', props: [['n', 1]] });
    });
});

describe('PageAgents', () => {
    const ORIGIN = 'https://site.test';
    const DOC = 'b'.repeat(24);
    it('registers pages only with a valid id from the same origin', () => {
        const pa = new PageAgents();
        expect(pa.touch(ORIGIN, { doc: 'short' })).toBeNull();
        expect(pa.touch('', { doc: DOC })).toBeNull();
        const d = pa.touch(ORIGIN, { doc: DOC, url: `${ORIGIN}/x`, title: 'T' });
        expect(d).toMatchObject({ id: DOC, origin: ORIGIN, url: `${ORIGIN}/x`, title: 'T' });
        expect(pa.touch('https://evil.test', { doc: DOC })).toBeNull();
        // A URL from another origin is ignored.
        pa.touch(ORIGIN, { doc: DOC, url: 'https://evil.test/' });
        expect(pa.get(DOC).url).toBe(`${ORIGIN}/x`);
    });
    it('hands commands to polls and resolves on the agent result', async () => {
        const pa = new PageAgents();
        pa.touch(ORIGIN, { doc: DOC });
        const p = pa.command(DOC, { op: 'eval', code: '1' });
        const { cmds, next } = pa.poll(ORIGIN, { doc: DOC });
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toMatchObject({ op: 'eval', code: '1' });
        expect(next).toBe(1000); // a command makes the UI "watched"
        expect(pa.poll(ORIGIN, { doc: DOC }).cmds).toEqual([]);
        expect(pa.result('https://evil.test', { id: cmds[0].id, doc: DOC, ok: true })).toBe(false);
        expect(pa.result(ORIGIN, { id: cmds[0].id, doc: DOC, ok: true, text: '1' })).toBe(true);
        await expect(p).resolves.toEqual({ ok: true, text: '1' });
    });
    it('fails commands for unknown pages, on timeout and when the page is dropped', async () => {
        const pa = new PageAgents();
        await expect(pa.command('c'.repeat(24), {})).rejects.toMatchObject({ status: 404 });
        pa.touch(ORIGIN, { doc: DOC });
        await expect(pa.command(DOC, { op: 'x' }, 20)).rejects.toMatchObject({ status: 504 });
        expect(pa.get(DOC).queue).toEqual([]);
        const p = pa.command(DOC, { op: 'y' });
        pa.clear();
        await expect(p).rejects.toMatchObject({ status: 410 });
    });
    it('counts console entries and lists live pages first', () => {
        const pa = new PageAgents();
        const a = pa.touch(ORIGIN, { doc: DOC });
        pa.noteConsole(a, [{ sev: 'error' }, { sev: 'warn' }, { sev: 'info' }]);
        const old = pa.touch(ORIGIN, { doc: 'd'.repeat(24) });
        old.lastSeen = Date.now() - 60 * 1000;
        const list = pa.list();
        expect(list.map((x) => [x.id, x.live])).toEqual([[DOC, true], ['d'.repeat(24), false]]);
        expect(list[0]).toMatchObject({ console: 3, errors: 1, warnings: 1 });
    });
});

describe('page analyzer: security audit', () => {
    const by = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.status]));
    it('flags a bare response', () => {
        const s = by(auditSecurityHeaders({ Server: 'nginx/1.25.3', 'X-Powered-By': 'Express' }));
        expect(s).toMatchObject({
            'Content-Security-Policy': 'bad', 'Strict-Transport-Security': 'bad', Clickjacking: 'warn',
            'X-Content-Type-Options': 'warn', 'Referrer-Policy': 'info', Server: 'warn', 'X-Powered-By': 'warn',
        });
    });
    it('accepts a hardened response', () => {
        const s = by(auditSecurityHeaders({
            'content-security-policy': "default-src 'none'; script-src 'nonce-abc' 'strict-dynamic'; base-uri 'none'; frame-ancestors 'self'",
            'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', server: 'cloudflare', 'cf-ray': '1',
        }));
        expect(s).toMatchObject({
            'Content-Security-Policy': 'good', 'Strict-Transport-Security': 'good', 'Clickjacking (frame-ancestors)': 'good',
            'X-Content-Type-Options': 'good', 'Referrer-Policy': 'good', Server: 'info', 'CDN / WAF': 'info',
        });
    });
    it('explains weak CSPs and skips HSTS on plain HTTP', () => {
        const rows = auditSecurityHeaders({ 'Content-Security-Policy': "script-src 'unsafe-inline' 'unsafe-eval' *" }, { https: false });
        const csp = rows.find((r) => r.name === 'Content-Security-Policy');
        expect(csp.status).toBe('warn');
        expect(csp.note).toContain("'unsafe-inline'");
        expect(csp.note).toContain("'unsafe-eval'");
        expect(csp.note).toContain('wildcard');
        expect(by(rows)['Strict-Transport-Security']).toBe('info');
    });
});

describe('page analyzer: technologies from headers', () => {
    const names = (h) => techFromHeaders(h).map((t) => (t.version ? `${t.name} ${t.version}` : t.name));
    it('parses server / x-powered-by with versions', () => {
        expect(names({ Server: 'nginx/1.25.3', 'X-Powered-By': 'Express 4.18' })).toEqual(['nginx 1.25.3', 'Express 4.18']);
        expect(names({ server: 'Apache/2.4.57 (Ubuntu)', 'x-powered-by': 'PHP/8.2.1' })).toEqual(['Apache 2.4.57', 'PHP 8.2.1']);
    });
    it('detects CDNs, WAFs and bot management', () => {
        expect(names({ 'cf-ray': 'x', 'set-cookie': ['a=1', '__cf_bm=2; path=/'] })).toEqual(['Cloudflare', 'Cloudflare Bot Management']);
        expect(names({ 'x-served-by': 'cache-ams123' })).toEqual(['Fastly']);
        expect(names({ 'x-served-by': 'some-app' })).toEqual([]);
        expect(names({ 'x-qrator-request-id': '1', 'x-aspnet-version': '4.0' })).toEqual(['Qrator', 'ASP.NET']);
    });
});

describe('page analyzer: stripping the agent from logged documents', () => {
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const csp = "default-src 'self'; script-src 'self'";
    const inject = (html, extra = []) => {
        const res = { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }, bodyBase64: b64(html) };
        const out = injectScriptsIntoHtmlResponse(res, [{ source: 'void "agent"', position: 'head', name: AGENT_RULE_NAME, connectSelf: true }, ...extra]);
        return { body: Buffer.from(out.bodyBase64, 'base64').toString('utf8'), headers: out.headers };
    };
    const html = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><title>t</title></head><body>hello world, long enough</body></html>';

    it('restores the original body and CSP', () => {
        const { body, headers } = inject(html);
        expect(body).toContain(AGENT_RULE_NAME);
        expect(headers['Content-Security-Policy']).not.toBe(csp);
        const out = stripAgentFromLoggedDocument(body, headers);
        expect(out.body).toBe(html);
        expect(out.headers['Content-Security-Policy']).toBe(csp);
    });
    it('keeps the nonce when user inject rules share it', () => {
        const { body, headers } = inject(html, [{ source: 'void "mine"', position: 'body-end', name: 'mine' }]);
        const out = stripAgentFromLoggedDocument(body, headers);
        expect(out.body).not.toContain(AGENT_RULE_NAME);
        expect(out.body).toContain('void "mine"');
        expect(out.headers).toBe(headers);
    });
    it('ignores documents without the agent', () => {
        expect(stripAgentFromLoggedDocument(html, {})).toBeNull();
        expect(stripAgentFromLoggedDocument(null, {})).toBeNull();
    });
});

describe('SessionLog.logConsole', () => {
    it('stores console entries with a one-line note and full args', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'cupnet-console-'));
        dirs.push(dir);
        const log = new SessionLog({ dir });
        const args = [{ t: 'obj', cls: 'Object', n: 1, props: [['a', 1]] }];
        const e = log.logConsole('https://site.test/', { lvl: 'warn', sev: 'warn', text: 'x', args, src: 'https://site.test/a.js:1:2', g: 99, t: 5 }, 'e'.repeat(24), 1);
        expect(e).toMatchObject({ kind: 'console', type: 'warn', sev: 'warn', note: 'x', url: 'https://site.test/', doc: 'e'.repeat(24), g: 32 });
        expect(log.get(e.seq).data).toMatchObject({ args, t: 5, frame: 1 });
        const odd = log.logConsole('https://site.test/', { lvl: '<script>', sev: 'nope', text: 'y'.repeat(5000) });
        expect(odd).toMatchObject({ type: 'script', sev: 'info' });
        expect(odd.note.length).toBeLessThan(5000);
        expect(log.get(odd.seq).data.text).toHaveLength(5000);
    });
});
