import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { safeRegexTest } = require('../../regex-safe.js');

describe('regex-safe', () => {
    it('matches simple pattern', () => {
        expect(safeRegexTest('foo', 'foobar')).toBe(true);
    });

    it('returns false for invalid pattern', () => {
        expect(safeRegexTest('(', 'x')).toBe(false);
    });

    it('handles patterns with special regex characters when valid', () => {
        expect(safeRegexTest('a\\[b\\]', 'a[b]')).toBe(true);
        expect(safeRegexTest('literal\\(', 'literal(')).toBe(true);
    });

    it('empty pattern matches (RegExp edge)', () => {
        expect(safeRegexTest('', '')).toBe(true);
        expect(safeRegexTest('', 'foo')).toBe(true);
    });

    it('is case-sensitive by default; bracket pattern can match loosely', () => {
        expect(safeRegexTest('foo', 'FOO')).toBe(false);
        expect(safeRegexTest('[Ff][Oo][Oo]', 'fOo')).toBe(true);
    });

    it('returns false for oversized pattern or haystack', () => {
        expect(safeRegexTest('a'.repeat(600), 'a')).toBe(false);
        expect(safeRegexTest('x', 'y'.repeat(200_001))).toBe(false);
    });

});
