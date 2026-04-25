'use strict';

/**
 * Anti-Anti-Debug compatibility shim — Layer 2.
 *
 * Returns a self-contained IIFE source string that we inject into the **page's
 * main world** at preload time (via `webFrame.executeJavaScript` from
 * `preload-view.js`) for hosts in `devtools-hostile-sites.js`. The script is a
 * port of https://github.com/Andrews54757/Anti-Anti-Debug (Unlicense) with
 * stealth Proxy wrappers and a few CupNet-specific additions (eval/setTimeout/
 * setInterval string-source stripping, outerWidth/outerHeight spoof).
 *
 * Patches installed:
 *   1. `console.clear` / `console.table` → silent no-op.
 *   2. `console.log` → strip args that look like getter-traps or toString-traps
 *      and the 50-object Performance Detector array.
 *   3. `Function.prototype.constructor` → strip the `debugger` keyword from JS
 *      sources passed to obfuscated `someFn.constructor("debugger; …")()`.
 *   4. `setTimeout`/`setInterval` with string handlers → strip `debugger`.
 *   5. `eval` → strip `debugger` from string source.
 *   6. `window.outerWidth` / `outerHeight` ≡ `innerWidth` / `innerHeight` so
 *      sites can't infer "DevTools panel is taking screen space".
 *
 * Stealth: every replacement is wrapped in a `Proxy` that forwards `toString`,
 * `name`, `length` to the original, so `String(console.clear)` etc. still
 * returns native source. Per-page idempotent via `__cupnetAntiAntiDebug` flag.
 *
 * What it cannot do (covered by the planned Layer 1 — MITM JS rewrite):
 *   - Static `function tick(){ debugger; setTimeout(tick, 100) }` baked into
 *     a non-eval-generated <script>. The `debugger` keyword still pauses if a
 *     CDP/DevTools client is attached. Layer 1 strips that from response body
 *     before the renderer sees it.
 */

/**
 * @returns {string} JS source to inject into the page's main world.
 */
function buildAntiAntiDebugScript() {
    return ANTI_ANTI_DEBUG_SOURCE;
}

const ANTI_ANTI_DEBUG_SOURCE = `(function () {
    if (window.__cupnetAntiAntiDebug) return;
    try {
        Object.defineProperty(window, '__cupnetAntiAntiDebug', {
            value: true, writable: false, configurable: false, enumerable: false,
        });
    } catch (_) { window.__cupnetAntiAntiDebug = true; }

    var Originals = {
        log: console.log,
        warn: console.warn,
        info: console.info,
        debug: console.debug,
        table: console.table,
        clear: console.clear,
        functionCtor: Function.prototype.constructor,
        toString: Function.prototype.toString,
        defineProperty: Object.defineProperty,
        setTimeout: window.setTimeout,
        setInterval: window.setInterval,
        eval: window.eval,
    };

    var cutoffs = {
        debugger: { count: 0, max: 50, last: 0, exceeded: false },
        clear:    { count: 0, max: 5,  last: 0, exceeded: false },
        table:    { count: 0, max: 5,  last: 0, exceeded: false },
        redacted: { count: 0, max: 5,  last: 0, exceeded: false },
    };
    function shouldLog(name) {
        var c = cutoffs[name]; if (!c) return true;
        var now = Date.now();
        if (now - c.last > 10000) { c.count = 0; c.exceeded = false; }
        c.last = now; c.count += 1;
        if (c.count > c.max) {
            if (!c.exceeded) {
                c.exceeded = true;
                try { Originals.warn.call(console, '[CupNet AAD] further "' + name + '" notices suppressed for 10s'); } catch (_) {}
            }
            return false;
        }
        return true;
    }

    function wrapFn(replacement, original) {
        try {
            return new Proxy(replacement, {
                get: function (target, prop) {
                    if (prop === 'apply' || prop === 'call' || prop === 'bind') return target[prop].bind(target);
                    if (prop === 'toString') return Originals.toString.bind(original);
                    if (prop === 'name')     return original.name;
                    if (prop === 'length')   return original.length;
                    return original[prop];
                },
                apply: function (target, thisArg, args) {
                    return target.apply(thisArg, args);
                },
            });
        } catch (_) {
            return replacement;
        }
    }

    try { console.clear = wrapFn(function () { shouldLog('clear'); }, Originals.clear); } catch (_) {}
    try { console.table = wrapFn(function () { shouldLog('table'); }, Originals.table); } catch (_) {}

    try {
        console.log = wrapFn(function () {
            var args = Array.prototype.slice.call(arguments);
            var redacted = 0;
            var safe = args.map(function (a) {
                if (typeof a === 'function') { redacted++; return '[CupNet AAD: function]'; }
                if (typeof a !== 'object' || a === null) return a;
                try {
                    var props = Object.getOwnPropertyDescriptors(a);
                    for (var name in props) {
                        if (props[name].get !== undefined) { redacted++; return '[CupNet AAD: getter-trap]'; }
                        if (name === 'toString')           { redacted++; return '[CupNet AAD: toString-trap]'; }
                    }
                } catch (_) {}
                if (Array.isArray(a) && a.length === 50 && typeof a[0] === 'object' && a[0] !== null) {
                    redacted++;
                    return '[CupNet AAD: perf-detector-array]';
                }
                return a;
            });
            if (redacted > 0 && redacted >= Math.max(args.length - 1, 1)) {
                if (!shouldLog('redacted')) return;
            }
            return Originals.log.apply(console, safe);
        }, Originals.log);
    } catch (_) {}

    function _stripDebugger(s) {
        if (typeof s !== 'string' || s.indexOf('debugger') === -1) return s;
        return s.replace(/\\bdebugger\\b/g, ' ');
    }

    try {
        var debugCount = 0;
        var fnCtorHook = function () {
            var args = Array.prototype.slice.call(arguments);
            var src = args[0];
            if (typeof src === 'string' && src.indexOf('debugger') !== -1) {
                debugCount++;
                if (debugCount > 200) {
                    if (shouldLog('debugger')) {
                        try { Originals.warn.call(console, '[CupNet AAD] excessive Function(debugger…) loop — throwing to break it'); } catch (_) {}
                    }
                    throw new Error('CupNet AAD: blocked anti-debug loop');
                }
                Originals.setTimeout.call(window, function () { if (debugCount > 0) debugCount--; }, 1);
                args[0] = _stripDebugger(src);
                if (shouldLog('debugger')) {
                    try { Originals.warn.call(console, '[CupNet AAD] stripped debugger from Function source'); } catch (_) {}
                }
            }
            return Originals.functionCtor.apply(this, args);
        };
        Function.prototype.constructor = wrapFn(fnCtorHook, Originals.functionCtor);
    } catch (_) {}

    try {
        window.setTimeout = wrapFn(function (handler, t) {
            var rest = Array.prototype.slice.call(arguments, 2);
            var h = typeof handler === 'string' ? _stripDebugger(handler) : handler;
            return Originals.setTimeout.apply(window, [h, t].concat(rest));
        }, Originals.setTimeout);
    } catch (_) {}
    try {
        window.setInterval = wrapFn(function (handler, t) {
            var rest = Array.prototype.slice.call(arguments, 2);
            var h = typeof handler === 'string' ? _stripDebugger(handler) : handler;
            return Originals.setInterval.apply(window, [h, t].concat(rest));
        }, Originals.setInterval);
    } catch (_) {}

    try {
        var evalHook = function (src) {
            if (typeof src === 'string' && src.indexOf('debugger') !== -1) {
                if (shouldLog('debugger')) {
                    try { Originals.warn.call(console, '[CupNet AAD] stripped debugger from eval source'); } catch (_) {}
                }
                src = _stripDebugger(src);
            }
            return Originals.eval.call(window, src);
        };
        Originals.defineProperty.call(Object, window, 'eval', {
            value: wrapFn(evalHook, Originals.eval),
            writable: true, configurable: true,
        });
    } catch (_) {}

    try {
        Originals.defineProperty.call(Object, window, 'outerWidth', {
            get: function () { return window.innerWidth; },
            configurable: true,
        });
        Originals.defineProperty.call(Object, window, 'outerHeight', {
            get: function () { return window.innerHeight; },
            configurable: true,
        });
    } catch (_) {}

    try { Originals.log.call(console, '[CupNet AAD] active for ' + (location && location.host)); } catch (_) {}
})();`;

module.exports = {
    buildAntiAntiDebugScript,
    ANTI_ANTI_DEBUG_SOURCE,
};
