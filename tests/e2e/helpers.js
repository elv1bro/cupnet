'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('@playwright/test');

/** Корень репозитория cupnet2 (родитель каталога tests/e2e). */
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/**
 * Путь к бинарнику Electron из devDependencies (кроссплатформенно).
 */
function getElectronExecutablePath() {
    switch (process.platform) {
        case 'darwin':
            return path.join(
                PROJECT_ROOT,
                'node_modules',
                'electron',
                'dist',
                'Electron.app',
                'Contents',
                'MacOS',
                'Electron'
            );
        case 'win32':
            return path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
        default:
            return path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron');
    }
}

/**
 * Запуск CupNet с изолированным userData и CUPNET_E2E=1:
 * — чистый профиль (меньше модалок логирования);
 * — выход без блокирующих диалогов «закрыть все окна».
 * @returns {Promise<import('@playwright/test').ElectronApplication>}
 */
async function launchCupnet() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-e2e-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.CUPNET_E2E = '1';

    return electron.launch({
        cwd: PROJECT_ROOT,
        executablePath: getElectronExecutablePath(),
        args: ['.', `--user-data-dir=${userDataDir}`],
        env,
    });
}

/**
 * Появление __cupnetAppContext и tabManager (после app.whenReady в main).
 */
async function waitForAppContext(electronApp, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const ok = await electronApp.evaluate(() => {
                const ctx = globalThis.__cupnetAppContext;
                return !!(ctx?.modules?.tabManager && typeof ctx.modules.tabManager.getActiveTab === 'function');
            });
            if (ok) return;
        } catch (e) {
            lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`App context not ready within ${timeoutMs}ms: ${lastErr?.message || ''}`);
}

/**
 * Ожидание готовности MITM (флаг в снимке appCtx).
 */
async function waitMitmReady(electronApp, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const ok = await electronApp.evaluate(() => {
                const ctx = globalThis.__cupnetAppContext;
                return !!(ctx && ctx.mitm && ctx.mitm.ready === true);
            });
            if (ok) return;
        } catch (e) {
            lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`MITM not ready within ${timeoutMs}ms: ${lastErr?.message || ''}`);
}

/**
 * URL активной вкладки (BrowserView).
 */
async function getActiveTabUrl(electronApp) {
    return electronApp.evaluate(() => {
        const tab = globalThis.__cupnetAppContext?.modules?.tabManager?.getActiveTab?.();
        const wc = tab?.view?.webContents;
        if (!wc || wc.isDestroyed()) return '';
        try {
            return wc.getURL() || '';
        } catch {
            return '';
        }
    });
}

/**
 * Навигация активной вкладки + ожидание по URL/телу (устойчивее, чем только did-finish-load).
 * @param {{ urlIncludes?: string, bodySnippet?: string, allowEmptyBody?: boolean, minBodyLength?: number }} [waitFor]
 */
async function navigateAndWait(electronApp, url, timeoutMs = 90_000, waitFor = {}) {
    const urlIncludes =
        waitFor.urlIncludes ??
        (() => {
            try {
                return new URL(url).hostname;
            } catch {
                return 'httpbin.org';
            }
        })();
    const bodySnippet = waitFor.bodySnippet || null;
    const allowEmptyBody = waitFor.allowEmptyBody === true;
    const minBodyLength = typeof waitFor.minBodyLength === 'number' ? waitFor.minBodyLength : 12;

    // Playwright Electron: первый аргумент — require('electron') в main, второй — наш payload.
    await electronApp.evaluate(async (_electronMain, u) => {
        if (typeof u !== 'string' || !u) throw new Error(`bad url arg: ${typeof u} ${String(u)}`);
        const tm = globalThis.__cupnetAppContext?.modules?.tabManager;
        if (!tm) throw new Error('tabManager missing');
        const tab = tm.getActiveTab();
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
            throw new Error('no active BrowserView');
        }
        const wc = tab.view.webContents;
        // Как tab-manager.navigate: не роняем процесс при отклонении (редиректы/abort).
        await wc.loadURL(u).catch(() => {});
    }, url);

    const deadline = Date.now() + timeoutMs;
    let lastUrl = '';
    let lastLen = 0;
    while (Date.now() < deadline) {
        lastUrl = await getActiveTabUrl(electronApp);
        const text = await readActiveTabBodyText(electronApp);
        lastLen = text.length;
        const urlOk = lastUrl.includes(urlIncludes);
        const bodyOk = bodySnippet
            ? text.includes(bodySnippet)
            : allowEmptyBody
              ? true
              : text.length >= minBodyLength;
        if (urlOk && bodyOk) return;
        await new Promise((r) => setTimeout(r, 400));
    }
    const snippet = await readActiveTabBodyText(electronApp);
    throw new Error(
        `nav timeout url=${url} lastUrl=${lastUrl} bodyLen=${lastLen} snippet=${String(snippet).slice(0, 200)}`
    );
}

/**
 * `navigator.userAgent` в активной вкладке (BrowserView renderer).
 */
async function getActiveTabNavigatorUserAgent(electronApp) {
    return electronApp.evaluate(async () => {
        const tm = globalThis.__cupnetAppContext?.modules?.tabManager;
        const tab = tm?.getActiveTab?.();
        const wc = tab?.view?.webContents;
        if (!wc || wc.isDestroyed()) return '';
        try {
            return await wc.executeJavaScript('navigator.userAgent');
        } catch {
            return '';
        }
    });
}

/**
 * Текст body активной вкладки (BrowserView).
 */
async function readActiveTabBodyText(electronApp) {
    return electronApp.evaluate(async () => {
        const tm = globalThis.__cupnetAppContext?.modules?.tabManager;
        const tab = tm?.getActiveTab?.();
        const wc = tab?.view?.webContents;
        if (!wc || wc.isDestroyed()) return '';
        try {
            return await wc.executeJavaScript(`document.body ? document.body.innerText : ''`);
        } catch {
            return '';
        }
    });
}

/**
 * Ждём, пока countDbRequests с фильтром вернёт значение > minCount (poll).
 */
async function waitForLoggedCount(mainWindowPage, filters, minCount, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const n = await mainWindowPage.evaluate(
            async (f) => {
                const api = window.electronAPI;
                if (!api?.countDbRequests) return -1;
                return api.countDbRequests(f);
            },
            filters
        );
        if (typeof n === 'number' && n > minCount) return n;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Logged count did not exceed ${minCount} within ${timeoutMs}ms`);
}

/**
 * Число окон Electron (включая главное).
 * @param {import('@playwright/test').ElectronApplication} electronApp
 */
function getWindowCount(electronApp) {
    return electronApp.windows().length;
}

/**
 * Ждём, пока число окон не станет >= minCount.
 */
async function waitForWindowCountAtLeast(electronApp, minCount, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last = 0;
    while (Date.now() < deadline) {
        last = electronApp.windows().length;
        if (last >= minCount) return last;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Expected window count >= ${minCount}, last=${last} after ${timeoutMs}ms`);
}

/**
 * Ожидание окна, у которого title содержит substring (регистронезависимо).
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {string} titleSubstring
 */
async function waitForWindowByTitle(electronApp, titleSubstring, timeoutMs = 25_000) {
    const needle = String(titleSubstring || '').toLowerCase();
    const deadline = Date.now() + timeoutMs;
    let lastTitles = [];
    while (Date.now() < deadline) {
        const pages = electronApp.windows();
        lastTitles = [];
        for (const p of pages) {
            try {
                const t = (await p.title()) || '';
                lastTitles.push(t);
                if (t.toLowerCase().includes(needle)) return p;
            } catch {
                /* ignore */
            }
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
        `No window with title containing "${titleSubstring}" within ${timeoutMs}ms; titles=${JSON.stringify(lastTitles)}`
    );
}

/**
 * Вызвать electronAPI[methodName]() в главном окне и дождаться появления нового окна (count + 1).
 * Если окно не появилось — не бросает (для «фокус существующего»).
 * @returns {Promise<import('@playwright/test').Page | null>} новое окно или null
 */
async function openSubWindowExpectNew(electronApp, mainWindowPage, methodName, timeoutMs = 25_000) {
    const n0 = electronApp.windows().length;
    await mainWindowPage.evaluate(async (name) => {
        const api = window.electronAPI;
        const fn = api && api[name];
        if (typeof fn !== 'function') throw new Error(`electronAPI.${name} is not a function`);
        await fn.call(api);
    }, methodName);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pages = electronApp.windows();
        if (pages.length > n0) return pages[pages.length - 1];
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
}

/**
 * Сохранить intercept-правило; вернуть id из main или бросить по error.
 * @param {import('@playwright/test').Page} mainWindowPage
 * @param {object} rule — поля как в БД: name, type, url_pattern, enabled, params
 */
async function createInterceptRule(mainWindowPage, rule) {
    const out = await mainWindowPage.evaluate(async (r) => {
        return window.electronAPI.saveInterceptRule(r);
    }, rule);
    if (out && out.error) throw new Error(String(out.error));
    if (!out || typeof out.id !== 'number') throw new Error(`saveInterceptRule: unexpected result ${JSON.stringify(out)}`);
    return out.id;
}

/**
 * Удалить все intercept-правила.
 */
async function deleteAllInterceptRules(mainWindowPage) {
    await mainWindowPage.evaluate(async () => {
        const rules = await window.electronAPI.getInterceptRules();
        for (const r of rules || []) {
            if (r && r.id != null) await window.electronAPI.deleteInterceptRule(r.id);
        }
    });
    await new Promise((r) => setTimeout(r, 400));
}

/**
 * Снимок proxy из __cupnetAppContext (main).
 */
async function getAppCtxProxy(electronApp) {
    return electronApp.evaluate(() => {
        const p = globalThis.__cupnetAppContext?.proxy;
        if (!p) return null;
        return {
            trafficMode: p.trafficMode,
            actProxy: p.actProxy,
            profileId: p.profileId,
            profileName: p.profileName,
        };
    });
}

/**
 * Закрыть все окна кроме указанной страницы (главное).
 */
async function closeAllExcept(electronApp, keepPage) {
    const pages = electronApp.windows();
    for (const p of pages) {
        if (p !== keepPage) {
            try {
                await p.close();
            } catch {
                /* ignore */
            }
        }
    }
}

/**
 * Новая вкладка с пустой cookie-группой и включённым CupNet (аналог старого newIsolatedTab).
 */
/**
 * Groups of duplicate rows: same tab + method + url + status (distinct request ids).
 * Excludes internal `type === 'cupnet'` rows.
 * @param {Array<{ id?: number, tab_id?: number|null, url?: string, method?: string, status?: number|null, type?: string }>} rows
 * @returns {Array<{ key: string, count: number, ids: number[] }>}
 */
function findDuplicateRequestGroups(rows) {
    const map = new Map();
    for (const r of rows || []) {
        if (!r || r.type === 'cupnet') continue;
        const id = r.id;
        if (id == null) continue;
        const key = `${r.tab_id ?? ''}|${String(r.method || 'GET').toUpperCase()}|${String(r.url || '')}|${r.status ?? ''}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(id);
    }
    const out = [];
    for (const [key, ids] of map) {
        if (ids.length > 1) out.push({ key, count: ids.length, ids });
    }
    return out;
}

/**
 * Poll until getDbRequests returns a stable row count (no change for `stableMs`), or timeout.
 */
async function waitForStableDbRequestCount(mainWindowPage, filters, limit, timeoutMs = 45_000, stableMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let stableSince = 0;
    while (Date.now() < deadline) {
        const n = await mainWindowPage.evaluate(
            async ({ f, lim }) => {
                const api = window.electronAPI;
                if (!api?.getDbRequests) return -1;
                const rows = await api.getDbRequests(f, lim, 0);
                return Array.isArray(rows) ? rows.length : -1;
            },
            { f: filters, lim: limit }
        );
        if (typeof n === 'number' && n >= 0) {
            if (n === last) {
                stableSince += 400;
                if (stableSince >= stableMs) return n;
            } else {
                last = n;
                stableSince = 0;
            }
        }
        await new Promise((r) => setTimeout(r, 400));
    }
    return last;
}

async function openNewTabWithFreshCookieGroupAndCupnet(mainWindowPage) {
    await mainWindowPage.evaluate(async () => {
        const cg = await window.electronAPI.createCookieGroup('e2e-iso-' + Date.now());
        if (!cg?.success) throw new Error(cg?.error || 'createCookieGroup failed');
        await window.electronAPI.newTab(null);
        const tabList = await window.electronAPI.getTabs();
        const active = tabList.find((t) => t.isActive);
        if (!active) throw new Error('no active tab');
        await window.electronAPI.setTabCookieGroup(active.id, cg.group.id);
    });
    await new Promise((r) => setTimeout(r, 750));
}

module.exports = {
    PROJECT_ROOT,
    getElectronExecutablePath,
    launchCupnet,
    waitForAppContext,
    waitMitmReady,
    getActiveTabNavigatorUserAgent,
    getActiveTabUrl,
    navigateAndWait,
    readActiveTabBodyText,
    waitForLoggedCount,
    getWindowCount,
    waitForWindowCountAtLeast,
    waitForWindowByTitle,
    openSubWindowExpectNew,
    createInterceptRule,
    deleteAllInterceptRules,
    getAppCtxProxy,
    closeAllExcept,
    findDuplicateRequestGroups,
    waitForStableDbRequestCount,
};
