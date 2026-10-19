'use strict';

/**
 * CupNet mini session log: every MITM request (and page events posted to /__cupnet/event) is kept in
 * an in-memory ring for the UI and appended to <dataDir>/sessions/<sessionId>.jsonl, one JSON object
 * per line, so a whole session can be reopened or exported later.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RING_MAX = 5000;
const BODY_MAX_CHARS = 512 * 1024;

function newSessionId(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
        + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function _clipBody(body) {
    if (body == null) return null;
    const s = String(body);
    return s.length > BODY_MAX_CHARS ? `${s.slice(0, BODY_MAX_CHARS)}\n…[truncated ${s.length - BODY_MAX_CHARS} chars]` : s;
}

class SessionLog {
    /**
     * @param {{ dir: string, sessionId?: string }} opts - dir = <dataDir>/sessions
     */
    constructor({ dir, sessionId }) {
        this.dir = dir;
        this.sessionId = sessionId || newSessionId();
        this.file = path.join(dir, `${this.sessionId}.jsonl`);
        this._seq = 0;
        this._ring = [];
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this._out = fs.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
        this._out.on('error', () => { /* disk full etc. — the in-memory ring keeps working */ });
        this._append({ kind: 'session-start', sessionId: this.sessionId });
    }

    _append(entry) {
        const full = { seq: ++this._seq, ts: Date.now(), ...entry };
        this._ring.push(full);
        if (this._ring.length > RING_MAX) this._ring.shift();
        try { this._out.write(`${JSON.stringify(full)}\n`); } catch { /* ignore */ }
        return full;
    }

    /** MitmProxy onRequestLogged payload → log entry. */
    logRequest(e) {
        return this._append({
            kind: 'request',
            method: e.method,
            url: e.url,
            status: e.status,
            type: e.type || null,
            duration: e.duration,
            requestHeaders: e.requestHeaders || {},
            responseHeaders: e.responseHeaders || {},
            requestBody: _clipBody(e.requestBody),
            responseBody: _clipBody(e.responseBody),
        });
    }

    /** Event posted by an injected page script to /__cupnet/event. */
    logPageEvent(pageUrl, data) {
        return this._append({ kind: 'page-event', url: pageUrl, data });
    }

    /** Summaries (no headers/bodies) with seq > after. */
    list(after = 0, limit = 500) {
        const out = [];
        for (const e of this._ring) {
            if (e.seq <= after) continue;
            out.push({
                seq: e.seq, ts: e.ts, kind: e.kind, method: e.method, url: e.url,
                status: e.status, type: e.type, duration: e.duration,
            });
            if (out.length >= limit) break;
        }
        return out;
    }

    get(seq) {
        return this._ring.find((e) => e.seq === seq) || null;
    }

    /** Resolves once the JSONL file is flushed (safe to seal it then). */
    close() {
        this._append({ kind: 'session-end' });
        return new Promise((resolve) => {
            try { this._out.end(resolve); } catch { resolve(); }
        });
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

module.exports = { SessionLog, newSessionId };
