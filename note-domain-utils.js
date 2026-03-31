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
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
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
        if (p.includes('*') || /^https?:\/\//i.test(p)) {
            return matchGlobPattern(p, full);
        }
        const ph = p.split('/')[0].toLowerCase();
        if (!ph) return false;
        return host === ph || host.endsWith('.' + ph);
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
