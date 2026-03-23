'use strict';

const archiver = require('archiver');
const siteSnapshotExport = require('../../../site-snapshot-export');

/**
 * HAR, bundle, diff, replay.
 * @param {object} ctx
 */
function registerTraceHarIpc(ctx) {
    ctx.ipcMain.handle('export-har', async (_, sessionId) => {
        const sid = sessionId || ctx.currentSessionId;
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(ctx.logViewerWindow, {
            title: 'Export HAR',
            defaultPath: ctx.path.join(ctx.app.getPath('downloads'), `cupnet-session-${sid}.har`),
            filters: [{ name: 'HAR Files', extensions: ['har'] }]
        });
        if (canceled) return { success: false, canceled: true };
        try {
            const har = ctx.harExporter.exportHar(sid);
            ctx.fs.writeFileSync(filePath, JSON.stringify(har, null, 2));
            return { success: true, path: filePath };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // ── Incident bundle export/import ────────────────────────────────────────
    ctx.ipcMain.handle('export-bundle', async (_, payload = {}) => {
        const sid = payload.sessionId || ctx.currentSessionId || null;
        const protectionLevel = String(payload.protectionLevel || 'Raw');
        const requestIds = Array.isArray(payload.requestIds) ? payload.requestIds : [];
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(ctx.logViewerWindow, {
            title: 'Export Incident Bundle',
            defaultPath: ctx.path.join(ctx.app.getPath('downloads'), `cupnet-bundle-${sid || 'manual'}-${Date.now()}.json`),
            filters: [{ name: 'Bundle Files', extensions: ['json', 'bundle'] }],
        });
        if (canceled) return { success: false, canceled: true };
        try {
            const bundle = ctx.bundleUtils.buildBundle({
                db: ctx.db,
                sessionId: sid,
                requestIds,
                protectionLevel,
                appVersion: ctx.app.getVersion(),
            });
            if (payload.notes && typeof payload.notes === 'object') {
                bundle.notes = { ...(bundle.notes || {}), ...payload.notes };
            }
            ctx.fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8');
            return {
                success: true,
                path: filePath,
                stats: {
                    requests: bundle.traffic?.requests?.length || 0,
                    protectionLevel: bundle.meta?.protectionLevel || protectionLevel,
                    redactedFields: bundle.meta?.redactionReport?.redactedFieldsCount || 0,
                },
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('list-session-origins', async (_, sessionId) => {
        const sid = Number(sessionId || ctx.currentSessionId);
        if (!sid) return [];
        try {
            const sqliteDb = ctx.db.getDb();
            if (!sqliteDb) return [];
            return siteSnapshotExport.listOriginsFromSession(sqliteDb, sid);
        } catch (e) {
            return [];
        }
    });

    ctx.ipcMain.handle('export-site-zip', async (_, payload = {}) => {
        const sid = Number(payload.sessionId || ctx.currentSessionId);
        const origin = String(payload.origin || '').trim();
        if (!sid) return { success: false, error: 'No session selected' };
        if (!origin) return { success: false, error: 'No origin selected' };
        let slug = 'site';
        try {
            slug = (new URL(origin).hostname || 'site').replace(/[^a-z0-9._-]+/gi, '_');
        } catch { /* keep */ }
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(ctx.logViewerWindow, {
            title: 'Export site snapshot (ZIP)',
            defaultPath: ctx.path.join(ctx.app.getPath('downloads'), `cupnet-site-${slug}-${Date.now()}.zip`),
            filters: [{ name: 'ZIP', extensions: ['zip'] }],
        });
        if (canceled) return { success: false, canceled: true };
        const sqliteDb = ctx.db.getDb();
        if (!sqliteDb) return { success: false, error: 'Database not ready' };
        try {
            const output = ctx.fs.createWriteStream(filePath);
            const stats = await siteSnapshotExport.exportSiteZipToStream({
                sqliteDb,
                sessionId: sid,
                origin,
                outputStream: output,
                archiverFactory: archiver,
            });
            return { success: true, path: filePath, stats };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('import-bundle', async () => {
        const { canceled, filePaths } = await ctx.dialog.showOpenDialog(ctx.logViewerWindow, {
            title: 'Import Incident Bundle',
            properties: ['openFile'],
            filters: [{ name: 'Bundle/JSON files', extensions: ['json', 'bundle'] }],
        });
        if (canceled || !filePaths.length) return { success: false, canceled: true };
        try {
            const raw = ctx.fs.readFileSync(filePaths[0], 'utf8');
            const bundle = JSON.parse(raw);
            const check = ctx.bundleUtils.validateBundle(bundle);
            if (!check.ok) return { success: false, error: check.error };
            const preview = {
                schemaVersion: bundle.schemaVersion,
                exportedAt: bundle.meta?.exportedAt || null,
                protectionLevel: bundle.meta?.protectionLevel || 'Raw',
                requests: Array.isArray(bundle.traffic?.requests) ? bundle.traffic.requests.length : 0,
                trace: Array.isArray(bundle.traffic?.trace) ? bundle.traffic.trace.length : 0,
            };
            return { success: true, filePath: filePaths[0], preview, bundle };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ctx.ipcMain.handle('diff-requests', async (_, leftId, rightId) => {
        const left = ctx.db.getRequest(Number(leftId));
        const right = ctx.db.getRequest(Number(rightId));
        if (!left || !right) return { success: false, error: 'Request not found for diff' };
        const result = ctx.diffUtils.compareRequests(left, right);
        if (!result.ok) return { success: false, error: result.error || 'Diff error' };
        return { success: true, diff: result };
    });

    ctx.ipcMain.handle('jsondiff-format-html', async (_, leftText, rightText) => {
        try {
            const mods = await ctx.loadJsonDiffModules();
            const left = JSON.parse(String(leftText || ''));
            const right = JSON.parse(String(rightText || ''));
            const delta = mods.jsondiffpatch.diff(left, right);
            const html = mods.formatter.format(delta, left);
            return { success: true, html };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ── Replay request ───────────────────────────────────────────────────────
    ctx.ipcMain.handle('replay-request', async (_, id) => {
        const req = ctx.db.getRequest(id);
        if (!req) return { success: false, error: 'Not found' };
        try {
            // Strip headers that break net.fetch or cause protocol errors
            const FORBIDDEN = new Set([
                'content-length', 'transfer-encoding', 'host', 'connection',
                'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization',
                'accept-encoding' // let Electron set this automatically
            ]);
            const rawHeaders = req.request_headers ? JSON.parse(req.request_headers) : {};
            const safeHeaders = {};
            for (const [k, v] of Object.entries(rawHeaders)) {
                if (!FORBIDDEN.has(k.toLowerCase())) safeHeaders[k] = v;
            }
            const isBodyless = ['GET', 'HEAD', 'OPTIONS'].includes((req.method || 'GET').toUpperCase());
            const resp = await ctx.netFetchWithTimeout(req.url, {
                method: req.method || 'GET',
                headers: safeHeaders,
                body: isBodyless ? undefined : (req.request_body || undefined)
            }, ctx.networkPolicy.timeouts.replayMs);
            const text = await resp.text();
            return { success: true, status: resp.status, body: text, original: req.response_body };
        } catch (e) { return { success: false, error: e.message }; }
    });
}

module.exports = { registerTraceHarIpc };
