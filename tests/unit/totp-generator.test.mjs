import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('totp-generator', () => {
    let decodeBase32;
    let generate;
    let secondsRemaining;

    beforeAll(() => {
        require('../../totp-generator.js');
        const api = globalThis.cupnetTotp;
        expect(api).toBeDefined();
        decodeBase32 = api.decodeBase32;
        generate = api.generate;
        secondsRemaining = api.secondsRemaining;
    });

    describe('decodeBase32', () => {
        it('decodes RFC-style base32 (ignores non-alphabet chars)', () => {
            const out = decodeBase32('JBSWY3DP');
            expect(Array.from(out)).toEqual([72, 101, 108, 108, 111]);
        });

        it('returns empty array for empty or invalid input', () => {
            expect(decodeBase32('').length).toBe(0);
        });
    });

    describe('secondsRemaining', () => {
        it('returns period minus (epochSeconds % period)', () => {
            expect(secondsRemaining(30, 1000)).toBe(29);
            expect(secondsRemaining(30, 30000)).toBe(30);
        });

        it('uses 30s window when period is 0 (falsy coerces to default)', () => {
            expect(secondsRemaining(0, 5000)).toBe(25);
        });

        it('uses explicit small period', () => {
            expect(secondsRemaining(1, 5000)).toBe(1);
        });
    });

    describe('generate', () => {
        it('returns empty code when secret decodes to empty', async () => {
            const r = await generate('', { nowMs: 1 });
            expect(r.code).toBe('');
            expect(r.secondsRemaining).toBeGreaterThan(0);
        });

        it('is deterministic for fixed time and secret', async () => {
            const nowMs = 1234567890000;
            const r = await generate('JBSWY3DPEHPK3PXP', { nowMs, period: 30, digits: 6 });
            expect(r.code).toBe('742275');
            expect(r.secondsRemaining).toBe(30);
            const r2 = await generate('JBSWY3DPEHPK3PXP', { nowMs, period: 30, digits: 6 });
            expect(r2.code).toBe(r.code);
        });
    });
});
