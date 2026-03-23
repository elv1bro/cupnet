'use strict';

const db = require('./db');

/** Limit stored body text in HAR to reduce memory / file size (H5 partial). */
const HAR_MAX_BODY_CHARS = 1024 * 1024;

function _truncateHarText(text) {
    if (text == null || text === '') return text;
    const s = typeof text === 'string' ? text : String(text);
    if (s.length <= HAR_MAX_BODY_CHARS) return s;
    return s.slice(0, HAR_MAX_BODY_CHARS) + '\n… [truncated by CupNet HAR_MAX_BODY_CHARS]';
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

    const entries = [];
    for (const full of rows) {

        const reqHeaders  = safeParseObj(full.request_headers);
        const respHeaders = safeParseObj(full.response_headers);

        const startedDateTime = full.created_at
            ? new Date(full.created_at).toISOString()
            : new Date().toISOString();

        const reqBodyText = full.request_body ? _truncateHarText(full.request_body) : null;
        const respBodyText = full.response_body ? _truncateHarText(full.response_body) : '';
        entries.push({
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
                bodySize: full.request_body ? full.request_body.length : -1,
                postData: full.request_body
                    ? { mimeType: getContentType(reqHeaders), text: reqBodyText }
                    : undefined
            },
            response: {
                status: full.status || 0,
                statusText: statusText(full.status),
                httpVersion: 'HTTP/1.1',
                headers: objToHarHeaders(respHeaders),
                cookies: [],
                content: {
                    size: full.response_body ? full.response_body.length : -1,
                    mimeType: getContentType(respHeaders) || 'application/octet-stream',
                    text: respBodyText
                },
                redirectURL: '',
                headersSize: -1,
                bodySize: full.response_body ? full.response_body.length : -1
            },
            cache: {},
            timings: { send: 0, wait: full.duration_ms || -1, receive: 0 },
            _tabId: full.tab_id,
            _sessionId: full.session_id
        });
    }

    return {
        log: {
            version: '1.2',
            creator: { name: 'CupNet', version: '2.0', comment: '' },
            browser: { name: 'Electron', version: process.versions.electron || '', comment: '' },
            pages: buildPages(sessionId, entries),
            entries
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

module.exports = { exportHar };
