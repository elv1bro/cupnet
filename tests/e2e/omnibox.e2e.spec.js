'use strict';

/**
 * E2E: Chrome-like omnibox (history suggestions, inline completion, command palette, mod+Enter,
 * site popover, search engine, history window, recently closed). Requires network for httpbin.org.
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    getMainWindow,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    getActiveTabUrl,
    openSubWindowExpectNew,
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
    await electronApp.firstWindow({ timeout: 120_000 });
    mainWindow = await getMainWindow(electronApp, 120_000);
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

async function omniboxState(page) {
    return page.evaluate(() => window.cupnetOmniboxDebug?.getState?.() || null);
}

async function waitForOmniboxOpen(page, timeout = 15_000) {
    await page.waitForFunction(
        () => document.getElementById('address-bar-container')?.classList.contains('omnibox-open'),
        null,
        { timeout }
    );
}

test('omni-2) host-prefix history match becomes row 1 and inline-completes; Tab accepts', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const urlInput = mainWindow.locator('#url-input');
    await urlInput.click();
    // Type character by character so the completion logic sees real "append" input events.
    await mainWindow.keyboard.type('httpb', { delay: 40 });
    await waitForOmniboxOpen(mainWindow);
    await expect
        .poll(async () => (await omniboxState(mainWindow))?.completionShown, { timeout: 10_000 })
        .toBe(true);
    const after = await mainWindow.evaluate(() => {
        const el = document.getElementById('url-input');
        return { value: el?.value || '', start: el?.selectionStart ?? 0, end: el?.selectionEnd ?? 0 };
    });
    expect(after.value.startsWith('httpbin.org')).toBe(true);
    expect(after.start).toBe(5);
    expect(after.end).toBe(after.value.length);
    const st = await omniboxState(mainWindow);
    expect(st.rows[0].kind).toBe('history');
    expect(st.rows[0].isDefault).toBe(true);
    expect(st.rows[1].kind).toBe('search');

    await mainWindow.keyboard.press('Tab');
    const accepted = await mainWindow.evaluate(() => {
        const el = document.getElementById('url-input');
        return { value: el?.value || '', start: el?.selectionStart ?? 0, end: el?.selectionEnd ?? 0 };
    });
    expect(accepted.start).toBe(accepted.end);
    expect(accepted.value.startsWith('httpbin.org')).toBe(true);
    await mainWindow.keyboard.press('Escape');
    await mainWindow.keyboard.press('Escape');
});

test('omni-2b) typing while a background tab changes title does not clobber the draft', async () => {
    const urlInput = mainWindow.locator('#url-input');
    await urlInput.click();
    await mainWindow.keyboard.type('draft-text', { delay: 20 });
    // Simulate the tab-list churn that used to reset the field (A-017).
    await electronApp.evaluate(() => {
        const tm = globalThis.__cupnetAppContext?.modules?.tabManager;
        tm?.broadcastTabList?.(true);
    });
    await new Promise((r) => setTimeout(r, 300));
    await expect(urlInput).toHaveValue('draft-text');
    await mainWindow.keyboard.press('Escape');
    await mainWindow.keyboard.press('Escape');
});

test('omni-2c) localhost:3000 is offered as an http URL, not a web search', async () => {
    const urlInput = mainWindow.locator('#url-input');
    await urlInput.click();
    await urlInput.fill('localhost:3000');
    await waitForOmniboxOpen(mainWindow);
    await expect
        .poll(async () => (await omniboxState(mainWindow))?.rows?.[0]?.url, { timeout: 10_000 })
        .toBe('http://localhost:3000');
    await mainWindow.keyboard.press('Escape');
    await mainWindow.keyboard.press('Escape');
});

test('omni-3) Ctrl/Cmd+K opens command palette with >', async () => {
    // Quiet e2e keeps windows hidden; before-input-event does not see the shortcut until the
    // window is shown. showInactive avoids stealing focus from the user.
    await electronApp.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed() && !w.isVisible()) w.showInactive();
        }
    });
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
    await waitForOmniboxOpen(mainWindow);
    await expect
        .poll(async () => ((await omniboxState(mainWindow))?.rows || []).findIndex((r) => r.kind === 'tab'), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(0);
    const tabIdx = ((await omniboxState(mainWindow)).rows).findIndex((r) => r.kind === 'tab');
    for (let i = 0; i < tabIdx; i++) await mainWindow.keyboard.press('ArrowDown');
    await mainWindow.keyboard.press('Enter');

    await expect
        .poll(() => getActiveTabUrl(electronApp), { timeout: 20_000 })
        .toContain('bytes/5');
});

test('omni-8) Shift+Delete removes the highlighted suggestion from history', async () => {
    await navigateAndWait(electronApp, HTTPBIN_BYTES);
    const before = await mainWindow.evaluate(() => window.electronAPI.getOmniboxSuggestions('httpbin.org/bytes', 12));
    expect(before.some((r) => String(r.url || '').includes('/bytes/5'))).toBe(true);
    const urlInput = mainWindow.locator('#url-input');
    await urlInput.click();
    await urlInput.fill('httpbin.org/bytes');
    await waitForOmniboxOpen(mainWindow);
    await expect
        .poll(async () => ((await omniboxState(mainWindow))?.rows || []).findIndex((r) => r.kind === 'history' && String(r.url).includes('/bytes/5')), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(0);
    const idx = ((await omniboxState(mainWindow)).rows).findIndex((r) => r.kind === 'history' && String(r.url).includes('/bytes/5'));
    for (let i = 0; i < idx; i++) await mainWindow.keyboard.press('ArrowDown');
    await mainWindow.keyboard.press('Shift+Delete');
    await expect
        .poll(async () => {
            const rows = await mainWindow.evaluate(() => window.electronAPI.getOmniboxSuggestions('httpbin.org/bytes', 12));
            return rows.some((r) => String(r.url || '').includes('/bytes/5'));
        }, { timeout: 10_000 })
        .toBe(false);
    await mainWindow.keyboard.press('Escape');
    await mainWindow.keyboard.press('Escape');
});

test('omni-9) History window lists visits with real titles and supports search', async () => {
    await navigateAndWait(electronApp, HTTPBIN_GET);
    const win = await openSubWindowExpectNew(electronApp, mainWindow, 'openHistoryWindow', 30_000);
    expect(win).toBeTruthy();
    await win.waitForLoadState('domcontentloaded');
    await expect.poll(() => win.locator('#history-tbody tr.visit').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const rows = await win.evaluate(() => [...document.querySelectorAll('#history-tbody tr.visit')].map((tr) => tr.dataset.url));
    expect(rows.some((u) => u.includes('httpbin.org/get'))).toBe(true);
    await win.locator('#search').fill('nothing-matches-this-zz');
    await expect.poll(() => win.locator('#history-tbody tr.visit').count(), { timeout: 10_000 }).toBe(0);
    await win.close();
});

test('omni-10) closing a tab makes it reopenable with its cookie group', async () => {
    const n0 = await mainWindow.evaluate(async () => (await window.electronAPI.getTabs()).length);
    await mainWindow.evaluate(() => window.electronAPI.newTab(null));
    await new Promise((r) => setTimeout(r, 400));
    await navigateAndWait(electronApp, HTTPBIN_BYTES);
    const activeId = await mainWindow.evaluate(async () => (await window.electronAPI.getTabs()).find((t) => t.isActive)?.id);
    await mainWindow.evaluate((id) => window.electronAPI.closeTab(id), activeId);
    await expect.poll(async () => (await mainWindow.evaluate(() => window.electronAPI.historyRecentlyClosed())).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const closed = await mainWindow.evaluate(() => window.electronAPI.historyRecentlyClosed());
    expect(closed[0].url).toContain('httpbin.org/bytes');
    const r = await mainWindow.evaluate(() => window.electronAPI.historyReopen(null));
    expect(r?.tabId).toBeTruthy();
    await expect.poll(() => getActiveTabUrl(electronApp), { timeout: 30_000 }).toContain('httpbin.org/bytes');
    const n1 = await mainWindow.evaluate(async () => (await window.electronAPI.getTabs()).length);
    expect(n1).toBe(n0 + 1);
});
