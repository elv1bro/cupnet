'use strict';

const api = window.electronAPI;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const backBtn        = document.getElementById('back-btn');
const forwardBtn     = document.getElementById('forward-btn');
const reloadBtn      = document.getElementById('reload-btn');
const homeBtn        = document.getElementById('home-btn');
const urlInput       = document.getElementById('url-input');
const logSessionNum  = document.getElementById('log-session-num');
const logEntryBadge  = document.getElementById('log-entry-badge');
const logToggleBtn   = document.getElementById('log-toggle-btn');   // recording toggle
const logPill        = document.getElementById('log-pill');          // .tool-log-pill wrapper
const toolbar        = document.getElementById('browser-toolbar');
const tabList        = document.getElementById('tab-list');
const newTabBtn      = document.getElementById('new-tab-btn');
const logViewerBtn   = document.getElementById('log-viewer-btn');
const screenshotBtn  = document.getElementById('screenshot-btn');
const devtoolsBtn    = document.getElementById('devtools-btn');
const cookiesBtn     = document.getElementById('cookies-btn');
const dnsBtn         = document.getElementById('dns-btn');
const reqEditorBtn   = document.getElementById('req-editor-btn');
const rulesBtn       = document.getElementById('rules-btn');
const consoleBtn     = document.getElementById('console-btn');
const analyzerBtn    = document.getElementById('analyzer-btn');

// ─── Proxy pill refs ──────────────────────────────────────────────────────────
const pbStatusBtn    = document.getElementById('pb-status-btn');
const pbDot          = document.getElementById('pb-dot');
const pbName         = document.getElementById('pb-name');
const settingsToggle = document.getElementById('settings-toggle-btn');

const toastContainer  = document.getElementById('rule-toast-container');

// ─── Navigation ───────────────────────────────────────────────────────────────
backBtn.addEventListener('click',    () => api.navBack());
forwardBtn.addEventListener('click', () => api.navForward());
reloadBtn.addEventListener('click',  () => api.navReload());
if (homeBtn) homeBtn.addEventListener('click', () => api.navHome());

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const raw = urlInput.value.trim();
        if (!raw) return;
        api.navigateTo(raw);
    }
});

function _normalizeToolbarUrl(url) {
    return url === 'about:blank' ? '' : (url || '');
}

function _setToolbarUrlIfChanged(url, { respectFocus = true, blur = false } = {}) {
    if (respectFocus && document.activeElement === urlInput) return false;
    if (urlInput.value !== url) urlInput.value = url;
    if (blur) urlInput.blur();
    return true;
}

api.onURLUpdate((url) => {
    const normalized = _normalizeToolbarUrl(url);
    _setToolbarUrlIfChanged(normalized, { respectFocus: true });
    ssHandleUrlChange(normalized);
});

// Navigation started by a link click or JS (will-navigate).
// Force-update the address bar even if urlInput currently has focus
// (BrowserView clicks don't transfer focus to the chrome renderer).
api.onTabWillNavigate?.((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && active.id === data.tabId) {
        const normalized = _normalizeToolbarUrl(data.url);
        // Force-update + blur: page navigation started, typed draft is no longer relevant.
        _setToolbarUrlIfChanged(normalized, { respectFocus: false, blur: true });
        ssHandleUrlChange(normalized);
        _interceptHitCount = 0;
        updateRulesHitBadge();
        _dnsHitCount = 0;
        updateDnsHitBadge();
    }
});

let _loadingApplied = false;
let _loadingPending = false;
let _loadingRaf = null;
let _loadingOffTimer = null;
function _applyToolbarLoading(next) {
    const val = !!next;
    if (_loadingApplied === val) return;
    _loadingApplied = val;
    toolbar.classList.toggle('loading', val);
}
function _scheduleToolbarLoading(next) {
    _loadingPending = !!next;
    if (_loadingRaf) return;
    _loadingRaf = requestAnimationFrame(() => {
        _loadingRaf = null;
        _applyToolbarLoading(_loadingPending);
    });
}
api.onSetLoadingState((loading) => {
    if (loading) {
        if (_loadingOffTimer) { clearTimeout(_loadingOffTimer); _loadingOffTimer = null; }
        _scheduleToolbarLoading(true);
        return;
    }
    if (_loadingOffTimer) clearTimeout(_loadingOffTimer);
    // Keep spinner for a short grace period to avoid class flapping
    // on quick redirect/start-stop bursts.
    _loadingOffTimer = setTimeout(() => {
        _loadingOffTimer = null;
        _scheduleToolbarLoading(false);
    }, 90);
});

// ─── Logging toggle state ─────────────────────────────────────────────────────
let isLogging = false;

function setLoggingVisual(on) {
    isLogging = on;
    // Unified log pill: add/remove 'recording' class for dot animation + color scheme
    if (logPill) logPill.classList.toggle('recording', on);
    if (logToggleBtn) {
        logToggleBtn.title = on ? 'Recording ON — click to stop' : 'Start recording (logging is OFF)';
    }
    // Screenshot button is only usable while logging is active
    if (screenshotBtn) {
        screenshotBtn.classList.toggle('tool-btn-disabled', !on);
        screenshotBtn.title = on
            ? 'Take screenshot · auto-captures active tab'
            : 'Logging is OFF — enable recording to use screenshots';
    }
    // Also hide/show the countdown badge when logging off
    if (!on && ssCountdownEl) ssCountdownEl.style.display = 'none';
}

api.onUpdateLogStatus((data) => {
    const on = !!(data && data.enabled);
    setLoggingVisual(on);
    if (!on) {
        if (logSessionNum)  logSessionNum.textContent = '#—';
        if (logEntryBadge) { logEntryBadge.style.display = 'none'; logEntryBadge.textContent = '0'; }
        return;
    }
    if (logSessionNum)  logSessionNum.textContent = `#${data.sessionId}`;
    if (logEntryBadge) {
        logEntryBadge.textContent = data.count >= 1000 ? `${Math.floor(data.count/1000)}k` : data.count;
        logEntryBadge.style.display = data.count > 0 ? '' : 'none';
    }
});

logToggleBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isLogging) {
        await api.toggleLoggingStop().catch(console.error);
    } else {
        try {
            const r = logToggleBtn.getBoundingClientRect();
            await api.toggleLoggingStart({ x: r.left, y: r.top, w: r.width, h: r.height });
        } catch (err) {
            console.error('[LogToggle] toggleLoggingStart error:', err);
        }
    }
});

// ─── Tab bar ──────────────────────────────────────────────────────────────────
let tabs = [];

function _isHomePage(url) {
    return !url || url === 'about:blank' || url.includes('new-tab.html');
}

function _tabFallbackIcon(tab) {
    if (_isHomePage(tab.url)) return '⌂';
    if (tab.isolated) return '🍪';
    return '🌐';
}

function _formatTabTitle(tab) {
    const num = tab.num ? `#${tab.num}` : '';
    const name = tab.title || 'New Tab';
    return `${num} ${name}`;
}

function makeTabEl(tab) {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.isActive ? ' active' : '') + (tab.isolated ? ' isolated' : '') + (tab.direct ? ' direct' : '');
    el.dataset.id = tab.id;
    el.title = (tab.url || '') + (tab.direct ? ' [Direct — no proxy]' : tab.isolated ? ' [Isolated cookies]' : '');

    const fallbackIcon = _tabFallbackIcon(tab);

    const faviconWrapper = document.createElement('span');
    faviconWrapper.className = 'tab-favicon-wrapper';
    if (tab.faviconUrl) {
        const img = document.createElement('img');
        img.className = 'tab-favicon-img';
        img.src = tab.faviconUrl;
        const fallback = document.createElement('span');
        fallback.className = 'tab-favicon';
        fallback.textContent = fallbackIcon;
        fallback.style.display = 'none';
        img.onerror = () => { img.style.display = 'none'; fallback.style.display = ''; };
        faviconWrapper.appendChild(img);
        faviconWrapper.appendChild(fallback);
    } else {
        const favicon = document.createElement('span');
        favicon.className = 'tab-favicon';
        favicon.textContent = fallbackIcon;
        faviconWrapper.appendChild(favicon);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = _formatTabTitle(tab);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close tab';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        api.closeTab(tab.id);
    });

    el.appendChild(faviconWrapper);
    el.appendChild(title);
    el.appendChild(closeBtn);
    el.addEventListener('click', () => {
        if (!el.classList.contains('active')) api.switchTab(tab.id);
    });
    return el;
}

function renderTabs(tabData) {
    tabs = tabData || [];

    // Build lookup of existing tab elements by id
    const existing = new Map();
    for (const el of tabList.querySelectorAll('.tab-item')) {
        existing.set(el.dataset.id, el);
    }

    const newIds = new Set(tabs.map(t => String(t.id)));

    // Remove tabs that no longer exist
    for (const [id, el] of existing) {
        if (!newIds.has(id)) el.remove();
    }

    // Insert/update/reorder tabs
    let insertBefore = newTabBtn || null;
    for (let i = tabs.length - 1; i >= 0; i--) {
        const tab = tabs[i];
        const idStr = String(tab.id);
        let el = existing.get(idStr);

        if (!el) {
            // New tab — create element
            el = makeTabEl(tab);
            tabList.insertBefore(el, insertBefore);
        } else {
            // Existing tab — patch in-place (avoid full rebuild)
            const wantClass = 'tab-item' + (tab.isActive ? ' active' : '') + (tab.isolated ? ' isolated' : '') + (tab.direct ? ' direct' : '');
            if (el.className !== wantClass) el.className = wantClass;

            const wantTitle = (tab.url || '') + (tab.direct ? ' [Direct — no proxy]' : tab.isolated ? ' [Isolated cookies]' : '');
            if (el.title !== wantTitle) el.title = wantTitle;

            const titleEl = el.querySelector('.tab-title');
            if (titleEl) {
                const want = _formatTabTitle(tab);
                if (titleEl.textContent !== want) titleEl.textContent = want;
            }

            const fallbackEl = el.querySelector('.tab-favicon');
            if (fallbackEl) {
                const wantIcon = _tabFallbackIcon(tab);
                if (fallbackEl.textContent !== wantIcon) fallbackEl.textContent = wantIcon;
            }

            const img = el.querySelector('.tab-favicon-img');
            if (img && tab.faviconUrl && img.src !== tab.faviconUrl) img.src = tab.faviconUrl;

            // Ensure correct order
            if (el !== tabList.children[i]) tabList.insertBefore(el, insertBefore);
        }
        insertBefore = el;
    }

    // Keep new-tab button at the end
    if (newTabBtn) tabList.appendChild(newTabBtn);
}

newTabBtn.addEventListener('click', () => {
    api.newTab(null);
});

const newIsolatedTabBtn = document.getElementById('new-isolated-tab-btn');
if (newIsolatedTabBtn) {
    newIsolatedTabBtn.addEventListener('click', () => {
        api.newIsolatedTab();
    });
}

const newDirectTabBtn = document.getElementById('new-direct-tab-btn');
if (newDirectTabBtn) {
    newDirectTabBtn.addEventListener('click', () => {
        api.newDirectTab();
    });
}

let _tabUiPending = null;
let _tabUiRaf = null;
function _scheduleTabUiUpdate(tabData) {
    _tabUiPending = tabData || [];
    if (_tabUiRaf) return;
    _tabUiRaf = requestAnimationFrame(() => {
        _tabUiRaf = null;
        const payload = _tabUiPending || [];
        _tabUiPending = null;
        renderTabs(payload);
        _onActiveTabChanged(payload);
        const active = payload.find(t => t.isActive);
        if (active && document.activeElement !== urlInput) {
            const normalized = _normalizeToolbarUrl(active.url);
            _setToolbarUrlIfChanged(normalized, { respectFocus: true });
            ssHandleUrlChange(normalized);
        }
    });
}

api.onTabListUpdated((tabData) => {
    _scheduleTabUiUpdate(tabData);
});

api.onTabUrlChanged((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && active.id === data.tabId && document.activeElement !== urlInput) {
        const normalized = _normalizeToolbarUrl(data.url);
        _setToolbarUrlIfChanged(normalized, { respectFocus: true });
        ssHandleUrlChange(normalized);
    }
    // Reset intercept badge on navigation
    if (typeof _interceptHitCount !== 'undefined') {
        _interceptHitCount = 0;
        updateRulesHitBadge();
    }
    _dnsHitCount = 0;
    updateDnsHitBadge();
});

// ─── Right toolbar actions ────────────────────────────────────────────────────
if (logViewerBtn) {
    logViewerBtn.addEventListener('click', () => api.openLogViewer());
}

// ─── Screenshot countdown ─────────────────────────────────────────────────────

const ssCountdownEl = document.getElementById('screenshot-countdown');
const ssFlashEl     = document.getElementById('screenshot-flash');

let ssIntervalSec  = 0;   // configured interval (seconds)
let ssOnHomePage   = true; // pause countdown while on new-tab / home page

function ssFlash() {
    if (!ssFlashEl) return;
    // Cancel any running animation, remove class, then re-add on next frame
    // — avoids the forced synchronous reflow caused by offsetWidth read
    ssFlashEl.getAnimations().forEach(a => a.cancel());
    ssFlashEl.classList.remove('flash');
    requestAnimationFrame(() => ssFlashEl.classList.add('flash'));
}

function ssIsHomePage(url) {
    // Empty URL bar = new-tab.html, or explicit file:// path
    return !url || url === '' || url.includes('new-tab.html') || url.startsWith('file://');
}

function ssUpdateBadge(val) {
    if (!ssCountdownEl) return;
    if (!ssOnHomePage && ssIntervalSec > 0 && val > 0) {
        ssCountdownEl.style.display = '';
        ssCountdownEl.textContent   = val;
        ssCountdownEl.classList.toggle('urgent', val <= 1);
    } else {
        ssCountdownEl.style.display = 'none';
    }
}

function ssResetTimer(intervalSec) {
    ssIntervalSec = intervalSec;
    ssUpdateBadge(0);
}

function ssHandleUrlChange(url) {
    const onHome = ssIsHomePage(url);
    if (onHome === ssOnHomePage) return; // no change
    ssOnHomePage = onHome;
    if (onHome) {
        ssUpdateBadge(0);
    } else {
        ssUpdateBadge(0);
    }
}

// Main process took a scheduled screenshot → play flash + reset countdown
api.onScreenshotTaken(() => {
    ssFlash();
    ssResetTimer(ssIntervalSec);
});

if (screenshotBtn) {
    screenshotBtn.addEventListener('click', async () => {
        // If logging is off — ask user to start it first
        if (!isLogging) {
            try {
                const r = screenshotBtn.getBoundingClientRect();
                await api.toggleLoggingStart({ x: r.left, y: r.top, w: r.width, h: r.height });
            } catch (err) {
                console.error('[ScreenshotBtn] toggleLoggingStart error:', err);
            }
            return;
        }
        screenshotBtn.disabled = true;
        await api.takeScreenshot('click').catch(() => {});
        screenshotBtn.disabled = false;
        ssFlash();
        ssResetTimer(ssIntervalSec);
    });
}

if (devtoolsBtn) {
    devtoolsBtn.addEventListener('click', () => api.openDevTools());
}
if (cookiesBtn) {
    cookiesBtn.addEventListener('click', async () => {
        const tabs = await api.getTabs();
        const active = tabs.find(t => t.isActive);
        api.openCookieManager(active?.id || null);
    });
}
if (dnsBtn) {
    dnsBtn.addEventListener('click', () => {
        api.openDnsManager();
    });
}
if (reqEditorBtn) {
    reqEditorBtn.addEventListener('click', () => {
        api.openRequestEditor(null);
    });
}
if (rulesBtn) {
    rulesBtn.addEventListener('click', () => {
        api.openRulesWindow();
    });
}

if (consoleBtn) {
    consoleBtn.addEventListener('click', () => {
        api.openConsoleViewer();
    });
}

if (analyzerBtn) {
    analyzerBtn.addEventListener('click', () => {
        api.openPageAnalyzer();
    });
}

// ─── Favicon support ──────────────────────────────────────────────────────────
function getFaviconHtml(tab) {
    if (tab.faviconUrl) {
        return `<img class="tab-favicon-img" src="${tab.faviconUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display=''">` +
               `<span class="tab-favicon" style="display:none">🌐</span>`;
    }
    return `<span class="tab-favicon">🌐</span>`;
}

// ─── Proxy pill + environment colors ──────────────────────────────────────────
const pbDetail = document.getElementById('pb-detail');

let _lastProxyInfo     = null;
let _proxyIpGeo        = null;
let _directIpGeo       = null;
let _isDirectTabActive = false;
let _isIsolatedTab     = false;
let _isNewTabPage      = false;

const ENV_CLASSES = ['env-direct', 'env-proxy', 'env-isolated', 'env-newtab'];

function _setEnvClass(el, cls) {
    if (!el) return;
    ENV_CLASSES.forEach(c => el.classList.remove(c));
    if (cls) el.classList.add(cls);
}

function _currentEnvClass() {
    if (_isDirectTabActive) return 'env-direct';
    if (_isIsolatedTab) return 'env-isolated';
    if (_isNewTabPage) return 'env-newtab';
    if (_lastProxyInfo?.active) return 'env-proxy';
    return 'env-direct';
}

function _renderPill() {
    const envCls = _currentEnvClass();
    _setEnvClass(pbStatusBtn, envCls);
    _setEnvClass(urlInput, envCls);

    // Reset dot classes
    pbDot.classList.remove('active', 'direct', 'isolated');

    if (_isDirectTabActive) {
        pbDot.classList.add('direct');
        pbName.textContent = 'Direct';
        if (_directIpGeo && _directIpGeo.ip) {
            const loc = [_directIpGeo.city, _directIpGeo.country].filter(Boolean).join(', ');
            pbDetail.textContent = _directIpGeo.ip + (loc ? ' · ' + loc : '');
        } else {
            pbDetail.textContent = 'checking…';
        }
        pbStatusBtn.title = 'Direct tab — no proxy, real IP';
        return;
    }

    const info = _lastProxyInfo;
    if (!info) return;
    const active = !!info.active;
    const label  = info.proxyName || 'Proxy';

    if (_isIsolatedTab) {
        pbDot.classList.add('isolated');
    } else if (active) {
        pbDot.classList.add('active');
    }

    pbName.textContent = active ? label : 'Direct';

    if (active && _proxyIpGeo && _proxyIpGeo.ip) {
        const loc = [_proxyIpGeo.city, _proxyIpGeo.country].filter(Boolean).join(', ');
        pbDetail.textContent = _proxyIpGeo.ip + (loc ? ' · ' + loc : '');
    } else if (!active && _directIpGeo && _directIpGeo.ip) {
        const loc = [_directIpGeo.city, _directIpGeo.country].filter(Boolean).join(', ');
        pbDetail.textContent = _directIpGeo.ip + (loc ? ' · ' + loc : '');
    } else if (!active) {
        pbDetail.textContent = 'checking…';
        _fetchDirectIpGeo();
    } else {
        pbDetail.textContent = '';
    }

    pbStatusBtn.title = active
        ? `${label} — click to manage`
        : 'No proxy — click to set up';
}

function updateProxyStatus(info) {
    if (!info) return;
    _lastProxyInfo = info;
    _renderPill();
}

function _fetchProxyIpGeo() {
    api.checkIpGeo().then(geo => {
        if (geo && geo.ip && geo.ip !== 'unknown') {
            _proxyIpGeo = geo;
            _renderPill();
        }
    }).catch(() => {});
}

function _fetchDirectIpGeo() {
    if (_directIpGeo) return;
    api.getDirectIp?.().then(geo => {
        if (geo && geo.ip && geo.ip !== 'unknown') {
            _directIpGeo = geo;
            _renderPill();
        }
    }).catch(() => {});
}

function _onActiveTabChanged(tabData) {
    const list = tabData || tabs;
    const active = list.find(t => t.isActive);
    const wasDirect = _isDirectTabActive;
    _isDirectTabActive = !!(active?.direct);
    _isIsolatedTab     = !!(active?.isolated);

    const url = active?.url || '';
    _isNewTabPage = !url || url === 'about:blank' || url.includes('new-tab.html');

    if (wasDirect !== _isDirectTabActive) _renderPill();
    else _renderPill();
    if (_isDirectTabActive || !_lastProxyInfo?.active) _fetchDirectIpGeo();
    _interceptHitCount = 0;
    updateRulesHitBadge();
    _dnsHitCount = 0;
    updateDnsHitBadge();
}

// Click opens Proxy Manager
if (pbStatusBtn) {
    pbStatusBtn.addEventListener('click', () => api.openProxyManager());
}

// Live updates
api.onProxyStatusChanged((info) => {
    updateProxyStatus(info);
    if (info?.active) _fetchProxyIpGeo();
});
api.getCurrentProxy().then((info) => {
    updateProxyStatus(info);
    if (info?.active) _fetchProxyIpGeo();
}).catch(() => {});

// ─── Settings ────────────────────────────────────────────────────────────────
settingsToggle?.addEventListener('click', () => {
    api.openSettingsTab?.();
});

// ─── Rule notification toasts ─────────────────────────────────────────────────
function showRuleToast(data) {
    if (!toastContainer) return;
    const el = document.createElement('div');
    el.className = 'rule-toast';
    // Use textContent to avoid any XSS via ruleName/url
    const icon = document.createElement('span');
    icon.className = 'rule-toast-icon';
    icon.textContent = '🔔';
    const body = document.createElement('div');
    body.className = 'rule-toast-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'rule-toast-name';
    nameEl.textContent = `Rule: ${data.ruleName || ''}`;
    const urlEl = document.createElement('div');
    urlEl.className = 'rule-toast-url';
    urlEl.title = data.url || '';
    urlEl.textContent = data.url || '';
    body.appendChild(nameEl);
    body.appendChild(urlEl);
    el.appendChild(icon);
    el.appendChild(body);
    toastContainer.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 320);
    }, 4000);
}

api.onRuleNotification && api.onRuleNotification(showRuleToast);

// ─── Intercept hit badge on Rules button ──────────────────────────────────────
const rulesHitBadge = document.getElementById('rules-hit-badge');
const dnsHitBadge = document.getElementById('dns-hit-badge');
let _interceptHitCount = 0;
let _dnsHitCount = 0;

function updateRulesHitBadge() {
    if (!rulesHitBadge) return;
    if (_interceptHitCount > 0) {
        rulesHitBadge.textContent = _interceptHitCount > 99 ? '99+' : _interceptHitCount;
        rulesHitBadge.style.display = '';
    } else {
        rulesHitBadge.style.display = 'none';
    }
}

function updateDnsHitBadge() {
    if (!dnsHitBadge) return;
    if (_dnsHitCount > 0) {
        dnsHitBadge.textContent = _dnsHitCount > 99 ? '99+' : _dnsHitCount;
        dnsHitBadge.style.display = '';
    } else {
        dnsHitBadge.style.display = 'none';
    }
}

function _onInterceptRuleMatched(info) {
    _interceptHitCount++;
    updateRulesHitBadge();
}
api.onInterceptRuleMatched?.(_onInterceptRuleMatched);
api.onInterceptRuleMatchedBatch?.((items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    _interceptHitCount += items.length;
    updateRulesHitBadge();
});

function _onDnsRuleMatched(info) {
    const active = tabs.find(t => t.isActive);
    if (info?.tabId && active && info.tabId !== active.id) return;
    _dnsHitCount++;
    updateDnsHitBadge();
}
api.onDnsRuleMatched?.(_onDnsRuleMatched);
api.onDnsRuleMatchedBatch?.((items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    for (const info of items) _onDnsRuleMatched(info);
});


// ─── Hotkey-driven IPC from main process ──────────────────────────────────────
api.onFocusUrlBar?.(() => {
    urlInput.focus();
    urlInput.select();
});

api.onSwitchTabRel?.((delta) => {
    if (!tabs.length) return;
    const activeIdx = tabs.findIndex(t => t.isActive);
    if (activeIdx < 0) return;
    const next = (activeIdx + delta + tabs.length) % tabs.length;
    api.switchTab(tabs[next].id);
});

api.onTakeScreenshotNow?.(() => {
    api.takeScreenshot('click');
    ssFlash();
    ssResetTimer(ssIntervalSec);
});

// Ctrl+1..9 — switch to tab by index
document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9 && tabs.length > 0) {
        const idx = n === 9 ? tabs.length - 1 : Math.min(n - 1, tabs.length - 1);
        api.switchTab(tabs[idx].id);
        e.preventDefault();
    }
});

// Report user activity to main process (throttled; used by tracking triggers)
let _lastMouseReportTs = 0;
document.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - _lastMouseReportTs < 5000) return;
    _lastMouseReportTs = now;
    api.reportMouseActivity?.();
});

// ─── Init: fetch current tabs ─────────────────────────────────────────────────
api.getTabs().then(td => { renderTabs(td); _onActiveTabChanged(td); }).catch(() => {});
