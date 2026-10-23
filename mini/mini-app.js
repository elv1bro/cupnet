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

const { SessionLog, newSessionId } = require('./session-log');
const { parseHar } = require('./har');
const sessionCrypto = require('./session-crypto');
const { spkiHashFromCertPem, fingerprintSha256, caInstructions, caTrustStatus, installCa } = require('./ca');
const { launchChrome, launchAppWindow } = require('./chrome');
const { createUiServer } = require('./ui-server');
const { RuleStore } = require('./rule-store');
const { ProxyStore, ProxyManager } = require('./proxy-store');
const { IpMonitor } = require('./ip-monitor');
const { CookieJar } = require('./cookie-jar');
const { DnsStore } = require('./dns-store');
const { NotesStore } = require('./notes-store');
const { SiteMapCache } = require('./site-map');
const { MirrorAudit } = require('./mirror-audit');
const { WsHub } = require('./ws-hub');
const { ShareHost } = require('./share-host');
const { PageAgents, POLL_IDLE_MS } = require('./page-agents');
const { buildAgentSource } = require('./page-agent');
const pageAnalyzer = require('./page-analyzer');

const PAGE_EVENT_MAX_BYTES = 64 * 1024;
/** Page agent posts (console batches are ≤48 KB; analyzer results carry the page's inline scripts). */
const AGENT_CONSOLE_MAX_BYTES = 256 * 1024;
const AGENT_RESULT_MAX_BYTES = 16 * 1024 * 1024;
const AGENT_SMALL_MAX_BYTES = 16 * 1024;
const CONSOLE_BATCH_MAX = 500;
const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
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
    /** Exit-IP monitor: check every ipWatchSec seconds and keep a history of changes. */
    ipWatch: true,
    ipWatchSec: 15,
    /**
     * Inject the page agent (console capture, Console REPL, page analyzer) into HTML documents. Off by
     * default: it wraps console.* and polls /__cupnet/agent/*, which a page can notice.
     */
    pageAgent: false,
    /** Hosts (and their subdomains, or *.host) the agent is never injected into. */
    pageAgentExclude: ['challenges.cloudflare.com'],
    /** Local test host for sealed sessions (viewer + .cupsess files) on 127.0.0.1:sharePort. */
    shareHost: false,
    sharePort: 8879,
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

function _jsonResponse(statusCode, obj) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        bodyBase64: Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'),
    };
}

const _NO_CONTENT = () => ({ statusCode: 204, headers: { 'Cache-Control': 'no-store' }, bodyBase64: '' });

function _reqBody(req) {
    return req.bodyBase64 != null
        ? Buffer.from(String(req.bodyBase64), 'base64')
        : Buffer.from(String(req.body ?? ''), 'utf8');
}

function _parseList(v) {
    return (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/))
        .map((d) => String(d || '').trim().toLowerCase())
        .filter((d) => DOMAIN_RE.test(d))
        .slice(0, 200);
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
        /** When --trust was not given, auto-pick system once we see the CA is already trusted. */
        this.trustForced = o.trust === 'system' || o.trust === 'spki';
        this.chromeBinary = o.chromeBinary || null;
        this.onQuit = o.onQuit || null;
        this.mitm = null;
        this.uiWindow = null;
        this._launchCodes = new Map();
        this.ui = null;
        this.log = null;
        this.proxies = null;
        this.ipMonitor = null;
        this.settings = { ...DEFAULT_SETTINGS };
        /** Requests paused by breakpoint rules: id → { info, resolve, timer } */
        this._paused = new Map();
        /** Pages running the page agent (console + analyzer). */
        this.pages = new PageAgents();
        this._agentSource = null;
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
    get ipHistoryFile() { return path.join(this.dataDir, 'ip-history.jsonl'); }
    get cookiesFile() { return path.join(this.dataDir, 'cookies.json'); }
    get dnsFile() { return path.join(this.dataDir, 'dns.json'); }
    get notesFile() { return path.join(this.dataDir, 'notes.json'); }
    get mirrorDir() { return path.join(this.dataDir, 'mirror'); }

    /** Push DNS rules to the MITM: dial mode (URL, SNI and HTTP/2 kept) with `*.domain` rules. */
    applyDns() {
        this.mitm?.setDnsOverrides(this.dns.toMitmRules(), { dial: true, wildcards: true });
    }

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
        // If the user never forced --trust, drop the SPKI flag (and its Chrome banner) the moment the
        // CA is already trusted in the OS store.
        if (!this.trustForced) {
            try {
                this.caStatusCache = caTrustStatus(ca.certPath);
                if (this.caStatusCache.trusted) this.trust = 'system';
            } catch { /* keep spki */ }
        }
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
        interceptor.setDocumentScriptsProvider((opts) => this._documentScripts(opts));
        this.mirrorAudit = new MirrorAudit({ dir: this.mirrorDir });
        interceptor.setMirrorAuditSink((e) => { try { this.mirrorAudit.add(e); } catch { /* ignore */ } });
        this._loadSettings();

        this.log = new SessionLog({ dir: this.sessionsDir });
        // The key exists from the first request, so the session's sealed name is known up front.
        this.sessionKey = sessionCrypto.ensureSessionKey(this.keysDir, this.log.sessionId);
        // Every intercept-rule match (and rule error) becomes an Activity-feed entry.
        this.rules.on('hit', (r) => { try { this.log?.logRule(r); } catch { /* ignore */ } });

        this.cookies = new CookieJar({ file: this.cookiesFile });
        this.dns = new DnsStore({ file: this.dnsFile });
        this.notes = new NotesStore({ file: this.notesFile });
        this.siteMaps = new SiteMapCache();
        this.ws = new WsHub({ getLog: () => this.log });
        const { MitmProxy } = require('../mitm-proxy');
        this.mitm = new MitmProxy({
            port: this.mitmPort,
            browser: this.browser,
            sendCaChain: true,
            onRequestLogged: (e) => {
                // Our own beacons are already logged as page events.
                if (/^https?:\/\/[^/]+\/__cupnet\//i.test(String(e.url || ''))) return;
                if (this.settings.pageAgent || this._agentSource) {
                    const s = pageAnalyzer.stripAgentFromLoggedDocument(e.responseBody, e.responseHeaders);
                    if (s) e = { ...e, responseBody: s.body, responseHeaders: s.headers };
                }
                const entry = this.log.logRequest(e);
                if (e.type === 'websocket' && e.status === 101) this.ws.noteUpgrade(e.requestId, entry?.seq);
                this.cookies.observe(e);
                if (e.dnsOverride) this.dns.noteHit(e.dnsOverride, { ...e, seq: entry?.seq });
            },
            onWebSocket: (w) => this.ws.attach(w),
            onBeforeUpstream: (up) => { this.cookies.beforeUpstream(up); },
            onResponseHead: (up, out) => { this.cookies.responseHead(up, out); return out; },
        });
        this._applySettings();
        await this.mitm.start();
        this.applyDns();
        this.proxies = new ProxyManager(new ProxyStore(this.proxiesFile, this.proxiesKeyFile), this.mitm, {
            cliUpstream: this.upstream, selfPort: this.mitmPort, onChange: () => this.ipMonitor?.noteSwitch(),
        });
        this.proxies.restore();
        this.ipMonitor = new IpMonitor({
            file: this.ipHistoryFile,
            getContext: () => this.proxies.connectionContext(),
            enabled: this.settings.ipWatch,
            intervalMs: this.settings.ipWatchSec * 1000,
        });
        this.ipMonitor.on('ok', (eg) => this.proxies?.adoptEgress(eg));
        this.ipMonitor.on('event', (ev) => this.log?.logIp(ev));
        this.ipMonitor.start();

        this.token = _readOrCreateToken(this.tokenFile);
        this.ui = createUiServer(this);
        await this.ui.listen(this.uiPort);
        this.uiPort = this.ui.port;
        if (this.settings.shareHost) await this.applyShareHost();
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

    /** Read-only trust-store status for the UI (is the CA installed/trusted, and which mode is live). */
    caStatus() {
        const ca = this.ca || this.loadCa();
        let st;
        try {
            st = caTrustStatus(ca.certPath);
        } catch (e) {
            st = { platform: process.platform, installed: false, trusted: false, supported: true, error: String(e?.message || e) };
        }
        this.caStatusCache = st;
        return {
            ...st,
            trust: this.trust,
            forced: this.trustForced,
            certPath: ca.certPath,
            sha256: ca.sha256,
            commands: ca.commands,
        };
    }

    /**
     * Install the CA on the user's click. The OS raises its own password prompt; on success we switch
     * to trust=system so the next Chrome launch drops the --ignore-certificate-errors-spki-list flag.
     */
    async installCaIntoStore() {
        const ca = this.ca || this.loadCa();
        const r = await installCa(ca.certPath);
        if (r.ok) {
            this.trust = 'system';
            try { this.caStatusCache = caTrustStatus(ca.certPath); } catch { /* best effort */ }
        }
        return { ...r, trust: this.trust };
    }

    /**
     * Import a HAR document as a new saved session (never the live one). Writes a fresh
     * sessions/import-<id>.jsonl with one `request` entry per HAR entry — full headers and bodies kept.
     * @param {Buffer|string} harBuf
     * @returns {{ ok: true, sessionId: string, entries: number } | { ok: false, error: string }}
     */
    importHar(harBuf) {
        let entries;
        try {
            entries = parseHar(typeof harBuf === 'string' ? harBuf : Buffer.from(harBuf).toString('utf8'));
        } catch (e) {
            return { ok: false, error: `не похоже на HAR: ${e?.message || e}` };
        }
        if (!entries.length) return { ok: false, error: 'в HAR нет запросов' };
        const sessionId = `import-${newSessionId()}`;
        const log = new SessionLog({ dir: this.sessionsDir, sessionId });
        try {
            for (const e of entries) log.logRequest(e);
        } finally {
            // close() appends session-end and closeSyncs the fd — synchronous, so the file is complete now.
            try { log.close(); } catch { /* ignore */ }
        }
        return { ok: true, sessionId, entries: entries.length };
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
            return _NO_CONTENT();
        }
        if (sub === 'console' || sub.startsWith('agent/')) return this._handleAgentEndpoint(sub, u.origin, req);
        return _textResponse(404, 'unknown CupNet endpoint');
    }

    // ── Page agent (console + analyzer) ─────────────────────────────────────────

    _agentExcluded(host) {
        const h = String(host || '').toLowerCase();
        return this.settings.pageAgentExclude.some((d) => {
            const base = d.startsWith('*.') ? d.slice(2) : d;
            return h === base || h.endsWith(`.${base}`);
        });
    }

    /** request-interceptor document scripts provider: the agent for every HTML document load. */
    _documentScripts(opts) {
        if (!this.settings.pageAgent) return null;
        let host = '';
        try { host = new URL(opts.url).hostname; } catch { return null; }
        if (this._agentExcluded(host)) return null;
        if (!this._agentSource) this._agentSource = buildAgentSource({ poll: POLL_IDLE_MS });
        return [{ source: this._agentSource, position: 'head', name: pageAnalyzer.AGENT_RULE_NAME, connectSelf: true }];
    }

    _handleAgentEndpoint(sub, origin, req) {
        if (!/^POST$/i.test(req.method || '')) return _textResponse(405, 'POST only', { Allow: 'POST' });
        // Turning the agent off stops the pages that still run it (they quit on 410).
        if (!this.settings.pageAgent) return _textResponse(410, 'page agent is off');
        const raw = _reqBody(req);
        const max = sub === 'agent/result' ? AGENT_RESULT_MAX_BYTES : sub === 'console' ? AGENT_CONSOLE_MAX_BYTES : AGENT_SMALL_MAX_BYTES;
        if (raw.length > max) return _textResponse(413, 'too large');
        let b;
        try { b = JSON.parse(raw.toString('utf8')); } catch { return _textResponse(400, 'bad JSON'); }
        if (!b || typeof b !== 'object') return _textResponse(400, 'bad body');
        if (sub === 'agent/poll') {
            const r = this.pages.poll(origin, b);
            return r ? _jsonResponse(200, r) : _textResponse(400, 'bad document id');
        }
        if (sub === 'agent/hello') {
            return this.pages.touch(origin, b) ? _NO_CONTENT() : _textResponse(400, 'bad document id');
        }
        if (sub === 'agent/result') {
            return this.pages.result(origin, b) ? _NO_CONTENT() : _textResponse(404, 'no such command');
        }
        if (sub === 'console') {
            const d = this.pages.touch(origin, b);
            if (!d) return _textResponse(400, 'bad document id');
            const items = Array.isArray(b.items) ? b.items.slice(0, CONSOLE_BATCH_MAX) : [];
            this.pages.noteConsole(d, items);
            for (const it of items) if (it && typeof it === 'object') this.log.logConsole(d.url, it, d.id, d.frame);
            return _NO_CONTENT();
        }
        return _textResponse(404, 'unknown CupNet endpoint');
    }

    listPages() {
        this.pages.watch();
        return { enabled: !!this.settings.pageAgent, watched: true, pages: this.pages.list() };
    }

    _page(id) {
        const d = this.pages.get(id);
        if (!d) throw Object.assign(new Error('No such page (reload it with the page agent on)'), { status: 404 });
        return d;
    }

    /** Run code in a page; the command and its result are logged as console entries. */
    async evalInPage(id, code, o = {}) {
        const d = this._page(id);
        const src = String(code ?? '');
        if (!src.trim()) throw Object.assign(new Error('Nothing to run'), { status: 400 });
        if (src.length > 512 * 1024) throw Object.assign(new Error('Code is too long'), { status: 413 });
        this.log.logConsole(d.url, { lvl: 'command', text: src, sev: 'info' }, d.id, d.frame);
        let r;
        try {
            r = await this.pages.command(d.id, { op: 'eval', code: src, await: o.await !== false });
        } catch (e) {
            this.log.logConsole(d.url, { lvl: 'result', text: e.message, sev: 'error' }, d.id, d.frame);
            throw e;
        }
        const entry = this.log.logConsole(d.url, {
            lvl: 'result', text: r.text || '', sev: r.ok ? 'info' : 'error',
            args: [r.ok ? r.value : r.error].filter(Boolean),
        }, d.id, d.frame);
        return { ...r, seq: entry.seq };
    }

    /** Form / storage / highlight actions from the analyzer. */
    async pageAction(id, a = {}) {
        const d = this._page(id);
        const op = String(a.op || '');
        let cmd;
        if (op === 'form') {
            const types = ['focus', 'show', 'hide', 'toggle-disabled', 'toggle-readonly', 'toggle-password', 'set-value'];
            if (!types.includes(a.type)) throw Object.assign(new Error('Unknown form action'), { status: 400 });
            cmd = { op, type: a.type, form: Math.trunc(Number(a.form)), field: Math.trunc(Number(a.field)), value: a.value == null ? undefined : String(a.value) };
            if (!Number.isFinite(cmd.form) || !Number.isFinite(cmd.field)) throw Object.assign(new Error('form and field are required'), { status: 400 });
        } else if (op === 'storage') {
            if (!a.data || typeof a.data !== 'object' || Array.isArray(a.data)) throw Object.assign(new Error('data must be an object'), { status: 400 });
            cmd = { op, which: a.which === 'session' ? 'session' : 'local', data: a.data, replace: !!a.replace };
        } else if (op === 'highlight') {
            cmd = { op, selector: String(a.selector || '').slice(0, 2000) };
        } else throw Object.assign(new Error('Unknown action'), { status: 400 });
        return this.pages.command(d.id, cmd);
    }

    /** Full analyzer report for a page: the agent's DOM scan plus headers, cookies and endpoints. */
    async analyzePage(id, o = {}) {
        const d = this._page(id);
        const started = Date.now();
        const r = await this.pages.command(d.id, { op: 'analyze' }, 20000);
        if (!r.ok || !r.report) throw Object.assign(new Error(r.text || 'The page could not be analyzed'), { status: 502 });
        const page = this.pages.list().find((p) => p.id === d.id) || { id: d.id, url: d.url, title: d.title };
        const ua = r.report.extra && r.report.extra.env && r.report.extra.env.userAgent;
        const out = await pageAnalyzer.enrichReport(r.report, {
            page, log: this.log, cookies: this.cookies ? this.cookies.list() : [],
            fetchMissing: !!o.fetchMissing,
            fetchScript: (url) => this._fetchForAnalyzer(url, d.url, ua),
        });
        if (out.endpoints) delete out.endpoints.inlineScripts;
        return { page, at: Date.now(), durationMs: Date.now() - started, ...out };
    }

    /** GET a script through the worker (current upstream + TLS profile) and log it as type "analyzer". */
    async _fetchForAnalyzer(url, referer, userAgent) {
        if (!/^https?:\/\//i.test(url)) return { statusCode: 0, body: '', error: 'not http(s)' };
        const proxy = this.mitm.upstream || null;
        if (!proxy && this.mitm.isEgressBlocked()) return { statusCode: 0, body: '', error: 'egress blocked' };
        let site = 'cross-site';
        try { site = new URL(url).origin === new URL(referer).origin ? 'same-origin' : 'cross-site'; } catch { /* keep */ }
        const pairs = [
            ...(userAgent ? [['User-Agent', String(userAgent)]] : []),
            ['Accept', '*/*'], ['Sec-Fetch-Site', site], ['Sec-Fetch-Mode', 'no-cors'], ['Sec-Fetch-Dest', 'script'],
            ['Referer', referer], ['Accept-Encoding', 'gzip, deflate, br, zstd'],
        ];
        const headers = Object.fromEntries(pairs);
        const t0 = Date.now();
        let res;
        try {
            res = await this.mitm.worker.request({
                method: 'GET', url, headers, orderedHeaders: pairs, proxy, browser: this.browser,
                tabId: 'cupnet-mini-analyzer', timeout: 15000, maxRetries: 0, disableRedirects: false,
                forceHttp1: !!this.settings.forceHttp1,
            });
        } catch (e) {
            return { statusCode: 0, body: '', error: e?.message || String(e) };
        }
        const raw = res.bodyBase64 != null ? Buffer.from(String(res.bodyBase64), 'base64') : Buffer.from(String(res.body ?? ''), 'utf8');
        const body = raw.toString('utf8');
        this.log.logRequest({
            method: 'GET', url, status: Number(res.statusCode) || 0, type: 'analyzer', duration: Date.now() - t0,
            requestHeaders: headers, responseHeaders: res.headers || {}, requestBody: null, responseBody: body || null,
        });
        return { statusCode: Number(res.statusCode) || 0, body };
    }

    /** GET a page through the worker so the Mirror replace editor can test rules on real HTML. */
    async mirrorFetch(url) {
        if (!/^https?:\/\//i.test(String(url || ''))) return { statusCode: 0, body: '', error: 'URL must start with http(s)://' };
        const proxy = this.mitm.upstream || null;
        if (!proxy && this.mitm.isEgressBlocked()) return { statusCode: 0, body: '', error: 'egress blocked' };
        const pairs = [
            ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
            ['Sec-Fetch-Site', 'none'], ['Sec-Fetch-Mode', 'navigate'], ['Sec-Fetch-Dest', 'document'],
            ['Accept-Encoding', 'gzip, deflate, br, zstd'],
        ];
        const headers = Object.fromEntries(pairs);
        let res;
        try {
            res = await this.mitm.worker.request({
                method: 'GET', url, headers, orderedHeaders: pairs, proxy, browser: this.browser,
                tabId: 'cupnet-mini-mirror-studio', timeout: 15000, maxRetries: 0, disableRedirects: false,
                forceHttp1: !!this.settings.forceHttp1,
            });
        } catch (e) {
            return { statusCode: 0, body: '', error: e?.message || String(e) };
        }
        const raw = res.bodyBase64 != null ? Buffer.from(String(res.bodyBase64), 'base64') : Buffer.from(String(res.body ?? ''), 'utf8');
        const ct = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '';
        return {
            statusCode: Number(res.statusCode) || 0,
            contentType: String(Array.isArray(ct) ? ct[0] : ct || ''),
            body: raw.toString('utf8'),
        };
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
        const domains = _parseList(s.tlsPassthrough);
        const sec = Math.round(Number(s.ipWatchSec));
        return {
            browser, tlsPassthrough: [...new Set(domains)], cors: !!s.cors, forceHttp1: !!s.forceHttp1,
            ipWatch: s.ipWatch !== false,
            ipWatchSec: Number.isFinite(sec) ? Math.min(3600, Math.max(5, sec)) : DEFAULT_SETTINGS.ipWatchSec,
            pageAgent: !!s.pageAgent,
            pageAgentExclude: [...new Set(_parseList(s.pageAgentExclude))],
            shareHost: !!s.shareHost,
            sharePort: Number.isInteger(Number(s.sharePort)) && Number(s.sharePort) >= 1024 && Number(s.sharePort) <= 65535
                ? Number(s.sharePort) : DEFAULT_SETTINGS.sharePort,
        };
    }

    _applySettings() {
        if (!this.mitm) return;
        this.mitm.setBrowser(this.browser);
        this.mitm.setTlsPassthroughDomains(this.settings.tlsPassthrough);
        this.mitm.setGlobalCorsEnabled(this.settings.cors);
        this.mitm.setForceHttp1(this.settings.forceHttp1);
        this.ipMonitor?.configure({ enabled: this.settings.ipWatch, intervalMs: this.settings.ipWatchSec * 1000 });
    }

    /** Start / stop / move the local share host to match the settings. */
    async applyShareHost() {
        if (!this.shareHost) this.shareHost = new ShareHost({ sealedDir: this.sealedDir, port: this.settings.sharePort });
        const h = this.shareHost;
        this.shareError = null;
        try {
            if (h.running && (!this.settings.shareHost || h.port !== this.settings.sharePort)) await h.stop();
            if (this.settings.shareHost && !h.running) await h.start(this.settings.sharePort);
        } catch (e) {
            this.shareError = e?.code === 'EADDRINUSE' ? `Port ${this.settings.sharePort} is in use` : (e?.message || String(e));
        }
        return this.shareStatus();
    }

    shareStatus() {
        return { ...(this.shareHost?.status() || { running: false, port: this.settings.sharePort, url: null }), enabled: this.settings.shareHost, error: this.shareError || null };
    }

    getSettings() {
        return {
            ...this.settings,
            browser: this.browser,
            browserFromCli: !!this.browserArg,
            tlsProfiles: TLS_PROFILES,
            share: this.shareStatus(),
        };
    }

    async updateSettings(patch) {
        const next = this._cleanSettings({ ...this.settings, ...(patch || {}) });
        this.settings = next;
        if (patch && patch.browser != null) { this.browser = next.browser; this.browserArg = null; }
        const tmp = `${this.settingsFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.settingsFile);
        this._applySettings();
        if (patch && (patch.shareHost != null || patch.sharePort != null)) await this.applyShareHost();
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

    /**
     * Send one Intruder request through the same egress path as {@link replay}, but log nothing to
     * the session (an attack can be thousands of requests). Returns just the metrics a result row
     * needs, plus the response text for grep matching.
     * @param {{ method?: string, url: string, headers?: Array<[string,string]>, body?: string }} r
     * @returns {Promise<{ status: number, duration: number, length: number, error: string|null, bodyText: string }>}
     */
    async intruderSend(r) {
        const url = String(r?.url || '').trim();
        if (!/^https?:\/\/[^/]/i.test(url)) return { status: 0, duration: 0, length: 0, error: 'URL must start with http:// or https://', bodyText: '' };
        const method = String(r.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
        const pairs = (Array.isArray(r.headers) ? r.headers : Object.entries(r.headers || {}))
            .filter((h) => Array.isArray(h) && String(h[0] || '').trim())
            .map(([k, v]) => [String(k).trim(), String(v ?? '')]);
        const headers = {};
        for (const [k, v] of pairs) headers[k] = v;
        const proxy = this.mitm.upstream || null;
        if (!proxy && this.mitm.isEgressBlocked()) throw Object.assign(new Error(this.mitm.getEgressBlockReason() || 'Egress blocked'), { status: 409 });
        const body = typeof r.body === 'string' ? r.body : '';
        const isB64 = body.startsWith('__b64__:');
        const started = Date.now();
        let res;
        try {
            res = await this.mitm.worker.request({
                method, url, headers, orderedHeaders: pairs,
                ...(body ? (isB64 ? { bodyBase64: body.slice(8) } : { body }) : {}),
                proxy, browser: this.browser, tabId: 'cupnet-mini-intruder',
                timeout: REPLAY_TIMEOUT_MS, maxRetries: 0, disableRedirects: true,
                forceHttp1: !!this.settings.forceHttp1,
            });
        } catch (e) {
            res = { statusCode: 0, headers: {}, error: e?.message || String(e) };
        }
        const duration = Date.now() - started;
        const rawRes = res.bodyBase64 != null ? Buffer.from(String(res.bodyBase64), 'base64') : Buffer.from(String(res.body ?? ''), 'utf8');
        const ct = Object.entries(res.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
        const mime = String(Array.isArray(ct) ? ct[0] : (ct || ''));
        return { status: Number(res.statusCode) || 0, duration, length: rawRes.length, error: res.error || null, bodyText: TEXT_MIME.test(mime) ? rawRes.toString('utf8') : '' };
    }

    async stop() {
        try { this.interceptor?.setLocalEndpointHandler(null); } catch { /* ignore */ }
        try { this.interceptor?.setBreakpointHandler(null); } catch { /* ignore */ }
        try { this.interceptor?.setDocumentScriptsProvider(null); } catch { /* ignore */ }
        try { this.interceptor?.setMirrorAuditSink(null); } catch { /* ignore */ }
        this.pages.clear();
        for (const id of [...this._paused.keys()]) this.resumeRequest(id, { action: 'forward' });
        if (this.ipMonitor) { this.ipMonitor.stop(); this.ipMonitor = null; }
        if (this.ui) { await this.ui.close().catch(() => {}); this.ui = null; }
        if (this.shareHost) { await this.shareHost.stop().catch(() => {}); this.shareHost = null; }
        try { this.ws?.closeAll(); } catch { /* ignore */ }
        if (this.mitm) { this.mitm.stop(); this.mitm = null; }
        try { this.interceptor?.setRuleStore(null); } catch { /* ignore */ }
        try { this.rules?.close(); } catch { /* ignore */ }
        try { this.cookies?.close(); } catch { /* ignore */ }
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
