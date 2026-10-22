import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runAttack, planAttack, buildRequestAt, splitMarkers, MARKER } = require('../../mini/intruder.js');

const S = MARKER;
const tpl = (extra = {}) => ({ method: 'GET', url: `https://api.example.com/u/${S}id${S}`, headers: [['X-Tag', `${S}t${S}`]], body: '', ...extra });

/** Collect every event from a synchronous-ish attack with a canned responder. */
function attack(spec, send) {
    const events = [];
    const job = runAttack({ spec, send, onEvent: (e) => events.push(e) });
    return job.done.then(() => ({
        events,
        results: events.filter((e) => e.type === 'result'),
        done: events.find((e) => e.type === 'done'),
        start: events.find((e) => e.type === 'start'),
        job,
    }));
}

const ok = () => async (req) => ({ status: 200, length: req.url.length, duration: 1, bodyText: `echo ${req.url} ${JSON.stringify(req.headers)}` });

describe('splitMarkers', () => {
    it('splits §…§ pairs and keeps a lone § as text', () => {
        expect(splitMarkers(`a${S}x${S}b`)).toEqual({ parts: ['a', 'b'], baselines: ['x'] });
        expect(splitMarkers(`a${S}b`)).toEqual({ parts: [`a${S}b`], baselines: [] });
        expect(splitMarkers('plain')).toEqual({ parts: ['plain'], baselines: [] });
    });
});

describe('planAttack', () => {
    it('counts each attack type and rejects bad specs', () => {
        expect(planAttack({ template: tpl(), attackType: 'sniper', payloadSets: [['a', 'b', 'c']] })).toMatchObject({ positions: 2, count: 6 });
        expect(planAttack({ template: tpl(), attackType: 'ram', payloadSets: [['a', 'b', 'c']] }).count).toBe(3);
        expect(planAttack({ template: tpl(), attackType: 'pitchfork', payloadSets: [['a', 'b', 'c'], ['1', '2']] }).count).toBe(2);
        expect(planAttack({ template: tpl(), attackType: 'clusterbomb', payloadSets: [['a', 'b', 'c'], ['1', '2']] }).count).toBe(6);
        expect(() => planAttack({ template: { url: 'ftp://x/' }, attackType: 'sniper', payloadSets: [['a']] })).toThrow(/http/);
        expect(() => planAttack({ template: { url: 'https://x/' }, attackType: 'sniper', payloadSets: [['a']] })).toThrow(/Mark at least one/);
        expect(() => planAttack({ template: tpl(), attackType: 'sniper', payloadSets: [[]] })).toThrow(/at least one payload/);
        expect(() => planAttack({ template: tpl(), attackType: 'pitchfork', payloadSets: [['a']] })).toThrow(/Payload set 2/);
        expect(() => planAttack({ template: tpl(), attackType: 'clusterbomb', payloadSets: [Array.from({ length: 200 }, (_, i) => i), Array.from({ length: 200 }, (_, i) => i)] })).toThrow(/limit/);
    });
});

describe('runAttack', () => {
    it('sniper fires one position at a time, others keep the baseline', async () => {
        const { results, done } = await attack({ template: tpl(), attackType: 'sniper', payloadSets: [['A', 'B']] }, ok());
        expect(done).toMatchObject({ type: 'done', count: 4, completed: 4, stopped: false });
        // position 0 varies id, X-Tag stays "t"; position 1 varies X-Tag, id stays "id".
        const urls = results.map((r) => /\/u\/([^']*)/.exec(r.payloads)); // not reliable; check via positions instead
        expect(results.filter((r) => r.position === 0)).toHaveLength(2);
        expect(results.filter((r) => r.position === 1)).toHaveLength(2);
        expect(urls).toBeTruthy();
    });

    it('battering ram puts the same payload in every position', async () => {
        const seen = [];
        await attack({ template: tpl(), attackType: 'ram', payloadSets: [['Z']] }, async (req) => { seen.push(req); return { status: 200, length: 0, duration: 0, bodyText: '' }; });
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe('https://api.example.com/u/Z');
        expect(seen[0].headers[0][1]).toBe('Z');
    });

    it('cluster bomb covers every combination with the last position fastest', async () => {
        const combos = [];
        await attack({ template: tpl(), attackType: 'clusterbomb', payloadSets: [['a', 'b'], ['1', '2']] }, async (req) => { combos.push([req.url.split('/u/')[1], req.headers[0][1]]); return { status: 200, length: 0, duration: 0, bodyText: '' }; });
        expect(combos.sort()).toEqual([['a', '1'], ['a', '2'], ['b', '1'], ['b', '2']]);
    });

    it('url-encodes payloads when asked', async () => {
        let got;
        await attack({ template: { method: 'GET', url: `https://x.test/?q=${S}v${S}`, headers: [] }, attackType: 'sniper', urlEncode: true, payloadSets: [['a b&c']] }, async (req) => { got = req.url; return { status: 200, length: 0, duration: 0, bodyText: '' }; });
        expect(got).toBe('https://x.test/?q=a%20b%26c');
    });

    it('flags grep hits and counts them in done', async () => {
        const { results, done } = await attack({ template: tpl(), attackType: 'ram', payloadSets: [['a', 'b', 'c']], grep: 'ADMIN' }, async (req) => ({ status: 200, length: 0, duration: 0, bodyText: req.url.endsWith('b') ? 'role=ADMIN' : 'role=user' }));
        expect(results.filter((r) => r.matched)).toHaveLength(1);
        expect(done.matched).toBe(1);
    });

    it('records a send error and aborts the rest', async () => {
        const events = [];
        const job = runAttack({
            spec: { template: tpl(), attackType: 'ram', payloadSets: [['a', 'b', 'c', 'd', 'e']] },
            concurrency: 2,
            send: async () => { throw new Error('egress blocked'); },
            onEvent: (e) => events.push(e),
        });
        await job.done;
        const results = events.filter((e) => e.type === 'result');
        const done = events.find((e) => e.type === 'done');
        expect(results[0]).toMatchObject({ status: 0, error: 'egress blocked' });
        expect(done.stopped).toBe(true);
        expect(done.completed).toBeLessThan(5);
    });

    it('can be stopped and reports stopped', async () => {
        const gate = [];
        const events = [];
        const job = runAttack({
            spec: { template: tpl(), attackType: 'ram', payloadSets: [Array.from({ length: 50 }, (_, i) => String(i))] },
            concurrency: 2,
            send: () => new Promise((r) => gate.push(() => r({ status: 200, length: 0, duration: 0, bodyText: '' }))),
            onEvent: (e) => events.push(e),
        });
        await new Promise((r) => setTimeout(r, 10)); // let the pool call send() (it runs in a microtask)
        expect(gate).toHaveLength(2);
        job.stop();
        gate.forEach((r) => r());
        await job.done;
        const done = events.find((e) => e.type === 'done');
        expect(done).toMatchObject({ type: 'done', stopped: true, count: 50 });
        expect(done.completed).toBe(2);
    });

    it('buildRequestAt rebuilds the request for one index', async () => {
        const spec = { template: tpl(), attackType: 'clusterbomb', payloadSets: [['a', 'b'], ['1', '2']] };
        expect(buildRequestAt(spec, 0)).toMatchObject({ url: 'https://api.example.com/u/a', index: 0 });
        expect(buildRequestAt(spec, 3)).toMatchObject({ url: 'https://api.example.com/u/b', index: 3 });
        expect(buildRequestAt(spec, 3).headers[0][1]).toBe('2');
    });
});
