import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    getNoteDomainFromUrl,
    noteMatchesUrlMatch,
    getNoteIndexDomainFromMatch,
    matchGlobPattern,
} = require('../../note-domain-utils.js');

describe('note-domain-utils', () => {
    describe('getNoteDomainFromUrl', () => {
        it('returns empty for invalid or empty input', () => {
            expect(getNoteDomainFromUrl('')).toBe('');
            expect(getNoteDomainFromUrl(null)).toBe('');
            expect(getNoteDomainFromUrl('not a url')).toBe('');
        });

        it('extracts eTLD+1 for normal hostnames', () => {
            expect(getNoteDomainFromUrl('https://sub.test.example.com/path')).toBe('example.com');
            expect(getNoteDomainFromUrl('test.example.com')).toBe('example.com');
        });

        it('returns localhost and IPv4 as-is', () => {
            expect(getNoteDomainFromUrl('http://localhost:3000/')).toBe('localhost');
            expect(getNoteDomainFromUrl('http://192.168.1.1/')).toBe('192.168.1.1');
        });
    });

    describe('matchGlobPattern', () => {
        it('matches <all_urls> and *', () => {
            expect(matchGlobPattern('<all_urls>', 'https://x.com')).toBe(true);
            expect(matchGlobPattern('*', 'anything')).toBe(true);
        });

        it('supports * wildcards on full URL', () => {
            expect(matchGlobPattern('https://*.example.com/*', 'https://a.example.com/foo')).toBe(true);
            expect(matchGlobPattern('https://*.example.com/*', 'https://other.net/')).toBe(false);
        });

        it('escapes regex metacharacters in pattern', () => {
            expect(matchGlobPattern('https://x.com/path', 'https://x.com/path')).toBe(true);
        });
    });

    describe('noteMatchesUrlMatch', () => {
        it('returns false for empty pattern or page', () => {
            expect(noteMatchesUrlMatch('', 'https://a.com')).toBe(false);
            expect(noteMatchesUrlMatch('a.com', '')).toBe(false);
        });

        it('matches exact domain and subdomains', () => {
            expect(noteMatchesUrlMatch('example.com', 'https://www.example.com/')).toBe(true);
            expect(noteMatchesUrlMatch('example.com', 'https://example.com/')).toBe(true);
            expect(noteMatchesUrlMatch('example.com', 'https://other.com/')).toBe(false);
        });

        it('uses glob when pattern contains * or scheme', () => {
            expect(noteMatchesUrlMatch('https://*.example.com/*', 'https://api.example.com/v1')).toBe(true);
        });
    });

    describe('getNoteIndexDomainFromMatch', () => {
        it('returns empty for blank match', () => {
            expect(getNoteIndexDomainFromMatch('')).toBe('');
        });

        it('uses getNoteDomainFromUrl for http(s) patterns', () => {
            expect(getNoteIndexDomainFromMatch('https://sub.foo.bar/path')).toBe('foo.bar');
        });

        it('extracts domain-like token without scheme', () => {
            expect(getNoteIndexDomainFromMatch('*.google.com')).toBe('google.com');
        });
    });
});
