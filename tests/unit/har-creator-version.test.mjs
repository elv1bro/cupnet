import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../../db.js');
const { buildHarCreator, exportHar } = require('../../har-exporter.js');

describe('HAR creator version', () => {
    afterEach(() => vi.restoreAllMocks());

    it('buildHarCreator stamps the supplied version verbatim', () => {
        const c = buildHarCreator('9.9.9', 'note');
        expect(c.name).toBe('CupNet');
        expect(c.version).toBe('9.9.9');
        expect(c.comment).toBe('note');
    });

    it('buildHarCreator falls back to "unknown" when no version given', () => {
        expect(buildHarCreator(undefined, '').version).toBe('unknown');
        expect(buildHarCreator('', '').version).toBe('unknown');
    });

    it('exportHar uses the passed appVersion, not a hard-coded constant', () => {
        vi.spyOn(db, 'countRequests').mockReturnValue(0);
        const har = exportHar(null, { appVersion: '42.1.7' });
        expect(har.log.creator.name).toBe('CupNet');
        expect(har.log.creator.version).toBe('42.1.7');
        // Regression guard: the old literal must be gone.
        expect(har.log.creator.version).not.toBe('2.0');
    });

    it('exportHar does not forward appVersion into the DB filters', () => {
        const spy = vi.spyOn(db, 'countRequests').mockReturnValue(0);
        exportHar(null, { appVersion: '42.1.7' });
        const passedFilters = spy.mock.calls[0]?.[0] || {};
        expect(passedFilters).not.toHaveProperty('appVersion');
    });
});
