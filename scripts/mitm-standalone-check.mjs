#!/usr/bin/env node
'use strict';

// Standalone MITM smoke test — NO Electron.
// Forces the child Go worker, starts MitmProxy on a test port, sends a real HTTPS
// request through it (manual CONNECT + TLS), then exercises stop()+start() (the
// exact lifecycle the "Restart MITM" button uses). Hard-exits so it can't hang.

import net from 'node:net';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1'; // force child worker (Go binary), no ffi in-process
process.env.CUPNET_DEBUG_MITM = process.env.CUPNET_DEBUG_MITM || '1';

const hardTimeout = setTimeout(() => {
    console.error('HARD-TIMEOUT (45s) — MITM standalone check did not finish');
    process.exit(2);
}, 45_000);
hardTimeout.unref();

const { MitmProxy, generateCAAsync } = require(path.join(root, 'mitm-proxy.js'));

const PORT = 18899;
const TARGETS = ['https://example.com/', 'https://ipinfo.io/json'];

/** Do a request through the local MITM proxy: TCP → CONNECT host:443 → TLS → GET. */
function fetchViaProxy(proxyPort, targetUrl, timeoutMs = 15_000) {
    return new Promise((resolve) => {
        const u = new URL(targetUrl);
        const host = u.hostname;
        const port = u.port || 443;
        const sock = net.connect(proxyPort, '127.0.0.1');
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; try { sock.destroy(); } catch {} resolve(v); } };
        const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);

        sock.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: `tcp:${e.message}` }); });
        sock.once('connect', () => {
            sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
        });

        let connectBuf = '';
        const onConnectData = (chunk) => {
            connectBuf += chunk.toString('latin1');
            if (!connectBuf.includes('\r\n\r\n')) return;
            sock.removeListener('data', onConnectData);
            const statusLine = connectBuf.split('\r\n')[0];
            if (!/ 200 /.test(statusLine)) { clearTimeout(timer); done({ ok: false, error: `connect:${statusLine}` }); return; }

            const tlsSock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
                tlsSock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: mitm-standalone-check\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
            });
            let respBuf = '';
            const finish = () => {
                clearTimeout(timer);
                const statusMatch = respBuf.match(/^HTTP\/\d\.\d (\d+)/);
                const status = statusMatch ? Number(statusMatch[1]) : 0;
                const bodyStart = respBuf.indexOf('\r\n\r\n');
                const body = bodyStart >= 0 ? respBuf.slice(bodyStart + 4) : '';
                done({ ok: status > 0, status, bodyLen: body.length, snippet: body.slice(0, 80).replace(/\s+/g, ' ') });
            };
            tlsSock.on('data', (d) => {
                respBuf += d.toString('utf8');
                // Resolve as soon as we have headers + a bit of body (avoid waiting for keep-alive close).
                const bodyStart = respBuf.indexOf('\r\n\r\n');
                if (bodyStart >= 0 && respBuf.length - (bodyStart + 4) >= 40) finish();
            });
            tlsSock.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: `tls:${e.message}` }); });
            tlsSock.on('end', finish);
            tlsSock.on('close', finish);
        };
        sock.on('data', onConnectData);
    });
}

async function startProxy() {
    const mitm = new MitmProxy({
        port: PORT,
        browser: 'chrome_120',
    });
    await mitm.start();
    return mitm;
}

async function main() {
    console.log('== MITM standalone check ==');
    await generateCAAsync();

    console.log('[1] starting MITM on port', PORT, '…');
    let mitm = await startProxy();
    console.log('    started, workerReady =', mitm.worker.ready);

    for (const t of TARGETS) {
        const r = await fetchViaProxy(PORT, t);
        console.log(`[req] ${t} ->`, JSON.stringify(r));
    }
    console.log('    stats:', JSON.stringify(mitm.getStats()));

    // Exercise restart lifecycle: stop() then start() a fresh instance on same port.
    console.log('[2] stop() + restart on same port (Restart-MITM lifecycle) …');
    mitm.stop();
    await new Promise((r) => setTimeout(r, 500));

    let restartErr = null;
    try {
        mitm = await startProxy();
    } catch (e) {
        restartErr = e.message;
    }
    if (restartErr) {
        console.log('    RESTART FAILED:', restartErr);
    } else {
        console.log('    restarted, workerReady =', mitm.worker.ready);
        const r = await fetchViaProxy(PORT, TARGETS[0]);
        console.log(`[req-after-restart] ${TARGETS[0]} ->`, JSON.stringify(r));
        console.log('    stats:', JSON.stringify(mitm.getStats()));
    }

    mitm.stop();
    clearTimeout(hardTimeout);
    const okStart = true;
    console.log('== DONE ==', restartErr ? 'RESTART_FAILED' : 'OK');
    setTimeout(() => process.exit(restartErr ? 1 : 0), 300);
}

main().catch((e) => {
    console.error('FATAL', e?.stack || e?.message || e);
    process.exit(1);
});
