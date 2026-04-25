'use strict';

/**
 * E2E: MITM + AzureTLS worker — first navigation must render real HTML (no blank page).
 * Uses public HTTPS (httpbin.org); requires network. HTTP/2 remains default; HTTP/1.1 is only a fallback after connection errors.
 *
 * When `azuretls-go/bin/azuretls-worker-*` exists, main process prefers the Go upstream worker (no ffi-napi) — same NDJSON protocol as `azure-tls-worker.js`. Opt out: CUPNET_USE_GO_WORKER=0.
 *
 * Optional debug: CUPNET_AZURETLS_LOG=1 npm run test:e2e -- tests/e2e/mitm-azure-first-load.e2e.spec.js
 * Optional practicetestautomation regression: CUPNET_E2E_PRACTICE=1 npm run test:e2e -- tests/e2e/mitm-azure-first-load.e2e.spec.js
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
} = require('./helpers.js');

const HTTPBIN_GET = 'https://httpbin.org/get';
const HTTPBIN_HTML = 'https://httpbin.org/html';

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

test('ma1) first load active tab — httpbin GET returns JSON body (not blank)', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET, 90_000, {
        urlIncludes: 'httpbin.org',
        bodySnippet: '"url"',
    });
    const text = await readActiveTabBodyText(electronApp);
    expect(text.length).toBeGreaterThan(80);
    expect(text).toMatch(/"headers"|origin|"url"/i);
});

test('ma2) new tab — first navigation must render page (MITM cold path per tab)', async () => {
    await mainWindow.evaluate(async () => {
        await window.electronAPI.newTab(null);
    });
    await new Promise((r) => setTimeout(r, 800));

    await navigateAndWait(electronApp, HTTPBIN_HTML, 90_000, {
        urlIncludes: 'httpbin.org',
        bodySnippet: 'Moby',
    });
    const text = await readActiveTabBodyText(electronApp);
    expect(text.length).toBeGreaterThan(40);
    expect(text).toMatch(/Moby|Dick|Melville/i);
});

test('ma3) second URL same tab — still renders (regression: no stuck white screen)', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET, 90_000, {
        urlIncludes: 'httpbin.org',
        bodySnippet: '"url"',
    });
    const text = await readActiveTabBodyText(electronApp);
    expect(text.length).toBeGreaterThan(80);
});

const PRACTICE_LOGIN = 'https://practicetestautomation.com/practice-test-login/';
test('ma4) practicetestautomation.com — first paint (optional; CUPNET_E2E_PRACTICE=1)', async () => {
    test.skip(process.env.CUPNET_E2E_PRACTICE !== '1', 'Set CUPNET_E2E_PRACTICE=1 to run (slower, external site)');
    await navigateAndWait(electronApp, PRACTICE_LOGIN, 120_000, {
        urlIncludes: 'practicetestautomation.com',
        bodySnippet: 'username',
    });
    const text = await readActiveTabBodyText(electronApp);
    expect(text.length).toBeGreaterThan(200);
    expect(text).toMatch(/username|password|submit|login/i);
});
