import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    registerTrustedShell,
    registerTabView,
    guardIpcHandler,
    _resetForTests,
} = require('../../main-process/ipc/ipc-trusted-sender.js');

describe('ipc-trusted-sender', () => {
    beforeEach(() => {
        _resetForTests();
    });

    it('allows trusted shell sender', async () => {
        const wc = { id: 1, isDestroyed: () => false, once: () => {} };
        registerTrustedShell(wc);
        const handler = guardIpcHandler('test-channel', async () => ({ ok: true }));
        const result = await handler({ sender: wc });
        expect(result.ok).toBe(true);
    });

    it('rejects tab view sender', async () => {
        const tabWc = { id: 2, isDestroyed: () => false, once: () => {} };
        registerTabView(tabWc);
        const handler = guardIpcHandler('test-channel', async () => ({ ok: true }));
        await expect(handler({ sender: tabWc })).rejects.toMatchObject({ code: 'IPC_UNTRUSTED_SENDER' });
    });
});
