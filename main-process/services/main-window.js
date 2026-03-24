'use strict';

/**
 * Главное окно браузера и application menu.
 * @param {object} d — runtime handles + `sub` (результат createSubWindowsApi).
 */
function createMainWindowApi(d) {
    const { sub } = d;

    function confirmExitDialog(win) {
        // E2E / автотесты: Playwright закрывает приложение без блокирующих модалок
        // (иначе срабатывают и close главного окна, и before-quit — два диалога).
        if (process.env.CUPNET_E2E === '1') return true;
        const owner = (win && !win.isDestroyed()) ? win : (d.BrowserWindow.getFocusedWindow() || d.BrowserWindow.getAllWindows()[0]);
        const choice = d.dialog.showMessageBoxSync(owner, {
            type: 'question',
            buttons: ['Cancel', 'Exit'],
            defaultId: 1,
            cancelId: 0,
            title: 'Exit [CupNet]',
            message: 'Close [CupNet] and all windows?',
            detail: 'All browser windows, proxy workers, and active sessions will be closed.',
            noLink: true,
        });
        return choice === 1;
    }

    function applyRuntimeAppIcon() {
        try {
            const img = d.nativeImage.createFromPath(d.iconPath);
            if (img.isEmpty()) return;
            if (process.platform === 'darwin' && d.app.dock) {
                d.app.dock.setIcon(img);
            }
        } catch (e) {
            console.warn('[icon] applyRuntimeAppIcon failed:', e.message);
        }
    }

    function createMainWindow() {
        if (d.startupMetrics.windowCreatedTs === 0) d.startupMetrics.windowCreatedTs = Date.now();
        d.mainWindow = new d.BrowserWindow({
            width: 1200, height: 800, minWidth: 900, minHeight: 600,
            show: false,
            backgroundColor: '#0f1117',
            icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js') },
        });
        d.mainWindow.loadFile(d.getAssetPath('browser.html'));
        d.mainWindow.once('ready-to-show', () => {
            applyRuntimeAppIcon();
            try { d.mainWindow.maximize(); } catch (err) {
                d.safeCatch({ module: 'main', eventCode: 'window.lifecycle.failed', context: { op: 'maximize' } }, err, 'info');
            }
            try { d.mainWindow.show(); } catch (err) {
                d.safeCatch({ module: 'main', eventCode: 'window.lifecycle.failed', context: { op: 'show' } }, err, 'info');
            }
        });

        d.mainWindow.webContents.once('did-finish-load', async () => {
            const s = d.loadSettings();
            d.tabManager.setPasteUnlock(s.pasteUnlock !== false);
            if (s.bypassDomains?.length) d.applyBypassDomains(s.bypassDomains);
            if (s.trafficOpts) d.applyTrafficFilters(s.trafficOpts);

            const firstTabId = await d.tabManager.createTab(d.persistentAnonymizedProxyUrl || null, d.getNewTabUrl());
            d.tabManager.switchTab(firstTabId);
            const tab = d.tabManager.getTab(firstTabId);
            if (tab) {
                d.setupNetworkLogging(tab.view.webContents, firstTabId, tab.sessionId);
                d.interceptor.attachToSession(tab.tabSession, firstTabId);
                d.currentSessionId = tab.sessionId;
            }
            d.startLogStatusUpdater();
            try { d.db.deleteEmptySessions(d.currentSessionId); } catch (e) { d.sysLog('warn', 'db', 'deleteEmptySessions failed: ' + (e?.message || e)); }

            d.mainWindow.webContents.send('init-settings', {
                filterPatterns: s.filterPatterns || [],
                pasteUnlock: s.pasteUnlock !== false,
                bypassDomains: s.bypassDomains || [],
                tracking: d.getTrackingSettings(),
            });
            d.notifyProxyProfilesList();
            d.notifyProxyStatus();
        });

        d.mainWindow.webContents.on('before-input-event', (event, input) => {
            const tab = d.tabManager ? d.tabManager.getActiveTab() : null;
            if (!tab || tab.view.webContents.isDestroyed()) return;
            if (input.key === 'F12' && input.type === 'keyDown') {
                tab.view.webContents.toggleDevTools();
                event.preventDefault();
            }
            if ((input.key === 'F5' || (input.key === 'r' && input.control)) && input.type === 'keyDown') {
                tab.view.webContents.reload();
                event.preventDefault();
            }
        });

        d.mainWindow.on('focus', () => { d.isWindowActive = true; d.lastMouseMoveTime = Date.now(); });
        d.mainWindow.on('blur', () => { d.isWindowActive = false; });
        d.mainWindow.on('resize', () => d.tabManager.relayout());
        d.mainWindow.on('close', (e) => {
            if (d.forceAppQuit) return;
            if (!confirmExitDialog(d.mainWindow)) {
                e.preventDefault();
                return;
            }
            d.forceAppQuit = true;
        });
        d.mainWindow.on('closed', () => {
            d.mainWindow = null;
            d.app.quit();
        });

        d.tabManager.init(d.mainWindow, async (event, tabId, data) => {
            if (event === 'open-in-new-tab') {
                const newTabId = await d.tabManager.createTab(d.persistentAnonymizedProxyUrl || null, data.url, false, d.currentSessionId);
                d.tabManager.switchTab(newTabId);
                const newTab = d.tabManager.getTab(newTabId);
                if (newTab) {
                    d.setupNetworkLogging(newTab.view.webContents, newTabId, d.currentSessionId);
                    d.interceptor.attachToSession(newTab.tabSession, newTabId);
                }
                sub.notifyCookieManagerTabs();
                return;
            }
            if (d.mainWindow && !d.mainWindow.isDestroyed()) {
                d.mainWindow.webContents.send(event, { tabId, ...data });
            }
            if (event === 'tab-title-changed' || event === 'tab-url-changed' || event === 'url-updated') {
                sub.notifyCookieManagerTabs();
            }
            if (event === 'tab-switched') {
                sub.notifyCookieManagerTabs();
                if (d.cookieManagerWindow && !d.cookieManagerWindow.isDestroyed()) {
                    d.cookieManagerWindow.webContents.send('set-active-tab', tabId);
                }
            }
        });

        buildMenu();
        d.isWindowActive = true;
        d.lastMouseMoveTime = Date.now();
    }

    function buildMenu() {
        const menu = d.Menu.buildFromTemplate([
            {
                label: 'File', submenu: [
                    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: async () => {
                        if (!d.tabManager || !d.mainWindow) return;
                        const id = await d.tabManager.createTab(d.persistentAnonymizedProxyUrl || null, d.getNewTabUrl(), false, d.currentSessionId);
                        d.tabManager.switchTab(id);
                        const tab = d.tabManager.getTab(id);
                        if (tab) { d.setupNetworkLogging(tab.view.webContents, id, d.currentSessionId); d.interceptor.attachToSession(tab.tabSession, id); }
                        sub.notifyCookieManagerTabs();
                    }},
                    { label: 'New Isolated Tab', accelerator: 'CmdOrCtrl+Shift+T', click: async () => {
                        if (!d.tabManager || !d.mainWindow) return;
                        const id = await d.tabManager.createTab(d.persistentAnonymizedProxyUrl || null, d.getNewTabUrl(), true, null);
                        d.tabManager.switchTab(id);
                        const tab = d.tabManager.getTab(id);
                        if (tab) {
                            d.setupNetworkLogging(tab.view.webContents, id, d.currentSessionId);
                            if (d.interceptor) {
                                try { d.interceptor.attachToSession(tab.tabSession, id); } catch (e) {
                                    d.safeCatch({ module: 'main', eventCode: 'interceptor.attach.failed', context: { tabId: id, source: 'menu.new-isolated-tab' } }, e);
                                }
                            }
                        }
                        sub.notifyCookieManagerTabs();
                    }},
                    { label: 'New Direct Tab', accelerator: 'CmdOrCtrl+Shift+D', click: async () => {
                        if (!d.tabManager || !d.mainWindow) return;
                        const id = await d.tabManager.createDirectTab(d.getNewTabUrl());
                        d.tabManager.switchTab(id);
                        sub.notifyCookieManagerTabs();
                    }},
                    { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => {
                        if (!d.tabManager) return;
                        const id = d.tabManager.getActiveTabId();
                        if (id) d.tabManager.closeTab(id);
                    }},
                    { type: 'separator' },
                    { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => {
                        d.mainWindow?.webContents.send('focus-url-bar');
                    }},
                    { type: 'separator' },
                    { label: 'Proxy Manager', accelerator: 'CmdOrCtrl+P', click: () => sub.createProxyManagerWindow() },
                    { label: 'Network Activity', accelerator: 'CmdOrCtrl+Shift+L', click: () => sub.createLogViewerWindow() },
                    { label: 'Cookie Manager', accelerator: 'CmdOrCtrl+Shift+C', click: () => sub.createCookieManagerWindow(d.tabManager?.getActiveTabId()) },
                    { label: 'DNS Manager', accelerator: 'CmdOrCtrl+Shift+M', click: () => sub.createDnsManagerWindow() },
                    { label: 'Rules & Interceptor', click: () => sub.createRulesWindow() },
                    { label: 'System Console', accelerator: 'CmdOrCtrl+Shift+K', click: () => sub.createConsoleViewerWindow() },
                    { label: 'Page Analyzer', accelerator: 'CmdOrCtrl+Shift+A', click: () => sub.createPageAnalyzerWindow() },
                    { label: 'API Scout', click: () => sub.createIvacScoutWindow() },
                    { type: 'separator' },
                    { label: 'Enable Logging', type: 'checkbox', checked: d.isLoggingEnabled,
                      click: (item) => {
                          d.isLoggingEnabled = item.checked;
                          if (item.checked && d.tabManager && d.setupNetworkLogging) {
                              const sid = d.currentSessionId;
                              for (const tab of d.tabManager.getAllTabs()) {
                                  if (tab.direct) continue;
                                  const wc = tab.view?.webContents;
                                  if (!wc || wc.isDestroyed()) continue;
                                  const effectiveSid = sid ?? tab.sessionId;
                                  if (effectiveSid == null) continue;
                                  tab.sessionId = effectiveSid;
                                  d.setupNetworkLogging(wc, tab.id, effectiveSid);
                              }
                          }
                          d.sendLogStatus();
                      } },
                    { label: 'Take Screenshot', accelerator: 'F2', click: () => {
                        d.requestScreenshot({ reason: 'click' }).catch((err) => {
                            d.safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'click', source: 'app-activate' } }, err, 'info');
                        });
                    }},
                    { type: 'separator' },
                    { role: 'quit', label: 'Exit' },
                ],
            },
            { label: 'Edit', submenu: [
                { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
            ]},
            { label: 'View', submenu: [
                { label: 'Reload Page', accelerator: 'CmdOrCtrl+R',
                  click: () => d.tabManager?.getActiveTab()?.view.webContents.reload() },
                { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R',
                  click: () => d.tabManager?.getActiveTab()?.view.webContents.reloadIgnoringCache() },
                { label: 'Developer Tools (Page)', accelerator: 'F12',
                  click: () => d.tabManager?.getActiveTab()?.view.webContents.toggleDevTools() },
                { label: 'Developer Tools (Shell)', accelerator: 'CmdOrCtrl+Shift+I',
                  click: () => d.mainWindow?.webContents.toggleDevTools() },
                { type: 'separator' },
                { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => { d.mainWindow?.webContents.send('switch-tab-rel', 1); }},
                { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => { d.mainWindow?.webContents.send('switch-tab-rel', -1); }},
                { type: 'separator' },
                { label: 'Trace', click: () => {
                    const s = d.settingsStore.getCached() || d.loadSettings();
                    if (s.traceMode || (d.db && d.db.countTraceEntries() > 0)) sub.createTraceViewerWindow();
                }},
            ]},
        ]);
        d.Menu.setApplicationMenu(menu);
    }

    return { confirmExitDialog, applyRuntimeAppIcon, createMainWindow, buildMenu };
}

module.exports = { createMainWindowApi };
