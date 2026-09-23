'use strict';

const crypto = require('crypto');

const MAGIC_CV01 = Buffer.from([0x43, 0x56, 0x30, 0x31]);
const MAGIC_CV02 = Buffer.from([0x43, 0x56, 0x30, 0x32]);
const VERSION_CV01 = 1;
const VERSION_CV02 = 2;
const VAULT_MARKER = 'CUPNET_VAULT_OK';

/** Argon2id params (OWASP moderate). */
const ARGON2_MEMORY = 65536;
const ARGON2_TIME = 3;
const ARGON2_PARALLELISM = 1;

let _argon2 = null;
try {
    _argon2 = require('argon2');
} catch {
    _argon2 = null;
}

function _deriveKeyScrypt(password, salt) {
    return crypto.scryptSync(String(password), salt, 32);
}

async function _deriveKeyArgon2id(password, salt) {
    if (!_argon2) return _deriveKeyScrypt(password, salt);
    const hash = await _argon2.hash(String(password), {
        type: _argon2.argon2id,
        memoryCost: ARGON2_MEMORY,
        timeCost: ARGON2_TIME,
        parallelism: ARGON2_PARALLELISM,
        salt,
        hashLength: 32,
        raw: true,
    });
    return Buffer.from(hash);
}

function deriveMasterKeySync(password, salt) {
    return _deriveKeyScrypt(password, salt);
}

async function deriveMasterKey(password, salt) {
    return _deriveKeyArgon2id(password, salt);
}

function _encryptAesGcm(key, plaintextUtf8) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plaintextUtf8 ?? ''), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv, tag, enc };
}

function _decryptAesGcm(key, iv, tag, data) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** CV01 — legacy per-field scrypt + AES-GCM. */
function encryptCredentialField(plaintextUtf8, masterPassword) {
    const salt = crypto.randomBytes(16);
    const key = _deriveKeyScrypt(masterPassword, salt);
    const { iv, tag, enc } = _encryptAesGcm(key, plaintextUtf8);
    return Buffer.concat([MAGIC_CV01, Buffer.from([VERSION_CV01]), salt, iv, tag, enc]);
}

function decryptCredentialField(buf, masterPassword) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length < 4 + 1 + 16 + 12 + 16) {
        throw new Error('Invalid encrypted credential field');
    }
    if (buf.subarray(0, 4).equals(MAGIC_CV02)) {
        return decryptCredentialFieldWithKey(buf, null, masterPassword);
    }
    if (!buf.subarray(0, 4).equals(MAGIC_CV01)) throw new Error('Invalid encrypted credential field');
    if (buf[4] !== VERSION_CV01) throw new Error('Unsupported credential encryption version');
    const salt = buf.subarray(5, 21);
    const iv = buf.subarray(21, 33);
    const tag = buf.subarray(33, 49);
    const data = buf.subarray(49);
    const key = _deriveKeyScrypt(masterPassword, salt);
    return _decryptAesGcm(key, iv, tag, data);
}

/** CV02 — AES-GCM with pre-derived 32-byte master key (no per-field KDF). */
function encryptCredentialFieldWithKey(plaintextUtf8, masterKey) {
    if (!masterKey || masterKey.length !== 32) throw new Error('Invalid master key');
    const { iv, tag, enc } = _encryptAesGcm(masterKey, plaintextUtf8);
    return Buffer.concat([MAGIC_CV02, Buffer.from([VERSION_CV02]), iv, tag, enc]);
}

function decryptCredentialFieldWithKey(buf, masterKey, masterPasswordFallback) {
    if (!buf || !Buffer.isBuffer(buf)) throw new Error('Invalid encrypted credential field');
    if (buf.subarray(0, 4).equals(MAGIC_CV01)) {
        if (!masterPasswordFallback) throw new Error('CV01 field requires password');
        return decryptCredentialField(buf, masterPasswordFallback);
    }
    if (!buf.subarray(0, 4).equals(MAGIC_CV02)) throw new Error('Invalid encrypted credential field');
    if (buf[4] !== VERSION_CV02) throw new Error('Unsupported credential encryption version');
    const iv = buf.subarray(5, 17);
    const tag = buf.subarray(17, 33);
    const data = buf.subarray(33);
    if (!masterKey || masterKey.length !== 32) throw new Error('Invalid master key');
    return _decryptAesGcm(masterKey, iv, tag, data);
}

function isCv02Blob(buf) {
    return buf && Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC_CV02);
}

async function createVaultVerifyBlob(masterPassword) {
    const salt = crypto.randomBytes(16);
    const key = await deriveMasterKey(masterPassword, salt);
    const { iv, tag, enc } = _encryptAesGcm(key, VAULT_MARKER);
    return Buffer.concat([MAGIC_CV02, Buffer.from([VERSION_CV02]), salt, iv, tag, enc]);
}

function createVaultVerifyBlobSync(masterPassword) {
    const salt = crypto.randomBytes(16);
    const key = deriveMasterKeySync(masterPassword, salt);
    const { iv, tag, enc } = _encryptAesGcm(key, VAULT_MARKER);
    return Buffer.concat([MAGIC_CV02, Buffer.from([VERSION_CV02]), salt, iv, tag, enc]);
}

async function verifyVaultPassword(verifyBlob, masterPassword) {
    if (!verifyBlob || !Buffer.isBuffer(verifyBlob)) return false;
    try {
        if (verifyBlob.subarray(0, 4).equals(MAGIC_CV02)) {
            const salt = verifyBlob.subarray(5, 21);
            const iv = verifyBlob.subarray(21, 33);
            const tag = verifyBlob.subarray(33, 49);
            const data = verifyBlob.subarray(49);
            const key = await deriveMasterKey(masterPassword, salt);
            return _decryptAesGcm(key, iv, tag, data) === VAULT_MARKER;
        }
        if (verifyBlob.subarray(0, 4).equals(MAGIC_CV01)) {
            return decryptCredentialField(verifyBlob, masterPassword) === VAULT_MARKER;
        }
    } catch {
        return false;
    }
    return false;
}

function verifyVaultPasswordSync(verifyBlob, masterPassword) {
    if (!verifyBlob || !Buffer.isBuffer(verifyBlob)) return false;
    try {
        if (verifyBlob.subarray(0, 4).equals(MAGIC_CV01)) {
            return decryptCredentialField(verifyBlob, masterPassword) === VAULT_MARKER;
        }
    } catch {
        return false;
    }
    return false;
}

async function deriveSessionKeyFromVerifyBlob(verifyBlob, masterPassword) {
    if (!verifyBlob || !Buffer.isBuffer(verifyBlob)) return null;
    const ok = await verifyVaultPassword(verifyBlob, masterPassword);
    if (!ok) return null;
    // Both CV01 and CV02 store their 16-byte salt at bytes 5..21. Deriving the
    // session key from the blob's embedded salt keeps the key deterministic across
    // unlocks; a random salt here would produce a fresh key every unlock and make
    // any field encrypted in the previous session permanently undecryptable.
    const salt = verifyBlob.subarray(5, 21);
    return deriveMasterKey(masterPassword, salt);
}

function encryptFieldForStorage(plaintextUtf8, masterKey, masterPasswordFallback) {
    if (masterKey && masterKey.length === 32) {
        return encryptCredentialFieldWithKey(plaintextUtf8, masterKey);
    }
    return encryptCredentialField(plaintextUtf8, masterPasswordFallback);
}

function decryptFieldFromStorage(buf, masterKey, masterPasswordFallback) {
    return decryptCredentialFieldWithKey(buf, masterKey, masterPasswordFallback);
}

module.exports = {
    encryptCredentialField,
    decryptCredentialField,
    encryptCredentialFieldWithKey,
    decryptCredentialFieldWithKey,
    createVaultVerifyBlob,
    createVaultVerifyBlobSync,
    verifyVaultPassword,
    verifyVaultPasswordSync,
    deriveMasterKey,
    deriveMasterKeySync,
    deriveSessionKeyFromVerifyBlob,
    encryptFieldForStorage,
    decryptFieldFromStorage,
    isCv02Blob,
    MAGIC_CV01,
    MAGIC_CV02,
};
