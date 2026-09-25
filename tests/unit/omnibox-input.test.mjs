import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { classifyOmniboxInput, resolveInternalAlias, looksLikeUrl, applySearchEngineTemplate } = require('../../omnibox-input.js');

describe('classifyOmniboxInput', () => {
    const cases = [
        ['', { kind: 'empty' }],
        ['   ', { kind: 'empty' }],
        ['> reload', { kind: 'command', query: 'reload' }],
        ['>', { kind: 'command', query: '' }],
        ['cupnet://settings', { kind: 'internal', internal: 'settings' }],
        ['CUPNET://Guide/', { kind: 'internal', internal: 'guide' }],
        ['cupnet://newtab', { kind: 'internal', internal: 'new-tab' }],
        ['cupnet://home', { kind: 'internal', internal: 'new-tab' }],
        ['cupnet://history', { kind: 'internal', internal: 'history' }],
        ['cupnet://identity', { kind: 'internal', internal: 'identity-check' }],
        ['https://example.com/x?y=1', { kind: 'url', url: 'https://example.com/x?y=1' }],
        ['http://example.com', { kind: 'url', url: 'http://example.com' }],
        ['file:///tmp/a.html', { kind: 'url', url: 'file:///tmp/a.html' }],
        ['about:blank', { kind: 'url', url: 'about:blank' }],
        ['localhost', { kind: 'url', url: 'http://localhost' }],
        ['localhost:3000', { kind: 'url', url: 'http://localhost:3000' }],
        ['localhost:3000/api?x=1', { kind: 'url', url: 'http://localhost:3000/api?x=1' }],
        ['LocalHost:8080', { kind: 'url', url: 'http://LocalHost:8080' }],
        ['[::1]:3000', { kind: 'url', url: 'http://[::1]:3000' }],
        ['[::1]', { kind: 'url', url: 'http://[::1]' }],
        ['127.0.0.1', { kind: 'url', url: 'http://127.0.0.1' }],
        ['10.0.0.5:8443/admin', { kind: 'url', url: 'http://10.0.0.5:8443/admin' }],
        ['192.168.1.20', { kind: 'url', url: 'http://192.168.1.20' }],
        ['8.8.8.8', { kind: 'url', url: 'https://8.8.8.8' }],
        ['api:8080/v1', { kind: 'url', url: 'http://api:8080/v1' }],
        ['intranet/path', { kind: 'url', url: 'http://intranet/path' }],
        ['example.com', { kind: 'url', url: 'https://example.com' }],
        ['www.example.com/path', { kind: 'url', url: 'https://www.example.com/path' }],
        ['sub.example.co.uk:8443/x', { kind: 'url', url: 'https://sub.example.co.uk:8443/x' }],
        ['app.local', { kind: 'url', url: 'http://app.local' }],
        ['dev.test:5173', { kind: 'url', url: 'http://dev.test:5173' }],
        ['wiki', { kind: 'search', query: 'wiki' }],
        ['settings', { kind: 'search', query: 'settings' }],
        ['two words', { kind: 'search', query: 'two words' }],
        ['example.com is down', { kind: 'search', query: 'example.com is down' }],
        ['3.14', { kind: 'search', query: '3.14' }],
        ['v1.2', { kind: 'search', query: 'v1.2' }],
        ['what is localhost?', { kind: 'search', query: 'what is localhost?' }],
        ['c++ tutorial', { kind: 'search', query: 'c++ tutorial' }],
        ['/only/path', { kind: 'search', query: '/only/path' }],
    ];
    for (const [input, expected] of cases) {
        it(`classifies ${JSON.stringify(input)} as ${expected.kind}`, () => {
            const got = classifyOmniboxInput(input);
            expect(got.kind).toBe(expected.kind);
            if (expected.url !== undefined) expect(got.url).toBe(expected.url);
            if (expected.query !== undefined) expect(got.query).toBe(expected.query);
            if (expected.internal !== undefined) expect(got.internal).toBe(expected.internal);
        });
    }

    it('resolves site-relative paths against the current https page', () => {
        const got = classifyOmniboxInput('/account/login?next=%2Ffoo', { base: 'https://app.example.com/dashboard' });
        expect(got.kind).toBe('url');
        expect(got.url).toBe('https://app.example.com/account/login?next=%2Ffoo');
    });

    it('does not resolve site-relative paths against internal pages', () => {
        expect(classifyOmniboxInput('/x', { base: 'file:///new-tab.html' }).kind).toBe('search');
        expect(classifyOmniboxInput('/x', { base: 'about:blank' }).kind).toBe('search');
    });

    it('marks added vs typed schemes', () => {
        expect(classifyOmniboxInput('https://example.com').scheme).toBe('typed');
        expect(classifyOmniboxInput('example.com').scheme).toBe('added');
    });

    it('treats an invalid scheme URL as a search', () => {
        expect(classifyOmniboxInput('http://').kind).toBe('search');
    });
});

describe('helpers', () => {
    it('resolveInternalAlias normalises case and trailing slashes', () => {
        expect(resolveInternalAlias('CUPNET://SETTINGS/')).toBe('settings');
        expect(resolveInternalAlias('cupnet:new-tab')).toBe('new-tab');
        expect(resolveInternalAlias('https://example.com')).toBeNull();
    });

    it('looksLikeUrl mirrors classification', () => {
        expect(looksLikeUrl('localhost:3000')).toBe(true);
        expect(looksLikeUrl('cupnet://guide')).toBe(true);
        expect(looksLikeUrl('hello world')).toBe(false);
    });

    it('applySearchEngineTemplate supports {q} and append', () => {
        expect(applySearchEngineTemplate('https://s.example/?q={q}&x=1', 'a b')).toBe('https://s.example/?q=a%20b&x=1');
        expect(applySearchEngineTemplate('https://s.example/?q=', 'a&b')).toBe('https://s.example/?q=a%26b');
    });
});
