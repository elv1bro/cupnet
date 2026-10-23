'use strict';

/**
 * HAR 1.2 from CupNet mini session entries (session-log.js), streamed so a large session never needs
 * one big string. Bodies are exported in full; `__b64__:` bodies go out as base64 content.
 */

const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently',
    302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
    407: 'Proxy Authentication Required', 429: 'Too Many Requests', 500: 'Internal Server Error',
    502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function _headers(obj) {
    const out = [];
    for (const [name, value] of Object.entries(obj || {})) {
        if (Array.isArray(value)) for (const v of value) out.push({ name, value: String(v) });
        else out.push({ name, value: String(value) });
    }
    return out;
}

function _header(obj, name) {
    const k = Object.keys(obj || {}).find((x) => x.toLowerCase() === name);
    if (!k) return '';
    const v = obj[k];
    return String(Array.isArray(v) ? v[0] : v);
}

function _body(body) {
    if (body == null || body === '') return null;
    const s = String(body);
    if (s.startsWith('__b64__:')) {
        const b64 = s.slice(8);
        return { text: b64, encoding: 'base64', size: Buffer.byteLength(b64, 'base64') };
    }
    return { text: s, size: Buffer.byteLength(s, 'utf8') };
}

function _query(url) {
    try {
        const out = [];
        new URL(url).searchParams.forEach((value, name) => out.push({ name, value }));
        return out;
    } catch { return []; }
}

function _cookies(cookieHeader) {
    return String(cookieHeader || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return i < 0 ? { name: p, value: '' } : { name: p.slice(0, i), value: p.slice(i + 1) };
    });
}

/** One session entry (kind 'request') → HAR entry. */
function harEntry(e) {
    const reqH = e.requestHeaders || {};
    const resH = e.responseHeaders || {};
    const req = _body(e.requestBody);
    const res = _body(e.responseBody);
    const resMime = _header(resH, 'content-type') || 'application/octet-stream';
    const time = Number(e.duration) >= 0 ? Number(e.duration) : -1;
    const entry = {
        startedDateTime: new Date(e.ts || Date.now()).toISOString(),
        time,
        request: {
            method: e.method || 'GET',
            url: e.url,
            httpVersion: 'HTTP/1.1',
            headers: _headers(reqH),
            queryString: _query(e.url),
            cookies: _cookies(_header(reqH, 'cookie')),
            headersSize: -1,
            bodySize: req ? req.size : 0,
        },
        response: {
            status: Number(e.status) || 0,
            statusText: STATUS_TEXT[e.status] || '',
            httpVersion: 'HTTP/1.1',
            headers: _headers(resH),
            cookies: [],
            content: { size: res ? res.size : 0, mimeType: resMime, ...(res ? { text: res.text } : {}), ...(res?.encoding ? { encoding: res.encoding } : {}) },
            redirectURL: _header(resH, 'location'),
            headersSize: -1,
            bodySize: res ? res.size : 0,
        },
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
        _cupnetSeq: e.seq,
    };
    if (req) {
        entry.request.postData = {
            mimeType: _header(reqH, 'content-type') || 'application/octet-stream',
            text: req.text,
            ...(req.encoding ? { encoding: req.encoding } : {}),
        };
    }
    if (e.type) entry._resourceType = e.type;
    return entry;
}

/**
 * Write a HAR document for `entries` (an iterable of full session entries) to a writable stream.
 * @param {import('stream').Writable} out
 * @param {Iterable<object>} entries
 * @param {{ version?: string, comment?: string }} [o]
 */
async function writeHar(out, entries, o = {}) {
    const write = (s) => (out.write(s) ? Promise.resolve() : new Promise((r) => out.once('drain', r)));
    const head = { log: { version: '1.2', creator: { name: 'CupNet mini', version: o.version || '' }, ...(o.comment ? { comment: o.comment } : {}), pages: [], entries: [] } };
    const json = JSON.stringify(head);
    await write(json.slice(0, json.lastIndexOf('[]')) + '[');
    let first = true;
    for (const e of entries) {
        if (!e || e.kind !== 'request') continue;
        await write((first ? '' : ',') + JSON.stringify(harEntry(e)));
        first = false;
    }
    await write(']}}');
}

/** HAR header list [{name,value}] → object, repeating a name into an array (mirrors `_headers`). */
function _headersToObject(list) {
    const out = {};
    for (const it of Array.isArray(list) ? list : []) {
        const name = String(it?.name ?? '').trim();
        if (!name) continue;
        const value = String(it?.value ?? '');
        if (out[name] === undefined) out[name] = value;
        else if (Array.isArray(out[name])) out[name].push(value);
        else out[name] = [out[name], value];
    }
    return out;
}

/** HAR content/postData → a session body string (`__b64__:` for base64 content), or null. */
function _contentToBody(c) {
    if (!c || c.text == null || c.text === '') return null;
    const text = String(c.text);
    return String(c.encoding || '').toLowerCase() === 'base64' ? `__b64__:${text}` : text;
}

/**
 * HAR 1.2 document → session entries (MITM-event shape for SessionLog.logRequest), in order.
 * Keeps full headers and bodies; preserves start time (`ts`), duration, status, resource type.
 * Accepts a parsed object or a JSON string; throws on anything that is not a HAR log.
 * @param {object|string} har
 * @returns {Array<object>}
 */
function parseHar(har) {
    const doc = typeof har === 'string' ? JSON.parse(har) : har;
    const entries = doc?.log?.entries;
    if (!Array.isArray(entries)) throw new Error('not a HAR document (log.entries missing)');
    const out = [];
    for (const e of entries) {
        const req = e?.request || {};
        const res = e?.response || {};
        if (!req.url) continue;
        const ts = Date.parse(e?.startedDateTime);
        const time = Number(e?.time);
        out.push({
            ts: Number.isFinite(ts) ? ts : undefined,
            method: req.method || 'GET',
            url: String(req.url),
            status: Number(res.status) || 0,
            type: e?._resourceType || null,
            duration: Number.isFinite(time) && time >= 0 ? Math.round(time) : undefined,
            requestHeaders: _headersToObject(req.headers),
            responseHeaders: _headersToObject(res.headers),
            requestBody: _contentToBody(req.postData),
            responseBody: _contentToBody(res.content),
        });
    }
    return out;
}

module.exports = { harEntry, writeHar, parseHar };
