'use strict';

/**
 * Fail-closed egress across proxy-profile failures and MITM restarts.
 *  - A-037: a failed profile switch must clear the MITM upstream (not keep the old proxy) and block.
 *  - A-027: per-tab upstreams and the egress block must survive a MITM restart.
 * Uses the real MitmProxy setters (no worker is spawned: methods are called on plain objects).
 */
import { describe, it, expect } from 'vitest';
import net from 'net';
import { Buffer } from 'buffer';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { MitmProxy, ExternalProxyPort } = require(path.join(root, 'mitm-proxy.js'));
const { createTrafficModeService } = require(path.join(root, 'main-process/services/traffic-mode-service.js'));
const { connectGlobalProxyProfile } = require(path.join(root, 'main-process/services/global-proxy-connect.js'));
const { snapshotMitmRuntimeState, restoreMitmRuntimeState } = require(path.join(root, 'main-process/services/mitm-runtime-state.js'));
const { normalizeTrafficMode } = require(path.join(root, 'traffic-mode-router.js'));

/** A plain object driven by the real MitmProxy setters/resolvers. */
function fakeMitm(upstream = null) {
    const m = { upstream, _egressBlocked: false, _egressBlockReason: '', _tabProxyMap: new Map(),
        browser: 'chrome', _activeJa3: null, forceHttp1: false, _identity: null };
    for (const fn of ['setUpstream', 'setEgressBlocked', 'setTabUpstream', 'removeTabUpstream', '_resolveUpstreamForTab']) {
        m[fn] = MitmProxy.prototype[fn].bind(m);
    }
    return m;
}

describe('A-037: failed profile switch clears the MITM upstream and blocks egress', () => {
    it('credential-less profile A connected, profile B fails → no upstream, blocked', async () => {
        const mitm = fakeMitm('http://1.2.3.4:3128'); // A used raw as upstream (no anonymized URL)
        let mode = 'mitm';
        const ctx = {
            persistentAnonymizedProxyUrl: null,
            actProxy: 'http://1.2.3.4:3128',
            mitmProxy: mitm,
            db: { getProxyProfileEncrypted: () => ({ id: 2, name: 'B', url_display: 'http://bad-host:{PORT}', traffic_mode: 'mitm' }) },
            parseProxyTemplate: (t) => String(t).replace('{PORT}', '1'),
            normalizeTrafficMode,
            parseFallbackProxyList: () => [],
            connectProxyWithFailover: async () => { throw new Error('anonymizeProxy failed'); },
            sysLog: () => {},
            buildMenu: () => {},
            notifyProxyStatus: () => {},
        };
        const svc = createTrafficModeService({
            getCurrentTrafficModeRaw: () => mode,
            setCurrentTrafficModeRaw: (v) => { mode = v; },
            getPersistentAnonymizedProxyUrl: () => ctx.persistentAnonymizedProxyUrl,
            getMitmProxy: () => mitm,
            getTabManager: () => null,
            getInterceptor: () => null,
            session: { defaultSession: { setProxy: async () => {} } },
            loadSettings: () => ({}),
            saveSettings: () => {},
            sysLog: () => {},
            notifyProxyStatus: () => {},
        });
        ctx.applyEffectiveTrafficMode = svc.applyEffectiveTrafficMode;

        const res = await connectGlobalProxyProfile(ctx, 2);
        expect(res.success).toBe(false);
        expect(res.fallback).toBe('blocked');
        expect(mitm.upstream).toBeNull();          // no longer routed through profile A
        expect(mitm._egressBlocked).toBe(true);    // and nothing goes out directly
    });
});

describe('A-027: MITM restart keeps per-tab upstreams and the egress block', () => {
    it('restores tab proxies and the block onto the new instance', () => {
        const oldMitm = fakeMitm(null);
        oldMitm.setTabUpstream('tab_7', { upstream: 'http://127.0.0.1:6001', browser: 'chrome', forceHttp1: true });
        oldMitm.setEgressBlocked(true, 'profile X failed');

        const next = fakeMitm(null);
        restoreMitmRuntimeState(next, snapshotMitmRuntimeState(oldMitm));

        expect(next._resolveUpstreamForTab('tab_7').proxy).toBe('http://127.0.0.1:6001');
        expect(next._resolveUpstreamForTab('tab_7').forceHttp1).toBe(true);
        expect(next._egressBlocked).toBe(true);
        expect(next._egressBlockReason).toBe('profile X failed');

        // Re-wiring a working global upstream afterwards lifts the block (as before a restart).
        next.setUpstream('http://127.0.0.1:7000');
        expect(next._egressBlocked).toBe(false);
    });

    it('no snapshot (first start) is a no-op', () => {
        const next = fakeMitm(null);
        restoreMitmRuntimeState(next, snapshotMitmRuntimeState(null));
        expect(next._tabProxyMap.size).toBe(0);
        expect(next._egressBlocked).toBe(false);
    });
});

describe('A-106: External Proxy without a running MITM', () => {
    it('answers 503 instead of throwing', async () => {
        const ext = new ExternalProxyPort(null, { port: 0, login: 'u', password: 'p' });
        await ext.start();
        try {
            const port = ext._server.address().port;
            const status = await new Promise((resolve, reject) => {
                const s = net.connect(port, '127.0.0.1');
                const auth = Buffer.from('u:p').toString('base64');
                s.once('connect', () => s.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`));
                let buf = '';
                s.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n')) { resolve(parseInt(buf.split(' ')[1], 10)); s.destroy(); } });
                s.on('error', reject);
                setTimeout(() => reject(new Error('timeout')), 5000);
            });
            expect(status).toBe(503);
        } finally {
            ext.stop();
        }
    });
});

describe('External Proxy loopback auth', () => {
    it('loopback skips the password; any other address still needs it', () => {
        const ext = new ExternalProxyPort(null, { port: 0, login: 'u', password: 'p' });
        expect(ext._checkAuth({}, '127.0.0.1')).toBe(true);
        expect(ext._checkAuth({}, '::1')).toBe(true);
        expect(ext._checkAuth({}, '::ffff:127.0.0.1')).toBe(true);
        expect(ext._checkAuth({}, '10.0.0.8')).toBe(false);
        const ok = 'Basic ' + Buffer.from('u:p').toString('base64');
        const bad = 'Basic ' + Buffer.from('u:no').toString('base64');
        expect(ext._checkAuth({ 'proxy-authorization': ok }, '10.0.0.8')).toBe(true);
        expect(ext._checkAuth({ 'proxy-authorization': bad }, '10.0.0.8')).toBe(false);
    });
});
