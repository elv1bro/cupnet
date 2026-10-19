import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    registerTrustedShell,
    registerTabView,
    guardIpcHandler,
    guardIpcHandlerAllowInternal,
    _resetForTests,
} = require('../../main-process/ipc/ipc-trusted-sender.js');
import path from 'path';
import { pathToFileURL } from 'url';

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

describe('ipc trusted or internal file page', () => {
    beforeEach(() => {
        _resetForTests();
    });

    it('allows an internal file: tab and rejects a website tab', async () => {
        const root = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')).href.replace(/\/+$/, '');
        const internal = { id: 3, isDestroyed: () => false, once: () => {}, getURL: () => root + '/new-tab.html' };
        const site = { id: 4, isDestroyed: () => false, once: () => {}, getURL: () => 'https://example.com/' };
        registerTabView(internal);
        registerTabView(site);
        const handler = guardIpcHandlerAllowInternal('get-direct-ip', async () => ({ ip: '1.2.3.4' }));
        await expect(handler({ sender: internal })).resolves.toEqual({ ip: '1.2.3.4' });
        await expect(handler({ sender: site })).rejects.toMatchObject({ code: 'IPC_UNTRUSTED_SENDER' });
    });
});
