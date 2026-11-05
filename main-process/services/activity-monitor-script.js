'use strict';

/**
 * Activity Monitor capture shim — the leak-free replacement for `Runtime.enable`.
 *
 * Why this exists:
 *   The classic CDP bot-detection ("Runtime.enable leak") fires the moment the
 *   `Runtime` domain is enabled on a page: the browser starts serializing
 *   console arguments / object previews for the inspector, which is observable
 *   from page JS (getter traps, Error.stack traps). BrowserScan and friends flag
 *   that as CDP = Robot. Our per-tab Activity Monitor used to call
 *   `Runtime.enable` purely to receive `Runtime.consoleAPICalled` /
 *   `Runtime.exceptionThrown`, which lit that flag on every logged tab.
 *
 *   This module captures the same data WITHOUT enabling the `Runtime` domain.
 *   It must run in the page's MAIN world to hook `console.*` — but CDP's
 *   `Page.addScriptToEvaluateOnNewDocument` only ever runs in an ISOLATED world
 *   in Electron's `webContents.debugger`, which has its own `console`, so it
 *   cannot intercept the page's console. Instead this IIFE is injected into the
 *   main world at document start by the tab preload (`preload-view.js`, via
 *   `webFrame.executeJavaScript` — the same path anti-anti-debug uses, the only
 *   reliable main-world document-start injection in Electron).
 *
 *   To get events back to the main process the script dispatches a DOM
 *   `CustomEvent` with an unguessable per-document name onto `document`; the
 *   preload's ISOLATED-world listener (which has `ipcRenderer`) forwards each one
 *   to the main process over `activity-monitor-event`, where it is fed into the
 *   exact same Activity Monitor log path as before.
 *
 * Stealth notes:
 *   - Nothing is left on `window`: the transport is a DOM CustomEvent whose name
 *     is a random nonce kept only in this closure and in the preload closure, so
 *     the page cannot read it (to spoof events) or detect a telltale global.
 *   - Native `CustomEvent` and `Document.prototype.dispatchEvent` are captured up
 *     front, before any page script runs, so a page cannot intercept the forward.
 *   - Each console replacement is wrapped in a `Proxy` that forwards
 *     `toString`/`name`/`length` to the native original (same technique as
 *     `anti-anti-debug-script.js`), so `String(console.log)` still reports
 *     native code.
 *   - Arguments are described WITHOUT reading object properties, so a page's
 *     own getter-trap objects are never triggered by our serialization — we
 *     would otherwise reintroduce exactly the leak we are removing.
 *   - Idempotent per document via a non-enumerable `__cupnetActivityMonitor`
 *     flag, so a double injection is a no-op.
 */

/**
 * @param {string} eventName Unguessable DOM CustomEvent name the preload listens for.
 * @returns {string} JS source (IIFE) to inject into the page's main world.
 */
function buildActivityMonitorScript(eventName) {
    // eventName is produced by the main process from crypto bytes; keep it to a
    // safe charset so the template substitution stays a bare string literal body.
    const safeName = String(eventName || '').replace(/[^A-Za-z0-9_$-]/g, '');
    return ACTIVITY_MONITOR_SOURCE.replace(/__CUPNET_EVENT__/g, safeName);
}

const ACTIVITY_MONITOR_SOURCE = `(function () {
    if (window.__cupnetActivityMonitor) return;
    try {
        Object.defineProperty(window, '__cupnetActivityMonitor', {
            value: true, writable: false, configurable: false, enumerable: false,
        });
    } catch (_) { window.__cupnetActivityMonitor = true; }

    // Capture the native transport primitives before any page script can touch them.
    var EVENT_NAME = '__CUPNET_EVENT__';
    if (!EVENT_NAME) return;
    var CE = window.CustomEvent;
    var doc = window.document;
    var docDispatch = (window.Document && window.Document.prototype && window.Document.prototype.dispatchEvent) ||
        (doc && doc.dispatchEvent);
    if (typeof CE !== 'function' || typeof docDispatch !== 'function' || !doc) return;

    var nativeToString = Function.prototype.toString;
    var Originals = {
        log:   console.log,
        info:  console.info,
        warn:  console.warn,
        error: console.error,
        debug: console.debug,
        trace: console.trace,
    };

    // Forward a plain (structured-cloneable) event object to the isolated-world
    // preload listener via a DOM CustomEvent. No window globals, no page-visible name.
    function emit(obj) {
        try { docDispatch.call(doc, new CE(EVENT_NAME, { detail: obj })); } catch (_) {}
    }

    // Describe a value WITHOUT reading its own properties, so page getter-traps
    // are never triggered by our serialization.
    function describe(a) {
        var t = typeof a;
        if (a === null) return { type: 'null', description: 'null' };
        if (a === undefined) return { type: 'undefined', description: 'undefined' };
        if (t === 'string') return { type: 'string', description: a };
        if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') {
            var d; try { d = String(a); } catch (_) { d = '[' + t + ']'; }
            return { type: t, description: d };
        }
        if (t === 'function') {
            var fn = ''; try { fn = 'function ' + (a.name || '(anonymous)'); } catch (_) { fn = 'function'; }
            return { type: 'function', description: fn };
        }
        // object: use the type tag / constructor name only, never contents.
        var tag = '[object]';
        try { tag = Object.prototype.toString.call(a); } catch (_) {}
        var label = '';
        try { if (Array.isArray(a)) label = 'Array(' + a.length + ')'; } catch (_) {}
        if (!label) { try { if (a.constructor && a.constructor.name) label = a.constructor.name; } catch (_) {} }
        return { type: 'object', description: label || tag };
    }

    function argsToSummary(args) {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(args[i].description);
        var s = parts.join(' ');
        if (s.length > 500) s = s.slice(0, 497) + '...';
        return s;
    }

    // Pull the first real script frame (url:line) out of an Error().stack,
    // skipping our own injected (URL-less) frames.
    function firstFrame(stack) {
        if (typeof stack !== 'string') return { url: null, line: null };
        var re = /((?:https?|file|blob|chrome-extension):[^\\s()]+?):(\\d+):(\\d+)/g;
        var m;
        while ((m = re.exec(stack))) {
            return { url: m[1], line: parseInt(m[2], 10) };
        }
        return { url: null, line: null };
    }

    function wrapConsole(level, original) {
        var replacement = function () {
            var args = Array.prototype.slice.call(arguments);
            try {
                var described = args.map(describe);
                var frame = firstFrame((new Error()).stack);
                emit({
                    k: 'c',
                    level: level,
                    summary: argsToSummary(described),
                    args: described,
                    url: frame.url,
                    line: frame.line,
                });
            } catch (_) {}
            try { return original.apply(console, args); } catch (_) {}
        };
        try {
            return new Proxy(replacement, {
                get: function (target, prop) {
                    if (prop === 'apply' || prop === 'call' || prop === 'bind') return target[prop].bind(target);
                    if (prop === 'toString') return nativeToString.bind(original);
                    if (prop === 'name')     return original.name;
                    if (prop === 'length')   return original.length;
                    return original[prop];
                },
                apply: function (target, thisArg, a) { return target.apply(thisArg, a); },
            });
        } catch (_) {
            return replacement;
        }
    }

    try { console.log   = wrapConsole('log',   Originals.log); }   catch (_) {}
    try { console.info  = wrapConsole('info',  Originals.info); }  catch (_) {}
    try { console.warn  = wrapConsole('warning', Originals.warn); } catch (_) {}
    try { console.error = wrapConsole('error', Originals.error); } catch (_) {}
    try { console.debug = wrapConsole('debug', Originals.debug); } catch (_) {}
    try { console.trace = wrapConsole('trace', Originals.trace); } catch (_) {}

    function emitException(message, stack, url, line) {
        try {
            var frame = (url || line) ? { url: url || null, line: line || null } : firstFrame(stack);
            emit({
                k: 'e',
                summary: String(message || 'Exception').slice(0, 8000),
                stack: typeof stack === 'string' ? stack.slice(0, 8000) : null,
                url: frame.url,
                line: frame.line,
            });
        } catch (_) {}
    }

    try {
        window.addEventListener('error', function (e) {
            try {
                if (e && e.message !== undefined) {
                    var stk = (e.error && typeof e.error.stack === 'string') ? e.error.stack : null;
                    emitException(e.message, stk, e.filename || null, e.lineno || null);
                }
            } catch (_) {}
        }, true);
    } catch (_) {}

    try {
        window.addEventListener('unhandledrejection', function (e) {
            try {
                var r = e ? e.reason : null;
                var msg = 'Unhandled promise rejection';
                var stk = null;
                if (r && typeof r === 'object') {
                    try { if (r.message) msg = 'Unhandled rejection: ' + r.message; } catch (_) {}
                    try { if (typeof r.stack === 'string') stk = r.stack; } catch (_) {}
                } else if (r !== undefined && r !== null) {
                    try { msg = 'Unhandled rejection: ' + String(r); } catch (_) {}
                }
                emitException(msg, stk, null, null);
            } catch (_) {}
        });
    } catch (_) {}
})();`;

module.exports = { buildActivityMonitorScript };
