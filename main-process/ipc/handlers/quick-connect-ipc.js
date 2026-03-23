'use strict';

/**
 * Быстрое подключение профиля из toolbar.
 * @param {object} ctx
 */
function registerQuickConnectIpc(ctx) {
    // Quick-connect a proxy profile directly from the browser toolbar
    ctx.ipcMain.handle('quick-connect-profile', async (_, profileId) => {
        try {
            if (!profileId) {
                if (ctx.persistentAnonymizedProxyUrl) {
                    await ctx.withTimeout(
                        ctx.ProxyChain.closeAnonymizedProxy(ctx.persistentAnonymizedProxyUrl, true),
                        ctx.networkPolicy.timeouts.proxyOperationMs,
                        'Proxy close timeout'
                    );
                    ctx.persistentAnonymizedProxyUrl = null;
                }
                ctx.actProxy = '';
                ctx.connectedProfileId = null;
                ctx.connectedProfileName = null;
                ctx.connectedResolvedVars = {};
                await ctx.applyEffectiveTrafficMode(ctx.getCurrentTrafficMode(), null, {
                    source: 'quick-connect-profile.disconnect',
                });
                ctx.buildMenu();
                ctx.notifyProxyStatus();
                return { success: true };
            }
            const encData = ctx.db.getProxyProfileEncrypted(profileId);
            if (!encData) return { success: false, error: 'Profile not found' };
            let raw = encData.url_encrypted
                ? ctx.safeStorage.decryptString(encData.url_encrypted)
                : encData.url_display || '';
            const savedVars = encData.variables
                ? (typeof encData.variables === 'string' ? JSON.parse(encData.variables) : encData.variables)
                : {};
            const resolvedUrl = ctx.parseProxyTemplate(raw, savedVars);
            await ctx.quickChangeProxy(resolvedUrl);
            const profileTrafficMode = ctx.normalizeTrafficMode(encData.traffic_mode);
            if (encData.traffic_mode && encData.traffic_mode !== profileTrafficMode) {
                ctx.sysLog('warn', 'traffic.mode.fallback', `Invalid profile mode "${encData.traffic_mode}" -> "${profileTrafficMode}"`);
            }
            await ctx.applyEffectiveTrafficMode(profileTrafficMode, ctx.persistentAnonymizedProxyUrl, {
                source: 'quick-connect-profile',
                profileId,
                force: true,
            });
            // Apply fingerprint from this profile
            ctx.activeFingerprint = {
                user_agent: encData.user_agent || null,
                timezone:   encData.timezone   || null,
                language:   encData.language   || null,
            };
            await ctx.applyFingerprintToAllTabs(ctx.activeFingerprint);
            ctx.connectedProfileId = profileId;
            ctx.connectedProfileName = encData.name || null;
            ctx.buildMenu();
            ctx.notifyProxyStatus();
            // No reload needed — MITM upstream switches instantly
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerQuickConnectIpc };
