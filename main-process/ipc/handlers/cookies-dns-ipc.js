'use strict';

const { insertCupnetTrafficSnapshotWithGeo } = require('../../services/cupnet-network-meta-log');
const { confirmOpenAnotherTab } = require('../../services/tab-open-confirm');

// ── Managed DevTools (real BrowserWindow + setDevToolsWebContents) ───────────
// Track by tab.id (Map), not WeakMap(webContents): the same logical tab must
// always resolve to one DevTools BrowserWindow; WeakMap lookups were missing on
// repeat clicks → duplicate white windows.
const _dtByTabId = new Map();
const _dtDestroyGuards = new Set();

function _focusDevToolsWindow(devWin) {
    if (!devWin || devWin.isDestroyed()) return;
    if (devWin.isMinimized()) devWin.restore();
    devWin.show();
    devWin.focus();
}

function _openManagedDevTools(wc, tabManager, tab) {
    const { BrowserWindow } = require('electron');
    const tabId = tab.id;
    const existing = _dtByTabId.get(tabId);
    if (existing && !existing.isDestroyed()) {
        _focusDevToolsWindow(existing);
        return true;
    }
    if (existing) _dtByTabId.delete(tabId);

    // getAllTabs() returns MapIterator (tabs.values()), not Array — no findIndex.
    const tabList = Array.from(tabManager.getAllTabs());
    const tabNum = Math.max(1, tabList.findIndex((t) => t.id === tab.id) + 1);
    const winTitle = `devtools #${tabNum}`;

    const devWin = new BrowserWindow({
        title: winTitle,
        show: false,
        width: 960,
        height: 700,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    _dtByTabId.set(tabId, devWin);

    devWin.on('closed', () => {
        _dtByTabId.delete(tabId);
        if (!wc.isDestroyed() && wc.isDevToolsOpened()) {
            try { wc.closeDevTools(); } catch (_) {}
        }
    });

    // Register devtools-closed ONLY after a real open — avoids spurious close during init.
    wc.once('devtools-opened', () => {
        wc.once('devtools-closed', () => {
            _dtByTabId.delete(tabId);
            if (devWin && !devWin.isDestroyed()) {
                try { devWin.close(); } catch (_) {}
            }
        });
    });

    if (!_dtDestroyGuards.has(tabId)) {
        _dtDestroyGuards.add(tabId);
        wc.once('destroyed', () => {
            _dtDestroyGuards.delete(tabId);
            const w = _dtByTabId.get(tabId);
            _dtByTabId.delete(tabId);
            if (w && !w.isDestroyed()) try { w.close(); } catch (_) {}
        });
    }

    wc.setDevToolsWebContents(devWin.webContents);
    wc.openDevTools({ mode: 'detach' });
    try { devWin.setTitle(winTitle); } catch (_) {}
    devWin.show();
    devWin.focus();
    return true;
}

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
        if (!(await confirmOpenAnotherTab(ctx))) return null;
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
        if (!tab || tab.view.webContents.isDestroyed()) return false;
        const wc = tab.view.webContents;
        const tabId = tab.id;
        const { app } = require('electron');
        try { app.focus({ steal: true }); } catch (_) {}

        // Prefer stable tab id — same as _openManagedDevTools guard (no duplicate windows).
        const managed = _dtByTabId.get(tabId);
        if (managed && !managed.isDestroyed()) {
            _focusDevToolsWindow(managed);
            return true;
        }

        if (wc.isDevToolsOpened()) {
            await new Promise((resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    resolve();
                };
                wc.once('devtools-closed', finish);
                try { wc.closeDevTools(); } catch (_) { finish(); }
                setTimeout(finish, 400);
            });
        }

        if (wc.isDestroyed()) return false;
        return _openManagedDevTools(wc, ctx.tabManager, tab);
    });
}

/** For window switcher: BrowserWindow ids of managed DevTools (detach). */
function getManagedDevToolsWindowIds() {
    const ids = [];
    for (const [, bw] of _dtByTabId) {
        if (bw && !bw.isDestroyed()) {
            try { ids.push(bw.id); } catch (_) { /* ignore */ }
        }
    }
    return ids;
}

/**
 * Rich metadata for DevTools tiles: tab index (#N) and inspected page title (from webContents).
 * @param {{ tabManager?: { getAllTabs: () => Iterable<unknown>; getTab: (id: unknown) => unknown } }} ctx
 */
function getManagedDevToolsSwitcherEntries(ctx) {
    const out = [];
    for (const [tabId, bw] of _dtByTabId) {
        if (!bw || bw.isDestroyed()) continue;
        let tabNum = 1;
        let tabTitle = '';
        try {
            if (ctx && ctx.tabManager) {
                const tabList = Array.from(ctx.tabManager.getAllTabs());
                const idx = tabList.findIndex((t) => t.id === tabId);
                tabNum = idx >= 0 ? idx + 1 : 1;
                const tab = ctx.tabManager.getTab(tabId);
                if (tab && tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
                    tabTitle = tab.view.webContents.getTitle() || '';
                }
            }
        } catch (_) { /* ignore */ }
        try {
            out.push({
                id: bw.id,
                title: `DevTools #${tabNum}`,
                type: 'devtools',
                devtoolsTabNum: tabNum,
                tabTitle: tabTitle || undefined,
            });
        } catch (_) { /* ignore */ }
    }
    return out;
}

module.exports = {
    registerCookiesDnsIpc,
    getManagedDevToolsWindowIds,
    getManagedDevToolsSwitcherEntries,
};
