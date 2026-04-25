import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { cnBlockExportText, formatHeaders, fmtBytes } = require('../../notes-cn-block-export.js');

describe('notes-cn-block-export', () => {
    describe('fmtBytes', () => {
        it('formats B, KB, MB', () => {
            expect(fmtBytes(null)).toBe('');
            expect(fmtBytes(100)).toBe('100 B');
            expect(fmtBytes(2048)).toBe('2.0 KB');
            expect(fmtBytes(2 * 1048576)).toBe('2.00 MB');
        });
    });

    describe('formatHeaders', () => {
        it('handles string, object, and array of pairs', () => {
            expect(formatHeaders('Raw: line')).toBe('Raw: line');
            expect(formatHeaders({ A: '1', B: '2' })).toBe('A: 1\nB: 2');
            expect(formatHeaders([{ name: 'X', value: 'Y' }, 'Plain'])).toBe('X: Y\nPlain');
        });

        it('returns empty for falsy', () => {
            expect(formatHeaders(null)).toBe('');
        });
    });

    describe('cnBlockExportText', () => {
        it('returns empty without kind', () => {
            expect(cnBlockExportText(null)).toBe('');
            expect(cnBlockExportText({})).toBe('');
        });

        it('exports request block with headers and bodies', () => {
            const text = cnBlockExportText({
                kind: 'request',
                method: 'GET',
                url: 'https://ex.com',
                status: 200,
                responseSize: 512,
                requestHeaders: { Host: 'ex.com' },
                responseHeaders: 'Content-Type: text/plain',
                requestBody: 'req',
                responseBody: 'resp',
            });
            expect(text).toContain('=REQ=====');
            expect(text).toContain('GET https://ex.com');
            expect(text).toContain('[Request Headers]');
            expect(text).toContain('512 B');
            expect(text).toContain('[Request Body]');
            expect(text).toContain('req');
            expect(text).toContain('resp');
        });

        it('falls back to JSON for unknown kind', () => {
            const t = cnBlockExportText({ kind: 'unknown', foo: 1 });
            expect(t).toContain('=BLOCK(unknown)===');
            expect(t).toContain('"foo": 1');
        });
    });
});
