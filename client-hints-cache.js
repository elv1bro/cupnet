'use strict';

/**
 * Accept-CH / Critical-CH support for the MITM identity layer.
 *
 * Real Chrome sends only the three low-entropy UA client hints by default and adds high-entropy
 * ones (full version list, platform version, arch, bitness, model, …) to an origin only after that
 * origin asked for them with an `Accept-CH` response header on a top-level navigation. `Critical-CH`
 * makes the browser retry the navigation at once with the requested hints. A client that claims
 * Chrome via `sec-ch-ua` but ignores Accept-CH is an easy bot signal, so the MITM mirrors Chrome:
 *   - remember per origin which UA hints were requested (navigation responses only);
 *   - add those hints to later requests to that origin (identity-headers.js `requestedHints`);
 *   - retry a navigation once when `Critical-CH` names hints that were not on the request.
 *
 * Pure module, no Electron. Unit tests: tests/unit/client-hints-cache.test.mjs
 */

/** UA client hints the identity layer can provide (lower-case header names). */
const SUPPORTED_UA_HINTS = new Set([
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model',
    'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors',
]);
/** Sent on every secure request regardless of Accept-CH. */
const LOW_ENTROPY_UA_HINTS = new Set(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);

const MAX_ORIGINS = 500;

/**
 * Parse an Accept-CH / Critical-CH header value into the supported high-entropy UA hint names.
 * Unknown tokens (viewport-width, downlink, …) are ignored.
 * @param {string|string[]|null|undefined} value
 * @returns {string[]} lower-case header names, deduplicated, in header order
 */
function parseAcceptCh(value) {
    const raw = Array.isArray(value) ? value.join(',') : String(value || '');
    const out = [];
    for (const tok of raw.split(',')) {
        const name = tok.trim().toLowerCase();
        if (!name) continue;
        if (!SUPPORTED_UA_HINTS.has(name) || LOW_ENTROPY_UA_HINTS.has(name)) continue;
        if (!out.includes(name)) out.push(name);
    }
    return out;
}

function originOf(url) {
    try {
        const u = new URL(String(url || ''));
        if (u.protocol !== 'https:' && u.protocol !== 'wss:') return null;
        return `${u.protocol}//${u.host}`;
    } catch {
        return null;
    }
}

/** Case-insensitive header lookup on a plain object (worker responses use canonical case). */
function headerValue(headers, name) {
    if (!headers || typeof headers !== 'object') return null;
    const want = String(name).toLowerCase();
    for (const k of Object.keys(headers)) {
        if (String(k).toLowerCase() === want) {
            const v = headers[k];
            return Array.isArray(v) ? v.join(', ') : (v == null ? null : String(v));
        }
    }
    return null;
}

/** True for top-level navigations (the only responses whose Accept-CH Chrome honours). */
function isNavigationRequest(reqHeaders) {
    const mode = headerValue(reqHeaders, 'sec-fetch-mode');
    const dest = headerValue(reqHeaders, 'sec-fetch-dest');
    return String(mode || '').toLowerCase() === 'navigate' && (dest == null || String(dest).toLowerCase() === 'document' || String(dest).toLowerCase() === 'iframe');
}

class ClientHintsCache {
    constructor() {
        /** @type {Map<string, Set<string>>} origin → requested high-entropy hints */
        this._byOrigin = new Map();
    }

    /** Remember the hints an origin asked for (Chrome replaces the set with the latest header). */
    remember(url, hintNames) {
        const origin = originOf(url);
        if (!origin) return null;
        const names = (hintNames || []).filter((n) => SUPPORTED_UA_HINTS.has(n) && !LOW_ENTROPY_UA_HINTS.has(n));
        if (!names.length) {
            this._byOrigin.delete(origin);
            return null;
        }
        this._byOrigin.delete(origin);
        this._byOrigin.set(origin, new Set(names));
        while (this._byOrigin.size > MAX_ORIGINS) {
            const oldest = this._byOrigin.keys().next().value;
            this._byOrigin.delete(oldest);
        }
        return this._byOrigin.get(origin);
    }

    /** Hints requested by the origin of `url` (empty array when none). */
    requestedFor(url) {
        const origin = originOf(url);
        if (!origin) return [];
        const set = this._byOrigin.get(origin);
        return set ? [...set] : [];
    }

    /**
     * Process a response: store Accept-CH (navigations only) and tell the caller whether a
     * Critical-CH retry is needed.
     * @returns {{ accepted: string[], critical: string[], retryWith: string[] }}
     */
    observeResponse(url, reqHeaders, resHeaders) {
        const empty = { accepted: [], critical: [], retryWith: [] };
        if (!isNavigationRequest(reqHeaders)) return empty;
        const accepted = parseAcceptCh(headerValue(resHeaders, 'accept-ch'));
        const critical = parseAcceptCh(headerValue(resHeaders, 'critical-ch'));
        if (accepted.length) this.remember(url, accepted);
        // Critical-CH is honoured only for hints that were also accepted (per spec) and not yet sent.
        const acceptedSet = new Set(accepted.length ? accepted : this.requestedFor(url));
        const retryWith = critical.filter((n) => acceptedSet.has(n) && headerValue(reqHeaders, n) == null);
        return { accepted, critical, retryWith };
    }

    clear() {
        this._byOrigin.clear();
    }

    get size() {
        return this._byOrigin.size;
    }
}

module.exports = { ClientHintsCache, parseAcceptCh, originOf, headerValue, isNavigationRequest, SUPPORTED_UA_HINTS, LOW_ENTROPY_UA_HINTS };
