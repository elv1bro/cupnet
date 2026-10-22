'use strict';

/**
 * Cross-session search (CupNet mini): finds a text or a regular expression in the URLs, headers and
 * bodies of logged requests and in WebSocket / console messages, across saved session files.
 *
 * The scan runs in a worker thread, so a slow regex or a large session never blocks the UI server and
 * a cancelled search is simply terminated. Literal queries first test the raw JSONL line (cheap) and
 * parse only the lines that can match; regex queries parse every line of the selected kinds.
 *
 * Headers are matched as `name: value` lines. Binary (`__b64__:`) bodies are skipped.
 */

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const QUERY_MAX = 500;
const HITS_DEFAULT = 500;
const HITS_LIMIT = 5000;
const SNIPPET_CTX = 60;
const SNIPPET_HIT_MAX = 160;
const COUNT_MAX = 999;
const READ_CHUNK = 4 * 1024 * 1024;
const PROGRESS_BYTES = 32 * 1024 * 1024;
const TIME_LIMIT_MS = 120 * 1000;
/** Console arguments are stringified for matching up to this many characters. */
const ARGS_TEXT_MAX = 256 * 1024;

const KINDS = ['request', 'ws', 'console'];
const FIELD_GROUPS = {
    url: ['url'],
    headers: ['reqHeaders', 'resHeaders'],
    bodies: ['reqBody', 'resBody', 'message'],
};

function _err(message) {
    const e = new Error(message);
    e.status = 400;
    return e;
}

/**
 * Validate the user's query. Throws a 400 error with a readable message.
 * @param {{ q: string, regex?: boolean, caseSensitive?: boolean }} o
 * @returns {{ source: string, flags: string, prefilter: boolean }}
 */
function compileQuery({ q, regex, caseSensitive }) {
    const text = String(q ?? '');
    if (!text.trim()) throw _err('Type something to search for');
    if (text.length > QUERY_MAX) throw _err(`The query is longer than ${QUERY_MAX} characters`);
    const source = regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = `g${caseSensitive ? '' : 'i'}`;
    let re;
    try { re = new RegExp(source, flags); } catch (e) { throw _err(`Invalid regular expression: ${e.message.replace(/^Invalid regular expression: /, '')}`); }
    if (re.test('')) throw _err('The pattern matches empty text — make it more specific');
    // A raw JSONL line holds a literal unchanged unless JSON escapes it or a header joins name and value.
    const prefilter = !regex && !/["\\\u0000-\u001f]|: /.test(text);
    return { source, flags, prefilter };
}

/** @returns {{ kinds: Set<string>, fields: Set<string> }} */
function _scope({ kinds, fields } = {}) {
    const k = new Set((Array.isArray(kinds) && kinds.length ? kinds : KINDS).filter((x) => KINDS.includes(x)));
    const f = new Set();
    for (const g of Array.isArray(fields) && fields.length ? fields : Object.keys(FIELD_GROUPS)) for (const x of FIELD_GROUPS[g] || []) f.add(x);
    if (!k.size) throw _err('Pick at least one kind of entry');
    if (!f.size) throw _err('Pick at least one place to search in');
    return { kinds: k, fields: f };
}

// ── worker side ──

const _isBinary = (s) => typeof s === 'string' && s.startsWith('__b64__:');
const _text = (v) => (v == null || _isBinary(v) ? '' : String(v));

function _hdrText(h) {
    if (!h || typeof h !== 'object') return '';
    const out = [];
    for (const [k, v] of Object.entries(h)) for (const x of Array.isArray(v) ? v : [v]) out.push(`${k}: ${x}`);
    return out.join('\n');
}

/** Searchable text of one entry, by field. */
function _fields(e, want) {
    const f = {};
    if (want.has('url') && e.url) f.url = String(e.url);
    if (e.kind === 'request') {
        if (want.has('reqHeaders')) f.reqHeaders = _hdrText(e.requestHeaders);
        if (want.has('resHeaders')) f.resHeaders = _hdrText(e.responseHeaders);
        if (want.has('reqBody')) f.reqBody = _text(e.requestBody);
        if (want.has('resBody')) f.resBody = _text(e.responseBody);
    } else if (want.has('message')) {
        if (e.kind === 'ws') {
            f.message = _text(e.data?.body);
            if (e.data?.reason) f.message += `${f.message ? '\n' : ''}${e.data.reason}`;
        } else if (e.kind === 'console') {
            const parts = [String(e.data?.text ?? e.note ?? '')];
            if (e.data?.args) { try { parts.push(JSON.stringify(e.data.args).slice(0, ARGS_TEXT_MAX)); } catch { /* cyclic */ } }
            if (e.data?.stack) parts.push(String(e.data.stack));
            f.message = parts.filter(Boolean).join('\n');
        }
    }
    return f;
}

const _flat = (s) => s.replace(/\s+/g, ' ');

/** First match of `re` in `text` with context, and how many matches there are (capped). */
function _matchField(re, text) {
    if (!text) return null;
    re.lastIndex = 0;
    let first = null;
    let count = 0;
    for (let m; (m = re.exec(text));) {
        if (!first) first = { i: m.index, len: m[0].length };
        if (++count >= COUNT_MAX) break;
        if (m[0].length === 0) re.lastIndex++;
    }
    if (!first) return null;
    const a = Math.max(0, first.i - SNIPPET_CTX);
    const z = Math.min(text.length, first.i + first.len + SNIPPET_CTX);
    return {
        count,
        pre: `${a > 0 ? '…' : ''}${_flat(text.slice(a, first.i)).trimStart()}`,
        hit: _flat(text.slice(first.i, first.i + Math.min(first.len, SNIPPET_HIT_MAX))),
        post: `${_flat(text.slice(first.i + first.len, z)).trimEnd()}${z < text.length ? '…' : ''}`,
        at: first.i,
    };
}

function _hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** Complete lines of `file` up to `end` (an unterminated last line is still being written). */
function* _lines(file, end) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(READ_CHUNK);
        let pos = 0;
        let parts = [];
        while (pos < end) {
            const n = fs.readSync(fd, buf, 0, Math.min(READ_CHUNK, end - pos), pos);
            if (n <= 0) break;
            let i = 0;
            for (;;) {
                const nl = buf.indexOf(0x0a, i);
                if (nl < 0 || nl >= n) { parts.push(Buffer.from(buf.subarray(i, n))); break; }
                parts.push(buf.subarray(i, nl));
                const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
                parts = [];
                if (line.length) yield line.toString('utf8');
                i = nl + 1;
            }
            pos += n;
            yield pos; // a chunk boundary: bytes read so far, for progress
        }
    } finally {
        fs.closeSync(fd);
    }
}

/** The scan itself (worker thread). Posts { type: 'session' | 'hit' | 'progress' | 'done' | 'error' }. */
function _run(job, post) {
    const re = new RegExp(job.query.source, job.query.flags);
    const pre = job.query.prefilter ? new RegExp(job.query.source, job.query.flags.replace('g', '')) : null;
    const want = new Set(job.fields);
    const kinds = new Set(job.kinds);
    const host = String(job.host || '').trim().toLowerCase();
    const t0 = Date.now();
    let hits = 0;
    let before = 0; // bytes of the sessions already scanned
    let lastReport = 0;
    let truncated = false;
    let timedOut = false;
    let scanned = 0;
    for (const s of job.sessions) {
        let end = 0;
        try { end = fs.statSync(s.file).size; } catch { continue; }
        post({ type: 'session', id: s.id, bytes: end, mtime: s.mtime });
        let n = 0;
        for (const line of _lines(s.file, end)) {
            if (typeof line === 'number') {
                const bytes = before + line;
                if (bytes - lastReport >= PROGRESS_BYTES) { lastReport = bytes; post({ type: 'progress', id: s.id, bytes, ms: Date.now() - t0 }); }
                if (Date.now() - t0 > TIME_LIMIT_MS) { timedOut = true; break; }
                continue;
            }
            if (pre && !pre.test(line)) continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            if (!Number.isFinite(e.seq) || !kinds.has(e.kind)) continue;
            if (host) {
                const hh = _hostOf(e.url);
                if (!hh.includes(host)) continue;
            }
            const matches = [];
            const f = _fields(e, want);
            for (const k of ['url', 'reqHeaders', 'reqBody', 'resHeaders', 'resBody', 'message']) {
                const r = f[k] != null ? _matchField(re, f[k]) : null;
                if (r) matches.push({ field: k, ...r });
            }
            if (!matches.length) continue;
            post({
                type: 'hit',
                hit: {
                    session: s.id, seq: e.seq, ts: e.ts, kind: e.kind, method: e.method, url: e.url ? String(e.url).slice(0, 2000) : undefined,
                    status: e.status, type: e.type, mime: e.mime, ws: e.ws, dir: e.dir,
                    matches,
                },
            });
            n++;
            if (++hits >= job.limit) { truncated = true; break; }
        }
        before += end;
        scanned++;
        post({ type: 'progress', id: s.id, bytes: before, ms: Date.now() - t0, sessionHits: n });
        if (truncated || timedOut) break;
    }
    post({ type: 'done', hits, bytes: before, scanned, sessions: job.sessions.length, truncated, timedOut, ms: Date.now() - t0 });
}

if (!isMainThread && workerData?.cupnetSessionSearch) {
    try {
        _run(workerData.job, (m) => parentPort.postMessage(m));
    } catch (e) {
        parentPort.postMessage({ type: 'error', error: e?.message || String(e) });
    }
}

// ── main-thread API ──

/**
 * Start a search. Validation errors throw synchronously (status 400).
 * @param {{ sessionsDir: string, sessions: { id: string, mtime?: number }[], q: string, regex?: boolean,
 *   caseSensitive?: boolean, kinds?: string[], fields?: string[], host?: string, limit?: number,
 *   onEvent: (ev: object) => void }} o
 * @returns {{ stop: () => void, done: Promise<void> }}
 */
function startSearch(o) {
    const query = compileQuery(o);
    const { kinds, fields } = _scope(o);
    const sessions = [];
    for (const s of o.sessions || []) {
        if (!/^[\w-]+$/.test(String(s.id || ''))) continue;
        sessions.push({ id: s.id, mtime: s.mtime, file: path.join(o.sessionsDir, `${s.id}.jsonl`) });
    }
    if (!sessions.length) throw _err('No sessions to search');
    const limit = Math.min(HITS_LIMIT, Math.max(1, Math.floor(Number(o.limit)) || HITS_DEFAULT));
    const job = { query, kinds: [...kinds], fields: [...fields], host: String(o.host || '').slice(0, 253), limit, sessions };
    const worker = new Worker(__filename, { workerData: { cupnetSessionSearch: true, job } });
    let finished = false;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    /** Report `ev` (unless stopped), end the worker and settle `done` — once. */
    const end = (ev) => {
        if (finished) return;
        finished = true;
        if (ev) o.onEvent(ev);
        worker.terminate().catch(() => {});
        resolveDone();
    };
    worker.on('message', (m) => {
        if (finished) return;
        if (m?.type === 'done' || m?.type === 'error') end(m); else o.onEvent(m);
    });
    worker.on('error', (e) => end({ type: 'error', error: e?.message || String(e) }));
    worker.on('exit', () => end({ type: 'error', error: 'search stopped' }));
    return { stop: () => end(null), done };
}

module.exports = { startSearch, compileQuery, KINDS, FIELD_GROUPS, HITS_LIMIT };
