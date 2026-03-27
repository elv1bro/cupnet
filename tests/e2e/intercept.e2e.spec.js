'use strict';

/**
 * E2E: intercept rules (block / mock / modifyHeaders) через MITM (planMitmIntercept).
 * Запуск: npm run test:e2e:intercept
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
    createInterceptRule,
    deleteAllInterceptRules,
} = require('./helpers.js');

const HTTPBIN_GET = 'https://httpbin.org/get';
const HTTPBIN_HEADERS = 'https://httpbin.org/headers';

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
    await deleteAllInterceptRules(mainWindow);
});

test.afterAll(async () => {
    try {
        await deleteAllInterceptRules(mainWindow);
    } catch {
        /* ignore */
    }
    if (electronApp) await electronApp.close();
});

test.beforeEach(async () => {
    await deleteAllInterceptRules(mainWindow);
    await mainWindow.evaluate(async () => {
        await window.electronAPI.newTab(null);
    });
    await new Promise((r) => setTimeout(r, 500));
});

test('i1) block — /headers отдаёт Blocked by CupNet', async () => {
    await createInterceptRule(mainWindow, {
        name: 'e2e-block-headers',
        type: 'block',
        url_pattern: '*httpbin.org/headers*',
        enabled: true,
        params: {},
    });
    await navigateAndWait(electronApp, HTTPBIN_HEADERS, 90_000, {
        urlIncludes: '',
        bodySnippet: 'Blocked by CupNet',
        minBodyLength: 1,
    });
    const text = await readActiveTabBodyText(electronApp);
    expect(text).toMatch(/Blocked by CupNet|403/i);
});

test('i2) mock — /get возвращает тело из правила', async () => {
    await createInterceptRule(mainWindow, {
        name: 'e2e-mock-get',
        type: 'mock',
        url_pattern: '*httpbin.org/get*',
        enabled: true,
        params: {
            body: '{"mocked":true,"e2e":1}',
            mimeType: 'application/json',
            status: 200,
        },
    });
    await navigateAndWait(electronApp, HTTPBIN_GET, 90_000, {
        bodySnippet: 'mocked',
        minBodyLength: 5,
    });
    const text = await readActiveTabBodyText(electronApp);
    expect(text).toContain('mocked');
    expect(text).toContain('true');
});

test('i3) modifyHeaders — запрос с X-CupNet-Test виден в JSON httpbin /headers', async () => {
    await createInterceptRule(mainWindow, {
        name: 'e2e-modify-headers',
        type: 'modifyHeaders',
        url_pattern: '*httpbin.org/headers*',
        enabled: true,
        params: {
            requestHeaders: { 'X-CupNet-Test': 'e2e-value' },
        },
    });
    await navigateAndWait(electronApp, HTTPBIN_HEADERS, 90_000, {
        bodySnippet: 'headers',
        minBodyLength: 20,
    });
    const text = (await readActiveTabBodyText(electronApp)).toLowerCase();
    expect(text.includes('x-cupnet-test') || text.includes('cupnet-test')).toBe(true);
    expect(text).toContain('e2e-value');
});

test('i4) после удаления правил — обычный /get с полями origin/url', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const text = await readActiveTabBodyText(electronApp);
    expect(text.length).toBeGreaterThan(50);
    expect(text).toMatch(/"url"|origin|headers/i);
});

test('i5) block — /headers на MITM-вкладке отдаёт Blocked by CupNet', async () => {
    await createInterceptRule(mainWindow, {
        name: 'e2e-block-headers-mitm',
        type: 'block',
        url_pattern: '*httpbin.org/headers*',
        enabled: true,
        params: {},
    });
    await navigateAndWait(electronApp, HTTPBIN_HEADERS, 90_000, {
        bodySnippet: 'Blocked',
        minBodyLength: 10,
    });
    const text = await readActiveTabBodyText(electronApp);
    expect(text).toContain('Blocked by CupNet');
});
