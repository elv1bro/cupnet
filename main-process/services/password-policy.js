'use strict';

const fs = require('fs');
const path = require('path');

/** Minimum master/profile password length. */
const MIN_PASSWORD_LENGTH = 12;

const COMMON_PASSWORDS_PATH = path.join(__dirname, '../../data/common-passwords-10k.txt');

/** Fallback when data file is missing (dev/tests). */
const FALLBACK_COMMON_PASSWORDS = new Set([
    'password1234', 'password12345', 'qwerty123456', '123456789012',
    'letmein12345', 'welcome12345', 'admin1234567', 'cupnet123456',
]);

let _commonPasswords = null;

function loadCommonPasswords() {
    if (_commonPasswords) return _commonPasswords;
    _commonPasswords = new Set(FALLBACK_COMMON_PASSWORDS);
    try {
        if (fs.existsSync(COMMON_PASSWORDS_PATH)) {
            const text = fs.readFileSync(COMMON_PASSWORDS_PATH, 'utf8');
            for (const line of text.split(/\r?\n/)) {
                const pw = line.trim();
                if (pw) _commonPasswords.add(pw.toLowerCase());
            }
        }
    } catch {
        /* keep fallback only */
    }
    return _commonPasswords;
}

function validatePassword(password) {
    const pw = String(password || '');
    if (pw.length < MIN_PASSWORD_LENGTH) {
        return {
            ok: false,
            error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        };
    }
    if (loadCommonPasswords().has(pw.toLowerCase())) {
        return { ok: false, error: 'Password is too common; choose a stronger passphrase' };
    }
    return { ok: true };
}

/** @internal test helper */
function _resetCommonPasswordCacheForTests() {
    _commonPasswords = null;
}

module.exports = {
    MIN_PASSWORD_LENGTH,
    COMMON_PASSWORDS_PATH,
    validatePassword,
    loadCommonPasswords,
    _resetCommonPasswordCacheForTests,
};
