'use strict';

const { insertCupnetTrafficSnapshot, insertCupnetTrafficSnapshotWithGeo } = require('../../services/cupnet-network-meta-log');

/**
 * Текущий прокси, connect/disconnect, профили, тесты.
 * @param {object} ctx
 */
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
        // Get the encrypted template URL from DB
        const row = ctx.db.getProxyProfileEncrypted(profileId);
        if (!row) return { success: false, error: 'Profile not found' };
        let template = null;
        if (row.url_encrypted && ctx.safeStorage.isEncryptionAvailable()) {
            try { template = ctx.safeStorage.decryptString(row.url_encrypted); } catch (e) { ctx.sysLog('warn', 'proxy', 'decrypt proxy template failed: ' + (e?.message || e)); }
        }
        if (!template) return { success: false, error: 'Cannot decrypt template' };

        const savedVars  = row.variables ? JSON.parse(row.variables) : {};
        const mergedVars = { ...savedVars, ...(ephemeralVars || {}) };
        const resolvedVars = {};
        const resolvedUrl = ctx.parseProxyTemplate(template, mergedVars, resolvedVars);
        const profileTrafficMode = ctx.normalizeTrafficMode(row.traffic_mode);
        if (row.traffic_mode && row.traffic_mode !== profileTrafficMode) {
            ctx.sysLog('warn', 'traffic.mode.fallback', `Invalid profile mode "${row.traffic_mode}" -> "${profileTrafficMode}"`);
        }
        const fallbackCandidates = ctx.parseFallbackProxyList(
            mergedVars.FALLBACK_PROXIES || mergedVars.fallback_proxies || mergedVars.fallbackProxies
        );

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

            // Apply fingerprint from profile
            ctx.activeFingerprint = {
                user_agent: row.user_agent || null,
                timezone:   row.timezone   || null,
                language:   row.language   || null,
            };
            if (ctx.activeFingerprint.user_agent) {
                // Apply session-level UA for each tab session (same as electron-app/app.js)
                for (const tab of ctx.tabManager.getAllTabs()) {
                    if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                        try {
                            tab.view.webContents.session.setUserAgent(
                                ctx.activeFingerprint.user_agent,
                                ctx.activeFingerprint.language || ''
                            );
                        } catch (e) {
                            ctx.sysLog('warn', 'fingerprint', 'setUserAgent for tab failed: ' + (e?.message || e));
                        }
                    }
                }
            }
            await ctx.applyFingerprintToAllTabs(ctx.activeFingerprint);

            // Apply TLS fingerprint profile
            if (ctx.mitmProxy) {
                const tlsMode    = row.tls_ja3_mode   || 'template';
                const tlsProfile = row.tls_profile    || 'chrome';
                const tlsJa3     = row.tls_ja3_custom || null;
                if (tlsMode === 'custom' && tlsJa3) {
                    // Custom JA3 → apply via worker
                    ctx.mitmProxy.setBrowser(tlsProfile);
                    if (ctx.mitmProxy.worker && ctx.mitmProxy.worker.ready) {
                        // Send a dummy request with ja3 to pre-warm the session with the custom fingerprint
                        // The ja3 is applied per-request in azure-tls-worker.js
                        ctx.mitmProxy._activeJa3 = tlsJa3;
                    }
                } else {
                    ctx.mitmProxy.setBrowser(tlsProfile);
                    ctx.mitmProxy._activeJa3 = null;
                }
                // Notify toolbar
                ctx.broadcastTlsProfileChanged(tlsProfile);
            }

            ctx.connectedProfileId = profileId;
            ctx.connectedProfileName = row.name || null;
            ctx.connectedResolvedVars = resolvedVars || {};
            ctx.buildMenu();
            ctx.notifyProxyStatus();

            ctx.checkCurrentIpGeo().then(geo => {
                ctx.db.updateProxyProfileGeoAsync(profileId, geo.ip, `${geo.city}, ${geo.country_name}`).catch((err) => {
                    ctx.safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'updateProxyProfileGeo', profileId } }, err);
                });
                ctx.notifyProxyProfilesList();
                insertCupnetTrafficSnapshot(ctx, {
                    mode: 'proxy',
                    profileName: row.name || null,
                    ip: geo?.ip && geo.ip !== 'unknown' ? geo.ip : '—',
                    country: geo?.country_name || '',
                    city: geo?.city || '',
                }).catch(() => {});
            }).catch((e) => {
                ctx.sysLog('warn', 'proxy', 'geo check after proxy connect failed: ' + (e?.message || e));
                insertCupnetTrafficSnapshotWithGeo(ctx, { mode: 'proxy', profileName: row.name || null }).catch(() => {});
            });
            return { success: true, resolvedUrl, resolvedVars };
        } catch (e) {
            ctx.sysLog('warn', 'proxy', 'connect-proxy-template failed, switching to direct mode: ' + (e?.message || e));
            try {
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
                await ctx.applyEffectiveTrafficMode(profileTrafficMode, null, {
                    source: 'connect-proxy-template.fallback',
                    profileId,
                });
                ctx.buildMenu();
                ctx.notifyProxyStatus();
            } catch (fallbackErr) {
                ctx.sysLog('warn', 'proxy', 'direct fallback after proxy failure also failed: ' + (fallbackErr?.message || fallbackErr));
            }
            return { success: false, error: e.message, fallback: 'direct' };
        }
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
                source: 'disconnect-proxy',
                force: true,
            });

            // Reset fingerprint overrides
            if (ctx.activeFingerprint) {
                for (const tab of ctx.tabManager.getAllTabs()) {
                    if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                        ctx.resetFingerprintOnWebContents(tab.view.webContents).catch(e => ctx.sysLog('warn', 'fingerprint', 'reset fingerprint on disconnect failed: ' + (e?.message || e)));
                    }
                }
                ctx.activeFingerprint = null;
            }

            ctx.buildMenu();
            ctx.notifyProxyStatus();
            await insertCupnetTrafficSnapshotWithGeo(ctx, { mode: 'direct' }).catch(() => {});
            // No reload needed — MITM upstream switches instantly
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('save-proxy-profile-full', async (_, profile) => {
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
        });
        ctx.notifyProxyProfilesList();
        return { success: true, id };
    });

    ctx.ipcMain.handle('test-proxy-template', async (_, profileId, ephemeralVars) => {
        const row = ctx.db.getProxyProfileEncrypted(profileId);
        if (!row) return { success: false, error: 'Profile not found' };
        let template = null;
        if (row.url_encrypted && ctx.safeStorage.isEncryptionAvailable()) {
            try { template = ctx.safeStorage.decryptString(row.url_encrypted); } catch (e) { ctx.sysLog('warn', 'proxy', 'decrypt test proxy template failed: ' + (e?.message || e)); }
        }
        if (!template) return { success: false, error: 'Cannot decrypt' };
        const savedVars  = row.variables ? JSON.parse(row.variables) : {};
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
    ctx.ipcMain.handle('get-proxy-profiles', async () => ctx.db.getProxyProfiles());

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
        return ctx.db.saveProxyProfileAsync(name, urlEncrypted, urlDisplay, country);
    });

    ctx.ipcMain.handle('get-proxy-profile-url', async (_, id) => {
        const row = ctx.db.getProxyProfileEncrypted(id);
        if (!row) return null;
        if (row.url_encrypted && ctx.safeStorage.isEncryptionAvailable()) {
            try { return ctx.safeStorage.decryptString(row.url_encrypted); } catch (e) { ctx.sysLog('warn', 'proxy', 'decrypt profile URL failed: ' + (e?.message || e)); }
        }
        return null;
    });

    ctx.ipcMain.handle('delete-proxy-profile', async (_, id) => { await ctx.db.deleteProxyProfileAsync(id); return true; });

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
}

module.exports = { registerProxyIpc };
