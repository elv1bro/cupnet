'use strict';

/**
 * CupNet mini proxy manager: saved upstream profiles, testing through the AzureTLS worker, one-click
 * connect, sticky-session re-roll ("New IP") and the kill switch.
 *
 * Profiles live in <dataDir>/proxies.json. Passwords never sit in that file in clear: each profile's
 * password is AES-256-GCM encrypted with the key in <dataDir>/proxies.key (32 random bytes, mode 0600;
 * the same key-file approach as the per-session keys, see session-crypto.js). The UI never receives a
 * password — only masked URLs — and a profile's password is replaced only when a new one is sent.
 *
 * Two kinds of profile:
 *   provider  Decodo / Oxylabs / IPRoyal / NodeMaven (proxy-providers.js): username, password, country,
 *             rotating|sticky (+ minutes) and provider options; the URL is built from them.
 *   custom    a URL or template (`http://user-{SID}:{PASSWORD}@host:port`, `{RAND:1-9999}`, `{VAR}`).
 *             A password typed into the URL is moved out into the encrypted field and the template
 *             keeps `{PASSWORD}`.
 *
 * Sticky sessions: {SID} / {RAND:a-b} are resolved once and pinned on the profile, so reconnecting
 * keeps the exit IP; "New IP" re-rolls them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const providers = require('../proxy-providers');
const { parseStaticProxyLines } = require('../proxy-static-import');
const { parseProxyTemplate, extractTemplateVars } = require('../utils');

const FILE_VERSION = 1;
const MAX_PROFILES = 5000;
const PASSWORD_VAR = 'PASSWORD';
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const TEST_TIMEOUT_MS = 15000;
const EGRESS_CACHE_MS = 60 * 1000;
const TEST_CONCURRENCY = 4;
const TEST_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function _now() { return new Date().toISOString(); }
function _id() { return crypto.randomBytes(8).toString('hex'); }
function _str(v, max = 500) { return String(v ?? '').trim().slice(0, max); }

function _readOrCreateKey(file) {
    try {
        const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
        if (k.length === 32) return k;
    } catch { /* create below */ }
    const k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${k.toString('hex')}\n`, { mode: 0o600 });
    return k;
}

function _encrypt(key, text) {
    if (!text) return '';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function _decrypt(key, blob) {
    if (!blob) return '';
    const [v, iv, tag, ct] = String(blob).split(':');
    if (v !== 'v1') throw new Error('Unknown secret format');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/**
 * Split `scheme://user:pass@host` into a template with {PASSWORD} and the password.
 * A password that already is `{PASSWORD}` (an edited template) yields password=null (keep stored one).
 */
function splitTemplatePassword(template) {
    let t = _str(template, 4000);
    if (t && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `http://${t}`;
    const m = /^([a-z][a-z0-9+.-]*:\/\/)([^@/]*?):([^@/]*)@(.+)$/i.exec(t);
    if (!m) return { template: t, password: null };
    const [, scheme, user, pass, rest] = m;
    if (new RegExp(`^\\{${PASSWORD_VAR}\\}$`, 'i').test(pass)) return { template: t, password: null };
    let plain = pass;
    try { plain = decodeURIComponent(pass); } catch { /* keep */ }
    return { template: `${scheme}${user}:{${PASSWORD_VAR}}@${rest}`, password: plain };
}

/** scheme / host / port of a URL or template (placeholders allowed, e.g. a {RAND:a-b} port). */
function _hostOf(url) {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::([^/]+))?/i.exec(String(url || ''));
    if (!m) return { scheme: '', host: '', port: '' };
    return { scheme: m[1].toLowerCase(), host: m[2], port: m[3] || '' };
}

/** Hide the password entirely (no length or first/last characters). */
function maskUrl(url) {
    return String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)([^:@/]*):([^@/]*)@/i,
        (m, scheme, user, pass) => (pass ? `${scheme}${user}:•••@` : `${scheme}${user}@`));
}

/** Validate a resolved proxy URL. @returns {string|null} error */
function validateProxyUrl(url) {
    const unresolved = /\{[A-Z_][A-Z0-9_:-]*\}/i.exec(url);
    if (unresolved) return `Unresolved variable ${unresolved[0]}`;
    let u;
    try { u = new URL(url); } catch { return 'Not a valid proxy URL'; }
    if (!PROXY_SCHEMES.has(u.protocol)) return `Unsupported scheme ${u.protocol} (http, https, socks4, socks4a, socks5, socks5h)`;
    if (!u.hostname) return 'Proxy host is missing';
    return null;
}

class ProxyStore {
    /**
     * @param {string} file proxies.json
     * @param {string} keyFile proxies.key
     */
    constructor(file, keyFile) {
        this.file = file;
        this.key = _readOrCreateKey(keyFile);
        this.data = { version: FILE_VERSION, activeId: null, killSwitch: false, profiles: [] };
        try {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (d && Array.isArray(d.profiles)) this.data = { ...this.data, ...d };
        } catch { /* new store */ }
    }

    _save() {
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    get activeId() { return this.data.activeId; }
    get killSwitch() { return !!this.data.killSwitch; }

    setActive(id) { this.data.activeId = id || null; this._save(); }
    setKillSwitch(on) { this.data.killSwitch = !!on; this._save(); }

    get(id) { return this.data.profiles.find((p) => p.id === id) || null; }

    /** Password in clear — server side only. */
    password(p) {
        try { return _decrypt(this.key, p.secret); } catch { return ''; }
    }

    /**
     * Build the profile's template with the password filled in (still with {SID}/{RAND}/vars).
     * @returns {string}
     */
    template(p) {
        if (p.kind === 'provider') {
            return providers.buildProviderTemplate(p.provider, {
                username: p.username,
                password: this.password(p),
                countryCode: p.country,
                sessionMode: p.sessionMode,
                durationMin: p.durationMin,
                options: p.options || {},
            });
        }
        const pass = encodeURIComponent(this.password(p));
        return String(p.template || '').replace(new RegExp(`\\{${PASSWORD_VAR}\\}`, 'gi'), pass);
    }

    /**
     * Resolve the connectable URL. Pinned SID/RAND keep a sticky exit; reroll draws new ones.
     * @returns {{ url: string, error: string|null }}
     */
    resolve(p, { reroll = false, pin = true } = {}) {
        let t = this.template(p);
        const pinned = (!reroll && p.pinned) || {};
        if (pinned.RAND) t = t.replace(/\{RAND:\d+-\d+\}/gi, pinned.RAND);
        const out = {};
        const vars = { ...(p.vars || {}), ...(pinned.SID ? { SID: pinned.SID } : {}) };
        const url = parseProxyTemplate(t, vars, out);
        if (pin && (out.SID || out.RAND)) {
            const next = { ...(p.pinned || {}) };
            if (out.SID) next.SID = out.SID;
            if (out.RAND) next.RAND = out.RAND;
            if (JSON.stringify(next) !== JSON.stringify(p.pinned || {})) { p.pinned = next; this._save(); }
        }
        return { url, error: validateProxyUrl(url) };
    }

    /** Masked URL for the UI ({SID}/{RAND} shown as placeholders unless pinned). */
    display(p) {
        let t = this.template(p);
        if (p.pinned?.RAND) t = t.replace(/\{RAND:\d+-\d+\}/gi, p.pinned.RAND);
        const filled = t.replace(/\{([A-Z_][A-Z0-9_]*)\}/gi, (m, n) => {
            if (n.toUpperCase() === 'SID' && p.pinned?.SID) return p.pinned.SID;
            const k = Object.keys(p.vars || {}).find((x) => x.toUpperCase() === n.toUpperCase());
            return k && p.vars[k] !== '' ? encodeURIComponent(p.vars[k]) : m;
        });
        return maskUrl(filled);
    }

    /** Profile as the UI sees it — never a password. */
    publicProfile(p) {
        const meta = p.kind === 'provider' ? providers.getProxyProviderById(p.provider) : null;
        const country = meta ? providers.getProviderCountry(meta, p.country) : null;
        const display = this.display(p);
        const sticky = p.kind === 'provider' ? p.sessionMode === 'sticky' : /\{(SID|RAND:)/i.test(p.template || '');
        return {
            id: p.id,
            name: p.name,
            group: p.group || '',
            notes: p.notes || '',
            kind: p.kind,
            provider: p.kind === 'provider' ? p.provider : 'custom',
            providerName: meta?.name || 'Custom',
            country: p.kind === 'provider' ? (p.country || '') : (p.lastTest?.country || '').toLowerCase(),
            countryName: country?.name || '',
            sessionMode: p.kind === 'provider' ? p.sessionMode : (sticky ? 'sticky' : 'static'),
            durationMin: p.durationMin ?? null,
            options: p.options || {},
            username: p.kind === 'provider' ? p.username : '',
            template: p.kind === 'custom' ? p.template : '',
            vars: p.vars || {},
            hasPassword: !!p.secret,
            sticky,
            pinnedSid: p.pinned?.SID || p.pinned?.RAND || '',
            display,
            ..._hostOf(display),
            lastTest: p.lastTest || null,
            active: this.data.activeId === p.id,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
    }

    list() { return this.data.profiles.map((p) => this.publicProfile(p)); }

    /**
     * Create or update from UI input. Errors are thrown with a user-facing message.
     * @param {object} input
     * @param {string|null} [id] existing profile to update
     */
    save(input, id = null) {
        const prev = id ? this.get(id) : null;
        const p = this.build(input, id);
        if (prev) this.data.profiles[this.data.profiles.indexOf(prev)] = p;
        else this.data.profiles.push(p);
        this._save();
        return p;
    }

    /**
     * Validate UI input into a profile without storing it (save() and the editor preview).
     * Errors are thrown with a user-facing message.
     */
    build(input, id = null) {
        const prev = id ? this.get(id) : null;
        if (id && !prev) throw new Error('Proxy profile not found');
        if (!prev && this.data.profiles.length >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} profiles`);
        const kind = input.kind === 'provider' ? 'provider' : 'custom';
        const p = {
            id: prev?.id || _id(),
            name: _str(input.name, 120),
            group: _str(input.group, 60),
            notes: _str(input.notes, 2000),
            kind,
            secret: prev?.secret || '',
            pinned: null,
            lastTest: prev?.lastTest || null,
            createdAt: prev?.createdAt || _now(),
            updatedAt: _now(),
        };
        if (kind === 'provider') {
            const meta = providers.getProxyProviderById(_str(input.provider, 40));
            if (!meta) throw new Error('Unknown provider');
            p.provider = meta.id;
            p.username = providers.normalizeProviderAccountUsername(meta, _str(input.username, 300));
            if (!p.username) throw new Error(`${meta.name} username is required`);
            const cc = _str(input.country, 20).toLowerCase();
            p.country = providers.getProviderCountry(meta, cc) ? cc : (meta.countries[0]?.code || '');
            p.sessionMode = input.sessionMode === 'sticky' ? 'sticky' : 'rotating';
            const d = meta.duration || { min: 1, max: 1440, default: 30 };
            p.durationMin = Math.max(d.min, Math.min(d.max, Number(input.durationMin) || d.default));
            p.options = providers.normalizeProviderOptions(meta, input.options || {});
            if (typeof input.password === 'string' && input.password !== '') p.secret = _encrypt(this.key, input.password);
            if (!p.secret) throw new Error(`${meta.name} password is required`);
            if (!p.name) p.name = providers.suggestProfileName(meta.id, p.country, p.sessionMode);
            // Same account, same sticky params → keep the pinned session (and exit IP).
            if (prev && prev.kind === 'provider' && prev.provider === p.provider && prev.country === p.country
                && prev.sessionMode === p.sessionMode && prev.username === p.username) p.pinned = prev.pinned || null;
        } else {
            const split = splitTemplatePassword(input.template);
            if (!split.template) throw new Error('Proxy URL is required');
            p.template = split.template;
            if (split.password != null) p.secret = split.password ? _encrypt(this.key, split.password) : '';
            else if (typeof input.password === 'string' && input.password !== '') p.secret = _encrypt(this.key, input.password);
            if (!/\{PASSWORD\}/i.test(p.template)) p.secret = '';
            const vars = {};
            const allowed = new Set(extractTemplateVars(p.template));
            for (const [k, v] of Object.entries(input.vars || {})) {
                const K = String(k).toUpperCase();
                if (allowed.has(K) && K !== PASSWORD_VAR && K !== 'SID') vars[K] = _str(v, 300);
            }
            p.vars = vars;
            const { host } = _hostOf(p.template);
            if (!p.name) p.name = host || 'Proxy';
            if (prev && prev.kind === 'custom' && prev.template === p.template) p.pinned = prev.pinned || null;
        }
        const check = this.resolve(p, { pin: false });
        if (check.error) throw new Error(check.error);
        return p;
    }

    remove(id) {
        const i = this.data.profiles.findIndex((p) => p.id === id);
        if (i < 0) return false;
        this.data.profiles.splice(i, 1);
        if (this.data.activeId === id) this.data.activeId = null;
        this._save();
        return true;
    }

    duplicate(id) {
        const p = this.get(id);
        if (!p) throw new Error('Proxy profile not found');
        const copy = { ...JSON.parse(JSON.stringify(p)), id: _id(), name: `${p.name} (copy)`, pinned: null, lastTest: null, createdAt: _now(), updatedAt: _now() };
        this.data.profiles.splice(this.data.profiles.indexOf(p) + 1, 0, copy);
        this._save();
        return copy;
    }

    /** Re-roll {SID}/{RAND} for a fresh sticky session. */
    reroll(p) {
        p.pinned = null;
        return this.resolve(p, { reroll: true });
    }

    recordTest(p, result) {
        p.lastTest = result;
        this._save();
    }

    /**
     * Bulk import (one proxy per line, proxy-static-import.js formats).
     * @returns {{ added: object[], errors: object[], duplicates: number, total: number }}
     */
    importLines(text, { group = '', namePrefix = '', dryRun = false } = {}) {
        const parsed = parseStaticProxyLines(String(text || ''));
        const existing = new Set(this.data.profiles.filter((p) => p.kind === 'custom').map((p) => this.resolve(p, { pin: false }).url));
        const added = [];
        let dupes = Number(parsed.duplicates) || 0;
        let n = 0;
        for (const e of parsed.entries) {
            if (existing.has(e.url)) { dupes++; continue; }
            n++;
            const name = namePrefix ? `${namePrefix} ${n}` : `${e.host}:${e.port}`;
            if (dryRun) { added.push({ name, display: maskUrl(e.url), scheme: e.scheme, host: e.host, port: e.port }); continue; }
            if (this.data.profiles.length >= MAX_PROFILES) break;
            const p = this.save({ kind: 'custom', name, group, template: e.url });
            added.push(this.publicProfile(p));
        }
        // Error lines may hold credentials: report the line number and reason only.
        const errors = (parsed.errors || []).map((e) => ({ line: e.line, reason: e.reason }));
        return { added, errors, duplicates: dupes, total: parsed.total ?? parsed.entries.length };
    }
}

/** IP / geo through a proxy, via the AzureTLS worker (the same TLS stack the browser traffic uses). */
async function probeEgress(worker, { proxy = null, browser = 'chrome_120' } = {}) {
    const started = Date.now();
    const get = async (url) => {
        const r = await worker.request({
            method: 'GET', url, proxy: proxy || null, browser,
            headers: { 'User-Agent': TEST_UA, Accept: 'application/json' },
            tabId: 'cupnet-mini-proxytest', timeout: TEST_TIMEOUT_MS, maxRetries: 0,
        });
        const body = r.bodyBase64 != null ? Buffer.from(r.bodyBase64, 'base64').toString('utf8') : String(r.body ?? '');
        return { status: Number(r.statusCode) || 0, body };
    };
    try {
        let r = await get('https://ipinfo.io/json');
        if (r.status === 200) {
            const j = JSON.parse(r.body);
            return {
                ok: true, ip: j.ip || '', country: (j.country || '').toUpperCase(), city: j.city || '', region: j.region || '',
                org: j.org || '', timezone: j.timezone || '', latencyMs: Date.now() - started, at: _now(),
            };
        }
        // ipinfo rate-limits; fall back once.
        r = await get('https://ipwho.is/');
        const j = JSON.parse(r.body);
        if (r.status !== 200 || j.success === false) throw new Error(`IP check failed (HTTP ${r.status})`);
        return {
            ok: true, ip: j.ip || '', country: (j.country_code || '').toUpperCase(), city: j.city || '', region: j.region || '',
            org: j.connection?.org || j.connection?.isp || '', timezone: j.timezone?.id || '', latencyMs: Date.now() - started, at: _now(),
        };
    } catch (e) {
        return { ok: false, error: _friendlyError(e?.message || String(e)), latencyMs: Date.now() - started, at: _now() };
    }
}

function _friendlyError(msg) {
    const m = String(msg);
    if (/407|proxy auth/i.test(m)) return 'Proxy rejected the credentials (407)';
    if (/ECONNREFUSED|connection refused/i.test(m)) return 'Proxy refused the connection';
    if (/ENOTFOUND|no such host/i.test(m)) return 'Proxy host not found';
    if (/timeout|deadline/i.test(m)) return 'Timed out';
    return m.slice(0, 300);
}

/**
 * Wires a ProxyStore to the MITM: connect / disconnect / kill switch / tests / egress status.
 */
class ProxyManager {
    /**
     * @param {ProxyStore} store
     * @param {import('../mitm-proxy').MitmProxy} mitm
     * @param {{ cliUpstream?: string|null, onChange?: () => void, selfPort?: number }} [o]
     *   selfPort: the MITM's own listen port — an upstream pointing back at it would loop forever.
     */
    constructor(store, mitm, o = {}) {
        this.store = store;
        this.mitm = mitm;
        this.selfPort = Number(o.selfPort) || 0;
        this.cliUpstream = o.cliUpstream || null;
        this.onChange = o.onChange || null;
        this._egress = null;
        this._egressAt = 0;
        this._egressPending = null;
        this._testing = new Set();
    }

    /** Restore the last state on start: --upstream wins, else the saved active profile. */
    restore() {
        if (this.cliUpstream) { this.mitm.setUpstream(this.cliUpstream); return; }
        const p = this.store.activeId && this.store.get(this.store.activeId);
        if (p) {
            const r = this.store.resolve(p);
            if (!r.error && !this._isSelf(r.url)) { this.mitm.setUpstream(r.url); return; }
            this.store.setActive(null);
        }
        this._applyDirect();
    }

    _applyDirect() {
        this.mitm.setUpstream(null);
        this.mitm.setEgressBlocked(this.store.killSwitch, 'Kill switch: direct connections are blocked — connect a proxy');
    }

    _changed() {
        this._egress = null;
        this._egressAt = 0;
        if (this.onChange) try { this.onChange(); } catch { /* ignore */ }
    }

    status() {
        const p = this.store.activeId ? this.store.get(this.store.activeId) : null;
        return {
            mode: this.cliUpstream ? 'cli' : (p ? 'proxy' : 'direct'),
            active: p ? this.store.publicProfile(p) : null,
            cliUpstream: this.cliUpstream ? maskUrl(this.cliUpstream) : null,
            killSwitch: this.store.killSwitch,
            blocked: this.mitm.isEgressBlocked(),
            blockReason: this.mitm.isEgressBlocked() ? this.mitm.getEgressBlockReason() : '',
            egress: this._egress,
            egressAt: this._egressAt || null,
        };
    }

    connect(id) {
        const p = this.store.get(id);
        if (!p) throw new Error('Proxy profile not found');
        const r = this.store.resolve(p);
        if (r.error) throw new Error(r.error);
        if (this._isSelf(r.url)) throw new Error(`That is CupNet's own proxy port (${this.selfPort}) — using it as the upstream would loop`);
        this.cliUpstream = null;
        this.mitm.setUpstream(r.url);
        this.store.setActive(p.id);
        this._changed();
        return this.status();
    }

    _isSelf(url) {
        if (!this.selfPort) return false;
        try {
            const u = new URL(url);
            const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
            const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0';
            return loopback && Number(u.port) === this.selfPort;
        } catch { return false; }
    }

    disconnect() {
        this.cliUpstream = null;
        this.store.setActive(null);
        this._applyDirect();
        this._changed();
        return this.status();
    }

    /** New sticky session → new exit IP. Re-applies the upstream when the profile is connected. */
    newIp(id) {
        const p = this.store.get(id || this.store.activeId);
        if (!p) throw new Error('No proxy profile selected');
        const r = this.store.reroll(p);
        if (r.error) throw new Error(r.error);
        if (this.store.activeId === p.id) {
            this.mitm.setUpstream(r.url);
            this._changed();
        }
        return this.store.publicProfile(p);
    }

    setKillSwitch(on) {
        this.store.setKillSwitch(on);
        if (!this.mitm.upstream) this._applyDirect();
        this._changed();
        return this.status();
    }

    async test(id) {
        const p = this.store.get(id);
        if (!p) throw new Error('Proxy profile not found');
        const r = this.store.resolve(p);
        const err = r.error || (this._isSelf(r.url) ? `That is CupNet's own proxy port (${this.selfPort})` : null);
        if (err) {
            const res = { ok: false, error: err, at: _now() };
            this.store.recordTest(p, res);
            return res;
        }
        this._testing.add(id);
        try {
            const res = await probeEgress(this.mitm.worker, { proxy: r.url, browser: this.mitm.browser });
            if (this.store.get(id)) this.store.recordTest(p, res);
            if (this.store.activeId === id && res.ok) { this._egress = { ...res, via: 'proxy' }; this._egressAt = Date.now(); }
            return res;
        } finally {
            this._testing.delete(id);
        }
    }

    /** Test many profiles a few at a time. */
    async testMany(ids) {
        const queue = [...new Set(ids)].filter((id) => this.store.get(id));
        const results = {};
        const run = async () => {
            while (queue.length) {
                const id = queue.shift();
                try { results[id] = await this.test(id); } catch (e) { results[id] = { ok: false, error: e.message }; }
            }
        };
        await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, queue.length) }, run));
        return results;
    }

    get testing() { return [...this._testing]; }

    /**
     * What the exit-IP monitor needs about the current connection. `proxy` is used for its requests
     * only; the monitor never stores it (it can hold credentials).
     */
    connectionContext() {
        const p = this.store.activeId ? this.store.get(this.store.activeId) : null;
        const pub = p ? this.store.publicProfile(p) : null;
        return {
            worker: this.mitm.worker,
            proxy: this.mitm.upstream || null,
            browser: this.mitm.browser,
            blocked: this.mitm.isEgressBlocked(),
            blockReason: this.mitm.isEgressBlocked() ? this.mitm.getEgressBlockReason() : '',
            label: this.cliUpstream ? 'CLI upstream' : (pub ? pub.name : 'Direct'),
            mode: this.cliUpstream ? 'cli' : (pub ? pub.sessionMode : 'direct'),
        };
    }

    /** Take an exit IP measured elsewhere (the IP monitor) as the current egress. */
    adoptEgress(eg) {
        if (!eg || !eg.ok) return;
        this._egress = eg;
        this._egressAt = Date.now();
    }

    /** Current exit IP/geo of the MITM (cached for a minute; force re-checks). */
    async egress({ force = false } = {}) {
        if (!force && this._egress && Date.now() - this._egressAt < EGRESS_CACHE_MS) return this._egress;
        if (this.mitm.isEgressBlocked() && !this.mitm.upstream) {
            return { ok: false, blocked: true, error: this.mitm.getEgressBlockReason(), at: _now() };
        }
        if (!this._egressPending) {
            const proxy = this.mitm.upstream || null;
            this._egressPending = probeEgress(this.mitm.worker, { proxy, browser: this.mitm.browser })
                .then((res) => {
                    // Ignore a result for an upstream that changed meanwhile.
                    if ((this.mitm.upstream || null) === proxy) {
                        this._egress = { ...res, via: proxy ? 'proxy' : 'direct' };
                        this._egressAt = Date.now();
                    }
                    return { ...res, via: proxy ? 'proxy' : 'direct' };
                })
                .finally(() => { this._egressPending = null; });
        }
        return this._egressPending;
    }
}

/** Provider catalog for the editor (no functions). */
function providerCatalog() {
    return providers.getProxyProviders().map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        scheme: p.scheme,
        session: p.session || {},
        duration: p.duration || null,
        optionFields: providers.getProviderOptionFields(p),
        countries: (p.countries || []).map((c) => ({ code: c.code, name: c.name, region: c.region })),
    }));
}

module.exports = {
    ProxyStore, ProxyManager, providerCatalog, probeEgress, splitTemplatePassword, validateProxyUrl, maskUrl,
};
