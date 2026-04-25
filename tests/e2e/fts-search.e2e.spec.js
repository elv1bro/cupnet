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

const HTTPBIN_UA = 'https://httpbin.org/user-agent';

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

test('fts1) FTS finds logged URL by token', async () => {
    await ensureLoggingStartedNoModal(mainWindow);
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    const before = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id, url: 'user-agent' }),
        sessionId
    );
    await navigateAndWait(electronApp, HTTPBIN_UA);
    await waitForLoggedCount(mainWindow, { sessionId, url: 'user-agent' }, before, 90_000);

    const rows = await mainWindow.evaluate(
        async ({ sid }) => window.electronAPI.ftsSearch('user-agent', sid),
        { sid: sessionId }
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
});

test('fts2) FTS empty for nonsense token', async () => {
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    const rows = await mainWindow.evaluate(
        async ({ sid }) => window.electronAPI.ftsSearch('zzzznomatchzzzz12345', sid),
        { sid: sessionId }
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
});
