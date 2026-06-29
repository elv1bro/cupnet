'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCookieRequestUrl,
    cookieIdentityKey,
    cookiesMatchIdentity,
    normalizeRemoveCookieArgs,
} from '../../main-process/services/session-cookie-utils.js';

describe('session-cookie-utils', () => {
    it('buildCookieRequestUrl strips leading dot from domain', () => {
        const url = buildCookieRequestUrl({ domain: '.example.com', path: '/a', secure: true });
        assert.equal(url, 'https://example.com/a');
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
});
