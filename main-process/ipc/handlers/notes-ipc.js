'use strict';

const fs = require('fs').promises;
const path = require('path');

const {
    getNoteDomainFromUrl,
    getNoteIndexDomainFromMatch,
    noteMatchesUrlMatch,
} = require('../../../note-domain-utils.js');
const { encryptNotePayload, decryptNotePayload } = require('../../../notes-crypto.js');
const TurndownService = require('turndown');

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', hr: '---' });

/**
 * CupNet custom blocks round-trip as fenced JSON so marked → HTML can be hydrated
 * back to ql-cn-block in the renderer (see hydrateCupnetBlocksHtml).
 * Plain-text export (cnBlockExportText) is for copy/export only, not for DB storage.
 */
td.addRule('cnBlock', {
    filter(node) {
        return node.nodeName === 'DIV'
            && node.classList
            && node.classList.contains('ql-cn-block')
            && node.hasAttribute('data-cn-payload');
    },
    replacement(_content, node) {
        try {
            const payload = JSON.parse(node.getAttribute('data-cn-payload') || '{}');
            const json = JSON.stringify(payload);
            return '\n\n```cupnet\n' + json + '\n```\n\n';
        } catch {
            return '';
        }
    },
});

/** marked v17+ — только ESM; подгружаем один раз через dynamic import. */
let markedSingletonPromise = null;
function getMarked() {
    if (!markedSingletonPromise) {
        markedSingletonPromise = import('marked').then((m) => {
            const { marked } = m;
            marked.setOptions({ gfm: true, breaks: true });
            return marked;
        });
    }
    return markedSingletonPromise;
}

async function mdToHtml(md) {
    if (!md) return '';
    const marked = await getMarked();
    return marked.parse(md);
}

function htmlToMd(html) {
    if (!html) return '';
    return td.turndown(html);
}

function mdToPlainText(md) {
    if (!md) return '';
    return String(md)
        .replace(/\r\n/g, '\n')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^>\s+/gm, '')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/^\d+\.\s+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function sanitizeFilenameBase(s) {
    const t = String(s || 'note').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80);
    return t || 'note';
}

/** Parse stored header field (JSON object or raw string) for Notes request embed. */
function parseHeadersFieldForEmbed(h) {
    if (h == null || h === '') return null;
    if (typeof h === 'object' && !Array.isArray(h)) return h;
    const s = String(h);
    try {
        const j = JSON.parse(s);
        if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch { /* ignore */ }
    return s;
}

function pickContentTypeFromHeaders(headers) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
    const keys = Object.keys(headers);
    const k = keys.find((x) => String(x).toLowerCase() === 'content-type');
    if (!k) return '';
    return String(headers[k] || '').split(';')[0].trim();
}

/**
 * Map a `requests` table row to payload for Quill `request` cnBlock (see notes-quill-custom-blocks.js).
 */
function normalizeRequestRowForNotesEmbed(row) {
    if (!row) return null;
    const reqH = parseHeadersFieldForEmbed(row.request_headers);
    const respH = parseHeadersFieldForEmbed(row.response_headers);
    const reqBody = row.request_body != null ? String(row.request_body) : null;
    const respBody = row.response_body != null ? String(row.response_body) : null;
    return {
        requestId: row.id,
        sessionId: row.session_id != null ? row.session_id : null,
        url: String(row.url || ''),
        method: String(row.method || 'GET').toUpperCase(),
        status: row.status != null ? Number(row.status) : null,
        statusText: '',
        mimeType: pickContentTypeFromHeaders(respH),
        requestHeaders: reqH,
        responseHeaders: respH,
        requestBody: reqBody,
        responseBody: respBody,
        responseSize: respBody != null ? respBody.length : null,
        timing: row.duration_ms != null ? Number(row.duration_ms) : null,
        timestamp: row.created_at || null,
        tlsVersion: null,
        protocol: null,
    };
}

function resolveNoteDomains(payload) {
    const pageUrl = String(payload.page_url || '');
    let urlMatch = String(payload.url_match != null ? payload.url_match : payload.domain || '').trim();
    let domain = getNoteIndexDomainFromMatch(urlMatch);
    if (!domain && pageUrl) domain = getNoteDomainFromUrl(pageUrl);
    if (!domain && urlMatch) {
        domain = getNoteDomainFromUrl(`https://${urlMatch.split('/')[0]}`);
    }
    if (!domain) domain = '(no site)';
    return { urlMatch, domain };
}

function registerNotesIpc(ctx) {
    ctx.ipcMain.handle('notes-list', (_, filter) => {
        if (!ctx.db) return [];
        try {
            const f = filter || {};
            let rows = ctx.db.listUserNotes(f);
            if (f.refineByUrlMatch && f.pageUrl) {
                const pu = String(f.pageUrl);
                rows = rows.filter((r) => noteMatchesUrlMatch(r.url_match || '', pu));
            }
            return rows;
        } catch (e) {
            ctx.sysLog?.('warn', 'notes', String(e?.message || e));
            return [];
        }
    });

    ctx.ipcMain.handle('notes-get', async (_, id, password) => {
        const row = ctx.db?.getUserNote(id);
        if (!row) return null;
        const base = {
            id: row.id,
            domain: row.domain,
            url_match: row.url_match != null ? row.url_match : '',
            page_url: row.page_url,
            created_at: row.created_at,
            updated_at: row.updated_at,
            is_encrypted: !!row.is_encrypted,
            tags: row.tags != null ? String(row.tags) : '',
            is_pinned: !!row.is_pinned,
        };
        if (!row.is_encrypted) {
            const bodyMd = row.body_plain || '';
            return { ...base, title: row.title || '', body: bodyMd, bodyHtml: await mdToHtml(bodyMd), locked: false };
        }
        if (!password) {
            return {
                ...base,
                title: row.title || '',
                body: '',
                bodyHtml: '',
                locked: true,
            };
        }
        try {
            const buf = Buffer.isBuffer(row.body_encrypted)
                ? row.body_encrypted
                : Buffer.from(row.body_encrypted || []);
            const txt = decryptNotePayload(buf, password);
            const j = JSON.parse(txt);
            let body = '';
            if (j && typeof j.body === 'string') {
                body = j.body;
            }
            if (!body && j && j.title !== undefined && j.body !== undefined) {
                body = typeof j.body === 'string' ? j.body : '';
            }
            const titlePlain = row.title || (j && typeof j.title === 'string' ? j.title : '') || '';
            return {
                ...base,
                title: titlePlain,
                body,
                bodyHtml: await mdToHtml(body),
                locked: false,
            };
        } catch {
            throw new Error('Wrong password');
        }
    });

    ctx.ipcMain.handle('notes-save', async (_, payload) => {
        if (!ctx.db) throw new Error('Database not available');
        const p = payload || {};
        const { urlMatch, domain } = resolveNoteDomains(p);
        const pageUrl = String(p.page_url || '');
        const isEnc = !!p.is_encrypted;
        const titlePlain = String(p.title || '');
        const tags = String(p.tags != null ? p.tags : '');
        const isPinned = !!p.is_pinned;

        const bodyMd = p.bodyHtml != null ? htmlToMd(p.bodyHtml) : String(p.body || '');

        if (isEnc) {
            const pw = String(p.password || '');
            if (!pw) throw new Error('Encryption password is required');
            const buf = encryptNotePayload(JSON.stringify({ body: bodyMd }), pw);
            return ctx.db.saveUserNoteAsync({
                id: p.id || null,
                domain,
                url_match: urlMatch,
                page_url: pageUrl,
                title: titlePlain,
                is_encrypted: true,
                body_encrypted: buf,
                tags,
                is_pinned: isPinned,
            });
        }
        return ctx.db.saveUserNoteAsync({
            id: p.id || null,
            domain,
            url_match: urlMatch,
            page_url: pageUrl,
            title: titlePlain,
            body_plain: bodyMd,
            is_encrypted: false,
            tags,
            is_pinned: isPinned,
        });
    });

    ctx.ipcMain.handle('notes-delete', async (_, id) => {
        if (!ctx.db) return false;
        await ctx.db.deleteUserNoteAsync(id);
        return true;
    });

    ctx.ipcMain.handle('notes-pin', async (_, noteId, pinned) => {
        if (!ctx.db) throw new Error('Database not available');
        await ctx.db.setUserNotePinnedAsync(noteId, !!pinned);
        return true;
    });

    ctx.ipcMain.handle('notes-export', async (event, payload) => {
        if (!ctx.db) throw new Error('Database not available');
        const p = payload || {};
        const id = Number(p.id);
        if (!id) throw new Error('Invalid note id');
        const format = String(p.format || 'md').toLowerCase();
        if (!['md', 'txt', 'html'].includes(format)) throw new Error('Invalid export format');

        const row = ctx.db.getUserNote(id);
        if (!row) throw new Error('Note not found');

        let bodyMd = '';
        let titlePlain = String(row.title || '');

        if (!row.is_encrypted) {
            bodyMd = row.body_plain || '';
        } else {
            const pw = String(p.password || '');
            if (!pw) throw new Error('Password required for encrypted note');
            try {
                const buf = Buffer.isBuffer(row.body_encrypted)
                    ? row.body_encrypted
                    : Buffer.from(row.body_encrypted || []);
                const txt = decryptNotePayload(buf, pw);
                const j = JSON.parse(txt);
                bodyMd = typeof j?.body === 'string' ? j.body : '';
            } catch {
                throw new Error('Wrong password');
            }
        }

        let content = '';
        let ext = '.md';
        if (format === 'md') {
            content = bodyMd;
            ext = '.md';
        } else if (format === 'txt') {
            content = mdToPlainText(bodyMd);
            ext = '.txt';
        } else {
            content = await mdToHtml(bodyMd);
            ext = '.html';
        }

        const win = ctx.notesWindow && !ctx.notesWindow.isDestroyed()
            ? ctx.notesWindow
            : (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null);
        const docDir = ctx.app?.getPath?.('documents') || '';
        const baseName = `${sanitizeFilenameBase(titlePlain)}${ext}`;
        const defaultPath = docDir ? path.join(docDir, baseName) : baseName;
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(win || undefined, {
            defaultPath,
            filters: [{ name: 'Export', extensions: [ext.slice(1)] }],
        });
        if (canceled || !filePath) return { canceled: true };

        await fs.writeFile(filePath, content, 'utf8');
        return { canceled: false, filePath };
    });

    ctx.ipcMain.handle('notes-get-request-for-embed', async (_, requestId) => {
        if (!ctx.db) return null;
        const id = Number(requestId);
        if (!Number.isFinite(id) || id <= 0) return null;
        const row = ctx.db.getRequest(id);
        if (!row) return null;
        return normalizeRequestRowForNotesEmbed(row);
    });
}

module.exports = { registerNotesIpc };
