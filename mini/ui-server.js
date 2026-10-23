'use strict';

/**
 * CupNet mini control UI on 127.0.0.1:<uiPort>.
 *
 * Access control (the log holds cookies and tokens):
 *  - bound to loopback only;
 *  - Host must be 127.0.0.1:<port> or localhost:<port> (blocks DNS-rebinding pages);
 *  - every /api/* call needs `X-CupNet-Token: <token>` — a custom header, so a cross-origin page cannot
 *    send it without a CORS preflight, which this server never approves.
 * The HTML page itself holds no data. It gets the token from its URL fragment (#t=…), or trades a
 * one-time launch code (#c=…, see MiniApp.newLaunchCode) for it, and keeps it in sessionStorage.
 *
 * Logged bodies are served only as application/octet-stream attachments with a sandbox CSP: a logged
 * HTML page must never render on this origin.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { SessionLog, SessionIndex } = require('./session-log');
const sessionCrypto = require('./session-crypto');
const { providerCatalog } = require('./proxy-store');
const { writeHar } = require('./har');
const VERSION = require('./version');
const { CookieJar } = require('./cookie-jar');
const siteMap = require('./site-map');
const { buildSnapshot } = require('./page-snapshot');
const { startSearch } = require('./session-search');
const { runAttack, buildRequestAt } = require('./intruder');
const mirrorRewrite = require('../mirror-rewrite');
const dnsPromises = require('dns').promises;
const net = require('net');

const UI_HTML = path.join(__dirname, 'ui.html');
const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob: data:; connect-src 'self'; font-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** UI assets (no data in them, so no token): mini/ui.* plus repo modules listed in browser-libs.json. */
const STATIC = new Map([
    ['/ui.css', [path.join(__dirname, 'ui.css'), 'text/css; charset=utf-8']],
    ['/ui.js', [path.join(__dirname, 'ui.js'), 'text/javascript; charset=utf-8']],
    ['/ui-activity.js', [path.join(__dirname, 'ui-activity.js'), 'text/javascript; charset=utf-8']],
    ['/ui-help.js', [path.join(__dirname, 'ui-help.js'), 'text/javascript; charset=utf-8']],
    ['/ui-inspect.js', [path.join(__dirname, 'ui-inspect.js'), 'text/javascript; charset=utf-8']],
    ['/ui-tools.js', [path.join(__dirname, 'ui-tools.js'), 'text/javascript; charset=utf-8']],
    ['/ui-select.js', [path.join(__dirname, 'ui-select.js'), 'text/javascript; charset=utf-8']],
    ['/ui-ws.js', [path.join(__dirname, 'ui-ws.js'), 'text/javascript; charset=utf-8']],
    ['/ui-search.js', [path.join(__dirname, 'ui-search.js'), 'text/javascript; charset=utf-8']],
    ['/ui-intruder.js', [path.join(__dirname, 'ui-intruder.js'), 'text/javascript; charset=utf-8']],
    ['/ui-mirror.js', [path.join(__dirname, 'ui-mirror.js'), 'text/javascript; charset=utf-8']],
    ...Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, 'browser-libs.json'), 'utf8')))
        .map(([k, rel]) => [`/${k}`, [path.join(__dirname, '..', rel), 'text/javascript; charset=utf-8']]),
]);
const JSON_BODY_MAX = 2 * 1024 * 1024;
/** Bodies in /api/log/:seq are cut to this many chars; the full body is at /api/log/:seq/body/<which>. */
const BODY_PREVIEW_CHARS = 2 * 1024 * 1024;
const STREAM_FLUSH_MS = 100;
const STREAM_HEARTBEAT_MS = 15000;
const PAST_INDEX_CACHE = 4;

function _send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...extra,
    });
    res.end(buf);
}

function _readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > JSON_BODY_MAX) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

/** Read a raw request body (for file uploads like HAR import), capped at `max` bytes. */
function _readRaw(req, max) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > max) { reject(new Error('файл слишком большой')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}
/** HAR imports can carry full bodies, so allow much more than a JSON API call. */
const HAR_IMPORT_MAX = 128 * 1024 * 1024;

// Live preview for the Mirror replace editor: run the REAL rewrite engine (mirror-rewrite.js, the
// same code the MITM path uses) over a sample body so the editor shows the exact transformed output,
// never a drifting client-side re-implementation. The UI computes the red/green diff of source ->
// output itself. `perRule[i]` stays aligned with the editor's rule list (invalid rows score 0), so
// each rule's hit badge is correct even while a rule is being typed.
function mirrorPreview(data) {
    const source = String(data && data.source != null ? data.source : '');
    const raw = Array.isArray(data && data.replace) ? data.replace : [];
    let body = Buffer.from(source, 'utf8');
    let hits = 0;
    const perRule = raw.map((rule) => {
        const norm = mirrorRewrite.normalizeReplaceRules([rule], false)[0];
        if (!norm || norm.kind === 'url') return 0; // dropped/invalid, or a path-swap (not sample text)
        const r = mirrorRewrite.replaceWords(body, norm.from, norm.to, norm);
        body = r.body;
        hits += r.hits;
        return r.hits;
    });
    const output = body.toString('utf8');
    return { output, hits, perRule, changed: output !== source };
}

function _tokenOk(given, expected) {
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function _preview(body) {
    if (body == null) return { body: null, truncated: false };
    const s = String(body);
    if (s.length <= BODY_PREVIEW_CHARS) return { body: s, truncated: false };
    return { body: s.slice(0, BODY_PREVIEW_CHARS), truncated: true };
}

/** A user-facing error (bad input, unknown profile) → 400; the message is shown in the UI. */
function _badRequest(res, e) {
    return _send(res, Number(e?.status) || 400, { error: e?.message || String(e) });
}

/** `1,4-9,12` → [1,4,5,…,9,12] (at most 100 000 seqs). */
function _parseSeqList(s) {
    const out = [];
    for (const part of String(s).split(',')) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
        if (!m) continue;
        const a = Number(m[1]);
        const b = m[2] ? Number(m[2]) : a;
        for (let n = a; n <= b && out.length < 100000; n++) if (n > 0) out.push(n);
        if (out.length >= 100000) break;
    }
    return out;
}

/** Full request entries of a session, in order (read back from the JSONL one by one). */
function* _fullEntries(src, seqs = null) {
    if (seqs) {
        for (const q of seqs) { const e = src.get(q); if (e && e.kind === 'request') yield e; }
        return;
    }
    let after = 0;
    for (;;) {
        const batch = src.list(after, 2000);
        if (!batch.length) return;
        for (const s of batch) {
            after = s.seq;
            if (s.kind !== 'request') continue;
            const e = src.get(s.seq);
            if (e) yield e;
        }
    }
}

function _headerVal(h, name) {
    if (!h) return '';
    const k = Object.keys(h).find((x) => x.toLowerCase() === name);
    const v = k ? h[k] : '';
    return String(Array.isArray(v) ? v[0] : v);
}

/** @param {import('./mini-app').MiniApp} app */
function createUiServer(app) {
    const pastIndexes = new Map(); // sessionId → SessionIndex (small LRU)
    const streams = new Set();

    /** The live log for the current session, a (cached, refreshed) index for a saved one, or null. */
    function sessionSource(id) {
        if (!id || id === app.log.sessionId) return app.log;
        if (!/^[\w-]+$/.test(id)) return null;
        const file = path.join(app.sessionsDir, `${id}.jsonl`);
        let idx = pastIndexes.get(id);
        if (idx) {
            pastIndexes.delete(id);
            idx.refresh();
        } else {
            if (!fs.existsSync(file)) return null;
            idx = SessionIndex.open(file);
        }
        pastIndexes.set(id, idx);
        while (pastIndexes.size > PAST_INDEX_CACHE) pastIndexes.delete(pastIndexes.keys().next().value);
        return idx;
    }

    const server = http.createServer(async (req, res) => {
        const port = server.address()?.port;
        const host = String(req.headers.host || '').toLowerCase();
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return _send(res, 421, { error: 'bad host' });
        const u = new URL(req.url, `http://127.0.0.1:${port}`);

        if (u.pathname === '/' && req.method === 'GET') {
            const html = fs.readFileSync(UI_HTML);
            return _send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': UI_CSP });
        }
        const asset = req.method === 'GET' && STATIC.get(u.pathname);
        if (asset) {
            try { return _send(res, 200, fs.readFileSync(asset[0]), asset[1]); } catch { return _send(res, 404, { error: 'not found' }); }
        }
        if (!u.pathname.startsWith('/api/')) return _send(res, 404, { error: 'not found' });

        // One-time launch code → token (custom header: a cross-origin page cannot send it either).
        if (u.pathname === '/api/auth/exchange' && req.method === 'POST') {
            if (!app.redeemLaunchCode(req.headers['x-cupnet-code'])) return _send(res, 401, { error: 'invalid or expired launch code' });
            return _send(res, 200, { token: app.token });
        }
        if (!_tokenOk(req.headers['x-cupnet-token'], app.token)) return _send(res, 401, { error: 'token required' });

        try {
            return await _route(app, req, res, u, { sessionSource, streams });
        } catch (e) {
            if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return undefined; }
            return _send(res, 500, { error: e?.message || String(e) });
        }
    });

    return {
        server,
        get port() { return server.address()?.port; },
        listen(port) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
            });
        },
        close() {
            for (const s of streams) { try { s.end(); } catch { /* ignore */ } }
            return new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        },
    };
}

/**
 * Live log: NDJSON summaries with seq > after, then every new entry as it is logged. The connection
 * stays open (a blank line every 15 s keeps it alive) until the client goes away or the session ends.
 */
function _stream(app, req, res, after, streams) {
    const log = app.log;
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no',
    });
    let pending = [];
    let timer = null;
    let lastSeq = after;
    const flush = () => {
        timer = null;
        if (!pending.length) return;
        res.write(pending.map((e) => JSON.stringify(e)).join('\n') + '\n');
        pending = [];
    };
    const onEntry = (e) => {
        if (e.seq <= lastSeq) return;
        lastSeq = e.seq;
        pending.push(e);
        if (!timer) timer = setTimeout(flush, STREAM_FLUSH_MS);
    };
    // Backlog first, in batches, then live entries.
    for (;;) {
        const batch = log.list(lastSeq, 5000);
        if (!batch.length) break;
        res.write(batch.map((e) => JSON.stringify(e)).join('\n') + '\n');
        lastSeq = batch[batch.length - 1].seq;
    }
    const heartbeat = setInterval(() => { try { res.write('\n'); } catch { /* closed */ } }, STREAM_HEARTBEAT_MS);
    const done = () => {
        clearInterval(heartbeat);
        if (timer) { clearTimeout(timer); timer = null; }
        log.off('entry', onEntry);
        log.off('close', end);
        streams.delete(handle);
    };
    const end = () => { flush(); done(); try { res.end(); } catch { /* ignore */ } };
    const handle = { end };
    streams.add(handle);
    log.on('entry', onEntry);
    log.on('close', end);
    req.on('close', done);
}

async function _route(app, req, res, u, { sessionSource, streams }) {
    const p = u.pathname;
    const m = req.method;

    if (p === '/api/status' && m === 'GET') {
        return _send(res, 200, {
            version: VERSION.VERSION,
            released: VERSION.RELEASED,
            sessionId: app.log.sessionId,
            entries: app.log.count,
            lastSeq: app.log.lastSeq,
            writeErrors: app.log.writeErrors,
            dataDir: app.dataDir,
            mitmPort: app.mitmPort,
            browser: app.browser,
            upstream: app.mitm?.upstream ? String(app.mitm.upstream).replace(/\/\/[^@/]*@/, '//***@') : null,
            proxy: app.proxies?.status() || null,
            ipWatch: app.ipMonitor?.summary() || null,
            cookies: app.cookies?.summary() || null,
            paused: app._paused?.size || 0,
            dns: app.dns ? { rules: app.dns.rules.length, enabled: app.dns.rules.filter((r) => r.enabled).length } : null,
            trust: app.trust,
            rulesFile: app.rulesFile,
            ca: { certPath: app.ca.certPath, spki: app.ca.spki, sha256: app.ca.sha256, commands: app.ca.commands },
            stats: app.mitm?.getStats?.() || null,
            canQuit: !!app.onQuit,
        });
    }

    if (p === '/api/log/stream' && m === 'GET') {
        return _stream(app, req, res, Number(u.searchParams.get('after')) || 0, streams);
    }

    if (p === '/api/log' && m === 'GET') {
        const src = sessionSource(u.searchParams.get('session'));
        if (!src) return _send(res, 404, { error: 'no such session' });
        const after = Number(u.searchParams.get('after')) || 0;
        const limit = Math.min(50000, Number(u.searchParams.get('limit')) || 5000);
        return _send(res, 200, src.list(after, limit));
    }

    const logOne = /^\/api\/log\/(\d+)(?:\/body\/(request|response))?$/.exec(p);
    if (logOne && m === 'GET') {
        const src = sessionSource(u.searchParams.get('session'));
        if (!src) return _send(res, 404, { error: 'no such session' });
        const e = src.get(Number(logOne[1]));
        if (!e) return _send(res, 404, { error: 'no such entry' });
        const which = logOne[2];
        if (!which) {
            const rq = _preview(e.requestBody);
            const rs = _preview(e.responseBody);
            return _send(res, 200, {
                ...e,
                requestBody: rq.body, requestBodyTruncated: rq.truncated,
                responseBody: rs.body, responseBodyTruncated: rs.truncated,
            });
        }
        const body = which === 'request' ? e.requestBody : e.responseBody;
        if (body == null) return _send(res, 404, { error: 'no body' });
        const s = String(body);
        const buf = s.startsWith('__b64__:') ? Buffer.from(s.slice(8), 'base64') : Buffer.from(s, 'utf8');
        const ct = _headerVal(which === 'request' ? e.requestHeaders : e.responseHeaders, 'content-type');
        return _send(res, 200, buf, 'application/octet-stream', {
            'Content-Disposition': `attachment; filename="cupnet-${e.seq}-${which}.bin"`,
            'Content-Security-Policy': 'sandbox',
            'X-CupNet-Content-Type': ct.replace(/[^\x20-\x7e]/g, ''),
        });
    }

    if (p === '/api/rules' && m === 'GET') {
        return _send(res, 200, app.rules.getAllInterceptRules());
    }
    if (p === '/api/rules' && m === 'POST') {
        const rule = await _readJson(req);
        if (!rule || typeof rule !== 'object') return _send(res, 400, { error: 'rule object expected' });
        if (!rule.name || !rule.url_pattern || !rule.type) return _send(res, 400, { error: 'name, url_pattern and type are required' });
        const v = app.interceptor.validateInterceptRuleForSave(rule);
        if (!v.ok) return _send(res, 400, { error: v.error });
        const id = app.rules.saveInterceptRule(rule);
        app.interceptor.invalidateRulesCache();
        return _send(res, 200, { id });
    }
    const ruleOne = /^\/api\/rules\/(\d+)$/.exec(p);
    if (ruleOne && m === 'DELETE') {
        app.rules.deleteInterceptRule(Number(ruleOne[1]));
        app.interceptor.invalidateRulesCache();
        return _send(res, 200, { ok: true });
    }

    const ruleToggle = /^\/api\/rules\/(\d+)\/enabled$/.exec(p);
    if (ruleToggle && m === 'POST') {
        const body = await _readJson(req).catch(() => null);
        const rule = app.rules.getAllInterceptRules().find((r) => r.id === Number(ruleToggle[1]));
        if (!rule) return _send(res, 404, { error: 'no such rule' });
        app.rules.saveInterceptRule({ ...rule, enabled: !!body?.enabled });
        app.interceptor.invalidateRulesCache();
        return _send(res, 200, { ok: true });
    }

    // ── CA trust (certificate install) ───────────────────────────────────────────
    if (p === '/api/ca/status' && m === 'GET') {
        return _send(res, 200, app.caStatus());
    }
    if (p === '/api/ca/install' && m === 'POST') {
        // Runs the OS install command; macOS shows its own password dialog and may block here a while.
        const r = await app.installCaIntoStore();
        return _send(res, r.ok ? 200 : 500, r);
    }

    // ── Proxy manager ───────────────────────────────────────────────────────────
    if (p.startsWith('/api/proxies') || p === '/api/egress') {
        const r = await _proxyRoute(app, req, res, u).catch((e) => _badRequest(res, e));
        if (r !== false) return r;
    }

    // ── Exit-IP monitor ─────────────────────────────────────────────────────────
    if (p === '/api/ip-history' && m === 'GET') {
        const mon = app.ipMonitor;
        if (!mon) return _send(res, 503, { error: 'IP monitor is not running' });
        const limit = Math.min(5000, Math.max(1, Number(u.searchParams.get('limit')) || 1000));
        const after = Number(u.searchParams.get('after')) || 0;
        return _send(res, 200, { state: mon.summary(), events: mon.history({ limit, after }) });
    }
    if (p === '/api/ip-history' && m === 'DELETE') {
        app.ipMonitor?.clearHistory();
        return _send(res, 200, { ok: true });
    }
    if (p === '/api/ip-history/check' && m === 'POST') {
        if (!app.ipMonitor) return _send(res, 503, { error: 'IP monitor is not running' });
        return _send(res, 200, { state: await app.ipMonitor.checkNow() });
    }

    // ── Cookie manager ──────────────────────────────────────────────────────────
    if (p.startsWith('/api/cookies')) {
        if (!app.cookies) return _send(res, 503, { error: 'Cookie manager is not running' });
        const r = await _cookieRoute(app.cookies, req, res, u).catch((e) => _badRequest(res, e));
        if (r !== false) return r;
    }

    // ── DNS overrides, notes, site map ─────────────────────────────────────────
    if (p.startsWith('/api/dns') || p.startsWith('/api/notes') || p.startsWith('/api/sitemap') || p.startsWith('/api/mirror')) {
        const r = await _toolRoute(app, req, res, u, sessionSource).catch((e) => _badRequest(res, e));
        if (r !== false) return r;
    }

    // ── Page agent: Console REPL + page analyzer ───────────────────────────────
    if (p === '/api/pages' && m === 'GET') return _send(res, 200, app.listPages());
    const pg = /^\/api\/pages\/([0-9a-f]{16,32})\/(eval|analyze|action)$/.exec(p);
    if (pg && m === 'POST') {
        const body = (await _readJson(req).catch(() => null)) || {};
        try {
            if (pg[2] === 'eval') return _send(res, 200, await app.evalInPage(pg[1], body.code, { await: body.await }));
            if (pg[2] === 'analyze') return _send(res, 200, await app.analyzePage(pg[1], { fetchMissing: !!body.fetchMissing }));
            return _send(res, 200, await app.pageAction(pg[1], body));
        } catch (e) { return _badRequest(res, e); }
    }

    // ── WebSockets: open connections, send / close (messages themselves are in the log) ──
    if (p === '/api/ws' && m === 'GET') return _send(res, 200, { open: app.ws?.list() || [] });
    const wsOne = /^\/api\/ws\/(\d+)\/(send|close)$/.exec(p);
    if (wsOne && m === 'POST') {
        const body = (await _readJson(req).catch(() => null)) || {};
        try {
            if (wsOne[2] === 'send') return _send(res, 200, app.ws.send(Number(wsOne[1]), body));
            return _send(res, 200, app.ws.close(Number(wsOne[1]), body.code, body.reason));
        } catch (e) { return _badRequest(res, e); }
    }

    if (p === '/api/settings' && m === 'GET') return _send(res, 200, app.getSettings());
    if (p === '/api/settings' && m === 'POST') {
        const body = await _readJson(req);
        return _send(res, 200, await app.updateSettings(body || {}));
    }

    if (p === '/api/replay' && m === 'POST') {
        const body = await _readJson(req);
        try { return _send(res, 200, await app.replay(body || {})); } catch (e) { return _badRequest(res, e); }
    }

    if (p === '/api/breakpoints' && m === 'GET') return _send(res, 200, app.listPaused());
    const bp = /^\/api\/breakpoints\/([0-9a-f]+)$/.exec(p);
    if (bp && m === 'POST') {
        const body = await _readJson(req);
        const ok = app.resumeRequest(bp[1], body || {});
        return _send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'request is no longer paused' });
    }

    if (p === '/api/chrome' && m === 'POST') {
        const body = await _readJson(req).catch(() => ({}));
        const r = app.launchChrome(body?.url);
        return _send(res, r.success ? 200 : 500, r);
    }
    if (p === '/api/window' && m === 'POST') {
        const r = app.openWindow();
        return _send(res, r.success ? 200 : 500, { success: r.success, error: r.error });
    }
    if (p === '/api/quit' && m === 'POST') {
        const ok = app.requestQuit();
        return _send(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'quit is not available in this mode' });
    }

    if (p === '/api/sessions' && m === 'GET') {
        const keys = sessionCrypto.listKeys(app.keysDir);
        const sessions = SessionLog.listSessions(app.sessionsDir).map((s) => {
            const k = keys.get(s.id);
            const sealedFile = k ? path.join(app.sealedDir, `${k.id}.cupsess`) : null;
            return { ...s, keyId: k?.id || null, sealed: !!(sealedFile && fs.existsSync(sealedFile)) };
        });
        return _send(res, 200, { current: app.log.sessionId, sessions });
    }
    // Search every (or the picked) saved session: NDJSON events — session, progress, hit…, done | error.
    if (p === '/api/search' && m === 'POST') {
        const b = (await _readJson(req)) || {};
        let list = SessionLog.listSessions(app.sessionsDir);
        if (Array.isArray(b.sessions) && b.sessions.length) { const want = new Set(b.sessions.map(String)); list = list.filter((s) => want.has(s.id)); }
        if (Number(b.since) > 0) list = list.filter((s) => s.mtime >= Number(b.since) || s.id === app.log.sessionId);
        let job;
        const events = [];
        let timer = null;
        const flush = () => {
            timer = null;
            if (events.length) { try { res.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch { /* closed */ } events.length = 0; }
        };
        try {
            job = startSearch({
                sessionsDir: app.sessionsDir, sessions: list, q: b.q, regex: !!b.regex, caseSensitive: !!b.caseSensitive,
                kinds: b.kinds, fields: b.fields, host: b.host, limit: b.limit,
                onEvent: (ev) => { events.push(ev); if (!timer) timer = setTimeout(flush, STREAM_FLUSH_MS); },
            });
        } catch (e) { return _badRequest(res, e); }
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Accel-Buffering': 'no',
        });
        const handle = { end: () => job.stop() };
        streams.add(handle);
        // Not req 'close': it fires as soon as the POST body has been read.
        res.on('close', () => job.stop());
        await job.done;
        streams.delete(handle);
        if (timer) clearTimeout(timer);
        flush();
        try { res.end(); } catch { /* ignore */ }
        return undefined;
    }
    if (p === '/api/intruder' && m === 'POST') {
        const spec = (await _readJson(req)) || {};
        let job;
        const events = [];
        let timer = null;
        const flush = () => {
            timer = null;
            if (events.length) { try { res.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch { /* closed */ } events.length = 0; }
        };
        try {
            job = runAttack({
                spec, concurrency: spec.concurrency,
                send: (r) => app.intruderSend(r),
                onEvent: (ev) => { events.push(ev); if (!timer) timer = setTimeout(flush, STREAM_FLUSH_MS); },
            });
        } catch (e) { return _badRequest(res, e); }
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Accel-Buffering': 'no',
        });
        const handle = { end: () => job.stop() };
        streams.add(handle);
        res.on('close', () => job.stop());
        await job.done;
        streams.delete(handle);
        if (timer) clearTimeout(timer);
        flush();
        try { res.end(); } catch { /* ignore */ }
        return undefined;
    }
    if (p === '/api/intruder/replay' && m === 'POST') {
        const b = (await _readJson(req)) || {};
        let r;
        try { r = buildRequestAt(b.spec || {}, b.index); } catch (e) { return _badRequest(res, e); }
        return _send(res, 200, await app.replay({ ...r, followRedirects: !!b.followRedirects }));
    }
    // Import a HAR file as a new saved session (e.g. a session exported from the old cupnet2).
    if (p === '/api/sessions/import' && m === 'POST') {
        let buf;
        try { buf = await _readRaw(req, HAR_IMPORT_MAX); }
        catch (e) { return _send(res, 413, { ok: false, error: String(e?.message || e) }); }
        const r = app.importHar(buf);
        return _send(res, r.ok ? 200 : 400, r);
    }
    const sess = /^\/api\/sessions\/([\w-]+)$/.exec(p);
    if (sess && m === 'GET') {
        const file = path.join(app.sessionsDir, `${sess[1]}.jsonl`);
        if (!fs.existsSync(file)) return _send(res, 404, { error: 'no such session' });
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Length': fs.statSync(file).size,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `attachment; filename="cupnet-${sess[1]}.jsonl"`,
        });
        fs.createReadStream(file).pipe(res);
        return undefined;
    }

    const har = /^\/api\/sessions\/([\w-]+)\/har$/.exec(p);
    if (har && m === 'GET') {
        const src = sessionSource(har[1]);
        if (!src) return _send(res, 404, { error: 'no such session' });
        const seqs = u.searchParams.get('seqs');
        const list = seqs ? _parseSeqList(seqs) : null;
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `attachment; filename="cupnet-${har[1]}.har"`,
        });
        await writeHar(res, _fullEntries(src, list), { version: VERSION.VERSION, comment: `CupNet mini session ${har[1]}` });
        res.end();
        return undefined;
    }

    // Seal now and return viewer links on the local share host (#k= carries the key, never sent to it).
    const share = /^\/api\/sessions\/([\w-]+)\/share$/.exec(p);
    if (share && m === 'POST') {
        if (!fs.existsSync(path.join(app.sessionsDir, `${share[1]}.jsonl`))) return _send(res, 404, { error: 'no such session' });
        const r = app.sealSession(share[1]);
        const k = sessionCrypto.findKeyBySessionId(app.keysDir, share[1]);
        const st = app.shareStatus();
        const base = `http://localhost:${st.port}/`;
        return _send(res, 200, {
            id: r.id, sessionId: share[1], bytes: r.bytes, host: st,
            link: `${base}#id=${r.id}`,
            linkWithKey: k ? `${base}#id=${r.id}&k=${Buffer.from(k.key).toString('base64url')}` : null,
        });
    }

    // Encrypt a session (own key per session) and fetch its key file / sealed file by the stable id.
    const seal = /^\/api\/sessions\/([\w-]+)\/(seal|key|sealed)$/.exec(p);
    if (seal) {
        const [, sessionId, what] = seal;
        if (!fs.existsSync(path.join(app.sessionsDir, `${sessionId}.jsonl`))) return _send(res, 404, { error: 'no such session' });
        if (what === 'seal' && m === 'POST') {
            const r = app.sealSession(sessionId);
            return _send(res, 200, { id: r.id, sessionId, keyFile: r.keyFile, sealedFile: r.sealedFile, bytes: r.bytes });
        }
        if (m !== 'GET') return _send(res, 405, { error: 'method not allowed' });
        const k = sessionCrypto.findKeyBySessionId(app.keysDir, sessionId);
        if (!k) return _send(res, 404, { error: 'session is not sealed yet' });
        const file = what === 'key' ? k.file : path.join(app.sealedDir, `${k.id}.cupsess`);
        if (!fs.existsSync(file)) return _send(res, 404, { error: 'session is not sealed yet' });
        return _send(res, 200, fs.readFileSync(file), what === 'key' ? 'application/json' : 'application/octet-stream');
    }

    return _send(res, 404, { error: 'not found' });
}

/** /api/dns*, /api/notes*, /api/sitemap*. Returns false when nothing matched. Thrown errors → 400. */
async function _toolRoute(app, req, res, u, sessionSource) {
    const p = u.pathname;
    const m = req.method;
    const body = async () => (await _readJson(req)) || {};

    // DNS overrides (applied by the MITM in dial mode on every change).
    if (p.startsWith('/api/dns')) {
        const dns = app.dns;
        const listing = () => _send(res, 200, { rules: dns.list(), activity: dns.activity.slice(-200).reverse() });
        if (p === '/api/dns' && m === 'GET') return listing();
        if (p === '/api/dns' && m === 'POST') { dns.add(await body()); app.applyDns(); return listing(); }
        if (p === '/api/dns/activity' && m === 'DELETE') { dns.clearActivity(); return listing(); }
        if (p === '/api/dns/import' && m === 'POST') {
            const b = await body();
            const r = dns.importHosts(String(b.text || ''), { replace: b.replace === true });
            app.applyDns();
            return _send(res, 200, { ...r, rules: dns.list(), activity: dns.activity.slice(-200).reverse() });
        }
        if (p === '/api/dns/export' && m === 'GET') {
            return _send(res, 200, dns.exportHosts(), 'text/plain; charset=utf-8', { 'Content-Disposition': 'attachment; filename="cupnet-dns-hosts.txt"' });
        }
        if (p === '/api/dns/resolve' && m === 'POST') {
            const host = String((await body()).host || '').trim().toLowerCase().replace(/^\*\./, '');
            if (!host || host.length > 253 || net.isIP(host) || !/^[a-z0-9_.-]+$/.test(host)) throw new Error('Enter a hostname');
            const rule = dns.rules.find((r) => r.enabled && (r.host === host || (r.host.startsWith('*.') && (host === r.host.slice(2) || host.endsWith(r.host.slice(1))))));
            let addresses = [];
            let error = null;
            try { addresses = (await dnsPromises.lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family })); } catch (e) { error = e.code || e.message; }
            return _send(res, 200, { host, addresses, error, override: rule ? { id: rule.id, host: rule.host, ip: rule.ip } : null });
        }
        const one = /^\/api\/dns\/([0-9a-f]{12})$/.exec(p);
        if (one && (m === 'PUT' || m === 'POST')) { dns.update(one[1], await body()); app.applyDns(); return listing(); }
        if (one && m === 'DELETE') {
            if (!dns.remove(one[1])) return _send(res, 404, { error: 'No such rule' });
            app.applyDns();
            return listing();
        }
        return false;
    }

    if (p.startsWith('/api/notes')) {
        const notes = app.notes;
        if (p === '/api/notes' && m === 'GET') {
            const host = String(u.searchParams.get('host') || '').toLowerCase();
            return _send(res, 200, { notes: host ? notes.forHost(host) : notes.list(), tags: notes.tags() });
        }
        if (p === '/api/notes' && m === 'POST') return _send(res, 200, notes.add(await body()));
        if (p === '/api/notes/templates' && m === 'GET') return _send(res, 200, notes.listTemplates());
        if (p === '/api/notes/templates' && m === 'POST') return _send(res, 200, notes.addTemplate(await body()));
        const tpl = /^\/api\/notes\/templates\/([0-9a-f]{12})$/.exec(p);
        if (tpl && (m === 'PUT' || m === 'POST')) return _send(res, 200, notes.updateTemplate(tpl[1], await body()));
        if (tpl && m === 'DELETE') {
            return notes.removeTemplate(tpl[1]) ? _send(res, 200, { ok: true }) : _send(res, 404, { error: 'No such template' });
        }
        const one = /^\/api\/notes\/([0-9a-f]{12})$/.exec(p);
        if (one && m === 'GET') {
            const n = notes.get(one[1]);
            return n ? _send(res, 200, n) : _send(res, 404, { error: 'No such note' });
        }
        if (one && (m === 'PUT' || m === 'POST')) return _send(res, 200, notes.update(one[1], await body()));
        if (one && m === 'DELETE') {
            return notes.remove(one[1]) ? _send(res, 200, { ok: true }) : _send(res, 404, { error: 'No such note' });
        }
        return false;
    }

    // Mirror audit: before/after trail for `mirror` intercept rules.
    if (p.startsWith('/api/mirror')) {
        // Live preview for the replace editor (runs the real engine; no audit store needed).
        if (p === '/api/mirror/preview' && m === 'POST') {
            const data = (await _readJson(req).catch(() => ({}))) || {};
            return _send(res, 200, mirrorPreview(data));
        }
        // Fetch a real page through the egress worker so the editor can test rules on live HTML.
        if (p === '/api/mirror/fetch' && m === 'POST') {
            const data = (await _readJson(req).catch(() => ({}))) || {};
            const r = await app.mirrorFetch(String(data.url || ''));
            // Always 200 so the editor can show the error inline instead of a transport failure.
            return _send(res, 200, r);
        }
        const audit = app.mirrorAudit;
        if (!audit) return _send(res, 200, { total: 0, items: [] });
        if (p === '/api/mirror' && m === 'GET') {
            return _send(res, 200, audit.list({
                limit: Number(u.searchParams.get('limit')) || 200,
                offset: Number(u.searchParams.get('offset')) || 0,
            }));
        }
        if (p === '/api/mirror' && m === 'DELETE') { audit.clear(); return _send(res, 200, { ok: true }); }
        const one = /^\/api\/mirror\/([a-z0-9]+)$/.exec(p);
        if (one && m === 'GET') {
            const row = audit.get(one[1]);
            return row ? _send(res, 200, row) : _send(res, 404, { error: 'No such entry' });
        }
        return false;
    }

    const snap = /^\/api\/sitemap\/snapshot\/(\d+)$/.exec(p);
    if (snap && m === 'GET') {
        const src = sessionSource(u.searchParams.get('session') || app.log.sessionId);
        if (!src) return _send(res, 404, { error: 'no such session' });
        return _send(res, 200, buildSnapshot(src, Number(snap[1])));
    }
    if (p === '/api/sitemap' && m === 'GET') {
        const sid = u.searchParams.get('session') || app.log.sessionId;
        const src = sessionSource(sid);
        if (!src) return _send(res, 404, { error: 'no such session' });
        const st = app.siteMaps.state(sid, src);
        const site = String(u.searchParams.get('site') || '').trim().toLowerCase();
        const sites = siteMap.listSites(st);
        if (!site) return _send(res, 200, { session: sid, sites });
        return _send(res, 200, { session: sid, sites, ...siteMap.siteView(st, site, { subs: u.searchParams.get('subs') === '1' }) });
    }
    return false;
}

/** /api/cookies*. Returns false when nothing matched. Thrown errors → 400. */
async function _cookieRoute(jar, req, res, u) {
    const p = u.pathname;
    const m = req.method;
    const body = async () => (await _readJson(req)) || {};
    const snapshot = () => _send(res, 200, jar.snapshot());

    if (p === '/api/cookies' && m === 'GET') return snapshot();
    if (p === '/api/cookies' && m === 'DELETE') {
        const b = await body();
        const forgotten = jar.forget({ ids: Array.isArray(b.ids) ? b.ids.map(String) : [], domain: b.domain, all: b.all === true });
        return _send(res, 200, { forgotten, ...jar.snapshot() });
    }
    if (p === '/api/cookies/ops' && m === 'POST') {
        const b = await body();
        if (b.op === 'set') jar.queueSet(b.cookie);
        else if (b.op === 'delete') jar.queueDelete({ ids: Array.isArray(b.ids) ? b.ids.map(String) : [], cookie: b.cookie });
        else if (b.op === 'clear') jar.queueClearSite(b.domain);
        else if (b.op === 'clear-done') jar.clearDoneOps();
        else throw new Error('op must be set, delete, clear or clear-done');
        return snapshot();
    }
    const op = /^\/api\/cookies\/ops\/([0-9a-f]{12})$/.exec(p);
    if (op && m === 'DELETE') {
        if (!jar.cancelOp(op[1])) return _send(res, 404, { error: 'No pending operation with this id' });
        return snapshot();
    }
    if (p === '/api/cookies/overrides' && m === 'POST') { jar.addOverride(await body()); return snapshot(); }
    const ov = /^\/api\/cookies\/overrides\/([0-9a-f]{12})$/.exec(p);
    if (ov && m === 'POST') { jar.updateOverride(ov[1], await body()); return snapshot(); }
    if (ov && m === 'DELETE') {
        if (!jar.removeOverride(ov[1])) return _send(res, 404, { error: 'No such override' });
        return snapshot();
    }
    if (p === '/api/cookies/export' && m === 'GET') {
        const fmt = u.searchParams.get('format') === 'netscape' ? 'netscape' : 'json';
        const ids = new Set((u.searchParams.get('ids') || '').split(',').filter(Boolean));
        const domain = String(u.searchParams.get('domain') || '').toLowerCase().replace(/^\./, '');
        const list = jar.list().filter((c) => (!ids.size || ids.has(c.id)) && (!domain || c.domain === domain || c.domain.endsWith(`.${domain}`)));
        const text = fmt === 'netscape' ? jar.exportNetscape(list) : jar.exportJson(list);
        return _send(res, 200, text, fmt === 'netscape' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', {
            'Content-Disposition': `attachment; filename="cookies${domain ? `-${domain.replace(/[^a-z0-9.-]/g, '')}` : ''}.${fmt === 'netscape' ? 'txt' : 'json'}"`,
        });
    }
    if (p === '/api/cookies/import' && m === 'POST') {
        const b = await body();
        const { cookies, errors } = CookieJar.parseImport(b.text);
        if (!b.dryRun) for (const c of cookies) jar.queueSet(c);
        return _send(res, 200, { queued: b.dryRun ? 0 : cookies.length, parsed: cookies.length, errors: errors.slice(0, 50), ...jar.snapshot() });
    }
    return false;
}

/** /api/proxies* and /api/egress. Returns false when nothing matched. Thrown errors → 400. */
async function _proxyRoute(app, req, res, u) {
    const p = u.pathname;
    const m = req.method;
    const pm = app.proxies;
    const store = pm.store;
    const listing = () => ({ profiles: store.list(), status: pm.status(), testing: pm.testing });

    if (p === '/api/egress' && m === 'GET') {
        const force = u.searchParams.get('force') === '1';
        const mon = app.ipMonitor;
        if (force && mon?.enabled) {
            // The monitor is checking anyway: one check that also lands in the IP history.
            const st = await mon.checkNow();
            const egress = st.ok ? mon.egress() : { ok: false, blocked: st.blocked, error: st.lastError || 'IP check failed', at: new Date().toISOString() };
            return _send(res, 200, { egress, status: pm.status() });
        }
        const egress = await pm.egress({ force });
        return _send(res, 200, { egress, status: pm.status() });
    }
    if (p === '/api/proxies' && m === 'GET') return _send(res, 200, listing());
    if (p === '/api/proxies/providers' && m === 'GET') return _send(res, 200, providerCatalog());
    if (p === '/api/proxies' && m === 'POST') {
        const saved = store.save((await _readJson(req)) || {});
        return _send(res, 200, { profile: store.publicProfile(saved), ...listing() });
    }
    if (p === '/api/proxies/preview' && m === 'POST') {
        const body = (await _readJson(req)) || {};
        const draft = store.build(body.profile || {}, body.id || null);
        return _send(res, 200, { display: store.display(draft), sticky: store.publicProfile(draft).sticky });
    }
    if (p === '/api/proxies/import' && m === 'POST') {
        const body = (await _readJson(req)) || {};
        const r = store.importLines(body.text, { group: body.group, namePrefix: body.namePrefix, dryRun: !!body.dryRun });
        return _send(res, 200, { ...r, ...(body.dryRun ? {} : listing()) });
    }
    if (p === '/api/proxies/test' && m === 'POST') {
        const body = (await _readJson(req)) || {};
        const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : store.list().map((x) => x.id);
        const results = await pm.testMany(ids);
        return _send(res, 200, { results, ...listing() });
    }
    if (p === '/api/proxies/disconnect' && m === 'POST') { pm.disconnect(); return _send(res, 200, listing()); }
    if (p === '/api/proxies/kill-switch' && m === 'POST') {
        const body = (await _readJson(req)) || {};
        pm.setKillSwitch(!!body.enabled);
        return _send(res, 200, listing());
    }
    if (p === '/api/proxies/new-ip' && m === 'POST') { pm.newIp(null); return _send(res, 200, listing()); }

    const one = /^\/api\/proxies\/([0-9a-f]{16})(?:\/(duplicate|test|connect|new-ip))?$/.exec(p);
    if (!one) return false;
    const [, id, action] = one;
    if (!store.get(id)) return _send(res, 404, { error: 'Proxy profile not found' });
    if (!action && m === 'PUT') {
        const saved = store.save((await _readJson(req)) || {}, id);
        // Editing the connected profile re-applies it right away.
        if (store.activeId === id) pm.connect(id);
        return _send(res, 200, { profile: store.publicProfile(saved), ...listing() });
    }
    if (!action && m === 'DELETE') {
        const wasActive = store.activeId === id;
        store.remove(id);
        if (wasActive) pm.disconnect();
        return _send(res, 200, listing());
    }
    if (m !== 'POST') return _send(res, 405, { error: 'method not allowed' });
    if (action === 'duplicate') { const c = store.duplicate(id); return _send(res, 200, { profile: store.publicProfile(c), ...listing() }); }
    if (action === 'test') { const result = await pm.test(id); return _send(res, 200, { result, ...listing() }); }
    if (action === 'connect') { pm.connect(id); return _send(res, 200, listing()); }
    if (action === 'new-ip') { pm.newIp(id); return _send(res, 200, listing()); }
    return false;
}

module.exports = { createUiServer, BODY_PREVIEW_CHARS, UI_CSP };
