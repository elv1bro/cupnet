'use strict';

const { getPidMetrics } = require('../../services/os-process-metrics.js');

/**
 * Out-of-process helpers spawned by CupNet (not listed in app.getAppMetrics()).
 * @param {object} ctx
 * @returns {object[]}
 */
function collectCupNetChildProcessMetrics(ctx) {
    const rows = [];
    try {
        const mp = ctx.mitmProxy;
        const w = mp && mp.worker;
        const proc = w && w.proc;
        if (proc && proc.pid && !proc.killed) {
            const pid = proc.pid;
            const st = getPidMetrics(pid);
            const kind = w._workerType === 'go' ? 'Go' : 'Node';
            rows.push({
                pid,
                type: 'CupNet',
                name: `AzureTLS upstream (${kind})`,
                cpuPercent: st?.cpuPercent ?? 0,
                cpuMs: 0,
                memWorkingSet: st?.memWorkingSetBytes ?? 0,
                memPrivate: st?.memPrivateBytes ?? 0,
                memShared: 0,
                sandboxed: false,
                cupnet: true,
            });
        }
    } catch { /* ignore */ }
    try {
        const ivp = ctx.ivacScoutProcess;
        if (ivp && ivp.pid && !ivp.killed) {
            const pid = ivp.pid;
            const st = getPidMetrics(pid);
            rows.push({
                pid,
                type: 'CupNet',
                name: 'IVAC Scout helper',
                cpuPercent: st?.cpuPercent ?? 0,
                cpuMs: 0,
                memWorkingSet: st?.memWorkingSetBytes ?? 0,
                memPrivate: st?.memPrivateBytes ?? 0,
                memShared: 0,
                sandboxed: false,
                cupnet: true,
            });
        }
    } catch { /* ignore */ }
    return rows;
}

/**
 * get-app-metrics.
 * @param {object} ctx
 */
function registerDiagnosticsIpc(ctx) {
    ctx.ipcMain.handle('get-app-metrics', () => {
        try {
            const metrics = ctx.app.getAppMetrics();
            const chromium = metrics.map(m => ({
                pid:         m.pid,
                type:        m.type,
                cpuPercent:  m.cpu?.percentCPUUsage ?? 0,
                cpuMs:       m.cpu?.cumulativeCPUUsage ?? 0,
                memWorkingSet: m.memory?.workingSetSize    ?? 0,
                memPrivate:    m.memory?.privateBytes      ?? 0,
                memShared:     m.memory?.sharedBytes       ?? 0,
                sandboxed:   m.sandboxed ?? false,
                name:        m.name || '',
                cupnet:      false,
            }));
            const cupnet = collectCupNetChildProcessMetrics(ctx);
            return chromium.concat(cupnet);
        } catch { return []; }
    });
}

module.exports = { registerDiagnosticsIpc };
