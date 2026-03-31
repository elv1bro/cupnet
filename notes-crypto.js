'use strict';

const crypto = require('crypto');

const MAGIC = Buffer.from([0x43, 0x4e, 0x30, 0x31]); // CN01
const VERSION = 1;

/**
 * @param {string} jsonUtf8
 * @param {string} password
 * @returns {Buffer}
 */
function encryptNotePayload(jsonUtf8, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(jsonUtf8, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, tag, enc]);
}

/**
 * @param {Buffer} buf
 * @param {string} password
 * @returns {string} UTF-8 plaintext JSON
 */
function decryptNotePayload(buf, password) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length < 4 + 1 + 16 + 12 + 16) {
        throw new Error('Invalid encrypted note');
    }
    if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Invalid encrypted note');
    if (buf[4] !== VERSION) throw new Error('Unsupported note encryption version');
    const salt = buf.subarray(5, 21);
    const iv = buf.subarray(21, 33);
    const tag = buf.subarray(33, 49);
    const data = buf.subarray(49);
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptNotePayload, decryptNotePayload };
