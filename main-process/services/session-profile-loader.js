const { confirmOpenAnotherTab } = require('../services/tab-open-confirm');
const { parseLaunchProfile } = require('../../session-profile');
const { upsertLastSessionProxyProfile, LAST_SESSION_PROXY_NAME } = require('./session-profile-proxy');
const { disconnectGlobalProxy, connectGlobalProxyProfile } = require('./global-proxy-connect');

/**
 * Apply a parsed session profile to a tab (create tab, proxy, cookies, navigate, storage, script).
 * @param {object} ctx — main-process IPC context
 * @param {import('../../session-profile').NormalizedSessionProfile} profile
 * @param {{ urlOverride?: string, newTab?: boolean|null }} [opts]
 */
async function loadSessionProfile(ctx, profile, opts = {}) {
    const urlOverride = opts.urlOverride ? String(opts.urlOverride).trim() : '';
    const profileUrl = profile.navigate?.url ? String(profile.navigate.url).trim() : '';
    const targetUrl = urlOverride || profileUrl;
    const dialogParent = ctx.sessionProfileModalWindow && !ctx.sessionProfileModalWindow.isDestroyed?.()
        ? ctx.sessionProfileModalWindow
        : null;

    const wantNewTab = opts.newTab != null ? !!opts.newTab : profile.tab.newTab;

    if (wantNewTab && !(await confirmOpenAnotherTab(ctx, dialogParent))) {
        return { success: false, error: 'Tab limit cancelled' };
    }

    let proxyProfileId = null;
    if (profile.proxy) {
        const proxyPrep = await _prepareGlobalProxyForSession(ctx, profile);
        if (!proxyPrep.success) {
            return { success: false, error: proxyPrep.error || 'Proxy setup failed' };
        }
        proxyProfileId = proxyPrep.profileId ?? null;
    }

    let tabId;

    if (wantNewTab) {
        const cookieGroupId = profile.tab.cookieGroupId || 1;
        tabId = await ctx.tabManager.createTab({
            url: null,
            cookieGroupId,
            baseUrl: targetUrl,
        });
        ctx.tabManager.switchTab(tabId);
        ctx.notifyCookieManagerTabs?.();
    } else {
        tabId = ctx.tabManager.getActiveTabId();
        if (!tabId) return { success: false, error: 'No active tab' };
    }

    const tab = ctx.tabManager.getTab(tabId);
    if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
        return { success: false, error: 'Tab not available' };
    }

    if (profile.proxy) {
        await ctx.tabManager.setTabProxy(tabId, null);
        if (ctx.mitmProxy) ctx.mitmProxy.removeTabUpstream(tabId);
    }

    if (profile.logging.recording != null) {
        ctx.isLoggingEnabled = !!profile.logging.recording;
        ctx.sendLogStatus?.();
    }

    if (profile.persistDnsOverrides && profile.dnsOverrides?.length && ctx.db?.saveDnsOverrideAsync) {
        for (const rule of profile.dnsOverrides) {
            try {
                await ctx.db.saveDnsOverrideAsync({
                    host: rule.host,
                    ip: rule.ip || '',
                    enabled: rule.enabled !== false,
                    rewrite_host: rule.rewrite_host || '',
                });
            } catch (e) {
                ctx.sysLog?.('warn', 'session-profile', `DNS override save failed: ${e?.message || e}`);
            }
        }
        ctx.syncDnsOverridesToMitm?.();
    }

    await _applyFingerprint(ctx, tab, profile);

    if (profile.clearCookiesBeforeLoad) {
        try {
            const all = await tab.tabSession.cookies.get({});
            for (const c of all) {
                const u = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
                try { await tab.tabSession.cookies.remove(u, c.name); } catch { /* ignore */ }
            }
            await tab.tabSession.cookies.flushStore();
        } catch { /* ignore */ }
    }

    if (profile.clearStorageBeforeLoad) {
        try { await tab.tabSession.clearStorageData(); } catch { /* ignore */ }
    }

    let cookiesOk = 0;
    let cookiesFail = 0;
    for (const c of profile.cookies) {
        try {
            await tab.tabSession.cookies.set(c);
            cookiesOk++;
        } catch {
            cookiesFail++;
        }
    }
    if (profile.cookies.length) {
        try { await tab.tabSession.cookies.flushStore(); } catch { /* ignore */ }
    }

    const wc = tab.view.webContents;
    ctx.tabManager.ensureActiveTabViewVisible?.();

    let navigationStarted = false;
    if (targetUrl && /^https?:\/\//i.test(targetUrl)) {
        const navigated = ctx.tabManager.navigate(targetUrl, tabId);
        if (!navigated) {
            return { success: false, error: 'Navigation could not start', tabId, cookiesOk, cookiesFail };
        }
        navigationStarted = true;
        _scheduleAfterNavigation(wc, profile, ctx);
    } else {
        ctx.sysLog?.('info', 'session-profile', `Context applied tab=${tabId} (no navigation)`);
    }

    void _attachTabServices(ctx, tab);

    if (typeof ctx.notifyProxyStatus === 'function') ctx.notifyProxyStatus();

    ctx.sysLog?.('info', 'session-profile', navigationStarted
        ? `Started navigation tab=${tabId} url=${targetUrl.slice(0, 120)}`
        : `Applied launch context tab=${tabId}`);

    return {
        success: true,
        tabId,
        url: targetUrl || null,
        cookiesOk,
        cookiesFail,
        name: profile.name,
        navigationStarted,
        proxyProfileId: proxyProfileId ?? null,
    };
}

async function _prepareGlobalProxyForSession(ctx, profile) {
    const proxy = profile.proxy;
    if (!proxy) return { success: true, profileId: null };

    ctx.sysLog?.('info', 'session-profile', 'Disconnecting proxy before session load');
    try {
        await disconnectGlobalProxy(ctx, { skipSnapshot: true });
    } catch (e) {
        return { success: false, error: `Disconnect failed: ${e?.message || e}` };
    }

    let profileId = null;
    if (proxy.template) {
        profileId = await upsertLastSessionProxyProfile(ctx, proxy, profile.fingerprint);
        if (!profileId) {
            return { success: false, error: 'Failed to refresh last_session_proxy' };
        }
        ctx.sysLog?.('info', 'session-profile', `Refreshed ${LAST_SESSION_PROXY_NAME} (#${profileId})`);
    } else if (proxy.profileId) {
        profileId = proxy.profileId;
    } else {
        return { success: false, error: 'No proxy profile or template in session file' };
    }

    for (const t of ctx.tabManager?.getAllTabs?.() || []) {
        if (!t?.id) continue;
        await ctx.tabManager.setTabProxy(t.id, null);
        ctx.mitmProxy?.removeTabUpstream(t.id);
    }

    const result = await connectGlobalProxyProfile(ctx, profileId, proxy.variables || {});
    if (!result?.success) {
        return {
            success: false,
            error: result?.error || 'Proxy connect failed',
            profileId,
        };
    }

    ctx.sysLog?.('info', 'session-profile', `Global proxy connected: ${LAST_SESSION_PROXY_NAME} (#${profileId})`);
    return { success: true, profileId };
}

async function _attachTabServices(ctx, tab) {
    if (!tab) return;
    const sid = tab.sessionId ?? ctx.currentSessionId;
    if (sid != null) tab.sessionId = sid;
    if (ctx.setupNetworkLogging && tab.view?.webContents) {
        void ctx.setupNetworkLogging(tab.view.webContents, tab.id, sid).catch(() => {});
    }
    if (ctx.interceptor?.attachToSession) {
        try { ctx.interceptor.attachToSession(tab.tabSession, tab.id); } catch { /* ignore */ }
    }
}

async function _applyFingerprint(ctx, tab, profile) {
    if (!profile.fingerprint || !tab?.view?.webContents || tab.view.webContents.isDestroyed()) return;
    if (!ctx.applyFingerprintToWebContents) return;
    await ctx.applyFingerprintToWebContents(tab.view.webContents, {
        user_agent: profile.fingerprint.userAgent,
        language: profile.fingerprint.language,
        timezone: profile.fingerprint.timezone,
    });
}

function _scheduleAfterNavigation(wc, profile, ctx) {
    if (!wc || wc.isDestroyed()) return;

    const hasStorage = profile.storage && (
        _hasStorageKeys(profile.storage.localStorage) || _hasStorageKeys(profile.storage.sessionStorage)
    );
    const runAfter = profile.runAfterLoad?.script ? profile.runAfterLoad : null;
    if (!hasStorage && !runAfter) return;

    const timeoutMs = Math.min(
        Math.max(Number(profile.navigate?.timeoutMs) || 120000, 5000),
        300000,
    );

    let done = false;
    const finish = () => {
        if (done || !wc || wc.isDestroyed()) return;
        done = true;
        clearTimeout(timer);
        wc.removeListener('did-finish-load', onLoad);
        wc.removeListener('did-fail-load', onFail);
        void _runAfterNavigationTasks(wc, profile, ctx);
    };

    const onLoad = () => finish();
    const onFail = (_, code, desc) => {
        ctx.sysLog?.('warn', 'session-profile', `Navigation failed (${code}): ${desc || 'unknown'}`);
        finish();
    };

    wc.once('did-finish-load', onLoad);
    wc.once('did-fail-load', onFail);
    const timer = setTimeout(() => {
        ctx.sysLog?.('warn', 'session-profile', `Post-load tasks: navigation wait timed out after ${timeoutMs}ms`);
        finish();
    }, timeoutMs);
}

async function _runAfterNavigationTasks(wc, profile, ctx) {
    if (!wc || wc.isDestroyed()) return;

    if (profile.storage && (
        _hasStorageKeys(profile.storage.localStorage) || _hasStorageKeys(profile.storage.sessionStorage)
    )) {
        try {
            await wc.executeJavaScript(_buildStorageInjectScript(profile.storage), true);
        } catch (e) {
            ctx.sysLog?.('warn', 'session-profile', `Storage inject failed: ${e?.message || e}`);
        }
    }

    if (profile.runAfterLoad?.script) {
        const delayMs = profile.runAfterLoad.delayMs || 0;
        if (delayMs > 0) await _sleep(delayMs);
        try {
            await wc.executeJavaScript(profile.runAfterLoad.script, true);
        } catch (e) {
            ctx.sysLog?.('warn', 'session-profile', `Post-load script failed: ${e?.message || e}`);
        }
    }
}

function _buildStorageInjectScript(storage) {
    const loc = storage.localStorage || {};
    const ses = storage.sessionStorage || {};
    const lines = ["(function(){try{"];
    for (const [k, v] of Object.entries(loc)) {
        lines.push(`localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(String(v))});`);
    }
    for (const [k, v] of Object.entries(ses)) {
        lines.push(`sessionStorage.setItem(${JSON.stringify(k)},${JSON.stringify(String(v))});`);
    }
    lines.push('}catch(e){console.error("[CupNet session]",e);}})();');
    return lines.join('');
}

function _hasStorageKeys(map) {
    return map && typeof map === 'object' && Object.keys(map).length > 0;
}

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} ctx
 * @param {string|object} rawJson
 * @param {object} [opts]
 */
async function loadSessionProfileFromJson(ctx, rawJson, opts) {
    const parsed = parseLaunchProfile(rawJson);
    if (!parsed.ok) return { success: false, error: parsed.error };
    return loadSessionProfile(ctx, parsed.profile, opts);
}

module.exports = {
    loadSessionProfile,
    loadSessionProfileFromJson,
};
