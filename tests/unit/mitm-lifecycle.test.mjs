'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createSingleFlight } = require('../../main-process/services/mitm-lifecycle.js');

describe('MITM single-flight (A-027)', () => {
    it('a second run joins the in-flight operation', async () => {
        const gate = createSingleFlight();
        let calls = 0;
        let release;
        const first = gate.run(() => {
            calls += 1;
            return new Promise((resolve) => { release = resolve; });
        });
        const second = gate.run(() => {
            calls += 1;
            return 'should-not-run';
        });
        expect(second).toBe(first);
        await Promise.resolve();
        expect(calls).toBe(1);
        expect(gate.inFlight()).toBe(first);
        release('proxy');
        await expect(first).resolves.toBe('proxy');
        await expect(second).resolves.toBe('proxy');
        await Promise.resolve();
        expect(gate.inFlight()).toBeNull();
        await expect(gate.run(() => 'next')).resolves.toBe('next');
        expect(calls).toBe(1);
    });

    it('a rejection frees the gate for the next run', async () => {
        const gate = createSingleFlight();
        await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        await Promise.resolve();
        await expect(gate.run(() => 'ok')).resolves.toBe('ok');
    });
});
