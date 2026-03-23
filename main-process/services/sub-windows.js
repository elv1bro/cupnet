'use strict';

/**
 * Secondary BrowserWindows, compare helpers, IVAC scout, DNS/cookie/modal/proxy/rules windows.
 * @param {object} d — runtime handles (getters/setters + shared arrays/maps). Built in cupnet-runtime.js.
 */
function createSubWindowsApi(d) {
    function createRequestEditorWindow(data) {
        const win = new d.BrowserWindow({
            width: 1250, height: 780, minWidth: 760, minHeight: 540,
            title: 'Request Editor', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        win.loadFile(d.getAssetPath('request-editor.html'));
        win.webContents.once('did-finish-load', () => {
            win.webContents.send('request-editor-init', data);
        });
    }

    function createLogViewerWindow(sessionId = null) {
        // Cascade offset: each new window is shifted so it's visibly separate
        const cascadeOffset = d.logViewerWindows.length * 30;
        const win = new d.BrowserWindow({
            width: 1200, height: 860, minWidth: 800, minHeight: 500,
            title: sessionId ? `Network Activity — Session #${sessionId}` : 'Network Activity',
            icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js') }
        });

        // Position with cascade offset relative to main window (or screen center)
        if (cascadeOffset > 0) {
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
        d.compareViewerWindow = new d.BrowserWindow({
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

    function createTraceViewerWindow() {
        const win = new d.BrowserWindow({
            width: 1100, height: 720, minWidth: 700, minHeight: 400,
            title: 'Trace', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        win.loadFile(d.getAssetPath('trace-viewer.html'));
        d.traceWindows.push(win);
        win.on('closed', () => {
            const idx = d.traceWindows.indexOf(win);
            if (idx !== -1) d.traceWindows.splice(idx, 1);
        });
    }

    function createConsoleViewerWindow() {
        if (d.consoleViewerWindow && !d.consoleViewerWindow.isDestroyed()) {
            d.consoleViewerWindow.focus();
            return;
        }
        d.consoleViewerWindow = new d.BrowserWindow({
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
        d.pageAnalyzerWindow = new d.BrowserWindow({
            width: 1020, height: 700, minWidth: 700, minHeight: 450,
            title: 'Page Analyzer', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        d.pageAnalyzerWindow.loadFile(d.getAssetPath('page-analyzer.html'));
        d.pageAnalyzerWindow.webContents.on('did-finish-load', () => _sendAnalyzerTabs());
        d.pageAnalyzerWindow.on('closed', () => { d.pageAnalyzerWindow = null; });
    }

    function createIvacScoutWindow() {
        if (d.ivacScoutWindow && !d.ivacScoutWindow.isDestroyed()) {
            d.ivacScoutWindow.focus();
            return;
        }
        d.ivacScoutWindow = new d.BrowserWindow({
            width: 980, height: 760, minWidth: 740, minHeight: 540,
            title: 'API Scout', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        });
        d.ivacScoutWindow.loadFile(d.getAssetPath('ivac-scout.html'));
        d.ivacScoutWindow.webContents.once('did-finish-load', () => {
            d.ivacScoutWindow.webContents.send('ivac-scout-state', { running: !!d.ivacScoutProcess });
        });
        d.ivacScoutWindow.on('closed', () => { d.ivacScoutWindow = null; });
    }

    function sendIvacScoutLog(line) {
        if (d.ivacScoutWindow && !d.ivacScoutWindow.isDestroyed()) {
            d.ivacScoutWindow.webContents.send('ivac-scout-log', line);
        }
    }

    function getIvacScoutContext() {
        const active = d.tabManager?.getActiveTab?.();
        const activeUrl = active?.url || '';
        const url = /^https?:\/\//i.test(activeUrl) ? activeUrl : 'https://appointment.ivacbd.com/';

        const tlsProfile = d.loadSettings().tlsProfile || 'chrome';
        const proxyActive = !!d.persistentAnonymizedProxyUrl;
        const proxyLabel = proxyActive ? (d.connectedProfileName || 'Proxy') : 'Direct';
        const proxyUrl = proxyActive ? d.persistentAnonymizedProxyUrl : '';

        return { url, tlsProfile, proxyActive, proxyLabel, proxyUrl };
    }

    function stopIvacScoutProcess() {
        if (!d.ivacScoutProcess || d.ivacScoutProcess.killed) return false;
        try { d.ivacScoutProcess.kill('SIGTERM'); } catch (err) {
            d.safeCatch({ module: 'main', eventCode: 'process.kill.failed', context: { process: 'ivac-scout', signal: 'SIGTERM' } }, err);
        }
        return true;
    }

    function runIvacScoutProcess(opts = {}) {
        return new Promise((resolve, reject) => {
            if (d.ivacScoutProcess) {
                reject(new Error('Scout already running'));
                return;
            }

            const scriptPath = d.path.join(d.cupnetRoot, 'scripts', 'debug-ivac.js');
            if (!d.fs.existsSync(scriptPath)) {
                reject(new Error('Scout script not found: ' + scriptPath));
                return;
            }

            const args = [scriptPath];
            const ctx = getIvacScoutContext();
            const runUrl = opts.url && /^https?:\/\//i.test(String(opts.url)) ? String(opts.url) : ctx.url;
            args.push('--url', runUrl);
            if (ctx.proxyUrl) args.push('--proxy', String(ctx.proxyUrl));
            args.push('--browser', String(ctx.tlsProfile || 'chrome'));

            // In packaged app run Electron binary as node; in dev use system node.
            const isPackaged = process.defaultApp === false && !process.env.ELECTRON_IS_DEV;
            const nodeBin = isPackaged ? process.execPath : (process.platform === 'win32' ? 'node.exe' : 'node');
            const env = isPackaged
                ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
                : { ...process.env };

            d.ivacScoutProcess = d.spawn(nodeBin, args, {
                cwd: _cupnetRoot,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            if (d.ivacScoutWindow && !d.ivacScoutWindow.isDestroyed()) {
                d.ivacScoutWindow.webContents.send('ivac-scout-state', { running: true });
            }

            let settled = false;
            const settle = (ok, payload) => {
                if (settled) return;
                settled = true;
                resolve({ ok, ...payload });
            };

            d.ivacScoutProcess.stdout.setEncoding('utf8');
            d.ivacScoutProcess.stderr.setEncoding('utf8');

            d.ivacScoutProcess.stdout.on('data', (chunk) => {
                for (const line of String(chunk).split(/\r?\n/)) {
                    if (line.trim()) sendIvacScoutLog(line);
                }
            });
            d.ivacScoutProcess.stderr.on('data', (chunk) => {
                for (const line of String(chunk).split(/\r?\n/)) {
                    if (line.trim()) sendIvacScoutLog('[stderr] ' + line);
                }
            });

            d.ivacScoutProcess.on('error', (err) => {
                sendIvacScoutLog('[main] spawn error: ' + err.message);
                d.ivacScoutProcess = null;
                if (d.ivacScoutWindow && !d.ivacScoutWindow.isDestroyed()) {
                    d.ivacScoutWindow.webContents.send('ivac-scout-state', { running: false });
                    d.ivacScoutWindow.webContents.send('ivac-scout-done', { ok: false, exitCode: -1, error: err.message });
                }
                settle(false, { exitCode: -1, error: err.message });
            });

            d.ivacScoutProcess.on('close', (code) => {
                const exitCode = Number.isInteger(code) ? code : -1;
                let summary = null;
                try {
                    const summaryPath = d.path.join(d.cupnetRoot, '_debug', 'summary.json');
                    if (d.fs.existsSync(summaryPath)) {
                        summary = JSON.parse(d.fs.readFileSync(summaryPath, 'utf8'));
                    }
                } catch (e) {
                    sendIvacScoutLog('[main] summary parse error: ' + e.message);
                }
                d.ivacScoutProcess = null;
                if (d.ivacScoutWindow && !d.ivacScoutWindow.isDestroyed()) {
                    d.ivacScoutWindow.webContents.send('ivac-scout-state', { running: false });
                    d.ivacScoutWindow.webContents.send('ivac-scout-done', { ok: exitCode === 0, exitCode, summary });
                }
                settle(exitCode === 0, { exitCode, summary });
            });
        });
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
            if (tab.direct) continue;
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
        d.cookieManagerWindow = new d.BrowserWindow({
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
        d.dnsManagerWindow = new d.BrowserWindow({
            width: 920, height: 660, minWidth: 720, minHeight: 480,
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

        d.loggingModalWindow = new d.BrowserWindow({
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

    function createProxyManagerWindow() {
        if (d.proxyManagerWindow && !d.proxyManagerWindow.isDestroyed()) {
            d.proxyManagerWindow.focus(); return;
        }
        d.proxyManagerWindow = new d.BrowserWindow({
            width: 1060, height: 700, minWidth: 720, minHeight: 480,
            title: 'Proxy Manager', icon: d.iconPath,
            webPreferences: { preload: d.path.join(d.cupnetRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false }
        });
        d.proxyManagerWindow.loadFile(d.getAssetPath('proxy-manager.html'));
        d.proxyManagerWindow.webContents.on('did-finish-load', () => {
            d.notifyProxyProfilesList();
            d.notifyProxyStatus();
        });
        d.proxyManagerWindow.on('closed', () => { d.proxyManagerWindow = null; });
    }

    function createRulesWindow() {
        if (d.rulesWindow) { d.rulesWindow.focus(); return; }
        d.rulesWindow = new d.BrowserWindow({
            width: 900, height: 700, minWidth: 640, minHeight: 480,
            parent: d.mainWindow, title: 'Rules & Interceptor', icon: d.iconPath,
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

    return {
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
        createTraceViewerWindow,
        createConsoleViewerWindow,
        createPageAnalyzerWindow,
        createIvacScoutWindow,
        sendIvacScoutLog,
        getIvacScoutContext,
        stopIvacScoutProcess,
        runIvacScoutProcess,
        _sendAnalyzerTabs,
        notifyCookieManagerTabs,
        isValidDnsHost,
        isValidIpv4,
        syncDnsOverridesToMitm,
        createCookieManagerWindow,
        createDnsManagerWindow,
        createLoggingModalWindow,
        createProxyManagerWindow,
        createRulesWindow,
        reattachInterceptorToAllTabs,
    };
}

module.exports = { createSubWindowsApi };
