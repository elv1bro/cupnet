'use strict';

const { test, expect } = require('@playwright/test');
const { launchCupnet, waitForAppContext, waitMitmReady } = require('./helpers.js');

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

test('dns1) save list toggle delete', async () => {
    const host = `e2e-${Date.now()}.invalid`;
    const save = await mainWindow.evaluate(
        (h) =>
            window.electronAPI.saveDnsOverride({
                host: h,
                ip: '127.0.0.1',
                enabled: true,
            }),
        host
    );
    expect(save?.success).toBe(true);
    expect(typeof save?.id === 'number' || save?.id > 0).toBeTruthy();

    let list = await mainWindow.evaluate(() => window.electronAPI.getDnsOverrides());
    const row = (list || []).find((r) => String(r.host || '').toLowerCase() === host.toLowerCase());
    expect(row).toBeTruthy();

    await mainWindow.evaluate(async (id) => window.electronAPI.toggleDnsOverride(id, false), row.id);
    list = await mainWindow.evaluate(() => window.electronAPI.getDnsOverrides());
    const row2 = (list || []).find((r) => r.id === row.id);
    expect(row2?.enabled === false || row2?.enabled === 0).toBeTruthy();

    await mainWindow.evaluate(async (id) => window.electronAPI.deleteDnsOverride(id), row.id);
    list = await mainWindow.evaluate(() => window.electronAPI.getDnsOverrides());
    expect((list || []).every((r) => r.id !== row.id)).toBe(true);
});
