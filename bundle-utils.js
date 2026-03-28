'use strict';

const crypto = require('crypto');
const { getExportWsFrameLimit } = require('./har-exporter');
const { getSessionEgressMeta } = require('./session-egress-meta');

/** Max rows per table for bundle export (`CUPNET_BUNDLE_MAX_ROWS`, default 50_000). `0` = use ceiling. */
function getBundleMaxRows() {
    const raw = process.env.CUPNET_BUNDLE_MAX_ROWS;
    if (raw === '0' || raw === '') return 500_000_000;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return 50_000;
    return Math.min(n, 500_000_000);
}

const BUNDLE_SCHEMA_VERSION = 'cupnet.bundle.v1';
const PROTECTION_LEVELS = new Set(['Raw', 'Balanced', 'Strict']);

function sha256Hex(input) {
    return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function mkMarker(kind, value) {
    const str = String(value || '');
    return `<REDACTED:${kind},len=${str.length}>`;
}

function looksSensitiveKey(key) {
    const k = String(key || '').toLowerCase();
    return [
        'authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
        'token', 'secret', 'password', 'passwd', 'session', 'sid',
    ].some(p => k.includes(p));
}

function redactStringValue(raw, level, fieldPath, report) {
    let v = String(raw || '');
    let changed = false;

    const before = v;
    v = v.replace(/Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi, (m) => {
        changed = true;
        return `Bearer ${mkMarker('bearer', m.replace(/^Bearer\s+/i, ''))}`;
    });
    v = v.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => {
        changed = true;
        const domain = m.split('@')[1] || '';
        return `<REDACTED:email_domain=${domain}>`;
    });
    v = v.replace(/(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s&;,]+)/gi, (m, k, value) => {
        changed = true;
        return `${k}=${mkMarker('credential', value)}`;
    });

    if (level === 'Strict') {
        const strictBefore = v;
        v = v.replace(/[A-Za-z0-9_\-]{16,}/g, (m) => `<REDACTED:string,len=${m.length}>`);
        if (strictBefore !== v) changed = true;
    }

    if (changed || before !== v) {
        report.redactedFieldsCount++;
        report.fields.push({ path: fieldPath, rule: level === 'Strict' ? 'pattern+strict' : 'pattern' });
    }
    return v;
}

function redactHeaders(headers, level, report, prefix) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const [k, value] of Object.entries(headers)) {
        const path = `${prefix}.${k}`;
        if (looksSensitiveKey(k)) {
            report.redactedFieldsCount++;
            report.fields.push({ path, rule: 'sensitive-header-key' });
            if (Array.isArray(value)) out[k] = value.map(v => mkMarker('header', v));
            else out[k] = mkMarker('header', value);
            continue;
        }
        if (Array.isArray(value)) out[k] = value.map(v => redactStringValue(v, level, path, report));
        else out[k] = redactStringValue(value, level, path, report);
    }
    return out;
}

function redactBody(body, level, report, prefix) {
    if (body == null) return body;
    const bodyStr = String(body);
    if (level === 'Strict') {
        // Keep evidence but avoid leaking sensitive payload.
        report.redactedFieldsCount++;
        report.fields.push({ path: prefix, rule: 'strict-body-summary' });
        return JSON.stringify({
            redacted: true,
            preview: bodyStr.slice(0, 120),
            original_length: bodyStr.length,
            sha256: sha256Hex(bodyStr),
        });
    }
    return redactStringValue(bodyStr, level, prefix, report);
}

function parseJsonSafely(text) {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch { return null; }
}

function normalizeWsEventRow(row) {
    if (!row || typeof row !== 'object') return null;
    return {
        id: row.id,
        session_id: row.session_id ?? null,
        tab_id: row.tab_id ?? null,
        url: row.url || '',
        direction: row.direction || '',
        payload: row.payload ?? null,
        connection_id: row.connection_id ?? null,
        created_at: row.created_at ?? null,
    };
}

function redactWsEventRecord(record, level, report) {
    if (level === 'Raw') return record;
    const out = { ...record };
    out.payload = redactBody(out.payload, level, report, `ws.${record.id}.payload`);
    if (out.url) out.url = redactStringValue(out.url, level, `ws.${record.id}.url`, report);
    return out;
}

/**
 * @param {object} db
 * @param {number|null} sessionId
 * @param {object[]} requestRows — normalized or raw request rows
 * @param {boolean} partialExport — true if user chose specific request IDs (do not dump whole session WS)
 */
function collectWsEventsForBundle(db, sessionId, requestRows, partialExport) {
    if (!db || typeof db.queryWsEvents !== 'function') return [];
    const merged = new Map();
    const pushRow = (ev) => {
        const n = normalizeWsEventRow(ev);
        if (n) merged.set(n.id, n);
    };
    const isWs = (r) => String(r.type || '').toLowerCase() === 'websocket';
    const handshakes = (requestRows || []).filter(isWs);
    if (handshakes.length) {
        for (const r of handshakes) {
            const sid = r.session_id ?? sessionId;
            if (!sid || !r.url) continue;
            const list = db.queryWsEvents(sid, r.tab_id ?? null, r.url, null, getExportWsFrameLimit());
            for (const ev of list) {
                pushRow({
                    id: ev.id,
                    session_id: sid,
                    tab_id: r.tab_id ?? null,
                    url: r.url,
                    direction: ev.direction,
                    payload: ev.payload,
                    connection_id: ev.connection_id,
                    created_at: ev.created_at,
                });
            }
        }
    } else if (sessionId && !partialExport && typeof db.queryWsEventsBySession === 'function') {
        for (const ev of db.queryWsEventsBySession(Number(sessionId), getExportWsFrameLimit())) {
            pushRow(ev);
        }
    }
    return [...merged.values()].sort((a, b) => a.id - b.id);
}

function normalizeRequestRow(row) {
    if (!row || typeof row !== 'object') return null;
    return {
        id: row.id,
        session_id: row.session_id ?? null,
        tab_id: row.tab_id ?? null,
        request_id: row.request_id ?? null,
        url: row.url || '',
        method: row.method || 'GET',
        status: row.status ?? null,
        type: row.type || null,
        duration_ms: row.duration_ms ?? null,
        request_headers: parseJsonSafely(row.request_headers) || {},
        response_headers: parseJsonSafely(row.response_headers) || {},
        request_body: row.request_body ?? null,
        response_body: row.response_body ?? null,
        error: row.error ?? null,
        host: row.host ?? null,
        tag: row.tag ?? null,
        note: row.note ?? null,
        created_at: row.created_at ?? null,
    };
}

function redactRequestRecord(record, level, report) {
    if (level === 'Raw') return record;
    const out = { ...record };
    out.request_headers = redactHeaders(out.request_headers, level, report, `request.${record.id}.request_headers`);
    out.response_headers = redactHeaders(out.response_headers, level, report, `request.${record.id}.response_headers`);
    out.request_body = redactBody(out.request_body, level, report, `request.${record.id}.request_body`);
    out.response_body = redactBody(out.response_body, level, report, `request.${record.id}.response_body`);
    if (out.url) out.url = redactStringValue(out.url, level, `request.${record.id}.url`, report);
    if (out.error) out.error = redactStringValue(out.error, level, `request.${record.id}.error`, report);
    return out;
}

function pickContext(db) {
    let rules = [];
    let interceptRules = [];
    let dnsOverrides = [];
    try { rules = db.getRules ? db.getRules() : []; } catch {}
    try { interceptRules = db.getAllInterceptRules ? db.getAllInterceptRules() : []; } catch {}
    try { dnsOverrides = db.getDnsOverrides ? db.getDnsOverrides() : []; } catch {}
    return { rules, interceptRules, dnsOverrides };
}

function buildBundle({ db, sessionId, requestIds, protectionLevel = 'Raw', appVersion = 'unknown' }) {
    const level = PROTECTION_LEVELS.has(protectionLevel) ? protectionLevel : 'Raw';
    const report = {
        redactedFieldsCount: 0,
        fields: [],
    };

    const maxRows = getBundleMaxRows();
    let rows = [];
    const partialExport = Array.isArray(requestIds) && requestIds.length > 0;
    if (partialExport) {
        rows = requestIds.map(id => db.getRequest(Number(id))).filter(Boolean);
    } else if (sessionId) {
        rows = db.queryRequestsFull({ sessionId: Number(sessionId) }, maxRows, 0);
    }
    const normalized = rows.map(normalizeRequestRow).filter(Boolean);
    const redacted = normalized.map(r => redactRequestRecord(r, level, report));

    const egressSessionId = sessionId != null && sessionId !== ''
        ? Number(sessionId)
        : (normalized[0]?.session_id != null ? Number(normalized[0].session_id) : null);

    let traceEntries = [];
    try {
        if (db.getTraceEntriesBySession && sessionId) traceEntries = db.getTraceEntriesBySession(Number(sessionId), maxRows, 0);
    } catch {}

    let websocketEvents = [];
    try {
        const rawWs = collectWsEventsForBundle(db, sessionId, rows, partialExport);
        websocketEvents = rawWs.map(ev => redactWsEventRecord(ev, level, report));
    } catch { /* ignore */ }

    const egress = Number.isFinite(egressSessionId) && egressSessionId > 0
        ? getSessionEgressMeta(db, egressSessionId)
        : getSessionEgressMeta(db, null);

    return {
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        meta: {
            exportedAt: new Date().toISOString(),
            appVersion,
            protectionLevel: level,
            redactionRulesVersion: 'v1',
            redactionReport: report,
            sourceSessionId: sessionId != null && sessionId !== ''
                ? Number(sessionId)
                : (Number.isFinite(egressSessionId) && egressSessionId > 0 ? egressSessionId : null),
            egress: {
                ip: egress.ip,
                country: egress.country,
                location: egress.location || null,
                profile: egress.profile || null,
                sessionProxyInfo: egress.sessionProxyInfo || null,
            },
        },
        traffic: {
            requests: redacted,
            trace: traceEntries,
            websocketEvents,
        },
        context: pickContext(db),
        notes: {
            summary: '',
            hypothesis: '',
            owner: '',
        },
    };
}

function validateBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return { ok: false, error: 'Invalid bundle object' };
    if (bundle.schemaVersion !== BUNDLE_SCHEMA_VERSION) return { ok: false, error: 'Unsupported schemaVersion' };
    if (!bundle.meta || !bundle.traffic || !bundle.context) return { ok: false, error: 'Bundle structure mismatch' };
    if (!bundle.meta.protectionLevel || !PROTECTION_LEVELS.has(bundle.meta.protectionLevel)) {
        return { ok: false, error: 'Invalid protection level in bundle' };
    }
    if (!Array.isArray(bundle.traffic.requests)) return { ok: false, error: 'traffic.requests must be array' };
    if (bundle.traffic.websocketEvents != null && !Array.isArray(bundle.traffic.websocketEvents)) {
        return { ok: false, error: 'traffic.websocketEvents must be array if present' };
    }
    return { ok: true };
}

module.exports = {
    BUNDLE_SCHEMA_VERSION,
    buildBundle,
    validateBundle,
};

