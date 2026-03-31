'use strict';

/**
 * E2E: исходящий User-Agent после MITM — без CupNet/Electron (Chrome-like).
 * В рендерере navigator.userAgent может оставаться строкой Electron — правка на wire.
 * Запуск: npm run test:e2e — или playwright test tests/e2e/user-agent.e2e.spec.js
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
    getActiveTabNavigatorUserAgent,
} = require('./helpers.js');

const HTTPBIN_HEADERS = 'https://httpbin.org/headers';

/** При `CUPNET_DISABLE_UA_SANITIZE=1` весь suite пропускается. */
const describeUa =
    process.env.CUPNET_DISABLE_UA_SANITIZE === '1' ? test.describe.skip : test.describe;

describeUa('user-agent e2e (MITM outbound)', () => {
    test.describe.configure({ mode: 'serial' });

    let electronApp;

    function assertChromeLikeWireUserAgent(ua) {
        expect(ua, 'UA не пустой').toBeTruthy();
        expect(String(ua)).not.toMatch(/cupnet/i);
        expect(String(ua)).not.toMatch(/\bElectron\//i);
        expect(String(ua)).toMatch(/Chrome\/[\d.]+/);
        expect(String(ua)).toMatch(/Safari\/[\d.]+/);
    }

    test.beforeAll(async () => {
        electronApp = await launchCupnet();
        const mainWindow = await electronApp.firstWindow({ timeout: 120_000 });
        await mainWindow.waitForLoadState('domcontentloaded');
        await waitForAppContext(electronApp, 120_000);
        await waitMitmReady(electronApp, 180_000);
    });

    test.afterAll(async () => {
        if (electronApp) await electronApp.close();
    });

    test('navigator.userAgent в рендерере — строка Electron/Chromium (может содержать CupNet)', async () => {
        const ua = await getActiveTabNavigatorUserAgent(electronApp);
        expect(ua).toBeTruthy();
        expect(String(ua)).toMatch(/Chrome\/[\d.]+/);
    });

    test('httpbin.org/headers — User-Agent в запросе Chrome-like (нормализация в MITM)', async () => {
        await navigateAndWait(electronApp, HTTPBIN_HEADERS, 90_000, { urlIncludes: 'httpbin.org' });

        const bodyText = await readActiveTabBodyText(electronApp);
        expect(bodyText.length).toBeGreaterThan(20);
        let data;
        try {
            data = JSON.parse(bodyText);
        } catch (e) {
            throw new Error(`httpbin body is not JSON: ${String(e?.message || e)} snippet=${bodyText.slice(0, 120)}`);
        }
        const sentUa = data?.headers?.['User-Agent'] || data?.headers?.['user-agent'];
        expect(sentUa, 'httpbin отдал User-Agent в headers').toBeTruthy();
        assertChromeLikeWireUserAgent(sentUa);
    });
});
