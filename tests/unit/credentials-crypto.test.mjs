import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    encryptCredentialField,
    decryptCredentialField,
    createVaultVerifyBlob,
    verifyVaultPassword,
} = require('../../credentials-crypto.js');

describe('credentials-crypto', () => {
    it('round-trips field encryption', () => {
        const mp = 'test-master-password-32chars!!';
        const plain = 'secret-value-ü';
        const buf = encryptCredentialField(plain, mp);
        expect(buf.length > 0).toBe(true);
        expect(decryptCredentialField(buf, mp)).toBe(plain);
    });

    it('vault verify blob', () => {
        const mp = 'another-strong-passphrase';
        const blob = createVaultVerifyBlob(mp);
        expect(verifyVaultPassword(blob, mp)).toBe(true);
        expect(verifyVaultPassword(blob, 'wrong')).toBe(false);
    });
});
