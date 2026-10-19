'use strict';

/**
 * CupNet mini — the CupNet MITM + Go AzureTLS worker without Electron, for use with real Chrome.
 *
 *   Chrome (dedicated profile) ──HTTP proxy──▶ MitmProxy 127.0.0.1:<mitmPort> ──AzureTLS──▶ origin
 *                                                │ intercept rules (block/mock/modifyHeaders/script/inject)
 *                                                │ /__cupnet/* served locally (page events)
 *                                                └▶ SessionLog (ring + sessions/<id>.jsonl) ◀── UI 127.0.0.1:<uiPort>
 *
 * Everything listens on loopback only. Data lives in <dataDir> (default ~/.cupnet-mini):
 *   ca/ca-key.pem, ca/ca-cert.pem · cupnet-mini.db (rules) · sessions/*.jsonl · chrome-profile/ · ui-token
 *
 * Must run on the Node ABI better-sqlite3 was built for (Electron's): see scripts/run-mini.cjs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { SessionLog } = require('./session-log');
const { spkiHashFromCertPem, fingerprintSha256, caInstructions } = require('./ca');
const { launchChrome } = require('./chrome');
const { createUiServer } = require('./ui-server');

const PAGE_EVENT_MAX_BYTES = 64 * 1024;

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
     */
    constructor(o = {}) {
        this.dataDir = path.resolve(o.dataDir || defaultDataDir());
        this.mitmPort = Number(o.mitmPort) || 8877;
        this.uiPort = o.uiPort === 0 ? 0 : (Number(o.uiPort) || 8878);
        this.browser = o.browser || 'chrome_120';
        this.upstream = o.upstream || null;
        this.trust = o.trust === 'system' ? 'system' : 'spki';
        this.chromeBinary = o.chromeBinary || null;
        this.mitm = null;
        this.ui = null;
        this.log = null;
    }

    get caDir() { return path.join(this.dataDir, 'ca'); }
    get caCertPath() { return path.join(this.caDir, 'ca-cert.pem'); }
    get profileDir() { return path.join(this.dataDir, 'chrome-profile'); }
    get sessionsDir() { return path.join(this.dataDir, 'sessions'); }

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

        const db = require('../db');
        db.initWithPath(path.join(this.dataDir, 'cupnet-mini.db'));
        this.db = db;
        const interceptor = require('../request-interceptor');
        this.interceptor = interceptor;
        interceptor.setLocalEndpointHandler((req) => this._handleLocalEndpoint(req));

        this.log = new SessionLog({ dir: this.sessionsDir });

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
        if (this.upstream) this.mitm.setUpstream(this.upstream);
        await this.mitm.start();

        this.token = _readOrCreateToken(path.join(this.dataDir, 'ui-token'));
        this.ui = createUiServer(this);
        await this.ui.listen(this.uiPort);
        this.uiPort = this.ui.port;
        return this;
    }

    get uiUrl() {
        return `http://127.0.0.1:${this.uiPort}/#t=${this.token}`;
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

    async stop() {
        try { this.interceptor?.setLocalEndpointHandler(null); } catch { /* ignore */ }
        if (this.ui) { await this.ui.close().catch(() => {}); this.ui = null; }
        if (this.mitm) { this.mitm.stop(); this.mitm = null; }
        if (this.log) { this.log.close(); this.log = null; }
        try { this.db?.close(); } catch { /* ignore */ }
    }
}

module.exports = { MiniApp, defaultDataDir };
