'use strict';

/**
 * Подсчёт cookies, которые браузер мог бы отправить на указанный URL (домен + path + secure + срок).
 * Упрощённо по RFC6265 (без SameSite и прочих нюансов запроса).
 */
(function () {
    function cookieIsExpired(c) {
        if (c.expirationDate == null || c.expirationDate === '') return false;
        const exp = Number(c.expirationDate);
        if (!Number.isFinite(exp)) return false;
        return exp * 1000 <= Date.now();
    }

    function pathMatches(cookiePath, requestPath) {
        const cp = (cookiePath && cookiePath !== '') ? String(cookiePath) : '/';
        const rp = requestPath || '/';
        if (cp === '/') return true;
        if (rp === cp) return true;
        const prefix = cp.endsWith('/') ? cp : `${cp}/`;
        return rp.startsWith(prefix);
    }

    function cookieAppliesToUrl(c, pageUrl) {
        if (!pageUrl || pageUrl === '(blank)' || pageUrl === 'about:blank') return false;
        if (cookieIsExpired(c)) return false;
        let u;
        try { u = new URL(pageUrl); } catch { return false; }
        const host = u.hostname.toLowerCase();
        if (!host) return false;
        if (c.secure && u.protocol !== 'https:') return false;

        const raw = String(c.domain || '').toLowerCase();
        if (!raw) return false;

        if (!pathMatches(c.path, u.pathname || '/')) return false;

        if (raw.startsWith('.')) {
            const bare = raw.slice(1);
            if (host === bare) return true;
            return host.endsWith('.' + bare);
        }
        return host === raw;
    }

    function countCookiesForPageUrl(cookies, pageUrl) {
        if (!Array.isArray(cookies) || !pageUrl) return 0;
        let n = 0;
        for (const c of cookies) {
            if (cookieAppliesToUrl(c, pageUrl)) n++;
        }
        return n;
    }

    window.CupNetCookiePageMatch = {
        cookieAppliesToUrl,
        countCookiesForPageUrl,
    };
})();
