'use strict';

/**
 * E2E: Chrome-like omnibox (history suggestions, inline ghost, command palette, mod+Enter, site popover, search engine).
 * Requires network for httpbin.org (same as cupnet.e2e).
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    getActiveTabUrl,
} = require('./helpers.js');

const HTTPBIN_GET = 'https://httpbin.org/get';
const HTTPBIN_BYTES = 'https://httpbin.org/bytes/5';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

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
    try {
        if (mainWindow) {
            await mainWindow.evaluate(() =>
                window.electronAPI.saveSearchEngineSettings({ searchEngine: 'duckduckgo', searchEngineCustomUrl: '' })
            );
        }
    } catch {
        /* ignore */
    }
    if (electronApp) await electronApp.close();
});

test('omni-1) history suggestions API returns visited URL', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const rows = await mainWindow.evaluate(() => window.electronAPI.getOmniboxSuggestions('httpbin.org', 12));
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r) => String(r.url || '').includes('httpbin.org'))).toBe(true);
});

test('omni-2) inline ghost selection then Tab accepts', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const urlInput = mainWindow.locator('#url-input');
    await urlInput.click();
    await urlInput.fill('https://httpbin.org/ge');
    await mainWindow.waitForFunction(
        () => {
            const el = document.getElementById('url-input');
            if (!el) return false;
            const v = String(el.value || '');
            return v.length > 'https://httpbin.org/ge'.length && el.selectionEnd > el.selectionStart;
        },
        null,
        { timeout: 15_000 }
    );
    await urlInput.press('Tab');
    const after = await mainWindow.evaluate(() => {
        const el = document.getElementById('url-input');
        return { value: el?.value || '', start: el?.selectionStart ?? 0, end: el?.selectionEnd ?? 0 };
    });
    expect(after.start).toBe(after.end);
    expect(after.value).toContain('httpbin.org');
});

test('omni-3) Ctrl/Cmd+K opens command palette with >', async () => {
    const urlInput = mainWindow.locator('#url-input');
    await urlInput.click();
    await mainWindow.keyboard.press(`${MOD}+KeyK`);
    await expect(urlInput).toHaveValue(/^>\s*$/);
});

test('omni-4) mod+Enter opens a new tab', async () => {
    const n = await mainWindow.evaluate(async () => (await window.electronAPI.getTabs()).length);
    const urlInput = mainWindow.locator('#url-input');
    await urlInput.click();
    await urlInput.fill('about:blank');
    await mainWindow.keyboard.press(`${MOD}+Enter`);
    await mainWindow.waitForFunction(
        async (prev) => (await window.electronAPI.getTabs()).length > prev,
        n,
        { timeout: 15_000 }
    );
    const after = await mainWindow.evaluate(async () => (await window.electronAPI.getTabs()).length);
    expect(after).toBeGreaterThan(n);
});

test('omni-5) site info popover opens', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const pop = mainWindow.locator('#site-info-popover');
    await mainWindow.locator('#site-info-btn').click();
    await expect(pop).not.toHaveClass(/hidden/);
    await mainWindow.keyboard.press('Escape');
});

test('omni-6) search engine setting persists (Google)', async () => {
    await mainWindow.evaluate(() =>
        window.electronAPI.saveSearchEngineSettings({ searchEngine: 'google', searchEngineCustomUrl: '' })
    );
    const s = await mainWindow.evaluate(() => window.electronAPI.getSettingsAll());
    expect(s?.searchEngine).toBe('google');
});

test('omni-7) switch to matching tab via suggestion row', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    await mainWindow.evaluate(() => window.electronAPI.newTab(null));
    await new Promise((r) => setTimeout(r, 400));
    await navigateAndWait(electronApp, HTTPBIN_BYTES);

    const firstId = await mainWindow.evaluate(async () => {
        const tabs = await window.electronAPI.getTabs();
        const get = tabs.find((t) => String(t.url || '').includes('/get'));
        return get ? get.id : null;
    });
    expect(firstId).toBeTruthy();

    await mainWindow.evaluate((id) => window.electronAPI.switchTab(id), firstId);
    await new Promise((r) => setTimeout(r, 300));
    let activeGet = await getActiveTabUrl(electronApp);
    expect(activeGet).toContain('httpbin.org/get');

    const urlInput = mainWindow.locator('#url-input');
    await urlInput.click();
    await urlInput.fill('bytes/5');
    await mainWindow.waitForFunction(
        () => {
            const el = document.getElementById('command-palette');
            return el && !el.classList.contains('hidden');
        },
        null,
        { timeout: 10_000 }
    );
    await new Promise((r) => setTimeout(r, 400));
    await mainWindow.keyboard.press('ArrowDown');
    await mainWindow.keyboard.press('Enter');

    await expect
        .poll(() => getActiveTabUrl(electronApp), { timeout: 20_000 })
        .toContain('bytes/5');
});
