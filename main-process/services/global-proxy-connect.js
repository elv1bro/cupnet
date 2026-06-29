'use strict';

const { insertCupnetTrafficSnapshot, insertCupnetTrafficSnapshotWithGeo } = require('./cupnet-network-meta-log');
const { resolveProxyTemplateFromDbRow } = require('./proxy-profile-resolve');

function parseProxyVariablesJson(raw, ctx) {
    if (!raw) return {};
    try {
        return typeof raw === 'object' ? { ...raw } : JSON.parse(raw);
    } catch (e) {
        ctx.safeCatch?.({
            module: 'main',
            eventCode: 'proxy.profile.variables.parse.failed',
            context: { op: 'parseProxyVariablesJson' },
        }, e, 'info');
        return {};
    }
}

/**
 * Disconnect global proxy (MITM upstream direct, close proxy-chain tunnel).
 * @param {object} ctx
 * @param {{ skipSnapshot?: boolean }} [opts]
 */
async function disconnectGlobalProxy(ctx, opts = {}) {
    if (ctx.persistentAnonymizedProxyUrl) {
        await ctx.withTimeout?.(
            ctx.ProxyChain.closeAnonymizedProxy(ctx.persistentAnonymizedProxyUrl, true),
            ctx.networkPolicy?.timeouts?.proxyOperationMs,
            'Proxy close timeout',
        );
        ctx.persistentAnonymizedProxyUrl = null;
    }
    ctx.actProxy = '';
    ctx.connectedProfileId = null;
    ctx.connectedProfileName = null;
    ctx.connectedResolvedVars = {};
    await ctx.applyEffectiveTrafficMode?.(ctx.getCurrentTrafficMode?.(), null, {
        source: 'disconnect-proxy',
        force: true,
    });

    if (ctx.activeFingerprint) {
        for (const tab of ctx.tabManager?.getAllTabs?.() || []) {
            if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                ctx.resetFingerprintOnWebContents?.(tab.view.webContents).catch((e) => {
                    ctx.sysLog?.('warn', 'fingerprint', `reset fingerprint on disconnect failed: ${e?.message || e}`);
                });
            }
        }
        ctx.activeFingerprint = null;
    }

    ctx.buildMenu?.();
    ctx.notifyProxyStatus?.();
    if (!opts.skipSnapshot) {
        await insertCupnetTrafficSnapshotWithGeo(ctx, { mode: 'direct' }).catch(() => {});
    }
}

/**
 * Connect a Proxy Manager profile globally (MITM upstream + fingerprint for all tabs).
 * Same behavior as the connect-proxy-template IPC handler.
 * @param {object} ctx
 * @param {number} profileId
 * @param {Record<string, string>} [ephemeralVars]
 * @returns {Promise<{ success: boolean, resolvedUrl?: string, resolvedVars?: object, error?: string, fallback?: string }>}
 */
async function connectGlobalProxyProfile(ctx, profileId, ephemeralVars = {}) {
    const row = ctx.db?.getProxyProfileEncrypted?.(profileId);
    if (!row) return { success: false, error: 'Profile not found' };

    const savedVars = parseProxyVariablesJson(row.variables, ctx);
    const mergedVars = { ...savedVars, ...(ephemeralVars && typeof ephemeralVars === 'object' ? ephemeralVars : {}) };
    const resolvedVars = {};
    const resolvedUrl = resolveProxyTemplateFromDbRow(ctx, row, mergedVars);
    if (!resolvedUrl) return { success: false, error: 'Cannot resolve proxy template' };

    // Fill resolvedVars (SID, RAND, etc.) the same way connect-proxy-template does.
    if (ctx.parseProxyTemplate) {
        let template = null;
        if (row.url_encrypted && ctx.safeStorage?.isEncryptionAvailable()) {
            try { template = ctx.safeStorage.decryptString(row.url_encrypted); } catch { /* ignore */ }
        }
        if (!template && row.url_display && !String(row.url_display).includes('***')) {
            template = String(row.url_display);
        }
        if (template) ctx.parseProxyTemplate(template, mergedVars, resolvedVars);
    }

    const profileTrafficMode = ctx.normalizeTrafficMode?.(row.traffic_mode) || 'mitm';
    if (row.traffic_mode && row.traffic_mode !== profileTrafficMode) {
        ctx.sysLog?.('warn', 'traffic.mode.fallback', `Invalid profile mode "${row.traffic_mode}" -> "${profileTrafficMode}"`);
    }
    const fallbackCandidates = ctx.parseFallbackProxyList?.(
        mergedVars.FALLBACK_PROXIES || mergedVars.fallback_proxies || mergedVars.fallbackProxies,
    ) || [];

    try {
        const proxyConnect = await ctx.connectProxyWithFailover(resolvedUrl, fallbackCandidates);
        if (proxyConnect?.used && proxyConnect.used !== resolvedUrl) {
            resolvedVars.__usedFallbackProxy = proxyConnect.used;
        }
        await ctx.applyEffectiveTrafficMode(profileTrafficMode, ctx.persistentAnonymizedProxyUrl, {
            source: 'connect-proxy-template',
            profileId,
            force: true,
        });

        ctx.activeFingerprint = {
            user_agent: row.user_agent || null,
            timezone: row.timezone || null,
            language: row.language || null,
        };
        await ctx.applyFingerprintToAllTabs?.(ctx.activeFingerprint);

        if (ctx.mitmProxy) {
            const tlsMode = row.tls_ja3_mode || 'template';
            const tlsProfile = row.tls_profile || 'chrome';
            const tlsJa3 = row.tls_ja3_custom || null;
            if (tlsMode === 'custom' && tlsJa3) {
                ctx.mitmProxy.setBrowser(tlsProfile);
                ctx.mitmProxy._activeJa3 = tlsJa3;
            } else {
                ctx.mitmProxy.setBrowser(tlsProfile);
                ctx.mitmProxy._activeJa3 = null;
            }
            ctx.broadcastTlsProfileChanged?.(tlsProfile);
        }

        ctx.connectedProfileId = profileId;
        ctx.connectedProfileName = row.name || null;
        ctx.connectedResolvedVars = resolvedVars || {};
        ctx.buildMenu?.();
        ctx.notifyProxyStatus?.();

        ctx.checkCurrentIpGeo?.().then((geo) => {
            ctx.db?.updateProxyProfileGeoAsync?.(profileId, geo.ip, `${geo.city}, ${geo.country_name}`).catch((err) => {
                ctx.safeCatch?.({
                    module: 'main',
                    eventCode: 'db.write.failed',
                    context: { op: 'updateProxyProfileGeo', profileId },
                }, err);
            });
            ctx.notifyProxyProfilesList?.();
            insertCupnetTrafficSnapshot(ctx, {
                mode: 'proxy',
                profileName: row.name || null,
                ip: geo?.ip && geo.ip !== 'unknown' ? geo.ip : '—',
                country: geo?.country_name || '',
                city: geo?.city || '',
            }).catch(() => {});
        }).catch((e) => {
            ctx.sysLog?.('warn', 'proxy', `geo check after proxy connect failed: ${e?.message || e}`);
            insertCupnetTrafficSnapshotWithGeo(ctx, { mode: 'proxy', profileName: row.name || null }).catch(() => {});
        });

        return { success: true, resolvedUrl, resolvedVars };
    } catch (e) {
        ctx.sysLog?.('warn', 'proxy', `connect global proxy failed, switching to direct: ${e?.message || e}`);
        try {
            if (ctx.persistentAnonymizedProxyUrl) {
                await ctx.withTimeout?.(
                    ctx.ProxyChain.closeAnonymizedProxy(ctx.persistentAnonymizedProxyUrl, true),
                    ctx.networkPolicy?.timeouts?.proxyOperationMs,
                    'Proxy close timeout',
                );
                ctx.persistentAnonymizedProxyUrl = null;
            }
            ctx.actProxy = '';
            ctx.connectedProfileId = null;
            ctx.connectedProfileName = null;
            ctx.connectedResolvedVars = {};
            await ctx.applyEffectiveTrafficMode?.(profileTrafficMode, null, {
                source: 'connect-proxy-template.fallback',
                profileId,
            });
            ctx.buildMenu?.();
            ctx.notifyProxyStatus?.();
        } catch (fallbackErr) {
            ctx.sysLog?.('warn', 'proxy', `direct fallback after proxy failure also failed: ${fallbackErr?.message || fallbackErr}`);
        }
        return { success: false, error: e.message, fallback: 'direct' };
    }
}

module.exports = {
    disconnectGlobalProxy,
    connectGlobalProxyProfile,
};
