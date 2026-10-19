'use strict';

/**
 * CupNet mini per-session encryption (mini/session-crypto.js) and the browser viewer's decryptor
 * (mini/viewer.html), which must read the exact bytes Node writes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sc = require('../../mini/session-crypto.js');

const tmpDirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'cupnet-seal-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function layout() {
    const root = tmp();
    const dirs = { sessionsDir: path.join(root, 'sessions'), keysDir: path.join(root, 'keys'), sealedDir: path.join(root, 'sealed') };
    mkdirSync(dirs.sessionsDir, { recursive: true });
    return dirs;
}

const jsonl = (n, pad = 0) => Array.from({ length: n }, (_, i) => JSON.stringify({ seq: i + 1, url: `https://a/${i}`, body: 'Ж'.repeat(pad) })).join('\n') + '\n';

/** The viewer's own parseKey/decrypt, lifted out of viewer.html and run on Node's WebCrypto. */
function viewerCrypto() {
    const html = readFileSync(path.join(repoRoot, 'mini', 'viewer.html'), 'utf8');
    const script = html.slice(html.indexOf("const MAGIC"), html.indexOf('async function tryOpen'));
    const src = script.replace(/^let .*$/m, '').replace(/^const status = .*$/m, '');
    // eslint-disable-next-line no-new-func
    return new Function('crypto', 'atob', 'TextEncoder', 'TextDecoder', 'Blob', `${src}\nreturn { parseKey, decrypt };`)(
        globalThis.crypto, globalThis.atob, TextEncoder, TextDecoder, Blob);
}

describe('session-crypto', () => {
    it('one key file per session, named by a key-derived id that never changes', () => {
        const d = layout();
        writeFileSync(path.join(d.sessionsDir, 's1.jsonl'), jsonl(3));
        const a = sc.sealSession({ ...d, sessionId: 's1' });
        expect(a.id).toMatch(/^[0-9a-f]{32}$/);
        expect(path.basename(a.keyFile)).toBe(`${a.id}.cupkey`);
        expect(path.basename(a.sealedFile)).toBe(`${a.id}.cupsess`);
        expect(statSync(a.keyFile).mode & 0o777).toBe(0o600);

        // The session grows and is sealed again: same key, same names, new content.
        writeFileSync(path.join(d.sessionsDir, 's1.jsonl'), jsonl(10));
        const b = sc.sealSession({ ...d, sessionId: 's1' });
        expect(b.id).toBe(a.id);
        expect(readdirSync(d.keysDir)).toEqual([`${a.id}.cupkey`]);
        expect(readdirSync(d.sealedDir)).toEqual([`${a.id}.cupsess`]);
        const k = sc.readKeyFile(a.keyFile);
        expect(sc.openBuffer(readFileSync(b.sealedFile), k).toString()).toBe(jsonl(10));

        // Another session → another key.
        writeFileSync(path.join(d.sessionsDir, 's2.jsonl'), jsonl(1));
        expect(sc.sealSession({ ...d, sessionId: 's2' }).id).not.toBe(a.id);
    });

    it('round-trips multi-frame sessions byte for byte; the ciphertext hides the content', () => {
        const key = Buffer.alloc(32, 7);
        const k = { id: sc.sessionIdFromKey(key), key };
        const plain = Buffer.from(jsonl(40, 30_000)); // ~2.4 MB of 2-byte chars → several frames
        const sealed = sc.sealBuffer(plain, k);
        expect(sealed.subarray(0, 8).toString()).toBe('CUPSESS1');
        expect(sealed.includes(Buffer.from('https://a/'))).toBe(false);
        const frames = [];
        for (let off = 8; off < sealed.length; off += 16 + sealed.readUInt32BE(off)) frames.push(off);
        expect(frames.length).toBeGreaterThan(2);
        expect(sc.openBuffer(sealed, k).equals(plain)).toBe(true);
    });

    it('rejects a wrong key, tampering, reordered frames and a mismatched key file', () => {
        const key = Buffer.alloc(32, 1);
        const k = { id: sc.sessionIdFromKey(key), key };
        const sealed = sc.sealBuffer(Buffer.from(jsonl(40, 30_000)), k);
        const other = Buffer.alloc(32, 2);
        expect(() => sc.openBuffer(sealed, { id: k.id, key: other })).toThrow();
        const flipped = Buffer.from(sealed); flipped[40] ^= 1;
        expect(() => sc.openBuffer(flipped, k)).toThrow();
        expect(() => sc.openBuffer(sealed.subarray(0, sealed.length - 5), k)).toThrow(/truncated/);

        // Swap frames 0 and 1: AAD binds each frame to its index.
        const f0 = 8, l0 = 16 + sealed.readUInt32BE(f0), f1 = f0 + l0, l1 = 16 + sealed.readUInt32BE(f1);
        const swapped = Buffer.concat([sealed.subarray(0, 8), sealed.subarray(f1, f1 + l1), sealed.subarray(f0, f0 + l0), sealed.subarray(f1 + l1)]);
        expect(() => sc.openBuffer(swapped, k)).toThrow();

        const kf = JSON.parse(JSON.stringify({ format: 'cupnet-session-key', v: 1, id: '0'.repeat(32), key: key.toString('base64url') }));
        expect(() => sc.parseKeyFile(JSON.stringify(kf))).toThrow(/does not match/);
        expect(() => sc.parseKeyFile('{"format":"x"}')).toThrow(/not a CupNet/);
    });

    it('viewer.html decrypts what Node sealed (WebCrypto, same id derivation)', async () => {
        const d = layout();
        const plain = jsonl(30, 20_000);
        writeFileSync(path.join(d.sessionsDir, 'sv.jsonl'), plain);
        const r = sc.sealSession({ ...d, sessionId: 'sv' });
        const { parseKey, decrypt } = viewerCrypto();
        const k = await parseKey(readFileSync(r.keyFile, 'utf8'));
        expect(k.id).toBe(r.id);
        expect(k.sessionId).toBe('sv');
        const blob = await decrypt(readFileSync(r.sealedFile), k);
        expect(await blob.text()).toBe(plain);

        const bad = Buffer.from(readFileSync(r.sealedFile)); bad[30] ^= 1;
        await expect(decrypt(bad, k)).rejects.toThrow(/frame 0/);
    });
});
