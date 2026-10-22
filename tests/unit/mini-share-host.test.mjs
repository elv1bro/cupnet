import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const require = createRequire(import.meta.url);
const { ShareHost } = require('../../mini/share-host.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-share-'));
const ID = 'a'.repeat(32);
let host;

const req = (p, { method = 'GET', hostHeader } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: host.port, path: p, method, headers: { Host: hostHeader || `localhost:${host.port}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
});

beforeAll(async () => {
    fs.writeFileSync(path.join(dir, `${ID}.cupsess`), Buffer.from([1, 2, 3, 4]));
    host = new ShareHost({ sealedDir: dir });
    await host.start(0);
});
afterAll(async () => {
    await host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('ShareHost', () => {
    it('reports status and builds links with the key in the fragment', () => {
        expect(host.status()).toEqual({ running: true, port: host.port, url: `http://localhost:${host.port}/` });
        expect(host.linkFor(ID)).toBe(`http://localhost:${host.port}/#id=${ID}`);
        expect(host.linkFor(ID, 'KEY')).toBe(`http://localhost:${host.port}/#id=${ID}&k=KEY`);
    });

    it('serves the viewer with a hash-based CSP', async () => {
        const r = await req('/');
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toMatch(/text\/html/);
        expect(r.headers['content-security-policy']).toMatch(/script-src 'sha256-/);
        expect(r.headers['content-security-policy']).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
        expect(r.headers['x-frame-options']).toBe('DENY');
    });

    it('serves sealed files by id only', async () => {
        const r = await req(`/sealed/${ID}.cupsess`);
        expect(r.status).toBe(200);
        expect([...r.body]).toEqual([1, 2, 3, 4]);
        expect(r.headers['cache-control']).toBe('no-store');
        expect((await req(`/sealed/${'b'.repeat(32)}.cupsess`)).status).toBe(404);
        expect((await req('/sealed/../../etc/passwd')).status).toBe(404);
        expect((await req('/sealed/')).status).toBe(404);
        const head = await req(`/sealed/${ID}.cupsess`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(head.body.length).toBe(0);
    });

    it('rejects foreign Host headers and non-GET methods', async () => {
        expect((await req('/', { hostHeader: 'evil.com' })).status).toBe(421);
        expect((await req('/', { hostHeader: `evil.com:${host.port}` })).status).toBe(421);
        const p = await req('/', { method: 'POST' });
        expect(p.status).toBe(405);
        expect(p.headers.allow).toBe('GET, HEAD');
    });

    it('stops cleanly', async () => {
        const h = new ShareHost({ sealedDir: dir });
        await h.start(0);
        expect(h.running).toBe(true);
        await h.stop();
        expect(h.status()).toMatchObject({ running: false, url: null });
    });
});
