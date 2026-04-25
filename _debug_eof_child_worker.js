#!/usr/bin/env node
/**
 * Minimal child worker that mimics azure-tls-worker.js:
 * reads JSON lines from stdin, makes requests via AzureTLS FFI, writes JSON responses to stdout.
 */
const AzureTLSClient = require('./azuretls/azureTLS');
const readline = require('readline');

const H2FP = '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p';
const clients = new Map(); // poolKey → client

function getClient(browser) {
    const key = browser || 'chrome';
    if (clients.has(key)) return clients.get(key);
    const c = new AzureTLSClient({ browser: key, timeout: 30000 });
    c.applyHTTP2Fingerprint(H2FP);
    clients.set(key, c);
    return c;
}

function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    
    const { id, method, url, orderedHeaders, headers, browser, disableRedirects } = msg;
    const client = getClient(browser);
    
    try {
        const res = await client.request({
            method: method || 'GET',
            url,
            maxRetries: 0,
            orderedHeaders: orderedHeaders || undefined,
            headers: headers || undefined,
            disableRedirects: disableRedirects === true,
            maxRedirects: disableRedirects === true ? 0 : undefined,
        });
        send({
            id,
            statusCode: res.statusCode,
            error: res.error || null,
            bodyLen: res.bodyLength || 0,
        });
    } catch (e) {
        send({ id, statusCode: 0, error: e.message });
    }
});

rl.on('close', () => {
    for (const c of clients.values()) { try { c.close(); } catch {} }
    process.exit(0);
});
