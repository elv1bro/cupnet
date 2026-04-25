import { describe, it, expect } from 'vitest';
import { buildConsoleEntryFromLine, inferSourceModule, inferLevel } from '../../main-process/services/console-capture.js';

describe('console-capture', () => {
    it('buildConsoleEntryFromLine classifies MITM', () => {
        const e = buildConsoleEntryFromLine('[mitm] TCP connect', 'stderr');
        expect(e.source).toBe('mitm');
        expect(e.stream).toBe('stderr');
        expect(e.text).toBe('[mitm] TCP connect');
    });

    it('buildConsoleEntryFromLine classifies DNS under MITM', () => {
        const e = buildConsoleEntryFromLine('[mitm] dns lookup example.com', 'stdout');
        expect(e.source).toBe('dns');
    });

    it('inferSourceModule detects worker/ffi', () => {
        expect(inferSourceModule('[worker-dbg] x').source).toBe('worker');
        expect(inferSourceModule('abc [ffi-dbg] y').source).toBe('ffi');
    });

    it('inferLevel marks stderr errors', () => {
        expect(inferLevel('something failed', 'stderr')).toBe('error');
        expect(inferLevel('ok', 'stdout')).toBe('info');
    });
});
