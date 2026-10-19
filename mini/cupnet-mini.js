'use strict';

/**
 * CupNet mini CLI. Run through scripts/run-mini.cjs (`npm run mini -- …`) so better-sqlite3 loads
 * on the Electron Node ABI it was built for.
 *
 *   start [--chrome] [--url URL]   run the proxy + UI (default command)
 *   chrome [--url URL]             launch Chrome on the mini profile (proxy must be running)
 *   ca                             print CA path, SHA-256, SPKI and the OS trust commands
 *
 * Options: --data DIR  --port 8877  --ui-port 8878  --browser chrome_120  --upstream URL
 *          --trust spki|system  --chrome-bin PATH
 */

const { MiniApp } = require('./mini-app');

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

    if (cmd === 'chrome') {
        app.loadCa();
        const r = app.launchChrome(typeof a.url === 'string' ? a.url : undefined);
        if (!r.success) { console.error(r.error); process.exitCode = 1; return; }
        console.log(`Chrome started (pid ${r.pid}) on profile ${app.profileDir}`);
        return;
    }

    if (cmd !== 'start') {
        console.error(`Unknown command "${cmd}". Use start | chrome | ca.`);
        process.exitCode = 2;
        return;
    }

    await app.start();
    console.log(`CupNet mini — session ${app.log.sessionId}`);
    console.log(`  proxy:    http://127.0.0.1:${app.mitmPort}${app.upstream ? ' → upstream' : ' (direct)'}`);
    console.log(`  UI:       ${app.uiUrl}`);
    console.log(`  log file: ${app.log.file}`);
    console.log(`  trust:    ${app.trust}${app.trust === 'spki' ? ` (SPKI ${app.ca.spki})` : ''}`);
    if (a.chrome) {
        const r = app.launchChrome(typeof a.url === 'string' ? a.url : undefined);
        console.log(r.success ? `  chrome:   pid ${r.pid}` : `  chrome:   ${r.error}`);
    }

    let stopping = false;
    const shutdown = async () => {
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

module.exports = { parseArgs };
