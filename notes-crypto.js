'use strict';

const crypto = require('crypto');

const MAGIC_CN01 = Buffer.from([0x43, 0x4e, 0x30, 0x31]); // CN01 — scrypt(password)
const MAGIC_CN02 = Buffer.from([0x43, 0x4e, 0x30, 0x32]); // CN02 — master key
const VERSION = 1;

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

/** Legacy: scrypt(password) per note. */
function encryptNotePayload(jsonUtf8, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const { iv, tag, enc } = _encryptAesGcm(key, jsonUtf8);
    return Buffer.concat([MAGIC_CN01, Buffer.from([VERSION]), salt, iv, tag, enc]);
}

function decryptNotePayload(buf, password) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length < 4 + 1 + 16 + 12 + 16) {
        throw new Error('Invalid encrypted note');
    }
    if (buf.subarray(0, 4).equals(MAGIC_CN02)) {
        throw new Error('CN02 note requires master key');
    }
    if (!buf.subarray(0, 4).equals(MAGIC_CN01)) throw new Error('Invalid encrypted note');
    if (buf[4] !== VERSION) throw new Error('Unsupported note encryption version');
    const salt = buf.subarray(5, 21);
    const iv = buf.subarray(21, 33);
    const tag = buf.subarray(33, 49);
    const data = buf.subarray(49);
    const key = crypto.scryptSync(password, salt, 32);
    return _decryptAesGcm(key, iv, tag, data);
}

/** CV02-style: AES-GCM with pre-derived 32-byte vault master key. */
function encryptNotePayloadWithKey(jsonUtf8, masterKey) {
    if (!masterKey || masterKey.length !== 32) throw new Error('Invalid master key');
    const { iv, tag, enc } = _encryptAesGcm(masterKey, jsonUtf8);
    return Buffer.concat([MAGIC_CN02, Buffer.from([VERSION]), iv, tag, enc]);
}

function decryptNotePayloadWithKey(buf, masterKey, passwordFallback) {
    if (!buf || !Buffer.isBuffer(buf)) throw new Error('Invalid encrypted note');
    if (buf.subarray(0, 4).equals(MAGIC_CN02)) {
        if (buf[4] !== VERSION) throw new Error('Unsupported note encryption version');
        if (!masterKey || masterKey.length !== 32) throw new Error('Invalid master key');
        const iv = buf.subarray(5, 17);
        const tag = buf.subarray(17, 33);
        const data = buf.subarray(33);
        return _decryptAesGcm(masterKey, iv, tag, data);
    }
    if (passwordFallback) return decryptNotePayload(buf, passwordFallback);
    throw new Error('CN01 note requires password');
}

module.exports = {
    encryptNotePayload,
    decryptNotePayload,
    encryptNotePayloadWithKey,
    decryptNotePayloadWithKey,
};
