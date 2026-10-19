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
    ctx.mitmProxy?.setForceHttp1?.(false);
    // Disconnect is an intentional switch to direct — clear any fail-closed egress block.
    ctx.mitmProxy?.setEgressBlocked?.(false);
    await ctx.applyEffectiveTrafficMode?.(ctx.getCurrentTrafficMode?.(), null, {
        source: 'disconnect-proxy',
        force: true,
    });

    // Drop the connected profile's identity override → back to the global browser identity
    // (identity-service re-applies TLS/JA3/forceHttp1/UA/timezone/language everywhere).
    if (ctx.identityService) {
        ctx.identityService.setGeoHint(null, { skipApply: true });
        await ctx.identityService.setProxyOverride(null, { reason: 'proxy-disconnect' });
    } else {
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

        // Identity is global and managed only in Browser ID — connecting a proxy never changes it.
        // (Proxy Manager is proxy-only; per-profile identity overrides were removed.)
        if (ctx.identityService) {
            await ctx.identityService.setProxyOverride(null, { reason: 'proxy-connect' });
        }

        // Proxy is up — ensure egress is allowed again.
        ctx.mitmProxy?.setEgressBlocked?.(false);

        ctx.connectedProfileId = profileId;
        ctx.connectedProfileName = row.name || null;
        ctx.connectedResolvedVars = resolvedVars || {};
        ctx.buildMenu?.();
        ctx.notifyProxyStatus?.();

        ctx.checkCurrentIpGeo?.().then((geo) => {
            // Identity may follow the egress country (timezone / Accept-Language) — identity-service decides.
            if (ctx.identityService && ctx.connectedProfileId === profileId) {
                ctx.identityService.setGeoHint(geo, { reason: 'proxy-geo' }).catch(() => {});
            }
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
        // Fail closed: the user asked for a proxy profile and it could not be established.
        // Block egress instead of silently routing direct (which would leak the real IP).
        ctx.sysLog?.('warn', 'proxy', `connect global proxy failed, blocking egress (fail-closed): ${e?.message || e}`);
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
            // Keep MITM sessions consistent (no upstream) but refuse to route until a proxy works.
            ctx.mitmProxy?.setEgressBlocked?.(true, `Proxy profile "${row.name || profileId}" failed to connect`);
            // force: persistentAnonymizedProxyUrl is already null here, so without it the apply sees
            // "same mode, same proxy" and returns early, leaving the MITM upstream on the old proxy (or a
            // closed local port) (A-037). setUpstream(null) inside the apply keeps the block in place.
            await ctx.applyEffectiveTrafficMode?.(profileTrafficMode, null, {
                source: 'connect-proxy-template.failclosed',
                profileId,
                force: true,
            });
            ctx.buildMenu?.();
            ctx.notifyProxyStatus?.();
        } catch (fallbackErr) {
            ctx.sysLog?.('warn', 'proxy', `egress block after proxy failure also failed: ${fallbackErr?.message || fallbackErr}`);
        }
        return { success: false, error: e.message, fallback: 'blocked' };
    }
}

module.exports = {
    disconnectGlobalProxy,
    connectGlobalProxyProfile,
};
