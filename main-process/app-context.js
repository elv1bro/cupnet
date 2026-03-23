'use strict';

/**
 * Composition root factory (Phase 0). Частично синхронизируется из cupnet-runtime.js (`whenReady`).
 * Авторитетное состояние по-прежнему в замыканиях runtime + `dSub` / сервисах.
 */
function createAppContext() {
    return {
        modules: {
            db: null,
            tabManager: null,
            harExporter: null,
            rulesEngine: null,
            interceptor: null,
            mitmProxy: null,
        },
        windows: {
            main: null,
            logViewers: [],
            traceViewers: [],
            rules: null,
            proxyManager: null,
            cookieManager: null,
            dnsManager: null,
            compareViewer: null,
            consoleViewer: null,
            pageAnalyzer: null,
            ivacScout: null,
        },
        proxy: {
            actProxy: '',
            anonymizedUrl: null,
            profileId: null,
            profileName: null,
            resolvedVars: {},
            trafficMode: 'browser_proxy',
            resilience: null,
        },
        logging: {
            enabled: false,
            hadBeenStopped: false,
            sessionId: null,
            entryCount: 0,
        },
        fingerprint: { active: null },
        mitm: { ready: false, startPromise: null },
        settings: { cached: null },
        metrics: {
            stability: { counters: {}, gauges: {}, hist: { requestLatencyMs: [] } },
            startupMetrics: {},
        },
        misc: { forceAppQuit: false, isWindowActive: true },
    };
}

module.exports = { createAppContext };
