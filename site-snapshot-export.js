'use strict';

/**
 * Сбор origin и экспорт «снимка сайта» из таблицы requests (GET + тела из логов) в ZIP.
 */

const INVALID_URL_PREFIX = /^(data:|blob:|chrome-extension:|about:|javascript:|file:)/i;

function parseJsonHeaders(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function getContentType(headersRaw) {
    const h = parseJsonHeaders(headersRaw);
    const ct = h['content-type'] || h['Content-Type'] || '';
    const v = Array.isArray(ct) ? ct[0] : ct;
    return String(v || '').split(';')[0].trim().toLowerCase();
}

/** @param {string} b */
function parseBase64Body(b) {
    if (!b || typeof b !== 'string') return null;
    if (b.startsWith('__b64__:')) {
        return { mime: null, data: b.slice(8) };
    }
    if (!b.startsWith('<base64|')) return null;
    const inner = b.slice(8, b.endsWith('>') ? b.length - 1 : b.length);
    const sep = inner.indexOf('|');
    if (sep === -1) return null;
    const qualifier = inner.slice(0, sep);
    const rest = inner.slice(sep + 1);
    if (qualifier === 'mime') {
        const sep2 = rest.indexOf('|');
        if (sep2 === -1) return null;
        return { mime: rest.slice(0, sep2), data: rest.slice(sep2 + 1) };
    }
    return null;
}

/** @param {string|null|undefined} bodyStr */
function decodeResponseBody(bodyStr) {
    if (bodyStr == null || bodyStr === '') return null;
    const s = String(bodyStr);
    const parsed = parseBase64Body(s);
    if (parsed) {
        try {
            return Buffer.from(parsed.data, 'base64');
        } catch {
            return null;
        }
    }
    return Buffer.from(s, 'utf8');
}

function mimeFromPath(pathname) {
    const m = pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (!m) return '';
    const ext = m[1].toLowerCase();
    const map = {
        html: 'text/html',
        htm: 'text/html',
        css: 'text/css',
        js: 'application/javascript',
        mjs: 'application/javascript',
        cjs: 'application/javascript',
        json: 'application/json',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        ico: 'image/x-icon',
        woff2: 'font/woff2',
        woff: 'font/woff',
        ttf: 'font/ttf',
        otf: 'font/otf',
        map: 'application/json',
        txt: 'text/plain',
        md: 'text/plain',
        wasm: 'application/wasm',
        xml: 'application/xml',
    };
    return map[ext] || '';
}

function isWebAssetContentType(ct, pathname) {
    const ml = (ct || '').toLowerCase();
    if (ml) {
        if (ml === 'text/html' || ml === 'text/css') return true;
        if (ml === 'application/javascript' || ml === 'text/javascript') return true;
        if (ml === 'application/json' || ml.endsWith('+json')) return true;
        if (ml.startsWith('image/')) return true;
        if (ml.startsWith('font/')) return true;
        if (ml.includes('javascript')) return true;
        if (ml === 'application/wasm') return true;
        if (ml === 'text/xml' || ml === 'application/xml' || ml.endsWith('+xml')) return true;
        if (ml === 'text/plain') return /\.(map|txt|md)$/i.test(pathname);
    }
    const fromPath = mimeFromPath(pathname);
    if (fromPath) {
        if (['text/html', 'text/css', 'application/javascript', 'application/json', 'image/svg+xml'].includes(fromPath)) {
            return true;
        }
        if (fromPath.startsWith('image/') || fromPath.startsWith('font/')) return true;
        if (fromPath === 'application/wasm') return true;
        if (fromPath === 'application/json' && pathname.toLowerCase().endsWith('.map')) return true;
        if (fromPath === 'text/plain' && /\.(map|txt|md)$/i.test(pathname)) return true;
    }
    if (ml === 'application/octet-stream') {
        const fp = mimeFromPath(pathname);
        return !!(fp && (fp.startsWith('font/') || fp.startsWith('image/')));
    }
    return false;
}

function normalizePathSegments(pathname) {
    const raw = pathname.split('/').filter(Boolean);
    const out = [];
    for (const seg of raw) {
        if (seg === '..') {
            if (out.length) out.pop();
        } else if (seg !== '.') {
            out.push(seg);
        }
    }
    return out;
}

function sanitizeSegment(seg) {
    return String(seg)
        .replace(/[<>:"|?*\x00-\x1f]/g, '_')
        .replace(/^\.+/, '_');
}

/** Папка верхнего уровня в ZIP при экспорте нескольких origin (имя хоста). */
function sanitizeHostnameForZip(hostname) {
    const s = String(hostname || '')
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^\.+|_+$/g, '');
    return s || 'host';
}

/**
 * @param {string} relPath из zipEntryNameFromUrl
 * @param {string} hostname
 * @param {boolean} multiOrigin
 */
function zipPathInArchive(relPath, hostname, multiOrigin) {
    if (!multiOrigin) return relPath;
    return `${sanitizeHostnameForZip(hostname)}/${relPath}`;
}

/**
 * Относительный путь внутри ZIP из URL (без ведущего слэша).
 * @param {string} url
 */
function zipEntryNameFromUrl(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return null;
    }
    const pathname = u.pathname || '/';
    const parts = normalizePathSegments(pathname);
    if (!parts.length) return 'index.html';
    const safe = parts.map(sanitizeSegment);
    return safe.join('/');
}

/**
 * @param {import('better-sqlite3').Database} sqliteDb
 * @param {number} sessionId
 * @returns {string[]}
 */
function listOriginsFromSession(sqliteDb, sessionId) {
    const origins = new Set();
    const stmt = sqliteDb.prepare('SELECT url FROM requests WHERE session_id = ?');
    for (const row of stmt.iterate(sessionId)) {
        const u = row.url;
        if (!u || typeof u !== 'string') continue;
        if (INVALID_URL_PREFIX.test(u)) continue;
        try {
            origins.add(new URL(u).origin);
        } catch {
            /* skip */
        }
    }
    return [...origins].sort();
}

/**
 * @param {object} row
 * @param {Set<string>} originsSet
 * @returns {{ relPath: string, hostname: string } | null}
 */
function siteExportRowInfo(row, originsSet) {
    if ((row.method || 'GET').toUpperCase() !== 'GET') return null;
    const st = Number(row.status);
    if (st !== 200) return null;
    if (!row.response_body) return null;
    let u;
    try {
        u = new URL(row.url);
    } catch {
        return null;
    }
    if (!originsSet.has(u.origin)) return null;
    const pathname = u.pathname || '/';
    const ct = getContentType(row.response_headers);
    if (!isWebAssetContentType(ct, pathname)) return null;
    const relPath = zipEntryNameFromUrl(row.url);
    if (!relPath) return null;
    return { relPath, hostname: u.hostname };
}

/**
 * @param {import('better-sqlite3').Database} sqliteDb
 * @param {number} sessionId
 * @param {string[]} origins
 * @returns {string[]}
 */
function listSitePathsForExport(sqliteDb, sessionId, origins) {
    const originList = [...new Set((origins || []).map((o) => String(o).trim()).filter(Boolean))];
    if (!originList.length) return [];
    const originsSet = new Set(originList);
    const multiOrigin = originList.length > 1;
    const names = new Set();
    const stmt = sqliteDb.prepare(`
        SELECT url, method, status, response_body, response_headers
        FROM requests
        WHERE session_id = ?
        ORDER BY id ASC
    `);
    for (const row of stmt.iterate(sessionId)) {
        const info = siteExportRowInfo(row, originsSet);
        if (!info) continue;
        names.add(zipPathInArchive(info.relPath, info.hostname, multiOrigin));
    }
    return [...names].sort();
}

/**
 * @param {import('better-sqlite3').Database} sqliteDb
 * @param {number} sessionId
 * @param {string[]} origins
 * @returns {{ pathToBuffer: Map<string, Buffer>, skipped: number }}
 */
function collectSiteFilesByPath(sqliteDb, sessionId, origins) {
    const originList = [...new Set((origins || []).map((o) => String(o).trim()).filter(Boolean))];
    if (!originList.length) return { pathToBuffer: new Map(), skipped: 0 };
    const originsSet = new Set(originList);
    const multiOrigin = originList.length > 1;
    const pathToBuffer = new Map();
    let skipped = 0;
    const stmt = sqliteDb.prepare(`
        SELECT url, method, status, response_body, response_headers
        FROM requests
        WHERE session_id = ?
        ORDER BY id ASC
    `);
    for (const row of stmt.iterate(sessionId)) {
        const info = siteExportRowInfo(row, originsSet);
        if (!info) {
            skipped++;
            continue;
        }
        const archivePath = zipPathInArchive(info.relPath, info.hostname, multiOrigin);
        const buf = decodeResponseBody(row.response_body);
        if (!buf || !buf.length) {
            skipped++;
            continue;
        }
        pathToBuffer.set(archivePath, buf);
    }
    return { pathToBuffer, skipped };
}

/**
 * Пишет ZIP в поток; resolve после close.
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.sqliteDb
 * @param {number} opts.sessionId
 * @param {string[]|undefined} opts.origins приоритет над legacy opts.origin
 * @param {string|undefined} opts.origin один origin (совместимость)
 * @param {import('fs').WriteStream} opts.outputStream
 * @param {typeof import('archiver')} opts.archiverFactory
 * @returns {Promise<{ files: number, skipped: number, origins: string[] }>}
 */
async function exportSiteZipToStream(opts) {
    const { sqliteDb, sessionId, outputStream, archiverFactory } = opts;
    let originList = [];
    if (Array.isArray(opts.origins) && opts.origins.length) {
        originList = [...new Set(opts.origins.map((o) => String(o).trim()).filter(Boolean))];
    } else if (opts.origin) {
        const o = String(opts.origin).trim();
        if (o) originList = [o];
    }
    const archive = archiverFactory('zip', { zlib: { level: 9 } });
    const { pathToBuffer, skipped } = collectSiteFilesByPath(sqliteDb, sessionId, originList);

    const done = new Promise((resolve, reject) => {
        outputStream.on('close', resolve);
        outputStream.on('error', reject);
        archive.on('error', reject);
    });

    archive.pipe(outputStream);

    const names = [...pathToBuffer.keys()].sort();
    for (const name of names) {
        archive.append(pathToBuffer.get(name), { name });
    }

    archive.finalize();
    await done;

    return {
        files: pathToBuffer.size,
        skipped,
        origins: originList,
    };
}

module.exports = {
    listOriginsFromSession,
    listSitePathsForExport,
    exportSiteZipToStream,
    collectSiteFilesByPath,
    decodeResponseBody,
    zipEntryNameFromUrl,
    sanitizeHostnameForZip,
    zipPathInArchive,
};
