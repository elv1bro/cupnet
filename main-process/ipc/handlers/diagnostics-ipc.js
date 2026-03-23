'use strict';

/**
 * get-app-metrics.
 * @param {object} ctx
 */
function registerDiagnosticsIpc(ctx) {
    // Performance metrics — all Chrome/Electron processes
    ctx.ipcMain.handle('get-app-metrics', () => {
        try {
            const metrics = ctx.app.getAppMetrics();
            return metrics.map(m => ({
                pid:         m.pid,
                type:        m.type,
                cpuPercent:  m.cpu?.percentCPUUsage ?? 0,
                cpuMs:       m.cpu?.cumulativeCPUUsage ?? 0,
                memWorkingSet: m.memory?.workingSetSize    ?? 0,
                memPrivate:    m.memory?.privateBytes      ?? 0,
                memShared:     m.memory?.sharedBytes       ?? 0,
                sandboxed:   m.sandboxed ?? false,
                name:        m.name || '',
            }));
        } catch { return []; }
    });
}

module.exports = { registerDiagnosticsIpc };
