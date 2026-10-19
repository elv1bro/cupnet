'use strict';

/**
 * Launch the user's real Google Chrome through CupNet mini.
 *
 * A dedicated, persistent profile (<dataDir>/chrome-profile) — never the user's everyday profile:
 *  - proxy: --proxy-server=http://127.0.0.1:<mitmPort> (localhost stays direct);
 *  - trust: `spki` (default) passes --ignore-certificate-errors-spki-list=<CupNet CA SPKI>; the MITM
 *    sends the CA in the chain, so only CupNet-signed certs are accepted and every other cert error
 *    still fails as usual. Chrome honours this flag only together with --user-data-dir.
 *    `system` passes nothing: the user installed the CA into the OS trust store (see ca.js);
 *  - WebRTC: profile preference webrtc.ip_handling_policy=disable_non_proxied_udp, so STUN cannot
 *    reveal the real IP around the proxy. Set as a pref (like the WebRTC policy extensions do), not
 *    as a --force-webrtc-ip-handling-policy switch.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { findChromeBinary } = require('../main-process/services/external-browser-launcher');

const WEBRTC_POLICY = 'disable_non_proxied_udp';

/** Merge CupNet's required prefs into <profile>/Default/Preferences (created before first launch). */
function ensureProfilePrefs(profileDir) {
    const defDir = path.join(profileDir, 'Default');
    const prefsFile = path.join(defDir, 'Preferences');
    fs.mkdirSync(defDir, { recursive: true, mode: 0o700 });
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) || {}; } catch { prefs = {}; }
    if (prefs.webrtc?.ip_handling_policy === WEBRTC_POLICY) return false;
    prefs.webrtc = { ...(prefs.webrtc || {}), ip_handling_policy: WEBRTC_POLICY };
    fs.writeFileSync(prefsFile, JSON.stringify(prefs), { mode: 0o600 });
    return true;
}

/**
 * Chrome command line for CupNet mini (exported for tests).
 * @param {{ mitmPort:number, profileDir:string, trust?:'spki'|'system', caSpki?:string, url?:string }} o
 */
function buildChromeArgs(o) {
    const args = [
        `--user-data-dir=${o.profileDir}`,
        `--proxy-server=http://127.0.0.1:${o.mitmPort}`,
        '--no-first-run',
        '--no-default-browser-check',
    ];
    if ((o.trust || 'spki') === 'spki') {
        if (!o.caSpki) throw new Error('caSpki is required for trust=spki');
        args.push(`--ignore-certificate-errors-spki-list=${o.caSpki}`);
    }
    if (o.url && /^https?:\/\//i.test(o.url)) args.push(o.url);
    return args;
}

/**
 * Chrome locks a profile to one process; a second launch with the same --user-data-dir just opens a
 * window in the running instance (and our flags are ignored there — they were applied at its start).
 * @returns {{ success:boolean, pid?:number, error?:string, binary?:string, args?:string[] }}
 */
function launchChrome(o) {
    const binary = o.binary || findChromeBinary();
    if (!binary) return { success: false, error: 'Google Chrome was not found. Install it or pass --chrome-bin <path>.' };
    try {
        ensureProfilePrefs(o.profileDir);
        const args = buildChromeArgs(o);
        const child = spawn(binary, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => { /* surfaced by the spawn throw where possible */ });
        child.unref();
        return { success: true, pid: child.pid, binary, args };
    } catch (e) {
        return { success: false, error: e?.message || String(e) };
    }
}

/** Command line for the CupNet mini window: the UI in a Chrome app window, on its own unproxied profile. */
function buildAppWindowArgs(o) {
    return [
        `--user-data-dir=${o.profileDir}`,
        `--app=${o.url}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1440,900',
    ];
}

/** @returns {{ success:boolean, pid?:number, error?:string }} */
function launchAppWindow(o) {
    const binary = o.binary || findChromeBinary();
    if (!binary) return { success: false, error: 'Google Chrome was not found. Install it or pass --chrome-bin <path>.' };
    try {
        fs.mkdirSync(o.profileDir, { recursive: true, mode: 0o700 });
        const child = spawn(binary, buildAppWindowArgs(o), { detached: true, stdio: 'ignore' });
        child.on('error', () => { /* surfaced by the spawn throw where possible */ });
        child.unref();
        return { success: true, pid: child.pid, binary };
    } catch (e) {
        return { success: false, error: e?.message || String(e) };
    }
}

module.exports = { buildChromeArgs, buildAppWindowArgs, ensureProfilePrefs, launchChrome, launchAppWindow, WEBRTC_POLICY };
