'use strict';

const api = window.electronAPI;

// ─── State ────────────────────────────────────────────────────────────────────
let allEntries        = [];
let filteredEntries   = [];
let selectedIndex     = -1;
/** Multi-select: DB request ids (Shift / Ctrl+click / Ctrl+A). */
const selectedRequestIds = new Set();
let selectionAnchorIdx  = -1;
let autoScrollEnabled = true;
let currentSessionId  = null;
let knownTabs         = new Set();

// Session filter state — replaces unreliable <select> value approach
// null = live/current, 'all' = all sessions, number = specific session ID
let sessionFilterMode = null;

// Remember which detail tab the user last chose
let lastActiveTab = 'headers';

/** Incremented when Raw+WS async payload loads — ignore stale responses */
let _rawWsGen = 0;

// Virtual scroll
const ROW_HEIGHT = 28;
const BUFFER     = 24;
let renderStart  = 0;
let renderEnd    = 0;

// Live-mode entry cap — prevents unbounded memory growth in long sessions
const MAX_LIVE_ENTRIES = 10000;

// Batch-flush state — groups rapid-fire IPC entries into one render tick
let _batchQueue  = [];
let _batchTimer  = null;
const BATCH_MS   = 80; // flush at most every 80 ms

// rAF token for scroll throttle
let _scrollRaf   = null;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const lvScroll       = document.getElementById('lv-scroll');
const lvRows         = document.getElementById('lv-rows');
const spacerTop      = document.getElementById('lv-spacer-top');
const spacerBottom   = document.getElementById('lv-spacer-bottom');
const detailEmpty    = document.getElementById('lv-detail-empty');
const detailPanel    = document.getElementById('lv-detail');
const searchInput    = document.getElementById('search-input');
const ftsCheckbox    = document.getElementById('fts-checkbox');
const scOnlyCheckbox     = document.getElementById('sc-only-checkbox');
const hideOptionsCheckbox = document.getElementById('hide-options-checkbox');
const hideScreenshotCheckbox = document.getElementById('hide-screenshot-checkbox');
const clearSearchBtn = document.getElementById('clear-search');
const filterSession  = document.getElementById('filter-session');
// Multi-select state (empty Set = "all")
const selectedTypes    = new Set();
const selectedStatuses = new Set();
const selectedTabs     = new Set();
/** Activity Monitor categories: console, exception, storage, csp (all on by default so rows are visible) */
const selectedActivityTypes = new Set(['console', 'exception', 'storage', 'csp']);
const lvCount        = document.getElementById('lv-count');
const lvSessionFromSelBtn = document.getElementById('lv-session-from-sel-btn');
const autoScrollBtn  = document.getElementById('auto-scroll-btn');
const exportHarBtn   = document.getElementById('export-har-btn');
const exportBundleBtn = document.getElementById('export-bundle-btn');
const exportSiteZipBtn = document.getElementById('export-site-zip-btn');
const importBundleBtn = document.getElementById('import-bundle-btn');
const openRulesBtn   = document.getElementById('open-rules-btn');
const clearLogsBtn   = document.getElementById('clear-logs');
const replayBar      = document.getElementById('lv-replay-bar');
const replayBtn      = document.getElementById('lv-replay-btn');
const addToCompareBtn = document.getElementById('lv-add-to-compare');
const openCompareBtn = document.getElementById('lv-open-compare');
const rawBtn         = document.getElementById('lv-raw-btn');
const copyUrlBtn     = document.getElementById('lv-copy-url');
const lvDetailIdStrip = document.getElementById('lv-detail-id-strip');
const dRequestIdEl   = document.getElementById('d-request-id');
const dRequestMethodEl = document.getElementById('d-request-method');
const detailUrlBtn   = document.getElementById('lv-detail-url-btn');
const copyUrlHeaderBtn = document.getElementById('lv-copy-url-header');
const urlPartsPopover = document.getElementById('lv-url-parts-popover');
const replayDiff     = document.getElementById('lv-replay-diff');
const replayResult   = document.getElementById('lv-replay-result');
const replayBody     = document.getElementById('replay-body');
const replayStatus   = document.getElementById('replay-status-badge');
const toolbarActions = document.getElementById('lv-toolbar-actions');
const sepActionsMark = document.getElementById('lv-sep-actions-mark');
const markSection    = document.getElementById('lv-mark-section');
const tagColorsWrap  = document.getElementById('lv-tag-colors');
const tagClearBtn    = document.getElementById('lv-tag-clear');
const notePreview    = document.getElementById('lv-note-preview');
const noteOpenBtn    = document.getElementById('lv-note-open');
const commentTextarea = document.getElementById('comment-textarea');
const commentSaveBtn = document.getElementById('comment-save-btn');
const markStatus     = document.getElementById('lv-mark-status');
const tabBtns        = document.querySelectorAll('.lv-tab-btn');
const tabContents    = document.querySelectorAll('.lv-tab-content');
const detailFindBar  = document.getElementById('lv-detail-find');
const detailFindInput = document.getElementById('lv-detail-find-input');
const detailFindCount = document.getElementById('lv-detail-find-count');
const detailFindPrev = document.getElementById('lv-detail-find-prev');
const detailFindNext = document.getElementById('lv-detail-find-next');
const detailFindClear = document.getElementById('lv-detail-find-clear');
const protectionModal = document.getElementById('protection-modal');
const protectionConfirmBtn = document.getElementById('protection-confirm-btn');
const protectionCancelBtn = document.getElementById('protection-cancel-btn');
const sessionFromSelModal = document.getElementById('session-from-sel-modal');
const sessionFromSelInput = document.getElementById('session-from-sel-input');
const sessionFromSelOkBtn = document.getElementById('session-from-sel-ok-btn');
const sessionFromSelCancelBtn = document.getElementById('session-from-sel-cancel-btn');
const sessionFromSelErr = document.getElementById('session-from-sel-err');
const siteExportModal = document.getElementById('site-export-modal');
const siteExportPatternRows = document.getElementById('site-export-pattern-rows');
const siteExportAddPatternBtn = document.getElementById('site-export-add-pattern');
const siteExportHostList = document.getElementById('site-export-host-list');
const siteExportConfirmBtn = document.getElementById('site-export-confirm-btn');
const siteExportCancelBtn = document.getElementById('site-export-cancel-btn');
const siteExportPathList = document.getElementById('site-export-path-list');
const MAX_SITE_EXPORT_PATTERN_FIELDS = 10;
/** @type {string[]} */
let _siteExportSessionOrigins = [];
/** @type {string[]} */
let _siteExportPaths = [];
/** @type {number|null} */
let _siteExportSessionId = null;
/** @type {((e: KeyboardEvent) => void)|null} */
let _siteExportEscHandler = null;
const compareSideModal = document.getElementById('compare-side-modal');
const compareSidePicker = document.getElementById('compare-side-picker');
const compareSideCancelBtn = document.getElementById('compare-side-cancel-btn');
const recBtn         = document.getElementById('lv-rec-btn');
const TAG_COLORS     = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#f472b6'];
const LV_ACT_LABELS = {
    editor: '✏ Editor',
    url: '⧉ URL',
    compareAdd: '+ Compare',
    compareOpen: '⇄ Open',
    mock: '⚡ Mock',
};
const NOTE_AUTOSAVE_MS = 500;
let _noteAutosaveTimer = null;

// ─── Recording toggle (synced with browser toolbar) ───────────────────────────
let _lvIsRecording = false;

function updateRecBtn(on) {
    _lvIsRecording = on;
    if (!recBtn) return;
    recBtn.classList.toggle('recording', on);
    recBtn.classList.toggle('stopped', !on);
    recBtn.textContent = on ? '⏺ Rec' : '⏹ Stopped';
    recBtn.title = on ? 'Recording — click to stop' : 'Stopped — click to start recording';
}

api.onUpdateLogStatus?.((data) => {
    updateRecBtn(!!(data && data.enabled));
});

recBtn?.addEventListener('click', async () => {
    if (_lvIsRecording) {
        await api.toggleLoggingStop().catch(console.error);
    } else {
        const r = recBtn.getBoundingClientRect();
        await api.toggleLoggingStart({ x: r.left, y: r.top, w: r.width, h: r.height }).catch(console.error);
    }
});

function browserEventCategory(e) {
    const et = String(e.event_type || '');
    if (et === 'exception') return 'exception';
    if (et === 'csp-violation') return 'csp';
    if (et.startsWith('ls-') || et.startsWith('ss-')) return 'storage';
    return 'console';
}

/** Method column: STG (storage), LOG (console / log-entry), etc. */
function browserActivityMethodBadge(et) {
    const e = String(et || '');
    if (e.startsWith('ls-') || e.startsWith('ss-')) return { text: 'STG', cls: 'be-method-stg' };
    if (e === 'console') return { text: 'LOG', cls: 'be-method-log' };
    if (e === 'exception') return { text: 'EXC', cls: 'be-method-exc' };
    if (e === 'csp-violation') return { text: 'CSP', cls: 'be-method-csp' };
    if (e === 'log-entry') return { text: 'LOG', cls: 'be-method-log' };
    return { text: 'LOG', cls: 'be-method-log' };
}

/** Status column: LOC / SES for storage; console levels abbreviated. */
function browserActivityStatusLabel(et, lev) {
    const e = String(et || '');
    const l = String(lev || '').toLowerCase();
    if (e.startsWith('ls-')) return { text: 'LOC', cls: 'be-status-loc' };
    if (e.startsWith('ss-')) return { text: 'SES', cls: 'be-status-ses' };
    if (e === 'exception') return { text: 'ERR', cls: 's-err' };
    if (e === 'csp-violation') return { text: 'CSP', cls: 'be-status-csp' };
    if (e === 'console' || e === 'log-entry') {
        if (l === 'error') return { text: 'ERR', cls: 's-err' };
        if (l === 'warning' || l === 'warn') return { text: 'WRN', cls: 'be-status-wrn' };
        if (l === 'info') return { text: 'INF', cls: 'be-status-inf' };
        if (l === 'debug') return { text: 'DBG', cls: 'be-status-dbg' };
        if (l === 'trace') return { text: 'TRC', cls: 'be-status-trc' };
        if (l === 'log') return { text: 'LOG', cls: 'be-status-log' };
        return { text: 'LOG', cls: 'be-status-log' };
    }
    return { text: '—', cls: 's-nil' };
}

/** Row background classes for console (pastel by level). */
function browserConsoleLevelRowClass(et, lev) {
    const e = String(et || '');
    const l = String(lev || '').toLowerCase();
    if (e !== 'console' && e !== 'log-entry') return '';
    if (l === 'error') return 'lv-row-be-lvl-error';
    if (l === 'warning' || l === 'warn') return 'lv-row-be-lvl-warn';
    if (l === 'info') return 'lv-row-be-lvl-info';
    if (l === 'debug') return 'lv-row-be-lvl-debug';
    if (l === 'trace') return 'lv-row-be-lvl-trace';
    if (l === 'log') return 'lv-row-be-lvl-log';
    return 'lv-row-be-lvl-log';
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function formatTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString('en-GB', { hour12: false }); } catch { return iso; }
}
function formatDur(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}
function statusCls(s) {
    if (!s) return 's-nil';
    if (s < 300) return 's-2xx';
    if (s < 400) return 's-3xx';
    if (s < 500) return 's-4xx';
    return 's-5xx';
}
function methodCls(m) {
    const map = {
        GET:'m-get', POST:'m-post', PUT:'m-put', PATCH:'m-patch', DELETE:'m-delete', HEAD:'m-head', OPTIONS:'m-options',
        SYS:'m-sys',
    };
    return map[(m||'').toUpperCase()] || 'm-other';
}
function durCls(ms) {
    if (ms == null) return '';
    if (ms < 200) return 'fast';
    if (ms > 2000) return 'slow';
    return '';
}
function truncUrl(url) {
    try {
        const u = new URL(url);
        let p = u.pathname;
        if (u.search) p += u.search.slice(0, 40) + (u.search.length > 40 ? '…' : '');
        return p || '/';
    } catch { return url.length > 80 ? url.slice(0, 80) + '…' : url; }
}
function extractHost(url) {
    try { return new URL(url).host || '—'; } catch { return '—'; }
}

let _urlPartsOutsideHandler = null;

function closeUrlPartsPopover() {
    if (urlPartsPopover) urlPartsPopover.hidden = true;
    if (_urlPartsOutsideHandler) {
        document.removeEventListener('mousedown', _urlPartsOutsideHandler, true);
        _urlPartsOutsideHandler = null;
    }
}

function parseUrlParts(url) {
    try {
        const u = new URL(url);
        return {
            valid: true,
            host: u.host,
            path: u.pathname || '/',
            search: u.search,
            queryPairs: [...u.searchParams.entries()].map(([key, value]) => ({ key, value })),
        };
    } catch {
        return { valid: false, raw: url, queryPairs: [] };
    }
}

function positionUrlPartsPopover(anchorEl) {
    if (!urlPartsPopover || !anchorEl) return;
    urlPartsPopover.hidden = false;
    const r = anchorEl.getBoundingClientRect();
    const margin = 8;
    let left = r.left;
    const width = urlPartsPopover.offsetWidth || 400;
    if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - width - margin);
    }
    let top = r.bottom + 6;
    const height = urlPartsPopover.offsetHeight || 200;
    if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, r.top - height - 6);
    }
    urlPartsPopover.style.left = `${Math.round(left)}px`;
    urlPartsPopover.style.top = `${Math.round(top)}px`;
}

function appendUrlPartCopyBtn(parent, text, title = 'Copy') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lv-field-copy body-act-btn';
    btn.title = title;
    btn.textContent = '⎘';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(String(text ?? '')).then(
            () => flashBtn(btn, '✓'),
            () => flashBtn(btn, '✗'),
        );
    });
    parent.appendChild(btn);
    return btn;
}

function openUrlPartsPopover(url, anchorEl) {
    if (!urlPartsPopover || !anchorEl || !url) return;
    closeUrlPartsPopover();
    const parts = parseUrlParts(url);

    urlPartsPopover.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'lv-url-parts-head';
    head.innerHTML = '<span>URL breakdown</span>';
    appendUrlPartCopyBtn(head, url, 'Copy full URL');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'body-act-btn';
    closeBtn.id = 'lv-url-parts-close';
    closeBtn.textContent = '✕';
    head.appendChild(closeBtn);
    urlPartsPopover.appendChild(head);

    const body = document.createElement('div');
    body.className = 'lv-url-parts-body';

    if (!parts.valid) {
        const row = document.createElement('div');
        row.className = 'lv-url-parts-row';
        row.innerHTML = '<span class="lv-url-parts-label">URL</span>';
        const rowHead = document.createElement('div');
        rowHead.className = 'lv-url-parts-row-head';
        const pre = document.createElement('pre');
        pre.className = 'lv-url-parts-val';
        pre.textContent = url;
        rowHead.appendChild(pre);
        appendUrlPartCopyBtn(rowHead, url, 'Copy URL');
        row.appendChild(rowHead);
        body.appendChild(row);
    } else {
        for (const [label, val] of [['Host', parts.host], ['Path', parts.path]]) {
            const row = document.createElement('div');
            row.className = 'lv-url-parts-row';
            const lbl = document.createElement('span');
            lbl.className = 'lv-url-parts-label';
            lbl.textContent = label;
            row.appendChild(lbl);
            const rowHead = document.createElement('div');
            rowHead.className = 'lv-url-parts-row-head';
            const span = document.createElement('span');
            span.className = 'lv-url-parts-val';
            span.textContent = val;
            rowHead.appendChild(span);
            appendUrlPartCopyBtn(rowHead, val, `Copy ${label.toLowerCase()}`);
            row.appendChild(rowHead);
            body.appendChild(row);
        }
        if (parts.queryPairs.length) {
            const sec = document.createElement('div');
            sec.className = 'lv-url-parts-section';
            sec.textContent = `Query parameters (${parts.queryPairs.length})`;
            body.appendChild(sec);
            const qWrap = document.createElement('div');
            qWrap.className = 'lv-url-parts-query';
            for (const { key, value } of parts.queryPairs) {
                const qRow = document.createElement('div');
                qRow.className = 'lv-url-parts-query-row';
                const qHead = document.createElement('div');
                qHead.className = 'lv-url-parts-query-head';
                const qKey = document.createElement('span');
                qKey.className = 'lv-url-parts-q-key';
                qKey.textContent = key;
                qHead.appendChild(qKey);
                appendUrlPartCopyBtn(qHead, value, 'Copy value');
                qRow.appendChild(qHead);
                const qVal = document.createElement('span');
                qVal.className = 'lv-url-parts-q-val';
                qVal.textContent = value;
                qRow.appendChild(qVal);
                qWrap.appendChild(qRow);
            }
            body.appendChild(qWrap);
        } else if (parts.search) {
            const row = document.createElement('div');
            row.className = 'lv-url-parts-row';
            row.innerHTML = '<span class="lv-url-parts-label">Query</span>';
            const rowHead = document.createElement('div');
            rowHead.className = 'lv-url-parts-row-head';
            const span = document.createElement('span');
            span.className = 'lv-url-parts-val';
            span.textContent = parts.search;
            rowHead.appendChild(span);
            appendUrlPartCopyBtn(rowHead, parts.search.slice(1), 'Copy query string');
            row.appendChild(rowHead);
            body.appendChild(row);
        }
    }
    urlPartsPopover.appendChild(body);

    positionUrlPartsPopover(anchorEl);
    closeBtn.addEventListener('click', closeUrlPartsPopover);
    _urlPartsOutsideHandler = (e) => {
        if (urlPartsPopover.contains(e.target) || anchorEl.contains(e.target)) return;
        closeUrlPartsPopover();
    };
    setTimeout(() => document.addEventListener('mousedown', _urlPartsOutsideHandler, true), 0);
}

function renderDetailRequestLine(entry, opts = {}) {
    const idForDisplay = entry?.id != null && entry?.id !== '' ? String(entry.id) : '';
    const cupnetSessMeta = getCupnetSessionTrafficPresentation(entry);
    let method = opts.method ?? cupnetSessMeta?.method ?? entry?.method ?? '';
    if (!method && entry?._browserEvent) {
        method = browserActivityMethodBadge(entry.event_type).text;
    }
    const url = opts.url ?? entry?.url ?? '';

    if (dRequestIdEl) {
        dRequestIdEl.textContent = opts.idText ?? (idForDisplay ? `[${idForDisplay}]` : '[—]');
        dRequestIdEl.title = idForDisplay ? `Entry id ${idForDisplay}` : '';
    }
    if (dRequestMethodEl) {
        const m = String(method || '').toUpperCase();
        if (m && m !== '—') {
            dRequestMethodEl.textContent = m;
            dRequestMethodEl.className = `method-badge ${methodCls(m)}`;
            dRequestMethodEl.style.display = '';
        } else {
            dRequestMethodEl.style.display = 'none';
        }
    }
    const urlEl = document.getElementById('lv-detail-url');
    if (urlEl) urlEl.textContent = url || '(no url)';
    if (detailUrlBtn) {
        detailUrlBtn.disabled = !url;
        detailUrlBtn.title = url ? 'Click to show host, path and query parameters' : '';
    }
    if (copyUrlHeaderBtn) {
        copyUrlHeaderBtn.style.display = url ? '' : 'none';
        copyUrlHeaderBtn.onclick = () => {
            navigator.clipboard.writeText(url).then(
                () => flashBtn(copyUrlHeaderBtn, '✓'),
                () => flashBtn(copyUrlHeaderBtn, '✗'),
            );
        };
    }
    closeUrlPartsPopover();
}

function wireDetailUrlPopover() {
    detailUrlBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const entry = _currentDetailEntry;
        const url = entry?.url || '';
        if (!url) return;
        if (urlPartsPopover && !urlPartsPopover.hidden) {
            closeUrlPartsPopover();
            return;
        }
        openUrlPartsPopover(url, detailUrlBtn);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeUrlPartsPopover();
    });
}

wireDetailUrlPopover();

const CUPNET_SESSION_PROXY_URL = 'cupnet://session/proxy';
const CUPNET_SESSION_DIRECT_URL = 'cupnet://session/direct';

/** Системные строки снимка прокси/direct в логе (не HTTP). */
function getCupnetSessionTrafficPresentation(entry) {
    if (String(entry?.type || '').toLowerCase() !== 'cupnet') return null;
    const u = String(entry?.url || '');
    if (u !== CUPNET_SESSION_PROXY_URL && u !== CUPNET_SESSION_DIRECT_URL) return null;
    const host = u === CUPNET_SESSION_PROXY_URL ? 'New proxy' : 'Direct';
    const hostTitle = u === CUPNET_SESSION_PROXY_URL
        ? 'Системная запись: выбран прокси'
        : 'Системная запись: прямой трафик';
    const body = String(entry.response_body ?? entry.responseBody ?? '');
    let loc = '';
    let ip = '';
    for (const line of body.split('\n')) {
        const t = line.trim();
        const ci = t.indexOf(':');
        if (ci < 0) continue;
        const key = t.slice(0, ci).trim().toLowerCase();
        const val = t.slice(ci + 1).trim();
        if (key === 'location') loc = val;
        else if (key === 'ip') ip = val;
    }
    const pathRaw = (loc && loc !== '—') ? loc : (ip || '—');
    const pathMax = 72;
    const pathShown = pathRaw.length > pathMax ? `${pathRaw.slice(0, pathMax - 1)}…` : pathRaw;
    const pathTitle = (body.trim() || pathRaw || u).replace(/\s+/g, ' ').trim();
    return {
        method: 'SYS',
        host,
        hostTitle,
        path: pathShown,
        pathTitle,
        urlTitle: u,
    };
}
function ensureAnnotationFields(entry) {
    if (!entry || typeof entry !== 'object') return;
    if (!entry.host) entry.host = extractHost(entry.url || '');
    if (!entry.tag) entry.tag = null;
    if (!entry.note) entry.note = '';
    entry.has_note = entry.note ? 1 : (entry.has_note ? 1 : 0);
}
function shortTypeLabel(type) {
    const t = String(type || '').toLowerCase();
    if (!t) return '—';
    const map = {
        document: 'Doc',
        stylesheet: 'CSS',
        script: 'JS',
        image: 'Img',
        font: 'Font',
        xhr: 'XHR',
        fetch: 'Fetch',
        websocket: 'WS',
        websocket_frame: 'WS-F',
        ping: 'Ping',
        media: 'Media',
        manifest: 'Mfst',
        preflight: 'Pre',
        screenshot: 'SS',
        cupnet: 'CupNet',
    };
    return map[t] || (t.length > 5 ? t.slice(0, 5) : t);
}
function parseScreenshotTriggerFromPath(url) {
    const m = String(url || '').match(/^autoscreen::\/([^/]+)\//i);
    return m ? String(m[1]).toLowerCase() : '';
}
function screenshotTriggerLabel(trigger) {
    const t = String(trigger || '').toLowerCase();
    const map = {
        click: 'Click',
        'page-load': 'Load',
        'network-pending': 'Pending',
        'mouse-activity': 'Mouse',
        'scroll-end': 'Scroll',
        'typing-end': 'Tapping',
        rule: 'Rule',
        manual: 'Manual',
    };
    return map[t] || (t ? t : '—');
}
function getScreenshotMeta(entry) {
    if (!entry) return null;
    if (entry.screenshotMeta && typeof entry.screenshotMeta === 'object') return entry.screenshotMeta;
    return null;
}
function getScreenshotTrigger(entry) {
    const meta = getScreenshotMeta(entry);
    return String(meta?.trigger || parseScreenshotTriggerFromPath(entry?.url || entry?.path || '') || '').toLowerCase();
}
function getScreenshotPageUrl(entry) {
    const meta = getScreenshotMeta(entry);
    const u = String(meta?.pageUrl || entry?.url || '').trim();
    return u || '—';
}
function enableScreenshotHoverZoom(wrapEl) {
    if (!wrapEl) return;
    const set = (xPercent, yPercent, zoom) => {
        wrapEl.style.setProperty('--ss-ox', `${xPercent.toFixed(3)}%`);
        wrapEl.style.setProperty('--ss-oy', `${yPercent.toFixed(3)}%`);
        wrapEl.style.setProperty('--ss-zoom', String(zoom));
    };
    set(50, 50, 1);
    wrapEl.addEventListener('mouseenter', () => set(50, 50, 2.0));
    wrapEl.addEventListener('mousemove', (ev) => {
        const r = wrapEl.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const x = ((ev.clientX - r.left) / r.width) * 100;
        const y = ((ev.clientY - r.top) / r.height) * 100;
        set(Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y)), 2.0);
    });
    wrapEl.addEventListener('mouseleave', () => set(50, 50, 1));
}
function notePreviewText(note) {
    const s = String(note || '').trim();
    if (!s) return 'No comment';
    const limit = 42;
    return s.length > limit ? s.slice(0, limit) + '…' : s;
}

function countHeaderEntries(headers) {
    if (!headers || typeof headers !== 'object') return 0;
    let n = 0;
    for (const v of Object.values(headers)) {
        n += Array.isArray(v) ? v.length : 1;
    }
    return n;
}

function formatTabBadgeCount(count) {
    const num = Number(count);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num > 999 ? '999+' : String(num);
}

function setDetailTabBadge(tabName, count) {
    const btn = document.querySelector(`.lv-tab-btn[data-tab="${tabName}"]`);
    if (!btn) return;
    const badge = btn.querySelector('.lv-tab-badge:not([data-cookie-badge])');
    if (!badge) return;
    const text = formatTabBadgeCount(count);
    if (!text) {
        badge.textContent = '';
        badge.hidden = true;
        return;
    }
    badge.textContent = text;
    badge.hidden = false;
}

function setCookieTabBadges(sent, received) {
    const btn = document.querySelector('.lv-tab-btn[data-tab="cookies"]');
    if (!btn) return;
    const pairs = [
        [btn.querySelector('[data-cookie-badge="sent"]'), sent, '↑', 'Sent cookies'],
        [btn.querySelector('[data-cookie-badge="recv"]'), received, '↓', 'Received Set-Cookie'],
    ];
    for (const [el, count, prefix, title] of pairs) {
        if (!el) continue;
        const text = formatTabBadgeCount(count);
        if (!text) {
            el.textContent = '';
            el.hidden = true;
            continue;
        }
        el.textContent = `${prefix}${text}`;
        el.title = `${title}: ${count}`;
        el.hidden = false;
    }
}

function clearDetailTabBadges() {
    document.querySelectorAll('.lv-tab-badge').forEach((badge) => {
        badge.textContent = '';
        badge.hidden = true;
    });
}

function countRequestTabItems(queryPairs, formPairs, multipartParts, reqBodyStored, reqBodyText, missingBodyMsg) {
    let n = Array.isArray(queryPairs) ? queryPairs.length : 0;
    if (formPairs?.length) n += formPairs.length;
    else if (multipartParts?.length) n += multipartParts.length;
    else if ((reqBodyText || reqBodyStored) && !missingBodyMsg) n += 1;
    return n;
}

function countResponseTabItems(respFmt, respParsed, isHtml) {
    if (isHtml && respFmt) {
        const forms = parseHtmlFormsFromString(respFmt);
        if (forms.length) {
            return forms.reduce((sum, form) => sum + (form.fields?.length || 0), 0);
        }
    }
    if (respFmt) return 1;
    if (respParsed) return 1;
    return 0;
}

function updateDetailTabBadges(stats) {
    for (const [tab, count] of Object.entries(stats || {})) {
        setDetailTabBadge(tab, count);
    }
}

function updateRawTabBadgeFromText(text) {
    const raw = String(text || '');
    if (!raw.trim()) {
        setDetailTabBadge('raw', 0);
        return;
    }
    setDetailTabBadge('raw', raw.split('\n').length);
}
function formatBody(b) {
    if (!b) return null;
    if (typeof b !== 'string') return JSON.stringify(b, null, 2);
    if (b.startsWith('__b64__:')) {
        const decoded = decodeStoredBody(b);
        if (decoded.text == null) return `[Binary — ${formatFileSize(decoded.bytes)}]`;
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(decoded.text.slice(0, 4096))) {
            return `[Binary — ${formatFileSize(decoded.bytes)}]`;
        }
        return decoded.text;
    }
    if (b.startsWith('<base64|')) {
        const parsed = parseBase64Body(b);
        if (parsed) return null; // handled separately as image
        return `[Binary — ${b.slice(0, 60)}…]`;
    }
    try { return JSON.stringify(JSON.parse(b), null, 2); } catch { return b; }
}

/** Pick request body from DB row / live log entry (snake_case + camelCase). */
function pickRequestBodyRaw(entry) {
    if (!entry) return null;
    const candidates = [
        entry.request_body,
        entry.requestBody,
        entry.request?.body,
        entry.request?.postData?.text,
        entry.request?.postData,
    ];
    for (const c of candidates) {
        if (c == null || c === '') continue;
        if (typeof c === 'object' && c != null && typeof c.text === 'string') return c.text;
        return c;
    }
    return null;
}

function normalizeRequestDetailRow(row) {
    if (!row || typeof row !== 'object') return row;
    return {
        ...row,
        request_body: pickRequestBodyRaw(row),
        request_headers: row.request_headers ?? row.requestHeaders ?? row.request?.headers ?? null,
        response_body: row.response_body ?? row.responseBody ?? null,
        response_headers: row.response_headers ?? row.responseHeaders ?? row.response?.headers ?? null,
    };
}

function looksLikeBase64Text(s) {
    if (!s || typeof s !== 'string') return false;
    const compact = s.replace(/\s/g, '');
    if (compact.length < 8 || compact.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/=]+$/.test(compact);
}

function b64ToBinaryString(b64) {
    const clean = String(b64 || '').replace(/\s/g, '');
    if (!clean) return { ok: false, bin: '', clean: '' };
    const tryDecode = (input) => {
        try { return { ok: true, bin: atob(input) }; } catch { return { ok: false, bin: '' }; }
    };
    let r = tryDecode(clean);
    if (r.ok) return { ok: true, bin: r.bin, clean };
    const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
    r = tryDecode(padded);
    if (r.ok) return { ok: true, bin: r.bin, clean: padded };
    return { ok: false, bin: '', clean };
}

/** Decode MITM/CDP binary body markers to raw text + byte length. */
function decodeStoredBody(body, contentType) {
    if (body == null || body === '') return { text: '', bytes: 0, stored: body || '', fromB64: false };
    if (typeof body !== 'string') {
        const s = String(body);
        return { text: s, bytes: s.length, stored: body, fromB64: false };
    }

    const parsed = parseBase64Body(body);
    if (parsed) {
        const dec = b64ToBinaryString(parsed.data);
        if (dec.ok) {
            return {
                text: dec.bin,
                bytes: dec.bin.length,
                stored: body,
                fromB64: true,
                b64Data: dec.clean,
            };
        }
        return { text: null, bytes: 0, stored: body, fromB64: true, b64Data: parsed.data.replace(/\s/g, ''), decodeError: true };
    }

    // Legacy: raw base64 without __b64__: prefix (older MITM logging).
    const ct = String(contentType || '').toLowerCase();
    if (looksLikeBase64Text(body) && (ct.includes('multipart') || ct.includes('octet-stream') || ct.includes('image/'))) {
        const dec = b64ToBinaryString(body);
        if (dec.ok && (dec.bin.startsWith('--') || dec.bin.includes('Content-Disposition') || ct.includes('multipart'))) {
            return {
                text: dec.bin,
                bytes: dec.bin.length,
                stored: body,
                fromB64: true,
                b64Data: dec.clean,
                legacyRawB64: true,
            };
        }
    }

    return { text: body, bytes: body.length, stored: body, fromB64: false };
}

function requestBodyMissingMessage(entry, parsedReqHeaders, method, reqBodyStored) {
    if (reqBodyStored != null && reqBodyStored !== '') return null;
    const m = String(method || entry?.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
    const ct = String(findHeader(parsedReqHeaders, 'content-type') || '').toLowerCase();
    const cl = findHeader(parsedReqHeaders, 'content-length');
    const clNum = cl != null ? parseInt(String(cl), 10) : NaN;
    const hinted = ct.includes('multipart')
        || ct.includes('application/x-www-form-urlencoded')
        || (Number.isFinite(clNum) && clNum > 0);
    if (!hinted) return null;
    const sizeHint = Number.isFinite(clNum) && clNum > 0 ? formatFileSize(clNum) : null;
    let msg = 'Request body was not stored for this entry.';
    if (ct.includes('multipart')) {
        msg += ' Older CupNet builds often omitted multipart request bodies in the log.';
    } else {
        msg += ' Older CupNet builds may not have persisted the request body.';
    }
    if (sizeHint) msg += ` Content-Length: ${sizeHint}.`;
    msg += ' Re-capture the request or use Request Editor to replay.';
    return msg;
}

/** Parse binary body markers:
 *  CDP:  <base64|mime|image/png|DATA> → { mime, data }
 *  MITM: __b64__:DATA → { mime: null, data }
 *  Returns null for text bodies. */
function parseBase64Body(b) {
    if (!b || typeof b !== 'string') return null;
    if (b.startsWith('__b64__:')) {
        return { mime: null, data: b.slice(8) };
    }
    if (!b.startsWith('<base64|')) return null;
    const inner = b.slice(8, b.endsWith('>') ? b.length - 1 : b.length);
    const sep   = inner.indexOf('|');
    if (sep === -1) return null;
    const qualifier = inner.slice(0, sep);
    const rest      = inner.slice(sep + 1);
    if (qualifier === 'mime') {
        const sep2 = rest.indexOf('|');
        if (sep2 === -1) return null;
        return { mime: rest.slice(0, sep2), data: rest.slice(sep2 + 1) };
    }
    return null;
}

function guessFileInfo(url, contentType) {
    let ext = 'bin';
    let mime = contentType || 'application/octet-stream';
    mime = mime.split(';')[0].trim();
    try {
        const pathname = new URL(url).pathname;
        const m = pathname.match(/\.([a-zA-Z]\w{0,9})$/);
        if (m) ext = m[1];
    } catch {}
    if (ext === 'bin' && mime) {
        const mlc = mime.toLowerCase();
        if (mlc.endsWith('+json')) { ext = 'json'; return { ext, mime }; }
        if (mlc.endsWith('+xml'))  { ext = 'xml';  return { ext, mime }; }
        const map = {
            'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
            'application/font-woff2': 'woff2', 'application/font-woff': 'woff',
            'application/x-font-ttf': 'ttf', 'application/x-font-opentype': 'otf',
            'application/pdf': 'pdf', 'application/zip': 'zip', 'application/gzip': 'gz',
            'application/octet-stream': 'bin',
            'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
            'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
            'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
        };
        ext = map[mlc] || mime.split('/')[1] || 'bin';
    }
    return { ext, mime };
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function binaryStringToBase64(bin) {
    if (!bin) return '';
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    let out = '';
    const step = 0x8000;
    for (let i = 0; i < len; i += step) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(out);
}

function sniffImageMime(bin, contentType) {
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (ct.startsWith('image/') && !ct.includes('svg')) return ct;
    if (!bin || bin.length < 4) return null;
    const c0 = bin.charCodeAt(0);
    const c1 = bin.charCodeAt(1);
    const c2 = bin.charCodeAt(2);
    if (c0 === 0xff && c1 === 0xd8 && c2 === 0xff) return 'image/jpeg';
    if (bin.slice(0, 4) === '\x89PNG') return 'image/png';
    if (bin.slice(0, 3) === 'GIF') return 'image/gif';
    if (bin.slice(0, 4) === 'RIFF' && bin.length >= 12 && bin.slice(8, 12) === 'WEBP') return 'image/webp';
    return null;
}

let _mpImageOverlay = null;
let _mpImageEscHandler = null;

function hideMultipartImagePreview() {
    if (_mpImageOverlay) _mpImageOverlay.classList.remove('visible');
    if (_mpImageEscHandler) {
        document.removeEventListener('keydown', _mpImageEscHandler);
        _mpImageEscHandler = null;
    }
}

function showMultipartImagePreview(part) {
    const bin = part.rawBinary;
    const mime = part.imageMime || sniffImageMime(bin, part.contentType);
    if (!bin || !mime) return;

    const b64 = binaryStringToBase64(bin);
    const src = `data:${mime};base64,${b64}`;
    const fi = guessFileInfo(part.filename || '', mime);
    const title = part.key || part.filename || 'Image';

    if (!_mpImageOverlay) {
        _mpImageOverlay = document.createElement('div');
        _mpImageOverlay.id = 'mp-image-overlay';
        _mpImageOverlay.className = 'lv-overlay';
        _mpImageOverlay.innerHTML = `
            <div class="lv-dialog mp-image-dialog" role="dialog" aria-modal="true">
                <div class="lv-dialog-title" id="mp-image-title"></div>
                <div style="font-size:10px;color:var(--text-dim);margin-bottom:8px" id="mp-image-meta"></div>
                <div class="ss-action-bar" style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px">
                    <button type="button" class="body-act-btn" id="mp-image-copy">⎘ Copy image</button>
                    <button type="button" class="body-act-btn" id="mp-image-save">↓ Save</button>
                    <button type="button" class="body-act-btn" id="mp-image-close">Close</button>
                </div>
                <div class="mp-image-wrap">
                    <img id="mp-image-img" alt="" style="max-width:100%;max-height:min(70vh,680px);border-radius:6px;border:1px solid var(--border);display:block;margin:0 auto">
                </div>
            </div>`;
        document.body.appendChild(_mpImageOverlay);
        _mpImageOverlay.addEventListener('click', (ev) => {
            if (ev.target === _mpImageOverlay) hideMultipartImagePreview();
        });
        _mpImageOverlay.querySelector('.mp-image-dialog')?.addEventListener('click', (ev) => ev.stopPropagation());
    }

    const titleEl = _mpImageOverlay.querySelector('#mp-image-title');
    const metaEl = _mpImageOverlay.querySelector('#mp-image-meta');
    const imgEl = _mpImageOverlay.querySelector('#mp-image-img');
    const copyBtn = _mpImageOverlay.querySelector('#mp-image-copy');
    const saveBtn = _mpImageOverlay.querySelector('#mp-image-save');
    const closeBtn = _mpImageOverlay.querySelector('#mp-image-close');

    titleEl.textContent = title;
    metaEl.textContent = `${mime} · ${formatFileSize(bin.length)}${part.filename ? ` · ${part.filename}` : ''}`;
    imgEl.src = src;
    imgEl.alt = title;

    copyBtn.onclick = async () => {
        try {
            const blob = await fetch(src).then((r) => r.blob());
            await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
            flashBtn(copyBtn, '✓ Copied');
        } catch {
            flashBtn(copyBtn, '✗ Failed');
        }
    };
    saveBtn.textContent = `↓ Save .${fi.ext}`;
    saveBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = src;
        const fn = part.filename && /\.\w+$/.test(part.filename)
            ? part.filename
            : `multipart-${part.key || 'image'}-${Date.now()}.${fi.ext}`;
        a.download = fn;
        a.click();
    };
    closeBtn.onclick = () => hideMultipartImagePreview();

    _mpImageOverlay.classList.add('visible');
    if (_mpImageEscHandler) document.removeEventListener('keydown', _mpImageEscHandler);
    _mpImageEscHandler = (ev) => {
        if (ev.key === 'Escape') hideMultipartImagePreview();
    };
    document.addEventListener('keydown', _mpImageEscHandler);
}

/** WS Messages tab: preview length before expand */
const WS_MSG_PREVIEW_CHARS = 200;

/** Last loaded rows for «Copy as JSON» (same session as current WS detail if entryId matches). */
let _wsMessagesCopyPayload = null;

/**
 * HTML for one WS payload: first 200 chars + expand/collapse for the rest.
 */
function wsMessagePayloadHtml(plainText) {
    const full = plainText == null ? '' : String(plainText);
    if (full.length <= WS_MSG_PREVIEW_CHARS) {
        return `<span class="ws-msg-single">${esc(full)}</span>`;
    }
    const head = full.slice(0, WS_MSG_PREVIEW_CHARS);
    return `<div class="ws-msg-body-payload">`
        + `<span class="ws-msg-short">${esc(head)}…</span>`
        + `<span class="ws-msg-full" hidden>${esc(full)}</span>`
        + `<button type="button" class="ws-msg-toggle" aria-expanded="false">Развернуть</button>`
        + `</div>`;
}

/** One listener on #tab-messages — survives innerHTML refresh of #ws-messages-list */
function setupWsMessagesToggle() {
    const tab = document.getElementById('tab-messages');
    if (!tab || tab._wsToggleBound) return;
    tab._wsToggleBound = true;
    tab.addEventListener('click', (e) => {
        const btn = e.target.closest('.ws-msg-toggle');
        if (!btn || !tab.contains(btn)) return;
        e.preventDefault();
        const wrap = btn.closest('.ws-msg-body-payload');
        if (!wrap) return;
        const shortEl = wrap.querySelector('.ws-msg-short');
        const fullEl = wrap.querySelector('.ws-msg-full');
        if (!shortEl || !fullEl) return;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        if (expanded) {
            shortEl.hidden = false;
            fullEl.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            btn.textContent = 'Развернуть';
        } else {
            shortEl.hidden = true;
            fullEl.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            btn.textContent = 'Свернуть';
        }
    });
}
function parseHeaders(h) {
    if (!h) return null;
    if (typeof h === 'string') { try { return JSON.parse(h); } catch { return null; } }
    return h;
}

/** Build curl command from entry (replay-able) */
function buildCurlCommand(entry) {
    const url = entry.url || '';
    const method = (entry.method || 'GET').toUpperCase();
    const reqH = parseHeaders(entry.request_headers || entry.request?.headers) || {};
    const reqBody = entry.request_body ?? entry.request?.body ?? '';
    const headers = Object.entries(reqH)
        .filter(([k]) => !/^(host|content-length)$/i.test(k))
        .map(([k, v]) => `-H '${String(k).replace(/'/g, "'\\\\''")}: ${String(v).replace(/'/g, "'\\\\''")}'`);
    let cmd = `curl -v -X ${method} '${url.replace(/'/g, "'\\\\''")}'`;
    if (headers.length) cmd += ' \\\n  ' + headers.join(' \\\n  ');
    if (reqBody && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        let body = String(reqBody);
        if (body.startsWith('<base64|') || body.startsWith('__b64__:')) body = '[Binary — use Request body tab]';
        else if (body.length > 8000) body = body.slice(0, 8000) + '\n... [truncated]';
        const escaped = body.replace(/\\/g, '\\\\').replace(/'/g, "'\\\\''");
        cmd += ` \\\n  --data-raw '${escaped}'`;
    }
    return cmd;
}

/** Time fragment for WEBSOCKET RAW block (HH:MM:SS.mmm) */
function formatWsRawTime(iso) {
    if (!iso) return '—';
    const s = String(iso).replace('T', ' ');
    const m = s.match(/(\d{2}:\d{2}:\d{2})([\.,]\d+)?/);
    if (m) return m[2] ? `${m[1]}${m[2].replace(',', '.')}` : m[1];
    return s.slice(11, 23) || '—';
}

/**
 * Append after HTTP handshake in Raw tab. recv = <<<<<<, send = >>>>>> (vs browser: inbound / outbound).
 */
function formatWebSocketRawLog(rows) {
    if (!rows || !rows.length) {
        return '\n\n──────── WEBSOCKET RAW ────────\n(no frames in DB yet — reconnect or Refresh Messages tab)\n';
    }
    let out = '\n\n──────── WEBSOCKET RAW ────────\n\n';
    for (const r of rows) {
        const t = formatWsRawTime(r.created_at);
        const pl = r.payload;
        if (typeof pl === 'string' && pl.startsWith('__cupnet_ws_meta__:')) {
            try {
                const meta = JSON.parse(pl.slice('__cupnet_ws_meta__:'.length));
                if (meta.kind === 'closed') {
                    out += `*** [closed] ${t}  frames=${meta.frames ?? 0}\n\n`;
                    continue;
                }
                if (meta.kind === 'error') {
                    out += `*** [error] ${t}  ${meta.error || ''}\n\n`;
                    continue;
                }
            } catch { /* fallthrough */ }
        }
        const dir = String(r.direction || '').toLowerCase();
        const arrow = dir === 'send' ? '>>>>>>' : '<<<<<<';
        const body = pl == null ? '' : String(pl);
        out += `${arrow} ${t}\n${body}\n\n`;
    }
    return out;
}

/** Build raw HTTP in curl -v style (request with >, response with <) */
function buildRawHttp(entry) {
    const reqH = parseHeaders(entry.request_headers || entry.request?.headers) || {};
    const resH = parseHeaders(entry.response_headers || entry.response?.headers) || {};
    const method = (entry.method || 'GET').toUpperCase();
    const url = entry.url || '';
    const status = entry.status ?? entry.response?.statusCode ?? 0;
    const isWs = String(entry.type || '').toLowerCase() === 'websocket';
    let reqBody = entry.request_body ?? entry.request?.body ?? '';
    let respBody = entry.response_body ?? entry.responseBody ?? '';
    if (typeof reqBody !== 'string') reqBody = String(reqBody);
    if (typeof respBody !== 'string') respBody = String(respBody);
    if (reqBody.startsWith('<base64|') || reqBody.startsWith('__b64__:')) {
        let bLen = 0;
        try { bLen = reqBody.startsWith('__b64__:') ? atob(reqBody.slice(8)).length : reqBody.length; } catch {}
        reqBody = `[Binary data, ${formatFileSize(bLen)}]`;
    }
    if (respBody.startsWith('<base64|') || respBody.startsWith('__b64__:')) {
        let bLen = 0;
        try { bLen = respBody.startsWith('__b64__:') ? atob(respBody.slice(8)).length : respBody.length; } catch {}
        respBody = `[Binary data, ${formatFileSize(bLen)}]`;
    }

    let path = '/';
    try { const u = new URL(url); path = u.pathname + (u.search || ''); } catch {}
    const reqLine = `${method} ${path} HTTP/1.1`;
    const hdrLine = (k, v) => (isWs ? `${String(k).toLowerCase()}: ${v}` : `${k}: ${v}`);
    const reqHeaders = Object.entries(reqH).map(([k, v]) => hdrLine(k, v));
    const reqLines = [reqLine, ...reqHeaders, ''].map(l => `> ${l}`);
    const reqPart = reqLines.join('\n') + (reqBody ? `\n${reqBody}` : '');

    let statusText = '';
    if (status === 101) statusText = 'Switching Protocols';
    else if (status >= 200 && status < 300) statusText = 'OK';
    else if (status === 301) statusText = 'Moved Permanently';
    else if (status === 302) statusText = 'Found';
    else if (status === 404) statusText = 'Not Found';
    else if (status === 500) statusText = 'Internal Server Error';
    const resLine = `HTTP/1.1 ${status || '000'} ${statusText}`.trim();
    const resHeaders = Object.entries(resH).map(([k, v]) => hdrLine(k, v));
    const resLines = [resLine, ...resHeaders, ''].map(l => `< ${l}`);
    const resPart = resLines.join('\n') + (respBody ? `\n${respBody}` : '');

    return `${reqPart}\n\n${resPart}`;
}

function chooseProtectionLevel() {
    if (!protectionModal || !protectionConfirmBtn || !protectionCancelBtn) {
        return Promise.resolve('Raw');
    }
    return new Promise((resolve) => {
        const cleanup = () => {
            protectionModal.classList.remove('visible');
            protectionConfirmBtn.removeEventListener('click', onConfirm);
            protectionCancelBtn.removeEventListener('click', onCancel);
            protectionModal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onEsc);
        };
        const onConfirm = () => {
            const selected = protectionModal.querySelector('input[name="protection-level"]:checked');
            const level = selected ? selected.value : 'Raw';
            cleanup();
            resolve(level);
        };
        const onCancel = () => {
            cleanup();
            resolve(null);
        };
        const onBackdrop = (e) => {
            if (e.target === protectionModal) onCancel();
        };
        const onEsc = (e) => {
            if (e.key === 'Escape') onCancel();
        };
        protectionConfirmBtn.addEventListener('click', onConfirm);
        protectionCancelBtn.addEventListener('click', onCancel);
        protectionModal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onEsc);
        protectionModal.classList.add('visible');
    });
}

/** Electron does not support `window.prompt` in the renderer — use overlay instead. */
function promptNewSessionNameFromSelection() {
    if (!sessionFromSelModal || !sessionFromSelInput || !sessionFromSelOkBtn || !sessionFromSelCancelBtn) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        const cleanup = () => {
            sessionFromSelModal.classList.remove('visible');
            sessionFromSelOkBtn.removeEventListener('click', onOk);
            sessionFromSelCancelBtn.removeEventListener('click', onCancel);
            sessionFromSelModal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKey);
        };
        const onCancel = () => {
            cleanup();
            resolve(null);
        };
        const onOk = () => {
            const trimmed = String(sessionFromSelInput.value || '').trim();
            if (!trimmed) {
                if (sessionFromSelErr) {
                    sessionFromSelErr.textContent = 'Enter a non-empty session name.';
                    sessionFromSelErr.style.display = '';
                }
                sessionFromSelInput.focus();
                return;
            }
            cleanup();
            resolve(trimmed);
        };
        const onBackdrop = (e) => {
            if (e.target === sessionFromSelModal) onCancel();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') onCancel();
            if (e.key === 'Enter') onOk();
        };
        sessionFromSelInput.value = '';
        if (sessionFromSelErr) {
            sessionFromSelErr.textContent = '';
            sessionFromSelErr.style.display = 'none';
        }
        sessionFromSelOkBtn.addEventListener('click', onOk);
        sessionFromSelCancelBtn.addEventListener('click', onCancel);
        sessionFromSelModal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
        sessionFromSelModal.classList.add('visible');
        requestAnimationFrame(() => {
            sessionFromSelInput.focus();
        });
    });
}

async function openCompareSidePickerForEntry(entry) {
    if (!entry?.id || !compareSideModal || !compareSidePicker) return;
    const cmpState = await api.getCompare?.().catch(() => null);
    compareSidePicker.innerHTML = '';
    for (const side of ['left', 'right']) {
        const current = cmpState?.[side];
        const btn = document.createElement('button');
        btn.className = 'cmp-side-btn';
        btn.type = 'button';
        btn.innerHTML = `<div class="side-label">${side === 'left' ? 'Left (A)' : 'Right (B)'}</div><div class="side-info">${current?.url ? esc(truncUrl(current.url)) : 'Empty'}</div>`;
        btn.addEventListener('click', async () => {
            await api.setCompareSlot?.(side, entry.id).catch(() => {});
            compareSideModal.classList.remove('visible');
            const otherSide = side === 'left' ? 'right' : 'left';
            if (cmpState?.[otherSide]) {
                await api.openCompareViewer?.().catch(() => {});
            }
        });
        compareSidePicker.appendChild(btn);
    }
    compareSideModal.classList.add('visible');
}

// ─── Virtual scroll ───────────────────────────────────────────────────────────
function calcWindow() {
    const vh   = lvScroll.clientHeight;
    const st   = lvScroll.scrollTop;
    const tot  = filteredEntries.length;
    const fv   = Math.floor(st / ROW_HEIGHT);
    renderStart = Math.max(0, fv - BUFFER);
    renderEnd   = Math.min(tot, fv + Math.ceil(vh / ROW_HEIGHT) + BUFFER);
}

function renderVirtual() {
    const preservedScrollTop = lvScroll.scrollTop;
    calcWindow();
    const tot = filteredEntries.length;
    spacerTop.style.height    = `${renderStart * ROW_HEIGHT}px`;
    spacerBottom.style.height = `${Math.max(0, (tot - renderEnd) * ROW_HEIGHT)}px`;
    lvRows.innerHTML = '';
    for (let i = renderStart; i < renderEnd; i++) {
        lvRows.appendChild(buildRow(filteredEntries[i], i));
    }
    // Подмена узлов внутри скролла на Windows часто даёт сбой scrollTop / scroll anchoring
    // (рвань в начало или в конец). Восстанавливаем позицию явно.
    const maxSt = Math.max(0, lvScroll.scrollHeight - lvScroll.clientHeight);
    const clamped = Math.min(Math.max(0, preservedScrollTop), maxSt);
    if (Math.abs(lvScroll.scrollTop - clamped) > 1) {
        lvScroll.scrollTop = clamped;
    }
}

let _renderRaf = null;
function scheduleRenderVirtual() {
    if (_renderRaf) return;
    _renderRaf = requestAnimationFrame(() => {
        _renderRaf = null;
        renderVirtual();
    });
}

function updateSessionFromSelButton() {
    if (!lvSessionFromSelBtn) return;
    lvSessionFromSelBtn.disabled = selectedRequestIds.size === 0;
}

/** Clear browser text selection (e.g. after Shift/Ctrl row range) so list selection stays visual-only. */
function clearDomTextSelection() {
    try {
        const s = window.getSelection && window.getSelection();
        if (s && s.rangeCount) s.removeAllRanges();
    } catch { /* ignore */ }
}

/** Block native range-select when modifying row selection; mousedown fires before click. */
function rowModifierMouseDown(e) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
}

function showMultiSelectionDetail() {
    detailEmpty.style.display = 'none';
    detailPanel.style.display = 'flex';
    detailPanel.classList.add('multi-sel');
    const n = selectedRequestIds.size;
    const multiText = document.getElementById('lv-detail-multi-text');
    if (multiText) {
        multiText.textContent = `${n} request(s) selected. Use “+ Session from selection” on the toolbar, then enter a name for the new session.`;
    }
    renderDetailRequestLine(_currentDetailEntry || {}, {
        idText: `[${n} selected]`,
        method: '',
        url: '',
    });
    if (dRequestMethodEl) dRequestMethodEl.style.display = 'none';
    if (copyUrlHeaderBtn) copyUrlHeaderBtn.style.display = 'none';
    if (detailUrlBtn) detailUrlBtn.disabled = true;
    updateSessionFromSelButton();
}

function handleRowClick(idx, e) {
    const entry = filteredEntries[idx];
    if (!entry) return;

    if (!entry.id || String(entry.type || '').toLowerCase() === 'screenshot' || entry._browserEvent) {
        selectedRequestIds.clear();
        selectionAnchorIdx = idx;
        updateSessionFromSelButton();
        selectEntry(idx);
        return;
    }

    if (e.shiftKey) {
        e.preventDefault();
        clearDomTextSelection();
        let anchor = selectionAnchorIdx;
        if (anchor < 0 && selectedIndex >= 0) anchor = selectedIndex;
        if (anchor < 0) anchor = idx;
        const lo = Math.min(anchor, idx);
        const hi = Math.max(anchor, idx);
        for (let i = lo; i <= hi; i++) {
            const en = filteredEntries[i];
            if (en?.id && String(en.type || '').toLowerCase() !== 'screenshot' && !en._browserEvent) selectedRequestIds.add(en.id);
        }
        selectionAnchorIdx = anchor;
        selectedIndex = idx;
        scheduleRenderVirtual();
        ensureVisible(idx);
        showMultiSelectionDetail();
        return;
    }

    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        clearDomTextSelection();
        if (selectedRequestIds.has(entry.id)) selectedRequestIds.delete(entry.id);
        else selectedRequestIds.add(entry.id);
        selectionAnchorIdx = idx;
        selectedIndex = idx;
        scheduleRenderVirtual();
        ensureVisible(idx);
        if (selectedRequestIds.size === 1) {
            const only = [...selectedRequestIds][0];
            const i = filteredEntries.findIndex(x => x.id === only);
            if (i >= 0) selectEntry(i);
        } else if (selectedRequestIds.size === 0) {
            detailPanel.classList.remove('multi-sel');
            detailEmpty.style.display = '';
            detailPanel.style.display = 'none';
            updateSessionFromSelButton();
        } else {
            showMultiSelectionDetail();
        }
        return;
    }

    selectedRequestIds.clear();
    selectedRequestIds.add(entry.id);
    selectionAnchorIdx = idx;
    updateSessionFromSelButton();
    selectEntry(idx);
}

function buildRow(entry, idx) {
    ensureAnnotationFields(entry);
    const row = document.createElement('div');
    row.className = 'lv-row';
    row.dataset.index = idx;
    row.style.height = ROW_HEIGHT + 'px';
    if (idx === selectedIndex) row.classList.add('selected');
    if (entry.id && selectedRequestIds.has(entry.id)) row.classList.add('lv-multi-sel');
    if (entry.error) row.classList.add('lv-error');

    const status  = entry.status ?? entry.response?.statusCode;
    const method  = (entry.method || '').toUpperCase();
    const type    = entry.type || '';
    const url     = entry.url || '';
    const host    = entry.host || extractHost(url);
    const dur     = entry.duration_ms ?? entry.duration;

    if (String(type).toLowerCase() === 'mock') row.classList.add('lv-row-mock');
    if (String(type).toLowerCase() === 'cupnet') row.classList.add('lv-row-cupnet');
    if (String(type).toLowerCase() === 'websocket') row.classList.add('lv-row-ws');

    const cupnetSess = getCupnetSessionTrafficPresentation(entry);
    if (cupnetSess) row.classList.add('lv-row-cupnet-session');

    if (entry._browserEvent) {
        const et = String(entry.event_type || '');
        const levRaw = String(entry.level || '');
        const lev = levRaw.toLowerCase();
        const mb = browserActivityMethodBadge(et);
        const st = browserActivityStatusLabel(et, levRaw);
        const isStorage = et.startsWith('ls-') || et.startsWith('ss-');
        const isConsole = et === 'console' || et === 'log-entry';
        if (isStorage) {
            row.classList.add('lv-row-browser-storage');
        } else if (isConsole) {
            row.classList.add('lv-row-browser-console');
            const lc = browserConsoleLevelRowClass(et, levRaw);
            if (lc) row.classList.add(lc);
        } else {
            row.classList.add('lv-row-browser-event');
            if (et === 'exception' || lev === 'error') row.classList.add('lv-row-browser-err');
            else if (lev === 'warning' || lev === 'warn') row.classList.add('lv-row-browser-warn');
        }
        const ts = entry.created_at
            ? new Date(entry.created_at).toLocaleTimeString()
            : '';
        const hostTxt = entry.origin || entry.source_url || '—';
        const hostShort = hostTxt.length > 36 ? hostTxt.slice(0, 33) + '…' : hostTxt;
        const typeLbl = entry.type || 'browser';
        const sum = String(entry.summary || '').slice(0, 200);
        const rowIdx = entry.id != null ? entry.id : idx + 1;
        row.innerHTML =
            `<div class="lv-td col-idx">${esc(rowIdx)}</div>` +
            `<div class="lv-td col-method"><span class="method-badge ${esc(mb.cls)}" title="${esc(et)}">${esc(mb.text)}</span></div>` +
            `<div class="lv-td col-status"><span class="lv-status ${esc(st.cls)}">${esc(st.text)}</span></div>` +
            `<div class="lv-td col-mark"></div>` +
            `<div class="lv-td col-host"><span class="host-chip" title="${esc(hostTxt)}">${esc(hostShort)}</span></div>` +
            `<div class="lv-td col-type"><span class="type-chip type-browser-act" title="${esc(et)}">${esc(typeLbl)}</span></div>` +
            `<div class="lv-td col-dur"><span class="lv-dur">${esc(ts)}</span></div>` +
            `<div class="lv-td col-path"><span class="lv-path" title="${esc(sum)}">${esc(sum)}</span></div>`;
        row.addEventListener('mousedown', rowModifierMouseDown);
        row.addEventListener('click', (e) => handleRowClick(idx, e));
        return row;
    }

    if (type === 'screenshot') {
        row.classList.add('lv-row-screenshot');
        // Thumbnail is never stored in memory — only shown in detail panel on click
        const ts = entry.created_at
            ? new Date(entry.created_at).toLocaleTimeString()
            : '';
        const trig = getScreenshotTrigger(entry);
        const trigLbl = screenshotTriggerLabel(trig);
        const typeLbl = trigLbl;
        const pageUrl = getScreenshotPageUrl(entry);
        const pageHost = 'screen';
        const tag = String(entry.tag || '').trim();
        const hasNote = !!(entry.has_note || (entry.note && String(entry.note).trim()));
        const tagTitle = [
            tag ? `tag: ${tag}` : null,
            hasNote ? 'note: yes' : null,
        ].filter(Boolean).join(' | ') || 'No mark';
        const tagDot = tag
            ? `<span class="tag-dot ${hasNote ? 'tag-has-note' : ''}" style="background:${esc(tag)}" title="${esc(tagTitle)}"></span>`
            : `<span class="tag-dot tag-none ${hasNote ? 'tag-has-note' : ''}" title="${esc(tagTitle)}"></span>`;
        const rowIdx = entry.id != null ? entry.id : idx + 1;
        row.innerHTML =
            `<div class="lv-td col-idx">${esc(rowIdx)}</div>` +
            `<div class="lv-td col-method"><span class="method-badge m-other">Scrn</span></div>` +
            `<div class="lv-td col-status"><span class="lv-status s-2xx">OK</span></div>` +
            `<div class="lv-td col-mark"><div class="mark-stack">${tagDot}</div></div>` +
            `<div class="lv-td col-host"><span class="host-chip" title="${esc(pageHost)}">${esc(pageHost)}</span></div>` +
            `<div class="lv-td col-type"><span class="type-chip type-screenshot" title="Screenshot trigger">${esc(typeLbl)}</span></div>` +
            `<div class="lv-td col-dur"><span class="lv-dur">${ts}</span></div>` +
            `<div class="lv-td col-path"><span class="ss-row-badge" title="Screenshot entry">📸</span><span class="lv-path" title="${esc(pageUrl)}">${esc(pageUrl)}</span></div>`;
        row.addEventListener('mousedown', rowModifierMouseDown);
        row.addEventListener('click', (e) => handleRowClick(idx, e));
        return row;
    }

    const scCount = countSetCookies(entry);
    const extBadge = (entry.source === 'external' || (entry.tabId || entry.tab_id || '').startsWith('ext_'))
        ? `<span class="ext-badge" title="External proxy :${entry.extPort || ''}">EXT</span>` : '';
    const mockBadge = String(type).toLowerCase() === 'mock'
        ? '<span class="mock-badge" title="Mocked by intercept rule">MOCK</span>'
        : '';
    const tagCls = entry.has_note ? 'tag-dot tag-has-note' : 'tag-dot';
    const tagDot = entry.tag
        ? `<span class="${tagCls}" style="background:${esc(entry.tag)}" title="${esc(entry.has_note ? 'Tag + note' : 'Tag')}"></span>`
        : `<span class="${tagCls}" title="${esc(entry.has_note ? 'Note only' : 'No mark')}"></span>`;
    const cookieMarkV3 = scCount > 0
        ? `<sup class="status-cookie" title="${scCount} Set-Cookie(s)">🍪${scCount > 1 ? scCount : ''}</sup>`
        : '';
    const tLower = String(type || '').toLowerCase();
    let typeChipHtml;
    if (tLower === 'websocket') {
        const n = entry.ws_message_count != null && entry.ws_message_count !== ''
            ? Number(entry.ws_message_count)
            : 0;
        const lbl = n > 0 ? `WS (${n})` : 'WS';
        typeChipHtml = `<span class="type-chip type-chip-ws" title="${esc(type)} — messages in DB">${esc(lbl)}</span>`;
    } else {
        typeChipHtml = `<span class="type-chip" title="${esc(type)}">${esc(shortTypeLabel(type))}</span>`;
    }
    const rowMethod = cupnetSess ? cupnetSess.method : method;
    const rowHost = cupnetSess ? cupnetSess.host : host;
    const rowHostTitle = cupnetSess ? cupnetSess.hostTitle : host;
    const pathCell = cupnetSess
        ? `${mockBadge}${extBadge}<span class="lv-path lv-path-cupnet-sess" title="${esc(cupnetSess.pathTitle)}">${esc(cupnetSess.path)}</span>`
        : `${mockBadge}${extBadge}<span class="lv-path" title="${esc(url)}">${esc(truncUrl(url))}</span>`;
    const rowIdx = entry.id != null ? entry.id : idx + 1;
    row.innerHTML =
        `<div class="lv-td col-idx">${esc(rowIdx)}</div>` +
        `<div class="lv-td col-method"><span class="method-badge ${methodCls(rowMethod)}">${esc(rowMethod) || '—'}</span></div>` +
        `<div class="lv-td col-status"><span class="lv-status ${entry.error ? 's-err' : statusCls(status)}">${status || (entry.error ? 'ERR' : '—')}${cookieMarkV3}</span></div>` +
        `<div class="lv-td col-mark">${tagDot}</div>` +
        `<div class="lv-td col-host"><span class="host-chip${cupnetSess ? ' host-chip-cupnet-sess' : ''}" title="${esc(rowHostTitle)}">${esc(rowHost)}</span></div>` +
        `<div class="lv-td col-type">${typeChipHtml}</div>` +
        `<div class="lv-td col-dur"><span class="lv-dur ${durCls(dur)}">${formatDur(dur)}</span></div>` +
        `<div class="lv-td col-path">${pathCell}</div>`;

    row.addEventListener('mousedown', rowModifierMouseDown);
    row.addEventListener('click', (e) => handleRowClick(idx, e));
    return row;
}

lvScroll.addEventListener('scroll', () => {
    if (_scrollRaf) return;
    _scrollRaf = requestAnimationFrame(() => {
        _scrollRaf = null;
        renderVirtual();
        if (!isAtBottom() && autoScrollEnabled) {
            autoScrollEnabled = false;
            autoScrollBtn.classList.remove('active');
            autoScrollBtn.textContent = '↓ Paused';
        }
    });
}, { passive: true });

lvScroll.addEventListener('keydown', (e) => {
    if (!filteredEntries.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); selectEntry(Math.min(selectedIndex + 1, filteredEntries.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); selectEntry(Math.max(selectedIndex - 1, 0)); }
    if (e.key === 'End')       { e.preventDefault(); selectEntry(filteredEntries.length - 1); }
    if (e.key === 'Home')      { e.preventDefault(); selectEntry(0); }
});

function isAtBottom() {
    return lvScroll.scrollHeight - lvScroll.scrollTop - lvScroll.clientHeight < ROW_HEIGHT * 3;
}
function scrollToBottom() { lvScroll.scrollTop = lvScroll.scrollHeight; }
function ensureVisible(i) {
    const top = i * ROW_HEIGHT, bot = top + ROW_HEIGHT;
    if (top < lvScroll.scrollTop) lvScroll.scrollTop = top;
    else if (bot > lvScroll.scrollTop + lvScroll.clientHeight) lvScroll.scrollTop = bot - lvScroll.clientHeight;
}

// ─── Count label ──────────────────────────────────────────────────────────────
function updateCount() {
    const total = allEntries.length;
    const shown = filteredEntries.length;
    lvCount.textContent = shown === total ? `${total} entries` : `${shown} / ${total}`;
}

// ─── Add entry (batched) ──────────────────────────────────────────────────────
let _tabFilterDebounce = null;
function scheduleTabFilterUpdate() {
    if (_tabFilterDebounce) return;
    _tabFilterDebounce = setTimeout(() => { _tabFilterDebounce = null; updateTabFilter(); }, 300);
}

function _flushBatch() {
    _batchTimer = null;
    if (!_batchQueue.length) return;

    const incoming = _batchQueue;
    _batchQueue = [];

    let anyPassed = false;
    for (const entry of incoming) {
        allEntries.push(entry);
        if (entry.tabId || entry.tab_id) knownTabs.add(entry.tabId || entry.tab_id);
        if (entryPassesFilter(entry)) {
            filteredEntries.push(entry);
            anyPassed = true;
        }
    }

    // Cap live entries — trim oldest when over limit
    if (allEntries.length > MAX_LIVE_ENTRIES) {
        const excess = allEntries.length - MAX_LIVE_ENTRIES;
        allEntries.splice(0, excess);
        // Rebuild filteredEntries after trim (indices may shift)
        filteredEntries = allEntries.filter(entryPassesFilter);
        selectedIndex = -1;
        selectedRequestIds.clear();
        selectionAnchorIdx = -1;
        updateSessionFromSelButton();
        anyPassed = true;
    }

    scheduleTabFilterUpdate();

    if (anyPassed) {
        updateCount();
        if (autoScrollEnabled) {
            scheduleRenderVirtual();
            requestAnimationFrame(scrollToBottom);
        } else {
            const last = filteredEntries.length - 1;
            if (last >= renderStart && last < renderEnd) scheduleRenderVirtual();
        }
    } else {
        updateCount();
    }

    // Update sidebar live-session count without full re-render
    if (activeSidebarId === null && currentSrvSessId) {
        const liveS = sidebarSessions.find(s => s.id === currentSrvSessId);
        if (liveS) {
            liveS.request_count = (liveS.request_count || 0) + incoming.length;
            const liveItem = sessionListEl?.querySelector(`[data-session-id="${currentSrvSessId}"]`);
            if (liveItem) {
                const metaEl = liveItem.querySelector('.si-meta');
                if (metaEl) metaEl.textContent = `${liveS.request_count} reqs · ${sessionDateStr(liveS)}`;
            }
        }
    }
}

function addEntry(entry) {
    ensureAnnotationFields(entry);
    _batchQueue.push(entry);
    if (!_batchTimer) _batchTimer = setTimeout(_flushBatch, BATCH_MS);
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function entryPassesFilter(e) {
    const q = searchInput.value.trim().toLowerCase();

    if (e._browserEvent) {
        // Category multiselect only (capture is controlled in Settings → Activity Monitor).
        if (selectedActivityTypes.size > 0) {
            if (!selectedActivityTypes.has(browserEventCategory(e))) return false;
        } else {
            return false;
        }
    } else {
        // Type filter (multi). By default hide per-frame WS rows (see Messages tab on WS handshake).
        if (selectedTypes.size > 0) {
            const eType = (e.type || '').toLowerCase();
            if (![...selectedTypes].some(t => t.toLowerCase() === eType)) return false;
        } else if (String(e.type || '').toLowerCase() === 'websocket_frame') {
            return false;
        }
    }

    // Status filter (multi) — HTTP only
    const s = e.status ?? e.response?.statusCode;
    if (selectedStatuses.size > 0 && !e._browserEvent) {
        let ok = false;
        if (selectedStatuses.has('success')      && s >= 200 && s < 300) ok = true;
        if (selectedStatuses.has('redirect')     && s >= 300 && s < 400) ok = true;
        if (selectedStatuses.has('client-error') && s >= 400 && s < 500) ok = true;
        if (selectedStatuses.has('server-error') && s >= 500 && s < 600) ok = true;
        if (selectedStatuses.has('error')        && e.error) ok = true;
        if (!ok) return false;
    }

    // Tab filter (multi)
    if (selectedTabs.size > 0) {
        if (!selectedTabs.has(e.tabId || e.tab_id || '')) return false;
    }

    // Set-Cookie only filter
    if (scOnlyCheckbox?.checked && !e._browserEvent) {
        if (countSetCookies(e) === 0) return false;
    }

    // Hide OPTIONS requests
    if (hideOptionsCheckbox?.checked && !e._browserEvent) {
        if ((e.method || '').toUpperCase() === 'OPTIONS') return false;
    }
    // Hide screenshot entries
    if (hideScreenshotCheckbox?.checked) {
        if (String(e.type || '').toLowerCase() === 'screenshot') return false;
    }

    // Session filter: use direct state variable (not the hidden <select>)
    if (sessionFilterMode !== null && sessionFilterMode !== 'all') {
        const entrySession = e.session_id ?? e.sessionId;
        if (entrySession == null || String(entrySession) !== String(sessionFilterMode)) return false;
    }

    if (q && !(e.url || '').toLowerCase().includes(q)) return false;
    return true;
}

async function applyFilters() {
    const q = searchInput.value.trim(), fts = ftsCheckbox?.checked;
    if (fts && q) {
        const ql = q.toLowerCase();
        let ftsRes = await api.ftsSearch(q, currentSessionId).catch(() => []);
        const fromFts = new Set((ftsRes || []).map((r) => r.id));
        const beMatch = allEntries.filter((e) => {
            if (!e._browserEvent) return false;
            const sum = String(e.summary || '').toLowerCase();
            const det = String(e.detail || '').toLowerCase();
            return sum.includes(ql) || det.includes(ql);
        }).filter(entryPassesFilter);
        const merged = [...(ftsRes || [])];
        for (const b of beMatch) {
            if (!fromFts.has(b.id)) merged.push(b);
        }
        merged.sort((a, b) => {
            const ta = a.created_at || '', tb = b.created_at || '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });
        filteredEntries = merged;
        if (scOnlyCheckbox?.checked) {
            filteredEntries = filteredEntries.filter(e => e._browserEvent || countSetCookies(e) > 0);
        }
        if (hideOptionsCheckbox?.checked) {
            filteredEntries = filteredEntries.filter(e => e._browserEvent || (e.method || '').toUpperCase() !== 'OPTIONS');
        }
        if (hideScreenshotCheckbox?.checked) {
            filteredEntries = filteredEntries.filter(e => String(e.type || '').toLowerCase() !== 'screenshot');
        }
    } else {
        filteredEntries = allEntries.filter(entryPassesFilter);
    }
    selectedIndex = -1;
    selectedRequestIds.clear();
    selectionAnchorIdx = -1;
    detailPanel?.classList.remove('multi-sel');
    updateSessionFromSelButton();
    updateCount();
    renderVirtual();
    if (autoScrollEnabled) scrollToBottom();
}

function updateTabFilter() {
    const drop = document.getElementById('ms-tab-drop');
    if (!drop) return;
    // preserve the clear button
    const clearBtn = drop.querySelector('.ms-clear');
    drop.querySelectorAll('.ms-opt').forEach(el => el.remove());

    for (const tid of knownTabs) {
        const lbl = document.createElement('label');
        lbl.className = 'ms-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = tid;
        cb.checked = selectedTabs.has(tid);
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(
            ' ' + (tid.length > 20 ? tid.slice(0, 20) + '…' : tid)
        ));
        if (clearBtn) drop.insertBefore(lbl, clearBtn);
        else drop.appendChild(lbl);
    }
    // update badge
    syncMsBadge('ms-tab-badge', 'ms-tab-btn', selectedTabs.size);
}

// ─── Session sidebar ──────────────────────────────────────────────────────────
const sessionListEl   = document.getElementById('session-list');
let sidebarSessions   = []; // cached session list
let activeSidebarId   = null; // null = live/current
let currentSrvSessId  = null; // actual current session in main process (for LIVE badge)

function sessionLabel(s) {
    return s.notes || `Session #${s.id}`;
}
function sessionDateStr(s) {
    try { return new Date(s.started_at).toLocaleString('en-GB', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); }
    catch { return ''; }
}

function appendSessionItem(s) {
    const isNamed      = !!s.notes;
    const isCurrentSrv = s.id === currentSrvSessId;
    const isActive = activeSidebarId === null ? isCurrentSrv
                                                  : s.id === activeSidebarId;

    const item = document.createElement('div');
    item.className = 'session-item' + (isActive ? ' active' : '') + (isNamed ? ' named' : '');
    item.dataset.sessionId = s.id;

    const label = sessionLabel(s);
    const meta  = [
        s.request_count != null ? `${s.request_count} reqs` : '',
        sessionDateStr(s),
    ].filter(Boolean).join(' · ');

    const proxyHint = s.proxy_info
        ? `<div class="si-proxy">${esc(s.proxy_info.replace(/:[^:@]+@/, ':***@'))}</div>`
        : '';

    item.innerHTML = `
        <div class="si-name-row">
            <span class="si-name" title="${esc(label)}">${esc(label)}</span>
            ${isCurrentSrv ? '<span class="si-live-badge">● LIVE</span>' : ''}
            <span class="si-actions">
                <button class="si-act-btn si-rename-btn" title="Rename session">✎</button>
                <button class="si-act-btn si-newwin-btn" title="Open in new window">↗</button>
                ${!isCurrentSrv ? '<button class="si-act-btn si-del-btn" title="Delete session">🗑</button>' : ''}
            </span>
        </div>
        <div class="si-meta">${esc(meta)}</div>
        ${proxyHint}`;

    item.addEventListener('click', (e) => {
        if (e.target.closest('.si-act-btn')) return;
        activateSidebarSession(s.id, isCurrentSrv);
    });

    item.querySelector('.si-rename-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        startRenameSession(item, s);
    });

    item.querySelector('.si-newwin-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        api.openSessionInNewWindow(s.id).catch(() => {});
    });

    item.querySelector('.si-del-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const count = s.request_count ?? 0;
        if (count > 1) {
            const delLabel = s.notes ? `"${s.notes}"` : `Session #${s.id}`;
            const ok = window.confirm(
                `Delete ${delLabel}?\n\nThis will permanently remove ${count} requests. This cannot be undone.`
            );
            if (!ok) return;
        }
        item.style.opacity = '0.4';
        item.style.pointerEvents = 'none';
        const res = await api.deleteSession(s.id).catch(() => null);
        if (res?.success === false && res?.reason === 'active') {
            item.style.opacity = '';
            item.style.pointerEvents = '';
            return;
        }
        if (activeSidebarId === s.id) {
            sessionFilterMode = null;
            activeSidebarId = null;
        }
        await loadSessionSidebar();
    });

    sessionListEl.appendChild(item);
}

function renderSessionList() {
    if (!sessionListEl) return;
    sessionListEl.innerHTML = '';

    if (!sidebarSessions.length) {
        sessionListEl.innerHTML = '<div style="padding:12px 10px;color:var(--text-dim);font-size:11px">No recorded sessions yet</div>';
        return;
    }

    const sorted = [...sidebarSessions].sort((a, b) => {
        const aNamed = !!a.notes, bNamed = !!b.notes;
        if (aNamed !== bNamed) return bNamed ? 1 : -1;
        return b.started_at > a.started_at ? 1 : b.started_at < a.started_at ? -1 : 0;
    });

    const named = sorted.filter(s => !!s.notes);
    const unnamed = sorted.filter(s => !s.notes);

    for (const s of named) { appendSessionItem(s); }

    if (unnamed.length) {
        if (named.length) {
            const sep = document.createElement('div');
            sep.style.cssText = 'height:1px;background:var(--border2);margin:4px 0;opacity:0.5';
            sessionListEl.appendChild(sep);
        }
        const wrap = document.createElement('div');
        wrap.className = 'si-delete-unnamed-wrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'si-delete-unnamed-btn';
        btn.textContent = 'Delete all unnamed sessions…';
        const totalUnnamedReqs = unnamed.reduce((a, s) => a + (s.request_count || 0), 0);
        btn.title = `${unnamed.length} session(s), ${totalUnnamedReqs} request(s) (current LIVE recording session is not removed)`;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = window.confirm(
                `Delete all unnamed sessions (${unnamed.length} session(s), ${totalUnnamedReqs} request(s))?\n\n` +
                `The active recording session will not be deleted.\nThis cannot be undone.`
            );
            if (!ok) return;
            btn.disabled = true;
            try {
                const res = await api.deleteUnnamedSessions().catch(() => null);
                if (res?.success === false) return;
                if (activeSidebarId != null && unnamed.some(u => u.id === activeSidebarId)) {
                    sessionFilterMode = null;
                    activeSidebarId = null;
                }
                await loadSessionSidebar();
            } finally {
                btn.disabled = false;
            }
        });
        wrap.appendChild(btn);
        sessionListEl.appendChild(wrap);

        for (const s of unnamed) { appendSessionItem(s); }
    }
}

function startRenameSession(itemEl, s) {
    const nameSpan = itemEl.querySelector('.si-name');
    const input    = document.createElement('input');
    input.type     = 'text';
    input.className = 'si-name-edit';
    input.value    = s.notes || '';
    input.placeholder = `Session #${s.id}`;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
        const newName = input.value.trim();
        s.notes = newName || null;
        await api.renameSession(s.id, newName || null).catch(() => {});
        renderSessionList();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { s.notes = s.notes; input.blur(); } // revert
    });
}

let _activatingSession = false; // guard against concurrent activations

async function activateSidebarSession(sessionId, isLive) {
    if (_activatingSession) return;
    _activatingSession = true;

    // Mark the clicked item as loading immediately for visual feedback
    const clickedItem = sessionListEl?.querySelector(`[data-session-id="${sessionId}"]`);
    if (clickedItem) clickedItem.classList.add('loading');

    try {
        activeSidebarId   = isLive ? null : sessionId;
        sessionFilterMode = isLive ? null : sessionId; // drives entryPassesFilter directly

        // Clear view
        allEntries = []; filteredEntries = []; selectedIndex = -1;
        selectedRequestIds.clear();
        selectionAnchorIdx = -1;
        updateSessionFromSelButton();
        knownTabs.clear();
        if (detailEmpty) detailEmpty.style.display = '';
        if (detailPanel) detailPanel.style.display = 'none';

        if (isLive) {
            currentSessionId = null;
            autoScrollEnabled = true;
            autoScrollBtn?.classList.add('active');
            if (autoScrollBtn) autoScrollBtn.textContent = '↓ Live';
            try {
                const logs = await api.getExistingLogs();
                if (logs?.length) {
                    for (const l of logs) {
                        allEntries.push(l);
                        if (l.tabId || l.tab_id) knownTabs.add(l.tabId || l.tab_id);
                    }
                }
            } catch (e) { console.error('[sidebar] getExistingLogs:', e); }
        } else {
            currentSessionId = sessionId;
            autoScrollEnabled = false;
            autoScrollBtn?.classList.remove('active');
            if (autoScrollBtn) autoScrollBtn.textContent = '↓ Paused';
            try {
                // queryRequests returns DESC; reverse to chronological
                const rows = await api.getDbRequests({ sessionId }, 5000, 0);
                if (rows?.length) {
                    const ordered = rows.slice().reverse();
                    for (const l of ordered) {
                        allEntries.push(l);
                        if (l.tabId || l.tab_id) knownTabs.add(l.tabId || l.tab_id);
                    }
                }
            } catch (e) { console.error('[sidebar] getDbRequests:', e); }
        }

        updateTabFilter();
        await applyFilters();
        renderSessionList();
        scrollToBottom();
    } finally {
        _activatingSession = false;
    }
}

async function loadSessionSidebar() {
    try {
        [sidebarSessions, currentSrvSessId] = await Promise.all([
            api.getSessionsWithStats().catch(() => []),
            api.getCurrentSessionId().catch(() => null),
        ]);
        renderSessionList();
    } catch (e) { console.error('loadSessionSidebar:', e); }
}

async function loadSessions() {
    // Legacy: just delegate to sidebar loader
    await loadSessionSidebar();
}

// ─── Entry detail ─────────────────────────────────────────────────────────────
let _selectGen = 0;
let _currentDetailEntry = null;
async function selectEntry(idx) {
    flushCommentAutosave();
    if (idx < 0 || idx >= filteredEntries.length) return;
    detailPanel?.classList.remove('multi-sel');
    selectedRequestIds.clear();
    const ent0 = filteredEntries[idx];
    if (ent0?.id && String(ent0.type || '').toLowerCase() !== 'screenshot' && !ent0._browserEvent) {
        selectedRequestIds.add(ent0.id);
    }
    selectionAnchorIdx = idx;
    updateSessionFromSelButton();
    if (selectedIndex >= 0 && selectedIndex < filteredEntries.length) {
        const prev = filteredEntries[selectedIndex];
        if (prev?._detailLoaded) {
            delete prev.requestBody;
            delete prev.responseBody;
            prev._detailLoaded = false;
        }
    }
    selectedIndex = idx;
    const gen = ++_selectGen;
    renderVirtual();
    ensureVisible(idx);
    const entry = filteredEntries[idx];
    showDetail(entry);
    if (entry.type !== 'screenshot' && !entry._browserEvent && entry.id && !entry._detailLoaded) {
        try {
            const full = await api.getRequestDetail(entry.id);
            if (full) {
                Object.assign(entry, normalizeRequestDetailRow(full));
                entry._detailLoaded = true;
                if (gen === _selectGen) showDetail(entry);
            }
        } catch (e) { console.error('[log-viewer] detail fetch/render error', e); }
    }
}

function showDetail(entry) {
    ensureAnnotationFields(entry);
    _currentDetailEntry = entry;
    detailEmpty.style.display = 'none';
    detailPanel.style.display = 'flex';

    const status = entry.status ?? entry.response?.statusCode;
    const method = entry.method || '';
    const type   = entry.type   || '';
    const url    = entry.url    || '';
    const dur    = entry.duration_ms ?? entry.duration;

    renderDetailRequestLine(entry);
    if (lvDetailIdStrip) lvDetailIdStrip.style.display = '';

    const dStatus = document.getElementById('d-status');
    dStatus.textContent = status || (entry.error ? 'Error' : '—');
    dStatus.className   = `meta-val lv-status ${entry.error ? 's-err' : statusCls(status)}`;

    const cupnetSessMeta = getCupnetSessionTrafficPresentation(entry);
    document.getElementById('d-type').textContent = cupnetSessMeta
        ? cupnetSessMeta.host
        : (shortTypeLabel(type) || type || '—');
    document.getElementById('d-duration').textContent = formatDur(dur);
    document.getElementById('d-time').textContent     = formatTime(entry.created_at || entry.timestamp);

    // Replay bar
    const canAnnotate = entry.id && !String(entry.id).startsWith('ss-') && !entry._browserEvent;
    const showReplay = entry.id && !type.startsWith('websocket') && type !== 'screenshot' && type !== 'cupnet' && !entry._browserEvent;
    const showToolbar = showReplay || canAnnotate;
    replayBar.classList.toggle('visible', showToolbar);
    if (toolbarActions) toolbarActions.style.display = showReplay ? '' : 'none';
    if (sepActionsMark) sepActionsMark.hidden = !(showReplay && canAnnotate);
    if (markSection) markSection.classList.toggle('visible', !!canAnnotate);
    if (showReplay) replayBtn.dataset.entryId = entry.id;
    replayResult.classList.remove('visible');
    replayDiff.textContent = '';

    // Copy URL
    copyUrlBtn.onclick = () => {
        navigator.clipboard.writeText(url).catch(() => {});
        flashBtn(copyUrlBtn, '✓');
    };
    if (addToCompareBtn) {
        addToCompareBtn.style.display = showReplay ? '' : 'none';
        addToCompareBtn.onclick = () => openCompareSidePickerForEntry(entry);
    }
    if (openCompareBtn) {
        openCompareBtn.style.display = showReplay ? '' : 'none';
        openCompareBtn.onclick = () => api.openCompareViewer?.();
    }

    const ssDirect  = document.getElementById('lv-screenshot-direct');
    const lvTabs    = document.getElementById('lv-tabs');
    const lvTabBody = document.getElementById('lv-tab-body');
    const metaRow   = document.getElementById('lv-detail-meta');

    if (type === 'screenshot') {
        lvTabs.style.display = 'none';
        lvTabBody.style.display = 'none';
        if (detailFindBar) detailFindBar.style.display = 'none';
        if (lvDetailIdStrip) lvDetailIdStrip.style.display = '';
        if (metaRow) metaRow.style.display = 'none';
        replayBar.style.display = 'none';
        if (markSection) markSection.classList.remove('visible');
        ssDirect.style.display = '';
        ssDirect.innerHTML = '<div class="body-empty" id="ss-loading">⏳ Loading…</div>';
        const ssMeta = getScreenshotMeta(entry) || {};
        const ssTrigger = getScreenshotTrigger(entry);
        const ssTriggerLabel = screenshotTriggerLabel(ssTrigger);
        const click = ssMeta.click && Number.isFinite(Number(ssMeta.click.xNorm)) && Number.isFinite(Number(ssMeta.click.yNorm))
            ? { xNorm: Math.max(0, Math.min(1, Number(ssMeta.click.xNorm))), yNorm: Math.max(0, Math.min(1, Number(ssMeta.click.yNorm))) }
            : null;
        document.getElementById('d-type').textContent = ssTrigger ? `screenshot (${ssTriggerLabel})` : 'screenshot';

        const renderSS = (b64) => {
            if (!b64) { ssDirect.innerHTML = '<div class="body-empty">No screenshot data</div>'; return; }
            const marker = click
                ? `<span class="ss-click-marker" style="left:${(click.xNorm * 100).toFixed(3)}%;top:${(click.yNorm * 100).toFixed(3)}%" title="Click position"></span>`
                : '';
            ssDirect.innerHTML = `
                <div class="screenshot-wrap">
                    <div class="ss-action-bar">
                        <span class="ss-trigger-pill" title="Screenshot trigger">${esc(ssTriggerLabel)}</span>
                        <button class="body-act-btn" id="ss-copy-btn">⎘ Copy image</button>
                        <button class="body-act-btn" id="ss-save-btn">↓ Save PNG</button>
                    </div>
                    <div class="ss-preview-wrap">
                        <div class="ss-zoom-stage">
                            <img id="ss-preview-img" src="data:image/png;base64,${b64}" style="max-width:100%;border-radius:6px;border:1px solid var(--border);display:block">
                            ${marker}
                        </div>
                    </div>
                </div>`;
            enableScreenshotHoverZoom(document.querySelector('.ss-preview-wrap'));
            document.getElementById('ss-copy-btn')?.addEventListener('click', async () => {
                try {
                    const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob());
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                    flashBtn(document.getElementById('ss-copy-btn'), '✓ Copied');
                } catch { flashBtn(document.getElementById('ss-copy-btn'), '✗ Failed'); }
            });
            document.getElementById('ss-save-btn')?.addEventListener('click', () => {
                const a = document.createElement('a');
                a.href = `data:image/png;base64,${b64}`;
                a.download = `screenshot-${Date.now()}.png`;
                a.click();
            });
        };

        if (entry.imageData) {
            renderSS(entry.imageData);
        } else if (entry.ssDbId) {
            api.getScreenshotData(entry.ssDbId).then(renderSS).catch(() => {
                ssDirect.innerHTML = '<div class="body-empty">Failed to load screenshot</div>';
            });
        } else {
            ssDirect.innerHTML = '<div class="body-empty">No screenshot data</div>';
        }
        return;
    }

    if (entry._browserEvent) {
        const ssDirect = document.getElementById('lv-screenshot-direct');
        const lvTabs = document.getElementById('lv-tabs');
        const lvTabBody = document.getElementById('lv-tab-body');
        const metaRow = document.getElementById('lv-detail-meta');
        const eventTabBtn = document.getElementById('lv-tab-event-btn');
        if (ssDirect) ssDirect.style.display = 'none';
        if (lvTabs) lvTabs.style.display = '';
        if (lvTabBody) lvTabBody.style.display = '';
        if (detailFindBar) detailFindBar.style.display = '';
        if (metaRow) metaRow.style.display = '';
        replayBar.style.display = 'none';
        if (markSection) markSection.classList.remove('visible');
        if (eventTabBtn) eventTabBtn.style.display = '';
        document.querySelectorAll('.lv-tab-btn').forEach((b) => {
            if (b.dataset.tab === 'event') b.style.display = '';
            else b.style.display = 'none';
        });
        document.getElementById('d-status').textContent = browserActivityStatusLabel(entry.event_type, entry.level).text;
        document.getElementById('d-type').textContent = String(entry.type || 'browser');
        document.getElementById('d-duration').textContent = '—';
        document.getElementById('d-time').textContent = formatTime(entry.created_at || entry.timestamp);
        const evPre = document.getElementById('tab-event-body');
        if (evPre) {
            let pretty = String(entry.detail || '');
            let storageLine = '';
            try {
                const o = JSON.parse(pretty);
                if (o.storageKind) storageLine = `Storage: ${o.storageKind}\n`;
                pretty = JSON.stringify(o, null, 2);
            } catch { /* keep raw */ }
            const head = `Summary: ${entry.summary || ''}\n${storageLine}Source: ${entry.source_url || '—'}${entry.source_line != null ? ':' + entry.source_line : ''}\nOrigin: ${entry.origin || '—'}\n\n`;
            evPre.textContent = head + pretty;
        }
        const copyEv = document.getElementById('tab-event-copy-btn');
        if (copyEv) {
            copyEv.onclick = () => {
                const t = document.getElementById('tab-event-body')?.textContent || '';
                navigator.clipboard.writeText(t).then(() => {
                    copyEv.textContent = '✓ Copied';
                    setTimeout(() => { copyEv.textContent = '⎘ Copy'; }, 1500);
                }).catch(() => {});
            };
        }
        activateTab('event', false);
        lastActiveTab = 'event';
        scheduleDetailFindRefresh();
        return;
    }

    const eventTabBtnHide = document.getElementById('lv-tab-event-btn');
    if (eventTabBtnHide) eventTabBtnHide.style.display = 'none';

    lvTabs.style.display = '';
    lvTabBody.style.display = '';
    if (detailFindBar) detailFindBar.style.display = '';
    ssDirect.style.display = 'none';
    if (metaRow) metaRow.style.display = '';
    replayBar.style.display = '';
    if (canAnnotate) syncMarkPanel(entry);

    document.querySelectorAll('.lv-tab-btn').forEach((b) => {
        if (b.dataset.tab === 'event') b.style.display = 'none';
        else b.style.display = '';
    });

    const msgTabBtn = document.getElementById('lv-tab-messages-btn');
    const isWsHandshake = String(type || '').toLowerCase() === 'websocket';
    if (msgTabBtn) {
        msgTabBtn.style.display = isWsHandshake ? '' : 'none';
        if (!isWsHandshake) {
            const msgContent = document.getElementById('tab-messages');
            if (msgContent?.classList.contains('active')) {
                activateTab('headers', false);
                lastActiveTab = 'headers';
            }
        }
    }

    // Parse headers once
    const parsedReqHeaders  = parseHeaders(entry.request_headers  || entry.request?.headers);
    const parsedRespHeaders = parseHeaders(entry.response_headers || entry.response?.headers);

    // Headers
    renderHeaders(document.getElementById('request-headers'), parsedReqHeaders, 'req-headers');
    renderHeaders(document.getElementById('response-headers'), parsedRespHeaders, 'resp-headers');
    injectViewToggle(
        document.querySelector('#tab-headers .hdr-section:first-child .hdr-section-title'),
        'req-headers',
        () => renderHeaders(document.getElementById('request-headers'), parsedReqHeaders, 'req-headers'),
    );
    injectViewToggle(
        document.querySelector('#tab-headers .hdr-section:last-child .hdr-section-title'),
        'resp-headers',
        () => renderHeaders(document.getElementById('response-headers'), parsedRespHeaders, 'resp-headers'),
    );

    // Copy headers as JSON buttons
    const reqHdrCopyBtn  = document.getElementById('req-hdr-copy-btn');
    const respHdrCopyBtn = document.getElementById('resp-hdr-copy-btn');
    if (reqHdrCopyBtn) {
        reqHdrCopyBtn.style.display = parsedReqHeaders && Object.keys(parsedReqHeaders).length ? '' : 'none';
        reqHdrCopyBtn.onclick = () => {
            navigator.clipboard.writeText(headersToJson(parsedReqHeaders)).then(
                () => flashBtn(reqHdrCopyBtn, '✓'), () => flashBtn(reqHdrCopyBtn, '✗'));
        };
    }
    if (respHdrCopyBtn) {
        respHdrCopyBtn.style.display = parsedRespHeaders && Object.keys(parsedRespHeaders).length ? '' : 'none';
        respHdrCopyBtn.onclick = () => {
            navigator.clipboard.writeText(headersToJson(parsedRespHeaders)).then(
                () => flashBtn(respHdrCopyBtn, '✓'), () => flashBtn(respHdrCopyBtn, '✗'));
        };
    }

    // ── Query parameters (from URL) ──────────────────────────────────────────
    const qpSection = document.getElementById('req-query-section');
    const qpWrap    = document.getElementById('query-params-wrap');
    let queryPairs = [];
    try {
        const u = new URL(url);
        queryPairs = [...u.searchParams.entries()].map(([k, v]) => ({ key: k, value: v }));
    } catch {}
    if (qpSection) {
        if (queryPairs.length) {
            qpSection.style.display = '';
            renderQueryParams(qpWrap, queryPairs);
            injectViewToggle(
                qpSection.querySelector('.body-toolbar'),
                'query-params',
                () => renderQueryParams(qpWrap, queryPairs),
            );
            const qpCopyObj  = document.getElementById('qp-copy-obj-btn');
            const qpCopyText = document.getElementById('qp-copy-text-btn');
            if (qpCopyObj) qpCopyObj.onclick = () => {
                const obj = {};
                for (const p of queryPairs) obj[p.key] = p.value;
                navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).then(
                    () => flashBtn(qpCopyObj, '✓'), () => flashBtn(qpCopyObj, '✗'));
            };
            if (qpCopyText) qpCopyText.onclick = () => {
                navigator.clipboard.writeText(queryPairs.map(p => `${p.key}=${p.value}`).join('\n')).then(
                    () => flashBtn(qpCopyText, '✓'), () => flashBtn(qpCopyText, '✗'));
            };
        } else {
            qpSection.style.display = 'none';
        }
    }

    // ── Request body ─────────────────────────────────────────────────────────
    const reqBodyStored = pickRequestBodyRaw(entry);
    const reqDecoded    = decodeStoredBody(reqBodyStored, findHeader(parsedReqHeaders, 'content-type'));
    const reqBodyText   = reqDecoded.text;
    const reqCtRaw      = findHeader(parsedReqHeaders, 'content-type') || '';
    const reqCt         = reqCtRaw.toLowerCase();
    const reqWrap       = document.getElementById('request-body-wrap');
    const reqSizeEl     = document.getElementById('req-body-size');
    const reqBadge      = document.getElementById('req-body-type-badge');
    const reqCopyJsonBtn = document.getElementById('req-copy-json-btn');
    const missingBodyMsg = requestBodyMissingMessage(entry, parsedReqHeaders, method, reqBodyStored);

    if (reqSizeEl) {
        if (reqBodyText) {
            reqSizeEl.textContent = formatFileSize(reqDecoded.bytes || reqBodyText.length);
        } else if (reqDecoded.fromB64 && reqDecoded.bytes > 0) {
            reqSizeEl.textContent = formatFileSize(reqDecoded.bytes);
        } else if (missingBodyMsg) {
            const cl = findHeader(parsedReqHeaders, 'content-length');
            const clNum = cl != null ? parseInt(String(cl), 10) : NaN;
            reqSizeEl.textContent = Number.isFinite(clNum) && clNum > 0
                ? `Not stored · ~${formatFileSize(clNum)}`
                : 'Not stored';
        } else {
            reqSizeEl.textContent = 'No body';
        }
    }

    const isFormEncoded  = reqCt.includes('application/x-www-form-urlencoded');
    const isMultipart    = reqCt.includes('multipart/form-data');
    const isJsonBody     = reqCt.includes('application/json') || reqCt.includes('+json');
    const formPairs      = (isFormEncoded && reqBodyText) ? parseFormBody(reqBodyText) : null;
    const multipartParts = (isMultipart && reqBodyText) ? parseMultipartBody(reqBodyText, reqCtRaw) : null;
    const copyPairs      = (formPairs && formPairs.length)
        ? formPairs
        : ((multipartParts && multipartParts.length) ? multipartPartsToCopyPairs(multipartParts) : null);

    // Badge
    if (reqBadge) {
        if (isFormEncoded)      { reqBadge.textContent = 'form-urlencoded'; reqBadge.style.display = ''; }
        else if (isMultipart)   { reqBadge.textContent = 'multipart/form-data'; reqBadge.style.display = ''; }
        else if (isJsonBody)    { reqBadge.textContent = 'application/json'; reqBadge.style.display = ''; }
        else if (reqBodyStored && reqCt) { reqBadge.textContent = reqCt.split(';')[0].trim(); reqBadge.style.display = ''; }
        else if (missingBodyMsg && reqCt) { reqBadge.textContent = reqCt.split(';')[0].trim(); reqBadge.style.display = ''; }
        else                    { reqBadge.style.display = 'none'; }
    }

    // JSON copy button
    if (reqCopyJsonBtn) {
        reqCopyJsonBtn.style.display = (isJsonBody && reqBodyText) ? '' : 'none';
        if (isJsonBody && reqBodyText) {
            reqCopyJsonBtn.onclick = () => {
                try {
                    const pretty = JSON.stringify(JSON.parse(reqBodyText), null, 2);
                    navigator.clipboard.writeText(pretty).then(
                        () => flashBtn(reqCopyJsonBtn, '✓'), () => flashBtn(reqCopyJsonBtn, '✗'));
                } catch {
                    navigator.clipboard.writeText(reqBodyText).then(
                        () => flashBtn(reqCopyJsonBtn, '✓'), () => flashBtn(reqCopyJsonBtn, '✗'));
                }
            };
        }
    }

    if (formPairs && formPairs.length) {
        renderFormBody(reqWrap, formPairs, reqBodyText);
    } else if (multipartParts && multipartParts.length) {
        renderMultipartBody(reqWrap, multipartParts, reqCtRaw);
    } else if (isJsonBody && reqBodyText) {
        renderJsonBody(reqWrap, reqBodyText, 'req-body-json');
    } else if (isMultipart && reqBodyText) {
        const preview = reqBodyText.length > 4000 ? reqBodyText.slice(0, 4000) + '\n… [truncated]' : reqBodyText;
        reqWrap.innerHTML = `<div class="body-content"><pre style="margin:0;white-space:pre-wrap;word-break:break-word">${esc(preview)}</pre></div>`;
    } else if (reqDecoded.fromB64 && reqBodyText == null) {
        const hint = reqDecoded.decodeError
            ? `[Binary body — base64 decode failed (${formatFileSize(String(reqDecoded.b64Data || '').length)} encoded) · try ↓ Save]`
            : `[Binary body — ${formatFileSize(reqDecoded.bytes)} · use ↓ Save]`;
        reqWrap.innerHTML = `<div class="body-content" style="color:var(--text-dim)">${esc(hint)}</div>`;
    } else if (missingBodyMsg) {
        reqWrap.innerHTML = `<div class="body-content" style="color:var(--text-dim);padding:12px;line-height:1.45">${esc(missingBodyMsg)}</div>`;
    } else {
        const reqFmt = formatBody(reqBodyText || reqBodyStored);
        if (reqFmt) {
            reqWrap.innerHTML = `<div class="body-content">${esc(reqFmt)}</div>`;
        } else if (!queryPairs.length) {
            reqWrap.innerHTML = '<span style="padding:14px;color:var(--text-dim);font-style:italic;display:block">(empty)</span>';
        } else {
            reqWrap.innerHTML = '';
        }
    }

    // Wire up request body toolbar buttons
    wireReqBodyBtns(reqBodyText || reqBodyStored, copyPairs, {
        fromB64: reqDecoded.fromB64,
        b64Data: reqDecoded.b64Data,
        contentType: reqCtRaw,
        storedRaw: reqBodyStored,
    });

    // Raw HTTP tab (curl -v style + curl command); WebSocket: append frames from DB
    const rawEl = document.getElementById('raw-http-content');
    const rawWrap = rawEl?.closest('.lv-tab-content');
    if (rawEl) {
        const isWs = String(entry.type || '').toLowerCase() === 'websocket';
        const setRawText = (wsExtra) => {
            const text = buildRawHttp(entry) + (wsExtra || '');
            rawEl.textContent = text;
            if (rawWrap) rawWrap.dataset.curl = buildCurlCommand(entry);
            updateRawTabBadgeFromText(text);
            scheduleDetailFindRefresh();
        };
        setRawText('');
        if (isWs && api.getWsEvents) {
            const sid = entry.session_id ?? entry.sessionId ?? currentSessionId;
            const tid = entry.tabId ?? entry.tab_id ?? null;
            const url = entry.url || '';
            const gen = ++_rawWsGen;
            api.getWsEvents({ sessionId: sid, tabId: tid, url })
                .then((rows) => {
                    if (gen !== _rawWsGen || _currentDetailEntry !== entry) return;
                    setRawText(formatWebSocketRawLog(rows || []));
                })
                .catch(() => {
                    if (gen !== _rawWsGen || _currentDetailEntry !== entry) return;
                    setRawText('\n\n──────── WEBSOCKET RAW ────────\n(failed to load frames)\n');
                });
        }
    }

    // Response body
    resetResponseHtmlViews();
    let respBody   = entry.response_body || entry.responseBody;
    let respParsed = respBody ? parseBase64Body(respBody) : null;
    let respFmt    = respParsed ? null : formatBody(respBody);
    const respWrap   = document.getElementById('response-body-wrap');
    const respSizeEl = document.getElementById('resp-body-size');

    // Determine content type for Save
    const respCt  = (findHeader(parsedRespHeaders, 'content-type') || '').toLowerCase();

    // Decode binary-wrapped text types (e.g. application/rdap+json)
    if (respParsed) {
        const binaryMime = (respParsed.mime || respCt.split(';')[0].trim() || '').toLowerCase();
        const isTextMime = binaryMime.endsWith('+json') || binaryMime.endsWith('+xml') || binaryMime.includes('json') ||
            binaryMime.startsWith('text/') || binaryMime.includes('javascript') || binaryMime.includes('xml') || binaryMime.includes('svg');
        if (isTextMime) {
            try {
                const decoded = decodeURIComponent(escape(atob(respParsed.data)));
                respBody = decoded;
                respFmt  = formatBody(decoded);
                respParsed = null;
            } catch { /* keep as binary */ }
        }
    }

    if (respSizeEl) {
        if (respParsed) {
            try { respSizeEl.textContent = formatFileSize(atob(respParsed.data).length); }
            catch { respSizeEl.textContent = 'Binary'; }
        } else {
            respSizeEl.textContent = respBody ? `${(respBody.length / 1024).toFixed(1)} KB` : 'No body';
        }
    }

    const isImage = respParsed && respParsed.mime && respParsed.mime.startsWith('image/');
    const isJson  = !isImage && (respCt.includes('json') || (respFmt && respFmt.trimStart().startsWith('{') || respFmt?.trimStart().startsWith('[')));
    const isHtml  = !isImage && looksLikeHtmlResponse(respFmt || respBody || '', respCt);

    if (respParsed) {
        const binaryMime = respParsed.mime || respCt.split(';')[0].trim() || 'application/octet-stream';
        const fileInfo = guessFileInfo(url, binaryMime);
        const rawBytes = atob(respParsed.data);
        const sizeStr  = formatFileSize(rawBytes.length);
        const isImg    = binaryMime.startsWith('image/') && !binaryMime.includes('svg');

        if (isImg) {
            const src = `data:${binaryMime};base64,${respParsed.data}`;
            respWrap.innerHTML = `
                <div class="screenshot-wrap">
                    <div class="ss-action-bar">
                        <span style="font-size:10px;color:var(--text-dim);margin-right:4px">${esc(binaryMime)} · ${sizeStr}</span>
                        <button class="body-act-btn" id="img-copy-btn">⎘ Copy image</button>
                        <button class="body-act-btn" id="img-save-btn">↓ Save .${esc(fileInfo.ext)}</button>
                    </div>
                    <img id="resp-img-preview" src="${src}" style="max-width:100%;border-radius:6px;border:1px solid var(--border);display:block">
                </div>`;
            document.getElementById('img-copy-btn')?.addEventListener('click', async () => {
                try {
                    const blob = await fetch(src).then(r => r.blob());
                    await navigator.clipboard.write([new ClipboardItem({ [binaryMime]: blob })]);
                    flashBtn(document.getElementById('img-copy-btn'), '✓ Copied');
                } catch { flashBtn(document.getElementById('img-copy-btn'), '✗ Failed'); }
            });
            document.getElementById('img-save-btn')?.addEventListener('click', () => {
                const a = document.createElement('a');
                a.href = src; a.download = `image-${Date.now()}.${fileInfo.ext}`; a.click();
            });
        } else {
            respWrap.innerHTML = `
                <div style="padding:20px 14px;text-align:center">
                    <div style="font-size:36px;margin-bottom:8px;opacity:0.5">📦</div>
                    <div style="font-size:13px;font-weight:600;color:var(--text)">${esc(fileInfo.ext.toUpperCase())} file</div>
                    <div style="font-size:11px;color:var(--text-dim);margin:4px 0">${esc(binaryMime)} · ${sizeStr}</div>
                    <button class="body-act-btn" id="bin-save-btn" style="margin-top:10px;padding:6px 18px;font-size:12px">↓ Save .${esc(fileInfo.ext)}</button>
                </div>`;
            document.getElementById('bin-save-btn')?.addEventListener('click', () => {
                const bytes = Uint8Array.from(atob(respParsed.data), c => c.charCodeAt(0));
                const blob = new Blob([bytes], { type: binaryMime });
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl; a.download = `file-${Date.now()}.${fileInfo.ext}`; a.click();
                setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
            });
        }
    } else {
        if (respFmt) {
            if (isJson) {
                renderJsonBody(respWrap, respFmt, 'resp-body-json');
            } else {
                respWrap.innerHTML = `<div class="body-content">${esc(respFmt)}</div>`;
            }
            if (isHtml) setupResponseHtmlViews(respFmt, respCt, url);
        } else {
            respWrap.innerHTML = '<div class="body-empty">(empty)</div>';
        }
    }

    // Wire up Copy / Save buttons for response toolbar
    const respCopyBtn = document.getElementById('resp-copy-btn');
    const respSaveBtn = document.getElementById('resp-save-btn');
    const hasTextBody = type !== 'screenshot' && !respParsed && !!respFmt;
    if (respCopyBtn) {
        respCopyBtn.onclick = hasTextBody ? () => {
            navigator.clipboard.writeText(respFmt).then(
                () => flashBtn(respCopyBtn, '✓ Copied'),
                () => flashBtn(respCopyBtn, '✗ Failed')
            );
        } : null;
        respCopyBtn.style.display = hasTextBody ? '' : 'none';
    }
    if (respSaveBtn) {
        if (hasTextBody) {
            const fi = guessFileInfo(url, respCt);
            const saveExt  = isJson ? 'json' : isHtml ? 'html' : (fi.ext !== 'bin' ? fi.ext : 'txt');
            const saveMime = isJson ? 'application/json' : isHtml ? 'text/html' : fi.mime;
            respSaveBtn.textContent = `↓ Save .${saveExt}`;
            respSaveBtn.onclick = () => {
                const blob = new Blob([respFmt], { type: saveMime });
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl; a.download = `response-${Date.now()}.${saveExt}`; a.click();
                setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
            };
            respSaveBtn.style.display = '';
        } else {
            respSaveBtn.style.display = 'none';
        }
    }

    // Render cookies tab
    renderCookiesTab(entry);

    clearDetailTabBadges();
    updateDetailTabBadges({
        headers: countHeaderEntries(parsedReqHeaders) + countHeaderEntries(parsedRespHeaders),
        request: countRequestTabItems(queryPairs, formPairs, multipartParts, reqBodyStored, reqBodyText, missingBodyMsg),
        response: countResponseTabItems(respFmt, respParsed, isHtml),
        comment: (entry.note || '').trim() ? 1 : 0,
    });
    updateRawTabBadgeFromText(buildRawHttp(entry));

    if (isWsHandshake && lastActiveTab === 'messages') {
        activateTab('messages', false);
    } else {
        activateTab(lastActiveTab);
    }
    scheduleDetailFindRefresh();
}

function syncMarkPanel(entry) {
    if (!entry) return;
    const tag = entry.tag || null;
    const note = entry.note || '';
    const hasNote = !!String(note).trim();
    if (notePreview) {
        notePreview.textContent = notePreviewText(note);
        notePreview.classList.toggle('has-note', hasNote);
    }
    if (commentTextarea) commentTextarea.value = note;
    tagColorsWrap?.querySelectorAll('.mark-color').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.color === tag);
    });
    setDetailTabBadge('comment', hasNote ? 1 : 0);
}

function flashMarkStatus(text, isError = false) {
    if (!markStatus) return;
    markStatus.textContent = text;
    markStatus.style.color = isError ? '#f87171' : '#4ade80';
    clearTimeout(flashMarkStatus._t);
    flashMarkStatus._t = setTimeout(() => {
        markStatus.textContent = '';
    }, 1800);
}

async function saveAnnotation({ tag, note }) {
    const entry = _currentDetailEntry;
    if (!entry || !entry.id || String(entry.id).startsWith('ss-')) return;
    const nextTag = tag !== undefined ? tag : (entry.tag || null);
    const nextNote = note !== undefined ? note : (entry.note || '');
    const res = await api.setRequestAnnotation(entry.id, { tag: nextTag, note: nextNote }).catch(() => ({ success: false }));
    if (!res || res.success === false) {
        flashMarkStatus('Save failed', true);
        return;
    }
    entry.tag = nextTag || null;
    entry.note = nextNote || '';
    entry.has_note = entry.note ? 1 : 0;
    renderVirtual();
    syncMarkPanel(entry);
    flashMarkStatus('Saved');
}

function saveCommentIfChanged() {
    const entry = _currentDetailEntry;
    if (!entry || !entry.id || String(entry.id).startsWith('ss-')) return;
    const next = (commentTextarea?.value || '').trim();
    const current = (entry.note || '').trim();
    if (next === current) return;
    saveAnnotation({ note: next });
}

function flushCommentAutosave() {
    if (_noteAutosaveTimer) {
        clearTimeout(_noteAutosaveTimer);
        _noteAutosaveTimer = null;
    }
    saveCommentIfChanged();
}

function setupMarkPanel() {
    if (!tagColorsWrap) return;
    tagColorsWrap.innerHTML = TAG_COLORS
        .map(c => `<button class="mark-color" data-color="${c}" style="background:${c}" title="${c}"></button>`)
        .join('');
    tagColorsWrap.addEventListener('click', (e) => {
        const btn = e.target.closest('.mark-color');
        if (!btn) return;
        saveAnnotation({ tag: btn.dataset.color });
    });
    tagClearBtn?.addEventListener('click', () => {
        saveAnnotation({ tag: null });
    });
    noteOpenBtn?.addEventListener('click', () => {
        activateTab('comment');
    });
    commentSaveBtn?.addEventListener('click', () => {
        flushCommentAutosave();
    });
    commentTextarea?.addEventListener('input', () => {
        if (_noteAutosaveTimer) clearTimeout(_noteAutosaveTimer);
        const entry = _currentDetailEntry;
        const next = (commentTextarea.value || '').trim();
        const current = (entry?.note || '').trim();
        if (next === current) {
            if (markStatus) markStatus.textContent = '';
            return;
        }
        flashMarkStatus('Saving...');
        _noteAutosaveTimer = setTimeout(() => {
            _noteAutosaveTimer = null;
            saveCommentIfChanged();
        }, NOTE_AUTOSAVE_MS);
    });
    commentTextarea?.addEventListener('blur', () => {
        flushCommentAutosave();
    });
    commentTextarea?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            flushCommentAutosave();
        }
    });
    const embedInNoteBtn = document.getElementById('lv-embed-in-note');
    embedInNoteBtn?.addEventListener('click', async () => {
        const entry = _currentDetailEntry;
        if (!entry?.id || String(entry.id).startsWith('ss-')) return;
        const reqHeaders = parseHeaders(entry.request_headers || entry.request?.headers);
        const respHeaders = parseHeaders(entry.response_headers || entry.response?.headers);
        const blockData = {
            kind: 'request',
            requestId: entry.id,
            sessionId: entry.session_id ?? entry.sessionId ?? null,
            url: entry.url || '',
            method: (entry.method || 'GET').toUpperCase(),
            status: entry.status ?? entry.response?.statusCode ?? null,
            statusText: entry.statusText ?? '',
            mimeType: entry.type || '',
            requestHeaders: reqHeaders,
            responseHeaders: respHeaders,
            requestBody: entry.request_body ?? entry.request?.body ?? null,
            responseBody: entry.response_body ?? entry.responseBody ?? null,
            responseSize: entry.response_size ?? entry.size ?? null,
            timing: entry.duration_ms ?? entry.duration ?? null,
            timestamp: entry.created_at ?? entry.timestamp ?? null,
            tlsVersion: entry.tls_version ?? null,
            protocol: entry.protocol ?? null,
        };
        try {
            await api.notesEmbedRequest(blockData);
            flashMarkStatus('Copied to note');
        } catch (e) {
            flashMarkStatus(String(e?.message || e), true);
        }
    });
}

function flashBtn(btn, text) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ─── Form body helpers ────────────────────────────────────────────────────────
/** Parse url-encoded body → [{key, value, rawKey, rawValue}] */
function parseFormBody(body) {
    if (!body) return [];
    try {
        return body.split('&').map(pair => {
            const eq = pair.indexOf('=');
            const rawKey = eq === -1 ? pair : pair.slice(0, eq);
            const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
            return {
                rawKey, rawValue: rawVal,
                key:   decodeURIComponent(rawKey.replace(/\+/g, ' ')),
                value: decodeURIComponent(rawVal.replace(/\+/g, ' ')),
            };
        }).filter(p => p.rawKey);
    } catch { return []; }
}

function extractMultipartBoundary(contentType, bodyText) {
    const ct = String(contentType || '');
    const m = ct.match(/boundary=([^;\s]+|"[^"]+"|'[^']+')/i);
    if (m) {
        let b = m[1].trim();
        if ((b.startsWith('"') && b.endsWith('"')) || (b.startsWith("'") && b.endsWith("'"))) {
            b = b.slice(1, -1);
        }
        return b;
    }
    const first = String(bodyText || '').match(/^--([^\r\n]+)/);
    return first ? first[1] : null;
}

/** Parse multipart/form-data body → [{ key, value, isFile?, filename?, contentType?, size? }] */
function parseMultipartBody(bodyText, contentType) {
    if (!bodyText) return [];
    const boundary = extractMultipartBoundary(contentType, bodyText);
    if (!boundary) return [];
    const delim = `--${boundary}`;
    const parts = [];
    for (const chunk of bodyText.split(delim)) {
        let c = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
        if (!c || c === '--' || c.startsWith('--')) continue;
        const sep = c.search(/\r\n\r\n|\n\n/);
        if (sep === -1) continue;
        const head = c.slice(0, sep);
        let body = c.slice(sep);
        body = body.replace(/^\r\n\r\n|^\n\n/, '').replace(/(?:\r\n|\n)--$/, '').replace(/\r\n$|\n$/, '');
        let name = '';
        let filename = null;
        let partCt = '';
        for (const line of head.split(/\r\n|\n/)) {
            const ll = line.toLowerCase();
            if (ll.startsWith('content-disposition:')) {
                const nm = line.match(/name="([^"]*)"/i) || line.match(/name=([^;\s]+)/i);
                const fn = line.match(/filename="([^"]*)"/i) || line.match(/filename=([^;\s]+)/i);
                if (nm) name = nm[1];
                if (fn) filename = fn[1];
            }
            if (ll.startsWith('content-type:')) {
                partCt = line.split(':').slice(1).join(':').trim();
            }
        }
        if (!name && !filename) continue;
        if (filename != null && filename !== '') {
            parts.push({
                key: name || filename,
                value: `[file: ${partCt || 'application/octet-stream'}, ${formatFileSize(body.length)}]`,
                isFile: true,
                filename,
                contentType: partCt,
                size: body.length,
                rawBinary: body,
                imageMime: sniffImageMime(body, partCt),
            });
        } else {
            const preview = body.length > 500 ? body.slice(0, 500) + '…' : body;
            parts.push({ key: name, value: preview, isFile: false, rawValue: body });
        }
    }
    return parts;
}

function multipartPartsToCopyPairs(parts) {
    return (parts || []).map((p) => ({
        key: p.key,
        value: p.isFile ? p.value : p.value,
        rawKey: p.key,
        rawValue: p.isFile ? p.value : (p.rawValue ?? p.value),
    }));
}

const LV_FIELD_PREVIEW_CHARS = 200;

function getLvViewMode(sectionKey) {
    try {
        const v = localStorage.getItem(`cupnet.lv.view.${sectionKey}`);
        if (v === 'table' || v === 'fields') return v;
    } catch { /* ignore */ }
    return 'fields';
}

function setLvViewMode(sectionKey, mode) {
    try { localStorage.setItem(`cupnet.lv.view.${sectionKey}`, mode); } catch { /* ignore */ }
}

function createViewModeToggle(sectionKey, onChange) {
    const wrap = document.createElement('span');
    wrap.className = 'lv-view-toggle';
    const current = getLvViewMode(sectionKey);
    for (const mode of ['fields', 'table']) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lv-view-toggle-btn' + (current === mode ? ' active' : '');
        btn.textContent = mode === 'fields' ? 'Fields' : 'Table';
        btn.dataset.mode = mode;
        btn.title = mode === 'fields' ? 'Compact field list' : 'Table view';
        btn.addEventListener('click', () => {
            if (getLvViewMode(sectionKey) === mode) return;
            setLvViewMode(sectionKey, mode);
            wrap.querySelectorAll('.lv-view-toggle-btn').forEach((b) => {
                b.classList.toggle('active', b.dataset.mode === mode);
            });
            onChange(mode);
        });
        wrap.appendChild(btn);
    }
    return wrap;
}

function injectViewToggle(titleEl, sectionKey, onRerender) {
    if (!titleEl || !sectionKey) return;
    let host = titleEl.querySelector('.lv-view-toggle-host');
    if (!host) {
        host = document.createElement('span');
        host.className = 'lv-view-toggle-host';
        const copyBtn = titleEl.querySelector('.hdr-copy-btn, .ck-copy-btn');
        const flexSpacer = titleEl.querySelector('span[style*="flex:1"], span[style*="flex: 1"]');
        if (copyBtn) titleEl.insertBefore(host, copyBtn);
        else if (flexSpacer) titleEl.insertBefore(host, flexSpacer);
        else titleEl.appendChild(host);
    }
    host.innerHTML = '';
    host.appendChild(createViewModeToggle(sectionKey, onRerender));
}

function createFieldList() {
    const el = document.createElement('div');
    el.className = 'lv-field-list';
    return el;
}

function createFieldValueBlock(text, opts = {}) {
    const previewChars = opts.previewChars ?? LV_FIELD_PREVIEW_CHARS;
    const wrap = document.createElement('div');
    wrap.className = 'lv-field-val-wrap';
    const full = text == null ? '' : String(text);
    const pre = document.createElement('pre');
    pre.className = 'lv-field-val lv-kv-value';
    if (!full) {
        pre.textContent = opts.emptyLabel || '(empty)';
        pre.classList.add('is-empty');
        wrap.appendChild(pre);
        return wrap;
    }
    if (full.length <= previewChars) {
        pre.textContent = full;
        wrap.appendChild(pre);
        return wrap;
    }
    pre.textContent = `${full.slice(0, previewChars)}…`;
    const foot = document.createElement('div');
    foot.className = 'lv-field-val-foot';
    const note = document.createElement('span');
    note.className = 'lv-field-val-len';
    note.textContent = `(${full.length} chars)`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lv-field-expand body-act-btn';
    btn.textContent = 'Expand';
    let open = false;
    btn.addEventListener('click', () => {
        open = !open;
        pre.textContent = open ? full : `${full.slice(0, previewChars)}…`;
        btn.textContent = open ? 'Collapse' : 'Expand';
    });
    foot.appendChild(note);
    foot.appendChild(btn);
    wrap.appendChild(pre);
    wrap.appendChild(foot);
    return wrap;
}

function appendFieldBadges(parent, badges) {
    if (!badges?.length) return;
    const row = document.createElement('div');
    row.className = 'lv-field-badges';
    for (const badge of badges) {
        const span = document.createElement('span');
        span.className = 'lv-field-badge' + (badge.cls ? ` ${badge.cls}` : '');
        span.textContent = badge.text;
        row.appendChild(span);
    }
    parent.appendChild(row);
}

function appendFieldMeta(parent, lines) {
    const items = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
    if (!items.length) return;
    const meta = document.createElement('div');
    meta.className = 'lv-field-meta';
    for (const line of items) {
        const row = document.createElement('div');
        row.className = 'lv-field-meta-line';
        if (typeof line === 'string') row.textContent = line;
        else row.innerHTML = line;
        meta.appendChild(row);
    }
    parent.appendChild(meta);
}

function appendWireValueSection(parent, wireValue) {
    if (wireValue == null) return;
    const wire = String(wireValue);
    const det = document.createElement('details');
    det.className = 'lv-field-wire';
    const sum = document.createElement('summary');
    sum.textContent = 'Wire value (URL-encoded)';
    det.appendChild(sum);
    det.appendChild(createFieldValueBlock(wire));
    const actions = document.createElement('div');
    actions.className = 'lv-field-wire-act';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'lv-field-copy body-act-btn';
    copyBtn.title = 'Copy wire value';
    copyBtn.textContent = '⎘';
    copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(wire).then(
            () => flashBtn(copyBtn, '✓'),
            () => flashBtn(copyBtn, '✗'),
        );
    });
    actions.appendChild(copyBtn);
    det.appendChild(actions);
    parent.appendChild(det);
}

function appendValueCellContent(parent, row, displayText) {
    const s = displayText == null ? '' : String(displayText);
    parent.appendChild(createFieldValueBlock(s));
    if (row.wireValue != null && String(row.wireValue) !== s) {
        appendWireValueSection(parent, row.wireValue);
    }
}

function createFieldCard({ key, subkey, value, meta, badges, footer, copyValue, wireValue }) {
    const card = document.createElement('div');
    card.className = 'lv-field-card lv-kv-field';

    const head = document.createElement('div');
    head.className = 'lv-field-head lv-kv-field-head';

    const keyBox = document.createElement('div');
    keyBox.className = 'lv-field-keybox';
    const keyEl = document.createElement('div');
    keyEl.className = 'lv-field-key lv-kv-label';
    keyEl.textContent = key;
    keyBox.appendChild(keyEl);
    if (subkey) {
        const sub = document.createElement('div');
        sub.className = 'lv-field-subkey lv-kv-subkey';
        sub.textContent = subkey;
        keyBox.appendChild(sub);
    }
    head.appendChild(keyBox);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'lv-field-copy body-act-btn';
    copyBtn.title = 'Copy value';
    copyBtn.textContent = '⎘';
    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(String(copyValue ?? value ?? '')).then(
            () => flashBtn(copyBtn, '✓'),
            () => flashBtn(copyBtn, '✗'),
        );
    });
    head.appendChild(copyBtn);

    card.appendChild(head);
    card.appendChild(createFieldValueBlock(value));
    if (wireValue != null && String(wireValue) !== String(value ?? '')) {
        appendWireValueSection(card, wireValue);
    }
    appendFieldBadges(card, badges);
    appendFieldMeta(card, meta);
    if (footer) card.appendChild(footer);
    return card;
}

function buildKvFieldList(rows) {
    const list = createFieldList();
    for (const row of rows) list.appendChild(createFieldCard(row));
    return list;
}

function buildKvTable(rows, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'lv-kv-table-wrap';
    const table = document.createElement('table');
    table.className = 'lv-kv-table';
    const columns = opts.columns || [
        { key: 'key', label: 'Name', cls: 'lv-kv-td-key' },
        { key: 'value', label: 'Value', cls: 'lv-kv-td-val' },
    ];
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const col of columns) {
        const th = document.createElement('th');
        th.textContent = col.label;
        headRow.appendChild(th);
    }
    const actTh = document.createElement('th');
    actTh.textContent = '';
    headRow.appendChild(actTh);
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        for (const col of columns) {
            const td = document.createElement('td');
            td.className = col.cls || '';
            const raw = col.render ? col.render(row) : (row[col.key] ?? '');
            const s = raw == null ? '' : String(raw);
            if (col.key === 'value') {
                appendValueCellContent(td, row, s);
            } else if (s.length > LV_FIELD_PREVIEW_CHARS) {
                td.textContent = `${s.slice(0, LV_FIELD_PREVIEW_CHARS)}…`;
                td.title = s;
            } else {
                td.textContent = s;
            }
            tr.appendChild(td);
        }
        const actTd = document.createElement('td');
        actTd.className = 'lv-kv-td-act';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'lv-field-copy body-act-btn';
        copyBtn.title = 'Copy value';
        copyBtn.textContent = '⎘';
        const copyVal = String(row.copyValue ?? row.value ?? '');
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(copyVal).then(
                () => flashBtn(copyBtn, '✓'),
                () => flashBtn(copyBtn, '✗'),
            );
        });
        actTd.appendChild(copyBtn);
        tr.appendChild(actTd);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
}

function renderKeyValueList(container, sectionKey, rows, opts = {}) {
    if (!container) return;
    container.innerHTML = '';
    if (!rows?.length) {
        container.innerHTML = `<div class="body-empty">${opts.emptyLabel || '(none)'}</div>`;
        return;
    }
    const mode = getLvViewMode(sectionKey);
    container.appendChild(mode === 'table' ? buildKvTable(rows, opts) : buildKvFieldList(rows));
}

function headersToRows(headers) {
    const rows = [];
    if (!headers || typeof headers !== 'object') return rows;
    for (const [k, v] of Object.entries(headers)) {
        const vals = Array.isArray(v) ? v : [v];
        vals.forEach((item, idx) => {
            rows.push({
                key: k,
                subkey: vals.length > 1 ? `#${idx + 1}` : '',
                value: String(item),
            });
        });
    }
    return rows;
}

function pairsToKvRows(pairs) {
    return (pairs || []).map(({ key, value, rawValue, subkey }) => {
        const decoded = value == null ? '' : String(value);
        const row = {
            key,
            subkey: subkey || '',
            value: decoded,
            copyValue: decoded,
        };
        if (rawValue != null && String(rawValue) !== decoded) {
            row.wireValue = String(rawValue);
        }
        return row;
    });
}

function formatJsonLeafValue(v) {
    if (v === null) return 'null';
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    return JSON.stringify(v);
}

function flattenJsonToRows(value, keyPrefix = '') {
    const rows = [];
    const push = (k, v) => {
        rows.push({
            key: k,
            value: formatJsonLeafValue(v),
            copyValue: formatJsonLeafValue(v),
        });
    };
    const walk = (val, prefix) => {
        if (val === null || val === undefined) {
            push(prefix || '(root)', val);
            return;
        }
        if (Array.isArray(val)) {
            if (!val.length) { push(prefix || '(root)', '[]'); return; }
            val.forEach((item, i) => {
                const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
                if (item !== null && typeof item === 'object') walk(item, p);
                else push(p, item);
            });
            return;
        }
        if (typeof val === 'object') {
            const keys = Object.keys(val);
            if (!keys.length) { push(prefix || '(root)', '{}'); return; }
            for (const k of keys) {
                const p = prefix ? `${prefix}.${k}` : k;
                const child = val[k];
                if (child !== null && typeof child === 'object') walk(child, p);
                else push(p, child);
            }
            return;
        }
        push(prefix || '(root)', val);
    };
    walk(value, keyPrefix);
    return rows;
}

function renderJsonBody(container, jsonText, sectionKey) {
    const section = sectionKey || 'json-body';
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        container.innerHTML = `<div class="body-content json-body">${esc(formatBody(jsonText))}</div>`;
        return;
    }
    const rows = flattenJsonToRows(parsed);
    const doRender = () => {
        container.innerHTML = '';
        renderFieldListHeader(container, 'application/json', rows.length, section, doRender);
        const body = document.createElement('div');
        container.appendChild(body);
        renderKeyValueList(body, section, rows, { emptyLabel: '(empty)' });
    };
    doRender();
}

function buildHtmlFormEditorPrefill(form, baseUrl) {
    const method = (form.method || 'GET').toUpperCase();
    let actionUrl = baseUrl || '';
    if (form.action) {
        try { actionUrl = new URL(form.action, baseUrl || undefined).href; }
        catch { actionUrl = form.action; }
    }
    const ct = form.enctype || 'application/x-www-form-urlencoded';
    const params = [];
    for (const field of form.fields || []) {
        const name = field.name;
        if (!name || field.tag === 'button') continue;
        if (field.type === 'file') {
            params.push([name, field.displayValue || '[file]']);
            continue;
        }
        if (field.type === 'checkbox' || field.type === 'radio') {
            if (!field.flags?.includes('checked')) continue;
        }
        params.push([name, field.value ?? '']);
    }
    const sp = new URLSearchParams();
    for (const [k, v] of params) sp.append(k, v);
    const bodyStr = sp.toString();
    if (method === 'GET' && bodyStr) {
        const sep = actionUrl.includes('?') ? '&' : '?';
        return { method, url: actionUrl + sep + bodyStr, headers: {}, body: '' };
    }
    const headers = bodyStr ? { 'Content-Type': ct.split(';')[0].trim() } : {};
    return { method, url: actionUrl, headers, body: bodyStr };
}

function renderFieldListHeader(container, badgeText, count, sectionKey, onRerender) {
    const header = document.createElement('div');
    header.className = 'lv-field-list-header';
    header.innerHTML = `<span class="form-type-badge">${esc(badgeText)}</span><span class="lv-field-list-count">${count} item${count !== 1 ? 's' : ''}</span>`;
    if (sectionKey && onRerender) {
        const host = document.createElement('span');
        host.className = 'lv-view-toggle-host';
        host.appendChild(createViewModeToggle(sectionKey, onRerender));
        header.appendChild(host);
    }
    container.appendChild(header);
}

function renderFormBody(container, pairs, rawBody) {
    const sectionKey = 'req-body-form';
    const rows = pairsToKvRows(pairs);
    const doRender = () => {
        container.innerHTML = '';
        renderFieldListHeader(container, 'application/x-www-form-urlencoded', pairs.length, sectionKey, doRender);
        const body = document.createElement('div');
        container.appendChild(body);
        renderKeyValueList(body, sectionKey, rows);
    };
    doRender();
}

function isLikelyHtmlContent(text) {
    const t = String(text || '').trimStart().slice(0, 800).toLowerCase();
    return t.startsWith('<!doctype html') || t.startsWith('<html') || (t.includes('<html') && t.includes('<body'));
}

function looksLikeHtmlResponse(text, contentType) {
    if (String(contentType || '').toLowerCase().includes('html')) return true;
    return isLikelyHtmlContent(text);
}

function htmlFormStyleHidden(style) {
    const s = String(style || '');
    if (!s) return false;
    if (/display\s*:\s*none/i.test(s)) return true;
    if (/visibility\s*:\s*hidden/i.test(s)) return true;
    return false;
}

function parseHtmlFormField(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (!tag || tag === 'fieldset') return null;

    let type = (el.getAttribute('type') || '').toLowerCase();
    if (!type) {
        if (tag === 'textarea') type = 'textarea';
        else if (tag === 'select') type = 'select';
        else if (tag === 'button') type = 'submit';
        else type = 'text';
    }

    const hidden = type === 'hidden'
        || el.hasAttribute('hidden')
        || htmlFormStyleHidden(el.getAttribute('style'))
        || el.getAttribute('aria-hidden') === 'true';

    const flags = [];
    if (hidden) flags.push('hidden');
    if (el.hasAttribute('disabled')) flags.push('disabled');
    if (el.hasAttribute('readonly')) flags.push('readonly');
    if (el.hasAttribute('required')) flags.push('required');
    if (el.hasAttribute('multiple')) flags.push('multiple');
    if (el.hasAttribute('checked')) flags.push('checked');

    const attrs = [];
    for (const name of [
        'autocomplete', 'placeholder', 'maxlength', 'minlength', 'pattern', 'min', 'max', 'step',
        'formaction', 'formmethod', 'formenctype', 'formtarget', 'accept', 'inputmode',
        'data-val', 'data-value', 'data-rule', 'data-msg',
    ]) {
        const v = el.getAttribute(name);
        if (v == null || v === '') continue;
        attrs.push(`${name}="${v}"`);
    }

    const field = {
        tag,
        type,
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
        hidden,
        flags,
        attrs,
        value: '',
        displayValue: '',
        options: null,
    };

    if (tag === 'select') {
        field.options = Array.from(el.querySelectorAll('option')).map((opt, index) => ({
            index,
            value: opt.getAttribute('value') ?? (opt.textContent || '').trim(),
            text: (opt.textContent || '').trim(),
            selected: opt.hasAttribute('selected'),
            disabled: opt.hasAttribute('disabled'),
        }));
        const selected = field.options.filter((o) => o.selected);
        const chosen = selected.length ? selected : field.options.slice(0, 1);
        field.value = chosen.map((o) => o.value).join(', ');
        field.displayValue = field.value;
    } else if (tag === 'textarea') {
        field.value = el.textContent || '';
        field.displayValue = field.value;
    } else if (type === 'checkbox' || type === 'radio') {
        const attrVal = el.getAttribute('value') || 'on';
        field.value = attrVal;
        field.displayValue = el.hasAttribute('checked') ? `checked · ${attrVal}` : `(unchecked) · ${attrVal}`;
    } else if (type === 'file') {
        field.displayValue = el.getAttribute('value') ? `[file path attr] ${el.getAttribute('value')}` : '(file input)';
    } else {
        field.value = el.getAttribute('value') || '';
        field.displayValue = field.value;
    }

    return field;
}

function parseHtmlFormsFromString(html) {
    const raw = String(html || '');
    if (!raw.includes('<form') && !isLikelyHtmlContent(raw)) return [];
    try {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        return Array.from(doc.querySelectorAll('form')).map((form, index) => {
            const fields = [];
            const elements = form.elements ? Array.from(form.elements) : Array.from(form.querySelectorAll('input, select, textarea, button'));
            for (const el of elements) {
                const parsed = parseHtmlFormField(el);
                if (parsed) fields.push(parsed);
            }
            return {
                index,
                id: form.getAttribute('id') || '',
                name: form.getAttribute('name') || '',
                action: form.getAttribute('action') || '',
                method: (form.getAttribute('method') || 'GET').toUpperCase(),
                enctype: form.getAttribute('enctype') || '',
                novalidate: form.hasAttribute('novalidate'),
                target: form.getAttribute('target') || '',
                fields,
            };
        });
    } catch {
        return [];
    }
}

let _respHtmlView = 'body';
let _respHtmlFormsPayload = null;

function resetResponseHtmlViews() {
    _respHtmlView = 'body';
    _respHtmlFormsPayload = null;
    const subtabs = document.getElementById('resp-html-subtabs');
    const formsWrap = document.getElementById('resp-html-forms-wrap');
    const bodyWrap = document.getElementById('response-body-wrap');
    const copyFormsBtn = document.getElementById('resp-forms-copy-btn');
    if (subtabs) subtabs.style.display = 'none';
    if (formsWrap) {
        formsWrap.style.display = 'none';
        formsWrap.innerHTML = '';
    }
    if (bodyWrap) bodyWrap.style.display = '';
    if (copyFormsBtn) copyFormsBtn.style.display = 'none';
    document.querySelectorAll('.resp-html-subtab').forEach((btn) => {
        btn.classList.toggle('active', (btn.dataset.respView || 'body') === 'body');
    });
}

function renderHtmlFormsPanel(container, forms, pageUrl = '') {
    if (!container) return;
    container.innerHTML = '';
    if (!forms?.length) {
        container.innerHTML = '<div class="resp-forms-empty">No &lt;form&gt; elements found in this HTML response.</div>';
        return;
    }

    for (const form of forms) {
        const card = document.createElement('div');
        card.className = 'resp-form-card';
        const sectionKey = `resp-form-${form.index}`;

        const label = form.name || form.id || `Form ${form.index + 1}`;
        const metaParts = [
            form.method,
            form.action ? `→ ${form.action}` : '(no action)',
            form.enctype ? form.enctype : null,
            `${form.fields.length} field${form.fields.length !== 1 ? 's' : ''}`,
        ].filter(Boolean);

        const fieldRows = form.fields.map((field, fieldIdx) => {
            const fieldLabel = field.name || field.id || `(unnamed ${field.tag})`;
            const badges = (field.flags || []).map((flag) => ({
                text: flag,
                cls: flag === 'hidden' ? 'badge-hidden' : '',
            }));
            if (field.type) badges.unshift({ text: field.type });

            const meta = [];
            if (field.id && field.name) meta.push(`id: ${field.id}`);
            if (field.options?.length) {
                for (const opt of field.options) {
                    const mark = opt.selected ? '●' : '○';
                    let line = `${mark} ${opt.text || opt.value || '(option)'}`;
                    if (opt.value && opt.value !== opt.text) line += ` (${opt.value})`;
                    meta.push(line);
                }
            }
            if (field.attrs?.length) meta.push(field.attrs.join(' · '));

            return {
                key: `${fieldIdx + 1}. ${fieldLabel}`,
                subkey: field.tag !== field.type ? field.tag : '',
                value: field.displayValue || field.value || '',
                copyValue: field.value || field.displayValue || '',
                badges,
                meta,
            };
        });

        const head = document.createElement('div');
        head.className = 'resp-form-head';
        const headTop = document.createElement('div');
        headTop.className = 'resp-form-head-top';
        headTop.innerHTML = `<div class="resp-form-head-title">${esc(label)}</div>`;
        const editorBtn = document.createElement('button');
        editorBtn.type = 'button';
        editorBtn.className = 'lv-act-btn lv-act-btn-primary resp-form-editor-btn';
        editorBtn.textContent = '✏ Submit';
        editorBtn.title = 'Open in Request Editor with form fields prefilled';
        editorBtn.addEventListener('click', () => {
            const prefill = buildHtmlFormEditorPrefill(form, pageUrl);
            void api.openRequestEditor(prefill).catch((err) => {
                alert('Could not open Request Editor: ' + (err?.message || err));
            });
        });
        headTop.appendChild(editorBtn);
        head.appendChild(headTop);
        const metaHtml = [
            `<div class="resp-form-head-meta">${esc(metaParts.join(' · '))}</div>`,
            form.id ? `<div class="resp-form-head-meta">id="${esc(form.id)}"</div>` : '',
            form.name ? `<div class="resp-form-head-meta">name="${esc(form.name)}"</div>` : '',
            form.target ? `<div class="resp-form-head-meta">target="${esc(form.target)}"</div>` : '',
        ].filter(Boolean).join('');
        if (metaHtml) {
            const metaWrap = document.createElement('div');
            metaWrap.innerHTML = metaHtml;
            head.appendChild(metaWrap);
        }

        const body = document.createElement('div');
        const renderFormFields = () => {
            body.innerHTML = '';
            const mode = getLvViewMode(sectionKey);
            if (mode === 'table') {
                renderKeyValueList(body, sectionKey, fieldRows.map(({ key, subkey, value, copyValue }) => ({
                    key: subkey ? `${key} (${subkey})` : key,
                    value,
                    copyValue,
                })));
            } else {
                const list = createFieldList();
                for (const row of fieldRows) list.appendChild(createFieldCard(row));
                body.appendChild(list);
            }
        };
        renderFormFields();
        injectViewToggle(headTop, sectionKey, renderFormFields);

        card.appendChild(head);
        card.appendChild(body);
        container.appendChild(card);
    }
}

function setResponseHtmlView(view) {
    _respHtmlView = view === 'forms' ? 'forms' : 'body';
    const bodyWrap = document.getElementById('response-body-wrap');
    const formsWrap = document.getElementById('resp-html-forms-wrap');
    document.querySelectorAll('.resp-html-subtab').forEach((btn) => {
        btn.classList.toggle('active', (btn.dataset.respView || 'body') === _respHtmlView);
    });
    if (bodyWrap) bodyWrap.style.display = _respHtmlView === 'forms' ? 'none' : '';
    if (formsWrap) formsWrap.style.display = _respHtmlView === 'forms' ? 'block' : 'none';
    scheduleDetailFindRefresh();
}

function setupResponseHtmlViews(htmlText, contentType, pageUrl = '') {
    resetResponseHtmlViews();
    if (!looksLikeHtmlResponse(htmlText, contentType) || !htmlText) return;

    const forms = parseHtmlFormsFromString(htmlText);
    if (!forms.length) return;

    _respHtmlFormsPayload = forms;
    const subtabs = document.getElementById('resp-html-subtabs');
    const formsWrap = document.getElementById('resp-html-forms-wrap');
    const countEl = document.getElementById('resp-forms-count');
    const copyFormsBtn = document.getElementById('resp-forms-copy-btn');

    if (subtabs) subtabs.style.display = 'flex';
    if (countEl) countEl.textContent = `(${forms.length})`;
    renderHtmlFormsPanel(formsWrap, forms, pageUrl);

    document.querySelectorAll('.resp-html-subtab').forEach((btn) => {
        btn.onclick = () => setResponseHtmlView(btn.dataset.respView || 'body');
    });

    if (copyFormsBtn) {
        copyFormsBtn.style.display = '';
        copyFormsBtn.onclick = () => {
            navigator.clipboard.writeText(JSON.stringify(_respHtmlFormsPayload, null, 2)).then(
                () => flashBtn(copyFormsBtn, '✓ Copied'),
                () => flashBtn(copyFormsBtn, '✗ Failed'),
            );
        };
    }
}

function renderHeaders(container, headers, sectionKey) {
    if (!sectionKey) {
        renderKeyValueList(container, 'headers', headersToRows(headers));
        return;
    }
    const rows = headersToRows(headers);
    renderKeyValueList(container, sectionKey, rows, { emptyLabel: '(none)' });
}

function renderMultipartBody(container, parts, contentType) {
    const sectionKey = 'req-body-multipart';
    const ctShort = String(contentType || 'multipart/form-data').split(';')[0].trim();
    let multipartFilter = 'all';

    const buildRows = () => parts.map((part) => {
        const badges = [];
        if (part.isFile) badges.push({ text: 'file', cls: 'badge-file' });
        const meta = [];
        if (part.filename) meta.push(`filename: ${part.filename}`);
        if (part.contentType) meta.push(`content-type: ${part.contentType}`);

        let footer = null;
        if (part.isFile && (part.imageMime || part.rawBinary)) {
            footer = document.createElement('div');
            footer.className = 'lv-field-actions';
            if (part.imageMime && part.rawBinary) {
                const viewBtn = document.createElement('button');
                viewBtn.type = 'button';
                viewBtn.className = 'body-act-btn';
                viewBtn.textContent = '👁 View image';
                viewBtn.title = `Preview ${part.imageMime}`;
                viewBtn.addEventListener('click', () => showMultipartImagePreview(part));
                footer.appendChild(viewBtn);
            }
            if (part.rawBinary) {
                const saveBtn = document.createElement('button');
                saveBtn.type = 'button';
                saveBtn.className = 'body-act-btn';
                const fi = guessFileInfo(part.filename || '', part.contentType || part.imageMime || '');
                saveBtn.textContent = `↓ Save .${fi.ext}`;
                saveBtn.addEventListener('click', () => {
                    const mime = part.imageMime || part.contentType || 'application/octet-stream';
                    const arr = new Uint8Array(part.rawBinary.length);
                    for (let i = 0; i < part.rawBinary.length; i++) arr[i] = part.rawBinary.charCodeAt(i) & 0xff;
                    const blob = new Blob([arr], { type: mime.split(';')[0].trim() });
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = part.filename && /\.\w+$/.test(part.filename)
                        ? part.filename
                        : `multipart-${part.key || 'file'}-${Date.now()}.${fi.ext}`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
                });
                footer.appendChild(saveBtn);
            }
        }

        return {
            key: part.key,
            value: part.isFile ? part.value : (part.rawValue ?? part.value),
            copyValue: part.isFile ? part.filename || part.value : (part.rawValue ?? part.value),
            badges,
            meta,
            footer,
            isFile: !!part.isFile,
        };
    });

    const rows = buildRows();
    const fileCount = rows.filter((r) => r.isFile).length;
    const showFileFilter = fileCount > 0 && fileCount < rows.length;

    const filteredRows = () => (multipartFilter === 'files' ? rows.filter((r) => r.isFile) : rows);

    const doRender = () => {
        container.innerHTML = '';
        const header = document.createElement('div');
        header.className = 'lv-field-list-header';
        header.innerHTML = `<span class="form-type-badge">${esc(ctShort)}</span><span class="lv-field-list-count">${filteredRows().length} item${filteredRows().length !== 1 ? 's' : ''}</span>`;
        if (showFileFilter) {
            const filterWrap = document.createElement('span');
            filterWrap.className = 'lv-multipart-filter';
            for (const mode of ['all', 'files']) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'lv-multipart-filter-btn' + (multipartFilter === mode ? ' active' : '');
                btn.textContent = mode === 'all' ? 'All' : `Files (${fileCount})`;
                btn.addEventListener('click', () => {
                    if (multipartFilter === mode) return;
                    multipartFilter = mode;
                    doRender();
                });
                filterWrap.appendChild(btn);
            }
            header.appendChild(filterWrap);
        }
        const toggleHost = document.createElement('span');
        toggleHost.className = 'lv-view-toggle-host';
        toggleHost.appendChild(createViewModeToggle(sectionKey, doRender));
        header.appendChild(toggleHost);
        container.appendChild(header);

        const body = document.createElement('div');
        container.appendChild(body);
        const visible = filteredRows();
        if (!visible.length) {
            body.innerHTML = '<div class="body-empty">No file parts in this request</div>';
            return;
        }
        const mode = getLvViewMode(sectionKey);
        if (mode === 'table') {
            renderKeyValueList(body, sectionKey, visible.map(({ key, value, copyValue }) => ({ key, value, copyValue })));
        } else {
            const list = createFieldList();
            for (const row of visible) list.appendChild(createFieldCard(row));
            body.appendChild(list);
        }
    };
    doRender();
}

function wireReqBodyBtns(rawBody, formPairs, saveOpts = {}) {
    const btnText = document.getElementById('req-copy-text-btn');
    const btnArr  = document.getElementById('req-copy-arr-btn');
    const btnObj  = document.getElementById('req-copy-obj-btn');
    const btnSave = document.getElementById('req-save-btn');
    const hasForm = formPairs && formPairs.length > 0;
    const hasBody = !!rawBody || !!(saveOpts.fromB64 && saveOpts.b64Data) || !!(saveOpts.storedRaw);

    // Form-specific buttons (Text/Array/Object) — only for form-urlencoded
    if (btnArr)  btnArr.style.display  = hasForm ? '' : 'none';
    if (btnObj)  btnObj.style.display  = hasForm ? '' : 'none';
    // Text copy — show for form OR any body
    if (btnText) {
        btnText.style.display = (hasForm || hasBody) ? '' : 'none';
        btnText.textContent   = hasForm ? '⎘ Text' : '⎘ Copy';
    }
    if (btnSave) btnSave.style.display = hasBody ? '' : 'none';

    if (btnText) {
        btnText.onclick = () => {
            const text = hasForm
                ? formPairs.map(p => `${p.key} = ${p.value}`).join('\n')
                : (rawBody || '');
            navigator.clipboard.writeText(text).then(
                () => flashBtn(btnText, '✓ Copied'),
                () => flashBtn(btnText, '✗ Failed'));
        };
    }
    if (btnArr && hasForm) {
        btnArr.onclick = () => {
            const lines = formPairs.map(p =>
                `  [${JSON.stringify(p.key)}, ${JSON.stringify(p.value)}]`
            ).join(',\n');
            navigator.clipboard.writeText(`[\n${lines}\n]`).then(
                () => flashBtn(btnArr, '✓ Copied'),
                () => flashBtn(btnArr, '✗ Failed'));
        };
    }
    if (btnObj && hasForm) {
        btnObj.onclick = () => {
            const lines = formPairs.map(p =>
                `  ${JSON.stringify(p.key)}: ${JSON.stringify(p.value)}`
            ).join(',\n');
            navigator.clipboard.writeText(`{\n${lines}\n}`).then(
                () => flashBtn(btnObj, '✓ Copied'),
                () => flashBtn(btnObj, '✗ Failed'));
        };
    }
    if (btnSave && hasBody) {
        btnSave.onclick = () => {
            let blob;
            const mime = saveOpts.contentType || 'text/plain';
            if (saveOpts.fromB64 && saveOpts.b64Data) {
                const dec = b64ToBinaryString(saveOpts.b64Data);
                if (dec.ok) {
                    const arr = new Uint8Array(dec.bin.length);
                    for (let i = 0; i < dec.bin.length; i++) arr[i] = dec.bin.charCodeAt(i);
                    blob = new Blob([arr], { type: mime.split(';')[0].trim() || 'application/octet-stream' });
                } else if (saveOpts.storedRaw) {
                    blob = new Blob([String(saveOpts.storedRaw)], { type: 'text/plain' });
                } else {
                    blob = new Blob([rawBody || ''], { type: 'text/plain' });
                }
            } else {
                blob = new Blob([rawBody], { type: mime.split(';')[0].trim() || 'text/plain' });
            }
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            const ext  = mime.includes('multipart') ? 'bin' : 'txt';
            a.href = url; a.download = `request-body-${Date.now()}.${ext}`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        };
    }
}

function renderQueryParams(container, pairs) {
    const sectionKey = 'query-params';
    const rows = (pairs || []).map(({ key, value }) => ({ key, value }));
    renderKeyValueList(container, sectionKey, rows, { emptyLabel: '(none)' });
}

function findHeader(headers, name) {
    if (!headers) return '';
    const lc = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lc) return Array.isArray(v) ? v[0] : String(v);
    }
    return '';
}

function headersToJson(headers) {
    if (!headers || typeof headers !== 'object') return '{}';
    const flat = {};
    for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) {
            flat[k] = v.length === 1 ? v[0] : v;
        } else {
            flat[k] = v;
        }
    }
    return JSON.stringify(flat, null, 2);
}

// ─── Cookies tab ──────────────────────────────────────────────────────────────

/** Parse `Cookie: name=val; name2=val2` request header → [{name, value}] */
function parseRequestCookies(cookieHeader) {
    if (!cookieHeader) return [];
    return String(cookieHeader).split(';').map(p => {
        const eq = p.indexOf('=');
        return eq === -1
            ? { name: p.trim(), value: '' }
            : { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
    }).filter(c => c.name);
}

/**
 * Parse one Set-Cookie header string → { name, value, attributes: {...}, flags: [] }
 * Handles: Path, Domain, Expires, Max-Age, Secure, HttpOnly, SameSite, Partitioned
 */
function parseSetCookie(raw) {
    if (!raw) return null;
    const parts = String(raw).split(';').map(s => s.trim());
    const first = parts[0] || '';
    const eq = first.indexOf('=');
    const name  = eq === -1 ? first : first.slice(0, eq).trim();
    const value = eq === -1 ? '' : first.slice(eq + 1).trim();
    const attrs = {};
    const flags = [];
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        const aeq = p.indexOf('=');
        const aName  = (aeq === -1 ? p : p.slice(0, aeq)).trim().toLowerCase();
        const aValue = aeq === -1 ? null : p.slice(aeq + 1).trim();
        if (aName === 'secure')       { flags.push('Secure'); }
        else if (aName === 'httponly') { flags.push('HttpOnly'); }
        else if (aName === 'partitioned') { flags.push('Partitioned'); }
        else if (aName === 'samesite')  { attrs.samesite = aValue || 'Lax'; flags.push(`SameSite=${aValue || 'Lax'}`); }
        else if (aName === 'path')     { attrs.path    = aValue; }
        else if (aName === 'domain')   { attrs.domain  = aValue; }
        else if (aName === 'expires')  { attrs.expires = aValue; }
        else if (aName === 'max-age')  { attrs.maxAge  = aValue; }
    }
    return { name, value, attrs, flags };
}

/** Count Set-Cookie headers in response (for list column and filter). */
function countSetCookies(entry) {
    const h = parseHeaders(entry.response_headers || entry.response?.headers);
    if (!h) return 0;
    return getSetCookies(h).length;
}

/** Get all Set-Cookie strings from response headers object.
 *  Handles arrays (MITM/AzureTLS) and '\n'-joined strings (CDP). */
function getSetCookies(headers) {
    if (!headers) return [];
    const result = [];
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'set-cookie' || k.toLowerCase() === 'set-cookie2') {
            if (Array.isArray(v)) {
                result.push(...v.map(s => String(s).trim()).filter(Boolean));
            } else {
                const values = String(v).split('\n').map(s => s.trim()).filter(Boolean);
                result.push(...values);
            }
        }
    }
    return result;
}

function renderCookiesTab(entry) {
    const container = document.getElementById('cookies-content');
    if (!container) return;
    container.innerHTML = '';

    const reqHeaders  = parseHeaders(entry.request_headers  || entry.request?.headers);
    const respHeaders = parseHeaders(entry.response_headers || entry.response?.headers);

    const cookieHeader = Object.entries(reqHeaders || {})
        .find(([k]) => k.toLowerCase() === 'cookie')?.[1] || '';
    const sentCookies = parseRequestCookies(cookieHeader);
    const sentRows = sentCookies.map((c) => ({ key: c.name, value: c.value }));

    const sentSection = document.createElement('div');
    sentSection.className = 'ck-section';
    const sentTitle = document.createElement('div');
    sentTitle.className = 'ck-section-title';
    sentTitle.innerHTML = `Sent <span style="color:#7dd3fc">Cookie</span> <span class="ck-count">${sentCookies.length}</span>`;
    if (sentCookies.length) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'ck-copy-btn';
        copyBtn.id = 'ck-sent-copy';
        copyBtn.textContent = '⎘ JSON';
        sentTitle.appendChild(copyBtn);
    }
    sentSection.appendChild(sentTitle);
    const sentBody = document.createElement('div');
    sentSection.appendChild(sentBody);
    if (sentCookies.length === 0) {
        sentBody.innerHTML = '<div class="ck-empty">No cookies sent with this request</div>';
    } else {
        const renderSent = () => renderKeyValueList(sentBody, 'cookies-sent', sentRows);
        renderSent();
        injectViewToggle(sentTitle, 'cookies-sent', renderSent);
    }
    container.appendChild(sentSection);
    const sentCopyBtn = document.getElementById('ck-sent-copy');
    if (sentCopyBtn) {
        sentCopyBtn.onclick = () => {
            const obj = {};
            for (const c of sentCookies) obj[c.name] = c.value;
            navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).then(
                () => flashBtn(sentCopyBtn, '✓'), () => flashBtn(sentCopyBtn, '✗'));
        };
    }

    const rawSetCookies = getSetCookies(respHeaders);
    const parsed = rawSetCookies.map(parseSetCookie).filter(Boolean);
    const recvRows = parsed.map((c) => {
        const badges = [];
        if (c.flags.includes('Secure')) badges.push({ text: 'Secure', cls: 'badge-secure' });
        if (c.flags.includes('HttpOnly')) badges.push({ text: 'HttpOnly', cls: 'badge-httponly' });
        const sameSite = c.flags.find((f) => f.startsWith('SameSite'));
        if (sameSite) badges.push({ text: sameSite.replace(/^SameSite=/i, 'SameSite '), cls: 'badge-samesite' });
        if (c.flags.includes('Partitioned')) badges.push({ text: 'Partitioned' });
        const meta = [
            c.attrs.path ? `Path: ${c.attrs.path}` : '',
            c.attrs.domain ? `Domain: ${c.attrs.domain}` : '',
            c.attrs.expires ? `Expires: ${c.attrs.expires}` : '',
            c.attrs.maxAge ? `Max-Age: ${c.attrs.maxAge}` : '',
        ].filter(Boolean);
        const metaCol = [
            ...meta,
            ...(c.flags.length ? [c.flags.join(', ')] : []),
        ].join(' · ');
        return {
            key: c.name,
            value: c.value,
            metaCol,
            badges,
            meta,
        };
    });

    const recvSection = document.createElement('div');
    recvSection.className = 'ck-section';
    recvSection.style.marginTop = '12px';
    const recvTitle = document.createElement('div');
    recvTitle.className = 'ck-section-title';
    recvTitle.innerHTML = `Received <span style="color:#4ade80">Set-Cookie</span> <span class="ck-count" style="${parsed.length ? '' : 'background:var(--bg2);color:var(--text-dim)'}">${parsed.length}</span>`;
    if (parsed.length) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'ck-copy-btn';
        copyBtn.id = 'ck-recv-copy';
        copyBtn.textContent = '⎘ JSON';
        recvTitle.appendChild(copyBtn);
    }
    recvSection.appendChild(recvTitle);
    const recvBody = document.createElement('div');
    recvSection.appendChild(recvBody);

    if (parsed.length === 0) {
        recvBody.innerHTML = '<div class="ck-empty">No Set-Cookie headers in this response</div>';
    } else {
        const renderRecv = () => {
            const mode = getLvViewMode('cookies-recv');
            recvBody.innerHTML = '';
            if (mode === 'table') {
                renderKeyValueList(recvBody, 'cookies-recv', recvRows, {
                    columns: [
                        { key: 'key', label: 'Name', cls: 'lv-kv-td-key' },
                        { key: 'value', label: 'Value', cls: 'lv-kv-td-val' },
                        { key: 'metaCol', label: 'Attributes', cls: 'lv-kv-td-meta' },
                    ],
                });
            } else {
                const list = createFieldList();
                for (const row of recvRows) {
                    list.appendChild(createFieldCard({
                        key: row.key,
                        value: row.value,
                        badges: row.badges,
                        meta: row.meta,
                    }));
                }
                recvBody.appendChild(list);
            }
        };
        renderRecv();
        injectViewToggle(recvTitle, 'cookies-recv', renderRecv);
    }
    container.appendChild(recvSection);
    const recvCopyBtn = document.getElementById('ck-recv-copy');
    if (recvCopyBtn) {
        recvCopyBtn.onclick = () => {
            const arr = parsed.map(c => ({
                name: c.name, value: c.value,
                ...(c.attrs.path   ? { path: c.attrs.path } : {}),
                ...(c.attrs.domain ? { domain: c.attrs.domain } : {}),
                ...(c.attrs.expires ? { expires: c.attrs.expires } : {}),
                ...(c.attrs.maxAge  ? { maxAge: c.attrs.maxAge } : {}),
                flags: c.flags,
            }));
            navigator.clipboard.writeText(JSON.stringify(arr, null, 2)).then(
                () => flashBtn(recvCopyBtn, '✓'), () => flashBtn(recvCopyBtn, '✗'));
        };
    }

    setCookieTabBadges(sentCookies.length, parsed.length);
}

/** @param {object} entry — log row with type websocket */
async function loadWsMessagesPanel(entry) {
    const listEl = document.getElementById('ws-messages-list');
    if (!listEl || !api.getWsEvents) return;
    _wsMessagesCopyPayload = null;
    const sid = entry.session_id ?? entry.sessionId ?? currentSessionId;
    const tid = entry.tabId ?? entry.tab_id ?? null;
    const url = entry.url || '';
    if (sid == null || !url) {
        listEl.innerHTML = '<div class="body-empty">No session or URL</div>';
        return;
    }
    listEl.innerHTML = '<div class="body-empty">⏳ Loading…</div>';
    try {
        const rows = await api.getWsEvents({ sessionId: sid, tabId: tid, url });
        if (!rows || !rows.length) {
            listEl.innerHTML = '<div class="body-empty">No frames yet (or session mismatch)</div>';
            return;
        }
        _wsMessagesCopyPayload = {
            schema: 'cupnet.ws_messages.v1',
            entryId: entry.id ?? null,
            url,
            sessionId: sid,
            tabId: tid,
            messages: rows.map((r) => ({
                id: r.id,
                direction: r.direction,
                connection_id: r.connection_id ?? null,
                created_at: r.created_at ?? null,
                payload: r.payload ?? null,
            })),
        };
        const parts = [];
        for (const r of rows) {
            const dir = String(r.direction || '').toLowerCase();
            let payload = r.payload;
            let rowClass = dir === 'send' ? 'send' : 'recv';
            let dirLabel = dir === 'send' ? 'Send' : 'Recv';
            let bodyHtml = '';
            if (typeof payload === 'string' && payload.startsWith('__cupnet_ws_meta__:')) {
                rowClass = 'meta';
                try {
                    const meta = JSON.parse(payload.slice('__cupnet_ws_meta__:'.length));
                    if (meta.kind === 'closed') {
                        dirLabel = 'Close';
                        bodyHtml = esc(`closed (frames: ${meta.frames ?? 0})`);
                    } else if (meta.kind === 'error') {
                        dirLabel = 'Error';
                        bodyHtml = esc(meta.error || '');
                    } else {
                        bodyHtml = wsMessagePayloadHtml(JSON.stringify(meta));
                    }
                } catch {
                    bodyHtml = wsMessagePayloadHtml(String(payload));
                }
            } else {
                const preview = payload == null ? '(empty)' : String(payload);
                bodyHtml = wsMessagePayloadHtml(preview);
            }
            const t = r.created_at ? esc(String(r.created_at).replace('T', ' ').slice(0, 23)) : '—';
            parts.push(`<div class="ws-msg-row ${rowClass}"><span class="ws-msg-dir">${esc(dirLabel)}</span><div class="ws-msg-body">${bodyHtml}</div><span class="ws-msg-time">${t}</span></div>`);
        }
        listEl.innerHTML = parts.join('');
        setDetailTabBadge('messages', rows.length);
        scheduleDetailFindRefresh();
    } catch (e) {
        _wsMessagesCopyPayload = null;
        setDetailTabBadge('messages', 0);
        listEl.innerHTML = `<div class="body-empty">Failed to load: ${esc(e.message || String(e))}</div>`;
    }
}

function activateTab(name, remember = true) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
    if (remember) lastActiveTab = name;
    if (name === 'messages' && _currentDetailEntry && String(_currentDetailEntry.type || '').toLowerCase() === 'websocket') {
        loadWsMessagesPanel(_currentDetailEntry);
    }
    scheduleDetailFindRefresh();
}

// ─── In-tab find (Headers / Request / Response / Raw …) ───────────────────────
const DETAIL_FIND_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'MARK']);
let _detailFindMarks = [];
let _detailFindTextareaRanges = [];
let _detailFindIndex = -1;
let _detailFindMode = 'dom'; // 'dom' | 'textarea'

function getActiveDetailTabPane() {
    return document.querySelector('.lv-tab-content.active');
}

function getDetailFindRoot() {
    const pane = getActiveDetailTabPane();
    if (!pane) return null;
    if (pane.id === 'tab-response') {
        const formsWrap = document.getElementById('resp-html-forms-wrap');
        const bodyWrap = document.getElementById('response-body-wrap');
        if (formsWrap && formsWrap.style.display !== 'none' && formsWrap.offsetParent !== null) {
            return formsWrap;
        }
        if (bodyWrap && bodyWrap.style.display !== 'none') return bodyWrap;
    }
    if (pane.id === 'tab-request') {
        const reqWrap = document.getElementById('request-body-wrap');
        if (reqWrap) return reqWrap;
    }
    return pane;
}

function isDetailFindTextareaMode() {
    const pane = getActiveDetailTabPane();
    return pane?.id === 'tab-comment' && !!commentTextarea;
}

function clearDetailFindMarksIn(root) {
    if (!root) return;
    root.querySelectorAll('mark.lv-find-mark').forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
    });
}

function clearAllDetailFindHighlights() {
    const body = document.getElementById('lv-tab-body');
    if (body) clearDetailFindMarksIn(body);
    _detailFindMarks = [];
    _detailFindTextareaRanges = [];
    _detailFindIndex = -1;
}

function detailFindShouldSkipNode(node, root) {
    let p = node.parentElement;
    while (p && p !== root) {
        if (DETAIL_FIND_SKIP_TAGS.has(p.tagName)) return true;
        if (p.classList?.contains('body-toolbar')) return true;
        if (p.classList?.contains('lv-detail-find-bar')) return true;
        if (p.classList?.contains('ss-action-bar')) return true;
        if (p.classList?.contains('lv-view-toggle')) return true;
        if (p.classList?.contains('lv-multipart-filter')) return true;
        if (p.classList?.contains('resp-form-head')) return true;
        if (p.classList?.contains('lv-url-parts-head')) return true;
        if (p.closest?.('.body-act-btn, .lv-field-copy, .lv-url-copy-btn, .lv-act-btn, button')) return true;
        const style = window.getComputedStyle(p);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        p = p.parentElement;
    }
    return false;
}

function collectDetailFindTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (detailFindShouldSkipNode(node, root)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
}

function buildDetailFindMarks(root, query) {
    const marks = [];
    const q = query.toLowerCase();
    for (const node of collectDetailFindTextNodes(root)) {
        const text = node.nodeValue;
        const lc = text.toLowerCase();
        let start = 0;
        let idx = lc.indexOf(q, start);
        if (idx === -1) continue;

        const fragments = [];
        while (idx !== -1) {
            if (idx > start) fragments.push(document.createTextNode(text.slice(start, idx)));
            const mark = document.createElement('mark');
            mark.className = 'lv-find-mark';
            mark.textContent = text.slice(idx, idx + query.length);
            fragments.push(mark);
            marks.push(mark);
            start = idx + query.length;
            idx = lc.indexOf(q, start);
        }
        if (start < text.length) fragments.push(document.createTextNode(text.slice(start)));

        const parent = node.parentNode;
        if (!parent) continue;
        for (const frag of fragments) parent.insertBefore(frag, node);
        parent.removeChild(node);
    }
    return marks;
}

function buildDetailFindTextareaRanges(query) {
    const ranges = [];
    const ta = commentTextarea;
    if (!ta || !query) return ranges;
    const text = ta.value;
    const lc = text.toLowerCase();
    const q = query.toLowerCase();
    let idx = 0;
    while ((idx = lc.indexOf(q, idx)) !== -1) {
        ranges.push({ start: idx, end: idx + query.length });
        idx += query.length;
    }
    return ranges;
}

function updateDetailFindCountUI() {
    if (!detailFindCount) return;
    const query = detailFindInput?.value.trim() || '';
    if (!query) {
        detailFindCount.textContent = '';
        return;
    }
    const total = _detailFindMode === 'textarea'
        ? _detailFindTextareaRanges.length
        : _detailFindMarks.length;
    if (!total) {
        detailFindCount.textContent = 'No matches';
        return;
    }
    const cur = _detailFindIndex >= 0 ? _detailFindIndex + 1 : 0;
    detailFindCount.textContent = `${cur} / ${total}`;
}

function focusDetailFindMatch(index, { scroll = true } = {}) {
    if (_detailFindMode === 'textarea') {
        const ranges = _detailFindTextareaRanges;
        if (!ranges.length || !commentTextarea) {
            _detailFindIndex = -1;
            updateDetailFindCountUI();
            return;
        }
        _detailFindIndex = ((index % ranges.length) + ranges.length) % ranges.length;
        const { start, end } = ranges[_detailFindIndex];
        commentTextarea.focus();
        commentTextarea.setSelectionRange(start, end);
        if (scroll) {
            const style = getComputedStyle(commentTextarea);
            const lineHeight = parseFloat(style.lineHeight) || 16;
            const linesBefore = commentTextarea.value.slice(0, start).split('\n').length - 1;
            commentTextarea.scrollTop = Math.max(0, linesBefore * lineHeight - commentTextarea.clientHeight * 0.35);
        }
        updateDetailFindCountUI();
        return;
    }

    if (!_detailFindMarks.length) {
        _detailFindIndex = -1;
        updateDetailFindCountUI();
        return;
    }
    _detailFindIndex = ((index % _detailFindMarks.length) + _detailFindMarks.length) % _detailFindMarks.length;
    _detailFindMarks.forEach((m, i) => m.classList.toggle('lv-find-active', i === _detailFindIndex));
    if (scroll) {
        _detailFindMarks[_detailFindIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    updateDetailFindCountUI();
}

function refreshDetailFind({ focusFirst = false } = {}) {
    clearAllDetailFindHighlights();
    const query = detailFindInput?.value.trim() || '';
    if (!query || !detailPanel || detailPanel.style.display === 'none' || detailPanel.classList.contains('multi-sel')) {
        updateDetailFindCountUI();
        return;
    }

    if (isDetailFindTextareaMode()) {
        _detailFindMode = 'textarea';
        _detailFindTextareaRanges = buildDetailFindTextareaRanges(query);
        if (_detailFindTextareaRanges.length) {
            focusDetailFindMatch(focusFirst ? 0 : 0, { scroll: true });
        } else {
            updateDetailFindCountUI();
        }
        return;
    }

    _detailFindMode = 'dom';
    const root = getDetailFindRoot();
    if (!root) {
        updateDetailFindCountUI();
        return;
    }
    _detailFindMarks = buildDetailFindMarks(root, query);
    if (_detailFindMarks.length) {
        focusDetailFindMatch(focusFirst ? 0 : 0, { scroll: true });
    } else {
        updateDetailFindCountUI();
    }
}

function scheduleDetailFindRefresh(opts) {
    requestAnimationFrame(() => refreshDetailFind(opts));
}

function stepDetailFind(delta) {
    const query = detailFindInput?.value.trim() || '';
    if (!query) {
        detailFindInput?.focus();
        return;
    }
    const total = _detailFindMode === 'textarea'
        ? _detailFindTextareaRanges.length
        : _detailFindMarks.length;
    if (!total) {
        refreshDetailFind();
        return;
    }
    if (_detailFindIndex < 0) {
        focusDetailFindMatch(delta >= 0 ? 0 : total - 1);
        return;
    }
    focusDetailFindMatch(_detailFindIndex + delta);
}

function clearDetailFind() {
    if (detailFindInput) detailFindInput.value = '';
    clearAllDetailFindHighlights();
    updateDetailFindCountUI();
}

function wireDetailFindBar() {
    const debouncedRefresh = debounce(() => refreshDetailFind({ focusFirst: true }), 120);
    detailFindInput?.addEventListener('input', debouncedRefresh);
    detailFindInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            stepDetailFind(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            clearDetailFind();
            detailFindInput.blur();
        }
    });
    detailFindPrev?.addEventListener('click', () => stepDetailFind(-1));
    detailFindNext?.addEventListener('click', () => stepDetailFind(1));
    detailFindClear?.addEventListener('click', () => {
        clearDetailFind();
        detailFindInput?.focus();
    });

    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return;
        if (!detailPanel || detailPanel.style.display === 'none' || detailPanel.classList.contains('multi-sel')) return;
        if (e.target === searchInput) return;
        e.preventDefault();
        detailFindInput?.focus();
        detailFindInput?.select();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'F3') return;
        if (!detailPanel || detailPanel.style.display === 'none' || detailPanel.classList.contains('multi-sel')) return;
        if (!detailFindInput?.value.trim()) return;
        e.preventDefault();
        stepDetailFind(e.shiftKey ? -1 : 1);
    });
}

wireDetailFindBar();

tabBtns.forEach(b => b.addEventListener('click', () => activateTab(b.dataset.tab)));
document.getElementById('ws-msg-refresh-btn')?.addEventListener('click', () => {
    if (_currentDetailEntry && String(_currentDetailEntry.type || '').toLowerCase() === 'websocket') {
        loadWsMessagesPanel(_currentDetailEntry);
    }
});

document.getElementById('ws-msg-copy-json-btn')?.addEventListener('click', async () => {
    const cur = _currentDetailEntry;
    if (!cur || String(cur.type || '').toLowerCase() !== 'websocket') {
        alert('Выберите строку WebSocket (handshake) в логе.');
        return;
    }
    if (!_wsMessagesCopyPayload?.messages?.length) {
        alert('Нет загруженных сообщений. Откройте вкладку Messages или нажмите Refresh.');
        return;
    }
    const pe = _wsMessagesCopyPayload.entryId;
    const cid = cur.id;
    if (pe != null && cid != null && Number(pe) !== Number(cid)) {
        alert('Список устарел. Нажмите Refresh.');
        return;
    }
    const text = JSON.stringify(_wsMessagesCopyPayload, null, 2);
    try {
        await navigator.clipboard.writeText(text);
        const btn = document.getElementById('ws-msg-copy-json-btn');
        if (btn) {
            const prev = btn.textContent;
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = prev; }, 1500);
        }
    } catch (e) {
        alert('Не удалось скопировать: ' + (e.message || e));
    }
});

// ─── Replay → Request Editor ──────────────────────────────────────────────────
if (replayBtn) {
    replayBtn.textContent = LV_ACT_LABELS.editor;
    replayBtn.title = 'Open in Request Editor (Postman-style)';
}

replayBtn?.addEventListener('click', async () => {
    const id = parseInt(replayBtn.dataset.entryId, 10);
    if (!id) return;
    replayBtn.disabled = true;
    replayBtn.textContent = '⏳';
    try {
        await api.openRequestEditor(id);
    } catch (e) {
        alert('Could not open Request Editor: ' + e.message);
    } finally {
        replayBtn.disabled = false;
        replayBtn.textContent = LV_ACT_LABELS.editor;
    }
});

// ─── Open Mock Rule editor from current response ────────────────────────────
const mockRuleBtn = document.getElementById('lv-create-mock-btn');
mockRuleBtn?.addEventListener('click', async () => {
    const entry = _currentDetailEntry;
    if (!entry) return;

    const url    = entry.url || '';
    const status = entry.status ?? entry.response?.statusCode ?? 200;
    const parsedRespHdrs = parseHeaders(entry.response_headers || entry.response?.headers);
    const ct = (parsedRespHdrs && findHeader(parsedRespHdrs, 'content-type')) || 'application/json';

    let body = entry.response_body || entry.responseBody || '';
    if (body.startsWith('__b64__:') || body.startsWith('<base64|')) {
        body = '';
    }

    const shortUrl = url.length > 60 ? url.slice(0, 57) + '…' : url;

    try {
        await api.openRulesWithMock({
            name: `Mock: ${shortUrl}`,
            url_pattern: url,
            params: {
                body,
                mimeType: ct.split(';')[0].trim(),
                status: parseInt(status, 10) || 200,
            },
        });
    } catch (e) {
        console.error('[log-viewer] open mock rule editor error', e);
    }
});

rawBtn?.addEventListener('click', () => activateTab('raw'));

document.getElementById('raw-copy-btn')?.addEventListener('click', () => {
    const rawEl = document.getElementById('raw-http-content');
    if (rawEl?.textContent) {
        navigator.clipboard.writeText(rawEl.textContent).then(() => {
            const btn = document.getElementById('raw-copy-btn');
            if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '⎘ Raw'; }, 1500); }
        });
    }
});

document.getElementById('raw-curl-btn')?.addEventListener('click', () => {
    const rawWrap = document.getElementById('tab-raw');
    const curl = rawWrap?.dataset?.curl;
    if (curl) {
        navigator.clipboard.writeText(curl).then(() => {
            const btn = document.getElementById('raw-curl-btn');
            if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '⎘ curl'; }, 1500); }
        });
    }
});

// ─── Toolbar actions ──────────────────────────────────────────────────────────
const debouncedFilter = debounce(applyFilters, 280);
searchInput?.addEventListener('input', debouncedFilter);
ftsCheckbox?.addEventListener('change', applyFilters);
scOnlyCheckbox?.addEventListener('change', applyFilters);
hideOptionsCheckbox?.addEventListener('change', applyFilters);
hideScreenshotCheckbox?.addEventListener('change', applyFilters);
clearSearchBtn?.addEventListener('click', () => { searchInput.value = ''; applyFilters(); });
filterSession?.addEventListener('change', applyFilters);
setupMultiSelects();
syncMsBadge('ms-activity-badge', 'ms-activity-btn', selectedActivityTypes.size);

lvSessionFromSelBtn?.addEventListener('click', async () => {
    if (selectedRequestIds.size === 0) return;
    const name = await promptNewSessionNameFromSelection();
    if (name === null) return;
    const ids = [...selectedRequestIds].map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) {
        alert('Selected rows have no valid database ids (cannot copy).');
        return;
    }
    lvSessionFromSelBtn.disabled = true;
    try {
        const res = await api.createSessionFromRequestIds(ids, name).catch(() => null);
        if (!res?.success) {
            alert(res?.error === 'no_requests' ? 'Could not copy requests (nothing selected or rows not found).' : 'Could not create session.');
            return;
        }
        await loadSessionSidebar();
        if (res.sessionId != null) await activateSidebarSession(res.sessionId, false);
    } finally {
        lvSessionFromSelBtn.disabled = false;
        updateSessionFromSelButton();
    }
});

document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key !== 'a' && e.key !== 'A') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    selectedRequestIds.clear();
    for (const en of filteredEntries) {
        if (en?.id && String(en.type || '').toLowerCase() !== 'screenshot') selectedRequestIds.add(en.id);
    }
    selectionAnchorIdx = 0;
    selectedIndex = filteredEntries.length ? filteredEntries.length - 1 : -1;
    scheduleRenderVirtual();
    if (selectedRequestIds.size) showMultiSelectionDetail();
    else updateSessionFromSelButton();
}, true);

autoScrollBtn?.addEventListener('click', () => {
    autoScrollEnabled = !autoScrollEnabled;
    autoScrollBtn.classList.toggle('active', autoScrollEnabled);
    autoScrollBtn.textContent = autoScrollEnabled ? '↓ Live' : '↓ Paused';
    if (autoScrollEnabled) scrollToBottom();
});

clearLogsBtn?.addEventListener('click', async () => {
    await api.clearLogs();
    allEntries = []; filteredEntries = []; selectedIndex = -1;
    selectedRequestIds.clear();
    selectionAnchorIdx = -1;
    detailPanel?.classList.remove('multi-sel');
    updateSessionFromSelButton();
    activeSidebarId = null;
    sessionFilterMode = null;
    if (detailEmpty) detailEmpty.style.display = '';
    if (detailPanel) detailPanel.style.display = 'none';
    renderVirtual(); updateCount();
    // Reload sidebar to reflect new session
    await loadSessionSidebar();
});

exportHarBtn?.addEventListener('click', async () => {
    exportHarBtn.disabled = true; exportHarBtn.textContent = '⟳ Exporting…';
    try {
        const res = await api.exportHar(currentSessionId);
        if (res?.success && res.sidecarPath) {
            alert(`HAR exported.\nWebSocket sidecar: ${res.sidecarPath}`);
        }
    } finally { exportHarBtn.disabled = false; exportHarBtn.textContent = '⬇ HAR'; }
});

async function resolveSessionIdForDbExport() {
    if (currentSessionId != null) return Number(currentSessionId);
    const sid = await api.getCurrentSessionId().catch(() => null);
    return sid != null ? Number(sid) : null;
}

/** Host без схемы (hostname:port), как в адресной строке. */
function _siteExportHostLabel(origin) {
    try {
        return new URL(origin).host || origin;
    } catch {
        return origin;
    }
}

function _siteExportGlobToRegExp(pattern) {
    let s = '';
    const p = String(pattern);
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') s += '.*';
        else if (c === '?') s += '.';
        else if ('.+^${}()|[\\]'.includes(c)) s += `\\${c}`;
        else s += c;
    }
    return new RegExp(`^${s}$`, 'i');
}

/** Без * и ? — точное совпадение host; с * или ? — glob на весь host. */
function _siteExportHostMatchesPattern(host, rawPattern) {
    const p = String(rawPattern).trim();
    if (!p) return false;
    const h = String(host);
    if (p.includes('*') || p.includes('?')) {
        try {
            return _siteExportGlobToRegExp(p).test(h);
        } catch {
            return false;
        }
    }
    return h.toLowerCase() === p.toLowerCase();
}

function _siteExportActivePatternStrings() {
    return [...(siteExportPatternRows?.querySelectorAll('.site-export-pattern-input') || [])]
        .map((el) => el.value.trim())
        .filter(Boolean);
}

/** Host входит в экспорт: нет активных фильтров → все; иначе OR по полям. */
function _siteExportHostIncluded(host) {
    const active = _siteExportActivePatternStrings();
    if (!active.length) return true;
    return active.some((pat) => _siteExportHostMatchesPattern(host, pat));
}

function _siteExportMatchedOrigins() {
    return _siteExportSessionOrigins.filter((o) => _siteExportHostIncluded(_siteExportHostLabel(o)));
}

function _renderSiteExportHostList() {
    if (!siteExportHostList) return;
    siteExportHostList.textContent = '';
    const sorted = _siteExportSessionOrigins.slice().sort((a, b) => _siteExportHostLabel(a).localeCompare(_siteExportHostLabel(b)));
    for (const origin of sorted) {
        const host = _siteExportHostLabel(origin);
        const div = document.createElement('div');
        div.className = 'site-export-host-line';
        div.classList.add(_siteExportHostIncluded(host) ? 'hit' : 'miss');
        div.textContent = host;
        div.title = origin;
        siteExportHostList.appendChild(div);
    }
}

function _updateSiteExportPatternRemoveButtons() {
    const rows = [...(siteExportPatternRows?.querySelectorAll('.site-export-pattern-row') || [])];
    rows.forEach((row) => {
        let btn = row.querySelector('.site-export-pattern-remove');
        if (rows.length <= 1) {
            if (btn) btn.remove();
        } else if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lv-btn site-export-pattern-remove';
            btn.textContent = '×';
            btn.title = 'Remove field';
            btn.addEventListener('click', () => {
                row.remove();
                _updateSiteExportPatternRemoveButtons();
                _updateSiteExportAddPatternState();
                _renderSiteExportHostList();
                _loadSiteExportPathsForModal();
            });
            row.appendChild(btn);
        }
    });
}

function _updateSiteExportAddPatternState() {
    const n = siteExportPatternRows?.querySelectorAll('.site-export-pattern-row').length || 0;
    if (siteExportAddPatternBtn) siteExportAddPatternBtn.disabled = n >= MAX_SITE_EXPORT_PATTERN_FIELDS;
}

function _addSiteExportPatternRow(value = '') {
    if (!siteExportPatternRows) return;
    if (siteExportPatternRows.querySelectorAll('.site-export-pattern-row').length >= MAX_SITE_EXPORT_PATTERN_FIELDS) return;
    const row = document.createElement('div');
    row.className = 'site-export-pattern-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'site-export-pattern-input';
    input.placeholder = 'e.g. app.example.com or *.cdn.io';
    input.value = value;
    input.autocomplete = 'off';
    input.addEventListener('input', () => {
        _renderSiteExportHostList();
        _loadSiteExportPathsForModal();
    });
    row.appendChild(input);
    siteExportPatternRows.appendChild(row);
    _updateSiteExportPatternRemoveButtons();
    _updateSiteExportAddPatternState();
}

function _resetSiteExportPatternRows() {
    if (!siteExportPatternRows) return;
    siteExportPatternRows.innerHTML = '';
    _addSiteExportPatternRow('');
}

function _renderSiteExportPathList() {
    if (!siteExportPathList) return;
    siteExportPathList.textContent = '';
    if (!_siteExportPaths.length) {
        const empty = document.createElement('div');
        empty.className = 'lv-dialog-note';
        empty.style.padding = '6px 0';
        empty.textContent = 'No matching GET 200 responses with body for the selected origin(s).';
        siteExportPathList.appendChild(empty);
        return;
    }
    for (const p of _siteExportPaths) {
        const div = document.createElement('div');
        div.className = 'site-export-path-line';
        div.textContent = p;
        siteExportPathList.appendChild(div);
    }
}

async function _loadSiteExportPathsForModal() {
    const sid = _siteExportSessionId;
    const origins = _siteExportMatchedOrigins();
    if (!siteExportPathList) return;
    if (!sid || !origins.length) {
        _siteExportPaths = [];
        _renderSiteExportPathList();
        return;
    }
    siteExportPathList.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'lv-dialog-note';
    loading.style.padding = '8px 4px';
    loading.textContent = 'Loading paths…';
    siteExportPathList.appendChild(loading);
    try {
        const paths = await api.listSiteExportPaths({ sessionId: sid, origins });
        _siteExportPaths = Array.isArray(paths) ? paths : [];
    } catch (e) {
        console.error('[log-viewer] listSiteExportPaths', e);
        _siteExportPaths = [];
    }
    _renderSiteExportPathList();
}

function closeSiteExportModal() {
    if (_siteExportEscHandler) {
        document.removeEventListener('keydown', _siteExportEscHandler);
        _siteExportEscHandler = null;
    }
    siteExportModal?.classList.remove('visible');
    _siteExportSessionId = null;
    _siteExportSessionOrigins = [];
    _siteExportPaths = [];
}

exportSiteZipBtn?.addEventListener('click', async () => {
    const sid = await resolveSessionIdForDbExport();
    if (!sid) {
        alert('No logging session. Start recording or open a saved session from the sidebar.');
        return;
    }
    _siteExportSessionId = sid;
    exportSiteZipBtn.disabled = true;
    const prevLabel = exportSiteZipBtn.textContent;
    exportSiteZipBtn.textContent = '⟳ …';
    try {
        const origins = await api.listSessionOrigins(sid);
        if (!origins.length) {
            alert('No HTTP(S) origins in this session.');
            _siteExportSessionId = null;
            return;
        }
        _siteExportSessionOrigins = origins;
        _resetSiteExportPatternRows();
        _renderSiteExportHostList();
        _siteExportEscHandler = (e) => {
            if (e.key === 'Escape') closeSiteExportModal();
        };
        document.addEventListener('keydown', _siteExportEscHandler);
        siteExportModal?.classList.add('visible');
        await _loadSiteExportPathsForModal();
    } catch (e) {
        console.error('[log-viewer] listSessionOrigins', e);
        alert('Could not load origins for this session.');
        _siteExportSessionId = null;
    } finally {
        exportSiteZipBtn.disabled = false;
        exportSiteZipBtn.textContent = prevLabel;
    }
});

siteExportCancelBtn?.addEventListener('click', () => closeSiteExportModal());
siteExportModal?.addEventListener('click', (e) => {
    if (e.target === siteExportModal) closeSiteExportModal();
});

siteExportAddPatternBtn?.addEventListener('click', () => {
    _addSiteExportPatternRow('');
    _renderSiteExportHostList();
    _loadSiteExportPathsForModal();
});

siteExportConfirmBtn?.addEventListener('click', async () => {
    const origins = _siteExportMatchedOrigins();
    const sessionId = _siteExportSessionId;
    if (!sessionId) {
        closeSiteExportModal();
        return;
    }
    if (!origins.length) {
        alert('No hosts match the filters. Clear filters or adjust patterns to include at least one host.');
        return;
    }
    siteExportConfirmBtn.disabled = true;
    const prev = siteExportConfirmBtn.textContent;
    siteExportConfirmBtn.textContent = '⟳ …';
    try {
        const res = await api.exportSiteZip({
            sessionId,
            origins,
        });
        closeSiteExportModal();
        if (res?.success) {
            const st = res.stats || {};
            const oline = Array.isArray(st.origins) && st.origins.length
                ? st.origins.join('\n')
                : '—';
            alert(`Site ZIP saved.\nOrigins:\n${oline}\nFiles: ${st.files ?? 0}\nRows skipped (filtered): ${st.skipped ?? '—'}`);
        } else if (!res?.canceled) {
            alert(`Site ZIP export failed: ${res?.error || 'unknown error'}`);
        }
    } catch (e) {
        console.error('[log-viewer] exportSiteZip', e);
        closeSiteExportModal();
        alert(`Site ZIP export failed: ${e.message || e}`);
    } finally {
        siteExportConfirmBtn.disabled = false;
        siteExportConfirmBtn.textContent = prev;
    }
});

exportBundleBtn?.addEventListener('click', async () => {
    const protectionLevel = await chooseProtectionLevel();
    if (!protectionLevel) return;
    const selected = selectedIndex >= 0 ? filteredEntries[selectedIndex] : null;
    const shouldExportSelectedOnly = !!(selected && selected.id && window.confirm('Export only selected request?\nOK = selected only\nCancel = whole session'));
    const payload = {
        sessionId: currentSessionId,
        protectionLevel,
        requestIds: shouldExportSelectedOnly ? [selected.id] : [],
        notes: {
            summary: selected?.note || '',
            owner: '',
        },
    };
    exportBundleBtn.disabled = true;
    exportBundleBtn.textContent = '⟳ Bundle…';
    try {
        const res = await api.exportBundle(payload);
        if (res?.success) {
            const stats = res.stats || {};
            alert(`Bundle exported.\nRequests: ${stats.requests || 0}\nWebSocket frames: ${stats.websocketEvents ?? 0}\nProtection: ${stats.protectionLevel || protectionLevel}\nRedacted fields: ${stats.redactedFields || 0}`);
        } else if (!res?.canceled) {
            alert(`Bundle export failed: ${res?.error || 'unknown error'}`);
        }
    } finally {
        exportBundleBtn.disabled = false;
        exportBundleBtn.textContent = '⬇ Bundle';
    }
});

importBundleBtn?.addEventListener('click', async () => {
    importBundleBtn.disabled = true;
    importBundleBtn.textContent = '⟳ Import…';
    try {
        const res = await api.importBundle();
        if (!res?.success) {
            if (!res?.canceled) alert(`Bundle import failed: ${res?.error || 'unknown error'}`);
            return;
        }
        const preview = res.preview || {};
        const ok = window.confirm(
            `Bundle preview:\n` +
            `Schema: ${preview.schemaVersion}\n` +
            `Exported: ${preview.exportedAt || 'n/a'}\n` +
            `Protection: ${preview.protectionLevel}\n` +
            `Requests: ${preview.requests || 0}\n` +
            `WebSocket frames: ${preview.websocketEvents ?? 0}\n\n` +
            'Restore this context into current log viewer?'
        );
        if (!ok) return;
        const bundle = res.bundle || {};
        const imported = Array.isArray(bundle.traffic?.requests) ? bundle.traffic.requests.slice().reverse() : [];
        allEntries = imported.map((e) => ({ ...e, _fromBundle: true }));
        filteredEntries = allEntries.slice();
        selectedIndex = -1;
        selectedRequestIds.clear();
        selectionAnchorIdx = -1;
        updateSessionFromSelButton();
        autoScrollEnabled = false;
        autoScrollBtn?.classList.remove('active');
        if (autoScrollBtn) autoScrollBtn.textContent = '↓ Paused';
        knownTabs = new Set(allEntries.map(e => e.tab_id || e.tabId).filter(Boolean));
        updateTabFilter();
        updateCount();
        renderVirtual();
        detailEmpty.style.display = '';
        detailPanel.style.display = 'none';
        alert('Bundle imported into viewer context.');
    } finally {
        importBundleBtn.disabled = false;
        importBundleBtn.textContent = '⬆ Bundle';
    }
});

compareSideCancelBtn?.addEventListener('click', () => {
    compareSideModal?.classList.remove('visible');
});
compareSideModal?.addEventListener('click', (e) => {
    if (e.target === compareSideModal) compareSideModal.classList.remove('visible');
});

openRulesBtn?.addEventListener('click', () => api.openRulesWindow());

api.onFocusRequestUrl?.(({ url }) => {
    const q = String(url || '').trim();
    if (!q) return;
    searchInput.value = q;
    applyFilters().then(() => {
        if (filteredEntries.length > 0) selectEntry(0);
    }).catch(() => {});
});

api.onFocusRequestId?.(({ id }) => {
    const rid = Number(id);
    if (!Number.isFinite(rid) || rid <= 0) return;
    const pick = () => {
        const i = filteredEntries.findIndex((x) => Number(x.id) === rid);
        if (i >= 0) {
            selectEntry(i);
            return;
        }
        const exists = allEntries.some((x) => Number(x.id) === rid);
        if (!exists) return;
        searchInput.value = '';
        if (ftsCheckbox) ftsCheckbox.checked = false;
        applyFilters().then(() => {
            const j = filteredEntries.findIndex((x) => Number(x.id) === rid);
            if (j >= 0) selectEntry(j);
        }).catch(() => {});
    };
    pick();
});

// ─── Live events ──────────────────────────────────────────────────────────────
api.onNewLogEntry((entry) => addEntry(entry));
api.onNewLogEntryBatch?.((entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (const entry of entries) addEntry(entry);
});

function applyWsHandshakeMessageCount(payload) {
    if (!payload || payload.handshakeDbId == null) return;
    const id = Number(payload.handshakeDbId);
    const cnt = payload.ws_message_count != null ? Number(payload.ws_message_count) : 0;
    const patch = (arr) => {
        for (const e of arr) {
            if (e && Number(e.id) === id) {
                e.ws_message_count = cnt;
                return true;
            }
        }
        return false;
    };
    if (patch(allEntries) || patch(filteredEntries)) scheduleRenderVirtual();
}
api.onWsHandshakeMessageCount?.(applyWsHandshakeMessageCount);

function _onInterceptRuleMatchedToast({ type, ruleName, url }) {
    showInterceptToast(type, ruleName, url);
}
api.onInterceptRuleMatched?.(_onInterceptRuleMatchedToast);
api.onInterceptRuleMatchedBatch?.((items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    for (const it of items) _onInterceptRuleMatchedToast(it);
});

function showInterceptToast(type, ruleName, url) {
    let container = document.getElementById('intercept-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'intercept-toast-container';
        container.style.cssText = 'position:fixed;bottom:12px;right:14px;z-index:9999;display:flex;flex-direction:column;gap:6px;pointer-events:none;max-width:380px';
        document.body.appendChild(container);
    }
    const icon = type === 'mock' ? '⚡' : type === 'block' ? '🚫' : '🔧';
    const color = type === 'mock' ? '#f59e0b' : type === 'block' ? '#ef4444' : '#3b7ef8';
    const toast = document.createElement('div');
    toast.style.cssText = `display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-radius:8px;background:var(--bg2,#1c2236);border:1px solid ${color}44;box-shadow:0 4px 16px rgba(0,0,0,.45);pointer-events:auto;opacity:0;transform:translateY(8px);transition:all .25s ease;font-size:11px;color:var(--text,#c9d3e8)`;
    const iconEl = document.createElement('span');
    iconEl.textContent = icon;
    iconEl.style.cssText = 'font-size:14px;flex-shrink:0;margin-top:1px';
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0';
    const nameEl = document.createElement('div');
    nameEl.style.cssText = `font-weight:700;color:${color};margin-bottom:2px`;
    nameEl.textContent = ruleName || 'Intercept Rule';
    const urlEl = document.createElement('div');
    urlEl.style.cssText = 'font-size:10px;color:var(--text-dim,#5c6b8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    urlEl.textContent = url || '';
    urlEl.title = url || '';
    body.appendChild(nameEl);
    body.appendChild(urlEl);
    toast.appendChild(iconEl);
    toast.appendChild(body);
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
    setTimeout(() => {
        toast.style.opacity = '0'; toast.style.transform = 'translateY(8px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ─── Resize observer ──────────────────────────────────────────────────────────
let _lvScrollResizeRaf = null;
const _resizeObs = new ResizeObserver(() => {
    if (_lvScrollResizeRaf) return;
    _lvScrollResizeRaf = requestAnimationFrame(() => {
        _lvScrollResizeRaf = null;
        scheduleRenderVirtual();
    });
});
_resizeObs.observe(lvScroll);
window.addEventListener('beforeunload', () => { _resizeObs.disconnect(); });

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
    // Get initial recording state
    try {
        const status = await api.getLogStatus?.();
        if (status) updateRecBtn(!!(status.enabled));
    } catch {}

    await loadSessionSidebar();

    // Check if this window was opened for a specific session
    let initSessionId = null;
    try { initSessionId = await api.getInitialSessionId(); } catch {}

    if (initSessionId) {
        await activateSidebarSession(initSessionId, false);
    } else {
        // Default: live mode — load current session entries
        try {
            const logs = await api.getExistingLogs();
            if (logs?.length) {
                for (const l of logs) { allEntries.push(l); if (l.tabId||l.tab_id) knownTabs.add(l.tabId||l.tab_id); }
                updateTabFilter();
                await applyFilters();
            }
        } catch (e) { console.error('init logs:', e); }
        scheduleRenderVirtual();
    }
}
init();
setupMarkPanel();
setupWsMessagesToggle();

// ─── Multi-select filter widgets ─────────────────────────────────────────────
function syncMsBadge(badgeId, btnId, count) {
    const badge = document.getElementById(badgeId);
    const btn   = document.getElementById(btnId);
    if (badge) { badge.textContent = count; badge.classList.toggle('vis', count > 0); }
    if (btn)   { btn.classList.toggle('ms-filtered', count > 0); }
}

function setupMultiSelect(btnId, dropId, badgeId, selSet) {
    const btn  = document.getElementById(btnId);
    const drop = document.getElementById(dropId);
    if (!btn || !drop) return;

    // Open / close toggle
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.ms-drop.ms-open').forEach(d => {
            if (d !== drop) { d.classList.remove('ms-open'); document.getElementById(d.id.replace('-drop', '-btn'))?.classList.remove('ms-open'); }
        });
        const nowOpen = drop.classList.toggle('ms-open');
        btn.classList.toggle('ms-open', nowOpen);
    });

    // Checkbox changes
    drop.addEventListener('change', (e) => {
        if (e.target.type !== 'checkbox') return;
        if (e.target.checked) selSet.add(e.target.value);
        else selSet.delete(e.target.value);
        syncMsBadge(badgeId, btnId, selSet.size);
        applyFilters();
    });

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'ms-clear';
    clearBtn.textContent = '✕ Clear filter';
    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        drop.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        selSet.clear();
        syncMsBadge(badgeId, btnId, 0);
        applyFilters();
    });
    drop.appendChild(clearBtn);
}

function setupMultiSelects() {
    setupMultiSelect('ms-type-btn',   'ms-type-drop',   'ms-type-badge',   selectedTypes);
    setupMultiSelect('ms-status-btn', 'ms-status-drop', 'ms-status-badge', selectedStatuses);
    setupMultiSelect('ms-tab-btn',    'ms-tab-drop',    'ms-tab-badge',    selectedTabs);
    setupMultiSelect('ms-activity-btn', 'ms-activity-drop', 'ms-activity-badge', selectedActivityTypes);
}

// Close all dropdowns when clicking outside
document.addEventListener('click', () => {
    document.querySelectorAll('.ms-drop.ms-open').forEach(d => {
        d.classList.remove('ms-open');
        document.getElementById(d.id.replace('-drop', '-btn'))?.classList.remove('ms-open');
    });
});

// ─── Resizable list/detail split ─────────────────────────────────────────────
(function () {
    const resizer   = document.getElementById('lv-resizer');
    const listPane  = document.getElementById('lv-list-pane');
    const container = document.getElementById('lv-body');
    if (!resizer || !listPane || !container) return;
    let dragging = false, startX = 0, startW = 0;
    resizer.addEventListener('mousedown', (e) => {
        dragging = true; startX = e.clientX; startW = listPane.offsetWidth;
        resizer.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const newW = Math.max(240, Math.min(startW + (e.clientX - startX), container.offsetWidth - 280));
        listPane.style.width = newW + 'px';
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    });
})();

// ─── Sidebar collapse toggle ──────────────────────────────────────────────────
(function () {
    const sidebar   = document.getElementById('lv-sidebar');
    const toggleBtn = document.getElementById('si-toggle-btn');
    if (!sidebar || !toggleBtn) return;

    const KEY = 'cupnet-lv-sidebar-open';
    let open = localStorage.getItem(KEY) !== 'false';

    function applyCollapse() {
        sidebar.classList.toggle('collapsed', !open);
        toggleBtn.textContent = open ? '◀' : '▶';
        toggleBtn.title = open ? 'Collapse sessions' : 'Expand sessions';
        localStorage.setItem(KEY, open ? 'true' : 'false');
    }
    applyCollapse();

    toggleBtn.addEventListener('click', () => {
        open = !open;
        applyCollapse();
    });
})();

// ─── Web Request Tools — row context menu ───────────────────────────────────
(function () {
    const menu = document.getElementById('wrt-ctx-menu');
    if (!menu || !lvRows) return;

    /** @type {{ entry: object, idx: number } | null} */
    let ctxState = null;

    function isHttpRequestEntry(entry) {
        if (!entry || entry._browserEvent) return false;
        const type = String(entry.type || '').toLowerCase();
        if (type === 'screenshot' || type === 'cupnet') return false;
        if (getCupnetSessionTrafficPresentation(entry)) return false;
        const url = String(entry.url || '');
        return /^https?:\/\//i.test(url) && entry.id != null;
    }

    function hideMenu() {
        menu.classList.add('hidden');
        ctxState = null;
    }

    function showMenu(e, entry, idx) {
        ctxState = { entry, idx };
        const id = Number(entry.id);
        menu.innerHTML =
            '<div class="wrt-ctx-menu-title">Web Request Tools</div>' +
            '<div class="wrt-ctx-menu-item" data-action="apply-new">Open with tab context (new tab)</div>' +
            '<div class="wrt-ctx-menu-item" data-action="apply-active">Open with tab context (active tab)</div>' +
            '<div class="wrt-ctx-menu-sep"></div>' +
            '<div class="wrt-ctx-menu-item" data-action="export">Export launch profile…</div>' +
            '<div class="wrt-ctx-menu-item" data-action="load-file">Load launch profile…</div>' +
            '<div class="wrt-ctx-menu-sep"></div>' +
            `<div class="wrt-ctx-menu-item" data-action="editor"${Number.isFinite(id) ? '' : ' class="disabled"'}>Request Editor</div>` +
            '<div class="wrt-ctx-menu-item" data-action="curl">Copy as curl</div>';

        menu.style.left = `${Math.min(e.clientX, window.innerWidth - 240)}px`;
        menu.style.top = `${Math.min(e.clientY, window.innerHeight - 280)}px`;
        menu.classList.remove('hidden');
    }

    lvRows.addEventListener('contextmenu', (e) => {
        const row = e.target.closest?.('.lv-row');
        if (!row) return;
        const idx = parseInt(row.dataset.index, 10);
        const entry = filteredEntries[idx];
        if (!isHttpRequestEntry(entry)) return;
        e.preventDefault();
        if (!selectedRequestIds.has(entry.id)) {
            selectedRequestIds.clear();
            selectedRequestIds.add(entry.id);
            selectionAnchorIdx = idx;
            selectedIndex = idx;
            selectEntry(idx);
        }
        showMenu(e, entry, idx);
    });

    menu.addEventListener('click', (e) => {
        const item = e.target.closest?.('.wrt-ctx-menu-item');
        if (!item || item.classList.contains('disabled') || !ctxState) return;
        const action = item.dataset.action;
        const entry = ctxState.entry;
        const id = Number(entry.id);
        hideMenu();

        if (action === 'apply-new') {
            void api.applyLaunchProfileFromRequest?.(id, { newTab: true }).then((r) => {
                if (!r?.success) alert(r?.error || 'Could not apply launch profile');
            }).catch((err) => alert(String(err?.message || err)));
            return;
        }
        if (action === 'apply-active') {
            void api.applyLaunchProfileFromRequest?.(id, { newTab: false }).then((r) => {
                if (!r?.success) alert(r?.error || 'Could not apply launch profile');
            }).catch((err) => alert(String(err?.message || err)));
            return;
        }
        if (action === 'export') {
            void api.exportLaunchProfileFromRequest?.(id).then((r) => {
                if (r?.canceled) return;
                if (!r?.success) alert(r?.error || 'Export failed');
            }).catch((err) => alert(String(err?.message || err)));
            return;
        }
        if (action === 'load-file') {
            void api.openSessionProfileModal?.();
            return;
        }
        if (action === 'editor') {
            if (!Number.isFinite(id)) return;
            void api.openRequestEditor(id).catch((err) => alert(String(err?.message || err)));
            return;
        }
        if (action === 'curl') {
            const text = buildCurlCommand(entry);
            void navigator.clipboard.writeText(text).catch((err) => alert(String(err?.message || err)));
        }
    });

    document.addEventListener('click', (e) => {
        if (!menu.classList.contains('hidden') && !menu.contains(e.target)) hideMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideMenu();
    });
    window.addEventListener('blur', hideMenu);
})();
