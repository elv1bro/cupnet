#!/usr/bin/env node
/**
 * Minimal reproduction of EOF bug with azureTLS + practicetestautomation.com
 *
 * Usage:  node _debug_eof_repro.js
 */

const AzureTLSClient = require('./azuretls/azureTLS');

const URL_TARGET = 'https://practicetestautomation.com/practice-test-login/';
const URL_CONTROL = 'https://httpbin.org/get';

async function makeRequest(client, url, label, opts = {}) {
    const t0 = Date.now();
    try {
        const res = await client.request({
            method: 'GET',
            url,
            maxRetries: 0,
            disableRedirects: true,
            maxRedirects: 0,
            forceHttp1: opts.forceHttp1 || false,
        });
        const ms = Date.now() - t0;
        console.log(`  [${label}] ${res.statusCode} ${ms}ms ${opts.forceHttp1 ? '(http1.1)' : '(h2)'}  url=${url}`);
        return { ok: true, status: res.statusCode, ms };
    } catch (e) {
        const ms = Date.now() - t0;
        console.log(`  [${label}] ERROR ${ms}ms ${opts.forceHttp1 ? '(http1.1)' : '(h2)'}  ${e.message}  url=${url}`);
        return { ok: false, error: e.message, ms };
    }
}

async function testScenario(name, fn) {
    console.log(`\n========== ${name} ==========`);
    await fn();
}

async function main() {
    console.log(`AzureTLS version: ${AzureTLSClient.getVersion()}`);
    console.log(`Target: ${URL_TARGET}`);
    console.log(`Control: ${URL_CONTROL}\n`);

    // ---- Test 1: Same session, sequential H2 requests ----
    await testScenario('T1: Same session, 5x H2 sequential', async () => {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        for (let i = 1; i <= 5; i++) {
            await makeRequest(c, URL_TARGET, `req${i}`);
        }
        c.close();
    });

    // ---- Test 2: Same session, sequential HTTP/1.1 requests ----
    await testScenario('T2: Same session, 5x HTTP/1.1 sequential', async () => {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        for (let i = 1; i <= 5; i++) {
            await makeRequest(c, URL_TARGET, `req${i}`, { forceHttp1: true });
        }
        c.close();
    });

    // ---- Test 3: New session per request, H2 ----
    await testScenario('T3: New session per request, H2', async () => {
        for (let i = 1; i <= 5; i++) {
            const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
            await makeRequest(c, URL_TARGET, `req${i}`);
            c.close();
        }
    });

    // ---- Test 4: New session per request, HTTP/1.1 ----
    await testScenario('T4: New session per request, HTTP/1.1', async () => {
        for (let i = 1; i <= 5; i++) {
            const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
            await makeRequest(c, URL_TARGET, `req${i}`, { forceHttp1: true });
            c.close();
        }
    });

    // ---- Test 5: H2 first, then after EOF try H1.1 on same session ----
    await testScenario('T5: H2 → EOF → H1.1 same session', async () => {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        const r1 = await makeRequest(c, URL_TARGET, 'h2-1');
        const r2 = await makeRequest(c, URL_TARGET, 'h2-2');
        if (!r2.ok) {
            console.log('  → switching to HTTP/1.1 on same session');
            await makeRequest(c, URL_TARGET, 'h1-retry', { forceHttp1: true });
        }
        c.close();
    });

    // ---- Test 6: H2 → EOF → close → new session H1.1 ----
    await testScenario('T6: H2 → EOF → new session H1.1', async () => {
        const c1 = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        const r1 = await makeRequest(c1, URL_TARGET, 'h2-1');
        const r2 = await makeRequest(c1, URL_TARGET, 'h2-2');
        c1.close();
        if (!r2.ok) {
            console.log('  → new session with HTTP/1.1');
            const c2 = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
            await makeRequest(c2, URL_TARGET, 'h1-new', { forceHttp1: true });
            c2.close();
        }
    });

    // ---- Test 7: Control — ipinfo works after EOF on target ----
    await testScenario('T7: target EOF → control site same session', async () => {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        await makeRequest(c, URL_TARGET, 'target-1');
        await makeRequest(c, URL_TARGET, 'target-2');
        await makeRequest(c, URL_CONTROL, 'control');
        c.close();
    });

    // ---- Test 8: CupNet pattern — 2 sessions, ipinfo first, then target ----
    await testScenario('T8: CupNet pattern — 2 sessions ipinfo → wait 4s → target', async () => {
        const c1 = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        const c2 = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        console.log('  Making parallel ipinfo requests...');
        await Promise.all([
            makeRequest(c1, 'https://ipinfo.io/json', 'c1-ipinfo'),
            makeRequest(c2, 'https://ipinfo.io/json', 'c2-ipinfo'),
        ]);
        console.log('  Waiting 4 seconds (simulating user navigation)...');
        await new Promise(r => setTimeout(r, 4000));
        console.log('  Now requesting target...');
        await makeRequest(c1, URL_TARGET, 'c1-target');
        await makeRequest(c1, URL_TARGET, 'c1-target-2');
        await makeRequest(c2, URL_TARGET, 'c2-target');
        c1.close();
        c2.close();
    });

    // ---- Test 9: 4 sessions concurrently (like CupNet pool), ipinfo → target ----
    await testScenario('T9: 4-session pool, ipinfo → target sequential', async () => {
        const pool = Array.from({ length: 4 }, () => new AzureTLSClient({ browser: 'chrome', timeout: 15000 }));
        await Promise.all(pool.map((c, i) => makeRequest(c, 'https://ipinfo.io/json', `s${i}-ipinfo`)));
        console.log('  Waiting 3 seconds...');
        await new Promise(r => setTimeout(r, 3000));
        for (let r = 0; r < 3; r++) {
            const c = pool[r % pool.length];
            await makeRequest(c, URL_TARGET, `round${r}-target`);
        }
        pool.forEach(c => c.close());
    });

    // ---- Test 10: Rapid sequential requests with short delays (like browser refresh) ----
    await testScenario('T10: Rapid reload simulation — 1s between full cycles', async () => {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        for (let cycle = 1; cycle <= 5; cycle++) {
            await makeRequest(c, URL_TARGET, `cycle${cycle}`);
            if (cycle < 5) await new Promise(r => setTimeout(r, 1000));
        }
        c.close();
    });

    // ---- Test 11: With Chromium-like headers (key difference from CupNet) ----
    await testScenario('T11: Chromium headers, same session, 5x H2', async () => {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        const chromeHeaders = {
            'host': 'practicetestautomation.com',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'max-age=0',
            'connection': 'keep-alive',
            'upgrade-insecure-requests': '1',
        };
        for (let i = 1; i <= 5; i++) {
            const t0 = Date.now();
            try {
                const res = await c.request({
                    method: 'GET', url: URL_TARGET, maxRetries: 0,
                    headers: chromeHeaders,
                    disableRedirects: true, maxRedirects: 0,
                });
                console.log(`  [req${i}] ${res.statusCode} ${Date.now()-t0}ms (h2+headers)`);
            } catch (e) {
                console.log(`  [req${i}] ERROR ${Date.now()-t0}ms ${e.message}`);
            }
        }
        c.close();
    });

    // ---- Test 12: With orderedHeaders (CupNet style) ----
    await testScenario('T12: orderedHeaders (CupNet style), same session, 5x H2', async () => {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        const ordered = [
            ['Host', 'practicetestautomation.com'],
            ['User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'],
            ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'],
            ['Accept-Encoding', 'gzip, deflate, br'],
            ['Accept-Language', 'en-US,en;q=0.9'],
            ['Cache-Control', 'max-age=0'],
            ['Connection', 'keep-alive'],
            ['Upgrade-Insecure-Requests', '1'],
        ];
        for (let i = 1; i <= 5; i++) {
            const t0 = Date.now();
            try {
                const res = await c.request({
                    method: 'GET', url: URL_TARGET, maxRetries: 0,
                    orderedHeaders: ordered,
                    disableRedirects: true, maxRedirects: 0,
                });
                console.log(`  [req${i}] ${res.statusCode} ${Date.now()-t0}ms (h2+ordered)`);
            } catch (e) {
                console.log(`  [req${i}] ERROR ${Date.now()-t0}ms ${e.message}`);
            }
        }
        c.close();
    });

    // ---- Test 13: Spawn actual worker process and communicate via pipes ----
    await testScenario('T13: Actual worker child process via pipes', async () => {
        const { spawn } = require('child_process');
        const workerPath = require('path').join(__dirname, 'azure-tls-worker.js');
        const proc = spawn(process.execPath, [workerPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });
        proc.stderr.on('data', d => process.stderr.write('[W] ' + d));
        let buf = '';
        const pending = new Map();
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', chunk => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === '__init__') { console.log('  Worker ready'); continue; }
                    const cb = pending.get(msg.id);
                    if (cb) { pending.delete(msg.id); cb(msg); }
                } catch {}
            }
        });
        await new Promise(r => setTimeout(r, 500));

        function workerRequest(id, opts) {
            return new Promise(resolve => {
                pending.set(id, resolve);
                const line = JSON.stringify({ id, ...opts }) + '\n';
                proc.stdin.write(line);
            });
        }

        for (let i = 1; i <= 5; i++) {
            const t0 = Date.now();
            const res = await workerRequest(`r${i}`, {
                method: 'GET',
                url: URL_TARGET,
                browser: 'chrome',
                maxRetries: 3,
                disableRedirects: true,
            });
            const ms = Date.now() - t0;
            if (res.error) {
                console.log(`  [r${i}] ERROR ${ms}ms ${res.error}`);
            } else {
                console.log(`  [r${i}] ${res.statusCode} ${ms}ms`);
            }
        }
        proc.stdin.end();
        proc.kill();
    });

    // ---- Test 14: Worker process — ipinfo first then target (CupNet exact pattern) ----
    await testScenario('T14: Worker process — ipinfo → 4s wait → target x3', async () => {
        const { spawn } = require('child_process');
        const workerPath = require('path').join(__dirname, 'azure-tls-worker.js');
        const proc = spawn(process.execPath, [workerPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });
        proc.stderr.on('data', d => process.stderr.write('[W] ' + d));
        let buf = '';
        const pending = new Map();
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', chunk => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === '__init__') continue;
                    const cb = pending.get(msg.id);
                    if (cb) { pending.delete(msg.id); cb(msg); }
                } catch {}
            }
        });
        await new Promise(r => setTimeout(r, 500));

        function workerRequest(id, opts) {
            return new Promise(resolve => {
                pending.set(id, resolve);
                proc.stdin.write(JSON.stringify({ id, ...opts }) + '\n');
            });
        }

        console.log('  ipinfo x2...');
        const [ip1, ip2] = await Promise.all([
            workerRequest('ip1', { method:'GET', url:'https://ipinfo.io/json', browser:'chrome', maxRetries:3, disableRedirects:true }),
            workerRequest('ip2', { method:'GET', url:'https://ipinfo.io/json', browser:'chrome', maxRetries:3, disableRedirects:true }),
        ]);
        console.log(`  ip1=${ip1.statusCode||ip1.error}  ip2=${ip2.statusCode||ip2.error}`);

        console.log('  Waiting 4 seconds...');
        await new Promise(r => setTimeout(r, 4000));

        for (let i = 1; i <= 3; i++) {
            const t0 = Date.now();
            const res = await workerRequest(`t${i}`, {
                method: 'GET', url: URL_TARGET, browser: 'chrome',
                maxRetries: 3, disableRedirects: true,
            });
            const ms = Date.now() - t0;
            console.log(`  [target${i}] ${res.error ? 'ERROR '+res.error : res.statusCode} ${ms}ms`);
        }
        proc.stdin.end();
        proc.kill();
    });

    console.log('\n========== DONE ==========\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
