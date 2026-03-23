'use strict';

/**
 * MITM stats, TLS profile, stability, connect-direct.
 * @param {object} ctx
 */
function registerMitmTlsResilienceIpc(ctx) {
    // ── MITM IPC handlers — registered immediately so they work even before proxy starts ──
    const EMPTY_STATS = { requests:0, errors:0, pending:0, avgMs:0, minMs:0, maxMs:0, reqPerSec:0, workerReady:false, browser:'chrome' };
    ctx.ipcMain.handle('mitm-get-stats',    ()         => ctx.mitmProxy ? ctx.mitmProxy.getStats() : EMPTY_STATS);
    ctx.ipcMain.handle('stability-metrics-snapshot', () => ({
        counters: { ...ctx.stabilityMetrics.counters },
        gauges: { ...ctx.stabilityMetrics.gauges },
        p95LatencyMs: ctx.stabilityMetrics.gauges.p95LatencyMs || 0,
        proxyResilience: ctx.proxyResilience.snapshot(),
        policy: ctx.networkPolicy,
        ts: Date.now(),
    }));
    ctx.ipcMain.handle('stability-slo-status', () => ({
        enabled: !!ctx.networkPolicy.slo.enabled,
        thresholds: { ...ctx.networkPolicy.slo },
        current: {
            p95LatencyMs: ctx.stabilityMetrics.gauges.p95LatencyMs || 0,
            queueDepth: ctx.stabilityMetrics.gauges.queueDepth || 0,
            workerRestarts: ctx.stabilityMetrics.gauges.workerRestarts || 0,
            dbWriteQueueHighDepth: ctx.stabilityMetrics.gauges.dbWriteQueueHighDepth || 0,
            dbWriteQueueLowDepth: ctx.stabilityMetrics.gauges.dbWriteQueueLowDepth || 0,
            dbWriteQueueDroppedLow: ctx.stabilityMetrics.gauges.dbWriteQueueDroppedLow || 0,
            dbWriteQueueDroppedHigh: ctx.stabilityMetrics.gauges.dbWriteQueueDroppedHigh || 0,
        },
    }));
    ctx.ipcMain.handle('proxy-resilience-state', () => ctx.proxyResilience.snapshot());
    ctx.ipcMain.handle('mitm-get-ca-cert',  ()         => ctx.mitmProxy?.getCACert() || '');
    ctx.ipcMain.handle('mitm-set-browser',  (_, prof)  => { ctx.mitmProxy?.setBrowser(prof); return { success: true }; });
    ctx.ipcMain.handle('mitm-set-upstream', (_, url)   => { ctx.mitmProxy?.setUpstream(url);  return { success: true }; });

    ctx.ipcMain.handle('get-tls-profile', () => ctx.loadSettings().tlsProfile || 'chrome');
    ctx.ipcMain.handle('set-tls-profile', (_, profile) => {
        const valid = ['chrome','firefox','safari','ios','edge','opera'];
        const p = valid.includes(profile) ? profile : 'chrome';
        const s = ctx.loadSettings();
        s.tlsProfile = p;
        ctx.saveSettings(s);
        ctx.mitmProxy?.setBrowser(p);
        ctx.broadcastTlsProfileChanged(p);
        return { success: true, profile: p };
    });

    ctx.ipcMain.handle('connect-direct', async (_, tlsProfile) => {
        try {
            if (ctx.persistentAnonymizedProxyUrl) {
                await ctx.withTimeout(
                    ctx.ProxyChain.closeAnonymizedProxy(ctx.persistentAnonymizedProxyUrl, true),
                    ctx.networkPolicy.timeouts.proxyOperationMs,
                    'Proxy close timeout'
                ).catch(e => ctx.sysLog('warn', 'proxy', 'closeAnonymizedProxy on connect-direct failed: ' + (e?.message || e)));
                ctx.persistentAnonymizedProxyUrl = null;
            }
            ctx.actProxy = '';
            ctx.connectedProfileId = null;
            ctx.connectedProfileName = null;
            ctx.connectedResolvedVars = {};
            if (ctx.mitmProxy) {
                ctx.mitmProxy.setUpstream(null);
                ctx.mitmProxy._activeJa3 = null;
            }

            const p = ['chrome','firefox','safari','ios','edge','opera'].includes(tlsProfile) ? tlsProfile : 'chrome';
            ctx.mitmProxy?.setBrowser(p);
            const settings = ctx.loadSettings();
            settings.tlsProfile = p;
            ctx.saveSettings(settings);

            await ctx.applyEffectiveTrafficMode('mitm', null, {
                source: 'connect-direct',
                force: true,
            });

            ctx.buildMenu();
            ctx.notifyProxyStatus();
            ctx.broadcastTlsProfileChanged(p);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerMitmTlsResilienceIpc };
