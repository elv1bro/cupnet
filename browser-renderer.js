'use strict';

const api = window.electronAPI;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const backBtn        = document.getElementById('back-btn');
const forwardBtn     = document.getElementById('forward-btn');
const reloadBtn      = document.getElementById('reload-btn');
const homeBtn        = document.getElementById('home-btn');
const urlInput       = document.getElementById('url-input');
const addressBarContainer = document.getElementById('address-bar-container');
const urlOmniboxDropdown = document.getElementById('url-omnibox-dropdown');
const URL_INPUT_PLACEHOLDER_DEFAULT = 'Type > for commands, or enter a URL…';
const URL_INPUT_PLACEHOLDER_OMNIBOX = 'Commands: > filter · URL: type and Enter';
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
const notesBtn       = document.getElementById('notes-btn');
const credUnifiedWrap = document.getElementById('cred-unified-wrap');
const credentialsBtn = document.getElementById('credentials-btn');
const credentialsSiteBadge = document.getElementById('credentials-site-badge');
const credPopup = document.getElementById('cred-popup');
const credPopupUnlock = document.getElementById('cred-popup-unlock');
const credPopupPw = document.getElementById('cred-popup-pw');
const credPopupUnlockBtn = document.getElementById('cred-popup-unlock-btn');
const credPopupUnlockErr = document.getElementById('cred-popup-unlock-err');
const credPopupList = document.getElementById('cred-popup-list');
const credPopupEmpty = document.getElementById('cred-popup-empty');
const credPopupOpenVault = document.getElementById('cred-popup-open-vault');
/** @type {Array<{ id: number, login: string, label: string }>} */
let credFillMatchesCache = [];
let credLongPressTimer = null;
let credLongPressFired = false;

// ─── Proxy pill refs ──────────────────────────────────────────────────────────
const pbStatusBtn    = document.getElementById('pb-status-btn');
const pbDot          = document.getElementById('pb-dot');
const pbName         = document.getElementById('pb-name');
const pbModeBadge    = document.getElementById('pb-mode-badge');
const settingsToggle = document.getElementById('settings-toggle-btn');

const statusMitm      = document.getElementById('status-mitm');
const statusProxy     = document.getElementById('status-proxy');
const statusIp        = document.getElementById('status-ip');
const statusRequests  = document.getElementById('status-requests');
const statusErrors    = document.getElementById('status-errors');

const toastContainer  = document.getElementById('rule-toast-container');

// ─── Navigation ───────────────────────────────────────────────────────────────
backBtn.addEventListener('click',    () => api.navBack());
forwardBtn.addEventListener('click', () => api.navForward());
reloadBtn.addEventListener('click',  () => api.navReload());
if (homeBtn) homeBtn.addEventListener('click', () => api.navHome());

function isOmniboxDropdownVisible() {
    const el = document.getElementById('command-palette');
    return !!(el && !el.classList.contains('hidden'));
}

urlInput.addEventListener('keydown', (e) => {
    if (!isOmniboxDropdownVisible() && e.key === 'Enter') {
        const raw = urlInput.value.trim();
        if (!raw) return;
        // Sync with main in case omnibox chrome reserve / overlay state is out of date.
        hideCommandPalette();
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
    hideCredPopup();
    scheduleCookiePageBadgeRefresh();
    scheduleCredentialsToolbarRefresh();
});

// Navigation started by a link click or JS (will-navigate).
// Force-update the address bar even if urlInput currently has focus
// (Tab WebContentsView clicks don't transfer focus to the chrome renderer).
api.onTabWillNavigate?.((data) => {
    const active = tabs.find(t => t.isActive);
    if (active && active.id === data.tabId) {
        const normalized = _normalizeToolbarUrl(data.url);
        // Force-update + blur: page navigation started, typed draft is no longer relevant.
        _setToolbarUrlIfChanged(normalized, { respectFocus: false, blur: true });
        ssHandleUrlChange(normalized);
        hideCredPopup();
        scheduleCookiePageBadgeRefresh();
        scheduleCredentialsToolbarRefresh();
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
let _statusLogCount = 0;

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
    _statusLogCount = (data && Number.isFinite(data.count)) ? data.count : 0;
    if (!on) {
        if (logSessionNum)  logSessionNum.textContent = '#—';
        if (logEntryBadge) { logEntryBadge.style.display = 'none'; logEntryBadge.textContent = '0'; }
        refreshBrowserStatusBar();
        return;
    }
    if (logSessionNum)  logSessionNum.textContent = `#${data.sessionId}`;
    if (logEntryBadge) {
        logEntryBadge.textContent = data.count >= 1000 ? `${Math.floor(data.count/1000)}k` : data.count;
        logEntryBadge.style.display = data.count > 0 ? '' : 'none';
    }
    refreshBrowserStatusBar();
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
    el.className = 'tab-item' + (tab.isActive ? ' active' : '') + (tab.isolated ? ' isolated' : '');
    el.dataset.id = tab.id;
    el.title = (tab.url || '') + (tab.isolated ? ' [Isolated cookies]' : '');

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

    // Per-tab indicator dots
    const indicators = document.createElement('span');
    indicators.className = 'tab-indicators';
    {
        const dot = document.createElement('span');
        dot.className = 'tab-dot tab-dot-cupnet';
        dot.title = 'MITM / CupNet';
        indicators.appendChild(dot);
    }
    if (tab.proxyProfileId) {
        const dot = document.createElement('span');
        dot.className = 'tab-dot tab-dot-proxy';
        dot.title = 'Per-tab proxy';
        indicators.appendChild(dot);
    }
    if (tab.cookieGroupId && tab.cookieGroupId !== 1) {
        const dot = document.createElement('span');
        dot.className = 'tab-dot tab-dot-cookies';
        dot.title = 'Custom cookie group';
        indicators.appendChild(dot);
    }

    el.appendChild(faviconWrapper);
    if (indicators.childElementCount > 0) el.appendChild(indicators);
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

// Legacy buttons removed — single "+" button creates regular tabs.
// CupNet ON/OFF is toggled via per-tab controls.

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
        scheduleCookiePageBadgeRefresh();
        scheduleCredentialsToolbarRefresh();
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
    if (active && active.id === data.tabId) {
        hideCredPopup();
        scheduleCookiePageBadgeRefresh();
        scheduleCredentialsToolbarRefresh();
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

// ─── Cookie count on toolbar (current page URL) ───────────────────────────────
const cookiePageBadge = document.getElementById('cookie-page-badge');
let _cookieBadgeTimer = null;
function scheduleCookiePageBadgeRefresh() {
    clearTimeout(_cookieBadgeTimer);
    _cookieBadgeTimer = setTimeout(() => { void refreshCookiePageBadge(); }, 450);
}
async function refreshCookiePageBadge() {
    if (!cookiePageBadge || !window.CupNetCookiePageMatch) return;
    const active = tabs.find(t => t.isActive);
    const url = active?.url || '';
    if (!active || ssIsHomePage(url)) {
        cookiePageBadge.style.display = 'none';
        cookiePageBadge.textContent = '';
        return;
    }
    try {
        const list = await api.getCookies(active.id, {});
        const n = window.CupNetCookiePageMatch.countCookiesForPageUrl(list, url);
        if (n > 0) {
            cookiePageBadge.textContent = n > 99 ? '99+' : String(n);
            cookiePageBadge.style.display = 'inline-flex';
        } else {
            cookiePageBadge.style.display = 'none';
            cookiePageBadge.textContent = '';
        }
    } catch {
        cookiePageBadge.style.display = 'none';
    }
}

// ─── Credentials toolbar: badge (matches for current site) + Fill button ───
let _credToolbarTimer = null;
function scheduleCredentialsToolbarRefresh() {
    clearTimeout(_credToolbarTimer);
    _credToolbarTimer = setTimeout(() => { void refreshCredentialsToolbarBadges(); }, 400);
}

function showCredToolbarToast(message, type) {
    if (!message) return;
    if (typeof showToast === 'function') {
        const t = type || (/could not|error|fail/i.test(String(message)) ? 'error' : 'success');
        showToast(String(message), { type: t, duration: 3200 });
        return;
    }
    if (!toastContainer) return;
    const el = document.createElement('div');
    el.className = 'rule-toast';
    el.style.whiteSpace = 'pre-wrap';
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 320);
    }, 3200);
}

function hideCredPopup() {
    if (!credPopup) return;
    credPopup.classList.add('hidden');
    if (credPopupUnlockErr) {
        credPopupUnlockErr.textContent = '';
        credPopupUnlockErr.classList.add('hidden');
    }
    if (credPopupPw) credPopupPw.value = '';
}

function showCredPopupUnlock() {
    if (!credPopup || !credPopupUnlock) return;
    credPopup.classList.remove('hidden');
    credPopupUnlock.classList.remove('hidden');
    if (credPopupList) credPopupList.classList.add('hidden');
    if (credPopupEmpty) credPopupEmpty.classList.add('hidden');
    setTimeout(() => {
        try {
            credPopupPw?.focus({ preventScroll: true });
        } catch {
            credPopupPw?.focus();
        }
    }, 30);
}

function showCredPopupList(matches) {
    if (!credPopup || !credPopupList) return;
    credPopup.classList.remove('hidden');
    if (credPopupUnlock) credPopupUnlock.classList.add('hidden');
    if (credPopupEmpty) credPopupEmpty.classList.add('hidden');
    credPopupList.classList.remove('hidden');
    credPopupList.innerHTML = (matches || []).map((row) => {
        const title = row.label || row.login || `Account ${row.id}`;
        const line2 = row.label && row.login ? row.login : '';
        return `<button type="button" class="cred-fill-menu-item" role="menuitem" data-cred-id="${row.id}">` +
            `<span class="cred-fill-menu-title">${escapeHtmlCred(title)}</span>` +
            (line2 ? `<span class="cred-fill-menu-sub">${escapeHtmlCred(line2)}</span>` : '') +
            '</button>';
    }).join('');
    credPopupList.querySelectorAll('.cred-fill-menu-item').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.getAttribute('data-cred-id'));
            hideCredPopup();
            try {
                const res = await api.credentialsFillActiveTab({ credentialId: id });
                if (res?.success) {
                    showCredToolbarToast('Filled login and password from vault.', 'success');
                } else {
                    showCredToolbarToast(res?.error || 'Could not fill this page.', 'error');
                }
            } catch (err) {
                showCredToolbarToast(String(err?.message || err), 'error');
            }
        });
    });
}

function showCredPopupEmpty() {
    if (!credPopup) return;
    credPopup.classList.remove('hidden');
    if (credPopupUnlock) credPopupUnlock.classList.add('hidden');
    if (credPopupList) {
        credPopupList.classList.add('hidden');
        credPopupList.innerHTML = '';
    }
    if (credPopupEmpty) credPopupEmpty.classList.remove('hidden');
}

function escapeHtmlCred(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

async function refreshCredentialsToolbarBadges() {
    if (!credentialsSiteBadge || !credUnifiedWrap) return;
    credFillMatchesCache = [];
    const active = tabs.find(t => t.isActive);
    const url = active?.url || '';
    if (!active || ssIsHomePage(url) || !/^https?:\/\//i.test(url)) {
        credentialsSiteBadge.style.display = 'none';
        credentialsSiteBadge.textContent = '';
        credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
        return;
    }
    if (!api.credentialsSiteMatchCount) {
        credentialsSiteBadge.style.display = 'none';
        credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
        return;
    }
    try {
        const r = await api.credentialsSiteMatchCount({ pageUrl: url });
        if (!r || !r.exists) {
            credentialsSiteBadge.style.display = 'none';
            credentialsSiteBadge.textContent = '';
            credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
            return;
        }
        const n = Number(r.count) || 0;
        const unlocked = r.unlocked === true;
        if (n > 0) {
            credentialsSiteBadge.textContent = n > 99 ? '99+' : String(n);
            credentialsSiteBadge.style.display = 'inline-flex';
            credentialsSiteBadge.classList.toggle('cred-badge-unlocked', unlocked);
            credentialsSiteBadge.classList.toggle('cred-badge-locked', !unlocked);
            if (unlocked && api.credentialsSiteMatches) {
                try {
                    const m = await api.credentialsSiteMatches({ pageUrl: url });
                    if (Array.isArray(m?.matches)) credFillMatchesCache = m.matches;
                } catch { /* ignore */ }
            }
        } else {
            credentialsSiteBadge.style.display = 'none';
            credentialsSiteBadge.textContent = '';
            credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
        }
    } catch {
        credentialsSiteBadge.style.display = 'none';
        credentialsSiteBadge.classList.remove('cred-badge-locked', 'cred-badge-unlocked');
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

if (notesBtn) {
    notesBtn.addEventListener('click', () => {
        api.openNotesWindow();
    });
}

async function handleCredentialsToolbarPrimaryClick(ev) {
    ev.stopPropagation();
    if (credLongPressFired) {
        credLongPressFired = false;
        return;
    }
    const active = tabs.find(t => t.isActive);
    const url = active?.url || '';
    if (!active || ssIsHomePage(url) || !/^https?:\/\//i.test(url)) {
        showCredToolbarToast('Open a website to use saved credentials.', 'error');
        return;
    }
    if (!api.credentialsSiteMatchCount) return;
    let r;
    try {
        r = await api.credentialsSiteMatchCount({ pageUrl: url });
    } catch (e) {
        showCredToolbarToast(String(e?.message || e), 'error');
        return;
    }
    if (!r?.exists) {
        api.openCredentialsWindow();
        return;
    }
    const count = Number(r.count) || 0;
    const unlocked = r.unlocked === true;

    // If the dropdown was left open (e.g. empty state, SPA nav), the first click used to
    // only dismiss it — do nothing visible. For unlocked + exactly one match, dismiss then fill.
    const popupVisible = credPopup && !credPopup.classList.contains('hidden');
    if (popupVisible) {
        hideCredPopup();
        if (!(unlocked && count === 1)) {
            return;
        }
    }

    if (!unlocked) {
        showCredPopupUnlock();
        return;
    }

    if (count === 0) {
        showCredPopupEmpty();
        return;
    }
    if (count === 1) {
        try {
            const res = await api.credentialsFillActiveTab({});
            if (res?.success) {
                showCredToolbarToast('Filled login and password from vault.', 'success');
            } else {
                showCredToolbarToast(res?.error || 'Could not fill this page.', 'error');
            }
        } catch (e) {
            showCredToolbarToast(String(e?.message || e), 'error');
        }
        return;
    }
    let matches = credFillMatchesCache;
    if (matches.length !== count && api.credentialsSiteMatches) {
        try {
            const m = await api.credentialsSiteMatches({ pageUrl: url });
            if (Array.isArray(m?.matches)) matches = m.matches;
        } catch { /* use cache */ }
    }
    showCredPopupList(matches);
}

async function submitCredPopupUnlock() {
    const active = tabs.find(t => t.isActive);
    const url = active?.url || '';
    if (!credPopupPw || !api.credentialsUnlockAndGetMatches) return;
    const pw = credPopupPw.value;
    if (credPopupUnlockErr) {
        credPopupUnlockErr.textContent = '';
        credPopupUnlockErr.classList.add('hidden');
    }
    try {
        const r = await api.credentialsUnlockAndGetMatches({ password: pw, pageUrl: url });
        if (!r?.success) {
            if (credPopupUnlockErr) {
                credPopupUnlockErr.textContent = r?.error || 'Unlock failed';
                credPopupUnlockErr.classList.remove('hidden');
            }
            return;
        }
        credPopupPw.value = '';
        void scheduleCredentialsToolbarRefresh();
        const matches = Array.isArray(r.matches) ? r.matches : [];
        if (matches.length === 0) {
            showCredPopupEmpty();
            return;
        }
        if (matches.length === 1) {
            hideCredPopup();
            try {
                const res = await api.credentialsFillActiveTab({ credentialId: matches[0].id });
                if (res?.success) {
                    showCredToolbarToast('Filled login and password from vault.', 'success');
                } else {
                    showCredToolbarToast(res?.error || 'Could not fill this page.', 'error');
                }
            } catch (e) {
                showCredToolbarToast(String(e?.message || e), 'error');
            }
            return;
        }
        showCredPopupList(matches);
    } catch (e) {
        if (credPopupUnlockErr) {
            credPopupUnlockErr.textContent = String(e?.message || e);
            credPopupUnlockErr.classList.remove('hidden');
        }
    }
}

if (credentialsBtn) {
    credentialsBtn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        credLongPressFired = false;
        clearTimeout(credLongPressTimer);
        credLongPressTimer = setTimeout(() => {
            credLongPressTimer = null;
            credLongPressFired = true;
            hideCredPopup();
            api.openCredentialsWindow();
        }, 500);
    });
    credentialsBtn.addEventListener('pointerup', () => {
        clearTimeout(credLongPressTimer);
        credLongPressTimer = null;
    });
    credentialsBtn.addEventListener('pointerleave', () => {
        clearTimeout(credLongPressTimer);
        credLongPressTimer = null;
    });
    credentialsBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        hideCredPopup();
        api.openCredentialsWindow();
    });
    credentialsBtn.addEventListener('click', (ev) => void handleCredentialsToolbarPrimaryClick(ev));
}

if (credPopupUnlockBtn) {
    credPopupUnlockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void submitCredPopupUnlock();
    });
}
if (credPopupPw) {
    credPopupPw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void submitCredPopupUnlock();
        }
    });
    credPopupPw.addEventListener('click', (e) => e.stopPropagation());
}
if (credPopupOpenVault) {
    credPopupOpenVault.addEventListener('click', (e) => {
        e.stopPropagation();
        hideCredPopup();
        api.openCredentialsWindow();
    });
}
if (credPopup) {
    credPopup.addEventListener('click', (e) => e.stopPropagation());
}
document.addEventListener('click', (e) => {
    if (credUnifiedWrap && credUnifiedWrap.contains(e.target)) return;
    hideCredPopup();
});

if (api.onCredentialsToolbarRefresh) {
    api.onCredentialsToolbarRefresh(() => scheduleCredentialsToolbarRefresh());
}

// ─── Credential save bar (auto-capture prompt) ───────────────────────────────
const credSaveBar     = document.getElementById('credential-save-bar');
const credSaveDomain  = document.getElementById('cred-save-domain');
const credSaveLogin   = document.getElementById('cred-save-login');
const credSaveUnlockRow = document.getElementById('cred-save-unlock-row');
const credSavePw      = document.getElementById('cred-save-pw');
const credSaveYes     = document.getElementById('cred-save-yes');
const credSaveNever   = document.getElementById('cred-save-never');
const credSaveDismiss = document.getElementById('cred-save-dismiss');

/** Extra space above the tab WebContentsView when the credential save bar is visible. */
const CRED_SAVE_BAR_RESERVE_PX = 36;

function getCredSaveBarReservePx() {
    return credSaveBar && !credSaveBar.classList.contains('hidden') ? CRED_SAVE_BAR_RESERVE_PX : 0;
}

async function applyChromeToolbarReserve() {
    try {
        await api.setToolbarHeight(getCredSaveBarReservePx());
    } catch (_) { /* ignore */ }
}

function hideCredSaveBar() {
    if (credSaveBar) credSaveBar.classList.add('hidden');
    if (credSavePw) credSavePw.value = '';
    void applyChromeToolbarReserve();
}

if (api.onShowCredentialSaveBar) {
    api.onShowCredentialSaveBar((data) => {
        if (!credSaveBar) return;
        credSaveBar.classList.remove('hidden');
        if (credSaveDomain) credSaveDomain.textContent = data.domain || '';
        if (credSaveLogin) credSaveLogin.textContent = data.login ? `(${data.login})` : '';
        if (data.needsUnlock) {
            if (credSaveUnlockRow) { credSaveUnlockRow.classList.remove('hidden'); credSaveUnlockRow.style.display = 'flex'; }
            if (credSaveYes) credSaveYes.textContent = 'Unlock & Save';
            setTimeout(() => credSavePw?.focus(), 60);
        } else {
            if (credSaveUnlockRow) { credSaveUnlockRow.classList.add('hidden'); credSaveUnlockRow.style.display = 'none'; }
            if (credSaveYes) credSaveYes.textContent = 'Save';
        }
        void applyChromeToolbarReserve();
    });
}

if (credSaveYes) {
    credSaveYes.addEventListener('click', async () => {
        const needsUnlock = credSaveUnlockRow && !credSaveUnlockRow.classList.contains('hidden');
        if (needsUnlock) {
            const pw = credSavePw?.value || '';
            if (!pw) { credSavePw?.focus(); return; }
            const res = await api.credentialCaptureUnlockAndSave(pw);
            if (res.success) {
                hideCredSaveBar();
                if (typeof showToast === 'function') showToast('Password saved to vault', { type: 'success' });
            } else {
                if (typeof showToast === 'function') showToast(res.error || 'Failed', { type: 'error' });
            }
        } else {
            const res = await api.credentialCaptureConfirm();
            if (res.success) {
                hideCredSaveBar();
                if (typeof showToast === 'function') showToast('Password saved to vault', { type: 'success' });
            } else {
                if (typeof showToast === 'function') showToast(res.error || 'Failed', { type: 'error' });
            }
        }
    });
}

if (credSaveNever) {
    credSaveNever.addEventListener('click', async () => {
        await api.credentialCaptureDismiss();
        hideCredSaveBar();
    });
}

if (credSaveDismiss) {
    credSaveDismiss.addEventListener('click', async () => {
        await api.credentialCaptureDismiss();
        hideCredSaveBar();
    });
}

if (credSavePw) {
    credSavePw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') credSaveYes?.click();
        if (e.key === 'Escape') { hideCredSaveBar(); api.credentialCaptureDismiss(); }
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
let _isIsolatedTab     = false;
let _isNewTabPage      = false;
let _lastPillTabSig    = '';

const ENV_CLASSES = ['env-direct', 'env-proxy', 'env-isolated', 'env-newtab'];

function _setEnvClass(el, cls) {
    if (!el) return;
    ENV_CLASSES.forEach(c => el.classList.remove(c));
    if (cls) el.classList.add(cls);
}

function _currentEnvClass() {
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

    const info = _lastProxyInfo;
    if (!info) {
        refreshBrowserStatusBar();
        return;
    }
    const active = !!info.active;
    const label  = (info.displayProxyName || info.proxyName || 'Proxy');

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
    } else if (!active && _directIpGeo && _directIpGeo._tried) {
        pbDetail.textContent = '—';
    } else if (!active) {
        pbDetail.textContent = 'checking…';
        _fetchDirectIpGeo();
    } else {
        pbDetail.textContent = '';
    }

    pbStatusBtn.title = active
        ? `${label} — click to manage`
        : 'No proxy — click to set up';

    _renderModeBadge(info);
    refreshBrowserStatusBar();
}

function _renderModeBadge(_info) {
    if (!pbModeBadge) return;
    pbModeBadge.textContent = '';
    pbModeBadge.style.display = 'none';
}

function updateProxyStatus(info) {
    if (!info) return;
    _lastProxyInfo = info;
    _renderPill();
}

function refreshBrowserStatusBar() {
    if (!statusMitm && !statusProxy) return;

    if (typeof api.getMitmStats === 'function') {
        api.getMitmStats().then((st) => {
            const ready = st && st.workerReady !== false;
            if (statusMitm) statusMitm.textContent = `MITM: ${ready ? 'Active' : 'Starting'}`;
            if (statusErrors) statusErrors.textContent = `Errors: ${st && st.errors != null ? st.errors : '—'}`;
        }).catch(() => {
            if (statusMitm) statusMitm.textContent = 'MITM: —';
        });
    }

    const info = _lastProxyInfo;
    if (statusProxy) {
        if (!info) {
            statusProxy.textContent = 'Proxy: —';
        } else {
            const active = !!info.active;
            const label = active ? (info.displayProxyName || info.proxyName || 'Proxy') : 'Direct';
            statusProxy.textContent = `Proxy: ${label}`;
        }
    }

    if (statusIp) {
        let txt = '—';
        if (info?.active && _proxyIpGeo && _proxyIpGeo.ip) {
            const loc = [_proxyIpGeo.city, _proxyIpGeo.country].filter(Boolean).join(', ');
            txt = _proxyIpGeo.ip + (loc ? ' · ' + loc : '');
        } else if (info && !info.active && _directIpGeo && _directIpGeo.ip) {
            const loc = [_directIpGeo.city, _directIpGeo.country].filter(Boolean).join(', ');
            txt = _directIpGeo.ip + (loc ? ' · ' + loc : '');
        } else if (info && !info.active && _directIpGeo && _directIpGeo._tried) {
            txt = '—';
        } else if (info && !info.active) {
            txt = 'checking…';
        }
        statusIp.textContent = `IP: ${txt}`;
    }

    if (statusRequests) {
        statusRequests.textContent = `Requests: ${isLogging ? _statusLogCount : 0}`;
    }
}

function _activeTabIdForIpGeo() {
    const a = tabs.find(t => t.isActive);
    return a?.id;
}

function _fetchProxyIpGeo() {
    const tid = _activeTabIdForIpGeo();
    api.checkIpGeo(tid).then(geo => {
        if (geo && geo.ip && geo.ip !== 'unknown') {
            _proxyIpGeo = geo;
            _renderPill();
        }
    }).catch(() => {});
}

function _fetchDirectIpGeo() {
    if (_directIpGeo && (_directIpGeo.ip || _directIpGeo._tried)) return;
    const tid = _activeTabIdForIpGeo();
    api.checkIpGeo(tid).then(geo => {
        if (geo && geo.ip && geo.ip !== 'unknown') {
            _directIpGeo = geo;
        } else {
            _directIpGeo = { _tried: true };
        }
        _renderPill();
    }).catch(() => {
        _directIpGeo = { _tried: true };
        _renderPill();
    });
}

function _onActiveTabChanged(tabData) {
    const list = tabData || tabs;
    const active = list.find(t => t.isActive);
    _isIsolatedTab     = !!(active?.isolated);

    const url = active?.url || '';
    _isNewTabPage = !url || url === 'about:blank' || url.includes('new-tab.html');

    _renderPill();

    const pillSig = `${active?.id || ''}|${active?.proxyProfileId ?? ''}`;
    if (pillSig !== _lastPillTabSig) {
        _lastPillTabSig = pillSig;
        _proxyIpGeo = null;
        _directIpGeo = null;
        api.getCurrentProxy().then((info) => {
            updateProxyStatus(info);
            if (info?.active) _fetchProxyIpGeo();
        }).catch(() => {});
    }
    if (!_lastProxyInfo?.active) _fetchDirectIpGeo();
    hideCredPopup();
    scheduleCookiePageBadgeRefresh();
    scheduleCredentialsToolbarRefresh();
}

// Click opens Proxy Manager
if (pbStatusBtn) {
    pbStatusBtn.addEventListener('click', () => api.openProxyManager());
}

// Live updates
api.onProxyStatusChanged((info) => {
    _proxyIpGeo = null;
    _directIpGeo = null;
    updateProxyStatus(info);
    if (info?.active) _fetchProxyIpGeo();
});
api.getCurrentProxy().then((info) => {
    updateProxyStatus(info);
    if (info?.active) _fetchProxyIpGeo();
}).catch(() => {});

setInterval(() => {
    refreshBrowserStatusBar();
}, 8000);

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

const _BADGE_VISIBLE = 'inline-flex';

function updateRulesHitBadge() {
    if (!rulesHitBadge) return;
    if (_interceptHitCount > 0) {
        rulesHitBadge.textContent = _interceptHitCount > 99 ? '99+' : String(_interceptHitCount);
        rulesHitBadge.style.display = _BADGE_VISIBLE;
    } else {
        rulesHitBadge.style.display = 'none';
    }
}

function updateDnsHitBadge() {
    if (!dnsHitBadge) return;
    if (_dnsHitCount > 0) {
        dnsHitBadge.textContent = _dnsHitCount > 99 ? '99+' : String(_dnsHitCount);
        dnsHitBadge.style.display = _BADGE_VISIBLE;
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
    if (!Array.isArray(items) || !items.length) return;
    _interceptHitCount += items.length;
    updateRulesHitBadge();
});

function _onDnsRuleMatched() {
    _dnsHitCount++;
    updateDnsHitBadge();
}
api.onDnsRuleMatched?.(_onDnsRuleMatched);
api.onDnsRuleMatchedBatch?.((items) => {
    if (!Array.isArray(items) || !items.length) return;
    _dnsHitCount += items.length;
    updateDnsHitBadge();
});
api.onToolbarActivityBadgeReset?.((tool) => {
    const t = String(tool || '');
    if (t === 'dns') {
        _dnsHitCount = 0;
        updateDnsHitBadge();
    } else if (t === 'rules') {
        _interceptHitCount = 0;
        updateRulesHitBadge();
    }
});


// ─── Hotkey-driven IPC from main process ──────────────────────────────────────
/** Set from omnibox block: open suggestions when main focuses the address bar (Ctrl+L). */
let _focusUrlBarOmniboxExtra = null;
api.onFocusUrlBar?.(() => {
    urlInput.focus();
    urlInput.select();
    if (typeof _focusUrlBarOmniboxExtra === 'function') _focusUrlBarOmniboxExtra();
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
    if (document.getElementById('win-switcher-overlay')?.classList.contains('win-switcher-overlay--open')) return;
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
api.getTabs().then(td => { renderTabs(td); _onActiveTabChanged(td); scheduleCookiePageBadgeRefresh(); scheduleCredentialsToolbarRefresh(); }).catch(() => {});

// ─── Window switcher overlay (Ctrl+` from main) ─────────────────────────────
const winSwitcherOverlay = document.getElementById('win-switcher-overlay');
const winSwitcherList = document.getElementById('win-switcher-list');
let _winSwitcherCache = [];
/** First window index shown on the current grid page (0, 11, 22, … when >12 windows). */
let _winSwitcherPageOffset = 0;
let _lastWinSwitcherOpenedAt = 0;
/** Refresh window list while switcher is open (tab titles, DevTools #N, previews). */
let _winSwitcherRefreshTimer = null;
const WIN_SWITCHER_REFRESH_MS = 10000;
/** Bumps when switcher closes — ignore stale async preview loads. */
let _winSwitcherPreviewLoadGen = 0;
/** Ignore toggle-close right after open (duplicate IPC after tab → shell focus). */
const WIN_SWITCHER_TOGGLE_CLOSE_GRACE_MS = 220;

/** Physical keyboard left block: row1 1–3, then QWE, ASD, ZXC (`KeyboardEvent.code`). */
const WIN_SWITCHER_KEY_CODES = [
    'Digit1', 'Digit2', 'Digit3',
    'KeyQ', 'KeyW', 'KeyE',
    'KeyA', 'KeyS', 'KeyD',
    'KeyZ', 'KeyX', 'KeyC',
];
const WIN_SWITCHER_KEY_LABELS = ['1', '2', '3', 'Q', 'W', 'E', 'A', 'S', 'D', 'Z', 'X', 'C'];
const WIN_SWITCHER_CODE_TO_SLOT = new Map(WIN_SWITCHER_KEY_CODES.map((c, i) => [c, i]));

const WIN_SWITCHER_HINT_LINE1 =
    '4×3 grid: 1–3 / QWE / ASD / ZXC — pick a window; More… on the last key when needed';
const WIN_SWITCHER_HINT_LINE2 =
    'Arrow keys move · Enter to focus · Esc: back from More, or close · Ctrl+` — open from any CupNet window';

/** Keyboard highlight (0–11) in the 4×3 grid; reset when switching pages or closing. */
let _winSwitcherKeyboardSlot = 0;

function _winSwitcherMoveGrid(slot, dir) {
    const row = Math.floor(slot / 3);
    const col = slot % 3;
    if (dir === 'up') {
        if (row >= 1) return slot - 3;
        return slot;
    }
    if (dir === 'down') {
        if (row <= 2) return slot + 3;
        return slot;
    }
    if (dir === 'left') {
        if (col >= 1) return slot - 1;
        return slot;
    }
    if (dir === 'right') {
        if (col <= 1) return slot + 1;
        return slot;
    }
    return slot;
}

const CUPNET_LOGO_FALLBACK_SVG =
    '<svg viewBox="0 0 32 32" class="win-switcher-cupnet-fallback" aria-hidden="true"><defs><linearGradient id="wscg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#wscg)"/><path fill="#fff" d="M9 10.5c0-1.1.9-2 2-2h6.5c2.5 0 4.5 2 4.5 4.5S20 17.5 17.5 17.5H13v3h7v2.5H12c-1.1 0-2-.9-2-2v-5c0-1.1.9-2 2-2h4.5c1.4 0 2.5-1.1 2.5-2.5S18.4 9 17 9H11v1.5z"/></svg>';

/** Short English labels for window type (first line under each tile). */
const WIN_SWITCHER_KIND_LABELS = {
    'cupnet-main': 'CupNet',
    devtools: 'DevTools',
    'log-viewer': 'Log viewer',
    'cookie-manager': 'Cookie manager',
    'dns-manager': 'DNS manager',
    'proxy-manager': 'Proxy manager',
    rules: 'Rules',
    console: 'Console',
    'page-analyzer': 'Page analyzer',
    notes: 'Notes',
    'request-editor': 'Request editor',
    'compare-viewer': 'Compare viewer',
    'ivac-scout': 'IVAC scout',
    'logging-modal': 'Logging',
    unknown: 'Window',
};

/** Window title from main process (always show when present). */
function getSwitcherWindowTitle(w) {
    const t = (w.title && String(w.title).trim()) ? String(w.title).trim() : '';
    if (t) return t;
    if (w.type === 'cupnet-main') return 'CupNet';
    if (w.type === 'devtools' && w.devtoolsTabNum != null) return `DevTools #${w.devtoolsTabNum}`;
    return WIN_SWITCHER_KIND_LABELS[w.type] || w.type || 'Window';
}

/** Top title bar (like a window): text left, shortcut keycap right. */
function appendSwitcherTitleBar(row, w, keyLabel) {
    const kind = WIN_SWITCHER_KIND_LABELS[w.type] || w.type;
    const bar = document.createElement('div');
    bar.className = 'win-switcher-titlebar';

    const textCol = document.createElement('div');
    textCol.className = 'win-switcher-titlebar-text';

    const primary = document.createElement('span');
    primary.className = 'win-switcher-title-primary';
    primary.textContent = getSwitcherWindowTitle(w);
    primary.title = primary.textContent;
    textCol.appendChild(primary);

    if (w.type === 'devtools') {
        const n = w.devtoolsTabNum != null ? String(w.devtoolsTabNum) : '?';
        const tt = (w.tabTitle && String(w.tabTitle).trim()) ? String(w.tabTitle).trim() : '';
        const sub = document.createElement('span');
        sub.className = 'win-switcher-subtitle';
        sub.textContent = tt ? `Inspected · tab ${n} · ${tt}` : `Inspected · tab ${n}`;
        if (!tt) sub.classList.add('win-switcher-subtitle--dim');
        textCol.appendChild(sub);
    } else {
        const titleText = getSwitcherWindowTitle(w);
        if (kind && titleText.toLowerCase() !== kind.toLowerCase()) {
            const kindEl = document.createElement('span');
            kindEl.className = 'win-switcher-kind';
            kindEl.textContent = kind;
            textCol.appendChild(kindEl);
        }
    }

    const cap = document.createElement('span');
    cap.className = 'win-switcher-keycap';
    cap.textContent = keyLabel;

    bar.appendChild(textCol);
    bar.appendChild(cap);
    row.appendChild(bar);
}

const WIN_SWITCHER_ICONS = {
    'cupnet-main': '',
    devtools: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5L2 8l3.5 3.5"/><path d="M10.5 4.5L14 8l-3.5 3.5"/><path d="M9.5 2.5l-3 11"/></svg>',
    'log-viewer': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h12"/><path d="M2 8h7"/><path d="M2 12h10"/></svg>',
    'cookie-manager': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><circle cx="6" cy="6.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="10" cy="7" r="0.9" fill="currentColor" stroke="none"/><circle cx="7" cy="10.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="10.5" cy="10.5" r="0.7" fill="currentColor" stroke="none"/></svg>',
    'dns-manager': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5a8.2 8.2 0 0 1 0 11"/><path d="M8 2.5a8.2 8.2 0 0 0 0 11"/></svg>',
    'proxy-manager': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5" cy="8" r="2.5"/><circle cx="11" cy="8" r="2.5"/><path d="M7.3 8h1.4"/></svg>',
    rules: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5h12l-4.5 5v4l-3-1.5V8.5L2 3.5z"/></svg>',
    console: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2"/><path d="M8.5 10.5h3"/></svg>',
    'page-analyzer': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3 3"/><path d="M5 7h4"/><path d="M7 5v4"/></svg>',
    notes: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h8a1 1 0 0 1 1 1v10l-2.5-2H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M5 6h6M5 9h4"/></svg>',
    'request-editor': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M2 8h7"/><path d="M2 12h5"/><path d="M11 10l3 2-3 2"/></svg>',
    'compare-viewer': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="5" height="10" rx="1"/><rect x="9" y="3" width="5" height="10" rx="1"/></svg>',
    'ivac-scout': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5" cy="8" r="2.5"/><circle cx="11" cy="8" r="2.5"/><path d="M7.5 8h1"/></svg>',
    'logging-modal': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5v4"/><path d="M8 11v.5"/></svg>',
    unknown: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 5.5h12"/></svg>',
};

function _winSwitcherIconSvg(type) {
    return WIN_SWITCHER_ICONS[type] || WIN_SWITCHER_ICONS.unknown;
}

function _winSwitcherFillIcon(iconWrap, w) {
    iconWrap.innerHTML = '';
    iconWrap.className = 'win-switcher-icon';
    iconWrap.innerHTML = _winSwitcherIconSvg(w.type);
}

function getValidWinSwitcherOffsets(total) {
    if (total <= 12) return [0];
    const out = [];
    let off = 0;
    while (off < total) {
        out.push(off);
        const rem = total - off;
        if (rem <= 12) break;
        off += 11;
    }
    return out;
}

function clampWinSwitcherPageOffset() {
    const total = _winSwitcherCache.length;
    if (total <= 12) {
        _winSwitcherPageOffset = 0;
        return;
    }
    const valid = getValidWinSwitcherOffsets(total);
    if (!valid.includes(_winSwitcherPageOffset)) {
        _winSwitcherPageOffset = valid[valid.length - 1];
    }
}

/**
 * @returns {{ type: 'window', index: number } | { type: 'more', remaining: number } | { type: 'empty' }}
 */
function getSwitcherSlotKind(slotIndex, total, pageOffset) {
    const remaining = total - pageOffset;
    if (remaining <= 0) return { type: 'empty' };

    if (total <= 12 && pageOffset === 0) {
        if (slotIndex < total) return { type: 'window', index: slotIndex };
        return { type: 'empty' };
    }

    if (remaining <= 12) {
        if (slotIndex < remaining) return { type: 'window', index: pageOffset + slotIndex };
        return { type: 'empty' };
    }

    if (slotIndex < 11) return { type: 'window', index: pageOffset + slotIndex };
    if (slotIndex === 11) return { type: 'more', remaining: remaining - 11 };
    return { type: 'empty' };
}

function _winSwitcherAppendPreview(previewWrap, w) {
    if (w.previewDataUrl) {
        const pv = document.createElement('img');
        pv.className = 'win-switcher-preview-img';
        pv.src = w.previewDataUrl;
        pv.alt = '';
        pv.decoding = 'async';
        previewWrap.appendChild(pv);
    } else if (w.type === 'cupnet-main') {
        const fb = document.createElement('div');
        fb.className = 'win-switcher-preview-fallback win-switcher-preview-fallback--main';
        const img = document.createElement('img');
        img.className = 'win-switcher-cupnet-tile-logo';
        img.src = 'img.png';
        img.alt = '';
        img.onerror = () => {
            fb.innerHTML = CUPNET_LOGO_FALLBACK_SVG;
        };
        fb.appendChild(img);
        previewWrap.appendChild(fb);
    } else {
        const fb = document.createElement('div');
        fb.className = 'win-switcher-preview-fallback';
        const iconWrap = document.createElement('span');
        _winSwitcherFillIcon(iconWrap, w);
        fb.appendChild(iconWrap);
        previewWrap.appendChild(fb);
    }
}

/**
 * @param {{ type: 'window', index: number } | { type: 'more', remaining: number } | { type: 'empty' }} slot
 */
function buildSwitcherTile(slot, keyLabel) {
    const row = document.createElement('button');
    row.type = 'button';

    if (slot.type === 'empty') {
        row.className = 'win-switcher-tile win-switcher-tile--empty';
        row.disabled = true;
        row.setAttribute('tabindex', '-1');
        row.setAttribute('aria-hidden', 'true');
        const bar = document.createElement('div');
        bar.className = 'win-switcher-titlebar win-switcher-titlebar--empty-slot';
        const cap = document.createElement('span');
        cap.className = 'win-switcher-keycap';
        cap.textContent = keyLabel;
        bar.appendChild(cap);
        const previewWrap = document.createElement('div');
        previewWrap.className = 'win-switcher-preview-wrap win-switcher-preview-wrap--empty';
        row.appendChild(bar);
        row.appendChild(previewWrap);
        return row;
    }

    if (slot.type === 'more') {
        row.className = 'win-switcher-tile win-switcher-tile--more';
        row.setAttribute('aria-label', `More windows, ${slot.remaining} remaining`);
        const bar = document.createElement('div');
        bar.className = 'win-switcher-titlebar';
        const textCol = document.createElement('div');
        textCol.className = 'win-switcher-titlebar-text';
        const t1 = document.createElement('span');
        t1.className = 'win-switcher-title-primary';
        t1.textContent = 'More…';
        const t2 = document.createElement('span');
        t2.className = 'win-switcher-subtitle';
        t2.textContent = `${slot.remaining} more`;
        textCol.appendChild(t1);
        textCol.appendChild(t2);
        const cap = document.createElement('span');
        cap.className = 'win-switcher-keycap';
        cap.textContent = keyLabel;
        bar.appendChild(textCol);
        bar.appendChild(cap);
        const previewWrap = document.createElement('div');
        previewWrap.className = 'win-switcher-preview-wrap win-switcher-preview-wrap--more';
        const moreInner = document.createElement('span');
        moreInner.className = 'win-switcher-more-label';
        moreInner.textContent = 'More…';
        previewWrap.appendChild(moreInner);
        row.appendChild(bar);
        row.appendChild(previewWrap);
        row.addEventListener('click', () => {
            _winSwitcherPageOffset += 11;
            _winSwitcherKeyboardSlot = 0;
            renderWindowSwitcher();
        });
        return row;
    }

    const w = _winSwitcherCache[slot.index];
    const hasLivePreview = !!(w.previewDataUrl || w.type === 'cupnet-main');
    row.className = 'win-switcher-tile' + (w.type === 'cupnet-main' ? ' win-switcher-tile--main' : '');
    if (!hasLivePreview) row.classList.add('win-switcher-tile--no-preview');
    appendSwitcherTitleBar(row, w, keyLabel);
    const previewWrap = document.createElement('div');
    previewWrap.className = 'win-switcher-preview-wrap';
    _winSwitcherAppendPreview(previewWrap, w);
    row.appendChild(previewWrap);
    row.addEventListener('click', () => {
        api.focusWindowById(w.id).catch(() => {});
        hideWindowSwitcher();
    });
    return row;
}

function renderWindowSwitcher() {
    if (!winSwitcherList) return;
    winSwitcherList.innerHTML = '';
    winSwitcherList.classList.add('win-switcher-keyboard');

    const hintEl = document.getElementById('win-switcher-hint');
    if (hintEl) {
        hintEl.innerHTML = '';
        const line1 = document.createElement('span');
        line1.className = 'win-switcher-hint-line1';
        line1.textContent = WIN_SWITCHER_HINT_LINE1;
        const line2 = document.createElement('span');
        line2.className = 'win-switcher-hint-line2';
        line2.textContent = WIN_SWITCHER_HINT_LINE2;
        hintEl.appendChild(line1);
        hintEl.appendChild(line2);
    }

    clampWinSwitcherPageOffset();
    const total = _winSwitcherCache.length;
    if (total === 0) {
        const empty = document.createElement('div');
        empty.className = 'win-switcher-list-empty';
        empty.textContent = 'No windows';
        winSwitcherList.appendChild(empty);
        winSwitcherList.classList.remove('win-switcher-keyboard');
        return;
    }

    for (let slot = 0; slot < 12; slot++) {
        const kind = getSwitcherSlotKind(slot, total, _winSwitcherPageOffset);
        const label = WIN_SWITCHER_KEY_LABELS[slot];
        const tile = buildSwitcherTile(kind, label);
        if (slot === _winSwitcherKeyboardSlot) tile.classList.add('win-switcher-tile--kbd-focus');
        winSwitcherList.appendChild(tile);
    }
    try {
        const el = winSwitcherList.querySelector('.win-switcher-tile--kbd-focus');
        el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch (e) { /* ignore */ }
}

function hideWindowSwitcher() {
    if (!winSwitcherOverlay) return;
    _winSwitcherPreviewLoadGen++;
    if (_winSwitcherRefreshTimer != null) {
        clearInterval(_winSwitcherRefreshTimer);
        _winSwitcherRefreshTimer = null;
    }
    _winSwitcherPageOffset = 0;
    _winSwitcherKeyboardSlot = 0;
    try { api.setWindowSwitcherOverlayVisible?.(false); } catch (_) { /* ignore */ }
    winSwitcherOverlay.classList.remove('win-switcher-overlay--open');
    winSwitcherOverlay.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onWindowSwitcherKeydown, true);
}

function onWindowSwitcherKeydown(e) {
    if (!winSwitcherOverlay || !winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        if (_winSwitcherPageOffset > 0) {
            _winSwitcherPageOffset = 0;
            renderWindowSwitcher();
            return;
        }
        const main = _winSwitcherCache.find((x) => x.type === 'cupnet-main');
        if (main) api.focusWindowById(main.id).catch(() => {});
        hideWindowSwitcher();
        return;
    }
    const total = _winSwitcherCache.length;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _winSwitcherKeyboardSlot = _winSwitcherMoveGrid(_winSwitcherKeyboardSlot, 'down');
        renderWindowSwitcher();
        return;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        _winSwitcherKeyboardSlot = _winSwitcherMoveGrid(_winSwitcherKeyboardSlot, 'up');
        renderWindowSwitcher();
        return;
    }
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        _winSwitcherKeyboardSlot = _winSwitcherMoveGrid(_winSwitcherKeyboardSlot, 'left');
        renderWindowSwitcher();
        return;
    }
    if (e.key === 'ArrowRight') {
        e.preventDefault();
        _winSwitcherKeyboardSlot = _winSwitcherMoveGrid(_winSwitcherKeyboardSlot, 'right');
        renderWindowSwitcher();
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        if (total === 0) return;
        const kind = getSwitcherSlotKind(_winSwitcherKeyboardSlot, total, _winSwitcherPageOffset);
        if (kind.type === 'empty') return;
        if (kind.type === 'more') {
            _winSwitcherPageOffset += 11;
            _winSwitcherKeyboardSlot = 0;
            renderWindowSwitcher();
            return;
        }
        api.focusWindowById(_winSwitcherCache[kind.index].id).catch(() => {});
        hideWindowSwitcher();
        return;
    }
    const slot = WIN_SWITCHER_CODE_TO_SLOT.get(e.code);
    if (slot === undefined) return;
    if (total === 0) return;
    const kind = getSwitcherSlotKind(slot, total, _winSwitcherPageOffset);
    if (kind.type === 'empty') return;
    if (kind.type === 'more') {
        e.preventDefault();
        _winSwitcherPageOffset += 11;
        _winSwitcherKeyboardSlot = 0;
        renderWindowSwitcher();
        return;
    }
    e.preventDefault();
    api.focusWindowById(_winSwitcherCache[kind.index].id).catch(() => {});
    hideWindowSwitcher();
}

async function showWindowSwitcher() {
    if (!winSwitcherOverlay || !winSwitcherList) return;
    _winSwitcherPageOffset = 0;
    _winSwitcherKeyboardSlot = 0;
    const loadGen = ++_winSwitcherPreviewLoadGen;
    let res = { windows: [] };
    try { res = await api.getOpenWindows({ includePreviews: false }); } catch (_) { /* ignore */ }
    _winSwitcherCache = Array.isArray(res.windows) ? res.windows : [];

    try { await api.setWindowSwitcherOverlayVisible?.(true); } catch (_) { /* ignore */ }

    renderWindowSwitcher();
    winSwitcherOverlay.classList.add('win-switcher-overlay--open');
    _lastWinSwitcherOpenedAt = Date.now();
    winSwitcherOverlay.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', onWindowSwitcherKeydown, true);
    if (_winSwitcherRefreshTimer != null) {
        clearInterval(_winSwitcherRefreshTimer);
        _winSwitcherRefreshTimer = null;
    }
    _winSwitcherRefreshTimer = setInterval(async () => {
        if (!winSwitcherOverlay || !winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) return;
        try {
            const r = await api.getOpenWindows({ includePreviews: true });
            if (Array.isArray(r.windows)) {
                _winSwitcherCache = r.windows;
                renderWindowSwitcher();
            }
        } catch (_) { /* ignore */ }
    }, WIN_SWITCHER_REFRESH_MS);

    (async () => {
        try {
            const full = await api.getOpenWindows({ includePreviews: true });
            if (loadGen !== _winSwitcherPreviewLoadGen) return;
            if (!winSwitcherOverlay || !winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) return;
            if (Array.isArray(full.windows)) {
                _winSwitcherCache = full.windows;
                renderWindowSwitcher();
            }
        } catch (_) { /* ignore */ }
    })();
}

if (winSwitcherOverlay) {
    winSwitcherOverlay.addEventListener('click', (e) => {
        if (e.target === winSwitcherOverlay) hideWindowSwitcher();
    });
}

api.onToggleWindowSwitcher?.(() => {
    if (!winSwitcherOverlay) return;
    if (winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) {
        if (Date.now() - _lastWinSwitcherOpenedAt < WIN_SWITCHER_TOGGLE_CLOSE_GRACE_MS) return;
        hideWindowSwitcher();
    } else {
        showWindowSwitcher();
    }
});

document.getElementById('win-switcher-toolbar-btn')?.addEventListener('click', () => {
    if (!winSwitcherOverlay) return;
    if (winSwitcherOverlay.classList.contains('win-switcher-overlay--open')) {
        hideWindowSwitcher();
    } else {
        showWindowSwitcher();
    }
});

// ─── Omnibox: `>` = commands; otherwise URL + suggestions (top hosts from log) ──
const commandPaletteEl = document.getElementById('command-palette');
const commandPaletteBackdrop = document.getElementById('command-palette-backdrop');
let commandPaletteActiveIdx = 0;
/** @type {Array<{ kind: 'cmd', label: string, category?: string, shortcut?: string, run: function } | { kind: 'url', label: string, sub?: string, url: string }>} */
let omniboxRows = [];
let cachedTopHosts = [];
let _topHostsFetchedAt = 0;
const TOP_HOSTS_TTL_MS = 60000;

const OMNIBOX_QUICK_LINKS = [
    { label: 'CupNet start page', keywords: 'home new tab dashboard', url: 'cupnet://newtab' },
    { label: 'Settings', keywords: 'preferences options', url: 'cupnet://settings' },
    { label: 'User guide', keywords: 'help documentation manual', url: 'cupnet://guide' },
];

function isCommandMode() {
    return String(urlInput?.value || '').trimStart().startsWith('>');
}

function getCommandFilterQuery() {
    const v = String(urlInput?.value || '');
    const i = v.indexOf('>');
    if (i < 0) return '';
    return v.slice(i + 1).trim();
}

function _cupnetFuzzyMatch(query, text) {
    const q = String(query || '').toLowerCase().trim();
    const t = String(text || '').toLowerCase();
    if (!q) return true;
    if (t.includes(q)) return true;
    let qi = 0;
    for (let i = 0; i < t.length && qi < q.length; i++) {
        if (t[i] === q[qi]) qi++;
    }
    return qi === q.length;
}

function getCommandPaletteCommands() {
    const active = tabs.find((x) => x.isActive);
    const activeTabId = active?.id;
    /** Curated list (not auto-generated from preload). `keywords` improves search. */
    return [
        { label: 'Back', category: 'Navigation', keywords: 'history previous', shortcut: '', run: () => api.navBack?.() },
        { label: 'Forward', category: 'Navigation', keywords: 'history next', shortcut: '', run: () => api.navForward?.() },
        { label: 'Reload page', category: 'Navigation', keywords: 'refresh', shortcut: '', run: () => api.navReload?.() },
        { label: 'Home', category: 'Navigation', keywords: 'start', shortcut: '', run: () => api.navHome?.() },
        { label: 'New tab', category: 'Navigation', keywords: '', shortcut: 'Ctrl+T', run: () => api.newTab() },
        { label: 'New isolated tab', category: 'Navigation', keywords: 'session isolate incognito', shortcut: '', run: () => api.newIsolatedTab?.() },
        { label: 'Close active tab', category: 'Navigation', keywords: '', shortcut: '', run: () => {
            if (activeTabId != null) void api.closeTab?.(activeTabId);
        } },
        { label: 'Focus address bar', category: 'Navigation', keywords: 'url omnibox location', shortcut: 'Ctrl+L', run: () => { urlInput.focus(); urlInput.select(); } },
        { label: 'Open Settings', category: 'Navigation', keywords: 'preferences options', shortcut: 'Ctrl+,', run: () => api.openSettingsTab?.() },
        { label: 'Open CupNet Guide', category: 'Navigation', keywords: 'help documentation manual', shortcut: '', run: () => api.navigateTo?.('cupnet://guide') },
        { label: 'Open start page', category: 'Navigation', keywords: 'new tab dashboard', shortcut: '', run: () => api.navigateTo?.('cupnet://newtab') },

        { label: 'Take screenshot', category: 'Page', keywords: 'capture screen shot', shortcut: '', run: () => { void api.takeScreenshot?.('click').catch(() => {}); } },
        { label: 'Import session bundle', category: 'Tools', keywords: 'har zip restore', shortcut: '', run: () => { void api.importBundle?.().catch(() => {}); } },
        { label: 'Open Network Activity', category: 'Tools', keywords: 'log viewer database requests', shortcut: '', run: () => api.openLogViewer() },
        { label: 'Open Proxy Manager', category: 'Tools', keywords: 'profile tls fingerprint chain', shortcut: '', run: () => api.openProxyManager() },
        { label: 'Disconnect proxy', category: 'Proxy', keywords: 'offline mitm', shortcut: '', run: () => { void api.disconnectProxy?.().catch(() => {}); } },
        { label: 'Connect direct (no upstream proxy)', category: 'Proxy', keywords: 'direct tls local', shortcut: '', run: () => { void api.connectDirect?.().catch(() => {}); } },
        { label: 'Open Rules & Interceptor', category: 'Tools', keywords: 'highlight mock block', shortcut: '', run: () => api.openRulesWindow() },
        { label: 'Open Cookie Manager', category: 'Tools', keywords: 'storage jar', shortcut: '', run: () => api.openCookieManager(activeTabId) },
        { label: 'Open DNS Manager', category: 'Tools', keywords: 'hosts override', shortcut: '', run: () => api.openDnsManager() },
        { label: 'Open Request Editor', category: 'Tools', keywords: 'replay http', shortcut: '', run: () => api.openRequestEditor() },
        { label: 'Open Request Editor (new window)', category: 'Tools', keywords: 'replay separate', shortcut: '', run: () => { void api.openRequestEditorNewWindow?.().catch(() => {}); } },
        { label: 'Open System Console', category: 'Tools', keywords: 'stdout stderr debug', shortcut: '', run: () => api.openConsoleViewer() },
        { label: 'Open Page Analyzer', category: 'Tools', keywords: 'forms captcha meta', shortcut: '', run: () => api.openPageAnalyzer() },
        { label: 'Open Notes', category: 'Tools', keywords: 'scratchpad quill', shortcut: '', run: () => api.openNotesWindow() },
        { label: 'Open Credentials vault', category: 'Tools', keywords: 'passwords secrets vault', shortcut: 'Ctrl+Alt+L', run: () => api.openCredentialsWindow() },
        { label: 'Autofill credentials (active tab)', category: 'Tools', keywords: 'fill login password', shortcut: '', run: () => { void api.credentialsFillActiveTab?.({}).catch(() => {}); } },
        { label: 'Open Compare viewer', category: 'Tools', keywords: 'diff two requests', shortcut: '', run: () => api.openCompareViewer() },
        { label: 'Open DevTools (active tab)', category: 'Tools', keywords: 'inspector chromium', shortcut: '', run: () => api.openDevTools() },
        { label: 'Open API Scout', category: 'Tools', keywords: 'ivac har dump', shortcut: '', run: () => api.openIvacScout() },
        { label: 'Toggle session recording', category: 'Logging', keywords: 'logging pause resume', shortcut: '', run: () => logToggleBtn?.click() },
        { label: 'Show my public IP', category: 'Proxy', keywords: 'wan address geoip', shortcut: '', run: async () => {
            try {
                const ip = await api.getDirectIp?.();
                if (typeof showToast === 'function' && ip) showToast(String(ip), { type: 'info' });
            } catch (_) { /* ignore */ }
        } },
        { label: 'Check IP / Geo (active tab)', category: 'Proxy', keywords: 'egress proxy ip', shortcut: '', run: () => {
            if (activeTabId != null && api.checkIpGeo) void api.checkIpGeo(activeTabId);
        } },
        { label: 'Reset first-run welcome wizard', category: 'App', keywords: 'onboarding tutorial', shortcut: '', run: () => { void api.resetOnboardingWizard?.().catch(() => {}); } },

        { label: 'Window switcher', category: 'Windows', keywords: 'alt-tab overview', shortcut: 'Ctrl+`', run: () => showWindowSwitcher() },
    ];
}

async function refreshTopHostsIfStale() {
    if (Date.now() - _topHostsFetchedAt < TOP_HOSTS_TTL_MS && cachedTopHosts.length) return;
    try {
        const rows = await api.getOmniboxTopHosts?.(16);
        cachedTopHosts = Array.isArray(rows) ? rows : [];
    } catch {
        cachedTopHosts = [];
    }
    _topHostsFetchedAt = Date.now();
}

function getOmniboxHintText() {
    if (isCommandMode()) {
        return '↑↓ select · Enter run command · Shift+Enter open rest as URL · Esc';
    }
    return '↑↓ select · Enter open · Shift+Enter search · Type > for commands · Esc';
}

function buildOmniboxOverlayPayload() {
    const addr = addressBarContainer;
    const r = addr ? addr.getBoundingClientRect() : { left: 12, width: 400, bottom: 95 };
    const left = Math.max(0, Math.round(r.left));
    const width = Math.max(120, Math.round(r.width));
    /** Align dropdown under the address field; overlay view starts at tab top (see tab-manager TOOLBAR_HEIGHT + cred reserve). */
    const tabSurfaceTop = 95 + getCredSaveBarReservePx();
    const topGap = Math.max(4, Math.round(r.bottom) - tabSurfaceTop + 4);
    const hint = getOmniboxHintText();
    if (!omniboxRows.length) {
        return {
            left,
            width,
            topGap,
            hint,
            emptyText: isCommandMode()
                ? 'No commands match'
                : 'No suggestions — browse to build history',
            items: [],
        };
    }
    const items = omniboxRows.map((row, i) => ({
        label: row.label,
        sub: row.kind === 'cmd' ? (row.category || '') : (row.sub || ''),
        shortcut: row.shortcut || '',
        active: i === commandPaletteActiveIdx,
    }));
    return { left, width, topGap, hint, items };
}

function renderOmniboxList() {
    if (!commandPaletteEl) return;
    if (isCommandMode()) {
        const q = getCommandFilterQuery();
        const all = getCommandPaletteCommands();
        const cmds = all.filter((c) => _cupnetFuzzyMatch(q, `${c.label} ${c.category} ${c.keywords || ''}`));
        omniboxRows = cmds.map((c) => ({
            kind: 'cmd',
            label: c.label,
            category: c.category,
            shortcut: c.shortcut,
            run: c.run,
        }));
        commandPaletteActiveIdx = Math.min(commandPaletteActiveIdx, Math.max(0, omniboxRows.length - 1));
    } else {
        const q = (urlInput?.value || '').trim().toLowerCase();
        const quick = OMNIBOX_QUICK_LINKS.filter((x) => _cupnetFuzzyMatch(q, `${x.label} ${x.keywords}`))
            .map((x) => ({ kind: 'url', label: x.label, sub: 'Quick link', url: x.url }));
        const hosts = cachedTopHosts
            .filter((h) => !q || _cupnetFuzzyMatch(q, h.host))
            .map((h) => ({
                kind: 'url',
                label: h.host,
                sub: `${h.count} in log`,
                url: `https://${h.host}`,
            }));
        omniboxRows = [...quick, ...hosts].slice(0, 24);
        commandPaletteActiveIdx = Math.min(commandPaletteActiveIdx, Math.max(0, omniboxRows.length - 1));
    }
    void api.updateOmniboxOverlay?.(buildOmniboxOverlayPayload());
}

function runOmniboxIndex(idx) {
    const row = omniboxRows[idx];
    if (!row) return;
    hideCommandPalette();
    try {
        if (row.kind === 'cmd') row.run();
        else if (row.kind === 'url') api.navigateTo(row.url);
    } catch (e) {
        console.error('[Omnibox]', e);
        if (typeof showToast === 'function') showToast(String(e?.message || e), { type: 'error' });
    }
}

async function showOmniboxOverlayShell() {
    if (!commandPaletteEl || !urlInput) return;
    commandPaletteEl.classList.remove('hidden');
    commandPaletteEl.setAttribute('aria-hidden', 'false');
    urlOmniboxDropdown?.classList.add('hidden');
    urlOmniboxDropdown?.setAttribute('aria-hidden', 'true');
    addressBarContainer?.classList.add('omnibox-open');
    urlInput.placeholder = URL_INPUT_PLACEHOLDER_OMNIBOX;
    urlInput.setAttribute('aria-expanded', 'true');
    try {
        await api.showOmniboxOverlay?.();
    } catch (_) { /* ignore */ }
}

/** Focus address bar + `>` + command list (Cmd/Ctrl+K). */
async function openCommandOmniboxHotkey() {
    if (!commandPaletteEl || !urlInput) return;
    if (isOmniboxDropdownVisible() && isCommandMode() && String(urlInput.value || '').trim() === '>') {
        hideCommandPalette();
        return;
    }
    await showOmniboxOverlayShell();
    urlInput.value = '>';
    commandPaletteActiveIdx = 0;
    renderOmniboxList();
    setTimeout(() => {
        urlInput.focus();
        urlInput.setSelectionRange(1, 1);
    }, 0);
}

/** Suggestions for normal URL mode (focus / Ctrl+L). */
async function openNavOmniboxOnFocus() {
    if (!commandPaletteEl || !urlInput || isCommandMode()) return;
    await showOmniboxOverlayShell();
    commandPaletteActiveIdx = 0;
    renderOmniboxList();
    void refreshTopHostsIfStale().then(() => {
        if (!isOmniboxDropdownVisible() || isCommandMode()) return;
        renderOmniboxList();
    });
}

async function onUrlInputOmnibox() {
    if (isCommandMode()) {
        if (!isOmniboxDropdownVisible()) await showOmniboxOverlayShell();
        commandPaletteActiveIdx = 0;
        renderOmniboxList();
        return;
    }
    if (isOmniboxDropdownVisible()) {
        commandPaletteActiveIdx = 0;
        renderOmniboxList();
    }
}

function hideCommandPalette() {
    if (!commandPaletteEl) return;
    try {
        void api.hideOmniboxOverlay?.();
    } catch (_) { /* ignore */ }
    commandPaletteEl.classList.add('hidden');
    commandPaletteEl.setAttribute('aria-hidden', 'true');
    urlOmniboxDropdown?.classList.add('hidden');
    urlOmniboxDropdown?.setAttribute('aria-hidden', 'true');
    addressBarContainer?.classList.remove('omnibox-open');
    if (urlInput) {
        urlInput.placeholder = URL_INPUT_PLACEHOLDER_DEFAULT;
        urlInput.setAttribute('aria-expanded', 'false');
        const active = tabs.find((t) => t.isActive);
        if (active) urlInput.value = _normalizeToolbarUrl(active.url || '');
    }
    omniboxRows = [];
    void applyChromeToolbarReserve();
}

_focusUrlBarOmniboxExtra = () => {
    void openNavOmniboxOnFocus();
};

urlInput.addEventListener('input', () => {
    void onUrlInputOmnibox();
});

urlInput.addEventListener('focus', () => {
    void (async () => {
        if (isCommandMode()) {
            if (!isOmniboxDropdownVisible()) await showOmniboxOverlayShell();
            renderOmniboxList();
            return;
        }
        await openNavOmniboxOnFocus();
    })();
});

api.onToggleCommandPalette?.(() => {
    void openCommandOmniboxHotkey();
});

api.onOmniboxOverlaySelect?.((idx) => {
    const i = Number(idx);
    if (Number.isFinite(i)) runOmniboxIndex(i);
});
api.onOmniboxOverlayDismiss?.(() => {
    hideCommandPalette();
});
api.onForceCloseOmnibox?.(() => {
    if (!commandPaletteEl || commandPaletteEl.classList.contains('hidden')) return;
    hideCommandPalette();
});

/** Capture phase: arrows / Enter when omnibox is open (list is under address bar). */
function onCommandPaletteGlobalKeydown(e) {
    if (!commandPaletteEl || commandPaletteEl.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (omniboxRows.length) {
            commandPaletteActiveIdx = Math.min(omniboxRows.length - 1, commandPaletteActiveIdx + 1);
            renderOmniboxList();
        }
        return;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        commandPaletteActiveIdx = Math.max(0, commandPaletteActiveIdx - 1);
        renderOmniboxList();
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const raw = (urlInput?.value || '').trim();
        if (isCommandMode()) {
            if (e.shiftKey) {
                const rest = raw.replace(/^>\s*/, '').trim();
                if (rest) api.navigateTo(rest);
                hideCommandPalette();
                return;
            }
            if (omniboxRows.length) runOmniboxIndex(commandPaletteActiveIdx);
            return;
        }
        if (e.shiftKey) {
            if (raw) api.navigateTo(raw);
            hideCommandPalette();
            return;
        }
        if (omniboxRows.length) {
            runOmniboxIndex(commandPaletteActiveIdx);
            return;
        }
        if (raw) api.navigateTo(raw);
        hideCommandPalette();
    }
}
document.addEventListener('keydown', onCommandPaletteGlobalKeydown, true);

commandPaletteBackdrop?.addEventListener('click', hideCommandPalette);

let _omniboxResizeTimer = null;
window.addEventListener('resize', () => {
    if (!isOmniboxDropdownVisible()) return;
    clearTimeout(_omniboxResizeTimer);
    _omniboxResizeTimer = setTimeout(() => {
        void api.updateOmniboxOverlay?.(buildOmniboxOverlayPayload());
    }, 80);
});

document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === ',') {
        e.preventDefault();
        api.openSettingsTab?.();
        return;
    }
    if (e.key === 'Escape' && commandPaletteEl && !commandPaletteEl.classList.contains('hidden')) {
        e.preventDefault();
        hideCommandPalette();
    }
}, true);
