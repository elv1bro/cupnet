'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    syncUserAgentFromTlsTemplate,
    TLS_TEMPLATE_DEFAULT_UA,
    UA_PRESET_VALUES,
} = require('../../proxy-tls-ua-sync.js');

describe('syncUserAgentFromTlsTemplate', () => {
    it('fills UA when field is empty (iOS template)', () => {
        const { newUa } = syncUserAgentFromTlsTemplate('ios', '');
        expect(newUa).toBe(TLS_TEMPLATE_DEFAULT_UA.ios);
        expect(newUa).toContain('iPhone');
        expect(newUa).toContain('Mobile');
    });

    it('fills UA when field is whitespace only', () => {
        const { newUa } = syncUserAgentFromTlsTemplate('firefox', '  \n\t  ');
        expect(newUa).toBe(TLS_TEMPLATE_DEFAULT_UA.firefox);
    });

    it('replaces a known preset UA when switching template (chrome → ios)', () => {
        const { newUa } = syncUserAgentFromTlsTemplate('ios', TLS_TEMPLATE_DEFAULT_UA.chrome);
        expect(newUa).toBe(TLS_TEMPLATE_DEFAULT_UA.ios);
    });

    it('replaces Mobile preset string when selecting iOS TLS (align with worker)', () => {
        const mobilePreset = UA_PRESET_VALUES.find((u) => u.includes('iPhone'));
        expect(mobilePreset).toBeTruthy();
        const { newUa } = syncUserAgentFromTlsTemplate('ios', mobilePreset);
        expect(newUa).toBe(TLS_TEMPLATE_DEFAULT_UA.ios);
    });

    it('does not overwrite a custom User-Agent', () => {
        const custom = 'MyCustomClient/1.0 (CupNet test)';
        const { newUa } = syncUserAgentFromTlsTemplate('ios', custom);
        expect(newUa).toBeNull();
    });

    it('does not overwrite arbitrary browser-like string not in replaceable set', () => {
        const odd = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
        const { newUa } = syncUserAgentFromTlsTemplate('chrome', odd);
        expect(newUa).toBeNull();
    });

    it('updates from iOS TLS UA to chrome when user selects chrome template', () => {
        const { newUa } = syncUserAgentFromTlsTemplate('chrome', TLS_TEMPLATE_DEFAULT_UA.ios);
        expect(newUa).toBe(TLS_TEMPLATE_DEFAULT_UA.chrome);
    });

    it('returns null newUa for invalid TLS key', () => {
        const { newUa } = syncUserAgentFromTlsTemplate('chrome_999', '');
        expect(newUa).toBeNull();
    });

    it('each valid TLS template has a non-empty default UA', () => {
        for (const key of ['chrome', 'firefox', 'safari', 'ios', 'edge', 'opera']) {
            expect(TLS_TEMPLATE_DEFAULT_UA[key].length).toBeGreaterThan(20);
        }
    });
});
