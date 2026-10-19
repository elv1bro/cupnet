#!/usr/bin/env node
'use strict';

/**
 * Pack CupNet mini as a standalone project, independent of the Electron app:
 *
 *   dist/cupnet-mini/                 (--dir, or any non-macOS host)
 *   dist/CupNet mini.app/             (macOS; the same tree lives in Contents/Resources/cupnet-mini)
 *     cupnet-mini, cupnet-mini.cmd    CLI launchers (bundled Node, else `node` on PATH)
 *     runtime/node                    this Node binary (skip with --no-node)
 *     app/                            only the files mini requires (walked from mini/cupnet-mini.js),
 *                                     mini/ itself, azuretls-go/bin/<worker> and a package.json
 *
 * No node_modules: mini uses Node built-ins only. db.js (better-sqlite3/Electron) is left out — mini
 * injects its JSON rule store into request-interceptor.js.
 *
 *   node scripts/pack-mini.cjs [--out DIR] [--dir] [--no-node] [--all-platforms]
 */

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'mini', 'cupnet-mini.js');
/** Required only behind Electron guards or lazily (never on mini's path). */
const OPTIONAL_PACKAGES = new Set(['electron', 'better-sqlite3']);
const EXCLUDE = new Set(['db.js']);

function parseArgs(argv) {
    const o = { out: path.join(ROOT, 'dist'), dir: false, node: true, allPlatforms: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') o.out = path.resolve(argv[++i]);
        else if (a === '--dir') o.dir = true;
        else if (a === '--no-node') o.node = false;
        else if (a === '--all-platforms') o.allPlatforms = true;
        else throw new Error(`Unknown option: ${a}`);
    }
    return o;
}

/** Static require() walk: repo-relative files + external packages. */
function walkRequires(entry) {
    const builtin = new Set(builtinModules);
    const files = new Set();
    const packages = new Map();
    const visit = (file) => {
        if (files.has(file)) return;
        files.add(file);
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/require\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
            const spec = m[2];
            if (spec.startsWith('.')) {
                const base = path.resolve(path.dirname(file), spec);
                const hit = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]
                    .find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
                if (!hit) throw new Error(`${path.relative(ROOT, file)}: cannot resolve ${spec}`);
                if (hit.endsWith('.js')) visit(hit); else files.add(hit);
                continue;
            }
            if (spec.startsWith('node:') || builtin.has(spec) || builtin.has(spec.split('/')[0])) continue;
            const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
            if (!packages.has(name)) packages.set(name, new Set());
            packages.get(name).add(path.relative(ROOT, file));
        }
    };
    visit(entry);
    return { files: [...files].map((f) => path.relative(ROOT, f)), packages };
}

function workerName(platform = process.platform, arch = process.arch) {
    if (platform === 'darwin') return arch === 'arm64' ? 'azuretls-worker-darwin-arm64' : 'azuretls-worker-darwin-amd64';
    if (platform === 'linux') return arch === 'arm64' ? 'azuretls-worker-linux-arm64' : 'azuretls-worker-linux-amd64';
    if (platform === 'win32') return 'azuretls-worker-win32-amd64.exe';
    return null;
}

function copy(src, dst, mode) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst); // follows symlinks (azuretls-go/bin in worktrees)
    if (mode) fs.chmodSync(dst, mode);
}

function write(dst, text, mode) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, text);
    if (mode) fs.chmodSync(dst, mode);
}

const SH_LAUNCHER = `#!/bin/sh
# CupNet mini CLI: bundled Node when present, else node on PATH. See app/mini/README.md.
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$HERE/runtime/node"
if [ ! -x "$NODE" ]; then
    NODE="$(command -v node)" || { echo "CupNet mini: Node.js >= 20 is required (not found on PATH)." >&2; exit 1; }
fi
exec "$NODE" "$HERE/app/mini/cupnet-mini.js" "$@"
`;

const CMD_LAUNCHER = `@echo off\r
rem CupNet mini CLI: bundled Node when present, else node on PATH.\r
set "HERE=%~dp0"\r
set "NODE=%HERE%runtime\\node.exe"\r
if not exist "%NODE%" set "NODE=node"\r
"%NODE%" "%HERE%app\\mini\\cupnet-mini.js" %*\r
`;

/** macOS bundle executable: start mini with its window; a second launch only opens another window. */
const APP_EXEC = `#!/bin/sh
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
DATA="\${CUPNET_MINI_DIR:-$HOME/.cupnet-mini}"
mkdir -p "$DATA" && chmod 700 "$DATA"
exec "$RES/cupnet-mini/cupnet-mini" start --window >>"$DATA/mini.log" 2>&1
`;

function infoPlist(version) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>CupNet mini</string>
    <key>CFBundleDisplayName</key><string>CupNet mini</string>
    <key>CFBundleIdentifier</key><string>dev.cupnet.mini</string>
    <key>CFBundleExecutable</key><string>CupNet mini</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${version}</string>
    <key>CFBundleVersion</key><string>${version}</string>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
    <!-- No Dock icon for the shell launcher: the UI is a Chrome app window; quit from its Quit button. -->
    <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

function pack(opts) {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const { files, packages } = walkRequires(ENTRY);
    for (const [name, from] of packages) {
        if (!OPTIONAL_PACKAGES.has(name)) throw new Error(`mini requires npm package "${name}" (${[...from].join(', ')}) — not packable without node_modules`);
    }

    const asApp = process.platform === 'darwin' && !opts.dir;
    const bundle = path.join(opts.out, asApp ? 'CupNet mini.app' : 'cupnet-mini');
    const base = asApp ? path.join(bundle, 'Contents', 'Resources', 'cupnet-mini') : bundle;
    fs.rmSync(bundle, { recursive: true, force: true });
    const app = path.join(base, 'app');

    // Code the walk found + the whole mini/ directory (ui.html, viewer.html, README).
    const copied = new Set();
    for (const rel of files) {
        if (EXCLUDE.has(rel)) continue;
        copy(path.join(ROOT, rel), path.join(app, rel));
        copied.add(rel);
    }
    for (const n of fs.readdirSync(path.join(ROOT, 'mini'))) {
        const rel = path.join('mini', n);
        if (!copied.has(rel) && fs.statSync(path.join(ROOT, rel)).isFile()) { copy(path.join(ROOT, rel), path.join(app, rel)); copied.add(rel); }
    }

    // Repo modules the UI loads in the browser (served by ui-server.js, never require()d by mini).
    const libs = JSON.parse(fs.readFileSync(path.join(ROOT, 'mini', 'browser-libs.json'), 'utf8'));
    for (const rel of Object.values(libs)) {
        if (!copied.has(rel)) { copy(path.join(ROOT, rel), path.join(app, rel)); copied.add(rel); }
    }

    // Go AzureTLS worker (mitm-proxy.js looks in <its dir>/azuretls-go/bin).
    const binDir = path.join(ROOT, 'azuretls-go', 'bin');
    const workers = opts.allPlatforms
        ? fs.readdirSync(binDir).filter((n) => n.startsWith('azuretls-worker-'))
        : [workerName()];
    for (const w of workers) {
        const src = path.join(binDir, w);
        if (!w || !fs.existsSync(src)) throw new Error(`Go worker ${w || '(unsupported platform)'} not found — run \`npm run build:go:local\``);
        copy(src, path.join(app, 'azuretls-go', 'bin', w), 0o755);
    }

    write(path.join(app, 'package.json'), `${JSON.stringify({
        name: 'cupnet-mini',
        version: rootPkg.version,
        private: true,
        description: 'CupNet mini: MITM proxy + AzureTLS worker for the real Google Chrome, no Electron.',
        main: 'mini/cupnet-mini.js',
        bin: { 'cupnet-mini': 'mini/cupnet-mini.js' },
        scripts: { start: 'node mini/cupnet-mini.js start --window' },
        engines: { node: '>=20' },
        license: rootPkg.license,
    }, null, 2)}\n`);

    let nodeVersion = null;
    if (opts.node) {
        copy(process.execPath, path.join(base, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), 0o755);
        nodeVersion = process.version;
    }
    write(path.join(base, 'cupnet-mini'), SH_LAUNCHER, 0o755);
    write(path.join(base, 'cupnet-mini.cmd'), CMD_LAUNCHER);

    if (asApp) {
        const contents = path.join(bundle, 'Contents');
        write(path.join(contents, 'Info.plist'), infoPlist(rootPkg.version));
        write(path.join(contents, 'MacOS', 'CupNet mini'), APP_EXEC, 0o755);
        const icns = path.join(ROOT, 'icons', 'icon.icns');
        if (fs.existsSync(icns)) copy(icns, path.join(contents, 'Resources', 'icon.icns'));
    }
    return { bundle, base, files: copied.size, workers, nodeVersion };
}

if (require.main === module) {
    try {
        const r = pack(parseArgs(process.argv.slice(2)));
        console.log(`CupNet mini packed → ${r.bundle}`);
        console.log(`  ${r.files} files, worker: ${r.workers.join(', ')}, node: ${r.nodeVersion || 'not bundled (uses PATH)'}`);
        console.log(`  CLI: "${path.join(r.base, 'cupnet-mini')}" start --window`);
    } catch (e) {
        console.error(`pack-mini: ${e.message}`);
        process.exit(1);
    }
}

module.exports = { pack, walkRequires, workerName };
