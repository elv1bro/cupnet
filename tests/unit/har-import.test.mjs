import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { Writable } from 'stream';

const require = createRequire(import.meta.url);
const { writeHar, parseHar } = require('../../mini/har.js');

/** Collect writeHar output into a string. */
async function toHar(entries) {
    let out = '';
    const sink = new Writable({ write(c, _e, cb) { out += c; cb(); } });
    await writeHar(sink, entries, { version: 'test' });
    return out;
}

describe('HAR import (parseHar)', () => {
    it('round-trips a session through export and import', async () => {
        const entries = [
            {
                kind: 'request', seq: 1, ts: Date.parse('2026-10-01T10:00:00Z'),
                method: 'GET', url: 'https://ex.com/a?x=1', status: 200, type: 'Document', duration: 123,
                requestHeaders: { Accept: 'text/html', Cookie: 'a=1' },
                responseHeaders: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['a=1', 'b=2'] },
                requestBody: null, responseBody: '<html>hi</html>',
            },
            {
                kind: 'request', seq: 2, ts: Date.parse('2026-10-01T10:00:01Z'),
                method: 'POST', url: 'https://ex.com/api', status: 201, type: 'XHR', duration: 40,
                requestHeaders: { 'content-type': 'application/json' },
                responseHeaders: { 'content-type': 'application/octet-stream' },
                requestBody: '{"k":1}', responseBody: `__b64__:${Buffer.from([1, 2, 3, 4]).toString('base64')}`,
            },
        ];
        const parsed = parseHar(await toHar(entries));
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toMatchObject({
            method: 'GET', url: 'https://ex.com/a?x=1', status: 200, type: 'Document', duration: 123,
            responseBody: '<html>hi</html>',
        });
        // Original timestamp, multi-value headers and binary bodies survive the round-trip.
        expect(new Date(parsed[0].ts).toISOString()).toBe('2026-10-01T10:00:00.000Z');
        expect(parsed[0].responseHeaders['set-cookie']).toEqual(['a=1', 'b=2']);
        expect(parsed[1].responseBody).toBe(`__b64__:${Buffer.from([1, 2, 3, 4]).toString('base64')}`);
    });

    it('rejects a document that is not HAR', () => {
        expect(() => parseHar('{"nope":true}')).toThrow(/HAR/);
    });

    it('skips entries with no request url', async () => {
        const har = { log: { version: '1.2', entries: [{ request: {}, response: {} }, { request: { url: 'https://x.y/' }, response: { status: 200 } }] } };
        const parsed = parseHar(har);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].url).toBe('https://x.y/');
    });
});
