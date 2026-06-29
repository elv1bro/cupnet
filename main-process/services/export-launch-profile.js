'use strict';

const { LAUNCH_FORMAT_ID, CURRENT_VERSION } = require('../../session-profile');
const { LAST_SESSION_PROXY_NAME } = require('./session-profile-proxy');
const { resolveProxyTemplateFromDbRow } = require('./proxy-profile-resolve');

function _cookieMatchesHost(cookie, hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return false;
    const dom = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
    if (!dom) return false;
    return host === dom || host.endsWith(`.${dom}`);
}

function _resolveProxyExport(ctx) {
    let profileId = ctx.connectedProfileId || null;
    if (!profileId && ctx.db?.getProxyProfiles) {
        const row = ctx.db.getProxyProfiles().find((p) => p.name === LAST_SESSION_PROXY_NAME);
        if (row?.id) profileId = row.id;
    }
    if (!profileId || !ctx.db?.getProxyProfileEncrypted) return null;
    const row = ctx.db.getProxyProfileEncrypted(profileId);
    if (!row) return null;
    const template = resolveProxyTemplateFromDbRow(ctx, row, {});
    if (!template) {
        return { profileId, profileName: row.name || null };
    }
    let variables = {};
    try {
        variables = row.variables
            ? (typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables)
            : {};
    } catch { /* ignore */ }
    return {
        profileId,
        profileName: row.name || null,
        template,
        variables,
        tlsProfile: row.tls_profile || null,
        ja3: row.tls_ja3_mode === 'custom' ? row.tls_ja3_custom || null : null,
    };
}

/**
 * Build a cupnet-launch JSON object from a logged request + live tab/proxy state.
 * @param {object} ctx
 * @param {number} requestId
 */
async function buildLaunchProfileFromRequest(ctx, requestId) {
    const id = Number(requestId);
    if (!Number.isFinite(id) || id <= 0) {
        return { success: false, error: 'Invalid request id' };
    }
    const req = ctx.db?.getRequest?.(id);
    if (!req) return { success: false, error: 'Request not found' };

    const url = String(req.url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
        return { success: false, error: 'Request has no HTTP(S) URL' };
    }

    let hostname = '';
    try { hostname = new URL(url).hostname; } catch {
        return { success: false, error: 'Invalid request URL' };
    }

    const cookies = [];
    const tabId = req.tab_id ? String(req.tab_id) : null;
    const tab = tabId ? ctx.tabManager?.getTab?.(tabId) : null;
    if (tab?.tabSession) {
        try {
            const all = await tab.tabSession.cookies.get({});
            for (const c of all) {
                if (!_cookieMatchesHost(c, hostname)) continue;
                cookies.push({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    secure: c.secure !== false,
                    httpOnly: !!c.httpOnly,
                    ...(c.expirationDate != null ? { expirationDate: c.expirationDate } : {}),
                });
            }
        } catch { /* ignore */ }
    }

    const proxyExport = _resolveProxyExport(ctx);
    const proxy = proxyExport?.template
        ? {
            template: proxyExport.template,
            variables: proxyExport.variables || {},
            tlsProfile: proxyExport.tlsProfile || undefined,
            ja3: proxyExport.ja3 || undefined,
        }
        : (proxyExport?.profileId ? { profileId: proxyExport.profileId } : null);

    let fingerprint = null;
    if (ctx.activeFingerprint) {
        fingerprint = {
            userAgent: ctx.activeFingerprint.user_agent || undefined,
            language: ctx.activeFingerprint.language || undefined,
            timezone: ctx.activeFingerprint.timezone || undefined,
        };
    }

    const profile = {
        format: LAUNCH_FORMAT_ID,
        version: CURRENT_VERSION,
        name: `From request #${id}`,
        description: `Exported from Network Activity\nurl=${url}\ntab=${tabId || '—'}\nproxy=${proxyExport?.profileName || '—'}`,
        tab: { newTab: true },
        navigate: { url },
        proxy,
        fingerprint,
        cookies,
        clearCookiesBeforeLoad: false,
        clearStorageBeforeLoad: false,
    };

    return { success: true, profile, requestId: id, tabId };
}

module.exports = {
    buildLaunchProfileFromRequest,
};
