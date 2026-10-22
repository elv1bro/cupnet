import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { DnsStore, normalizeHost, normalizeIp, parseHosts } = require('../../mini/dns-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-dns-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => new DnsStore({ file: path.join(dir, `dns-${++n}.json`) });

describe('normalizeHost / normalizeIp', () => {
    it('normalizes hosts and wildcards', () => {
        expect(normalizeHost(' API.Example.com. ')).toBe('api.example.com');
        expect(normalizeHost('*.Example.com')).toBe('*.example.com');
        expect(normalizeHost('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
    });
    it('rejects IPs, junk and bad wildcards', () => {
        expect(normalizeHost('1.2.3.4')).toBe('');
        expect(normalizeHost('a b')).toBe('');
        expect(normalizeHost('*.')).toBe('');
        expect(normalizeHost('a.*.com')).toBe('');
        expect(normalizeHost('')).toBe('');
    });
    it('accepts canonical IPv4 and IPv6 only', () => {
        expect(normalizeIp('10.0.0.1')).toBe('10.0.0.1');
        expect(normalizeIp('[::1]')).toBe('::1');
        expect(normalizeIp('FE80::1')).toBe('fe80::1');
        expect(normalizeIp('010.0.0.1')).toBe('');
        expect(normalizeIp('example.com')).toBe('');
    });
});

describe('parseHosts', () => {
    it('reads several hosts per line, notes and disabled rules', () => {
        const r = parseHosts('# comment\n10.0.0.1 a.com b.com # staging\n# off: 10.0.0.2 c.com\nbad line\n\n::1\td.com');
        expect(r).toEqual([
            { ip: '10.0.0.1', host: 'a.com', note: 'staging', enabled: true },
            { ip: '10.0.0.1', host: 'b.com', note: 'staging', enabled: true },
            { ip: '10.0.0.2', host: 'c.com', note: '', enabled: false },
            { ip: '::1', host: 'd.com', note: '', enabled: true },
        ]);
    });
});

describe('DnsStore', () => {
    it('adds, rejects duplicates and bad input, updates and removes', () => {
        const s = fresh();
        const r = s.add({ host: 'API.example.com', ip: '10.1.1.1' });
        expect(r).toMatchObject({ host: 'api.example.com', ip: '10.1.1.1', enabled: true, cors: false, rewriteHost: null });
        expect(r.id).toMatch(/^[0-9a-f]{12}$/);
        expect(() => s.add({ host: 'api.example.com', ip: '10.1.1.2' })).toThrow(expect.objectContaining({ status: 409 }));
        expect(() => s.add({ host: 'x', ip: 'nope' })).toThrow(expect.objectContaining({ status: 400 }));
        expect(() => s.add({ host: 'x.com', ip: '1.1.1.1', rewriteHost: 'bad host' })).toThrow(/Rewrite Host/);
        const u = s.update(r.id, { enabled: false, rewriteHost: 'origin.internal:8443', note: 'n' });
        expect(u).toMatchObject({ id: r.id, host: 'api.example.com', enabled: false, rewriteHost: 'origin.internal:8443', note: 'n' });
        expect(() => s.update('000000000000', {})).toThrow(expect.objectContaining({ status: 404 }));
        expect(s.remove(r.id)).toBe(true);
        expect(s.remove(r.id)).toBe(false);
    });

    it('persists rules across instances', () => {
        const file = path.join(dir, 'persist.json');
        const a = new DnsStore({ file });
        const r = a.add({ host: '*.shop.test', ip: '127.0.0.1', cors: true });
        const b = new DnsStore({ file });
        expect(b.rules).toHaveLength(1);
        expect(b.rules[0]).toMatchObject({ id: r.id, host: '*.shop.test', cors: true });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('imports and exports hosts files (round trip)', () => {
        const s = fresh();
        s.add({ host: 'a.com', ip: '1.1.1.1' });
        const res = s.importHosts('2.2.2.2 a.com # moved\n3.3.3.3 b.com\n# off: 4.4.4.4 c.com\n127.0.0.1 localhost\n5.5.5.5 bad_host!');
        expect(res).toEqual({ added: 2, updated: 1, skipped: 2 });
        expect(s.get(s.rules[0].id)).toMatchObject({ host: 'a.com', ip: '2.2.2.2', note: 'moved' });
        const t = fresh();
        t.importHosts(s.exportHosts());
        expect(t.rules.map((r) => [r.host, r.ip, r.enabled, r.note])).toEqual(s.rules.map((r) => [r.host, r.ip, r.enabled, r.note]));
        const rep = t.importHosts('9.9.9.9 z.com', { replace: true });
        expect(rep.added).toBe(1);
        expect(t.rules.map((r) => r.host)).toEqual(['z.com']);
    });

    it('maps rules to the MITM shape', () => {
        const s = fresh();
        const r = s.add({ host: 'a.com', ip: '1.1.1.1', rewriteHost: 'b.com', cors: true, enabled: false });
        expect(s.toMitmRules()).toEqual([{ id: r.id, host: 'a.com', ip: '1.1.1.1', enabled: false, rewrite_host: 'b.com', mitm_inject_cors: true }]);
    });

    it('counts hits and keeps activity', () => {
        const s = fresh();
        const r = s.add({ host: 'a.com', ip: '1.1.1.1' });
        s.noteHit({ id: r.id, host: 'a.com', ip: '1.1.1.1' }, { url: 'https://a.com/', method: 'GET', status: 200, seq: 7 });
        s.noteHit({ host: 'a.com', ip: '1.1.1.1' }, { url: 'https://a.com/x' });
        s.noteHit({ host: 'other.com', ip: '2.2.2.2' });
        s.noteHit(null);
        expect(s.list()[0]).toMatchObject({ hits: 2 });
        expect(s.list()[0].lastHit).toBeGreaterThan(0);
        expect(s.activity).toHaveLength(3);
        expect(s.activity[0]).toMatchObject({ ruleId: r.id, seq: 7, status: 200, method: 'GET' });
        expect(s.activity[2].ruleId).toBeNull();
        s.clearActivity();
        expect(s.activity).toHaveLength(0);
        expect(s.list()[0].hits).toBe(0);
    });
});
