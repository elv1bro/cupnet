import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    normalizeTrafficMode,
    toProxyRules,
    resolveSessionProxyConfig,
    TRAFFIC_MODE_MITM,
} = require('../../traffic-mode-router.js');

describe('traffic-mode-router', () => {
    it('normalizeTrafficMode: always mitm', () => {
        expect(normalizeTrafficMode('mitm')).toBe(TRAFFIC_MODE_MITM);
        expect(normalizeTrafficMode('browser_proxy')).toBe(TRAFFIC_MODE_MITM);
        expect(normalizeTrafficMode('unknown')).toBe(TRAFFIC_MODE_MITM);
        expect(normalizeTrafficMode(null)).toBe(TRAFFIC_MODE_MITM);
    });

    it('toProxyRules: converts URL to host:port', () => {
        expect(toProxyRules('http://127.0.0.1:8899')).toBe('127.0.0.1:8899');
        expect(toProxyRules('invalid-url')).toBe(null);
        expect(toProxyRules('')).toBe(null);
    });

    it('toProxyRules: preserves SOCKS scheme for Chromium proxyRules', () => {
        expect(toProxyRules('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
        expect(toProxyRules('socks4://10.0.0.1')).toBe('socks5://10.0.0.1:1080');
    });

    it('resolveSessionProxyConfig: mitm rules to local proxy', () => {
        const cfg = resolveSessionProxyConfig({ bypassRules: 'a,b' });
        expect(cfg.proxyRules).toContain('127.0.0.1');
        expect(cfg.proxyBypassRules).toBe('a,b');
    });
});
