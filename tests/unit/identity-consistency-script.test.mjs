'use strict';

/**
 * Unit test for the main-world identity-consistency patch (identity-consistency-script.js).
 * Builds the script for each identity shape and evals it in a vm context against a minimal fake
 * `window`, then probes the result INSIDE the same context (a browser is a single realm, so the
 * closure `Function.prototype.toString` shim must be observed from that realm, not from Node's).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildConsistencyScript, osFromNavigatorPlatform, WEBGL_BY_OS } = require('../../main-process/services/identity-consistency-script.js');

/** Fresh single-realm sandbox: window + WebGL prototypes reporting a host (Apple) GPU. */
function makeContext() {
    const src = `
        globalThis.window = globalThis;
        function WebGLRenderingContext() {}
        WebGLRenderingContext.prototype.getParameter = function getParameter(p) {
            if (p === 37445) return 'Google Inc. (Apple)';
            if (p === 37446) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';
            if (p === 7936) return 'WebKit';
            return null;
        };
        function WebGL2RenderingContext() {}
        WebGL2RenderingContext.prototype.getParameter = WebGLRenderingContext.prototype.getParameter;
        function Navigator() {}
        Object.defineProperty(Navigator.prototype, 'userAgentData', { value: { brands: [] }, configurable: true });
        globalThis.WebGLRenderingContext = WebGLRenderingContext;
        globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
        globalThis.Navigator = Navigator;
        globalThis.chrome = {};
        globalThis.performance = { now: function () { return 123.4; } };
    `;
    const ctx = vm.createContext({});
    vm.runInContext(src, ctx);
    return ctx;
}

function runAndProbe(script, probeExpr) {
    const ctx = makeContext();
    vm.runInContext(script, ctx);
    return vm.runInContext(probeExpr, ctx);
}

describe('identity-consistency-script: osFromNavigatorPlatform', () => {
    it('maps navigator.platform to an OS family', () => {
        expect(osFromNavigatorPlatform('Win32')).toBe('windows');
        expect(osFromNavigatorPlatform('MacIntel')).toBe('macos');
        expect(osFromNavigatorPlatform('Linux x86_64')).toBe('linux');
        expect(osFromNavigatorPlatform('Linux armv8l')).toBe('android');
        expect(osFromNavigatorPlatform('iPhone')).toBe('ios');
        expect(osFromNavigatorPlatform('')).toBeNull();
    });
});

describe('identity-consistency-script: Chromium identity', () => {
    it('fills window.chrome with app/csi/loadTimes/runtime and native-looking functions', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'MacIntel', hostNodePlatform: 'darwin' });
        expect(script).toBeTruthy();
        const r = runAndProbe(script, `JSON.stringify({
            keys: Object.keys(window.chrome).sort(),
            loadTimesType: typeof window.chrome.loadTimes,
            csiType: typeof window.chrome.csi,
            winEnum: window.chrome.runtime.PlatformOs.WIN,
            sendMsgType: typeof window.chrome.runtime.sendMessage,
            isInstalled: window.chrome.app.isInstalled,
            loadTimesStr: window.chrome.loadTimes.toString(),
            connectStr: window.chrome.runtime.connect.toString(),
            csiStrViaProto: Function.prototype.toString.call(window.chrome.csi),
            connInfo: window.chrome.loadTimes().connectionInfo,
            spdy: window.chrome.loadTimes().wasFetchedViaSpdy,
        })`);
        const o = JSON.parse(r);
        expect(o.keys).toEqual(['app', 'csi', 'loadTimes', 'runtime']);
        expect(o.loadTimesType).toBe('function');
        expect(o.csiType).toBe('function');
        expect(o.winEnum).toBe('win');
        expect(o.sendMsgType).toBe('function');
        expect(o.isInstalled).toBe(false);
        expect(o.loadTimesStr).toBe('function loadTimes() { [native code] }');
        expect(o.connectStr).toBe('function connect() { [native code] }');
        expect(o.csiStrViaProto).toBe('function csi() { [native code] }');
        expect(o.connInfo).toBe('h2');
        expect(o.spdy).toBe(true);
    });

    it('the toString shim itself reports native source (not detectable via toString.toString)', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'MacIntel', hostNodePlatform: 'darwin' });
        const r = runAndProbe(script, `Function.prototype.toString.toString()`);
        expect(r).toBe('function toString() { [native code] }');
    });

    it('macOS identity on a macOS host does NOT touch WebGL (genuine GPU already consistent)', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'MacIntel', hostNodePlatform: 'darwin' });
        const r = runAndProbe(script, `WebGLRenderingContext.prototype.getParameter(37446)`);
        expect(r).toContain('Apple M2');
    });

    it('Windows identity on a macOS host rewrites WebGL vendor/renderer to a Windows GPU', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'Win32', hostNodePlatform: 'darwin' });
        const r = JSON.parse(runAndProbe(script, `JSON.stringify({
            vendor: WebGLRenderingContext.prototype.getParameter(37445),
            renderer: WebGLRenderingContext.prototype.getParameter(37446),
            vendor2: WebGL2RenderingContext.prototype.getParameter(37446),
            passthrough: WebGLRenderingContext.prototype.getParameter(7936),
            gpStr: WebGLRenderingContext.prototype.getParameter.toString(),
            gpLen: WebGLRenderingContext.prototype.getParameter.length,
        })`));
        expect(r.vendor).toBe(WEBGL_BY_OS.windows.vendor);
        expect(r.renderer).toBe(WEBGL_BY_OS.windows.renderer);
        expect(r.renderer).not.toContain('Apple');
        expect(r.vendor2).toBe(WEBGL_BY_OS.windows.renderer);
        expect(r.passthrough).toBe('WebKit');
        expect(r.gpStr).toBe('function getParameter() { [native code] }');
        expect(r.gpLen).toBe(1);
    });

    it('engine mode fills window.chrome but never spoofs WebGL', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: null, hostNodePlatform: 'darwin', fillChrome: true });
        const r = JSON.parse(runAndProbe(script, `JSON.stringify({
            runtimeType: typeof window.chrome.runtime,
            renderer: WebGLRenderingContext.prototype.getParameter(37446),
        })`));
        expect(r.runtimeType).toBe('object');
        expect(r.renderer).toContain('Apple M2');
    });
});

describe('identity-consistency-script: non-Chromium identity', () => {
    it('removes window.chrome and navigator.userAgentData, does not add a chrome object', () => {
        const script = buildConsistencyScript({ chromium: false, navigatorPlatform: 'MacIntel', removeUserAgentData: true });
        expect(script).toBeTruthy();
        const r = JSON.parse(runAndProbe(script, `JSON.stringify({
            chromeType: typeof window.chrome,
            hasUad: ('userAgentData' in Navigator.prototype),
        })`));
        expect(r.chromeType).toBe('undefined');
        expect(r.hasUad).toBe(false);
    });
});

/** Richer sandbox with Navigator + Canvas + Audio prototypes, to exercise hardware + farble patches. */
function makeFarbleContext() {
    const src = `
        globalThis.window = globalThis;
        function Navigator() {}
        Object.defineProperty(Navigator.prototype, 'deviceMemory', { value: 16, configurable: true });
        Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { value: 24, configurable: true });
        globalThis.Navigator = Navigator;
        globalThis.navigator = Object.create(Navigator.prototype);
        // fixed base pixels so the original getImageData returns the same input every call
        var BASE = new Uint8ClampedArray(4000);
        for (var i = 0; i < BASE.length; i++) BASE[i] = (i * 7) % 256;
        globalThis.__BASE = BASE;
        function CanvasRenderingContext2D() {}
        CanvasRenderingContext2D.prototype.getImageData = function getImageData() { return { data: BASE.slice(), width: 10, height: 100 }; };
        CanvasRenderingContext2D.prototype.putImageData = function putImageData() {};
        globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
        function HTMLCanvasElement() { this.width = 10; this.height = 100; }
        HTMLCanvasElement.prototype.getContext = function getContext() { return Object.create(CanvasRenderingContext2D.prototype); };
        HTMLCanvasElement.prototype.toDataURL = function toDataURL() { return 'data:orig'; };
        HTMLCanvasElement.prototype.toBlob = function toBlob(cb) { cb && cb('blob'); };
        globalThis.HTMLCanvasElement = HTMLCanvasElement;
        globalThis.document = { createElement: function (t) { return new HTMLCanvasElement(); } };
        function AnalyserNode() {}
        AnalyserNode.prototype.getFloatFrequencyData = function getFloatFrequencyData(arr) { for (var i = 0; i < arr.length; i++) arr[i] = -50; };
        globalThis.AnalyserNode = AnalyserNode;
        function AudioBuffer() { this._buf = new Float32Array(2000); for (var i = 0; i < this._buf.length; i++) this._buf[i] = 0.5; }
        AudioBuffer.prototype.getChannelData = function getChannelData() { return this._buf; };
        globalThis.AudioBuffer = AudioBuffer;
        globalThis.performance = { now: function () { return 1; } };
    `;
    const ctx = vm.createContext({});
    vm.runInContext(src, ctx);
    return ctx;
}

describe('identity-consistency-script: hardware fields', () => {
    it('caps deviceMemory at 8 and pins hardwareConcurrency, with native getters', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'Win32', hostNodePlatform: 'darwin', hardware: true, deviceMemory: 8, hardwareConcurrency: 8 });
        const ctx = makeFarbleContext();
        vm.runInContext(script, ctx);
        const r = JSON.parse(vm.runInContext(`JSON.stringify({
            dm: navigator.deviceMemory,
            hc: navigator.hardwareConcurrency,
            dmGetterNative: Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory').get.toString(),
        })`, ctx));
        expect(r.dm).toBe(8);
        expect(r.hc).toBe(8);
        expect(r.dmGetterNative).toBe('function get deviceMemory() { [native code] }');
    });
});

describe('identity-consistency-script: farble (canvas + audio)', () => {
    it('canvas getImageData is perturbed but deterministic and stable across reads', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'Win32', hostNodePlatform: 'darwin', farble: true, seed: 123456 });
        const ctx = makeFarbleContext();
        vm.runInContext(script, ctx);
        const r = JSON.parse(vm.runInContext(`(() => {
            var ctx2d = Object.create(CanvasRenderingContext2D.prototype);
            var a = Array.from(ctx2d.getImageData().data);
            var b = Array.from(ctx2d.getImageData().data);
            var base = Array.from(__BASE);
            var diffAB = a.some((v, i) => v !== b[i]);
            var diffFromBase = a.some((v, i) => v !== base[i]);
            return JSON.stringify({ diffAB: diffAB, diffFromBase: diffFromBase, len: a.length });
        })()`, ctx));
        expect(r.len).toBe(4000);
        expect(r.diffAB).toBe(false);      // two reads identical → stable fingerprint
        expect(r.diffFromBase).toBe(true); // but not the host's raw pixels
    });

    it('a different identity seed yields a different canvas perturbation', () => {
        const mk = (seed) => {
            const ctx = makeFarbleContext();
            vm.runInContext(buildConsistencyScript({ chromium: true, navigatorPlatform: 'Win32', hostNodePlatform: 'darwin', farble: true, seed }), ctx);
            return vm.runInContext(`Array.from(Object.create(CanvasRenderingContext2D.prototype).getImageData().data).join(',')`, ctx);
        };
        expect(mk(111)).not.toBe(mk(222));
    });

    it('toDataURL / toBlob still return through the original (no throw) after farbling', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'Win32', hostNodePlatform: 'darwin', farble: true, seed: 7 });
        const ctx = makeFarbleContext();
        vm.runInContext(script, ctx);
        const r = JSON.parse(vm.runInContext(`(() => {
            var c = new HTMLCanvasElement();
            var url = c.toDataURL();
            var blob = null; c.toBlob((b) => { blob = b; });
            return JSON.stringify({ url: url, blob: blob });
        })()`, ctx));
        expect(r.url).toBe('data:orig');
        expect(r.blob).toBe('blob');
    });

    it('audio getChannelData perturbs each buffer once and stays stable across reads', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'Win32', hostNodePlatform: 'darwin', farble: true, seed: 99 });
        const ctx = makeFarbleContext();
        vm.runInContext(script, ctx);
        const r = JSON.parse(vm.runInContext(`(() => {
            var buf = new AudioBuffer();
            var a = Array.from(buf.getChannelData());
            var b = Array.from(buf.getChannelData());
            var stable = a.every((v, i) => v === b[i]);
            var changed = a.some((v) => v !== 0.5);
            return JSON.stringify({ stable: stable, changed: changed });
        })()`, ctx));
        expect(r.stable).toBe(true);
        expect(r.changed).toBe(true);
    });

    it('getFloatFrequencyData adds a deterministic per-index delta (stable across calls)', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'Win32', hostNodePlatform: 'darwin', farble: true, seed: 5 });
        const ctx = makeFarbleContext();
        vm.runInContext(script, ctx);
        const r = JSON.parse(vm.runInContext(`(() => {
            var an = Object.create(AnalyserNode.prototype);
            var a = new Float32Array(64); an.getFloatFrequencyData(a); a = Array.from(a);
            var b = new Float32Array(64); an.getFloatFrequencyData(b); b = Array.from(b);
            var stable = a.every((v, i) => v === b[i]);
            var changed = a.some((v) => v !== -50);
            return JSON.stringify({ stable: stable, changed: changed });
        })()`, ctx));
        expect(r.stable).toBe(true);
        expect(r.changed).toBe(true);
    });
});
