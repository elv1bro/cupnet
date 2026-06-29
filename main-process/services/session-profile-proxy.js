'use strict';

const { maskProxyUrlForLog } = require('./proxy-profile-resolve');

/** Proxy Manager profile updated on each session load with inline `proxy.template`. */
const LAST_SESSION_PROXY_NAME = 'last_session_proxy';

/**
 * Upsert a Proxy Manager profile from session inline proxy + optional fingerprint.
 * @param {object} ctx — IPC scope (db, safeStorage, notifyProxyProfilesList, sysLog)
 * @param {import('../../session-profile').NormalizedSessionProfile['proxy']} proxy
 * @param {import('../../session-profile').NormalizedSessionProfile['fingerprint']} [fingerprint]
 * @returns {Promise<number|null>} profile id
 */
async function upsertLastSessionProxyProfile(ctx, proxy, fingerprint) {
    if (!proxy?.template || !ctx.db?.saveProxyProfileAsync) return null;

    const template = String(proxy.template).trim();
    if (!template) return null;

    let urlEncrypted = null;
    let urlDisplay = template;
    if (ctx.safeStorage?.isEncryptionAvailable()) {
        try {
            urlEncrypted = ctx.safeStorage.encryptString(template);
            try {
                const u = new URL(template.replace(/\{[^}]+\}/g, 'x'));
                if (u.password) urlDisplay = template.replace(u.password, '***');
            } catch { /* ignore */ }
        } catch (e) {
            ctx.sysLog?.('warn', 'session-profile', `Proxy encrypt failed: ${e?.message || e}`);
        }
    }

    const hasTemplateVars = /\{[A-Za-z][A-Za-z0-9_:-]*\}/.test(template);
    const tlsProfile = proxy.tlsProfile || 'chrome';
    const ja3 = proxy.ja3 || null;

    try {
        const id = await ctx.db.saveProxyProfileAsync(LAST_SESSION_PROXY_NAME, urlEncrypted, urlDisplay, {
            isTemplate: hasTemplateVars,
            variables: proxy.variables || {},
            notes: 'Auto-saved from session profile load',
            traffic_mode: 'mitm',
            user_agent: fingerprint?.userAgent || null,
            timezone: fingerprint?.timezone || null,
            language: fingerprint?.language || null,
            tls_profile: tlsProfile,
            tls_ja3_mode: ja3 ? 'custom' : 'template',
            tls_ja3_custom: ja3,
        });
        ctx.notifyProxyProfilesList?.();
        return id ?? null;
    } catch (e) {
        ctx.sysLog?.('warn', 'session-profile', `last_session_proxy save failed: ${e?.message || e}`);
        return null;
    }
}

module.exports = {
    LAST_SESSION_PROXY_NAME,
    upsertLastSessionProxyProfile,
    maskProxyUrlForLog,
};
