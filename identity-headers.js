'use strict';

/**
 * Outbound header rewrite for the active browser identity (MITM path).
 *
 * Applies to the request right before it goes to the AzureTLS worker / raw WebSocket tunnel:
 *   - `User-Agent` → identity UA;
 *   - Chromium-family identity: every `sec-ch-ua*` header Chromium sent is rewritten to describe
 *     the claimed browser (never adds hints the page did not ask for);
 *   - non-Chromium identity (Firefox / Safari / iOS): all `sec-ch-ua*` headers are removed;
 *   - `Accept-Language` → identity language (only when the header is present).
 * Header order is preserved by editing `orderedHeaders` in place.
 *
 * No identity (or one without a User-Agent) keeps the legacy sanitize-only behaviour from
 * user-agent-utils.js. identity-service turns engine mode into an "engine wire identity" (sanitized
 * engine UA + the real engine's 2-brand Chromium hints) so the wire matches navigator.userAgentData.
 *
 * Unit tests: tests/unit/identity-headers.test.mjs
 */

const { applyOutboundUserAgentToMitmHeaders } = require('./user-agent-utils');
const { buildClientHintHeaders } = require('./browser-identity-catalog');

const CLIENT_HINT_PREFIX = 'sec-ch-ua';

/**
 * Low-entropy hints real Chrome sends on EVERY secure request. Electron does not emit them at all
 * (no ClientHintsControllerDelegate), so a Chromium identity must synthesize them when absent.
 */
const LOW_ENTROPY_HINTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];
/** Sent only when the origin asked for them via Accept-CH (client-hints-cache.js). */
const HIGH_ENTROPY_HINTS = ['sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors'];

function _isSecureUrl(url) {
    if (!url) return true; // unknown → assume the TLS-terminated path
    return /^(https|wss):/i.test(String(url));
}

/**
 * @param {Record<string,string>} headers        - mutable header map (any key casing)
 * @param {Array<[string,string]>|null} orderedHeaders - mutable ordered pairs (Chromium order) or null
 * @param {import('./browser-identity-catalog').ResolvedIdentity|null|undefined} identity
 * @param {{ url?: string, requestedHints?: Iterable<string> }} [opts] - request URL (low-entropy hints are only
 *        added on secure URLs); requestedHints = high-entropy hints the origin asked for via Accept-CH
 * @returns {{ applied: boolean }}
 */
function applyIdentityToOutboundHeaders(headers, orderedHeaders, identity, opts = {}) {
    if (!identity || !identity.userAgent) {
        applyOutboundUserAgentToMitmHeaders(headers, orderedHeaders);
        return { applied: false };
    }
    if (!headers || typeof headers !== 'object') return { applied: false };

    const ua = String(identity.userAgent);
    const hintValues = buildClientHintHeaders(identity.clientHints || null); // null → strip all
    const language = identity.language ? String(identity.language) : null;
    const addMissingHints = !!hintValues && _isSecureUrl(opts.url);
    const wantedHigh = addMissingHints && opts.requestedHints
        ? [...opts.requestedHints].map((h) => String(h).toLowerCase()).filter((h) => HIGH_ENTROPY_HINTS.includes(h) && hintValues[h] != null)
        : [];
    const toAdd = addMissingHints ? [...LOW_ENTROPY_HINTS, ...wantedHigh] : [];

    // ── headers map ────────────────────────────────────────────────────────────
    let uaKey = null;
    const seenHints = new Set();
    for (const k of Object.keys(headers)) {
        const kl = String(k).toLowerCase();
        if (kl === 'user-agent') {
            uaKey = k;
        } else if (kl.startsWith(CLIENT_HINT_PREFIX)) {
            if (!hintValues) delete headers[k];
            else if (Object.prototype.hasOwnProperty.call(hintValues, kl)) { headers[k] = hintValues[kl]; seenHints.add(kl); }
        } else if (kl === 'accept-language' && language) {
            headers[k] = language;
        }
    }
    if (uaKey) headers[uaKey] = ua;
    else headers['user-agent'] = ua;
    for (const h of toAdd) if (!seenHints.has(h)) headers[h] = hintValues[h];

    // ── ordered headers ────────────────────────────────────────────────────────
    if (Array.isArray(orderedHeaders)) {
        let uaSeen = false;
        const orderedHints = new Set();
        for (let i = orderedHeaders.length - 1; i >= 0; i--) {
            const pair = orderedHeaders[i];
            if (!pair || pair.length < 2) continue;
            const kl = String(pair[0]).toLowerCase();
            if (kl === 'user-agent') {
                orderedHeaders[i] = [pair[0], ua];
                uaSeen = true;
            } else if (kl.startsWith(CLIENT_HINT_PREFIX)) {
                if (!hintValues) orderedHeaders.splice(i, 1);
                else if (Object.prototype.hasOwnProperty.call(hintValues, kl)) { orderedHeaders[i] = [pair[0], hintValues[kl]]; orderedHints.add(kl); }
            } else if (kl === 'accept-language' && language) {
                orderedHeaders[i] = [pair[0], language];
            }
        }
        if (!uaSeen) orderedHeaders.push(['User-Agent', ua]);
        const missing = toAdd.filter((h) => !orderedHints.has(h)).map((h) => [h, hintValues[h]]);
        if (missing.length) {
            // Chrome places the client-hint block right before Upgrade-Insecure-Requests / User-Agent;
            // when a sec-ch-ua block already exists, extend it in place.
            let at = -1;
            for (let i = orderedHeaders.length - 1; i >= 0; i--) {
                if (String(orderedHeaders[i][0]).toLowerCase().startsWith(CLIENT_HINT_PREFIX)) { at = i + 1; break; }
            }
            if (at < 0) at = orderedHeaders.findIndex(([k]) => String(k).toLowerCase() === 'upgrade-insecure-requests');
            if (at < 0) at = orderedHeaders.findIndex(([k]) => String(k).toLowerCase() === 'user-agent');
            if (at < 0) at = orderedHeaders.length;
            orderedHeaders.splice(at, 0, ...missing);
        }
    }
    return { applied: true };
}

/** Preview of the wire-relevant header values for an identity (Identity window "what the wire sends"). */
function previewIdentityHeaders(identity) {
    if (!identity || !identity.userAgent) return null;
    const hints = buildClientHintHeaders(identity.clientHints || null);
    return {
        'user-agent': String(identity.userAgent),
        'sec-ch-ua': hints ? hints['sec-ch-ua'] : null,
        'sec-ch-ua-mobile': hints ? hints['sec-ch-ua-mobile'] : null,
        'sec-ch-ua-platform': hints ? hints['sec-ch-ua-platform'] : null,
        'accept-language': identity.language || null,
    };
}

module.exports = { applyIdentityToOutboundHeaders, previewIdentityHeaders, CLIENT_HINT_PREFIX, LOW_ENTROPY_HINTS, HIGH_ENTROPY_HINTS };
