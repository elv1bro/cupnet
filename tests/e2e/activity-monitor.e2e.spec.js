'use strict';

/**
 * E2E: Browser Activity Monitor — CDP console rows + inject storage + settings persistence.
 * Uses the default in-app tab (no external URLs) so MITM/network is not required.
 * Run: npm run test:e2e — or playwright test tests/e2e/activity-monitor.e2e.spec.js
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    executeActiveTabJavaScript,
    waitForBrowserEvent,
    ensureLoggingStartedNoModal,
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

    await ensureLoggingStartedNoModal(mainWindow);

    await mainWindow.evaluate(() =>
        window.electronAPI.saveActivityMonitorSettings({
            activityMonitorEnabled: true,
            activityMonitorRateLimit: 100,
            activityMonitorStorageStackTraces: false,
        })
    );
});

test.afterAll(async () => {
    if (electronApp) await electronApp.close();
});

test('1) console.log — browser_events row (CDP Runtime.consoleAPICalled)', async () => {
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    expect(sessionId).toBeTruthy();

    const marker = `cupnet_e2e_am_console_${Date.now()}`;
    await executeActiveTabJavaScript(
        electronApp,
        `console.log(${JSON.stringify(marker)}); true`
    );

    const row = await waitForBrowserEvent(
        mainWindow,
        sessionId,
        (r) =>
            String(r.event_type || '') === 'console' &&
            String(r.summary || '').includes(marker),
        60_000
    );
    expect(row.level).toBeTruthy();
});

test('2) localStorage with inject — ls-set row with inject detail (stack traces mode)', async () => {
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    expect(sessionId).toBeTruthy();

    await mainWindow.evaluate(() =>
        window.electronAPI.saveActivityMonitorSettings({
            activityMonitorEnabled: true,
            activityMonitorRateLimit: 100,
            activityMonitorStorageStackTraces: true,
        })
    );
    await new Promise((r) => setTimeout(r, 600));

    const key = `cupnet_e2e_ls_${Date.now()}`;
    await executeActiveTabJavaScript(
        electronApp,
        `try { localStorage.setItem(${JSON.stringify(key)}, 'v'); } catch (e) {} true`
    );

    const row = await waitForBrowserEvent(
        mainWindow,
        sessionId,
        (r) =>
            String(r.event_type || '') === 'ls-set' &&
            String(r.summary || '').includes(key),
        60_000
    );
    let detail;
    try {
        detail = JSON.parse(String(row.detail || '{}'));
    } catch {
        detail = {};
    }
    expect(detail.inject).toBe(true);
    expect(String(detail.stack || '').length).toBeGreaterThan(10);
});

test('3) saveActivityMonitorSettings — getSettingsAll returns saved values', async () => {
    await mainWindow.evaluate(() =>
        window.electronAPI.saveActivityMonitorSettings({
            activityMonitorEnabled: true,
            activityMonitorRateLimit: 220,
            activityMonitorStorageStackTraces: false,
        })
    );
    await new Promise((r) => setTimeout(r, 200));

    const s = await mainWindow.evaluate(() => window.electronAPI.getSettingsAll());
    expect(s.activityMonitorEnabled).toBe(true);
    expect(s.activityMonitorRateLimit).toBe(220);
    expect(s.activityMonitorStorageStackTraces).toBe(false);
});
