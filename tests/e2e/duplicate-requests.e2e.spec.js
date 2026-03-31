'use strict';

/**
 * E2E: no duplicate DB rows for the same (tab, method, url, status) after httpbin.org/ loads.
 * Main page pulls CSS/JS/fonts — good coverage for subresource dedup.
 * Needs network. Run: npm run test:e2e — or playwright test tests/e2e/duplicate-requests.e2e.spec.js
 *
 * Optional: CUPNET_E2E_SKIP_DUP_CHECK=1 skips the assertion (diagnostics only).
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    findDuplicateRequestGroups,
    waitForStableDbRequestCount,
} = require('./helpers.js');

/** Swagger / static assets — many subrequests (fonts, CSS, JS). */
const HTTPBIN_ROOT = 'https://httpbin.org/';

const skipDupAssert = process.env.CUPNET_E2E_SKIP_DUP_CHECK === '1';

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

    const startRes = await mainWindow.evaluate(() => window.electronAPI.toggleLoggingStart('e2e-dup'));
    if (startRes?.status === 'modal_shown') {
        await mainWindow.evaluate(() =>
            window.electronAPI.confirmLoggingStart({ mode: 'continue', renameOld: null })
        );
    } else {
        expect(['started', 'already_on']).toContain(startRes?.status);
    }
});

test.afterAll(async () => {
    if (electronApp) await electronApp.close();
});

test('httpbin.org/ — no duplicate log rows (same tab+method+url+status)', async () => {
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    expect(sessionId).toBeTruthy();

    await navigateAndWait(electronApp, HTTPBIN_ROOT, 90_000, {
        urlIncludes: 'httpbin.org',
        bodySnippet: 'httpbin',
    });
    await waitForStableDbRequestCount(mainWindow, { sessionId, url: 'httpbin.org' }, 8000, 90_000, 2500);

    const rows = await mainWindow.evaluate(
        async (id) => {
            const api = window.electronAPI;
            if (!api?.getDbRequests) return [];
            return api.getDbRequests({ sessionId: id, url: 'httpbin.org' }, 8000, 0);
        },
        sessionId
    );

    const fontish = /\.(woff2?|ttf|otf)(\?|$)/i;
    const rowsFontOrCss = rows.filter((r) => {
        const u = String(r.url || '');
        return fontish.test(u) || /\.css(\?|$)/i.test(u);
    });

    const dupsAll = findDuplicateRequestGroups(rows);
    const dupsFontish = findDuplicateRequestGroups(rowsFontOrCss);

    if (skipDupAssert) {
        console.log('[e2e dup] dupsAll:', dupsAll.length, 'dupsFontish:', dupsFontish.length);
        return;
    }

    expect(
        dupsAll,
        `any duplicate: ${dupsAll.map((d) => `${d.key} x${d.count}`).join('; ') || 'none'}`
    ).toEqual([]);

    expect(
        dupsFontish,
        `font/css duplicate: ${dupsFontish.map((d) => `${d.key} x${d.count}`).join('; ') || 'none'}`
    ).toEqual([]);
});
