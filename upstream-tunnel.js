'use strict';

/**
 * Raw TCP tunnels to host:port through an upstream proxy, for the paths that bypass the AzureTLS worker
 * (TLS passthrough domains, WebSocket after Upgrade). The worker itself already speaks every scheme;
 * before this module these raw paths only knew plain-HTTP CONNECT, so SOCKS / https:// upstreams broke
 * them (A-410).
 *
 *   http://   CONNECT over TCP
 *   https://  CONNECT over TLS to the proxy (certificate not verified, same as the Go worker)
 *   socks4:// target resolved locally (SOCKS4 has no hostnames)
 *   socks4a:// target name sent to the proxy
 *   socks5:// / socks5h://  target name sent to the proxy (no local DNS for the target, like Go's
 *             x/net/proxy); username/password auth (RFC 1929) when the URL has credentials
 *
 * connectThroughProxy() resolves { socket, buffered }: `buffered` holds bytes the proxy sent after its
 * CONNECT reply (normally empty) that belong to the tunnelled stream.
 */

const net = require('net');
const tls = require('tls');
const dns = require('dns');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_CONNECT_HEAD = 16 * 1024;

const SOCKS5_REPLIES = {
    1: 'general SOCKS server failure',
    2: 'connection not allowed by ruleset',
    3: 'network unreachable',
    4: 'host unreachable',
    5: 'connection refused',
    6: 'TTL expired',
    7: 'command not supported',
    8: 'address type not supported',
};

const SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

function _decode(s) {
    try { return decodeURIComponent(s || ''); } catch { return s || ''; }
}

function parseProxyUrl(proxyUrl) {
    const u = proxyUrl instanceof URL ? proxyUrl : new URL(String(proxyUrl));
    const scheme = u.protocol.toLowerCase();
    if (!SCHEMES.has(scheme)) throw new Error(`Unsupported upstream proxy scheme ${scheme}`);
    const defaultPort = scheme === 'http:' ? 80 : scheme === 'https:' ? 443 : 1080;
    return {
        scheme: scheme === 'socks:' ? 'socks5:' : scheme,
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port: Number(u.port || defaultPort),
        username: _decode(u.username),
        password: _decode(u.password),
    };
}

/** Reads exactly-sized replies from a socket in the handshake phase. */
class _Reader {
    constructor(socket) {
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.waiter = null;
        this.failed = null;
        this._onData = (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this._pump(); };
        this._onEnd = () => this._fail(new Error('Upstream proxy closed the connection during handshake'));
        this._onError = (e) => this._fail(e);
        socket.on('data', this._onData);
        socket.on('end', this._onEnd);
        socket.on('close', this._onEnd);
        socket.on('error', this._onError);
    }

    _fail(err) {
        if (this.failed) return;
        this.failed = err;
        this._pump();
    }

    _pump() {
        const w = this.waiter;
        if (!w) return;
        const n = w.test(this.buf);
        if (n != null) {
            this.waiter = null;
            const out = this.buf.subarray(0, n);
            this.buf = this.buf.subarray(n);
            w.resolve(out);
        } else if (this.failed) {
            this.waiter = null;
            w.reject(this.failed);
        } else if (this.buf.length > MAX_CONNECT_HEAD) {
            this.waiter = null;
            w.reject(new Error('Upstream proxy reply too large'));
        }
    }

    /** @param {(buf: Buffer) => number|null} test byte count of a complete reply, or null if more is needed */
    read(test) {
        return new Promise((resolve, reject) => {
            this.waiter = { test, resolve, reject };
            this._pump();
        });
    }

    exact(n) { return this.read((b) => (b.length >= n ? n : null)); }

    /** Detach and hand back unread bytes. */
    release() {
        this.socket.removeListener('data', this._onData);
        this.socket.removeListener('end', this._onEnd);
        this.socket.removeListener('close', this._onEnd);
        this.socket.removeListener('error', this._onError);
        const rest = this.buf;
        this.buf = Buffer.alloc(0);
        return rest;
    }
}

function _hostPortTarget(host, port) {
    return net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}

async function _httpConnect(reader, p, host, port) {
    const target = _hostPortTarget(host, port);
    const lines = [
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        'Proxy-Connection: Keep-Alive',
        'Connection: Keep-Alive',
    ];
    if (p.username || p.password) {
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password}`, 'utf8').toString('base64')}`);
    }
    reader.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    const head = await reader.read((b) => {
        const i = b.indexOf('\r\n\r\n');
        return i === -1 ? null : i + 4;
    });
    const text = head.toString('latin1');
    if (!/^HTTP\/1\.[01]\s+200\b/i.test(text)) {
        const first = (text.split('\r\n')[0] || '').trim();
        const err = new Error(`Upstream CONNECT rejected for ${target}: ${first || 'unknown status'}`);
        const m = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(first);
        if (m) err.statusCode = Number(m[1]);
        throw err;
    }
}

function _lookup4(host) {
    if (net.isIPv4(host)) return Promise.resolve(host);
    return new Promise((resolve, reject) => {
        dns.lookup(host, { family: 4 }, (err, addr) => (err ? reject(err) : resolve(addr)));
    });
}

async function _socks4Connect(reader, p, host, port) {
    const remote = p.scheme === 'socks4a:' && !net.isIPv4(host);
    const ip = remote ? '0.0.0.1' : await _lookup4(host);
    const user = Buffer.from(p.username || '', 'utf8');
    const parts = [
        Buffer.from([4, 1, (port >> 8) & 0xff, port & 0xff, ...ip.split('.').map(Number)]),
        user, Buffer.from([0]),
    ];
    if (remote) parts.push(Buffer.from(host, 'utf8'), Buffer.from([0]));
    reader.socket.write(Buffer.concat(parts));
    const r = await reader.exact(8);
    if (r[1] !== 0x5a) throw new Error(`SOCKS4 connect to ${host}:${port} rejected (code 0x${r[1].toString(16)})`);
}

async function _socks5Connect(reader, p, host, port) {
    const withAuth = !!(p.username || p.password);
    reader.socket.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]));
    const hello = await reader.exact(2);
    if (hello[0] !== 5) throw new Error('Upstream is not a SOCKS5 proxy');
    if (hello[1] === 2) {
        if (!withAuth) throw new Error('SOCKS5 proxy requires a username and password');
        const u = Buffer.from(p.username, 'utf8');
        const pw = Buffer.from(p.password, 'utf8');
        if (u.length > 255 || pw.length > 255) throw new Error('SOCKS5 credentials are too long');
        reader.socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
        const auth = await reader.exact(2);
        if (auth[1] !== 0) throw new Error('SOCKS5 authentication failed (wrong username or password)');
    } else if (hello[1] !== 0) {
        throw new Error('SOCKS5 proxy accepts none of the offered auth methods');
    }

    let addr;
    if (net.isIPv4(host)) addr = Buffer.from([1, ...host.split('.').map(Number)]);
    else if (net.isIPv6(host) && !host.includes('.')) addr = Buffer.concat([Buffer.from([4]), _ipv6Bytes(host)]);
    else {
        const name = Buffer.from(host, 'utf8');
        if (name.length > 255) throw new Error('Target host name too long for SOCKS5');
        addr = Buffer.concat([Buffer.from([3, name.length]), name]);
    }
    reader.socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));

    const rep = await reader.read((b) => {
        if (b.length < 5) return null;
        const atyp = b[3];
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + b[4] : -1;
        if (len < 0) return 5; // malformed; reported below
        return b.length >= 4 + len + 2 ? 4 + len + 2 : null;
    });
    if (rep[0] !== 5) throw new Error('Malformed SOCKS5 reply');
    if (rep[1] !== 0) {
        throw new Error(`SOCKS5 connect to ${host}:${port} failed: ${SOCKS5_REPLIES[rep[1]] || `code ${rep[1]}`}`);
    }
}

function _ipv6Bytes(addr) {
    let [head, tail] = addr.split('::');
    const h = head ? head.split(':') : [];
    const t = tail != null && tail !== '' ? tail.split(':') : [];
    const groups = tail != null ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
    return out;
}

/**
 * @param {string|URL} proxyUrl http(s)/socks4(a)/socks5(h) upstream
 * @param {string} host target host (name or IP)
 * @param {number} port target port
 * @param {{ timeoutMs?: number }} [o]
 * @returns {Promise<{ socket: import('net').Socket, buffered: Buffer }>}
 */
function connectThroughProxy(proxyUrl, host, port, o = {}) {
    let p;
    try { p = parseProxyUrl(proxyUrl); } catch (e) { return Promise.reject(e); }
    const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const target = String(host).replace(/^\[|\]$/g, '');
    const targetPort = Number(port);

    return new Promise((resolve, reject) => {
        let settled = false;
        const socket = p.scheme === 'https:'
            ? tls.connect({ host: p.host, port: p.port, servername: net.isIP(p.host) ? undefined : p.host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
            : net.connect(p.port, p.host);
        const timer = setTimeout(() => finish(new Error(`Upstream proxy ${p.host}:${p.port} timed out`)), timeoutMs);
        const finish = (err, buffered) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) {
                try { socket.destroy(); } catch { /* ignore */ }
                reject(err);
            } else {
                resolve({ socket, buffered: buffered || Buffer.alloc(0) });
            }
        };
        const reader = new _Reader(socket);
        socket.once(p.scheme === 'https:' ? 'secureConnect' : 'connect', async () => {
            try {
                if (p.scheme === 'http:' || p.scheme === 'https:') await _httpConnect(reader, p, target, targetPort);
                else if (p.scheme === 'socks4:' || p.scheme === 'socks4a:') await _socks4Connect(reader, p, target, targetPort);
                else await _socks5Connect(reader, p, target, targetPort);
                finish(null, reader.release());
            } catch (e) {
                reader.release();
                finish(e);
            }
        });
        socket.once('error', (e) => finish(e));
    });
}

module.exports = { connectThroughProxy, parseProxyUrl };
