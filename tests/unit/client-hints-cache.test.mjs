'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ClientHintsCache, parseAcceptCh, originOf, isNavigationRequest, headerValue } = require('../../client-hints-cache.js');

describe('client-hints-cache: parsing', () => {
    it('parseAcceptCh keeps only supported high-entropy UA hints, lower-cased and deduplicated', () => {
        expect(parseAcceptCh('Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA, Viewport-Width, sec-ch-ua-arch, SEC-CH-UA-ARCH, UA-Model'))
            .toEqual(['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch']);
        expect(parseAcceptCh(['sec-ch-ua-bitness', 'sec-ch-ua-model'])).toEqual(['sec-ch-ua-bitness', 'sec-ch-ua-model']);
        expect(parseAcceptCh('')).toEqual([]);
        expect(parseAcceptCh(null)).toEqual([]);
    });
    it('originOf only accepts secure origins; headerValue is case-insensitive', () => {
        expect(originOf('https://a.example:8443/x?y')).toBe('https://a.example:8443');
        expect(originOf('http://a.example/')).toBeNull();
        expect(originOf('nonsense')).toBeNull();
        expect(headerValue({ 'Accept-CH': 'x' }, 'accept-ch')).toBe('x');
        expect(headerValue({ 'set-cookie': ['a', 'b'] }, 'Set-Cookie')).toBe('a, b');
        expect(headerValue({}, 'accept-ch')).toBeNull();
    });
    it('isNavigationRequest uses Sec-Fetch-Mode / Sec-Fetch-Dest', () => {
        expect(isNavigationRequest({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).toBe(true);
        expect(isNavigationRequest({ 'Sec-Fetch-Mode': 'navigate' })).toBe(true);
        expect(isNavigationRequest({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).toBe(false);
        expect(isNavigationRequest({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'image' })).toBe(false);
        expect(isNavigationRequest({})).toBe(false);
    });
});

describe('client-hints-cache: cache behaviour', () => {
    const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-ch-ua': 'x' };

    it('remembers Accept-CH from navigation responses per origin and serves it to later requests', () => {
        const c = new ClientHintsCache();
        const r = c.observeResponse('https://site.example/login', nav, { 'Accept-CH': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version' });
        expect(r.accepted).toEqual(['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version']);
        expect(r.retryWith).toEqual([]);
        expect(c.requestedFor('https://site.example/api/x')).toEqual(['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version']);
        expect(c.requestedFor('https://other.example/')).toEqual([]);
        expect(c.requestedFor('http://site.example/')).toEqual([]);
        // latest header replaces the set; an empty one clears it
        c.observeResponse('https://site.example/', nav, { 'accept-ch': 'sec-ch-ua-arch' });
        expect(c.requestedFor('https://site.example/')).toEqual(['sec-ch-ua-arch']);
        c.remember('https://site.example/', []);
        expect(c.requestedFor('https://site.example/')).toEqual([]);
    });

    it('ignores Accept-CH on subresource responses', () => {
        const c = new ClientHintsCache();
        const r = c.observeResponse('https://site.example/app.js', { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }, { 'accept-ch': 'sec-ch-ua-arch' });
        expect(r.accepted).toEqual([]);
        expect(c.size).toBe(0);
    });

    it('Critical-CH asks for a retry only for accepted hints missing from the request', () => {
        const c = new ClientHintsCache();
        const r = c.observeResponse('https://site.example/', nav, {
            'Accept-CH': 'sec-ch-ua-full-version-list, sec-ch-ua-platform-version',
            'Critical-CH': 'sec-ch-ua-full-version-list, sec-ch-ua-model',
        });
        expect(r.critical).toEqual(['sec-ch-ua-full-version-list', 'sec-ch-ua-model']);
        expect(r.retryWith).toEqual(['sec-ch-ua-full-version-list']);
        // already present on the request → no retry
        const r2 = c.observeResponse('https://site.example/', { ...nav, 'sec-ch-ua-full-version-list': 'v' }, { 'Critical-CH': 'sec-ch-ua-full-version-list' });
        expect(r2.retryWith).toEqual([]);
    });

    it('evicts the oldest origins beyond the cap and can be cleared', () => {
        const c = new ClientHintsCache();
        for (let i = 0; i < 520; i++) c.remember(`https://o${i}.example/`, ['sec-ch-ua-arch']);
        expect(c.size).toBe(500);
        expect(c.requestedFor('https://o0.example/')).toEqual([]);
        expect(c.requestedFor('https://o519.example/')).toEqual(['sec-ch-ua-arch']);
        c.clear();
        expect(c.size).toBe(0);
    });
});
