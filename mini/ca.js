'use strict';

/**
 * CupNet mini CA helpers.
 *
 * `caInstructions` prints the commands for the user to run by hand. `installCa` runs the same
 * command for them on a button click: it never changes trust silently — on macOS the OS raises its
 * own authorization dialog for the user's password, so the user still makes the trust decision.
 * `caTrustStatus` is a read-only probe of the OS store used to decide whether Chrome needs the
 * `--ignore-certificate-errors-spki-list` flag (and its warning banner) at all.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const CA_COMMON_NAME = 'CupNet MITM CA';

function _loginKeychain() {
    return path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

function _nssdb() {
    return `sql:${path.join(os.homedir(), '.pki', 'nssdb')}`;
}

/** Normalize a SHA-256 fingerprint (strip colons/spaces, lowercase) for comparison. */
function _normFp(s) {
    return String(s || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
}

/** Run a command without a shell; never throws. @returns {{ code:number, out:string, missing:boolean }} */
function _run(cmd, args, timeoutMs = 10000) {
    try {
        const out = execFileSync(cmd, args, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out: out.toString(), missing: false };
    } catch (e) {
        const out = `${e.stdout ? e.stdout.toString() : ''}${e.stderr ? e.stderr.toString() : ''}`;
        return { code: typeof e.status === 'number' ? e.status : 1, out, missing: e.code === 'ENOENT' };
    }
}

/** base64(SHA-256(SubjectPublicKeyInfo)) — the format of --ignore-certificate-errors-spki-list. */
function spkiHashFromCertPem(certPem) {
    const spkiDer = crypto.createPublicKey(certPem).export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(spkiDer).digest('base64');
}

function fingerprintSha256(certPem) {
    return new crypto.X509Certificate(certPem).fingerprint256;
}

/** OS commands to trust / untrust the CA (for `--trust system`). */
function caInstructions(certPath, platform = process.platform) {
    const q = JSON.stringify(certPath);
    if (platform === 'darwin') {
        return {
            install: `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ${q}`,
            remove: `security delete-certificate -c "CupNet MITM CA" ~/Library/Keychains/login.keychain-db`,
            verify: `security find-certificate -c "CupNet MITM CA" -Z ~/Library/Keychains/login.keychain-db`,
        };
    }
    if (platform === 'win32') {
        return {
            install: `certutil -user -addstore Root ${q}`,
            remove: 'certutil -user -delstore Root "CupNet MITM CA"',
            verify: 'certutil -user -store Root "CupNet MITM CA"',
        };
    }
    // Linux Chrome reads the NSS user DB, not the system bundle.
    return {
        install: `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "CupNet MITM CA" -i ${q}`,
        remove: 'certutil -d sql:$HOME/.pki/nssdb -D -n "CupNet MITM CA"',
        verify: 'certutil -d sql:$HOME/.pki/nssdb -L -n "CupNet MITM CA"',
    };
}

/**
 * Read-only probe of the OS trust store. Tells us whether Chrome can be launched without the
 * `--ignore-certificate-errors-spki-list` flag (which triggers a warning banner in Chrome).
 * `installed` = the CA cert is present in the store; `trusted` = it is trusted as a root.
 * `supported` = the required OS tooling is available (on Linux, NSS `certutil`).
 * @returns {{ platform:string, installed:boolean, trusted:boolean, supported:boolean, error?:string }}
 */
function caTrustStatus(certPath, platform = process.platform) {
    const res = { platform, installed: false, trusted: false, supported: true };
    let wantFp;
    try {
        wantFp = _normFp(fingerprintSha256(fs.readFileSync(certPath, 'utf8')));
    } catch {
        return { ...res, error: 'CA certificate not found' };
    }

    if (platform === 'darwin') {
        const found = _run('security', ['find-certificate', '-a', '-c', CA_COMMON_NAME, '-Z', _loginKeychain()]);
        const hashes = [...found.out.matchAll(/SHA-256 hash:\s*([0-9A-F]+)/gi)].map((m) => m[1].toLowerCase());
        res.installed = hashes.includes(wantFp);
        if (res.installed) {
            // verify-cert validates the cert against the user's trust settings; exit 0 == trusted root.
            res.trusted = _run('security', ['verify-cert', '-c', certPath, '-p', 'basic']).code === 0;
        }
        return res;
    }

    if (platform === 'win32') {
        const found = _run('certutil', ['-user', '-store', 'Root', CA_COMMON_NAME]);
        res.installed = found.code === 0 && _normFp(found.out).includes(wantFp);
        res.trusted = res.installed; // presence in the Root store means trusted
        return res;
    }

    // Linux: Chrome reads the per-user NSS DB, not the system bundle.
    const found = _run('certutil', ['-d', _nssdb(), '-L', '-n', CA_COMMON_NAME]);
    if (found.missing) return { ...res, supported: false, error: 'NSS certutil is not installed' };
    res.installed = found.code === 0;
    res.trusted = res.installed;
    return res;
}

/**
 * Install the CA into the OS trust store the way the user would by hand. This is invoked only from a
 * user button click; on macOS the `security` tool raises its own authorization dialog, so the user
 * confirms the trust decision with their password — the app never changes trust without that prompt.
 * @returns {Promise<{ ok:boolean, error?:string, missing?:boolean }>}
 */
function installCa(certPath, platform = process.platform) {
    let cmd, args;
    if (platform === 'darwin') {
        cmd = 'security';
        args = ['add-trusted-cert', '-r', 'trustRoot', '-k', _loginKeychain(), certPath];
    } else if (platform === 'win32') {
        cmd = 'certutil';
        args = ['-user', '-addstore', 'Root', certPath];
    } else {
        cmd = 'certutil';
        args = ['-d', _nssdb(), '-A', '-t', 'C,,', '-n', CA_COMMON_NAME, '-i', certPath];
    }
    return new Promise((resolve) => {
        // Generous timeout: the OS password dialog waits on the user.
        execFile(cmd, args, { timeout: 180000 }, (err, _stdout, stderr) => {
            if (!err) return resolve({ ok: true });
            if (err.code === 'ENOENT') {
                return resolve({ ok: false, missing: true, error: `${cmd} is not available on this system` });
            }
            const msg = String(stderr || err.message || '').trim();
            resolve({ ok: false, error: msg || 'Certificate install failed' });
        });
    });
}

module.exports = {
    spkiHashFromCertPem, fingerprintSha256, caInstructions, caTrustStatus, installCa, CA_COMMON_NAME,
};
