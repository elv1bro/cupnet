'use strict';

/**
 * CupNet mini CLI (plain Node ≥ 20).
 *
 *   start [--window] [--chrome] [--url URL]
 *                                  run the proxy + UI (default command). --window opens the CupNet mini
 *                                  window (UI as a Chrome app window); if mini is already running it
 *                                  only opens another window. --chrome also launches the proxied Chrome.
 *   window                         open the CupNet mini window of a running instance
 *   chrome [--url URL]             launch Chrome on the mini profile (proxy must be running)
 *   ca                             print CA path, SHA-256, SPKI and the OS trust commands
 *   seal [SESSION_ID | --all]      encrypt saved session(s) → keys/<id>.cupkey + sealed/<id>.cupsess
 *   open KEYFILE [--sealed FILE]   decrypt a sealed session to stdout (JSONL)
 *
 * Options: --data DIR  --port 8877  --ui-port 8878  --browser chrome_120  --upstream URL
 *          --trust spki|system  --chrome-bin PATH
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { MiniApp } = require('./mini-app');
const { SessionLog } = require('./session-log');
const sessionCrypto = require('./session-crypto');

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const eq = a.indexOf('=');
        const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
        if (eq > 0) { out[key] = a.slice(eq + 1); continue; }
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    }
    return out;
}

/** POST/GET to a running instance's UI API with the token from <data>/ui-token. Resolves null when none answers. */
function callRunning(app, method, apiPath) {
    let token = '';
    try { token = fs.readFileSync(app.tokenFile, 'utf8').trim(); } catch { return Promise.resolve(null); }
    return new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1', port: app.uiPort, path: apiPath, method, timeout: 1500,
            headers: { 'X-CupNet-Token': token, 'Content-Type': 'application/json', 'Content-Length': 2 },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not ours */ }
                resolve(res.statusCode === 200 ? body : null);
            });
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null));
        req.end('{}');
    });
}

function appFromArgs(a) {
    return new MiniApp({
        dataDir: a.data,
        mitmPort: a.port,
        uiPort: a['ui-port'],
        browser: a.browser,
        upstream: a.upstream || process.env.CUPNET_MINI_UPSTREAM,
        trust: a.trust,
        chromeBinary: a['chrome-bin'],
    });
}

async function main() {
    const a = parseArgs(process.argv.slice(2));
    const cmd = a._[0] || 'start';
    const app = appFromArgs(a);

    if (cmd === 'ca') {
        const ca = app.loadCa();
        console.log(`CA certificate: ${ca.certPath}`);
        console.log(`SHA-256:        ${ca.sha256}`);
        console.log(`SPKI (base64):  ${ca.spki}`);
        console.log('\nOnly for --trust system — run these yourself:');
        console.log(`  install: ${ca.commands.install}`);
        console.log(`  remove:  ${ca.commands.remove}`);
        console.log(`  verify:  ${ca.commands.verify}`);
        return;
    }

    if (cmd === 'window') {
        const r = await callRunning(app, 'POST', '/api/window');
        if (!r) { console.error(`CupNet mini is not running on 127.0.0.1:${app.uiPort} (start it with: start --window)`); process.exitCode = 1; return; }
        if (!r.success) { console.error(r.error); process.exitCode = 1; }
        return;
    }

    if (cmd === 'chrome') {
        app.loadCa();
        const r = app.launchChrome(typeof a.url === 'string' ? a.url : undefined);
        if (!r.success) { console.error(r.error); process.exitCode = 1; return; }
        console.log(`Chrome started (pid ${r.pid}) on profile ${app.profileDir}`);
        return;
    }

    if (cmd === 'seal') {
        const ids = a.all ? SessionLog.listSessions(app.sessionsDir).map((s) => s.id) : [a._[1]];
        if (!ids[0]) { console.error('Usage: seal SESSION_ID | --all'); process.exitCode = 2; return; }
        for (const id of ids) {
            const r = app.sealSession(id);
            console.log(`${id}\n  key:    ${r.keyFile}\n  sealed: ${r.sealedFile}`);
        }
        return;
    }

    if (cmd === 'open') {
        const keyFile = a._[1];
        if (!keyFile) { console.error('Usage: open KEYFILE [--sealed FILE]'); process.exitCode = 2; return; }
        const k = sessionCrypto.readKeyFile(keyFile);
        // Default: <id>.cupsess next to the key file, else in <data>/sealed/.
        const sealed = typeof a.sealed === 'string' ? a.sealed
            : [path.join(path.dirname(keyFile), `${k.id}.cupsess`), path.join(app.sealedDir, `${k.id}.cupsess`)]
                .find((f) => fs.existsSync(f));
        if (!sealed) { console.error(`${k.id}.cupsess not found; pass --sealed FILE`); process.exitCode = 1; return; }
        process.stdout.write(sessionCrypto.openBuffer(fs.readFileSync(sealed), k));
        return;
    }

    if (cmd !== 'start') {
        console.error(`Unknown command "${cmd}". Use start | window | chrome | ca | seal | open.`);
        process.exitCode = 2;
        return;
    }

    // Already running (e.g. the app launcher clicked twice): just bring up another window.
    if (a.window && await callRunning(app, 'GET', '/api/status')) {
        const r = await callRunning(app, 'POST', '/api/window');
        console.log(r?.success ? 'CupNet mini is already running; opened its window.' : `CupNet mini is already running; window: ${r?.error || 'failed'}`);
        return;
    }

    let shutdown = null;
    app.onQuit = () => shutdown?.();
    await app.start();
    console.log(`CupNet mini — session ${app.log.sessionId}`);
    console.log(`  proxy:    http://127.0.0.1:${app.mitmPort}${app.upstream ? ' → upstream' : ' (direct)'}`);
    console.log(`  UI:       ${app.uiUrl}`);
    console.log(`  log file: ${app.log.file}`);
    console.log(`  key file: ${app.sessionKey.file} (sealed on stop → sealed/${app.sessionKey.id}.cupsess)`);
    console.log(`  trust:    ${app.trust}${app.trust === 'spki' ? ` (SPKI ${app.ca.spki})` : ''}`);
    if (app.rulesImported) console.log(`  rules:    imported ${app.rulesImported} from cupnet-mini.db into ${app.rulesFile}`);
    if (a.window) {
        const r = app.openWindow();
        console.log(r.success ? '  window:   opened' : `  window:   ${r.error}`);
    }
    if (a.chrome) {
        const r = app.launchChrome(typeof a.url === 'string' ? a.url : undefined);
        console.log(r.success ? `  chrome:   pid ${r.pid}` : `  chrome:   ${r.error}`);
    }

    let stopping = false;
    shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log('\nStopping…');
        const t = setTimeout(() => process.exit(0), 3000);
        t.unref();
        await app.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.stack || e);
        process.exit(1);
    });
}

module.exports = { parseArgs, callRunning };
