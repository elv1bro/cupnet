'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const catalog = require('../../browser-identity-catalog.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

describe('browser-identity-catalog: templates', () => {
    it('every template is complete and internally consistent', () => {
        expect(catalog.IDENTITY_TEMPLATES.length).toBeGreaterThanOrEqual(8);
        const ids = new Set();
        for (const t of catalog.IDENTITY_TEMPLATES) {
            expect(ids.has(t.id)).toBe(false);
            ids.add(t.id);
            expect(t.label).toBeTruthy();
            expect(catalog.TLS_PROFILES).toContain(t.tlsProfile);
            expect(t.userAgent).toMatch(/^Mozilla\/5\.0 /);
            expect(t.userAgent).not.toMatch(/CupNet|Electron/i);
            expect(typeof t.navigatorPlatform).toBe('string');
            const isChromium = /Chrome\/\d/.test(t.userAgent) && !/\b(iPhone|iPad)\b/.test(t.userAgent);
            if (isChromium) {
                expect(t.clientHints).toBeTruthy();
                const major = t.userAgent.match(/Chrome\/(\d+)/)[1];
                const chromium = t.clientHints.brands.find((b) => b.brand === 'Chromium');
                expect(chromium.version).toBe(major);
                expect(t.clientHints.mobile).toBe(t.mobile);
            } else {
                expect(t.clientHints).toBeNull();
            }
        }
    });

    it('DEFAULT_TEMPLATE_FOR_TLS covers every TLS profile and resolves', () => {
        for (const tls of catalog.TLS_PROFILES) {
            const id = catalog.DEFAULT_TEMPLATE_FOR_TLS[tls];
            const t = catalog.getTemplate(id);
            expect(t, tls).toBeTruthy();
            expect(t.tlsProfile).toBe(tls);
        }
    });

    it('getTemplate returns copies (mutations do not leak)', () => {
        const a = catalog.getTemplate('chrome-win');
        a.clientHints.platform = 'Mutated';
        expect(catalog.getTemplate('chrome-win').clientHints.platform).toBe('Windows');
        expect(catalog.getTemplate('nope')).toBeNull();
    });

    it('UA strings match the Go worker profiles (azuretls-go/profiles.go)', () => {
        const go = readFileSync(path.join(repoRoot, 'azuretls-go', 'profiles.go'), 'utf8');
        for (const tls of catalog.TLS_PROFILES) {
            const ua = catalog.getTemplate(catalog.DEFAULT_TEMPLATE_FOR_TLS[tls]).userAgent;
            expect(go.includes(`"${ua}"`), `profiles.go should contain the ${tls} UA "${ua}"`).toBe(true);
        }
    });
});

describe('browser-identity-catalog: greased brands', () => {
    it('follows Chromium ordering / grease rules per major', () => {
        const list = catalog.greasedBrandList(154, { brand: 'Google Chrome', version: '154' });
        expect(list).toHaveLength(3);
        expect(list.map((b) => b.brand)).toContain('Chromium');
        expect(list.map((b) => b.brand)).toContain('Google Chrome');
        const grease = list.find((b) => /^Not/.test(b.brand));
        expect(grease.brand).toMatch(/^Not.A.Brand$/);
        expect(['8', '99', '24']).toContain(grease.version);
        // order permutes with the seed
        const l2 = catalog.greasedBrandList(155, { brand: 'Google Chrome', version: '155' });
        expect(l2.map((b) => b.brand)).not.toEqual(list.map((b) => b.brand));
        // full version list carries x.0.0.0
        const full = catalog.greasedBrandList(154, { brand: 'Google Chrome', version: '154' }, true);
        expect(full.find((b) => b.brand === 'Chromium').version).toBe('154.0.0.0');
    });

    it('header value is a structured-field list', () => {
        const v = catalog.buildBrandListHeaderValue([{ brand: 'Chromium', version: '154' }, { brand: 'Not A(Brand', version: '99' }]);
        expect(v).toBe('"Chromium";v="154", "Not A(Brand";v="99"');
    });
});

describe('browser-identity-catalog: derive from custom UA', () => {
    it('Chrome on Windows', () => {
        const h = catalog.deriveClientHintsFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36');
        expect(h.platform).toBe('Windows');
        expect(h.mobile).toBe(false);
        expect(h.brands.find((b) => b.brand === 'Google Chrome').version).toBe('151');
        expect(h.architecture).toBe('x86');
    });
    it('Edge / Opera primary brands', () => {
        const e = catalog.deriveClientHintsFromUserAgent(catalog.UA.edgeWin);
        expect(e.brands.map((b) => b.brand)).toContain('Microsoft Edge');
        expect(e.brands.map((b) => b.brand)).not.toContain('Google Chrome');
        const o = catalog.deriveClientHintsFromUserAgent(catalog.UA.operaWin);
        expect(o.brands.find((b) => b.brand === 'Opera').version).toBe(String(catalog.VERSIONS.opera));
        expect(o.brands.find((b) => b.brand === 'Chromium').version).toBe(String(catalog.VERSIONS.operaChromium));
    });
    it('Android is mobile with model, macOS is arm', () => {
        const a = catalog.deriveClientHintsFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36');
        expect(a.platform).toBe('Android');
        expect(a.mobile).toBe(true);
        expect(a.model).toBe('Pixel 8');
        const m = catalog.deriveClientHintsFromUserAgent(catalog.UA.chromeMac);
        expect(m.platform).toBe('macOS');
        expect(m.architecture).toBe('arm');
    });
    it('non-Chromium UAs have no hints', () => {
        expect(catalog.deriveClientHintsFromUserAgent(catalog.UA.firefoxWin)).toBeNull();
        expect(catalog.deriveClientHintsFromUserAgent(catalog.UA.safariMac)).toBeNull();
        expect(catalog.deriveClientHintsFromUserAgent(catalog.UA.iosSafari)).toBeNull();
        expect(catalog.deriveClientHintsFromUserAgent('')).toBeNull();
        expect(catalog.deriveClientHintsFromUserAgent('curl/8.0')).toBeNull();
    });
    it('TLS profile / navigator.platform guesses', () => {
        expect(catalog.deriveTlsProfileFromUserAgent(catalog.UA.firefoxMac)).toBe('firefox');
        expect(catalog.deriveTlsProfileFromUserAgent(catalog.UA.iosSafari)).toBe('ios');
        expect(catalog.deriveTlsProfileFromUserAgent(catalog.UA.safariMac)).toBe('safari');
        expect(catalog.deriveTlsProfileFromUserAgent(catalog.UA.edgeWin)).toBe('edge');
        expect(catalog.deriveTlsProfileFromUserAgent(catalog.UA.operaWin)).toBe('opera');
        expect(catalog.deriveTlsProfileFromUserAgent('curl/8')).toBe('chrome');
        expect(catalog.deriveNavigatorPlatformFromUserAgent(catalog.UA.iosSafari)).toBe('iPhone');
        expect(catalog.deriveNavigatorPlatformFromUserAgent(catalog.UA.chromeLinux)).toBe('Linux x86_64');
        expect(catalog.deriveNavigatorPlatformFromUserAgent(catalog.UA.chromeMac)).toBe('MacIntel');
    });
});

describe('browser-identity-catalog: resolveIdentity', () => {
    it('engine mode carries no UA but keeps TLS/JA3/timezone/language', () => {
        const r = catalog.resolveIdentity({ mode: 'engine', tlsProfile: 'firefox', tlsJa3Mode: 'custom', tlsJa3Custom: '771,1-2,3,4,0', timezone: 'Europe/Berlin', language: 'de-DE,de;q=0.9' });
        expect(r.mode).toBe('engine');
        expect(r.userAgent).toBeNull();
        expect(r.clientHints).toBeNull();
        expect(r.tlsProfile).toBe('firefox');
        expect(r.ja3).toBe('771,1-2,3,4,0');
        expect(r.timezone).toBe('Europe/Berlin');
        expect(r.language).toBe('de-DE,de;q=0.9');
    });
    it('template mode takes UA/hints/TLS from the template unless TLS is overridden', () => {
        const r = catalog.resolveIdentity({ mode: 'template', templateId: 'firefox-win' });
        expect(r.userAgent).toBe(catalog.UA.firefoxWin);
        expect(r.tlsProfile).toBe('firefox');
        expect(r.clientHints).toBeNull();
        const r2 = catalog.resolveIdentity({ mode: 'template', templateId: 'firefox-win', tlsProfile: 'chrome' });
        expect(r2.tlsProfile).toBe('chrome');
    });
    it('unknown template id falls back to chrome-win; invalid mode to engine', () => {
        expect(catalog.resolveIdentity({ mode: 'template', templateId: 'zzz' }).templateId).toBe('chrome-win');
        expect(catalog.resolveIdentity({ mode: 'weird' }).mode).toBe('engine');
        expect(catalog.resolveIdentity(null).mode).toBe('engine');
    });
    it('custom mode derives hints/TLS/platform; empty UA degrades to engine', () => {
        const r = catalog.resolveIdentity({ mode: 'custom', userAgent: catalog.UA.edgeWin });
        expect(r.tlsProfile).toBe('edge');
        expect(r.navigatorPlatform).toBe('Win32');
        expect(r.clientHints.brands.map((b) => b.brand)).toContain('Microsoft Edge');
        expect(catalog.resolveIdentity({ mode: 'custom', userAgent: '   ' }).mode).toBe('engine');
    });
    it('resolveIdentityFromProfileRow: UA row → custom override with fallback tz/lang', () => {
        const fb = catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-mac', timezone: 'UTC', language: 'en-US' });
        const r = catalog.resolveIdentityFromProfileRow({ user_agent: catalog.UA.firefoxWin, tls_profile: 'firefox', force_http1: 1 }, fb);
        expect(r.userAgent).toBe(catalog.UA.firefoxWin);
        expect(r.tlsProfile).toBe('firefox');
        expect(r.forceHttp1).toBe(true);
        expect(r.timezone).toBe('UTC');
        expect(r.language).toBe('en-US');
        // no UA in the row → keep the fallback UA but take the row's TLS/timezone
        const r2 = catalog.resolveIdentityFromProfileRow({ tls_profile: 'safari', timezone: 'Asia/Tokyo' }, fb);
        expect(r2.userAgent).toBe(catalog.UA.chromeMac);
        expect(r2.tlsProfile).toBe('safari');
        expect(r2.timezone).toBe('Asia/Tokyo');
    });
    it('CDP metadata shape', () => {
        const r = catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-android' });
        const md = catalog.buildCdpUserAgentMetadata(r.clientHints);
        expect(md.platform).toBe('Android');
        expect(md.mobile).toBe(true);
        expect(md.model).toBe('Pixel 9');
        expect(md.fullVersion).toBe(`${catalog.VERSIONS.chrome}.0.0.0`);
        expect(md.brands.length).toBe(3);
        expect(catalog.buildCdpUserAgentMetadata(null)).toBeNull();
    });
    it('describeIdentity', () => {
        expect(catalog.describeIdentity(catalog.resolveIdentity(null))).toBe('Engine default');
        expect(catalog.describeIdentity(catalog.resolveIdentity({ mode: 'template', templateId: 'chrome-win' }))).toBe(`Chrome ${catalog.VERSIONS.chrome} · Windows`);
        expect(catalog.describeIdentity(catalog.resolveIdentity({ mode: 'custom', userAgent: 'MyUA/1.0' }))).toMatch(/^Custom UA/);
    });
});

describe('browser-identity-catalog: engine (unbranded Chromium) hints', () => {
    it('2-brand list follows Chromium: seed % 2 picks the order, grease chars from the seed', () => {
        // Electron 34 / Chromium 132 reported: "Not A(Brand";v="8", "Chromium";v="132"
        expect(catalog.greasedBrandList(132, null)).toEqual([{ brand: 'Not A(Brand', version: '8' }, { brand: 'Chromium', version: '132' }]);
        const odd = catalog.greasedBrandList(133, null);
        expect(odd[0].brand).toBe('Chromium');
        expect(odd[1].brand).toMatch(/^Not.A.Brand$/);
        expect(catalog.greasedBrandList(132, null, true)[1].version).toBe('132.0.0.0');
    });
    it('engineClientHints describes the host platform with no primary brand', () => {
        const h = catalog.engineClientHints({ chromiumMajor: 146, nodePlatform: 'darwin', arch: 'arm64' });
        expect(h.platform).toBe('macOS');
        expect(h.architecture).toBe('arm');
        expect(h.brands.map((b) => b.brand)).toContain('Chromium');
        expect(h.brands.map((b) => b.brand)).not.toContain('Google Chrome');
        expect(h.brands.length).toBe(2);
        expect(h.mobile).toBe(false);
        expect(catalog.engineClientHints({ chromiumMajor: 146, nodePlatform: 'win32', arch: 'x64' }).platform).toBe('Windows');
        expect(catalog.engineClientHints({ chromiumMajor: 146, nodePlatform: 'linux' }).platform).toBe('Linux');
        expect(catalog.buildClientHintHeaders(h)['sec-ch-ua']).toMatch(/"Chromium";v="146"/);
    });
    it('normalizeIdentitySettings: engineHints defaults on, followProxyGeo defaults off', () => {
        const n = catalog.normalizeIdentitySettings({});
        expect(n.engineHints).toBe(true);
        expect(n.followProxyGeo).toBe(false);
        expect(catalog.normalizeIdentitySettings({ engineHints: false, followProxyGeo: true })).toMatchObject({ engineHints: false, followProxyGeo: true });
    });
});

describe('browser-identity-catalog: Accept-Language helpers', () => {
    it('acceptLanguageCodes strips q-values and junk; formatAcceptLanguageHeader rebuilds Chromium-style q-values', () => {
        expect(catalog.acceptLanguageCodes('ru,en-US;q=0.8;q=0.9,en;q=0.7;q=0.8')).toEqual(['ru', 'en-US', 'en']);
        expect(catalog.acceptLanguageCodes('en-US, en;q=0.9, en')).toEqual(['en-US', 'en']);
        expect(catalog.acceptLanguageCodes('bad value!,de')).toEqual(['de']);
        expect(catalog.formatAcceptLanguageHeader(['ru', 'en-US', 'en'])).toBe('ru,en-US;q=0.9,en;q=0.8');
        expect(catalog.formatAcceptLanguageHeader('en-US,en;q=0.9')).toBe('en-US,en;q=0.9');
        expect(catalog.formatAcceptLanguageHeader('')).toBe('');
        expect(catalog.formatAcceptLanguageHeader(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'])).toMatch(/k;q=0\.1$/);
    });
});
