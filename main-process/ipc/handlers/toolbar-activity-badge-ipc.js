'use strict';

/**
 * Сброс счётчиков Activity на кнопках главного окна (DNS / Rules) при подчистке лога в дочерних окнах.
 */
function registerToolbarActivityBadgeIpc(ctx) {
    ctx.ipcMain.on('reset-toolbar-activity-badge', (_event, tool) => {
        const w = ctx.mainWindow;
        if (!w || w.isDestroyed()) return;
        try {
            w.webContents.send('toolbar-activity-badge-reset', tool);
        } catch (_) { /* ignore */ }
    });
}

module.exports = { registerToolbarActivityBadgeIpc };
