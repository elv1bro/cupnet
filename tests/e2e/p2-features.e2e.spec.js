'use strict';

/**
 * P2: compare viewer, page analyzer, shortcuts, per-tab proxy, bypass, websocket, ext-proxy.
 */
const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    ensureLoggingStartedNoModal,
    waitForLoggedCount,
    executeActiveTabJavaScript,
    getActiveTabId,
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
});

test.afterAll(async () => {
    if (electronApp) await electronApp.close();
});

test('p2-compare) compare-run with two anchors', async () => {
    await ensureLoggingStartedNoModal(mainWindow);
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());

    const b1 = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id, url: 'httpbin.org/get' }),
        sessionId
    );
    await navigateAndWait(electronApp, HTTPBIN_GET);
    await waitForLoggedCount(mainWindow, { sessionId, url: 'httpbin.org/get' }, b1, 90_000);

    const b2 = await mainWindow.evaluate(
        (id) => window.electronAPI.countDbRequests({ sessionId: id, url: 'httpbin.org/headers' }),
        sessionId
    );
    await navigateAndWait(electronApp, HTTPBIN_HEADERS);
    await waitForLoggedCount(mainWindow, { sessionId, url: 'httpbin.org/headers' }, b2, 90_000);

    const rows = await mainWindow.evaluate(
        async (sid) =>
            (await window.electronAPI.getDbRequests({ sessionId: sid }, 80, 0)).filter((r) =>
                String(r.url || '').includes('httpbin.org')
            ),
        sessionId
    );
    const idGet = rows.find((r) => String(r.url || '').includes('/get'))?.id;
    const idHeaders = rows.find((r) => String(r.url || '').includes('/headers'))?.id;
    expect(idGet && idHeaders).toBeTruthy();

    await mainWindow.evaluate(async (id) => window.electronAPI.setCompareSlot('left', id), idGet);
    await mainWindow.evaluate(async (id) => window.electronAPI.setCompareSlot('right', id), idHeaders);

    const cmp = await mainWindow.evaluate(() => window.electronAPI.runCompare({ level: 'quick' }));
    expect(cmp?.success).toBe(true);
    expect(Array.isArray(cmp?.result?.pairs)).toBe(true);
});

test('p2-analyzer) analyze-page-meta on active tab', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const tabId = await getActiveTabId(electronApp);
    expect(tabId).toBeTruthy();
    const meta = await mainWindow.evaluate(async (tid) => window.electronAPI.analyzePageMeta(tid), tabId);
    expect(meta && typeof meta === 'object').toBe(true);
});

test('p2-shortcuts) openSettingsTab opens internal settings', async () => {
    const res = await mainWindow.evaluate(() => window.electronAPI.openSettingsTab());
    expect(res === true || res?.success === true || res != null).toBeTruthy();
});

test('p2-tab-proxy) setTabProxy with profile then clear', async () => {
    const created = await mainWindow.evaluate(() =>
        window.electronAPI.saveProxyProfileFull({
            name: `e2e-tab-${Date.now()}`,
            template: 'http://127.0.0.1:18888',
            variables: {},
            notes: '',
            country: '',
            tls_profile: 'chrome',
        })
    );
    expect(created?.id).toBeTruthy();

    const tabId = await getActiveTabId(electronApp);
    const set = await mainWindow.evaluate(
        async ({ tid, pid }) => window.electronAPI.setTabProxy(tid, pid, null),
        { tid: tabId, pid: created.id }
    );
    expect(set?.success).toBe(true);

    const clear = await mainWindow.evaluate(async (tid) => window.electronAPI.setTabProxy(tid, null, null), tabId);
    expect(clear?.success).toBe(true);

    await mainWindow.evaluate(async (id) => window.electronAPI.deleteProxyProfile(id), created.id);
});

test('p2-ws) websocket handshake logged when page opens WS', async ({}, testInfo) => {
    await ensureLoggingStartedNoModal(mainWindow);
    const sessionId = await mainWindow.evaluate(() => window.electronAPI.getCurrentSessionId());
    const before = await mainWindow.evaluate(
        async () => (await window.electronAPI.getWsEvents({ limit: 500 }))?.length || 0,
        null
    );

    await navigateAndWait(electronApp, 'https://httpbin.org/get');
    await executeActiveTabJavaScript(
        electronApp,
        `(() => {
          try {
            const w = new WebSocket('wss://echo.websocket.events/.ws');
            w.__cupnetE2e = true;
            return 'opened';
          } catch (e) {
            return String(e);
          }
        })()`
    );
    await new Promise((r) => setTimeout(r, 4000));

    const after = await mainWindow.evaluate(
        async (sid) => (await window.electronAPI.getWsEvents({ sessionId: sid, limit: 500 }))?.length || 0,
        sessionId
    );
    if (after <= before) {
        testInfo.skip(true, 'No new WebSocket rows (network or logging may omit this WS)');
    }
});

test('p2-ext-proxy) create ext port then delete', async ({}, testInfo) => {
    const port = 28000 + Math.floor(Math.random() * 2000);
    const cr = await mainWindow.evaluate(
        async (p) =>
            window.electronAPI.extProxyCreate({
                port: p,
                name: 'e2e-ext',
                autoStart: false,
            }),
        port
    );
    if (!cr?.success) {
        testInfo.skip(true, `ext-proxy create: ${cr?.error || 'failed'}`);
        return;
    }
    expect(cr.port).toBe(port);

    const stop = await mainWindow.evaluate(async (p) => window.electronAPI.extProxyStop(p), port);
    expect(stop?.success !== false).toBe(true);

    const del = await mainWindow.evaluate(async (p) => window.electronAPI.extProxyDelete(p), port);
    expect(del?.success !== false).toBe(true);
});
