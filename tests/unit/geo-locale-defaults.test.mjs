'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { GEO_LOCALE_DEFAULTS, localeDefaultsForCountry, geoHintFromLookup, FALLBACK_LANGUAGE } = require('../../geo-locale-defaults.js');

describe('geo-locale-defaults', () => {
    it('every row has a plausible Accept-Language and an IANA-looking timezone', () => {
        expect(Object.keys(GEO_LOCALE_DEFAULTS).length).toBeGreaterThanOrEqual(60);
        for (const [cc, row] of Object.entries(GEO_LOCALE_DEFAULTS)) {
            expect(cc).toMatch(/^[a-z]{2}$/);
            expect(row.language).toMatch(/^[a-z]{2}(-[A-Z]{2})?(,[a-z]{2,3}(-[A-Z]{2})?;q=0\.\d)*$/);
            expect(row.timezone).toMatch(/^[A-Z][A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/);
            // the zone must be accepted by Intl
            expect(() => new Intl.DateTimeFormat('en', { timeZone: row.timezone })).not.toThrow();
        }
    });

    it('localeDefaultsForCountry is case-insensitive and falls back for unknown codes', () => {
        expect(localeDefaultsForCountry('DE')).toEqual({ language: 'de-DE,de;q=0.9,en;q=0.8', timezone: 'Europe/Berlin', known: true });
        expect(localeDefaultsForCountry('zz')).toEqual({ language: FALLBACK_LANGUAGE, timezone: null, known: false });
        expect(localeDefaultsForCountry('')).toEqual({ language: FALLBACK_LANGUAGE, timezone: null, known: false });
    });

    it('geoHintFromLookup prefers the lookup timezone and derives the language from the country', () => {
        expect(geoHintFromLookup({ country: 'JP', timezone: 'Asia/Tokyo' })).toEqual({ country: 'jp', timezone: 'Asia/Tokyo', language: 'ja-JP,ja;q=0.9,en;q=0.8' });
        // no timezone in the lookup → table fallback
        expect(geoHintFromLookup({ country: 'gb' })).toEqual({ country: 'gb', timezone: 'Europe/London', language: 'en-GB,en;q=0.9' });
        // unknown country keeps the lookup timezone, no language guess beyond the fallback
        expect(geoHintFromLookup({ country: 'zz', timezone: 'Etc/UTC' })).toEqual({ country: 'zz', timezone: 'Etc/UTC', language: FALLBACK_LANGUAGE });
        expect(geoHintFromLookup({ ip: '1.2.3.4' })).toBeNull();
        expect(geoHintFromLookup(null)).toBeNull();
    });
});
