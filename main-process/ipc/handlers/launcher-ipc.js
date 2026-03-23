'use strict';

/**
 * Открытие вспомогательных окон (proxy manager, console, analyzer, IVAC).
 * @param {object} ctx
 */
function registerLauncherIpc(ctx) {
    // ── Proxy Manager ────────────────────────────────────────────────────────
    ctx.ipcMain.handle('open-proxy-manager', async () => { ctx.createProxyManagerWindow(); return true; });

    // ── Console Viewer ───────────────────────────────────────────────────────
    ctx.ipcMain.handle('open-console-viewer', async () => { ctx.createConsoleViewerWindow(); return true; });
    ctx.ipcMain.handle('get-console-history', () => ctx.consoleCaptureApi.getConsoleBufferSnapshot());
    ctx.ipcMain.handle('save-console-log', async (_, content) => {
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(ctx.consoleViewerWindow || ctx.mainWindow, {
            title: 'Save Console Log',
            defaultPath: ctx.path.join(ctx.app.getPath('downloads'), `cupnet-console-${Date.now()}.log`),
            filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }]
        });
        if (canceled || !filePath) return false;
        ctx.fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    });

    // ── Page Analyzer ────────────────────────────────────────────────────────
    ctx.ipcMain.handle('open-page-analyzer', async () => { ctx.createPageAnalyzerWindow(); return true; });
    ctx.ipcMain.handle('open-ivac-scout', async () => { ctx.createIvacScoutWindow(); return true; });
    ctx.ipcMain.handle('get-ivac-scout-context', async () => ctx.getIvacScoutContext());
    ctx.ipcMain.handle('run-ivac-scout', async (_, opts) => ctx.runIvacScoutProcess(opts || {}));
    ctx.ipcMain.handle('stop-ivac-scout', async () => ({ stopped: ctx.stopIvacScoutProcess() }));
    ctx.ipcMain.handle('open-ivac-dump-folder', async () => {
        const dumpDir = ctx.path.join(ctx._cupnetRoot, '_debug');
        ctx.fs.mkdirSync(dumpDir, { recursive: true });
        await ctx.shell.openPath(dumpDir);
        return true;
    });
}

module.exports = { registerLauncherIpc };
