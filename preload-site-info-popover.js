'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siteInfoPopoverAPI', {
    onSiteInfoInit(cb) {
        ipcRenderer.on('site-info-init', (_, data) => { try { cb(data); } catch (_) { /* ignore */ } });
    },
    copyUrl(url) {
        return ipcRenderer.invoke('site-info-popover-copy-url', url);
    },
    clearCookies(tabId, domain) {
        return ipcRenderer.invoke('site-info-popover-clear-cookies', tabId, domain);
    },
    openNetworkLog(filter) {
        return ipcRenderer.invoke('site-info-popover-open-log', filter);
    },
    closeWindow() {
        ipcRenderer.send('site-info-popover-close');
    },
});
