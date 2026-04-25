import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
    buildAntiAntiDebugScript,
    ANTI_ANTI_DEBUG_SOURCE,
} = require('../../main-process/services/anti-anti-debug-script.js');

/**
 * Mimic a browser global where `window === globalThis` and `console`,
 * `setTimeout`, `Function`, `eval` are all properties of the same object.
 * That's the only environment shape the AAD IIFE was written against.
 */
function runShim() {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.location = { host: 'example.test', href: 'https://example.test/' };
    sandbox.innerWidth = 1280;
    sandbox.innerHeight = 720;
    sandbox.outerWidth = 1700;
    sandbox.outerHeight = 1200;
    /** Track every console call hitting the underlying impl so tests can assert filtering. */
    sandbox._consoleCalls = [];
    sandbox.console = {
        log:   (...a) => sandbox._consoleCalls.push(['log', a]),
        warn:  (...a) => sandbox._consoleCalls.push(['warn', a]),
        info:  (...a) => sandbox._consoleCalls.push(['info', a]),
        debug: (...a) => sandbox._consoleCalls.push(['debug', a]),
        clear: () => sandbox._consoleCalls.push(['clear', []]),
        table: (...a) => sandbox._consoleCalls.push(['table', a]),
    };
    vm.createContext(sandbox);
    /** vm gives us its own Function/Object/Date — provide setTimeout/setInterval/eval. */
    vm.runInContext(`
        var setTimeout  = (fn, t) => 0;
        var setInterval = (fn, t) => 0;
        /** Indirect eval via the per-context globalThis is enough for the test. */
        var __nativeEval = (0, eval);
        Object.defineProperty(this, 'eval', { value: __nativeEval, writable: true, configurable: true });
    `, sandbox);
    vm.runInContext(ANTI_ANTI_DEBUG_SOURCE, sandbox);
    return sandbox;
}

describe('anti-anti-debug-script', () => {
    it('exports a non-empty IIFE source string', () => {
        const src = buildAntiAntiDebugScript();
        expect(typeof src).toBe('string');
        expect(src.length).toBeGreaterThan(500);
        expect(src.startsWith('(function ()')).toBe(true);
        expect(src.trimEnd().endsWith('})();')).toBe(true);
    });

    it('source mentions all the expected patch sites', () => {
        const src = buildAntiAntiDebugScript();
        for (const probe of [
            'console.clear',
            'console.table',
            'console.log',
            'Function.prototype.constructor',
            'window.setTimeout',
            'window.setInterval',
            "'eval'",
            "'outerWidth'",
            "'outerHeight'",
            '__cupnetAntiAntiDebug',
        ]) {
            expect(src).toContain(probe);
        }
    });

    it('does not contain unescaped template-literal markers that would break the .js source', () => {
        /** The source ends up inside a JS string that's stringified by Node `require` via module.exports.
         *  Just sanity-check there are no stray BACKTICKS that would break the host file's template literal. */
        const src = buildAntiAntiDebugScript();
        expect(src.includes('`')).toBe(false);
    });

    it('script is valid syntax (vm parse) and idempotent across two runs', () => {
        const sandbox = runShim();
        expect(sandbox.__cupnetAntiAntiDebug).toBe(true);
        const clearAfterFirst = sandbox.console.clear;
        vm.runInContext(ANTI_ANTI_DEBUG_SOURCE, sandbox);
        expect(sandbox.console.clear).toBe(clearAfterFirst);
    });

    it('console.clear and console.table become silent no-ops', () => {
        const sandbox = runShim();
        const before = sandbox._consoleCalls.length;
        sandbox.console.clear();
        sandbox.console.clear();
        sandbox.console.table([{ a: 1 }]);
        const newEntries = sandbox._consoleCalls.slice(before);
        expect(newEntries.find((e) => e[0] === 'clear')).toBeUndefined();
        expect(newEntries.find((e) => e[0] === 'table')).toBeUndefined();
    });

    it('console.log redacts a getter-trap object', () => {
        const sandbox = runShim();
        sandbox._consoleCalls.length = 0;
        /** Build the trap via a vm-eval'd statement so its prototype lives in the sandbox realm
         *  (Object.getOwnPropertyDescriptors used inside the IIFE walks own props of the same realm). */
        vm.runInContext(`
            globalThis._trap = {};
            Object.defineProperty(globalThis._trap, 'id', { get: function () { throw new Error('detected'); } });
            console.log(globalThis._trap);
        `, sandbox);
        const lastLog = [...sandbox._consoleCalls].reverse().find((e) => e[0] === 'log');
        expect(lastLog).toBeDefined();
        expect(JSON.stringify(lastLog[1])).toContain('CupNet AAD');
    });

    it('Function.prototype.constructor wrapper toString reports as native, not our hook source', () => {
        const sandbox = runShim();
        const s = vm.runInContext('String(Function.prototype.constructor)', sandbox);
        expect(s).not.toContain('CupNet AAD');
        expect(s).not.toContain('debugCount');
        expect(s).not.toContain('_stripDebugger');
    });

    it('outerWidth and outerHeight mirror inner dimensions after the shim runs', () => {
        const sandbox = runShim();
        sandbox.innerWidth = 1024;
        sandbox.innerHeight = 768;
        expect(sandbox.outerWidth).toBe(1024);
        expect(sandbox.outerHeight).toBe(768);
    });

    it('eval strips the debugger statement from string source', () => {
        const sandbox = runShim();
        /** If the keyword survived AND a debugger were attached to the test process, this would
         *  freeze the run. The assertion proves the wrapper returned a value. */
        const result = vm.runInContext("eval('debugger; 42')", sandbox);
        expect(result).toBe(42);
    });

    it('setTimeout with string handler strips the debugger keyword', () => {
        /** Replace setTimeout in the sandbox BEFORE the IIFE captures Originals.setTimeout
         *  so the wrapper's underlying call lands in our spy. */
        const sandbox = {};
        sandbox.window = sandbox;
        sandbox.location = { host: 'example.test', href: 'https://example.test/' };
        sandbox.innerWidth = 1280;
        sandbox.innerHeight = 720;
        sandbox.outerWidth = 1700;
        sandbox.outerHeight = 1200;
        sandbox._consoleCalls = [];
        sandbox.console = {
            log: () => {}, warn: () => {}, info: () => {}, debug: () => {},
            clear: () => {}, table: () => {},
        };
        let capturedTimeout = null;
        let capturedInterval = null;
        sandbox.setTimeout = (handler) => { capturedTimeout = handler; return 0; };
        sandbox.setInterval = (handler) => { capturedInterval = handler; return 0; };
        vm.createContext(sandbox);
        vm.runInContext(`Object.defineProperty(this, 'eval', { value: (0, eval), writable: true, configurable: true });`, sandbox);
        vm.runInContext(ANTI_ANTI_DEBUG_SOURCE, sandbox);

        vm.runInContext("setTimeout('var x = 1; debugger; x++', 100)", sandbox);
        expect(typeof capturedTimeout).toBe('string');
        expect(capturedTimeout).not.toContain('debugger');
        expect(capturedTimeout).toContain('x++');

        vm.runInContext("setInterval('debugger; doStuff()', 50)", sandbox);
        expect(typeof capturedInterval).toBe('string');
        expect(capturedInterval).not.toContain('debugger');
        expect(capturedInterval).toContain('doStuff()');
    });
});
