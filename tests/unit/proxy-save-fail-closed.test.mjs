import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('proxy save fail-closed', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('save-proxy-profile rejects when safeStorage unavailable', async () => {
        const handlers = new Map();
        const ctx = {
            safeStorage: { isEncryptionAvailable: () => false },
            db: { saveProxyProfileAsync: vi.fn() },
            safeCatch: vi.fn(),
            sysLog: vi.fn(),
            ipcMain: {
                handle: (channel, fn) => handlers.set(channel, fn),
            },
        };
        require('../../main-process/ipc/handlers/proxy-ipc.js').registerProxyIpc(ctx);
        const fn = handlers.get('save-proxy-profile');
        expect(fn).toBeTruthy();
        const result = await fn({}, 'Test', 'http://user:pass@proxy:8080', null);
        expect(result.success).toBe(false);
        expect(String(result.error)).toMatch(/secure storage/i);
        expect(ctx.db.saveProxyProfileAsync).not.toHaveBeenCalled();
    });
});
