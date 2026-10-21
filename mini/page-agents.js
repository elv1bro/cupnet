'use strict';

/**
 * Live pages that run the CupNet mini page agent (mini/page-agent.js), and the command channel to them.
 *
 * The agent reaches us only through `/__cupnet/agent/*` on its own origin, answered by the MITM
 * (MiniApp._handleLocalEndpoint). Any website can call those paths, so:
 *  - a document id is a random 96-bit value made in the page; a command for it is handed only to
 *    polls from the same origin, and a result is accepted only from that origin;
 *  - nothing the agent endpoints return contains logged data (commands are the user's own input);
 *  - the registry is capped and forgets pages that stop polling.
 */

const crypto = require('crypto');

const MAX_DOCS = 300;
/** A page that has not polled for this long is shown as gone, and dropped after DOC_DROP_MS. */
const DOC_STALE_MS = 45 * 1000;
const DOC_DROP_MS = 10 * 60 * 1000;
const MAX_QUEUE = 20;
/** Poll interval while the Console / Analyzer page is open in the UI, and otherwise. */
const POLL_WATCHED_MS = 1000;
const POLL_IDLE_MS = 10 * 1000;
const WATCH_TTL_MS = 20 * 1000;
const DOC_ID_RE = /^[0-9a-f]{16,32}$/;

function _origin(url) {
    try { return new URL(url).origin; } catch { return ''; }
}

class PageAgents {
    constructor() {
        /** @type {Map<string, object>} doc id → page */
        this.docs = new Map();
        /** cmd id → { doc, resolve, reject, timer } */
        this._waiting = new Map();
        this._watchUntil = 0;
    }

    /** The UI's Console / Analyzer page is open: agents poll fast for a while. */
    watch() { this._watchUntil = Date.now() + WATCH_TTL_MS; }
    get watched() { return Date.now() < this._watchUntil; }

    /**
     * Register or refresh a page from an agent request.
     * @param {string} origin - origin of the request URL (the MITM saw it; the page cannot fake it)
     * @param {{ doc?: string, url?: string, title?: string, frame?: number, referrer?: string, vis?: number }} b
     */
    touch(origin, b) {
        const id = String(b?.doc || '');
        if (!DOC_ID_RE.test(id) || !origin) return null;
        let d = this.docs.get(id);
        if (d && d.origin !== origin) return null; // another site reusing an id it saw
        const url = typeof b.url === 'string' && _origin(b.url) === origin ? b.url.slice(0, 4000) : (d?.url || `${origin}/`);
        const now = Date.now();
        if (!d) {
            this._evict();
            d = { id, origin, url, title: '', frame: 0, referrer: '', firstSeen: now, lastSeen: now, visible: true, queue: [], console: 0, errors: 0, warnings: 0 };
            this.docs.set(id, d);
        }
        d.url = url;
        if (typeof b.title === 'string') d.title = b.title.slice(0, 300);
        if (b.frame != null) d.frame = b.frame ? 1 : 0;
        if (typeof b.referrer === 'string' && b.referrer) d.referrer = b.referrer.slice(0, 2000);
        if (b.vis != null) d.visible = !!b.vis;
        d.lastSeen = now;
        return d;
    }

    _evict() {
        const now = Date.now();
        for (const [id, d] of this.docs) if (now - d.lastSeen > DOC_DROP_MS) this._drop(id);
        if (this.docs.size < MAX_DOCS) return;
        const oldest = [...this.docs.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (oldest) this._drop(oldest.id);
    }

    _drop(id) {
        const d = this.docs.get(id);
        if (!d) return;
        this.docs.delete(id);
        for (const [cid, w] of this._waiting) if (w.doc === id) { clearTimeout(w.timer); this._waiting.delete(cid); w.reject(Object.assign(new Error('The page is gone'), { status: 410 })); }
    }

    /** Agent poll → commands queued for this document and the next poll delay. */
    poll(origin, b) {
        const d = this.touch(origin, b);
        if (!d) return null;
        const cmds = d.queue.splice(0, d.queue.length);
        return { next: this.watched ? POLL_WATCHED_MS : POLL_IDLE_MS, cmds };
    }

    /** Agent answer to one command. */
    result(origin, b) {
        const id = String(b?.id || '');
        const w = this._waiting.get(id);
        if (!w) return false;
        const d = this.docs.get(w.doc);
        if (!d || d.origin !== origin || String(b.doc) !== d.id) return false;
        clearTimeout(w.timer);
        this._waiting.delete(id);
        d.lastSeen = Date.now();
        const { doc: _d, id: _i, ...rest } = b;
        w.resolve(rest);
        return true;
    }

    /** Count console entries per page (for the page list). */
    noteConsole(d, items) {
        for (const it of items) {
            d.console++;
            if (it.sev === 'error') d.errors++;
            else if (it.sev === 'warn') d.warnings++;
        }
    }

    /**
     * Queue a command for a page and wait for its answer.
     * @returns {Promise<object>} the agent's result (ok, value/text/report…)
     */
    command(docId, cmd, timeoutMs = 15000) {
        const d = this.docs.get(String(docId));
        if (!d) return Promise.reject(Object.assign(new Error('No such page (reload it with the page agent on)'), { status: 404 }));
        if (d.queue.length >= MAX_QUEUE) return Promise.reject(Object.assign(new Error('Too many pending commands for this page'), { status: 429 }));
        const id = crypto.randomBytes(8).toString('hex');
        this.watch();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._waiting.delete(id);
                const i = d.queue.findIndex((c) => c.id === id);
                if (i >= 0) d.queue.splice(i, 1);
                reject(Object.assign(new Error(Date.now() - d.lastSeen > DOC_STALE_MS
                    ? 'The page stopped answering (closed, navigated away or frozen in a background tab)'
                    : 'The page did not answer in time'), { status: 504 }));
            }, timeoutMs);
            this._waiting.set(id, { doc: d.id, resolve, reject, timer });
            d.queue.push({ ...cmd, id });
        });
    }

    get(id) { return this.docs.get(String(id)) || null; }

    /** Pages for the UI, live ones first, newest first. */
    list() {
        const now = Date.now();
        return [...this.docs.values()]
            .map((d) => ({
                id: d.id, origin: d.origin, url: d.url, title: d.title, frame: d.frame, referrer: d.referrer,
                firstSeen: d.firstSeen, lastSeen: d.lastSeen, visible: d.visible,
                live: now - d.lastSeen < DOC_STALE_MS, pending: d.queue.length,
                console: d.console, errors: d.errors, warnings: d.warnings,
            }))
            .sort((a, b) => (b.live - a.live) || (a.frame - b.frame) || (b.lastSeen - a.lastSeen));
    }

    clear() {
        for (const id of [...this.docs.keys()]) this._drop(id);
    }
}

module.exports = { PageAgents, DOC_ID_RE, POLL_WATCHED_MS, POLL_IDLE_MS };
