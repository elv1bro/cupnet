'use strict';

/**
 * Нормализация User-Agent для **исходящего HTTP** в MITM (strip CupNet/Electron → Chrome-like).
 * В рендерере `navigator.userAgent` по-прежнему может быть строкой Electron — правка только на wire.
 *
 * Отключить: `CUPNET_DISABLE_UA_SANITIZE=1`
 * Юнит-тесты: tests/test-user-agent-utils.js
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

/**
 * Перед upstream (AzureTLS worker / raw WS) подменить User-Agent в объекте заголовков и в orderedHeaders.
 */
function applyOutboundUserAgentToMitmHeaders(headers, orderedHeaders) {
    if (isUaSanitizeDisabled() || !headers || typeof headers !== 'object') return;
    for (const k of Object.keys(headers)) {
        if (String(k).toLowerCase() === 'user-agent') {
            headers[k] = sanitizeUserAgentChromeOnly(String(headers[k] ?? ''));
            break;
        }
    }
    if (!Array.isArray(orderedHeaders)) return;
    for (let i = 0; i < orderedHeaders.length; i++) {
        const pair = orderedHeaders[i];
        if (!pair || pair.length < 2) continue;
        if (String(pair[0]).toLowerCase() === 'user-agent') {
            orderedHeaders[i] = [pair[0], sanitizeUserAgentChromeOnly(String(pair[1] ?? ''))];
            break;
        }
    }
}

module.exports = {
    sanitizeUserAgentChromeOnly,
    applyOutboundUserAgentToMitmHeaders,
    isUaSanitizeDisabled,
};
