'use strict';
/**
 * Сеть / прокси-утилиты без зависимостей от Electron session.
 */
const os = require('os');
const crypto = require('crypto');

function getLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

function generatePassword(len = 8) {
    return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function sanitizeProxyUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        throw new Error('Proxy URL must be a non-empty string');
    }
    let u;
    try {
        u = new URL(proxyUrl);
    } catch {
        try { u = new URL('http://' + proxyUrl); } catch {
            throw new Error(`Invalid proxy URL format: "${proxyUrl}"`);
        }
    }
    const allowed = ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'];
    if (!allowed.includes(u.protocol)) {
        throw new Error(`Unsupported proxy protocol "${u.protocol}". Allowed: ${allowed.join(', ')}`);
    }
    if (!u.hostname) throw new Error('Proxy URL is missing a hostname');
    const masked = u.password
        ? `${u.protocol}//${u.username}:***@${u.hostname}${u.port ? ':' + u.port : ''}`
        : proxyUrl;
    Object.defineProperty(sanitizeProxyUrl, '_lastMasked', { value: masked, writable: true, configurable: true });
    return proxyUrl;
}

function withTimeout(promise, timeoutMs, timeoutMessage = 'Operation timeout') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        Promise.resolve(promise).then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}

module.exports = {
    getLocalIp,
    generatePassword,
    sanitizeProxyUrl,
    withTimeout,
};
