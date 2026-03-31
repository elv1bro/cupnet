'use strict';

/**
 * E2E: открытие/закрытие вспомогательных окон (Playwright + Electron).
 * Запуск: npm run test:e2e:windows
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    openSubWindowExpectNew,
    getWindowCount,
    closeAllExcept,
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
    await waitMitmReady(electronApp, 180_000);
});

test.afterAll(async () => {
    if (electronApp) await electronApp.close();
});

/**
 * Открыть через IPC; если появилось новое окно — закрыть его. Иначе только проверить, что invoke не упал.
 */
async function openAndCloseIfNew(methodName) {
    const n0 = getWindowCount(electronApp);
    await expect(
        mainWindow.evaluate(async (name) => {
            const api = window.electronAPI;
            const fn = api && api[name];
            if (typeof fn !== 'function') throw new Error(`no electronAPI.${name}`);
            return fn.call(api);
        }, methodName)
    ).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 600));
    const n1 = getWindowCount(electronApp);
    if (n1 > n0) {
        const pages = electronApp.windows();
        const newest = pages[pages.length - 1];
        if (newest && newest !== mainWindow) {
            await newest.close().catch(() => {});
        }
    }
    await new Promise((r) => setTimeout(r, 300));
}

test('w1) Log Viewer — IPC без падения процесса', async () => {
    await openAndCloseIfNew('openLogViewer');
});

test('w2) Proxy Manager — новое окно, закрытие', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openProxyManager');
    if (extra) await extra.close().catch(() => {});
});

test('w3) Rules — новое окно, закрытие', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openRulesWindow');
    if (extra) await extra.close().catch(() => {});
});

test('w4) Cookie Manager — новое окно, закрытие', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openCookieManager');
    if (extra) await extra.close().catch(() => {});
});

test('w5) DNS Manager — новое окно, закрытие', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openDnsManager');
    if (extra) await extra.close().catch(() => {});
});

test('w6) Request Editor — первое открытие создаёт окно, повтор без второго окна', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openRequestEditor');
    if (extra) {
        const nAfterFirst = electronApp.windows().length;
        await mainWindow.evaluate(async () => {
            await window.electronAPI.openRequestEditor(null);
        });
        await new Promise((r) => setTimeout(r, 500));
        expect(electronApp.windows().length).toBe(nAfterFirst);
        await extra.close().catch(() => {});
    }
});

test('w7) Console Viewer — новое окно, закрытие', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openConsoleViewer');
    if (extra) await extra.close().catch(() => {});
});

test('w8) Page Analyzer — новое окно, закрытие', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openPageAnalyzer');
    if (extra) await extra.close().catch(() => {});
});

test('w9) API Scout (IVAC) — новое окно, закрытие', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openIvacScout');
    if (extra) await extra.close().catch(() => {});
});

test('w10) Trace Viewer — после включения trace появляется окно', async () => {
    const n0 = getWindowCount(electronApp);
    await mainWindow.evaluate(async () => {
        await window.electronAPI.setTraceMode(true);
        await window.electronAPI.openTraceViewer();
    });
    await new Promise((r) => setTimeout(r, 800));
    const n1 = getWindowCount(electronApp);
    if (n1 > n0) {
        const pages = electronApp.windows();
        const newest = pages[pages.length - 1];
        if (newest && newest !== mainWindow) await newest.close().catch(() => {});
    }
    await mainWindow.evaluate(async () => {
        await window.electronAPI.setTraceMode(false);
    });
    expect(n1).toBeGreaterThan(n0);
});

test('w11) Compare Viewer — новое окно, закрытие', async () => {
    const extra = await openSubWindowExpectNew(electronApp, mainWindow, 'openCompareViewer');
    if (extra) await extra.close().catch(() => {});
});

test('w12) стресс: открыть несколько окон подряд, затем закрыть все кроме главного', async () => {
    const methods = [
        'openProxyManager',
        'openRulesWindow',
        'openCookieManager',
        'openDnsManager',
        'openConsoleViewer',
        'openCompareViewer',
    ];
    for (const m of methods) {
        await mainWindow.evaluate(async (name) => {
            const api = window.electronAPI;
            const fn = api && api[name];
            if (typeof fn === 'function') await fn.call(api);
        }, m);
        await new Promise((r) => setTimeout(r, 400));
    }
    await closeAllExcept(electronApp, mainWindow);
    await new Promise((r) => setTimeout(r, 500));
    expect(getWindowCount(electronApp)).toBe(1);
});
