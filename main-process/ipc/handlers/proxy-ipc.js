'use strict';

const { insertCupnetTrafficSnapshot, insertCupnetTrafficSnapshotWithGeo } = require('../../services/cupnet-network-meta-log');
const { connectGlobalProxyProfile, disconnectGlobalProxy } = require('../../services/global-proxy-connect');

/**
 * Текущий прокси, connect/disconnect, профили, тесты.
 * @param {object} ctx
 */
function parseProxyVariablesJson(raw, ctx) {
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (e) {
        ctx.safeCatch({ module: 'main', eventCode: 'proxy.profile.variables.parse.failed', context: { op: 'parseProxyVariablesJson' } }, e, 'info');
        return {};
    }
}

function registerProxyIpc(ctx) {
    ctx.ipcMain.handle('get-current-proxy', async () => {
        const isDirect = !ctx.persistentAnonymizedProxyUrl && ctx.actProxy === '';
        const globalName = ctx.connectedProfileName || ctx.actProxy || '';
        const at = ctx.tabManager?.getActiveTab?.();
        let tabProxyProfileId = null;
        let tabProxyName = '';
        if (at?.proxyProfileId && ctx.db?.getProxyProfileEncrypted) {
            tabProxyProfileId = at.proxyProfileId;
            try {
                const row = ctx.db.getProxyProfileEncrypted(at.proxyProfileId);
                if (row?.name) tabProxyName = String(row.name);
            } catch (_) { /* ignore */ }
            if (!tabProxyName) tabProxyName = `#${at.proxyProfileId}`;
        }
        const displayProxyName = tabProxyName || globalName;
        return {
            active:    !!ctx.persistentAnonymizedProxyUrl,
            proxyName: globalName,
            tabProxyProfileId,
            tabProxyName,
            displayProxyName,
            mode:      isDirect ? 'direct' : (ctx.persistentAnonymizedProxyUrl ? 'proxy' : 'none'),
            trafficMode: ctx.getCurrentTrafficMode(),
            effectiveMode: ctx.getCurrentTrafficMode(),
            profileId: ctx.connectedProfileId || null,
            resolvedVars: ctx.connectedResolvedVars || {},
        };
    });

    ctx.ipcMain.handle('connect-proxy-template', async (_, profileId, ephemeralVars) => {
        return connectGlobalProxyProfile(ctx, profileId, ephemeralVars);
    });

    ctx.ipcMain.handle('apply-quick-proxy-change', async (_, proxyUrl) => {
        try {
            if (!proxyUrl || typeof proxyUrl !== 'string') return { success: false, error: 'Invalid proxy URL' };
            const anonymized = await ctx.quickChangeProxy(proxyUrl);
            await ctx.applyEffectiveTrafficMode(ctx.getCurrentTrafficMode(), anonymized, {
                source: 'quick-proxy-change',
                force: true,
            });
            ctx.buildMenu();
            ctx.notifyProxyStatus();
            await insertCupnetTrafficSnapshotWithGeo(ctx, { mode: 'proxy', profileName: 'Quick proxy' }).catch(() => {});
            return { success: true, message: 'Proxy applied successfully' };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('disconnect-proxy', async () => {
        try {
            await disconnectGlobalProxy(ctx);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('save-proxy-profile-full', async (_, profile) => {
        try {
            // profile: { id?, name, template, variables, notes, country }
            let urlEncrypted = null, urlDisplay = profile.template;
            try {
                if (ctx.safeStorage.isEncryptionAvailable()) {
                    urlEncrypted = ctx.safeStorage.encryptString(profile.template);
                    // Mask password in display string
                    try {
                        const u = new URL(profile.template.replace(/\{[^}]+\}/g, 'PLACEHOLDER'));
                        if (u.password) urlDisplay = profile.template.replace(u.password, '***');
                    } catch (err) {
                        ctx.safeCatch({ module: 'main', eventCode: 'proxy.profile.parse.failed', context: { op: 'mask-password-template' } }, err, 'info');
                    }
                }
            } catch (err) {
                ctx.safeCatch({ module: 'main', eventCode: 'proxy.profile.encrypt.failed', context: { op: 'save-proxy-profile-full' } }, err);
            }

            if (profile.id) {
                await ctx.db.updateProxyProfileByIdAsync(profile.id, {
                    name:          profile.name,
                    url_encrypted: urlEncrypted,
                    url_display:   urlDisplay,
                    is_template:   1,
                    variables:     profile.variables || {},
                    notes:         profile.notes || '',
                    country:       profile.country || '',
                    traffic_mode:  'mitm',
                    user_agent:    profile.user_agent || null,
                    timezone:      profile.timezone   || null,
                    language:      profile.language   || null,
                    tls_profile:   profile.tls_profile    || 'chrome',
                    tls_ja3_mode:  profile.tls_ja3_mode   || 'template',
                    tls_ja3_custom: profile.tls_ja3_custom || null,
                });
                ctx.notifyProxyProfilesList();
                return { success: true, id: profile.id };
            }

            const id = await ctx.db.saveProxyProfileAsync(profile.name, urlEncrypted, urlDisplay, {
                isTemplate: 1,
                variables:  profile.variables || {},
                notes:      profile.notes || '',
                country:    profile.country || '',
                traffic_mode: 'mitm',
                user_agent: profile.user_agent || null,
                timezone:   profile.timezone   || null,
                language:   profile.language   || null,
                tls_profile:   profile.tls_profile    || 'chrome',
                tls_ja3_mode:  profile.tls_ja3_mode   || 'template',
                tls_ja3_custom: profile.tls_ja3_custom || null,
            });
            ctx.notifyProxyProfilesList();
            return { success: true, id };
        } catch (err) {
            ctx.safeCatch({ module: 'main', eventCode: 'proxy.profile.save.failed', context: { op: 'save-proxy-profile-full' } }, err);
            return { success: false, error: err?.message || String(err) };
        }
    });

    ctx.ipcMain.handle('test-proxy-template', async (_, profileId, ephemeralVars) => {
        const row = ctx.db.getProxyProfileEncrypted(profileId);
        if (!row) return { success: false, error: 'Profile not found' };
        let template = null;
        if (row.url_encrypted && ctx.safeStorage.isEncryptionAvailable()) {
            try { template = ctx.safeStorage.decryptString(row.url_encrypted); } catch (e) { ctx.sysLog('warn', 'proxy', 'decrypt test proxy template failed: ' + (e?.message || e)); }
        }
        if (!template) return { success: false, error: 'Cannot decrypt' };
        const savedVars  = parseProxyVariablesJson(row.variables, ctx);
        const resolved   = ctx.parseProxyTemplate(template, { ...savedVars, ...(ephemeralVars || {}) });
        const start      = Date.now();
        const result     = await ctx.testProxy(resolved);
        const latency    = Date.now() - start;
        if (result.success && result.data) {
            const ip  = result.data.ip || '';
            const geo = [result.data.city, result.data.country].filter(Boolean).join(', ');
            await ctx.db.updateProxyProfileTestAsync(profileId, latency, ip, geo);
            ctx.notifyProxyProfilesList();
        }
        return { ...result, latency, resolvedUrl: resolved };
    });

    // ── Proxy profiles ───────────────────────────────────────────────────────
    ctx.ipcMain.handle('get-proxy-profiles', async () => {
        try {
            if (!ctx.db || typeof ctx.db.getProxyProfiles !== 'function') {
                ctx.sysLog?.('error', 'proxy', 'get-proxy-profiles: database not ready');
                return [];
            }
            return ctx.db.getProxyProfiles();
        } catch (err) {
            ctx.safeCatch({ module: 'main', eventCode: 'proxy.profiles.load.failed', context: { op: 'get-proxy-profiles' } }, err);
            return [];
        }
    });

    ctx.ipcMain.handle('save-proxy-profile', async (_, name, url, country) => {
        let urlEncrypted = null;
        let urlDisplay   = url;
        try {
            if (ctx.safeStorage.isEncryptionAvailable()) {
                urlEncrypted = ctx.safeStorage.encryptString(url);
                // Strip password from display
                try {
                    const u = new URL(url);
                    if (u.password) u.password = '***';
                    urlDisplay = u.toString();
                } catch (err) {
                    ctx.safeCatch({ module: 'main', eventCode: 'proxy.profile.parse.failed', context: { op: 'mask-password' } }, err, 'info');
                }
            }
        } catch (err) {
            ctx.safeCatch({ module: 'main', eventCode: 'proxy.profile.encrypt.failed', context: { op: 'save-proxy-profile' } }, err);
        }
        const opts = country != null && typeof country === 'object' ? country : { country: country || null };
        return ctx.db.saveProxyProfileAsync(name, urlEncrypted, urlDisplay, opts);
    });

    ctx.ipcMain.handle('get-proxy-profile-url', async (_, id) => {
        const row = ctx.db.getProxyProfileEncrypted(id);
        if (!row) return null;
        if (row.url_encrypted && ctx.safeStorage.isEncryptionAvailable()) {
            try { return ctx.safeStorage.decryptString(row.url_encrypted); } catch (e) { ctx.sysLog('warn', 'proxy', 'decrypt profile URL failed: ' + (e?.message || e)); }
        }
        return null;
    });

    ctx.ipcMain.handle('delete-proxy-profile', async (_, id) => {
        await ctx.db.deleteProxyProfileAsync(id);
        ctx.notifyProxyProfilesList();
        return true;
    });

    ctx.ipcMain.handle('test-proxy-profile', async (_, id) => {
        const row = ctx.db.getProxyProfileEncrypted(id);
        if (!row) return { success: false, error: 'Profile not found' };
        let url = null;
        if (row.url_encrypted && ctx.safeStorage.isEncryptionAvailable()) {
            try { url = ctx.safeStorage.decryptString(row.url_encrypted); } catch (e) { ctx.sysLog('warn', 'proxy', 'decrypt profile URL for test failed: ' + (e?.message || e)); }
        }
        if (!url) return { success: false, error: 'Cannot decrypt URL' };
        const start = Date.now();
        const result = await ctx.testProxy(url);
        const latency = Date.now() - start;
        if (result.success) await ctx.db.updateProxyProfileTestAsync(id, latency);
        return { ...result, latency };
    });

    ctx.ipcMain.handle('test-proxy-url', async (_, url, options) => {
        if (!url || typeof url !== 'string') return { success: false, error: 'URL required' };
        const start = Date.now();
        const result = await ctx.testProxy(url, options && typeof options === 'object' ? options : undefined);
        return { ...result, latency: Date.now() - start, resolvedUrl: url };
    });
}

module.exports = { registerProxyIpc };
