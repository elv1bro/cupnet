'use strict';

// electron-builder afterPack hook: fail the build if the packaged app for this
// arch does not carry the AzureTLS Go worker binary it will look for at runtime.
//
// Why: the macOS DMG target builds both x64 and arm64. extraResources copies
// azuretls-go/bin/** into each, but if CI only built the runner-arch worker, the
// other arch's app ships WITHOUT a worker and every tab fails at MITM start with
// "Go worker required" (AUDIT A-045). This assert turns that silent, ship-it bug
// into a hard build failure, for CI and local `npm run dist:mac` alike.
//
// Binary names mirror mitm-proxy.js `_goWorkerBinaryName` — keep in sync.

const fs = require('fs');
const path = require('path');

// electron-builder Arch enum (builder-util): ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
const ARCH_NAME = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function workerNameFor(platform, archName) {
    if (platform === 'darwin') {
        return archName === 'arm64' ? 'azuretls-worker-darwin-arm64' : 'azuretls-worker-darwin-amd64';
    }
    if (platform === 'linux') {
        return archName === 'arm64' ? 'azuretls-worker-linux-arm64' : 'azuretls-worker-linux-amd64';
    }
    if (platform === 'win32') {
        return 'azuretls-worker-win32-amd64.exe';
    }
    return null;
}

/** Locates the Resources dir that holds extraResources, per platform. */
function resourcesDir(platform, appOutDir) {
    if (platform === 'darwin') {
        // <appOutDir>/<Product>.app/Contents/Resources
        let appBundle = null;
        try {
            appBundle = fs.readdirSync(appOutDir).find((n) => n.endsWith('.app'));
        } catch { /* ignore */ }
        if (!appBundle) return null;
        return path.join(appOutDir, appBundle, 'Contents', 'Resources');
    }
    // win32 / linux: <appOutDir>/resources
    return path.join(appOutDir, 'resources');
}

module.exports = async function afterPack(context) {
    const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'
    const archName = ARCH_NAME[context.arch] ?? String(context.arch);

    // Universal builds carry both arch slices; the thin binaries are verified on
    // their own passes, so skip the merged one.
    if (archName === 'universal') return;

    const name = workerNameFor(platform, archName);
    if (!name) {
        throw new Error(`[after-pack] Unsupported platform/arch for the Go worker: ${platform}/${archName}`);
    }

    const resDir = resourcesDir(platform, context.appOutDir);
    if (!resDir) {
        throw new Error(`[after-pack] Could not locate the Resources dir in ${context.appOutDir}`);
    }

    const binPath = path.join(resDir, 'azuretls-go', 'bin', name);
    if (!fs.existsSync(binPath)) {
        throw new Error(
            `[after-pack] Missing AzureTLS Go worker for ${platform}/${archName}: ` +
            `expected ${binPath}. Build it before packaging ` +
            `(macOS release needs BOTH darwin arches — run azuretls-go/build.sh or build both GOARCHs). ` +
            `Without it, MITM never starts on ${archName} and every tab fails (A-045).`
        );
    }

    // Must be a real, non-empty executable, not a stray 0-byte file.
    const st = fs.statSync(binPath);
    if (!st.isFile() || st.size === 0) {
        throw new Error(`[after-pack] Go worker ${binPath} is empty or not a file (size=${st.size}).`);
    }

    console.log(`[after-pack] OK: ${platform}/${archName} ships ${name} (${st.size} bytes).`);
};
