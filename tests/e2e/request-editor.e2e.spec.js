'use strict';

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    ensureLoggingStartedNoModal,
    waitForLoggedCount,
} = require('./helpers.js');

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

test('re1) executeRequest GET httpbin', async () => {
    const res = await mainWindow.evaluate(() =>
        window.electronAPI.executeRequest({
            method: 'GET',
            url: 'https://httpbin.org/get',
            headers: { 'X-CupNet-E2E': '1' },
            body: '',
        })
    );
    expect(res?.success === true || res?.status > 0).toBeTruthy();
    expect(String(res?.body || '').length).toBeGreaterThan(20);
});

test('re2) replay last DB request for httpbin/get', async () => {
    await ensureLoggingStartedNoModal(mainWindow);
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    const before = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id, url: 'httpbin.org/get' }),
        sessionId
    );
    await navigateAndWait(electronApp, 'https://httpbin.org/get');
    await waitForLoggedCount(mainWindow, { sessionId, url: 'httpbin.org/get' }, before, 90_000);

    const rows = await mainWindow.evaluate(
        async () => (await window.electronAPI.getDbRequests({ url: 'httpbin.org/get' }, 30, 0)) || []
    );
    const row = rows.find((r) => String(r.url || '').includes('/get'));
    expect(row?.id).toBeTruthy();
    const rep = await mainWindow.evaluate(async (id) => window.electronAPI.replayRequest(id), row.id);
    expect(rep?.success).toBe(true);
});
