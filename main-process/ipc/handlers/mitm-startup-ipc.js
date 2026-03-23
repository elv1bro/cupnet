'use strict';

/**
 * MITM ready + startup UI metrics (ранняя регистрация).
 * @param {object} ctx
 */
function registerMitmStartupIpc(ctx) {
    ctx.ipcMain.handle('mitm-ready-state', () => ({ ready: !!ctx.mitmReady, ts: Date.now() }));
    ctx.ipcMain.on('ui-first-paint', () => {
        if (!ctx.startupMetrics.firstPaintTs) {
            ctx.startupMetrics.firstPaintTs = Date.now();
            ctx.maybeLogStartupMetrics();
        }
    });
    ctx.ipcMain.on('ui-long-task-count', (_, count) => {
        ctx.startupMetrics.longTaskCount = Number(count) || 0;
    });
}

module.exports = { registerMitmStartupIpc };
