'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeParentDomain,
    parentDomainAttribute,
    cookieBelongsToTree,
    isStrictSubdomainHost,
} from '../../main-process/services/session-cookie-utils.js';

describe('cookie consolidate helpers', () => {
    it('computeParentDomain strips leftmost subdomain label', () => {
        assert.equal(computeParentDomain('armenia.blsspainrussia.ru'), 'blsspainrussia.ru');
        assert.equal(parentDomainAttribute('blsspainrussia.ru'), '.blsspainrussia.ru');
    });

    it('cookieBelongsToTree matches parent and subdomains', () => {
        const parent = 'blsspainrussia.ru';
        assert.equal(cookieBelongsToTree({ domain: '.blsspainrussia.ru' }, parent), true);
        assert.equal(cookieBelongsToTree({ domain: 'armenia.blsspainrussia.ru' }, parent), true);
        assert.equal(cookieBelongsToTree({ domain: 'google.com' }, parent), false);
    });

    it('isStrictSubdomainHost detects host-only subdomain cookies', () => {
        assert.equal(isStrictSubdomainHost('armenia.blsspainrussia.ru', 'blsspainrussia.ru'), true);
        assert.equal(isStrictSubdomainHost('blsspainrussia.ru', 'blsspainrussia.ru'), false);
    });
});
