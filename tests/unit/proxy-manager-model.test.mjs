'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const model = require('../../proxy-manager-model.js');
const pp = require('../../proxy-providers.js');

describe('proxy-manager-model: editor modes', () => {
    it('normalizes the mode and defaults to simple', () => {
        expect(model.normalizeEditorMode('advanced')).toBe('advanced');
        expect(model.normalizeEditorMode('nope')).toBe('simple');
        expect(model.normalizeEditorMode(undefined)).toBe('simple');
    });
    it('editorModeForProfile: provider profiles stay simple, everything else needs advanced', () => {
        const simple = { variables: { __connectionMode: 'provider', __provider: 'nodemaven', __country: 'de' } };
        expect(model.editorModeForProfile(simple, 'simple')).toBe('simple');
        expect(model.editorModeForProfile(simple, 'advanced')).toBe('advanced');
        expect(model.editorModeForProfile({ variables: { __connectionMode: 'manual' } }, 'simple')).toBe('advanced');
        expect(model.editorModeForProfile({ variables: {} }, 'simple')).toBe('advanced');
        expect(model.editorModeForProfile({ variables: { ...simple.variables, __opt_protocol: 'socks5' } }, 'simple')).toBe('advanced');
        // Provider options equal to the provider defaults (what every saved NodeMaven profile carries) stay simple…
        const nmDefaults = pp.normalizeProviderOptions(pp.getProxyProviderById('nodemaven'), {});
        const defaultVars = { ...simple.variables };
        for (const [k, val] of Object.entries(nmDefaults)) if (val !== '' && val != null) defaultVars[`__opt_${k}`] = String(val);
        expect(model.editorModeForProfile({ variables: defaultVars }, 'simple', pp)).toBe('simple');
        // …but a changed option needs Advanced, and without the registry any option is treated as advanced.
        expect(model.editorModeForProfile({ variables: { ...defaultVars, __opt_protocol: 'socks5' } }, 'simple', pp)).toBe('advanced');
        expect(model.editorModeForProfile({ variables: defaultVars }, 'simple')).toBe('advanced');
        expect(model.editorModeForProfile({ variables: { ...simple.variables, FALLBACK_PROXIES: 'x' } }, 'simple')).toBe('advanced');
        expect(model.editorModeForProfile({ ...simple, identity_override: 1 }, 'simple')).toBe('advanced');
        expect(model.editorModeForProfile(null, 'simple')).toBe('simple');
    });
});

describe('proxy-manager-model: credentials', () => {
    it('extractCredentialsFromUrl handles encoding and template placeholders', () => {
        expect(model.extractCredentialsFromUrl('http://user-country-de:p%40ss@gate.nodemaven.com:8080')).toEqual({ username: 'user-country-de', password: 'p@ss' });
        expect(model.extractCredentialsFromUrl('http://u-{SID}:pw@host:{RAND:1-9}')).toEqual({ username: 'u-{SID}', password: 'pw' });
        expect(model.extractCredentialsFromUrl('http://host:8080')).toEqual({ username: '', password: '' });
        expect(model.extractCredentialsFromUrl('')).toEqual({ username: '', password: '' });
    });
    it('profileUsername prefers __username over the URL username', () => {
        expect(model.profileUsername({ variables: { __username: 'acct' } }, 'http://acct-country-de:x@h:1')).toBe('acct');
        expect(model.profileUsername({ variables: {} }, 'http://acct-country-de:x@h:1')).toBe('acct-country-de');
    });
    it('findCredentialSourceProfile picks the newest profile of that provider with a username', () => {
        const profiles = [
            { id: 1, created_at: '2026-01-01', variables: { __connectionMode: 'provider', __provider: 'nodemaven', __username: 'old' } },
            { id: 2, created_at: '2026-03-01', variables: { __connectionMode: 'provider', __provider: 'nodemaven', __username: 'new' } },
            { id: 3, created_at: '2026-04-01', variables: { __connectionMode: 'provider', __provider: 'decodo', __username: 'other' } },
            { id: 4, created_at: '2026-05-01', variables: { __connectionMode: 'manual' } },
        ];
        expect(model.findCredentialSourceProfile(profiles, 'nodemaven').id).toBe(2);
        expect(model.findCredentialSourceProfile(profiles, 'oxylabs')).toBeNull();
    });
});

describe('proxy-manager-model: simple profile payload', () => {
    it('validates the form', () => {
        expect(model.validateSimpleForm({})).toEqual(['Select a provider', 'Username is required', 'Password is required', 'Select a country']);
        expect(model.validateSimpleForm({ providerId: 'nodemaven', username: 'u', password: 'p', countryCode: 'de', sessionMode: 'sticky', durationMin: 0 })).toEqual(['Sticky duration must be 1–1440 minutes']);
        expect(model.validateSimpleForm({ providerId: 'nodemaven', username: 'u', password: 'p', countryCode: 'de' })).toEqual([]);
    });

    it('NodeMaven rotating → template with the password only in the URL, username kept in variables', () => {
        const { profile, errors } = model.buildSimpleProfile(pp, { providerId: 'nodemaven', username: 'nmuser', password: 'nm pass', countryCode: 'de', sessionMode: 'rotating' });
        expect(errors).toBeUndefined();
        // NodeMaven appends its default option suffixes (e.g. -filter-medium) after the country.
        expect(profile.template).toMatch(/^http:\/\/nmuser-country-de(-[a-z0-9-]+)?:nm%20pass@gate\.nodemaven\.com:8080$/);
        expect(profile.variables.__provider).toBe('nodemaven');
        expect(profile.variables.__username).toBe('nmuser');
        expect(profile.variables.__password).toBeUndefined();
        expect(profile.variables.__country).toBe('de');
        expect(profile.name).toBe('NodeMaven · Germany');
        expect(profile.identity_override).toBe(0);
        expect(profile.country).toBe('de');
    });

    it('sticky sessions carry {SID} and the duration; explicit names win', () => {
        const { profile } = model.buildSimpleProfile(pp, { providerId: 'decodo', username: 'dcu', password: 'pw', countryCode: 'us', sessionMode: 'sticky', durationMin: 15, name: 'My US sticky' });
        expect(profile.template).toContain('{SID}');
        expect(profile.template).toContain('sessionduration-15');
        expect(profile.variables.__sessionMode).toBe('sticky');
        expect(profile.variables.__durationMin).toBe('15');
        expect(profile.name).toBe('My US sticky');
    });

    it('works for every provider in the registry', () => {
        for (const prov of pp.getProxyProviders()) {
            const { profile, errors } = model.buildSimpleProfile(pp, { providerId: prov.id, username: 'u', password: 'p', countryCode: prov.countries[0].code });
            expect(errors, prov.id).toBeUndefined();
            expect(profile.template, prov.id).toMatch(/^[a-z0-9]+:\/\/.+@.+:\d+$/);
            expect(model.extractCredentialsFromUrl(profile.template).password).toBe('p');
        }
    });

    it('returns errors instead of a payload for an invalid form', () => {
        const r = model.buildSimpleProfile(pp, { providerId: 'nodemaven' });
        expect(r.profile).toBeUndefined();
        expect(r.errors.length).toBeGreaterThan(0);
    });

    it('describeIdentityForSimple', () => {
        expect(model.describeIdentityForSimple(null)).toBe('Browser ID: —');
        expect(model.describeIdentityForSimple({ effective: { description: 'Chrome 154 · Windows' }, source: 'global' })).toBe('Browser ID: Chrome 154 · Windows');
        expect(model.describeIdentityForSimple({ effective: { description: 'X' }, source: 'proxy-profile' })).toContain('overridden');
    });
});
