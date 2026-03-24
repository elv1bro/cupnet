'use strict';

const { networkPolicy } = require('./network-policy');

const TRAFFIC_MODE_MITM = 'mitm';
const TRAFFIC_MODE_BROWSER_PROXY = 'browser_proxy';

function normalizeTrafficMode(mode) {
    return mode === TRAFFIC_MODE_MITM ? TRAFFIC_MODE_MITM : TRAFFIC_MODE_BROWSER_PROXY;
}

function toProxyRules(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        const u = new URL(proxyUrl);
        if (u.protocol === 'socks5:' || u.protocol === 'socks4:' || u.protocol === 'socks:') {
            return `socks5://${u.hostname}:${u.port || '1080'}`;
        }
        return `${u.hostname}:${u.port}`;
    } catch {
        return null;
    }
}

function resolveSessionProxyConfig({ mode, upstreamProxyUrl, bypassRules }) {
    const normalized = normalizeTrafficMode(mode);
    if (normalized === TRAFFIC_MODE_MITM) {
        const p = networkPolicy.mitmPort;
        const hp = `127.0.0.1:${p}`;
        return {
            proxyRules: `http=${hp};https=${hp}`,
            proxyBypassRules: bypassRules || '',
        };
    }
    const proxyRules = toProxyRules(upstreamProxyUrl);
    if (!proxyRules) return { mode: 'direct' };
    return {
        proxyRules,
        proxyBypassRules: bypassRules || '',
    };
}

module.exports = {
    TRAFFIC_MODE_MITM,
    TRAFFIC_MODE_BROWSER_PROXY,
    normalizeTrafficMode,
    toProxyRules,
    resolveSessionProxyConfig,
};
