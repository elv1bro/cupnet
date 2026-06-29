'use strict';

// ─── Pure utility functions (no Electron deps) ────────────────────────────────
// Exported separately so they can be unit-tested without launching Electron.

/** Preset search URL templates (`{q}` = encoded query; if absent, query is appended). */
const SEARCH_ENGINES = {
    duckduckgo: 'https://duckduckgo.com/?q=',
    google: 'https://www.google.com/search?q=',
    brave: 'https://search.brave.com/search?q=',
    yandex: 'https://yandex.com/search/?text=',
};

/** @deprecated Use SEARCH_ENGINES.duckduckgo — kept for legacy tests/imports */
const SEARCH_ENGINE = SEARCH_ENGINES.duckduckgo;

function applySearchEngineTemplate(template, query) {
    const t = String(template || '');
    const enc = encodeURIComponent(query);
    if (t.includes('{q}')) return t.split('{q}').join(enc);
    return t + enc;
}

/**
 * Normalize user-defined search URL (must contain `{q}` or gets `?q={q}` / `&q={q}`).
 * @param {string} raw
 */
function normalizeCustomSearchEngineUrl(raw) {
    let t = String(raw || '').trim();
    if (!t) return SEARCH_ENGINES.duckduckgo;
    if (t.includes('{q}')) return t;
    if (t.includes('%s')) return t.replace(/%s/g, '{q}');
    if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
    const join = t.includes('?') ? (t.endsWith('?') || t.endsWith('&') ? '' : '&') : '?';
    return `${t}${join}q={q}`;
}

/**
 * @param {{ searchEngine?: string, searchEngineCustomUrl?: string }|null|undefined} s settings slice or null
 * @returns {string} template for applySearchEngineTemplate
 */
function getSearchEngineUrlFromSettings(s) {
    if (!s || typeof s !== 'object') return SEARCH_ENGINE;
    const key = String(s.searchEngine || 'duckduckgo').toLowerCase();
    if (key === 'custom') return normalizeCustomSearchEngineUrl(s.searchEngineCustomUrl);
    return SEARCH_ENGINES[key] || SEARCH_ENGINE;
}

/**
 * Resolve raw user input (URL bar) to a full navigatable URL.
 *   "google.com"       → "https://google.com"
 *   "https://x.com"    → "https://x.com"
 *   "hello world"      → search engine URL for query
 * @param {string} input
 * @param {{ searchEngineUrl?: string }} [opts]
 */
function resolveNavigationUrl(input, opts = {}) {
    if (!input || typeof input !== 'string') return null;
    const s = input.trim();
    if (!s) return null;
    if (/^[a-z][a-z\d+\-.]*:\/\//i.test(s)) {
        try { new URL(s); return s; } catch { /* fall through */ }
    }
    if (/^[^\s]+\.[^\s]{2,}$/.test(s) && !s.includes(' ')) {
        const withProto = 'https://' + s;
        try { new URL(withProto); return withProto; } catch {}
    }
    const engine = opts.searchEngineUrl || SEARCH_ENGINE;
    return applySearchEngineTemplate(engine, s);
}

/**
 * Resolve omnibox / navigation input against the active page when input is a site-relative path.
 * @param {string} input
 * @param {string|null|undefined} baseUrl current tab URL (https://host/…)
 * @param {{ searchEngineUrl?: string }} [opts]
 * @returns {string|null}
 */
function resolveNavigationUrlWithBase(input, baseUrl, opts = {}) {
    if (!input || typeof input !== 'string') return null;
    const s = input.trim();
    if (!s) return null;
    if (/^[a-z][a-z\d+\-.]*:\/\//i.test(s)) {
        return resolveNavigationUrl(s, opts);
    }
    const base = String(baseUrl || '').trim();
    if (s.startsWith('/') && base && !base.startsWith('file:') && !base.startsWith('about:')) {
        try {
            const abs = new URL(s, base).href;
            new URL(abs);
            return abs;
        } catch { /* fall through to search / domain heuristics */ }
    }
    return resolveNavigationUrl(s, opts);
}

/**
 * Parse a proxy template string, replacing:
 *   {RAND:min-max}  → random integer in [min, max]
 *   {VARNAME}       → value from vars object (case-insensitive)
 *   {SID}           → "cupnet" + 10 random digits (default)
 */
function parseProxyTemplate(template, vars = {}, resolvedOut) {
    let result = template.replace(/\{RAND:(\d+)-(\d+)\}/gi, (_, mn, mx) => {
        const min = parseInt(mn, 10), max = parseInt(mx, 10);
        const val = String(Math.floor(Math.random() * (max - min + 1)) + min);
        if (resolvedOut) resolvedOut['RAND'] = val;
        return val;
    });
    result = result.replace(/\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name) => {
        const key = Object.keys(vars).find(k => k.toUpperCase() === name.toUpperCase());
        if (key !== undefined && vars[key] !== undefined && vars[key] !== '') {
            const val = String(vars[key]);
            if (resolvedOut) resolvedOut[name.toUpperCase()] = val;
            return val;
        }
        if (name.toUpperCase() === 'SID') {
            const val = 'cupnet' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
            if (resolvedOut) resolvedOut['SID'] = val;
            return val;
        }
        return match;
    });
    return result;
}

/** Extract variable names from a proxy template (excludes RAND). */
function extractTemplateVars(template) {
    const vars = new Set();
    for (const m of template.matchAll(/\{([A-Z_][A-Z0-9_]*)\}/gi)) {
        vars.add(m[1].toUpperCase());
    }
    // Remove RAND:{min}-{max} entries
    for (const m of template.matchAll(/\{RAND:\d+-\d+\}/gi)) {
        vars.delete(m[0].slice(1, -1).toUpperCase());
    }
    return [...vars];
}

/** Human-readable byte size string. */
function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024, sz = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sz[i];
}

// Cache compiled filter patterns — recompile only when the array reference changes
let _lastFilterPatterns = null;
let _compiledFilters    = [];

/**
 * Returns true if `url` should be hidden from the network log.
 * file:// URLs are always hidden; other URLs matched against glob patterns (* = wildcard).
 */
function shouldFilterUrl(url, patterns) {
    if (url && url.startsWith('file://')) return true;
    if (!patterns || !patterns.length) return false;
    if (patterns !== _lastFilterPatterns) {
        _lastFilterPatterns = patterns;
        _compiledFilters = patterns.map(p =>
            new RegExp(p.replace(/\./g, '\\.').replace(/\*/g, '.*'), 'i')
        );
    }
    for (const rx of _compiledFilters) { if (rx.test(url)) return true; }
    return false;
}

/**
 * Remove HTTP/2 pseudo-headers from a header map.
 * Chromium/CDP often stores :authority, :method, :path, :scheme in captured requests;
 * Go net/http rejects field names starting with ':'.
 */
function sanitizeOutgoingRequestHeaders(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (const [k, v] of Object.entries(headers)) {
        if (k == null || v == null) continue;
        const name = String(k).trim();
        if (!name || name.startsWith(':')) continue;
        out[k] = v;
    }
    return out;
}

/**
 * True when the user typed an origin only (scheme + host[:port] + optional `/`).
 * Inline history ghost must not extend these into deeper paths.
 * @param {string} trimmed
 * @returns {boolean}
 */
function shouldSkipOmniboxInlineGhost(trimmed) {
    const t = String(trimmed || '').trim();
    if (!t) return true;
    return /^https?:\/\/[^/?#]+\/?$/i.test(t);
}

module.exports = {
    resolveNavigationUrl,
    resolveNavigationUrlWithBase,
    parseProxyTemplate,
    extractTemplateVars,
    formatBytes,
    shouldFilterUrl,
    sanitizeOutgoingRequestHeaders,
    shouldSkipOmniboxInlineGhost,
    SEARCH_ENGINE,
    SEARCH_ENGINES,
    applySearchEngineTemplate,
    getSearchEngineUrlFromSettings,
    normalizeCustomSearchEngineUrl,
};
