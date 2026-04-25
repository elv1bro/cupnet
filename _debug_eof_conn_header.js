#!/usr/bin/env node
/**
 * Test: does "Connection: keep-alive" in orderedHeaders cause EOF on reuse?
 */
const AzureTLSClient = require('./azuretls/azureTLS');
const URL_T = 'https://practicetestautomation.com/practice-test-login/';
const URL_B = 'https://pixel.wp.com/g.gif?v=ext&blog=167878209&post=251&tz=-4&srv=practicetestautomation.com&j=1%3A14.5&host=practicetestautomation.com&ref=&fcp=0&rand=0.123';

const ORDERED_WITH_CONN = [
    ['Host', 'practicetestautomation.com'],
    ['Connection', 'keep-alive'],
    ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'],
    ['Accept-Encoding', 'gzip, deflate, br, zstd'],
    ['Accept-Language', 'ru'],
    ['Cookie', 'nfd-enable-cf-opt=63a6825d27cab0f204d3b602'],
    ['Sec-Fetch-Dest', 'document'],
    ['Sec-Fetch-Mode', 'navigate'],
];

const ORDERED_WITHOUT_CONN = ORDERED_WITH_CONN.filter(([k]) => k.toLowerCase() !== 'connection');

const ORDERED_B = [
    ['Host', 'pixel.wp.com'],
    ['Connection', 'keep-alive'],
    ['Accept', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'],
    ['Accept-Encoding', 'gzip, deflate, br, zstd'],
    ['Accept-Language', 'ru'],
    ['Referer', 'https://practicetestautomation.com/'],
    ['Sec-Fetch-Dest', 'image'],
    ['Sec-Fetch-Mode', 'no-cors'],
];

async function req(client, url, ordered, label) {
    const t0 = Date.now();
    try {
        const res = await client.request({
            method: 'GET', url, maxRetries: 0,
            orderedHeaders: ordered,
            disableRedirects: true, maxRedirects: 0,
        });
        console.log(`  [${label}] ${res.statusCode} ${Date.now()-t0}ms`);
        return true;
    } catch (e) {
        console.log(`  [${label}] ERROR ${Date.now()-t0}ms ${e.message}`);
        return false;
    }
}

async function main() {
    console.log('=== A: WITH Connection:keep-alive + interleave + 1s delay ===');
    {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        await req(c, URL_T, ORDERED_WITH_CONN, 'target-1');
        await req(c, URL_B, ORDERED_B, 'pixel');
        console.log('  (waiting 1s)');
        await new Promise(r => setTimeout(r, 1000));
        await req(c, URL_T, ORDERED_WITH_CONN, 'target-2');
        await req(c, URL_T, ORDERED_WITH_CONN, 'target-3');
        c.close();
    }

    console.log('\n=== B: WITHOUT Connection header + interleave + 1s delay ===');
    {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        await req(c, URL_T, ORDERED_WITHOUT_CONN, 'target-1');
        await req(c, URL_B, ORDERED_B.filter(([k]) => k.toLowerCase() !== 'connection'), 'pixel');
        console.log('  (waiting 1s)');
        await new Promise(r => setTimeout(r, 1000));
        await req(c, URL_T, ORDERED_WITHOUT_CONN, 'target-2');
        await req(c, URL_T, ORDERED_WITHOUT_CONN, 'target-3');
        c.close();
    }

    console.log('\n=== C: WITH Connection + no interleave + 2s delay ===');
    {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        await req(c, URL_T, ORDERED_WITH_CONN, 'target-1');
        console.log('  (waiting 2s)');
        await new Promise(r => setTimeout(r, 2000));
        await req(c, URL_T, ORDERED_WITH_CONN, 'target-2');
        c.close();
    }

    console.log('\n=== D: WITH Connection + no interleave + 5s delay ===');
    {
        const c = new AzureTLSClient({ browser: 'chrome', timeout: 15000 });
        await req(c, URL_T, ORDERED_WITH_CONN, 'target-1');
        console.log('  (waiting 5s)');
        await new Promise(r => setTimeout(r, 5000));
        await req(c, URL_T, ORDERED_WITH_CONN, 'target-2');
        c.close();
    }

    console.log('\nDone');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
