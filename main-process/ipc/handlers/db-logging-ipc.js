'use strict';

const { insertSessionBootstrapTrafficRow } = require('../../services/cupnet-network-meta-log');

/**
 * БД запросов/сессий и управление логированием.
 * @param {object} ctx
 */
function registerDbLoggingIpc(ctx) {
    ctx.ipcMain.handle('get-db-requests', async (_, filters, limit, offset) => {
        return ctx.db.queryRequests(filters || {}, limit || 100, offset || 0);
    });

    ctx.ipcMain.handle('count-db-requests', async (_, filters) => {
        return ctx.db.countRequests(filters || {});
    });

    ctx.ipcMain.handle('get-request-detail', async (_, id) => {
        return ctx.db.getRequest(id);
    });

    ctx.ipcMain.handle('set-request-annotation', async (_, id, data) => {
        if (!id) return { success: false, error: 'Invalid request id' };
        await ctx.db.setRequestAnnotationAsync(id, data || {});
        return { success: true };
    });

    ctx.ipcMain.handle('fts-search', async (_, query, sessionId) => {
        return ctx.db.ftsSearch(query, sessionId || null);
    });

    ctx.ipcMain.handle('get-omnibox-top-hosts', async (_, limit) => {
        try {
            return ctx.db.getOmniboxTopHosts(limit);
        } catch {
            return [];
        }
    });

    ctx.ipcMain.handle('get-sessions', async () => {
        return ctx.db.getSessions(50, 0);
    });

    ctx.ipcMain.handle('get-sessions-with-stats', async () => {
        return ctx.db.getSessionsWithStats(200, 0);
    });

    ctx.ipcMain.handle('get-current-session-id', async () => {
        return ctx.currentSessionId ?? null;
    });

    ctx.ipcMain.handle('rename-session', async (_, id, name) => {
        await ctx.db.renameSessionAsync(id, name);
        return { success: true };
    });

    // ── Logging toggle ───────────────────────────────────────────────────────
    ctx.ipcMain.handle('toggle-logging-start', async (_, hint) => {
        if (ctx.isLoggingEnabled) return { status: 'already_on' };

        // No session yet (truly first run) — create one and enable silently
        if (!ctx.currentSessionId) {
            const sess = await ctx.db.createSessionAsync(ctx.actProxy || null, null);
            ctx.currentSessionId = sess ? sess.id : null;
            ctx.logEntryCount = 0;
            ctx.isLoggingEnabled = true;
            await insertSessionBootstrapTrafficRow(ctx).catch(() => {});
            for (const tab of ctx.tabManager.getAllTabs()) {
                tab.sessionId = ctx.currentSessionId;
                ctx.setupNetworkLogging(tab.view.webContents, tab.id, ctx.currentSessionId);
            }
            ctx.sendLogStatus();
            return { status: 'started' };
        }

        // If logging was explicitly stopped before — ALWAYS show choice modal
        // (even when logEntryCount === 0, e.g. after clear-logs)
        if (ctx.hadLoggingBeenStopped || ctx.logEntryCount > 0) {
            const sess = ctx.db.getSession(ctx.currentSessionId);
            const modalData = {
                sessionId:   ctx.currentSessionId,
                sessionName: sess?.notes || null,
                count:       ctx.logEntryCount,
            };
            ctx.createLoggingModalWindow(modalData, hint);
            return { status: 'modal_shown' };
        }

        // First enable ever with a pre-created empty session — start silently
        ctx.isLoggingEnabled = true;
        await insertSessionBootstrapTrafficRow(ctx).catch(() => {});
        // Иначе setupNetworkLogging ранее мог выйти рано (!logging && !fp) — CDP не висит, в MITM пишет только CDP.
        for (const tab of ctx.tabManager.getAllTabs()) {
            if (!tab.view?.webContents || tab.view.webContents.isDestroyed()) continue;
            const sid = ctx.currentSessionId ?? tab.sessionId;
            if (sid == null) continue;
            tab.sessionId = sid;
            ctx.setupNetworkLogging(tab.view.webContents, tab.id, sid);
        }
        ctx.sendLogStatus();
        return { status: 'started' };
    });

    ctx.ipcMain.handle('confirm-logging-start', async (_, { mode, renameOld }) => {
        if (mode === 'continue') {
            ctx.isLoggingEnabled = true;
            ctx.hadLoggingBeenStopped = false;
            // Re-attach logging for every tab so new tabs opened while paused also log
            for (const tab of ctx.tabManager.getAllTabs()) {
                tab.sessionId = ctx.currentSessionId;
                ctx.setupNetworkLogging(tab.view.webContents, tab.id, ctx.currentSessionId);
            }
            ctx.sendLogStatus();
            return { success: true };
        }
        // mode === 'new'
        if (renameOld && ctx.currentSessionId) await ctx.db.renameSessionAsync(ctx.currentSessionId, renameOld);
        if (ctx.currentSessionId) await ctx.db.endSessionAsync(ctx.currentSessionId);
        const sess = await ctx.db.createSessionAsync(ctx.actProxy || null, null);
        ctx.currentSessionId = sess ? sess.id : null;
        ctx.logEntryCount = 0;
        ctx.hadLoggingBeenStopped = false;
        ctx.isLoggingEnabled = true;
        await insertSessionBootstrapTrafficRow(ctx).catch(() => {});
        for (const tab of ctx.tabManager.getAllTabs()) {
            tab.sessionId = ctx.currentSessionId;
            ctx.setupNetworkLogging(tab.view.webContents, tab.id, ctx.currentSessionId);
        }
        ctx.sendLogStatus();
        return { success: true };
    });

    ctx.ipcMain.handle('toggle-logging-stop', async () => {
        ctx.isLoggingEnabled = false;
        ctx.hadLoggingBeenStopped = true;
        ctx.sendLogStatus();
        return { success: true };
    });

    ctx.ipcMain.handle('delete-session', async (_, id) => {
        // Guard: cannot delete the currently active session
        if (id === ctx.currentSessionId) return { success: false, reason: 'active' };
        await ctx.db.deleteSessionAsync(id);
        return { success: true };
    });

    ctx.ipcMain.handle('delete-unnamed-sessions', async () => {
        const res = await ctx.db.deleteUnnamedSessionsAsync(ctx.currentSessionId ?? null);
        return { success: true, deleted: res.deleted };
    });

    ctx.ipcMain.handle('create-session-from-request-ids', async (_, requestIds, name) => {
        const row = await ctx.db.createSessionFromRequestIdsAsync(requestIds || [], name);
        if (!row?.id) return { success: false, error: 'no_requests' };
        return { success: true, sessionId: row.id };
    });

    ctx.ipcMain.handle('open-session-in-new-window', async (_, sessionId) => {
        ctx.createLogViewerWindow(sessionId || null);
        return { success: true };
    });

    ctx.ipcMain.handle('get-initial-session-id', async (e) => {
        return ctx.logViewerInitSessions.get(e.sender.id) ?? null;
    });

    ctx.ipcMain.handle('get-log-status', () => {
        return ctx.isLoggingEnabled && ctx.currentSessionId
            ? { enabled: true, sessionId: ctx.currentSessionId, count: ctx.logEntryCount }
            : { enabled: false, sessionId: null, count: 0 };
    });

    // ── Existing logs (DB-backed) ────────────────────────────────────────────
    ctx.ipcMain.handle('get-existing-logs', async () => {
        if (!ctx.currentSessionId) return [];
        const requests    = ctx.db.queryRequests({ sessionId: ctx.currentSessionId }, 5000, 0);
        const screenshots = ctx.db.getScreenshotEntriesForSession(ctx.currentSessionId);
        const browserEvents = ctx.db.getBrowserEventsForSession(ctx.currentSessionId);
        // Merge and sort ascending by created_at so order is chronological
        return [...requests, ...screenshots, ...browserEvents].sort((a, b) => {
            const ta = a.created_at || '', tb = b.created_at || '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });
    });

    ctx.ipcMain.handle('get-browser-events', async (_, opts) => {
        const sessionId = opts && opts.sessionId != null ? opts.sessionId : ctx.currentSessionId;
        if (!sessionId) return [];
        return ctx.db.getBrowserEvents(sessionId, opts || {});
    });

    ctx.ipcMain.handle('get-ws-events', async (_, payload) => {
        const p = payload || {};
        return ctx.db.queryWsEvents(p.sessionId, p.tabId, p.url, p.connectionId || null, p.limit || 10000);
    });

    ctx.ipcMain.handle('clear-logs', async () => {
        // Start a new session; all open tabs will log into it
        try {
            if (ctx.currentSessionId) await ctx.db.endSessionAsync(ctx.currentSessionId);
            const newSession = await ctx.db.createSessionAsync(ctx.actProxy || null, null);
            ctx.currentSessionId = newSession ? newSession.id : null;
            ctx.logEntryCount = 0;
            if (ctx.isLoggingEnabled) {
                await insertSessionBootstrapTrafficRow(ctx).catch(() => {});
            }
            // Re-attach logging for every open tab so they write to the new session
            for (const tab of ctx.tabManager.getAllTabs()) {
                tab.sessionId = ctx.currentSessionId;
                ctx.setupNetworkLogging(tab.view.webContents, tab.id, ctx.currentSessionId);
            }
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    /** Injected page script (storage stack traces) — see tab-manager + preload-view `cupnetStorageActivity`. */
    ctx.ipcMain.on('browser-storage-activity', (event, payload) => {
        if (!ctx.isLoggingEnabled) return;
        const s = ctx.loadSettings();
        if (!s.activityMonitorEnabled || !s.activityMonitorStorageStackTraces) return;
        const wcId = event.sender && event.sender.id;
        if (wcId == null || !ctx.currentSessionId) return;
        const tabId = ctx.tabManager.getTabIdByWebContentsId(wcId);
        if (!tabId) return;
        const p = payload && typeof payload === 'object' ? payload : {};
        const kind = String(p.kind || '').toLowerCase() === 'ss' ? 'ss' : 'ls';
        const op = String(p.op || 'set');
        let eventType = `${kind}-set`;
        if (op === 'remove') eventType = `${kind}-remove`;
        if (op === 'clear') eventType = `${kind}-clear`;
        let summary = '';
        if (op === 'clear') summary = 'storage cleared (inject)';
        else if (op === 'remove') summary = `remove ${p.key || ''}`;
        else summary = `${p.key || ''} = ${String(p.newValue || '').slice(0, 200)}`;
        const storageKind = kind === 'ss' ? 'sessionStorage' : 'localStorage';
        const detail = JSON.stringify({
            inject: true,
            stack: p.stack || '',
            key: p.key,
            newValue: p.newValue,
            op,
            storageKind,
            isLocalStorage: kind === 'ls',
        });
        (async () => {
            try {
                const id = await ctx.db.insertBrowserEventAsync(ctx.currentSessionId, tabId, {
                    event_type: eventType,
                    level: 'info',
                    summary: summary.slice(0, 8000),
                    detail,
                    source_url: null,
                    source_line: null,
                    origin: null,
                });
                if (id && typeof ctx._broadcastLogEntryToViewers === 'function') {
                    ctx._broadcastLogEntryToViewers({
                        _browserEvent: true,
                        id,
                        event_type: eventType,
                        level: 'info',
                        summary: summary.slice(0, 8000),
                        detail,
                        source_url: null,
                        source_line: null,
                        origin: null,
                        url: summary,
                        type: 'storage',
                        tabId,
                        tab_id: tabId,
                        session_id: ctx.currentSessionId,
                        sessionId: ctx.currentSessionId,
                        created_at: new Date().toISOString(),
                    });
                }
            } catch { /* ignore */ }
        })();
    });
}

module.exports = { registerDbLoggingIpc };
