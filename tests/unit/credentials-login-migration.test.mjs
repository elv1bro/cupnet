import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('credentials login migration', () => {
    beforeEach(async () => {
        const vaultSession = require('../../main-process/services/vault-session-service.js');
        vaultSession._resetForTests();
        const { createVaultVerifyBlob } = require('../../credentials-crypto.js');
        const verifyBlob = await createVaultVerifyBlob('test-master-password-12');
        await vaultSession.unlockVault({
            vaultId: 1,
            name: 'Test',
            password: 'test-master-password-12',
            verifyBlob,
        });
    });

    it('encrypts plaintext login and notes on migration', () => {
        const { migratePlaintextCredentialFields } = require('../../main-process/ipc/handlers/credentials-ipc.js');
        const patches = [];
        const db = {
            listCredentials: () => [{ id: 42, vaultId: 1 }],
            getCredential: () => ({
                id: 42,
                login: 'alice@example.com',
                notes: 'secret note',
                login_encrypted: null,
                notes_encrypted: null,
            }),
            updateCredentialSensitiveFields: (patch) => patches.push(patch),
        };
        migratePlaintextCredentialFields(db, 1);
        expect(patches.length).toBe(1);
        expect(patches[0].login).toBe('');
        expect(patches[0].notes).toBe('');
        expect(Buffer.isBuffer(patches[0].login_encrypted)).toBe(true);
        expect(Buffer.isBuffer(patches[0].notes_encrypted)).toBe(true);
    });
});
