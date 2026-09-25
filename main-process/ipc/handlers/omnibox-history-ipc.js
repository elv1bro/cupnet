'use strict';

const { Menu, clipboard } = require('electron');
const { confirmOpenAnotherTab } = require('../../services/tab-open-confirm');
const { classifyOmniboxInput, applySearchEngineTemplate } = require('../../../omnibox-input.js');
const { broadcastBrowserChromeSettings } = require('./settings-toolbar-ipc');

/**
 * Omnibox (address bar) + browsing history IPC.
 *
 * renderer→main invoke (trusted shell / tool windows only):
 *   omnibox-suggest(q, limit) → { rows, shortcut }
 *   omnibox-zero-suggest()    → { recent, topSites }
 *   omnibox-navigate({ text, action, url, disposition, shortcutText }) → { ok, url }
 *   omnibox-delete-url(url)
 *   history-list(opts) / history-count(opts) / history-stats()
 *   history-delete-url(url) / history-delete-visit(id) / history-clear(range)
 *   history-get-settings() / history-set-settings(patch)
 *   history-recently-closed() / history-reopen(id)
 *   open-history-window()
 *   url-bar-context-menu({ hasSelection, hasText }) / nav-history-menu({ direction })
 * renderer→main invoke (any sender, read-only): get-search-engine
 * main→renderer: history-changed(kinds[])
 * @param {object} ctx
 */
function registerOmniboxHistoryIpc(ctx) {
    const { guardIpcHandler, guardIpcListener } = require('../ipc-trusted-sender.js');
    const svc = () => ctx.historyService;

    function searchEngineInfo() {
        const s = ctx.loadSettings();
        const se = ctx.settingsStore.normalizeSearchEngineSettings(s);
        return { ...se, searchEngineUrl: ctx.getSearchEngineUrl() };
    }

    // Read-only, also used by new-tab.html through preload-view.js.
    ctx.ipcMain.handle('get-search-engine', () => searchEngineInfo());

    ctx.ipcMain.handle('omnibox-suggest', guardIpcHandler('omnibox-suggest', (_, q, limit) => {
        try { return svc().suggest(q, limit); } catch { return { rows: [], shortcut: null }; }
    }));

    ctx.ipcMain.handle('omnibox-zero-suggest', guardIpcHandler('omnibox-zero-suggest', () => {
        try { return svc().zeroSuggest(); } catch { return { recent: [], topSites: [] }; }
    }));

    ctx.ipcMain.handle('omnibox-delete-url', guardIpcHandler('omnibox-delete-url', (_, url) => {
        return !!svc().deleteUrl(String(url || ''));
    }));

    async function openInNewTab(url, { isolated = false } = {}) {
        if (!(await confirmOpenAnotherTab(ctx))) return null;
        let tabId;
        if (isolated) {
            tabId = await ctx.tabManager.createTab(ctx.persistentAnonymizedProxyUrl || null, url, true, null);
        } else {
            tabId = await ctx.tabManager.createTab({ url, cookieGroupId: 1 });
        }
        ctx.tabManager.switchTab(tabId);
        const tab = ctx.tabManager.getTab(tabId);
        if (tab && typeof ctx.setupNetworkLogging === 'function') {
            try { ctx.setupNetworkLogging(tab.view.webContents, tabId, ctx.currentSessionId); } catch (_) { /* ignore */ }
            if (ctx.interceptor) {
                try { ctx.interceptor.attachToSession(tab.tabSession, tabId); } catch (_) { /* ignore */ }
            }
        }
        ctx.notifyCookieManagerTabs?.();
        return tabId;
    }

    /**
     * Resolve what the omnibox wants to open.
     * action: 'default' (classify text) | 'url' (open payload.url as is) | 'search' (force a web search)
     * disposition: 'current' | 'new-tab' | 'isolated-tab'
     */
    ctx.ipcMain.handle('omnibox-navigate', guardIpcHandler('omnibox-navigate', async (_, payload) => {
        const p = payload && typeof payload === 'object' ? payload : {};
        const text = String(p.text || '').trim();
        const action = String(p.action || 'default');
        const disposition = String(p.disposition || 'current');
        const activeTab = ctx.tabManager.getActiveTab();
        const base = activeTab?.view?.webContents && !activeTab.view.webContents.isDestroyed()
            ? (activeTab.view.webContents.getURL() || activeTab.url || '')
            : (activeTab?.url || '');

        let url = null;
        let internal = null;
        if (action === 'search') {
            url = applySearchEngineTemplate(ctx.getSearchEngineUrl(), text);
        } else if (action === 'url' && p.url) {
            const c = classifyOmniboxInput(String(p.url), { base });
            if (c.kind === 'internal') internal = c.internal;
            else if (c.kind === 'url') url = c.url;
            else url = applySearchEngineTemplate(ctx.getSearchEngineUrl(), String(p.url));
        } else {
            const c = classifyOmniboxInput(text, { base });
            if (c.kind === 'empty') return { ok: false };
            if (c.kind === 'internal') internal = c.internal;
            else if (c.kind === 'url') url = c.url;
            else url = applySearchEngineTemplate(ctx.getSearchEngineUrl(), c.query != null ? c.query : text);
        }

        if (internal === 'history') {
            ctx.createHistoryWindow?.();
            return { ok: true, url: 'cupnet://history' };
        }
        if (internal) url = internal === 'new-tab' ? ctx.getNewTabUrl() : ctx.getInternalPageUrl(internal);
        if (!url) return { ok: false };

        // Learn "typed this → went there" for history picks so the next prefix completes directly.
        if (p.shortcutText && action === 'url' && /^https?:\/\//i.test(url)) {
            try { svc().recordShortcut(String(p.shortcutText), url); } catch (_) { /* ignore */ }
        }

        if (disposition === 'new-tab' || disposition === 'isolated-tab') {
            const tabId = await openInNewTab(url, { isolated: disposition === 'isolated-tab' });
            if (tabId) ctx.tabManager.markOmniboxTyped?.(tabId, text);
            return { ok: !!tabId, url, tabId };
        }
        ctx.tabManager.navigate(url, undefined, { omniboxTyped: true, typedText: text });
        return { ok: true, url };
    }));

    // ── History window / data ──────────────────────────────────────────────
    ctx.ipcMain.handle('open-history-window', guardIpcHandler('open-history-window', () => {
        ctx.createHistoryWindow?.();
        return true;
    }));
    ctx.ipcMain.handle('history-list', guardIpcHandler('history-list', (_, opts) => svc().list(opts || {})));
    ctx.ipcMain.handle('history-count', guardIpcHandler('history-count', (_, opts) => svc().count(opts || {})));
    ctx.ipcMain.handle('history-stats', guardIpcHandler('history-stats', () => svc().stats()));
    ctx.ipcMain.handle('history-delete-url', guardIpcHandler('history-delete-url', (_, url) => !!svc().deleteUrl(String(url || ''))));
    ctx.ipcMain.handle('history-delete-visit', guardIpcHandler('history-delete-visit', (_, id) => !!svc().deleteVisit(id)));
    ctx.ipcMain.handle('history-clear', guardIpcHandler('history-clear', (_, range) => svc().clear(range)));
    ctx.ipcMain.handle('history-get-settings', guardIpcHandler('history-get-settings', () => svc().getSettings()));
    ctx.ipcMain.handle('history-set-settings', guardIpcHandler('history-set-settings', (_, patch) => {
        const next = svc().setSettings(patch);
        try { broadcastBrowserChromeSettings(ctx); } catch (_) { /* ignore */ }
        return next;
    }));
    ctx.ipcMain.handle('history-recently-closed', guardIpcHandler('history-recently-closed', () => svc().getRecentlyClosed()));
    ctx.ipcMain.handle('history-reopen', guardIpcHandler('history-reopen', async (_, id) => {
        if (!(await confirmOpenAnotherTab(ctx))) return null;
        return svc().reopenClosedTab(id == null ? null : id);
    }));
    ctx.ipcMain.handle('history-open-url', guardIpcHandler('history-open-url', async (_, url, disposition) => {
        const u = String(url || '').trim();
        if (!/^https?:\/\//i.test(u)) return { ok: false };
        if (disposition === 'new-tab') {
            const tabId = await openInNewTab(u);
            return { ok: !!tabId, tabId };
        }
        ctx.tabManager.navigate(u);
        try { if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.focus(); } catch (_) { /* ignore */ }
        return { ok: true };
    }));

    // ── Native menus for the address bar and Back/Forward ──────────────────
    ctx.ipcMain.on('url-bar-context-menu', guardIpcListener('url-bar-context-menu', (event, info) => {
        const i = info && typeof info === 'object' ? info : {};
        const clip = String(clipboard.readText() || '').trim();
        const wc = event.sender;
        const template = [
            {
                label: clip ? `Paste and go: ${clip.length > 48 ? clip.slice(0, 48) + '…' : clip}` : 'Paste and go',
                enabled: !!clip,
                click: () => {
                    try {
                        const c = classifyOmniboxInput(clip);
                        if (c.kind === 'internal') {
                            if (c.internal === 'history') { ctx.createHistoryWindow?.(); return; }
                            ctx.tabManager.navigate(c.internal === 'new-tab' ? ctx.getNewTabUrl() : ctx.getInternalPageUrl(c.internal), undefined, { omniboxTyped: true });
                            return;
                        }
                        const url = c.kind === 'url' ? c.url : applySearchEngineTemplate(ctx.getSearchEngineUrl(), clip);
                        ctx.tabManager.navigate(url, undefined, { omniboxTyped: true, typedText: clip });
                        wc.send('omnibox-close');
                    } catch (_) { /* ignore */ }
                },
            },
            { type: 'separator' },
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut', enabled: !!i.hasSelection },
            { role: 'copy', enabled: !!i.hasSelection },
            { role: 'paste' },
            { role: 'selectAll', enabled: !!i.hasText },
            { type: 'separator' },
            {
                label: 'Copy page URL',
                enabled: !!i.committedUrl,
                click: () => { try { clipboard.writeText(String(i.committedUrl || '')); } catch (_) { /* ignore */ } },
            },
        ];
        try {
            const win = ctx.BrowserWindow.fromWebContents(wc);
            Menu.buildFromTemplate(template).popup({ window: win || undefined });
        } catch (_) { /* ignore */ }
    }));

    ctx.ipcMain.on('nav-history-menu', guardIpcListener('nav-history-menu', (event, info) => {
        const tab = ctx.tabManager.getActiveTab();
        const wc = tab?.view?.webContents;
        if (!wc || wc.isDestroyed()) return;
        const nh = wc.navigationHistory;
        if (!nh || typeof nh.getAllEntries !== 'function') return;
        const entries = nh.getAllEntries();
        const active = nh.getActiveIndex();
        const dir = info && info.direction === 'forward' ? 'forward' : 'back';
        const items = [];
        if (dir === 'back') {
            for (let i = active - 1; i >= 0 && items.length < 15; i--) items.push({ entry: entries[i], index: i });
        } else {
            for (let i = active + 1; i < entries.length && items.length < 15; i++) items.push({ entry: entries[i], index: i });
        }
        if (!items.length) return;
        const template = items.map(({ entry, index }) => {
            const label = (entry.title || entry.url || '').slice(0, 80) || `Entry ${index + 1}`;
            return { label, click: () => { try { nh.goToIndex(index); } catch (_) { /* ignore */ } } };
        });
        template.push({ type: 'separator' }, { label: 'Show All History', click: () => ctx.createHistoryWindow?.() });
        try {
            const win = ctx.BrowserWindow.fromWebContents(event.sender);
            Menu.buildFromTemplate(template).popup({ window: win || undefined });
        } catch (_) { /* ignore */ }
    }));

    // ── Change notifications → history window + shell ──────────────────────
    const service = svc();
    if (service && typeof service.onChanged === 'function') {
        service.onChanged((kinds) => {
            const payload = Array.isArray(kinds) ? kinds : ['change'];
            const targets = [ctx.historyWindow, ctx.mainWindow];
            for (const w of targets) {
                try {
                    if (w && !w.isDestroyed()) w.webContents.send('history-changed', payload);
                } catch (_) { /* ignore */ }
            }
            if (payload.includes('closed')) {
                try { ctx.buildMenu?.(); } catch (_) { /* ignore */ }
            }
        });
    }
}

module.exports = { registerOmniboxHistoryIpc };
