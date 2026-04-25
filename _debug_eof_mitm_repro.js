#!/usr/bin/env node
const path = require('path');
const { execSync } = require('child_process');
process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1';

const { MitmProxy, generateCA } = require('./mitm-proxy');
const PORT = 18877;

function curlViaProxy(url) {
    try {
        const out = execSync(
            `curl -sk --max-time 10 -o /dev/null -w "%{http_code} %{time_total}" -x http://127.0.0.1:${PORT} "${url}"`,
            { encoding: 'utf8', timeout: 15000 }
        );
        return out.trim();
    } catch (e) {
        return 'ERROR: ' + (e.stderr || e.message).trim().slice(0, 120);
    }
}

async function main() {
    generateCA();
    const proxy = new MitmProxy({
        port: PORT, browser: 'chrome_120',
        workerPath: path.join(__dirname, 'azure-tls-worker.js'),
    });
    await proxy.start();
    console.log(`MITM on ${PORT}`);
    await new Promise(r => setTimeout(r, 1500));

    const URL_T = 'https://practicetestautomation.com/practice-test-login/';
    for (let i = 1; i <= 8; i++) {
        const res = curlViaProxy(URL_T);
        console.log(`[req${i}] ${res}`);
        if (i < 8) await new Promise(r => setTimeout(r, 1500));
    }
    console.log('Done');
    try { proxy.stop(); } catch {}
    setTimeout(() => process.exit(0), 500);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
