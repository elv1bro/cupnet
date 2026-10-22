import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { NotesStore, siteMatches, noteRefs } = require('../../mini/notes-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-notes-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('NotesStore', () => {
    it('adds, normalizes, updates and removes notes', () => {
        const s = new NotesStore({ file: path.join(dir, 'a.json') });
        const n = s.add({ title: '  Login flow ', body: '# hi', site: 'https://Shop.Example.com/login', tags: '#Auth, auth bug' });
        expect(n).toMatchObject({ title: 'Login flow', body: '# hi', site: 'shop.example.com', tags: ['auth', 'bug'], pinned: false });
        expect(() => s.add({ site: 'not a host!' })).toThrow(/Site must be/);
        expect(() => s.add({ body: 'x'.repeat(512 * 1024 + 1) })).toThrow(/limited/);
        const u = s.update(n.id, { pinned: true, tags: ['x'] });
        expect(u).toMatchObject({ id: n.id, title: 'Login flow', site: 'shop.example.com', pinned: true, tags: ['x'] });
        expect(() => s.update('000000000000', {})).toThrow(expect.objectContaining({ status: 404 }));
        expect(s.remove(n.id)).toBe(true);
        expect(s.remove(n.id)).toBe(false);
    });

    it('sorts pinned first, filters by host, counts tags and persists', () => {
        const file = path.join(dir, 'b.json');
        const s = new NotesStore({ file });
        const a = s.add({ title: 'a', site: '*.example.com', tags: ['t1', 't2'] });
        const b = s.add({ title: 'b', site: 'other.com', tags: ['t1'] });
        s.update(a.id, { pinned: true });
        expect(s.list().map((x) => x.title)).toEqual(['a', 'b']);
        expect(s.forHost('www.example.com').map((x) => x.id)).toEqual([a.id]);
        expect(s.forHost('OTHER.com').map((x) => x.id)).toEqual([b.id]);
        expect(s.tags()).toEqual([{ tag: 't1', count: 2 }, { tag: 't2', count: 1 }]);
        const again = new NotesStore({ file });
        expect(again.list().map((x) => [x.id, x.pinned])).toEqual([[a.id, true], [b.id, false]]);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('starts empty on a broken file', () => {
        const file = path.join(dir, 'broken.json');
        fs.writeFileSync(file, '{nope');
        expect(new NotesStore({ file }).list()).toEqual([]);
    });
});

describe('siteMatches / noteRefs', () => {
    it('matches exact hosts and wildcards', () => {
        expect(siteMatches('*.example.com', 'example.com')).toBe(true);
        expect(siteMatches('*.example.com', 'a.b.example.com')).toBe(true);
        expect(siteMatches('*.example.com', 'badexample.com')).toBe(false);
        expect(siteMatches('example.com', 'www.example.com')).toBe(false);
        expect(siteMatches('', 'example.com')).toBe(false);
    });
    it('finds request references', () => {
        expect(noteRefs('see cupnet:req/s-1/12 and cupnet:req/abc/3')).toEqual([{ session: 's-1', seq: 12 }, { session: 'abc', seq: 3 }]);
        expect(noteRefs('')).toEqual([]);
    });
});
