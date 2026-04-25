'use strict';

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    ensureLoggingStartedNoModal,
} = require('./helpers.js');

const HTTPBIN_GET = 'https://httpbin.org/get';

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

test('tr1) trace mode records entries then clears', async () => {
    await ensureLoggingStartedNoModal(mainWindow);
    await mainWindow.evaluate(() => window.electronAPI.clearTraceEntries());
    await mainWindow.evaluate(() => window.electronAPI.setTraceMode(true));
    expect(await mainWindow.evaluate(() => window.electronAPI.getTraceMode())).toBe(true);

    await navigateAndWait(electronApp, HTTPBIN_GET);

    const n = await mainWindow.evaluate(async () => {
        let c = 0;
        for (let i = 0; i < 40; i++) {
            c = await window.electronAPI.countTraceEntries();
            if (c > 0) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        return c;
    });
    expect(n).toBeGreaterThan(0);

    const entries = await mainWindow.evaluate(() => window.electronAPI.getTraceEntries(20, 0));
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    await mainWindow.evaluate(() => window.electronAPI.setTraceMode(false));
    expect(await mainWindow.evaluate(() => window.electronAPI.getTraceMode())).toBe(false);
});
