'use strict';

const db = require('./db');
const { getSessionEgressMeta, formatEgressComment } = require('./session-egress-meta');

/**
 * Max chars for HTTP bodies and Chrome `_webSocketMessages[].data` in exported HAR.
 * `CUPNET_HAR_MAX_EXPORT_CHARS` or legacy `CUPNET_HAR_MAX_BODY_CHARS`.
 * Set to `0` for no truncation (full dump; large files possible).
 */
function getHarExportMaxChars() {
    const raw = process.env.CUPNET_HAR_MAX_EXPORT_CHARS ?? process.env.CUPNET_HAR_MAX_BODY_CHARS;
    if (raw === '0') return Number.MAX_SAFE_INTEGER;
    if (raw === undefined || raw === '') return 1024 * 1024;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 0 ? n : 1024 * 1024;
}

/**
 * Max WebSocket frames loaded per handshake / session for HAR and bundle (DB query limit).
 * `CUPNET_EXPORT_WS_FRAME_LIMIT` (default 5_000_000).
 */
function getExportWsFrameLimit() {
    const raw = process.env.CUPNET_EXPORT_WS_FRAME_LIMIT;
    if (raw === '0' || raw === '') return 500_000_000;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return 5_000_000;
    return Math.min(n, 500_000_000);
}

function truncateExportText(text) {
    if (text == null || text === '') return text;
    const s = typeof text === 'string' ? text : String(text);
    const max = getHarExportMaxChars();
    if (max === Number.MAX_SAFE_INTEGER || s.length <= max) return s;
    return s.slice(0, max) + '\n… [truncated by CupNet HAR export max chars]';
}

/** Strip `__b64__:` prefix and return pure base64 string, or null if body is plain text. */
function _parseB64Prefix(body) {
    if (!body || typeof body !== 'string') return null;
    if (body.startsWith('__b64__:')) return body.slice(8);
    return null;
}

/** Chrome HAR: send | receive, time in seconds, opcode 1 = text */
function buildWebSocketMessagesHar(rows) {
    if (!rows || !rows.length) return null;
    return rows.map((r) => {
        const dir = String(r.direction || '').toLowerCase();
        const type = dir === 'send' ? 'send' : 'receive';
        const time = r.created_at ? new Date(r.created_at).getTime() / 1000 : 0;
        return {
            type,
            time,
            opcode: 1,
            data: truncateExportText(r.payload),
        };
    });
}

/**
 * CupNet extension: full DB payload (no truncation), plus ids for correlation.
 */
function buildCupnetWebSocketMessages(rows) {
    if (!rows || !rows.length) return null;
    return rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        connection_id: r.connection_id ?? null,
        created_at: r.created_at ?? null,
        payload: r.payload == null ? null : String(r.payload),
    }));
}

/**
 * Sidecar JSON: all ws_events for session (no truncation). Written when CUPNET_HAR_WS_SIDECAR=1.
 */
function exportWebSocketSidecarPayload(sessionId) {
    const sid = parseInt(String(sessionId), 10);
    if (!sid) return null;
    const limit = getExportWsFrameLimit();
    const events = db.queryWsEventsBySession(sid, limit);
    return {
        schema: 'cupnet.ws_sidecar.v1',
        sessionId: sid,
        exportedAt: new Date().toISOString(),
        frameLimit: limit,
        events,
    };
}

/**
 * Exports requests from the SQLite DB as HAR 1.2 format.
 * @param {number|null} sessionId  – export only this session; null = all
 * @param {object}      filters    – same filters as db.queryRequests
 * @returns {object} HAR 1.2 object
 */
function exportHar(sessionId, filters = {}) {
    const mergedFilters = { ...filters };
    if (sessionId) mergedFilters.sessionId = sessionId;

    const total = db.countRequests(mergedFilters);
    const rows  = db.queryRequestsFull(mergedFilters, total, 0);

    const wsLimit = getExportWsFrameLimit();
    const entries = [];
    for (const full of rows) {

        const reqHeaders  = safeParseObj(full.request_headers);
        const respHeaders = safeParseObj(full.response_headers);

        const startedDateTime = full.created_at
            ? new Date(full.created_at).toISOString()
            : new Date().toISOString();

        const reqBodyRaw = full.request_body || null;
        const respBodyRaw = full.response_body || null;
        const reqB64 = _parseB64Prefix(reqBodyRaw);
        const respB64 = _parseB64Prefix(respBodyRaw);
        const reqBodyText = reqB64 ? truncateExportText(reqB64) : (reqBodyRaw ? truncateExportText(reqBodyRaw) : null);
        const respBodyText = respB64 ? truncateExportText(respB64) : (respBodyRaw ? truncateExportText(respBodyRaw) : '');
        const reqBodySize = reqB64 ? Math.ceil(reqB64.length * 3 / 4) : (reqBodyRaw ? reqBodyRaw.length : -1);
        const respBodySize = respB64 ? Math.ceil(respB64.length * 3 / 4) : (respBodyRaw ? respBodyRaw.length : -1);
        const entry = {
            startedDateTime,
            time: full.duration_ms || -1,
            request: {
                method: full.method || 'GET',
                url: full.url,
                httpVersion: 'HTTP/1.1',
                headers: objToHarHeaders(reqHeaders),
                queryString: parseQueryString(full.url),
                cookies: [],
                headersSize: -1,
                bodySize: reqBodySize,
                postData: reqBodyRaw
                    ? { mimeType: getContentType(reqHeaders), text: reqBodyText, ...(reqB64 ? { encoding: 'base64' } : {}) }
                    : undefined
            },
            response: {
                status: full.status || 0,
                statusText: statusText(full.status),
                httpVersion: 'HTTP/1.1',
                headers: objToHarHeaders(respHeaders),
                cookies: [],
                content: {
                    size: respBodySize,
                    mimeType: getContentType(respHeaders) || 'application/octet-stream',
                    text: respBodyText,
                    ...(respB64 ? { encoding: 'base64' } : {}),
                },
                redirectURL: '',
                headersSize: -1,
                bodySize: respBodySize
            },
            cache: {},
            timings: { send: 0, wait: full.duration_ms || -1, receive: 0 },
            _tabId: full.tab_id,
            _sessionId: full.session_id
        };
        if (String(full.type || '').toLowerCase() === 'websocket' && db.queryWsEvents) {
            try {
                const wsRows = db.queryWsEvents(
                    full.session_id,
                    full.tab_id ?? null,
                    full.url || '',
                    null,
                    wsLimit
                );
                const wm = buildWebSocketMessagesHar(wsRows);
                if (wm && wm.length) {
                    entry._webSocketMessages = wm;
                    const cup = buildCupnetWebSocketMessages(wsRows);
                    if (cup && cup.length) entry._cupnetWebSocketMessages = cup;
                }
            } catch { /* ignore */ }
        }
        entries.push(entry);
    }

    const egress = sessionId ? getSessionEgressMeta(db, sessionId) : getSessionEgressMeta(db, null);
    const baseCreatorComment = 'HTTP/WS export; _webSocketMessages Chrome-style; _cupnetWebSocketMessages full payloads; env CUPNET_HAR_* / CUPNET_EXPORT_WS_FRAME_LIMIT';
    const creatorComment = formatEgressComment(egress, baseCreatorComment);

    return {
        log: {
            version: '1.2',
            creator: {
                name: 'CupNet',
                version: '2.0',
                comment: creatorComment,
            },
            browser: { name: 'Electron', version: process.versions.electron || '', comment: '' },
            pages: buildPages(sessionId, entries),
            entries,
            _cupnet: {
                egressIp: egress.ip,
                egressCountry: egress.country,
                egressLocation: egress.location || null,
                egressProfile: egress.profile || null,
                sessionProxyInfo: egress.sessionProxyInfo || null,
            },
        }
    };
}

function buildPages(sessionId, entries) {
    if (!entries.length) return [];
    const pageId = `page_${sessionId || 'all'}`;
    const startedDateTime = entries[0] ? entries[0].startedDateTime : new Date().toISOString();
    return [{
        startedDateTime,
        id: pageId,
        title: sessionId ? `Session ${sessionId}` : 'All sessions',
        pageTimings: { onLoad: -1 }
    }];
}

function safeParseObj(str) {
    if (!str) return {};
    try { return JSON.parse(str); } catch { return {}; }
}

function objToHarHeaders(obj) {
    if (!obj || typeof obj !== 'object') return [];
    return Object.entries(obj).map(([name, value]) => ({
        name,
        value: Array.isArray(value) ? value.join(', ') : String(value)
    }));
}

function parseQueryString(url) {
    try {
        const u = new URL(url);
        const result = [];
        u.searchParams.forEach((value, name) => result.push({ name, value }));
        return result;
    } catch {
        return [];
    }
}

function getContentType(headers) {
    if (!headers) return '';
    const key = Object.keys(headers).find(k => k.toLowerCase() === 'content-type');
    return key ? String(headers[key]).split(';')[0].trim() : '';
}

function statusText(code) {
    const map = {
        200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content',
        301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
        400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
        404: 'Not Found', 405: 'Method Not Allowed', 429: 'Too Many Requests',
        500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable'
    };
    return map[code] || '';
}

module.exports = {
    exportHar,
    exportWebSocketSidecarPayload,
    getHarExportMaxChars,
    getExportWsFrameLimit,
};
