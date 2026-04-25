'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const jsondiffpatch = require('jsondiffpatch');
const { format: formatHtmlDiff } = require('jsondiffpatch/formatters/html');
const requestInterceptor = require('../../../request-interceptor');
const breakpointService = require('../../services/breakpoint-service');

function monacoVsDir() {
    const candidates = [
        path.join(__dirname, '../../../node_modules/monaco-editor/min/vs'),
        path.join(app.getAppPath(), 'node_modules/monaco-editor/min/vs'),
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(path.join(p, 'loader.js'))) return p;
        } catch { /* ignore */ }
    }
    return candidates[0];
}

/**
 * Intercept rules IPC.
 * @param {object} ctx
 */
function registerRulesIpc(ctx) {
    ctx.ipcMain.handle('get-monaco-vs-path', () => monacoVsDir());

    ctx.ipcMain.handle('breakpoint-resume', (_, payload) => {
        const { id, action, patch } = payload || {};
        if (!id) return { ok: false };
        const ok = breakpointService.resumeBreakpoint(id, {
            action: action === 'block' ? 'block' : 'forward',
            patch: patch && typeof patch === 'object' ? patch : undefined,
        });
        return { ok };
    });

    ctx.ipcMain.handle('format-intercept-rule-diff-html', (_, leftJson, rightJson) => {
        try {
            const left = typeof leftJson === 'string' ? JSON.parse(leftJson) : leftJson;
            const right = typeof rightJson === 'string' ? JSON.parse(rightJson) : rightJson;
            const delta = jsondiffpatch.diff(left, right);
            if (!delta) return { ok: true, html: '<p class="cn-empty-state-sub">No changes.</p>' };
            const html = formatHtmlDiff(delta, left);
            return { ok: true, html };
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
    });

    // ── Intercept rules ──────────────────────────────────────────────────────
    ctx.ipcMain.handle('get-intercept-rules', async () => ctx.db.getAllInterceptRules());
    ctx.ipcMain.handle('save-intercept-rule', async (_, rule) => {
        const v = requestInterceptor.validateInterceptRuleForSave(rule);
        if (!v.ok) return { error: v.error };

        const id = await ctx.db.saveInterceptRuleAsync(rule);
        if (ctx.interceptor) {
            // invalidateRulesCache() уже вызывает resyncWebRequestHooks()
            ctx.interceptor.invalidateRulesCache();
            ctx.reattachInterceptorToAllTabs();
        }
        return { id };
    });
    ctx.ipcMain.handle('delete-intercept-rule', async (_, id) => {
        await ctx.db.deleteInterceptRuleAsync(id);
        if (ctx.interceptor) {
            ctx.interceptor.invalidateRulesCache();
            ctx.reattachInterceptorToAllTabs();
        }
        return true;
    });

    ctx.ipcMain.handle('select-mock-file', async () => {
        const parent = ctx.rulesWindow && !ctx.rulesWindow.isDestroyed() ? ctx.rulesWindow : ctx.mainWindow;
        const { canceled, filePaths } = await ctx.dialog.showOpenDialog(parent, {
            title: 'Select Mock Response File',
            properties: ['openFile'],
            filters: [{ name: 'All Files', extensions: ['*'] }],
        });
        if (canceled || !filePaths.length) return null;
        const filePath = filePaths[0];
        try {
            const stat = fs.statSync(filePath);
            return { filePath, size: stat.size };
        } catch {
            return { filePath, size: null };
        }
    });

    ctx.ipcMain.handle('test-intercept-notification', async () => {
        function broadcast(info) {
            ctx.broadcastInterceptRuleMatched(info);
        }
        broadcast({ type: 'mock', ruleName: 'Test Mock Rule', url: 'https://example.com/api/data', detail: '200 application/json', bodyPreview: '{"status":"ok","message":"mocked response"}' });
        setTimeout(() => broadcast({ type: 'block', ruleName: 'Test Block Rule', url: 'https://example.com/ads/tracker.js' }), 800);
        setTimeout(() => broadcast({ type: 'modifyHeaders', ruleName: 'Test Modify Rule', url: 'https://example.com/api/auth', detail: 'Set: X-Custom-Token; Remove: Cookie' }), 1600);
        return true;
    });

    ctx.ipcMain.handle('test-intercept-script', async (_, payload) => {
        try {
            return requestInterceptor.runInterceptScriptSelfTest(payload || {});
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
    });

    ctx.ipcMain.handle('test-intercept-url-match', async (_, pattern, url) => {
        try {
            const ok = requestInterceptor.ruleMatchesUrl(String(pattern || ''), String(url || ''));
            return { ok };
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
    });

    ctx.ipcMain.handle('export-intercept-rules', async () => {
        const rows = await ctx.db.getAllInterceptRules();
        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            rules: rows.map((r) => ({
                name: r.name,
                enabled: !!r.enabled,
                url_pattern: r.url_pattern,
                type: r.type,
                params: r.params || {},
                priority: r.priority ?? 0,
                method: r.method || '*',
                group_name: r.group_name ?? null,
                delay_ms: r.delay_ms ?? 0,
                tags: r.tags,
                stop_on_match: r.stop_on_match !== 0,
                breakpoint_enabled: !!r.breakpoint_enabled,
            })),
        };
        const parent = ctx.rulesWindow && !ctx.rulesWindow.isDestroyed() ? ctx.rulesWindow : ctx.mainWindow;
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(parent, {
            title: 'Export Intercept Rules',
            defaultPath: path.join(ctx.app.getPath('documents'), 'cupnet-intercept-rules.json'),
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (canceled || !filePath) return { ok: false, error: 'Canceled' };
        try {
            fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
            return { ok: true, filePath };
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
    });

    ctx.ipcMain.handle('import-intercept-rules', async () => {
        const parent = ctx.rulesWindow && !ctx.rulesWindow.isDestroyed() ? ctx.rulesWindow : ctx.mainWindow;
        const { canceled, filePaths } = await ctx.dialog.showOpenDialog(parent, {
            title: 'Import Intercept Rules',
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
        });
        if (canceled || !filePaths.length) return { ok: false, error: 'Canceled' };
        let raw;
        try {
            raw = fs.readFileSync(filePaths[0], 'utf8');
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return { ok: false, error: 'Invalid JSON' };
        }
        const list = Array.isArray(data.rules) ? data.rules : Array.isArray(data) ? data : null;
        if (!list || !list.length) return { ok: false, error: 'No rules in file' };
        let imported = 0;
        for (const r of list) {
            if (!r || !r.name || !r.url_pattern || !r.type) continue;
            const rule = {
                name: String(r.name),
                enabled: r.enabled !== false,
                url_pattern: String(r.url_pattern),
                type: r.type,
                params: r.params || {},
                priority: Number(r.priority) || 0,
                method: r.method != null ? String(r.method) : '*',
                group_name: r.group_name,
                delay_ms: r.delay_ms,
                tags: r.tags,
                stop_on_match: r.stop_on_match !== false,
                breakpoint_enabled: !!r.breakpoint_enabled,
            };
            const v = requestInterceptor.validateInterceptRuleForSave(rule);
            if (!v.ok) continue;
            await ctx.db.saveInterceptRuleAsync(rule);
            imported++;
        }
        if (ctx.interceptor) {
            ctx.interceptor.invalidateRulesCache();
            ctx.reattachInterceptorToAllTabs();
        }
        return { ok: true, imported };
    });

    ctx.ipcMain.handle('reorder-intercept-rules', async (_, pairs) => {
        await ctx.db.reorderInterceptRulesAsync(pairs || []);
        if (ctx.interceptor) {
            ctx.interceptor.invalidateRulesCache();
            ctx.reattachInterceptorToAllTabs();
        }
        return true;
    });

    ctx.ipcMain.handle('get-intercept-rule-history', async (_, ruleId, limit) => {
        return ctx.db.getInterceptRuleHistory(ruleId, limit);
    });

    ctx.ipcMain.handle('export-rules-activity-log', async (_, payload) => {
        const parent = ctx.rulesWindow && !ctx.rulesWindow.isDestroyed() ? ctx.rulesWindow : ctx.mainWindow;
        const entries = payload?.entries;
        if (!Array.isArray(entries)) return { ok: false, error: 'No entries' };
        const asCsv = payload?.format === 'csv';
        const defaultName = asCsv ? 'cupnet-rules-activity.csv' : 'cupnet-rules-activity.json';
        const { canceled, filePath } = await ctx.dialog.showSaveDialog(parent, {
            title: 'Export Activity Log',
            defaultPath: path.join(ctx.app.getPath('documents'), defaultName),
            filters: asCsv
                ? [{ name: 'CSV', extensions: ['csv'] }]
                : [{ name: 'JSON', extensions: ['json'] }],
        });
        if (canceled || !filePath) return { ok: false, error: 'Canceled' };
        try {
            if (asCsv) {
                const esc = (v) => {
                    const s = v == null ? '' : String(v);
                    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
                    return s;
                };
                const lines = [['time', 'type', 'rule', 'url'].join(',')];
                for (const e of entries) {
                    const t = e.ts ? new Date(e.ts).toISOString() : '';
                    lines.push([esc(t), esc(e.type), esc(e.ruleName), esc(e.url)].join(','));
                }
                fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
            } else {
                fs.writeFileSync(filePath, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries }, null, 2), 'utf8');
            }
            return { ok: true, filePath };
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
    });
}

module.exports = { registerRulesIpc };
