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
    it('fills window.chrome with loadTimes/csi/app (NO runtime) and native-looking functions', () => {
        // Real Google Chrome exposes only { loadTimes, csi, app } on an ordinary web page; chrome.runtime
        // appears exclusively in extension contexts. Synthesizing runtime was an over-spoof detectable as
        // "chrome.runtime present on a plain site" → not Chrome. Key order mirrors real Chrome.
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'MacIntel', hostNodePlatform: 'darwin' });
        expect(script).toBeTruthy();
        const r = runAndProbe(script, `JSON.stringify({
            keys: Object.keys(window.chrome),
            hasRuntime: 'runtime' in window.chrome,
            loadTimesType: typeof window.chrome.loadTimes,
            csiType: typeof window.chrome.csi,
            isInstalled: window.chrome.app.isInstalled,
            loadTimesStr: window.chrome.loadTimes.toString(),
            csiStrViaProto: Function.prototype.toString.call(window.chrome.csi),
            ltName: window.chrome.loadTimes.name,
            ltOwn: Reflect.ownKeys(window.chrome.loadTimes).join(','),
            ltProtoCtor: window.chrome.loadTimes.prototype.constructor === window.chrome.loadTimes,
            ltNew: typeof new window.chrome.loadTimes(),
            appKeys: Object.keys(window.chrome.app).join(','),
            getDetailsStr: Function.prototype.toString.call(window.chrome.app.getDetails),
            getDetailsProto: 'prototype' in window.chrome.app.getDetails,
            getDetailsNew: (() => { try { new window.chrome.app.getDetails(); return 'constructed'; } catch (e) { return e.name; } })(),
            runningState: window.chrome.app.runningState(),
            installStateSync: window.chrome.app.installState(function () {}),
            connInfo: window.chrome.loadTimes().connectionInfo,
            spdy: window.chrome.loadTimes().wasFetchedViaSpdy,
            ltKeys: Object.keys(window.chrome.loadTimes()).join(','),
            csiKeys: Object.keys(window.chrome.csi()).join(','),
        })`);
        const o = JSON.parse(r);
        expect(o.keys).toEqual(['loadTimes', 'csi', 'app']);
        expect(o.hasRuntime).toBe(false);
        expect(o.loadTimesType).toBe('function');
        expect(o.csiType).toBe('function');
        expect(o.isInstalled).toBe(false);
        // Measured on Chrome 153: anonymous, own keys length,name,prototype, constructible, native source.
        expect(o.loadTimesStr).toBe('function () { [native code] }');
        expect(o.csiStrViaProto).toBe('function () { [native code] }');
        expect(o.ltName).toBe('');
        expect(o.ltOwn).toBe('length,name,prototype');
        expect(o.ltProtoCtor).toBe(true);
        expect(o.ltNew).toBe('object');
        // chrome.app: Chrome's own-key order; named non-constructible native methods.
        expect(o.appKeys).toBe('isInstalled,getDetails,getIsInstalled,installState,runningState,InstallState,RunningState');
        expect(o.getDetailsStr).toBe('function getDetails() { [native code] }');
        expect(o.getDetailsProto).toBe(false);
        expect(o.getDetailsNew).toBe('TypeError');
        expect(o.runningState).toBe('cannot_run');
        expect(o.installStateSync).toBe(undefined);
        // No navigation entry in the sandbox → no invented protocol.
        expect(o.connInfo).toBe('unknown');
        expect(o.spdy).toBe(false);
        expect(o.ltKeys).toBe('requestTime,startLoadTime,commitLoadTime,finishDocumentLoadTime,finishLoadTime,firstPaintTime,firstPaintAfterLoadTime,navigationType,wasFetchedViaSpdy,wasNpnNegotiated,npnNegotiatedProtocol,wasAlternateProtocolAvailable,connectionInfo');
        expect(o.csiKeys).toBe('startE,onloadT,pageT,tran');
    });

    it('loadTimes / csi values come from Navigation Timing (h2 over https), not constants', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: null, hostNodePlatform: 'darwin' });
        const ctx = makeContext();
        vm.runInContext(`
            globalThis.location = { protocol: 'https:' };
            globalThis.performance = {
                timeOrigin: 1790552646803.1, now: function () { return 3383; },
                getEntriesByType: function (t) {
                    if (t === 'navigation') return [{ type: 'reload', nextHopProtocol: 'h2', responseStart: 1933.4, domContentLoadedEventEnd: 1969.6, loadEventEnd: 1970.1 }];
                    if (t === 'paint') return [{ name: 'first-paint', startTime: 2020 }];
                    return [];
                },
            };`, ctx);
        vm.runInContext(script, ctx);
        const lt = JSON.parse(vm.runInContext('JSON.stringify(window.chrome.loadTimes())', ctx));
        const csi = JSON.parse(vm.runInContext('JSON.stringify(window.chrome.csi())', ctx));
        expect(lt.requestTime).toBe(1790552646.803);
        expect(lt.commitLoadTime).toBe(1790552648.736);
        expect(lt.finishDocumentLoadTime).toBe(1790552648.772);
        expect(lt.finishLoadTime).toBe(1790552648.773);
        expect(lt.firstPaintTime).toBe(1790552648.823);
        expect(lt.navigationType).toBe('Reload');
        expect(lt.connectionInfo).toBe('h2');
        expect(lt.npnNegotiatedProtocol).toBe('h2');
        expect(lt.wasFetchedViaSpdy).toBe(true);
        expect(lt.wasNpnNegotiated).toBe(true);
        expect(csi).toEqual({ startE: 1790552646803, onloadT: 1790552648772, pageT: 3383, tran: 16 });
    });

    it('a toString that throws does not leave an injected frame in the stack', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: null, hostNodePlatform: 'darwin' });
        const stack = runAndProbe(script, `(() => { try { Function.prototype.toString.call({}); } catch (e) { return String(e.stack); } })()`);
        expect(stack).toMatch(/requires that 'this' be a Function/);
        expect(stack).not.toMatch(/toString \(<anonymous>:\d+:\d+\)/);
    });

    it('fakes stay native-looking through a toString from ANOTHER realm running the same patch', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: null, hostNodePlatform: 'darwin' });
        const a = makeContext(); vm.runInContext(script, a);
        const b = makeContext(); vm.runInContext(script, b);
        b.foreignGetDetails = vm.runInContext('window.chrome.app.getDetails', a);
        expect(vm.runInContext('Function.prototype.toString.call(foreignGetDetails)', b)).toBe('function getDetails() { [native code] }');
    });

    it('does not patch colorDepth for an identity of the host OS', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'MacIntel', hostNodePlatform: 'darwin' });
        expect(script).not.toMatch(/colorDepth/);
        const other = buildConsistencyScript({ chromium: true, navigatorPlatform: 'Win32', hostNodePlatform: 'darwin' });
        expect(other).toMatch(/colorDepth/);
    });

    it('undecided Notification.permission and permissions.query look like Chrome prompt/default', async () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'MacIntel', hostNodePlatform: 'darwin' });
        const ctx = makeContext();
        vm.runInContext(`
            function Notification() {}
            Object.defineProperty(Notification, 'permission', { get: function () { return 'denied'; }, configurable: true, enumerable: true });
            function Permissions() {}
            Permissions.prototype.query = function (desc) { return Promise.resolve({ state: 'denied', name: desc && desc.name }); };
            globalThis.Notification = Notification;
            globalThis.Permissions = Permissions;
            globalThis.navigator = new Navigator();
        `, ctx);
        vm.runInContext(script, ctx);
        const undecided = vm.runInContext(`({
            notification: Notification.permission,
            share: typeof navigator.share,
            canShare: navigator.canShare({ title: 't' }),
            canShareEmpty: navigator.canShare(),
        })`, ctx);
        expect(undecided.notification).toBe('default');
        expect(undecided.share).toBe('function');
        expect(undecided.canShare).toBe(true);
        expect(undecided.canShareEmpty).toBe(false);
        const state = await vm.runInContext(`navigator.permissions ? null : Permissions.prototype.query.call(new Permissions(), { name: 'notifications' }).then(s => s.state)`, ctx);
        // Permissions is a constructor; query lives on the prototype. The page uses navigator.permissions.
        const q = await vm.runInContext(`Permissions.prototype.query.call(new Permissions(), { name: 'notifications' }).then(s => s.state)`, ctx);
        expect(q).toBe('prompt');
        const deniedScript = buildConsistencyScript({
            chromium: true, navigatorPlatform: 'MacIntel', hostNodePlatform: 'darwin',
            permissionDecisions: { notifications: false },
        });
        const ctx2 = makeContext();
        vm.runInContext(`
            function Notification() {}
            Object.defineProperty(Notification, 'permission', { get: function () { return 'denied'; }, configurable: true, enumerable: true });
            globalThis.Notification = Notification;
        `, ctx2);
        vm.runInContext(deniedScript, ctx2);
        expect(vm.runInContext('Notification.permission', ctx2)).toBe('denied');
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

    it('engine mode fills window.chrome (no runtime) but never spoofs WebGL', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: null, hostNodePlatform: 'darwin', fillChrome: true });
        const r = JSON.parse(runAndProbe(script, `JSON.stringify({
            runtimeType: typeof window.chrome.runtime,
            hasApp: 'app' in window.chrome,
            renderer: WebGLRenderingContext.prototype.getParameter(37446),
        })`));
        expect(r.runtimeType).toBe('undefined');
        expect(r.hasApp).toBe(true);
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

describe('identity-consistency-script: about:blank iframe', () => {
    it('stamps window.chrome.loadTimes into a script-created about:blank iframe', () => {
        const script = buildConsistencyScript({ chromium: true, navigatorPlatform: 'MacIntel', hostNodePlatform: 'darwin' });
        const child = vm.createContext({});
        vm.runInContext(`
            globalThis.window = globalThis;
            globalThis.chrome = {};
            globalThis.location = { href: 'about:blank', protocol: 'about:' };
            globalThis.performance = {
                now: function () { return 5; },
                timeOrigin: 10,
                getEntriesByType: function () { return []; },
            };
            function Navigator() {}
            globalThis.Navigator = Navigator;
            // vm hides built-ins from other realms; a same-origin iframe exposes contentWindow.Function.
            globalThis.Function = Function;
        `, child);

        const parentSrc = `
            globalThis.window = globalThis;
            globalThis.chrome = {};
            globalThis.location = { href: 'https://example.test/', protocol: 'https:' };
            globalThis.performance = {
                now: function () { return 5; },
                timeOrigin: 10,
                getEntriesByType: function () { return []; },
            };
            function Navigator() {}
            globalThis.Navigator = Navigator;
            function Node() {}
            Node.prototype.appendChild = function (node) { return node; };
            Node.prototype.insertBefore = function (node) { return node; };
            Node.prototype.replaceChild = function (node) { return node; };
            function Element() {}
            Element.prototype = Object.create(Node.prototype);
            Element.prototype.append = function () {};
            Element.prototype.prepend = function () {};
            Element.prototype.before = function () {};
            Element.prototype.after = function () {};
            Element.prototype.replaceChildren = function () {};
            Element.prototype.insertAdjacentElement = function () {};
            globalThis.Node = Node;
            globalThis.Element = Element;
            globalThis.document = { querySelectorAll: function () { return []; } };
            globalThis.__child = null;
        `;
        const parent = vm.createContext({});
        vm.runInContext(parentSrc, parent);
        parent.__child = child;
        vm.runInContext(script, parent);
        vm.runInContext(`
            var iframe = { nodeType: 1, tagName: 'IFRAME', contentWindow: __child };
            document.body = {};
            Node.prototype.appendChild.call(document.body, iframe);
            // appendChild wrapper is on the prototype; call it directly.
            Node.prototype.appendChild(iframe);
        `, parent);
        const stamped = vm.runInContext(`({
            type: typeof window.chrome.loadTimes,
            keys: Object.keys(window.chrome).join(','),
        })`, child);
        expect(stamped.type).toBe('function');
        expect(stamped.keys).toBe('loadTimes,csi,app');
    });
});
