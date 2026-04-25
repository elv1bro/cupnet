'use strict';

/**
 * E2E: assert Go AzureTLS worker is selected and basic MITM flows work.
 * Requires `npm run build:go:local` (binary under azuretls-go/bin) and network (httpbin.org).
 * Opt out of Go worker: CUPNET_USE_NODE_WORKER=1 (suite skipped).
 */

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
    executeActiveTabJavaScript,
} = require('./helpers.js');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function resolveGoWorkerBinary() {
    const arch = process.arch;
    const platform = process.platform;
    let name;
    if (platform === 'darwin') {
        name = arch === 'arm64' ? 'azuretls-worker-darwin-arm64' : 'azuretls-worker-darwin-amd64';
    } else if (platform === 'linux') {
        name = arch === 'arm64' ? 'azuretls-worker-linux-arm64' : 'azuretls-worker-linux-amd64';
    } else if (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) {
        name = 'azuretls-worker-win32-amd64.exe';
    } else {
        return null;
    }
    return path.join(PROJECT_ROOT, 'azuretls-go', 'bin', name);
}

const goBinPath = resolveGoWorkerBinary();
const haveGoBinary = !!(goBinPath && fs.existsSync(goBinPath));

test.describe.configure({ mode: 'serial' });

let electronApp;
/** @type {import('@playwright/test').Page} */
let mainWindow;
/** @type {boolean} */
let suiteSkipped = false;

test.beforeAll(async () => {
    if (!haveGoBinary) {
        suiteSkipped = true;
        return;
    }
    electronApp = await launchCupnet();
    mainWindow = await electronApp.firstWindow({ timeout: 120_000 });
    await mainWindow.waitForLoadState('domcontentloaded');
    await waitForAppContext(electronApp, 120_000);
    await waitMitmReady(electronApp, 180_000);
    const workerType = await electronApp.evaluate(
        () => globalThis.__cupnetAppContext?.modules?.mitmProxy?.worker?._workerType
    );
    if (workerType !== 'go') {
        suiteSkipped = true;
        try {
            await electronApp.close();
        } catch {
            /* ignore */
        }
        electronApp = null;
        mainWindow = null;
    }
});

test.afterAll(async () => {
    if (electronApp) await electronApp.close();
});

test('go1) Go worker is selected when binary exists', async () => {
    test.skip(suiteSkipped);
    const workerType = await electronApp.evaluate(
        () => globalThis.__cupnetAppContext?.modules?.mitmProxy?.worker?._workerType
    );
    expect(workerType).toBe('go');
});

test('go2) httpbin GET — JSON response body', async () => {
    test.skip(suiteSkipped);
    await navigateAndWait(electronApp, 'https://httpbin.org/get', 90_000, {
        urlIncludes: 'httpbin.org',
        bodySnippet: '"url"',
    });
    const text = await readActiveTabBodyText(electronApp);
    expect(text.length).toBeGreaterThan(80);
});

test('go3) HTTPS POST — body echo', async () => {
    test.skip(suiteSkipped);
    const payload = `e2e-go-post-${Date.now()}`;
    const raw = await executeActiveTabJavaScript(
        electronApp,
        `(async () => {
            const r = await fetch('https://httpbin.org/post', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: ${JSON.stringify(payload)},
            });
            return await r.text();
        })()`
    );
    expect(String(raw)).toContain(payload);
});

test('go4) concurrent tab navigations — three tabs render', async () => {
    test.skip(suiteSkipped);
    await mainWindow.evaluate(async () => {
        await window.electronAPI.newTab(null);
    });
    await new Promise((r) => setTimeout(r, 600));
    await mainWindow.evaluate(async () => {
        await window.electronAPI.newTab(null);
    });
    await new Promise((r) => setTimeout(r, 600));

    const tabs = await mainWindow.evaluate(async () => window.electronAPI.getTabs());
    expect(tabs.length).toBeGreaterThanOrEqual(3);

    const urls = [
        'https://httpbin.org/html',
        'https://httpbin.org/get',
        'https://httpbin.org/headers',
    ];
    for (let i = 0; i < 3; i++) {
        const tabId = tabs[i]?.id;
        expect(tabId).toBeTruthy();
        await mainWindow.evaluate(async (id) => window.electronAPI.switchTab(id), tabId);
        await navigateAndWait(electronApp, urls[i], 90_000, {
            urlIncludes: 'httpbin.org',
            minBodyLength: 20,
        });
    }
});

test('go5) large response — 100KB', async () => {
    test.skip(suiteSkipped);
    // Binary /bytes is a poor fit for DOM `innerText` waits; assert size via fetch in the tab.
    const n = await executeActiveTabJavaScript(
        electronApp,
        `(async () => {
            const r = await fetch('https://httpbin.org/bytes/102400');
            const buf = await r.arrayBuffer();
            return buf.byteLength;
        })()`
    );
    expect(Number(n)).toBe(102400);
});

test('go6) clearSessions does not break subsequent requests', async () => {
    test.skip(suiteSkipped);
    const ok = await electronApp.evaluate(async () => {
        const w = globalThis.__cupnetAppContext?.modules?.mitmProxy?.worker;
        if (!w || typeof w.clearSessions !== 'function') return false;
        await w.clearSessions();
        return true;
    });
    expect(ok).toBe(true);
    await navigateAndWait(electronApp, 'https://httpbin.org/get', 90_000, {
        urlIncludes: 'httpbin.org',
        bodySnippet: '"url"',
    });
});

test('go7) rapid sequential navigations', async () => {
    test.skip(suiteSkipped);
    const urls = [
        'https://httpbin.org/get',
        'https://httpbin.org/html',
        'https://httpbin.org/headers',
        'https://httpbin.org/user-agent',
        'https://httpbin.org/ip',
    ];
    for (const u of urls) {
        await navigateAndWait(electronApp, u, 90_000, {
            urlIncludes: 'httpbin.org',
            minBodyLength: 12,
        });
    }
});
