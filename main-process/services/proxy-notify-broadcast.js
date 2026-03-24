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

    function _buildBaseProxyStatus() {
        const persistentAnonymizedProxyUrl = typeof getPersistentAnonymizedProxyUrl === 'function'
            ? getPersistentAnonymizedProxyUrl()
            : null;
        const actProxy = typeof getActProxy === 'function' ? getActProxy() : '';
        const isDirect = !persistentAnonymizedProxyUrl && actProxy === '';
        const trafficMode = typeof getCurrentTrafficMode === 'function' ? getCurrentTrafficMode() : 'browser_proxy';
        const globalName = (typeof getConnectedProfileName === 'function' ? getConnectedProfileName() : null) || actProxy || '';
        return {
            active: !!persistentAnonymizedProxyUrl,
            proxyName: globalName,
            mode: isDirect ? 'direct' : (persistentAnonymizedProxyUrl ? 'proxy' : 'none'),
            trafficMode,
            effectiveMode: trafficMode,
            profileId: typeof getConnectedProfileId === 'function' ? getConnectedProfileId() : null,
            resolvedVars: (typeof getConnectedResolvedVars === 'function' ? getConnectedResolvedVars() : null) || {},
        };
    }

    /** Имя профиля для конкретной вкладки (per-tab proxy) или глобальное — для пилюли и виджета new-tab. */
    function _augmentProxyStatusForTab(base, tab) {
        const db = typeof getDb === 'function' ? getDb() : null;
        if (!tab || !tab.cupnetEnabled || !tab.proxyProfileId) {
            return {
                ...base,
                tabProxyProfileId: null,
                tabProxyName: '',
                displayProxyName: base.proxyName,
            };
        }
        let tabProxyName = '';
        try {
            const row = db?.getProxyProfileEncrypted?.(tab.proxyProfileId);
            if (row?.name) tabProxyName = String(row.name);
        } catch (_) { /* ignore */ }
        if (!tabProxyName) tabProxyName = `#${tab.proxyProfileId}`;
        return {
            ...base,
            tabProxyProfileId: tab.proxyProfileId,
            tabProxyName,
            displayProxyName: tabProxyName,
        };
    }

    function notifyProxyStatus() {
        const base = _buildBaseProxyStatus();
        const tabManager = typeof getTabManager === 'function' ? getTabManager() : null;
        const activeTab = tabManager?.getActiveTab?.() || null;
        const tabList = tabManager?.getAllTabs?.();
        const tabsArr = Array.isArray(tabList) ? tabList : Array.from(tabList || []);
        const sig = JSON.stringify({
            ...base,
            tabs: tabsArr.map((t) => `${t.id}:${t.proxyProfileId ?? ''}:${t.cupnetEnabled ? 1 : 0}`).join('|'),
        });
        if (sig === _lastProxyStatusSig) return;
        _lastProxyStatusSig = sig;

        const mainInfo = _augmentProxyStatusForTab(base, activeTab);
        const pmw = typeof getProxyManagerWindow === 'function' ? getProxyManagerWindow() : null;
        const managerInfo = {
            ...base,
            tabProxyProfileId: null,
            tabProxyName: '',
            displayProxyName: base.proxyName,
        };

        for (const win of BrowserWindow.getAllWindows()) {
            try {
                if (!win.isDestroyed()) {
                    const useManagerPayload = pmw && !pmw.isDestroyed() && win.id === pmw.id;
                    win.webContents.send('proxy-status-changed', useManagerPayload ? managerInfo : mainInfo);
                }
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'proxy-status-changed.window' } }, err, 'info');
            }
        }
        if (tabManager) {
            const tabsForSend = Array.isArray(tabList) ? tabList : Array.from(tabList || []);
            for (const tab of tabsForSend) {
                try {
                    if (tab.view && !tab.view.webContents.isDestroyed()) {
                        const info = _augmentProxyStatusForTab(base, tab);
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
