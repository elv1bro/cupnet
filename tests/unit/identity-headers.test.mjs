'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { applyIdentityToOutboundHeaders, previewIdentityHeaders } = require('../../identity-headers.js');
const catalog = require('../../browser-identity-catalog.js');

const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CupNet/2.0 Chrome/132.0.6834.210 Electron/34.5.8 Safari/537.36';

/** A request the way Chromium 132 sends it (order matters). */
function chromiumRequest() {
    const ordered = [
        ['Host', 'example.com'],
        ['Connection', 'keep-alive'],
        ['sec-ch-ua', '"Chromium";v="132", "Not A(Brand";v="8"'],
        ['sec-ch-ua-mobile', '?0'],
        ['sec-ch-ua-platform', '"macOS"'],
        ['Upgrade-Insecure-Requests', '1'],
        ['User-Agent', ELECTRON_UA],
        ['Accept', 'text/html'],
        ['Accept-Language', 'en-US,en;q=0.9'],
    ];
    const headers = {};
    for (const [k, v] of ordered) headers[k.toLowerCase()] = v;
    return { headers, ordered };
}

describe('applyIdentityToOutboundHeaders — engine mode (legacy sanitize)', () => {
    it('null identity only sanitizes the UA and leaves hints alone', () => {
        const { headers, ordered } = chromiumRequest();
        const r = applyIdentityToOutboundHeaders(headers, ordered, null);
        expect(r.applied).toBe(false);
        expect(headers['user-agent']).not.toMatch(/CupNet|Electron/);
        expect(headers['user-agent']).toMatch(/Chrome\/132\.0\.0\.0/);
        expect(headers['sec-ch-ua']).toBe('"Chromium";v="132", "Not A(Brand";v="8"');
        expect(ordered.find(([k]) => k === 'User-Agent')[1]).toMatch(/Chrome\/132\.0\.0\.0/);
    });
    it('engine-mode identity behaves the same', () => {
        const { headers, ordered } = chromiumRequest();
        const r = applyIdentityToOutboundHeaders(headers, ordered, catalog.resolveIdentity({ mode: 'engine', language: 'de' }));
        expect(r.applied).toBe(false);
        expect(headers['accept-language']).toBe('en-US,en;q=0.9');
    });
});

describe('applyIdentityToOutboundHeaders — Chromium identity', () => {
    it('rewrites UA, low-entropy hints and Accept-Language, preserving order', () => {
        const { headers, ordered } = chromiumRequest();
        const id = catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win', language: 'fr-FR,fr;q=0.9' });
        const r = applyIdentityToOutboundHeaders(headers, ordered, id);
        expect(r.applied).toBe(true);
        expect(headers['user-agent']).toBe(catalog.UA.chromeWin);
        expect(headers['sec-ch-ua']).toContain(`"Chromium";v="${catalog.VERSIONS.chrome}"`);
        expect(headers['sec-ch-ua']).toContain('"Google Chrome"');
        expect(headers['sec-ch-ua-platform']).toBe('"Windows"');
        expect(headers['sec-ch-ua-mobile']).toBe('?0');
        expect(headers['accept-language']).toBe('fr-FR,fr;q=0.9');
        // order unchanged, keys keep their casing
        expect(ordered.map(([k]) => k)).toEqual([
            'Host', 'Connection', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
            'Upgrade-Insecure-Requests', 'User-Agent', 'Accept', 'Accept-Language',
        ]);
        expect(ordered[6][1]).toBe(catalog.UA.chromeWin);
        expect(ordered[4][1]).toBe('"Windows"');
        expect(ordered[8][1]).toBe('fr-FR,fr;q=0.9');
    });

    it('adds the three low-entropy hints when Chromium sent none (secure URL), in Chrome order', () => {
        const headers = { host: 'x.test', connection: 'keep-alive', 'upgrade-insecure-requests': '1', 'user-agent': ELECTRON_UA, accept: 'text/html' };
        const ordered = [['Host', 'x.test'], ['Connection', 'keep-alive'], ['Upgrade-Insecure-Requests', '1'], ['User-Agent', ELECTRON_UA], ['Accept', 'text/html']];
        applyIdentityToOutboundHeaders(headers, ordered, catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }), { url: 'https://x.test/' });
        expect(headers['sec-ch-ua']).toContain('"Google Chrome"');
        expect(headers['sec-ch-ua-mobile']).toBe('?0');
        expect(headers['sec-ch-ua-platform']).toBe('"Windows"');
        expect(headers['sec-ch-ua-arch']).toBeUndefined();
        expect(ordered.map(([k]) => k)).toEqual(['Host', 'Connection', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'Upgrade-Insecure-Requests', 'User-Agent', 'Accept']);
    });

    it('does not add hints on plain http URLs or for non-Chromium identities', () => {
        const headers = { host: 'x.test', 'user-agent': ELECTRON_UA };
        applyIdentityToOutboundHeaders(headers, null, catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }), { url: 'http://x.test/' });
        expect(headers['sec-ch-ua']).toBeUndefined();
        const h2 = { host: 'x.test', 'user-agent': ELECTRON_UA };
        applyIdentityToOutboundHeaders(h2, null, catalog.resolveIdentity({ mode: 'template', templateId: 'firefox-win' }), { url: 'https://x.test/' });
        expect(h2['sec-ch-ua']).toBeUndefined();
    });

    it('rewrites high-entropy hints only when present and never adds missing ones', () => {
        const { headers, ordered } = chromiumRequest();
        headers['sec-ch-ua-platform-version'] = '"14.6.1"';
        headers['sec-ch-ua-arch'] = '"arm"';
        ordered.push(['sec-ch-ua-platform-version', '"14.6.1"'], ['sec-ch-ua-arch', '"arm"']);
        const id = catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' });
        applyIdentityToOutboundHeaders(headers, ordered, id);
        expect(headers['sec-ch-ua-platform-version']).toBe('"15.0.0"');
        expect(headers['sec-ch-ua-arch']).toBe('"x86"');
        expect(headers['sec-ch-ua-bitness']).toBeUndefined();
        expect(headers['sec-ch-ua-full-version-list']).toBeUndefined();
        expect(ordered.filter(([k]) => k.startsWith('sec-ch-ua')).length).toBe(5);
    });

    it('mobile template sets ?1 and Android platform', () => {
        const { headers, ordered } = chromiumRequest();
        applyIdentityToOutboundHeaders(headers, ordered, catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-android' }));
        expect(headers['sec-ch-ua-mobile']).toBe('?1');
        expect(headers['sec-ch-ua-platform']).toBe('"Android"');
        expect(headers['user-agent']).toMatch(/Mobile Safari/);
    });

    it('adds a User-Agent when the request had none (headers + ordered)', () => {
        const headers = { host: 'x.test' };
        const ordered = [['Host', 'x.test']];
        applyIdentityToOutboundHeaders(headers, ordered, catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }), { url: 'http://x.test/' });
        expect(headers['user-agent']).toBe(catalog.UA.chromeWin);
        expect(ordered[ordered.length - 1]).toEqual(['User-Agent', catalog.UA.chromeWin]);
    });

    it('works with headers only (orderedHeaders null) — log path', () => {
        const { headers } = chromiumRequest();
        applyIdentityToOutboundHeaders(headers, null, catalog.resolveIdentity({ mode: 'template', templateId: 'edge-win' }));
        expect(headers['user-agent']).toBe(catalog.UA.edgeWin);
        expect(headers['sec-ch-ua']).toContain('"Microsoft Edge"');
    });

    it('does not add Accept-Language when the request had none', () => {
        const headers = { host: 'x.test', 'user-agent': ELECTRON_UA };
        applyIdentityToOutboundHeaders(headers, null, catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win', language: 'de' }), { url: 'http://x.test/' });
        expect(headers['accept-language']).toBeUndefined();
    });
});

describe('applyIdentityToOutboundHeaders — non-Chromium identity', () => {
    it('Firefox identity strips every sec-ch-ua* header from both structures', () => {
        const { headers, ordered } = chromiumRequest();
        headers['sec-ch-ua-full-version-list'] = 'x';
        ordered.push(['sec-ch-ua-full-version-list', 'x']);
        applyIdentityToOutboundHeaders(headers, ordered, catalog.resolveIdentity({ mode: 'template', templateId: 'firefox-win' }));
        expect(headers['user-agent']).toBe(catalog.UA.firefoxWin);
        expect(Object.keys(headers).some((k) => k.startsWith('sec-ch-ua'))).toBe(false);
        expect(ordered.some(([k]) => k.toLowerCase().startsWith('sec-ch-ua'))).toBe(false);
        expect(ordered.map(([k]) => k)).toEqual(['Host', 'Connection', 'Upgrade-Insecure-Requests', 'User-Agent', 'Accept', 'Accept-Language']);
    });
    it('custom non-Chromium UA (Safari) also strips hints', () => {
        const { headers, ordered } = chromiumRequest();
        applyIdentityToOutboundHeaders(headers, ordered, catalog.resolveIdentity({ mode: 'custom', userAgent: catalog.UA.safariMac }));
        expect(headers['user-agent']).toBe(catalog.UA.safariMac);
        expect(headers['sec-ch-ua']).toBeUndefined();
    });
});

describe('previewIdentityHeaders', () => {
    it('returns null for engine and the wire values otherwise', () => {
        expect(previewIdentityHeaders(catalog.resolveIdentity(null))).toBeNull();
        const p = previewIdentityHeaders(catalog.resolveIdentity({ mode: 'template', templateId: 'opera-win', language: 'pl' }));
        expect(p['user-agent']).toBe(catalog.UA.operaWin);
        expect(p['sec-ch-ua']).toContain('"Opera"');
        expect(p['accept-language']).toBe('pl');
        const f = previewIdentityHeaders(catalog.resolveIdentity({ mode: 'template', templateId: 'safari-mac' }));
        expect(f['sec-ch-ua']).toBeNull();
    });
});

describe('applyIdentityToOutboundHeaders — engine wire identity (synthesized hints)', () => {
    it('engine identity with a UA + 2-brand hints adds the low-entropy hints when absent', () => {
        const engine = {
            mode: 'engine',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            clientHints: catalog.engineClientHints({ chromiumMajor: 146, nodePlatform: 'darwin', arch: 'arm64' }),
            language: null,
        };
        const headers = { host: 'x.test', 'user-agent': ELECTRON_UA, accept: '*/*' };
        const ordered = [['Host', 'x.test'], ['User-Agent', ELECTRON_UA], ['Accept', '*/*']];
        const r = applyIdentityToOutboundHeaders(headers, ordered, engine, { url: 'https://x.test/' });
        expect(r.applied).toBe(true);
        expect(headers['user-agent']).toBe(engine.userAgent);
        expect(headers['sec-ch-ua']).toBe(catalog.buildClientHintHeaders(engine.clientHints)['sec-ch-ua']);
        expect(headers['sec-ch-ua']).toMatch(/"Chromium";v="146"/);
        expect(headers['sec-ch-ua']).not.toMatch(/Google Chrome/);
        expect(headers['sec-ch-ua-platform']).toBe('"macOS"');
        expect(ordered.map(([k]) => k)).toEqual(['Host', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'User-Agent', 'Accept']);
    });
    it('engine identity without a UA still means legacy sanitize', () => {
        const headers = { host: 'x.test', 'user-agent': ELECTRON_UA };
        const r = applyIdentityToOutboundHeaders(headers, null, { mode: 'engine', userAgent: null, clientHints: null }, { url: 'https://x.test/' });
        expect(r.applied).toBe(false);
        expect(headers['sec-ch-ua']).toBeUndefined();
        expect(headers['user-agent']).toMatch(/Chrome\/132\.0\.0\.0/);
    });
});

describe('applyIdentityToOutboundHeaders — Accept-CH requested hints', () => {
    it('adds only the requested high-entropy hints, after the low-entropy block', () => {
        const { headers, ordered } = chromiumRequest();
        const id = catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' });
        applyIdentityToOutboundHeaders(headers, ordered, id, { url: 'https://x.test/', requestedHints: ['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'viewport-width'] });
        expect(headers['sec-ch-ua-full-version-list']).toContain(`"Chromium";v="${catalog.VERSIONS.chrome}.0.0.0"`);
        expect(headers['sec-ch-ua-platform-version']).toBe('"15.0.0"');
        expect(headers['sec-ch-ua-arch']).toBeUndefined();
        expect(headers['viewport-width']).toBeUndefined();
        const names = ordered.map(([k]) => k.toLowerCase());
        expect(names.indexOf('sec-ch-ua-full-version-list')).toBe(names.indexOf('sec-ch-ua-platform') + 1);
        expect(names.indexOf('sec-ch-ua-full-version-list')).toBeLessThan(names.indexOf('user-agent'));
    });
    it('never adds high-entropy hints without a request, nor for non-Chromium identities', () => {
        const { headers } = chromiumRequest();
        applyIdentityToOutboundHeaders(headers, null, catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }), { url: 'https://x.test/' });
        expect(headers['sec-ch-ua-full-version-list']).toBeUndefined();
        const h2 = chromiumRequest().headers;
        applyIdentityToOutboundHeaders(h2, null, catalog.resolveIdentity({ mode: 'template', templateId: 'firefox-win' }), { url: 'https://x.test/', requestedHints: ['sec-ch-ua-arch'] });
        expect(Object.keys(h2).some((k) => k.startsWith('sec-ch-ua'))).toBe(false);
    });
    it('a Chromium identity always carries client hints (the old clientHints:false toggle is ignored — real Chrome always sends them)', () => {
        const { headers } = chromiumRequest();
        const id = catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win', clientHints: false });
        expect(id.clientHints).not.toBeNull();
        applyIdentityToOutboundHeaders(headers, null, id, { url: 'https://x.test/' });
        expect(headers['user-agent']).toBe(catalog.UA.chromeWin);
        expect(headers['sec-ch-ua']).toContain('"Chromium"');
        expect(headers['sec-ch-ua-platform']).toBe('"Windows"');
    });

    it('a non-Chromium identity (Firefox) never carries client hints regardless of the flag', () => {
        const { headers } = chromiumRequest();
        const id = catalog.resolveIdentity({ mode: 'template', templateId: 'firefox-win', clientHints: true });
        expect(id.clientHints).toBeNull();
        applyIdentityToOutboundHeaders(headers, null, id, { url: 'https://x.test/' });
        expect(Object.keys(headers).some((k) => k.startsWith('sec-ch-ua'))).toBe(false);
    });
});
