'use strict';

/** @param {string|null|undefined} text */
function parseCupnetResponseBody(text) {
    const out = { profile: null, ip: null, location: null, mode: null };
    if (!text) return out;
    for (const raw of String(text).split('\n')) {
        const line = raw.trim();
        if (line.startsWith('Profile:')) out.profile = line.slice(8).trim();
        else if (line.startsWith('Mode:')) out.mode = line.slice(5).trim();
        else if (line.startsWith('IP:')) out.ip = line.slice(3).trim();
        else if (line.startsWith('Location:')) out.location = line.slice(9).trim();
    }
    return out;
}

/**
 * IP / country for HAR & bundle export. Uses earliest cupnet snapshot row, else first cupnet row.
 * @param {object} db — CupNet db module API
 * @param {number|string|null} sessionId
 */
function getSessionEgressMeta(db, sessionId) {
    const sid = parseInt(String(sessionId), 10);
    const empty = {
        ip: 'unknown',
        country: 'unknown',
        location: '',
        profile: null,
        sessionProxyInfo: null,
    };
    if (!db || !Number.isFinite(sid)) return empty;

    let session = null;
    try { session = db.getSession(sid); } catch { session = null; }
    const sessionProxyInfo = session?.proxy_info || null;

    let rows = [];
    try {
        const sqlite = db.getDb && db.getDb();
        if (sqlite) {
            rows = sqlite.prepare(`
                SELECT id, method, response_body FROM requests
                WHERE session_id = ? AND LOWER(COALESCE(type, '')) = 'cupnet'
                ORDER BY id ASC
            `).all(sid);
        }
    } catch { rows = []; }

    let picked = null;
    for (const r of rows) {
        const m = String(r.method || '').toUpperCase();
        if (m.includes('PROXY') || m.includes('DIRECT')) {
            picked = r;
            break;
        }
    }
    if (!picked && rows.length) picked = rows[0];

    if (!picked) {
        return { ...empty, sessionProxyInfo };
    }

    const p = parseCupnetResponseBody(picked.response_body);
    const rawIp = p.ip && String(p.ip).trim() !== '' && p.ip !== '—' ? String(p.ip).trim() : '';
    const ip = rawIp || 'unknown';
    let country = 'unknown';
    const loc = p.location || '';
    if (loc) {
        const parts = loc.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 1) country = parts[parts.length - 1];
    }
    return {
        ip,
        country,
        location: loc,
        profile: p.profile,
        sessionProxyInfo,
    };
}

function formatEgressComment(meta, existing = '') {
    const ip = meta.ip || 'unknown';
    const country = meta.country || 'unknown';
    const loc = meta.location ? ` | Location: ${meta.location}` : '';
    const prof = meta.profile ? ` | Profile: ${meta.profile}` : '';
    const base = `Egress IP: ${ip} | Country: ${country}${loc}${prof}`;
    return existing ? `${existing} — ${base}` : base;
}

module.exports = {
    parseCupnetResponseBody,
    getSessionEgressMeta,
    formatEgressComment,
};
