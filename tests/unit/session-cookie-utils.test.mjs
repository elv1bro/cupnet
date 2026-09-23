'use strict';

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
    buildCookieRequestUrl,
    buildExpireSetDetails,
    cookieIdentityKey,
    cookieMatchesDomainFilter,
    cookiesMatchIdentity,
    isHostOnlyCookie,
    normalizeRemoveCookieArgs,
} from '../../main-process/services/session-cookie-utils.js';

describe('session-cookie-utils', () => {
    it('buildCookieRequestUrl strips leading dot from domain', () => {
        const url = buildCookieRequestUrl({ domain: '.example.com', path: '/a', secure: true });
        assert.equal(url, 'https://example.com/a');
    });

    it('buildCookieRequestUrl defaults to https when secure is unset', () => {
        const url = buildCookieRequestUrl({ domain: '.example.com', path: '/', secure: undefined });
        assert.equal(url, 'https://example.com/');
    });

    it('cookieIdentityKey distinguishes same name on different paths', () => {
        const a = { name: 'sid', domain: '.x.com', path: '/', secure: true };
        const b = { name: 'sid', domain: '.x.com', path: '/app', secure: true };
        assert.notEqual(cookieIdentityKey(a), cookieIdentityKey(b));
        assert.equal(cookiesMatchIdentity(a, a), true);
        assert.equal(cookiesMatchIdentity(a, b), false);
    });

    it('normalizeRemoveCookieArgs accepts full cookie object', () => {
        const c = normalizeRemoveCookieArgs({
            name: 'a',
            domain: '.httpbin.org',
            path: '/cookies',
            secure: true,
        });
        assert.equal(c.name, 'a');
        assert.equal(c.domain, '.httpbin.org');
        assert.equal(c.path, '/cookies');
        assert.equal(c.url, 'https://httpbin.org/cookies');
    });

    it('normalizeRemoveCookieArgs supports legacy url + name', () => {
        const c = normalizeRemoveCookieArgs('https://httpbin.org/', 'cupnet_ipc');
        assert.equal(c.name, 'cupnet_ipc');
        assert.equal(c.domain, 'httpbin.org');
        assert.equal(c.path, '/');
    });

    it('isHostOnlyCookie respects hostOnly and __Host- prefix', () => {
        assert.equal(isHostOnlyCookie({ name: 'a', domain: 'x.com', hostOnly: true }), true);
        assert.equal(isHostOnlyCookie({ name: '__Host-sid', domain: 'x.com' }), true);
        assert.equal(isHostOnlyCookie({ name: 'a', domain: '.x.com' }), false);
    });

    it('buildExpireSetDetails omits domain for host-only cookies', () => {
        const d = buildExpireSetDetails(
            { name: 'sid', domain: 'x.com', path: '/', secure: true, hostOnly: true },
            'https://x.com/',
            0
        );
        assert.equal(d.domain, undefined);
        assert.equal(d.secure, true);
    });

    it('cookieMatchesDomainFilter matches parent and subdomain domains', () => {
        assert.equal(cookieMatchesDomainFilter({ domain: '.example.com' }, 'example.com'), true);
        assert.equal(cookieMatchesDomainFilter({ domain: 'app.example.com' }, 'example.com'), true);
        assert.equal(cookieMatchesDomainFilter({ domain: 'other.com' }, 'example.com'), false);
    });
});
