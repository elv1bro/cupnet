#!/usr/bin/env node
/**
 * Exact reproduction of CupNet's EOF bug — extended with concurrency + child-process tests.
 */
const AzureTLSClient = require('./azuretls/azureTLS');
const { spawn } = require('child_process');
const path = require('path');

const H2FP = '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p';
const URL_TARGET = 'https://practicetestautomation.com/practice-test-login/';
const URL_IPINFO = 'https://ipinfo.io/json';

const OH_TARGET = [
    ['Host', 'practicetestautomation.com'],
    ['Connection', 'keep-alive'],
    ['Cache-Control', 'max-age=0'],
    ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'],
    ['Accept-Encoding', 'gzip, deflate, br, zstd'],
    ['Accept-Language', 'ru'],
    ['Cookie', 'nfd-enable-cf-opt=63a6825d27cab0f204d3b602'],
    ['Sec-Fetch-Dest', 'document'],
    ['Sec-Fetch-Mode', 'navigate'],
    ['Sec-Fetch-Site', 'none'],
    ['Sec-Fetch-User', '?1'],
    ['Upgrade-Insecure-Requests', '1'],
    ['User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.210 Safari/537.36'],
];

const OH_SUBRESOURCE = [
    ['Host', 'practicetestautomation.com'],
    ['Connection', 'keep-alive'],
    ['Accept', '*/*'],
    ['Accept-Encoding', 'gzip, deflate, br, zstd'],
    ['Accept-Language', 'ru'],
    ['Referer', 'https://practicetestautomation.com/practice-test-login/'],
    ['Sec-Fetch-Dest', 'script'],
    ['Sec-Fetch-Mode', 'no-cors'],
    ['Sec-Fetch-Site', 'same-origin'],
    ['User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.210 Safari/537.36'],
];

function createClient() {
    const c = new AzureTLSClient({ browser: 'chrome', timeout: 30000 });
    c.applyHTTP2Fingerprint(H2FP);
    return c;
}

async function req(client, url, oh, label) {
    const t0 = Date.now();
    try {
        const res = await client.request({
            method: 'GET', url, maxRetries: 0,
            orderedHeaders: oh,
            disableRedirects: true, maxRedirects: 0,
        });
        const ms = Date.now() - t0;
        const ok = !res.error && res.statusCode > 0;
        console.log(`  [${label}] ${res.statusCode} ${ms}ms ${res.error || ''}`);
        return { ok, status: res.statusCode, ms };
    } catch (e) {
        const ms = Date.now() - t0;
        console.log(`  [${label}] ERROR ${ms}ms ${e.message}`);
        return { ok: false, error: e.message, ms };
    }
}

// ==================== TEST 6: TRUE CONCURRENCY on same Go session ====================
async function testConcurrency() {
    console.log('=== T6: TRUE CONCURRENCY — 6 parallel requests on SAME session ===');
    console.log('    (Chromium sends HTML + CSS + JS + images simultaneously)');
    const c = createClient();
    
    await req(c, URL_IPINFO, OH_TARGET, 'ipinfo-warmup');
    console.log('  (waiting 3s)');
    await new Promise(r => setTimeout(r, 3000));
    
    const urls = [
        URL_TARGET,
        'https://practicetestautomation.com/wp-content/themes/modern-store-modified/style.css',
        'https://practicetestautomation.com/wp-content/themes/modern-store-modified/js/build/production.min.js',
        'https://practicetestautomation.com/wp-content/themes/modern-store-modified/assets/font-awesome/css/all.min.css',
        'https://practicetestautomation.com/wp-includes/js/jquery/jquery.min.js',
        'https://practicetestautomation.com/wp-includes/js/jquery/jquery-migrate.min.js',
    ];
    
    const results = await Promise.all(urls.map((u, i) =>
        req(c, u, i === 0 ? OH_TARGET : OH_SUBRESOURCE, `concurrent-${i}`)
    ));
    
    const fails = results.filter(r => !r.ok).length;
    if (fails > 0) console.log(`  *** ${fails}/${urls.length} FAILED ***`);
    else console.log('  All OK');
    
    console.log('  (waiting 2s, then refresh)');
    await new Promise(r => setTimeout(r, 2000));
    
    const results2 = await Promise.all(urls.map((u, i) =>
        req(c, u, i === 0 ? OH_TARGET : OH_SUBRESOURCE, `concurrent2-${i}`)
    ));
    const fails2 = results2.filter(r => !r.ok).length;
    if (fails2 > 0) console.log(`  *** ${fails2}/${urls.length} FAILED ON REFRESH ***`);
    else console.log('  All OK (refresh)');
    
    c.close();
}

// ==================== TEST 7: Child process via pipes (like azure-tls-worker) ====================
async function testChildProcess() {
    console.log('\n=== T7: Child process via pipes (mimic azure-tls-worker.js) ===');
    
    return new Promise((resolve) => {
        const worker = spawn(process.execPath, [path.join(__dirname, '_debug_eof_child_worker.js')], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        
        let buf = '';
        let pending = new Map();
        let nextId = 1;
        
        worker.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line) continue;
                try {
                    const msg = JSON.parse(line);
                    const cb = pending.get(msg.id);
                    if (cb) { pending.delete(msg.id); cb(msg); }
                } catch (e) { /* stderr noise */ }
            }
        });
        
        function sendReq(url, oh, label) {
            return new Promise((res) => {
                const id = nextId++;
                const t0 = Date.now();
                pending.set(id, (msg) => {
                    const ms = Date.now() - t0;
                    const ok = !msg.error && msg.statusCode > 0;
                    console.log(`  [${label}] ${msg.statusCode || 0} ${ms}ms ${msg.error || ''}`);
                    res({ ok, status: msg.statusCode, ms, error: msg.error });
                });
                worker.stdin.write(JSON.stringify({
                    id, method: 'GET', url,
                    orderedHeaders: oh,
                    browser: 'chrome',
                    disableRedirects: true,
                }) + '\n');
            });
        }
        
        (async () => {
            await sendReq(URL_IPINFO, OH_TARGET, 'child-ipinfo');
            console.log('  (waiting 4s)');
            await new Promise(r => setTimeout(r, 4000));
            
            const r1 = await sendReq(URL_TARGET, OH_TARGET, 'child-target-1');
            console.log('  (waiting 1.5s)');
            await new Promise(r => setTimeout(r, 1500));
            const r2 = await sendReq(URL_TARGET, OH_TARGET, 'child-target-2');
            console.log('  (waiting 1.5s)');
            await new Promise(r => setTimeout(r, 1500));
            const r3 = await sendReq(URL_TARGET, OH_TARGET, 'child-target-3');
            
            if (!r1.ok || !r2.ok || !r3.ok) console.log('  *** EOF in child process ***');
            else console.log('  All OK via child process');
            
            // Concurrent in child
            console.log('  (concurrent burst via child)');
            const burst = await Promise.all([
                sendReq(URL_TARGET, OH_TARGET, 'child-burst-0'),
                sendReq(URL_TARGET, OH_SUBRESOURCE, 'child-burst-1'),
                sendReq(URL_TARGET, OH_SUBRESOURCE, 'child-burst-2'),
                sendReq(URL_TARGET, OH_SUBRESOURCE, 'child-burst-3'),
            ]);
            const burstFails = burst.filter(r => !r.ok).length;
            if (burstFails > 0) console.log(`  *** ${burstFails}/4 BURST FAILED ***`);
            else console.log('  Burst OK');
            
            worker.stdin.end();
            worker.on('exit', () => resolve());
        })();
    });
}

async function main() {
    await testConcurrency();
    await testChildProcess();
    console.log('\nDone');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
