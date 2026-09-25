#!/usr/bin/env node
'use strict';

// Compare the TLS / HTTP-2 fingerprint our MITM + Go AzureTLS worker presents with the one a real, locally
// installed Chrome presents — both measured by https://tls.peet.ws/api/all. No Electron, no window: the
// worker is driven through a standalone MitmProxy, Chrome runs with --headless=new.
//
// Usage:
//   node scripts/tls-fingerprint-compare.mjs [--template chrome-mac] [--chrome "<path to Chrome binary>"] [--no-chrome] [--json]
//
// Why: identity templates claim a Chrome major, but the worker's ClientHello comes from the azuretls-client
// preset; this shows exactly where they differ (extensions, signature schemes, ciphers, groups, HTTP/2).
// Re-run after every Electron / azuretls bump — see docs/ai/PRODUCTION_PLAN.md "Electron/Chromium upgrade
// cadence" and docs/ai/BROWSER_IDENTITY_STATUS.md §4 (2). Needs network.

import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1'; // Go child worker, no ffi in-process

const PEET = 'https://tls.peet.ws/api/all';
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const TEMPLATE = opt('--template', 'chrome-mac');
const NO_CHROME = args.includes('--no-chrome');
const AS_JSON = args.includes('--json');
const CHROME = opt('--chrome', process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : '/usr/bin/google-chrome');

const hardTimeout = setTimeout(() => { console.error('HARD-TIMEOUT (120s)'); process.exit(2); }, 120_000);
hardTimeout.unref();

/** GET `targetUrl` through the local MITM (CONNECT + TLS), resolving once the body is complete (keep-alive safe). */
function fetchViaProxy(proxyPort, targetUrl, ua, timeoutMs = 40_000) {
    return new Promise((resolve) => {
        const u = new URL(targetUrl);
        const sock = net.connect(proxyPort, '127.0.0.1');
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; try { sock.destroy(); } catch {} resolve(v); } };
        const timer = setTimeout(() => done({ error: 'timeout' }), timeoutMs);
        sock.on('error', (e) => done({ error: `tcp:${e.message}` }));
        sock.once('connect', () => sock.write(`CONNECT ${u.hostname}:443 HTTP/1.1\r\nHost: ${u.hostname}:443\r\n\r\n`));
        let connectBuf = '';
        const onConnect = (chunk) => {
            connectBuf += chunk.toString('latin1');
            if (!connectBuf.includes('\r\n\r\n')) return;
            sock.removeListener('data', onConnect);
            const statusLine = connectBuf.split('\r\n')[0];
            if (!/ 200 /.test(statusLine)) return done({ error: `connect:${statusLine}` });
            const ts = tls.connect({ socket: sock, servername: u.hostname, rejectUnauthorized: false }, () => {
                ts.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: ${ua}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
            });
            let buf = '';
            const finish = () => {
                clearTimeout(timer);
                const i = buf.indexOf('\r\n\r\n');
                const head = i >= 0 ? buf.slice(0, i).toLowerCase() : '';
                let body = i >= 0 ? buf.slice(i + 4) : '';
                if (/transfer-encoding: *chunked/.test(head)) body = decodeChunked(body);
                done({ status: Number((buf.match(/^HTTP\/\d\.\d (\d+)/) || [])[1] || 0), body });
            };
            ts.on('data', (d) => {
                buf += d.toString('utf8');
                const i = buf.indexOf('\r\n\r\n');
                if (i < 0) return;
                const head = buf.slice(0, i).toLowerCase();
                const body = buf.slice(i + 4);
                const cl = head.match(/content-length: *(\d+)/);
                if (cl && body.length >= Number(cl[1])) finish();
                else if (/transfer-encoding: *chunked/.test(head) && /\r\n0\r\n\r\n$/.test(buf)) finish();
            });
            ts.on('error', (e) => done({ error: `tls:${e.message}` }));
            ts.on('end', finish);
            ts.on('close', finish);
        };
        sock.on('data', onConnect);
    });
}

/** Decode an HTTP/1.1 chunked body (sizes in hex, optional chunk extensions ignored). */
function decodeChunked(body) {
    let out = '';
    let i = 0;
    while (i < body.length) {
        const j = body.indexOf('\r\n', i);
        if (j < 0) break;
        const size = parseInt(body.slice(i, j).split(';')[0], 16);
        if (!size) break;
        out += body.slice(j + 2, j + 2 + size);
        i = j + 2 + size + 2;
    }
    return out;
}

function parseJsonLoose(text) {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

async function measureWorker() {
    const { MitmProxy, generateCAAsync } = require(path.join(root, 'mitm-proxy.js'));
    const catalog = require(path.join(root, 'browser-identity-catalog.js'));
    await generateCAAsync();
    const identity = catalog.resolveIdentity({ mode: 'template', templateId: TEMPLATE });
    const mitm = new MitmProxy({ port: 0, browser: identity.tlsProfile || 'chrome' });
    await mitm.start();
    mitm.setIdentity(identity);
    try {
        const r = await fetchViaProxy(mitm._server.address().port, PEET, identity.userAgent);
        if (r.error) throw new Error(`worker fetch failed: ${r.error}`);
        return { label: `CupNet worker (template ${TEMPLATE}, tls profile ${identity.tlsProfile})`, data: parseJsonLoose(r.body) };
    } finally {
        mitm.stop();
    }
}

function measureChrome() {
    return new Promise((resolve) => {
        if (NO_CHROME || !fs.existsSync(CHROME)) return resolve(null);
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-tls-compare-'));
        const a = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--dump-dom', PEET];
        execFile(CHROME, a, { timeout: 60_000, maxBuffer: 4 << 20 }, (err, stdout) => {
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
            if (err && !stdout) return resolve({ error: err.message });
            try {
                const m = stdout.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
                const raw = (m ? m[1] : stdout).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                const data = parseJsonLoose(raw);
                let version = '';
                try { version = execFileSyncVersion(); } catch {}
                resolve({ label: `real Chrome${version ? ' ' + version : ''} (headless, ${path.basename(CHROME)})`, data });
            } catch (e) {
                resolve({ error: `parse: ${e.message}` });
            }
        });
    });
}

function execFileSyncVersion() {
    if (process.platform !== 'darwin') return '';
    const plist = path.join(path.dirname(path.dirname(CHROME)), 'Info.plist'); // <App>.app/Contents/Info.plist
    const s = fs.readFileSync(plist, 'utf8');
    const m = s.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1] : '';
}

function summarize(j) {
    const t = j.tls || {}; const h2 = j.http2 || {};
    const ext = (t.extensions || []).map((e) => e.name).filter((n) => !/GREASE/i.test(n));
    const sig = ((t.extensions || []).find((e) => /signature_algorithms \(13\)/.test(e.name)) || {}).signature_algorithms || [];
    const groups = ((t.extensions || []).find((e) => /supported_groups \(10\)/.test(e.name)) || {}).supported_groups || [];
    return {
        ja4: t.ja4, ja4_r: t.ja4_r, ja3_hash: t.ja3_hash, peetprint_hash: t.peetprint_hash,
        akamai: h2.akamai_fingerprint, akamai_hash: h2.akamai_fingerprint_hash,
        tls_version: t.tls_version_negotiated, ciphers: (t.ciphers || []).filter((c) => !/GREASE/i.test(c)),
        extensions_sorted: [...ext].sort(), sigalgs: sig.filter((s) => !/^0x([0-9a-f])a\1a$/i.test(s)), groups: groups.filter((g) => !/GREASE/i.test(g)),
    };
}

function diffLists(a, b) {
    const A = new Set(a), B = new Set(b);
    return { onlyInFirst: a.filter((x) => !B.has(x)), onlyInSecond: b.filter((x) => !A.has(x)) };
}

(async () => {
    const worker = await measureWorker();
    const chrome = await measureChrome();
    const w = summarize(worker.data);
    const out = { worker: { label: worker.label, ...w } };
    if (chrome && !chrome.error) {
        const c = summarize(chrome.data);
        out.chrome = { label: chrome.label, ...c };
        out.diff = {
            ja4_equal: w.ja4 === c.ja4,
            ja4_parts: { worker: (w.ja4 || '').split('_'), chrome: (c.ja4 || '').split('_') },
            akamai_equal: w.akamai === c.akamai,
            ciphers: diffLists(w.ciphers, c.ciphers),
            extensions: diffLists(w.extensions_sorted, c.extensions_sorted),
            sigalgs: diffLists(w.sigalgs, c.sigalgs),
            groups: diffLists(w.groups, c.groups),
        };
    } else if (chrome && chrome.error) {
        out.chrome = { error: chrome.error };
    } else {
        out.chrome = { skipped: NO_CHROME ? '--no-chrome' : `Chrome binary not found at ${CHROME} (use --chrome <path>)` };
    }
    if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
    else {
        const line = (k, v) => console.log(`  ${k.padEnd(14)} ${v ?? '-'}`);
        for (const side of ['worker', 'chrome']) {
            const s = out[side]; if (!s || s.error || s.skipped) { console.log(`== ${side}: ${s?.error || s?.skipped || 'n/a'}`); continue; }
            console.log(`== ${s.label}`);
            line('JA4', s.ja4); line('JA4_r', s.ja4_r); line('JA3 hash', s.ja3_hash); line('HTTP/2 akamai', `${s.akamai}  (${s.akamai_hash})`);
            line('sigalgs', s.sigalgs.join(' ')); line('groups', s.groups.join(' '));
        }
        if (out.diff) {
            const d = out.diff;
            console.log('== diff (worker vs chrome)');
            line('JA4 equal', d.ja4_equal); line('HTTP/2 equal', d.akamai_equal);
            for (const k of ['ciphers', 'extensions', 'sigalgs', 'groups']) {
                line(`${k} only-worker`, d[k].onlyInFirst.join(', ') || '(none)');
                line(`${k} only-chrome`, d[k].onlyInSecond.join(', ') || '(none)');
            }
        }
    }
    clearTimeout(hardTimeout);
    setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('FATAL', e?.stack || e?.message || e); process.exit(1); });
