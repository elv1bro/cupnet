'use strict';

/**
 * Bulk / static proxy list parser (Proxy Manager → Advanced → "Import list").
 *
 * Accepted line formats (one proxy per line, blank lines and `#` comments ignored):
 *   scheme://user:pass@host:port
 *   scheme://host:port
 *   user:pass@host:port
 *   host:port:user:pass
 *   host:port
 * Default scheme is http. IPv6 hosts must be bracketed ([::1]:8080). Duplicates are dropped.
 *
 * Dual-mode module (CommonJS + window.cupnetProxyStaticImport), dependency-free.
 * Unit tests: tests/unit/proxy-static-import.test.mjs
 */

const SCHEMES = new Set(['http', 'https', 'socks5', 'socks5h', 'socks4', 'socks4a', 'socks']);
const MAX_LINES = 2000;

function _validPort(p) {
    return /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
}

function _validHost(h) {
    if (!h) return false;
    if (/^\[[0-9a-f:.]+\]$/i.test(h)) return true;                 // bracketed IPv6
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h);
}

function _safeDecode(s) {
    try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Parse one line. Returns { entry } or { error }.
 * @param {string} rawLine
 */
function parseStaticProxyLine(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) return { skip: true };

    let scheme = 'http';
    let rest = line;
    const m = rest.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
    if (m) {
        scheme = m[1].toLowerCase();
        rest = m[2];
        if (!SCHEMES.has(scheme)) return { error: `unsupported scheme "${scheme}"` };
    }

    let username = '';
    let password = '';
    let hostport = rest;
    const at = rest.lastIndexOf('@');
    if (at >= 0) {
        const cred = rest.slice(0, at);
        hostport = rest.slice(at + 1);
        const c = cred.indexOf(':');
        username = c >= 0 ? cred.slice(0, c) : cred;
        password = c >= 0 ? cred.slice(c + 1) : '';
        username = _safeDecode(username);
        password = _safeDecode(password);
    }

    // host:port[:user:pass]  (IPv6 in brackets)
    let host;
    let port;
    let tail = [];
    const v6 = hostport.match(/^(\[[^\]]+\])(?::(.*))?$/);
    if (v6) {
        host = v6[1];
        tail = v6[2] ? v6[2].split(':') : [];
    } else {
        tail = hostport.split(':');
        host = tail.shift();
    }
    port = tail.shift() || '';
    if (tail.length && !username) {
        username = tail.shift() || '';
        password = tail.join(':'); // password may contain ':'
    } else if (tail.length) {
        return { error: 'credentials given twice' };
    }
    if (hostport.includes('/')) return { error: 'path segments are not allowed' };
    if (!_validHost(host)) return { error: `invalid host "${host || ''}"` };
    if (!_validPort(port)) return { error: `invalid port "${port || ''}"` };

    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    const url = `${scheme}://${auth}${host}:${port}`;
    return { entry: { url, scheme, host, port: Number(port), username, password, hasAuth: !!username } };
}

/**
 * Parse a multi-line list.
 * @param {string} text
 * @returns {{ entries: Array<object>, errors: Array<{line:number, text:string, reason:string}>, duplicates: number, total: number }}
 */
function parseStaticProxyLines(text) {
    const lines = String(text || '').split(/\r?\n/);
    const entries = [];
    const errors = [];
    const seen = new Set();
    let duplicates = 0;
    let total = 0;
    for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
        const r = parseStaticProxyLine(lines[i]);
        if (r.skip) continue;
        total++;
        if (r.error) { errors.push({ line: i + 1, text: lines[i].trim(), reason: r.error }); continue; }
        const key = r.entry.url;
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        entries.push({ ...r.entry, line: i + 1 });
    }
    return { entries, errors, duplicates, total };
}

/**
 * Suggest profile names for imported entries: "<prefix> 01" … or "<host>:<port>" without a prefix.
 * @param {Array<object>} entries
 * @param {string} [prefix]
 */
function suggestStaticProfileNames(entries, prefix) {
    const p = String(prefix || '').trim();
    const width = String(entries.length).length;
    return entries.map((e, i) => (p ? `${p} ${String(i + 1).padStart(Math.max(2, width), '0')}` : `${e.host}:${e.port}`));
}

const cupnetProxyStaticImport = { parseStaticProxyLine, parseStaticProxyLines, suggestStaticProfileNames, SCHEMES: [...SCHEMES], MAX_LINES };

if (typeof module !== 'undefined' && module.exports) module.exports = cupnetProxyStaticImport;
if (typeof window !== 'undefined') window.cupnetProxyStaticImport = cupnetProxyStaticImport;
