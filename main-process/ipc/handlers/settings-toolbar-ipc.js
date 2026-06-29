'use strict';

const { isDevtoolsHostileUrl } = require('../../services/devtools-hostile-sites');
const { buildAntiAntiDebugScript } = require('../../services/anti-anti-debug-script');
const { getPasteUnlockScript } = require('../../services/paste-unlock');

/**
 * Настройки для toolbar / фильтры / traffic.
 * @param {object} ctx
 */
function reattachActivityMonitorToAllTabs(ctx) {
    const setup = ctx.setupNetworkLogging;
    if (typeof setup !== 'function' || !ctx.tabManager || typeof ctx.tabManager.getAllTabs !== 'function') return;
    const injectStorage = typeof ctx.tabManager.injectStorageActivityMonitor === 'function'
        ? ctx.tabManager.injectStorageActivityMonitor.bind(ctx.tabManager)
        : null;
    const s = ctx.loadSettings();
    for (const tab of ctx.tabManager.getAllTabs()) {
        if (!tab.view?.webContents || tab.view.webContents.isDestroyed()) continue;
        const sid = ctx.currentSessionId ?? tab.sessionId;
        if (sid == null) continue;
        tab.sessionId = sid;
        setup(tab.view.webContents, tab.id, sid).catch(() => {});
        if (injectStorage) injectStorage(tab.view.webContents);
    }
}

function applySettingsSideEffects(ctx) {
    const s = ctx.loadSettings();
    try {
        if (ctx.tabManager && typeof ctx.tabManager.setPasteUnlock === 'function') {
            ctx.tabManager.setPasteUnlock(s.pasteUnlock !== false);
        }
    } catch { /* ignore */ }
    try {
        if (typeof ctx.applyTrafficFilters === 'function') ctx.applyTrafficFilters(s.trafficOpts || {});
    } catch { /* ignore */ }
    try {
        if (ctx.tabManager && typeof ctx.tabManager.applyDevicePermissions === 'function') {
            ctx.tabManager.applyDevicePermissions();
        }
    } catch { /* ignore */ }
    try {
        if (ctx.mitmProxy && typeof ctx.mitmProxy.setGlobalCorsEnabled === 'function') {
            ctx.mitmProxy.setGlobalCorsEnabled(!!s.corsBypassEnabled);
        }
    } catch { /* ignore */ }
    try {
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
            ctx.mainWindow.webContents.send('cors-bypass-status', !!s.corsBypassEnabled);
        }
    } catch { /* ignore */ }
    broadcastBrowserChromeSettings(ctx);
    reattachActivityMonitorToAllTabs(ctx);
}

function broadcastBrowserChromeSettings(ctx) {
    try {
        const s = ctx.loadSettings();
        if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
        ctx.mainWindow.webContents.send('browser-settings-updated', {
            toolbarToolsPlacement: ctx.settingsStore.normalizeToolbarToolsPlacement(s),
            toolbarToolsMiniAlign: ctx.settingsStore.normalizeToolbarToolsMiniAlign(s),
        });
    } catch { /* ignore */ }
}

function registerSettingsToolbarIpc(ctx) {
    // ── Inline settings (browser toolbar) ───────────────────────────────────
    ctx.ipcMain.handle('onboarding-complete', () => {
        const s = ctx.loadSettings();
        s.onboardingComplete = true;
        ctx.saveSettings(s);
        return { success: true };
    });

    ctx.ipcMain.handle('reset-onboarding-wizard', () => {
        const s = ctx.loadSettings();
        s.onboardingComplete = false;
        ctx.saveSettings(s);
        if (typeof ctx.createOnboardingWindow === 'function') {
            try {
                ctx.createOnboardingWindow();
            } catch { /* ignore */ }
        }
        return { success: true };
    });

    ctx.ipcMain.handle('get-settings-all', () => {
        const s = ctx.loadSettings();
        const se = ctx.settingsStore.normalizeSearchEngineSettings(s);
        return {
            filterPatterns:  s.filterPatterns  || [],
            pasteUnlock:     s.pasteUnlock !== false,
            trafficOpts:     s.trafficOpts || {},
            effectiveTrafficMode: ctx.getCurrentTrafficMode(),
            tracking:        ctx.getTrackingSettings(),
            devicePermissions: ctx.settingsStore.normalizeDevicePermissions(s.devicePermissions),
            maxTabsBeforeWarning: ctx.settingsStore.normalizeMaxTabsBeforeWarning(s),
            onboardingComplete: !!s.onboardingComplete,
            activityMonitorEnabled: s.activityMonitorEnabled === true,
            activityMonitorRateLimit: Math.max(50, Math.min(500, Number(s.activityMonitorRateLimit) || ctx.settingsStore.SETTINGS_DEFAULTS.activityMonitorRateLimit)),
            activityMonitorStorageStackTraces: s.activityMonitorStorageStackTraces === true,
            searchEngine: se.searchEngine,
            searchEngineCustomUrl: se.searchEngineCustomUrl,
            corsBypassEnabled: s.corsBypassEnabled === true,
            toolbarToolsPlacement: ctx.settingsStore.normalizeToolbarToolsPlacement(s),
            toolbarToolsMiniAlign: ctx.settingsStore.normalizeToolbarToolsMiniAlign(s),
        };
    });

    ctx.ipcMain.handle('save-search-engine-settings', (_, opts) => {
        const s = ctx.loadSettings();
        const o = opts && typeof opts === 'object' ? opts : {};
        const n = ctx.settingsStore.normalizeSearchEngineSettings({
            searchEngine: o.searchEngine,
            searchEngineCustomUrl: o.searchEngineCustomUrl != null ? o.searchEngineCustomUrl : s.searchEngineCustomUrl,
        });
        s.searchEngine = n.searchEngine;
        s.searchEngineCustomUrl = n.searchEngineCustomUrl;
        ctx.saveSettings(s);
        return { success: true, searchEngine: n.searchEngine, searchEngineCustomUrl: n.searchEngineCustomUrl };
    });

    ctx.ipcMain.handle('save-activity-monitor-settings', (_, opts) => {
        const s = ctx.loadSettings();
        const o = opts && typeof opts === 'object' ? opts : {};
        s.activityMonitorEnabled = !!o.activityMonitorEnabled;
        s.activityMonitorRateLimit = Math.max(50, Math.min(500, Number(o.activityMonitorRateLimit) || ctx.settingsStore.SETTINGS_DEFAULTS.activityMonitorRateLimit));
        s.activityMonitorStorageStackTraces = !!o.activityMonitorStorageStackTraces;
        ctx.saveSettings(s);
        reattachActivityMonitorToAllTabs(ctx);
        return {
            success: true,
            activityMonitorEnabled: s.activityMonitorEnabled,
            activityMonitorRateLimit: s.activityMonitorRateLimit,
            activityMonitorStorageStackTraces: s.activityMonitorStorageStackTraces,
        };
    });

    ctx.ipcMain.handle('export-settings-json', () => {
        const s = ctx.loadSettings();
        const safe = ctx.settingsStore.exportSettingsSafe(s);
        try {
            return { success: true, json: JSON.stringify(safe, null, 2) };
        } catch (e) {
            return { success: false, error: e && e.message ? String(e.message) : 'export failed' };
        }
    });

    ctx.ipcMain.handle('import-settings-json', (_, jsonStr) => {
        let parsed;
        try {
            parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        } catch (e) {
            return { success: false, error: 'Invalid JSON' };
        }
        if (!parsed || typeof parsed !== 'object') {
            return { success: false, error: 'Invalid settings object' };
        }
        const cur = ctx.loadSettings();
        const merged = ctx.settingsStore.mergeImportedSettings(cur, parsed);
        ctx.saveSettings(merged);
        applySettingsSideEffects(ctx);
        return { success: true };
    });

    ctx.ipcMain.handle('reset-settings-to-defaults', () => {
        const fresh = ctx.settingsStore.buildFactoryResetSettings();
        ctx.saveSettings(fresh);
        applySettingsSideEffects(ctx);
        return { success: true };
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

    // Adjust tab WebContentsView y-offset to reveal HTML overlay panels (e.g. settings)
    ctx.ipcMain.handle('set-toolbar-height', (_, extraPx) => {
        ctx.tabManager.setExtraTopOffset(extraPx || 0);
        return true;
    });

    ctx.ipcMain.handle('set-bottom-chrome-height', (_, extraPx) => {
        ctx.tabManager.setExtraBottomOffset(extraPx || 0);
        return true;
    });

    ctx.ipcMain.handle('set-right-chrome-width', (_, extraPx) => {
        ctx.tabManager.setExtraRightOffset(extraPx || 0);
        return true;
    });

    ctx.ipcMain.handle('save-toolbar-tools-placement', (_, placement) => {
        const s = ctx.loadSettings();
        s.toolbarToolsPlacement = ctx.settingsStore.normalizeToolbarToolsPlacement({ toolbarToolsPlacement: placement });
        ctx.saveSettings(s);
        broadcastBrowserChromeSettings(ctx);
        return { success: true, toolbarToolsPlacement: s.toolbarToolsPlacement };
    });

    ctx.ipcMain.handle('save-toolbar-tools-mini-align', (_, align) => {
        const s = ctx.loadSettings();
        s.toolbarToolsMiniAlign = ctx.settingsStore.normalizeToolbarToolsMiniAlign({ toolbarToolsMiniAlign: align });
        ctx.saveSettings(s);
        broadcastBrowserChromeSettings(ctx);
        return { success: true, toolbarToolsMiniAlign: s.toolbarToolsMiniAlign };
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

    ctx.ipcMain.on('get-paste-unlock-sync', (event) => {
        try {
            const s = ctx.loadSettings();
            const enabled = s.pasteUnlock !== false;
            const stealth = Number(process.env.CUPNET_STEALTH_LEVEL || 0);
            if (!enabled || stealth >= 1) {
                event.returnValue = { script: null };
                return;
            }
            event.returnValue = { script: getPasteUnlockScript() };
        } catch {
            event.returnValue = { script: null };
        }
    });

    // Layer-2 anti-anti-debug shim — see main-process/services/anti-anti-debug-script.js.
    // Sync because the preload must inject before any page <script> executes.
    // URL preference order: payload from renderer (location.href at preload time) →
    // sender's webContents URL → empty (skip).
    ctx.ipcMain.on('get-anti-anti-debug-sync', (event, payload) => {
        try {
            const fromPayload = payload && typeof payload.url === 'string' ? payload.url : '';
            const fromSender = (() => {
                try { return event.sender && !event.sender.isDestroyed() ? event.sender.getURL() : ''; }
                catch { return ''; }
            })();
            const url = fromPayload || fromSender;
            if (!isDevtoolsHostileUrl(url)) { event.returnValue = { script: null }; return; }
            event.returnValue = { script: buildAntiAntiDebugScript() };
        } catch {
            event.returnValue = { script: null };
        }
    });
}

module.exports = { registerSettingsToolbarIpc };
