'use strict';

// ─── Pure utility functions (no Electron deps) ────────────────────────────────
// Exported separately so they can be unit-tested without launching Electron.

const { classifyOmniboxInput } = require('./omnibox-input.js');

/** Preset search URL templates (`{q}` = encoded query; if absent, query is appended). */
const SEARCH_ENGINES = {
    duckduckgo: 'https://duckduckgo.com/?q=',
    google: 'https://www.google.com/search?q=',
    brave: 'https://search.brave.com/search?q=',
    yandex: 'https://yandex.com/search/?text=',
    bing: 'https://www.bing.com/search?q=',
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
    // Shared classifier (omnibox-input.js): scheme URLs, localhost/host:port/IP/intranet → http,
    // word.tld → https, everything else → search.
    const c = classifyOmniboxInput(s);
    if (c.kind === 'url') return c.url;
    if (c.kind === 'internal') return s;
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

/** True when string is safe for Electron webContents.loadURL (not a bare site-relative path). */
function isWebContentsLoadUrl(target) {
    const s = String(target || '').trim();
    if (!s || s === 'about:blank') return true;
    return /^https?:\/\//i.test(s) || /^file:\/\//i.test(s);
}

/**
 * Resolve navigation target for webContents.loadURL — never returns bare `/path` (Electron rejects those).
 * @param {string} rawUrl
 * @param {string|null|undefined} baseUrl
 * @param {{ searchEngineUrl?: string, cupnetAliases?: Record<string, string> }} [opts]
 * @returns {string|null}
 */
/**
 * Resolve a redirect Location header value against the request URL.
 * Proxied Chromium can fail when upstream returns a site-relative Location (e.g. BLS /Global/Account/LogIn).
 * @param {string} location
 * @param {string} requestUrl
 * @returns {string}
 */
function preventRedirectSchemeDowngrade(resolved, requestUrl) {
    if (!resolved || !requestUrl) return resolved;
    try {
        const req = new URL(String(requestUrl));
        const red = new URL(String(resolved));
        if (req.protocol !== 'https:' || red.protocol !== 'http:') return resolved;
        if (req.hostname.toLowerCase() !== red.hostname.toLowerCase()) return resolved;
        red.protocol = 'https:';
        if (red.port === '80') red.port = '';
        return red.href;
    } catch {
        return resolved;
    }
}

function resolveRedirectLocationHeader(location, requestUrl) {
    const loc = String(location ?? '').trim();
    if (!loc) return loc;

    let resolved = loc;
    if (/^https?:\/\//i.test(loc)) {
        resolved = loc;
    } else if (loc.startsWith('//')) {
        try {
            const base = new URL(String(requestUrl || ''));
            resolved = `${base.protocol}${loc}`;
        } catch {
            return loc;
        }
    } else {
        try {
            resolved = new URL(loc, requestUrl).href;
        } catch {
            return loc;
        }
    }
    return preventRedirectSchemeDowngrade(resolved, requestUrl);
}

/**
 * Make 3xx MITM responses safe for Chromium: absolutize relative Location headers.
 * @param {{ statusCode?: number, headers?: Record<string, string|string[]>, [k: string]: unknown }} res
 * @param {string} requestUrl
 */
function absolutizeMitmRedirectResponse(res, requestUrl) {
    const code = Number(res?.statusCode);
    if (!res || !requestUrl || !Number.isFinite(code) || code < 300 || code >= 400) return res;
    const headers = res.headers || {};
    let changed = false;
    const nextHeaders = { ...headers };
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== 'location') continue;
        const raw = headers[key];
        if (Array.isArray(raw)) {
            const mapped = raw.map((v) => resolveRedirectLocationHeader(v, requestUrl));
            if (mapped.some((v, i) => v !== raw[i])) {
                nextHeaders[key] = mapped;
                changed = true;
            }
        } else {
            const mapped = resolveRedirectLocationHeader(raw, requestUrl);
            if (mapped !== raw) {
                nextHeaders[key] = mapped;
                changed = true;
            }
        }
    }
    return changed ? { ...res, headers: nextHeaders } : res;
}

function resolveLoadUrlForWebContents(rawUrl, baseUrl, opts = {}) {
    const s = String(rawUrl || '').trim();
    if (!s || s === 'about:blank') return s;
    if (/^https?:\/\//i.test(s)) {
        try {
            new URL(s);
            return s;
        } catch {
            return null;
        }
    }
    if (/^file:\/\//i.test(s)) return s;

    const aliases = opts.cupnetAliases || {};
    const aliasKey = s.toLowerCase();
    if (aliases[aliasKey]) return aliases[aliasKey];

    let resolved = resolveNavigationUrlWithBase(s, baseUrl, opts);
    if (resolved && isWebContentsLoadUrl(resolved)) return resolved;

    const base = String(baseUrl || '').trim();
    if (s.startsWith('/') && base && /^https?:\/\//i.test(base) && !base.startsWith('about:')) {
        try {
            const abs = new URL(s, base).href;
            new URL(abs);
            return abs;
        } catch { /* ignore */ }
    }

    if (resolved && !isWebContentsLoadUrl(resolved)) return null;
    return resolved;
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
    isWebContentsLoadUrl,
    resolveLoadUrlForWebContents,
    resolveRedirectLocationHeader,
    absolutizeMitmRedirectResponse,
    parseProxyTemplate,
    extractTemplateVars,
    formatBytes,
    shouldFilterUrl,
    sanitizeOutgoingRequestHeaders,
    shouldSkipOmniboxInlineGhost,
    classifyOmniboxInput,
    SEARCH_ENGINE,
    SEARCH_ENGINES,
    applySearchEngineTemplate,
    getSearchEngineUrlFromSettings,
    normalizeCustomSearchEngineUrl,
};
