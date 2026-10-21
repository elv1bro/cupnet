'use strict';
/**
 * CupNet mini cookie manager — works on the MITM path only (no CDP, no extension, nothing in the page).
 *
 *  - Tracking: every logged request feeds `observe()`: `Set-Cookie` gives full attributes, the `Cookie`
 *    request header shows what Chrome actually sends. Each cookie keeps a short value history.
 *  - Overrides (applied by MitmProxy hooks to traffic leaving or entering Chrome):
 *      pin   — send this value upstream instead of the browser's (adds the cookie if missing)
 *      strip — drop the cookie (or all cookies, name `*`) from requests to the domain
 *      block — drop matching `Set-Cookie` lines before Chrome sees them
 *  - Browser ops: set / delete / clear-site are queued and injected as `Set-Cookie` (or
 *    `Clear-Site-Data: "cookies"`) into the next first-party response from a matching host, so the
 *    change lands in Chrome's own cookie store the next time a page of that site loads.
 *
 * State is kept in `cookies.json` in the data folder (mode 0600 — it holds cookie values).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const HISTORY_MAX = 20;
const MAX_COOKIES = 5000;
const OP_TTL_MS = 60 * 60 * 1000;
const OPS_KEPT = 200;
const SAVE_DELAY_MS = 1000;
const SAME_SITE = { lax: 'Lax', strict: 'Strict', none: 'None' };
const ACTIONS = new Set(['pin', 'strip', 'block']);

const normDomain = (d) => String(d || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
/** RFC 6265 §5.1.3 (without the public-suffix list). */
const domainMatch = (host, domain) => !!domain && (host === domain || (host.endsWith(`.${domain}`) && !/^\d+\.\d+\.\d+\.\d+$/.test(host)));
/** RFC 6265 §5.1.4 */
function pathMatch(reqPath, cookiePath) {
    if (reqPath === cookiePath) return true;
    if (!reqPath.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
}
/** RFC 6265 §5.1.4 default-path */
function defaultPath(urlPath) {
    if (!urlPath || urlPath[0] !== '/') return '/';
    const i = urlPath.lastIndexOf('/');
    return i <= 0 ? '/' : urlPath.slice(0, i);
}
const cookieId = (domain, p, name) => crypto.createHash('sha1').update(`${domain}\n${p}\n${name}`).digest('hex').slice(0, 16);
const _newId = () => crypto.randomBytes(6).toString('hex');
const _epoch = () => crypto.randomBytes(6).toString('hex');
function _url(u) { try { return new URL(u); } catch { return null; } }
const _place = (u) => `${u.protocol}//${u.host}${u.pathname}`;

function _headerKeys(h, name) { return Object.keys(h || {}).filter((k) => k.toLowerCase() === name); }
function _headerValues(h, name) {
    const out = [];
    for (const k of _headerKeys(h, name)) for (const v of (Array.isArray(h[k]) ? h[k] : [h[k]])) if (v != null) out.push(String(v));
    return out;
}

/** `Cookie` header value(s) → `[[name, value]]` in order. */
function parseCookieHeader(values) {
    const out = [];
    for (const v of (Array.isArray(values) ? values : [values])) {
        for (const part of String(v || '').split(';')) {
            const p = part.trim();
            if (!p) continue;
            const i = p.indexOf('=');
            out.push(i < 0 ? ['', p] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]);
        }
    }
    return out;
}
const buildCookieHeader = (pairs) => pairs.map(([n, v]) => (n ? `${n}=${v}` : v)).join('; ');

/**
 * One `Set-Cookie` line (RFC 6265 §5.2), resolved against the response URL.
 * @returns {object|null} null when Chrome would ignore it (bad name, foreign Domain).
 */
function parseSetCookie(line, url, now = Date.now()) {
    const u = typeof url === 'string' ? _url(url) : url;
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    const parts = String(line).split(';');
    const nv = parts.shift();
    const eq = nv.indexOf('=');
    const name = (eq < 0 ? '' : nv.slice(0, eq)).trim();
    const value = (eq < 0 ? nv : nv.slice(eq + 1)).trim();
    if (!name && !value) return null;
    const c = {
        name, value, domain: host, hostOnly: true, path: defaultPath(u.pathname),
        expires: null, secure: false, httpOnly: false, sameSite: null, partitioned: false,
    };
    let maxAge = null, expires = null;
    for (const raw of parts) {
        const i = raw.indexOf('=');
        const k = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : raw.slice(i + 1).trim();
        if (k === 'expires') { const t = Date.parse(v); if (Number.isFinite(t)) expires = t; }
        else if (k === 'max-age') { if (/^-?\d+$/.test(v)) maxAge = Number(v); }
        else if (k === 'domain') {
            const d = normDomain(v);
            if (d) {
                if (!domainMatch(host, d)) return null;
                c.domain = d; c.hostOnly = false;
            }
        }
        else if (k === 'path') c.path = v && v[0] === '/' ? v : defaultPath(u.pathname);
        else if (k === 'secure') c.secure = true;
        else if (k === 'httponly') c.httpOnly = true;
        else if (k === 'samesite') c.sameSite = SAME_SITE[v.toLowerCase()] || null;
        else if (k === 'partitioned') c.partitioned = true;
    }
    if (maxAge != null) c.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
    else if (expires != null) c.expires = expires;
    c.expired = c.expires != null && c.expires <= now;
    return c;
}

/** A cookie spec → `Set-Cookie` line (with `Max-Age=0` when deleting). */
function serializeSetCookie(c, { remove = false } = {}) {
    const out = [`${c.name}=${remove ? '' : c.value ?? ''}`, `Path=${c.path || '/'}`];
    if (!c.hostOnly && c.domain) out.push(`Domain=${c.domain}`);
    if (remove) out.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    else if (c.expires) out.push(`Expires=${new Date(c.expires).toUTCString()}`);
    if (c.secure) out.push('Secure');
    if (c.httpOnly) out.push('HttpOnly');
    if (c.sameSite) out.push(`SameSite=${c.sameSite}`);
    if (c.partitioned && !remove) out.push('Partitioned');
    return out.join('; ');
}

/** Checks Chrome applies to a cookie written by a response (prefixes, SameSite=None). */
function validateSpec(c) {
    if (!c || typeof c !== 'object') throw new Error('cookie object expected');
    if (!c.name || /[\s;=,]/.test(c.name)) throw new Error('Cookie name is empty or has spaces, ";", "=" or ","');
    if (/[;\r\n]/.test(String(c.value ?? ''))) throw new Error('Cookie value cannot contain ";" or line breaks');
    if (!normDomain(c.domain)) throw new Error('Domain is required');
    if (c.path && c.path[0] !== '/') throw new Error('Path must start with "/"');
    if (c.name.startsWith('__Host-') && (!c.secure || !c.hostOnly || (c.path || '/') !== '/')) throw new Error('__Host- cookies need Secure, Path=/ and no Domain (host-only)');
    if (c.name.startsWith('__Secure-') && !c.secure) throw new Error('__Secure- cookies need Secure');
    if (c.sameSite === 'None' && !c.secure) throw new Error('SameSite=None needs Secure');
    if (c.partitioned && !c.secure) throw new Error('Partitioned needs Secure');
}
function _spec(c) {
    return {
        name: String(c.name || '').trim(), value: String(c.value ?? ''), domain: normDomain(c.domain),
        hostOnly: c.hostOnly !== false, path: c.path || '/',
        expires: c.expires == null || c.expires === '' ? null : Number(c.expires),
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        sameSite: SAME_SITE[String(c.sameSite || '').toLowerCase()] || null, partitioned: !!c.partitioned,
    };
}

/** Whether a response to this request is one Chrome stores cookies from as first-party. */
function _firstParty(reqHeaders) {
    const site = _headerValues(reqHeaders, 'sec-fetch-site')[0];
    return !site || site === 'same-origin' || site === 'same-site' || site === 'none';
}

class CookieJar extends EventEmitter {
    /**
     * @param {{ file?: string, now?: () => number, maxCookies?: number }} [o]
     */
    constructor(o = {}) {
        super();
        this.file = o.file || null;
        this.now = o.now || Date.now;
        this.maxCookies = o.maxCookies || MAX_COOKIES;
        /** @type {Map<string, object>} id → cookie */
        this.cookies = new Map();
        this.overrides = [];
        this.ops = [];
        this.rev = 0;
        this.epoch = _epoch();
        this._saveTimer = null;
        this._load();
    }

    // ── tracking ──────────────────────────────────────────────────────────────

    /** A logged request (MitmProxy onRequestLogged payload). */
    observe(e) {
        const u = _url(e?.url);
        if (!u || !/^https?:$/.test(u.protocol)) return;
        const now = this.now();
        const host = u.hostname.toLowerCase();
        let changed = false;
        const sent = parseCookieHeader(_headerValues(e.requestHeaders, 'cookie'));
        for (const [name, value] of sent) {
            if (!name) continue;
            const c = this._matchSent(host, u.pathname, name, value) || this._inferred(host, name, value, now, u);
            c.sentCount++; c.lastSentAt = now; c.lastSeen = now; c.lastUrl = _place(u);
            if (c.value !== value) { this._history(c, value, 'sent', now, u); c.value = value; }
            if (c.deleted) { c.deleted = false; c.deletedAt = null; }
            changed = true;
        }
        for (const line of _headerValues(e.responseHeaders, 'set-cookie')) {
            for (const one of line.split('\n')) {
                const p = one.trim() && parseSetCookie(one, u, now);
                if (p) { this._applySet(p, 'set', now, u); changed = true; }
            }
        }
        if (changed) this._touch();
    }

    /** The stored cookie Chrome sent as `name=value` to host/path; prefers an exact value match. */
    _matchSent(host, reqPath, name, value) {
        let best = null, score = -1;
        for (const c of this.cookies.values()) {
            if (c.name !== name || c.deleted) continue;
            if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) continue;
            if (!pathMatch(reqPath || '/', c.path)) continue;
            const s = (c.value === value ? 1e6 : 0) + c.path.length * 1000 + c.domain.length;
            if (s > score) { best = c; score = s; }
        }
        return best;
    }

    /** A cookie only ever seen in `Cookie` headers: scope unknown, assume host-only at `/`. */
    _inferred(host, name, value, now, u) {
        const c = this._create({ name, value, domain: host, hostOnly: true, path: '/', secure: u.protocol === 'https:' && name.startsWith('__') }, now);
        c.inferred = true; c.source = 'request';
        this._history(c, value, 'sent', now, u);
        return c;
    }

    _create(spec, now) {
        const s = _spec(spec);
        const id = cookieId(s.domain, s.path, s.name);
        const c = {
            id, ...s, inferred: false, deleted: false, deletedAt: null, source: 'set-cookie',
            firstSeen: now, lastSeen: now, lastSetAt: null, lastSentAt: null, lastUrl: null,
            setCount: 0, sentCount: 0, blockedCount: 0, history: [],
        };
        this.cookies.set(id, c);
        if (this.cookies.size > this.maxCookies) this._evict();
        return c;
    }

    _evict() {
        const byAge = [...this.cookies.values()].sort((a, b) => a.lastSeen - b.lastSeen);
        for (const c of byAge.slice(0, this.cookies.size - this.maxCookies)) this.cookies.delete(c.id);
    }

    _history(c, value, via, at, u) {
        c.history.unshift({ at, value, via, url: u ? _place(u) : null });
        if (c.history.length > HISTORY_MAX) c.history.length = HISTORY_MAX;
    }

    /** Record a cookie Chrome is told to store (or drop): by the site (`set`) or by us (`manual`). */
    _applySet(p, via, now, u) {
        const id = cookieId(p.domain, p.path, p.name);
        // A cookie first guessed from a Cookie header may really live on a parent domain or deeper path.
        for (const c of [...this.cookies.values()]) {
            if (!c.inferred || c.id === id || c.name !== p.name || !domainMatch(c.domain, p.domain)) continue;
            if (!p.expired) this.cookies.delete(c.id);
            else if (!c.deleted) { this._history(c, '', via === 'manual' ? 'manual-delete' : 'deleted', now, u); c.deleted = true; c.deletedAt = now; }
        }
        let c = this.cookies.get(id);
        if (!c && p.expired) return null; // deleting a cookie we never saw: nothing to record
        if (!c) c = this._create(p, now);
        else Object.assign(c, _spec({ ...c, ...p }));
        c.inferred = false;
        c.source = via === 'manual' ? 'manual' : c.source === 'request' ? 'set-cookie' : c.source;
        c.lastSeen = now; c.lastUrl = u ? _place(u) : c.lastUrl;
        if (p.expired) {
            if (!c.deleted) this._history(c, '', via === 'manual' ? 'manual-delete' : 'deleted', now, u);
            c.deleted = true; c.deletedAt = now;
            return c;
        }
        c.setCount++; c.lastSetAt = now;
        if (c.deleted || c.history[0]?.value !== p.value || c.history.length === 0) this._history(c, p.value, via, now, u);
        c.value = p.value; c.deleted = false; c.deletedAt = null;
        return c;
    }

    list() {
        return [...this.cookies.values()].sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    }

    /** Forget tracked cookies (Chrome keeps them): by ids, by domain (and subdomains), or all. */
    forget({ ids, domain, all } = {}) {
        let n = 0;
        if (all) { n = this.cookies.size; this.cookies.clear(); }
        for (const id of ids || []) if (this.cookies.delete(id)) n++;
        const d = normDomain(domain);
        if (d) for (const c of [...this.cookies.values()]) if (domainMatch(c.domain, d)) { this.cookies.delete(c.id); n++; }
        if (n) this._touch();
        return n;
    }

    // ── overrides ─────────────────────────────────────────────────────────────

    addOverride(o) {
        const ov = this._overrideFrom(o);
        this.overrides.push(ov);
        this._touch();
        return ov;
    }
    updateOverride(id, patch) {
        const i = this.overrides.findIndex((x) => x.id === id);
        if (i < 0) throw new Error('No such override');
        this.overrides[i] = { ...this._overrideFrom({ ...this.overrides[i], ...patch }), id, hits: this.overrides[i].hits, lastHitAt: this.overrides[i].lastHitAt, createdAt: this.overrides[i].createdAt };
        this._touch();
        return this.overrides[i];
    }
    removeOverride(id) {
        const n = this.overrides.length;
        this.overrides = this.overrides.filter((x) => x.id !== id);
        if (this.overrides.length !== n) this._touch();
        return this.overrides.length !== n;
    }
    _overrideFrom(o) {
        if (!ACTIONS.has(o?.action)) throw new Error('action must be pin, strip or block');
        const name = String(o.name || '').trim();
        const domain = o.domain === '*' ? '*' : normDomain(o.domain);
        if (!domain) throw new Error('Domain is required (use * for every site)');
        if (!name) throw new Error('Cookie name is required (use * for every cookie)');
        if (o.action === 'pin' && (name === '*' || /[\s;=,]/.test(name))) throw new Error('Pin needs one cookie name without spaces, ";", "=" or ","');
        if (o.action === 'pin' && /[;\r\n]/.test(String(o.value ?? ''))) throw new Error('Cookie value cannot contain ";" or line breaks');
        return {
            id: o.id || _newId(), action: o.action, domain, name, value: o.action === 'pin' ? String(o.value ?? '') : '',
            enabled: o.enabled !== false, note: String(o.note || '').slice(0, 200),
            createdAt: o.createdAt || this.now(), hits: o.hits || 0, lastHitAt: o.lastHitAt || null,
        };
    }
    _activeFor(host, actions) {
        return this.overrides.filter((o) => o.enabled && actions.includes(o.action) && (o.domain === '*' || domainMatch(host, o.domain)));
    }

    // ── browser ops ───────────────────────────────────────────────────────────

    /** Queue a cookie write into Chrome (lands with the next first-party response from its host). */
    queueSet(cookie) {
        const c = _spec(cookie);
        validateSpec(c);
        return this._queue({ op: 'set', domain: c.domain, cookie: c });
    }
    /** Queue deleting tracked cookies by id, or a spec ({name, domain, path, hostOnly}). */
    queueDelete({ ids, cookie } = {}) {
        const specs = (ids || []).map((id) => this.cookies.get(id)).filter(Boolean);
        if (cookie) specs.push(_spec(cookie));
        if (!specs.length) throw new Error('Nothing to delete');
        return specs.map((c) => this._queue({ op: 'delete', domain: c.domain, cookie: _spec(c), inferred: !!c.inferred }));
    }
    /** Queue `Clear-Site-Data: "cookies"` — Chrome drops every cookie of the site (HTTPS only). */
    queueClearSite(domain) {
        const d = normDomain(domain);
        if (!d) throw new Error('Domain is required');
        return this._queue({ op: 'clear', domain: d, cookie: null });
    }
    _queue(o) {
        // A newer op for the same cookie replaces a pending one.
        const key = o.cookie ? cookieId(o.cookie.domain, o.cookie.path, o.cookie.name) : `clear:${o.domain}`;
        for (const x of this.ops) if (x.state === 'pending' && x.key === key) x.state = 'replaced';
        const op = { id: _newId(), key, ...o, state: 'pending', createdAt: this.now(), appliedAt: null, appliedUrl: null };
        this.ops.unshift(op);
        if (this.ops.length > OPS_KEPT) this.ops.length = OPS_KEPT;
        this._touch();
        return op;
    }
    cancelOp(id) {
        const op = this.ops.find((x) => x.id === id && x.state === 'pending');
        if (!op) return false;
        op.state = 'cancelled';
        this._touch();
        return true;
    }
    clearDoneOps() {
        const n = this.ops.length;
        this.ops = this.ops.filter((x) => x.state === 'pending');
        if (n !== this.ops.length) this._touch();
    }
    _expireOps(now) {
        let n = 0;
        for (const x of this.ops) if (x.state === 'pending' && now - x.createdAt > OP_TTL_MS) { x.state = 'expired'; n++; }
        return n;
    }
    pendingHosts() {
        return [...new Set(this.ops.filter((x) => x.state === 'pending').map((x) => x.domain))];
    }

    // ── MitmProxy hooks ───────────────────────────────────────────────────────

    /** onBeforeUpstream: pin / strip in the outgoing `Cookie` header (headers + orderedHeaders). */
    beforeUpstream(up) {
        if (!this.overrides.length) return false;
        const u = _url(up?.url);
        if (!u) return false;
        const rules = this._activeFor(u.hostname.toLowerCase(), ['pin', 'strip']);
        if (!rules.length) return false;
        const keys = _headerKeys(up.headers, 'cookie');
        const before = parseCookieHeader(_headerValues(up.headers, 'cookie'));
        let pairs = before.slice();
        const now = this.now();
        for (const r of rules) {
            if (r.action === 'strip') {
                const n = pairs.length;
                pairs = r.name === '*' ? [] : pairs.filter(([k]) => k !== r.name);
                if (pairs.length !== n) { r.hits++; r.lastHitAt = now; }
            } else {
                const has = pairs.some(([k]) => k === r.name);
                pairs = has ? pairs.map(([k, v]) => (k === r.name ? [k, r.value] : [k, v])) : [...pairs, [r.name, r.value]];
                r.hits++; r.lastHitAt = now;
            }
        }
        const value = buildCookieHeader(pairs);
        if (value === buildCookieHeader(before)) return false;
        const keyName = keys[0] || (Object.keys(up.headers || {}).some((k) => k !== k.toLowerCase()) ? 'Cookie' : 'cookie');
        for (const k of keys) delete up.headers[k];
        if (value) up.headers[keyName] = value;
        if (Array.isArray(up.orderedHeaders)) {
            const oh = up.orderedHeaders;
            let at = -1;
            for (let i = oh.length - 1; i >= 0; i--) if (String(oh[i][0]).toLowerCase() === 'cookie') { at = i; oh.splice(i, 1); }
            if (value) {
                if (at < 0) { at = oh.findIndex(([k]) => String(k).toLowerCase() === 'priority'); if (at < 0) at = oh.length; }
                oh.splice(Math.min(at, oh.length), 0, [keyName, value]);
            }
        }
        this._touch(false);
        return true;
    }

    /** onResponseHead: drop blocked `Set-Cookie` lines, inject pending browser ops. Mutates `out.headers`. */
    responseHead(up, out) {
        const u = _url(up?.url);
        if (!u || !out || !out.headers) return false;
        const host = u.hostname.toLowerCase();
        const now = this.now();
        const blocks = this.overrides.length ? this._activeFor(host, ['block']) : [];
        const hasOps = this.ops.length && this.ops.some((x) => x.state === 'pending');
        if (!blocks.length && !hasOps) return false;
        const keys = _headerKeys(out.headers, 'set-cookie');
        let lines = [];
        for (const k of keys) for (const v of (Array.isArray(out.headers[k]) ? out.headers[k] : [out.headers[k]])) lines.push(...String(v).split('\n').filter((s) => s.trim()));
        const n0 = lines.length;
        let changed = false;
        for (const r of blocks) {
            const keep = [];
            for (const line of lines) {
                const p = parseSetCookie(line, u, now);
                if (p && (r.name === '*' || p.name === r.name)) {
                    r.hits++; r.lastHitAt = now;
                    const c = this.cookies.get(cookieId(p.domain, p.path, p.name));
                    if (c) c.blockedCount++;
                    changed = true;
                } else keep.push(line);
            }
            lines = keep;
        }
        if (hasOps && this._expireOps(now)) changed = true;
        const status = Number(out.statusCode) || 0;
        if (hasOps && status >= 200 && status !== 101 && _firstParty(up.headers)) {
            for (const op of this.ops) {
                if (op.state !== 'pending' || !this._opMatches(op, host, u)) continue;
                if (op.op === 'clear') {
                    if (u.protocol !== 'https:') continue;
                    out.headers['Clear-Site-Data'] = '"cookies"';
                    for (const c of this.cookies.values()) if (domainMatch(c.domain, op.domain) || domainMatch(op.domain, c.domain)) { if (!c.deleted) this._history(c, '', 'manual-delete', now, u); c.deleted = true; c.deletedAt = now; }
                } else {
                    const variants = op.op === 'delete' ? this._deleteVariants(op, host) : [op.cookie];
                    for (const c of variants) lines.push(serializeSetCookie(c, { remove: op.op === 'delete' }));
                    this._applySet({ ...op.cookie, expired: op.op === 'delete' }, 'manual', now, u);
                }
                op.state = 'applied'; op.appliedAt = now; op.appliedUrl = _place(u);
                changed = true;
                this.emit('applied', op);
            }
        }
        if (!changed) return false;
        for (const k of keys) delete out.headers[k];
        if (lines.length) out.headers[keys[0] || 'Set-Cookie'] = lines.length === 1 ? lines[0] : lines;
        if (lines.length !== n0 || changed) this._touch();
        return true;
    }

    _opMatches(op, host, u) {
        if (op.op === 'clear') return domainMatch(host, op.domain);
        const c = op.cookie;
        if (c.secure && u.protocol !== 'https:') return false;
        if (op.op === 'delete' && op.inferred) return domainMatch(host, c.domain);
        return c.hostOnly ? host === c.domain : domainMatch(host, c.domain);
    }

    /** A cookie of unknown scope may be host-only or set on any parent domain — remove every variant. */
    _deleteVariants(op, host) {
        const c = op.cookie;
        if (!op.inferred) return [c];
        const out = [{ ...c, hostOnly: true, domain: host }];
        const labels = host.split('.');
        for (let i = 0; i < labels.length - 1; i++) out.push({ ...c, hostOnly: false, domain: labels.slice(i).join('.') });
        return out;
    }

    // ── import / export ───────────────────────────────────────────────────────

    /** JSON in the browser-extension / Playwright shape (`expirationDate` / `expires` in seconds). */
    exportJson(cookies) {
        return JSON.stringify(cookies.filter((c) => !c.deleted).map((c) => ({
            name: c.name, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`, hostOnly: c.hostOnly, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly,
            sameSite: c.sameSite === 'None' ? 'no_restriction' : c.sameSite ? c.sameSite.toLowerCase() : 'unspecified',
            session: !c.expires, ...(c.expires ? { expirationDate: Math.floor(c.expires / 1000) } : {}),
        })), null, 2);
    }
    /** Netscape cookies.txt (curl, wget, yt-dlp). */
    exportNetscape(cookies) {
        const rows = cookies.filter((c) => !c.deleted).map((c) => [
            `${c.httpOnly ? '#HttpOnly_' : ''}${c.hostOnly ? c.domain : `.${c.domain}`}`, c.hostOnly ? 'FALSE' : 'TRUE', c.path,
            c.secure ? 'TRUE' : 'FALSE', c.expires ? Math.floor(c.expires / 1000) : 0, c.name, c.value,
        ].join('\t'));
        return `# Netscape HTTP Cookie File\n# Exported by CupNet mini\n\n${rows.join('\n')}\n`;
    }
    /** JSON (array or `{cookies: []}`) or Netscape text → validated cookie specs. */
    static parseImport(text) {
        const s = String(text || '').trim();
        if (!s) throw new Error('Nothing to import');
        const out = [], errors = [];
        const add = (c, where) => { try { const sp = _spec(c); validateSpec(sp); out.push(sp); } catch (e) { errors.push(`${where}: ${e.message}`); } };
        if (/^[[{]/.test(s)) {
            let data;
            try { data = JSON.parse(s); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
            const arr = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : null;
            if (!arr) throw new Error('Expected a JSON array of cookies or {"cookies": [...]}');
            arr.forEach((c, i) => {
                const dom = String(c?.domain || '');
                const exp = c?.expirationDate ?? (c?.expires > 0 ? c.expires : null);
                const ss = String(c?.sameSite || '').toLowerCase();
                add({
                    name: c?.name, value: c?.value, domain: dom, hostOnly: c?.hostOnly ?? !dom.startsWith('.'), path: c?.path || '/',
                    secure: c?.secure, httpOnly: c?.httpOnly, expires: exp ? Math.round(Number(exp) * 1000) : null,
                    sameSite: ss === 'no_restriction' ? 'none' : ss === 'unspecified' ? null : ss,
                }, `#${i + 1}`);
            });
        } else {
            s.split(/\r?\n/).forEach((line, i) => {
                let l = line;
                let httpOnly = false;
                if (l.startsWith('#HttpOnly_')) { httpOnly = true; l = l.slice(10); } else if (!l.trim() || l.startsWith('#')) return;
                const f = l.split('\t');
                if (f.length < 7) { errors.push(`line ${i + 1}: expected 7 tab-separated fields`); return; }
                const exp = Number(f[4]);
                add({ domain: f[0], hostOnly: !f[0].startsWith('.') && f[1] !== 'TRUE', path: f[2], secure: f[3] === 'TRUE', expires: exp > 0 ? exp * 1000 : null, name: f[5], value: f.slice(6).join('\t'), httpOnly }, `line ${i + 1}`);
            });
        }
        return { cookies: out, errors };
    }

    // ── state ─────────────────────────────────────────────────────────────────

    summary() {
        let live = 0;
        for (const c of this.cookies.values()) if (!c.deleted) live++;
        return {
            rev: this.rev, epoch: this.epoch, cookies: live,
            pending: this.ops.filter((x) => x.state === 'pending').length,
            overrides: this.overrides.filter((o) => o.enabled).length,
        };
    }

    snapshot() {
        this._expireOps(this.now());
        return { ...this.summary(), list: this.list(), overrides: this.overrides, ops: this.ops };
    }

    _touch(save = true) {
        this.rev++;
        if (save) this._scheduleSave();
        else if (!this._saveTimer) this._scheduleSave();
    }

    _scheduleSave() {
        if (!this.file || this._saveTimer) return;
        this._saveTimer = setTimeout(() => { this._saveTimer = null; this.flush(); }, SAVE_DELAY_MS);
        this._saveTimer.unref?.();
    }

    flush() {
        if (!this.file) return;
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
        const data = JSON.stringify({ version: 1, cookies: [...this.cookies.values()], overrides: this.overrides, ops: this.ops.filter((x) => x.state === 'pending') });
        const tmp = `${this.file}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(tmp, data, { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch { /* not written */ }
            this.emit('error', e);
        }
    }

    _load() {
        if (!this.file || !fs.existsSync(this.file)) return;
        try {
            const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const c of d.cookies || []) if (c && c.id && c.name != null) this.cookies.set(c.id, { history: [], ...c });
            this.overrides = Array.isArray(d.overrides) ? d.overrides.filter((o) => o && ACTIONS.has(o.action)) : [];
            this.ops = Array.isArray(d.ops) ? d.ops.filter((x) => x && x.state === 'pending') : [];
        } catch {
            // A broken file must not stop the proxy; keep it for the user and start empty.
            try { fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* ignore */ }
        }
    }

    close() { this.flush(); }
}

module.exports = { CookieJar, parseSetCookie, serializeSetCookie, parseCookieHeader, domainMatch, pathMatch, defaultPath, validateSpec };
