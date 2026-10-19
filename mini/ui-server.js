'use strict';

/**
 * CupNet mini control UI on 127.0.0.1:<uiPort>.
 *
 * Access control (the log holds cookies and tokens):
 *  - bound to loopback only;
 *  - Host must be 127.0.0.1:<port> or localhost:<port> (blocks DNS-rebinding pages);
 *  - every /api/* call needs `X-CupNet-Token: <token>` — a custom header, so a cross-origin page cannot
 *    send it without a CORS preflight, which this server never approves.
 * The HTML page itself holds no data; it reads the token from its own URL fragment (#t=…).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { SessionLog } = require('./session-log');

const UI_HTML = path.join(__dirname, 'ui.html');
const JSON_BODY_MAX = 2 * 1024 * 1024;

function _send(res, status, body, type = 'application/json; charset=utf-8') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
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

/** @param {import('./mini-app').MiniApp} app */
function createUiServer(app) {
    const server = http.createServer(async (req, res) => {
        const port = server.address()?.port;
        const host = String(req.headers.host || '').toLowerCase();
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return _send(res, 421, { error: 'bad host' });
        const u = new URL(req.url, `http://127.0.0.1:${port}`);

        if (u.pathname === '/' && req.method === 'GET') {
            const html = fs.readFileSync(UI_HTML);
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'");
            return _send(res, 200, html, 'text/html; charset=utf-8');
        }
        if (!u.pathname.startsWith('/api/')) return _send(res, 404, { error: 'not found' });
        if (!_tokenOk(req.headers['x-cupnet-token'], app.token)) return _send(res, 401, { error: 'token required' });

        try {
            return await _route(app, req, res, u);
        } catch (e) {
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
        close() { return new Promise((resolve) => server.close(() => resolve())); },
    };
}

async function _route(app, req, res, u) {
    const p = u.pathname;
    const m = req.method;

    if (p === '/api/status' && m === 'GET') {
        return _send(res, 200, {
            sessionId: app.log.sessionId,
            dataDir: app.dataDir,
            mitmPort: app.mitmPort,
            browser: app.browser,
            upstream: app.upstream ? String(app.upstream).replace(/\/\/[^@/]*@/, '//***@') : null,
            trust: app.trust,
            ca: { certPath: app.ca.certPath, spki: app.ca.spki, sha256: app.ca.sha256, commands: app.ca.commands },
            stats: app.mitm?.getStats?.() || null,
        });
    }

    if (p === '/api/log' && m === 'GET') {
        const after = Number(u.searchParams.get('after')) || 0;
        const limit = Math.min(2000, Number(u.searchParams.get('limit')) || 500);
        return _send(res, 200, app.log.list(after, limit));
    }
    const logOne = /^\/api\/log\/(\d+)$/.exec(p);
    if (logOne && m === 'GET') {
        const e = app.log.get(Number(logOne[1]));
        return e ? _send(res, 200, e) : _send(res, 404, { error: 'not in memory (see the session file)' });
    }

    if (p === '/api/rules' && m === 'GET') {
        return _send(res, 200, app.db.getAllInterceptRules());
    }
    if (p === '/api/rules' && m === 'POST') {
        const rule = await _readJson(req);
        if (!rule || typeof rule !== 'object') return _send(res, 400, { error: 'rule object expected' });
        if (!rule.name || !rule.url_pattern || !rule.type) return _send(res, 400, { error: 'name, url_pattern and type are required' });
        const v = app.interceptor.validateInterceptRuleForSave(rule);
        if (!v.ok) return _send(res, 400, { error: v.error });
        const id = app.db.saveInterceptRule(rule);
        app.interceptor.invalidateRulesCache();
        return _send(res, 200, { id });
    }
    const ruleOne = /^\/api\/rules\/(\d+)$/.exec(p);
    if (ruleOne && m === 'DELETE') {
        app.db.deleteInterceptRule(Number(ruleOne[1]));
        app.interceptor.invalidateRulesCache();
        return _send(res, 200, { ok: true });
    }

    if (p === '/api/chrome' && m === 'POST') {
        const body = await _readJson(req).catch(() => ({}));
        const r = app.launchChrome(body?.url);
        return _send(res, r.success ? 200 : 500, r);
    }

    if (p === '/api/sessions' && m === 'GET') {
        return _send(res, 200, { current: app.log.sessionId, sessions: SessionLog.listSessions(app.sessionsDir) });
    }
    const sess = /^\/api\/sessions\/([\w-]+)$/.exec(p);
    if (sess && m === 'GET') {
        const file = path.join(app.sessionsDir, `${sess[1]}.jsonl`);
        if (!fs.existsSync(file)) return _send(res, 404, { error: 'no such session' });
        return _send(res, 200, fs.readFileSync(file), 'application/x-ndjson; charset=utf-8');
    }

    return _send(res, 404, { error: 'not found' });
}

module.exports = { createUiServer };
