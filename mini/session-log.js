'use strict';

/**
 * CupNet mini session log: every MITM request (and page events posted to /__cupnet/event) is appended
 * in full — headers and complete bodies, nothing truncated — to <dataDir>/sessions/<sessionId>.jsonl,
 * one JSON object per line.
 *
 * Memory holds only an index: a short summary per entry plus the byte offset/length of its line, so
 * sessions of any size stay cheap. `get(seq)` reads the full entry back from the file. Saved sessions
 * are indexed the same way by `SessionIndex.open(file)`, which scans only the head of each line.
 *
 * Line layout: summary fields first (seq, ts, kind, method, url, status, type, duration, mime, reqSize,
 * resSize), then headers and bodies. The scanner relies on that order to skip big bodies.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SUMMARY_KEYS = ['seq', 'ts', 'kind', 'method', 'url', 'status', 'type', 'duration', 'mime', 'reqSize', 'resSize', 'note'];
/** First key after the summary in each line layout (request / page event). */
const HEAD_CUTS = [',"requestHeaders":', ',"data":'];
const HEAD_SCAN_BYTES = 64 * 1024;
const SCAN_CHUNK = 4 * 1024 * 1024;

function newSessionId(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
        + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Byte size of a logged body (`__b64__:` bodies are binary in base64). */
function bodySize(body) {
    if (body == null) return 0;
    const s = String(body);
    if (s.startsWith('__b64__:')) {
        const n = s.length - 8;
        return Math.max(0, Math.floor(n * 3 / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0));
    }
    return Buffer.byteLength(s, 'utf8');
}

function _headerVal(h, name) {
    if (!h) return '';
    const k = Object.keys(h).find((x) => x.toLowerCase() === name);
    if (!k) return '';
    const v = h[k];
    return String(Array.isArray(v) ? v[0] : v);
}

function _summary(e, off, len) {
    const s = { off, len };
    for (const k of SUMMARY_KEYS) if (e[k] !== undefined) s[k] = e[k];
    return s;
}

/** Summary of one JSONL line from its first bytes, without parsing the bodies. */
function _parseHead(headBuf, fullLen) {
    const text = headBuf.toString('utf8');
    if (headBuf.length >= fullLen) {
        try { return JSON.parse(text); } catch { /* cut below */ }
    }
    for (const cut of HEAD_CUTS) {
        const i = text.indexOf(cut);
        if (i > 0) { try { return JSON.parse(`${text.slice(0, i)}}`); } catch { /* next */ } }
    }
    return null;
}

/** Read-only index over a JSONL session file: summaries + offsets, full entries on demand. */
class SessionIndex {
    constructor(file) {
        this.file = file;
        this.items = [];
        this.bySeq = new Map();
        this.bytes = 0;
    }

    /** Scan `file` (only the first HEAD_SCAN_BYTES of each line are decoded). */
    static open(file) {
        const idx = new SessionIndex(file);
        idx._scanFrom(0);
        return idx;
    }

    /** Index lines appended since the last scan (a running session written by another process). */
    refresh() {
        let size = 0;
        try { size = fs.statSync(this.file).size; } catch { return 0; }
        if (size <= this.bytes) return 0;
        const n = this.items.length;
        this._scanFrom(this.bytes);
        return this.items.length - n;
    }

    _scanFrom(start) {
        const fd = fs.openSync(this.file, 'r');
        try {
            const buf = Buffer.allocUnsafe(SCAN_CHUNK);
            let pos = start;
            let lineStart = start;
            let head = [];
            let headLen = 0;
            for (;;) {
                const n = fs.readSync(fd, buf, 0, SCAN_CHUNK, pos);
                if (n <= 0) break;
                let i = 0;
                while (i < n) {
                    const nl = buf.indexOf(0x0a, i);
                    const end = nl < 0 || nl >= n ? n : nl;
                    if (headLen < HEAD_SCAN_BYTES) {
                        const take = Math.min(end - i, HEAD_SCAN_BYTES - headLen);
                        if (take > 0) { head.push(Buffer.from(buf.subarray(i, i + take))); headLen += take; }
                    }
                    if (end === n) { i = n; break; }
                    const lineEnd = pos + end; // offset of '\n'
                    const len = lineEnd - lineStart;
                    if (len > 0) {
                        let e = _parseHead(Buffer.concat(head, headLen), len);
                        if (!e && len > headLen) e = this._readLine(fd, lineStart, len); // e.g. a URL over 64 KB
                        if (e && Number.isFinite(e.seq)) this._add(_summary(e, lineStart, len));
                    }
                    lineStart = lineEnd + 1;
                    head = []; headLen = 0;
                    i = end + 1;
                }
                pos += n;
            }
            // An unterminated last line is still being written: leave it for the next refresh().
            this.bytes = lineStart;
        } finally {
            fs.closeSync(fd);
        }
    }

    _add(s) {
        this.items.push(s);
        this.bySeq.set(s.seq, s);
    }

    _readLine(fd, off, len) {
        try {
            const buf = Buffer.allocUnsafe(len);
            fs.readSync(fd, buf, 0, len, off);
            return JSON.parse(buf.toString('utf8'));
        } catch { return null; }
    }

    /** Summaries (no headers/bodies, no offsets) with seq > after. */
    list(after = 0, limit = 1000) {
        const out = [];
        // seq grows with the position, so binary-search the start.
        let lo = 0, hi = this.items.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (this.items[mid].seq <= after) lo = mid + 1; else hi = mid; }
        for (let i = lo; i < this.items.length && out.length < limit; i++) {
            const { off, len, ...s } = this.items[i];
            out.push(s);
        }
        return out;
    }

    get count() { return this.items.length; }
    get lastSeq() { return this.items.length ? this.items[this.items.length - 1].seq : 0; }

    /** Full entry for `seq`, read from the file. */
    get(seq) {
        const s = this.bySeq.get(Number(seq));
        if (!s) return null;
        const fd = fs.openSync(this.file, 'r');
        try {
            return this._readLine(fd, s.off, s.len);
        } finally {
            fs.closeSync(fd);
        }
    }
}

/** The running session: appends synchronously (offsets are exact) and emits 'entry' with each summary. */
class SessionLog extends EventEmitter {
    /**
     * @param {{ dir: string, sessionId?: string }} opts - dir = <dataDir>/sessions
     */
    constructor({ dir, sessionId }) {
        super();
        this.setMaxListeners(0);
        this.dir = dir;
        this.sessionId = sessionId || newSessionId();
        this.file = path.join(dir, `${this.sessionId}.jsonl`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this._fd = fs.openSync(this.file, 'a', 0o600);
        this.index = new SessionIndex(this.file);
        this.index.bytes = fs.fstatSync(this._fd).size;
        this._seq = 0;
        this.writeErrors = 0;
        this._append({ kind: 'session-start', sessionId: this.sessionId });
    }

    _append(entry) {
        const full = { seq: ++this._seq, ts: Date.now(), ...entry };
        if (this._fd == null) return full;
        let line;
        try { line = Buffer.from(`${JSON.stringify(full)}\n`, 'utf8'); } catch {
            // A body beyond V8's string limit: keep the entry, mark the body as dropped.
            line = Buffer.from(`${JSON.stringify({ ...full, requestBody: null, responseBody: null, bodyError: 'too large to serialise' })}\n`, 'utf8');
        }
        const off = this.index.bytes;
        try {
            let done = 0;
            while (done < line.length) done += fs.writeSync(this._fd, line, done, line.length - done);
        } catch {
            this.writeErrors++;
            return full;
        }
        this.index.bytes += line.length;
        const s = _summary(full, off, line.length - 1);
        this.index._add(s);
        const { off: _o, len: _l, ...pub } = s;
        this.emit('entry', pub);
        return full;
    }

    /** MitmProxy onRequestLogged payload → log entry (bodies in full). */
    logRequest(e) {
        const requestHeaders = e.requestHeaders || {};
        const responseHeaders = e.responseHeaders || {};
        return this._append({
            kind: 'request',
            method: e.method,
            url: e.url,
            status: e.status,
            type: e.type || null,
            duration: e.duration,
            mime: _headerVal(responseHeaders, 'content-type').split(';')[0].trim() || null,
            reqSize: bodySize(e.requestBody),
            resSize: bodySize(e.responseBody),
            requestHeaders,
            responseHeaders,
            requestBody: e.requestBody ?? null,
            responseBody: e.responseBody ?? null,
        });
    }

    /** Event posted by an injected page script to /__cupnet/event. */
    logPageEvent(pageUrl, data) {
        return this._append({ kind: 'page-event', url: pageUrl, data });
    }

    /** Exit-IP monitor event (start / switch / change / error / recovered); `note` is the one-line summary. */
    logIp(ev) {
        const where = [ev.city, ev.country].filter(Boolean).join(', ');
        const note = ev.type === 'error' ? `IP check failed: ${ev.error || 'error'}`
            : ev.type === 'stop' || ev.type === 'blocked' ? `IP monitor ${ev.type === 'stop' ? 'stopped' : 'blocked'}: ${ev.note || ''}`
            : `${ev.prevIp && ev.prevIp !== ev.ip ? `${ev.prevIp} → ` : ''}${ev.ip}${where ? ` · ${where}` : ''}${ev.label ? ` · ${ev.label}` : ''}`;
        return this._append({ kind: 'ip', type: ev.type, note, data: ev });
    }

    list(after = 0, limit = 1000) { return this.index.list(after, limit); }
    get(seq) { return this.index.get(seq); }
    get count() { return this.index.count; }
    get lastSeq() { return this._seq; }

    close() {
        if (this._fd == null) return Promise.resolve();
        this._append({ kind: 'session-end' });
        try { fs.closeSync(this._fd); } catch { /* ignore */ }
        this._fd = null;
        this.emit('close');
        return Promise.resolve();
    }

    /** Saved sessions in `dir`, newest first. */
    static listSessions(dir) {
        let names = [];
        try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
        return names.map((n) => {
            const st = fs.statSync(path.join(dir, n));
            return { id: n.slice(0, -'.jsonl'.length), bytes: st.size, mtime: st.mtimeMs };
        }).sort((a, b) => b.mtime - a.mtime);
    }
}

module.exports = { SessionLog, SessionIndex, newSessionId, bodySize };
