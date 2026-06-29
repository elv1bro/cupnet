'use strict';

const fs = require('fs');
const path = require('path');
const { Menu } = require('electron');

const INJECT_SRC = fs.readFileSync(
    path.join(__dirname, '../injected/page-http-lab.inject.js'),
    'utf8',
);

const INTERNAL_FILE_MARKERS = [
    'new-tab.html',
    'settings.html',
    'cupnet-guide.html',
    'browser.html',
    'log-viewer.html',
    'session-profile-modal.html',
];

/** @type {Set<number>} tab ids with HTTP Lab active (persists across navigations) */
const httpLabActiveTabIds = new Set();

function setHttpLabActive(tabId, active) {
    const id = Number(tabId);
    if (!Number.isFinite(id)) return;
    if (active) httpLabActiveTabIds.add(id);
    else httpLabActiveTabIds.delete(id);
}

function isHttpLabActive(tabId) {
    return httpLabActiveTabIds.has(Number(tabId));
}

function isHttpLabEligibleUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    if (url.startsWith('file://')) {
        return !INTERNAL_FILE_MARKERS.some((m) => url.includes(m));
    }
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function buildInjectScript(options = {}) {
    return `(${INJECT_SRC})(${JSON.stringify(options || {})})`;
}

/**
 * Inject the in-page HTTP Lab panel into a tab webContents.
 * @param {import('electron').WebContents} webContents
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function injectPageHttpLab(webContents, options = {}, tabId = null) {
    if (!webContents || webContents.isDestroyed()) {
        return { ok: false, error: 'tab-not-found' };
    }
    const url = webContents.getURL() || '';
    if (!isHttpLabEligibleUrl(url)) {
        return { ok: false, error: 'page-not-eligible' };
    }
    try {
        await webContents.executeJavaScript(buildInjectScript(options), true);
        if (tabId != null && options.dismiss !== true) {
            setHttpLabActive(tabId, true);
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

/**
 * Re-inject HTTP Lab after navigation when the tab still has it active.
 * @param {number} tabId
 * @param {import('electron').WebContents} webContents
 */
async function maybeRestorePageHttpLab(tabId, webContents) {
    if (!isHttpLabActive(tabId)) return { ok: false, skipped: true };
    if (!webContents || webContents.isDestroyed()) return { ok: false, error: 'tab-not-found' };
    const url = webContents.getURL() || '';
    if (!isHttpLabEligibleUrl(url)) return { ok: false, skipped: true };
    return injectPageHttpLab(webContents, { restore: true, skipLog: true }, tabId);
}

function handleHttpLabUiState(tabId, state = {}) {
    if (state.active === false) {
        setHttpLabActive(tabId, false);
        return;
    }
    if (state.active === true) {
        setHttpLabActive(tabId, true);
    }
}

/**
 * Attach native context menu with Web Request Tools submenu.
 * @param {{ id: number, view: import('electron').WebContentsView }} tab
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
function attachTabWebRequestToolsContextMenu(tab, getMainWindow, onOpenLinkInNewTab) {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return;

    wc.on('context-menu', (event, params) => {
        const pageUrl = params.pageURL || wc.getURL() || '';
        if (!isHttpLabEligibleUrl(pageUrl)) return;

        event.preventDefault();

        const injectOpts = (extra = {}) => ({
            clickX: params.x,
            clickY: params.y,
            ...extra,
        });

        const template = [
            {
                label: 'Web Request Tools',
                submenu: [
                    {
                        label: 'Open HTTP Lab',
                        click: () => { void injectPageHttpLab(wc, injectOpts(), tab.id); },
                    },
                    {
                        label: 'Open minimized (bubble)',
                        click: () => { void injectPageHttpLab(wc, injectOpts({ startMinimized: true }), tab.id); },
                    },
                    {
                        label: 'Open & import all page forms',
                        click: () => { void injectPageHttpLab(wc, injectOpts({ importForms: true }), tab.id); },
                    },
                    {
                        label: 'Open & import form under cursor',
                        click: () => { void injectPageHttpLab(wc, injectOpts({ importForms: true, focusForm: true }), tab.id); },
                    },
                ],
            },
            { type: 'separator' },
        ];

        if (params.linkURL && typeof onOpenLinkInNewTab === 'function') {
            template.push({
                label: 'Open Link in New Tab',
                click: () => { onOpenLinkInNewTab(params.linkURL, pageUrl); },
            });
        }

        if (params.selectionText && params.selectionText.trim()) {
            template.push({ role: 'copy', label: 'Copy' });
        }
        if (params.isEditable) {
            template.push({ role: 'cut', label: 'Cut' });
            template.push({ role: 'copy', label: 'Copy' });
            template.push({ role: 'paste', label: 'Paste' });
        } else if (!params.selectionText) {
            template.push({ role: 'copy', label: 'Copy' });
        }

        template.push({ type: 'separator' });
        template.push({
            label: 'Inspect Element',
            click: () => { wc.inspectElement(params.x, params.y); },
        });

        const win = getMainWindow?.();
        Menu.buildFromTemplate(template).popup({
            window: win && !win.isDestroyed() ? win : undefined,
        });
    });
}

module.exports = {
    INJECT_SRC,
    isHttpLabEligibleUrl,
    buildInjectScript,
    injectPageHttpLab,
    maybeRestorePageHttpLab,
    setHttpLabActive,
    isHttpLabActive,
    handleHttpLabUiState,
    attachTabWebRequestToolsContextMenu,
};
