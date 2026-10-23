'use strict';
/**
 * Request compare for CupNet mini: header / query / cookie / JSON / line diffs of two log entries.
 * Pure functions, no DOM. Loaded by the UI as /lib/diff.js (window.CupNetDiff) and require()d by tests.
 */

// A classic script in the UI shares one global scope with ui.js: keep the helpers private.
(() => {

/** Headers that change on every request or response and usually hide the real differences. */
const VOLATILE = new Set([
    'date', 'age', 'expires', 'last-modified', 'etag', 'if-none-match', 'if-modified-since',
    'cf-ray', 'cf-cache-status', 'x-request-id', 'x-amzn-requestid', 'x-amz-cf-id', 'x-amz-request-id',
    'x-amzn-trace-id', 'x-cache', 'x-served-by', 'x-timer', 'x-trace-id', 'traceparent', 'tracestate',
    'request-id', 'x-correlation-id', 'server-timing', 'report-to', 'nel', 'content-length',
    'x-runtime', 'x-response-time', 'via', 'alt-svc', 'x-envoy-upstream-service-time', 'priority',
]);

/** `{name: value | value[]}` → `[[name, value], …]` in object order. */
function pairsOf(obj) {
    const out = [];
    for (const [k, v] of Object.entries(obj || {})) {
        for (const one of (Array.isArray(v) ? v : [v])) out.push([k, String(one == null ? '' : one)]);
    }
    return out;
}

/**
 * Name/value diff of two multimaps (headers, query, cookies). Names match case-insensitively when
 * `caseless`; repeated names compare as one value list. Rows keep A's order, then B-only names.
 * @returns {{ rows: Array<{name, a: string[]|null, b: string[]|null, state: 'same'|'changed'|'added'|'removed'}>, counts }}
 */
function diffPairs(aPairs, bPairs, opts = {}) {
    const caseless = opts.caseless !== false;
    const ignore = opts.ignore || null;
    const key = (k) => (caseless ? String(k).toLowerCase() : String(k));
    const group = (pairs) => {
        const m = new Map();
        for (const [k, v] of pairs || []) {
            const kk = key(k);
            if (ignore && ignore.has(String(k).toLowerCase())) continue;
            if (!m.has(kk)) m.set(kk, { name: k, values: [] });
            m.get(kk).values.push(String(v));
        }
        return m;
    };
    const A = group(aPairs), B = group(bPairs);
    const rows = [];
    const counts = { same: 0, changed: 0, added: 0, removed: 0 };
    const push = (row) => { rows.push(row); counts[row.state]++; };
    for (const [k, a] of A) {
        const b = B.get(k);
        if (!b) push({ name: a.name, a: a.values, b: null, state: 'removed' });
        else push({ name: a.name, a: a.values, b: b.values, state: a.values.join('\n') === b.values.join('\n') ? 'same' : 'changed' });
    }
    for (const [k, b] of B) if (!A.has(k)) push({ name: b.name, a: null, b: b.values, state: 'added' });
    return { rows, counts, differences: counts.changed + counts.added + counts.removed };
}

/**
 * Order of the names both lists share. Fingerprinting looks at header order, so a reorder is a
 * real difference even when every value matches.
 * @returns {{ same: boolean, a: string[], b: string[], moved: Set<string> }}
 */
function orderDiff(aNames, bNames) {
    const lc = (xs) => xs.map((x) => String(x).toLowerCase());
    const a = lc(aNames), b = lc(bNames);
    const inB = new Set(b), inA = new Set(a);
    const sa = a.filter((x) => inB.has(x)), sb = b.filter((x) => inA.has(x));
    const keep = new Set(lcs(sa, sb));
    const moved = new Set(sa.filter((x) => !keep.has(x)));
    return { same: moved.size === 0 && sa.length === sb.length, a, b, moved };
}

/** Longest common subsequence of two short string lists (header names). */
function lcs(a, b) {
    const n = a.length, m = b.length;
    if (!n || !m) return [];
    const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const out = [];
    for (let i = 0, j = 0; i < n && j < m;) {
        if (a[i] === b[j]) { out.push(a[i]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
    }
    return out;
}

/** `a=1; b=2` → `[['a','1'], ['b','2']]` (all Cookie headers of a request). */
function cookiePairs(headers) {
    const out = [];
    for (const [k, v] of pairsOf(headers)) {
        if (k.toLowerCase() !== 'cookie') continue;
        for (const part of v.split(';')) {
            const p = part.trim();
            if (!p) continue;
            const i = p.indexOf('=');
            out.push(i < 0 ? [p, ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]);
        }
    }
    return out;
}

/** Set-Cookie lines → `[[name, 'value; attrs']]` so attribute changes show as a changed value. */
function setCookiePairs(headers) {
    const out = [];
    for (const [k, v] of pairsOf(headers)) {
        if (k.toLowerCase() !== 'set-cookie') continue;
        for (const line of v.split('\n')) {
            const s = line.trim();
            if (!s) continue;
            const semi = s.indexOf(';');
            const nv = semi < 0 ? s : s.slice(0, semi);
            const i = nv.indexOf('=');
            out.push([i < 0 ? nv.trim() : nv.slice(0, i).trim(), i < 0 ? s : s.slice(i + 1).trim()]);
        }
    }
    return out;
}

function queryPairs(url) {
    try { return [...new URL(url).searchParams.entries()]; } catch { return []; }
}

const _type = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const _short = (v) => {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 300 ? `${s.slice(0, 300)}…` : s;
};
const _pathKey = (p, k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);

/**
 * Structural JSON diff. Arrays compare by index. Stops after `maxRows` rows (`truncated`).
 * @returns {{ rows: Array<{path, kind: 'changed'|'added'|'removed'|'type', a?, b?}>, truncated: boolean }}
 */
function jsonDiff(a, b, opts = {}) {
    const maxRows = opts.maxRows || 2000;
    const rows = [];
    let truncated = false;
    const add = (row) => { if (rows.length >= maxRows) { truncated = true; return false; } rows.push(row); return true; };
    const walk = (x, y, p, depth) => {
        if (truncated) return;
        const tx = _type(x), ty = _type(y);
        if (tx !== ty) { add({ path: p, kind: 'type', a: _short(x), b: _short(y) }); return; }
        if (tx === 'object' && depth < 64) {
            for (const k of Object.keys(x)) {
                if (!Object.prototype.hasOwnProperty.call(y, k)) add({ path: _pathKey(p, k), kind: 'removed', a: _short(x[k]) });
                else walk(x[k], y[k], _pathKey(p, k), depth + 1);
            }
            for (const k of Object.keys(y)) if (!Object.prototype.hasOwnProperty.call(x, k)) add({ path: _pathKey(p, k), kind: 'added', b: _short(y[k]) });
            return;
        }
        if (tx === 'array' && depth < 64) {
            const n = Math.max(x.length, y.length);
            for (let i = 0; i < n && !truncated; i++) {
                if (i >= y.length) add({ path: `${p}[${i}]`, kind: 'removed', a: _short(x[i]) });
                else if (i >= x.length) add({ path: `${p}[${i}]`, kind: 'added', b: _short(y[i]) });
                else walk(x[i], y[i], `${p}[${i}]`, depth + 1);
            }
            return;
        }
        if (JSON.stringify(x) !== JSON.stringify(y)) add({ path: p, kind: 'changed', a: _short(x), b: _short(y) });
    };
    walk(a, b, '$', 0);
    return { rows, truncated };
}

/** Parse a body as JSON when it looks like JSON; `undefined` otherwise. */
function tryJson(text) {
    if (typeof text !== 'string' || text.length > 20 * 1048576 || !/^\s*[[{]/.test(text)) return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Line diff (Myers O(ND) after trimming the common head and tail).
 * Gives up with `tooBig` when either side has more than `maxLines` lines or the edit distance passes `maxD`.
 * @returns {{ ops: Array<{t: '='|'-'|'+', text: string, a?: number, b?: number}>, added, removed, tooBig?: boolean }}
 */
function lineDiff(aText, bText, opts = {}) {
    const maxLines = opts.maxLines || 50000;
    const maxD = opts.maxD || 2000;
    const A = String(aText ?? '').split('\n'), B = String(bText ?? '').split('\n');
    if (A.length > maxLines || B.length > maxLines) return { ops: [], added: 0, removed: 0, tooBig: true };
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
    const mid = _myers(a, b, maxD);
    if (!mid) return { ops: [], added: 0, removed: 0, tooBig: true };
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push({ t: '=', text: A[i], a: i + 1, b: i + 1 });
    let ia = pre, ib = pre;
    let added = 0, removed = 0;
    for (const op of mid) {
        if (op === '=') { ops.push({ t: '=', text: A[ia], a: ++ia, b: ++ib }); } else if (op === '-') { ops.push({ t: '-', text: A[ia], a: ++ia }); removed++; } else { ops.push({ t: '+', text: B[ib], b: ++ib }); added++; }
    }
    for (let i = 0; i < suf; i++) ops.push({ t: '=', text: A[ia], a: ++ia, b: ++ib });
    return { ops, added, removed };
}

/**
 * Word/punctuation token diff of two strings for an inline red(removed)/green(added) view.
 * Tokens are runs of letters/digits, runs of whitespace, or single other chars — so a one-letter
 * change shows as one removed + one added token rather than a whole rewritten line.
 * Trims the common head/tail first, then Myers over the middle. `tooBig` when it blows past maxD.
 * @returns {{ ops: Array<{t:'='|'-'|'+', text:string}>, added:number, removed:number, tooBig?:boolean }}
 */
function tokenDiff(aText, bText, opts = {}) {
    const maxTokens = opts.maxTokens || 60000;
    const maxD = opts.maxD || 4000;
    const re = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
    const A = String(aText ?? '').match(re) || [];
    const B = String(bText ?? '').match(re) || [];
    if (A.length > maxTokens || B.length > maxTokens) return { ops: [], added: 0, removed: 0, tooBig: true };
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
    const mid = _myers(a, b, maxD);
    if (!mid) return { ops: [], added: 0, removed: 0, tooBig: true };
    // Merge adjacent same-type tokens into one op so the rendered DOM stays small.
    const ops = [];
    let added = 0, removed = 0;
    const push = (t, text) => {
        const last = ops[ops.length - 1];
        if (last && last.t === t) last.text += text; else ops.push({ t, text });
    };
    for (let i = 0; i < pre; i++) push('=', A[i]);
    let ia = pre, ib = pre;
    for (const op of mid) {
        if (op === '=') { push('=', A[ia]); ia++; ib++; }
        else if (op === '-') { push('-', A[ia]); ia++; removed++; }
        else { push('+', B[ib]); ib++; added++; }
    }
    for (let i = 0; i < suf; i++) push('=', A[ia + i]);
    return { ops, added, removed };
}

/** Myers shortest edit script as a list of '=', '-', '+'; null when the distance exceeds maxD. */
function _myers(a, b, maxD) {
    const n = a.length, m = b.length;
    if (!n && !m) return [];
    if (!n) return new Array(m).fill('+');
    if (!m) return new Array(n).fill('-');
    const max = Math.min(n + m, maxD);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    // trace[d] = the k ∈ [-d-1, d+1] window of v before step d (index k + d + 1) — O(D²) memory, not O(D·N).
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice(off - d - 1, off + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[off + k] = x;
            if (x >= n && y >= m) return _backtrack(trace, n, m, d);
        }
    }
    return null;
}
function _backtrack(trace, n, m, dEnd) {
    const ops = [];
    let x = n, y = m;
    for (let d = dEnd; d > 0; d--) {
        const w = trace[d], o = d + 1;
        const k = x - y;
        const prevK = k === -d || (k !== d && w[o + k - 1] < w[o + k + 1]) ? k + 1 : k - 1;
        const prevX = w[o + prevK], prevY = prevX - prevK;
        while (x > prevX && y > prevY) { ops.push('='); x--; y--; }
        if (x === prevX) { ops.push('+'); y--; } else { ops.push('-'); x--; }
    }
    while (x > 0 && y > 0) { ops.push('='); x--; y--; }
    return ops.reverse();
}

/**
 * Collapse long unchanged runs: keeps `context` lines around each change.
 * @returns {Array<op | {t: 'skip', count: number, from: number}>}
 */
function hunks(ops, context = 3) {
    const keep = new Uint8Array(ops.length);
    ops.forEach((op, i) => {
        if (op.t === '=') return;
        for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = 1;
    });
    const out = [];
    for (let i = 0; i < ops.length;) {
        if (keep[i]) { out.push(ops[i]); i++; continue; }
        let j = i;
        while (j < ops.length && !keep[j]) j++;
        out.push({ t: 'skip', count: j - i, from: i });
        i = j;
    }
    return out;
}

/** Top-line fields of two request entries. */
function summaryRows(a, b) {
    const f = (e) => ({
        Method: e.method || '', URL: e.url || '', Status: String(e.status || 'failed'), Type: e.type || '',
        MIME: e.mime || '', Duration: e.duration != null ? `${e.duration} ms` : '',
        'Request body': String(e.reqSize || 0), 'Response body': String(e.resSize || 0),
    });
    const A = f(a), B = f(b);
    return Object.keys(A).map((k) => ({ name: k, a: A[k], b: B[k], state: A[k] === B[k] ? 'same' : 'changed' }));
}

const CupNetDiff = {
    VOLATILE, pairsOf, diffPairs, orderDiff, cookiePairs, setCookiePairs, queryPairs, jsonDiff, tryJson, lineDiff, tokenDiff, hunks, summaryRows,
};
if (typeof window !== 'undefined') window.CupNetDiff = CupNetDiff;
if (typeof module !== 'undefined' && module.exports) module.exports = CupNetDiff;
})();
