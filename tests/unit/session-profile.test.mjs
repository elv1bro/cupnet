import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseSessionProfile, parseLaunchProfile, summarizeSessionProfile, FORMAT_ID, LAUNCH_FORMAT_ID } = require('../../session-profile.js');

const MINIMAL = {
    format: FORMAT_ID,
    version: 1,
    name: 'Test',
    navigate: { url: 'https://example.com/start' },
};

describe('session-profile', () => {
    it('parses a minimal valid profile', () => {
        const r = parseSessionProfile(MINIMAL);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.profile.name).toBe('Test');
        expect(r.profile.navigate.url).toBe('https://example.com/start');
        expect(r.profile.tab.newTab).toBe(true);
        expect(r.profile.cookies).toEqual([]);
    });

    it('accepts top-level url alias', () => {
        const r = parseSessionProfile({ url: 'https://example.com/x' });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.profile.navigate.url).toBe('https://example.com/x');
    });

    it('rejects missing url', () => {
        const r = parseSessionProfile({ name: 'No URL' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/url/i);
    });

    it('rejects relative url', () => {
        const r = parseSessionProfile({ navigate: { url: '/Global/home' } });
        expect(r.ok).toBe(false);
    });

    it('rejects unknown format', () => {
        const r = parseSessionProfile({ format: 'other', navigate: { url: 'https://a.com' } });
        expect(r.ok).toBe(false);
    });

    it('normalizes cookies and runAfterLoad string', () => {
        const r = parseSessionProfile({
            ...MINIMAL,
            cookies: [{ name: 'sid', value: '1', domain: 'example.com' }],
            runAfterLoad: 'console.log(1);',
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.profile.cookies).toHaveLength(1);
        expect(r.profile.cookies[0].url).toMatch(/^https:\/\/example\.com\//);
        expect(r.profile.runAfterLoad?.script).toBe('console.log(1);');
    });

    it('forces secure cookies for HTTPS handoff with secure:false', () => {
        const r = parseSessionProfile({
            ...MINIMAL,
            cookies: [{
                name: '.AspNetCore.Cookies',
                value: 'x',
                domain: 'uzbekistan.blsspainglobal.com',
                secure: false,
                httpOnly: true,
            }],
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.profile.cookies[0].secure).toBe(true);
        expect(r.profile.cookies[0].url).toMatch(/^https:\/\//);
    });

    it('summarizeSessionProfile lists key facts', () => {
        const r = parseSessionProfile({
            ...MINIMAL,
            tab: { isolated: true },
            cookies: [{ name: 'a', value: 'b', domain: 'example.com' }],
            runAfterLoad: 'void 0;',
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const s = summarizeSessionProfile(r.profile);
        expect(s).toContain('Test');
        expect(s).toContain('cookie');
        expect(s).toContain('isolated');
        expect(s).toContain('post-load');
    });

    it('parseLaunchProfile allows proxy-only without navigate url', () => {
        const r = parseLaunchProfile({
            format: LAUNCH_FORMAT_ID,
            version: 1,
            name: 'Proxy only',
            proxy: { template: 'http://127.0.0.1:8080' },
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.profile.navigate.url).toBe('');
        expect(r.profile.proxy?.template).toContain('8080');
    });

    it('parseLaunchProfile rejects empty profile', () => {
        const r = parseLaunchProfile({
            format: LAUNCH_FORMAT_ID,
            version: 1,
            name: 'Empty',
        });
        expect(r.ok).toBe(false);
    });

    it('parseSessionProfile still requires navigate url', () => {
        const r = parseSessionProfile({
            format: FORMAT_ID,
            version: 1,
            proxy: { template: 'http://127.0.0.1:8080' },
        });
        expect(r.ok).toBe(false);
    });
});
