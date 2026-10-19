'use strict';

/**
 * Launch the user's real Google Chrome wired to a CupNet External Proxy port.
 *
 * Why: some sites (commercial anti-bot challenges) will not render through the Electron engine like
 * real Chrome does. Instead of trying to defeat the check, hand the user their own Chrome — but route
 * it through CupNet's MITM (the External Proxy port) so the traffic is still captured/logged and uses
 * the same TLS profile as tabs. The launched Chrome uses a persistent, dedicated profile so the session
 * (cookies, logins) survives across launches — it is NOT a throwaway profile each time.
 *
 * Proxy auth: the External Proxy port accepts loopback (same-machine) clients without the Basic
 * password (see ExternalProxyPort._checkAuth) — Chrome cannot take proxy credentials on the command
 * line, and the port is bound to 127.0.0.1, so a local browser is trusted the same way a local curl is.
 * HTTPS is intercepted by CupNet's CA, which this dedicated profile is told to accept
 * (--ignore-certificate-errors, same posture as the panel's `curl -k` example) — scoped to this
 * analysis profile only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** Locate the installed Google Chrome binary for the current platform, or null. */
function findChromeBinary() {
    const candidates = [];
    if (process.platform === 'darwin') {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        candidates.push(path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
    } else if (process.platform === 'win32') {
        const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
        const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const local = process.env['LOCALAPPDATA'] || '';
        candidates.push(path.join(pf, 'Google/Chrome/Application/chrome.exe'));
        candidates.push(path.join(pf86, 'Google/Chrome/Application/chrome.exe'));
        if (local) candidates.push(path.join(local, 'Google/Chrome/Application/chrome.exe'));
    } else {
        candidates.push('/usr/bin/google-chrome');
        candidates.push('/usr/bin/google-chrome-stable');
        candidates.push('/opt/google/chrome/chrome');
        candidates.push('/usr/bin/chromium');
        candidates.push('/usr/bin/chromium-browser');
    }
    for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return null;
}

/**
 * Launch Chrome pointed at 127.0.0.1:<port> (a CupNet External Proxy port) with a persistent profile.
 * @param {object} opts
 * @param {number} opts.port                 - External Proxy TCP port (loopback; accepts loopback w/o auth)
 * @param {string} [opts.url]                - initial URL (default: about:blank)
 * @param {string} opts.userDataRoot         - app.getPath('userData')
 * @returns {{ success: boolean, error?: string, pid?: number }}
 */
function launchExternalChrome(opts = {}) {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { success: false, error: 'Invalid proxy port' };
    }
    const chrome = findChromeBinary();
    if (!chrome) {
        return { success: false, error: 'Google Chrome was not found on this computer. Install it, then try again.' };
    }
    const url = typeof opts.url === 'string' && /^https?:\/\//i.test(opts.url) ? opts.url : 'about:blank';

    // Persistent, dedicated profile so the session (cookies/logins) survives across launches.
    const baseDir = path.join(opts.userDataRoot || os.tmpdir(), 'external-browser');
    const profileDir = path.join(baseDir, `profile-${port}`);
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }

    const args = [
        `--user-data-dir=${profileDir}`,
        // Non-loopback traffic flows through CupNet's MITM; localhost keeps the default direct route so
        // the browser behaves normally on local dev sites.
        `--proxy-server=http://127.0.0.1:${port}`,
        // Trust CupNet's MITM CA for this analysis profile (same posture as the panel's `curl -k`).
        '--ignore-certificate-errors',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=ChromeWhatsNewUI',
        url,
    ];

    try {
        const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => { /* surfaced via the initial spawn throw where possible */ });
        child.unref();
        return { success: true, pid: child.pid };
    } catch (e) {
        return { success: false, error: e?.message || 'Failed to launch Chrome' };
    }
}

module.exports = { findChromeBinary, launchExternalChrome };
