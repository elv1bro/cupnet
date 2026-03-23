'use strict';

/**
 * Trace mode + homepage.
 * @param {object} ctx
 */
function registerTraceViewerIpc(ctx) {
    ctx.ipcMain.handle('get-trace-mode', async () => (ctx.settingsStore.getCached() || ctx.loadSettings()).traceMode === true);
    ctx.ipcMain.handle('set-trace-mode', async (_, enabled) => {
        const s = ctx.loadSettings();
        s.traceMode = !!enabled;
        ctx.saveSettings(s);
        return true;
    });
    ctx.ipcMain.handle('get-trace-path', async () => ctx.path.join(ctx.app.getPath('userData'), 'cupnet-trace.jsonl'));
    ctx.ipcMain.handle('open-trace-file', async () => {
        const p = ctx.path.join(ctx.app.getPath('userData'), 'cupnet-trace.jsonl');
        if (ctx.fs.existsSync(p)) ctx.shell.openPath(p);
        else ctx.shell.showItemInFolder(ctx.app.getPath('userData'));
        return true;
    });
    ctx.ipcMain.handle('has-trace-data', async () => {
        const s = ctx.settingsStore.getCached() || ctx.loadSettings();
        if (s.traceMode) return true;
        return ctx.db && ctx.db.countTraceEntries() > 0;
    });
    ctx.ipcMain.handle('open-trace-viewer', () => {
        const live = ctx.traceWindows.find(w => !w.isDestroyed());
        if (live) { if (live.isMinimized()) live.restore(); live.focus(); return; }
        const s = ctx.settingsStore.getCached() || ctx.loadSettings();
        if (!s.traceMode && (!ctx.db || ctx.db.countTraceEntries() === 0)) return;
        ctx.createTraceViewerWindow();
    });
    ctx.ipcMain.handle('get-trace-entries', async (_, limit, offset) => {
        return ctx.db ? ctx.db.queryTraceEntries(limit ?? 300, offset ?? 0) : [];
    });
    ctx.ipcMain.handle('get-trace-entry', async (_, id) => {
        return ctx.db ? ctx.db.getTraceEntry(id) : null;
    });
    ctx.ipcMain.handle('count-trace-entries', async () => {
        return ctx.db ? ctx.db.countTraceEntries() : 0;
    });
    ctx.ipcMain.handle('clear-trace-entries', async () => {
        if (ctx.db) ctx.db.clearTraceEntries();
        return true;
    });

    // ── Homepage ─────────────────────────────────────────────────────────────
    ctx.ipcMain.handle('get-homepage', async () => ctx.settingsStore.getCached()?.homepage || '');

    ctx.ipcMain.handle('set-homepage', async (_, url) => {
        const settings = ctx.loadSettings();
        settings.homepage = (url || '').trim();
        ctx.saveSettings(settings);
        return true;
    });
}

module.exports = { registerTraceViewerIpc };
