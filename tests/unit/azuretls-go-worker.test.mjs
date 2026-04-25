/**
 * Integration-style unit tests: NDJSON protocol against the built Go worker binary.
 * Skips if `azuretls-go/bin/azuretls-worker-*` was not built (`npm run build:go:local`).
 * HTTP cases require network (httpbin.org).
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

function resolveGoWorkerBinary() {
    const arch = process.arch;
    const platform = process.platform;
    let name;
    if (platform === 'darwin') {
        name = arch === 'arm64' ? 'azuretls-worker-darwin-arm64' : 'azuretls-worker-darwin-amd64';
    } else if (platform === 'linux') {
        name = arch === 'arm64' ? 'azuretls-worker-linux-arm64' : 'azuretls-worker-linux-amd64';
    } else if (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) {
        name = 'azuretls-worker-win32-amd64.exe';
    } else {
        return null;
    }
    return path.join(repoRoot, 'azuretls-go', 'bin', name);
}

const goBin = resolveGoWorkerBinary();
const haveBinary = goBin && existsSync(goBin);

function spawnWorker() {
    const proc = spawn(goBin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    const nextJson = () =>
        new Promise((resolve, reject) => {
            const onLine = (line) => {
                try {
                    resolve(JSON.parse(line));
                } catch (e) {
                    reject(e);
                }
            };
            rl.once('line', onLine);
            rl.once('error', reject);
        });
    return { proc, rl, nextJson };
}

describe.skipIf(!haveBinary)('azuretls-go worker (NDJSON binary)', () => {
    it('emits __init__ then answers __get_profiles__ and __clear_sessions__', async () => {
        const { proc, rl, nextJson } = spawnWorker();

        const init = await nextJson();
        expect(init.id).toBe('__init__');
        expect(init.status).toBe('ready');

        proc.stdin.write(`${JSON.stringify({ id: '__get_profiles__' })}\n`);
        const prof = await nextJson();
        expect(prof.id).toBe('__get_profiles__');
        expect(prof.profiles).toBeTruthy();
        expect(prof.profiles.chrome.userAgent).toMatch(/Chrome/i);

        proc.stdin.write(`${JSON.stringify({ id: '__clear_sessions__' })}\n`);
        const cleared = await nextJson();
        expect(cleared.id).toBe('__clear_sessions__');
        expect(cleared.status).toBe('ok');
        expect(cleared.cleared).toBe(true);

        proc.stdin.end();
        await new Promise((resolve, reject) => {
            proc.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
            proc.once('error', reject);
        });
        rl.close();
    });

    it('HTTP GET to httpbin.org/get returns 200 and JSON body', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();

        const id = 't-http-get';
        proc.stdin.write(
            `${JSON.stringify({
                id,
                method: 'GET',
                url: 'https://httpbin.org/get',
                browser: 'chrome',
            })}\n`
        );
        const res = await nextJson();
        expect(res.id).toBe(id);
        expect(res.statusCode).toBe(200);
        expect(res.error == null || res.error === '').toBe(true);
        const raw = Buffer.from(res.bodyBase64, 'base64').toString('utf8');
        const json = JSON.parse(raw);
        expect(json.url).toContain('httpbin.org/get');

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    });

    it('POST with body echoes via httpbin.org/post', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();
        const id = 't-post';
        const payload = 'hello-cupnet-post';
        proc.stdin.write(
            `${JSON.stringify({
                id,
                method: 'POST',
                url: 'https://httpbin.org/post',
                browser: 'chrome',
                bodyBase64: Buffer.from(payload, 'utf8').toString('base64'),
            })}\n`
        );
        const res = await nextJson();
        expect(res.id).toBe(id);
        expect(res.statusCode).toBe(200);
        const raw = Buffer.from(res.bodyBase64, 'base64').toString('utf8');
        const json = JSON.parse(raw);
        expect(json.data).toBe(payload);

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    });

    it('orderedHeaders preserved (httpbin /headers)', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();
        const id = 't-oh';
        proc.stdin.write(
            `${JSON.stringify({
                id,
                method: 'GET',
                url: 'https://httpbin.org/headers',
                browser: 'chrome',
                orderedHeaders: [['X-Custom', 'test123']],
            })}\n`
        );
        const res = await nextJson();
        expect(res.statusCode).toBe(200);
        const raw = Buffer.from(res.bodyBase64, 'base64').toString('utf8');
        expect(raw).toMatch(/test123/i);

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    });

    it('disableRedirects returns 302 for httpbin redirect/1', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();
        const id = 't-dr';
        proc.stdin.write(
            `${JSON.stringify({
                id,
                method: 'GET',
                url: 'https://httpbin.org/redirect/1',
                browser: 'chrome',
                disableRedirects: true,
            })}\n`
        );
        const res = await nextJson();
        expect(res.id).toBe(id);
        expect(res.statusCode).toBe(302);

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    });

    it('invalid JSON line returns Invalid JSON', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();
        proc.stdin.write('not json\n');
        const res = await nextJson();
        expect(res.error).toBe('Invalid JSON');

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    });

    it('JSON without id returns missing id', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();
        proc.stdin.write('{"method":"GET"}\n');
        const res = await nextJson();
        expect(res.error).toBe('missing id');

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    });

    it('concurrent requests return matching ids', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();
        const n = 5;
        for (let i = 0; i < n; i++) {
            proc.stdin.write(
                `${JSON.stringify({
                    id: `conc-${i}`,
                    method: 'GET',
                    url: 'https://httpbin.org/get',
                    browser: 'chrome',
                })}\n`
            );
        }
        const byId = {};
        for (let i = 0; i < n; i++) {
            const row = await nextJson();
            byId[row.id] = row;
        }
        for (let i = 0; i < n; i++) {
            const id = `conc-${i}`;
            expect(byId[id]).toBeDefined();
            expect(byId[id].statusCode).toBe(200);
        }

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    });

    it('large body round-trip (1MB)', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();
        const id = 't-big';
        const buf = Buffer.alloc(1024 * 1024, 0x41);
        proc.stdin.write(
            `${JSON.stringify({
                id,
                method: 'POST',
                url: 'https://httpbin.org/post',
                browser: 'chrome',
                bodyBase64: buf.toString('base64'),
            })}\n`
        );
        const res = await nextJson();
        expect(res.statusCode).toBe(200);
        const raw = Buffer.from(res.bodyBase64, 'base64').toString('utf8');
        const json = JSON.parse(raw);
        expect(json.data.length).toBe(1024 * 1024);

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    }, 120_000);

    it('graceful shutdown (stdin end, exit 0)', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();
        proc.stdin.end();
        const code = await new Promise((resolve) => {
            proc.once('exit', resolve);
        });
        expect(code).toBe(0);
        rl.close();
    });

    it('__clear_sessions__ during idle then another request succeeds', async () => {
        const { proc, rl, nextJson } = spawnWorker();
        await nextJson();

        proc.stdin.write(
            `${JSON.stringify({
                id: 'before-clear',
                method: 'GET',
                url: 'https://httpbin.org/get',
                browser: 'chrome',
            })}\n`
        );
        const r1 = await nextJson();
        expect(r1.statusCode).toBe(200);

        proc.stdin.write(`${JSON.stringify({ id: '__clear_sessions__' })}\n`);
        const cleared = await nextJson();
        expect(cleared.cleared).toBe(true);

        proc.stdin.write(
            `${JSON.stringify({
                id: 'after-clear',
                method: 'GET',
                url: 'https://httpbin.org/get',
                browser: 'chrome',
            })}\n`
        );
        const r2 = await nextJson();
        expect(r2.statusCode).toBe(200);

        proc.stdin.end();
        await new Promise((r, j) => {
            proc.once('exit', (c) => (c === 0 ? r() : j(new Error(`exit ${c}`))));
        });
        rl.close();
    });
});
