'use strict';

const { parse } = require('tldts');

/**
 * Регистрируемый домен (eTLD+1): test.example.com → example.com.
 * Для localhost / IP / внутренних URL — возвращаем hostname как есть.
 */
function getNoteDomainFromUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return '';
    const raw = urlStr.trim();
    if (!raw) return '';
    let u;
    try {
        u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
        return '';
    }
    const host = (u.hostname || '').toLowerCase();
    if (!host) return '';
    if (host === 'localhost' || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return host;
    }
    const p = parse(u.href);
    if (p.domain) return String(p.domain).toLowerCase();
    return host;
}

/**
 * Glob как в intercept rules (для совпадения с полным URL страницы).
 */
function matchGlobPattern(pattern, url) {
    if (!pattern) return false;
    if (pattern === '<all_urls>' || pattern === '*') return true;
    try {
        const regexStr = '^' + pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*') + '$';
        return new RegExp(regexStr, 'i').test(url);
    } catch {
        return url.includes(pattern);
    }
}

/**
 * Совпадает ли заметка с паттерном url_match с текущей страницей.
 * Пустой паттерн — не привязана к сайту (не показывать в «текущий сайт»).
 */
function noteMatchesUrlMatch(pattern, pageUrl) {
    const p = String(pattern || '').trim();
    if (!p) return false;
    if (!pageUrl) return false;
    try {
        const u = new URL(/^https?:\/\//i.test(pageUrl) ? pageUrl : `https://${pageUrl}`);
        const full = u.href;
        const host = u.hostname.toLowerCase();
        // A pattern with an explicit scheme globs against the whole URL.
        if (/^https?:\/\//i.test(p)) {
            return matchGlobPattern(p, full);
        }
        // Scheme-less: split into a host part and an optional path part, and match them
        // separately — otherwise "*.example.com" (globbed against the full URL) never
        // matches because of the trailing path, and "example.com/admin" ignores its path
        // and matches every page on the host. (A-162)
        const slash = p.indexOf('/');
        const hostPart = (slash === -1 ? p : p.slice(0, slash)).toLowerCase();
        const pathPart = slash === -1 ? '' : p.slice(slash); // keeps the leading '/'
        if (!hostPart) return false;
        let hostOk;
        if (hostPart.startsWith('*.')) {
            const base = hostPart.slice(2);
            hostOk = host === base || host.endsWith('.' + base);
        } else if (hostPart.includes('*')) {
            hostOk = matchGlobPattern(hostPart, host);
        } else {
            hostOk = host === hostPart || host.endsWith('.' + hostPart);
        }
        if (!hostOk) return false;
        if (pathPart && pathPart !== '/') {
            return matchGlobPattern(pathPart, u.pathname + u.search);
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Индексный домен (eTLD+1) для колонки domain — из строки url_match.
 */
function getNoteIndexDomainFromMatch(match) {
    const raw = String(match || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
        return getNoteDomainFromUrl(raw);
    }
    const noStar = raw.replace(/\*/g, '');
    const first = noStar.split('/')[0].trim();
    if (first && first.includes('.')) {
        return getNoteDomainFromUrl(`https://${first}`);
    }
    const m = raw.match(/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/i);
    if (m) return getNoteDomainFromUrl(`https://${m[0]}`);
    return '';
}

module.exports = {
    getNoteDomainFromUrl,
    noteMatchesUrlMatch,
    getNoteIndexDomainFromMatch,
    matchGlobPattern,
};
