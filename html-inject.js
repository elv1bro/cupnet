'use strict';

/**
 * Inject CupNet scripts into HTML document responses on the MITM path (intercept rule type `inject`).
 *
 * Works on raw bytes: the body is read as latin1 (byte-preserving), edited with ASCII-only text and
 * written back as latin1, so any ASCII-compatible page charset (utf-8, windows-1251, …) survives
 * untouched. Script sources are escaped to ASCII (\uXXXX) for the same reason.
 *
 * CSP: an inline <script> needs permission. The tag carries a fresh nonce and the effective
 * script directive (header and <meta http-equiv>) is patched so that nonce is allowed — without
 * breaking the page's own inline scripts (adding a nonce to a policy that relies on 'unsafe-inline'
 * would switch 'unsafe-inline' off, so such policies are left as they are).
 */

const crypto = require('crypto');
const zlib = require('zlib');

const HTML_CT_RE = /^\s*(text\/html|application\/xhtml\+xml)\b/i;
/** Fetch destinations that are HTML documents (navigations and frames). */
const DOCUMENT_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);
const MAX_INJECT_BODY_BYTES = 16 * 1024 * 1024;

function _headerKey(headers, name) {
    const lower = name.toLowerCase();
    return Object.keys(headers || {}).find((k) => k.toLowerCase() === lower);
}

function _headerVal(headers, name) {
    const k = _headerKey(headers, name);
    if (!k) return '';
    const v = headers[k];
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}

/**
 * True when the request is a document load (worth buffering the response to inject into).
 * Uses Sec-Fetch-Dest when present (every current Chromium sends it); otherwise falls back to Accept.
 */
function isDocumentRequest(method, headers) {
    if (!/^GET$/i.test(String(method || 'GET'))) return false;
    const dest = _headerVal(headers, 'sec-fetch-dest').trim().toLowerCase();
    if (dest) return DOCUMENT_DESTS.has(dest);
    return /\btext\/html\b/i.test(_headerVal(headers, 'accept'));
}

/** Escape a script source so it is plain ASCII and cannot close the surrounding <script>. */
function escapeScriptSource(src) {
    return String(src || '')
        .replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .replace(/<\/(script)/gi, '<\\/$1')
        .replace(/<!--/g, '<\\!--');
}

const NONCE_OR_HASH_RE = /^'(nonce-|sha256-|sha384-|sha512-)/i;

/**
 * Allow `nonce` in one CSP policy string (one header value). Returns the policy unchanged when
 * inline scripts are already allowed or when no directive restricts scripts.
 */
function patchCspPolicy(policy, nonce) {
    const directives = String(policy || '').split(';').map((p) => p.trim().split(/\s+/).filter(Boolean));
    const find = (name) => directives.findIndex((d) => d[0] && d[0].toLowerCase() === name);
    // Inline <script> elements: script-src-elem, else script-src, else default-src.
    const targets = [];
    const elem = find('script-src-elem');
    const script = find('script-src');
    if (elem >= 0) targets.push(elem);
    if (script >= 0) targets.push(script);
    if (!targets.length) {
        const def = find('default-src');
        if (def >= 0) targets.push(def);
    }
    let changed = false;
    for (const i of targets) {
        const d = directives[i];
        const sources = d.slice(1);
        const hasNonceOrHash = sources.some((s) => NONCE_OR_HASH_RE.test(s));
        const unsafeInline = sources.some((s) => s.toLowerCase() === "'unsafe-inline'");
        if (unsafeInline && !hasNonceOrHash) continue; // inline already allowed
        const kept = sources.filter((s) => s.toLowerCase() !== "'none'");
        directives[i] = [d[0], ...kept, `'nonce-${nonce}'`];
        changed = true;
    }
    if (!changed) return policy;
    return directives.filter((d) => d.length).map((d) => d.join(' ')).join('; ');
}

function _patchCspHeaders(headers, nonce) {
    const out = { ...headers };
    for (const k of Object.keys(out)) {
        if (k.toLowerCase() !== 'content-security-policy') continue;
        const v = out[k];
        out[k] = Array.isArray(v) ? v.map((p) => patchCspPolicy(p, nonce)) : patchCspPolicy(v, nonce);
    }
    return out;
}

const META_CSP_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
const CONTENT_ATTR_RE = /(\bcontent\s*=\s*)(["'])([\s\S]*?)\2/i;

function _patchMetaCsp(html, nonce) {
    return html.replace(META_CSP_RE, (tag) => tag.replace(CONTENT_ATTR_RE, (m, pre, q, val) => {
        // CSP keywords use single quotes; inside a '…' attribute they arrive entity-encoded.
        const decoded = val.replace(/&#39;|&apos;/g, "'");
        let patched = patchCspPolicy(decoded, nonce);
        if (patched === decoded) return m;
        if (q === "'") patched = patched.replace(/'/g, '&#39;');
        return `${pre}${q}${patched}${q}`;
    }));
}

/** Offset where scripts go: after <head>, else after <html>, else after the doctype, else 0. */
function _insertionIndex(html, position) {
    if (position === 'body-end') {
        const i = html.search(/<\/body\s*>/i);
        if (i >= 0) return i;
        const j = html.search(/<\/html\s*>/i);
        return j >= 0 ? j : html.length;
    }
    for (const re of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
        const m = re.exec(html);
        if (m) return m.index + m[0].length;
    }
    return 0;
}

const KNOWN_ENCODINGS = new Set(['', 'identity', 'gzip', 'x-gzip', 'deflate', 'br', 'zstd']);

function _decodeBody(buf, encoding) {
    const enc = String(encoding || '').trim().toLowerCase();
    if (!enc || enc === 'identity') return buf;
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') {
        try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf);
    return null; // unknown encoding — leave the response alone
}

/**
 * Inject `scripts` into an HTML response. Non-HTML, empty, non-2xx, streamed or undecodable
 * responses are returned unchanged.
 * @param {{ statusCode:number, headers:object, bodyBase64:string }} res
 * @param {Array<{ source:string, position?:'head'|'body-end', name?:string }>} scripts
 * @param {{ bodyDecoded?: boolean }} [opts] - bodyDecoded: the body is already decompressed and a
 *   Content-Encoding header is stale (the MITM buffered path: AzureTLS decodes known encodings);
 *   only an unknown encoding then still means "leave alone".
 * @returns {object} response (a new object when modified)
 */
function injectScriptsIntoHtmlResponse(res, scripts, opts = {}) {
    if (!res || res.stream || !Array.isArray(scripts) || !scripts.length) return res;
    const status = Number(res.statusCode) || 0;
    if (status < 200 || status >= 300 || status === 204) return res;
    const headers = res.headers || {};
    if (!HTML_CT_RE.test(_headerVal(headers, 'content-type'))) return res;
    if (!res.bodyBase64) return res;
    let body = Buffer.from(res.bodyBase64, 'base64');
    if (!body.length || body.length > MAX_INJECT_BODY_BYTES) return res;
    const encKey = _headerKey(headers, 'content-encoding');
    if (encKey && opts.bodyDecoded) {
        if (!KNOWN_ENCODINGS.has(String(headers[encKey] || '').trim().toLowerCase())) return res;
    } else if (encKey) {
        let decoded = null;
        try { decoded = _decodeBody(body, headers[encKey]); } catch { decoded = null; }
        if (!decoded) return res;
        body = decoded;
    }

    const nonce = crypto.randomBytes(16).toString('base64');
    let html = _patchMetaCsp(body.toString('latin1'), nonce);

    const byPos = { head: [], 'body-end': [] };
    for (const s of scripts) {
        if (!s || !String(s.source || '').trim()) continue;
        const pos = s.position === 'body-end' ? 'body-end' : 'head';
        const label = s.name ? ` data-cupnet-rule="${String(s.name).replace(/[^\w .-]/g, '_').slice(0, 80)}"` : '';
        byPos[pos].push(`<script nonce="${nonce}" data-cupnet${label}>${escapeScriptSource(s.source)}</script>`);
    }
    if (!byPos.head.length && !byPos['body-end'].length) return res;
    // Insert at the later position first so the earlier offset stays valid.
    for (const pos of ['body-end', 'head']) {
        if (!byPos[pos].length) continue;
        const at = _insertionIndex(html, pos);
        html = html.slice(0, at) + byPos[pos].join('') + html.slice(at);
    }

    const outHeaders = _patchCspHeaders(headers, nonce);
    for (const k of Object.keys(outHeaders)) {
        const lower = k.toLowerCase();
        // The body is now plain and a different length; validators for the old bytes no longer match.
        if (lower === 'content-encoding' || lower === 'content-length' || lower === 'etag' || lower === 'content-md5') {
            delete outHeaders[k];
        }
    }
    return { ...res, headers: outHeaders, bodyBase64: Buffer.from(html, 'latin1').toString('base64') };
}

module.exports = {
    isDocumentRequest,
    escapeScriptSource,
    patchCspPolicy,
    injectScriptsIntoHtmlResponse,
};
