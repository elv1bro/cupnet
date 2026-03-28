'use strict';

const fs = require('fs');
const path = require('path');

/** Только в главном процессе Electron; azure-tls-worker на обычном Node — без electron (иначе MODULE_NOT_FOUND). */
function _tryRequireElectron() {
    if (!process.versions?.electron) return null;
    try {
        return require('electron');
    } catch {
        return null;
    }
}

const MAX_LOG_ENTRIES = 2000;
const MAX_CRITICAL_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

const _entries = [];
let _logViewerWindows = [];
let _criticalLogPath = null;

function getCriticalLogPath() {
    if (_criticalLogPath) return _criticalLogPath;
    const electron = _tryRequireElectron();
    const app = electron?.app;
    try {
        if (app && typeof app.getPath === 'function') {
            _criticalLogPath = path.join(app.getPath('userData'), 'critical.log');
        } else {
            _criticalLogPath = path.join(process.cwd(), 'critical.log');
        }
    } catch {
        _criticalLogPath = path.join(process.cwd(), 'critical.log');
    }
    return _criticalLogPath;
}

/**
 * @param {'info'|'warn'|'error'|'critical'} level
 * @param {string} module - source module name
 * @param {string} message
 * @param {object} [data] - optional extra data
 */
function sysLog(level, module, message, data) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        module,
        message: String(message),
        data: data || undefined,
    };

    _entries.push(entry);
    if (_entries.length > MAX_LOG_ENTRIES) _entries.splice(0, _entries.length - MAX_LOG_ENTRIES);

    const prefix = `[${entry.ts}] [${level.toUpperCase()}] [${module}]`;

    if (level === 'error' || level === 'critical') {
        process.stderr.write(`${prefix} ${message}\n`);
    }

    if (level === 'critical') {
        writeToCriticalLog(entry);
    }

    for (const w of _logViewerWindows) {
        try {
            if (!w.isDestroyed()) w.webContents.send('sys-log-entry', entry);
        } catch {}
    }
}

function writeToCriticalLog(entry) {
    try {
        const logPath = getCriticalLogPath();
        const line = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.module}] ${entry.message}${entry.data ? ' ' + JSON.stringify(entry.data) : ''}\n`;
        try {
            const stat = fs.statSync(logPath);
            if (stat.size > MAX_CRITICAL_LOG_SIZE) {
                try { fs.renameSync(logPath, logPath + '.1'); } catch { /* ignore */ }
                fs.writeFileSync(logPath, line);
                return;
            }
        } catch {}
        fs.appendFileSync(logPath, line);
    } catch {}
}

function _normalizeError(err) {
    if (!err) return { message: 'Unknown error', code: null, stack: null };
    const message = String(err?.message || err);
    const code = err?.code ? String(err.code) : null;
    const stack = typeof err?.stack === 'string'
        ? err.stack.split('\n').slice(0, 4).join('\n')
        : null;
    return { message, code, stack };
}

/**
 * Structured error capture for previously silent catch blocks.
 * @param {{module: string, eventCode: string, context?: object}} meta
 * @param {unknown} err
 * @param {'info'|'warn'|'error'|'critical'} [level]
 */
function safeCatch(meta, err, level = 'warn') {
    const moduleName = String(meta?.module || 'unknown');
    const eventCode = String(meta?.eventCode || 'unknown.event');
    const context = meta?.context && typeof meta.context === 'object' ? meta.context : {};
    const normalized = _normalizeError(err);
    sysLog(level, moduleName, `${eventCode}: ${normalized.message}`, {
        eventCode,
        context,
        code: normalized.code,
        stack: normalized.stack,
    });
}

function getEntries(level, limit = 500) {
    let result = _entries;
    if (level) result = result.filter(e => e.level === level);
    return result.slice(-limit);
}

function registerSysLogWindow(win) {
    _logViewerWindows.push(win);
    win.on('closed', () => {
        _logViewerWindows = _logViewerWindows.filter(w => w !== win);
    });
}

function flushOnExit() {
    const criticals = _entries.filter(e => e.level === 'critical' || e.level === 'error');
    if (criticals.length === 0) return;
    try {
        const logPath = getCriticalLogPath();
        const lines = criticals.map(e =>
            `[${e.ts}] [${e.level.toUpperCase()}] [${e.module}] ${e.message}${e.data ? ' ' + JSON.stringify(e.data) : ''}`
        ).join('\n') + '\n';
        fs.appendFileSync(logPath, lines);
    } catch {}
}

function initIPC() {
    const electron = _tryRequireElectron();
    const ipcMain = electron?.ipcMain;
    if (!ipcMain?.handle) return;
    ipcMain.handle('get-sys-log', (_, level, limit) => getEntries(level, limit));
}

module.exports = { sysLog, safeCatch, getEntries, registerSysLogWindow, flushOnExit, initIPC };
