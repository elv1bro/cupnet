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
const reqEditorBtn   = document.getElementById('req-editor-btn');
const rulesBtn       = document.getElementById('rules-btn');

// ─── Proxy pill refs ──────────────────────────────────────────────────────────
const pbStatusBtn    = document.getElementById('pb-status-btn');
const pbDot          = document.getElementById('pb-dot');
const pbName         = document.getElementById('pb-name');
const settingsToggle = document.getElementById('settings-toggle-btn');

// ─── Settings panel refs ──────────────────────────────────────────────────────
const settingsPanel   = document.getElementById('settings-panel');
const spAutoSS        = document.getElementById('sp-auto-screenshot');
const spFilters       = document.getElementById('sp-filter-patterns');
const spSaveFilters   = document.getElementById('sp-save-filters');
const spPasteUnlock   = document.getElementById('sp-paste-unlock');
const spPerfTbody     = document.getElementById('sp-perf-tbody');
const spPerfUpdated   = document.getElementById('sp-perf-updated');
const toastContainer  = document.getElementById('rule-toast-container');

// ─── Navigation ───────────────────────────────────────────────────────────────
backBtn.addEventListener('click',    () => api.navBack());
forwardBtn.addEventListener('click', () => api.navForward());
reloadBtn.addEventListener('click',  () => api.navReload());
if (homeBtn) homeBtn.addEventListener('click', () => api.navHome());

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        let url = urlInput.value.trim();
        if (!url) return;
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        api.navigateTo(url);
    }
});

api.onURLUpdate((url) => {
    if (document.activeElement !== urlInput) urlInput.value = url;
    ssHandleUrlChange(url);
});

// Navigation started by a link click or JS (will-navigate).
// Force-update the address bar even if urlInput currently has focus
// (BrowserView clicks don't transfer focus to the chrome renderer).
api.onTabWillNavigate?.((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && active.id === data.tabId) {
        urlInput.value = data.url;
        urlInput.blur();        // release focus — user is no longer editing
        ssHandleUrlChange(data.url);
    }
});

api.onSetLoadingState((loading) => {
    toolbar.classList.toggle('loading', loading);
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

function makeTabEl(tab) {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.isActive ? ' active' : '') + (tab.isolated ? ' isolated' : '');
    el.dataset.id = tab.id;
    el.title = (tab.url || '') + (tab.isolated ? ' [Isolated cookies]' : '');

    const faviconWrapper = document.createElement('span');
    faviconWrapper.className = 'tab-favicon-wrapper';
    if (tab.faviconUrl) {
        const img = document.createElement('img');
        img.className = 'tab-favicon-img';
        img.src = tab.faviconUrl;
        const fallback = document.createElement('span');
        fallback.className = 'tab-favicon';
        fallback.textContent = '🌐';
        fallback.style.display = 'none';
        img.onerror = () => { img.style.display = 'none'; fallback.style.display = ''; };
        faviconWrapper.appendChild(img);
        faviconWrapper.appendChild(fallback);
    } else {
        const favicon = document.createElement('span');
        favicon.className = 'tab-favicon';
        favicon.textContent = '🌐';
        faviconWrapper.appendChild(favicon);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    const num = tab.num ? `#${tab.num} ` : '';
    const iso = tab.isolated ? '🔐 ' : '';
    title.textContent = num + iso + (tab.title || 'New Tab');

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
            const wantClass = 'tab-item' + (tab.isActive ? ' active' : '') + (tab.isolated ? ' isolated' : '');
            if (el.className !== wantClass) el.className = wantClass;

            const wantTitle = (tab.url || '') + (tab.isolated ? ' [Isolated cookies]' : '');
            if (el.title !== wantTitle) el.title = wantTitle;

            const titleEl = el.querySelector('.tab-title');
            if (titleEl) {
                const num = tab.num ? `#${tab.num} ` : '';
                const iso = tab.isolated ? '🔐 ' : '';
                const want = num + iso + (tab.title || 'New Tab');
                if (titleEl.textContent !== want) titleEl.textContent = want;
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

api.onTabListUpdated((tabData) => {
    renderTabs(tabData);
    const active = tabData.find(t => t.isActive);
    if (active && document.activeElement !== urlInput) {
        const url = active.url === 'about:blank' ? '' : (active.url || '');
        urlInput.value = url;
        ssHandleUrlChange(url);
    }
});

api.onTabUrlChanged((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && active.id === data.tabId && document.activeElement !== urlInput) {
        const url = data.url === 'about:blank' ? '' : (data.url || '');
        urlInput.value = url;
        ssHandleUrlChange(url);
    }
});

// ─── Right toolbar actions ────────────────────────────────────────────────────
if (logViewerBtn) {
    logViewerBtn.addEventListener('click', () => api.openLogViewer());
}

// ─── Screenshot countdown ─────────────────────────────────────────────────────

const ssCountdownEl = document.getElementById('screenshot-countdown');
const ssFlashEl     = document.getElementById('screenshot-flash');

let ssIntervalSec  = 0;   // configured interval (seconds)
let ssRemaining    = 0;   // current countdown value
let ssTickTimer    = null; // setInterval handle
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
    if (ssTickTimer) { clearInterval(ssTickTimer); ssTickTimer = null; }
    ssIntervalSec = intervalSec;
    if (intervalSec <= 0 || ssOnHomePage) { ssUpdateBadge(0); return; }
    ssRemaining = intervalSec;
    ssUpdateBadge(ssRemaining);
    ssTickTimer = setInterval(() => {
        ssRemaining--;
        if (ssRemaining <= 0) ssRemaining = ssIntervalSec;
        ssUpdateBadge(ssRemaining);
    }, 1000);
}

function ssHandleUrlChange(url) {
    const onHome = ssIsHomePage(url);
    if (onHome === ssOnHomePage) return; // no change
    ssOnHomePage = onHome;
    if (onHome) {
        // Paused — stop timer and hide badge
        if (ssTickTimer) { clearInterval(ssTickTimer); ssTickTimer = null; }
        ssUpdateBadge(0);
    } else {
        // Resumed — restart countdown from full interval
        ssResetTimer(ssIntervalSec);
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
        await api.takeScreenshot().catch(() => {});
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

// ─── Favicon support ──────────────────────────────────────────────────────────
function getFaviconHtml(tab) {
    if (tab.faviconUrl) {
        return `<img class="tab-favicon-img" src="${tab.faviconUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display=''">` +
               `<span class="tab-favicon" style="display:none">🌐</span>`;
    }
    return `<span class="tab-favicon">🌐</span>`;
}

// ─── Proxy pill ───────────────────────────────────────────────────────────────

function shortenProxy(raw) {
    if (!raw) return 'Direct';
    try {
        const u = new URL(raw.includes('://') ? raw : 'http://' + raw);
        return u.hostname + (u.port ? ':' + u.port : '');
    } catch { return raw.slice(0, 22); }
}

function updateProxyStatus(info) {
    if (!info) return;
    const active = !!info.active;
    pbDot.classList.toggle('active', active);
    pbName.textContent = active
        ? (info.proxyName ? shortenProxy(info.proxyName) : 'Proxy on')
        : 'Direct';
    pbStatusBtn.title = active
        ? `Proxy: ${info.proxyName || 'active'} — click to manage`
        : 'No proxy — click to set up';
}

// Click opens Proxy Manager
if (pbStatusBtn) {
    pbStatusBtn.addEventListener('click', () => api.openProxyManager());
}

// Live updates
api.onProxyStatusChanged(updateProxyStatus);
api.getCurrentProxy().then(updateProxyStatus).catch(() => {});

// ─── Settings panel ───────────────────────────────────────────────────────────
let settingsOpen     = false;
let activeSpTab      = 'general';
let perfPollTimer    = null;
const SETTINGS_PANEL_HEIGHT = 260; // Must match CSS max-height in #settings-panel.open

function switchSpTab(name) {
    activeSpTab = name;
    document.querySelectorAll('.sp-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.spTab === name);
    });
    document.querySelectorAll('.sp-tab-body').forEach(el => {
        el.style.display = el.id === `sp-tab-${name}` ? '' : 'none';
    });
    if (name === 'performance') startPerfPoll();
    else stopPerfPoll();
}

document.querySelectorAll('.sp-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchSpTab(btn.dataset.spTab));
});

function toggleSettings() {
    settingsOpen = !settingsOpen;
    settingsPanel.classList.toggle('open', settingsOpen);
    settingsToggle.classList.toggle('active', settingsOpen);
    api.setToolbarHeight(settingsOpen ? SETTINGS_PANEL_HEIGHT : 0).catch(() => {});
    if (!settingsOpen) stopPerfPoll();
    else if (activeSpTab === 'performance') startPerfPoll();
}

settingsToggle.addEventListener('click', toggleSettings);

// ─── Performance metrics ──────────────────────────────────────────────────────

function fmtMb(kb) { return (kb / 1024).toFixed(1); }

function renderPerfMetrics(metrics) {
    if (!spPerfTbody) return;
    if (!metrics?.length) {
        spPerfTbody.innerHTML = '<tr><td colspan="6" class="sp-perf-loading">No data</td></tr>';
        return;
    }
    const typeClass = t => {
        if (t === 'Browser')  return 'sp-perf-type-browser';
        if (t === 'Renderer') return 'sp-perf-type-renderer';
        if (t === 'GPU')      return 'sp-perf-type-gpu';
        return 'sp-perf-type-utility';
    };
    spPerfTbody.innerHTML = metrics.map(m => {
        const cpuHigh = m.cpuPercent > 30 ? ' sp-perf-cpu-high' : '';
        return `<tr>
            <td><span class="sp-perf-type ${typeClass(m.type)}">${m.type}${m.name ? ` (${m.name})` : ''}</span></td>
            <td style="font-size:10px;color:#9ca3af">${m.pid}</td>
            <td class="num${cpuHigh}">${m.cpuPercent.toFixed(1)}%</td>
            <td class="num">${fmtMb(m.memWorkingSet)}</td>
            <td class="num">${fmtMb(m.memPrivate)}</td>
            <td style="font-size:10px">${m.sandboxed ? '✓' : '—'}</td>
        </tr>`;
    }).join('');
    if (spPerfUpdated) spPerfUpdated.textContent = new Date().toLocaleTimeString();
}

async function fetchAndRenderPerf() {
    try {
        const metrics = await api.getAppMetrics();
        renderPerfMetrics(metrics);
    } catch { /* ignore */ }
}

function startPerfPoll() {
    stopPerfPoll();
    fetchAndRenderPerf();
    perfPollTimer = setInterval(fetchAndRenderPerf, 3000);
}

function stopPerfPoll() {
    if (perfPollTimer) { clearInterval(perfPollTimer); perfPollTimer = null; }
}

function applyPasteUnlock(enabled) {
    if (spPasteUnlock) spPasteUnlock.checked = !!enabled;
}

// Populate from init-settings event (sent on window load)
api.onInitSettings((data) => {
    if (spFilters) {
        spFilters.value = (data.filterPatterns || []).join('\n');
    }
    applyScreenshotSetting(data.autoScreenshot ?? 5);
    applyPasteUnlock(data.pasteUnlock !== false);
});

// Also load on demand (settings panel opened before init event arrives)
api.getSettingsAll().then((data) => {
    if (spFilters && (!spFilters.value) && data?.filterPatterns) {
        spFilters.value = data.filterPatterns.join('\n');
    }
    applyScreenshotSetting(data?.autoScreenshot ?? 5);
    applyPasteUnlock(data?.pasteUnlock !== false);
}).catch(() => {});

// Auto screenshot — number input (0 = off, 1-60 = interval in seconds)
function applyScreenshotSetting(seconds) {
    const sec = Math.max(0, Math.min(60, Number(seconds) || 0));
    if (spAutoSS) spAutoSS.value = sec;
    ssResetTimer(sec);  // start / stop visual countdown
}

let ssDebounce;
spAutoSS?.addEventListener('input', () => {
    clearTimeout(ssDebounce);
    ssDebounce = setTimeout(() => {
        const sec = Math.max(0, Math.min(60, Number(spAutoSS.value) || 0));
        spAutoSS.value = sec;
        api.setAutoScreenshot(sec);
        ssResetTimer(sec);
    }, 500);
});

// Paste unlock toggle
spPasteUnlock?.addEventListener('change', () => {
    api.setPasteUnlock(spPasteUnlock.checked);
});

// Filter patterns
spSaveFilters?.addEventListener('click', () => {
    const patterns = (spFilters?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
    api.saveFilterPatterns(patterns);
    const btn = spSaveFilters;
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save filters'; }, 1500);
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

// ─── Init: fetch current tabs ─────────────────────────────────────────────────
api.getTabs().then(renderTabs).catch(() => {});
