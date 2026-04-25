import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CUPNET_KEYBOARD_SHORTCUTS } = require('../../keyboard-shortcuts.js');

describe('keyboard-shortcuts', () => {
    it('exports a non-empty canonical list with id and keys per entry', () => {
        expect(Array.isArray(CUPNET_KEYBOARD_SHORTCUTS)).toBe(true);
        expect(CUPNET_KEYBOARD_SHORTCUTS.length).toBeGreaterThan(0);
        for (const item of CUPNET_KEYBOARD_SHORTCUTS) {
            expect(typeof item.id).toBe('string');
            expect(item.id.length).toBeGreaterThan(0);
            expect(typeof item.keys).toBe('string');
            expect(item.keys.length).toBeGreaterThan(0);
            expect(typeof item.label).toBe('string');
        }
    });
});
