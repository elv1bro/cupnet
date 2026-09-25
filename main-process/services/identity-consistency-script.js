'use strict';

/**
 * Main-world identity-consistency patch (injected by preload-view.js BEFORE any page script).
 *
 * Electron's Chromium leaves several JS tells that contradict a spoofed browser identity — confirmed
 * against a real bot-protection challenge (Qrator on appointment.blsspainrussia.ru):
 *
 *   1. `window.chrome` is an empty object `{}`. Real Chrome exposes `app` / `csi` / `loadTimes` /
 *      `runtime`. An empty `window.chrome` on a page claiming to be Chrome is a classic Electron signal.
 *   2. WebGL `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` report the HOST GPU (e.g.
 *      "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 …)") even when the User-Agent claims another OS.
 *   3. `navigator.deviceMemory` reports the raw host RAM (e.g. 16); real Chrome caps it at 8. The host
 *      `hardwareConcurrency` also leaks the exact machine.
 *   4. Canvas / AudioContext read-back exposes the host's exact rendering hash (a stable, high-entropy
 *      device fingerprint). We apply a tiny per-identity deterministic perturbation ("farble") so the
 *      hash is stable for a given identity but is not the host's raw hash — the same approach Brave ships.
 *
 * For a Chromium-family identity we FILL `window.chrome`, cap `deviceMemory` / pin `hardwareConcurrency`,
 * rewrite WebGL strings when the claimed OS differs from the host, and (for a spoofing identity, i.e.
 * not engine mode) farble canvas + audio with a seed derived from the identity. For a non-Chromium
 * identity (Firefox / Safari / iOS) we REMOVE `window.chrome` and `navigator.userAgentData`.
 *
 * Farbling is deterministic and idempotent: the seed depends only on the identity, so a page reading a
 * canvas/audio twice gets identical values (a drifting fingerprint is itself a bot signal). Spoofed
 * functions report native source via a closure-scoped `Function.prototype.toString` shim (no marker
 * properties leak). The whole thing is one IIFE.
 *
 * Disabled entirely by CUPNET_DISABLE_FINGERPRINT=1 (identity-service short-circuits before calling
 * this). Unit test: tests/unit/identity-consistency-script.test.mjs.
 */

/** Canonical WebGL UNMASKED vendor/renderer per claimed OS (recent Chrome + ANGLE shapes). */
const WEBGL_BY_OS = {
    windows: {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    macos: {
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    },
    linux: {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)',
    },
    android: {
        vendor: 'Google Inc. (Qualcomm)',
        renderer: 'ANGLE (Qualcomm, Adreno (TM) 640, OpenGL ES 3.2)',
    },
};

/** navigator.platform → OS family used to pick a WebGL string / decide host mismatch. */
function osFromNavigatorPlatform(platform) {
    const s = String(platform || '');
    if (s === 'Win32' || /Windows/i.test(s)) return 'windows';
    if (s === 'MacIntel' || /Mac/i.test(s)) return 'macos';
    if (s === 'iPhone' || s === 'iPad' || /iPhone|iPad/i.test(s)) return 'ios';
    if (s === 'Linux armv8l' || /Android/i.test(s)) return 'android';
    if (/Linux/i.test(s)) return 'linux';
    return null;
}

/** process.platform → OS family (for the host-vs-claimed comparison). */
function osFromNodePlatform(nodePlatform) {
    if (nodePlatform === 'darwin') return 'macos';
    if (nodePlatform === 'win32') return 'windows';
    if (nodePlatform === 'linux') return 'linux';
    return null;
}

/** Stable 32-bit seed from a string (identity UA) — deterministic per identity, no randomness. */
function seedFromString(str) {
    let h = 2166136261 >>> 0; // FNV-1a
    const s = String(str || 'cupnet');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

// ── injected fragments ────────────────────────────────────────────────────────
// Shared prelude: a closure-scoped toString shim so our spoofed functions look native.
const PRELUDE = `
var __nativeSrc = new WeakMap();
var __origToString = Function.prototype.toString;
function __nativeFn(name, fn) {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e) {}
    __nativeSrc.set(fn, 'function ' + name + '() { [native code] }');
    return fn;
}
var __patchedToString = function toString() {
    if (__nativeSrc.has(this)) return __nativeSrc.get(this);
    return __origToString.call(this);
};
__nativeSrc.set(__patchedToString, 'function toString() { [native code] }');
try { Function.prototype.toString = __patchedToString; } catch (e) {}
`;

// window.chrome = { app, csi, loadTimes, runtime } — the shape a real Chrome page sees.
const CHROME_PATCH = `
try {
    var __c = window.chrome && typeof window.chrome === 'object' ? window.chrome : {};
    var __now = function () { return Date.now() / 1000; };
    var runtime = {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        connect: __nativeFn('connect', function connect() {}),
        sendMessage: __nativeFn('sendMessage', function sendMessage() {}),
        id: undefined,
    };
    var app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: __nativeFn('getDetails', function getDetails() { return null; }),
        getIsInstalled: __nativeFn('getIsInstalled', function getIsInstalled() { return false; }),
        installState: __nativeFn('installState', function installState() { return 'not_installed'; }),
        runningState: __nativeFn('runningState', function runningState() { return 'cannot_run'; }),
    };
    var loadTimes = __nativeFn('loadTimes', function loadTimes() {
        var t = __now();
        return {
            requestTime: t, startLoadTime: t, commitLoadTime: t,
            finishDocumentLoadTime: t, finishLoadTime: t, firstPaintTime: t,
            firstPaintAfterLoadTime: 0, navigationType: 'Other',
            wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false, connectionInfo: 'h2',
        };
    });
    var csi = __nativeFn('csi', function csi() {
        return { startE: Date.now(), onloadT: Date.now(), pageT: (window.performance && performance.now ? performance.now() : 0), tran: 15 };
    });
    if (!('app' in __c)) __c.app = app;
    if (!('runtime' in __c)) __c.runtime = runtime;
    if (typeof __c.loadTimes !== 'function') __c.loadTimes = loadTimes;
    if (typeof __c.csi !== 'function') __c.csi = csi;
    try { Object.defineProperty(window, 'chrome', { value: __c, configurable: true, enumerable: true, writable: true }); }
    catch (e) { window.chrome = __c; }
} catch (e) {}
`;

// Remove window.chrome (non-Chromium identities have no such object).
const REMOVE_CHROME_PATCH = `
try { delete window.chrome; } catch (e) {}
try { if (window.chrome) window.chrome = undefined; } catch (e) {}
`;

// Remove navigator.userAgentData (Firefox/Safari expose none; Chromium keeps it after a UA override).
const REMOVE_UAD_PATCH = `
try { delete Navigator.prototype.userAgentData; } catch (e) {}
`;

function webglPatch(vendor, renderer) {
    return `
try {
    var __VENDOR = 37445, __RENDERER = 37446;
    var __patchGl = function (proto) {
        if (!proto || typeof proto.getParameter !== 'function') return;
        var __orig = proto.getParameter;
        var __patched = __nativeFn('getParameter', function getParameter(p) {
            if (p === __VENDOR) return ${JSON.stringify(vendor)};
            if (p === __RENDERER) return ${JSON.stringify(renderer)};
            return __orig.apply(this, arguments);
        });
        try { Object.defineProperty(__patched, 'length', { value: 1, configurable: true }); } catch (e) {}
        proto.getParameter = __patched;
    };
    __patchGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    __patchGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
} catch (e) {}
`;
}

// navigator.deviceMemory (Chrome caps at 8) + hardwareConcurrency — stable per identity, not the host.
function hardwarePatch(deviceMemory, hardwareConcurrency) {
    return `
try {
    var __defHw = function (name, val) {
        try { Object.defineProperty(Navigator.prototype, name, { get: __nativeFn('get ' + name, function () { return val; }), configurable: true, enumerable: true }); } catch (e) {}
    };
    __defHw('deviceMemory', ${JSON.stringify(deviceMemory)});
    __defHw('hardwareConcurrency', ${JSON.stringify(hardwareConcurrency)});
} catch (e) {}
`;
}

// Deterministic per-identity perturbation of canvas + audio read-back (Brave-style "farbling").
function farblePatch(seed) {
    return `
try {
    var __seed = (${JSON.stringify(seed >>> 0)}) >>> 0;
    var __rng = function (s) { var x = (s >>> 0) || 1; return function () { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; };
    // ── Canvas 2D read-back ──
    if (window.CanvasRenderingContext2D && window.HTMLCanvasElement) {
        var __origGID = CanvasRenderingContext2D.prototype.getImageData;
        var __origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        var __origToBlob = HTMLCanvasElement.prototype.toBlob;
        var __farble = function (data) {
            try {
                var n = data.length; if (!n) return data;
                var r = __rng(__seed ^ n);
                var count = Math.max(8, (n / 4 * 0.005) | 0);
                for (var i = 0; i < count; i++) {
                    var px = (r() * (n / 4)) | 0; var off = px * 4 + ((r() * 3) | 0);
                    var v = data[off] + (r() < 0.5 ? -1 : 1);
                    data[off] = v < 0 ? 0 : v > 255 ? 255 : v;
                }
            } catch (e) {}
            return data;
        };
        CanvasRenderingContext2D.prototype.getImageData = __nativeFn('getImageData', function getImageData() {
            var img = __origGID.apply(this, arguments);
            try { __farble(img.data); } catch (e) {}
            return img;
        });
        var __farbledCopy = function (canvas) {
            var ctx = canvas.getContext && canvas.getContext('2d');
            if (!ctx || !canvas.width || !canvas.height) return null;
            var img = __origGID.call(ctx, 0, 0, canvas.width, canvas.height);
            __farble(img.data);
            var tmp = document.createElement('canvas'); tmp.width = canvas.width; tmp.height = canvas.height;
            tmp.getContext('2d').putImageData(img, 0, 0);
            return tmp;
        };
        HTMLCanvasElement.prototype.toDataURL = __nativeFn('toDataURL', function toDataURL() {
            try { var t = __farbledCopy(this); if (t) return __origToDataURL.apply(t, arguments); } catch (e) {}
            return __origToDataURL.apply(this, arguments);
        });
        if (__origToBlob) HTMLCanvasElement.prototype.toBlob = __nativeFn('toBlob', function toBlob() {
            try { var t = __farbledCopy(this); if (t) return __origToBlob.apply(t, arguments); } catch (e) {}
            return __origToBlob.apply(this, arguments);
        });
    }
    // ── AudioContext read-back ──
    if (window.AnalyserNode) {
        var __ofd = AnalyserNode.prototype.getFloatFrequencyData;
        if (__ofd) AnalyserNode.prototype.getFloatFrequencyData = __nativeFn('getFloatFrequencyData', function getFloatFrequencyData(arr) {
            __ofd.apply(this, arguments);
            try { for (var i = 0; i < arr.length; i++) { var h = (Math.imul((__seed ^ i) >>> 0, 2654435761) >>> 0) / 4294967296; arr[i] += (h - 0.5) * 1e-4; } } catch (e) {}
        });
    }
    if (window.AudioBuffer) {
        var __seen = new WeakSet();
        var __ogc = AudioBuffer.prototype.getChannelData;
        if (__ogc) AudioBuffer.prototype.getChannelData = __nativeFn('getChannelData', function getChannelData() {
            var d = __ogc.apply(this, arguments);
            try {
                if (!__seen.has(d)) { // perturb each buffer once so repeated reads stay identical
                    var r = __rng(__seed ^ d.length); var c = Math.max(1, (d.length * 0.002) | 0);
                    for (var i = 0; i < c; i++) { var idx = (r() * d.length) | 0; d[idx] += (r() - 0.5) * 1e-7; }
                    __seen.add(d);
                }
            } catch (e) {}
            return d;
        });
    }
} catch (e) {}
`;
}

/**
 * Build the main-world consistency script for one resolved identity, or null when nothing to patch.
 * @param {object} opts
 * @param {boolean} opts.chromium              - Chromium-family identity (fill window.chrome) vs not (remove it)
 * @param {string|null} opts.navigatorPlatform - identity navigator.platform (drives the WebGL OS)
 * @param {string|null} [opts.hostNodePlatform]- process.platform of the host (skip WebGL spoof when OS matches)
 * @param {boolean} [opts.fillChrome=true]     - populate window.chrome for Chromium identities
 * @param {boolean} [opts.removeUserAgentData=false] - delete navigator.userAgentData (non-Chromium)
 * @param {boolean} [opts.hardware=false]      - cap deviceMemory / pin hardwareConcurrency
 * @param {number}  [opts.deviceMemory=8]      - navigator.deviceMemory value (Chrome caps at 8)
 * @param {number}  [opts.hardwareConcurrency=8] - navigator.hardwareConcurrency value
 * @param {boolean} [opts.farble=false]        - deterministic canvas/audio perturbation
 * @param {number}  [opts.seed=0]              - farble seed (stable per identity)
 * @returns {string|null}
 */
function buildConsistencyScript(opts = {}) {
    const chromium = !!opts.chromium;
    const claimedOs = osFromNavigatorPlatform(opts.navigatorPlatform);
    const hostOs = osFromNodePlatform(opts.hostNodePlatform);
    const fillChrome = opts.fillChrome !== false;

    const body = [];
    let needsPrelude = false;

    if (chromium) {
        if (fillChrome) { body.push(CHROME_PATCH); needsPrelude = true; }
        const glMismatch = !!claimedOs && WEBGL_BY_OS[claimedOs] && (!hostOs || claimedOs !== hostOs);
        if (glMismatch) {
            const gl = WEBGL_BY_OS[claimedOs];
            body.push(webglPatch(gl.vendor, gl.renderer));
            needsPrelude = true;
        }
        if (opts.hardware) {
            const dm = Number.isFinite(opts.deviceMemory) ? opts.deviceMemory : 8;
            const hc = Number.isFinite(opts.hardwareConcurrency) ? opts.hardwareConcurrency : 8;
            body.push(hardwarePatch(dm, hc));
            needsPrelude = true;
        }
        if (opts.farble) {
            body.push(farblePatch((opts.seed || 0) >>> 0));
            needsPrelude = true;
        }
    } else {
        body.push(REMOVE_CHROME_PATCH);
        if (opts.removeUserAgentData) body.push(REMOVE_UAD_PATCH);
    }

    if (!body.length) return null;
    const parts = needsPrelude ? [PRELUDE, ...body] : body;
    return `(function () { 'use strict';\n${parts.join('\n')}\n})();`;
}

module.exports = {
    buildConsistencyScript,
    osFromNavigatorPlatform,
    osFromNodePlatform,
    seedFromString,
    WEBGL_BY_OS,
};
