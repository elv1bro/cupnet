import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { SessionLog } = require('../../mini/session-log.js');
const { startSearch, compileQuery } = require('../../mini/session-search.js');

let dir;
const ids = ['20261001-100000-aaaa', '20261002-100000-bbbb'];

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-search-'));
    const a = new SessionLog({ dir, sessionId: ids[0] });
    a.logRequest({
        method: 'POST', url: 'https://api.example.com/login?next=%2Fhome', status: 200,
        requestHeaders: { 'Content-Type': 'application/json', Cookie: 'sid=abc' },
        responseHeaders: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'token=SECRET42'] },
        requestBody: '{"user":"alice","pass":"x"}', responseBody: '{"ok":true,"Token":"Secret42"}',
    });
    a.logRequest({ method: 'GET', url: 'https://cdn.other.net/logo.png', status: 200, responseHeaders: {}, responseBody: `__b64__:${Buffer.from('secret42 in binary').toString('base64')}` });
    a.logWs(1, { dir: 'in', type: 'text', data: Buffer.from('{"event":"secret42 pushed"}'), url: 'https://api.example.com/socket' });
    a.logConsole('https://api.example.com/', { lvl: 'log', text: 'debug', args: [{ t: 'object', v: { key: 'Secret42' } }] });
    await a.close();
    const b = new SessionLog({ dir, sessionId: ids[1] });
    for (let i = 0; i < 20; i++) b.logRequest({ method: 'GET', url: `https://www.example.com/item/${i}`, status: 200, responseHeaders: {}, responseBody: `item ${i} secret42` });
    await b.close();
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function run(opts) {
    const events = [];
    const job = startSearch({ sessionsDir: dir, sessions: ids.map((id) => ({ id })), onEvent: (e) => events.push(e), ...opts });
    return job.done.then(() => ({ events, hits: events.filter((e) => e.type === 'hit').map((e) => e.hit), end: events[events.length - 1] }));
}

describe('compileQuery', () => {
    it('rejects bad and empty-matching patterns', () => {
        expect(() => compileQuery({ q: '  ' })).toThrow(/Type something/);
        expect(() => compileQuery({ q: 'a(', regex: true })).toThrow(/Invalid regular expression/);
        expect(() => compileQuery({ q: 'x*', regex: true })).toThrow(/empty text/);
    });
    it('uses the raw-line prefilter only when the literal survives JSON as is', () => {
        expect(compileQuery({ q: 'secret' }).prefilter).toBe(true);
        expect(compileQuery({ q: 'a"b' }).prefilter).toBe(false);
        expect(compileQuery({ q: 'cookie: sid' }).prefilter).toBe(false);
        expect(compileQuery({ q: 'sec.*', regex: true }).prefilter).toBe(false);
    });
});

describe('startSearch', () => {
    it('finds a literal case-insensitively across sessions, kinds and fields, skipping binary bodies', async () => {
        const { hits, end } = await run({ q: 'secret42' });
        expect(end).toMatchObject({ type: 'done', scanned: 2, truncated: false });
        const first = hits.filter((h) => h.session === ids[0]);
        expect(first.map((h) => h.kind)).toEqual(['request', 'ws', 'console']);
        expect(first[0].matches.map((m) => m.field)).toEqual(['resHeaders', 'resBody']);
        expect(first[0].matches[1]).toMatchObject({ hit: 'Secret42', count: 1 });
        expect(first[0].matches[1].pre).toContain('"Token":"');
        expect(hits.some((h) => h.url?.includes('logo.png'))).toBe(false);
        expect(hits.filter((h) => h.session === ids[1])).toHaveLength(20);
    });

    it('honours case, regex, fields, kinds and host', async () => {
        expect((await run({ q: 'secret42', caseSensitive: true })).hits.filter((h) => h.session === ids[0]).map((h) => h.kind)).toEqual(['ws']);
        expect((await run({ q: 'cookie: sid=' })).hits.map((h) => h.matches[0].field)).toEqual(['reqHeaders']);
        expect((await run({ q: 'item/1\\d$', regex: true, fields: ['url'] })).hits.map((h) => h.seq)).toHaveLength(10);
        expect((await run({ q: 'secret42', kinds: ['ws', 'console'] })).hits).toHaveLength(2);
        expect((await run({ q: 'secret42', host: 'www.' })).hits).toHaveLength(20);
        expect((await run({ q: 'alice', fields: ['headers'] })).hits).toHaveLength(0);
    });

    it('stops at the hit limit and reports it', async () => {
        const { hits, end } = await run({ q: 'secret42', limit: 5 });
        expect(hits).toHaveLength(5);
        expect(end).toMatchObject({ type: 'done', truncated: true, hits: 5 });
    });

    it('can be stopped', async () => {
        const events = [];
        const job = startSearch({ sessionsDir: dir, sessions: ids.map((id) => ({ id })), q: 'secret42', onEvent: (e) => events.push(e) });
        job.stop();
        await job.done;
        expect(events.some((e) => e.type === 'done')).toBe(false);
    });
});
