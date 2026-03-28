'use strict';

/**
 * electron-builder пересобирает нативные модули под Electron ABI.
 * azure-tls-worker запускается вложенным Node (cupnet-node) → нужен Node ABI.
 *
 * Собираем @2060.io/ref-napi и ffi-napi в корневом node_modules репозитория
 * (полные пакеты с binding.gyp) через bundled Node, затем копируем build/Release
 * в дерево сборки (app/ или app.asar.unpacked/ — зависит от asar).
 *
 * Env: CUPNET_SKIP_AFTERPACK_AZURETLS_NATIVE=1 — пропуск.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** electron-builder передаёт Arch как число или строку */
function resolveNpmArch(arch) {
    if (typeof arch === 'string' && ['x64', 'ia32', 'arm64', 'armv7l'].includes(arch)) return arch;
    const map = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: process.arch };
    const n = typeof arch === 'number' ? arch : NaN;
    if (Number.isFinite(n) && map[n]) return map[n];
    return process.env.npm_config_arch || process.arch;
}

function findAppBundle(appOutDir) {
    if (!fs.existsSync(appOutDir)) return null;
    const apps = fs.readdirSync(appOutDir).filter((f) => f.endsWith('.app'));
    return apps.length ? path.join(appOutDir, apps[0]) : null;
}

function appDirForPack(context) {
    const plat = context.electronPlatformName;
    const { appOutDir } = context;
    let resourcesDir;
    if (plat === 'darwin') {
        const app = findAppBundle(appOutDir);
        if (!app) throw new Error(`no .app in ${appOutDir}`);
        resourcesDir = path.join(app, 'Contents', 'Resources');
    } else {
        resourcesDir = path.join(appOutDir, 'resources');
    }

    const unpackedApp = path.join(resourcesDir, 'app.asar.unpacked');
    if (fs.existsSync(unpackedApp)) return { resourcesDir, appDir: unpackedApp };

    const plainApp = path.join(resourcesDir, 'app');
    if (fs.existsSync(plainApp)) return { resourcesDir, appDir: plainApp };

    throw new Error(`no app dir in ${resourcesDir}`);
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        const d = path.join(dest, name);
        if (fs.statSync(s).isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

module.exports = async function afterPackAzuretlsWorkerNative(context) {
    if (process.env.CUPNET_SKIP_AFTERPACK_AZURETLS_NATIVE === '1') {
        console.log('[after-pack-azuretls] skip (env)');
        return;
    }

    const plat = context.electronPlatformName;
    if (plat === 'win32' && process.platform !== 'win32') {
        console.warn('[after-pack-azuretls] skip: cross-compile Windows ffi');
        return;
    }

    let resourcesDir, appDir;
    try {
        ({ resourcesDir, appDir } = appDirForPack(context));
    } catch (e) {
        console.warn('[after-pack-azuretls]', e.message);
        return;
    }

    const destNm = path.join(appDir, 'node_modules');
    if (!fs.existsSync(destNm)) {
        console.warn('[after-pack-azuretls] missing', destNm);
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
        console.warn('[after-pack-azuretls] node-gyp not found, skip');
        return;
    }

    const slugs = ['ref-napi', 'ffi-napi'];
    const srcPkgs = slugs.map((s) => path.join(ROOT, 'node_modules', '@2060.io', s));
    const destPkgs = slugs.map((s) => path.join(destNm, '@2060.io', s));

    for (const p of [...srcPkgs, ...destPkgs]) {
        if (!fs.existsSync(p)) throw new Error(`[after-pack-azuretls] нет ${p}`);
    }

    const npmArch = resolveNpmArch(context.arch);
    console.log('[after-pack-azuretls] rebuilding @2060.io native for Node', bundledNode, 'arch', npmArch);

    for (let i = 0; i < slugs.length; i++) {
        const r = spawnSync(bundledNode, [nodeGyp, 'rebuild'], {
            cwd: srcPkgs[i],
            stdio: 'inherit',
            env: { ...process.env, npm_config_arch: npmArch },
        });
        if (r.status !== 0) {
            throw new Error(`node-gyp rebuild failed for @2060.io/${slugs[i]} (exit ${r.status})`);
        }

        const rel = path.join('build', 'Release');
        const from = path.join(srcPkgs[i], rel);
        if (!fs.existsSync(from)) throw new Error(`нет ${from} после node-gyp`);
        const to = path.join(destPkgs[i], rel);
        fs.mkdirSync(to, { recursive: true });
        copyDir(from, to);
        console.log('[after-pack-azuretls] copied', `@2060.io/${slugs[i]}/build/Release →`, path.relative(ROOT, to));
    }
};
