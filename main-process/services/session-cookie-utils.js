'use strict';

/** @param {{ domain?: string, path?: string, secure?: boolean, url?: string }} c */
function buildCookieRequestUrl(c) {
    if (c?.url) return c.url;
    const domain = String(c?.domain || '').replace(/^\./, '');
    const path = c?.path || '/';
    const scheme = c?.secure ? 'https' : 'http';
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${scheme}://${domain}${normalizedPath}`;
}

/** Stable identity for one cookie jar entry (name alone is not unique). */
function cookieIdentityKey(c) {
    return [
        c?.name || '',
        c?.domain || '',
        c?.path || '/',
        c?.secure ? '1' : '0',
        c?.httpOnly ? '1' : '0',
    ].join('\0');
}

function cookiesMatchIdentity(a, b) {
    return cookieIdentityKey(a) === cookieIdentityKey(b);
}

/**
 * Legacy IPC: remove-cookie(tabId, url, name).
 * Preferred: remove-cookie(tabId, cookieObject).
 */
function normalizeRemoveCookieArgs(cookieOrUrl, name) {
    if (cookieOrUrl && typeof cookieOrUrl === 'object') {
        const c = cookieOrUrl;
        return {
            name: c.name,
            domain: c.domain,
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: c.sameSite,
            url: c.url || buildCookieRequestUrl(c),
        };
    }
    const url = String(cookieOrUrl || '');
    let domain;
    try {
        domain = new URL(url).hostname;
    } catch {
        domain = undefined;
    }
    return {
        name: String(name || ''),
        domain,
        path: '/',
        secure: url.startsWith('https:'),
        url,
    };
}

/**
 * Remove exactly one cookie (domain + path + name).
 * Electron cookies.remove(url, name) deletes all cookies with that name in the URL scope.
 */
async function removeSessionCookiePrecise(sess, cookie) {
    if (!sess || !cookie?.name) throw new Error('Invalid cookie');

    const domain = cookie.domain;
    const path = cookie.path || '/';
    const url = cookie.url || buildCookieRequestUrl(cookie);

    await sess.cookies.set({
        url,
        name: cookie.name,
        value: '',
        domain,
        path,
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
        expirationDate: 1,
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    });

    const left = await sess.cookies.get({ url, name: cookie.name });
    const stillThere = left.some((c) => cookiesMatchIdentity(c, cookie));
    if (stillThere && domain) {
        await sess.cookies.set({
            url,
            name: cookie.name,
            value: '',
            domain,
            path,
            secure: !!cookie.secure,
            httpOnly: !!cookie.httpOnly,
            expirationDate: Math.floor(Date.now() / 1000) - 3600,
            ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
        });
    }
}

module.exports = {
    buildCookieRequestUrl,
    cookieIdentityKey,
    cookiesMatchIdentity,
    normalizeRemoveCookieArgs,
    removeSessionCookiePrecise,
};
