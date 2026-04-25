'use strict';

/**
 * Credentials vault: setup, save, fill, lock, change master, trash/restore.
 */
const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    injectLoginFormInActiveTab,
} = require('./helpers.js');

const MASTER = 'e2eCredPw1';
const MASTER2 = 'e2eCredPw2';

test.describe.configure({ mode: 'serial' });

let electronApp;
/** @type {import('@playwright/test').Page} */
let mainWindow;

test.beforeAll(async () => {
    electronApp = await launchCupnet();
    mainWindow = await electronApp.firstWindow({ timeout: 120_000 });
    await mainWindow.waitForLoadState('domcontentloaded');
    await waitForAppContext(electronApp, 120_000);
    await waitMitmReady(electronApp, 180_000);
});

test.afterAll(async () => {
    if (electronApp) await electronApp.close();
});

test('cr1) vault setup + save credential', async () => {
    const st = await mainWindow.evaluate(() => window.electronAPI.credentialsVaultStatus());
    if (!st?.exists) {
        const setup = await mainWindow.evaluate(
            async (pw) =>
                window.electronAPI.credentialsVaultSetup({
                    name: 'E2E',
                    password: pw,
                    confirm: pw,
                }),
            MASTER
        );
        expect(setup?.success).toBe(true);
    } else if (!st?.unlocked) {
        const un = await mainWindow.evaluate(async (pw) => window.electronAPI.credentialsUnlock(pw), MASTER);
        expect(un?.success).toBe(true);
    }

    const save = await mainWindow.evaluate(() =>
        window.electronAPI.credentialsSave({
            domain: 'httpbin.org',
            url_match: 'httpbin.org',
            label: 'e2e',
            login: 'user_e2e',
            password: 'secret_e2e',
        })
    );
    expect(save?.success !== false).toBe(true);
    expect(typeof save?.id).toBe('number');
});

test('cr2) fill active tab after injected form', async () => {
    await navigateAndWait(electronApp, 'https://httpbin.org/get');
    await injectLoginFormInActiveTab(electronApp);

    const fill = await mainWindow.evaluate(() => window.electronAPI.credentialsFillActiveTab({}));
    expect(fill?.success).toBe(true);
});

test('cr3) lock + unlock', async () => {
    await mainWindow.evaluate(() => window.electronAPI.credentialsLock());
    await expect(mainWindow.evaluate(() => window.electronAPI.credentialsList({}))).rejects.toThrow();

    const un = await mainWindow.evaluate(async (pw) => window.electronAPI.credentialsUnlock(pw), MASTER);
    expect(un?.success).toBe(true);
    const list = await mainWindow.evaluate(() => window.electronAPI.credentialsList({ limit: 50 }));
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
});

test('cr4) change master password', async () => {
    const ch = await mainWindow.evaluate(
        async ({ oldPw, newPw }) =>
            window.electronAPI.credentialsChangeMaster({
                oldPassword: oldPw,
                newPassword: newPw,
                confirm: newPw,
            }),
        { oldPw: MASTER, newPw: MASTER2 }
    );
    expect(ch?.success).toBe(true);

    await mainWindow.evaluate(() => window.electronAPI.credentialsLock());
    const un = await mainWindow.evaluate(async (pw) => window.electronAPI.credentialsUnlock(pw), MASTER2);
    expect(un?.success).toBe(true);

    await mainWindow.evaluate(
        async ({ oldPw, newPw }) =>
            window.electronAPI.credentialsChangeMaster({
                oldPassword: oldPw,
                newPassword: newPw,
                confirm: newPw,
            }),
        { oldPw: MASTER2, newPw: MASTER }
    );
});

test('cr5) soft delete + restore', async () => {
    const rows = await mainWindow.evaluate(() => window.electronAPI.credentialsList({ limit: 20 }));
    const id = (rows || []).find((r) => r.label === 'e2e')?.id;
    expect(id).toBeTruthy();

    await mainWindow.evaluate(
        async (credId) => window.electronAPI.credentialsDelete(credId, false),
        id
    );
    const rest = await mainWindow.evaluate(async (credId) => window.electronAPI.credentialsRestore(credId), id);
    expect(rest?.success).toBe(true);
});
