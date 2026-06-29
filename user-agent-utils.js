'use strict';

/**
 * User-Agent normalization for MITM wire headers and tab renderer (`navigator.userAgent`).
 * Strips CupNet/Electron tokens → Chrome-like string.
 *
 * Disable: `CUPNET_DISABLE_UA_SANITIZE=1`
 * Unit tests: tests/test-user-agent-utils.js
 */

function isUaSanitizeDisabled() {
    return process.env.CUPNET_DISABLE_UA_SANITIZE === '1';
}

function sanitizeUserAgentChromeOnly(ua) {
    let s = String(ua || '').trim();
    if (!s) return s;
    if (isUaSanitizeDisabled()) return s;
    s = s.replace(/\s+CupNet\/[^\s]+/gi, '');
    s = s.replace(/\s+Electron\/[^\s]+/gi, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s;
}

const DEFAULT_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Перед upstream (AzureTLS worker / raw WS) подменить User-Agent в объекте заголовков и в orderedHeaders.
 * Если User-Agent отсутствует, добавляет дефолтный Chrome UA (без него nginx может вернуть 444/EOF).
 */
function applyOutboundUserAgentToMitmHeaders(headers, orderedHeaders) {
    if (isUaSanitizeDisabled() || !headers || typeof headers !== 'object') return;
    let foundInHeaders = false;
    for (const k of Object.keys(headers)) {
        if (String(k).toLowerCase() === 'user-agent') {
            const sanitized = sanitizeUserAgentChromeOnly(String(headers[k] ?? ''));
            headers[k] = sanitized || DEFAULT_CHROME_UA;
            foundInHeaders = true;
            break;
        }
    }
    if (!foundInHeaders) {
        headers['user-agent'] = DEFAULT_CHROME_UA;
    }

    let foundInOrdered = false;
    if (Array.isArray(orderedHeaders)) {
        for (let i = 0; i < orderedHeaders.length; i++) {
            const pair = orderedHeaders[i];
            if (!pair || pair.length < 2) continue;
            if (String(pair[0]).toLowerCase() === 'user-agent') {
                const sanitized = sanitizeUserAgentChromeOnly(String(pair[1] ?? ''));
                orderedHeaders[i] = [pair[0], sanitized || DEFAULT_CHROME_UA];
                foundInOrdered = true;
                break;
            }
        }
        if (!foundInOrdered) {
            orderedHeaders.push(['User-Agent', DEFAULT_CHROME_UA]);
        }
    }
}

/**
 * Chrome-like UA for tabs when no profile override is set.
 * @param {string|null|undefined} [rawUa] — optional preferred string (e.g. proxy profile)
 * @returns {string}
 */
function resolveRendererUserAgent(rawUa) {
    if (isUaSanitizeDisabled()) {
        const explicit = String(rawUa || '').trim();
        if (explicit) return explicit;
        try {
            const { session } = require('electron');
            return session.defaultSession.getUserAgent();
        } catch {
            return DEFAULT_CHROME_UA;
        }
    }
    const sanitizedExplicit = sanitizeUserAgentChromeOnly(rawUa);
    if (sanitizedExplicit) return sanitizedExplicit;
    try {
        const { session } = require('electron');
        const fromDefault = sanitizeUserAgentChromeOnly(session.defaultSession.getUserAgent());
        if (fromDefault) return fromDefault;
    } catch { /* ignore */ }
    return DEFAULT_CHROME_UA;
}

/**
 * Apply sanitized UA to an Electron Session (affects `navigator.userAgent` in that partition).
 * @param {import('electron').Session|null|undefined} sess
 * @param {string|null|undefined} [rawUa]
 * @param {string} [acceptLanguage]
 */
function applyRendererUserAgentToSession(sess, rawUa, acceptLanguage) {
    if (!sess || typeof sess.setUserAgent !== 'function') return;
    if (isUaSanitizeDisabled() && rawUa == null) return;
    const ua = resolveRendererUserAgent(rawUa);
    if (!ua) return;
    try {
        sess.setUserAgent(ua, acceptLanguage || '');
    } catch { /* ignore */ }
}

module.exports = {
    sanitizeUserAgentChromeOnly,
    applyOutboundUserAgentToMitmHeaders,
    applyRendererUserAgentToSession,
    resolveRendererUserAgent,
    isUaSanitizeDisabled,
    DEFAULT_CHROME_UA,
};
