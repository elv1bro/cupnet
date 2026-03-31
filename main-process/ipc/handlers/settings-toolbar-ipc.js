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
            devicePermissions: ctx.settingsStore.normalizeDevicePermissions(s.devicePermissions),
            maxTabsBeforeWarning: ctx.settingsStore.normalizeMaxTabsBeforeWarning(s),
        };
    });

    ctx.ipcMain.handle('set-paste-unlock', (_, enabled) => {
        const s = ctx.loadSettings();
        s.pasteUnlock = !!enabled;
        ctx.saveSettings(s);
        ctx.tabManager.setPasteUnlock(s.pasteUnlock);
        return { success: true, pasteUnlock: s.pasteUnlock };
    });

    ctx.ipcMain.handle('set-max-tabs-before-warning', (_, value) => {
        const s = ctx.loadSettings();
        s.maxTabsBeforeWarning = ctx.settingsStore.normalizeMaxTabsBeforeWarning({ maxTabsBeforeWarning: value });
        ctx.saveSettings(s);
        return { success: true, maxTabsBeforeWarning: s.maxTabsBeforeWarning };
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

    ctx.ipcMain.handle('enumerate-media-devices', async () => {
        const win = ctx.mainWindow;
        if (!win || win.isDestroyed()) return [];
        try {
            const devices = await win.webContents.executeJavaScript(`(async () => {
                if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
                const list = await navigator.mediaDevices.enumerateDevices();
                return list
                    .filter((d) => d.kind === 'videoinput')
                    .map((d) => ({ deviceId: d.deviceId, label: d.label || '', kind: d.kind }));
            })()`, false);
            return Array.isArray(devices) ? devices : [];
        } catch {
            return [];
        }
    });

    ctx.ipcMain.handle('save-device-permissions', (_, raw) => {
        const s = ctx.loadSettings();
        s.devicePermissions = ctx.settingsStore.normalizeDevicePermissions(raw);
        ctx.saveSettings(s);
        if (ctx.tabManager && typeof ctx.tabManager.applyDevicePermissions === 'function') {
            ctx.tabManager.applyDevicePermissions();
        }
        return s.devicePermissions;
    });

    // Synchronous IPC for preload: must return before ANY page script runs.
    ctx.ipcMain.on('get-device-permissions-sync', (event) => {
        try {
            const dp = ctx.tabManager._getCameraFilterDataForPreload();
            if (!dp) { event.returnValue = null; return; }
            event.returnValue = {
                script: ctx.tabManager.buildCameraFilterScript(dp),
            };
        } catch {
            event.returnValue = null;
        }
    });
}

module.exports = { registerSettingsToolbarIpc };
