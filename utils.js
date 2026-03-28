'use strict';

// ─── Pure utility functions (no Electron deps) ────────────────────────────────
// Exported separately so they can be unit-tested without launching Electron.

const SEARCH_ENGINE = 'https://duckduckgo.com/?q=';

/**
 * Resolve raw user input (URL bar) to a full navigatable URL.
 *   "google.com"       → "https://google.com"
 *   "https://x.com"    → "https://x.com"
 *   "hello world"      → "https://duckduckgo.com/?q=hello+world"
 */
function resolveNavigationUrl(input) {
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
    return SEARCH_ENGINE + encodeURIComponent(s);
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
        if (k == null || v === undefined) continue;
        const name = String(k).trim();
        if (!name || name.startsWith(':')) continue;
        out[k] = v;
    }
    return out;
}

module.exports = {
    resolveNavigationUrl,
    parseProxyTemplate,
    extractTemplateVars,
    formatBytes,
    shouldFilterUrl,
    sanitizeOutgoingRequestHeaders,
    SEARCH_ENGINE,
};
