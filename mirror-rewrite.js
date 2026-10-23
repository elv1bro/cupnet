'use strict';

/**
 * Site-mirror rewrite engine (pure, no network, no Electron, no SQLite).
 *
 * Ported from the standalone https-rewrite-proxy service, dropping its egress path and
 * per-request NodeMaven country/SID selection. It lets a `mirror` intercept rule serve the
 * content of one upstream host (A) under another client-facing host (B): on the request it
 * swaps Host B -> A and reverses any URL rewriting applied to the path; on the response it
 * rewrites the body, `Location` and `Set-Cookie` so every absolute reference stays on host B.
 *
 * The egress itself is NOT done here — the MITM proxy (Go AzureTLS worker) performs it after
 * {@link rewriteRequest} mutates the request URL/Host (see request-interceptor.js `mirror` rule).
 *
 * `replace` rule shape (same as the standalone service's config `sites[].replace`):
 *   { from, to, kind: 'word'|'url', regex?, whole?, cs?, urls?, tags? }
 *   - word (default): plain substring match, case-insensitive. So a single letter maps to another
 *     ("A" -> "o") and partial matches work. By default only text nodes of HTML are touched.
 *   - whole: match whole words only (boundary-aware), instead of any substring.
 *   - cs: case-sensitive match (default: case-insensitive).
 *   - regex: `from` is a RegExp source, `to` may use $1.. groups.
 *   - urls: also rewrite inside href/src/action/... attributes (and, with `tags`, the whole text).
 *   - tags: rewrite the whole document, markup included (not only text nodes).
 *   - kind:'url': path-swap — request path `from` is fetched as `to` upstream and swapped back.
 */

// ─── small host / path helpers ──────────────────────────────────────────────

function normalizeHost(host) {
    return String(host || '').trim().replace(/\.$/, '').toLowerCase();
}

function hostOnly(value) {
    let raw = String(value || '').trim().toLowerCase();
    raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    raw = raw.split(/[/?#]/)[0];
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        return end >= 0 ? raw.slice(1, end) : raw;
    }
    const colon = raw.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) raw = raw.slice(0, colon);
    return raw.replace(/\.$/, '');
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function authority(host, port) {
    const number = Number(port || 443);
    if (!number || number === 443) return host;
    return `${host}:${number}`;
}

function pathOnly(value) {
    const p = String(value || '/').split('#')[0].split('?')[0];
    if (p === '/') return '/';
    return p.replace(/\/+$/, '') || '/';
}

function validProxyPath(value) {
    const p = String(value || '').trim().split('#')[0].split('?')[0];
    if (!p.startsWith('/') || p.length > 2000) return false;
    if (p.includes('..') || /\s/.test(p) || p.includes('<')) return false;
    return true;
}

// ─── word-aware text replacement ────────────────────────────────────────────

function isWordByte(b) {
    return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;
}

function isWordChar(ch) {
    if (!ch) return false;
    const c = ch.charCodeAt(0);
    if (isWordByte(c)) return true;
    return ch.toLowerCase() !== ch.toUpperCase();
}

/** Split HTML into text / tag (and comment) parts so word rules skip markup unless asked. */
function htmlParts(text) {
    const parts = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '<') {
            const next = text.indexOf('<', i);
            const end = next < 0 ? text.length : next;
            parts.push({ tag: false, text: text.slice(i, end) });
            i = end;
            continue;
        }
        if (text.startsWith('<!--', i)) {
            const end = text.indexOf('-->', i + 4);
            const stop = end < 0 ? text.length : end + 3;
            parts.push({ tag: true, text: text.slice(i, stop) });
            i = stop;
            continue;
        }
        let j = i + 1;
        let quote = '';
        while (j < text.length) {
            const ch = text[j];
            if (quote) {
                if (ch === quote) quote = '';
            } else if (ch === '"' || ch === '\'') quote = ch;
            else if (ch === '>') {
                j += 1;
                break;
            }
            j += 1;
        }
        parts.push({ tag: true, text: text.slice(i, j) });
        i = j;
    }
    return parts;
}

/** Find the next index of `needle` in `text` at/after `i`, honouring the folded comparison. */
function nextIndex(text, cmpText, needle, from, stable, i) {
    if (stable) return cmpText.indexOf(needle, i);
    const fold = cmpText === text ? (s) => s : (s) => s.toLowerCase();
    for (let k = i; k <= text.length - from.length; k += 1) {
        if (fold(text.slice(k, k + from.length)) === needle) return k;
    }
    return -1;
}

/** Plain substring replacement (the default word-rule mode): any occurrence, optionally case-sensitive. */
function replaceSubstring(text, from, to, caseSensitive) {
    if (!from) return { text, hits: 0 };
    const cmpText = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? from : from.toLowerCase();
    const stable = cmpText.length === text.length && needle.length === from.length;
    let out = '';
    let i = 0;
    let hits = 0;
    while (i < text.length) {
        const idx = nextIndex(text, cmpText, needle, from, stable, i);
        if (idx < 0) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, idx) + to;
        hits += 1;
        i = idx + from.length;
    }
    return { text: out, hits };
}

/** Whole-word (boundary-aware) replacement. `loose` keeps leading/trailing slashes as boundaries. */
function replaceWordsInText(text, from, to, loose, caseSensitive) {
    const cmpText = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? from : from.toLowerCase();
    const stable = cmpText.length === text.length && needle.length === from.length;
    let out = '';
    let i = 0;
    let hits = 0;
    while (i < text.length) {
        const idx = nextIndex(text, cmpText, needle, from, stable, i);
        if (idx < 0) {
            out += text.slice(i);
            break;
        }
        const end = idx + from.length;
        const prevOk = (loose && from.startsWith('/')) || idx === 0 || !isWordChar(text.charAt(idx - 1));
        const nextOk = (loose && from.endsWith('/')) || end === text.length || !isWordChar(text.charAt(end));
        if (prevOk && nextOk) {
            out += text.slice(i, idx) + to;
            hits += 1;
            i = end;
        } else {
            out += text.slice(i, idx + 1);
            i = idx + 1;
        }
    }
    return { text: out, hits };
}

function expandReplacement(template, match, groups) {
    return String(template).replace(/\$\$|\$&|\$(\d+)/g, (token, n) => {
        if (token === '$$') return '$';
        if (token === '$&') return match;
        const value = groups[Number(n) - 1];
        return value == null ? '' : String(value);
    });
}

function replaceRegex(text, pattern, replacement, caseSensitive) {
    const flags = caseSensitive ? 'gu' : 'giu';
    const fallback = caseSensitive ? 'g' : 'gi';
    let re;
    try {
        re = new RegExp(pattern, flags);
    } catch {
        try {
            re = new RegExp(pattern, fallback);
        } catch {
            return { text, hits: 0 };
        }
    }
    const probe = new RegExp(re.source, String(re.flags).replace('g', ''));
    if (probe.test('')) return { text, hits: 0 };
    let hits = 0;
    const out = String(text).replace(re, (...args) => {
        hits += 1;
        const match = args[0];
        const groups = args.slice(1, args.length - 2);
        return expandReplacement(replacement, match, groups);
    });
    return { text: out, hits };
}

function applyRuleText(text, item) {
    if (item.regex) return replaceRegex(text, item.from, item.to, item.cs);
    if (item.whole) return replaceWordsInText(text, item.from, item.to, Boolean(item.urls), item.cs);
    return replaceSubstring(text, item.from, item.to, item.cs);
}

function replaceInUrlAttrs(tag, item) {
    let hits = 0;
    const text = String(tag).replace(
        /(\s(?:href|src|action|poster|formaction|cite|data|background|srcset)\s*=\s*)(["'])([\s\S]*?)\2/gi,
        (all, pre, quote, val) => {
            const replaced = applyRuleText(val, item);
            hits += replaced.hits;
            return pre + quote + replaced.text + quote;
        }
    );
    return { text, hits };
}

/** Apply one normalized replace rule to a text buffer/string. */
function replaceWords(buf, fromBuf, toBuf, opts) {
    const flags = typeof opts === 'boolean' ? { tags: opts } : (opts || {});
    const item = {
        from: Buffer.isBuffer(fromBuf) ? fromBuf.toString('utf8') : String(fromBuf || ''),
        to: Buffer.isBuffer(toBuf) ? toBuf.toString('utf8') : String(toBuf || ''),
        tags: Boolean(flags.tags),
        regex: Boolean(flags.regex),
        urls: Boolean(flags.urls),
        whole: Boolean(flags.whole),
        cs: Boolean(flags.cs),
    };
    if (!item.from) return { body: buf, hits: 0 };
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    if (item.tags) {
        const replaced = applyRuleText(text, item);
        return { body: Buffer.from(replaced.text), hits: replaced.hits };
    }
    let hits = 0;
    const out = htmlParts(text).map((part) => {
        if (!part.tag) {
            const replaced = applyRuleText(part.text, item);
            hits += replaced.hits;
            return replaced.text;
        }
        if (!item.urls) return part.text;
        const replaced = replaceInUrlAttrs(part.text, item);
        hits += replaced.hits;
        return replaced.text;
    }).join('');
    return { body: Buffer.from(out), hits };
}

/** Apply the url-marking rules to a header value (Location / cookie Path). */
function rewriteMarked(text, rules) {
    let out = String(text || '');
    for (const item of rules || []) {
        if (item.kind === 'url' || !item.urls) continue;
        out = applyRuleText(out, item).text;
    }
    return out;
}

/** Reverse URL rewriting on the request path so a rewritten link maps back to the real upstream. */
function undoUrlPath(requestUrl, rules) {
    const raw = String(requestUrl || '/');
    const cut = raw.indexOf('?');
    let p = cut < 0 ? raw : raw.slice(0, cut);
    const query = cut < 0 ? '' : raw.slice(cut);
    const list = (rules || []).filter((item) => {
        if (!item.urls || item.kind === 'url' || !item.to) return false;
        if (!item.regex) return true;
        return !/[.*+?^${}()|[\]\\]/.test(item.from) && !String(item.to).includes('$');
    });
    for (let i = list.length - 1; i >= 0; i -= 1) {
        p = replaceWordsInText(p, list[i].to, list[i].from, true).text;
    }
    return p + query;
}

// ─── kind:'url' path-swap ────────────────────────────────────────────────────

function pathRuleFor(rules, requestUrl) {
    const current = pathOnly(requestUrl);
    for (const item of rules || []) {
        if (item.kind === 'url' && pathOnly(item.from) === current) return item;
    }
    return null;
}

function fetchPath(requestUrl, targetPath) {
    const query = String(requestUrl || '').split('?')[1] || '';
    const base = pathOnly(targetPath);
    return query ? `${base}?${query}` : base;
}

function swapPathText(text, upstreamPath, clientPath) {
    const from = pathOnly(upstreamPath);
    const to = pathOnly(clientPath);
    if (!from || !to || from === to) return text;
    const lower = text.toLowerCase();
    const needle = from.toLowerCase();
    let out = '';
    let i = 0;
    while (i < text.length) {
        const idx = lower.indexOf(needle, i);
        if (idx < 0) {
            out += text.slice(i);
            break;
        }
        const end = idx + from.length;
        const next = end >= text.length ? '' : text.charAt(end);
        const nextOk = !next || /[/?#"'\\\s<>)]/.test(next);
        const head = text.slice(Math.max(0, idx - 120), idx);
        const prevOk = idx === 0
            || /[\s"'=>(]/.test(text.charAt(idx - 1))
            || /:\/\/[^/\s]*$/.test(head);
        if (nextOk && prevOk) {
            out += text.slice(i, idx) + to;
            i = end;
        } else {
            out += text.slice(i, idx + 1);
            i = idx + 1;
        }
    }
    return out;
}

// ─── host swap (body + headers) ──────────────────────────────────────────────

function replaceLiteral(buf, from, to) {
    if (!from.length) return { body: buf, hits: 0 };
    const parts = [];
    let i = 0;
    let hits = 0;
    while (i < buf.length) {
        const idx = buf.indexOf(from, i);
        if (idx < 0) {
            parts.push(buf.subarray(i));
            break;
        }
        if (idx > i) parts.push(buf.subarray(i, idx));
        parts.push(to);
        hits += 1;
        i = idx + from.length;
    }
    return { body: Buffer.concat(parts), hits };
}

function swapHostText(value, fromHost, fromPort, toHost, toPort) {
    const from = authority(fromHost, fromPort);
    const to = authority(toHost, toPort);
    let out = String(value);
    // A site often answers Location: http://its-own-host. Without this swap the client leaves
    // HTTPS (host B) and the next request through the mirror breaks.
    out = out.split(`http://${from}`).join(`https://${to}`);
    out = out.split(`https://${from}`).join(`https://${to}`);
    out = out.split(`//${from}`).join(`//${to}`);
    return out;
}

function swapHostBuf(buf, fromHost, fromPort, toHost, toPort) {
    const from = authority(fromHost, fromPort);
    const to = authority(toHost, toPort);
    let body = buf;
    const pairs = [
        [`http://${from}`, `https://${to}`],
        [`https://${from}`, `https://${to}`],
        [`//${from}`, `//${to}`],
    ];
    for (const [source, dest] of pairs) {
        body = replaceLiteral(body, Buffer.from(source), Buffer.from(dest)).body;
    }
    return body;
}

function rewriteCookieDomain(cookie, from, to) {
    const re = new RegExp(`(^|;\\s*)domain\\s*=\\s*${escapeRegex(from)}(?=\\s*;|$)`, 'ig');
    return String(cookie).replace(re, `$1Domain=${to}`);
}

function shouldRewriteType(contentType) {
    const ct = String(contentType || '').toLowerCase();
    return ct.startsWith('text/')
        || ct.includes('application/json')
        || ct.includes('application/javascript')
        || ct.includes('application/xml')
        || ct.includes('application/xhtml')
        || ct.includes('+json')
        || ct.includes('+xml');
}

// ─── rule normalization / validation ─────────────────────────────────────────

/**
 * Sanitize a raw replace[] array into normalized rules. Bad rules are dropped unless `strict`,
 * in which case the first problem is thrown (used by validateMirrorParams for the UI).
 */
function normalizeReplaceRules(raw, strict) {
    const out = [];
    for (const rule of Array.isArray(raw) ? raw : []) {
        const from = String(rule && rule.from || '');
        const to = String(rule && rule.to || '');
        const kind = rule && rule.kind === 'url' ? 'url' : 'word';
        const tags = kind !== 'url' && Boolean(rule && rule.tags);
        const regex = kind !== 'url' && Boolean(rule && rule.regex);
        const urls = kind !== 'url' && Boolean(rule && rule.urls);
        const whole = kind !== 'url' && !regex && Boolean(rule && rule.whole);
        const cs = kind !== 'url' && Boolean(rule && rule.cs);
        if (!from || from === to) {
            if (strict) throw new Error('each replace rule needs a non-empty "from" different from "to"');
            continue;
        }
        if (regex) {
            let re;
            try {
                re = new RegExp(from, 'giu');
            } catch {
                try {
                    re = new RegExp(from, 'gi');
                } catch (err) {
                    if (strict) throw new Error(`regex for "${from}": ${err.message}`);
                    continue;
                }
            }
            re.lastIndex = 0;
            if (re.test('')) {
                if (strict) throw new Error(`regex for "${from}" matches an empty string`);
                continue;
            }
        }
        if (kind === 'url' && (!validProxyPath(from) || !validProxyPath(to))) {
            if (strict) throw new Error(`path rule must be two absolute paths: ${from} -> ${to}`);
            continue;
        }
        out.push({ from, to, kind, tags, regex, urls, whole, cs });
    }
    return out;
}

/** Validate a mirror rule's params for the UI. Returns { ok } or { ok:false, error }. */
function validateMirrorParams(params) {
    const p = params && typeof params === 'object' ? params : {};
    const upstreamHost = hostOnly(p.upstreamHost);
    if (!upstreamHost) return { ok: false, error: 'Mirror rule needs an upstream host' };
    if (!/^[a-z0-9.-]+$/.test(upstreamHost) || upstreamHost.includes('..')
        || upstreamHost.startsWith('.') || upstreamHost.endsWith('.')) {
        return { ok: false, error: `Bad upstream host: ${p.upstreamHost}` };
    }
    try {
        normalizeReplaceRules(p.replace, true);
    } catch (err) {
        return { ok: false, error: err.message };
    }
    return { ok: true };
}

/** Normalize a mirror rule's params into { upstreamHost, upstreamPort, replace }. */
function normalizeMirror(params) {
    const p = params && typeof params === 'object' ? params : {};
    const upstreamHost = hostOnly(p.upstreamHost);
    const upstreamPort = Number(p.upstreamPort) || 0;
    return { upstreamHost, upstreamPort, replace: normalizeReplaceRules(p.replace, false) };
}

// ─── public request / response rewrite ───────────────────────────────────────

/**
 * Rewrite the outbound request so the MITM worker fetches the upstream host.
 * @param {{ url?: string, clientHost?: string, clientPort?: number }} req
 * @param {object} mirror normalized mirror rule (see normalizeMirror)
 * @returns {{ url: string, host: string, port: number, path: string }|null}
 *   `null` when the rule has no upstream host (nothing to do).
 */
function rewriteRequest(req, mirror) {
    const m = mirror && mirror.upstreamHost ? mirror : normalizeMirror(mirror);
    if (!m.upstreamHost) return null;
    const clientHost = hostOnly(req.clientHost || req.url);
    const clientPort = Number(req.clientPort) || 443;
    const upstreamHost = m.upstreamHost;
    const upstreamPort = m.upstreamPort || clientPort;

    let clientPath = '/';
    let base = '';
    try {
        const u = new URL(req.url);
        clientPath = `${u.pathname || '/'}${u.search || ''}`;
        base = `${u.protocol}//`;
    } catch {
        clientPath = String(req.url || '/');
        if (!clientPath.startsWith('/')) clientPath = '/';
        base = 'https://';
    }

    const pathRule = pathRuleFor(m.replace, clientPath);
    const fetchedPath = pathRule ? fetchPath(clientPath, pathRule.to) : undoUrlPath(clientPath, m.replace);
    const url = `${base}${authority(upstreamHost, upstreamPort)}${fetchedPath}`;
    return { url, host: upstreamHost, port: upstreamPort, path: fetchedPath };
}

/**
 * Rewrite a response (body + Location + Set-Cookie) so every reference stays on the client host.
 * @param {{ statusCode?: number, headers?: object, body?: Buffer|string, contentType?: string }} res
 * @param {object} mirror normalized mirror rule
 * @param {{ clientHost: string, clientPort?: number, clientUrl?: string }} ctx
 * @returns {{ headers: object, body: Buffer, hits: number, rewrote: boolean }}
 */
function rewriteResponse(res, mirror, ctx) {
    const m = mirror && mirror.upstreamHost ? mirror : normalizeMirror(mirror);
    const clientHost = hostOnly(ctx.clientHost);
    const clientPort = Number(ctx.clientPort) || 443;
    const upstreamHost = m.upstreamHost || clientHost;
    const upstreamPort = m.upstreamPort || clientPort;
    const hostSwap = upstreamHost !== clientHost || upstreamPort !== clientPort;
    const urlRules = (m.replace || []).some((item) => item.urls);
    const clientPath = ctx.clientUrl || '/';
    const pathRule = pathRuleFor(m.replace, clientPath);

    const headers = rewriteHeaders(res.headers || {}, m, {
        clientHost, clientPort, upstreamHost, upstreamPort, hostSwap, urlRules, pathRule,
    });

    const contentType = res.contentType || headerLookup(res.headers, 'content-type');
    let body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body == null ? '' : res.body), 'utf8');
    let hits = 0;
    let rewrote = false;
    if (shouldRewriteType(contentType)) {
        for (const item of m.replace || []) {
            if (item.kind === 'url') continue;
            const replaced = replaceWords(body, item.from, item.to, item);
            body = replaced.body;
            hits += replaced.hits;
        }
        if (hostSwap) body = swapHostBuf(body, upstreamHost, upstreamPort, clientHost, clientPort);
        if (pathRule) {
            body = Buffer.from(swapPathText(body.toString('utf8'), pathRule.to, pathRule.from));
            hits += 1;
        }
        rewrote = true;
    }
    return { headers, body, hits, rewrote };
}

function headerLookup(headers, name) {
    const lower = String(name).toLowerCase();
    for (const [k, v] of Object.entries(headers || {})) {
        if (String(k).toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
    }
    return '';
}

/** Rewrite Location / Set-Cookie of a response. Returns a shallow-copied headers object. */
function rewriteHeaders(src, mirror, opt) {
    const m = mirror && mirror.upstreamHost ? mirror : normalizeMirror(mirror);
    const { clientHost, clientPort, upstreamHost, upstreamPort, hostSwap, urlRules, pathRule } = opt;
    const out = {};
    for (const [k, v] of Object.entries(src || {})) out[k] = v;
    // ETag / Content-MD5 no longer match a rewritten body.
    for (const k of Object.keys(out)) {
        const low = k.toLowerCase();
        if (low === 'etag' || low === 'content-md5') delete out[k];
    }

    const map = (value) => {
        let next = rewriteMarked(value, m.replace);
        if (pathRule) next = swapPathText(next, pathRule.to, pathRule.from);
        if (hostSwap) next = swapHostText(next, upstreamHost, upstreamPort, clientHost, clientPort);
        return next;
    };

    if (pathRule || hostSwap || urlRules) {
        for (const k of Object.keys(out)) {
            if (k.toLowerCase() !== 'location') continue;
            out[k] = Array.isArray(out[k]) ? out[k].map(map) : map(out[k]);
        }
    }

    if (hostSwap || urlRules) {
        for (const k of Object.keys(out)) {
            if (k.toLowerCase() !== 'set-cookie') continue;
            const list = Array.isArray(out[k]) ? out[k] : [out[k]];
            out[k] = list.map((cookie) => {
                let next = cookie;
                if (urlRules) {
                    next = String(next).replace(/(^|;\s*)(Path=)([^;]*)/gi, (all, lead, key, val) => (
                        lead + key + rewriteMarked(val, m.replace)
                    ));
                }
                if (hostSwap) next = rewriteCookieDomain(next, upstreamHost, clientHost);
                return next;
            });
        }
    }
    return out;
}

module.exports = {
    // high-level API used by request-interceptor.js
    normalizeMirror,
    normalizeReplaceRules,
    validateMirrorParams,
    rewriteRequest,
    rewriteResponse,
    rewriteHeaders,
    shouldRewriteType,
    // low-level helpers (exported for unit tests)
    normalizeHost,
    hostOnly,
    authority,
    htmlParts,
    replaceWords,
    replaceWordsInText,
    replaceSubstring,
    replaceRegex,
    applyRuleText,
    swapHostText,
    swapHostBuf,
    swapPathText,
    undoUrlPath,
    rewriteCookieDomain,
    replaceLiteral,
};
