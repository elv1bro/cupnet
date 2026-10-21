'use strict';

/**
 * CupNet mini exit-IP monitor: every N seconds (15 by default) it asks which IP a new connection through
 * the current upstream gets, and keeps a history of what changed in <dataDir>/ip-history.jsonl.
 *
 * Each check is one small request over HTTP/1.1 with `Connection: close`, so every check opens a fresh
 * tunnel through the proxy. A rotating proxy therefore shows its rotation instead of the IP of a reused
 * keep-alive connection. Geo (country / city / ASN) is looked up only for an IP not seen before, through
 * the same upstream (never direct, so a lookup cannot reveal the machine's own IP), and cached per IP.
 *
 * History events (type):
 *   start      first IP after launch or after the monitor was turned on (prevIp = last IP in the history)
 *   switch     IP after the user changed the connection (connect / disconnect / New IP / --upstream)
 *   change     IP changed by itself — proxy rotation, a sticky session that expired, a network change
 *   error      checks started failing (recorded once per outage)
 *   recovered  checks work again with the same IP (a different IP is a `change`)
 *   blocked    kill switch on and no proxy: nothing can go out (a gap, like stop)
 *   stop       monitoring stopped (app closed / monitor turned off) — a gap in the timeline, not an IP
 *
 * Events carry the connection label (proxy profile name), never the proxy URL: it can hold credentials.
 */

const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const DEFAULT_INTERVAL_MS = 15 * 1000;
const MIN_INTERVAL_MS = 5 * 1000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10 * 1000;
const GEO_TIMEOUT_MS = 12 * 1000;
const MAX_EVENTS = 5000;
const GEO_CACHE_MAX = 500;
const CHECK_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Plain "what is my IP" endpoints, tried in order; the one that worked last is tried first. */
const IP_ENDPOINTS = [
    { url: 'https://api.ipify.org/?format=json', parse: (b) => JSON.parse(b).ip },
    { url: 'https://checkip.amazonaws.com/', parse: (b) => b },
    { url: 'https://icanhazip.com/', parse: (b) => b },
];

/** ipinfo.io JSON → geo fields. */
function geoFromIpinfo(j) {
    return {
        ip: j.ip || '', country: String(j.country || '').toUpperCase(), city: j.city || '', region: j.region || '',
        org: j.org || '', timezone: j.timezone || '',
    };
}

/** ipwho.is JSON → geo fields. */
function geoFromIpwho(j) {
    return {
        ip: j.ip || '', country: String(j.country_code || '').toUpperCase(), city: j.city || '', region: j.region || '',
        org: j.connection?.org || j.connection?.isp || '', timezone: j.timezone?.id || '',
    };
}

function _bodyText(r) {
    return r.bodyBase64 != null ? Buffer.from(String(r.bodyBase64), 'base64').toString('utf8') : String(r.body ?? '');
}

function _clampInterval(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)));
}

function _shortError(msg) {
    const m = String(msg || 'check failed');
    if (/407|proxy auth/i.test(m)) return 'Proxy rejected the credentials (407)';
    if (/ECONNREFUSED|connection refused/i.test(m)) return 'Proxy refused the connection';
    if (/ENOTFOUND|no such host/i.test(m)) return 'Host not found';
    if (/timeout|deadline|timed out/i.test(m)) return 'Timed out';
    return m.slice(0, 200);
}

const _newEpoch = () => crypto.randomBytes(6).toString('hex');

class IpMonitor extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} [o.file] history file (JSONL); in memory only when omitted
     * @param {() => { worker: any, proxy: string|null, browser: string, blocked: boolean, blockReason?: string, label: string, mode?: string }} o.getContext
     *   the current connection; `proxy` is used only for requests and to notice switches
     * @param {number} [o.intervalMs]
     * @param {boolean} [o.enabled]
     */
    constructor(o) {
        super();
        this.file = o.file || null;
        this.getContext = o.getContext;
        this.intervalMs = _clampInterval(o.intervalMs ?? DEFAULT_INTERVAL_MS);
        this.enabled = o.enabled !== false;
        this.events = [];
        this._nextId = 1;
        this._geo = new Map();
        // Changes whenever the history is reloaded or cleared, so a client that only fetches
        // `after` its last id knows when to start over.
        this.epoch = _newEpoch();
        this._ep = 0;
        this._timer = null;
        this._running = null;
        this._again = false;
        this._started = false;
        this._switchPending = false;
        /** next good check opens a new run (`start`) */
        this._fresh = true;
        this._runHasEvents = false;
        this.state = {
            ip: '', country: '', city: '', region: '', org: '', timezone: '', label: '', mode: '', via: '',
            since: null, lastCheckAt: null, lastOkAt: null, nextCheckAt: null, latencyMs: null,
            checks: 0, failures: 0, consecutiveFailures: 0, lastError: '', blocked: false,
        };
        /** proxy of the last successful check (in memory only) */
        this._lastProxy = undefined;
        this._load();
    }

    // ── lifecycle ──────────────────────────────────────────────────────────────

    start() {
        this._started = true;
        this._schedule(0);
        return this;
    }

    stop() {
        if (this._started && this.enabled) this._recordStop('CupNet mini closed');
        this._started = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this.state.nextCheckAt = null;
    }

    /** @param {{ enabled?: boolean, intervalMs?: number }} o */
    configure(o = {}) {
        const wasEnabled = this.enabled;
        if (o.intervalMs != null) this.intervalMs = _clampInterval(o.intervalMs);
        if (o.enabled != null) this.enabled = !!o.enabled;
        if (!this._started) return;
        if (wasEnabled && !this.enabled) this._recordStop('Monitor turned off');
        if (this.enabled && !wasEnabled) this._schedule(0);
        else this._schedule(this.enabled ? this.intervalMs : null);
    }

    /** The user changed the connection: check right away and record the result as a `switch`. */
    noteSwitch() {
        this._switchPending = true;
        if (this._started && this.enabled) this.checkNow().catch(() => {});
    }

    _recordStop(reason) {
        if (this._runHasEvents) this._record({ type: 'stop', prevIp: this.state.ip, label: this.state.label, note: reason });
        this._runHasEvents = false;
        this._fresh = true;
        this.state.consecutiveFailures = 0;
    }

    _schedule(ms) {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (ms == null || !this._started || !this.enabled) { this.state.nextCheckAt = null; return; }
        this.state.nextCheckAt = Date.now() + ms;
        this._timer = setTimeout(() => { this._timer = null; this.checkNow().catch(() => {}); }, ms);
        if (this._timer.unref) this._timer.unref();
    }

    // ── checks ─────────────────────────────────────────────────────────────────

    /** Run one check now (joins a check already in flight, then runs once more). Resolves with `summary()`. */
    async checkNow() {
        if (this._running) { this._again = true; await this._running; return this.summary(); }
        this._running = (async () => {
            do {
                this._again = false;
                try { await this._check(); } catch (e) { this._fail(this.getContext() || {}, e); }
            } while (this._again);
        })();
        try { await this._running; } finally {
            this._running = null;
            if (this._started && this.enabled) this._schedule(this.intervalMs);
        }
        return this.summary();
    }

    async _check() {
        const ctx = { ...this.getContext() };
        const st = this.state;
        st.lastCheckAt = Date.now();
        if (ctx.blocked && !ctx.proxy) {
            if (!st.blocked) {
                this._record({ type: 'blocked', prevIp: st.ip, label: ctx.label, mode: ctx.mode, note: ctx.blockReason || 'Egress blocked' });
                this._fresh = true;
                this._switchPending = false;
            }
            st.blocked = true;
            st.lastError = ctx.blockReason || 'Egress blocked';
            st.label = ctx.label;
            return;
        }
        st.blocked = false;
        st.checks++;
        const started = Date.now();
        // The connection changed while we were asking: the answer (or failure) belongs to the old one.
        const stale = () => (this.getContext().proxy || null) !== (ctx.proxy || null);
        let ip;
        try { ip = await this._fetchIp(ctx); } catch (e) {
            if (stale()) { this._again = true; return; }
            throw e;
        }
        if (stale()) { this._again = true; return; }
        st.latencyMs = Date.now() - started;
        const geo = await this._lookupGeo(ctx, ip);
        this._ok(ctx, ip, geo);
    }

    async _request(ctx, url, timeout) {
        return ctx.worker.request({
            method: 'GET', url, proxy: ctx.proxy || null, browser: ctx.browser,
            headers: { 'User-Agent': CHECK_UA, Accept: '*/*', Connection: 'close' },
            tabId: 'cupnet-mini-ipwatch', timeout, maxRetries: 0, forceHttp1: true,
        });
    }

    async _fetchIp(ctx) {
        let lastErr = null;
        for (let k = 0; k < IP_ENDPOINTS.length; k++) {
            const i = (this._ep + k) % IP_ENDPOINTS.length;
            const ep = IP_ENDPOINTS[i];
            try {
                const r = await this._request(ctx, ep.url, CHECK_TIMEOUT_MS);
                if (r.error) throw new Error(String(r.error));
                if (Number(r.statusCode) !== 200) throw new Error(`HTTP ${r.statusCode}`);
                const ip = String(ep.parse(_bodyText(r)) || '').trim();
                if (!net.isIP(ip)) throw new Error('not an IP address in the answer');
                this._ep = i;
                return ip;
            } catch (e) {
                lastErr = e;
                // A proxy that refuses us fails on every endpoint the same way.
                if (/407|proxy auth|ECONNREFUSED|connection refused/i.test(String(e?.message))) break;
            }
        }
        throw lastErr || new Error('IP check failed');
    }

    async _lookupGeo(ctx, ip) {
        const hit = this._geo.get(ip);
        if (hit) return hit;
        let geo = null;
        const tries = [
            [`https://ipinfo.io/${ip}/json`, geoFromIpinfo, (j) => !j.bogon],
            [`https://ipwho.is/${ip}`, geoFromIpwho, (j) => j.success !== false],
        ];
        for (const [url, map, good] of tries) {
            try {
                const r = await this._request(ctx, url, GEO_TIMEOUT_MS);
                if (Number(r.statusCode) !== 200) continue;
                const j = JSON.parse(_bodyText(r));
                if (!good(j)) continue;
                geo = { ...map(j), ip };
                break;
            } catch { /* next */ }
        }
        // No geo is not a failed check; retry the lookup when this IP comes up again.
        if (!geo) return { ip, country: '', city: '', region: '', org: '', timezone: '' };
        this._geo.set(ip, geo);
        if (this._geo.size > GEO_CACHE_MAX) this._geo.delete(this._geo.keys().next().value);
        return geo;
    }

    _ok(ctx, ip, geo) {
        const st = this.state;
        const fresh = this._fresh;
        this._fresh = false;
        const prevIp = st.ip || (fresh ? this._lastKnownIp() : '');
        const wasFailing = st.consecutiveFailures > 0;
        const switched = this._switchPending || (this._lastProxy !== undefined && (ctx.proxy || null) !== this._lastProxy);
        this._switchPending = false;
        this._lastProxy = ctx.proxy || null;
        const now = Date.now();
        st.lastOkAt = now;
        st.consecutiveFailures = 0;
        st.lastError = '';
        st.label = ctx.label;
        st.mode = ctx.mode || '';
        st.via = ctx.proxy ? 'proxy' : 'direct';
        let type = null;
        if (fresh) type = switched ? 'switch' : 'start';
        else if (switched) type = 'switch';
        else if (ip !== prevIp) type = 'change';
        else if (wasFailing) type = 'recovered';
        if (fresh || ip !== st.ip || !st.since) st.since = now;
        Object.assign(st, { ip, country: geo.country, city: geo.city, region: geo.region, org: geo.org, timezone: geo.timezone });
        if (type) {
            const held = !fresh && prevIp && (type === 'change' || type === 'switch') ? this._heldMs(prevIp, now) : null;
            this._record({
                type, ip, prevIp: prevIp || '', country: geo.country, city: geo.city, region: geo.region, org: geo.org,
                label: ctx.label, mode: ctx.mode, via: st.via, latencyMs: st.latencyMs, heldMs: held,
            });
        }
        this.emit('ok', this.egress());
    }

    _fail(ctx, e) {
        const st = this.state;
        st.failures++;
        st.consecutiveFailures++;
        st.lastError = _shortError(e?.message || e);
        st.label = ctx.label || st.label;
        if (st.consecutiveFailures === 1) {
            this._record({
                type: 'error', ip: '', prevIp: st.ip, error: st.lastError, label: ctx.label || '', mode: ctx.mode,
                via: ctx.proxy ? 'proxy' : 'direct',
            });
        }
    }

    _lastKnownIp() {
        for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].ip) return this.events[i].ip;
        return '';
    }

    /** How long `ip` was the exit IP until `now` (from its latest start/switch/change event). */
    _heldMs(ip, now) {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const ev = this.events[i];
            if (ev.ip === ip && ev.type !== 'recovered') return Math.max(0, now - ev.at);
            if (ev.type === 'stop' || (ev.ip && ev.ip !== ip)) return null;
        }
        return null;
    }

    // ── history ────────────────────────────────────────────────────────────────

    _record(fields) {
        const ev = { id: this._nextId++, at: Date.now(), ...fields };
        for (const k of Object.keys(ev)) if (ev[k] === '' || ev[k] == null) delete ev[k];
        this.events.push(ev);
        this._runHasEvents = true;
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
        if (this.file) {
            try { fs.appendFileSync(this.file, `${JSON.stringify(ev)}\n`, { mode: 0o600 }); } catch { /* memory still has it */ }
        }
        this.emit('event', ev);
        return ev;
    }

    _load() {
        if (!this.file) return;
        let text = '';
        try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
        const lines = text.split('\n').filter(Boolean);
        for (const l of lines) {
            try {
                const ev = JSON.parse(l);
                if (ev && Number.isFinite(ev.id) && ev.type) this.events.push(ev);
            } catch { /* skip a torn line */ }
        }
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
        this._nextId = (this.events.length ? this.events[this.events.length - 1].id : 0) + 1;
        // Keep the file from growing forever.
        if (lines.length > MAX_EVENTS * 2) this._rewrite();
    }

    _rewrite() {
        if (!this.file) return;
        const tmp = `${this.file}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tmp, this.events.map((e) => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : ''), { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    }

    /** Events newest first. @param {{ limit?: number, after?: number }} [o] after = only ids above it */
    history({ limit = 500, after = 0 } = {}) {
        const out = [];
        for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
            if (this.events[i].id <= after) break;
            out.push(this.events[i]);
        }
        return out;
    }

    clearHistory() {
        this.events = [];
        this.epoch = _newEpoch();
        this._rewrite();
    }

    get lastEventId() { return this.events.length ? this.events[this.events.length - 1].id : 0; }

    /** Current exit IP in the shape of ProxyManager's egress. */
    egress() {
        const st = this.state;
        if (!st.ip) return null;
        return {
            ok: true, ip: st.ip, country: st.country, city: st.city, region: st.region, org: st.org, timezone: st.timezone,
            latencyMs: st.latencyMs, at: new Date(st.lastOkAt || Date.now()).toISOString(), via: st.via,
        };
    }

    summary() {
        const now = Date.now();
        const st = this.state;
        let changes1h = 0, changes24h = 0;
        const ips24h = new Set();
        for (let i = this.events.length - 1; i >= 0; i--) {
            const ev = this.events[i];
            if (now - ev.at > 24 * 3600 * 1000) break;
            if (ev.ip) ips24h.add(ev.ip);
            if (ev.type === 'change' || ev.type === 'switch') {
                changes24h++;
                if (now - ev.at <= 3600 * 1000) changes1h++;
            }
        }
        if (st.ip) ips24h.add(st.ip);
        return {
            enabled: this.enabled, intervalMs: this.intervalMs, running: !!this._running,
            ...st, ok: !!st.ip && !st.consecutiveFailures && !st.blocked,
            changes1h, changes24h, uniqueIps24h: ips24h.size, lastEventId: this.lastEventId, epoch: this.epoch,
        };
    }
}

module.exports = { IpMonitor, geoFromIpinfo, geoFromIpwho, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS };
