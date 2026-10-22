import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { MirrorAudit, isTextType } = require('../../mini/mirror-audit.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-mirror-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const entry = (over = {}) => ({
    ruleId: 'r1',
    ruleName: 'shop mirror',
    method: 'GET',
    clientHost: 'shop.test',
    upstreamHost: 'origin.example.com',
    clientUrl: '/products',
    status: 200,
    contentType: 'text/html',
    hits: 2,
    rewrote: true,
    before: Buffer.from('<p>origin.example.com</p>'),
    after: Buffer.from('<p>shop.test</p>'),
    ts: Date.now(),
    ...over,
});

describe('MirrorAudit', () => {
    it('adds a row, stores both bodies and serves the diff', () => {
        const audit = new MirrorAudit({ dir: path.join(dir, 'a') });
        const row = audit.add(entry());
        expect(row).toMatchObject({
            ruleName: 'shop mirror', clientHost: 'shop.test', upstreamHost: 'origin.example.com',
            status: 200, rewrote: true, changed: true, hasBodies: true,
        });
        expect(row.id).toMatch(/^[a-z0-9]+$/);
        const full = audit.get(row.id);
        expect(full.before).toBe('<p>origin.example.com</p>');
        expect(full.after).toBe('<p>shop.test</p>');
        const page = audit.list();
        expect(page.total).toBe(1);
        expect(page.items[0].id).toBe(row.id);
    });

    it('does not store bodies for binary content', () => {
        const audit = new MirrorAudit({ dir: path.join(dir, 'b') });
        const row = audit.add(entry({ contentType: 'image/png', before: Buffer.from([1, 2]), after: Buffer.from([3, 4]) }));
        expect(row.hasBodies).toBe(false);
        expect(audit.get(row.id).before).toBeNull();
    });

    it('lists newest first and clears', () => {
        const audit = new MirrorAudit({ dir: path.join(dir, 'c') });
        const a = audit.add(entry({ clientUrl: '/one' }));
        const b = audit.add(entry({ clientUrl: '/two' }));
        const page = audit.list();
        expect(page.items.map((r) => r.id)).toEqual([b.id, a.id]);
        audit.clear();
        expect(audit.list().total).toBe(0);
        expect(audit.get(a.id)).toBeNull();
    });

    it('rejects a malformed id without touching disk', () => {
        const audit = new MirrorAudit({ dir: path.join(dir, 'd') });
        expect(audit.get('../etc/passwd')).toBeNull();
        expect(audit.get('')).toBeNull();
    });

    it('prunes down once the amortized threshold is crossed and drops orphaned bodies', () => {
        const audit = new MirrorAudit({ dir: path.join(dir, 'e'), limit: 3 });
        const ids = [];
        // Pruning is amortized: it fires only once _count exceeds limit + 200, then rewrites to `limit`.
        for (let i = 0; i < 260; i += 1) ids.push(audit.add(entry({ clientUrl: `/p${i}` })).id);
        const page = audit.list({ limit: 1000 });
        expect(page.total).toBeLessThan(260);
        expect(page.total).toBeLessThanOrEqual(audit.limit + 200);
        // the oldest ids were pruned from both the log and the bodies dir
        expect(audit.get(ids[0])).toBeNull();
        const bodies = fs.readdirSync(path.join(dir, 'e', 'bodies'));
        expect(bodies.length).toBe(page.total * 2); // every surviving row keeps before + after
    });

    it('isTextType classifies common content types', () => {
        expect(isTextType('text/html')).toBe(true);
        expect(isTextType('application/json')).toBe(true);
        expect(isTextType('image/png')).toBe(false);
    });
});
