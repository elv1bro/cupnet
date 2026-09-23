import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('traffic-log-crypto', () => {
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

    it('encrypts and hydrates request log fields', () => {
        const { prepareRequestLogFields, hydrateRequestLogRow } = require('../../main-process/services/traffic-log-crypto.js');
        const prepared = prepareRequestLogFields({
            requestHeaders: { Authorization: 'Bearer secret' },
            responseHeaders: { 'Set-Cookie': 'sid=abc' },
            requestBody: '{"token":"x"}',
            responseBody: '{"ok":true}',
        });
        expect(prepared.log_encrypted).toBe(1);
        expect(prepared.request_body).toBeNull();
        expect(Buffer.isBuffer(prepared.request_body_enc)).toBe(true);

        const hydrated = hydrateRequestLogRow({
            ...prepared,
            id: 1,
            log_encrypted: 1,
        });
        expect(hydrated.request_body).toBe('{"token":"x"}');
        expect(hydrated.response_body).toBe('{"ok":true}');
    });
});
