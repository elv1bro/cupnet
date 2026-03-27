'use strict';

const { normalizeTrafficMode, resolveSessionProxyConfig } = require('../../traffic-mode-router');

const HARDCODED_BYPASS = ['<local>', '*.youtube.com', '*.googlevideo.com'];

/**
 * @param {object} d
 * @param {import('../services/settings-store')} d.settingsStore
 * @param {() => object} d.loadSettings
 * @param {(s: object) => void} d.saveSettings
 * @param {typeof import('../../sys-log').sysLog} d.sysLog
 * @param {typeof import('../../sys-log').safeCatch} d.safeCatch
 * @param {import('electron').session} d.session
 * @param {() => void} d.notifyProxyStatus
 * @param {() => unknown} d.getMitmProxy
 * @param {() => unknown} d.getTabManager
 * @param {() => string|null|undefined} d.getPersistentAnonymizedProxyUrl
 * @param {() => string} d.getCurrentTrafficModeRaw
 * @param {(v: string) => void} d.setCurrentTrafficModeRaw
 */
function createTrafficModeService(d) {
    function buildBypassList(userDomains) {
        const all = [...HARDCODED_BYPASS, ...(userDomains || [])];
        return [...new Set(all)].join(',');
    }

    function getCurrentTrafficMode() {
        return normalizeTrafficMode(d.getCurrentTrafficModeRaw());
    }

    function getMitmProxyOpts() {
        return resolveSessionProxyConfig({
            bypassRules: buildBypassList((d.settingsStore.getCached() || d.loadSettings()).bypassDomains),
        });
    }

    async function applyEffectiveTrafficMode(mode, upstreamProxyUrl, context = {}) {
        const nextMode = normalizeTrafficMode(mode);
        const prevMode = getCurrentTrafficMode();
        const sameProxy = String(upstreamProxyUrl || '') === String(d.getPersistentAnonymizedProxyUrl() || '');
        const sameMode = prevMode === nextMode;
        if (sameMode && sameProxy && !context.force) return;
        if (!sameMode) {
            d.sysLog('info', 'traffic.mode.changed', `mode ${prevMode} -> ${nextMode}`);
        }

        const defaultSessionOpts = getMitmProxyOpts();

        d.setCurrentTrafficModeRaw(nextMode);
        const interceptor = d.getInterceptor?.();
        if (interceptor?.setTrafficMode) interceptor.setTrafficMode(nextMode);
        const mitm = d.getMitmProxy();
        mitm?.setUpstream?.(upstreamProxyUrl || null);

        const tabManager = d.getTabManager();
        if (tabManager?.setProxyAll) {
            await tabManager.setProxyAll(upstreamProxyUrl || null);
        }
        if (tabManager?.reapplyMitmTrustToSharedSession) {
            tabManager.reapplyMitmTrustToSharedSession();
        }
        await d.session.defaultSession.setProxy(defaultSessionOpts);

        const s = d.loadSettings();
        s.currentProxy = upstreamProxyUrl || '';
        s.effectiveTrafficMode = nextMode;
        d.saveSettings(s);

        d.sysLog('info', 'traffic.mode.applied', `mode=${nextMode} source=${context.source || 'unknown'}`);
        d.notifyProxyStatus();
    }

    function applyBypassDomains(userDomains) {
        const tabManager = d.getTabManager();
        if (!tabManager) return;
        const bypassStr = buildBypassList(userDomains);
        tabManager.setBypassRules(bypassStr);
        applyEffectiveTrafficMode(getCurrentTrafficMode(), d.getPersistentAnonymizedProxyUrl(), {
            source: 'bypass-domains',
            force: true,
        }).catch((err) => {
            d.safeCatch({ module: 'main', eventCode: 'traffic.mode.apply.failed', context: { source: 'bypass-domains' } }, err);
        });
        console.log('[main] bypass domains updated:', bypassStr);
    }

    function applyTrafficFilters(trafficOpts) {
        const tabManager = d.getTabManager();
        if (!tabManager) return;
        const opts = trafficOpts || {};
        tabManager.setTrafficOpts(opts);
        const mitm = d.getMitmProxy();
        if (mitm?.setTlsPassthroughDomains) {
            mitm.setTlsPassthroughDomains(opts.tlsPassthroughDomains || ['challenges.cloudflare.com']);
        }
        console.log('[main] traffic filters updated:', JSON.stringify(opts));
    }

    return {
        buildBypassList,
        getCurrentTrafficMode,
        getMitmProxyOpts,
        applyEffectiveTrafficMode,
        applyBypassDomains,
        applyTrafficFilters,
    };
}

module.exports = { createTrafficModeService, HARDCODED_BYPASS };
