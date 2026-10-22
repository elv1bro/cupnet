'use strict';

/**
 * Local test host for sealed sessions: serves mini/viewer.html at / and <dataDir>/sealed/<id>.cupsess at
 * /sealed/<id>.cupsess. Loopback only (127.0.0.1, Host header checked), no listing, nothing else.
 * Sealed files are AES-GCM encrypted and named by an unguessable id; the key never reaches this server
 * (it is a .cupkey file or the #k= fragment of the share link, which browsers do not send).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const VIEWER = path.join(__dirname, 'viewer.html');
const DEFAULT_PORT = 8879;
/** 0 = any free port (tests); otherwise 1..65535, else the default. */
const _port = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 65535 && v !== '' && v != null ? n : DEFAULT_PORT; };

function _viewer() {
    const html = fs.readFileSync(VIEWER);
    // The viewer is one file with inline <style>/<script>: allow exactly that script by hash.
    const text = html.toString('utf8');
    const hashes = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    const csp = `default-src 'none'; script-src ${hashes.join(' ') || "'none'"}; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    return { html, csp };
}

class ShareHost {
    /** @param {{ sealedDir: string, port?: number }} o */
    constructor({ sealedDir, port }) {
        this.sealedDir = sealedDir;
        this.port = _port(port);
        this.server = null;
    }

    get running() { return !!this.server?.listening; }

    get baseUrl() { return `http://localhost:${this.port}/`; }

    /** Viewer link for a sealed session; with `rawKey` (base64url) the key travels in the fragment. */
    linkFor(id, rawKey) {
        return `${this.baseUrl}#id=${id}${rawKey ? `&k=${rawKey}` : ''}`;
    }

    _handle(req, res) {
        const host = String(req.headers.host || '');
        const send = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
            res.writeHead(status, {
                'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', ...extra,
            });
            res.end(req.method === 'HEAD' ? undefined : body);
        };
        if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(421, 'bad host');
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed', undefined, { Allow: 'GET, HEAD' });
        const p = String(req.url || '/').split('?')[0];
        if (p === '/' || p === '/viewer.html') {
            let v;
            try { v = _viewer(); } catch { return send(500, 'viewer.html is missing'); }
            return send(200, v.html, 'text/html; charset=utf-8', { 'Content-Security-Policy': v.csp, 'X-Frame-Options': 'DENY' });
        }
        const m = /^\/sealed\/([0-9a-f]{32})\.cupsess$/.exec(p);
        if (!m) return send(404, 'not found');
        const file = path.join(this.sealedDir, `${m[1]}.cupsess`);
        let st;
        try { st = fs.statSync(file); } catch { return send(404, 'not found'); }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return undefined;
    }

    start(port) {
        if (this.running) return Promise.resolve(this);
        if (port != null) this.port = _port(port);
        const server = http.createServer((req, res) => {
            try { this._handle(req, res); } catch { try { res.destroy(); } catch { /* ignore */ } }
        });
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.port, '127.0.0.1', () => {
                server.off('error', reject);
                this.server = server;
                this.port = server.address().port;
                resolve(this);
            });
        });
    }

    stop() {
        const s = this.server;
        this.server = null;
        if (!s) return Promise.resolve();
        return new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
    }

    status() { return { running: this.running, port: this.port, url: this.running ? this.baseUrl : null }; }
}

module.exports = { ShareHost, DEFAULT_SHARE_PORT: DEFAULT_PORT };
