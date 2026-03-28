'use strict';

/**
 * electron-builder пересобирает нативные модули под **Electron**; azure-tls-worker
 * запускается вложенным **Node** (cupnet-node) и ждёт .node под тот ABI.
 *
 * В app.asar.unpacked попадает урезанная копия пакетов (без binding.gyp), поэтому
 * node-gyp внутри .app падает. Собираем в корневом node_modules (полный npm-пакет),
 * затем копируем build/Release в дерево unpacked.
 *
 * Env: CUPNET_SKIP_AFTERPACK_AZURETLS_NATIVE=1 — пропуск.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** electron-builder передаёт Arch как число или строку */
function resolveNpmArch(arch) {
    if (arch === 'x64' || arch === 'ia32' || arch === 'arm64' || arch === 'armv7l' || arch === 'universal') {
        return arch === 'universal' ? process.arch : arch;
    }
    const n = typeof arch === 'number' ? arch : NaN;
    // builder-util Arch: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
    const map = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: process.arch };
    if (Number.isFinite(n) && map[n]) return map[n];
    return process.env.npm_config_arch || process.arch;
}

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

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        const d = path.join(dest, name);
        const st = fs.statSync(s);
        if (st.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

function copyReleaseIntoDest(srcPkg, destPkg) {
    const rel = path.join('build', 'Release');
    const from = path.join(srcPkg, rel);
    if (!fs.existsSync(from)) {
        throw new Error(`нет ${from} после node-gyp`);
    }
    const to = path.join(destPkg, rel);
    fs.mkdirSync(to, { recursive: true });
    copyDir(from, to);
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

    const slugPairs = [
        ['ref-napi', path.join(ROOT, 'node_modules', '@2060.io', 'ref-napi'), path.join(unpackedNm, '@2060.io', 'ref-napi')],
        ['ffi-napi', path.join(ROOT, 'node_modules', '@2060.io', 'ffi-napi'), path.join(unpackedNm, '@2060.io', 'ffi-napi')],
    ];

    for (const [, srcRoot, destRoot] of slugPairs) {
        if (!fs.existsSync(srcRoot)) throw new Error(`[after-pack-azuretls] нет ${srcRoot}`);
        if (!fs.existsSync(destRoot)) throw new Error(`[after-pack-azuretls] нет ${destRoot}`);
    }

    const npmArch = resolveNpmArch(context.arch);
    console.log('[after-pack-azuretls] node-gyp rebuild в repo node_modules, затем копия в .app; node=', bundledNode, 'arch=', npmArch);

    for (const [slug, srcRoot] of slugPairs) {
        const r = spawnSync(bundledNode, [nodeGyp, 'rebuild'], {
            cwd: srcRoot,
            stdio: 'inherit',
            env: {
                ...process.env,
                npm_config_arch: npmArch,
            },
        });
        if (r.status !== 0) {
            throw new Error(`node-gyp rebuild failed for @2060.io/${slug} (exit ${r.status})`);
        }
    }

    for (const [, srcRoot, destRoot] of slugPairs) {
        copyReleaseIntoDest(srcRoot, destRoot);
        console.log('[after-pack-azuretls] скопирован build/Release →', path.relative(ROOT, destRoot));
    }
};
