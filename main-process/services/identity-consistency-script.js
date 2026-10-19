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
//  - The shim is a method (no `prototype`, not a constructor), like the native toString.
//  - Fakes are also recognised by their exact source text, so a toString taken from ANOTHER realm
//    (a same-origin iframe running its own copy of this patch) still reports native source.
//  - When the native toString throws (non-function receiver), the stack must not show an extra
//    injected frame: real Chrome has only the native `at Object.toString (<anonymous>)` there.
const PRELUDE = `
var __nativeSrc = new WeakMap();
var __nativeBySource = new Map();
var __origToString = Function.prototype.toString;
function __nativeFn(name, fn) {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e) {}
    var nat = 'function ' + name + '() { [native code] }';
    __nativeSrc.set(fn, nat);
    try { __nativeBySource.set(__origToString.call(fn), nat); } catch (e) {}
    return fn;
}
function __dropOwnFrame(err) {
    try {
        var st = err && err.stack;
        if (typeof st !== 'string') return;
        var lines = st.split('\\n');
        for (var i = 1; i < lines.length - 1; i++) {
            if (/\\(<anonymous>\\)$/.test(lines[i]) && /toString \\(<anonymous>:\\d+:\\d+\\)$/.test(lines[i + 1])) {
                lines.splice(i + 1, 1);
                err.stack = lines.join('\\n');
                return;
            }
        }
    } catch (e) {}
}
var __patchedToString = ({
    toString() {
        if (typeof this === 'function') {
            if (__nativeSrc.has(this)) return __nativeSrc.get(this);
            var src;
            try { src = __origToString.call(this); } catch (e) { __dropOwnFrame(e); throw e; }
            return __nativeBySource.has(src) ? __nativeBySource.get(src) : src;
        }
        // Non-function receiver: the native method throws; compensate the stack depth for our frame.
        var lim = Error.stackTraceLimit;
        var bumped = typeof lim === 'number' && isFinite(lim);
        if (bumped) Error.stackTraceLimit = lim + 1;
        try { return __origToString.call(this); } catch (e) { __dropOwnFrame(e); throw e; }
        finally { if (bumped) Error.stackTraceLimit = lim; }
    },
}).toString;
__nativeSrc.set(__patchedToString, 'function toString() { [native code] }');
try { Function.prototype.toString = __patchedToString; } catch (e) {}
`;

// window.chrome = { loadTimes, csi, app } — the exact shape a real Chrome web page sees (measured on
// Chrome 153): loadTimes/csi are anonymous (name ""), length 0, have a `prototype`, are constructible,
// and print "function () { [native code] }". A bound function gives exactly that toString natively
// (in every realm, no shim needed); we then set name "" and add the prototype. Values come from
// Navigation Timing so they agree with performance.* (a constant or "now" value is a tell).
// NOTE: real Chrome has NO chrome.runtime on an ordinary web page (extension contexts only).
const CHROME_PATCH = `
try {
    var __c = window.chrome && typeof window.chrome === 'object' ? window.chrome : {};
    var __perf = window.performance;
    var __nav = function () { try { return __perf.getEntriesByType('navigation')[0] || null; } catch (e) { return null; } };
    var __firstPaint = function () {
        try { var p = __perf.getEntriesByType('paint'); for (var i = 0; i < p.length; i++) if (p[i].name === 'first-paint') return p[i].startTime; } catch (e) {}
        return 0;
    };
    var __sec = function (ms) { return Math.floor(ms) / 1000; };
    var __t0 = function () {
        if (__perf && typeof __perf.timeOrigin === 'number') return __perf.timeOrigin;
        return Date.now() - (__perf && __perf.now ? __perf.now() : 0);
    };
    var __https = function () { try { return location.protocol === 'https:'; } catch (e) { return false; } };
    var __anonNative = function (impl) {
        var f = impl.bind(null);
        try { Object.defineProperty(f, 'name', { value: '', configurable: true }); } catch (e) {}
        var proto = {};
        try { Object.defineProperty(proto, 'constructor', { value: f, writable: true, enumerable: false, configurable: true }); } catch (e) {}
        try { Object.defineProperty(f, 'prototype', { value: proto, writable: true, enumerable: false, configurable: false }); } catch (e) {}
        return f;
    };
    var loadTimes = __anonNative(function () {
        var t0 = __t0(), n = __nav(), fp = __firstPaint();
        var proto = (n && n.nextHopProtocol) || '';
        var alpn = __https() && !!proto;
        var type = n && n.type;
        return {
            requestTime: __sec(t0), startLoadTime: __sec(t0),
            commitLoadTime: n && n.responseStart ? __sec(t0 + n.responseStart) : 0,
            finishDocumentLoadTime: n && n.domContentLoadedEventEnd ? __sec(t0 + n.domContentLoadedEventEnd) : 0,
            finishLoadTime: n && n.loadEventEnd ? __sec(t0 + n.loadEventEnd) : 0,
            firstPaintTime: fp ? __sec(t0 + fp) : 0,
            firstPaintAfterLoadTime: 0,
            navigationType: type === 'reload' ? 'Reload' : type === 'back_forward' ? 'BackForward' : 'Other',
            wasFetchedViaSpdy: /^h[23]/.test(proto), wasNpnNegotiated: alpn,
            npnNegotiatedProtocol: alpn ? proto : 'unknown',
            wasAlternateProtocolAvailable: false, connectionInfo: proto || 'unknown',
        };
    });
    var csi = __anonNative(function () {
        var t0 = __t0(), n = __nav(), type = n && n.type;
        return {
            startE: Math.floor(t0),
            onloadT: n && n.domContentLoadedEventEnd ? Math.floor(t0 + n.domContentLoadedEventEnd) : 0,
            pageT: __perf && __perf.now ? __perf.now() : 0,
            tran: type === 'reload' ? 16 : type === 'back_forward' ? 6 : 15,
        };
    });
    // chrome.app: named, non-constructible native methods; own-key order as in Chrome.
    var __appFns = {
        getDetails() { return null; },
        getIsInstalled() { return false; },
        installState(callback) { if (typeof callback === 'function' && typeof setTimeout === 'function') setTimeout(callback.bind(null, 'not_installed'), 0); },
        runningState() { return 'cannot_run'; },
    };
    var app = {};
    app.isInstalled = false;
    app.getDetails = __nativeFn('getDetails', __appFns.getDetails);
    app.getIsInstalled = __nativeFn('getIsInstalled', __appFns.getIsInstalled);
    app.installState = __nativeFn('installState', __appFns.installState);
    app.runningState = __nativeFn('runningState', __appFns.runningState);
    app.InstallState = { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' };
    app.RunningState = { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' };
    try { Object.defineProperty(app.installState, 'length', { value: 0, configurable: true }); } catch (e) {}
    // Insertion order mirrors real Chrome's own-key order on a web page: loadTimes, csi, app.
    if (typeof __c.loadTimes !== 'function') __c.loadTimes = loadTimes;
    if (typeof __c.csi !== 'function') __c.csi = csi;
    if (!('app' in __c)) __c.app = app;
    try { Object.defineProperty(window, 'chrome', { value: __c, configurable: true, enumerable: true, writable: true }); }
    catch (e) { window.chrome = __c; }
} catch (e) {}
`;

// Remove window.chrome (non-Chromium identities have no such object).
const REMOVE_CHROME_PATCH = `
try { delete window.chrome; } catch (e) {}
try { if (window.chrome) window.chrome = undefined; } catch (e) {}
`;

// Script-created about:blank iframes do not run the tab preload (the initial document is created
// synchronously, before a subframe preload). Real Chrome still has window.chrome.loadTimes there.
// Stamp that window from the parent as the node is inserted. The stamp is the chrome patch only;
// The stamp is loose statements (prelude + chrome), run in the same function as the installer
// so __nativeFn is in scope. The installer is re-applied in the child so a nested about:blank is stamped too.
function blankFrameHook(stampSource) {
    const src = JSON.stringify(String(stampSource));
    return `
try {
    var __stampSrc = ${src};
    function __installBlank(stampSrc) {
        function __stampWin(win) {
            try {
                if (!win || win === window) return;
                var href = '';
                try { href = String(win.location && win.location.href || ''); } catch (e) { return; }
                if (href !== 'about:blank' && href.indexOf('about:srcdoc') !== 0) return;
                if (win.chrome && typeof win.chrome.loadTimes === 'function') return;
                win.Function(stampSrc + '\\n' + __installBlank.toString() + '\\n__installBlank(' + JSON.stringify(stampSrc) + ');')();
            } catch (e) {}
        }
        function __stampNode(node) {
            try {
                if (!node || node.nodeType !== 1) return;
                if (String(node.tagName || '').toLowerCase() !== 'iframe') return;
                __stampWin(node.contentWindow);
            } catch (e) {}
        }
        function __stampArgs(args) {
            for (var i = 0; i < args.length; i++) __stampNode(args[i]);
        }
        function __wrap(proto, name, pick) {
            try {
                if (!proto || typeof proto[name] !== 'function') return;
                var orig = proto[name];
                var wrapped = __nativeFn(name, function () {
                    var ret = orig.apply(this, arguments);
                    try { pick(arguments); } catch (e) {}
                    return ret;
                });
                try { Object.defineProperty(wrapped, 'length', { value: orig.length, configurable: true }); } catch (e) {}
                proto[name] = wrapped;
            } catch (e) {}
        }
        var NodeP = typeof Node === 'function' ? Node.prototype : null;
        var ElP = typeof Element === 'function' ? Element.prototype : null;
        __wrap(NodeP, 'appendChild', function (args) { __stampNode(args[0]); });
        __wrap(NodeP, 'insertBefore', function (args) { __stampNode(args[0]); });
        __wrap(NodeP, 'replaceChild', function (args) { __stampNode(args[0]); });
        __wrap(ElP, 'append', __stampArgs);
        __wrap(ElP, 'prepend', __stampArgs);
        __wrap(ElP, 'before', __stampArgs);
        __wrap(ElP, 'after', __stampArgs);
        __wrap(ElP, 'replaceChildren', __stampArgs);
        __wrap(ElP, 'insertAdjacentElement', function (args) { __stampNode(args[1]); });
        try {
            if (typeof document !== 'undefined' && document.querySelectorAll) {
                var have = document.querySelectorAll('iframe');
                for (var i = 0; i < have.length; i++) __stampNode(have[i]);
            }
        } catch (e) {}
    }
    __installBlank(__stampSrc);
} catch (e) {}
`;
}


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

// navigator.languages / navigator.language: keep them consistent with the wire Accept-Language.
// Electron derives navigator.languages from the OS locale but Accept-Language from a different source,
// so they can disagree (e.g. languages=["ru","ru-BY","en-BY"] while the header is "ru,en-US,en") — a
// detectable inconsistency. When the identity carries an explicit language list we pin both to it. (qrator)
function languagesPatch(langs) {
    return `
try {
    var __langs = ${JSON.stringify(langs)};
    if (__langs && __langs.length) {
        Object.defineProperty(Navigator.prototype, 'languages', { get: __nativeFn('get languages', function () { return __langs.slice(); }), configurable: true, enumerable: true });
        Object.defineProperty(Navigator.prototype, 'language', { get: __nativeFn('get language', function () { return __langs[0]; }), configurable: true, enumerable: true });
    }
} catch (e) {}
`;
}

// screen.colorDepth / pixelDepth: real Chrome reports the display's actual depth — measured 2026-09-28:
// headed Chrome 153 on a wide-gamut Mac reports 30 (the earlier "24" came from HEADLESS Chrome). So the
// genuine value is kept whenever the claimed OS is the host OS; only a template claiming ANOTHER OS
// (e.g. Windows on a Mac, where Chrome reports 24) pins 24 — together with the WebGL rewrite.
const SCREEN_PATCH = `
try {
    var __defDepth = function (name) {
        try { Object.defineProperty(Screen.prototype, name, { get: __nativeFn('get ' + name, function () { return 24; }), configurable: true, enumerable: true }); } catch (e) {}
    };
    __defDepth('colorDepth');
    __defDepth('pixelDepth');
} catch (e) {}
`;

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
 * @param {string[]} [opts.languages]          - navigator.languages, kept consistent with Accept-Language
 * @param {object|null} [opts.permissionDecisions] - origin decisions; absent keys stay prompt/default
 * @returns {string|null}
 */
const SHARE_PATCH = `
try {
    if (typeof Navigator === 'function' && Navigator.prototype && typeof Navigator.prototype.share !== 'function') {
        Navigator.prototype.canShare = __nativeFn('canShare', function (data) {
            try {
                if (!data || typeof data !== 'object') return false;
                if (data.files && typeof data.files.length === 'number' && data.files.length) return false;
                var url = typeof data.url === 'string' ? data.url : '';
                var text = typeof data.text === 'string' ? data.text : '';
                var title = typeof data.title === 'string' ? data.title : '';
                if (!url && !text && !title) return false;
                if (url) {
                    var u = new URL(url, (typeof location !== 'undefined' && location.href) || undefined);
                    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
                }
                return true;
            } catch (e) { return false; }
        });
        Navigator.prototype.share = __nativeFn('share', function (data) {
            if (!Navigator.prototype.canShare.call(navigator, data || {})) {
                return Promise.reject(new TypeError('Invalid share data'));
            }
            return Promise.reject(new DOMException('Share canceled', 'AbortError'));
        });
    }
} catch (e) {}
`;

function permissionQueryPatch(decisions) {
    const decided = JSON.stringify(decisions && typeof decisions === 'object' ? decisions : {});
    return `
try {
    var __permDecided = ${decided};
    function __permUndecided(name) {
        return !Object.prototype.hasOwnProperty.call(__permDecided, name);
    }
    var __promptNames = {
        notifications: 1, geolocation: 1, midi: 1, camera: 1, microphone: 1,
        'clipboard-read': 1, 'idle-detection': 1, 'local-fonts': 1, 'window-management': 1
    };
    function __asPrompt(name, state) {
        if (state !== 'denied' || !__promptNames[name] || !__permUndecided(name)) return state;
        return 'prompt';
    }
    if (typeof Notification === 'function') {
        var __np = Object.getOwnPropertyDescriptor(Notification, 'permission');
        if (__np && typeof __np.get === 'function') {
            Object.defineProperty(Notification, 'permission', {
                configurable: true,
                enumerable: __np.enumerable,
                get: __nativeFn('get permission', function () {
                    var v = __np.get.call(Notification);
                    if (v === 'denied' && __permUndecided('notifications')) return 'default';
                    return v;
                }),
            });
        }
    }
    if (typeof Permissions === 'function' && Permissions.prototype && typeof Permissions.prototype.query === 'function') {
        var __origQuery = Permissions.prototype.query;
        Permissions.prototype.query = __nativeFn('query', function (desc) {
            var name = desc && desc.name;
            return Promise.resolve(__origQuery.apply(this, arguments)).then(function (status) {
                if (!status) return status;
                var next = __asPrompt(name, status.state);
                if (next === status.state) return status;
                return new Proxy(status, {
                    get: function (t, k) {
                        if (k === 'state') return next;
                        var v = t[k];
                        return typeof v === 'function' ? v.bind(t) : v;
                    },
                });
            });
        });
    }
} catch (e) {}
`;
}

function buildConsistencyScript(opts = {}) {
    const chromium = !!opts.chromium;
    const claimedOs = osFromNavigatorPlatform(opts.navigatorPlatform);
    const hostOs = osFromNodePlatform(opts.hostNodePlatform);
    const fillChrome = opts.fillChrome !== false;

    const body = [];
    let needsPrelude = false;

    if (chromium) {
        if (fillChrome) {
            body.push(CHROME_PATCH);
            body.push(SHARE_PATCH);
            body.push(permissionQueryPatch(opts.permissionDecisions));
            needsPrelude = true;
            // Blank iframes re-run the same chrome/share/permission statements (they skip the preload).
            const stamp = `'use strict';\n${PRELUDE}\n${CHROME_PATCH}\n${SHARE_PATCH}\n${permissionQueryPatch(opts.permissionDecisions)}`;
            body.push(blankFrameHook(stamp));
        }
        // Undecided permissions.query / Notification.permission are rewritten to Chrome's
        // prompt/default. The check handler still returns false until the user allows,
        // so nothing is granted silently (A-188). A recorded denial is left as denied.
        if (Array.isArray(opts.languages) && opts.languages.length) {
            body.push(languagesPatch(opts.languages)); needsPrelude = true;
        }
        const otherOs = !!claimedOs && (!hostOs || claimedOs !== hostOs);
        const glMismatch = otherOs && !!WEBGL_BY_OS[claimedOs];
        if (glMismatch) {
            const gl = WEBGL_BY_OS[claimedOs];
            body.push(webglPatch(gl.vendor, gl.renderer));
            needsPrelude = true;
        }
        if (otherOs) { body.push(SCREEN_PATCH); needsPrelude = true; }
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
