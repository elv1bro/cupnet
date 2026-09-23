'use strict';

/**
 * Parse a cURL command into { method, url, headers, body }.
 *
 * curl distinguishes flags by CASE (e.g. -X = method, -x = proxy; -A = user-agent),
 * so flags are matched case-sensitively. Chrome's "Copy as cURL" emits ANSI-C quoted
 * bodies ($'...'), which the tokenizer decodes. (A-174)
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
    let explicitMethod = false;
    let url = '';
    const dataParts = [];
    let isForm = false;

    const tokens = tokenizeCurl(s);
    let i = 0;
    if (tokens[0] && /^curl$/i.test(tokens[0])) i = 1;

    // Flags that take an argument we don't use — skip the flag AND its value.
    const skipWithArg = new Set([
        '-x', '--proxy', '-o', '--output', '--connect-timeout', '--max-time', '-m',
        '--retry', '--limit-rate', '-w', '--write-out', '--cacert', '--cert', '--key',
        '--resolve', '--interface', '-Y', '--speed-limit', '-y', '--speed-time',
    ]);

    while (i < tokens.length) {
        const t = tokens[i];
        if (t === '-X' || t === '--request') {
            method = String(tokens[i + 1] || 'GET').toUpperCase();
            explicitMethod = true;
            i += 2;
            continue;
        }
        if (t === '-H' || t === '--header') {
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
        if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
            dataParts.push(String(tokens[i + 1] || ''));
            i += 2;
            continue;
        }
        if (t === '--data-urlencode') {
            const v = String(tokens[i + 1] || '');
            const eq = v.indexOf('=');
            if (eq > 0) dataParts.push(encodeURIComponent(v.slice(0, eq)) + '=' + encodeURIComponent(v.slice(eq + 1)));
            else dataParts.push(encodeURIComponent(v.replace(/^=/, '')));
            i += 2;
            continue;
        }
        if (t === '-F' || t === '--form') {
            // Multipart is not fully modeled here; at least force POST.
            isForm = true;
            i += 2;
            continue;
        }
        if (t === '-b' || t === '--cookie') { headers['Cookie'] = String(tokens[i + 1] || ''); i += 2; continue; }
        if (t === '-e' || t === '--referer') { headers['Referer'] = String(tokens[i + 1] || ''); i += 2; continue; }
        if (t === '-A' || t === '--user-agent') { headers['User-Agent'] = String(tokens[i + 1] || ''); i += 2; continue; }
        if (t === '-u' || t === '--user') {
            const u = String(tokens[i + 1] || '');
            try {
                headers['Authorization'] = 'Basic ' + b64(u);
            } catch {
                headers['Authorization'] = 'Basic ' + u;
            }
            i += 2;
            continue;
        }
        if (t === '--url') { if (!url) url = stripQuotes(String(tokens[i + 1] || '')); i += 2; continue; }
        if (skipWithArg.has(t)) { i += 2; continue; }
        if (t.startsWith('-')) { i++; continue; } // other boolean flags
        // First positional token is the URL (curl semantics); ignore later ones.
        if (!url) url = stripQuotes(t);
        i++;
    }

    if (!explicitMethod && (dataParts.length || isForm)) method = 'POST';
    const body = dataParts.join('&');

    if (!url) return null;
    return { method, url, headers, body };
}

function b64(str) {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(str)));
    // Node fallback
    return Buffer.from(str, 'utf8').toString('base64');
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
    let q = null; // "'", '"', or 'ansi' ($'...')
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q === 'ansi') {
            if (c === '\\' && i + 1 < line.length) {
                const n = line[++i];
                if (n === 'n') cur += '\n';
                else if (n === 't') cur += '\t';
                else if (n === 'r') cur += '\r';
                else if (n === "'") cur += "'";
                else if (n === '"') cur += '"';
                else if (n === '\\') cur += '\\';
                else if (n === 'x') {
                    const hex = line.slice(i + 1, i + 3);
                    if (/^[0-9a-f]{2}$/i.test(hex)) { cur += String.fromCharCode(parseInt(hex, 16)); i += 2; }
                    else cur += 'x';
                } else if (n === 'u') {
                    const hex = line.slice(i + 1, i + 5);
                    if (/^[0-9a-f]{4}$/i.test(hex)) { cur += String.fromCharCode(parseInt(hex, 16)); i += 4; }
                    else cur += 'u';
                } else cur += n;
                continue;
            }
            if (c === "'") { q = null; out.push(cur); cur = ''; continue; }
            cur += c;
            continue;
        }
        if (q) {
            if (c === '\\' && q !== "'" && i + 1 < line.length) { cur += line[++i]; continue; }
            if (c === q) { q = null; out.push(cur); cur = ''; continue; }
            cur += c;
            continue;
        }
        // ANSI-C quoting: $'...'
        if (c === '$' && line[i + 1] === "'") {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
            q = 'ansi';
            i++; // skip the opening '
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

if (typeof window !== 'undefined') {
    window.CupNetParseCurl = parseCurlCommand;
    window.CupNetParsePostman = parsePostmanCollectionV21;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseCurlCommand, parsePostmanCollectionV21, tokenizeCurl };
}
