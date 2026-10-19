'use strict';

/**
 * CupNet mini — the CupNet MITM + Go AzureTLS worker without Electron, for use with real Chrome.
 *
 *   Chrome (dedicated profile) ──HTTP proxy──▶ MitmProxy 127.0.0.1:<mitmPort> ──AzureTLS──▶ origin
 *                                                │ intercept rules (block/mock/modifyHeaders/script/inject)
 *                                                │ /__cupnet/* served locally (page events)
 *                                                └▶ SessionLog (sessions/<id>.jsonl + index) ◀── UI 127.0.0.1:<uiPort>
 *
 * Everything listens on loopback only. Data lives in <dataDir> (default ~/.cupnet-mini):
 *   ca/ca-key.pem, ca/ca-cert.pem · rules.json · sessions/*.jsonl · chrome-profile/ · ui-profile/ · ui-token
 *   keys/<id>.cupkey (one key per session) · sealed/<id>.cupsess (encrypted sessions, see session-crypto.js)
 *   proxies.json + proxies.key (proxy profiles, passwords encrypted; proxy-store.js) · settings.json
 *
 * Plain Node ≥ 20 is enough: no Electron, no native modules (rules live in a JSON file, rule-store.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { SessionLog } = require('./session-log');
const sessionCrypto = require('./session-crypto');
const { spkiHashFromCertPem, fingerprintSha256, caInstructions } = require('./ca');
const { launchChrome, launchAppWindow } = require('./chrome');
const { createUiServer } = require('./ui-server');
const { RuleStore } = require('./rule-store');
const { ProxyStore, ProxyManager } = require('./proxy-store');

const PAGE_EVENT_MAX_BYTES = 64 * 1024;
/** Bodies are logged in full; this only guards V8's string limit (base64 of the body must fit). */
const DEFAULT_LOG_BODY_MAX_BYTES = 256 * 1024 * 1024;
const LAUNCH_CODE_TTL_MS = 60 * 1000;
/** A paused request continues unchanged after this long without an answer from the UI. */
const BREAKPOINT_TIMEOUT_MS = 120 * 1000;
const REPLAY_TIMEOUT_MS = 60 * 1000;
const MAX_PAUSED = 200;

/** AzureTLS presets (azuretls-go/profiles.go). Real Chrome drives the traffic, so Chrome/Edge match it best. */
const TLS_PROFILES = [
    { id: 'chrome', name: 'Chrome (latest)', note: 'Matches the real Chrome mini launches — recommended' },
    { id: 'edge', name: 'Edge (latest)', note: 'Chromium-based; consistent with Chrome' },
    { id: 'opera', name: 'Opera (latest)', note: 'Chromium-based' },
    { id: 'firefox', name: 'Firefox (latest)', note: 'TLS/H2 will not match the Chrome user agent and JS' },
    { id: 'safari', name: 'Safari (macOS)', note: 'TLS/H2 will not match the Chrome user agent and JS' },
    { id: 'ios', name: 'iOS Safari', note: 'TLS/H2 will not match the Chrome user agent and JS' },
];

const DEFAULT_SETTINGS = {
    browser: 'chrome',
    tlsPassthrough: ['challenges.cloudflare.com'],
    cors: false,
    forceHttp1: false,
};

const TEXT_MIME = /^(text\/|application\/(json|[\w.+-]*\+json|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;

function defaultDataDir() {
    return process.env.CUPNET_MINI_DIR || path.join(os.homedir(), '.cupnet-mini');
}

function _readOrCreateToken(file) {
    try {
        const t = fs.readFileSync(file, 'utf8').trim();
        if (/^[A-Za-z0-9_-]{32,}$/.test(t)) return t;
    } catch { /* create below */ }
    const t = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(file, `${t}\n`, { mode: 0o600 });
    return t;
}

function _textResponse(statusCode, text, extraHeaders = {}) {
    return {
        statusCode,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
        bodyBase64: Buffer.from(String(text), 'utf8').toString('base64'),
    };
}

class MiniApp {
    /**
     * @param {object} o
     * @param {string} [o.dataDir]
     * @param {number} [o.mitmPort=8877]
     * @param {number} [o.uiPort=8878]
     * @param {string} [o.browser='chrome_120'] AzureTLS profile for the upstream TLS/H2 fingerprint
     * @param {string} [o.upstream] upstream proxy URL (http://, socks5://), default direct
     * @param {'spki'|'system'} [o.trust='spki']
     * @param {string} [o.chromeBinary]
     * @param {() => void} [o.onQuit] called when the UI asks to quit
     */
    constructor(o = {}) {
        this.dataDir = path.resolve(o.dataDir || defaultDataDir());
        this.mitmPort = Number(o.mitmPort) || 8877;
        this.uiPort = o.uiPort === 0 ? 0 : (Number(o.uiPort) || 8878);
        /** --browser from the CLI wins over settings.json for this run. */
        this.browserArg = o.browser || null;
        this.browser = o.browser || DEFAULT_SETTINGS.browser;
        this.upstream = o.upstream || null;
        this.trust = o.trust === 'system' ? 'system' : 'spki';
        this.chromeBinary = o.chromeBinary || null;
        this.onQuit = o.onQuit || null;
        this.mitm = null;
        this.uiWindow = null;
        this._launchCodes = new Map();
        this.ui = null;
        this.log = null;
        this.proxies = null;
        this.settings = { ...DEFAULT_SETTINGS };
        /** Requests paused by breakpoint rules: id → { info, resolve, timer } */
        this._paused = new Map();
    }

    get caDir() { return path.join(this.dataDir, 'ca'); }
    get caCertPath() { return path.join(this.caDir, 'ca-cert.pem'); }
    get profileDir() { return path.join(this.dataDir, 'chrome-profile'); }
    get uiProfileDir() { return path.join(this.dataDir, 'ui-profile'); }
    get rulesFile() { return path.join(this.dataDir, 'rules.json'); }
    get tokenFile() { return path.join(this.dataDir, 'ui-token'); }
    get sessionsDir() { return path.join(this.dataDir, 'sessions'); }
    get keysDir() { return path.join(this.dataDir, 'keys'); }
    get sealedDir() { return path.join(this.dataDir, 'sealed'); }
    get proxiesFile() { return path.join(this.dataDir, 'proxies.json'); }
    get proxiesKeyFile() { return path.join(this.dataDir, 'proxies.key'); }
    get settingsFile() { return path.join(this.dataDir, 'settings.json'); }

    /** Encrypt a saved session into sealed/<id>.cupsess (its key file is created on first use). */
    sealSession(sessionId) {
        return sessionCrypto.sealSession({
            sessionsDir: this.sessionsDir, keysDir: this.keysDir, sealedDir: this.sealedDir, sessionId,
        });
    }

    /** CA only (no MITM/db) — for `ca` CLI commands. */
    loadCa() {
        fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        const { loadOrGenerateCA } = require('../mitm-ca');
        const { caCertPem } = loadOrGenerateCA(this.caDir);
        return {
            certPath: this.caCertPath,
            spki: spkiHashFromCertPem(caCertPem),
            sha256: fingerprintSha256(caCertPem),
            commands: caInstructions(this.caCertPath),
        };
    }

    async start() {
        const ca = this.loadCa();
        this.ca = ca;
        // The Go worker always runs as a child process here (no in-process ffi without Electron).
        process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1';
        // Log everything: full bodies, media included. Read by mitm-proxy.js at require time.
        if (!process.env.CUPNET_LOG_BODY_MAX_BYTES) process.env.CUPNET_LOG_BODY_MAX_BYTES = String(DEFAULT_LOG_BODY_MAX_BYTES);
        if (!process.env.CUPNET_LOG_MEDIA_BODIES) process.env.CUPNET_LOG_MEDIA_BODIES = '1';

        this.rules = new RuleStore(this.rulesFile);
        this.rulesImported = this.rules.importFromSqlite(path.join(this.dataDir, 'cupnet-mini.db'));
        const interceptor = require('../request-interceptor');
        this.interceptor = interceptor;
        interceptor.setRuleStore(this.rules);
        interceptor.setLocalEndpointHandler((req) => this._handleLocalEndpoint(req));
        interceptor.setBreakpointHandler((opts, rule) => this._pauseRequest(opts, rule));
        this._loadSettings();

        this.log = new SessionLog({ dir: this.sessionsDir });
        // The key exists from the first request, so the session's sealed name is known up front.
        this.sessionKey = sessionCrypto.ensureSessionKey(this.keysDir, this.log.sessionId);

        const { MitmProxy } = require('../mitm-proxy');
        this.mitm = new MitmProxy({
            port: this.mitmPort,
            browser: this.browser,
            sendCaChain: true,
            onRequestLogged: (e) => {
                // Our own beacons are already logged as page events.
                if (/^https?:\/\/[^/]+\/__cupnet\//i.test(String(e.url || ''))) return;
                this.log.logRequest(e);
            },
        });
        this._applySettings();
        await this.mitm.start();
        this.proxies = new ProxyManager(new ProxyStore(this.proxiesFile, this.proxiesKeyFile), this.mitm, { cliUpstream: this.upstream, selfPort: this.mitmPort });
        this.proxies.restore();

        this.token = _readOrCreateToken(this.tokenFile);
        this.ui = createUiServer(this);
        await this.ui.listen(this.uiPort);
        this.uiPort = this.ui.port;
        return this;
    }

    get uiUrl() {
        return `http://127.0.0.1:${this.uiPort}/#t=${this.token}`;
    }

    /**
     * One-time code for opening the UI without putting the token on a command line (other local users
     * can read process arguments). The page trades it for the token once: POST /api/auth/exchange.
     */
    newLaunchCode() {
        const code = crypto.randomBytes(18).toString('base64url');
        this._launchCodes.set(code, Date.now() + LAUNCH_CODE_TTL_MS);
        return code;
    }

    /** @returns {boolean} true once per valid, unexpired code */
    redeemLaunchCode(code) {
        const now = Date.now();
        for (const [c, exp] of this._launchCodes) if (exp < now) this._launchCodes.delete(c);
        if (typeof code !== 'string' || !this._launchCodes.has(code)) return false;
        this._launchCodes.delete(code);
        return true;
    }

    /** The CupNet mini window: the UI as a Chrome app window on its own profile (not proxied). */
    openWindow() {
        const url = `http://127.0.0.1:${this.uiPort}/#c=${this.newLaunchCode()}`;
        const r = launchAppWindow({ binary: this.chromeBinary, profileDir: this.uiProfileDir, url });
        if (r.success) this.uiWindow = r;
        return r;
    }

    requestQuit() {
        if (this.onQuit) setImmediate(this.onQuit);
        return !!this.onQuit;
    }

    launchChrome(url) {
        return launchChrome({
            binary: this.chromeBinary,
            mitmPort: this.mitmPort,
            profileDir: this.profileDir,
            trust: this.trust,
            caSpki: this.ca?.spki || this.loadCa().spki,
            url,
        });
    }

    /**
     * `/__cupnet/*` on any origin — reached only by pages in the proxied Chrome. Write-only on purpose:
     * every website can call these paths, so nothing here may return logged data.
     */
    async _handleLocalEndpoint(req) {
        const u = new URL(req.url);
        const sub = u.pathname.slice('/__cupnet/'.length);
        if (sub === 'ping') return _textResponse(200, 'ok');
        if (sub === 'event') {
            if (!/^POST$/i.test(req.method || '')) return _textResponse(405, 'POST only', { Allow: 'POST' });
            const raw = req.bodyBase64 != null
                ? Buffer.from(String(req.bodyBase64), 'base64')
                : Buffer.from(String(req.body ?? ''), 'utf8');
            if (raw.length > PAGE_EVENT_MAX_BYTES) return _textResponse(413, 'too large');
            let data;
            try { data = JSON.parse(raw.toString('utf8') || 'null'); } catch { data = raw.toString('utf8'); }
            const h = req.headers || {};
            const referer = h.referer || h.Referer || `${u.origin}/`;
            this.log.logPageEvent(String(referer), data);
            return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, bodyBase64: '' };
        }
        return _textResponse(404, 'unknown CupNet endpoint');
    }

    // ── Settings ────────────────────────────────────────────────────────────────

    _loadSettings() {
        try {
            const d = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
            this.settings = this._cleanSettings({ ...DEFAULT_SETTINGS, ...d });
        } catch { this.settings = { ...DEFAULT_SETTINGS }; }
        if (!this.browserArg) this.browser = this.settings.browser;
    }

    _cleanSettings(s) {
        const browser = TLS_PROFILES.some((t) => t.id === s.browser) || /^chrome_\d+$/.test(String(s.browser)) ? String(s.browser) : DEFAULT_SETTINGS.browser;
        const domains = (Array.isArray(s.tlsPassthrough) ? s.tlsPassthrough : String(s.tlsPassthrough || '').split(/[\s,]+/))
            .map((d) => String(d || '').trim().toLowerCase())
            .filter((d) => /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(d))
            .slice(0, 200);
        return { browser, tlsPassthrough: [...new Set(domains)], cors: !!s.cors, forceHttp1: !!s.forceHttp1 };
    }

    _applySettings() {
        if (!this.mitm) return;
        this.mitm.setBrowser(this.browser);
        this.mitm.setTlsPassthroughDomains(this.settings.tlsPassthrough);
        this.mitm.setGlobalCorsEnabled(this.settings.cors);
        this.mitm.setForceHttp1(this.settings.forceHttp1);
    }

    getSettings() {
        return {
            ...this.settings,
            browser: this.browser,
            browserFromCli: !!this.browserArg,
            tlsProfiles: TLS_PROFILES,
        };
    }

    updateSettings(patch) {
        const next = this._cleanSettings({ ...this.settings, ...(patch || {}) });
        this.settings = next;
        if (patch && patch.browser != null) { this.browser = next.browser; this.browserArg = null; }
        const tmp = `${this.settingsFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.settingsFile);
        this._applySettings();
        return this.getSettings();
    }

    // ── Breakpoints (rules with breakpoint_enabled) ────────────────────────────

    _pauseRequest(opts, rule) {
        if (this._paused.size >= MAX_PAUSED) return Promise.resolve({ action: 'forward' });
        const id = crypto.randomBytes(6).toString('hex');
        const info = {
            id,
            at: Date.now(),
            ruleId: rule.id,
            ruleName: rule.name,
            method: opts.method || 'GET',
            url: opts.url,
            headers: Array.isArray(opts.orderedHeaders) && opts.orderedHeaders.length
                ? opts.orderedHeaders.map(([k, v]) => [String(k), String(v)])
                : Object.entries(opts.headers || {}).map(([k, v]) => [k, String(v)]),
            body: opts.bodyBase64 != null ? `__b64__:${opts.bodyBase64}` : (opts.body != null ? String(opts.body) : ''),
            timeoutMs: BREAKPOINT_TIMEOUT_MS,
        };
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.resumeRequest(id, { action: 'forward' }), BREAKPOINT_TIMEOUT_MS);
            this._paused.set(id, { info, resolve, timer });
        });
    }

    listPaused() { return [...this._paused.values()].map((p) => p.info); }

    /**
     * @param {string} id
     * @param {{ action: 'forward'|'block', method?: string, url?: string, headers?: Array<[string,string]>, body?: string }} r
     */
    resumeRequest(id, r = {}) {
        const p = this._paused.get(id);
        if (!p) return false;
        clearTimeout(p.timer);
        this._paused.delete(id);
        if (r.action === 'block') { p.resolve({ action: 'block' }); return true; }
        const patch = {};
        if (r.method) patch.method = String(r.method).toUpperCase();
        if (r.url && /^https?:\/\//i.test(r.url)) patch.url = String(r.url);
        if (Array.isArray(r.headers)) {
            const pairs = r.headers.filter((h) => Array.isArray(h) && h[0]).map(([k, v]) => [String(k), String(v ?? '')]);
            patch.orderedHeaders = pairs;
            patch.headers = Object.fromEntries(pairs);
        }
        if (typeof r.body === 'string' && r.body !== p.info.body) {
            if (r.body.startsWith('__b64__:')) patch.bodyBase64 = r.body.slice(8);
            else patch.body = r.body;
        }
        p.resolve({ action: 'forward', patch: Object.keys(patch).length ? patch : undefined });
        return true;
    }

    // ── Repeater ────────────────────────────────────────────────────────────────

    /**
     * Send a request through the AzureTLS worker with the current upstream and TLS profile, and log it
     * to the session as type "repeater". Intercept rules do not apply.
     * @param {{ method?: string, url: string, headers?: Array<[string,string]>|Record<string,string>, body?: string, followRedirects?: boolean }} r
     */
    async replay(r) {
        const url = String(r?.url || '').trim();
        if (!/^https?:\/\/[^/]/i.test(url)) throw Object.assign(new Error('URL must start with http:// or https://'), { status: 400 });
        const method = String(r.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
        const pairs = (Array.isArray(r.headers) ? r.headers : Object.entries(r.headers || {}))
            .filter((h) => Array.isArray(h) && String(h[0] || '').trim())
            .map(([k, v]) => [String(k).trim(), String(v ?? '')]);
        const headers = {};
        for (const [k, v] of pairs) headers[k] = v;
        const proxy = this.mitm.upstream || null;
        if (!proxy && this.mitm.isEgressBlocked()) {
            throw Object.assign(new Error(this.mitm.getEgressBlockReason() || 'Egress blocked'), { status: 409 });
        }
        const body = typeof r.body === 'string' ? r.body : '';
        const isB64 = body.startsWith('__b64__:');
        const started = Date.now();
        let res;
        try {
            res = await this.mitm.worker.request({
                method, url, headers, orderedHeaders: pairs,
                ...(body ? (isB64 ? { bodyBase64: body.slice(8) } : { body }) : {}),
                proxy, browser: this.browser, tabId: 'cupnet-mini-repeater',
                timeout: REPLAY_TIMEOUT_MS, maxRetries: 0, disableRedirects: !r.followRedirects,
                forceHttp1: !!this.settings.forceHttp1,
            });
        } catch (e) {
            res = { statusCode: 0, headers: {}, error: e?.message || String(e) };
        }
        const duration = Date.now() - started;
        const rawRes = res.bodyBase64 != null ? Buffer.from(String(res.bodyBase64), 'base64') : Buffer.from(String(res.body ?? ''), 'utf8');
        const ct = Object.entries(res.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
        const mime = String(Array.isArray(ct) ? ct[0] : (ct || ''));
        const responseBody = !rawRes.length ? (res.error ? `CupNet repeater error: ${res.error}` : null)
            : (TEXT_MIME.test(mime) ? rawRes.toString('utf8') : `__b64__:${rawRes.toString('base64')}`);
        const entry = this.log.logRequest({
            method, url, status: Number(res.statusCode) || 0, type: 'repeater', duration,
            requestHeaders: headers, responseHeaders: res.headers || {},
            requestBody: body || null, responseBody,
        });
        return { seq: entry.seq, status: entry.status, duration, error: res.error || null };
    }

    async stop() {
        try { this.interceptor?.setLocalEndpointHandler(null); } catch { /* ignore */ }
        try { this.interceptor?.setBreakpointHandler(null); } catch { /* ignore */ }
        for (const id of [...this._paused.keys()]) this.resumeRequest(id, { action: 'forward' });
        if (this.ui) { await this.ui.close().catch(() => {}); this.ui = null; }
        if (this.mitm) { this.mitm.stop(); this.mitm = null; }
        try { this.interceptor?.setRuleStore(null); } catch { /* ignore */ }
        try { this.rules?.close(); } catch { /* ignore */ }
        if (this.uiWindow?.pid) { try { process.kill(this.uiWindow.pid); } catch { /* already closed */ } this.uiWindow = null; }
        if (this.log) {
            const { sessionId } = this.log;
            await this.log.close();
            this.log = null;
            try { this.sealed = this.sealSession(sessionId); } catch { /* the plain JSONL is still there */ }
        }
    }
}

module.exports = { MiniApp, defaultDataDir };
