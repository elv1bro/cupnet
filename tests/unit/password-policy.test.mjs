import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const {
    validatePassword,
    MIN_PASSWORD_LENGTH,
    COMMON_PASSWORDS_PATH,
    loadCommonPasswords,
    _resetCommonPasswordCacheForTests,
} = require('../../main-process/services/password-policy.js');

describe('password-policy', () => {
    it('requires minimum length', () => {
        const r = validatePassword('short');
        expect(r.ok).toBe(false);
        expect(r.error).toContain(String(MIN_PASSWORD_LENGTH));
    });

    it('rejects common passwords from fallback list', () => {
        const r = validatePassword('password1234');
        expect(r.ok).toBe(false);
    });

    it('loads top-10k blocklist file', () => {
        _resetCommonPasswordCacheForTests();
        expect(fs.existsSync(COMMON_PASSWORDS_PATH)).toBe(true);
        const set = loadCommonPasswords();
        expect(set.size).toBeGreaterThan(9000);
    });

    it('rejects a 12+ char password present in top-10k list', () => {
        _resetCommonPasswordCacheForTests();
        const lines = fs.readFileSync(COMMON_PASSWORDS_PATH, 'utf8').split(/\r?\n/);
        const sample = lines.find((l) => l.trim().length >= MIN_PASSWORD_LENGTH);
        expect(sample).toBeTruthy();
        const r = validatePassword(sample.trim());
        expect(r.ok).toBe(false);
    });

    it('accepts strong passphrase', () => {
        const r = validatePassword('unique-river-canyon-42!');
        expect(r.ok).toBe(true);
    });
});
