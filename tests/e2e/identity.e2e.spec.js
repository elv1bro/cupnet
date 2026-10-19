'use strict';

/**
 * E2E: Browser Identity — the chosen identity must be consistent on the wire (MITM → origin)
 * and in JavaScript (navigator.*, Intl) for every tab, including tabs opened later.
 *
 * Hermetic: a local HTTPS echo server plays the origin; the tab reaches it through the MITM via a
 * DNS override (Chromium bypasses the proxy for loopback, so a non-local hostname is required).
 */
const { test, expect } = require('@playwright/test');
const https = require('https');
const path = require('path');
const {
    launchCupnet,
    getMainWindow,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
    executeActiveTabJavaScript,
    openSubWindowExpectNew,
    waitForWindowByTitle,
} = require('./helpers.js');

const repoRoot = path.join(__dirname, '..', '..');
const { generateCA, getFakeCert } = require(path.join(repoRoot, 'mitm-ca.js'));
const catalog = require(path.join(repoRoot, 'browser-identity-catalog.js'));

const ECHO_HOST = 'echo.cupnet-e2e.test';

test.describe.configure({ mode: 'serial' });

let electronApp;
/** @type {import('@playwright/test').Page} */
let mainWindow;
let echo;
let echoPort;
let dnsRuleId = null;

async function echoViaTab() {
    await navigateAndWait(electronApp, `https://${ECHO_HOST}:${echoPort}/echo?t=${Date.now()}`, 60_000, { urlIncludes: ECHO_HOST, bodySnippet: '"headers"' });
    const text = await readActiveTabBodyText(electronApp);
    return JSON.parse(text);
}

async function tabJs() {
    return executeActiveTabJavaScript(electronApp, `({
        ua: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        uad: navigator.userAgentData ? {
            mobile: navigator.userAgentData.mobile,
            platform: navigator.userAgentData.platform,
            brands: navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version),
        } : null,
    })`);
}

test.beforeAll(async () => {
    generateCA();
    const cert = getFakeCert(ECHO_HOST);
    echo = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
        const payload = JSON.stringify({ headers: req.headers, url: req.url });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
    });
    await new Promise((r) => echo.listen(0, '127.0.0.1', r));
    echoPort = echo.address().port;

    electronApp = await launchCupnet();
    await electronApp.firstWindow({ timeout: 120_000 });
    await waitForAppContext(electronApp, 120_000);
    mainWindow = await getMainWindow(electronApp, 60_000);
    await mainWindow.waitForLoadState('domcontentloaded');
    await waitMitmReady(electronApp, 180_000);

    const save = await mainWindow.evaluate((h) => window.electronAPI.saveDnsOverride({ host: h, ip: '127.0.0.1', enabled: true }), ECHO_HOST);
    expect(save?.success).toBe(true);
    dnsRuleId = save.id;
});

test.afterAll(async () => {
    try {
        if (mainWindow && dnsRuleId != null) await mainWindow.evaluate((id) => window.electronAPI.deleteDnsOverride(id), dnsRuleId);
        if (mainWindow) await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'engine', timezone: '', language: '', tlsProfile: 'chrome' }));
    } catch { /* ignore */ }
    if (electronApp) await electronApp.close();
    await new Promise((r) => (echo ? echo.close(() => r()) : r()));
});

test('id1) default identity is engine mode with a template catalog', async () => {
    const st = await mainWindow.evaluate(() => window.electronAPI.getIdentity());
    expect(st?.success).toBe(true);
    expect(st.settings.mode).toBe('engine');
    expect(st.effective.mode).toBe('engine');
    expect(st.source).toBe('global');
    expect(Array.isArray(st.templates)).toBe(true);
    expect(st.templates.some((t) => t.id === 'chrome-win')).toBe(true);
    expect(st.templates.some((t) => t.id === 'firefox-win')).toBe(true);
});

test('id2) engine mode: wire UA equals navigator.userAgent and the synthesized sec-ch-ua equals navigator.userAgentData.brands', async () => {
    const body = await echoViaTab();
    const ua = body.headers['user-agent'];
    expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
    expect(ua).not.toMatch(/CupNet|Electron/i);
    const js = await tabJs();
    expect(js.ua).toBe(ua);
    expect(js.uad).toBeTruthy();
    // Electron itself sends no client hints; the MITM synthesizes the real engine's 2-brand list.
    const wire = body.headers['sec-ch-ua'];
    expect(wire).toBeTruthy();
    const wireBrands = [...wire.matchAll(/"([^"]+)";v="([^"]+)"/g)].map((m) => `${m[1]}/${m[2]}`);
    expect(wireBrands).toEqual(js.uad.brands);
    expect(body.headers['sec-ch-ua-mobile']).toBe('?0');
    expect(body.headers['sec-ch-ua-platform']).toBe(`"${js.uad.platform}"`);
});

test('id3) Firefox template: UA on the wire + in JS, no client hints, timezone + language emulated', async () => {
    const res = await mainWindow.evaluate(() => window.electronAPI.setIdentity({
        mode: 'template', templateId: 'firefox-win', timezone: 'Asia/Tokyo', language: 'ja-JP,ja;q=0.9',
    }));
    expect(res?.success).toBe(true);
    expect(res.effective.userAgent).toBe(catalog.UA.firefoxWin);
    expect(res.effective.tlsProfile).toBe('firefox');
    expect(await mainWindow.evaluate(() => window.electronAPI.getTlsProfile())).toBe('firefox');

    const body = await echoViaTab();
    expect(body.headers['user-agent']).toBe(catalog.UA.firefoxWin);
    expect(Object.keys(body.headers).some((k) => k.startsWith('sec-ch-ua'))).toBe(false);
    expect(body.headers['accept-language']).toBe('ja-JP,ja;q=0.9');

    const js = await tabJs();
    expect(js.ua).toBe(catalog.UA.firefoxWin);
    expect(js.platform).toBe('Win32');
    expect(js.tz).toBe('Asia/Tokyo');
    expect(js.language.toLowerCase()).toMatch(/^ja/);
    expect(js.uad).toBeNull(); // Firefox has no navigator.userAgentData
});

test('id4) Chrome Android template: sec-ch-ua*, navigator.userAgentData and platform all agree', async () => {
    const res = await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'template', templateId: 'chrome-android', timezone: '', language: '' }));
    expect(res?.success).toBe(true);

    const body = await echoViaTab();
    expect(body.headers['user-agent']).toBe(catalog.UA.chromeAndroid);
    expect(body.headers['sec-ch-ua']).toContain(`"Chromium";v="${catalog.VERSIONS.chrome}"`);
    expect(body.headers['sec-ch-ua-platform']).toBe('"Android"');
    expect(body.headers['sec-ch-ua-mobile']).toBe('?1');

    const js = await tabJs();
    expect(js.ua).toBe(catalog.UA.chromeAndroid);
    expect(js.platform).toBe('Linux armv8l');
    expect(js.uad).toBeTruthy();
    expect(js.uad.mobile).toBe(true);
    expect(js.uad.platform).toBe('Android');
    expect(js.uad.brands).toContain(`Chromium/${catalog.VERSIONS.chrome}`);
    expect(js.uad.brands).toContain(`Google Chrome/${catalog.VERSIONS.chrome}`);
});

test('id5) a tab opened after the identity change inherits it', async () => {
    const tabId = await mainWindow.evaluate(() => window.electronAPI.newTab());
    expect(tabId).toBeTruthy();
    const body = await echoViaTab();
    expect(body.headers['user-agent']).toBe(catalog.UA.chromeAndroid);
    const js = await tabJs();
    expect(js.ua).toBe(catalog.UA.chromeAndroid);
    expect(js.uad?.platform).toBe('Android');
});

test('id6) back to engine mode restores the real engine identity', async () => {
    const res = await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'engine', tlsProfile: 'chrome' }));
    expect(res?.success).toBe(true);
    expect(res.effective.mode).toBe('engine');
    const body = await echoViaTab();
    expect(body.headers['user-agent']).toMatch(/Chrome\/\d+\.0\.0\.0/);
    expect(body.headers['user-agent']).not.toMatch(/Android|Firefox/);
    expect(body.headers['sec-ch-ua-platform']).not.toBe('"Android"');
    // Engine mode presents as Google Chrome (owner decision 2026-09-27) — on the wire and in JS alike.
    const major = body.headers['user-agent'].match(/Chrome\/(\d+)/)[1];
    expect(body.headers['sec-ch-ua']).toContain(`"Google Chrome";v="${major}"`);
    expect(body.headers['sec-ch-ua']).toContain(`"Chromium";v="${major}"`);
    const js = await tabJs();
    expect(js.ua).not.toMatch(/Android|Firefox/);
    expect(js.uad).toBeTruthy();
    expect(js.uad.brands).toContain(`Google Chrome/${major}`);
    expect(js.uad.brands).toContain(`Chromium/${major}`);
    expect(js.uad.mobile).toBe(false);
    expect(js.platform).not.toBe('Linux armv8l');
});

const CUSTOM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

async function readIdentityCheckReport() {
    // Built-in cupnet://identity-check page: wait until it finished comparing, then read its JSON report.
    for (let i = 0; i < 60; i++) {
        const state = await executeActiveTabJavaScript(electronApp, "document.getElementById('root')?.dataset.state || ''").catch(() => '');
        if (state === 'done') break;
        await new Promise((r) => setTimeout(r, 250));
    }
    const text = await executeActiveTabJavaScript(electronApp, "document.getElementById('json')?.textContent || ''");
    return JSON.parse(text);
}

test('id6b) custom User-Agent (Chrome 153 / Windows): the built-in check page proves wire == JavaScript', async () => {
    const res = await mainWindow.evaluate((ua) => window.electronAPI.setIdentity({ mode: 'custom', userAgent: ua, timezone: '', language: '' }), CUSTOM_UA);
    expect(res?.success).toBe(true);
    expect(res.effective.tlsProfile).toBe('chrome');

    const opened = await mainWindow.evaluate(() => window.electronAPI.openIdentityCheck());
    expect(opened?.success).toBe(true);
    await navigateAndWait(electronApp, `file://${path.join(repoRoot, 'identity-check.html')}`, 60_000, { urlIncludes: 'identity-check.html', bodySnippet: 'Browser ID check' });
    const report = await readIdentityCheckReport();
    expect(report.error).toBeNull();
    expect(report.wire.headers['user-agent']).toBe(CUSTOM_UA);
    expect(report.js.userAgent).toBe(CUSTOM_UA);
    expect(report.wire.headers['sec-ch-ua']).toMatch(/"Google Chrome";v="153"/);
    expect(report.wire.headers['sec-ch-ua-platform']).toBe('"Windows"');
    expect(report.js.userAgentData.brands.map((b) => `${b.brand}/${b.version}`)).toContain('Google Chrome/153');
    expect(report.js.userAgentData.platform).toBe('Windows');
    expect(report.js.platform).toBe('Win32');
    expect(report.failed, JSON.stringify({ headers: report.wire.headers, js: { language: report.js.language, languages: report.js.languages, uad: report.js.userAgentData } })).toEqual([]);
    expect(report.consistent).toBe(true);
    expect(report.wire.tls.profile).toMatch(/^chrome/);
    // the "through the proxy" (real external request) section is present (its network call is not exercised here)
    expect(await executeActiveTabJavaScript(electronApp, "!!document.getElementById('btn-external')")).toBe(true);
    expect(await executeActiveTabJavaScript(electronApp, "document.getElementById('external-table').style.display")).toBe('none');
});

test('id6c) toolbar Browser ID button opens the identity window; footer shows the active identity', async () => {
    await expect(mainWindow.locator('#identity-btn')).toBeVisible();
    await expect(mainWindow.locator('#identity-btn-label')).toHaveText('Browser ID');
    await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'engine' })); // id6b left a custom UA
    // engine mode: footer reads "Engine default", the toolbar dot is off
    await expect(mainWindow.locator('#status-identity')).toContainText('Engine default', { timeout: 10_000 });
    await expect(mainWindow.locator('#identity-btn')).not.toHaveClass(/identity-active/);
    // switching identity (as the window does) updates the footer + dot, and applies everywhere
    await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'template', templateId: 'firefox-win' }));
    await expect(mainWindow.locator('#status-identity')).toContainText(/Firefox/, { timeout: 10_000 });
    await expect(mainWindow.locator('#identity-btn')).toHaveClass(/identity-active/);
    const body = await echoViaTab();
    expect(body.headers['user-agent']).toBe(catalog.UA.firefoxWin);
    expect((await tabJs()).ua).toBe(catalog.UA.firefoxWin);
    // clicking the button opens the Browser ID window (no dropdown menu)
    const stale = await waitForWindowByTitle(electronApp, 'Browser ID', 3_000).catch(() => null);
    if (stale) await stale.close().catch(() => {});
    await mainWindow.click('#identity-btn');
    const opened = await waitForWindowByTitle(electronApp, 'Browser ID', 20_000);
    expect(await opened.title()).toContain('Browser ID');
    await opened.close().catch(() => {});
    await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'engine' }));
    await expect(mainWindow.locator('#status-identity')).toContainText('Engine default', { timeout: 10_000 });
});

test('id6e) the Browser ID window switches modes via its segment and Apply persists a custom UA', async () => {
    const win = await openSubWindowExpectNew(electronApp, mainWindow, 'openIdentityManager');
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('#tpl-grid .tpl-card').first()).toBeAttached({ timeout: 15_000 });
    await win.click('#mode-seg button[data-mode="custom"]');
    await expect(win.locator('#mode-seg button[data-mode="custom"]')).toHaveClass(/\bon\b/);
    await expect(win.locator('#custom-ua-field')).toBeVisible();
    await win.click('#mode-seg button[data-mode="engine"]');
    await expect(win.locator('#custom-ua-field')).toBeHidden();
    await win.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    // opening with an explicit mode (deep-link) pre-selects Custom and focuses the UA field
    await mainWindow.evaluate(() => window.electronAPI.openIdentityManager({ mode: 'custom' }));
    const win2 = await waitForWindowByTitle(electronApp, 'Browser ID', 25_000);
    await win2.waitForLoadState('domcontentloaded');
    await expect(win2.locator('#mode-seg button[data-mode="custom"]')).toHaveClass(/\bon\b/, { timeout: 15_000 });
    expect(await win2.evaluate(() => document.activeElement?.id)).toBe('f-ua');
    await win2.fill('#f-ua', CUSTOM_UA);
    await expect(win2.locator('#btn-apply')).toBeEnabled();
    await win2.click('#btn-apply');
    await expect(win2.locator('#status')).toContainText('Applied', { timeout: 15_000 });
    await expect(mainWindow.locator('#status-identity')).toContainText(/Custom/, { timeout: 10_000 });
    const st = await mainWindow.evaluate(() => window.electronAPI.getIdentity());
    expect(st.settings.mode).toBe('custom');
    expect(st.effective.userAgent).toBe(CUSTOM_UA);
    // an already-open window receives the mode command instead of spawning a second one
    await mainWindow.evaluate(() => window.electronAPI.openIdentityManager({ mode: 'engine' }));
    await expect(win2.locator('#mode-seg button[data-mode="engine"]')).toHaveClass(/\bon\b/, { timeout: 10_000 });
    expect(electronApp.windows().filter((pg) => /identity-manager\.html/.test(pg.url())).length).toBe(1);
    await win2.close().catch(() => {});
    await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'engine' }));
});

test('id6d) identity holds with an authenticated upstream proxy connected (local proxy-chain server)', async () => {
    const { Server: ProxyServer } = require('proxy-chain');
    let connects = 0;
    const upstream = new ProxyServer({
        port: 0, host: '127.0.0.1', verbose: false,
        prepareRequestFunction: ({ username, password }) => {
            connects++;
            return { requestAuthentication: !(username === 'e2e' && password === 'pw'), upstreamProxyUrl: null };
        },
    });
    await upstream.listen();
    const proxyPort = upstream.port;
    let profileId = null;
    try {
        const saved = await mainWindow.evaluate((tpl) => window.electronAPI.saveProxyProfileFull({
            name: `e2e-upstream-${Date.now()}`, template: tpl, variables: { __connectionMode: 'manual' }, notes: '', country: '',
            tls_profile: 'chrome', tls_ja3_mode: 'template', tls_ja3_custom: null, force_http1: 0, identity_override: 0,
        }), `http://e2e:pw@127.0.0.1:${proxyPort}`);
        expect(saved?.success).toBe(true);
        profileId = saved.id;
        const conn = await mainWindow.evaluate((id) => window.electronAPI.connectProxyTemplate(id, {}), profileId);
        expect(conn?.success).toBe(true);

        await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'template', templateId: 'chrome-mac', timezone: '', language: '' }));
        const body = await echoViaTab();   // tab → MITM → worker → proxy-chain (auth) → local HTTPS echo
        expect(body.headers['user-agent']).toBe(catalog.UA.chromeMac);
        expect(body.headers['sec-ch-ua-platform']).toBe('"macOS"');
        expect(connects).toBeGreaterThan(0);
        const js = await tabJs();
        expect(js.ua).toBe(catalog.UA.chromeMac);
        expect(js.uad.platform).toBe('macOS');
        // the self-check echo reports the upstream without credentials and stays consistent. An
        // authenticated upstream is wrapped in a local proxy-chain anonymizer (global-proxy-connect.js),
        // so the MITM sees a loopback hop on another port, never the e2e:pw URL.
        await navigateAndWait(electronApp, `file://${path.join(repoRoot, 'identity-check.html')}`, 60_000, { urlIncludes: 'identity-check.html', bodySnippet: 'Browser ID check' });
        const report = await readIdentityCheckReport();
        expect(report.wire.upstreamProxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(JSON.stringify(report)).not.toContain('e2e:pw');
        expect(report.failed).toEqual([]);
    } finally {
        await mainWindow.evaluate(() => window.electronAPI.disconnectProxy()).catch(() => {});
        if (profileId != null) await mainWindow.evaluate((id) => window.electronAPI.deleteProxyProfileById(id), profileId).catch(() => {});
        await upstream.close(true).catch(() => {});
    }
});

test('id7) Browser Identity window opens', async () => {
    const win = await openSubWindowExpectNew(electronApp, mainWindow, 'openIdentityManager');
    expect(win).toBeTruthy();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('#tpl-grid .tpl-card').first()).toBeAttached({ timeout: 15_000 });
    expect(await win.title()).toContain('Browser ID');
    await win.close().catch(() => {});
});
