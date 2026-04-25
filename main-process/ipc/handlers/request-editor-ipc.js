'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

/**
 * Request Editor: saved collections, environments, file picker for multipart.
 */
function registerRequestEditorIpc(ctx) {
    ctx.ipcMain.handle('request-editor-list-collections', () => {
        try {
            return { success: true, rows: ctx.db.listRequestEditorCollectionTree() };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('request-editor-save-collection-node', (_, row) => {
        try {
            if (row?.id) {
                const id = Number(row.id);
                if (row.node_type === 'folder') {
                    ctx.db.updateRequestEditorCollectionRow(id, {
                        parent_id: row.parent_id,
                        name: row.name,
                        sort_order: row.sort_order,
                        method: null,
                        url: null,
                        headers_json: null,
                        body: null,
                        body_type: null,
                        auth_json: null,
                        params_json: null,
                        form_fields_json: null,
                        multipart_json: null,
                    });
                } else {
                    ctx.db.updateRequestEditorCollectionRow(id, row);
                }
                return { success: true, id };
            }
            const newId = ctx.db.insertRequestEditorCollectionRow(row);
            return { success: true, id: newId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('request-editor-delete-collection-node', (_, id) => {
        try {
            ctx.db.deleteRequestEditorCollectionNode(Number(id));
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('request-editor-list-environments', () => {
        try {
            return { success: true, rows: ctx.db.listRequestEditorEnvironments() };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('request-editor-upsert-environment', (_, row) => {
        try {
            const id = ctx.db.upsertRequestEditorEnvironment(row || {});
            return { success: true, id };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('request-editor-delete-environment', (_, id) => {
        try {
            ctx.db.deleteRequestEditorEnvironment(Number(id));
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('request-editor-pick-file', async () => {
        const focused = BrowserWindow.getFocusedWindow();
        const parent = (focused && !focused.isDestroyed())
            ? focused
            : (ctx.requestEditorWindow && !ctx.requestEditorWindow.isDestroyed()
                ? ctx.requestEditorWindow
                : (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : undefined));
        const { canceled, filePaths } = await ctx.dialog.showOpenDialog(parent, {
            title: 'Select file',
            properties: ['openFile'],
        });
        if (canceled || !filePaths.length) return { path: null };
        return { path: filePaths[0] };
    });

    /**
     * Build multipart body from text fields and file paths (main process has fs).
     * @param parts {{ text?: { key: string, value: string }[], files?: { key: string, path: string, filename?: string }[] }}
     */
    ctx.ipcMain.handle('request-editor-build-multipart', (_, parts) => {
        try {
            const text = Array.isArray(parts?.text) ? parts.text : [];
            const files = Array.isArray(parts?.files) ? parts.files : [];
            const boundary = `----cupnetFormBoundary${Date.now()}`;
            const chunks = [];
            const skipped = [];
            const crlf = '\r\n';
            for (const t of text) {
                if (!t || !t.key) continue;
                chunks.push(Buffer.from(
                    `--${boundary}${crlf}Content-Disposition: form-data; name="${String(t.key).replace(/"/g, '')}"${crlf}${crlf}${String(t.value ?? '')}${crlf}`,
                    'utf8',
                ));
            }
            for (const f of files) {
                if (!f || !f.key || !f.path) continue;
                const fp = String(f.path);
                if (!fs.existsSync(fp)) {
                    skipped.push(f.filename || path.basename(fp));
                    continue;
                }
                const filename = f.filename || path.basename(fp);
                const data = fs.readFileSync(fp);
                const head = Buffer.from(
                    `--${boundary}${crlf}Content-Disposition: form-data; name="${String(f.key).replace(/"/g, '')}"; filename="${filename.replace(/"/g, '')}"${crlf}Content-Type: application/octet-stream${crlf}${crlf}`,
                    'utf8',
                );
                chunks.push(head);
                chunks.push(data);
                chunks.push(Buffer.from(crlf, 'utf8'));
            }
            chunks.push(Buffer.from(`--${boundary}--${crlf}`, 'utf8'));
            const body = Buffer.concat(chunks);
            const result = {
                success: true,
                contentType: `multipart/form-data; boundary=${boundary}`,
                bodyBase64: body.toString('base64'),
            };
            if (skipped.length) {
                result.warning = `Files not found: ${skipped.join(', ')}`;
            }
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerRequestEditorIpc };
