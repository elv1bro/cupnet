import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    encryptCredentialField,
    decryptCredentialField,
    encryptCredentialFieldWithKey,
    decryptCredentialFieldWithKey,
    createVaultVerifyBlob,
    verifyVaultPassword,
    deriveMasterKey,
} = require('../../credentials-crypto.js');

describe('credentials-crypto', () => {
    it('round-trips CV01 field encryption', () => {
        const mp = 'test-master-password-32chars!!';
        const plain = 'secret-value-ü';
        const buf = encryptCredentialField(plain, mp);
        expect(buf.length > 0).toBe(true);
        expect(decryptCredentialField(buf, mp)).toBe(plain);
    });

    it('round-trips CV02 field encryption with derived key', async () => {
        const mp = 'another-strong-passphrase12';
        const salt = Buffer.alloc(16, 7);
        const key = await deriveMasterKey(mp, salt);
        const plain = 'cv02-secret';
        const buf = encryptCredentialFieldWithKey(plain, key);
        expect(decryptCredentialFieldWithKey(buf, key)).toBe(plain);
    });

    it('vault verify blob (CV02 async)', async () => {
        const mp = 'another-strong-passphrase12';
        const blob = await createVaultVerifyBlob(mp);
        expect(await verifyVaultPassword(blob, mp)).toBe(true);
        expect(await verifyVaultPassword(blob, 'wrong-password-12')).toBe(false);
    });
});
