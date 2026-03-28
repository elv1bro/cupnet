'use strict';

/**
 * electron-builder пересобирает нативные модули под **Electron**; azure-tls-worker
 * запускается вложенным **Node** (cupnet-node) и ждёт .node под тот ABI.
 * После упаковки пересобираем только @2060.io/* в app.asar.unpacked выбранным Node.
 *
 * Env: CUPNET_SKIP_AFTERPACK_AZURETLS_NATIVE=1 — пропуск.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function findAppBundle(appOutDir) {
    if (!fs.existsSync(appOutDir)) return null;
    const apps = fs.readdirSync(appOutDir).filter((f) => f.endsWith('.app'));
    return apps.length ? path.join(appOutDir, apps[0]) : null;
}

function resourcesDirForPack(context) {
    const plat = context.electronPlatformName;
    const { appOutDir } = context;
    if (plat === 'darwin') {
        const app = findAppBundle(appOutDir);
        if (!app) throw new Error(`no .app in ${appOutDir}`);
        return path.join(app, 'Contents', 'Resources');
    }
    return path.join(appOutDir, 'resources');
}

module.exports = async function afterPackAzuretlsWorkerNative(context) {
    if (process.env.CUPNET_SKIP_AFTERPACK_AZURETLS_NATIVE === '1') {
        console.log('[after-pack-azuretls] skip (CUPNET_SKIP_AFTERPACK_AZURETLS_NATIVE=1)');
        return;
    }

    const plat = context.electronPlatformName;

    if (plat === 'win32' && process.platform !== 'win32') {
        console.warn('[after-pack-azuretls] skip: Windows target on non-Windows host (ffi rebuild needs Windows)');
        return;
    }

    let resourcesDir;
    try {
        resourcesDir = resourcesDirForPack(context);
    } catch (e) {
        console.warn('[after-pack-azuretls]', e.message || e);
        return;
    }

    const unpackedNm = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules');
    if (!fs.existsSync(unpackedNm)) {
        console.warn('[after-pack-azuretls] missing', unpackedNm);
        return;
    }

    const nodeName = plat === 'win32' ? 'node.exe' : 'node';
    const bundledNode = path.join(resourcesDir, 'cupnet-node', nodeName);
    if (!fs.existsSync(bundledNode)) {
        console.warn('[after-pack-azuretls] no bundled node:', bundledNode);
        return;
    }

    const nodeGyp = path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
    if (!fs.existsSync(nodeGyp)) {
        console.warn('[after-pack-azuretls] node-gyp not found under repo (npm install), skip');
        return;
    }

    const pkgs = [
        path.join(unpackedNm, '@2060.io', 'ref-napi'),
        path.join(unpackedNm, '@2060.io', 'ffi-napi'),
    ].filter((p) => fs.existsSync(p));

    if (!pkgs.length) {
        console.warn('[after-pack-azuretls] no @2060.io ref-napi/ffi-napi in unpacked tree');
        return;
    }

    const arch = context.arch || process.env.npm_config_arch || process.arch;
    console.log('[after-pack-azuretls] node-gyp rebuild for worker via', bundledNode, `(arch ${arch})`);

    for (const dir of pkgs) {
        const r = spawnSync(
            bundledNode,
            [nodeGyp, 'rebuild'],
            {
                cwd: dir,
                stdio: 'inherit',
                env: {
                    ...process.env,
                    npm_config_arch: arch,
                },
            },
        );
        if (r.status !== 0) {
            throw new Error(`node-gyp rebuild failed in ${path.relative(ROOT, dir)} (exit ${r.status})`);
        }
    }
};
