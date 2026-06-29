import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    resolveNavigationUrl,
    resolveNavigationUrlWithBase,
    formatBytes,
    parseProxyTemplate,
    extractTemplateVars,
    shouldFilterUrl,
    sanitizeOutgoingRequestHeaders,
    shouldSkipOmniboxInlineGhost,
    SEARCH_ENGINE,
    SEARCH_ENGINES,
} = require('../../utils.js');

describe('utils', () => {
    it('resolveNavigationUrl adds https for domain-like input', () => {
        expect(resolveNavigationUrl('example.com')).toBe('https://example.com');
    });

    it('resolveNavigationUrlWithBase resolves site-relative paths', () => {
        const base = 'https://app.example.com/dashboard';
        expect(resolveNavigationUrlWithBase('/account/login?next=%2Ffoo', base))
            .toBe('https://app.example.com/account/login?next=%2Ffoo');
        expect(resolveNavigationUrlWithBase('https://example.com/x', base))
            .toBe('https://example.com/x');
    });

    it('formatBytes formats small sizes', () => {
        expect(formatBytes(500)).toContain('B');
    });

    it('parseProxyTemplate replaces RAND and SID', () => {
        const out = {};
        const s = parseProxyTemplate('http://x:{RAND:1-2}:{SID}', {}, out);
        expect(s).toMatch(/^http:\/\/x:[12]:cupnet\d{10}$/);
    });

    it('extractTemplateVars collects {VAR} and ignores {RAND:a-b}', () => {
        expect(extractTemplateVars('http://x:{USER}:{PASS}:{RAND:1-10}')).toEqual(['USER', 'PASS']);
    });

    it('shouldFilterUrl hides file:// and matches glob patterns', () => {
        expect(shouldFilterUrl('file:///tmp/x', [])).toBe(true);
        expect(shouldFilterUrl('https://x.com', [])).toBe(false);
        const patterns = ['*.google.com'];
        expect(shouldFilterUrl('https://www.google.com/foo', patterns)).toBe(true);
    });

    it('sanitizeOutgoingRequestHeaders removes pseudo-headers and null values', () => {
        expect(
            sanitizeOutgoingRequestHeaders({
                ':method': 'GET',
                Host: 'x.com',
                'X-Null': null,
            }),
        ).toEqual({ Host: 'x.com' });
    });

    it('SEARCH_ENGINE is a DuckDuckGo query URL', () => {
        expect(SEARCH_ENGINE).toContain('duckduckgo.com');
        expect(SEARCH_ENGINE).toContain('?q=');
    });

    it('resolveNavigationUrl uses searchEngineUrl option for queries', () => {
        const u = resolveNavigationUrl('hello world', { searchEngineUrl: SEARCH_ENGINES.google });
        expect(u.startsWith('https://www.google.com/search?q=')).toBe(true);
        expect(u).toContain('hello');
    });

    it('shouldSkipOmniboxInlineGhost skips origin-only URLs', () => {
        expect(shouldSkipOmniboxInlineGhost('https://app.example.com/')).toBe(true);
        expect(shouldSkipOmniboxInlineGhost('https://app.example.com')).toBe(true);
        expect(shouldSkipOmniboxInlineGhost('https://httpbin.org/ge')).toBe(false);
        expect(shouldSkipOmniboxInlineGhost('')).toBe(true);
    });
});
