'use strict';

const { sanitizeOutgoingRequestHeaders } = require('../../../utils');

/**
 * Log viewer, compare, JSONL, rules window, request editor, execute-request.
 * @param {object} ctx
 */
function registerLogCompareExecuteIpc(ctx) {
    ctx.ipcMain.handle('open-log-directory', async (_, dirPath) => {
        const p = dirPath || ctx.app.getPath('logs');
        try { ctx.fs.mkdirSync(p, { recursive: true }); } catch (err) {
            ctx.safeCatch({ module: 'main', eventCode: 'fs.mkdir.failed', context: { path: p } }, err);
        }
        await ctx.shell.openPath(p);
    });

    ctx.ipcMain.handle('select-log-directory', async () => {
        const parent = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : undefined;
        const { canceled, filePaths } = await ctx.dialog.showOpenDialog(parent, { properties: ['openDirectory'] });
        if (!canceled && filePaths.length) {
            const p = filePaths[0];
            // Save to settings
            const s = ctx.loadSettings();
            s.lastLogPath = p;
            ctx.saveSettings(s);
            return { path: p };
        }
        return { path: null };
    });

    ctx.ipcMain.handle('open-log-viewer', () => {
        // Toolbar button: focus the existing live window instead of opening a new one
        const liveWin = ctx.getLiveLogViewerWindow();
        if (liveWin) {
            if (liveWin.isMinimized()) liveWin.restore();
            liveWin.focus();
            return { success: true };
        }
        ctx.createLogViewerWindow();
        return { success: true };
    });

    ctx.ipcMain.handle('open-log-viewer-with-url', (_, url) => {
        const sendFocus = (win) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('focus-request-url', { url: String(url || '') });
            }
        };
        let liveWin = ctx.getLiveLogViewerWindow();
        if (liveWin) {
            if (liveWin.isMinimized()) liveWin.restore();
            liveWin.focus();
            sendFocus(liveWin);
            return { success: true };
        }
        ctx.createLogViewerWindow();
        liveWin = ctx.getLiveLogViewerWindow();
        if (liveWin && !liveWin.webContents.isLoading()) {
            sendFocus(liveWin);
        } else if (liveWin) {
            liveWin.webContents.once('did-finish-load', () => sendFocus(liveWin));
        }
        return { success: true };
    });

    ctx.ipcMain.handle('open-compare-viewer', () => {
        ctx.createCompareViewerWindow();
        return { success: true };
    });

    ctx.ipcMain.handle('compare-get', () => {
        return ctx._comparePayload();
    });

    ctx.ipcMain.handle('compare-set-slot', (_, side, requestId) => {
        const slot = String(side || '').toLowerCase();
        const reqId = Number(requestId);
        if (slot !== 'left' && slot !== 'right') return { success: false, error: 'Invalid side' };
        if (!Number.isInteger(reqId) || reqId <= 0) return { success: false, error: 'Invalid request id' };
        const req = ctx.db.getRequest(reqId);
        if (!req) return { success: false, error: 'Request not found' };
        ctx.comparePair[slot] = ctx._serializeCompareRowRequest(req);
        ctx.compareResult = null;
        ctx._broadcastCompareUpdated();
        return { success: true, ...ctx._comparePayload() };
    });

    ctx.ipcMain.handle('compare-clear-slot', (_, side) => {
        const slot = String(side || '').toLowerCase();
        if (slot !== 'left' && slot !== 'right') return { success: false, error: 'Invalid side' };
        ctx.comparePair[slot] = null;
        ctx.compareResult = null;
        ctx._broadcastCompareUpdated();
        return { success: true, ...ctx._comparePayload() };
    });

    ctx.ipcMain.handle('compare-run', (_, options = {}) => {
        if (!ctx.comparePair.left || !ctx.comparePair.right) {
            return { success: false, error: 'Need both left and right anchors' };
        }
        const level = ['quick', 'standard', 'deep'].includes(String(options.level || '').toLowerCase())
            ? String(options.level).toLowerCase()
            : 'standard';
        const LEFT_COUNT = level === 'quick' ? 12 : (level === 'deep' ? 30 : 20);
        const RIGHT_SEARCH = level === 'quick' ? 60 : (level === 'deep' ? 140 : 100);

        const leftReqs = ctx._requestsForSessionAsc(ctx.comparePair.left.session_id);
        const rightReqs = ctx._requestsForSessionAsc(ctx.comparePair.right.session_id);
        const leftPos = leftReqs.findIndex(r => Number(r.id) === Number(ctx.comparePair.left.id));
        const rightPos = rightReqs.findIndex(r => Number(r.id) === Number(ctx.comparePair.right.id));

        const leftSlice = leftReqs.slice(Math.max(0, leftPos), leftPos + LEFT_COUNT);
        const rightPool = rightReqs.slice(Math.max(0, rightPos), rightPos + RIGHT_SEARCH);

        const leftList = leftSlice.map(r => ctx._serializeCompareRowRequest(r));
        const rightUsed = new Set();
        const pairs = [];

        for (let i = 0; i < leftSlice.length; i++) {
            let best = { idx: -1, score: -Infinity, exactKey: false };
            for (let j = 0; j < rightPool.length; j++) {
                if (rightUsed.has(j)) continue;
                const s = ctx._pairScore(leftSlice[i], rightPool[j], i, j, level);
                if (!s.acceptable) continue;
                if (s.score > best.score) best = { idx: j, score: s.score, exactKey: s.exactKey };
            }
            if (best.idx >= 0) {
                rightUsed.add(best.idx);
                const leftCmp = ctx._reqWithCompareOptions(leftSlice[i], options);
                const rightCmp = ctx._reqWithCompareOptions(rightPool[best.idx], options);
                const cmp = ctx.diffUtils.compareRequests(leftCmp, rightCmp);
                pairs.push({
                    type: 'match',
                    leftIndex: i,
                    rightId: rightPool[best.idx].id,
                    left: ctx._serializeCompareRowRequest(leftSlice[i]),
                    right: ctx._serializeCompareRowRequest(rightPool[best.idx]),
                    diff: cmp?.ok ? cmp : null,
                    summary: cmp?.summary || null,
                    score: best.score,
                    confidence: ctx._confidence(best.score, best.exactKey),
                });
            } else {
                pairs.push({
                    type: 'missing-right',
                    leftIndex: i,
                    left: ctx._serializeCompareRowRequest(leftSlice[i]),
                    right: null, diff: null, summary: null,
                });
            }
        }

        const rightList = rightPool.map((r, j) => {
            const ser = ctx._serializeCompareRowRequest(r);
            ser._paired = rightUsed.has(j);
            return ser;
        });

        for (let j = 0; j < rightPool.length; j++) {
            if (!rightUsed.has(j)) {
                pairs.push({
                    type: 'missing-left',
                    leftIndex: -1,
                    left: null,
                    right: ctx._serializeCompareRowRequest(rightPool[j]),
                    diff: null, summary: null,
                });
            }
        }

        ctx.compareResult = {
            options: {
                level,
                removeNoiseHeaders: !!options.removeNoiseHeaders,
            },
            leftList,
            rightList,
            pairs,
        };
        ctx._broadcastCompareUpdated();
        return { success: true, ...ctx._comparePayload() };
    });

    ctx.ipcMain.handle('open-jsonl-file', async () => {
        const { canceled, filePaths } = await ctx.dialog.showOpenDialog(ctx.logViewerWindow, {
            title: 'Open JSONL Log File',
            filters: [{ name: 'JSONL Files', extensions: ['jsonl'] }, { name: 'All Files', extensions: ['*'] }],
            properties: ['openFile']
        });
        if (canceled || !filePaths.length) return { success: false, canceled: true };
        try {
            const logs = ctx.fs.readFileSync(filePaths[0], 'utf8')
                .split('\n').filter(Boolean)
                .map(l => { try { return JSON.parse(l); } catch { return null; } })
                .filter(Boolean);
            return { success: true, logs, filePath: filePaths[0] };
        } catch (err) { return { success: false, error: err.message }; }
    });

    ctx.ipcMain.handle('open-rules-window', () => { ctx.createRulesWindow(); return true; });

    ctx.ipcMain.handle('open-rules-window-with-mock', (_, data) => {
        ctx.createRulesWindow();
        const sendPrefill = () => {
            if (ctx.rulesWindow && !ctx.rulesWindow.isDestroyed()) {
                ctx.rulesWindow.webContents.send('prefill-intercept-rule', data);
            }
        };
        if (ctx.rulesWindow && !ctx.rulesWindow.isDestroyed() && !ctx.rulesWindow.webContents.isLoading()) {
            sendPrefill();
        } else if (ctx.rulesWindow) {
            ctx.rulesWindow.webContents.once('did-finish-load', sendPrefill);
        }
        return true;
    });

    // ── Request Editor ───────────────────────────────────────────────────────
    ctx.ipcMain.handle('open-request-editor', async (_, entryId) => {
        let data = { method: 'GET', url: '', headers: {}, body: '' };
        if (entryId) {
            try {
                const req = ctx.db.getRequest(entryId);
                if (req) {
                    data = {
                        method:  req.method  || 'GET',
                        url:     req.url     || '',
                        headers: req.request_headers  ? JSON.parse(req.request_headers)  : {},
                        body:    req.request_body     || '',
                    };
                }
            } catch (err) {
                ctx.safeCatch({ module: 'main', eventCode: 'request-editor.prefill.failed', context: { entryId } }, err, 'info');
            }
        }
        ctx.createRequestEditorWindow(data);
        return true;
    });

    const EXEC_FORBIDDEN = new Set([
        'content-length','transfer-encoding','host','connection',
        'keep-alive','upgrade','te','trailer','proxy-authorization','accept-encoding',
    ]);

    ctx.ipcMain.handle('execute-request', async (_, { method, url, headers, body, tlsProfile }) => {
        const start = Date.now();
        const reqMethod = (method || 'GET').toUpperCase();
        const sanitizedHeaders = sanitizeOutgoingRequestHeaders(headers || {});

        /** Log the result to DB and forward to open log viewer windows */
        function maybeLog(result) {
            if (!ctx.isLoggingEnabled || !ctx.currentSessionId) return;
            try {
                // insertRequest returns the SQLite integer id — use it for detail lookup
                ctx.db.insertRequestAsync(ctx.currentSessionId, null, {
                    requestId:       `re-${Date.now()}`,
                    url:             url || '',
                    method:          reqMethod,
                    status:          result.status || null,
                    type:            'request-editor',
                    duration:        result.duration || 0,
                    requestHeaders:  headers || {},
                    responseHeaders: result.headers || {},
                    requestBody:     body || null,
                    responseBody:    result.body || null,
                    error:           result.error || null,
                }).then((dbId) => {
                    ctx.logEntryCount++;
                    ctx.sendLogStatus();

                    // Forward to all open log viewer windows (live update)
                    if (ctx.logViewerWindows.length > 0) {
                        const entry = {
                            // Use the real SQLite id so detail panel can call getRequestDetail(id)
                            id:           dbId,
                            type:         'request-editor',
                            timestamp:    Date.now(),
                            url:          url || '',
                            method:       reqMethod,
                            response:     result.status ? { statusCode: result.status, headers: result.headers || {} } : null,
                            request:      { headers: headers || {}, body: body || null },
                            responseBody: result.body || null,
                            duration:     result.duration || 0,
                            error:        result.error || null,
                            tabId:        null,
                            sessionId:    ctx.currentSessionId,
                        };
                        ctx._broadcastLogEntryToViewers(entry);
                    }
                }).catch((err) => {
                    ctx.safeCatch({ module: 'main', eventCode: 'db.write.failed', context: { op: 'request-editor.maybeLog' } }, err, 'info');
                });
            } catch (e) { /* non-fatal */ }
        }

        try {
            // Use AzureTLS worker only in MITM mode.
            if (ctx.getCurrentTrafficMode() === 'mitm' && ctx.mitmProxy && ctx.mitmProxy.worker && ctx.mitmProxy.worker.ready) {
                const profile = tlsProfile || ctx.loadSettings().tlsProfile || 'chrome';
                const currentProxy = ctx.persistentAnonymizedProxyUrl || ctx.loadSettings().currentProxy || null;
                const res = await ctx.mitmProxy.worker.request({
                    method:            reqMethod,
                    url,
                    headers:           sanitizedHeaders,
                    body:              body || undefined,
                    proxy:            currentProxy,
                    browser:          profile,
                    disableRedirects: true,
                    timeout:          ctx.networkPolicy.timeouts.requestEditorMs,
                });
                const duration = Date.now() - start;
                if (res.error) {
                    const out = { success: false, error: res.error, duration };
                    maybeLog(out);
                    return out;
                }
                let respBody = '';
                if (res.bodyBase64) {
                    try { respBody = Buffer.from(res.bodyBase64, 'base64').toString('utf8'); } catch (err) {
                        ctx.safeCatch({ module: 'main', eventCode: 'request-editor.decode.failed', context: { encoding: 'base64' } }, err, 'info');
                    }
                } else if (typeof res.body === 'string') {
                    respBody = res.body;
                }
                const out = {
                    success: true,
                    status: res.statusCode,
                    statusText: '',
                    headers: res.headers || {},
                    body: respBody,
                    duration,
                    tlsProfile: profile,
                };
                maybeLog(out);
                return out;
            }

            // Fallback: Electron net.fetch
            const safe = {};
            for (const [k, v] of Object.entries(sanitizedHeaders)) {
                if (!EXEC_FORBIDDEN.has(k.toLowerCase())) safe[k] = v;
            }
            const isBodyless = ['GET','HEAD','OPTIONS'].includes(reqMethod);
            const resp = await ctx.netFetchWithTimeout(url, {
                method:  reqMethod,
                headers: safe,
                body:    isBodyless ? undefined : (body || undefined),
            }, ctx.networkPolicy.timeouts.requestEditorMs);
            const duration = Date.now() - start;
            const respHeaders = {};
            resp.headers.forEach((v, k) => { respHeaders[k] = v; });
            const text = await resp.text();
            const out = { success: true, status: resp.status, statusText: resp.statusText,
                          headers: respHeaders, body: text, duration };
            maybeLog(out);
            return out;
        } catch (e) {
            const out = { success: false, error: e.message, duration: Date.now() - start };
            maybeLog(out);
            return out;
        }
    });
}

module.exports = { registerLogCompareExecuteIpc };
