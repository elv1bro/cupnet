'use strict';

/**
 * Анализ страницы, CapMonster, Turnstile.
 * @param {object} ctx
 */
function registerPageAnalyzerIpc(ctx) {
    ctx.ipcMain.handle('analyze-page-forms', async (_, tabId) => {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return [];
        try {
            return await tab.view.webContents.executeJavaScript(`(${ctx._analyzeFormsScript})()`);
        } catch { return []; }
    });

    ctx.ipcMain.handle('analyze-page-captcha', async (_, tabId) => {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return {};
        try {
            return await tab.view.webContents.executeJavaScript(`(${ctx._analyzeCaptchaScript})()`);
        } catch { return {}; }
    });

    async function injectTurnstileTokenToTab(tabId, payload = {}) {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
            return { injected: false, submitted: false, updatedCount: 0, reason: 'tab-not-found' };
        }
        const tokenLiteral = JSON.stringify(String(payload.token || ''));
        const sitekeyLiteral = JSON.stringify(String(payload.sitekey || ''));
        const actionLiteral = JSON.stringify(String(payload.action || ''));
        const autoSubmitLiteral = payload.autoSubmit === true ? 'true' : 'false';
        const script = `(function(){
            var token = ${tokenLiteral};
            var sitekey = ${sitekeyLiteral};
            var action = ${actionLiteral};
            var autoSubmit = ${autoSubmitLiteral};
            if (!token) return { injected:false, submitted:false, updatedCount:0, reason:'missing-token' };
            var updated = 0;
            var callbacksInvoked = 0;
            var forms = [];
            var callbackFns = [];
            var callbackNames = [];
            function safePushCallback(fn, name){
                if (typeof fn !== 'function') return;
                if (callbackFns.indexOf(fn) !== -1) return;
                callbackFns.push(fn);
                callbackNames.push(name || 'anonymous');
            }
            function setNativeValue(inp, value) {
                try {
                    var proto = (inp && inp.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc && typeof desc.set === 'function') {
                        desc.set.call(inp, value);
                        return;
                    }
                } catch {}
                try { inp.value = value; } catch {}
            }
            function markInput(inp) {
                if (!inp) return;
                try {
                    setNativeValue(inp, token);
                    inp.setAttribute('value', token);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    inp.dispatchEvent(new Event('blur', { bubbles: true }));
                    updated++;
                    if (inp.form && forms.indexOf(inp.form) === -1) forms.push(inp.form);
                } catch {}
            }
            function all(sel) {
                try { return Array.from(document.querySelectorAll(sel)); } catch { return []; }
            }
            all('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').forEach(markInput);
            all('input[id$="_response"], textarea[id$="_response"]').forEach(function(el){
                var id = String(el.id || '').toLowerCase();
                if (id.indexOf('cf-chl-widget-') === 0) markInput(el);
            });
            all('.cf-turnstile, [data-turnstile-widget-id]').forEach(function(node){
                var nodeSitekey = String(node.getAttribute('data-sitekey') || '');
                var nodeAction = String(node.getAttribute('data-action') || '');
                var cbName = String(node.getAttribute('data-callback') || '').trim();
                if (cbName && typeof window[cbName] === 'function') safePushCallback(window[cbName], cbName);
                if (sitekey && nodeSitekey && sitekey !== nodeSitekey) return;
                if (action && nodeAction && action !== nodeAction) return;
                var form = node.closest('form');
                var holder = form || node.parentElement || document.body;
                if (!holder) return;
                var hidden = holder.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
                if (!hidden) {
                    hidden = document.createElement('input');
                    hidden.type = 'hidden';
                    hidden.name = 'cf-turnstile-response';
                    holder.appendChild(hidden);
                }
                markInput(hidden);
            });

            try {
                var knownCbNames = ['onTurnstileSuccess', 'turnstileCallback', 'onCaptchaSolved', 'onCaptchaSuccess'];
                knownCbNames.forEach(function(name){
                    if (typeof window[name] === 'function') safePushCallback(window[name], name);
                });
            } catch {}

            try {
                var cfg = window.___turnstile_cfg;
                var clients = cfg && cfg.clients ? cfg.clients : null;
                var visited = [];
                function walk(obj, depth) {
                    if (!obj || depth > 6) return;
                    if (visited.indexOf(obj) !== -1) return;
                    visited.push(obj);
                    var keys = [];
                    try { keys = Object.keys(obj); } catch { return; }
                    for (var i = 0; i < keys.length; i++) {
                        var k = keys[i];
                        var v = obj[k];
                        if (!v) continue;
                        if (typeof v === 'function') continue;
                        if (typeof v === 'object') {
                            try {
                                if (typeof v.callback === 'function') {
                                    var sk = String(v.sitekey || v.siteKey || '');
                                    var ac = String(v.action || '');
                                    var skOk = !sitekey || !sk || sk === sitekey;
                                    var acOk = !action || !ac || ac === action;
                                    if (skOk && acOk) safePushCallback(v.callback, '___turnstile_cfg.callback');
                                }
                            } catch {}
                            walk(v, depth + 1);
                        }
                    }
                }
                if (clients && typeof clients === 'object') walk(clients, 0);
            } catch {}

            callbackFns.forEach(function(fn){
                try {
                    fn(token);
                    callbacksInvoked++;
                } catch {}
            });
            var submitted = false;
            if (autoSubmit) {
                var form = forms.find(function(f){ return !!f; }) || document.querySelector('form');
                if (form) {
                    try {
                        if (typeof form.requestSubmit === 'function') form.requestSubmit();
                        else form.submit();
                        submitted = true;
                    } catch {}
                }
            }
            var injected = updated > 0 || callbacksInvoked > 0;
            return {
                injected: injected,
                submitted: submitted,
                updatedCount: updated,
                callbacksInvoked: callbacksInvoked,
                reason: injected ? 'ok' : 'no-input-found'
            };
        })()`;
        try {
            return await tab.view.webContents.executeJavaScript(script);
        } catch {
            return { injected: false, submitted: false, updatedCount: 0, reason: 'script-execution-failed' };
        }
    }

    function formatSolverError(err) {
        const fallback = { code: 'SOLVER_ERROR', message: 'Unknown solver error', retryable: true };
        if (!err) return fallback;
        const code = String(err.code || 'SOLVER_ERROR');
        const message = String(err.message || fallback.message);
        const nonRetryable = new Set(['MISSING_API_KEY', 'INVALID_API_KEY', 'MISSING_PAGE_URL', 'MISSING_SITEKEY', 'TASK_NOT_SUPPORTED']);
        return {
            code,
            message,
            retryable: !nonRetryable.has(code),
            details: err.details || {},
        };
    }

    function extractTurnstileSitekey(item = {}) {
        const direct = String(item.sitekey || '').trim();
        if (direct) return direct;
        const iframeSrc = String(item.iframeSrc || '').trim();
        if (!iframeSrc) return '';
        try {
            const u = new URL(iframeSrc);
            return String(
                u.searchParams.get('k')
                || u.searchParams.get('sitekey')
                || u.searchParams.get('render')
                || ''
            ).trim();
        } catch {
            return '';
        }
    }

    async function discoverTurnstilePayloadFromPage(tabId, fallbackPayload = {}) {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return fallbackPayload;
        const base = { ...(fallbackPayload || {}) };
        if (!base.pageUrl) {
            try { base.pageUrl = tab.view.webContents.getURL() || tab.url || ''; } catch (err) {
                ctx.safeCatch({ module: 'main', eventCode: 'captcha.context.discovery_failed', context: { field: 'pageUrl', tabId } }, err, 'info');
            }
        }
        if (base.sitekey) return base;
        try {
            const data = await tab.view.webContents.executeJavaScript(`(${ctx._analyzeCaptchaScript})()`);
            const turns = Array.isArray(data?.turnstile) ? data.turnstile : [];
            const item = turns.find(x => extractTurnstileSitekey(x)) || turns[0] || {};
            const discoveredSitekey = extractTurnstileSitekey(item);
            return {
                ...base,
                sitekey: discoveredSitekey || base.sitekey || '',
                action: base.action || item.action || '',
                cData: base.cData || item.cData || '',
                iframeSrc: base.iframeSrc || item.iframeSrc || '',
                pageUrl: base.pageUrl || data?.pageUrl || '',
            };
        } catch {
            return base;
        }
    }

    ctx.ipcMain.handle('get-capmonster-settings', () => ctx.getCapmonsterSettings());
    ctx.ipcMain.handle('save-capmonster-settings', (_, cfg) => {
        const s = ctx.loadSettings();
        s.capmonster = ctx.normalizeCapmonsterSettings({ ...(s.capmonster || {}), ...(cfg || {}) });
        ctx.saveSettings(s);
        return s.capmonster;
    });
    ctx.ipcMain.handle('inject-turnstile-token', async (_, tabId, payload) => {
        return await injectTurnstileTokenToTab(tabId, payload || {});
    });
    ctx.ipcMain.handle('solve-turnstile-captcha', async (_, tabId, captcha, options = {}) => {
        try {
            const tab = ctx.tabManager.getTab(tabId);
            if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
                return { ok: false, error: { code: 'TAB_NOT_FOUND', message: 'Target tab not found.', retryable: false } };
            }
            const settings = ctx.getCapmonsterSettings();
            const merged = {
                ...settings,
                ...(options || {}),
                apiKey: String((options && options.apiKey) || settings.apiKey || '').trim(),
            };
            const hydratedCaptcha = await discoverTurnstilePayloadFromPage(tabId, {
                ...(captcha || {}),
                sitekey: extractTurnstileSitekey(captcha || {}),
            });
            const pageUrl = String(hydratedCaptcha.pageUrl || tab.url || tab.view.webContents.getURL() || '');
            const sitekey = String(hydratedCaptcha.sitekey || '');
            const action = String(hydratedCaptcha.action || '');
            const cData = String(hydratedCaptcha.cData || '');
            const userAgent = String(tab.view.webContents.getUserAgent() || '');

            const solved = await ctx.solveTurnstileWithCapMonster({
                apiKey: merged.apiKey,
                pageUrl,
                sitekey,
                action,
                cData,
                userAgent,
                timeoutMs: merged.pollTimeoutMs,
                pollIntervalMs: merged.pollIntervalMs,
            });

            let injectResult = { injected: false, submitted: false, updatedCount: 0, reason: 'auto-inject-disabled' };
            if (merged.autoInject) {
                injectResult = await injectTurnstileTokenToTab(tabId, {
                    token: solved.token,
                    sitekey,
                    action,
                    autoSubmit: merged.autoSubmit === true,
                });
            }

            return {
                ok: true,
                token: solved.token,
                taskId: solved.taskId,
                cost: solved.cost,
                solveCount: solved.solveCount,
                createdAt: solved.createdAt,
                endedAt: solved.endedAt,
                inject: injectResult,
            };
        } catch (err) {
            if (err instanceof ctx.CaptchaSolverError) {
                return { ok: false, error: formatSolverError(err) };
            }
            return { ok: false, error: formatSolverError(new ctx.CaptchaSolverError('SOLVER_ERROR', err?.message || 'Unknown solver error')) };
        }
    });

    ctx.ipcMain.handle('analyze-page-meta', async (_, tabId) => {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return {};
        try {
            return await tab.view.webContents.executeJavaScript(`(${ctx._analyzeMetaScript})()`);
        } catch { return {}; }
    });

    const _dumpWebStorageScript = `(function(){
        function dump(store) {
            var o = {};
            try {
                var n = store.length;
                for (var i = 0; i < n; i++) {
                    var k = store.key(i);
                    if (k != null) o[k] = store.getItem(k);
                }
            } catch (e) {}
            return o;
        }
        return { sessionStorage: dump(sessionStorage), localStorage: dump(localStorage) };
    })`;

    ctx.ipcMain.handle('analyze-page-storage', async (_, tabId) => {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
            return { sessionStorage: {}, localStorage: {} };
        }
        try {
            return await tab.view.webContents.executeJavaScript(_dumpWebStorageScript + '()');
        } catch {
            return { sessionStorage: {}, localStorage: {} };
        }
    });

    ctx.ipcMain.handle('apply-page-storage', async (_, tabId, payload) => {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
            return { ok: false, error: 'no-tab' };
        }
        const target = payload?.target === 'local' ? 'local' : 'session';
        const entries = payload?.entries;
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
            return { ok: false, error: 'entries must be a plain object' };
        }
        const storeName = target === 'local' ? 'localStorage' : 'sessionStorage';
        let literal;
        try {
            literal = JSON.stringify(entries);
        } catch {
            return { ok: false, error: 'entries not serializable' };
        }
        const script = `(function(){
            try {
                var entries = ${literal};
                if (!entries || typeof entries !== 'object' || Array.isArray(entries))
                    return { ok:false, error:'bad-entries' };
                var store = window['${storeName}'];
                var nextKeys = Object.keys(entries);
                var nk = Object.create(null);
                for (var i = 0; i < nextKeys.length; i++) nk[nextKeys[i]] = true;
                for (var i = store.length - 1; i >= 0; i--) {
                    var k = store.key(i);
                    if (k != null && !nk[k]) store.removeItem(k);
                }
                for (var i = 0; i < nextKeys.length; i++) {
                    var k = nextKeys[i];
                    var v = entries[k];
                    store.setItem(k, v == null ? '' : String(v));
                }
                return { ok: true };
            } catch (e) {
                return { ok: false, error: String(e && e.message ? e.message : e) };
            }
        })()`;
        try {
            const out = await tab.view.webContents.executeJavaScript(script);
            if (out && out.ok) return { ok: true };
            return { ok: false, error: (out && out.error) || 'script-failed' };
        } catch (err) {
            return { ok: false, error: String(err?.message || err) };
        }
    });

    ctx.ipcMain.handle('analyze-page-endpoints', async (_, tabId) => {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return {};
        try {
            return await tab.view.webContents.executeJavaScript(`(${ctx._analyzeEndpointsScript})()`);
        } catch { return {}; }
    });

    ctx.ipcMain.handle('page-analyzer-action', async (_, tabId, action) => {
        const tab = ctx.tabManager.getTab(tabId);
        if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) return false;
        try {
            const fi = Number(action.formIndex);
            const fld = Number(action.fieldIndex);
            const valueLiteral = JSON.stringify(action.value == null ? '' : String(action.value));
            const script = `(function(){
                var forms=document.querySelectorAll('form');
                if(!forms[${fi}]) return 'no-form';
                var el=forms[${fi}].elements[${fld}];
                if(!el) return 'no-field';
                var act='${action.type}';
                var newValue=${valueLiteral};
                function ensureVisible(node) {
                    if (!node || node.nodeType !== 1) return;
                    var cur = node;
                    while (cur && cur.nodeType === 1) {
                        var cs = window.getComputedStyle(cur);
                        if (cur.hidden) cur.hidden = false;
                        if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') cur.removeAttribute('aria-hidden');
                        if (cs.display === 'none') {
                            cur.style.display = '';
                            if (window.getComputedStyle(cur).display === 'none') cur.style.display = 'block';
                        }
                        if (cs.visibility === 'hidden') cur.style.visibility = 'visible';
                        if (cs.opacity === '0') cur.style.opacity = '1';
                        cur = cur.parentElement;
                    }
                }
                if(act==='focus'){
                    el.scrollIntoView({behavior:'smooth',block:'center'});
                    el.focus();
                    el.style.outline='3px solid #3b82f6';
                    el.style.outlineOffset='2px';
                    setTimeout(function(){el.style.outline='';el.style.outlineOffset=''},3000);
                } else if(act==='show'){
                    if(el.type==='hidden') el.type='text';
                    ensureVisible(el);
                    el.removeAttribute && el.removeAttribute('hidden');
                    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') el.removeAttribute('aria-hidden');
                    el.style.cssText='display:block !important;visibility:visible !important;opacity:1 !important;position:static !important;width:auto !important;height:auto !important;min-height:24px !important;border:2px dashed #f59e0b !important;padding:4px !important;background:rgba(245,158,11,0.08) !important;';
                    el.scrollIntoView({behavior:'smooth',block:'center'});
                } else if(act==='hide'){
                    el.hidden = true;
                    if (el.setAttribute) el.setAttribute('aria-hidden', 'true');
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('visibility', 'hidden', 'important');
                    el.style.setProperty('opacity', '0', 'important');
                } else if(act==='toggle-disabled'){
                    el.disabled = !el.disabled;
                } else if(act==='toggle-password-visibility'){
                    var t = (el.type || '').toLowerCase();
                    if (t === 'password') {
                        try { el.type = 'text'; } catch {}
                    } else if (t === 'text') {
                        try { el.type = 'password'; } catch {}
                    }
                } else if(act==='set-value'){
                    var tag = (el.tagName || '').toLowerCase();
                    var type = (el.type || '').toLowerCase();
                    if (type === 'checkbox' || type === 'radio') {
                        var v = String(newValue).toLowerCase();
                        el.checked = (v === '1' || v === 'true' || v === 'yes' || v === 'on');
                    } else if (tag === 'select') {
                        el.value = newValue;
                    } else {
                        el.value = newValue;
                    }
                    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                }
                return 'ok';
            })()`;
            const result = await tab.view.webContents.executeJavaScript(script);
            return result === 'ok';
        } catch { return false; }
    });
}

module.exports = { registerPageAnalyzerIpc };
