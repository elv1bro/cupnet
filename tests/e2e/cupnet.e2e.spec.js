'use strict';

/**
 * E2E: реальный Electron + httpbin.org (нужен интернет).
 * Запуск: npm run test:e2e
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
    waitForLoggedCount,
} = require('./helpers.js');

const HTTPBIN_GET = 'https://httpbin.org/get';
const HTTPBIN_HEADERS = 'https://httpbin.org/headers';
const HTTPBIN_COOKIES_SET = 'https://httpbin.org/cookies/set?cupnet_e2e=1';
const HTTPBIN_COOKIES = 'https://httpbin.org/cookies';
const HTTPBIN_STATUS = 'https://httpbin.org/status/200';

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

test('1) приложение стартует, главное окно и MITM готовы', async () => {
    expect(mainWindow).toBeTruthy();
    const ready = await electronApp.evaluate(() => globalThis.__cupnetAppContext?.mitm?.ready === true);
    expect(ready).toBe(true);
});

test('2) навигация на httpbin.org/get — тело содержит JSON поля', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const text = await readActiveTabBodyText(electronApp);
    expect(text.length).toBeGreaterThan(50);
    expect(text).toMatch(/"url"|origin|headers/i);
});

test('3) логирование Network Activity — запись в БД после /headers', async () => {
    const startRes = await mainWindow.evaluate(() => window.electronAPI.toggleLoggingStart('e2e'));
    expect(['started', 'already_on']).toContain(startRes?.status);

    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    expect(sessionId).toBeTruthy();

    const before = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id, url: 'httpbin.org/headers' }),
        sessionId
    );

    await navigateAndWait(electronApp, HTTPBIN_HEADERS);

    await waitForLoggedCount(
        mainWindow,
        { sessionId, url: 'httpbin.org/headers' },
        before,
        90_000
    );

    const after = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id, url: 'httpbin.org/headers' }),
        sessionId
    );
    expect(after).toBeGreaterThan(before);
});

test('4) cookies — set на httpbin виден на /cookies', async () => {
    await navigateAndWait(electronApp, HTTPBIN_COOKIES_SET);
    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    const text = await readActiveTabBodyText(electronApp);
    expect(text).toContain('cupnet_e2e');
});

test('5) изолированная вкладка — cookie из shared не видна', async () => {
    await mainWindow.evaluate(() => window.electronAPI.newIsolatedTab());
    // дать время переключить BrowserView (иначе редкий race с CDP / evaluate)
    await new Promise((r) => setTimeout(r, 750));
    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    const text = await readActiveTabBodyText(electronApp);
    expect(text).not.toContain('cupnet_e2e');
});

test('6) direct-вкладка — загрузка httpbin/get без MITM-сессии', async () => {
    await mainWindow.evaluate(() => window.electronAPI.newDirectTab());
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const text = await readActiveTabBodyText(electronApp);
    expect(text.length).toBeGreaterThan(50);
    expect(text).toMatch(/"url"|origin|headers/i);
});

test('7) остановка логирования — новые запросы не попадают в БД', async () => {
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    expect(sessionId).toBeTruthy();

    const before = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id }),
        sessionId
    );

    await mainWindow.evaluate(() => window.electronAPI.toggleLoggingStop());

    await navigateAndWait(electronApp, HTTPBIN_STATUS, 90_000, {
        urlIncludes: 'httpbin.org/status',
        allowEmptyBody: true,
    });

    const after = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id }),
        sessionId
    );

    expect(after).toBe(before);
});
