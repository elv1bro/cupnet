'use strict';

/**
 * Parse a cURL command into { method, url, headers, body }.
 */
function parseCurlCommand(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    let s = raw.replace(/\r\n/g, '\n');
    s = s.replace(/\\\n/g, ' ');
    if (!/^curl\b/i.test(s)) {
        s = 'curl ' + s;
    }

    const headers = {};
    let method = 'GET';
    let url = '';
    let body = '';
    const tokens = tokenizeCurl(s);
    let i = 0;
    if (tokens[0] && /^curl$/i.test(tokens[0])) i = 1;

    while (i < tokens.length) {
        const t = tokens[i];
        const low = t.toLowerCase();
        if (low === '-x' || low === '--request') {
            method = String(tokens[i + 1] || 'GET').toUpperCase();
            i += 2;
            continue;
        }
        if (low === '-h' || low === '--header') {
            const hv = String(tokens[i + 1] || '');
            const colon = hv.indexOf(':');
            if (colon > 0) {
                const k = hv.slice(0, colon).trim();
                const v = hv.slice(colon + 1).trim();
                if (k) headers[k] = v;
            }
            i += 2;
            continue;
        }
        if (low === '-d' || low === '--data' || low === '--data-raw' || low === '--data-binary') {
            body = String(tokens[i + 1] || '');
            i += 2;
            continue;
        }
        if (low === '-b' || low === '--cookie') {
            headers['Cookie'] = String(tokens[i + 1] || '');
            i += 2;
            continue;
        }
        if (low === '-u' || low === '--user') {
            const u = String(tokens[i + 1] || '');
            try {
                headers['Authorization'] = 'Basic ' + btoa(unescape(encodeURIComponent(u)));
            } catch {
                headers['Authorization'] = 'Basic ' + u;
            }
            i += 2;
            continue;
        }
        if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith("'http") || t.startsWith('"http')) {
            url = stripQuotes(t);
            i++;
            continue;
        }
        if (t.startsWith('-')) {
            i++;
            continue;
        }
        if (!url && (t.includes('://') || /^['"]?https?:/.test(t))) {
            url = stripQuotes(t);
        }
        i++;
    }

    if (!url) return null;
    return { method, url, headers, body };
}

function stripQuotes(x) {
    let s = String(x || '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1);
    }
    return s;
}

function tokenizeCurl(line) {
    const out = [];
    let cur = '';
    let q = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '\\' && q !== "'" && i + 1 < line.length) {
                cur += line[++i];
                continue;
            }
            if (c === q) {
                q = null;
                out.push(cur);
                cur = '';
                continue;
            }
            cur += c;
            continue;
        }
        if (c === '"' || c === "'") {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
            q = c;
            continue;
        }
        if (/\s/.test(c)) {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/**
 * Postman Collection v2.1 — first item with request.
 */
function parsePostmanCollectionV21(json) {
    if (!json || typeof json !== 'object') return null;
    const info = json.info;
    if (!info || String(info.schema || '').indexOf('2.1') === -1) {
        return null;
    }

    function walkItems(items) {
        if (!Array.isArray(items)) return null;
        for (const it of items) {
            if (it && it.request && typeof it.request === 'object') {
                const r = it.request;
                const method = String(r.method || 'GET').toUpperCase();
                let urlStr = '';
                if (typeof r.url === 'string') {
                    urlStr = r.url;
                } else if (r.url && typeof r.url === 'object') {
                    const u = r.url;
                    const raw = u.raw || '';
                    if (raw) urlStr = raw;
                    else {
                        const proto = (u.protocol || 'https') + '://';
                        const host = (Array.isArray(u.host) ? u.host.join('.') : u.host) || '';
                        const path = Array.isArray(u.path) ? u.path.join('/') : '';
                        if (host) urlStr = proto + host + (path ? '/' + path : '');
                    }
                }
                const headers = {};
                if (Array.isArray(r.header)) {
                    for (const h of r.header) {
                        if (h && h.key && h.value !== undefined && !h.disabled) {
                            headers[h.key] = h.value;
                        }
                    }
                }
                let body = '';
                if (r.body && r.body.mode === 'raw' && r.body.raw) {
                    body = String(r.body.raw);
                } else if (r.body && r.body.mode === 'urlencoded' && Array.isArray(r.body.urlencoded)) {
                    const pairs = [];
                    for (const p of r.body.urlencoded) {
                        if (p && p.key && !p.disabled) {
                            pairs.push(`${encodeURIComponent(p.key)}=${encodeURIComponent(p.value || '')}`);
                        }
                    }
                    body = pairs.join('&');
                }
                return { method, url: urlStr, headers, body };
            }
            if (it && Array.isArray(it.item)) {
                const nested = walkItems(it.item);
                if (nested) return nested;
            }
        }
        return null;
    }

    return walkItems(json.item);
}

window.CupNetParseCurl = parseCurlCommand;
window.CupNetParsePostman = parsePostmanCollectionV21;
