'use strict';

/**
 * Synthetic Network Activity rows for CupNet proxy / direct mode (not real HTTP).
 * @param {object} ctx — ipc scope (db, currentSessionId, isLoggingEnabled, logEntryCount, _broadcastLogEntryToViewers)
 * @param {object} snap
 * @param {'proxy'|'direct'} snap.mode
 * @param {string|null} [snap.profileName]
 * @param {string} [snap.ip]
 * @param {string} [snap.country]
 * @param {string} [snap.city]
 * @param {{ force?: boolean }} [opts] — force=true: insert even if logging flag still off (session bootstrap)
 */
async function insertCupnetTrafficSnapshot(ctx, snap, opts = {}) {
    if (!ctx.db || ctx.currentSessionId == null) return;
    if (!opts.force && !ctx.isLoggingEnabled) return;

    const mode = snap.mode === 'proxy' ? 'proxy' : 'direct';
    const isProxy = mode === 'proxy';
    const method = isProxy ? 'SET PROXY' : 'SET DIRECT';
    const url = isProxy ? 'cupnet://session/proxy' : 'cupnet://session/direct';
    const ip = snap.ip != null && String(snap.ip).trim() !== '' ? String(snap.ip).trim() : '—';
    const locParts = [snap.city, snap.country].filter(Boolean);
    const lines = isProxy
        ? [`Profile: ${snap.profileName != null && snap.profileName !== '' ? snap.profileName : '—'}`, `IP: ${ip}`]
        : [`Mode: direct`, `IP: ${ip}`];
    if (locParts.length) lines.push(`Location: ${locParts.join(', ')}`);
    const responseBody = lines.join('\n');

    const status = 204;
    const type = 'cupnet';

    const dbId = await ctx.db.insertRequestAsync(ctx.currentSessionId, null, {
        requestId: `cupnet_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        url,
        method,
        status,
        type,
        duration: 0,
        requestHeaders: { 'X-CupNet-Event': isProxy ? 'set-proxy' : 'set-direct' },
        responseHeaders: { 'content-type': 'text/plain; charset=utf-8' },
        requestBody: null,
        responseBody,
        error: null,
    });
    if (!dbId) return;
    ctx.logEntryCount++;
    const broadcast = ctx._broadcastLogEntryToViewers;
    if (typeof broadcast === 'function') {
        broadcast({
            id: dbId,
            url,
            method,
            status,
            type,
            duration: 0,
            duration_ms: 0,
            response: { statusCode: status, headers: { 'content-type': 'text/plain; charset=utf-8' } },
            responseBody,
            tabId: null,
            sessionId: ctx.currentSessionId,
        });
    }
}

async function insertCupnetTrafficSnapshotWithGeo(ctx, partial, opts = {}) {
    let geo = {};
    const needGeo = partial.ip == null || partial.ip === ''
        || (partial.country == null || partial.country === '')
        || (partial.city == null || partial.city === '');
    if (needGeo && typeof ctx.checkCurrentIpGeo === 'function') {
        try { geo = await ctx.checkCurrentIpGeo(); } catch (_) { geo = {}; }
    }
    const gIp = geo?.ip && geo.ip !== 'unknown' ? geo.ip : '';
    await insertCupnetTrafficSnapshot(ctx, {
        mode: partial.mode,
        profileName: partial.profileName ?? null,
        ip: partial.ip != null && partial.ip !== '' ? partial.ip : (gIp || '—'),
        country: partial.country != null && partial.country !== '' ? partial.country : (geo?.country_name || ''),
        city: partial.city != null && partial.city !== '' ? partial.city : (geo?.city || ''),
    }, opts);
}

function isGlobalProxyActive(ctx) {
    if (ctx.persistentAnonymizedProxyUrl) return true;
    const ap = ctx.actProxy;
    if (ap != null && String(ap).trim() !== '') return true;
    const cid = ctx.connectedProfileId;
    if (cid != null && cid !== '') return true;
    return false;
}

/** First row for a new logging session (before tab CDP attaches). */
async function insertSessionBootstrapTrafficRow(ctx) {
    const mode = isGlobalProxyActive(ctx) ? 'proxy' : 'direct';
    const profileName = mode === 'proxy' ? (ctx.connectedProfileName || null) : null;
    await insertCupnetTrafficSnapshotWithGeo(ctx, { mode, profileName }, { force: true });
}

module.exports = {
    insertCupnetTrafficSnapshot,
    insertCupnetTrafficSnapshotWithGeo,
    insertSessionBootstrapTrafficRow,
    isGlobalProxyActive,
};
