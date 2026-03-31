'use strict';

const { confirmOpenAnotherTab } = require('../../services/tab-open-confirm');

/**
 * Вкладки и навигация.
 * @param {object} ctx
 */
function registerTabsIpc(ctx) {
    // ── Tab management ───────────────────────────────────────────────────────
    ctx.ipcMain.handle('new-tab', async (_, proxyRules) => {
        if (!(await confirmOpenAnotherTab(ctx))) return null;
        const tabId = await ctx.tabManager.createTab({
            url: ctx.getNewTabUrl(),
            cookieGroupId: 1,
        });
        ctx.tabManager.switchTab(tabId);
        ctx.notifyCookieManagerTabs();
        return tabId;
    });

    ctx.ipcMain.handle('open-settings-tab', async () => {
        const settingsUrl = ctx.getInternalPageUrl('settings');
        for (const tab of ctx.tabManager.getAllTabs()) {
            const currentUrl = tab?.view?.webContents?.isDestroyed()
                ? ''
                : (tab?.view?.webContents?.getURL?.() || tab?.url || '');
            if (currentUrl && currentUrl.includes('settings.html')) {
                ctx.tabManager.switchTab(tab.id);
                return tab.id;
            }
        }
        if (!(await confirmOpenAnotherTab(ctx))) return null;
        const tabId = await ctx.tabManager.createTab({
            url: settingsUrl,
            cookieGroupId: 1,
        });
        ctx.tabManager.switchTab(tabId);
        ctx.notifyCookieManagerTabs();
        return tabId;
    });

    ctx.ipcMain.handle('close-tab', async (_, tabId) => {
        const tab = ctx.tabManager.getTab(tabId);
        if (tab) {
            try { ctx.interceptor.detachFromSession(tab.tabSession); } catch (e) { ctx.sysLog('warn', 'tabs', 'interceptor detach on close-tab failed: ' + (e?.message || e)); }
        }
        const result = ctx.tabManager.closeTab(tabId);
        ctx.notifyCookieManagerTabs();
        return result;
    });

    ctx.ipcMain.handle('switch-tab', async (_, tabId) => {
        return ctx.tabManager.switchTab(tabId);
    });

    ctx.ipcMain.handle('get-tabs', async () => {
        return ctx.tabManager.getTabList();
    });

    // ── Navigation ───────────────────────────────────────────────────────────
    ctx.ipcMain.on('navigate-to', (event, rawInput) => {
        const raw = String(rawInput || '').trim();
        const alias = raw.toLowerCase();
        if (alias === 'cupnet://settings' || alias === 'cupnet:settings') {
            ctx.tabManager.navigate(ctx.getInternalPageUrl('settings'));
            return;
        }
        if (alias === 'cupnet://guide' || alias === 'cupnet:guide') {
            ctx.tabManager.navigate(ctx.getInternalPageUrl('guide'));
            return;
        }
        if (alias === 'cupnet://home'
            || alias === 'cupnet:home'
            || alias === 'cupnet://new-tab'
            || alias === 'cupnet:new-tab') {
            ctx.tabManager.navigate(ctx.getNewTabUrl());
            return;
        }
        const url = ctx.resolveNavigationUrl(rawInput);
        if (!url) return;
        // Always load in active tab — avoids sender-id confusion (URL bar vs new-tab)
        ctx.tabManager.navigate(url);
    });
    ctx.ipcMain.on('nav-back', () => {
        const tab = ctx.tabManager.getActiveTab();
        if (tab && tab.view.webContents.canGoBack()) tab.view.webContents.goBack();
    });
    ctx.ipcMain.on('nav-forward', () => {
        const tab = ctx.tabManager.getActiveTab();
        if (tab && tab.view.webContents.canGoForward()) tab.view.webContents.goForward();
    });
    ctx.ipcMain.on('nav-reload', () => {
        const tab = ctx.tabManager.getActiveTab();
        if (tab) tab.view.webContents.reload();
    });
    ctx.ipcMain.on('nav-home', () => {
        const tab = ctx.tabManager.getActiveTab();
        if (tab && !tab.view.webContents.isDestroyed()) {
            tab.view.webContents.loadURL(ctx.getNewTabUrl()).catch((err) => {
                ctx.safeCatch({ module: 'main', eventCode: 'navigation.load.failed', context: { target: 'new-tab' } }, err, 'info');
            });
        }
    });
}

module.exports = { registerTabsIpc };
