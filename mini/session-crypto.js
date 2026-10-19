'use strict';

/**
 * Per-session encryption for CupNet mini sessions.
 *
 * Every session gets its own random 256-bit key, stored in a key file:
 *   <dataDir>/keys/<id>.cupkey     JSON { format, v, id, sessionId, key, createdAt }
 * and its encrypted copy is
 *   <dataDir>/sealed/<id>.cupsess
 *
 * `id` = first 128 bits of SHA-256("cupnet-session-id:v1" ‖ key), hex. It depends only on the key,
 * so it never changes while the session grows, it does not reveal the key, and the key file alone
 * is enough to find the sealed session (same name) and decrypt it.
 *
 * .cupsess format: "CUPSESS1" then frames of
 *   u32be ciphertextLength ‖ 12-byte IV ‖ AES-256-GCM(ciphertext ‖ 16-byte tag)
 * Each frame's plaintext is a run of whole JSONL lines (≤ FRAME_MAX bytes). AAD = "<id>:<frameIndex>",
 * so frames cannot be reordered or moved between sessions. mini/viewer.html decrypts the same format
 * with WebCrypto.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('CUPSESS1', 'ascii');
const KEY_FORMAT = 'cupnet-session-key';
const FRAME_MAX = 1024 * 1024;

function sessionIdFromKey(key) {
    return crypto.createHash('sha256').update('cupnet-session-id:v1').update(key).digest('hex').slice(0, 32);
}

function _b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _fromB64url(s) {
    return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Parse and validate a key file's JSON text → { id, sessionId, key(Buffer) }. */
function parseKeyFile(text) {
    const j = JSON.parse(text);
    if (!j || j.format !== KEY_FORMAT || j.v !== 1) throw new Error('not a CupNet session key file');
    const key = _fromB64url(j.key);
    if (key.length !== 32) throw new Error('bad key length');
    const id = sessionIdFromKey(key);
    if (j.id && j.id !== id) throw new Error('key file id does not match its key');
    return { id, sessionId: j.sessionId || null, key, createdAt: j.createdAt || null };
}

function readKeyFile(file) {
    return parseKeyFile(fs.readFileSync(file, 'utf8'));
}

/** Key for `sessionId` in `keysDir`: reuse the existing key file, else create one. */
function ensureSessionKey(keysDir, sessionId) {
    const found = findKeyBySessionId(keysDir, sessionId);
    if (found) return found;
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    const id = sessionIdFromKey(key);
    const file = path.join(keysDir, `${id}.cupkey`);
    const body = { format: KEY_FORMAT, v: 1, id, sessionId, key: _b64url(key), createdAt: new Date().toISOString() };
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { id, sessionId, key, file };
}

function findKeyBySessionId(keysDir, sessionId) {
    let names = [];
    try { names = fs.readdirSync(keysDir).filter((n) => n.endsWith('.cupkey')); } catch { return null; }
    for (const n of names) {
        const file = path.join(keysDir, n);
        try {
            const k = readKeyFile(file);
            if (k.sessionId === sessionId) return { ...k, file };
        } catch { /* skip foreign/corrupt files */ }
    }
    return null;
}

/** sessionId → { id, file } for every valid key file in `keysDir`. */
function listKeys(keysDir) {
    const out = new Map();
    let names = [];
    try { names = fs.readdirSync(keysDir).filter((n) => n.endsWith('.cupkey')); } catch { return out; }
    for (const n of names) {
        const file = path.join(keysDir, n);
        try {
            const k = readKeyFile(file);
            if (k.sessionId) out.set(k.sessionId, { id: k.id, file });
        } catch { /* skip foreign/corrupt files */ }
    }
    return out;
}

/** Split JSONL text into frames of whole lines, each ≤ FRAME_MAX bytes (a longer line is its own frame). */
function _chunkLines(buf) {
    const chunks = [];
    let start = 0;
    while (start < buf.length) {
        let end = Math.min(start + FRAME_MAX, buf.length);
        if (end < buf.length) {
            const nl = buf.lastIndexOf(0x0a, end - 1);
            if (nl >= start) end = nl + 1;
            else {
                const next = buf.indexOf(0x0a, end);
                end = next < 0 ? buf.length : next + 1;
            }
        }
        chunks.push(buf.subarray(start, end));
        start = end;
    }
    return chunks;
}

/** Encrypt JSONL bytes for `id` with `key` → .cupsess bytes. */
function sealBuffer(plain, { id, key }) {
    const parts = [MAGIC];
    _chunkLines(Buffer.from(plain)).forEach((chunk, i) => {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key, iv);
        c.setAAD(Buffer.from(`${id}:${i}`, 'ascii'));
        const ct = Buffer.concat([c.update(chunk), c.final(), c.getAuthTag()]);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(ct.length, 0);
        parts.push(len, iv, ct);
    });
    return Buffer.concat(parts);
}

/** Decrypt .cupsess bytes → JSONL Buffer. Throws on a wrong key or tampered data. */
function openBuffer(sealed, { id, key }) {
    const buf = Buffer.from(sealed);
    if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a .cupsess file');
    const out = [];
    let off = MAGIC.length;
    for (let i = 0; off < buf.length; i++) {
        if (off + 4 + 12 + 16 > buf.length) throw new Error('truncated .cupsess file');
        const len = buf.readUInt32BE(off);
        const iv = buf.subarray(off + 4, off + 16);
        const ct = buf.subarray(off + 16, off + 16 + len);
        if (ct.length !== len || len < 16) throw new Error('truncated .cupsess file');
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAAD(Buffer.from(`${id}:${i}`, 'ascii'));
        d.setAuthTag(ct.subarray(len - 16));
        out.push(d.update(ct.subarray(0, len - 16)), d.final());
        off += 16 + len;
    }
    return Buffer.concat(out);
}

/**
 * Seal <sessionsDir>/<sessionId>.jsonl into <sealedDir>/<id>.cupsess (rewritten in place: the
 * name stays the same as the session grows).
 */
function sealSession({ sessionsDir, keysDir, sealedDir, sessionId }) {
    const src = path.join(sessionsDir, `${sessionId}.jsonl`);
    const plain = fs.readFileSync(src);
    const k = ensureSessionKey(keysDir, sessionId);
    fs.mkdirSync(sealedDir, { recursive: true, mode: 0o700 });
    const out = path.join(sealedDir, `${k.id}.cupsess`);
    const tmp = `${out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, sealBuffer(plain, k), { mode: 0o600 });
    fs.renameSync(tmp, out);
    return { id: k.id, sessionId, keyFile: k.file, sealedFile: out, bytes: plain.length };
}

module.exports = {
    sessionIdFromKey,
    parseKeyFile,
    readKeyFile,
    ensureSessionKey,
    findKeyBySessionId,
    listKeys,
    sealBuffer,
    openBuffer,
    sealSession,
    FRAME_MAX,
};
