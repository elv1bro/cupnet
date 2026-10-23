'use strict';

/**
 * CupNet mini intercept rules in a JSON file (<dataDir>/rules.json) instead of SQLite, so mini runs on
 * plain Node without better-sqlite3/Electron. Implements the part of db.js that request-interceptor.js
 * and the mini UI use (see request-interceptor `setRuleStore`), with the same row shape and order.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const FLUSH_DELAY_MS = 1000;

function _normalize(rule, prev = {}) {
    const method = rule.method != null && String(rule.method).trim() !== '' ? String(rule.method).trim() : '*';
    let tags = rule.tags ?? null;
    if (typeof tags === 'string') tags = tags.split(',').map((s) => s.trim()).filter(Boolean);
    return {
        id: prev.id,
        name: String(rule.name || ''),
        enabled: rule.enabled !== false,
        url_pattern: String(rule.url_pattern || ''),
        type: String(rule.type || ''),
        params: rule.params && typeof rule.params === 'object' ? rule.params : {},
        priority: Number(rule.priority) || 0,
        method,
        group_name: rule.group_name != null && String(rule.group_name).trim() !== '' ? String(rule.group_name).trim() : null,
        hit_count: prev.hit_count || 0,
        last_hit_at: prev.last_hit_at || null,
        delay_ms: Math.max(0, Math.min(60000, Number(rule.delay_ms) || 0)),
        tags,
        last_error: prev.last_error || null,
        stop_on_match: rule.stop_on_match !== false,
        breakpoint_enabled: !!rule.breakpoint_enabled,
        created_at: prev.created_at || new Date().toISOString(),
    };
}

class RuleStore extends EventEmitter {
    /** @param {string} file - rules.json */
    constructor(file) {
        super();
        this.setMaxListeners(0);
        this.file = file;
        this._rules = [];
        this._nextId = 1;
        this._timer = null;
        this._load();
    }

    _load() {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* new store */ }
        const rules = Array.isArray(j?.rules) ? j.rules : [];
        this._rules = rules.filter((r) => r && Number.isInteger(r.id)).map((r) => ({ ..._normalize(r, r), id: r.id }));
        this._nextId = Math.max(Number(j?.nextId) || 1, ...this._rules.map((r) => r.id + 1));
    }

    /** Write now (atomic rename). Hit counters are batched; edits call this directly. */
    flush() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, nextId: this._nextId, rules: this._rules }, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    _flushSoon() {
        if (this._timer) return;
        this._timer = setTimeout(() => { this._timer = null; try { this.flush(); } catch { /* retried on next change */ } }, FLUSH_DELAY_MS);
        this._timer.unref?.();
    }

    _find(id) { return this._rules.find((r) => r.id === Number(id)) || null; }

    getAllInterceptRules() {
        return this._rules
            .slice()
            .sort((a, b) => (b.priority - a.priority) || (a.id - b.id))
            .map((r) => JSON.parse(JSON.stringify(r)));
    }

    getInterceptRules() {
        return this.getAllInterceptRules().filter((r) => r.enabled);
    }

    saveInterceptRule(rule) {
        const prev = rule.id != null ? this._find(rule.id) : null;
        if (prev) {
            Object.assign(prev, _normalize(rule, prev));
        } else {
            const r = _normalize(rule, { id: this._nextId++ });
            this._rules.push(r);
        }
        this.flush();
        return prev ? prev.id : this._nextId - 1;
    }

    deleteInterceptRule(id) {
        const n = this._rules.length;
        this._rules = this._rules.filter((r) => r.id !== Number(id));
        if (this._rules.length !== n) this.flush();
    }

    incrementInterceptRuleHit(id) {
        const r = this._find(id);
        if (!r) return;
        r.hit_count = (r.hit_count || 0) + 1;
        r.last_hit_at = new Date().toISOString();
        r.last_error = null;
        this._flushSoon();
        // The Activity feed logs each match; the row is a shallow copy so a later edit can't mutate it.
        if (this.listenerCount('hit')) { try { this.emit('hit', { ...r }); } catch { /* never block interception */ } }
    }

    setInterceptRuleError(id, errText) {
        const r = this._find(id);
        if (!r) return;
        r.last_error = errText != null && String(errText).trim() !== '' ? String(errText).slice(0, 2000) : null;
        this._flushSoon();
        if (r.last_error && this.listenerCount('hit')) { try { this.emit('hit', { ...r }); } catch { /* never block interception */ } }
    }

    incrementInterceptRuleHitAsync(id) { this.incrementInterceptRuleHit(id); return Promise.resolve(); }
    setInterceptRuleErrorAsync(id, errText) { this.setInterceptRuleError(id, errText); return Promise.resolve(); }

    close() {
        if (this._timer) { try { this.flush(); } catch { /* ignore */ } }
    }

    /**
     * One-time import from the old SQLite store (<dataDir>/cupnet-mini.db), when Node has node:sqlite.
     * @returns {number} rules imported
     */
    importFromSqlite(dbFile) {
        if (this._rules.length || !fs.existsSync(dbFile)) return 0;
        let DatabaseSync;
        try { ({ DatabaseSync } = require('node:sqlite')); } catch { return 0; }
        let rows = [];
        try {
            const sdb = new DatabaseSync(dbFile, { readOnly: true });
            try { rows = sdb.prepare('SELECT * FROM intercept_rules ORDER BY id').all(); } finally { sdb.close(); }
        } catch { return 0; }
        for (const row of rows) {
            let params = {};
            try { params = JSON.parse(row.params || '{}'); } catch { /* keep {} */ }
            let tags = row.tags;
            if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { /* comma list */ } }
            const r = _normalize({
                ...row, params, tags, enabled: !!row.enabled,
                stop_on_match: row.stop_on_match !== 0, breakpoint_enabled: !!row.breakpoint_enabled,
            }, { id: Number(row.id), hit_count: row.hit_count, last_hit_at: row.last_hit_at, created_at: row.created_at });
            this._rules.push(r);
        }
        this._nextId = Math.max(1, ...this._rules.map((r) => r.id + 1));
        if (rows.length) this.flush();
        return rows.length;
    }
}

module.exports = { RuleStore };
