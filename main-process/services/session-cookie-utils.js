'use strict';

/** @param {{ domain?: string, path?: string, secure?: boolean, url?: string }} c */
function buildCookieRequestUrl(c) {
    if (c?.url) return c.url;
    const domain = String(c?.domain || '').replace(/^\./, '');
    const path = c?.path || '/';
    const scheme = c?.secure === false ? 'http' : 'https';
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
        c?.hostOnly ? '1' : '0',
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
            hostOnly: !!c.hostOnly,
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
        hostOnly: true,
        url,
    };
}

function isHostOnlyCookie(c) {
    if (c?.hostOnly === true) return true;
    const name = String(c?.name || '');
    if (name.startsWith('__Host-')) return true;
    const domain = String(c?.domain || '');
    return !!domain && !domain.startsWith('.');
}

function sameSiteForSet(c) {
    const ss = c?.sameSite;
    if (!ss || ss === 'unspecified') return null;
    return ss;
}

function buildExpireSetDetails(c, url, expirationDate) {
    const details = {
        url,
        name: c.name,
        value: '',
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expirationDate,
    };
    const ss = sameSiteForSet(c);
    if (ss) details.sameSite = ss;
    if (!isHostOnlyCookie(c) && c.domain) {
        details.domain = c.domain;
    }
    return details;
}

/** Candidate request URLs for delete/remove (path + scheme variants). */
function buildCookieRemovalUrls(c) {
    const urls = new Set();
    if (c?.url) urls.add(c.url);

    const bare = String(c?.domain || '').replace(/^\./, '');
    const path = c?.path || '/';
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    if (bare) {
        const schemes = c?.secure === false ? ['http', 'https'] : ['https'];
        for (const scheme of schemes) {
            urls.add(`${scheme}://${bare}${normalizedPath}`);
            if (normalizedPath !== '/') urls.add(`${scheme}://${bare}/`);
        }
    }

    if (!urls.size) urls.add(buildCookieRequestUrl(c));
    return [...urls];
}

function cookieMatchesDomainFilter(c, filterDomain) {
    if (!filterDomain) return true;
    const needle = String(filterDomain).replace(/^\./, '').toLowerCase();
    const hay = String(c?.domain || '').replace(/^\./, '').toLowerCase();
    if (!needle || !hay) return false;
    return hay === needle || hay.endsWith('.' + needle) || needle.endsWith('.' + hay);
}

async function sessionHasCookie(sess, cookie) {
    const all = await sess.cookies.get({});
    return all.some((c) => cookiesMatchIdentity(c, cookie));
}

/**
 * Remove exactly one cookie (domain + path + name).
 * Avoids cookies.remove(url, name) as primary — it can drop multiple same-name entries.
 */
async function removeSessionCookiePrecise(sess, cookie) {
    if (!sess || !cookie?.name) throw new Error('Invalid cookie');

    const urls = buildCookieRemovalUrls(cookie);
    const past = Math.floor(Date.now() / 1000) - 86400;

    for (const url of urls) {
        try {
            await sess.cookies.set(buildExpireSetDetails(cookie, url, past));
        } catch { /* try next url */ }
    }

    if (!(await sessionHasCookie(sess, cookie))) return;

    for (const url of urls) {
        try {
            await sess.cookies.remove(url, cookie.name);
        } catch { /* ignore */ }
    }

    if (!(await sessionHasCookie(sess, cookie))) return;

    for (const url of urls) {
        try {
            await sess.cookies.set(buildExpireSetDetails(cookie, url, 0));
        } catch { /* ignore */ }
    }

    if (await sessionHasCookie(sess, cookie)) {
        throw new Error(`Could not remove cookie "${cookie.name}"`);
    }
}

function normalizeCookieHostname(host) {
    return String(host || '').replace(/^\./, '').toLowerCase();
}

/** Strip leftmost label when 3+ labels (armenia.blsspainrussia.ru → blsspainrussia.ru). */
function computeParentDomain(hostname) {
    const labels = normalizeCookieHostname(hostname).split('.').filter(Boolean);
    if (labels.length < 2) return labels.join('.');
    if (labels.length === 2) return labels.join('.');
    return labels.slice(1).join('.');
}

function parentDomainAttribute(parentBare) {
    const bare = normalizeCookieHostname(parentBare);
    const labels = bare.split('.').filter(Boolean);
    if (labels.length >= 2) return `.${bare}`;
    return bare;
}

function cookieBelongsToTree(c, parentBare) {
    const bare = normalizeCookieHostname(c?.domain);
    const parent = normalizeCookieHostname(parentBare);
    if (!bare || !parent) return false;
    return bare === parent || bare.endsWith('.' + parent);
}

function isCookieOnParentDomain(c, parentBare) {
    const bare = normalizeCookieHostname(c?.domain);
    const parent = normalizeCookieHostname(parentBare);
    return bare === parent && !c?.hostOnly;
}

function isStrictSubdomainHost(domain, parentBare) {
    const bare = normalizeCookieHostname(domain);
    const parent = normalizeCookieHostname(parentBare);
    return bare !== parent && bare.endsWith('.' + parent);
}

function consolidationGroupKey(c) {
    const ss = c?.sameSite && c.sameSite !== 'unspecified' ? c.sameSite : '';
    return [
        c?.name || '',
        c?.path || '/',
        c?.secure ? '1' : '0',
        c?.httpOnly ? '1' : '0',
        ss,
    ].join('\0');
}

function cookieSpecificityScore(c, anchorHost) {
    const bare = normalizeCookieHostname(c?.domain);
    const anchor = normalizeCookieHostname(anchorHost);
    let score = 0;
    if (bare === anchor) score += 200;
    if (c?.hostOnly && bare === anchor) score += 50;
    if (String(c?.value || '').length > 0) score += 20;
    if (c?.expirationDate) score += 2;
    score += bare.split('.').length;
    return score;
}

function pickCanonicalCookie(group, anchorHost) {
    return [...group].sort(
        (a, b) => cookieSpecificityScore(b, anchorHost) - cookieSpecificityScore(a, anchorHost),
    )[0];
}

function buildSetDetailsForDomain(c, domainAttr) {
    const attr = String(domainAttr || '');
    const bare = normalizeCookieHostname(attr);
    const hostOnly = !attr.startsWith('.') && bare.split('.').length < 2;
    const domain = hostOnly ? bare : (attr.startsWith('.') ? attr : parentDomainAttribute(bare));
    const url = buildCookieRequestUrl({
        ...c,
        domain: hostOnly ? bare : domain,
        secure: c?.secure !== false,
    });
    const details = {
        url,
        name: c.name,
        value: c.value ?? '',
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
    };
    if (c.expirationDate) details.expirationDate = c.expirationDate;
    const ss = sameSiteForSet(c);
    if (ss) details.sameSite = ss;
    if (!hostOnly && domain) details.domain = domain;
    return details;
}

/**
 * Merge cookies on subdomains (armenia.example.com, .armenia.example.com)
 * into the parent domain (.example.com) and remove narrower entries.
 */
async function consolidateCookiesToParent(sess, { anchorHost } = {}) {
    if (!sess) throw new Error('Session required');
    const anchor = normalizeCookieHostname(anchorHost);
    if (!anchor) throw new Error('Anchor host required');

    const parentBare = computeParentDomain(anchor);
    const parentDomain = parentDomainAttribute(parentBare);
    const all = await sess.cookies.get({});
    const inTree = all.filter((c) => cookieBelongsToTree(c, parentBare));

    const groups = new Map();
    for (const c of inTree) {
        const key = consolidationGroupKey(c);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }

    let groupsMerged = 0;
    let cookiesRemoved = 0;
    let cookiesWritten = 0;

    for (const [, group] of groups) {
        if (group.length === 1 && isCookieOnParentDomain(group[0], parentBare)) {
            continue;
        }
        const canonical = pickCanonicalCookie(group, anchor);
        for (const c of group) {
            await removeSessionCookiePrecise(sess, { ...c, url: buildCookieRequestUrl(c) });
            cookiesRemoved++;
        }
        await sess.cookies.set(buildSetDetailsForDomain(canonical, parentDomain));
        cookiesWritten++;
        groupsMerged++;
    }

    const after = await sess.cookies.get({});
    for (const c of after) {
        if (!cookieBelongsToTree(c, parentBare)) continue;
        if (isCookieOnParentDomain(c, parentBare)) continue;
        if (isStrictSubdomainHost(c.domain, parentBare)) {
            await removeSessionCookiePrecise(sess, { ...c, url: buildCookieRequestUrl(c) });
            cookiesRemoved++;
        }
    }

    await sess.cookies.flushStore();
    return {
        groupsMerged,
        cookiesRemoved,
        cookiesWritten,
        parentDomain,
        anchorHost: anchor,
    };
}

/** Remove all cookies scoped to a hostname (exact host or domain suffix). */
async function purgeCookiesForHostname(sess, hostname) {
    if (!sess) throw new Error('Session required');
    const target = normalizeCookieHostname(hostname).replace(/^\*\./, '');
    if (!target) return { removed: 0 };

    const all = await sess.cookies.get({});
    let removed = 0;
    for (const c of all) {
        const bare = normalizeCookieHostname(c.domain);
        if (bare === target || bare.endsWith('.' + target)) {
            await removeSessionCookiePrecise(sess, { ...c, url: buildCookieRequestUrl(c) });
            removed++;
        }
    }
    await sess.cookies.flushStore();
    return { removed };
}

async function purgeCookiesForHostnameAllTabs(tabManager, hostname) {
    const seen = new Set();
    let removed = 0;
    for (const tab of tabManager.getAllTabs()) {
        const sess = tab.tabSession;
        if (!sess || seen.has(sess)) continue;
        seen.add(sess);
        const res = await purgeCookiesForHostname(sess, hostname);
        removed += res.removed;
    }
    return { removed, sessions: seen.size };
}

module.exports = {
    buildCookieRequestUrl,
    buildCookieRemovalUrls,
    buildExpireSetDetails,
    cookieIdentityKey,
    cookiesMatchIdentity,
    cookieMatchesDomainFilter,
    isHostOnlyCookie,
    normalizeRemoveCookieArgs,
    removeSessionCookiePrecise,
    computeParentDomain,
    parentDomainAttribute,
    consolidateCookiesToParent,
    purgeCookiesForHostname,
    purgeCookiesForHostnameAllTabs,
    normalizeCookieHostname,
    cookieBelongsToTree,
    isCookieOnParentDomain,
    isStrictSubdomainHost,
};
