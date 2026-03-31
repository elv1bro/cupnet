'use strict';

const {
    getNoteDomainFromUrl,
    getNoteIndexDomainFromMatch,
    noteMatchesUrlMatch,
} = require('../../../note-domain-utils.js');
const { encryptNotePayload, decryptNotePayload } = require('../../../notes-crypto.js');
const TurndownService = require('turndown');

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', hr: '---' });

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
        });
    });

    ctx.ipcMain.handle('notes-delete', async (_, id) => {
        if (!ctx.db) return false;
        await ctx.db.deleteUserNoteAsync(id);
        return true;
    });
}

module.exports = { registerNotesIpc };
