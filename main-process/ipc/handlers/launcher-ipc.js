'use strict';

const { getDebugMitmLevel, setDebugMitmLevel } = require('../../../mitm-proxy.js');

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
    ctx.ipcMain.handle('get-debug-mitm-level', () => getDebugMitmLevel());
    ctx.ipcMain.handle('set-debug-mitm-level', (_, lvl) => {
        const n = setDebugMitmLevel(lvl);
        try {
            process.stdout.write(`[mitm] CUPNET_DEBUG_MITM=${n} (from console UI)\n`);
        } catch { /* ignore */ }
        return n;
    });
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
    ctx.ipcMain.handle('save-console-log-json', async (_, content) => {
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(ctx.consoleViewerWindow || ctx.mainWindow, {
            title: 'Save Console Log (JSON)',
            defaultPath: ctx.path.join(ctx.app.getPath('downloads'), `cupnet-console-${Date.now()}.json`),
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (canceled || !filePath) return false;
        ctx.fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf-8');
        return true;
    });
    ctx.ipcMain.handle('save-console-log-csv', async (_, content) => {
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(ctx.consoleViewerWindow || ctx.mainWindow, {
            title: 'Save Console Log (CSV)',
            defaultPath: ctx.path.join(ctx.app.getPath('downloads'), `cupnet-console-${Date.now()}.csv`),
            filters: [{ name: 'CSV', extensions: ['csv'] }]
        });
        if (canceled || !filePath) return false;
        ctx.fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    });
    ctx.ipcMain.handle('get-console-logs-db', async (_, opts) => {
        if (!ctx.db || typeof ctx.db.queryConsoleLogs !== 'function') return [];
        return ctx.db.queryConsoleLogs(opts || {});
    });
    ctx.ipcMain.handle('get-console-log-sessions', async () => {
        if (!ctx.db || typeof ctx.db.getConsoleLogSessionsSummary !== 'function') return [];
        return ctx.db.getConsoleLogSessionsSummary(80);
    });
    ctx.ipcMain.handle('find-requests-near-ts', async (_, payload) => {
        if (!ctx.db || typeof ctx.db.findRequestsNearTimestamp !== 'function') return [];
        const sessionId = payload?.sessionId ?? ctx.currentSessionId;
        const tsMs = payload?.tsMs;
        const windowMs = payload?.windowMs;
        return ctx.db.findRequestsNearTimestamp(sessionId, tsMs, windowMs);
    });
    ctx.ipcMain.handle('cupnet-log', async (_, payload) => {
        const { level, module: mod, message, meta } = payload || {};
        if (ctx.consoleCaptureApi?.cupnetLog) {
            ctx.consoleCaptureApi.cupnetLog(level || 'info', mod, message ?? '', meta);
        }
        return true;
    });

    // ── Page Analyzer ────────────────────────────────────────────────────────
    ctx.ipcMain.handle('open-page-analyzer', async () => { ctx.createPageAnalyzerWindow(); return true; });
    ctx.ipcMain.handle('open-notes-window', async () => { ctx.createNotesWindow(); return true; });
    ctx.ipcMain.handle('open-credentials-window', async () => { ctx.createCredentialsWindow(); return true; });

    ctx.ipcMain.handle('notes-embed-request', async (_, blockData) => {
        ctx.createNotesWindow();
        const win = ctx.notesWindow;
        if (!win || win.isDestroyed()) return false;
        const send = () => {
            if (win.isDestroyed()) return;
            win.webContents.send('notes-embed-block', blockData);
        };
        if (win.webContents.isLoading()) {
            win.webContents.once('did-finish-load', () => setTimeout(send, 120));
        } else {
            send();
        }
        return true;
    });
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
