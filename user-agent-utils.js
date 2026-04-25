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

module.exports = {
    sanitizeUserAgentChromeOnly,
    applyOutboundUserAgentToMitmHeaders,
    isUaSanitizeDisabled,
};
