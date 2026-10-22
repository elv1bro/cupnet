'use strict';

/**
 * CupNet mini Intruder: send many variations of one request, inserting payloads at positions the
 * user marks with `§ … §`, and report status / length / time / grep hit for each.
 *
 * The planning (marker parsing, attack-type expansion, building one request for a given index) is
 * pure and unit-testable. `runAttack` drives the sends through a caller-supplied `send` function
 * (the app's egress worker) with a bounded concurrency pool, so it never blocks the UI server and a
 * cancelled attack simply stops scheduling. Nothing here logs to the session; a single row is
 * inspected by rebuilding its request (`buildRequestAt`) and replaying it.
 */

const MARKER = '§'; // §
const MAX_POSITIONS = 20;
const MAX_REQUESTS = 10000;
const CONCURRENCY_DEFAULT = 8;
const CONCURRENCY_MAX = 32;
const ATTACK_TYPES = ['sniper', 'ram', 'pitchfork', 'clusterbomb'];

function _err(message) {
    const e = new Error(message);
    e.status = 400;
    return e;
}

/** Split `s` on `§ … §` pairs into fixed parts and the baseline text of each position. A lone `§` is literal. */
function splitMarkers(s) {
    const parts = [];
    const baselines = [];
    let i = 0;
    for (;;) {
        const a = s.indexOf(MARKER, i);
        if (a < 0) { parts.push(s.slice(i)); break; }
        const b = s.indexOf(MARKER, a + 1);
        if (b < 0) { parts.push(s.slice(i)); break; }
        parts.push(s.slice(i, a));
        baselines.push(s.slice(a + 1, b));
        i = b + 1;
    }
    return { parts, baselines };
}

/** Parse the request template into per-field marker splits and a total position count. */
function parseTemplate(t) {
    const url = splitMarkers(String(t.url || ''));
    const headers = (Array.isArray(t.headers) ? t.headers : [])
        .filter((h) => Array.isArray(h) && String(h[0] || '').trim())
        .map(([k, v]) => [String(k).trim(), splitMarkers(String(v ?? ''))]);
    const body = splitMarkers(typeof t.body === 'string' ? t.body : '');
    const positions = url.baselines.length + headers.reduce((n, [, p]) => n + p.baselines.length, 0) + body.baselines.length;
    return { method: String(t.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET', url, headers, body, positions };
}

/** Rebuild one field, taking position values from `valueAt(globalIndex)` (null → keep the baseline). */
function renderField(f, offset, valueAt) {
    let out = f.parts[0];
    for (let i = 0; i < f.baselines.length; i++) {
        const v = valueAt(offset + i);
        out += (v == null ? f.baselines[i] : v) + f.parts[i + 1];
    }
    return out;
}

/** Build a concrete request from a parsed template and a per-position value array. */
function buildRequest(parsed, vals, { urlEncode } = {}) {
    const valueAt = (gi) => { const v = vals[gi]; return v == null ? null : (urlEncode ? encodeURIComponent(v) : v); };
    let off = 0;
    const url = renderField(parsed.url, off, valueAt); off += parsed.url.baselines.length;
    const headers = parsed.headers.map(([k, p]) => { const v = renderField(p, off, valueAt); off += p.baselines.length; return [k, v]; });
    const body = renderField(parsed.body, off, valueAt);
    return { method: parsed.method, url, headers, body };
}

/** Validate a spec and resolve attack type, payload sets and the total request count. */
function _prepare(spec) {
    const attackType = String(spec?.attackType || 'sniper');
    if (!ATTACK_TYPES.includes(attackType)) throw _err('Unknown attack type');
    if (!/^https?:\/\/[^/]/i.test(String(spec?.template?.url || '').trim())) throw _err('URL must start with http:// or https://');
    const parsed = parseTemplate(spec.template);
    const N = parsed.positions;
    if (N < 1) throw _err('Mark at least one position: select some text and add a § … § position');
    if (N > MAX_POSITIONS) throw _err(`Too many positions (${N}); keep it under ${MAX_POSITIONS}`);
    const sets = (Array.isArray(spec.payloadSets) ? spec.payloadSets : []).map((s) => (Array.isArray(s) ? s.map((x) => String(x)) : []));
    let count;
    if (attackType === 'sniper' || attackType === 'ram') {
        const set0 = sets[0] || [];
        if (!set0.length) throw _err('Add at least one payload');
        count = attackType === 'sniper' ? N * set0.length : set0.length;
    } else {
        for (let p = 0; p < N; p++) if (!(sets[p] && sets[p].length)) throw _err(`Payload set ${p + 1} is empty (${attackType} needs one list per position)`);
        count = attackType === 'pitchfork'
            ? Math.min(...Array.from({ length: N }, (_, p) => sets[p].length))
            : Array.from({ length: N }, (_, p) => sets[p].length).reduce((a, b) => a * b, 1);
    }
    if (count < 1) throw _err('Nothing to send');
    if (count > MAX_REQUESTS) throw _err(`That is ${count.toLocaleString()} requests; the limit is ${MAX_REQUESTS.toLocaleString()}. Narrow the payloads.`);
    return { parsed, attackType, sets, N, count };
}

/** The per-position value array (and payload labels) for request number `index`. */
function assignmentAt(prep, index) {
    const { attackType, sets, N } = prep;
    const vals = new Array(N).fill(null);
    let payloads;
    let position = null;
    if (attackType === 'sniper') {
        const per = sets[0].length;
        position = Math.floor(index / per);
        const x = sets[0][index % per];
        vals[position] = x; payloads = [x];
    } else if (attackType === 'ram') {
        const x = sets[0][index];
        for (let p = 0; p < N; p++) vals[p] = x;
        payloads = [x];
    } else if (attackType === 'pitchfork') {
        payloads = [];
        for (let p = 0; p < N; p++) { vals[p] = sets[p][index]; payloads.push(sets[p][index]); }
    } else {
        payloads = new Array(N);
        let x = index;
        for (let p = N - 1; p >= 0; p--) { const s = sets[p]; vals[p] = s[x % s.length]; payloads[p] = vals[p]; x = Math.floor(x / s.length); }
    }
    return { index, vals, payloads, position };
}

/** Validate a spec and report the shape of the attack (for the UI to confirm before running). */
function planAttack(spec) {
    const { attackType, N, count } = _prepare(spec);
    return { attackType, positions: N, count };
}

/** Build the concrete request for one index (to inspect a single result by replaying it). */
function buildRequestAt(spec, index) {
    const prep = _prepare(spec);
    const i = Math.max(0, Math.min(prep.count - 1, Math.floor(Number(index)) || 0));
    return { ...buildRequest(prep.parsed, assignmentAt(prep, i).vals, spec), index: i };
}

/** Compile the optional grep-match test run against each (text) response body. */
function _grep(spec) {
    const g = String(spec?.grep || '');
    if (!g) return null;
    if (spec.grepRegex) {
        let re;
        try { re = new RegExp(g, 'i'); } catch (e) { throw _err(`Invalid grep expression: ${e.message.replace(/^Invalid regular expression: /, '')}`); }
        return (t) => re.test(t);
    }
    const needle = g.toLowerCase();
    return (t) => t.toLowerCase().includes(needle);
}

/**
 * Run an attack. Validation throws synchronously (status 400). `send(request)` resolves to
 * `{ status, length, duration, error, bodyText }`; a rejection aborts the attack.
 * @returns {{ stop: () => void, done: Promise<void>, count: number, attackType: string, positions: number }}
 */
function runAttack({ spec, send, onEvent, concurrency }) {
    const prep = _prepare(spec);
    const grep = _grep(spec);
    const conc = Math.min(CONCURRENCY_MAX, Math.max(1, Math.floor(Number(concurrency)) || CONCURRENCY_DEFAULT));
    const t0 = Date.now();
    let next = 0;
    let active = 0;
    let completed = 0;
    let errored = 0;
    let matchedCount = 0;
    let stopped = false;
    let drained = false;
    let settled = false;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });

    const finish = () => {
        if (settled) return;
        settled = true;
        onEvent({ type: 'done', count: prep.count, completed, errored, matched: matchedCount, stopped, ms: Date.now() - t0 });
        resolveDone();
    };

    const emit = (item, r, err, started) => {
        if (settled) return;
        const matched = (!err && grep) ? grep(r.bodyText || '') : null;
        if (matched) matchedCount++;
        if (err || r.error) errored++;
        onEvent({
            type: 'result', i: item.index, payloads: item.payloads, position: item.position,
            status: r.status || 0, length: r.length || 0, time: r.duration != null ? r.duration : (Date.now() - started),
            error: err ? (err.message || String(err)) : (r.error || null), matched,
        });
    };

    const launch = () => {
        if (stopped || next >= prep.count) { drained = true; return; }
        const item = assignmentAt(prep, next++);
        const req = buildRequest(prep.parsed, item.vals, spec);
        const started = Date.now();
        active++;
        Promise.resolve().then(() => send(req)).then(
            (r) => emit(item, r || {}, null, started),
            (e) => { emit(item, {}, e, started); stopped = true; },
        ).finally(() => {
            active--;
            completed++;
            if (!stopped && !drained) launch();
            if ((drained || stopped) && active === 0) finish();
        });
    };

    onEvent({ type: 'start', count: prep.count, attackType: prep.attackType, positions: prep.N, concurrency: conc });
    for (let k = 0; k < conc; k++) launch();
    if (active === 0) finish();

    return {
        count: prep.count,
        attackType: prep.attackType,
        positions: prep.N,
        done,
        stop: () => { stopped = true; if (active === 0) finish(); },
    };
}

module.exports = {
    runAttack, planAttack, buildRequestAt, splitMarkers, parseTemplate, buildRequest,
    MARKER, ATTACK_TYPES, MAX_REQUESTS, MAX_POSITIONS, CONCURRENCY_DEFAULT, CONCURRENCY_MAX,
};
