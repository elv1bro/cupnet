import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('vault-session-service auto-lock', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('does not idle-lock while profile workspace is active', async () => {
        vi.useFakeTimers();
        const vaultSession = require('../../main-process/services/vault-session-service.js');
        const profileSession = require('../../main-process/services/profile-session.js');
        vaultSession._resetForTests();
        vaultSession.configure({ autoLockMinutes: 1 });

        const { createVaultVerifyBlob } = require('../../credentials-crypto.js');
        const verifyBlob = await createVaultVerifyBlob('test-master-password-12');

        const unlock = await vaultSession.unlockVault({
            vaultId: 1,
            name: 'Test',
            password: 'test-master-password-12',
            verifyBlob,
        });
        expect(unlock.success).toBe(true);
        expect(profileSession.isProfileActive()).toBe(true);
        expect(vaultSession.isVaultUnlocked(1)).toBe(true);

        await vi.advanceTimersByTimeAsync(61 * 1000);
        expect(vaultSession.isVaultUnlocked(1)).toBe(true);
        vi.useRealTimers();
    });

    it('idle-locks when profile workspace is not active', async () => {
        vi.useFakeTimers();
        const vaultSession = require('../../main-process/services/vault-session-service.js');
        const profileSession = require('../../main-process/services/profile-session.js');
        vaultSession._resetForTests();
        vaultSession.configure({ autoLockMinutes: 1 });

        const { createVaultVerifyBlob } = require('../../credentials-crypto.js');
        const verifyBlob = await createVaultVerifyBlob('test-master-password-12');

        const unlock = await vaultSession.unlockVault({
            vaultId: 1,
            name: 'Test',
            password: 'test-master-password-12',
            verifyBlob,
        });
        expect(unlock.success).toBe(true);
        profileSession.clearProfileSession();

        await vi.advanceTimersByTimeAsync(61 * 1000);
        expect(vaultSession.isVaultUnlocked(1)).toBe(false);
        vi.useRealTimers();
    });
});
