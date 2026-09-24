'use strict';

const { screen } = require('electron');
const { registerTrustedShell } = require('../ipc/ipc-trusted-sender.js');
const { getNoteDomainFromUrl } = require('../../note-domain-utils.js');
const profileSession = require('./profile-session.js');
const windowStateStore = require('./window-state-store');

/**
 * * Secondary BrowserWindows, compare helpers, DNS/cookie/modal/proxy/rules windows.
 * @param {object} d — runtime handles (getters/setters + shared arrays/maps). Built in cupnet-runtime.js.
 */
function createSubWindowsApi(d) {
    function _spawnRequestEditorBrowserWindow(title) {
        const win = new d.BrowserWindow({
            width: 1250, height: 780, minWidth: 760, minHeight: 540,
            title: title || 'Request Editor', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        registerTrustedShell(win.webContents);
        return win;
    }

    function _spawnTrustedToolWindow(opts) {
        const win = new d.BrowserWindow(opts);
        registerTrustedShell(win.webContents);
        return win;
    }

    /** Основное окно: тулбар, open-request-editor из Log — фокус и тот же инстанс. */
    function openRequestEditorWindow(data) {
        const payload = data != null ? data : { method: 'GET', url: '', headers: {}, body: '' };
        if (d.requestEditorWindow && !d.requestEditorWindow.isDestroyed()) {
            d.requestEditorWindow.show();
            d.requestEditorWindow.focus();
            const wc = d.requestEditorWindow.webContents;
            const send = () => {
                try { wc.send('request-editor-init', payload); } catch (_) { /* ignore */ }
            };
            if (wc.isLoading()) wc.once('did-finish-load', send);
            else send();
            return;
        }
        const win = _spawnRequestEditorBrowserWindow('Request Editor');
        d.requestEditorWindow = win;
        win.webContents.once('did-finish-load', () => {
            try { win.webContents.send('request-editor-init', payload); } catch (_) { /* ignore */ }
        });
        win.loadFile(d.getAssetPath('request-editor.html'));
        win.on('closed', () => {
            if (d.requestEditorWindow === win) d.requestEditorWindow = null;
        });
    }

    /** Дополнительное окно — только через «+ New window» в UI. */
    function openRequestEditorNewWindow(data) {
        const payload = data != null ? data : { method: 'GET', url: '', headers: {}, body: '' };
        const n = (d.requestEditorExtraWindows?.length || 0) + 2;
        const title = n <= 2 ? 'Request Editor (2)' : `Request Editor (${n})`;
        const win = _spawnRequestEditorBrowserWindow(title);
        d.requestEditorExtraWindows.push(win);
        win.webContents.once('did-finish-load', () => {
            try { win.webContents.send('request-editor-init', payload); } catch (_) { /* ignore */ }
        });
        win.loadFile(d.getAssetPath('request-editor.html'));
        win.on('closed', () => {
            const idx = d.requestEditorExtraWindows.indexOf(win);
            if (idx !== -1) d.requestEditorExtraWindows.splice(idx, 1);
        });
    }

    /** Совместимость IPC: открыть ещё одно окно (как раньше createRequestEditorWindow). */
    const createRequestEditorWindow = openRequestEditorNewWindow;

    function createLogViewerWindow(sessionId = null) {
        const cascadeOffset = d.logViewerWindows.length * 30;
        const lvDefaults = {
            width: 1200, height: 860, minWidth: 800, minHeight: 500, isMaximized: false,
        };
        let savedLv = windowStateStore.getWindowBounds('logViewer', d.app, lvDefaults);
        try {
            const display = screen.getDisplayNearestPoint({
                x: Number.isFinite(savedLv.x) ? savedLv.x : 0,
                y: Number.isFinite(savedLv.y) ? savedLv.y : 0,
            });
            savedLv = { ...savedLv, ...windowStateStore.sanitizeBounds(savedLv, display) };
        } catch (_) { /* ignore */ }

        const win = _spawnTrustedToolWindow({
            x: savedLv.x,
            y: savedLv.y,
            width: savedLv.width,
            height: savedLv.height,
            minWidth: lvDefaults.minWidth,
            minHeight: lvDefaults.minHeight,
            title: sessionId ? `Network Activity — Session #${sessionId}` : 'Network Activity',
            icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js') }
        });

        if (savedLv.isMaximized) {
            try { win.maximize(); } catch (_) { /* ignore */ }
        } else if (cascadeOffset > 0) {
            const [x, y] = win.getPosition();
            win.setPosition(x + cascadeOffset, y + cascadeOffset);
        }

        win.loadFile(d.getAssetPath('log-viewer.html'));

        // Track preselected session for this window
        const wcId = win.webContents.id;
        d.logViewerInitSessions.set(wcId, sessionId);

        d.logViewerWindows.push(win);
        d.logViewerWindow = win;

        win.webContents.once('did-finish-load', () => {
            const payload = d.isLoggingEnabled && d.currentSessionId
                ? { enabled: true, sessionId: d.currentSessionId, count: d.logEntryCount }
                : { enabled: false, sessionId: null, count: 0 };
            win.webContents.send('update-log-status', payload);
        });

        win.on('close', () => {
            try {
                windowStateStore.saveWindowBounds('logViewer', d.app, win);
            } catch (_) { /* ignore */ }
        });
        win.on('closed', () => {
            d.logViewerInitSessions.delete(wcId);
            const idx = d.logViewerWindows.indexOf(win);
            if (idx !== -1) d.logViewerWindows.splice(idx, 1);
            if (d.logViewerWindow === win) d.logViewerWindow = d.logViewerWindows[d.logViewerWindows.length - 1] || null;
        });
    }

    function _serializeCompareRowRequest(req) {
        if (!req) return null;
        return {
            id: req.id,
            url: req.url || '',
            method: req.method || 'GET',
            status: req.status ?? null,
            created_at: req.created_at || null,
            session_id: req.session_id ?? null,
            match_key: d.diffUtils.requestMatchKey(req),
        };
    }

    function _comparePayload() {
        return {
            left: d.comparePair.left ? { ...d.comparePair.left } : null,
            right: d.comparePair.right ? { ...d.comparePair.right } : null,
            result: d.compareResult,
        };
    }

    function _requestsForSessionAsc(sessionId) {
        if (!sessionId) return [];
        const rows = d.db.queryRequestsFull({ sessionId: Number(sessionId) }, 10000, 0);
        return rows.slice().reverse();
    }

    function _parseHeadersMaybe(h) {
        if (!h) return {};
        if (typeof h === 'string') {
            try { return JSON.parse(h); } catch { return {}; }
        }
        if (typeof h === 'object') return { ...h };
        return {};
    }

    function _stripNoiseHeaders(headers, enabled) {
        if (!enabled) return headers;
        const noise = new Set([
            'date', 'expires', 'last-modified', 'etag', 'age',
            'x-request-id', 'x-correlation-id', 'x-amzn-trace-id',
            'cf-ray', 'cf-cache-status', 'server-timing',
            'x-served-by', 'x-cache', 'x-cache-hits', 'x-timer',
            'set-cookie',
        ]);
        const out = {};
        for (const [k, v] of Object.entries(headers || {})) {
            if (!noise.has(String(k || '').toLowerCase())) out[k] = v;
        }
        return out;
    }

    function _reqWithCompareOptions(req, options) {
        const out = { ...req };
        out.request_headers = _stripNoiseHeaders(_parseHeadersMaybe(req.request_headers), !!options?.removeNoiseHeaders);
        out.response_headers = _stripNoiseHeaders(_parseHeadersMaybe(req.response_headers), !!options?.removeNoiseHeaders);
        return out;
    }

    function _safeUrl(url) {
        try { return new URL(String(url || '')); } catch { return null; }
    }

    function _queryKeys(url) {
        const u = _safeUrl(url);
        if (!u) return new Set();
        return new Set(Array.from(u.searchParams.keys()).map(k => k.toLowerCase()));
    }

    function _pathTokens(url) {
        const u = _safeUrl(url);
        const p = u?.pathname || String(url || '').split('?')[0] || '';
        return p.split('/').filter(Boolean).map(s => s.toLowerCase());
    }

    function _tokenSimilarity(aTokens, bTokens) {
        const a = new Set(aTokens);
        const b = new Set(bTokens);
        if (!a.size && !b.size) return 1;
        const inter = [...a].filter(x => b.has(x)).length;
        const union = new Set([...a, ...b]).size || 1;
        return inter / union;
    }

    function _statusClass(code) {
        const n = Number(code || 0);
        if (!n) return 0;
        return Math.floor(n / 100);
    }

    function _pairScore(leftReq, rightReq, i, j, level = 'standard') {
        const leftKey = d.diffUtils.requestMatchKey(leftReq);
        const rightKey = d.diffUtils.requestMatchKey(rightReq);
        const exactKey = leftKey && rightKey && leftKey === rightKey;
        const leftMethod = String(leftReq.method || '').toUpperCase();
        const rightMethod = String(rightReq.method || '').toUpperCase();
        const sameMethod = leftMethod === rightMethod;
        const pathSim = _tokenSimilarity(_pathTokens(leftReq.url), _pathTokens(rightReq.url));
        const sameStatusClass = _statusClass(leftReq.status) === _statusClass(rightReq.status);
        const lq = _queryKeys(leftReq.url);
        const rq = _queryKeys(rightReq.url);
        const qInter = [...lq].filter(k => rq.has(k)).length;
        const qUnion = new Set([...lq, ...rq]).size || 1;
        const qSim = qInter / qUnion;
        const indexPenalty = Math.min(Math.abs(i - j), 40);
        let score = 0;
        if (exactKey) score += 100;
        if (sameMethod) score += 18;
        score += Math.round(pathSim * (level === 'deep' ? 24 : 12));
        score += Math.round(qSim * 14);
        if (sameStatusClass) score += 6;
        score -= indexPenalty;
        const allowFallback = level === 'deep';
        const acceptable = exactKey || (allowFallback && sameMethod && pathSim >= 0.55);
        return { score, acceptable, exactKey };
    }

    function _confidence(score, exactKey) {
        if (exactKey && score >= 105) return 'high';
        if (score >= 80) return 'high';
        if (score >= 60) return 'medium';
        return 'low';
    }


    function _broadcastCompareUpdated() {
        const payload = _comparePayload();
        try {
            if (d.compareViewerWindow && !d.compareViewerWindow.isDestroyed()) {
                d.compareViewerWindow.webContents.send('compare-updated', payload);
            }
        } catch (err) {
            d.safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'compare-updated.primary' } }, err, 'info');
        }
        for (const w of d.logViewerWindows) {
            try {
                if (!w.isDestroyed()) w.webContents.send('compare-updated', payload);
            } catch (err) {
                d.safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'compare-updated.viewer' } }, err, 'info');
            }
        }
    }

    function createCompareViewerWindow() {
        if (d.compareViewerWindow && !d.compareViewerWindow.isDestroyed()) {
            d.compareViewerWindow.focus();
            _broadcastCompareUpdated();
            return d.compareViewerWindow;
        }
        d.compareViewerWindow = _spawnTrustedToolWindow({
            width: 1360,
            height: 920,
            minWidth: 980,
            minHeight: 680,
            title: 'Compare',
            icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        d.compareViewerWindow.loadFile(d.getAssetPath('compare-viewer.html'));
        d.compareViewerWindow.webContents.once('did-finish-load', () => {
            _broadcastCompareUpdated();
        });
        d.compareViewerWindow.on('closed', () => { d.compareViewerWindow = null; });
        return d.compareViewerWindow;
    }

    function getLiveLogViewerWindow() {
        return d.logViewerWindows.find(w =>
            !w.isDestroyed() && !d.logViewerInitSessions.get(w.webContents.id)
        ) || null;
    }

    function createConsoleViewerWindow() {
        if (d.consoleViewerWindow && !d.consoleViewerWindow.isDestroyed()) {
            d.consoleViewerWindow.focus();
            return;
        }
        d.consoleViewerWindow = _spawnTrustedToolWindow({
            width: 1000, height: 600, minWidth: 600, minHeight: 300,
            title: 'System Console', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        d.consoleViewerWindow.loadFile(d.getAssetPath('console-viewer.html'));
        d.consoleViewerWindow.on('closed', () => { d.consoleViewerWindow = null; });
    }

    function createPageAnalyzerWindow() {
        if (d.pageAnalyzerWindow && !d.pageAnalyzerWindow.isDestroyed()) {
            d.pageAnalyzerWindow.focus();
            _sendAnalyzerTabs();
            return;
        }
        d.pageAnalyzerWindow = _spawnTrustedToolWindow({
            width: 1020, height: 700, minWidth: 700, minHeight: 450,
            title: 'Page Analyzer', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        d.pageAnalyzerWindow.loadFile(d.getAssetPath('page-analyzer.html'));
        d.pageAnalyzerWindow.webContents.on('did-finish-load', () => _sendAnalyzerTabs());
        d.pageAnalyzerWindow.on('closed', () => { d.pageAnalyzerWindow = null; });
    }

    function createNotesWindow() {
        let pageUrl = '';
        let domain = '';
        try {
            const active = d.tabManager?.getActiveTab?.();
            const u = active?.url && /^https?:\/\//i.test(String(active.url)) ? String(active.url) : '';
            pageUrl = u;
            domain = u ? getNoteDomainFromUrl(u) : '';
        } catch { /* ignore */ }
        if (d.notesWindow && !d.notesWindow.isDestroyed()) {
            d.notesWindow.focus();
            /* Do not send notes-init here — it runs newNote()+loadList() and wipes the open note.
               First load still gets notes-init in did-finish-load; refocus only updates tab URL context. */
            d.notesWindow.webContents.send('notes-context-update', { pageUrl, domain });
            return;
        }
        d.notesWindow = _spawnTrustedToolWindow({
            width: 920, height: 640, minWidth: 560, minHeight: 400,
            title: 'Notes', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        d.notesWindow.loadFile(d.getAssetPath('notes.html'));
        d.notesWindow.webContents.once('did-finish-load', () => {
            d.notesWindow.webContents.send('notes-init', { pageUrl, domain });
        });
        d.notesWindow.on('closed', () => { d.notesWindow = null; });
    }

    /** Пуш контекста активной вкладки в открытое окно заметок (смена URL / вкладки). */
    function broadcastNotesWindowContext() {
        if (!d.notesWindow || d.notesWindow.isDestroyed()) return;
        let pageUrl = '';
        let domain = '';
        try {
            const active = d.tabManager?.getActiveTab?.();
            const u = active?.url && /^https?:\/\//i.test(String(active.url)) ? String(active.url) : '';
            pageUrl = u;
            domain = u ? getNoteDomainFromUrl(u) : '';
        } catch { /* ignore */ }
        try {
            d.notesWindow.webContents.send('notes-context-update', { pageUrl, domain });
        } catch { /* ignore */ }
    }

    function _sendAnalyzerTabs() {
        if (!d.pageAnalyzerWindow || d.pageAnalyzerWindow.isDestroyed() || !d.tabManager) return;
        d.pageAnalyzerWindow.webContents.send('analyzer-tabs-list', d.tabManager.getTabList());
    }


    /** Обновить mock protocol.handle на каждой уникальной session (без дублирования webRequest). */
    function reattachInterceptorToAllTabs() {
        if (!d.interceptor || !d.tabManager) return;
        const seen = new WeakSet();
        for (const tab of d.tabManager.getAllTabs()) {
            const ts = tab.tabSession;
            if (!ts || seen.has(ts)) continue;
            seen.add(ts);
            try { d.interceptor.syncMockProtocolHandlers(ts); } catch (err) {
                d.safeCatch({ module: 'main', eventCode: 'interceptor.mock_sync.failed', context: { tabId: tab.id } }, err);
            }
        }
    }

    /** Broadcast updated tab list to cookie manager & page analyzer — debounced */
    function notifyCookieManagerTabs() {
        const hold = d.notifyTabsDebounce;
        if (hold.id) clearTimeout(hold.id);
        hold.id = setTimeout(() => {
            hold.id = null;
            const list = d.tabManager.getTabList();
            if (d.cookieManagerWindow && !d.cookieManagerWindow.isDestroyed()) {
                d.cookieManagerWindow.webContents.send('tabs-updated', list);
            }
            if (d.pageAnalyzerWindow && !d.pageAnalyzerWindow.isDestroyed()) {
                d.pageAnalyzerWindow.webContents.send('analyzer-tabs-updated', list);
            }
        }, 150);
    }

    /** Toolbar + Cookie Manager: refresh cookie group dropdowns after CRUD */
    function notifyCookieGroupsListsUpdated() {
        const send = (wc) => {
            try {
                if (wc && !wc.isDestroyed()) wc.send('cookie-groups-updated');
            } catch (_) { /* ignore */ }
        };
        if (d.mainWindow && !d.mainWindow.isDestroyed()) send(d.mainWindow.webContents);
        if (d.cookieManagerWindow && !d.cookieManagerWindow.isDestroyed()) send(d.cookieManagerWindow.webContents);
        try {
            for (const tab of d.tabManager.getAllTabs()) {
                send(tab?.view?.webContents);
            }
        } catch (_) { /* ignore */ }
    }

    function isValidPlainDnsHost(value) {
        const parts = value.split('.');
        if (!parts.length || parts.some(p => !p || p.length > 63)) return false;
        return parts.every(p => /^[a-z0-9-]+$/i.test(p) && !p.startsWith('-') && !p.endsWith('-'));
    }

    function isValidDnsHost(host) {
        const value = String(host || '').trim().toLowerCase();
        if (!value || value.length > 253) return false;
        if (value.startsWith('*.')) {
            const rest = value.slice(2);
            return !!rest && isValidPlainDnsHost(rest) && rest.includes('.');
        }
        return isValidPlainDnsHost(value);
    }

    function isValidIpv4(ip) {
        const value = String(ip || '').trim();
        const m = value.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
        if (!m) return false;
        return value.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
    }

    function syncDnsOverridesToMitm() {
        const mp = d.mitmProxy;
        if (!d.db || !mp || typeof mp.setDnsOverrides !== 'function') return;
        try {
            const rules = d.db.getDnsOverrides().filter(r => !!r.enabled);
            mp.setDnsOverrides(rules);
            if (d.dnsManagerWindow && !d.dnsManagerWindow.isDestroyed()) {
                d.dnsManagerWindow.webContents.send('dns-overrides-updated', d.db.getDnsOverrides());
            }
        } catch (e) {
            d.sysLog('warn', 'dns', 'syncDnsOverridesToMitm failed: ' + (e?.message || e));
        }
    }

    function createCookieManagerWindow(initialTabId) {
        if (d.cookieManagerWindow && !d.cookieManagerWindow.isDestroyed()) {
            d.cookieManagerWindow.focus();
            if (initialTabId) d.cookieManagerWindow.webContents.send('set-active-tab', initialTabId);
            return;
        }
        d.cookieManagerWindow = _spawnTrustedToolWindow({
            width: 980, height: 680, minWidth: 700, minHeight: 480,
            title: 'Cookie Manager', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false }
        });
        d.cookieManagerWindow.loadFile(d.getAssetPath('cookie-manager.html'));
        d.cookieManagerWindow.webContents.on('did-finish-load', () => {
            if (initialTabId) d.cookieManagerWindow.webContents.send('set-active-tab', initialTabId);
            d.cookieManagerWindow.webContents.send('tabs-list', d.tabManager.getTabList());
        });
        d.cookieManagerWindow.on('closed', () => { d.cookieManagerWindow = null; });
    }

    function createDnsManagerWindow() {
        if (d.dnsManagerWindow && !d.dnsManagerWindow.isDestroyed()) {
            d.dnsManagerWindow.focus();
            return;
        }
        d.dnsManagerWindow = _spawnTrustedToolWindow({
            width: 980, height: 660, minWidth: 760, minHeight: 480,
            title: 'DNS Manager', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false }
        });
        d.dnsManagerWindow.loadFile(d.getAssetPath('dns-manager.html'));
        d.dnsManagerWindow.webContents.on('did-finish-load', () => {
            if (d.db) d.dnsManagerWindow.webContents.send('dns-overrides-updated', d.db.getDnsOverrides());
            const dnsReplay = d.ipcBatch.getRecentDnsEventsSlice(100);
            if (dnsReplay.length > 0) {
                d.dnsManagerWindow.webContents.send('dns-rule-matched-batch', dnsReplay);
            }
        });
        d.dnsManagerWindow.on('closed', () => { d.dnsManagerWindow = null; });
    }

    function createSessionProfileModalWindow() {
        if (d.sessionProfileModalWindow && !d.sessionProfileModalWindow.isDestroyed()) {
            d.sessionProfileModalWindow.show();
            d.sessionProfileModalWindow.focus();
            return;
        }

        const W = 860;
        const H = 640;
        const winOpts = {
            width: W,
            height: H,
            minWidth: 720,
            minHeight: 520,
            resizable: true,
            minimizable: false,
            maximizable: true,
            title: 'Launch Profile',
            icon: d.iconPath,
            show: false,
            webPreferences: {
                preload: d.path.join(d.cupnetRoot, 'preload-session-profile-modal.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
            },
        };
        if (d.mainWindow && !d.mainWindow.isDestroyed()) {
            winOpts.parent = d.mainWindow;
        }

        d.sessionProfileModalWindow = _spawnTrustedToolWindow(winOpts);
        d.sessionProfileModalWindow.loadFile(d.getAssetPath('session-profile-modal.html'));
        d.sessionProfileModalWindow.once('ready-to-show', () => {
            if (d.sessionProfileModalWindow && !d.sessionProfileModalWindow.isDestroyed()) {
                d.sessionProfileModalWindow.show();
            }
        });
        d.sessionProfileModalWindow.on('closed', () => { d.sessionProfileModalWindow = null; });
    }

    function createLoggingModalWindow(data, buttonHint) {
        // If already open, just focus and re-send data
        if (d.loggingModalWindow && !d.loggingModalWindow.isDestroyed()) {
            d.loggingModalWindow.webContents.send('modal-logging-init', data);
            d.loggingModalWindow.focus();
            return;
        }

        // Position near the button that triggered this modal.
        // buttonHint: { x, y, w, h } — button rect in browser.html viewport coords.
        // We convert to screen coords using d.mainWindow's screen position.
        const W = 330, H = 290;
        let x, y;
        if (d.mainWindow && !d.mainWindow.isDestroyed()) {
            const [wx, wy] = d.mainWindow.getPosition();
            if (buttonHint) {
                // Align modal right-edge with button right-edge, appear below button (+50px gap), shifted 200px right
                x = Math.round(wx + buttonHint.x + buttonHint.w - W + 200);
                y = Math.round(wy + buttonHint.y + buttonHint.h + 56);
            } else {
                // Fallback: center over window
                const [ww, wh] = d.mainWindow.getSize();
                x = Math.round(wx + (ww - W) / 2);
                y = Math.round(wy + (wh - H) / 2);
            }
        }

        d.loggingModalWindow = _spawnTrustedToolWindow({
            width: W, height: H,
            x, y,
            resizable: false,
            minimizable: false,
            maximizable: false,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            parent: d.mainWindow || undefined,
            show: false,
            webPreferences: {
                preload: d.path.join(d.cupnetRoot, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });

        d.loggingModalWindow.loadFile(d.getAssetPath('modal-logging.html'));

        d.loggingModalWindow.webContents.once('did-finish-load', () => {
            d.loggingModalWindow.webContents.send('modal-logging-init', data);
            d.loggingModalWindow.show();
        });

        d.loggingModalWindow.on('closed', () => { d.loggingModalWindow = null; });
    }

    /**
     * Site information popover — separate frameless window so it is not clipped by WebContentsView stacking.
     * @param {object} data — payload from buildTabTlsInfo (main)
     * @param {{ x: number, y: number, w: number, h: number }|null} buttonHint — site-info button rect in browser shell coords
     */
    function createSiteInfoPopoverWindow(data, buttonHint) {
        const W = 340;
        const H = 360;
        let x;
        let y;
        if (d.mainWindow && !d.mainWindow.isDestroyed()) {
            const [wx, wy] = d.mainWindow.getPosition();
            if (buttonHint && Number.isFinite(buttonHint.x)) {
                x = Math.round(wx + buttonHint.x);
                y = Math.round(wy + buttonHint.y + (buttonHint.h || 0) + 8);
            } else {
                const [ww, wh] = d.mainWindow.getSize();
                x = Math.round(wx + (ww - W) / 2);
                y = Math.round(wy + 96);
            }
        }

        const sendInit = (win) => {
            if (!win || win.isDestroyed()) return;
            try {
                win.webContents.send('site-info-init', data);
            } catch (_) { /* ignore */ }
        };

        if (d.siteInfoPopoverWindow && !d.siteInfoPopoverWindow.isDestroyed()) {
            try {
                d.siteInfoPopoverWindow.__cupnetTabId = data.tabId;
            } catch (_) { /* ignore */ }
            try {
                if (Number.isFinite(x) && Number.isFinite(y)) d.siteInfoPopoverWindow.setPosition(x, y);
            } catch (_) { /* ignore */ }
            sendInit(d.siteInfoPopoverWindow);
            d.siteInfoPopoverWindow.show();
            d.siteInfoPopoverWindow.focus();
            return;
        }

        d.siteInfoPopoverWindow = _spawnTrustedToolWindow({
            width: W,
            height: H,
            x,
            y,
            resizable: false,
            minimizable: false,
            maximizable: false,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            parent: d.mainWindow || undefined,
            show: false,
            webPreferences: {
                preload: d.path.join(d.cupnetRoot, 'preload-site-info-popover.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });

        try {
            d.siteInfoPopoverWindow.setBackgroundColor('#00000000');
        } catch (_) { /* ignore */ }

        d.siteInfoPopoverWindow.loadFile(d.getAssetPath('site-info-popover.html'));

        d.siteInfoPopoverWindow.webContents.once('did-finish-load', () => {
            try {
                d.siteInfoPopoverWindow.__cupnetTabId = data.tabId;
            } catch (_) { /* ignore */ }
            sendInit(d.siteInfoPopoverWindow);
            d.siteInfoPopoverWindow.show();
        });

        d.siteInfoPopoverWindow.on('blur', () => {
            try {
                if (d.siteInfoPopoverWindow && !d.siteInfoPopoverWindow.isDestroyed()) d.siteInfoPopoverWindow.close();
            } catch (_) { /* ignore */ }
        });

        d.siteInfoPopoverWindow.on('closed', () => { d.siteInfoPopoverWindow = null; });
    }

    function createProxyManagerWindow() {
        if (d.proxyManagerWindow && !d.proxyManagerWindow.isDestroyed()) {
            d.proxyManagerWindow.focus(); return;
        }
        d.proxyManagerWindow = _spawnTrustedToolWindow({
            width: 920, height: 620, minWidth: 680, minHeight: 440,
            title: 'Proxy Manager', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false }
        });
        if (process.env.CUPNET_DEVTOOLS === '1' || String(process.env.CUPNET_DEVTOOLS || '').toLowerCase() === 'true') {
            d.proxyManagerWindow.webContents.once('did-finish-load', () => {
                try { d.proxyManagerWindow.webContents.openDevTools({ mode: 'detach' }); } catch (_) { /* ignore */ }
            });
        }
        d.proxyManagerWindow.loadFile(d.getAssetPath('proxy-manager.html'));
        d.proxyManagerWindow.webContents.on('did-finish-load', () => {
            d.notifyProxyProfilesList();
            d.notifyProxyStatus();
        });
        d.proxyManagerWindow.on('closed', () => { d.proxyManagerWindow = null; });
    }

    /** Browser Identity window (UA / client hints / TLS / timezone / language). */
    function createIdentityManagerWindow() {
        if (d.identityManagerWindow && !d.identityManagerWindow.isDestroyed()) {
            d.identityManagerWindow.focus(); return;
        }
        d.identityManagerWindow = _spawnTrustedToolWindow({
            width: 760, height: 640, minWidth: 620, minHeight: 480,
            title: 'Browser Identity', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false }
        });
        if (process.env.CUPNET_DEVTOOLS === '1' || String(process.env.CUPNET_DEVTOOLS || '').toLowerCase() === 'true') {
            d.identityManagerWindow.webContents.once('did-finish-load', () => {
                try { d.identityManagerWindow.webContents.openDevTools({ mode: 'detach' }); } catch (_) { /* ignore */ }
            });
        }
        d.identityManagerWindow.loadFile(d.getAssetPath('identity-manager.html'));
        d.identityManagerWindow.on('closed', () => { d.identityManagerWindow = null; });
    }

    function createOnboardingWindow() {
        if (d.onboardingWindow && !d.onboardingWindow.isDestroyed()) {
            d.onboardingWindow.focus();
            return;
        }
        const parent = d.mainWindow && !d.mainWindow.isDestroyed() ? d.mainWindow : null;
        d.onboardingWindow = _spawnTrustedToolWindow({
            width: 540,
            height: 480,
            minWidth: 400,
            minHeight: 360,
            modal: !!parent,
            parent: parent || undefined,
            title: 'Welcome to CupNet',
            icon: d.iconPath,
            show: true,
            webPreferences: {
                preload: d.path.join(d.cupnetRoot, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        d.onboardingWindow.loadFile(d.getAssetPath('onboarding.html'));
        d.onboardingWindow.on('closed', () => { d.onboardingWindow = null; });
    }

    function createRulesWindow() {
        if (d.rulesWindow) { d.rulesWindow.focus(); return; }
        d.rulesWindow = _spawnTrustedToolWindow({
            width: 900, height: 700, minWidth: 640, minHeight: 480,
            title: 'Rules & Interceptor', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false }
        });
        d.rulesWindow.loadFile(d.getAssetPath('rules.html'));
        d.rulesWindow.webContents.once('did-finish-load', () => {
            const interceptReplay = d.ipcBatch.getRecentInterceptEventsSlice(80);
            if (interceptReplay.length > 0) {
                d.rulesWindow.webContents.send('intercept-rule-matched-batch', interceptReplay);
            }
        });
        d.rulesWindow.on('closed', () => { d.rulesWindow = null; });
    }

    /**
     * Breakpoint UI for MITM intercept (see request-interceptor setBreakpointHandler).
     * @param {{ id: string, snapshot: object, ruleName?: string, matchUrl?: string, wireUrl?: string }} payload
     */
    function openBreakpointWindow(payload) {
        if (!payload || !payload.id) return;
        const send = () => {
            try {
                if (d.breakpointWindow && !d.breakpointWindow.isDestroyed()) {
                    d.breakpointWindow.webContents.send('breakpoint-set', payload);
                    d.breakpointWindow.show();
                    d.breakpointWindow.focus();
                }
            } catch (_) { /* ignore */ }
        };
        if (d.breakpointWindow && !d.breakpointWindow.isDestroyed()) {
            if (d.breakpointWindow.webContents.isLoading()) {
                d.breakpointWindow.webContents.once('did-finish-load', send);
            } else {
                send();
            }
            return;
        }
        d.breakpointWindow = _spawnTrustedToolWindow({
            width: 680, height: 560, minWidth: 480, minHeight: 420,
            title: 'Breakpoint', icon: d.iconPath,
            webPreferences: {
                preload: d.path.join(d.cupnetRoot, 'breakpoint-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        d.breakpointWindow.loadFile(d.getAssetPath('breakpoint.html'));
        d.breakpointWindow.webContents.once('did-finish-load', send);
        d.breakpointWindow.on('closed', () => { d.breakpointWindow = null; });
    }

    return {
        openRequestEditorWindow,
        openRequestEditorNewWindow,
        createRequestEditorWindow,
        createLogViewerWindow,
        _serializeCompareRowRequest,
        _comparePayload,
        _requestsForSessionAsc,
        _parseHeadersMaybe,
        _stripNoiseHeaders,
        _reqWithCompareOptions,
        _safeUrl,
        _queryKeys,
        _pathTokens,
        _tokenSimilarity,
        _statusClass,
        _pairScore,
        _confidence,
        _broadcastCompareUpdated,
        createCompareViewerWindow,
        getLiveLogViewerWindow,
        createConsoleViewerWindow,
        createPageAnalyzerWindow,
        createNotesWindow,
        broadcastNotesWindowContext,
        _sendAnalyzerTabs,
        notifyCookieManagerTabs,
        notifyCookieGroupsListsUpdated,
        isValidDnsHost,
        isValidIpv4,
        syncDnsOverridesToMitm,
        createCookieManagerWindow,
        createDnsManagerWindow,
        createLoggingModalWindow,
        createSessionProfileModalWindow,
        createSiteInfoPopoverWindow,
        createProxyManagerWindow,
        createIdentityManagerWindow,
        createRulesWindow,
        openBreakpointWindow,
        createOnboardingWindow,
        reattachInterceptorToAllTabs,
    };
}

module.exports = { createSubWindowsApi };
