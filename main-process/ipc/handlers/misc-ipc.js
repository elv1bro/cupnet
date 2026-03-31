'use strict';

/**
 * Uptime, splash, version, ui-pref, IP geo.
 * @param {object} ctx
 */
function registerMiscIpc(ctx) {
    const _appStartTime = Date.now();
    let _startupSplashConsumed = false;
    function consumeStartupSplashState() {
        if (_startupSplashConsumed) return { show: false, durationMs: 0 };
        _startupSplashConsumed = true;
        return { show: true, durationMs: 3000 };
    }
    ctx.ipcMain.handle('get-uptime', () => Date.now() - _appStartTime);
    ctx.ipcMain.handle('consume-startup-splash', () => consumeStartupSplashState());
    ctx.ipcMain.handle('get-app-version', () => ctx.app.getVersion());

    ctx.ipcMain.handle('get-ui-pref', (_, key, def) => {
        const v = ctx.uiPrefsStore.loadUiPrefs()[key];
        return v !== undefined ? v : (def !== undefined ? def : null);
    });
    ctx.ipcMain.handle('set-ui-pref', (_, key, value) => { ctx.uiPrefsStore.saveUiPref(key, value); return true; });

    ctx.ipcMain.handle('check-ip-geo', async (_, tabId) => ctx.checkCurrentIpGeo(tabId));

    ctx.ipcMain.handle('get-direct-ip', async () => {
        try {
            const directSess = ctx.session.fromPartition('direct-ip-check');
            await directSess.setProxy({ mode: 'direct' });
            const win = new ctx.BrowserWindow({ show: false, webPreferences: { session: directSess } });
            try {
                await win.loadURL('https://ipinfo.io/json');
                const text = await win.webContents.executeJavaScript('document.body.innerText');
                const d = JSON.parse(text);
                return { ip: d.ip || '', city: d.city || '', country: d.country || '', country_name: d.country || '', region: d.region || '', org: d.org || '' };
            } finally {
                win.destroy();
            }
        } catch (e) {
            ctx.sysLog('warn', 'direct-ip', 'Failed to get direct IP: ' + (e?.message || e));
            return { ip: '', city: '', country: '', country_name: '' };
        }
    });

    // ── Window switcher (overlay in browser shell) ─────────────────────────
    const { getManagedDevToolsWindowIds, getManagedDevToolsSwitcherEntries } = require('./cookies-dns-ipc');

    /** MRU focus order (0 = last focused). Drives secondary window ordering; main is always first in the list. */
    const _winFocusMru = [];
    let _winFocusHookRegistered = false;
    function _ensureBrowserWindowFocusHook() {
        if (_winFocusHookRegistered) return;
        _winFocusHookRegistered = true;
        ctx.app.on('browser-window-focus', (_event, win) => {
            if (!win || win.isDestroyed()) return;
            const id = win.id;
            const i = _winFocusMru.indexOf(id);
            if (i >= 0) _winFocusMru.splice(i, 1);
            _winFocusMru.unshift(id);
        });
    }
    _ensureBrowserWindowFocusHook();

    function _focusRankForSwitcher(id) {
        const i = _winFocusMru.indexOf(id);
        return i === -1 ? 1e9 : i;
    }

    /** Max thumbnail size: ¼ of main window content, else ¼ of primary work area. */
    function _getSwitcherThumbnailMaxDims() {
        let w = 0;
        let h = 0;
        try {
            if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
                const s = ctx.mainWindow.getContentSize();
                w = s[0];
                h = s[1];
            }
        } catch (_) { /* ignore */ }
        if (!w || !h) {
            try {
                const { screen } = require('electron');
                const wa = screen.getPrimaryDisplay().workAreaSize;
                w = wa.width;
                h = wa.height;
            } catch (_) {
                w = 1920;
                h = 1080;
            }
        }
        return {
            maxW: Math.max(1, Math.floor(w / 4)),
            maxH: Math.max(1, Math.floor(h / 4)),
        };
    }

    function _classifyCupnetWindow(win, ctx) {
        if (!win || win.isDestroyed()) return null;
        if (ctx.mainWindow && win.id === ctx.mainWindow.id) return null;
        if (getManagedDevToolsWindowIds().includes(win.id)) return 'devtools';
        if (ctx.consoleViewerWindow && !ctx.consoleViewerWindow.isDestroyed() && win.id === ctx.consoleViewerWindow.id) return 'console';
        if (ctx.cookieManagerWindow && !ctx.cookieManagerWindow.isDestroyed() && win.id === ctx.cookieManagerWindow.id) return 'cookie-manager';
        if (ctx.dnsManagerWindow && !ctx.dnsManagerWindow.isDestroyed() && win.id === ctx.dnsManagerWindow.id) return 'dns-manager';
        if (ctx.proxyManagerWindow && !ctx.proxyManagerWindow.isDestroyed() && win.id === ctx.proxyManagerWindow.id) return 'proxy-manager';
        if (ctx.rulesWindow && !ctx.rulesWindow.isDestroyed() && win.id === ctx.rulesWindow.id) return 'rules';
        if (ctx.compareViewerWindow && !ctx.compareViewerWindow.isDestroyed() && win.id === ctx.compareViewerWindow.id) return 'compare-viewer';
        if (ctx.pageAnalyzerWindow && !ctx.pageAnalyzerWindow.isDestroyed() && win.id === ctx.pageAnalyzerWindow.id) return 'page-analyzer';
        if (ctx.notesWindow && !ctx.notesWindow.isDestroyed() && win.id === ctx.notesWindow.id) return 'notes';
        if (ctx.ivacScoutWindow && !ctx.ivacScoutWindow.isDestroyed() && win.id === ctx.ivacScoutWindow.id) return 'ivac-scout';
        if (ctx.loggingModalWindow && !ctx.loggingModalWindow.isDestroyed() && win.id === ctx.loggingModalWindow.id) return 'logging-modal';
        if (ctx.logViewerWindows && Array.isArray(ctx.logViewerWindows)) {
            for (const w of ctx.logViewerWindows) {
                if (w && !w.isDestroyed() && win.id === w.id) return 'log-viewer';
            }
        }
        if (ctx.traceWindows && Array.isArray(ctx.traceWindows)) {
            for (const w of ctx.traceWindows) {
                if (w && !w.isDestroyed() && win.id === w.id) return 'trace-viewer';
            }
        }
        if (ctx.requestEditorWindow && !ctx.requestEditorWindow.isDestroyed() && win.id === ctx.requestEditorWindow.id) {
            return 'request-editor';
        }
        if (ctx.requestEditorExtraWindows && Array.isArray(ctx.requestEditorExtraWindows)) {
            for (const w of ctx.requestEditorExtraWindows) {
                if (w && !w.isDestroyed() && win.id === w.id) return 'request-editor';
            }
        }
        return 'unknown';
    }

    /** PNG data URL from a webContents; scaled to fit within maxW×maxH (window switcher previews). */
    async function _thumbnailDataUrlFromWebContents(wc, maxW, maxH) {
        if (!wc || wc.isDestroyed()) return null;
        try {
            const img = await wc.capturePage();
            const size = img.getSize();
            if (!size.width || !size.height) return null;
            const mw = maxW != null ? maxW : 220;
            const mh = maxH != null ? maxH : 132;
            const scale = Math.min(mw / size.width, mh / size.height, 1);
            const tw = Math.max(1, Math.round(size.width * scale));
            const th = Math.max(1, Math.round(size.height * scale));
            const out = scale < 1 ? img.resize({ width: tw, height: th }) : img;
            return out.toDataURL();
        } catch (_) {
            return null;
        }
    }

    async function _thumbnailDataUrlForWindow(win, maxW, maxH) {
        if (!win || win.isDestroyed()) return null;
        return _thumbnailDataUrlFromWebContents(win.webContents, maxW, maxH);
    }

    /**
     * Main window preview must use the active tab BrowserView — capturePage on the shell
     * webContents does not include the BrowserView layer, so it would never update with the site.
     */
    async function _thumbnailDataUrlForMainWindowEntry(maxW, maxH) {
        try {
            if (ctx.tabManager && typeof ctx.tabManager.getActiveTab === 'function') {
                const at = ctx.tabManager.getActiveTab();
                const twc = at && at.view && at.view.webContents && !at.view.webContents.isDestroyed()
                    ? at.view.webContents
                    : null;
                if (twc) {
                    const u = await _thumbnailDataUrlFromWebContents(twc, maxW, maxH);
                    if (u) return u;
                }
            }
        } catch (_) { /* ignore */ }
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
            return _thumbnailDataUrlFromWebContents(ctx.mainWindow.webContents, maxW, maxH);
        }
        return null;
    }

    /**
     * @param {unknown} opts `includePreviews: false` skips capturePage — fast path for opening the switcher UI first.
     */
    ctx.ipcMain.handle('get-open-windows', async (_evt, opts) => {
        try {
            const includePreviews = !(opts && typeof opts === 'object' && opts.includePreviews === false);
            const all = ctx.BrowserWindow.getAllWindows();
            const seen = new Set();
            const head = [];
            if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
                seen.add(ctx.mainWindow.id);
                const mainEntry = {
                    id: ctx.mainWindow.id,
                    title: 'CupNet',
                    type: 'cupnet-main',
                };
                if (includePreviews) {
                    const { maxW, maxH } = _getSwitcherThumbnailMaxDims();
                    const mainPreview = await _thumbnailDataUrlForMainWindowEntry(maxW, maxH);
                    if (mainPreview) mainEntry.previewDataUrl = mainPreview;
                }
                head.push(mainEntry);
            }
            const devtoolsMetaById = new Map(
                getManagedDevToolsSwitcherEntries(ctx).map((e) => [e.id, e])
            );
            const rest = [];
            for (const win of all) {
                if (!win || win.isDestroyed()) continue;
                if (seen.has(win.id)) continue;
                const type = _classifyCupnetWindow(win, ctx);
                if (type === null) continue;
                seen.add(win.id);
                let title = '';
                try { title = win.getTitle() || ''; } catch (_) { title = ''; }
                let entry = { id: win.id, title: title || type, type };
                if (type === 'devtools') {
                    const dm = devtoolsMetaById.get(win.id);
                    if (dm) {
                        entry = {
                            id: win.id,
                            type: 'devtools',
                            title: dm.title,
                            devtoolsTabNum: dm.devtoolsTabNum,
                            ...(dm.tabTitle ? { tabTitle: dm.tabTitle } : {}),
                        };
                    }
                }
                rest.push(entry);
            }
            rest.sort((a, b) => {
                const ra = _focusRankForSwitcher(a.id);
                const rb = _focusRankForSwitcher(b.id);
                if (ra !== rb) return ra - rb;
                return `${a.type}\t${a.title}`.localeCompare(`${b.type}\t${b.title}`);
            });
            if (!includePreviews) {
                return { windows: [...head, ...rest] };
            }
            const { maxW, maxH } = _getSwitcherThumbnailMaxDims();
            const restWithPreview = await Promise.all(
                rest.map(async (w) => {
                    const bw = ctx.BrowserWindow.fromId(w.id);
                    const previewDataUrl = await _thumbnailDataUrlForWindow(bw, maxW, maxH);
                    return { ...w, previewDataUrl };
                })
            );
            return { windows: [...head, ...restWithPreview] };
        } catch (e) {
            ctx.sysLog?.('warn', 'windows', 'get-open-windows: ' + (e?.message || e));
            return { windows: [] };
        }
    });

    ctx.ipcMain.handle('focus-window-by-id', (_, winId) => {
        try {
            const id = Number(winId);
            const w = ctx.BrowserWindow.fromId(id);
            if (!w || w.isDestroyed()) return false;
            if (w.isMinimized()) w.restore();
            w.show();
            w.focus();
            return true;
        } catch (_) {
            return false;
        }
    });

    ctx.ipcMain.handle('set-window-switcher-overlay-visible', (_, visible) => {
        try {
            if (ctx.tabManager && typeof ctx.tabManager.setWindowSwitcherOverlayVisible === 'function') {
                ctx.tabManager.setWindowSwitcherOverlayVisible(!!visible);
            }
            return true;
        } catch (_) {
            return false;
        }
    });
}

module.exports = { registerMiscIpc };
