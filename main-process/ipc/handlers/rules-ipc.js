'use strict';

const requestInterceptor = require('../../../request-interceptor');

/**
 * Highlight + intercept rules.
 * @param {object} ctx
 */
function registerRulesIpc(ctx) {
    ctx.ipcMain.handle('get-rules', async () => ctx.db.getRules());
    ctx.ipcMain.handle('save-rule', async (_, rule) => ctx.db.saveRuleAsync(rule));
    ctx.ipcMain.handle('delete-rule', async (_, id) => { await ctx.db.deleteRuleAsync(id); return true; });
    ctx.ipcMain.handle('toggle-rule', async (_, id, enabled) => { await ctx.db.toggleRuleAsync(id, enabled); return true; });

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
}

module.exports = { registerRulesIpc };
