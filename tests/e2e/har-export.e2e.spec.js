'use strict';

/**
 * HAR export via main harExporter + replay-request (requires network).
 */
const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    exportHarViaMain,
    ensureLoggingStartedNoModal,
    waitForLoggedCount,
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

test('har1) exportHar shape — log.version and entries', async () => {
    await ensureLoggingStartedNoModal(mainWindow);
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    expect(sessionId).toBeTruthy();

    const before = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id, url: 'httpbin.org/get' }),
        sessionId
    );

    await navigateAndWait(electronApp, HTTPBIN_GET);

    await waitForLoggedCount(mainWindow, { sessionId, url: 'httpbin.org/get' }, before, 90_000);

    const har = await exportHarViaMain(electronApp, sessionId);
    expect(har && typeof har === 'object').toBe(true);
    expect(har.log?.version).toBe('1.2');
    expect(Array.isArray(har.log?.entries)).toBe(true);
    const hit = (har.log.entries || []).find((e) => String(e.request?.url || '').includes('httpbin.org/get'));
    expect(hit).toBeTruthy();
    expect(hit.response?.status).toBeGreaterThan(0);
});

test('har2) replay-request — success and body', async () => {
    const rows = await mainWindow.evaluate(
        async () => (await window.electronAPI.getDbRequests({ url: 'httpbin.org/get' }, 20, 0)) || []
    );
    const row = rows.find((r) => String(r.url || '').includes('/get'));
    expect(row?.id).toBeTruthy();

    const rep = await mainWindow.evaluate(async (id) => window.electronAPI.replayRequest(id), row.id);
    expect(rep?.success).toBe(true);
    expect(rep?.status).toBeGreaterThan(0);
    expect(String(rep?.body || '').length).toBeGreaterThan(10);
});
