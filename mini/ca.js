'use strict';

/**
 * CupNet mini CA helpers. The agent/app never edits the OS trust store itself: `caInstructions`
 * prints the commands for the user to run (they need the user's password anyway).
 */

const crypto = require('crypto');

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

module.exports = { spkiHashFromCertPem, fingerprintSha256, caInstructions };
