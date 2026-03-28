'use strict';

const { insertCupnetTrafficSnapshotWithGeo } = require('../../services/cupnet-network-meta-log');

/**
 * Cookies, DNS overrides, isolate/direct tabs, DevTools.
 * @param {object} ctx
 */
function registerCookiesDnsIpc(ctx) {
    function getResolvedProxyUpstreamFromProfile(profile, ephemeralVars) {
        if (!profile) return null;
        let template = null;
        if (profile.url_encrypted && ctx.safeStorage?.isEncryptionAvailable()) {
            try { template = ctx.safeStorage.decryptString(profile.url_encrypted); } catch {}
        }
        if (!template) return null;
        let savedVars = {};
        try { savedVars = profile.variables ? JSON.parse(profile.variables) : {}; } catch {}
        const mergedVars = { ...savedVars, ...(ephemeralVars && typeof ephemeralVars === 'object' ? ephemeralVars : {}) };
        return ctx.parseProxyTemplate(template, mergedVars);
    }

    async function applyMitmAndFingerprintForTabProxy(tid, proxyProfileId, ephemeralVars) {
        const tab = ctx.tabManager.getTab(tid);
        if (!tab) return;
        if (!proxyProfileId || !ctx.mitmProxy) {
            if (ctx.mitmProxy) ctx.mitmProxy.removeTabUpstream(tid);
            if (ctx.resetFingerprintOnWebContents && tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
                await ctx.resetFingerprintOnWebContents(tab.view.webContents);
            }
            return;
        }
        const profile = ctx.db.getProxyProfileEncrypted(proxyProfileId);
        if (!profile) return;
        const resolvedUrl = getResolvedProxyUpstreamFromProfile(profile, ephemeralVars);
        ctx.mitmProxy.setTabUpstream(tid, {
            upstream: resolvedUrl,
            browser:  profile.tls_profile || null,
            ja3:      profile.tls_ja3_mode === 'custom' ? profile.tls_ja3_custom : null,
        });
        if (ctx.applyFingerprintFromProfile && tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
            await ctx.applyFingerprintFromProfile(tab.view.webContents, proxyProfileId);
        }
    }
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
        const rewrite_host = String(payload?.rewrite_host ?? '').trim();
        try {
            const savedId = await ctx.db.saveDnsOverrideAsync({ id, host, ip, enabled, mitm_inject_cors, rewrite_host });
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
        // Mirror set-tab-cookie-group: new BrowserView/session loses MITM upstream + logging unless re-applied.
        if (result?.success) {
            const tab = ctx.tabManager.getTab(tid);
            if (tab) {
                ctx.setupNetworkLogging(tab.view.webContents, tab.id, ctx.currentSessionId);
                if (ctx.interceptor) {
                    try { ctx.interceptor.attachToSession(tab.tabSession, tab.id); } catch (e) {
                        ctx.sysLog('warn', 'tabs', 'interceptor attach on isolate-tab failed: ' + (e?.message || e));
                    }
                }
                if (tab.proxyProfileId) {
                    await applyMitmAndFingerprintForTabProxy(tid, tab.proxyProfileId);
                }
            }
            ctx.notifyCookieManagerTabs();
            if (typeof ctx.notifyProxyStatus === 'function') ctx.notifyProxyStatus();
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

    ctx.ipcMain.handle('open-cookie-manager', async (_, tabId) => {
        ctx.createCookieManagerWindow(tabId || ctx.tabManager.getActiveTabId());
        return true;
    });

    // ── Per-tab controls ────────────────────────────────────────────────────

    ctx.ipcMain.handle('set-tab-proxy', async (_, tabId, proxyProfileId, ephemeralVars) => {
        const tid = tabId || ctx.tabManager.getActiveTabId();
        const result = await ctx.tabManager.setTabProxy(tid, proxyProfileId);
        if (!result?.success) return result;

        await applyMitmAndFingerprintForTabProxy(tid, proxyProfileId || null, ephemeralVars);
        const tab = ctx.tabManager.getTab(tid);
        if (tab?.view?.webContents && ctx.setupNetworkLogging) {
            try {
                await ctx.setupNetworkLogging(tab.view.webContents, tab.id, tab.sessionId ?? ctx.currentSessionId);
            } catch (_) { /* ignore */ }
        }
        if (typeof ctx.notifyProxyStatus === 'function') ctx.notifyProxyStatus();
        try {
            let profileLabel = 'Direct · tab';
            if (proxyProfileId && ctx.db?.getProxyProfileEncrypted) {
                const prow = ctx.db.getProxyProfileEncrypted(proxyProfileId);
                if (prow?.name) profileLabel = `${prow.name} · tab`;
                else profileLabel = `Profile #${proxyProfileId} · tab`;
            }
            await insertCupnetTrafficSnapshotWithGeo(ctx, {
                mode: proxyProfileId ? 'proxy' : 'direct',
                profileName: profileLabel,
            }).catch(() => {});
        } catch (_) { /* ignore */ }
        return result;
    });

    ctx.ipcMain.handle('set-tab-cookie-group', async (_, tabId, cookieGroupId) => {
        const tid = tabId || ctx.tabManager.getActiveTabId();
        const result = await ctx.tabManager.setTabCookieGroup(tid, cookieGroupId);
        if (result?.success) {
            const tab = ctx.tabManager.getTab(tid);
            if (tab) {
                ctx.setupNetworkLogging(tab.view.webContents, tab.id, ctx.currentSessionId);
                if (ctx.interceptor) {
                    try { ctx.interceptor.attachToSession(tab.tabSession, tab.id); } catch {}
                }
                if (tab.proxyProfileId) {
                    await applyMitmAndFingerprintForTabProxy(tid, tab.proxyProfileId);
                }
            }
            ctx.notifyCookieManagerTabs();
        }
        return result;
    });

    // ── Cookie Groups ───────────────────────────────────────────────────────

    ctx.ipcMain.handle('get-cookie-groups', async () => {
        return ctx.db ? ctx.db.getCookieGroups() : [];
    });

    ctx.ipcMain.handle('create-cookie-group', async (_, name) => {
        try {
            const group = await ctx.db.createCookieGroupAsync(name);
            ctx.notifyCookieGroupsListsUpdated?.();
            return { success: true, group };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('copy-cookie-group', async (_, fromGroupId, newName) => {
        try {
            const newGroup = await ctx.db.createCookieGroupAsync(newName);
            if (!newGroup) return { success: false, error: 'Failed to create group' };

            const { session: electronSession } = require('electron');
            const srcPartition = ctx.tabManager.partitionForGroup(fromGroupId);
            const dstPartition = ctx.tabManager.partitionForGroup(newGroup.id);
            const srcSession = electronSession.fromPartition(srcPartition);
            const dstSession = electronSession.fromPartition(dstPartition);

            const cookies = await srcSession.cookies.get({});
            for (const c of cookies) {
                const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
                try { await dstSession.cookies.set({ ...c, url }); } catch {}
            }
            await dstSession.cookies.flushStore();
            ctx.notifyCookieGroupsListsUpdated?.();
            return { success: true, group: newGroup, copiedCount: cookies.length };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('rename-cookie-group', async (_, groupId, newName) => {
        try {
            await ctx.db.renameCookieGroupAsync(groupId, newName);
            ctx.notifyCookieGroupsListsUpdated?.();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('delete-cookie-group', async (_, groupId) => {
        try {
            const gid = Number(groupId);
            for (const tab of ctx.tabManager.getAllTabs()) {
                if ((tab.cookieGroupId ?? 1) === gid) {
                    return { success: false, error: 'A tab is still using this cookie group' };
                }
            }
            await ctx.db.deleteCookieGroupAsync(gid);
            const { session: electronSession } = require('electron');
            const part = ctx.tabManager.partitionForGroup(gid);
            const s = electronSession.fromPartition(part);
            await s.clearStorageData();
            ctx.notifyCookieGroupsListsUpdated?.();
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
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
