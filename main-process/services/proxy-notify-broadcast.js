'use strict';
/**
 * IPC: proxy-status-changed, mitm-ready-changed, proxy-profiles-list.
 * Состояние читается геттерами — актуально на момент вызова.
 */
function createProxyNotifyBroadcast({
    safeCatch,
    BrowserWindow,
    getTabManager,
    getDb,
    getMainWindow,
    getProxyManagerWindow,
    getPersistentAnonymizedProxyUrl,
    getActProxy,
    getConnectedProfileName,
    getConnectedProfileId,
    getConnectedResolvedVars,
    getCurrentTrafficMode,
    getMitmReady,
}) {
    let _lastProxyStatusSig = '';

    function notifyProxyStatus() {
        const persistentAnonymizedProxyUrl = typeof getPersistentAnonymizedProxyUrl === 'function'
            ? getPersistentAnonymizedProxyUrl()
            : null;
        const actProxy = typeof getActProxy === 'function' ? getActProxy() : '';
        const isDirect = !persistentAnonymizedProxyUrl && actProxy === '';
        const trafficMode = typeof getCurrentTrafficMode === 'function' ? getCurrentTrafficMode() : 'browser_proxy';
        const info = {
            active: !!persistentAnonymizedProxyUrl,
            proxyName: (typeof getConnectedProfileName === 'function' ? getConnectedProfileName() : null) || actProxy || '',
            mode: isDirect ? 'direct' : (persistentAnonymizedProxyUrl ? 'proxy' : 'none'),
            trafficMode,
            effectiveMode: trafficMode,
            profileId: typeof getConnectedProfileId === 'function' ? getConnectedProfileId() : null,
            resolvedVars: (typeof getConnectedResolvedVars === 'function' ? getConnectedResolvedVars() : null) || {},
        };
        const sig = JSON.stringify(info);
        if (sig === _lastProxyStatusSig) return;
        _lastProxyStatusSig = sig;
        for (const win of BrowserWindow.getAllWindows()) {
            try {
                if (!win.isDestroyed()) win.webContents.send('proxy-status-changed', info);
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'proxy-status-changed.window' } }, err, 'info');
            }
        }
        const tabManager = typeof getTabManager === 'function' ? getTabManager() : null;
        if (tabManager) {
            for (const tab of tabManager.getAllTabs()) {
                try {
                    if (tab.view && !tab.view.webContents.isDestroyed()) {
                        tab.view.webContents.send('proxy-status-changed', info);
                    }
                } catch (err) {
                    safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'proxy-status-changed.tab' } }, err, 'info');
                }
            }
        }
    }

    function notifyMitmReady() {
        const mitmReady = typeof getMitmReady === 'function' ? getMitmReady() : false;
        const info = { ready: !!mitmReady, ts: Date.now() };
        for (const win of BrowserWindow.getAllWindows()) {
            try {
                if (!win.isDestroyed()) win.webContents.send('mitm-ready-changed', info);
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'mitm-ready-changed.window' } }, err, 'info');
            }
        }
        const tabManager = typeof getTabManager === 'function' ? getTabManager() : null;
        if (tabManager) {
            for (const tab of tabManager.getAllTabs()) {
                try {
                    if (tab.view && !tab.view.webContents.isDestroyed()) {
                        tab.view.webContents.send('mitm-ready-changed', info);
                    }
                } catch (err) {
                    safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'mitm-ready-changed.tab' } }, err, 'info');
                }
            }
        }
    }

    function notifyProxyProfilesList() {
        const db = typeof getDb === 'function' ? getDb() : null;
        if (!db || typeof db.getProxyProfiles !== 'function') return;
        const list = db.getProxyProfiles();
        const proxyManagerWindow = typeof getProxyManagerWindow === 'function' ? getProxyManagerWindow() : null;
        const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
        if (proxyManagerWindow && !proxyManagerWindow.isDestroyed()) {
            proxyManagerWindow.webContents.send('proxy-profiles-list', list);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('proxy-profiles-list', list);
        }
    }

    return {
        notifyProxyStatus,
        notifyMitmReady,
        notifyProxyProfilesList,
    };
}

module.exports = { createProxyNotifyBroadcast };
