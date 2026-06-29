import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    getProxyProviderById,
    buildProviderTemplate,
    buildProviderVariables,
    getProfileProviderMeta,
    filterUserTemplateVars,
    isReservedProviderVar,
    resolveProviderCredentials,
    planProviderAccountTests,
    buildProviderAccountTestTemplate,
    maskProxyUrlForDisplay,
    getProviderTestCheckUrl,
    getProviderTestMinPasses,
} from '../../proxy-providers.js';

describe('proxy-providers', () => {
    it('decodo sticky template includes SID, duration, and sticky port range', () => {
        const tpl = buildProviderTemplate('decodo', {
            username: 'myuser',
            password: 'mypass',
            countryCode: 'pl',
            sessionMode: 'sticky',
            durationMin: 45,
        });
        assert.match(tpl, /^http:\/\//);
        assert.match(tpl, /country-pl/);
        assert.match(tpl, /\{SID\}/);
        assert.match(tpl, /sessionduration-45/);
        assert.match(tpl, /@pl\.decodo\.com:\{RAND:20001-29999\}$/);
    });

    it('decodo rotating template uses fixed rotating port', () => {
        const tpl = buildProviderTemplate('decodo', {
            username: 'u',
            password: 'p',
            countryCode: 'de',
            sessionMode: 'rotating',
        });
        assert.doesNotMatch(tpl, /\{SID\}/);
        assert.match(tpl, /@de\.decodo\.com:20000$/);
    });

    it('decodo random uses gate without country-random segment', () => {
        const tpl = buildProviderTemplate('decodo', {
            username: 'myuser',
            password: 'mypass',
            countryCode: 'random',
            sessionMode: 'rotating',
        });
        assert.match(tpl, /user-myuser:/);
        assert.doesNotMatch(tpl, /country-random/);
        assert.match(tpl, /@gate\.decodo\.com:10000$/);
    });

    it('provider account test picks three countries from popular pool', () => {
        const decodo = getProxyProviderById('decodo');
        const plan = planProviderAccountTests('decodo', 3);
        assert.equal(plan.length, 3);
        assert.ok(plan.every(p => decodo.countries.some(c => c.code === p.code)));
        const tpl = buildProviderAccountTestTemplate('decodo', {
            username: 'u',
            password: 'p',
            countryCode: plan[0].code,
        });
        assert.match(tpl, /^http:\/\//);
        assert.match(tpl, /user-u-country-/);
    });

    it('decodo exposes all endpoint countries', () => {
        const decodo = getProxyProviderById('decodo');
        assert.ok(decodo.countries.length >= 130);
        const pl = decodo.countries.find((c) => c.code === 'pl');
        assert.equal(pl.portRotating, 20000);
        assert.equal(pl.stickyMin, 20001);
        assert.equal(pl.stickyMax, 29999);
    });

    it('buildProviderVariables stores profile settings without credentials', () => {
        const vars = buildProviderVariables('decodo', {
            countryCode: 'us',
            sessionMode: 'sticky',
            durationMin: 30,
            accountId: 'acc_test',
            username: 'user1',
            password: 'pass1',
        });
        assert.equal(vars.__connectionMode, 'provider');
        assert.equal(vars.__provider, 'decodo');
        assert.equal(vars.__country, 'us');
        assert.equal(vars.__sessionMode, 'sticky');
        assert.equal(vars.__accountId, 'acc_test');
        assert.equal(vars.__username, undefined);
        assert.equal(vars.__password, undefined);
    });

    it('resolveProviderCredentials falls back to legacy profile vars', () => {
        assert.deepEqual(resolveProviderCredentials('decodo', { __username: 'legacy', __password: 'old' }), {
            username: 'legacy',
            password: 'old',
            fromAccount: false,
            accountId: '',
        });
        assert.deepEqual(resolveProviderCredentials('decodo', {}), {
            username: '',
            password: '',
            fromAccount: false,
            accountId: '',
        });
    });

    it('getProfileProviderMeta returns Custom URL for manual profiles', () => {
        const meta = getProfileProviderMeta({ __connectionMode: 'manual' });
        assert.equal(meta.providerName, 'Custom URL');
        assert.equal(meta.providerId, '__custom__');
    });

    it('oxylabs strips customer prefix and uses uppercase country code', () => {
        const tpl = buildProviderTemplate('oxylabs', {
            username: 'customer-john_TFTdL-cc-us',
            password: 'Secret1!',
            countryCode: 'de',
            sessionMode: 'rotating',
        });
        assert.match(tpl, /customer-john_TFTdL-cc-DE:Secret1!@pr\.oxylabs\.io:7777$/);
        assert.doesNotMatch(tpl, /customer-customer/);
    });

    it('oxylabs encodes plus in password', () => {
        const tpl = buildProviderTemplate('oxylabs', {
            username: 'user',
            password: 'pass+word',
            countryCode: 'us',
            sessionMode: 'rotating',
        });
        assert.match(tpl, /:pass%2Bword@pr\.oxylabs\.io:7777$/);
    });

    it('maskProxyUrlForDisplay keeps first and last password characters without trailing slash', () => {
        const masked = maskProxyUrlForDisplay('http://customer-u-cc-US:pAzzw0rd!@pr.oxylabs.io:7777');
        assert.match(masked, /:p\*+!@pr\.oxylabs\.io:7777$/);
        assert.doesNotMatch(masked, /pAzzw0rd!/);
        assert.doesNotMatch(masked, /7777\/$/);
    });

    it('oxylabs uses reliable test countries and pass threshold', () => {
        const oxylabs = getProxyProviderById('oxylabs');
        assert.deepEqual(oxylabs.testCountries, ['us', 'gb', 'de', 'fr', 'nl']);
        assert.equal(getProviderTestCheckUrl('oxylabs'), 'https://ipinfo.io/json');
        assert.equal(getProviderTestMinPasses('oxylabs'), 2);
        const plan = planProviderAccountTests('oxylabs', 3);
        assert.equal(plan.length, 3);
        assert.ok(plan.every(p => oxylabs.testCountries.includes(p.code)));
    });

    it('getProfileProviderMeta reads saved vars', () => {
        const meta = getProfileProviderMeta({
            __connectionMode: 'provider',
            __provider: 'oxylabs',
            __country: 'gb',
            __sessionMode: 'rotating',
        });
        assert.equal(meta.providerName, 'Oxylabs');
        assert.equal(meta.countryName, 'United Kingdom');
    });

    it('filterUserTemplateVars strips reserved keys', () => {
        const filtered = filterUserTemplateVars({
            __provider: 'decodo',
            __opt_ipv4: 'true',
            COUNTRY: 'ru',
        });
        assert.deepEqual(filtered, { COUNTRY: 'ru' });
        assert.ok(isReservedProviderVar('__provider'));
        assert.ok(isReservedProviderVar('__opt_gateway'));
    });

    it('nodemaven sticky template matches username parameter format', () => {
        const tpl = buildProviderTemplate('nodemaven', {
            username: 'JacekG404_gmail_com',
            password: 'pass',
            countryCode: 'ru',
            sessionMode: 'sticky',
            durationMin: 30,
            options: {
                gateway: 'auto',
                protocol: 'http',
                filter: 'none',
                ipv4: 'true',
            },
        });
        assert.match(tpl, /^http:\/\//);
        assert.match(tpl, /JacekG404_gmail_com-country-ru/);
        assert.match(tpl, /-ipv4-true/);
        assert.match(tpl, /-sid-\{SID\}/);
        assert.match(tpl, /-ttl-30m/);
        assert.match(tpl, /@gate\.nodemaven\.com:8080$/);
    });

    it('nodemaven rotating template omits sid and ttl', () => {
        const tpl = buildProviderTemplate('nodemaven', {
            username: 'user',
            password: 'pass',
            countryCode: 'us',
            sessionMode: 'rotating',
            options: { filter: 'medium', protocol: 'http' },
        });
        assert.doesNotMatch(tpl, /-sid-/);
        assert.doesNotMatch(tpl, /-ttl-/);
        assert.match(tpl, /-filter-medium/);
    });

    it('buildProviderVariables stores provider options', () => {
        const vars = buildProviderVariables('nodemaven', {
            countryCode: 'ru',
            sessionMode: 'sticky',
            durationMin: 30,
            options: { ipv4: 'true', gateway: 'ru', filter: 'none' },
        });
        assert.equal(vars.__opt_ipv4, 'true');
        assert.equal(vars.__opt_gateway, 'ru');
        assert.equal(vars.__opt_filter, 'none');
    });
});
