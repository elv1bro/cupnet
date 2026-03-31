'use strict';

const { SETTINGS_DEFAULTS } = require('./settings-store');

function getMaxTabsBeforeWarning(loadSettings) {
    const s = loadSettings();
    const n = Number(s && s.maxTabsBeforeWarning);
    if (Number.isFinite(n) && n >= 1) return Math.min(200, Math.floor(n));
    return SETTINGS_DEFAULTS.maxTabsBeforeWarning;
}

/**
 * @param {{ loadSettings: function, tabManager: object, dialog: object, mainWindow?: import('electron').BrowserWindow | null }} ctx
 * @returns {Promise<boolean>}
 */
async function confirmOpenAnotherTab(ctx) {
    if (process.env.CUPNET_E2E === '1') return true;
    const limit = getMaxTabsBeforeWarning(ctx.loadSettings);
    const n = [...ctx.tabManager.getAllTabs()].length;
    if (n < limit) return true;
    const win = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : undefined;
    const { response } = await ctx.dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Open tab'],
        defaultId: 1,
        cancelId: 0,
        title: 'Many tabs',
        message: `You already have ${n} tabs open. Open another tab?`,
        detail: `A warning appears when you have at least ${limit} tabs (change in Settings → General).`,
        noLink: true,
    });
    return response === 1;
}

module.exports = { confirmOpenAnotherTab, getMaxTabsBeforeWarning };
