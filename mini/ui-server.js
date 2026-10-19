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

const UI_HTML = path.join(__dirname, 'ui.html');
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
            return _send(res, 200, html, 'text/html; charset=utf-8', {
                'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; frame-src 'none'; object-src 'none'; frame-ancestors 'none'",
            });
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
            sessionId: app.log.sessionId,
            entries: app.log.count,
            lastSeq: app.log.lastSeq,
            writeErrors: app.log.writeErrors,
            dataDir: app.dataDir,
            mitmPort: app.mitmPort,
            browser: app.browser,
            upstream: app.upstream ? String(app.upstream).replace(/\/\/[^@/]*@/, '//***@') : null,
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

module.exports = { createUiServer, BODY_PREVIEW_CHARS };
