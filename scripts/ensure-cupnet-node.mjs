#!/usr/bin/env node
/**
 * Downloads a stock Node.js binary into resources/cupnet-node/ so the packaged
 * app can spawn azure-tls-worker.js with real Node (ffi-napi), not ELECTRON_RUN_AS_NODE.
 *
 * Env:
 *   CUPNET_BUNDLE_NODE_VERSION — default 22.14.0
 *   CUPNET_SKIP_BUNDLE_NODE=1 — no-op (for rare local experiments)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'resources', 'cupnet-node');
const TMP_ROOT = path.join(ROOT, 'resources', '.cupnet-node-tmp');
const NODE_VER = process.env.CUPNET_BUNDLE_NODE_VERSION || '22.14.0';

if (process.env.CUPNET_SKIP_BUNDLE_NODE === '1') {
    console.log('[cupnet-node] skip (CUPNET_SKIP_BUNDLE_NODE=1)');
    process.exit(0);
}

async function download(url, dest) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
}

function platformSpec() {
    const { platform, arch } = process;
    if (platform === 'darwin' && arch === 'arm64') return { key: 'darwin-arm64', ext: 'tar.gz' };
    if (platform === 'darwin' && arch === 'x64') return { key: 'darwin-x64', ext: 'tar.gz' };
    if (platform === 'linux' && arch === 'x64') return { key: 'linux-x64', ext: 'tar.xz' };
    if (platform === 'linux' && arch === 'arm64') return { key: 'linux-arm64', ext: 'tar.xz' };
    if (platform === 'win32' && arch === 'x64') return { key: 'win-x64', ext: 'zip' };
    if (platform === 'win32' && arch === 'arm64') return { key: 'win-arm64', ext: 'zip' };
    throw new Error(`[cupnet-node] unsupported ${platform} ${arch}`);
}

function rmRf(p) {
    try {
        fs.rmSync(p, { recursive: true, force: true });
    } catch { /* ignore */ }
}

async function main() {
    const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
    const target = path.join(OUT_DIR, nodeBin);
    const verFile = path.join(OUT_DIR, 'VERSION');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    if (fs.existsSync(verFile) && fs.existsSync(target)) {
        try {
            const v = fs.readFileSync(verFile, 'utf8').trim();
            if (v === NODE_VER) {
                console.log('[cupnet-node] reusing cached', NODE_VER, target);
                return;
            }
        } catch { /* refresh */ }
    }

    const { key, ext } = platformSpec();
    const base = `node-v${NODE_VER}-${key}`;
    const url = `https://nodejs.org/dist/v${NODE_VER}/${base}.${ext}`;

    rmRf(TMP_ROOT);
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const archive = path.join(TMP_ROOT, `bundle.${ext}`);

    console.log('[cupnet-node] fetching', url);
    await download(url, archive);

    if (ext === 'zip') {
        const ps = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${TMP_ROOT.replace(/'/g, "''")}' -Force`;
        const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
        if (r.status !== 0) throw new Error('Expand-Archive failed');
        const sub = path.join(TMP_ROOT, base);
        const src = path.join(sub, nodeBin);
        if (!fs.existsSync(src)) throw new Error(`missing ${src} after unzip`);
        fs.copyFileSync(src, target);
    } else {
        const tarArgs = ext === 'tar.gz'
            ? ['-xzf', archive, '-C', TMP_ROOT]
            : ['-xJf', archive, '-C', TMP_ROOT];
        const r = spawnSync('tar', tarArgs, { stdio: 'inherit' });
        if (r.error) throw r.error;
        if (r.status !== 0) throw new Error(`tar exit ${r.status}`);
        const sub = path.join(TMP_ROOT, base);
        const inner = path.join(sub, 'bin', nodeBin);
        if (!fs.existsSync(inner)) throw new Error(`missing ${inner}`);
        fs.copyFileSync(inner, target);
        try {
            fs.chmodSync(target, 0o755);
        } catch { /* windows */ }
    }

    fs.writeFileSync(verFile, NODE_VER + '\n', 'utf8');
    rmRf(TMP_ROOT);

    console.log('[cupnet-node] installed', NODE_VER, '→', target);
}

main().catch((e) => {
    console.error('[cupnet-node]', e.message || e);
    process.exit(1);
});
