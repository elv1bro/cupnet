'use strict';
/**
 * CupNet mini page agent — the script injected into HTML documents when Settings → Page agent is on.
 *
 * It runs in the page before the page's own scripts (first <script> in <head>, CSP nonce via
 * html-inject.js) and talks only to `/__cupnet/*` on its own origin, which the MITM answers locally:
 *
 *   POST agent/hello   {doc, url, title, frame, referrer}        once, and again when the title/URL change
 *   POST console       {doc, items:[entry…]}                      batched console / error / CSP entries
 *   POST agent/poll    {doc, url, title, vis} → {next, cmds:[…]}  commands from the CupNet UI for this doc
 *   POST agent/result  {doc, id, ok, value|error|report}          answer to one command
 *
 * Commands: `eval` (DevTools-style console input), `analyze` (page analyzer report), `highlight`
 * (outline an element). Nothing is exposed on `window`; the page can still notice the agent (wrapped
 * console methods, the extra same-origin requests), so it is off by default.
 *
 * `pageAgentMain` is stringified into the page — it must stay self-contained (no closures over this
 * module). `serialize` and `collectReport` are exported for the unit tests.
 */

/* eslint-disable no-restricted-globals */
function pageAgentMain(cfg, hooks) {
    'use strict';
    const H = hooks || {};
    // Tests pass a fake window (hooks.window) to run the agent under Node.
    const W = H.window || (typeof window !== 'undefined' ? window : globalThis);
    const D = W.document;
    // The CSP nonce of our own <script> (html-inject.js) lets `eval` fall back to a nonce'd inline script.
    let NONCE = '';
    if (!H.test) {
        try {
            const me = D && D.currentScript;
            if (me) { NONCE = me.nonce || me.getAttribute('nonce') || ''; me.remove(); }
        } catch (_) { /* detached */ }
    }

    // Originals, taken before the page's own scripts can wrap them.
    const _fetch = typeof W.fetch === 'function' ? W.fetch.bind(W) : null;
    const _beacon = W.navigator && typeof W.navigator.sendBeacon === 'function' ? W.navigator.sendBeacon.bind(W.navigator) : null;
    const _Blob = W.Blob;
    const _setTimeout = W.setTimeout.bind(W);
    const _clearTimeout = W.clearTimeout.bind(W);
    const _stringify = JSON.stringify;
    const _parse = JSON.parse;
    const _now = Date.now;
    const _dateIso = Date.prototype.toISOString;
    const _toStr = Object.prototype.toString;
    const _keys = Object.keys;
    const _gopd = Object.getOwnPropertyDescriptor;
    const _getProto = Object.getPrototypeOf;
    const _fnToString = Function.prototype.toString;
    const _isArray = Array.isArray;
    const EP = cfg.ep || '/__cupnet/';
    const DOC = cfg.doc || (() => {
        try {
            const a = new Uint8Array(12);
            W.crypto.getRandomValues(a);
            return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
        } catch (_) { return `${_now().toString(16)}${Math.random().toString(16).slice(2, 14)}`; }
    })();
    let quiet = 0; // > 0 while evalViaScript runs: its syntax errors are not page errors
    let evalAt = -1e9; // last console-prompt eval: the CSP report it triggers is ours, not the page's
    let frame = 0;
    try { frame = W.top !== W ? 1 : 0; } catch (_) { frame = 1; }

    // ── serialization: a bounded, side-effect-free preview of any value ─────────────────────────
    const STR_MAX = 10000, PROPS_MAX = 60, ITEMS_MAX = 100, DEPTH_MAX = 3;
    const tagOf = (v) => { try { return _toStr.call(v).slice(8, -1); } catch (_) { return 'Object'; } };
    const ctorName = (v) => {
        try {
            const p = _getProto(v);
            const c = p && _gopd(p, 'constructor');
            const n = c && typeof c.value === 'function' ? c.value.name : '';
            return n || (p === null ? 'Object' : tagOf(v));
        } catch (_) { return tagOf(v); }
    };
    const cutStr = (s, b) => {
        const max = Math.max(32, Math.min(STR_MAX, b.n));
        b.n -= Math.min(s.length, max);
        return s.length > max ? { t: 's', v: s.slice(0, max), n: s.length } : s;
    };
    function nodeLabel(n) {
        try {
            if (n.nodeType === 1) {
                const tag = String(n.tagName || '').toLowerCase();
                const id = n.id ? `#${n.id}` : '';
                const cls = (n.getAttribute && n.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join('');
                return `<${tag}${id}${cls}>`;
            }
            if (n.nodeType === 3) return `#text "${String(n.nodeValue || '').slice(0, 80)}"`;
            if (n.nodeType === 9) return '#document';
            if (n.nodeType === 8) return '<!-- -->';
            return String(n.nodeName || 'node');
        } catch (_) { return 'node'; }
    }
    function serialize(v, depth, seen, b) {
        if (depth === undefined) { depth = 0; seen = []; b = { n: 16000 }; }
        b.n -= 8;
        const t = typeof v;
        if (v === null || t === 'boolean') return v;
        if (t === 'string') return cutStr(v, b);
        if (t === 'number') {
            if (Number.isNaN(v)) return { t: 'n', v: 'NaN' };
            if (!Number.isFinite(v)) return { t: 'n', v: v > 0 ? 'Infinity' : '-Infinity' };
            if (v === 0 && 1 / v < 0) return { t: 'n', v: '-0' };
            return v;
        }
        if (t === 'undefined') return { t: 'u' };
        if (t === 'bigint') return { t: 'big', v: `${v}` };
        if (t === 'symbol') { try { return { t: 'sym', v: v.toString() }; } catch (_) { return { t: 'sym', v: 'Symbol()' }; } }
        if (t === 'function') {
            let src = '';
            try { src = _fnToString.call(v); } catch (_) { /* revoked proxy */ }
            let name = '';
            try { name = String(v.name || ''); } catch (_) { /* getter threw */ }
            return { t: 'fn', name, v: src.length > 300 ? `${src.slice(0, 300)}…` : src };
        }
        if (seen.indexOf(v) >= 0) return { t: 'cyc' };
        const tag = tagOf(v);
        try {
            if (v === W) return { t: 'obj', cls: 'Window', n: 0, props: [] };
            if (tag === 'Error' || v instanceof Error) {
                let name = 'Error', msg = '', stack = '';
                try { name = String(v.name || 'Error'); msg = String(v.message || ''); stack = String(v.stack || ''); } catch (_) { /* odd error */ }
                return { t: 'err', name, msg: msg.slice(0, STR_MAX), stack: stack.slice(0, 4000) };
            }
            if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') {
                let html = '';
                try { if (v.nodeType === 1) html = String(v.outerHTML || '').slice(0, 300); } catch (_) { /* no outerHTML */ }
                return { t: 'node', v: nodeLabel(v), html };
            }
            if (tag === 'Date') { const n = v.getTime(); return { t: 'date', v: Number.isNaN(n) ? 'Invalid Date' : new Date(n).toISOString() }; }
            if (tag === 'RegExp') return { t: 're', v: String(v) };
            if (tag === 'Promise') return { t: 'obj', cls: 'Promise', n: 0, props: [] };
            if (depth >= DEPTH_MAX || b.n <= 0) {
                const n = _isArray(v) ? v.length : (tag === 'Map' || tag === 'Set') ? v.size : _keys(v).length;
                return { t: _isArray(v) ? 'arr' : 'obj', cls: ctorName(v), n, more: true };
            }
            seen.push(v);
            try {
                if (_isArray(v) || /^(Uint8|Int8|Uint16|Int16|Uint32|Int32|Float32|Float64|Uint8Clamped|BigInt64|BigUint64)Array$/.test(tag)) {
                    const n = v.length;
                    const items = [];
                    for (let i = 0; i < Math.min(n, ITEMS_MAX) && b.n > 0; i++) {
                        const d = _isArray(v) ? _gopd(v, i) : { value: v[i] };
                        items.push(!d ? { t: 'hole' } : d.get ? { t: 'get' } : serialize(d.value, depth + 1, seen, b));
                    }
                    return { t: 'arr', cls: _isArray(v) ? (ctorName(v) === 'Array' ? 'Array' : ctorName(v)) : tag, n, items, more: items.length < n };
                }
                if (tag === 'Map') {
                    const entries = [];
                    for (const [k, x] of v) { if (entries.length >= ITEMS_MAX || b.n <= 0) break; entries.push([serialize(k, depth + 1, seen, b), serialize(x, depth + 1, seen, b)]); }
                    return { t: 'map', n: v.size, entries, more: entries.length < v.size };
                }
                if (tag === 'Set') {
                    const items = [];
                    for (const x of v) { if (items.length >= ITEMS_MAX || b.n <= 0) break; items.push(serialize(x, depth + 1, seen, b)); }
                    return { t: 'set', n: v.size, items, more: items.length < v.size };
                }
                const keys = _keys(v);
                const props = [];
                for (const k of keys) {
                    if (props.length >= PROPS_MAX || b.n <= 0) break;
                    b.n -= k.length;
                    const d = _gopd(v, k);
                    props.push([k, !d ? { t: 'u' } : d.get ? { t: 'get' } : serialize(d.value, depth + 1, seen, b)]);
                }
                return { t: 'obj', cls: ctorName(v), n: keys.length, props, more: props.length < keys.length };
            } finally { seen.pop(); }
        } catch (_) {
            return { t: 'obj', cls: tag, n: 0, props: [], err: true };
        }
    }

    /** One-line text of console arguments (printf-style %s %d %i %f %o %O %c, like DevTools). */
    function shortText(v, depth = 0) {
        const t = typeof v;
        if (t === 'string') return depth ? _stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v) : v;
        if (v === null || t === 'number' || t === 'boolean') return String(v);
        if (t === 'bigint') return `${v}n`;
        if (t === 'undefined') return 'undefined';
        if (t === 'symbol') { try { return v.toString(); } catch (_) { return 'Symbol()'; } }
        if (t === 'function') { try { return `ƒ ${v.name || ''}()`; } catch (_) { return 'ƒ'; } }
        try {
            if (v instanceof Error) return depth ? (v.name || 'Error') : `${v.name || 'Error'}: ${v.message || ''}`;
            if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') return nodeLabel(v);
            const tag = tagOf(v);
            if (tag === 'Date') { try { return _dateIso.call(v); } catch (_) { return 'Invalid Date'; } }
            if (tag === 'RegExp') return String(v);
            // DevTools-like preview: one level of entries, nested values shortened.
            const list = (items, open, close, prefix) => {
                const body = items.slice(0, 6).join(', ') + (items.length > 6 ? ', …' : '');
                return `${prefix}${open}${body}${close}`;
            };
            if (depth >= 1) {
                if (_isArray(v)) return `Array(${v.length})`;
                if (tag === 'Map' || tag === 'Set') return `${tag}(${v.size})`;
                return ctorName(v) === 'Object' ? '{…}' : ctorName(v);
            }
            if (_isArray(v)) return list(Array.prototype.slice.call(v, 0, 7).map((x) => shortText(x, 1)), '[', ']', v.length > 1 ? `(${v.length}) ` : '');
            if (tag === 'Map') { const out = []; for (const [k, x] of v) { out.push(`${shortText(k, 1)} => ${shortText(x, 1)}`); if (out.length > 6) break; } return list(out, '{', '}', `Map(${v.size}) `); }
            if (tag === 'Set') { const out = []; for (const x of v) { out.push(shortText(x, 1)); if (out.length > 6) break; } return list(out, '{', '}', `Set(${v.size}) `); }
            const keys = _keys(v), cls = ctorName(v);
            const out = keys.slice(0, 7).map((k) => { const d = _gopd(v, k); return `${k}: ${!d ? 'undefined' : d.get ? '(…)' : shortText(d.value, 1)}`; });
            return list(out, '{', '}', cls && cls !== 'Object' ? `${cls} ` : '');
        } catch (_) { /* exotic object */ }
        return ctorName(v);
    }
    function formatText(args) {
        const out = [];
        let i = 0;
        if (typeof args[0] === 'string' && args[0].indexOf('%') >= 0) {
            let a = 1;
            out.push(args[0].replace(/%([sdifoOc%])/g, (m, k) => {
                if (k === '%') return '%';
                if (a >= args.length) return m;
                const x = args[a++];
                if (k === 'c') return '';
                if (k === 'd' || k === 'i') { const n = parseInt(x, 10); return Number.isNaN(n) ? 'NaN' : String(n); }
                if (k === 'f') return String(parseFloat(x));
                return shortText(x);
            }));
            i = a;
        }
        for (; i < args.length; i++) out.push(shortText(args[i]));
        const s = out.join(' ');
        return s.length > 500 ? `${s.slice(0, 500)}…` : s;
    }

    if (H.test) H.expose({ serialize, formatText, shortText, wrapBodies });

    // ── transport ─────────────────────────────────────────────────────────────────────────────
    /**
     * POST to our endpoint. `unloading`: the page is going away, so use a beacon (outlives the page).
     * Otherwise a plain fetch: keepalive requests skip the proxy in some setups (loopback hosts).
     */
    function send(path, obj, unloading) {
        let body;
        try { body = _stringify(obj); } catch (_) { return; }
        if (unloading && _beacon && _Blob && body.length < 60000) {
            try { if (_beacon(EP + path, new _Blob([body], { type: 'text/plain' }))) return; } catch (_) { /* fall through */ }
        }
        if (_fetch) _fetch(EP + path, { method: 'POST', body, credentials: 'omit', cache: 'no-store', keepalive: !!unloading && body.length < 60000 }).catch(() => {});
    }

    const SEV = { error: 'error', assert: 'error', exception: 'error', resource: 'error', warn: 'warn', csp: 'warn', deprecation: 'warn', intervention: 'warn', debug: 'verbose' };
    const MAX_PER_SEC = 200;
    const BATCH_BYTES = 48 * 1024;
    let queue = [], qBytes = 0, flushTimer = 0, winStart = 0, winCount = 0, dropped = 0, busy = false, groupDepth = 0;
    function flush(ev) {
        const unloading = !!(ev && ev.type === 'pagehide');
        if (flushTimer) { _clearTimeout(flushTimer); flushTimer = 0; }
        if (dropped) { queue.push(_stringify({ lvl: 'info', sev: 'info', t: _now(), text: `CupNet: ${dropped} console message(s) dropped (over ${MAX_PER_SEC}/s)` })); dropped = 0; }
        if (!queue.length) return;
        const parts = queue; queue = []; qBytes = 0;
        // Several beacons when a burst went over the batch size.
        let chunk = [], size = 0;
        const out = () => { if (chunk.length) send('console', { doc: DOC, frame, url: W.location.href, items: chunk.map((s) => _parse(s)) }, unloading); chunk = []; size = 0; };
        for (const p of parts) { if (size + p.length > BATCH_BYTES) out(); chunk.push(p); size += p.length; }
        out();
    }
    function push(entry) {
        const now = _now();
        if (now - winStart > 1000) { winStart = now; winCount = 0; }
        if (++winCount > MAX_PER_SEC) { dropped++; return; }
        entry.t = entry.t || now;
        entry.sev = SEV[entry.lvl] || 'info';
        if (groupDepth) entry.g = groupDepth;
        let s;
        try { s = _stringify(entry); } catch (_) { return; }
        if (s.length > 32000) {
            entry.args = [{ t: 's', v: entry.text || '', n: s.length }];
            s = _stringify(entry);
        }
        queue.push(s); qBytes += s.length;
        if (qBytes > BATCH_BYTES) flush();
        else if (!flushTimer) flushTimer = _setTimeout(() => flush(), 250);
    }
    /** Caller location from a stack captured in our wrapper: frame 0 is "Error", 1 is the wrapper. */
    function callerOf(stack, skip) {
        const lines = String(stack || '').split('\n').slice(1 + (skip || 1));
        const first = lines[0] || '';
        const m = /\(?((?:https?|blob|chrome-extension|file):[^\s)]+?):(\d+):(\d+)\)?\s*$/.exec(first) || /@(.+?):(\d+):(\d+)$/.exec(first);
        return { src: m ? `${m[1]}:${m[2]}:${m[3]}` : '', stack: lines.slice(0, 12).map((l) => l.trim()).join('\n') };
    }

    // ── console capture ───────────────────────────────────────────────────────────────────────
    const C = W.console;
    const counts = Object.create(null), timers = Object.create(null);
    function capture(lvl, args, stack) {
        if (busy) return;
        busy = true;
        try {
            const where = callerOf(stack, 1);
            let text = '', list = args;
            if (lvl === 'assert') {
                if (args[0]) return;
                list = args.slice(1);
                text = `Assertion failed${list.length ? `: ${formatText(list)}` : ''}`;
            } else if (lvl === 'count' || lvl === 'countReset') {
                const label = args.length && args[0] !== undefined ? String(args[0]) : 'default';
                if (lvl === 'countReset') { counts[label] = 0; return; }
                counts[label] = (counts[label] || 0) + 1;
                text = `${label}: ${counts[label]}`; list = [];
            } else if (lvl === 'time' || lvl === 'timeEnd' || lvl === 'timeLog') {
                const label = args.length && args[0] !== undefined ? String(args[0]) : 'default';
                const p = W.performance;
                const now = p && p.now ? p.now() : _now();
                if (lvl === 'time') { timers[label] = now; return; }
                if (!(label in timers)) { text = `Timer '${label}' does not exist`; lvl = 'warn'; list = []; }
                else {
                    text = `${label}: ${(now - timers[label]).toFixed(3)} ms${lvl === 'timeLog' && args.length > 1 ? ` ${formatText(args.slice(1))}` : ''}`;
                    if (lvl === 'timeEnd') delete timers[label];
                    list = lvl === 'timeLog' ? args.slice(1) : [];
                }
                lvl = lvl === 'warn' ? 'warn' : 'time';
            } else if (lvl === 'groupEnd') {
                groupDepth = Math.max(0, groupDepth - 1);
                return;
            } else if (lvl === 'clear') {
                text = 'Console was cleared'; list = [];
            } else {
                text = list.length ? formatText(list) : (lvl === 'group' || lvl === 'groupCollapsed' ? 'console.group' : '');
            }
            const e = { lvl: lvl === 'groupCollapsed' ? 'group' : lvl, text, src: where.src };
            if (list.length) e.args = list.map((a) => serialize(a));
            if (lvl === 'error' || lvl === 'warn' || lvl === 'trace' || lvl === 'assert') e.stack = where.stack;
            if (lvl === 'groupCollapsed') e.collapsed = 1;
            push(e);
            if (lvl === 'group' || lvl === 'groupCollapsed') groupDepth++;
        } catch (_) { /* never break the page */ } finally { busy = false; }
    }
    const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert', 'count', 'countReset', 'time', 'timeEnd', 'timeLog', 'group', 'groupCollapsed', 'groupEnd', 'clear'];
    if (C) {
        for (const m of METHODS) {
            const orig = C[m];
            if (typeof orig !== 'function') continue;
            const wrapped = {
                [m](...args) {
                    let stack = '';
                    try { stack = new Error().stack; } catch (_) { /* no stacks */ }
                    capture(m, args, stack);
                    return orig.apply(this, args);
                },
            }[m];
            try { Object.defineProperty(wrapped, 'length', { value: orig.length }); } catch (_) { /* frozen */ }
            try { C[m] = wrapped; } catch (_) { /* read-only console */ }
        }
    }

    // ── errors, rejections, CSP, browser reports ──────────────────────────────────────────────
    if (W.addEventListener) {
        W.addEventListener('error', (ev) => {
            try {
                if (quiet) { ev.preventDefault(); return; }
                const tgt = ev.target;
                if (tgt && tgt !== W && typeof tgt.nodeType === 'number') {
                    // Capture phase: a resource (img, script, link, media) failed to load.
                    const url = tgt.currentSrc || tgt.src || tgt.href || '';
                    push({ lvl: 'resource', text: `Failed to load ${String(tgt.tagName || 'resource').toLowerCase()}${url ? `: ${url}` : ''}`, src: String(url).slice(0, 2000) });
                    return;
                }
                const err = ev.error;
                push({
                    lvl: 'exception',
                    text: `Uncaught ${err && err.name ? `${err.name}: ${err.message}` : ev.message || 'error'}`,
                    src: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : '',
                    stack: err && err.stack ? String(err.stack).slice(0, 4000) : '',
                    args: err !== undefined ? [serialize(err)] : undefined,
                });
            } catch (_) { /* ignore */ }
        }, true);
        W.addEventListener('unhandledrejection', (ev) => {
            try {
                const r = ev.reason;
                push({ lvl: 'exception', text: `Uncaught (in promise) ${shortText(r)}`, stack: r && r.stack ? String(r.stack).slice(0, 4000) : '', args: [serialize(r)] });
            } catch (_) { /* ignore */ }
        });
        W.addEventListener('pagehide', flush);
    }
    if (D && D.addEventListener) {
        D.addEventListener('securitypolicyviolation', (ev) => {
            try {
                if (String(ev.blockedURI || '').indexOf(EP) >= 0) return;
                if (ev.blockedURI === 'eval' && _now() - evalAt < 5000) return;
                push({
                    lvl: 'csp',
                    text: `CSP ${ev.disposition === 'report' ? 'report-only ' : ''}violation: ${ev.effectiveDirective || ev.violatedDirective} blocked ${ev.blockedURI || 'inline'}`,
                    src: ev.sourceFile ? `${ev.sourceFile}:${ev.lineNumber}:${ev.columnNumber}` : '',
                });
            } catch (_) { /* ignore */ }
        });
    }
    try {
        if (typeof W.ReportingObserver === 'function') {
            new W.ReportingObserver((reports) => {
                for (const r of reports) {
                    const b = r.body || {};
                    push({ lvl: r.type === 'intervention' ? 'intervention' : 'deprecation', text: `[${r.type}] ${b.message || b.id || ''}`, src: b.sourceFile ? `${b.sourceFile}:${b.lineNumber}:${b.columnNumber}` : '' });
                }
            }, { types: ['deprecation', 'intervention'], buffered: true }).observe();
        }
    } catch (_) { /* ignore */ }

    // ── commands from the CupNet UI ───────────────────────────────────────────────────────────
    /**
     * Pages without 'unsafe-eval' block eval(); run the code as a nonce'd inline <script> instead (the
     * nonce html-inject.js gave our own tag). `bodies` are expressions, tried in order until one parses.
     */
    function evalViaScript(bodies, raw) {
        if (!NONCE || !D) return null;
        const key = `cupnet-${Math.random().toString(36).slice(2)}`;
        let out = null;
        const on = (ev) => { out = ev.detail; };
        D.addEventListener(key, on);
        let parseErr = null;
        // A candidate that does not parse reports to window 'error'; keep it from the site's own handlers.
        let probing = false;
        const onErr = (ev) => {
            if (ev.error instanceof W.SyntaxError) {
                // Keep the first message: later candidates wrap the code in more syntax and mislead.
                if (!parseErr || probing) parseErr = new W.SyntaxError(String(ev.error.message).replace(/^Failed to execute '[^']+' on '[^']+': /, ''));
            } else if (!probing) return;
            ev.stopImmediatePropagation(); ev.preventDefault();
        };
        W.addEventListener('error', onErr, true);
        const tryRun = (body, text) => {
            const el = D.createElement('script');
            el.nonce = NONCE;
            el.text = text || `document.dispatchEvent(new CustomEvent(${_stringify(key)},{detail:(function(){try{return{ok:1,v:${body}}}catch(e){return{ok:0,e:e}}})()}));`;
            quiet++;
            try { (D.head || D.documentElement).appendChild(el); } finally { quiet--; el.remove(); }
        };
        try {
            for (const b of bodies) { tryRun(b); if (out) break; }
            // Nothing parsed: parse the code alone for the real message. A script is parsed whole before it
            // runs, so the leading throw keeps valid code from executing.
            if (!out && parseErr && raw != null) { probing = true; tryRun(null, `throw 0;\n${raw}`); }
        } catch (_) { /* Trusted Types or similar */ }
        D.removeEventListener(key, on);
        W.removeEventListener('error', onErr, true);
        return out || (parseErr ? { ok: 0, e: parseErr } : null);
    }
    const AWAIT_RE = /(^|[^\w$.])await\b/;
    /**
     * Function-wrapped forms of `code`: an expression, then statements returning the last one
     * ("let a = 2; a * 21" → 42, split at the last ; or newline: a wrong split just fails to parse),
     * then plain statements.
     */
    function wrapBodies(code, isAsync) {
        const fn = isAsync ? 'async()=>' : 'function()';
        const call = (b) => (isAsync ? `(${fn}{${b}\n})()` : `(${fn}{${b}\n}).call(this)`);
        const out = [isAsync ? `(${fn}(${code}\n))()` : `(${code}\n)`];
        const t = code.replace(/[\s;]+$/, '');
        const cut = Math.max(t.lastIndexOf(';'), t.lastIndexOf('\n'));
        if (cut > 0 && t.slice(cut + 1).trim()) out.push(call(`${t.slice(0, cut + 1)}\nreturn (${t.slice(cut + 1)}\n);`));
        out.push(call(code));
        return out;
    }
    function evalCmd(c) {
        let v;
        const code = String(c.code || '');
        const wantAwait = !!c.await && AWAIT_RE.test(code);
        const run = () => {
            evalAt = _now();
            if (!wantAwait) return (0, eval)(code);
            const bodies = wrapBodies(code, true);
            let first = null;
            for (const b of bodies) {
                try { return (0, eval)(b); } catch (e) { if (!(e instanceof W.SyntaxError)) throw e; first = first || e; }
            }
            throw first;
        };
        // A syntax error's stack is our own eval frames — drop it.
        const errOut = (e) => (e instanceof W.SyntaxError ? { t: 'err', name: 'SyntaxError', msg: String(e.message || '') } : serialize(e));
        try { v = run(); } catch (e) {
            const msg = String(e && e.message || e);
            const csp = e instanceof W.EvalError || /unsafe-eval|Content Security Policy|Trusted Type/i.test(msg);
            const alt = csp ? evalViaScript(wrapBodies(code, wantAwait), wantAwait ? null : code) : null;
            if (!alt) return Promise.resolve({ ok: false, error: errOut(e), text: `Uncaught ${shortText(e)}`, csp });
            if (!alt.ok) return Promise.resolve({ ok: false, error: errOut(alt.e), text: `Uncaught ${shortText(alt.e)}`, via: 'script' });
            v = alt.v;
        }
        if (v && typeof v.then === 'function' && c.await) {
            return new Promise((resolve) => {
                const t = _setTimeout(() => resolve({ ok: true, value: { t: 'obj', cls: 'Promise', n: 0, props: [] }, text: 'Promise {<pending>}' }), 10000);
                v.then((x) => { resolve({ ok: true, value: serialize(x), text: shortText(x) }); }, (e) => { resolve({ ok: false, error: serialize(e), text: `Uncaught (in promise) ${shortText(e)}` }); })
                    .finally(() => _clearTimeout(t));
            });
        }
        return Promise.resolve({ ok: true, value: serialize(v), text: shortText(v) });
    }
    let hl = null;
    function highlight(sel) {
        try {
            if (hl) { hl.remove(); hl = null; }
            const el = sel ? D.querySelector(sel) : null;
            if (!el) return { ok: false, text: sel ? 'No element matches' : 'cleared' };
            if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            const r = el.getBoundingClientRect();
            hl = D.createElement('div');
            hl.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;outline:2px solid #4f8cff;background:rgba(79,140,255,.15);border-radius:3px;transition:opacity .4s`;
            (D.body || D.documentElement).appendChild(hl);
            const mine = hl;
            _setTimeout(() => { if (hl === mine) { mine.style.opacity = '0'; _setTimeout(() => { mine.remove(); if (hl === mine) hl = null; }, 450); } }, 2500);
            return { ok: true, text: nodeLabel(el) };
        } catch (e) { return { ok: false, text: shortText(e) }; }
    }
    /** Analyzer actions on form fields; fields are addressed as forms[form].elements[field]. */
    function formAction(c) {
        // Same addressing as the analyzer's forms scan; form -1 = controls outside any <form>.
        const list = c.form === -1
            ? Array.prototype.filter.call(D.querySelectorAll('input,select,textarea'), (x) => !x.form)
            : (D.querySelectorAll('form')[c.form] || { querySelectorAll: () => [] }).querySelectorAll('input,select,textarea,button');
        const el = list[c.field];
        if (!el) return { ok: false, text: 'Field not found (the page changed?)' };
        const fire = (t) => el.dispatchEvent(new W.Event(t, { bubbles: true }));
        switch (c.type) {
            case 'focus': if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); el.focus(); break;
            case 'show': el.dataset.cupnetType = el.type; if (el.type === 'hidden') el.type = 'text'; el.style.setProperty('display', 'block', 'important'); el.style.setProperty('visibility', 'visible', 'important'); break;
            case 'hide': if (el.dataset.cupnetType) { el.type = el.dataset.cupnetType; delete el.dataset.cupnetType; } el.style.removeProperty('display'); el.style.removeProperty('visibility'); break;
            case 'toggle-disabled': el.disabled = !el.disabled; break;
            case 'toggle-readonly': el.readOnly = !el.readOnly; break;
            case 'toggle-password': el.type = el.type === 'password' ? 'text' : 'password'; break;
            case 'set-value': {
                const v = String(c.value ?? '');
                if (el.type === 'checkbox' || el.type === 'radio') el.checked = /^(1|true|on|yes|checked)$/i.test(v);
                else {
                    // React and friends track the value setter on the prototype.
                    const proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? W.HTMLSelectElement.prototype : W.HTMLInputElement.prototype;
                    const d = _gopd(proto, 'value');
                    if (d && d.set) d.set.call(el, v); else el.value = v;
                }
                fire('input'); fire('change');
                break;
            }
            default: return { ok: false, text: `unknown action ${c.type}` };
        }
        return { ok: true };
    }
    function storageAction(c) {
        const st = c.which === 'session' ? W.sessionStorage : W.localStorage;
        const data = c.data && typeof c.data === 'object' ? c.data : {};
        if (c.replace) for (const k of _keys(st)) if (!(k in data)) st.removeItem(k);
        for (const k of _keys(data)) {
            if (data[k] === null) st.removeItem(k);
            else st.setItem(k, typeof data[k] === 'string' ? data[k] : _stringify(data[k]));
        }
        return { ok: true };
    }
    function run(c) {
        let p;
        if (c.op === 'eval') p = evalCmd(c);
        else if (c.op === 'form') p = Promise.resolve().then(() => formAction(c));
        else if (c.op === 'storage') p = Promise.resolve().then(() => storageAction(c));
        else if (c.op === 'analyze') p = Promise.resolve().then(() => ({ ok: true, report: H.collect ? H.collect(W) : null }));
        else if (c.op === 'highlight') p = Promise.resolve(highlight(c.selector));
        else p = Promise.resolve({ ok: false, text: `unknown op ${c.op}` });
        const fail = (e) => send('agent/result', { doc: DOC, id: c.id, ok: false, text: shortText(e) }, false);
        p.then((r) => {
            let body;
            try { body = _stringify({ doc: DOC, id: c.id, ...r }); } catch (e) { fail(e); return; }
            if (_fetch) _fetch(`${EP}agent/result`, { method: 'POST', body, credentials: 'omit', cache: 'no-store' }).catch(() => {});
        }, fail);
    }

    // ── presence + command poll ──────────────────────────────────────────────────────────────
    let pollMs = cfg.poll || 15000, lastUrl = '', lastTitle = '', stopped = false;
    const vis = () => (D && D.visibilityState === 'visible' ? 1 : 0);
    function hello() {
        lastUrl = W.location.href; lastTitle = D ? String(D.title || '') : '';
        send('agent/hello', { doc: DOC, url: lastUrl, title: lastTitle.slice(0, 300), frame, referrer: D ? D.referrer : '' }, false);
    }
    let pollTimer = 0;
    function schedule(ms) { if (pollTimer) W.clearTimeout(pollTimer); if (!stopped) pollTimer = _setTimeout(poll, ms); }
    function poll() {
        pollTimer = 0;
        if (!_fetch || stopped) return;
        const title = D ? String(D.title || '').slice(0, 300) : '';
        _fetch(`${EP}agent/poll`, { method: 'POST', credentials: 'omit', cache: 'no-store', body: _stringify({ doc: DOC, url: W.location.href, title, vis: vis() }) })
            .then((r) => (r.status === 410 ? (stopped = true, null) : r.ok ? r.text() : null))
            .then((txt) => {
                if (!txt) return;
                const j = _parse(txt);
                if (j.next) pollMs = Math.max(500, Math.min(60000, Number(j.next) || pollMs));
                for (const c of j.cmds || []) run(c);
            })
            .catch(() => {})
            // Same pace when hidden: the CupNet window often covers Chrome, and an occluded page counts as
            // hidden. The next poll is set from a fetch callback, so Chrome's timer-chain throttling does not apply.
            .then(() => schedule(pollMs));
    }
    if (!H.test) {
        hello();
        if (D && D.addEventListener) {
            D.addEventListener('DOMContentLoaded', () => { if (D.title !== lastTitle) hello(); });
            D.addEventListener('visibilitychange', () => { if (vis()) schedule(0); });
        }
        schedule(800);
    }
}

/**
 * Analyzer extras (the forms / captcha / meta / endpoint scans are the old CupNet analyzer scripts).
 * Self-contained: stringified into the page.
 */
function collectExtras(W) {
    'use strict';
    const D = W.document;
    const N = W.navigator || {};
    const cut = (v, n) => String(v == null ? '' : v).slice(0, n || 300);
    const has = (k) => { try { return k in W && W[k] != null; } catch (_) { return false; } };
    const q = (sel) => { try { return !!D.querySelector(sel); } catch (_) { return false; } };
    const out = {};

    // Controls outside any <form> (SPAs): shown as form -1, same field layout as the forms scan.
    out.orphanFields = Array.prototype.filter.call(D.querySelectorAll('input,select,textarea'), (el) => !el.form).slice(0, 300).map((el, i) => {
        const cs = W.getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        return {
            index: i, tag, type: el.type || '', name: el.name || '', id: el.id || '',
            value: el.type === 'file' ? '' : cut(el.value, 500), placeholder: el.placeholder || '',
            hidden: el.type === 'hidden', readonly: !!el.readOnly, disabled: !!el.disabled, required: !!el.required,
            visible: cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && el.offsetWidth > 0,
            className: cut(el.className, 100),
            options: tag === 'select' ? Array.from(el.options).slice(0, 50).map((o) => ({ value: o.value, text: o.text, selected: o.selected })) : undefined,
        };
    });

    const dump = (st) => {
        const o = {};
        let total = 0;
        try {
            for (let i = 0; i < st.length && i < 1000; i++) {
                const k = st.key(i);
                const v = st.getItem(k) || '';
                total += v.length;
                o[k] = total > 4e6 ? `[${v.length} chars, not loaded]` : v;
            }
        } catch (e) { o['(error)'] = String(e && e.message || e); }
        return o;
    };
    out.storage = { local: dump(W.localStorage), session: dump(W.sessionStorage) };
    out.cookieNames = String(D.cookie || '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')[0]).slice(0, 300);

    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { /* old engine */ }
    const scr = W.screen || {};
    out.env = {
        userAgent: N.userAgent, platform: N.platform, language: N.language, languages: (N.languages || []).slice(0, 10),
        hardwareConcurrency: N.hardwareConcurrency, deviceMemory: N.deviceMemory, maxTouchPoints: N.maxTouchPoints,
        webdriver: N.webdriver, cookieEnabled: N.cookieEnabled, doNotTrack: N.doNotTrack, timezone: tz,
        tzOffset: new Date().getTimezoneOffset(),
        screen: `${scr.width}×${scr.height} (avail ${scr.availWidth}×${scr.availHeight}, ${scr.colorDepth}-bit)`,
        viewport: `${W.innerWidth}×${W.innerHeight} @${W.devicePixelRatio}x`,
        uaData: N.userAgentData ? { brands: (N.userAgentData.brands || []).map((b) => `${b.brand} ${b.version}`), mobile: N.userAgentData.mobile, platform: N.userAgentData.platform } : null,
        serviceWorker: N.serviceWorker && N.serviceWorker.controller ? N.serviceWorker.controller.scriptURL : '',
        isSecureContext: W.isSecureContext, crossOriginIsolated: W.crossOriginIsolated,
    };

    try {
        const nav = (W.performance.getEntriesByType('navigation') || [])[0];
        // Our own agent requests are not the page's.
        const res = (W.performance.getEntriesByType('resource') || []).filter((r) => String(r.name).indexOf('/__cupnet/') < 0);
        const byType = {};
        let bytes = 0;
        for (const r of res) { byType[r.initiatorType || 'other'] = (byType[r.initiatorType || 'other'] || 0) + 1; bytes += r.transferSize || 0; }
        out.timing = nav ? {
            type: nav.type, protocol: nav.nextHopProtocol, ttfb: Math.round(nav.responseStart - nav.startTime),
            domInteractive: Math.round(nav.domInteractive), domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            load: Math.round(nav.loadEventEnd), docBytes: nav.transferSize, decodedBytes: nav.decodedBodySize,
            resources: res.length, resourceBytes: bytes, byType,
        } : { resources: res.length, resourceBytes: bytes, byType };
    } catch (_) { out.timing = null; }

    const gen = (D.querySelector('meta[name="generator"]') || {}).content || '';
    const ver = (f) => { try { return f() || ''; } catch (_) { return ''; } };
    const T = [
        ['React', has('React') || q('[data-reactroot]') || ver(() => Object.keys(D.querySelector('body > div') || {}).some((k) => k.indexOf('__react') === 0)), ver(() => W.React.version)],
        ['Next.js', has('__NEXT_DATA__') || has('next') || q('script#__NEXT_DATA__'), ver(() => W.next.version)],
        ['Vue', has('__VUE__') || has('Vue') || q('[data-v-app]') || q('[data-server-rendered]'), ver(() => W.Vue.version)],
        ['Nuxt', has('__NUXT__') || has('$nuxt') || q('#__nuxt')],
        ['Angular', q('[ng-version]'), ver(() => D.querySelector('[ng-version]').getAttribute('ng-version'))],
        ['AngularJS', has('angular'), ver(() => W.angular.version.full)],
        ['Svelte', q('[class*="svelte-"]')],
        ['jQuery', has('jQuery'), ver(() => W.jQuery.fn.jquery)],
        ['Gatsby', has('___gatsby') || q('#___gatsby')],
        ['Remix', has('__remixContext')],
        ['WordPress', /wordpress/i.test(gen) || q('link[href*="/wp-content/"]') || q('script[src*="/wp-includes/"]'), gen.replace(/^\D+/, '')],
        ['Shopify', has('Shopify')],
        ['Bitrix', has('BX')],
        ['Tilda', q('[data-tilda-project-id]') || has('tildaForm')],
        ['Google Tag Manager', has('google_tag_manager')],
        ['Google Analytics', has('gtag') || has('ga') || has('GoogleAnalyticsObject')],
        ['Yandex Metrica', has('ym') || has('Ya')],
        ['Sentry', has('__SENTRY__') || has('Sentry')],
        ['Cloudflare challenge', has('_cf_chl_opt') || q('#challenge-form') || q('script[src*="/cdn-cgi/challenge-platform/"]')],
        ['Cloudflare Turnstile', has('turnstile') || q('script[src*="challenges.cloudflare.com/turnstile"]')],
        ['reCAPTCHA', has('grecaptcha')],
        ['hCaptcha', has('hcaptcha')],
        ['Akamai Bot Manager', has('bmak') || q('script[src*="/akam/"]') || /_abck=/.test(D.cookie)],
        ['PerimeterX / HUMAN', has('_pxAppId') || has('_pxUuid')],
        ['DataDome', has('ddjskey') || has('dataDomeOptions') || q('script[src*="datadome"]')],
        ['Imperva / Incapsula', /incap_ses_|visid_incap_/.test(D.cookie) || q('script[src*="/_Incapsula_Resource"]')],
        ['Qrator', has('__qrator') || q('script[src*="qrator"]')],
        ['Kasada', has('KPSDK')],
        ['FingerprintJS', has('FingerprintJS') || has('Fingerprint2')],
    ];
    out.tech = T.filter((t) => t[1]).map((t) => ({ name: t[0], version: cut(t[2] || '', 40) }));
    return out;
}

/**
 * Source of the agent script for one document. `cfg` must be JSON-able ({ ep?, poll? }); the doc id is
 * generated in the page.
 */
function buildAgentSource(cfg = {}) {
    // Required lazily: only the analyzer needs these, and the module is plain strings.
    const old = require('../main-process/services/page-analyzer-injected-scripts');
    const collect = `function (W) {
        var out = {};
        var run = function (k, f) { try { out[k] = f(); } catch (e) { out[k] = { error: String(e && e.message || e) }; } };
        run('forms', ${old._analyzeFormsScript});
        run('captcha', ${old._analyzeCaptchaScript});
        run('meta', ${old._analyzeMetaScript});
        run('endpoints', ${old._analyzeEndpointsCollectScript});
        run('extra', function () { return (${collectExtras})(W); });
        return out;
    }`;
    return `(${pageAgentMain})(${JSON.stringify(cfg)}, { collect: ${collect} });`;
}

module.exports = { pageAgentMain, collectExtras, buildAgentSource };
