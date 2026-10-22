'use strict';

/**
 * CupNet mini mirror audit: a before/after trail for the `mirror` intercept rule.
 *
 * Every time a mirror rule serves an upstream host (A) under a client host (B), the interceptor
 * hands us the raw upstream body (`before`) and the rewritten body the browser received (`after`).
 * We keep a bounded history in <dataDir>/mirror/history.jsonl, and the two bodies of each entry in
 * <dataDir>/mirror/bodies/<id>.before|.after so the UI can show the diff. Binary responses (images,
 * fonts) are never stored — only the metadata row is kept.
 *
 * The row never carries a proxy URL or any credential; it is pure request/response metadata.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LIMIT = 2000;
const DEFAULT_BODY_MAX = 4 * 1024 * 1024; // per body stored on disk
const PREVIEW_MAX = 400; // inline preview chars in the row

function isTextType(contentType) {
    const ct = String(contentType || '').toLowerCase();
    return ct.startsWith('text/')
        || ct.includes('json')
        || ct.includes('javascript')
        || ct.includes('xml')
        || ct.includes('html')
        || ct === '';
}

function truncate(str, max) {
    const s = String(str == null ? '' : str);
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

class MirrorAudit {
    constructor(opts = {}) {
        this.dir = opts.dir;
        this.historyFile = path.join(this.dir, 'history.jsonl');
        this.bodiesDir = path.join(this.dir, 'bodies');
        this.limit = Number(opts.limit) || DEFAULT_LIMIT;
        this.bodyMax = Number(opts.bodyMaxBytes) || DEFAULT_BODY_MAX;
        this._count = 0;
        try {
            fs.mkdirSync(this.bodiesDir, { recursive: true, mode: 0o700 });
        } catch { /* ignore */ }
        this._count = this._countRows();
    }

    _countRows() {
        try {
            const raw = fs.readFileSync(this.historyFile, 'utf8');
            return raw.split('\n').filter((l) => l.trim()).length;
        } catch {
            return 0;
        }
    }

    /**
     * Record one mirror response. `entry.before` / `entry.after` are Buffers (raw upstream and
     * rewritten bodies). Returns the stored row, or null if it could not be written.
     */
    add(entry) {
        if (!entry || !this.dir) return null;
        const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
        const before = Buffer.isBuffer(entry.before) ? entry.before : Buffer.from(String(entry.before || ''), 'utf8');
        const after = Buffer.isBuffer(entry.after) ? entry.after : Buffer.from(String(entry.after || ''), 'utf8');
        const textable = isTextType(entry.contentType);
        const changed = !before.equals(after);
        let hasBodies = false;
        if (textable && (before.length || after.length) && before.length <= this.bodyMax && after.length <= this.bodyMax) {
            try {
                fs.writeFileSync(path.join(this.bodiesDir, `${id}.before`), before, { mode: 0o600 });
                fs.writeFileSync(path.join(this.bodiesDir, `${id}.after`), after, { mode: 0o600 });
                hasBodies = true;
            } catch {
                hasBodies = false;
            }
        }
        const row = {
            id,
            ts: Number(entry.ts) || Date.now(),
            ruleId: entry.ruleId != null ? String(entry.ruleId) : null,
            ruleName: String(entry.ruleName || ''),
            method: String(entry.method || 'GET'),
            clientHost: String(entry.clientHost || ''),
            upstreamHost: String(entry.upstreamHost || ''),
            clientUrl: String(entry.clientUrl || '/'),
            status: Number(entry.status) || 0,
            contentType: String(entry.contentType || ''),
            hits: Number(entry.hits) || 0,
            rewrote: Boolean(entry.rewrote),
            changed,
            beforeSize: before.length,
            afterSize: after.length,
            hasBodies,
            preview: textable ? truncate(after.toString('utf8'), PREVIEW_MAX) : '',
        };
        try {
            fs.appendFileSync(this.historyFile, `${JSON.stringify(row)}\n`);
            this._count += 1;
        } catch {
            return null;
        }
        if (this._count > this.limit + 200) this._prune();
        return row;
    }

    /** Rewrite history.jsonl down to the newest `limit` rows and drop orphaned body files. */
    _prune() {
        let rows;
        try {
            rows = fs.readFileSync(this.historyFile, 'utf8').split('\n').filter((l) => l.trim());
        } catch {
            return;
        }
        if (rows.length <= this.limit) { this._count = rows.length; return; }
        const keep = rows.slice(rows.length - this.limit);
        const keepIds = new Set();
        for (const line of keep) {
            try { keepIds.add(JSON.parse(line).id); } catch { /* skip */ }
        }
        try {
            fs.writeFileSync(this.historyFile, `${keep.join('\n')}\n`);
            this._count = keep.length;
        } catch { /* ignore */ }
        try {
            for (const name of fs.readdirSync(this.bodiesDir)) {
                const base = name.replace(/\.(before|after)$/, '');
                if (base !== name && !keepIds.has(base)) {
                    try { fs.unlinkSync(path.join(this.bodiesDir, name)); } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
    }

    /** Newest-first page of rows (metadata only). */
    list(opts = {}) {
        const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
        const offset = Math.max(0, Number(opts.offset) || 0);
        let rows;
        try {
            rows = fs.readFileSync(this.historyFile, 'utf8').split('\n').filter((l) => l.trim());
        } catch {
            return { total: 0, items: [] };
        }
        const total = rows.length;
        const slice = rows.slice(Math.max(0, total - offset - limit), total - offset).reverse();
        const items = [];
        for (const line of slice) {
            try { items.push(JSON.parse(line)); } catch { /* skip */ }
        }
        return { total, items };
    }

    /** One row plus its before/after bodies (utf8, capped), for the diff view. */
    get(id) {
        const safe = String(id || '');
        if (!safe || /[^a-z0-9]/i.test(safe)) return null;
        let row = null;
        try {
            const rows = fs.readFileSync(this.historyFile, 'utf8').split('\n').filter((l) => l.trim());
            for (const line of rows) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.id === safe) { row = parsed; break; }
                } catch { /* skip */ }
            }
        } catch {
            return null;
        }
        if (!row) return null;
        const readBody = (suffix) => {
            if (!row.hasBodies) return null;
            try {
                return fs.readFileSync(path.join(this.bodiesDir, `${safe}.${suffix}`)).toString('utf8');
            } catch {
                return null;
            }
        };
        return { ...row, before: readBody('before'), after: readBody('after') };
    }

    /** Erase the whole trail (rows + stored bodies). */
    clear() {
        try { fs.rmSync(this.historyFile, { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(this.bodiesDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.mkdirSync(this.bodiesDir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
        this._count = 0;
    }
}

module.exports = { MirrorAudit, isTextType };
