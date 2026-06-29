'use strict';

const { isDevtoolsHostileWebContents } = require('./devtools-hostile-sites');

/** tab.id → detached DevTools BrowserWindow */
const _dtByTabId = new Map();
const _dtDestroyGuards = new Set();

function _focusDevToolsWindow(devWin) {
    if (!devWin || devWin.isDestroyed()) return;
    if (devWin.isMinimized()) devWin.restore();
    devWin.show();
    devWin.focus();
}

function _purgeManagedEntry(tabId) {
    const w = _dtByTabId.get(tabId);
    _dtByTabId.delete(tabId);
    return w;
}

/**
 * Fully detach DevTools from a tab webContents (required before reopen after close).
 * @param {import('electron').WebContents} wc
 * @param {string|number} tabId
 */
function ensureDevToolsFullyClosed(wc, tabId) {
    if (!wc || wc.isDestroyed()) {
        if (tabId != null) _purgeManagedEntry(tabId);
        return Promise.resolve();
    }
    const managed = _dtByTabId.get(tabId);
    if (managed && !managed.isDestroyed()) {
        try { managed.close(); } catch { /* ignore */ }
    } else if (tabId != null) {
        _purgeManagedEntry(tabId);
    }
    if (!wc.isDevToolsOpened()) return Promise.resolve();
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        wc.once('devtools-closed', finish);
        try { wc.closeDevTools(); } catch { finish(); }
        setTimeout(finish, 600);
    });
}

/**
 * @param {import('electron').WebContents} wc
 * @param {{ getAllTabs: () => Iterable<{ id: unknown }>; getTab: (id: unknown) => { id: unknown } | null | undefined }} tabManager
 * @param {{ id: string|number }} tab
 * @returns {Promise<boolean>}
 */
async function openManagedDevTools(wc, tabManager, tab) {
    if (!wc || wc.isDestroyed()) return false;
    const tabId = tab.id;

    const existing = _dtByTabId.get(tabId);
    if (existing && !existing.isDestroyed()) {
        _focusDevToolsWindow(existing);
        return true;
    }
    if (existing) _purgeManagedEntry(tabId);

    await ensureDevToolsFullyClosed(wc, tabId);
    if (wc.isDestroyed()) return false;

    const { BrowserWindow } = require('electron');
    const tabList = Array.from(tabManager.getAllTabs());
    const tabNum = Math.max(1, tabList.findIndex((t) => t.id === tab.id) + 1);
    const winTitle = `devtools #${tabNum}`;

    const devWin = new BrowserWindow({
        title: winTitle,
        show: false,
        width: 960,
        height: 700,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    _dtByTabId.set(tabId, devWin);

    devWin.on('closed', () => {
        _purgeManagedEntry(tabId);
        if (!wc.isDestroyed() && wc.isDevToolsOpened()) {
            try { wc.closeDevTools(); } catch { /* ignore */ }
        }
    });

    wc.once('devtools-opened', () => {
        wc.once('devtools-closed', () => {
            _purgeManagedEntry(tabId);
            if (devWin && !devWin.isDestroyed()) {
                try { devWin.close(); } catch { /* ignore */ }
            }
        });
    });

    if (!_dtDestroyGuards.has(tabId)) {
        _dtDestroyGuards.add(tabId);
        wc.once('destroyed', () => {
            _dtDestroyGuards.delete(tabId);
            const w = _purgeManagedEntry(tabId);
            if (w && !w.isDestroyed()) try { w.close(); } catch { /* ignore */ }
        });
    }

    try {
        wc.setDevToolsWebContents(devWin.webContents);
        wc.openDevTools({ mode: 'detach' });
    } catch {
        _purgeManagedEntry(tabId);
        if (!devWin.isDestroyed()) try { devWin.close(); } catch { /* ignore */ }
        return false;
    }

    try { devWin.setTitle(winTitle); } catch { /* ignore */ }
    devWin.show();
    devWin.focus();
    return true;
}

/**
 * Open, focus, or close DevTools for the active tab (F12 / toolbar / menu).
 * @param {{ view?: { webContents?: import('electron').WebContents } } | null | undefined} tab
 * @param {{ getAllTabs: () => Iterable<unknown>; getTab: (id: unknown) => unknown }} tabManager
 * @param {{ notifyHostileBlocked?: () => void }} [opts]
 * @returns {Promise<boolean>}
 */
async function toggleManagedDevToolsForTab(tab, tabManager, opts = {}) {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    if (isDevtoolsHostileWebContents(wc)) {
        await ensureDevToolsFullyClosed(wc, tab.id);
        if (typeof opts.notifyHostileBlocked === 'function') opts.notifyHostileBlocked();
        return false;
    }

    const tabId = tab.id;
    const managed = _dtByTabId.get(tabId);
    const open = (managed && !managed.isDestroyed()) || wc.isDevToolsOpened();
    if (open) {
        await ensureDevToolsFullyClosed(wc, tabId);
        return true;
    }
    return openManagedDevTools(wc, tabManager, tab);
}

/** For window switcher: BrowserWindow ids of managed DevTools (detach). */
function getManagedDevToolsWindowIds() {
    const ids = [];
    for (const [, bw] of _dtByTabId) {
        if (bw && !bw.isDestroyed()) {
            try { ids.push(bw.id); } catch { /* ignore */ }
        }
    }
    return ids;
}

/**
 * @param {{ tabManager?: { getAllTabs: () => Iterable<unknown>; getTab: (id: unknown) => unknown } }} ctx
 */
function getManagedDevToolsSwitcherEntries(ctx) {
    const out = [];
    for (const [tabId, bw] of _dtByTabId) {
        if (!bw || bw.isDestroyed()) continue;
        let tabNum = 1;
        let tabTitle = '';
        try {
            if (ctx && ctx.tabManager) {
                const tabList = Array.from(ctx.tabManager.getAllTabs());
                const idx = tabList.findIndex((t) => t.id === tabId);
                tabNum = idx >= 0 ? idx + 1 : 1;
                const tab = ctx.tabManager.getTab(tabId);
                if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                    tabTitle = tab.view.webContents.getTitle() || '';
                }
            }
        } catch { /* ignore */ }
        try {
            out.push({
                id: bw.id,
                title: `DevTools #${tabNum}`,
                type: 'devtools',
                devtoolsTabNum: tabNum,
                tabTitle: tabTitle || undefined,
            });
        } catch { /* ignore */ }
    }
    return out;
}

module.exports = {
    openManagedDevTools,
    toggleManagedDevToolsForTab,
    ensureDevToolsFullyClosed,
    getManagedDevToolsWindowIds,
    getManagedDevToolsSwitcherEntries,
};
