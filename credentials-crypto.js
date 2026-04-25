'use strict';

const crypto = require('crypto');

/** CupNet credentials vault field encryption (CV01) */
const MAGIC = Buffer.from([0x43, 0x56, 0x30, 0x31]); // CV01
const VERSION = 1;

const VAULT_MARKER = 'CUPNET_VAULT_OK';

/**
 * @param {string} plaintextUtf8
 * @param {string} masterPassword
 * @returns {Buffer}
 */
function encryptCredentialField(plaintextUtf8, masterPassword) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(masterPassword, salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plaintextUtf8 ?? ''), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, tag, enc]);
}

/**
 * @param {Buffer} buf
 * @param {string} masterPassword
 * @returns {string}
 */
function decryptCredentialField(buf, masterPassword) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length < 4 + 1 + 16 + 12 + 16) {
        throw new Error('Invalid encrypted credential field');
    }
    if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Invalid encrypted credential field');
    if (buf[4] !== VERSION) throw new Error('Unsupported credential encryption version');
    const salt = buf.subarray(5, 21);
    const iv = buf.subarray(21, 33);
    const tag = buf.subarray(33, 49);
    const data = buf.subarray(49);
    const key = crypto.scryptSync(masterPassword, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * @param {string} masterPassword
 * @returns {Buffer}
 */
function createVaultVerifyBlob(masterPassword) {
    return encryptCredentialField(VAULT_MARKER, masterPassword);
}

/**
 * @param {Buffer} verifyBlob
 * @param {string} masterPassword
 * @returns {boolean}
 */
function verifyVaultPassword(verifyBlob, masterPassword) {
    try {
        const plain = decryptCredentialField(verifyBlob, masterPassword);
        return plain === VAULT_MARKER;
    } catch {
        return false;
    }
}

module.exports = {
    encryptCredentialField,
    decryptCredentialField,
    createVaultVerifyBlob,
    verifyVaultPassword,
};
