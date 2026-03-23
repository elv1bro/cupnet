'use strict';

/**
 * Скриншоты.
 * @param {object} ctx
 */
function registerScreenshotsIpc(ctx) {
    ctx.ipcMain.handle('take-screenshot', async (_, reason, meta) => {
        const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'click';
        return ctx.requestScreenshot({ reason: normalizedReason, meta });
    });

    // Lazy-load single screenshot image data by DB id (avoids sending all base64 on log-viewer open)
    ctx.ipcMain.handle('get-screenshot-data', (_, id) => ctx.db.getScreenshotData(id) || null);

    ctx.ipcMain.handle('save-screenshot', async (_, imageData, filename) => {
        try {
            const { canceled, filePath } = await ctx.dialog.showSaveDialog({
                title: 'Save Screenshot',
                defaultPath: ctx.path.join(ctx.app.getPath('pictures'), filename.replace(/[^a-zA-Z0-9-_.]/g, '_') + '.png'),
                filters: [{ name: 'PNG Images', extensions: ['png'] }]
            });
            if (canceled) return { success: false };
            ctx.fs.writeFileSync(filePath, Buffer.from(imageData, 'base64'));
            return { success: true, path: filePath };
        } catch (err) { return { success: false, error: err.message }; }
    });

    ctx.ipcMain.handle('copy-screenshot', async (_, imageData) => {
        try {
            ctx.clipboard.writeImage(ctx.nativeImage.createFromBuffer(Buffer.from(imageData, 'base64')));
            return { success: true };
        } catch (err) { return { success: false, error: err.message }; }
    });
}

module.exports = { registerScreenshotsIpc };
