'use strict';

/**
 * Cookie Manager flows via IPC (requires network for httpbin).
 */
const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
    openNewTabWithFreshCookieGroupAndCupnet,
} = require('./helpers.js');

const HTTPBIN_SET = 'https://httpbin.org/cookies/set?cupnet_mgr=e2e';
const HTTPBIN_COOKIES = 'https://httpbin.org/cookies';

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

test('cm1) set-cookie via IPC — visible on /cookies', async () => {
    const tabId = await mainWindow.evaluate(async () => {
        const tabs = await window.electronAPI.getTabs();
        const a = tabs.find((t) => t.isActive);
        return a?.id;
    });
    expect(tabId).toBeTruthy();

    const setRes = await mainWindow.evaluate(
        async (tid) =>
            window.electronAPI.setCookie(tid, {
                url: 'https://httpbin.org/',
                name: 'cupnet_ipc',
                value: 'ok',
                path: '/',
                secure: true,
            }),
        tabId
    );
    expect(setRes?.success).toBe(true);

    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    const body = await readActiveTabBodyText(electronApp);
    expect(body).toContain('cupnet_ipc');
});

test('cm2) get-cookies — contains httpbin cookies', async () => {
    const tabId = await mainWindow.evaluate(async () => {
        const tabs = await window.electronAPI.getTabs();
        return tabs.find((t) => t.isActive)?.id;
    });
    const list = await mainWindow.evaluate(
        async (tid) => window.electronAPI.getCookies(tid, { domain: 'httpbin.org' }),
        tabId
    );
    expect(Array.isArray(list)).toBe(true);
    const names = (list || []).map((c) => c.name);
    expect(names.some((n) => n === 'cupnet_ipc')).toBe(true);
});

test('cm3) remove-cookie — cookie gone', async () => {
    const tabId = await mainWindow.evaluate(async () => {
        const tabs = await window.electronAPI.getTabs();
        return tabs.find((t) => t.isActive)?.id;
    });
    await mainWindow.evaluate(
        async (tid) =>
            window.electronAPI.removeCookie(tid, {
                name: 'cupnet_ipc',
                domain: 'httpbin.org',
                path: '/',
                secure: true,
            }),
        tabId
    );
    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    const body = await readActiveTabBodyText(electronApp);
    expect(body).not.toContain('cupnet_ipc');
});

test('cm4) clear-cookies clears jar for tab', async () => {
    await navigateAndWait(electronApp, HTTPBIN_SET);
    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    let body = await readActiveTabBodyText(electronApp);
    expect(body).toContain('cupnet_mgr');

    const tabId = await mainWindow.evaluate(async () => {
        const tabs = await window.electronAPI.getTabs();
        return tabs.find((t) => t.isActive)?.id;
    });
    const clearRes = await mainWindow.evaluate(async (tid) => window.electronAPI.clearCookies(tid), tabId);
    expect(clearRes?.success).toBe(true);

    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    body = await readActiveTabBodyText(electronApp);
    expect(body).not.toContain('cupnet_mgr');
});

test('cm5) cookie group + tab switch — isolated from shared', async () => {
    await openNewTabWithFreshCookieGroupAndCupnet(mainWindow);
    await navigateAndWait(electronApp, HTTPBIN_SET);
    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    let body = await readActiveTabBodyText(electronApp);
    expect(body).toContain('cupnet_mgr');

    const tabs = await mainWindow.evaluate(async () => window.electronAPI.getTabs());
    const withCookie = tabs.find((t) => t.isActive);
    expect(withCookie?.id).toBeTruthy();

    const other = tabs.find((t) => t.id !== withCookie.id);
    expect(other?.id).toBeTruthy();

    await mainWindow.evaluate(async (id) => window.electronAPI.switchTab(id), other.id);
    await new Promise((r) => setTimeout(r, 400));
    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    body = await readActiveTabBodyText(electronApp);
    expect(body).not.toContain('cupnet_mgr');
});

test('cm6) share-cookies — target tab receives cookies', async () => {
    await mainWindow.evaluate(async () => {
        await window.electronAPI.newTab(null);
    });
    await new Promise((r) => setTimeout(r, 500));

    const { fromId, toId } = await mainWindow.evaluate(async () => {
        const tabs = await window.electronAPI.getTabs();
        if (tabs.length < 2) throw new Error('need 2 tabs');
        const a = tabs[tabs.length - 2];
        const b = tabs[tabs.length - 1];
        await window.electronAPI.switchTab(a.id);
        return { fromId: a.id, toId: b.id };
    });

    await navigateAndWait(electronApp, 'https://httpbin.org/cookies/set?share_test=1');
    const shareRes = await mainWindow.evaluate(
        async ({ f, t }) => window.electronAPI.shareCookies(f, t, 'httpbin.org'),
        { f: fromId, t: toId }
    );
    expect(shareRes?.success).toBe(true);
    expect(shareRes?.count).toBeGreaterThan(0);

    await mainWindow.evaluate(async (id) => window.electronAPI.switchTab(id), toId);
    await new Promise((r) => setTimeout(r, 400));
    await navigateAndWait(electronApp, HTTPBIN_COOKIES);
    const body = await readActiveTabBodyText(electronApp);
    expect(body).toContain('share_test');
});
