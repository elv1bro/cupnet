'use strict';

/**
 * Rebuild native addons (better-sqlite3) for the **installed Electron binary**, not for the
 * Node.js that runs `npm install`. That matters on macOS when the terminal/Node is x86_64
 * (Rosetta) but Electron is arm64 — otherwise dlopen fails at runtime.
 *
 * Skip: SKIP_ELECTRON_REBUILD=1
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

function getElectronArch() {
    let electronPath;
    try {
        electronPath = require('electron');
    } catch (e) {
        console.warn('[rebuild-electron-native] require("electron") failed:', e?.message || e);
        return process.arch;
    }
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const r = spawnSync(electronPath, ['-e', 'process.stdout.write(process.arch)'], {
        encoding: 'utf8',
        env,
        maxBuffer: 64,
        windowsHide: true,
    });
    const out = (r.stdout || '').trim();
    if (r.status !== 0 || !out) {
        console.warn('[rebuild-electron-native] electron arch probe failed (status=%s), using process.arch=%s',
            r.status, process.arch);
        return process.arch;
    }
    return out;
}

function main() {
    if (process.env.SKIP_ELECTRON_REBUILD === '1') {
        console.log('[rebuild-electron-native] skipped (SKIP_ELECTRON_REBUILD=1)');
        process.exit(0);
    }

    const arch = getElectronArch();
    console.log('[rebuild-electron-native] target arch (from Electron binary):', arch);

    // Use --only (-o), not --which (-w): -w still walks the tree and rebuilds matching native deps.
    const args = ['electron-rebuild', '-f', '-o', 'better-sqlite3', '--arch', arch];
    const r = spawnSync('npx', args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: process.env,
    });
    process.exit(r.status === null ? 1 : r.status);
}

main();
