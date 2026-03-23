'use strict';

/**
 * Cookies, DNS overrides, isolate/direct tabs, DevTools.
 * @param {object} ctx
 */
function registerCookiesDnsIpc(ctx) {
    ctx.ipcMain.handle('get-cookies', async (_, tabId, filter) => {
        const tab = tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
        if (!tab) return [];
        return tab.tabSession.cookies.get(filter || {});
    });

    ctx.ipcMain.handle('set-cookie', async (_, tabId, details) => {
        const tab = tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
        if (!tab) return { success: false, error: 'Tab not found' };
        try {
            await tab.tabSession.cookies.set(details);
            await tab.tabSession.cookies.flushStore();
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('remove-cookie', async (_, tabId, url, name) => {
        const tab = tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
        if (!tab) return false;
        await tab.tabSession.cookies.remove(url, name);
        return true;
    });

    ctx.ipcMain.handle('clear-cookies', async (_, tabId, domain) => {
        const tab = tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
        if (!tab) return { success: false, error: 'Tab not found' };
        try {
            const filter = domain ? { domain } : {};
            const cookies = await tab.tabSession.cookies.get(filter);
            for (const c of cookies) {
                const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
                try { await tab.tabSession.cookies.remove(url, c.name); } catch (e) { ctx.sysLog('warn', 'tabs', 'cookie remove failed: ' + (e?.message || e)); }
            }
            await tab.tabSession.cookies.flushStore();
            return { success: true, count: cookies.length };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('share-cookies', async (_, fromTabId, toTabId, domain) => {
        const fromTab = ctx.tabManager.getTab(fromTabId);
        const toTab   = ctx.tabManager.getTab(toTabId);
        if (!fromTab || !toTab) return { success: false, error: 'Tab not found' };
        try {
            const filter  = domain ? { domain } : {};
            const cookies = await fromTab.tabSession.cookies.get(filter);
            let count = 0;
            for (const c of cookies) {
                const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
                try { await toTab.tabSession.cookies.set({ ...c, url }); count++; } catch (e) { ctx.sysLog('warn', 'tabs', 'cookie share/set failed: ' + (e?.message || e)); }
            }
            await toTab.tabSession.cookies.flushStore();
            return { success: true, count };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // ── DNS Overrides ────────────────────────────────────────────────────────
    ctx.ipcMain.handle('open-dns-manager', async () => {
        ctx.createDnsManagerWindow();
        return true;
    });

    ctx.ipcMain.handle('dns-overrides-list', async () => {
        return ctx.db ? ctx.db.getDnsOverrides() : [];
    });

    ctx.ipcMain.handle('dns-overrides-save', async (_, payload) => {
        const host = String(payload?.host || '').trim().toLowerCase();
        const ip = String(payload?.ip || '').trim();
        const enabled = payload?.enabled !== false;
        const id = payload?.id ? Number(payload.id) : null;

        if (!ctx.isValidDnsHost(host)) return { success: false, error: 'Invalid host' };

        const mitm_inject_cors = payload?.mitm_inject_cors === true;
        const isWildcard = host.startsWith('*.');
        if (isWildcard && ip) return { success: false, error: 'Wildcard host (*.…) cannot be combined with IPv4' };
        if (isWildcard && !mitm_inject_cors) return { success: false, error: 'Wildcard host requires MITM CORS' };
        if (mitm_inject_cors) {
            if (ip && !ctx.isValidIpv4(ip)) return { success: false, error: 'Invalid IPv4 address' };
        } else {
            if (!ctx.isValidIpv4(ip)) return { success: false, error: 'Invalid IPv4 address' };
        }
        try {
            const savedId = await ctx.db.saveDnsOverrideAsync({ id, host, ip, enabled, mitm_inject_cors });
            ctx.syncDnsOverridesToMitm();
            return { success: true, id: savedId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('dns-overrides-delete', async (_, id) => {
        try {
            await ctx.db.deleteDnsOverrideAsync(Number(id));
            ctx.syncDnsOverridesToMitm();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('dns-overrides-toggle', async (_, id, enabled) => {
        try {
            await ctx.db.toggleDnsOverrideAsync(Number(id), !!enabled);
            ctx.syncDnsOverridesToMitm();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('isolate-tab', async (_, tabId) => {
        const tid = tabId || ctx.tabManager.getActiveTabId();
        const result = await ctx.tabManager.isolateTab(tid);
        // Attach interceptor to the new isolated session so request rules apply
        if (result?.success && ctx.interceptor) {
            const tab = ctx.tabManager.getTab(tid);
            if (tab) {
                try { ctx.interceptor.attachToSession(tab.tabSession, tid); } catch (e) { ctx.sysLog('warn', 'tabs', 'interceptor attach on isolate-tab failed: ' + (e?.message || e)); }
            }
        }
        return result;
    });

    ctx.ipcMain.handle('new-isolated-tab', async () => {
        const tabId = await ctx.tabManager.createTab(
            ctx.persistentAnonymizedProxyUrl || null,
            ctx.getNewTabUrl(),
            true,           // isolated = true
            null            // no shared session — fresh empty cookies
        );
        ctx.tabManager.switchTab(tabId);
        const tab = ctx.tabManager.getTab(tabId);
        if (tab) {
            ctx.setupNetworkLogging(tab.view.webContents, tabId, ctx.currentSessionId);
            if (ctx.interceptor) {
                try { ctx.interceptor.attachToSession(tab.tabSession, tabId); } catch (e) { ctx.sysLog('warn', 'tabs', 'interceptor attach on new-isolated-tab failed: ' + (e?.message || e)); }
            }
        }
        ctx.notifyCookieManagerTabs();
        return tabId;
    });

    ctx.ipcMain.handle('new-direct-tab', async () => {
        const tabId = await ctx.tabManager.createDirectTab(ctx.getNewTabUrl());
        ctx.tabManager.switchTab(tabId);
        ctx.notifyCookieManagerTabs();
        return tabId;
    });

    ctx.ipcMain.handle('open-cookie-manager', async (_, tabId) => {
        ctx.createCookieManagerWindow(tabId || ctx.tabManager.getActiveTabId());
        return true;
    });

    // ── DevTools for active tab ──────────────────────────────────────────────
    ctx.ipcMain.handle('open-devtools', async () => {
        const tab = ctx.tabManager?.getActiveTab();
        if (tab && !tab.view.webContents.isDestroyed()) {
            tab.view.webContents.openDevTools();
            return true;
        }
        return false;
    });
}

module.exports = { registerCookiesDnsIpc };
