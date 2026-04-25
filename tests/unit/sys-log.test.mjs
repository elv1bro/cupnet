import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { sysLog, safeCatch, getEntries } = require('../../sys-log.js');

describe('sys-log', () => {
    it('sysLog records entries retrievable via getEntries', () => {
        const tag = `sys-log.unit.${Date.now()}`;
        sysLog('info', 'unit-test', tag, { k: 1 });
        const last = getEntries('info', 500).filter((e) => e.message === tag);
        expect(last.length).toBeGreaterThan(0);
        expect(last[last.length - 1].module).toBe('unit-test');
        expect(last[last.length - 1].data?.k).toBe(1);
    });

    it('safeCatch writes structured event with required fields', () => {
        const eventCode = `db.write.failed.${Date.now()}`;
        safeCatch(
            { module: 'tests', eventCode, context: { op: 'unit' } },
            new Error('boom'),
            'warn',
        );
        const hit = getEntries('warn', 500).find((e) => e.data?.eventCode === eventCode);
        expect(hit).toBeDefined();
        expect(hit.module).toBe('tests');
        expect(hit.message).toContain(eventCode);
        expect(hit.data.context.op).toBe('unit');
    });
});
