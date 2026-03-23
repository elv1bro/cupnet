'use strict';

/**
 * E2E: MITM, connect-direct, check-ip-geo, вкладки, отсутствие типичных TLS ошибок в sys log.
 * Запуск: npm run test:e2e:traffic
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
    getAppCtxProxy,
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

test('t1) MITM готов, в контексте режим mitm', async () => {
    const ready = await electronApp.evaluate(() => globalThis.__cupnetAppContext?.mitm?.ready === true);
    expect(ready).toBe(true);
    const proxy = await getAppCtxProxy(electronApp);
    expect(proxy).toBeTruthy();
    expect(String(proxy.trafficMode || '').toLowerCase()).toContain('mitm');
});

test('t2) connect-direct — навигация на httpbin/get без cupnet_pass_through в теле', async () => {
    const res = await mainWindow.evaluate(() => window.electronAPI.connectDirect('chrome'));
    expect(res?.success !== false).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const text = await readActiveTabBodyText(electronApp);
    expect(text).not.toContain('cupnet_pass_through');
    expect(text.length).toBeGreaterThan(50);
});

test('t3) check-ip-geo — есть строковый ip, нет ошибки pass-through', async () => {
    const geo = await mainWindow.evaluate(() => window.electronAPI.checkIpGeo());
    expect(geo).toBeTruthy();
    if (geo && geo.error === 'cupnet_pass_through') {
        throw new Error(`checkIpGeo pass-through: ${geo.message || ''}`);
    }
    expect(typeof geo.ip).toBe('string');
    expect(geo.ip.length).toBeGreaterThan(3);
});

test('t4) изолированная вкладка — загрузка httpbin/get', async () => {
    await mainWindow.evaluate(() => window.electronAPI.newIsolatedTab());
    await new Promise((r) => setTimeout(r, 750));
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const text = await readActiveTabBodyText(electronApp);
    expect(text).not.toContain('cupnet_pass_through');
    expect(text.length).toBeGreaterThan(40);
});

test('t5) direct-вкладка + getDirectIp — ip строка', async () => {
    await mainWindow.evaluate(() => window.electronAPI.newDirectTab());
    await new Promise((r) => setTimeout(r, 750));
    const direct = await mainWindow.evaluate(() => window.electronAPI.getDirectIp());
    expect(direct).toBeTruthy();
    expect(typeof direct.ip).toBe('string');
});

test('t6) sys log — нет net_error -207 / ERR_CERT_INVALID в последних записях', async () => {
    const entries = await mainWindow.evaluate(() => window.electronAPI.getSysLog(null, 800));
    const blob = Array.isArray(entries)
        ? entries
              .map((e) =>
                  `${e?.level || ''} ${e?.module || ''} ${e?.message || ''} ${e?.data != null ? JSON.stringify(e.data) : ''}`
              )
              .join('\n')
        : String(entries || '');
    expect(blob.toLowerCase()).not.toContain('net_error -207');
    expect(blob).not.toContain('ERR_CERT_INVALID');
});
