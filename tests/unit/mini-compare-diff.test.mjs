'use strict';

/** CupNet mini request compare (mini/compare-diff.js). */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const D = require('../../mini/compare-diff.js');

/** Rebuild both sides from line ops — any correct diff must give back the inputs. */
const sides = (ops) => [
    ops.filter((o) => o.t !== '+').map((o) => o.text).join('\n'),
    ops.filter((o) => o.t !== '-').map((o) => o.text).join('\n'),
];

describe('compare-diff', () => {
    it('diffs header multimaps case-insensitively and can ignore volatile names', () => {
        const a = D.pairsOf({ Accept: 'a', 'X-Old': '1', Date: 'Mon', 'Set-Cookie': ['a=1', 'b=2'] });
        const b = D.pairsOf({ accept: 'b', 'x-new': '2', date: 'Tue', 'set-cookie': ['a=1', 'b=2'] });
        const r = D.diffPairs(a, b);
        expect(r.rows.map((x) => [x.name, x.state])).toEqual([['Accept', 'changed'], ['X-Old', 'removed'], ['Date', 'changed'], ['Set-Cookie', 'same'], ['x-new', 'added']]);
        expect(D.diffPairs(a, b, { ignore: D.VOLATILE }).counts).toEqual({ same: 1, changed: 1, added: 1, removed: 1 });
    });

    it('spots a moved header even when values match', () => {
        const o = D.orderDiff(['Host', 'Accept', 'User-Agent', 'Cookie'], ['host', 'user-agent', 'cookie', 'accept']);
        expect(o.same).toBe(false);
        expect([...o.moved]).toEqual(['accept']);
        expect(D.orderDiff(['a', 'b'], ['a', 'x', 'b']).same).toBe(true);
    });

    it('splits cookies, Set-Cookie and query strings', () => {
        expect(D.cookiePairs({ Cookie: 'a=1; b=x=y; flag' })).toEqual([['a', '1'], ['b', 'x=y'], ['flag', '']]);
        expect(D.setCookiePairs({ 'Set-Cookie': ['sid=1; Path=/', 'x=2'] })).toEqual([['sid', '1; Path=/'], ['x', '2']]);
        expect(D.queryPairs('https://h.test/?a=1&b=2&a=3')).toEqual([['a', '1'], ['b', '2'], ['a', '3']]);
        expect(D.queryPairs('not a url')).toEqual([]);
    });

    it('diffs JSON structurally', () => {
        const r = D.jsonDiff({ a: 1, b: { c: [1, 2], d: 'x' }, 'k-1': true }, { a: 2, b: { c: [1], e: null }, 'k-1': 'yes' });
        expect(r.rows).toEqual([
            { path: '$.a', kind: 'changed', a: '1', b: '2' },
            { path: '$.b.c[1]', kind: 'removed', a: '2' },
            { path: '$.b.d', kind: 'removed', a: '"x"' },
            { path: '$.b.e', kind: 'added', b: 'null' },
            { path: '$["k-1"]', kind: 'type', a: 'true', b: '"yes"' },
        ]);
        expect(D.jsonDiff([...Array(10).keys()], [], { maxRows: 3 })).toMatchObject({ truncated: true });
        expect(D.tryJson(' {"a":1}')).toEqual({ a: 1 });
        expect(D.tryJson('<html>')).toBeUndefined();
    });

    it('line diff reconstructs both sides on random inputs', () => {
        let seed = 7;
        const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
        for (let t = 0; t < 200; t++) {
            const a = Array.from({ length: rnd(40) }, () => 'abcde'[rnd(5)]);
            const b = a.filter(() => rnd(4)).map((x) => (rnd(5) ? x : 'xyz'[rnd(3)]));
            if (rnd(2)) b.splice(rnd(b.length + 1), 0, 'new');
            const r = D.lineDiff(a.join('\n'), b.join('\n'));
            expect(sides(r.ops)).toEqual([a.join('\n'), b.join('\n')]);
            expect(r.added).toBe(r.ops.filter((o) => o.t === '+').length);
        }
        expect(D.lineDiff('a\nb', 'a\nb').ops.every((o) => o.t === '=')).toBe(true);
    });

    it('gives up on huge edit distances and collapses unchanged runs', () => {
        const big = (p) => Array.from({ length: 3000 }, (_, i) => `${p}${i}`).join('\n');
        expect(D.lineDiff(big('a'), big('b')).tooBig).toBe(true);
        const a = Array.from({ length: 50 }, (_, i) => `l${i}`);
        const b = a.slice(); b[25] = 'changed';
        const hs = D.hunks(D.lineDiff(a.join('\n'), b.join('\n')).ops, 2);
        expect(hs.map((x) => x.t)).toEqual(['skip', '=', '=', '-', '+', '=', '=', 'skip']);
        expect(hs[0]).toEqual({ t: 'skip', count: 23, from: 0 });
    });

    it('summarizes two entries', () => {
        const rows = D.summaryRows({ method: 'GET', url: 'u', status: 200, duration: 5 }, { method: 'GET', url: 'u', status: 0, duration: 5 });
        expect(rows.find((r) => r.name === 'Status')).toMatchObject({ a: '200', b: 'failed', state: 'changed' });
        expect(rows.find((r) => r.name === 'Method').state).toBe('same');
    });
});
