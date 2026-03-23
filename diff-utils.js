'use strict';

function parseHeaders(headers) {
    if (!headers) return {};
    if (typeof headers === 'string') {
        try { return JSON.parse(headers); } catch { return {}; }
    }
    return headers;
}

function normalizeBody(body) {
    const raw = body == null ? '' : String(body);
    const compact = raw.replace(/\s+/g, ' ').trim();
    return {
        raw,
        compact,
        length: raw.length,
    };
}

function trimBody(raw, limit = 20000) {
    const text = raw == null ? '' : String(raw);
    if (text.length <= limit) return { text, truncated: false };
    return { text: text.slice(0, limit), truncated: true };
}

function headerDiff(a, b) {
    const left = parseHeaders(a);
    const right = parseHeaders(b);
    const leftKeys = new Set(Object.keys(left).map(k => k.toLowerCase()));
    const rightKeys = new Set(Object.keys(right).map(k => k.toLowerCase()));
    const all = new Set([...leftKeys, ...rightKeys]);
    const added = [];
    const removed = [];
    const changed = [];

    for (const k of all) {
        const lEntry = Object.entries(left).find(([hk]) => hk.toLowerCase() === k);
        const rEntry = Object.entries(right).find(([hk]) => hk.toLowerCase() === k);
        const lVal = lEntry ? JSON.stringify(lEntry[1]) : null;
        const rVal = rEntry ? JSON.stringify(rEntry[1]) : null;
        if (lVal == null && rVal != null) added.push({ key: rEntry[0], value: rEntry[1] });
        else if (lVal != null && rVal == null) removed.push({ key: lEntry[0], value: lEntry[1] });
        else if (lVal !== rVal) changed.push({ key: lEntry[0], before: lEntry[1], after: rEntry[1] });
    }

    return { added, removed, changed };
}

function pathWithoutQuery(url) {
    try {
        const u = new URL(String(url || ''));
        return u.pathname || '/';
    } catch {
        const raw = String(url || '');
        const q = raw.indexOf('?');
        return q === -1 ? raw : raw.slice(0, q);
    }
}

function requestMatchKey(req) {
    if (!req) return '';
    const method = String(req.method || 'GET').toUpperCase();
    const path = pathWithoutQuery(req.url || '');
    return `${method} ${path}`;
}

function compareRequests(leftReq, rightReq) {
    if (!leftReq || !rightReq) {
        return { ok: false, error: 'Both requests are required' };
    }

    const leftRespBody = normalizeBody(leftReq.response_body || leftReq.responseBody);
    const rightRespBody = normalizeBody(rightReq.response_body || rightReq.responseBody);
    const leftReqBody = normalizeBody(leftReq.request_body || leftReq.requestBody);
    const rightReqBody = normalizeBody(rightReq.request_body || rightReq.requestBody);

    const reqHeaderDiff = headerDiff(leftReq.request_headers, rightReq.request_headers);
    const respHeaderDiff = headerDiff(leftReq.response_headers, rightReq.response_headers);
    const leftReqTrim = trimBody(leftReqBody.raw);
    const rightReqTrim = trimBody(rightReqBody.raw);
    const leftRespTrim = trimBody(leftRespBody.raw);
    const rightRespTrim = trimBody(rightRespBody.raw);

    const methodChanged = String(leftReq.method || '').toUpperCase() !== String(rightReq.method || '').toUpperCase();
    const urlChanged = String(leftReq.url || '') !== String(rightReq.url || '');
    const statusChanged = Number(leftReq.status || 0) !== Number(rightReq.status || 0);
    const latencyDelta = Number(rightReq.duration_ms || 0) - Number(leftReq.duration_ms || 0);

    const summary = {
        methodChanged,
        urlChanged,
        statusChanged,
        requestHeadersChanged: reqHeaderDiff.added.length + reqHeaderDiff.removed.length + reqHeaderDiff.changed.length,
        responseHeadersChanged: respHeaderDiff.added.length + respHeaderDiff.removed.length + respHeaderDiff.changed.length,
        requestBodyChanged: leftReqBody.compact !== rightReqBody.compact,
        responseBodyChanged: leftRespBody.compact !== rightRespBody.compact,
        latencyDeltaMs: latencyDelta,
        impact: {
            breaking: statusChanged || methodChanged,
            auth: reqHeaderDiff.changed.some(h => /authorization|cookie|token/i.test(h.key)),
            schema: respHeaderDiff.changed.some(h => /content-type/i.test(h.key)),
            latency: Math.abs(latencyDelta) > 300,
        },
    };

    return {
        ok: true,
        left: {
            id: leftReq.id,
            method: leftReq.method || 'GET',
            url: leftReq.url || '',
            status: leftReq.status || null,
            duration_ms: leftReq.duration_ms || null,
        },
        right: {
            id: rightReq.id,
            method: rightReq.method || 'GET',
            url: rightReq.url || '',
            status: rightReq.status || null,
            duration_ms: rightReq.duration_ms || null,
        },
        summary,
        request: {
            headers: reqHeaderDiff,
            body: {
                beforeLength: leftReqBody.length,
                afterLength: rightReqBody.length,
                beforePreview: leftReqBody.raw.slice(0, 400),
                afterPreview: rightReqBody.raw.slice(0, 400),
                beforeText: leftReqTrim.text,
                afterText: rightReqTrim.text,
                beforeTruncated: leftReqTrim.truncated,
                afterTruncated: rightReqTrim.truncated,
            },
        },
        response: {
            headers: respHeaderDiff,
            body: {
                beforeLength: leftRespBody.length,
                afterLength: rightRespBody.length,
                beforePreview: leftRespBody.raw.slice(0, 800),
                afterPreview: rightRespBody.raw.slice(0, 800),
                beforeText: leftRespTrim.text,
                afterText: rightRespTrim.text,
                beforeTruncated: leftRespTrim.truncated,
                afterTruncated: rightRespTrim.truncated,
            },
        },
    };
}

module.exports = {
    compareRequests,
    pathWithoutQuery,
    requestMatchKey,
};

