'use strict';

const { insertCupnetTrafficSnapshotWithGeo } = require('../../services/cupnet-network-meta-log');
const { confirmOpenAnotherTab } = require('../../services/tab-open-confirm');
const { isDevtoolsHostileWebContents } = require('../../services/devtools-hostile-sites');
const {
    openManagedDevTools,
    getManagedDevToolsWindowIds,
    getManagedDevToolsSwitcherEntries,
} = require('../../services/managed-devtools');
const { resolveProxyTemplateFromDbRow } = require('../../services/proxy-profile-resolve');
const {
    buildCookieRequestUrl,
    cookieMatchesDomainFilter,
    cookiesMatchIdentity,
    consolidateCookiesToParent,
    normalizeRemoveCookieArgs,
    purgeCookiesForHostnameAllTabs,
    removeSessionCookiePrecise,
} = require('../../services/session-cookie-utils.js');

/**
 * Cookies, DNS overrides, isolate/direct tabs, DevTools.
 * @param {object} ctx
 */
function registerCookiesDnsIpc(ctx) {
    const { guardIpcHandler } = require('../ipc-trusted-sender.js');

    function _tabForCookieAccess(event, tabId) {
        const tab = tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
        if (!tab?.view?.webContents) return null;
        if (tab.view.webContents.id === event.sender.id) return tab;
        return null;
    }

    function _cookieSessionTab(event, tabId) {
        const owned = _tabForCookieAccess(event, tabId);
        if (owned) return owned;
        const { assertTrustedShell } = require('../ipc-trusted-sender.js');
        assertTrustedShell(event, 'cookies');
        return tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
    }
    function getResolvedProxyUpstreamFromProfile(profile, ephemeralVars) {
        return resolveProxyTemplateFromDbRow(ctx, profile, ephemeralVars);
    }

    async function applyMitmAndFingerprintForTabProxy(tid, proxyProfileId, ephemeralVars) {
        const tab = ctx.tabManager.getTab(tid);
        if (!tab) return;
        if (!proxyProfileId || !ctx.mitmProxy) {
            if (ctx.mitmProxy) ctx.mitmProxy.removeTabUpstream(tid);
            // Back to the effective global identity for this tab.
            if (ctx.identityService) await ctx.identityService.setTabOverride(tid, null);
            return;
        }
        const profile = ctx.db.getProxyProfileEncrypted(proxyProfileId);
        if (!profile) return;
        const resolvedUrl = getResolvedProxyUpstreamFromProfile(profile, ephemeralVars);
        const overrides = profile.identity_override;
        // TLS / JA3 / forceHttp1 follow the tab profile only when it overrides the identity;
        // otherwise the tab inherits the global effective identity (browser/ja3 null → global).
        ctx.mitmProxy.setTabUpstream(tid, {
            upstream: resolvedUrl,
            browser:  overrides ? (profile.tls_profile || null) : null,
            ja3:      overrides && profile.tls_ja3_mode === 'custom' ? profile.tls_ja3_custom : null,
            forceHttp1: overrides ? !!profile.force_http1 : null,
        });
        if (ctx.identityService) await ctx.identityService.setTabOverride(tid, overrides ? profile : null);
    }
    ctx.ipcMain.handle('get-cookies', async (event, tabId, filter) => {
        const tab = _cookieSessionTab(event, tabId);
        if (!tab) return [];
        return tab.tabSession.cookies.get(filter || {});
    });

    ctx.ipcMain.handle('set-cookie', async (event, tabId, details) => {
        const tab = _cookieSessionTab(event, tabId);
        if (!tab) return { success: false, error: 'Tab not found' };
        try {
            await tab.tabSession.cookies.set(details);
            await tab.tabSession.cookies.flushStore();
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('remove-cookie', async (_, tabId, cookieOrUrl, name) => {
        const tab = tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
        if (!tab) return { success: false, error: 'Tab not found' };
        try {
            const cookie = normalizeRemoveCookieArgs(cookieOrUrl, name);
            await removeSessionCookiePrecise(tab.tabSession, cookie);
            await tab.tabSession.cookies.flushStore();
            const left = await tab.tabSession.cookies.get({});
            if (left.some((c) => cookiesMatchIdentity(c, cookie))) {
                return { success: false, error: 'Cookie was not removed' };
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('clear-cookies', async (_, tabId, domain) => {
        const tab = tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
        if (!tab) return { success: false, error: 'Tab not found' };
        try {
            const dom = domain ? String(domain).trim() : '';

            if (!dom) {
                const before = (await tab.tabSession.cookies.get({})).length;
                await tab.tabSession.clearStorageData({ storages: ['cookies'] });
                await tab.tabSession.cookies.flushStore();
                const remaining = (await tab.tabSession.cookies.get({})).length;
                return {
                    success: remaining === 0,
                    count: before,
                    remaining,
                    error: remaining > 0 ? `${remaining} cookie(s) still in jar` : undefined,
                };
            }

            const cookies = (await tab.tabSession.cookies.get({}))
                .filter((c) => cookieMatchesDomainFilter(c, dom));
            for (const c of cookies) {
                try {
                    await removeSessionCookiePrecise(tab.tabSession, { ...c, url: buildCookieRequestUrl(c) });
                } catch (e) {
                    ctx.sysLog('warn', 'tabs', 'cookie remove failed: ' + (e?.message || e));
                }
            }
            await tab.tabSession.cookies.flushStore();
            const remaining = (await tab.tabSession.cookies.get({}))
                .filter((c) => cookieMatchesDomainFilter(c, dom)).length;
            return {
                success: remaining === 0,
                count: cookies.length,
                remaining,
                error: remaining > 0 ? `${remaining} cookie(s) still in jar` : undefined,
            };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('consolidate-cookies', async (_, tabId, anchorHost) => {
        const tab = tabId ? ctx.tabManager.getTab(tabId) : ctx.tabManager.getActiveTab();
        if (!tab) return { success: false, error: 'Tab not found' };
        try {
            let anchor = String(anchorHost || '').trim();
            if (!anchor) {
                const raw = tab.displayUrlOverride || tab.url || tab.view?.webContents?.getURL?.() || '';
                try { anchor = new URL(raw).hostname; } catch { anchor = ''; }
            }
            if (!anchor) return { success: false, error: 'No anchor host (open a site tab or set domain filter)' };
            const result = await consolidateCookiesToParent(tab.tabSession, { anchorHost: anchor });
            return { success: true, ...result };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('share-cookies', guardIpcHandler('share-cookies', async (_, fromTabId, toTabId, domain) => {
        const fromTab = ctx.tabManager.getTab(fromTabId);
        const toTab   = ctx.tabManager.getTab(toTabId);
        if (!fromTab || !toTab) return { success: false, error: 'Tab not found' };
        try {
            const filter  = domain ? { domain } : {};
            const cookies = await fromTab.tabSession.cookies.get(filter);
            let count = 0;
            for (const c of cookies) {
                const url = buildCookieRequestUrl(c);
                try { await toTab.tabSession.cookies.set({ ...c, url }); count++; } catch (e) { ctx.sysLog('warn', 'tabs', 'cookie share/set failed: ' + (e?.message || e)); }
            }
            await toTab.tabSession.cookies.flushStore();
            return { success: true, count };
        } catch (e) { return { success: false, error: e.message }; }
    }));

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

        let mitm_inject_cors = false;
        if (id && ctx.db) {
            try {
                const cur = ctx.db.getDnsOverrides().find((r) => Number(r.id) === id);
                if (cur) mitm_inject_cors = !!cur.mitm_inject_cors;
            } catch (_) { /* ignore */ }
        }
        const isWildcard = host.startsWith('*.');
        if (isWildcard && ip) return { success: false, error: 'Wildcard host (*.…) cannot be combined with IPv4' };
        const needIpv4 = !mitm_inject_cors || !!ip;
        if (needIpv4 && !ctx.isValidIpv4(ip)) return { success: false, error: 'Invalid IPv4 address' };
        const rewrite_host = String(payload?.rewrite_host ?? '').trim();
        try {
            const savedId = await ctx.db.saveDnsOverrideAsync({ id, host, ip, enabled, mitm_inject_cors, rewrite_host });
            ctx.syncDnsOverridesToMitm();
            if (rewrite_host && !isWildcard) {
                const dnsHost = host.replace(/^\*\./, '');
                const rewriteNorm = rewrite_host.toLowerCase();
                if (dnsHost && dnsHost !== rewriteNorm) {
                    try {
                        await purgeCookiesForHostnameAllTabs(ctx.tabManager, dnsHost);
                    } catch (e) {
                        ctx.sysLog('warn', 'tabs', 'purge cookies on DNS rewrite failed: ' + (e?.message || e));
                    }
                }
            }
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
        // Mirror set-tab-cookie-group: new WebContentsView/session loses MITM upstream + logging unless re-applied.
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
                const url = buildCookieRequestUrl(c);
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
    // When invoked from a secondary window (Proxy Manager, Rules, Log viewer, …),
    // open DevTools for that window — not for the browser tab. The main CupNet
    // window uses the same preload API, so we branch on ipc sender's BrowserWindow.
    ctx.ipcMain.handle('open-devtools', async (event) => {
        const { BrowserWindow, app } = require('electron');
        const mainWin = typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : null;
        const senderWin = event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
        if (mainWin && !mainWin.isDestroyed() && senderWin && !senderWin.isDestroyed() && senderWin.id !== mainWin.id) {
            try { app.focus({ steal: true }); } catch (_) { /* ignore */ }
            try {
                senderWin.webContents.openDevTools({ mode: 'detach', activate: true });
            } catch (_) { /* ignore */ }
            return true;
        }

        const tab = ctx.tabManager?.getActiveTab();
        if (!tab || tab.view.webContents.isDestroyed()) return false;
        const wc = tab.view.webContents;
        try { app.focus({ steal: true }); } catch (_) {}
        if (isDevtoolsHostileWebContents(wc)) {
            if (wc.isDevToolsOpened()) {
                try { wc.closeDevTools(); } catch (_) {}
            }
            return false;
        }

        return openManagedDevTools(wc, ctx.tabManager, tab);
    });
}

module.exports = {
    registerCookiesDnsIpc,
    getManagedDevToolsWindowIds,
    getManagedDevToolsSwitcherEntries,
};
