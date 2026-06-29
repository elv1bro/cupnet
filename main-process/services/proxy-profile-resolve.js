'use strict';

/**
 * Resolve proxy template string from a DB profile row or session inline proxy.
 * @param {object} ctx
 * @param {{ url_encrypted?: Buffer|string|null, url_display?: string|null, variables?: string|object|null, tls_profile?: string|null, tls_ja3_mode?: string|null, tls_ja3_custom?: string|null }|null} dbRow
 * @param {Record<string, string>} [ephemeralVars]
 * @returns {string|null}
 */
function resolveProxyTemplateFromDbRow(ctx, dbRow, ephemeralVars) {
    if (!dbRow || !ctx.parseProxyTemplate) return null;
    let template = null;
    if (dbRow.url_encrypted && ctx.safeStorage?.isEncryptionAvailable()) {
        try {
            template = ctx.safeStorage.decryptString(dbRow.url_encrypted);
        } catch { /* ignore */ }
    }
    if (!template && dbRow.url_display) {
        const disp = String(dbRow.url_display);
        if (disp && !disp.includes('***')) template = disp;
    }
    if (!template) return null;
    let savedVars = {};
    try {
        savedVars = dbRow.variables
            ? (typeof dbRow.variables === 'string' ? JSON.parse(dbRow.variables) : dbRow.variables)
            : {};
    } catch { /* ignore */ }
    const mergedVars = { ...savedVars, ...(ephemeralVars && typeof ephemeralVars === 'object' ? ephemeralVars : {}) };
    return ctx.parseProxyTemplate(template, mergedVars);
}

/**
 * @param {object} ctx
 * @param {import('../../session-profile').NormalizedSessionProfile['proxy']} proxy
 * @param {number|null} profileId
 * @returns {{ upstream: string, browser: string|null, ja3: string|null }|null}
 */
function resolveSessionProfileProxyUpstream(ctx, proxy, profileId) {
    if (!proxy || !ctx.parseProxyTemplate) return null;

    let upstream = null;
    let browser = proxy.tlsProfile || null;
    let ja3 = proxy.ja3 || null;

    if (proxy.template) {
        upstream = ctx.parseProxyTemplate(proxy.template, proxy.variables || {});
    }

    if (!upstream && profileId && ctx.db?.getProxyProfileEncrypted) {
        const row = ctx.db.getProxyProfileEncrypted(profileId);
        if (row) {
            upstream = resolveProxyTemplateFromDbRow(ctx, row, proxy.variables || {});
            if (!browser) browser = row.tls_profile || null;
            if (!ja3 && row.tls_ja3_mode === 'custom') ja3 = row.tls_ja3_custom || null;
        }
    }

    if (!upstream) return null;
    return { upstream, browser, ja3 };
}

/** @param {string} url */
function maskProxyUrlForLog(url) {
    try {
        const u = new URL(url);
        if (u.password) u.password = '***';
        if (u.username) u.username = u.username.slice(0, 4) + '***';
        return u.toString();
    } catch {
        return String(url).replace(/:[^:@/]+@/, ':***@');
    }
}

module.exports = {
    resolveProxyTemplateFromDbRow,
    resolveSessionProfileProxyUpstream,
    maskProxyUrlForLog,
};
