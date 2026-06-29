'use strict';

const { injectPageHttpLab, handleHttpLabUiState } = require('../../services/page-http-lab');

/**
 * In-page HTTP Lab (Web Request Tools).
 * @param {object} ctx
 */
function registerPageHttpLabIpc(ctx) {
    ctx.ipcMain.handle('inject-page-http-lab', async (_, tabId, options = {}) => {
        const id = tabId ?? ctx.tabManager.getActiveTabId();
        const tab = ctx.tabManager.getTab(id);
        const wc = tab?.view?.webContents;
        return injectPageHttpLab(wc, options, id);
    });

    ctx.ipcMain.handle('inject-active-page-http-lab', async (_, options = {}) => {
        const id = ctx.tabManager.getActiveTabId();
        const tab = ctx.tabManager.getTab(id);
        const wc = tab?.view?.webContents;
        return injectPageHttpLab(wc, options, id);
    });

    ctx.ipcMain.on('http-lab-ui-state', (event, state = {}) => {
        const tabId = ctx.tabManager.getTabIdByWebContentsId?.(event.sender.id);
        if (tabId == null) return;
        handleHttpLabUiState(tabId, state);
    });
}

module.exports = { registerPageHttpLabIpc };
