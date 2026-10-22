'use strict';

/**
 * CupNet mini DNS overrides: host → IP rules kept in <dataDir>/dns.json and applied by the MITM in dial
 * mode (mitm-proxy.js setDnsOverrides { dial, wildcards }): the request keeps its URL, so SNI, Host and
 * HTTP/2 stay those of the real host and only the TCP connection goes to the override address. TLS
 * passthrough tunnels follow the same rules.
 *
 * Rule: { id, host ('api.example.com' or '*.example.com' — subdomains and the domain itself), ip (IPv4 or
 * IPv6), enabled, rewriteHost (send another Host header; forces HTTP/1.1), cors (MITM CORS headers on
 * responses of that host), note, created, updated }. Hit counters and the activity list are in memory
 * (since start); the session log keeps every overridden request (`dns` on the entry).
 */

const fs = require('fs');
const net = require('net');
const url = require('url');
const crypto = require('crypto');

const MAX_RULES = 2000;
const ACTIVITY_MAX = 500;
const HOST_RE = /^(\*\.)?[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const REWRITE_RE = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?(:\d{1,5})?$/i;

function _err(message, status = 400) { return Object.assign(new Error(message), { status }); }

/** 'API.Example.com.' → 'api.example.com'; IDN → punycode; '' when it is not a host pattern. */
function normalizeHost(v) {
    let s = String(v ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!s) return '';
    const wild = s.startsWith('*.');
    if (wild) s = s.slice(2);
    if (/[^\x00-\x7f]/.test(s)) s = url.domainToASCII(s) || '';
    if (!s || net.isIP(s)) return '';
    const out = (wild ? '*.' : '') + s;
    return HOST_RE.test(out) && out.length <= 253 ? out : '';
}

/** Canonical IP string or ''. IPv4 must be dotted-quad without leading zeros (A-240). */
function normalizeIp(v) {
    const s = String(v ?? '').trim().replace(/^\[|\]$/g, '');
    if (net.isIPv4(s)) return s;
    if (net.isIPv6(s)) return s.toLowerCase();
    return '';
}

function _clean(r, prev = null) {
    const host = normalizeHost(r.host ?? prev?.host);
    if (!host) throw _err('Host must be a hostname such as api.example.com or *.example.com');
    const ip = normalizeIp(r.ip ?? prev?.ip);
    if (!ip) throw _err('IP must be an IPv4 or IPv6 address');
    const rw = String(r.rewriteHost ?? prev?.rewriteHost ?? '').trim();
    if (rw && !REWRITE_RE.test(rw)) throw _err('Rewrite Host must be a hostname (optionally :port)');
    const now = Date.now();
    return {
        id: prev?.id || crypto.randomBytes(6).toString('hex'),
        host,
        ip,
        enabled: r.enabled != null ? !!r.enabled : (prev ? prev.enabled : true),
        rewriteHost: rw || null,
        cors: r.cors != null ? !!r.cors : !!prev?.cors,
        note: String(r.note ?? prev?.note ?? '').slice(0, 500),
        created: prev?.created || now,
        updated: now,
    };
}

/**
 * hosts-file text → [{ ip, host, note }]. `#` starts a comment; a comment after a rule becomes its note.
 * A line may carry several hosts. A line starting with `# off:` imports a disabled rule.
 */
function parseHosts(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        let line = raw.trim();
        let enabled = true;
        const off = /^#\s*off:\s*(.*)$/i.exec(line);
        if (off) { line = off[1]; enabled = false; }
        const hash = line.indexOf('#');
        const note = hash >= 0 ? line.slice(hash + 1).trim() : '';
        const body = (hash >= 0 ? line.slice(0, hash) : line).trim();
        if (!body) continue;
        const [ip, ...hosts] = body.split(/\s+/);
        if (!normalizeIp(ip)) continue;
        for (const h of hosts) out.push({ ip, host: h, note, enabled });
    }
    return out;
}

class DnsStore {
    /** @param {{ file: string }} o */
    constructor({ file }) {
        this.file = file;
        this.rules = [];
        /** id → { count, last } since start */
        this.hits = new Map();
        /** Newest last: { at, ruleId, host, ip, url, method, status, seq } */
        this.activity = [];
        this._load();
    }

    _load() {
        try {
            const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const list = Array.isArray(d?.rules) ? d.rules : [];
            const seen = new Set();
            for (const r of list.slice(0, MAX_RULES)) {
                try {
                    const c = _clean(r, { ...r, id: /^[0-9a-f]{12}$/.test(String(r.id)) ? r.id : undefined });
                    c.updated = Number(r.updated) || c.updated;
                    if (seen.has(c.host)) continue;
                    seen.add(c.host);
                    this.rules.push(c);
                } catch { /* skip a broken rule */ }
            }
        } catch { this.rules = []; }
    }

    _save() {
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, rules: this.rules }, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    list() {
        return this.rules.map((r) => ({ ...r, hits: this.hits.get(r.id)?.count || 0, lastHit: this.hits.get(r.id)?.last || null }));
    }

    get(id) { return this.rules.find((r) => r.id === id) || null; }

    _dupe(host, exceptId) {
        if (this.rules.some((r) => r.host === host && r.id !== exceptId)) throw _err(`A rule for ${host} already exists`, 409);
    }

    add(r) {
        if (this.rules.length >= MAX_RULES) throw _err(`At most ${MAX_RULES} rules`);
        const c = _clean(r || {});
        this._dupe(c.host);
        this.rules.push(c);
        this._save();
        return c;
    }

    update(id, patch) {
        const i = this.rules.findIndex((r) => r.id === id);
        if (i < 0) throw _err('No such rule', 404);
        const c = _clean(patch || {}, this.rules[i]);
        this._dupe(c.host, id);
        this.rules[i] = c;
        this._save();
        return c;
    }

    remove(id) {
        const n = this.rules.length;
        this.rules = this.rules.filter((r) => r.id !== id);
        if (this.rules.length === n) return false;
        this.hits.delete(id);
        this._save();
        return true;
    }

    /** @returns {{ added: number, updated: number, skipped: number }} */
    importHosts(text, { replace = false } = {}) {
        const parsed = parseHosts(text);
        if (replace) this.rules = [];
        let added = 0, updated = 0, skipped = 0;
        for (const p of parsed) {
            const host = normalizeHost(p.host);
            if (!host || host === 'localhost' || host === 'broadcasthost') { skipped++; continue; }
            const prev = this.rules.find((r) => r.host === host);
            try {
                if (prev) {
                    Object.assign(prev, _clean({ ...p, host }, prev));
                    updated++;
                } else if (this.rules.length < MAX_RULES) {
                    this.rules.push(_clean({ ...p, host }));
                    added++;
                } else skipped++;
            } catch { skipped++; }
        }
        this._save();
        return { added, updated, skipped };
    }

    /** hosts-file text; disabled rules are written as `# off:` lines, notes as trailing comments. */
    exportHosts() {
        const rows = ['# CupNet mini DNS overrides', `# ${new Date().toISOString()}`, ''];
        for (const r of this.rules) {
            const bits = [];
            if (r.note) bits.push(r.note.replace(/[\r\n]+/g, ' '));
            const line = `${r.ip}\t${r.host}${bits.length ? `\t# ${bits.join(' ')}` : ''}`;
            rows.push(r.enabled ? line : `# off: ${line}`);
        }
        return `${rows.join('\n')}\n`;
    }

    /** Rules in the shape mitm-proxy.js setDnsOverrides takes. */
    toMitmRules() {
        return this.rules.map((r) => ({
            id: r.id, host: r.host, ip: r.ip, enabled: r.enabled, rewrite_host: r.rewriteHost || '', mitm_inject_cors: r.cors,
        }));
    }

    /** A request the MITM sent to an override (onRequestLogged `dnsOverride`). */
    noteHit(d, e = {}) {
        if (!d || !d.ip) return;
        const rule = (d.id && this.get(d.id)) || this.rules.find((r) => r.host === d.host) || null;
        const at = Date.now();
        if (rule) {
            const h = this.hits.get(rule.id) || { count: 0, last: 0 };
            h.count++; h.last = at;
            this.hits.set(rule.id, h);
        }
        this.activity.push({
            at, ruleId: rule?.id || null, host: d.host, ip: d.ip, url: String(e.url || '').slice(0, 2000),
            method: e.method || null, status: e.status ?? null, seq: e.seq ?? null,
        });
        if (this.activity.length > ACTIVITY_MAX) this.activity.splice(0, this.activity.length - ACTIVITY_MAX);
    }

    clearActivity() {
        this.activity = [];
        this.hits.clear();
    }
}

module.exports = { DnsStore, normalizeHost, normalizeIp, parseHosts };
