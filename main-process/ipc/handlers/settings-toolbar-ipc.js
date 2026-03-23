'use strict';

/**
 * Настройки для toolbar / фильтры / bypass / traffic.
 * @param {object} ctx
 */
function registerSettingsToolbarIpc(ctx) {
    // ── Inline settings (browser toolbar) ───────────────────────────────────
    ctx.ipcMain.handle('get-settings-all', () => {
        const s = ctx.loadSettings();
        return {
            filterPatterns:  s.filterPatterns  || [],
            pasteUnlock:     s.pasteUnlock !== false,
            bypassDomains:   s.bypassDomains || [],
            trafficOpts:     s.trafficOpts || {},
            effectiveTrafficMode: ctx.getCurrentTrafficMode(),
            tracking:        ctx.getTrackingSettings(),
            capmonster:      ctx.getCapmonsterSettings(),
        };
    });

    ctx.ipcMain.handle('set-paste-unlock', (_, enabled) => {
        const s = ctx.loadSettings();
        s.pasteUnlock = !!enabled;
        ctx.saveSettings(s);
        ctx.tabManager.setPasteUnlock(s.pasteUnlock);
        return { success: true, pasteUnlock: s.pasteUnlock };
    });

    // Adjust BrowserView y-offset to reveal HTML overlay panels (e.g. settings)
    ctx.ipcMain.handle('set-toolbar-height', (_, extraPx) => {
        ctx.tabManager.setExtraTopOffset(extraPx || 0);
        return true;
    });

    ctx.ipcMain.handle('set-auto-screenshot', async (_, seconds) => {
        const s = ctx.loadSettings();
        s.autoScreenshot = Math.max(0, Math.min(60, Number(seconds) || 0)); // legacy compatibility
        ctx.saveSettings(s);
        return true;
    });

    ctx.ipcMain.handle('get-tracking-settings', () => ctx.getTrackingSettings());
    ctx.ipcMain.handle('save-tracking-settings', (_, cfg) => {
        const s = ctx.loadSettings();
        s.tracking = ctx.normalizeTrackingSettings(cfg);
        ctx.saveSettings(s);
        return s.tracking;
    });

    ctx.ipcMain.handle('save-filter-patterns', async (_, patterns) => {
        const s = ctx.loadSettings();
        s.filterPatterns = Array.isArray(patterns) ? patterns : [];
        ctx.saveSettings(s);
        return true;
    });

    ctx.ipcMain.handle('save-bypass-domains', async (_, domains) => {
        const s = ctx.loadSettings();
        s.bypassDomains = Array.isArray(domains) ? domains : [];
        ctx.saveSettings(s);
        ctx.applyBypassDomains(s.bypassDomains);
        return true;
    });

    ctx.ipcMain.handle('save-traffic-opts', async (_, opts) => {
        const s = ctx.loadSettings();
        s.trafficOpts = { ...(s.trafficOpts || {}), ...opts };
        ctx.saveSettings(s);
        ctx.applyTrafficFilters(s.trafficOpts);
        return true;
    });

    ctx.ipcMain.handle('get-traffic-opts', () => {
        const s = ctx.loadSettings();
        return s.trafficOpts || {};
    });
}

module.exports = { registerSettingsToolbarIpc };
