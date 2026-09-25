'use strict';

/**
 * E2E: Proxy Manager window — Simple (one card) vs Advanced (full editor) modes, inline provider
 * credentials, Direct entry and the static list import (identity lives only in Browser ID). No external network
 * needed (profiles are only saved, never connected).
 */
const { test, expect } = require('@playwright/test');
const { launchCupnet, getMainWindow, waitForAppContext, waitMitmReady, waitForWindowByTitle } = require('./helpers.js');

test.describe.configure({ mode: 'serial' });

let electronApp;
/** @type {import('@playwright/test').Page} */
let mainWindow;
/** @type {import('@playwright/test').Page} */
let pm;
const createdIds = [];
const USER = `e2e-nm-user-${Date.now()}`;
const PASS = 'e2e p@ss:word';

async function listProfiles() {
    return mainWindow.evaluate(() => window.electronAPI.getProxyProfiles());
}

test.beforeAll(async () => {
    electronApp = await launchCupnet();
    await electronApp.firstWindow({ timeout: 120_000 });
    await waitForAppContext(electronApp, 120_000);
    mainWindow = await getMainWindow(electronApp, 60_000);
    await mainWindow.waitForLoadState('domcontentloaded');
    await waitMitmReady(electronApp, 180_000);
    await mainWindow.evaluate(() => window.electronAPI.openProxyManager());
    pm = await waitForWindowByTitle(electronApp, 'Proxy Manager', 25_000);
    // window.confirm() (discard unsaved changes) is a native dialog: accept it, Playwright dismisses by default.
    pm.on('dialog', (d) => d.accept().catch(() => {}));
    await pm.waitForLoadState('domcontentloaded');
    await pm.locator('#editor-mode-seg').waitFor({ timeout: 15_000 });
});

test.afterAll(async () => {
    try {
        for (const id of createdIds) await mainWindow.evaluate((i) => window.electronAPI.deleteProxyProfileById(i), id);
    } catch { /* ignore */ }
    if (electronApp) await electronApp.close();
});

test('pm1) Simple mode is a separate one-card editor: provider chips, no tabs / templates / MITM stats', async () => {
    await expect(pm.locator('body')).toHaveAttribute('data-editor-mode', 'simple');
    await expect(pm.locator('#mitm-stats')).toBeHidden();
    await expect(pm.locator('.sidebar-filters-row')).toBeHidden();
    await pm.click('#btn-simple-new');
    await expect(pm.locator('#simple-editor')).toBeVisible();
    await expect(pm.locator('#editor-wrap')).toBeHidden();
    await expect(pm.locator('#tab-btn-identity')).toHaveCount(0); // identity lives only in Browser ID
    await expect(pm.locator('#f-template')).toBeHidden();
    const chips = await pm.locator('#se-providers .se-chip').evaluateAll((els) => els.map((e) => e.dataset.provider));
    expect(chips).toContain('nodemaven');
    expect(chips).toContain('decodo');
    expect(chips.length).toBeGreaterThanOrEqual(4);
    await expect(pm.locator('#se-save-connect')).toBeVisible();
    await expect(pm.locator('#simple-identity-text')).toHaveCount(0); // no identity control in the proxy manager
});

test('pm2) Simple: NodeMaven + credentials + country → saved with encrypted URL, masked display, username kept', async () => {
    await pm.click('#se-providers .se-chip[data-provider="nodemaven"]');
    await pm.fill('#se-user', USER);
    await pm.fill('#se-pass', PASS);
    await pm.selectOption('#se-country', 'de');
    await expect(pm.locator('#se-name')).toHaveValue(/NodeMaven · Germany/);
    await pm.click('#se-save');
    await expect(pm.locator('#se-status')).toContainText('Saved', { timeout: 15_000 });

    const list = await listProfiles();
    const row = list.find((p) => p.variables?.__provider === 'nodemaven' && p.variables?.__username === USER);
    expect(row).toBeTruthy();
    createdIds.push(row.id);
    expect(row.url_display).toContain('gate.nodemaven.com');
    expect(row.url_display).not.toContain('word');       // password masked
    expect(row.url_display).toContain('***');
    expect(row.variables.__password).toBeUndefined();
    expect(row.variables.__country).toBe('de');
    expect(row.country).toBe('de');
    expect(row.identity_override).toBe(0);
    const decrypted = await mainWindow.evaluate((id) => window.electronAPI.getProxyProfileUrl(id), row.id);
    expect(decrypted).toContain(`${USER}-country-de`);
    expect(decrypted).toContain(encodeURIComponent(PASS));
});

test('pm3) reopening the profile in Simple restores provider, country, username and the decrypted password', async () => {
    await pm.click('#btn-simple-new');
    await expect(pm.locator('#se-user')).toHaveValue('');
    await pm.click('.profile-item:has-text("NodeMaven")');
    await expect(pm.locator('#se-user')).toHaveValue(USER, { timeout: 10_000 });
    await expect(pm.locator('#se-pass')).toHaveValue(PASS, { timeout: 10_000 });
    await expect(pm.locator('#se-country')).toHaveValue('de');
    await expect(pm.locator('#se-providers .se-chip.active')).toHaveAttribute('data-provider', 'nodemaven');
    await expect(pm.locator('#se-delete')).toBeVisible();
    await expect(pm.locator('body')).toHaveAttribute('data-editor-mode', 'simple');
});

test('pm4) a new Simple profile for the same provider pre-fills the last used credentials', async () => {
    await pm.click('#btn-simple-new');
    await pm.click('#se-providers .se-chip[data-provider="nodemaven"]');
    await expect(pm.locator('#se-user')).toHaveValue(USER, { timeout: 10_000 });
    await expect(pm.locator('#se-pass')).toHaveValue(PASS, { timeout: 10_000 });
    await pm.keyboard.press('Escape'); // discard the draft (confirm dialog auto-accepted)
    await expect(pm.locator('#simple-editor')).toBeHidden();
});

test('pm5) Advanced mode persists and shows the full editor; the proxy manager has NO identity tab (identity is Browser ID only)', async () => {
    await pm.click('#editor-mode-advanced');
    await expect(pm.locator('body')).toHaveAttribute('data-editor-mode', 'advanced');
    const pref = await mainWindow.evaluate(() => window.electronAPI.getUiPref('proxyManager.editorMode', 'simple'));
    expect(pref).toBe('advanced');
    await pm.click(`.profile-item:has-text("NodeMaven")`);
    await expect(pm.locator('#editor-wrap')).toBeVisible();
    await expect(pm.locator('#simple-editor')).toBeHidden();
    await expect(pm.locator('#f-provider-pass')).toHaveValue(PASS, { timeout: 10_000 }); // profile fully loaded
    // identity moved out of the proxy manager entirely
    await expect(pm.locator('#tab-btn-identity')).toHaveCount(0);
    await expect(pm.locator('#f-identity-override')).toHaveCount(0);
    await expect(pm.locator('#fp-section')).toHaveCount(0);
    await expect(pm.locator('#mitm-stats')).toBeVisible();
    const values = await pm.locator('#f-provider option').evaluateAll((opts) => opts.map((o) => o.value));
    expect(values).toContain('__custom__');
    // Direct in Advanced
    await pm.click('.profile-item-direct');
    await expect(pm.locator('#editor-title')).toHaveText('MITM (no upstream)');
    await expect(pm.locator('body')).toHaveAttribute('data-direct', '1');
    await expect(pm.locator('#tab-btn-identity')).toHaveCount(0);
    // Direct in Simple: a plain card with "Use Direct"
    await pm.click('#editor-mode-simple');
    await expect(pm.locator('#se-card-direct')).toBeVisible();
    await expect(pm.locator('#se-card-profile')).toBeHidden();
    await expect(pm.locator('#se-use-direct')).toBeVisible();
    await pm.click('#editor-mode-advanced');
});

test('pm6) Advanced: static list import creates one profile per line', async () => {
    await pm.click('#btn-bulk-import');
    await expect(pm.locator('#bulk-modal-backdrop')).toHaveClass(/open/);
    await pm.fill('#bulk-modal-prefix', 'E2E DC');
    await pm.fill('#bulk-modal-text', 'http://u1:p1@10.0.0.1:8080\n10.0.0.2:8081:u2:p2\n# comment\nnonsense\n');
    await expect(pm.locator('#bulk-modal-status')).toContainText('2 proxies ready');
    await expect(pm.locator('#bulk-modal-status')).toContainText('1 invalid');
    await pm.click('#bulk-modal-import');
    await expect(pm.locator('#bulk-modal-backdrop')).not.toHaveClass(/open/, { timeout: 15_000 });

    const list = await listProfiles();
    const a = list.find((p) => p.name === 'E2E DC 01');
    const b = list.find((p) => p.name === 'E2E DC 02');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    createdIds.push(a.id, b.id);
    expect(a.url_display).toContain('10.0.0.1:8080');
    expect(a.url_display).not.toContain('p1@');
    expect(b.variables.__connectionMode).toBe('manual');
    const bUrl = await mainWindow.evaluate((id) => window.electronAPI.getProxyProfileUrl(id), b.id);
    expect(bUrl).toBe('http://u2:p2@10.0.0.2:8081');
});

test('pm7) a manual profile opened in Simple mode switches the editor to Advanced', async () => {
    await pm.click('#editor-mode-simple');
    await expect(pm.locator('body')).toHaveAttribute('data-editor-mode', 'simple');
    await pm.click('.profile-item:has-text("E2E DC 01")');
    await expect(pm.locator('body')).toHaveAttribute('data-editor-mode', 'advanced');
    await expect(pm.locator('#editor-wrap')).toBeVisible();
    await expect(pm.locator('#manual-panel')).toHaveClass(/active/);
    await expect(pm.locator('#f-template')).toHaveValue(/10\.0\.0\.1:8080/);
});
