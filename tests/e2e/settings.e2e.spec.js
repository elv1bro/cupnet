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

test('st1) homepage get/set', async () => {
    const u = 'https://httpbin.org/get';
    await mainWindow.evaluate((url) => window.electronAPI.setHomepage(url), u);
    const g = await mainWindow.evaluate(() => window.electronAPI.getHomepage());
    expect(g).toBe(u);
    await mainWindow.evaluate(() => window.electronAPI.setHomepage(''));
});

test('st2) trace mode toggle', async () => {
    await mainWindow.evaluate(() => window.electronAPI.setTraceMode(true));
    let on = await mainWindow.evaluate(() => window.electronAPI.getTraceMode());
    expect(on).toBe(true);
    await mainWindow.evaluate(() => window.electronAPI.setTraceMode(false));
    on = await mainWindow.evaluate(() => window.electronAPI.getTraceMode());
    expect(on).toBe(false);
});

test('st3) bypass domains save + getSettingsAll', async () => {
    await mainWindow.evaluate(() => window.electronAPI.saveBypassDomains(['example.com', 'test.invalid']));
    const all = await mainWindow.evaluate(() => window.electronAPI.getSettingsAll());
    expect(Array.isArray(all?.bypassDomains)).toBe(true);
    expect(all.bypassDomains).toContain('example.com');
    await mainWindow.evaluate(() => window.electronAPI.saveBypassDomains([]));
});

test('st4) activity monitor settings persist', async () => {
    await mainWindow.evaluate(() =>
        window.electronAPI.saveActivityMonitorSettings({
            activityMonitorEnabled: true,
            activityMonitorRateLimit: 220,
            activityMonitorStorageStackTraces: false,
        })
    );
    const all = await mainWindow.evaluate(() => window.electronAPI.getSettingsAll());
    expect(all?.activityMonitorEnabled).toBe(true);
    expect(all?.activityMonitorRateLimit).toBe(220);
});
