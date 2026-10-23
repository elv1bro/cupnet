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
 * resSize, dns, note, sev, src, doc, g, ws, dir, inj), then headers and bodies (or `data`). The scanner relies on that order to skip big bodies.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SUMMARY_KEYS = ['seq', 'ts', 'kind', 'method', 'url', 'status', 'type', 'duration', 'mime', 'reqSize', 'resSize', 'dns', 'note', 'sev', 'src', 'doc', 'g', 'ws', 'dir', 'inj', 'rid'];
/** WebSocket message preview kept in the summary (the payload is in `data.body`). */
const WS_NOTE_MAX = 300;
/** Console text kept in the summary (the full message and its arguments are in `data`). */
const CONSOLE_NOTE_MAX = 500;
const CONSOLE_SEVS = new Set(['error', 'warn', 'info', 'verbose']);
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

/** Ping/pong payload as text when it is printable, else hex. */
function _utf8Preview(buf) {
    const t = buf.toString('utf8');
    return /^[\x20-\x7e]*$/.test(t) ? t.slice(0, 60) : buf.subarray(0, 30).toString('hex');
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
            // Imported entries carry their original timestamp; live MITM logging leaves it to _append.
            ...(Number.isFinite(e.ts) ? { ts: e.ts } : {}),
            kind: 'request',
            method: e.method,
            url: e.url,
            status: e.status,
            type: e.type || null,
            duration: e.duration,
            mime: _headerVal(responseHeaders, 'content-type').split(';')[0].trim() || null,
            reqSize: bodySize(e.requestBody),
            resSize: bodySize(e.responseBody),
            dns: e.dnsOverride?.ip ? {
                host: e.dnsOverride.host, ip: e.dnsOverride.ip, ...(e.dnsOverride.id ? { id: e.dnsOverride.id } : {}),
            } : undefined,
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

    /**
     * One console message from the page agent (or a Console command / result). Summary: type = level
     * (log, warn, error, exception, csp, command, result…), note = text, sev, src (file:line), doc (page id),
     * g (group depth). Arguments, stack and the full text go to `data`.
     * @param {string} pageUrl
     * @param {{ lvl?: string, text?: string, src?: string, sev?: string, g?: number, args?: any[], stack?: string, t?: number, collapsed?: boolean }} it
     * @param {string} [docId]
     * @param {number} [frame] - 1 when the page is an iframe
     */
    logConsole(pageUrl, it, docId, frame) {
        const text = String(it?.text ?? '');
        const lvl = String(it?.lvl || 'log').replace(/[^\w-]/g, '').slice(0, 24) || 'log';
        const data = { text: text.length > CONSOLE_NOTE_MAX ? text : undefined };
        if (Array.isArray(it?.args) && it.args.length) data.args = it.args;
        if (it?.stack) data.stack = String(it.stack).slice(0, 16000);
        if (Number.isFinite(it?.t)) data.t = it.t;
        if (it?.collapsed) data.collapsed = true;
        if (frame) data.frame = 1;
        if (it?.value !== undefined) data.value = it.value;
        return this._append({
            kind: 'console',
            type: lvl,
            url: String(pageUrl || '').slice(0, 4000),
            note: text.slice(0, CONSOLE_NOTE_MAX),
            sev: CONSOLE_SEVS.has(it?.sev) ? it.sev : 'info',
            src: it?.src ? String(it.src).slice(0, 500) : undefined,
            doc: docId || undefined,
            g: Number(it?.g) > 0 ? Math.min(32, Math.floor(Number(it.g))) : undefined,
            data,
        });
    }

    /** Exit-IP monitor event (start / switch / change / error / recovered); `note` is the one-line summary. */
    logIp(ev) {
        const where = [ev.city, ev.country].filter(Boolean).join(', ');
        const note = ev.type === 'error' ? `IP check failed: ${ev.error || 'error'}`
            : ev.type === 'stop' || ev.type === 'blocked' ? `IP monitor ${ev.type === 'stop' ? 'stopped' : 'blocked'}: ${ev.note || ''}`
            : `${ev.prevIp && ev.prevIp !== ev.ip ? `${ev.prevIp} → ` : ''}${ev.ip}${where ? ` · ${where}` : ''}${ev.label ? ` · ${ev.label}` : ''}`;
        return this._append({ kind: 'ip', type: ev.type, note, data: ev });
    }

    /**
     * One WebSocket message (or the end of a connection: type 'end'). Summary: ws = seq of the upgrade
     * request, dir = 'out' (page → server) | 'in', type = text/binary/close/ping/pong, resSize = payload
     * bytes on the wire, note = preview, inj = 1 when CupNet sent it. Payload in `data.body`
     * (`__b64__:` for binary).
     * @param {number} wsId
     * @param {{ dir: string, type: string, data?: Buffer, size?: number, ts?: number, url?: string, compressed?: boolean,
     *   truncated?: boolean, injected?: boolean, code?: number, reason?: string, inflateError?: string, note?: string }} m
     */
    logWs(wsId, m) {
        const buf = Buffer.isBuffer(m.data) ? m.data : Buffer.from(String(m.data ?? ''), 'utf8');
        const text = m.type === 'text' || m.type === 'close' && !m.code ? buf.toString('utf8') : null;
        const note = m.note != null ? String(m.note)
            : m.type === 'close' ? `close${m.code ? ` ${m.code}` : ''}${m.reason ? ` ${m.reason}` : ''}`
            : m.type === 'text' && !m.inflateError ? text.slice(0, WS_NOTE_MAX).replace(/\s+/g, ' ')
            : m.type === 'ping' || m.type === 'pong' ? `${m.type}${buf.length ? ` ${_utf8Preview(buf)}` : ''}`
            : `binary ${buf.length.toLocaleString('en-US')} bytes`;
        const data = { body: text != null && !m.inflateError ? text : buf.length ? `__b64__:${buf.toString('base64')}` : '' };
        if (m.compressed) data.compressed = true;
        if (m.truncated) data.truncated = true;
        if (m.inflateError) data.inflateError = m.inflateError;
        if (m.code) { data.code = m.code; data.reason = m.reason || ''; }
        return this._append({
            ...(Number.isFinite(m.ts) ? { ts: m.ts } : {}),
            kind: 'ws',
            url: m.url ? String(m.url).slice(0, 4000) : undefined,
            type: m.type,
            resSize: Number.isFinite(m.size) ? m.size : buf.length,
            note: note.slice(0, WS_NOTE_MAX),
            ws: wsId,
            dir: m.dir === 'in' ? 'in' : m.dir === 'out' ? 'out' : undefined,
            inj: m.injected ? 1 : undefined,
            data,
        });
    }

    /**
     * One intercept-rule match (block / mock / modifyHeaders / script / inject / delay / breakpoint).
     * Summary: type = rule action, note = rule name, rid = rule id, url = the rule's url_pattern,
     * sev = 'error' when the rule last failed. Details (pattern, group, priority, hit count) go to `data`.
     * @param {{ id?: number, name?: string, type?: string, url_pattern?: string, group_name?: string,
     *   priority?: number, hit_count?: number, last_error?: string }} rule
     */
    logRule(rule) {
        const name = String(rule?.name || '').trim() || `rule #${rule?.id ?? '?'}`;
        return this._append({
            kind: 'rule',
            type: String(rule?.type || '').slice(0, 40) || null,
            note: name.slice(0, 300),
            rid: Number.isFinite(rule?.id) ? rule.id : undefined,
            url: rule?.url_pattern ? String(rule.url_pattern).slice(0, 4000) : undefined,
            sev: rule?.last_error ? 'error' : 'info',
            data: {
                pattern: rule?.url_pattern || '',
                group: rule?.group_name || undefined,
                priority: Number(rule?.priority) || 0,
                hitCount: Number(rule?.hit_count) || undefined,
                error: rule?.last_error || undefined,
            },
        });
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
