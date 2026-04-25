'use strict';

/**
 * Verify native addons load under the installed Electron binary; if not, run rebuild, then start the app.
 *
 * IMPORTANT: Do NOT pass --user-data-dir while ELECTRON_RUN_AS_NODE=1. In that mode Electron runs as
 * Node.js; unknown flags can make the process exit before -e runs (verify always failed).
 * Isolation from a running GUI instance is not needed for this short probe — RUN_AS_NODE does not
 * start the normal Electron app / single-instance GUI path.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

function getElectronPath() {
    try {
        return require('electron');
    } catch (e) {
        console.error('[start-force] require("electron") failed. Run npm install first.');
        console.error(e?.message || e);
        process.exit(1);
    }
}

/**
 * True if better-sqlite3 loads under Electron-as-Node (same arch as the GUI binary).
 * Must use cwd=project root: a script under /tmp cannot resolve `require('better-sqlite3')`
 * (Node walks up from the script path, not from cwd, for non-relative requires in a file).
 * With -e, resolution uses cwd — see Node "eval" wrapper behavior.
 */
function verifyBetterSqlite(electronPath) {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const r = spawnSync(
        electronPath,
        [
            '-e',
            "try { require('better-sqlite3'); process.exit(0); } catch (e) { console.error(e && e.stack ? e.stack : e); process.exit(1); }",
        ],
        {
            cwd: root,
            env,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        }
    );

    if (r.status !== 0) {
        const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
        if (out) console.error('[start-force] better-sqlite3 probe output:\n' + out);
        else console.error('[start-force] better-sqlite3 probe failed (exit %s, no output)', r.status);
    }

    return r.status === 0;
}

function rebuild() {
    return spawnSync(process.execPath, [path.join(__dirname, 'rebuild-electron-native.js')], {
        cwd: root,
        stdio: 'inherit',
    }).status === 0;
}

/** Same as manual `npm start` (see package.json "start"). */
function startApp() {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npmCmd, ['run', 'start'], {
        cwd: root,
        stdio: 'inherit',
        env,
        shell: process.platform === 'win32',
    });
    process.exit(r.status === null ? 1 : r.status);
}

function main() {
    const electronPath = getElectronPath();

    if (process.env.SKIP_START_FORCE_CHECK === '1') {
        console.log('[start-force] SKIP_START_FORCE_CHECK=1 — starting without verify');
        startApp();
        return;
    }

    if (!verifyBetterSqlite(electronPath)) {
        console.log('[start-force] Native module check failed; running rebuild…');
        if (!rebuild()) {
            console.error('[start-force] rebuild failed');
            process.exit(1);
        }
        if (!verifyBetterSqlite(electronPath)) {
            console.error('[start-force] better-sqlite3 still fails after rebuild');
            process.exit(1);
        }
    }

    console.log('[start-force] Starting app (npm run start)…');
    startApp();
}

main();
