'use strict';

const api = window.electronAPI;

// ─── State ────────────────────────────────────────────────────────────────────
let allEntries        = [];
let filteredEntries   = [];
let selectedIndex     = -1;
let autoScrollEnabled = true;
let currentSessionId  = null;
let knownTabs         = new Set();
let highlightRules    = {};

// Session filter state — replaces unreliable <select> value approach
// null = live/current, 'all' = all sessions, number = specific session ID
let sessionFilterMode = null;

// Remember which detail tab the user last chose
let lastActiveTab = 'headers';

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
const lvCount        = document.getElementById('lv-count');
const autoScrollBtn  = document.getElementById('auto-scroll-btn');
const exportHarBtn   = document.getElementById('export-har-btn');
const exportBundleBtn = document.getElementById('export-bundle-btn');
const importBundleBtn = document.getElementById('import-bundle-btn');
const traceModeBtn  = document.getElementById('trace-mode-btn');
const openRulesBtn   = document.getElementById('open-rules-btn');
const clearLogsBtn   = document.getElementById('clear-logs');
const replayBar      = document.getElementById('lv-replay-bar');
const replayBtn      = document.getElementById('lv-replay-btn');
const addToCompareBtn = document.getElementById('lv-add-to-compare');
const openCompareBtn = document.getElementById('lv-open-compare');
const rawBtn         = document.getElementById('lv-raw-btn');
const copyUrlBtn     = document.getElementById('lv-copy-url');
const replayDiff     = document.getElementById('lv-replay-diff');
const replayResult   = document.getElementById('lv-replay-result');
const replayBody     = document.getElementById('replay-body');
const replayStatus   = document.getElementById('replay-status-badge');
const markPanel      = document.getElementById('lv-mark-panel');
const tagColorsWrap  = document.getElementById('lv-tag-colors');
const tagClearBtn    = document.getElementById('lv-tag-clear');
const notePreview    = document.getElementById('lv-note-preview');
const noteOpenBtn    = document.getElementById('lv-note-open');
const commentTextarea = document.getElementById('comment-textarea');
const commentSaveBtn = document.getElementById('comment-save-btn');
const markStatus     = document.getElementById('lv-mark-status');
const tabBtns        = document.querySelectorAll('.lv-tab-btn');
const tabContents    = document.querySelectorAll('.lv-tab-content');
const protectionModal = document.getElementById('protection-modal');
const protectionConfirmBtn = document.getElementById('protection-confirm-btn');
const protectionCancelBtn = document.getElementById('protection-cancel-btn');
const compareSideModal = document.getElementById('compare-side-modal');
const compareSidePicker = document.getElementById('compare-side-picker');
const compareSideCancelBtn = document.getElementById('compare-side-cancel-btn');
const recBtn         = document.getElementById('lv-rec-btn');
const TAG_COLORS     = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#f472b6'];
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
    const map = { GET:'m-get', POST:'m-post', PUT:'m-put', PATCH:'m-patch', DELETE:'m-delete', HEAD:'m-head', OPTIONS:'m-options' };
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
        'typing-end': 'Typing',
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
function formatBody(b) {
    if (!b) return null;
    if (typeof b !== 'string') return JSON.stringify(b, null, 2);
    if (b.startsWith('<base64|')) {
        const parsed = parseBase64Body(b);
        if (parsed) return null; // handled separately as image
        return `[Binary — ${b.slice(0, 60)}…]`;
    }
    try { return JSON.stringify(JSON.parse(b), null, 2); } catch { return b; }
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
        if (body.startsWith('<base64|')) body = '[Binary - use Raw tab]';
        else if (body.length > 8000) body = body.slice(0, 8000) + '\n... [truncated]';
        const escaped = body.replace(/\\/g, '\\\\').replace(/'/g, "'\\\\''");
        cmd += ` \\\n  --data-raw '${escaped}'`;
    }
    return cmd;
}

/** Build raw HTTP in curl -v style (request with >, response with <) */
function buildRawHttp(entry) {
    const reqH = parseHeaders(entry.request_headers || entry.request?.headers) || {};
    const resH = parseHeaders(entry.response_headers || entry.response?.headers) || {};
    const method = (entry.method || 'GET').toUpperCase();
    const url = entry.url || '';
    const status = entry.status ?? entry.response?.statusCode ?? 0;
    let reqBody = entry.request_body ?? entry.request?.body ?? '';
    let respBody = entry.response_body ?? entry.responseBody ?? '';
    if (typeof reqBody !== 'string') reqBody = String(reqBody);
    if (typeof respBody !== 'string') respBody = String(respBody);
    if (respBody.startsWith('<base64|') || respBody.startsWith('__b64__:')) {
        let bLen = 0;
        try { bLen = respBody.startsWith('__b64__:') ? atob(respBody.slice(8)).length : respBody.length; } catch {}
        respBody = `[Binary data, ${formatFileSize(bLen)}]`;
    }

    let path = '/';
    try { const u = new URL(url); path = u.pathname + (u.search || ''); } catch {}
    const reqLine = `${method} ${path} HTTP/1.1`;
    const reqHeaders = Object.entries(reqH).map(([k, v]) => `${k}: ${v}`);
    const reqLines = [reqLine, ...reqHeaders, ''].map(l => `> ${l}`);
    const reqPart = reqLines.join('\n') + (reqBody ? `\n${reqBody}` : '');

    const statusText = status >= 200 && status < 300 ? 'OK' : status === 301 ? 'Moved Permanently' : status === 302 ? 'Found' : status === 404 ? 'Not Found' : status === 500 ? 'Internal Server Error' : '';
    const resLine = `HTTP/1.1 ${status || '000'} ${statusText}`;
    const resHeaders = Object.entries(resH).map(([k, v]) => `${k}: ${v}`);
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
    calcWindow();
    const tot = filteredEntries.length;
    spacerTop.style.height    = `${renderStart * ROW_HEIGHT}px`;
    spacerBottom.style.height = `${Math.max(0, (tot - renderEnd) * ROW_HEIGHT)}px`;
    lvRows.innerHTML = '';
    for (let i = renderStart; i < renderEnd; i++) {
        lvRows.appendChild(buildRow(filteredEntries[i], i));
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

function buildRow(entry, idx) {
    ensureAnnotationFields(entry);
    const row = document.createElement('div');
    row.className = 'lv-row';
    row.dataset.index = idx;
    row.style.height = ROW_HEIGHT + 'px';
    if (idx === selectedIndex) row.classList.add('selected');
    if (entry.error) row.classList.add('lv-error');

    const status  = entry.status ?? entry.response?.statusCode;
    const method  = (entry.method || '').toUpperCase();
    const type    = entry.type || '';
    const url     = entry.url || '';
    const host    = entry.host || extractHost(url);
    const dur     = entry.duration_ms ?? entry.duration;

    const hl = highlightRules[url];
    if (hl) { row.style.borderLeft = `3px solid ${hl}`; row.classList.add('hl-rule'); }
    if (String(type).toLowerCase() === 'mock') row.classList.add('lv-row-mock');

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
        row.innerHTML =
            `<div class="lv-td col-idx">${idx + 1}</div>` +
            `<div class="lv-td col-method"><span class="method-badge m-other">Scrn</span></div>` +
            `<div class="lv-td col-status"><span class="lv-status s-2xx">OK</span></div>` +
            `<div class="lv-td col-mark"><div class="mark-stack">${tagDot}</div></div>` +
            `<div class="lv-td col-host"><span class="host-chip" title="${esc(pageHost)}">${esc(pageHost)}</span></div>` +
            `<div class="lv-td col-type"><span class="type-chip type-screenshot" title="Screenshot trigger">${esc(typeLbl)}</span></div>` +
            `<div class="lv-td col-dur"><span class="lv-dur">${ts}</span></div>` +
            `<div class="lv-td col-path"><span class="ss-row-badge" title="Screenshot entry">📸</span><span class="lv-path" title="${esc(pageUrl)}">${esc(pageUrl)}</span></div>`;
        row.addEventListener('click', () => selectEntry(idx));
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
    row.innerHTML =
        `<div class="lv-td col-idx">${idx + 1}</div>` +
        `<div class="lv-td col-method"><span class="method-badge ${methodCls(method)}">${esc(method) || '—'}</span></div>` +
        `<div class="lv-td col-status"><span class="lv-status ${entry.error ? 's-err' : statusCls(status)}">${status || (entry.error ? 'ERR' : '—')}${cookieMarkV3}</span></div>` +
        `<div class="lv-td col-mark">${tagDot}</div>` +
        `<div class="lv-td col-host"><span class="host-chip" title="${esc(host)}">${esc(host)}</span></div>` +
        `<div class="lv-td col-type"><span class="type-chip" title="${esc(type)}">${esc(shortTypeLabel(type))}</span></div>` +
        `<div class="lv-td col-dur"><span class="lv-dur ${durCls(dur)}">${formatDur(dur)}</span></div>` +
        `<div class="lv-td col-path">${mockBadge}${extBadge}<span class="lv-path" title="${esc(url)}">${esc(truncUrl(url))}</span></div>`;

    row.addEventListener('click', () => selectEntry(idx));
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

    // Type filter (multi)
    if (selectedTypes.size > 0) {
        const eType = (e.type || '').toLowerCase();
        if (![...selectedTypes].some(t => t.toLowerCase() === eType)) return false;
    }

    // Status filter (multi)
    const s = e.status ?? e.response?.statusCode;
    if (selectedStatuses.size > 0) {
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
    if (scOnlyCheckbox?.checked) {
        if (countSetCookies(e) === 0) return false;
    }

    // Hide OPTIONS requests
    if (hideOptionsCheckbox?.checked) {
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
        filteredEntries = await api.ftsSearch(q, currentSessionId).catch(() => []);
        if (scOnlyCheckbox?.checked) {
            filteredEntries = filteredEntries.filter(e => countSetCookies(e) > 0);
        }
        if (hideOptionsCheckbox?.checked) {
            filteredEntries = filteredEntries.filter(e => (e.method || '').toUpperCase() !== 'OPTIONS');
        }
        if (hideScreenshotCheckbox?.checked) {
            filteredEntries = filteredEntries.filter(e => String(e.type || '').toLowerCase() !== 'screenshot');
        }
    } else {
        filteredEntries = allEntries.filter(entryPassesFilter);
    }
    selectedIndex = -1;
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

function renderSessionList() {
    if (!sessionListEl) return;
    sessionListEl.innerHTML = '';

    if (!sidebarSessions.length) {
        sessionListEl.innerHTML = '<div style="padding:12px 10px;color:var(--text-dim);font-size:11px">No recorded sessions yet</div>';
        return;
    }

    // Sort: renamed sessions first (by start desc), then unnamed (by start desc)
    const sorted = [...sidebarSessions].sort((a, b) => {
        const aNamed = !!a.notes, bNamed = !!b.notes;
        if (aNamed !== bNamed) return bNamed ? 1 : -1; // named float to top
        // Within same group: most recent first
        return b.started_at > a.started_at ? 1 : b.started_at < a.started_at ? -1 : 0;
    });

    let lastGroupNamed = null; // track group separator

    for (const s of sorted) {
        const isNamed      = !!s.notes;
        // LIVE = only the session currently being written to by main process
        const isCurrentSrv = s.id === currentSrvSessId;
        // Active = the one currently shown in this window
        const isActive = activeSidebarId === null ? isCurrentSrv
                                                  : s.id === activeSidebarId;

        // Group separator between named and unnamed
        if (lastGroupNamed !== null && lastGroupNamed !== isNamed) {
            const sep = document.createElement('div');
            sep.style.cssText = 'height:1px;background:var(--border2);margin:4px 0;opacity:0.5';
            sessionListEl.appendChild(sep);
        }
        lastGroupNamed = isNamed;

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

        // Click on item → load session
        // FIX: use isCurrentSrv (not the removed isLive variable)
        item.addEventListener('click', (e) => {
            if (e.target.closest('.si-act-btn')) return;
            activateSidebarSession(s.id, isCurrentSrv);
        });

        // Rename
        item.querySelector('.si-rename-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            startRenameSession(item, s);
        });

        // Open in new window
        item.querySelector('.si-newwin-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            api.openSessionInNewWindow(s.id).catch(() => {});
        });

        // Delete session
        item.querySelector('.si-del-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const count = s.request_count ?? 0;
            if (count > 1) {
                const label = s.notes ? `"${s.notes}"` : `Session #${s.id}`;
                const ok = window.confirm(
                    `Delete ${label}?\n\nThis will permanently remove ${count} requests. This cannot be undone.`
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
            // If the deleted session was selected, switch to live
            if (activeSidebarId === s.id) {
                sessionFilterMode = null;
                activeSidebarId = null;
            }
            await loadSessionSidebar();
        });

        sessionListEl.appendChild(item);
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
    if (entry.type !== 'screenshot' && entry.id && !entry._detailLoaded) {
        try {
            const full = await api.getRequestDetail(entry.id);
            if (full) {
                Object.assign(entry, full);
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

    document.getElementById('lv-detail-url').textContent = url;

    const dStatus = document.getElementById('d-status');
    dStatus.textContent = status || (entry.error ? 'Error' : '—');
    dStatus.className   = `meta-val lv-status ${entry.error ? 's-err' : statusCls(status)}`;

    document.getElementById('d-method').textContent   = method || '—';
    document.getElementById('d-type').textContent     = type   || '—';
    document.getElementById('d-duration').textContent = formatDur(dur);
    document.getElementById('d-time').textContent     = formatTime(entry.created_at || entry.timestamp);
    const tabDisplay = (entry.tabId || entry.tab_id || '—');
    const isExt = entry.source === 'external' || (tabDisplay + '').startsWith('ext_');
    document.getElementById('d-tab').textContent = isExt ? `EXT :${entry.extPort || tabDisplay}` : tabDisplay;

    // Replay bar
    const canAnnotate = entry.id && !String(entry.id).startsWith('ss-');
    const showReplay = entry.id && !type.startsWith('websocket') && type !== 'screenshot';
    replayBar.classList.toggle('visible', showReplay);
    if (showReplay) replayBtn.dataset.entryId = entry.id;
    replayResult.classList.remove('visible');
    replayDiff.textContent = '';

    // Copy URL
    copyUrlBtn.onclick = () => {
        navigator.clipboard.writeText(url).catch(() => {});
        copyUrlBtn.textContent = '✓ Copied';
        setTimeout(() => { copyUrlBtn.textContent = '⧉ Copy URL'; }, 1500);
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
    const urlBar    = document.getElementById('lv-detail-url-bar');
    const metaRow   = document.getElementById('lv-detail-meta');

    if (type === 'screenshot') {
        lvTabs.style.display = 'none';
        lvTabBody.style.display = 'none';
        if (urlBar) urlBar.style.display = 'none';
        if (metaRow) metaRow.style.display = 'none';
        replayBar.style.display = 'none';
        if (markPanel) markPanel.classList.remove('visible');
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

    lvTabs.style.display = '';
    lvTabBody.style.display = '';
    ssDirect.style.display = 'none';
    if (urlBar) urlBar.style.display = '';
    if (metaRow) metaRow.style.display = '';
    replayBar.style.display = '';
    if (markPanel) markPanel.classList.toggle('visible', !!canAnnotate);
    if (canAnnotate) syncMarkPanel(entry);

    // Parse headers once
    const parsedReqHeaders  = parseHeaders(entry.request_headers  || entry.request?.headers);
    const parsedRespHeaders = parseHeaders(entry.response_headers || entry.response?.headers);

    // Headers
    renderHeaders(document.getElementById('request-headers'),  parsedReqHeaders);
    renderHeaders(document.getElementById('response-headers'), parsedRespHeaders);

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
    const reqBody   = entry.request_body || entry.request?.body;
    const reqCtRaw  = findHeader(parsedReqHeaders, 'content-type') || '';
    const reqCt     = reqCtRaw.toLowerCase();
    const reqWrap   = document.getElementById('request-body-wrap');
    const reqSizeEl = document.getElementById('req-body-size');
    const reqBadge  = document.getElementById('req-body-type-badge');
    const reqCopyJsonBtn = document.getElementById('req-copy-json-btn');

    if (reqSizeEl) reqSizeEl.textContent = reqBody ? `${(reqBody.length / 1024).toFixed(1)} KB` : 'No body';

    const isFormEncoded = reqCt.includes('application/x-www-form-urlencoded');
    const isMultipart   = reqCt.includes('multipart/form-data');
    const isJsonBody    = reqCt.includes('application/json') || reqCt.includes('+json');
    const formPairs     = (isFormEncoded && reqBody) ? parseFormBody(reqBody) : null;

    // Badge
    if (reqBadge) {
        if (isFormEncoded)      { reqBadge.textContent = 'form-urlencoded'; reqBadge.style.display = ''; }
        else if (isMultipart)   { reqBadge.textContent = 'multipart/form-data'; reqBadge.style.display = ''; }
        else if (isJsonBody)    { reqBadge.textContent = 'application/json'; reqBadge.style.display = ''; }
        else if (reqBody && reqCt) { reqBadge.textContent = reqCt.split(';')[0].trim(); reqBadge.style.display = ''; }
        else                    { reqBadge.style.display = 'none'; }
    }

    // JSON copy button
    if (reqCopyJsonBtn) {
        reqCopyJsonBtn.style.display = (isJsonBody && reqBody) ? '' : 'none';
        if (isJsonBody && reqBody) {
            reqCopyJsonBtn.onclick = () => {
                try {
                    const pretty = JSON.stringify(JSON.parse(reqBody), null, 2);
                    navigator.clipboard.writeText(pretty).then(
                        () => flashBtn(reqCopyJsonBtn, '✓'), () => flashBtn(reqCopyJsonBtn, '✗'));
                } catch {
                    navigator.clipboard.writeText(reqBody).then(
                        () => flashBtn(reqCopyJsonBtn, '✓'), () => flashBtn(reqCopyJsonBtn, '✗'));
                }
            };
        }
    }

    if (formPairs && formPairs.length) {
        renderFormBody(reqWrap, formPairs, reqBody);
    } else if (isJsonBody && reqBody) {
        const pretty = formatBody(reqBody);
        reqWrap.innerHTML = `<div class="body-content json-body">${esc(pretty)}</div>`;
    } else if (isMultipart && reqBody) {
        reqWrap.innerHTML = `<div class="body-content" style="color:var(--text-dim)">${esc(reqBody)}</div>`;
    } else {
        const reqFmt = formatBody(reqBody);
        if (reqFmt) {
            reqWrap.innerHTML = `<div class="body-content">${esc(reqFmt)}</div>`;
        } else if (!queryPairs.length) {
            reqWrap.innerHTML = '<span style="padding:14px;color:var(--text-dim);font-style:italic;display:block">(empty)</span>';
        } else {
            reqWrap.innerHTML = '';
        }
    }

    // Wire up request body toolbar buttons
    wireReqBodyBtns(reqBody, formPairs);

    // Raw HTTP tab (curl -v style + curl command)
    const rawEl = document.getElementById('raw-http-content');
    const rawWrap = rawEl?.closest('.lv-tab-content');
    if (rawEl) {
        rawEl.textContent = buildRawHttp(entry);
        if (rawWrap) rawWrap.dataset.curl = buildCurlCommand(entry);
    }

    // Response body
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
    const isHtml  = !isImage && respCt.includes('html');

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
            respWrap.innerHTML = `<div class="body-content">${esc(respFmt)}</div>`;
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

    activateTab(lastActiveTab);
}

function syncMarkPanel(entry) {
    if (!markPanel || !entry) return;
    const tag = entry.tag || null;
    const note = entry.note || '';
    if (notePreview) notePreview.textContent = notePreviewText(note);
    if (commentTextarea) commentTextarea.value = note;
    tagColorsWrap?.querySelectorAll('.mark-color').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.color === tag);
    });
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

function renderFormBody(container, pairs, rawBody) {
    const table = document.createElement('table');
    table.className = 'form-table';
    table.innerHTML = `
        <thead><tr>
            <th>Key</th>
            <th>Value</th>
        </tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const { key, value, rawKey, rawValue } of pairs) {
        const tr = document.createElement('tr');
        const showRaw = rawValue !== value;
        tr.innerHTML = `
            <td class="form-td-key">${esc(key)}</td>
            <td class="form-td-val">${esc(value)}${showRaw
                ? `<br><span class="form-td-raw">${esc(rawValue)}</span>`
                : ''}</td>`;
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    container.innerHTML = `<div style="padding:4px 0 2px 10px">
        <span class="form-type-badge">application/x-www-form-urlencoded</span>
        <span style="font-size:10px;color:var(--text-dim)">${pairs.length} field${pairs.length !== 1 ? 's' : ''}</span>
    </div>`;
    container.appendChild(table);
}

function wireReqBodyBtns(rawBody, formPairs) {
    const btnText = document.getElementById('req-copy-text-btn');
    const btnArr  = document.getElementById('req-copy-arr-btn');
    const btnObj  = document.getElementById('req-copy-obj-btn');
    const btnSave = document.getElementById('req-save-btn');
    const hasForm = formPairs && formPairs.length > 0;
    const hasBody = !!rawBody;

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
            const blob = new Blob([rawBody], { type: 'text/plain' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href = url; a.download = `request-body-${Date.now()}.txt`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        };
    }
}

function renderHeaders(container, headers) {
    container.innerHTML = '';
    if (!headers || typeof headers !== 'object') {
        container.innerHTML = '<div class="body-empty">(none)</div>';
        return;
    }
    const entries = Object.entries(headers);
    if (!entries.length) { container.innerHTML = '<div class="body-empty">(none)</div>'; return; }
    for (const [k, v] of entries) {
        const vals = Array.isArray(v) ? v : [v];
        for (const item of vals) {
            const row = document.createElement('div');
            row.className = 'hdr-row';
            row.innerHTML = `<span class="hdr-name">${esc(k)}</span><span class="hdr-val">${esc(String(item))}</span>`;
            container.appendChild(row);
        }
    }
}

function findHeader(headers, name) {
    if (!headers) return '';
    const lc = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lc) return Array.isArray(v) ? v[0] : String(v);
    }
    return '';
}

function renderQueryParams(container, pairs) {
    container.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'form-table';
    table.innerHTML = `<thead><tr><th>Key</th><th>Value</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const { key, value } of pairs) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="form-td-key">${esc(key)}</td><td class="form-td-val">${esc(value)}</td>`;
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
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

    // ── Sent cookies (Cookie: header) ────────────────────────────────────────
    const cookieHeader = Object.entries(reqHeaders || {})
        .find(([k]) => k.toLowerCase() === 'cookie')?.[1] || '';
    const sentCookies = parseRequestCookies(cookieHeader);

    const sentSection = document.createElement('div');
    sentSection.className = 'ck-section';
    sentSection.innerHTML = `<div class="ck-section-title">
        Sent <span style="color:#7dd3fc">Cookie</span>
        <span class="ck-count">${sentCookies.length}</span>
        ${sentCookies.length ? '<button class="ck-copy-btn" id="ck-sent-copy">⎘ JSON</button>' : ''}
    </div>`;
    if (sentCookies.length === 0) {
        sentSection.innerHTML += '<div class="ck-empty">No cookies sent with this request</div>';
    } else {
        const tbl = document.createElement('table');
        tbl.className = 'ck-table';
        tbl.innerHTML = `<thead><tr><th>Name</th><th>Value</th></tr></thead>`;
        const tbody = document.createElement('tbody');
        for (const c of sentCookies) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td class="ck-td-name">${esc(c.name)}</td><td class="ck-td-val">${esc(c.value)}</td>`;
            tbody.appendChild(tr);
        }
        tbl.appendChild(tbody);
        sentSection.appendChild(tbl);
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

    // ── Received cookies (Set-Cookie: headers) ────────────────────────────────
    const rawSetCookies = getSetCookies(respHeaders);
    const parsed = rawSetCookies.map(parseSetCookie).filter(Boolean);

    const recvSection = document.createElement('div');
    recvSection.className = 'ck-section';
    recvSection.style.marginTop = '12px';
    recvSection.innerHTML = `<div class="ck-section-title">
        Received <span style="color:#4ade80">Set-Cookie</span>
        <span class="ck-count" style="${parsed.length ? '' : 'background:var(--bg2);color:var(--text-dim)'}">${parsed.length}</span>
        ${parsed.length ? '<button class="ck-copy-btn" id="ck-recv-copy">⎘ JSON</button>' : ''}
    </div>`;

    if (parsed.length === 0) {
        recvSection.innerHTML += '<div class="ck-empty">No Set-Cookie headers in this response</div>';
    } else {
        const tbl = document.createElement('table');
        tbl.className = 'ck-table';
        tbl.innerHTML = `<thead><tr>
            <th>Name</th><th>Value</th><th>Path / Domain</th><th>Flags</th>
        </tr></thead>`;
        const tbody = document.createElement('tbody');
        for (const c of parsed) {
            const tr = document.createElement('tr');
            const flagsHtml = [
                c.flags.includes('Secure')    ? '<span class="ck-flag ck-flag-secure">Secure</span>' : '',
                c.flags.includes('HttpOnly')  ? '<span class="ck-flag ck-flag-httponly">HttpOnly</span>' : '',
                c.flags.find(f => f.startsWith('SameSite'))
                    ? `<span class="ck-flag ck-flag-samesite">${esc(c.flags.find(f => f.startsWith('SameSite')))}</span>` : '',
                c.flags.includes('Partitioned') ? '<span class="ck-flag ck-flag-partitioned">Partitioned</span>' : '',
            ].join('');
            const pathDom = [
                c.attrs.path   ? `Path: ${esc(c.attrs.path)}` : '',
                c.attrs.domain ? `Domain: ${esc(c.attrs.domain)}` : '',
                c.attrs.expires ? `Expires: ${esc(c.attrs.expires)}` : '',
                c.attrs.maxAge  ? `Max-Age: ${esc(c.attrs.maxAge)}` : '',
            ].filter(Boolean).join('<br>');
            tr.innerHTML = `<td class="ck-td-name">${esc(c.name)}</td>
                <td class="ck-td-val">${esc(c.value)}</td>
                <td class="ck-td-attr ck-attr-row">${pathDom || '—'}</td>
                <td class="ck-td-attr">${flagsHtml || '<span style="color:var(--text-dim)">—</span>'}</td>`;
            tbody.appendChild(tr);
        }
        tbl.appendChild(tbody);
        recvSection.appendChild(tbl);
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

    // Update tab button badge
    const ckBtn = document.querySelector('.lv-tab-btn[data-tab="cookies"]');
    if (ckBtn) {
        const total = sentCookies.length + parsed.length;
        ckBtn.textContent = total > 0 ? `Cookies (${total})` : 'Cookies';
    }
}

function activateTab(name, remember = true) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
    if (remember) lastActiveTab = name;
}

tabBtns.forEach(b => b.addEventListener('click', () => activateTab(b.dataset.tab)));

// ─── Replay → Request Editor ──────────────────────────────────────────────────
if (replayBtn) {
    // Update button label to indicate it opens an editor
    replayBtn.textContent = '✏ Request Editor';
    replayBtn.title = 'Open in Request Editor (Postman-style)';
}

replayBtn?.addEventListener('click', async () => {
    const id = parseInt(replayBtn.dataset.entryId, 10);
    if (!id) return;
    replayBtn.disabled = true;
    replayBtn.textContent = '⏳ Opening…';
    try {
        await api.openRequestEditor(id);
    } catch (e) {
        alert('Could not open Request Editor: ' + e.message);
    } finally {
        replayBtn.disabled = false;
        replayBtn.textContent = '✏ Request Editor';
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

autoScrollBtn?.addEventListener('click', () => {
    autoScrollEnabled = !autoScrollEnabled;
    autoScrollBtn.classList.toggle('active', autoScrollEnabled);
    autoScrollBtn.textContent = autoScrollEnabled ? '↓ Live' : '↓ Paused';
    if (autoScrollEnabled) scrollToBottom();
});

clearLogsBtn?.addEventListener('click', async () => {
    await api.clearLogs();
    allEntries = []; filteredEntries = []; selectedIndex = -1;
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
    try { await api.exportHar(currentSessionId); }
    finally { exportHarBtn.disabled = false; exportHarBtn.textContent = '⬇ HAR'; }
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
            alert(`Bundle exported.\nRequests: ${stats.requests || 0}\nProtection: ${stats.protectionLevel || protectionLevel}\nRedacted fields: ${stats.redactedFields || 0}`);
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
            `Trace: ${preview.trace || 0}\n\n` +
            'Restore this context into current log viewer?'
        );
        if (!ok) return;
        const bundle = res.bundle || {};
        const imported = Array.isArray(bundle.traffic?.requests) ? bundle.traffic.requests.slice().reverse() : [];
        allEntries = imported.map((e) => ({ ...e, _fromBundle: true }));
        filteredEntries = allEntries.slice();
        selectedIndex = -1;
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

// Trace mode: full req/res to DB, ⌘/Ctrl+click opens Trace window
async function updateTraceBtnState() {
    if (!traceModeBtn || !api.getTraceMode) return;
    const on = await api.getTraceMode();
    traceModeBtn.classList.toggle('active', on);
    traceModeBtn.title = on ? 'Trace ON — ⌘/Ctrl+click to open Trace window' : 'Trace: full req/res to DB. ⌘/Ctrl+click to open Trace window';
}
traceModeBtn?.addEventListener('click', async (e) => {
    if (!api.setTraceMode) return;
    if (e.ctrlKey || e.metaKey) {
        api.openTraceViewer?.();
        return;
    }
    const on = !traceModeBtn.classList.contains('active');
    await api.setTraceMode(on);
    updateTraceBtnState();
});
if (api.getTraceMode) updateTraceBtnState();

// ─── Live events ──────────────────────────────────────────────────────────────
api.onNewLogEntry((entry) => addEntry(entry));
api.onNewLogEntryBatch?.((entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (const entry of entries) addEntry(entry);
});

api.onRuleHighlight?.((({ url, color }) => {
    highlightRules[url] = color;
    scheduleRenderVirtual();
}));

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
const _resizeObs = new ResizeObserver(() => scheduleRenderVirtual());
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
