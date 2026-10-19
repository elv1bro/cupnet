'use strict';

const { guardIpcHandler } = require('../ipc-trusted-sender');

/**
 * Browser Identity IPC (trusted shell windows only):
 *   identity:get            → { settings, global, effective, source, templates, cdpEnabled }
 *   open-identity-manager({mode?}) → Browser ID window (optionally pre-switched to a mode)
 *   identity:set(patch)     → apply + persist the GLOBAL identity, returns the new status
 *   identity:apply(patch,{autoCheck}) → apply + persist the GLOBAL identity; autoCheck opens/refreshes the self-check tab.
 *   identity:preview(s)     → resolve settings without applying (editor live preview)
 *   identity:open-check     → self-check tab (cupnet://identity-check), reused if already open
 *   get-identity-navigator-patch-sync (preload-view, per tab) → { script|null }
 * The toolbar "Browser ID" button opens the Browser ID window directly (no dropdown menu): the tab
 * WebContentsView paints above the shell HTML, so identity switching lives in the window instead.
 * @param {object} ctx
 */
function registerIdentityIpc(ctx) {
    const svc = () => ctx.identityService;
    let identityCheckTabId = null; // reuse one self-check tab instead of spawning a new one each time

    // Open (or reuse) the built-in self-check tab in the main window.
    async function openOrReuseCheckTab() {
        const url = ctx.getInternalPageUrl('identity-check');
        const existing = identityCheckTabId && ctx.tabManager?.getTab?.(identityCheckTabId);
        const wc = existing?.view?.webContents;
        if (wc && !wc.isDestroyed()) {
            ctx.tabManager.switchTab(identityCheckTabId);
            try { wc.reload(); } catch { /* ignore */ }
        } else {
            identityCheckTabId = await ctx.tabManager.createTab({ url, cookieGroupId: 1 });
            ctx.tabManager.switchTab(identityCheckTabId);
        }
        ctx.notifyCookieManagerTabs?.();
        try { if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) { ctx.mainWindow.show(); ctx.mainWindow.focus(); } } catch { /* ignore */ }
        return identityCheckTabId;
    }

    ctx.ipcMain.handle('identity:apply', guardIpcHandler('identity:apply', async (_, patch, opts) => {
        const s = svc();
        if (!s) return { success: false, error: 'identity service unavailable' };
        const autoCheck = !!(opts && opts.autoCheck);
        try {
            // Identity is global and managed only in Browser ID (proxies never carry identity).
            await s.setSettings(patch && typeof patch === 'object' ? patch : {}, { reason: 'identity-manager' });
            ctx.buildMenu?.();
            let checkTabId = null;
            if (autoCheck) { try { checkTabId = await openOrReuseCheckTab(); } catch { /* ignore */ } }
            return { success: true, appliedTo: 'global', checkTabId, ...s.getStatus(), templates: s.listTemplates() };
        } catch (e) {
            ctx.safeCatch?.({ module: 'main', eventCode: 'identity.apply.failed' }, e, 'warn');
            return { success: false, error: e?.message || String(e) };
        }
    }));

    ctx.ipcMain.handle('identity:get', guardIpcHandler('identity:get', () => {
        const s = svc();
        if (!s) return { success: false, error: 'identity service unavailable' };
        return { success: true, ...s.getStatus(), templates: s.listTemplates() };
    }));

    ctx.ipcMain.handle('identity:set', guardIpcHandler('identity:set', async (_, patch) => {
        const s = svc();
        if (!s) return { success: false, error: 'identity service unavailable' };
        try {
            await s.setSettings(patch && typeof patch === 'object' ? patch : {}, { reason: 'identity-manager' });
            ctx.buildMenu?.();
            return { success: true, ...s.getStatus() };
        } catch (e) {
            ctx.safeCatch?.({ module: 'main', eventCode: 'identity.set.failed' }, e, 'warn');
            return { success: false, error: e?.message || String(e) };
        }
    }));

    ctx.ipcMain.handle('identity:preview', guardIpcHandler('identity:preview', (_, settings) => {
        const s = svc();
        if (!s) return null;
        return s.preview(settings && typeof settings === 'object' ? settings : {});
    }));

    // opts.mode ('engine' | 'template' | 'custom'): open the window already switched to that mode
    // (toolbar "Custom User-Agent…" → window in Custom mode with the UA field focused).
    ctx.ipcMain.handle('open-identity-manager', async (_, opts) => {
        const mode = opts && typeof opts === 'object' && ['engine', 'template', 'custom'].includes(opts.mode) ? opts.mode : null;
        ctx.createIdentityManagerWindow?.(mode ? { mode } : undefined);
        return true;
    });

    // Built-in self-check page (cupnet://identity-check) — reuse an already-open check tab.
    ctx.ipcMain.handle('identity:open-check', guardIpcHandler('identity:open-check', async () => {
        try {
            const tabId = await openOrReuseCheckTab();
            return { success: true, tabId };
        } catch (e) {
            return { success: false, error: e?.message || String(e) };
        }
    }));

    // Tab preload (untrusted pages): only a tiny navigator patch, never identity details.
    ctx.ipcMain.on('get-identity-navigator-patch-sync', (event) => {
        try {
            const s = svc();
            const tabId = ctx.tabManager?.getTabIdByWebContentsId?.(event.sender?.id) || null;
            let permissionDecisions = null;
            try {
                const frameUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
                const origin = new URL(frameUrl).origin;
                if (origin && origin !== 'null' && typeof ctx.tabManager?.permissionDecisionsFor === 'function') {
                    permissionDecisions = ctx.tabManager.permissionDecisionsFor(tabId, origin);
                }
            } catch { /* about:blank and internal pages have no http origin */ }
            event.returnValue = { script: s ? s.getNavigatorPatchScript(tabId, { permissionDecisions }) : null };
        } catch {
            event.returnValue = { script: null };
        }
    });
}

module.exports = { registerIdentityIpc };
