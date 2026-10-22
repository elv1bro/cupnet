'use strict';

/**
 * Offline page snapshot (CupNet mini): rebuilds a logged HTML document from the session log alone.
 * Stylesheets are inlined, images / fonts / CSS url()s become data: URLs from responses that were
 * already captured. Nothing is fetched — resources that were never requested stay missing.
 *
 * Scripts, <base>, meta refresh and frames are dropped. The UI renders the result in a sandboxed
 * frame (no scripts, opaque origin), and the snapshot carries its own CSP that allows data: and
 * inline styles only, so the page cannot reach the network or this origin.
 */

const { decodeEntities } = require('./site-map');

/** Per-resource and total limits for inlined data (the snapshot travels as one JSON string). */
const ASSET_MAX = 3 * 1024 * 1024;
const TOTAL_MAX = 24 * 1024 * 1024;
const CSS_DEPTH = 3;
const MISSING_LIST = 60;

const SNAPSHOT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:";
const HEAD = `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}">`
    + '<style>a[href],area{pointer-events:none!important}</style>';

const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function _key(raw, base) {
    try {
        const u = new URL(String(raw).trim(), base);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        u.hash = '';
        return u.href;
    } catch { return ''; }
}

function _hdr(h, name) {
    if (!h) return '';
    const k = Object.keys(h).find((x) => x.toLowerCase() === name);
    const v = k ? h[k] : '';
    return String(Array.isArray(v) ? v[0] : v || '');
}

function _bodyBuf(e) {
    const b = e?.responseBody;
    if (b == null) return null;
    const s = String(b);
    if (s.startsWith('__b64__:')) {
        try { return Buffer.from(s.slice(8), 'base64'); } catch { return null; }
    }
    return Buffer.from(s, 'utf8');
}

/** Text of a body, decoded by the charset of the response (or of a <meta charset> for HTML). */
function _text(buf, ct, sniffMeta) {
    let cs = (/charset\s*=\s*["']?([\w-]+)/i.exec(ct) || [])[1];
    if (!cs && sniffMeta) cs = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
    try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

const _escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * @param {{ list: Function, get: Function }} src  SessionLog or SessionIndex
 * @param {number} seq  the logged document
 * @returns {{ html: string, url: string, seq: number, status: number, ts: number, stats: object, missing: string[] }}
 */
function buildSnapshot(src, seq) {
    const page = src.get(Number(seq));
    if (!page || page.kind !== 'request') throw new Error('no such request');
    const buf = _bodyBuf(page);
    const ct = _hdr(page.responseHeaders, 'content-type') || page.mime || '';
    if (!buf || !buf.length) throw new Error('No HTML body was captured for this request');
    if (ct && !/html|xml/i.test(ct)) throw new Error(`Not an HTML document (${ct.split(';')[0]})`);

    // Captured responses by URL: the latest one at or before the page, else the first one after it.
    const byUrl = new Map();
    for (let after = 0; ;) {
        const batch = src.list(after, 5000);
        if (!batch.length) break;
        for (const s of batch) {
            after = s.seq;
            if (s.kind !== 'request' || !s.url || !(s.status >= 200 && s.status < 300) || s.seq === page.seq) continue;
            const k = _key(s.url);
            if (k && (s.seq <= page.seq || !byUrl.has(k))) byUrl.set(k, s);
        }
    }

    const stats = { styles: 0, images: 0, fonts: 0, other: 0, missing: 0, skipped: 0, scripts: 0, frames: 0, bytes: 0 };
    const missing = [];
    const cache = new Map();
    const miss = (u) => { stats.missing++; if (missing.length < MISSING_LIST && !missing.includes(u)) missing.push(u); };
    /** Captured resource → { buf, mime, entry } | null */
    const fetchCaptured = (url) => {
        if (cache.has(url)) return cache.get(url);
        const s = byUrl.get(url);
        let r = null;
        if (s) {
            const full = src.get(s.seq);
            const b = full && _bodyBuf(full);
            if (b && b.length) r = { buf: b, mime: (_hdr(full.responseHeaders, 'content-type') || s.mime || 'application/octet-stream').split(';')[0].trim().toLowerCase(), headers: full.responseHeaders };
        }
        cache.set(url, r);
        return r;
    };
    const dataUri = (raw, base, kind) => {
        const t = String(raw || '').trim();
        if (!t || /^data:/i.test(t)) return t;
        if (/^(#|about:|javascript:|blob:)/i.test(t)) return '';
        const url = _key(t, base);
        if (!url) return '';
        const r = fetchCaptured(url);
        if (!r) { miss(url); return ''; }
        if (r.buf.length > ASSET_MAX || stats.bytes + r.buf.length > TOTAL_MAX) { stats.skipped++; return ''; }
        stats.bytes += r.buf.length;
        stats[kind || (/^font\/|woff|truetype|opentype/.test(r.mime) ? 'fonts' : /^image\//.test(r.mime) ? 'images' : 'other')]++;
        return `data:${r.mime};base64,${r.buf.toString('base64')}`;
    };

    const css = (text, base, depth = 0) => {
        let out = String(text);
        out = out.replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?([^;]*);/gi, (m, q, href) => {
            const url = _key(href, base);
            if (!url || depth >= CSS_DEPTH) return '';
            const r = fetchCaptured(url);
            if (!r) { miss(url); return ''; }
            stats.styles++;
            return css(_text(r.buf, _hdr(r.headers, 'content-type')), url, depth + 1);
        });
        return out.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, q, ref) => {
            if (/^data:/i.test(ref.trim())) return m;
            const d = dataUri(ref, base);
            return d ? `url("${d}")` : 'url("data:,")';
        });
    };

    let html = _text(buf, ct, true);
    const docUrl = page.url;
    const baseTag = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
    const base = (baseTag && _key(decodeEntities(baseTag[1] ?? baseTag[2] ?? baseTag[3]), docUrl)) || docUrl;
    const attrs = (src0) => {
        const a = [];
        ATTR_RE.lastIndex = 0;
        let m;
        while ((m = ATTR_RE.exec(src0))) a.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4], m[1]]);
        return a;
    };
    const tag = (name, list, selfClose) => `<${name}${list.map(([, v, n]) => (v == null ? ` ${n}` : ` ${n}="${_escAttr(v)}"`)).join('')}${selfClose ? ' /' : ''}>`;

    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, () => { stats.scripts++; return ''; })
        .replace(/<script\b[^>]*\/>/gi, () => { stats.scripts++; return ''; })
        .replace(/<base\b[^>]*>/gi, '')
        .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:refresh|content-security-policy)[^>]*>/gi, '');

    // <style> blocks
    html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, a, body, z) => a + css(body, base) + z);

    // <link rel=stylesheet> → <style>; every other <link> goes
    html = html.replace(/<link\b([^>]*)>/gi, (m, inner) => {
        const a = Object.fromEntries(attrs(inner).map(([k, v]) => [k, decodeEntities(v ?? '')]));
        if (!/\bstylesheet\b/i.test(a.rel || '') || !a.href) return '';
        const url = _key(a.href, base);
        const r = url && fetchCaptured(url);
        if (!r) { if (url) miss(url); return ''; }
        stats.styles++;
        const media = a.media && a.media !== 'all' ? ` media="${_escAttr(a.media)}"` : '';
        return `<style${media}>${css(_text(r.buf, _hdr(r.headers, 'content-type')), url).replace(/<\/style/gi, '<\\/style')}</style>`;
    });

    // Frames → placeholder
    html = html.replace(/<(iframe|frame|embed|object)\b([^>]*)>/gi, (m, name, inner) => {
        stats.frames++;
        const a = Object.fromEntries(attrs(inner).map(([k, v]) => [k, decodeEntities(v ?? '')]));
        const where = a.src || a.data || '';
        return `<div style="display:inline-block;box-sizing:border-box;max-width:100%;padding:6px 10px;border:1px dashed #8b949e;color:#8b949e;font:12px sans-serif;${a.width ? `width:${/^\d+$/.test(a.width) ? `${a.width}px` : _escAttr(a.width)};` : ''}">${name.toLowerCase()}${where ? ` · ${_escAttr(where.slice(0, 200))}` : ''}</div>`;
    });

    // Media: src / srcset / poster / data-src
    html = html.replace(/<(img|source|video|audio|input|track|image)\b([^>]*?)(\/?)>/gi, (m, name, inner, sc) => {
        const list = attrs(inner);
        const get = (k) => list.find((x) => x[0] === k);
        const lazy = get('data-src') || get('data-lazy-src') || get('data-original');
        const out = [];
        let gotSrc = false;
        for (const it of list) {
            const [k, v] = it;
            if (k === 'src' || k === 'poster' || k === 'href' || k === 'xlink:href') {
                if (name.toLowerCase() === 'input' && k === 'src' && !/image/i.test(get('type')?.[1] || '')) { out.push(it); continue; }
                const d = dataUri(decodeEntities(v ?? ''), base, k === 'poster' || /img|image|input/i.test(name) ? 'images' : undefined);
                if (d) { out.push([k, d, it[2]]); if (k === 'src') gotSrc = true; }
                continue;
            }
            if (k === 'srcset' || k === 'data-srcset') {
                const parts = decodeEntities(v ?? '').split(/,\s+(?=\S)/).map((c) => {
                    const [u, ...desc] = c.trim().split(/\s+/);
                    const d = dataUri(u, base, 'images');
                    return d ? [d, ...desc].join(' ') : '';
                }).filter(Boolean);
                if (parts.length) out.push(['srcset', parts.join(', '), 'srcset']);
                continue;
            }
            if (k === 'loading') continue;
            out.push(it);
        }
        if (!gotSrc && lazy && /img/i.test(name)) {
            const d = dataUri(decodeEntities(lazy[1] ?? ''), base, 'images');
            if (d) out.push(['src', d, 'src']);
        }
        return tag(name, out, !!sc);
    });

    // style="" attributes
    html = html.replace(/(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, d, s) => {
        const v = decodeEntities(d ?? s);
        if (!/url\(/i.test(v)) return m;
        return `${pre}"${_escAttr(css(v, base))}"`;
    });

    const dt = /^\s*(<!doctype[^>]*>)/i.exec(html);
    html = dt ? `${dt[1]}${HEAD}${html.slice(dt[0].length)}` : `${HEAD}${html}`;
    return { html, url: docUrl, seq: page.seq, status: page.status, ts: page.ts, stats, missing };
}

module.exports = { buildSnapshot, SNAPSHOT_CSP };
