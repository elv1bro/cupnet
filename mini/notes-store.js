'use strict';

/**
 * CupNet mini notes: markdown notes kept in <dataDir>/notes.json (0600, atomic writes).
 *
 * Note: { id, title, body (markdown), site ('' or a host such as shop.example.com / *.example.com),
 * tags [], pinned, created, updated }. A body may reference logged requests as `cupnet:req/<session>/<seq>`;
 * the UI turns them into links to Traffic.
 */

const fs = require('fs');
const crypto = require('crypto');
const { normalizeHost } = require('./dns-store');

const MAX_NOTES = 5000;
const BODY_MAX = 512 * 1024;
const TITLE_MAX = 200;
const TAG_MAX = 40;
const TAGS_PER_NOTE = 20;
const REF_RE = /cupnet:req\/([\w-]+)\/(\d+)/g;

function _err(message, status = 400) { return Object.assign(new Error(message), { status }); }

function _tags(v) {
    const list = Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/);
    const out = [];
    for (const t of list) {
        const s = String(t || '').trim().replace(/^#/, '').toLowerCase().slice(0, TAG_MAX);
        if (s && !out.includes(s)) out.push(s);
        if (out.length >= TAGS_PER_NOTE) break;
    }
    return out;
}

function _clean(n, prev = null) {
    const body = String(n.body ?? prev?.body ?? '');
    if (body.length > BODY_MAX) throw _err(`A note is limited to ${BODY_MAX / 1024} KB`);
    const siteIn = String(n.site ?? prev?.site ?? '').trim();
    const site = siteIn ? normalizeHost(siteIn.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0]) : '';
    if (siteIn && !site) throw _err('Site must be a host such as shop.example.com or *.example.com');
    const now = Date.now();
    return {
        id: prev?.id || crypto.randomBytes(6).toString('hex'),
        title: String(n.title ?? prev?.title ?? '').trim().slice(0, TITLE_MAX),
        body,
        site,
        tags: n.tags !== undefined ? _tags(n.tags) : (prev?.tags || []),
        pinned: n.pinned != null ? !!n.pinned : !!prev?.pinned,
        created: prev?.created || now,
        updated: now,
    };
}

/** Does a note's site ('' = any) apply to `host`? `*.x` covers x and its subdomains. */
function siteMatches(site, host) {
    const h = String(host || '').toLowerCase();
    if (!site || !h) return false;
    if (site.startsWith('*.')) { const base = site.slice(2); return h === base || h.endsWith(`.${base}`); }
    return h === site;
}

/** `cupnet:req/<session>/<seq>` references in a body. */
function noteRefs(body) {
    const out = [];
    for (const m of String(body || '').matchAll(REF_RE)) out.push({ session: m[1], seq: Number(m[2]) });
    return out;
}

class NotesStore {
    constructor({ file }) {
        this.file = file;
        this.notes = [];
        try {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const n of (Array.isArray(d?.notes) ? d.notes : []).slice(0, MAX_NOTES)) {
                try {
                    const c = _clean(n, { ...n, id: /^[0-9a-f]{12}$/.test(String(n.id)) ? n.id : undefined });
                    c.updated = Number(n.updated) || c.updated;
                    this.notes.push(c);
                } catch { /* skip a broken note */ }
            }
        } catch { this.notes = []; }
    }

    _save() {
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, notes: this.notes })}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    /** Pinned first, then most recently updated. */
    list() {
        return [...this.notes].sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
    }

    get(id) { return this.notes.find((n) => n.id === id) || null; }

    add(n) {
        if (this.notes.length >= MAX_NOTES) throw _err(`At most ${MAX_NOTES} notes`);
        const c = _clean(n || {});
        this.notes.push(c);
        this._save();
        return c;
    }

    update(id, patch) {
        const i = this.notes.findIndex((n) => n.id === id);
        if (i < 0) throw _err('No such note', 404);
        this.notes[i] = _clean(patch || {}, this.notes[i]);
        this._save();
        return this.notes[i];
    }

    remove(id) {
        const n = this.notes.length;
        this.notes = this.notes.filter((x) => x.id !== id);
        if (this.notes.length === n) return false;
        this._save();
        return true;
    }

    forHost(host) { return this.list().filter((n) => siteMatches(n.site, host)); }

    tags() {
        const m = new Map();
        for (const n of this.notes) for (const t of n.tags) m.set(t, (m.get(t) || 0) + 1);
        return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
    }
}

module.exports = { NotesStore, siteMatches, noteRefs };
