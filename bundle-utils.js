'use strict';

const crypto = require('crypto');

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

    let rows = [];
    if (Array.isArray(requestIds) && requestIds.length) {
        rows = requestIds.map(id => db.getRequest(Number(id))).filter(Boolean);
    } else if (sessionId) {
        rows = db.queryRequestsFull({ sessionId: Number(sessionId) }, 5000, 0);
    }
    const normalized = rows.map(normalizeRequestRow).filter(Boolean);
    const redacted = normalized.map(r => redactRequestRecord(r, level, report));

    let traceEntries = [];
    try {
        if (db.getTraceEntriesBySession && sessionId) traceEntries = db.getTraceEntriesBySession(Number(sessionId), 5000, 0);
    } catch {}

    return {
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        meta: {
            exportedAt: new Date().toISOString(),
            appVersion,
            protectionLevel: level,
            redactionRulesVersion: 'v1',
            redactionReport: report,
            sourceSessionId: sessionId ?? null,
        },
        traffic: {
            requests: redacted,
            trace: traceEntries,
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
    return { ok: true };
}

module.exports = {
    BUNDLE_SCHEMA_VERSION,
    buildBundle,
    validateBundle,
};

