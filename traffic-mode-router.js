'use strict';

const { networkPolicy } = require('./network-policy');

const TRAFFIC_MODE_MITM = 'mitm';

/** Всегда MITM — режим browser_proxy удалён. */
function normalizeTrafficMode(_mode) {
    return TRAFFIC_MODE_MITM;
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

function resolveSessionProxyConfig({ bypassRules } = {}) {
    const p = networkPolicy.mitmPort;
    const hp = `127.0.0.1:${p}`;
    return {
        proxyRules: `http=${hp};https=${hp}`,
        proxyBypassRules: bypassRules || '',
    };
}

module.exports = {
    TRAFFIC_MODE_MITM,
    normalizeTrafficMode,
    toProxyRules,
    resolveSessionProxyConfig,
};
