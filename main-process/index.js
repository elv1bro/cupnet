'use strict';

/**
 * Electron main entry (Phase 0): single-instance lock, global error hooks, then full bootstrap.
 * @see cupnet-runtime.js — MITM, IPC, windows, proxy/traffic.
 */
const { sysLog } = require('../sys-log');
const { app, BrowserWindow } = require('electron');

// ─── Single instance lock (one CupNet per host/user session) ─────────────────
// E2E: Playwright может поднять новый процесс до полного завершения предыдущего —
// без lock каждый запуск использует свой --user-data-dir (см. tests/e2e/helpers.js).
const cupnetE2E = process.env.CUPNET_E2E === '1';
if (!cupnetE2E) {
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
    process.exit(0);
    }
}

if (!cupnetE2E) {
app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
});
}

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    sysLog('error', 'process', 'unhandledRejection: ' + msg);
});

process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    sysLog('critical', 'process', 'uncaughtException: ' + msg);
});

const { attachMainProcess } = require('./cupnet-runtime');
attachMainProcess();
