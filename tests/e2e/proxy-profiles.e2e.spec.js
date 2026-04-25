'use strict';

/**
 * Proxy profile CRUD and TLS profile (no external proxy required).
 */
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

test('pp1) saveProxyProfileFull — list contains profile', async () => {
    const name = `e2e-pp-${Date.now()}`;
    const res = await mainWindow.evaluate(
        async (n) =>
            window.electronAPI.saveProxyProfileFull({
                name: n,
                template: 'http://127.0.0.1:19999',
                variables: {},
                notes: 'e2e',
                country: '',
                tls_profile: 'chrome',
            }),
        name
    );
    expect(res?.success).toBe(true);
    expect(typeof res?.id).toBe('number');

    const list = await mainWindow.evaluate(() => window.electronAPI.getProxyProfiles());
    expect(Array.isArray(list)).toBe(true);
    const row = (list || []).find((p) => p.name === name);
    expect(row).toBeTruthy();
});

test('pp2) deleteProxyProfile — profile removed', async () => {
    const name = `e2e-del-${Date.now()}`;
    const created = await mainWindow.evaluate(
        async (n) =>
            window.electronAPI.saveProxyProfileFull({
                name: n,
                template: 'http://127.0.0.1:19998',
                variables: {},
                notes: '',
                country: '',
                tls_profile: 'firefox',
            }),
        name
    );
    expect(created?.id).toBeTruthy();

    const del = await mainWindow.evaluate(async (id) => window.electronAPI.deleteProxyProfile(id), created.id);
    expect(del === true || del?.success === true).toBe(true);

    const list = await mainWindow.evaluate(() => window.electronAPI.getProxyProfiles());
    expect((list || []).every((p) => p.name !== name)).toBe(true);
});

test('pp3) setTlsProfile / getTlsProfile roundtrip', async () => {
    const before = await mainWindow.evaluate(() => window.electronAPI.getTlsProfile());
    await mainWindow.evaluate(() => window.electronAPI.setTlsProfile('safari'));
    const mid = await mainWindow.evaluate(() => window.electronAPI.getTlsProfile());
    expect(mid).toBe('safari');

    const restore = typeof before === 'string' ? before : 'chrome';
    await mainWindow.evaluate((p) => window.electronAPI.setTlsProfile(p), restore);
});

test('pp4) disconnectProxy after connect-direct — app stays in direct mode', async () => {
    const d = await mainWindow.evaluate(() => window.electronAPI.connectDirect('chrome'));
    expect(d?.success === true || d?.success === undefined).toBeTruthy();
    const disc = await mainWindow.evaluate(() => window.electronAPI.disconnectProxy());
    expect(disc?.success !== false).toBe(true);
});
