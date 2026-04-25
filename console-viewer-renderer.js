'use strict';

const api = window.electronAPI;

const MAX_LINES = 50000;
const TRIM_BATCH = 10000;
const ROW_H = 22;
const VIRTUAL_BUFFER = 45;
const WRAP_MAX_ROWS = 4000;

/** @type {ReturnType<typeof normalizeEntry>[]} */
let entries = [];
let entrySeq = 0;
/** @type {number[]} */
let filteredIdx = [];
let activeTab = 'mitm';
let autoScroll = true;
let paused = false;
let searchTerm = '';
let useRegex = false;
/** @type {string[]} */
let excludeTerms = [];
let groupRepeats = false;
let wordWrap = false;

const levelOn = { error: true, warn: true, info: true, debug: true, trace: true };
const sourceOn = { mitm: true, system: true, worker: true, ffi: true, dns: true, main: true, app: true };

const bookmarks = new Set();
const BM_KEY = 'cupnet-console-bookmarks-v1';

function loadBookmarks() {
    try {
        const raw = localStorage.getItem(BM_KEY);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            for (const s of arr) bookmarks.add(Number(s));
        }
    } catch { /* ignore */ }
}
function saveBookmarks() {
    try {
        localStorage.setItem(BM_KEY, JSON.stringify([...bookmarks]));
    } catch { /* ignore */ }
}

let countAll = 0;
let countMitm = 0;
let countSystem = 0;

/** @type {number[]} ring buffer for last 60 timestamps (rate) */
const rateRing = [];
const RATE_LEN = 60;

let liveMode = true;

const logScroll = document.getElementById('cv-log-scroll');
const logViewport = document.getElementById('cv-viewport');
const logEl = document.getElementById('cv-log');
const emptyEl = document.getElementById('cv-empty');
const searchInput = document.getElementById('cv-search');
const regexCb = document.getElementById('cv-regex');
const excludeInput = document.getElementById('cv-exclude');
const countEl = document.getElementById('cv-count');
const autoscrollBtn = document.getElementById('cv-autoscroll');
const pauseBtn = document.getElementById('cv-pause');
const copyBtn = document.getElementById('cv-copy');
const clearBtn = document.getElementById('cv-clear');
const saveBtn = document.getElementById('cv-save');
const saveJsonBtn = document.getElementById('cv-save-json');
const saveCsvBtn = document.getElementById('cv-save-csv');
const wrapBtn = document.getElementById('cv-wrap');
const groupBtn = document.getElementById('cv-group');
const debugMitmSelect = document.getElementById('cv-debug-mitm');
const mitmToolbar = document.getElementById('cv-mitm-toolbar');
const tabs = document.querySelectorAll('.cv-tab');
const dbSessionSelect = document.getElementById('cv-db-session');
const cvDetail = document.getElementById('cv-detail');
const cvDetailBody = document.getElementById('cv-detail-body');
const cvDetailClose = document.getElementById('cv-detail-close');
const cvCorrHead = document.getElementById('cv-corr-head');
const cvCorrList = document.getElementById('cv-corr-list');
const ctxMenu = document.getElementById('cv-ctx-menu');

const stTotal = document.getElementById('cv-st-total');
const stVisible = document.getElementById('cv-st-visible');
const stRate = document.getElementById('cv-st-rate');
const stRange = document.getElementById('cv-st-range');

const timeFromEl = document.getElementById('cv-time-from');
const timeToEl = document.getElementById('cv-time-to');
const extraFiltersEl = document.getElementById('cv-extra-filters');
const toggleExtraFiltersBtn = document.getElementById('cv-toggle-extra-filters');
const EXTRA_FILTERS_KEY = 'cupnet-console-extra-filters-open';

(function initExtraFiltersToggle() {
    if (!extraFiltersEl || !toggleExtraFiltersBtn) return;
    try {
        if (sessionStorage.getItem(EXTRA_FILTERS_KEY) === '1') {
            extraFiltersEl.removeAttribute('hidden');
            toggleExtraFiltersBtn.setAttribute('aria-expanded', 'true');
            toggleExtraFiltersBtn.textContent = 'More filters ▴';
        }
    } catch { /* ignore */ }
    toggleExtraFiltersBtn.addEventListener('click', () => {
        const hidden = extraFiltersEl.hasAttribute('hidden');
        if (hidden) {
            extraFiltersEl.removeAttribute('hidden');
            toggleExtraFiltersBtn.setAttribute('aria-expanded', 'true');
            toggleExtraFiltersBtn.textContent = 'More filters ▴';
            try { sessionStorage.setItem(EXTRA_FILTERS_KEY, '1'); } catch { /* ignore */ }
        } else {
            extraFiltersEl.setAttribute('hidden', '');
            toggleExtraFiltersBtn.setAttribute('aria-expanded', 'false');
            toggleExtraFiltersBtn.textContent = 'More filters';
            try { sessionStorage.setItem(EXTRA_FILTERS_KEY, '0'); } catch { /* ignore */ }
        }
    });
})();

let ctxTargetSeq = null;
let selectedIdx = null;

function classifyCategory(text) {
    const t = String(text);
    if (t.startsWith('[mitm]')) return 'mitm';
    if (t.startsWith('[mitm-proxy]')) return 'mitm';
    if (t.startsWith('[mitm-cors]')) return 'mitm';
    if (t.startsWith('[ext-proxy]')) return 'mitm';
    return 'system';
}

function inferLevelFromText(text, stream) {
    const s = String(text);
    const lower = s.toLowerCase();
    const st = stream === 'stderr' ? 'stderr' : 'stdout';
    if (st === 'stderr') {
        if (/\berror\b|exception|fatal|\bfail/.test(lower)) return 'error';
        if (/\bwarn/.test(lower)) return 'warn';
    }
    if (/\bERROR\b|Error:|Exception:/.test(s)) return 'error';
    if (/\bWARN(ING)?\b/.test(s)) return 'warn';
    if (/\bDEBUG\b/.test(s)) return 'debug';
    if (/\bTRACE\b/.test(s)) return 'trace';
    return 'info';
}

function inferSourceFromText(text) {
    const t = String(text);
    if (t.startsWith('[mitm]')) {
        const rest = t.slice(6).trimStart();
        if (/^dns\b|^\[dns\]/i.test(rest) || t.includes('DNS overrides')) return 'dns';
        return 'mitm';
    }
    if (t.startsWith('[mitm-proxy]')) return 'mitm';
    if (t.startsWith('[mitm-cors]')) return 'mitm';
    if (t.startsWith('[ext-proxy]')) return 'mitm';
    if (t.includes('[ffi-dbg]')) return 'ffi';
    if (t.includes('[worker-dbg]')) return 'worker';
    if (t.startsWith('[main]')) return 'main';
    if (t.startsWith('[cupnet]')) return 'app';
    return 'system';
}

/**
 * @param {object} raw
 */
function normalizeEntry(raw) {
    const text = typeof raw.text === 'string' ? raw.text : String(raw.text || '');
    const ts = raw.ts != null ? new Date(raw.ts) : new Date();
    const stream = raw.stream === 'stderr' ? 'stderr' : 'stdout';
    let level = raw.level;
    let source = raw.source;
    let module = raw.module != null ? String(raw.module) : null;
    if (!level || typeof level !== 'string') {
        level = inferLevelFromText(text, stream);
    }
    if (!source || typeof source !== 'string') {
        source = inferSourceFromText(text);
    }
    const category = classifyCategory(text);
    const seq = raw.seq != null ? Number(raw.seq) : ++entrySeq;
    return {
        text,
        ts,
        tsMs: ts.getTime(),
        level,
        source,
        module,
        stream,
        category,
        seq,
        repeatCount: raw.repeatCount != null ? Number(raw.repeatCount) : 1,
    };
}

function getLineClass(text) {
    const t = String(text);
    if (t.includes('CUPNET_DEBUG_MITM') && (t.startsWith('[mitm]') || t.startsWith('[mitm-proxy]'))) return 'cv-mitm-cfg';
    if (t.startsWith('[mitm] dns') || t.startsWith('[mitm][dns]')) return 'cv-mitm-dns';
    if (t.startsWith('[mitm]') && t.includes('DNS overrides')) return 'cv-mitm-dns';
    if (t.startsWith('[mitm-cors]')) return 'cv-mitm-cfg';
    if (t.startsWith('[mitm] TCP')) return 'cv-mitm-tcp';
    if (t.startsWith('[mitm] CONNECT')) return 'cv-mitm-conn';
    if (t.startsWith('[mitm] →')) return 'cv-mitm-req';
    if (t.startsWith('[mitm] ←')) return 'cv-mitm-res';
    if (t.includes('[ffi-dbg]')) return 'cv-ffi';
    if (t.includes('[worker-dbg]')) return 'cv-worker';
    if (t.includes('[AUTO-RETRY]') || t.includes('Request error on attempt')) return 'cv-retry';
    if (t.startsWith('[main]')) return 'cv-main';
    if (t.includes('ERROR') || t.includes('error:') || t.includes('Error')) return 'cv-err';
    if (t.includes('Warning') || t.includes('warn')) return 'cv-warn';
    return '';
}

function levelPillClass(lvl) {
    if (lvl === 'error') return 'err';
    if (lvl === 'warn') return 'warn';
    if (lvl === 'info') return 'info';
    if (lvl === 'debug') return 'dbg';
    return 'trace';
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightSearch(html, term) {
    if (!term) return html;
    try {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return html.replace(new RegExp(`(${escaped})`, 'gi'), '<span class="cv-highlight">$1</span>');
    } catch {
        return html;
    }
}

function formatTime(d) {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
}

function parseTimeBounds() {
    let fromMs = null;
    let toMs = null;
    try {
        if (timeFromEl?.value) {
            const d = new Date(timeFromEl.value);
            if (!Number.isNaN(d.getTime())) fromMs = d.getTime();
        }
        if (timeToEl?.value) {
            const d = new Date(timeToEl.value);
            if (!Number.isNaN(d.getTime())) toMs = d.getTime();
        }
    } catch { /* ignore */ }
    return { fromMs, toMs };
}

function matchesSearch(text) {
    const t = String(text);
    const q = searchTerm;
    if (!q) return true;
    if (useRegex) {
        try {
            return new RegExp(q, 'i').test(t);
        } catch {
            return t.toLowerCase().includes(q.toLowerCase());
        }
    }
    return t.toLowerCase().includes(q.toLowerCase());
}

function matchesExclude(text) {
    if (!excludeTerms.length) return false;
    const t = String(text).toLowerCase();
    for (const ex of excludeTerms) {
        if (ex && t.includes(ex.toLowerCase())) return true;
    }
    return false;
}

function entryMatchesFilters(entry) {
    const lv = entry.level && levelOn[entry.level] !== undefined ? entry.level : 'info';
    if (!levelOn[lv]) return false;
    const src = entry.source && Object.prototype.hasOwnProperty.call(sourceOn, entry.source) ? entry.source : 'system';
    if (!sourceOn[src]) return false;
    const { fromMs, toMs } = parseTimeBounds();
    if (fromMs != null && entry.tsMs < fromMs) return false;
    if (toMs != null && entry.tsMs > toMs) return false;
    if (matchesExclude(entry.text)) return false;
    if (!matchesSearch(entry.text)) return false;
    if (activeTab === 'all') return true;
    if (activeTab === 'bookmarks') return bookmarks.has(entry.seq);
    if (activeTab === 'mitm') return entry.category === 'mitm';
    if (activeTab === 'system') return entry.category === 'system';
    return true;
}

function rebuildFilteredIndices() {
    filteredIdx = [];
    for (let i = 0; i < entries.length; i++) {
        if (entryMatchesFilters(entries[i])) filteredIdx.push(i);
    }
    updateEmptyState();
    updateStatusBar();
    renderVirtual();
}

function updateEmptyState() {
    const show = entries.length === 0 || (filteredIdx.length === 0 && entries.length > 0);
    if (emptyEl) emptyEl.hidden = !show;
    if (emptyEl && entries.length > 0 && filteredIdx.length === 0) {
        const title = emptyEl.querySelector('.cn-empty-state-title');
        const sub = emptyEl.querySelector('.cn-empty-state-sub');
        if (title) title.textContent = 'No matching lines';
        if (sub) sub.textContent = 'Adjust filters, search, or time range.';
    } else if (emptyEl && entries.length === 0) {
        const title = emptyEl.querySelector('.cn-empty-state-title');
        const sub = emptyEl.querySelector('.cn-empty-state-sub');
        if (title) title.textContent = 'No log entries yet';
        if (sub) sub.textContent = 'Logs from the main process and MITM will appear here. Enable recording to persist logs to the database for this session.';
    }
}

function updateBadges() {
    let bm = 0;
    for (const e of entries) {
        if (bookmarks.has(e.seq)) bm++;
    }
    const el = (id, n) => {
        const x = document.getElementById(id);
        if (x) x.textContent = n > 9999 ? `${Math.floor(n / 1000)}k` : String(n);
    };
    el('badge-all', countAll);
    el('badge-mitm', countMitm);
    el('badge-system', countSystem);
    el('badge-bookmarks', bm);
}

function updateStatusBar() {
    if (stTotal) stTotal.textContent = `Total: ${entries.length}`;
    if (stVisible) stVisible.textContent = `Visible: ${filteredIdx.length}`;
    if (entries.length) {
        const first = entries[0].ts;
        const last = entries[entries.length - 1].ts;
        if (stRange) stRange.textContent = `Range: ${first.toISOString().slice(11, 23)} → ${last.toISOString().slice(11, 23)}`;
    } else if (stRange) stRange.textContent = 'Range: —';
    if (stRate) stRate.textContent = rateRing.length ? `Rate: ~${rateRing.length}/s` : 'Rate: —';
}

function pushRate(ts) {
    const now = ts || Date.now();
    rateRing.push(now);
    while (rateRing.length && now - rateRing[0] > 1000) rateRing.shift();
    if (rateRing.length > RATE_LEN) rateRing.splice(0, rateRing.length - RATE_LEN);
}

function trimEntriesIfNeeded() {
    if (entries.length <= MAX_LINES) return;
    const remove = Math.min(TRIM_BATCH, entries.length - MAX_LINES + TRIM_BATCH);
    entries.splice(0, remove);
    rebuildFilteredIndices();
}

function addEntry(entry) {
    if (paused) return;
    if (groupRepeats && entries.length > 0) {
        const last = entries[entries.length - 1];
        if (last.text === entry.text && last.level === entry.level && last.source === entry.source) {
            last.repeatCount = (last.repeatCount || 1) + 1;
            countAll++;
            if (last.category === 'mitm') countMitm++;
            else countSystem++;
            trimEntriesIfNeeded();
            updateBadges();
            pushRate(Date.now());
            rebuildFilteredIndices();
            notifyInactiveTab(last);
            return;
        }
    }
    entries.push(entry);
    countAll++;
    if (entry.category === 'mitm') countMitm++;
    else countSystem++;
    trimEntriesIfNeeded();
    updateBadges();
    pushRate(Date.now());
    if (entryMatchesFilters(entry)) {
        filteredIdx.push(entries.length - 1);
        updateEmptyState();
        updateStatusBar();
        if (!wordWrap) {
            renderVirtual();
        } else {
            renderWrapMode();
        }
    } else {
        updateStatusBar();
    }
    if (autoScroll && !wordWrap) scrollToBottom();
    notifyInactiveTab(entry);
}

function notifyInactiveTab(entry) {
    const category = entry.category;
    for (const tab of tabs) {
        const t = tab.dataset.tab;
        if (t === activeTab) continue;
        if (t === 'all' || t === category || (t === 'bookmarks' && bookmarks.has(entry.seq))) {
            tab.classList.add('has-new');
        }
    }
}

function scrollToBottom() {
    if (!logScroll) return;
    requestAnimationFrame(() => {
        logScroll.scrollTop = logScroll.scrollHeight;
    });
}

function renderVirtual() {
    if (!logEl || !logScroll) return;
    if (wordWrap) {
        renderWrapMode();
        return;
    }
    const total = filteredIdx.length;
    if (total === 0) {
        logEl.innerHTML = '';
        logEl.style.paddingTop = '0';
        logEl.style.paddingBottom = '0';
        if (countEl) countEl.textContent = '0 visible';
        return;
    }
    const totalH = total * ROW_H;
    const viewH = logScroll.clientHeight || 400;
    const scrollTop = logScroll.scrollTop;
    let start = Math.floor(scrollTop / ROW_H) - VIRTUAL_BUFFER;
    if (start < 0) start = 0;
    let end = Math.ceil((scrollTop + viewH) / ROW_H) + VIRTUAL_BUFFER;
    if (end > total) end = total;
    const topPad = start * ROW_H;
    const bottomPad = Math.max(0, totalH - end * ROW_H);

    logEl.style.paddingTop = `${topPad}px`;
    logEl.style.paddingBottom = `${bottomPad}px`;
    logEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let fi = start; fi < end; fi++) {
        const ei = filteredIdx[fi];
        const entry = entries[ei];
        if (!entry) continue;
        frag.appendChild(rowElement(entry, ei));
    }
    logEl.appendChild(frag);
    if (countEl) countEl.textContent = `${visibleCount()} visible`;
}

function visibleCount() {
    return filteredIdx.length;
}

function rowElement(entry, ei) {
    const div = document.createElement('div');
    div.className = 'cv-line';
    div.style.height = `${ROW_H}px`;
    div.dataset.seq = String(entry.seq);
    div.dataset.ei = String(ei);
    if (wordWrap) div.classList.add('cv-line-wrap');

    const pin = document.createElement('span');
    pin.className = 'cv-pin' + (bookmarks.has(entry.seq) ? ' on' : '');
    pin.textContent = bookmarks.has(entry.seq) ? '★' : '☆';
    pin.title = 'Bookmark';
    pin.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (bookmarks.has(entry.seq)) bookmarks.delete(entry.seq);
        else bookmarks.add(entry.seq);
        saveBookmarks();
        renderVirtual();
        updateBadges();
    });

    const ts = document.createElement('span');
    ts.className = 'cv-ts';
    ts.textContent = formatTime(entry.ts);

    const lvl = document.createElement('span');
    lvl.className = 'cv-lvl-pill ' + levelPillClass(entry.level);
    lvl.textContent = String(entry.level).slice(0, 5);

    const src = document.createElement('span');
    src.className = 'cv-src-pill';
    src.textContent = entry.source || '—';
    src.title = entry.module || entry.source || '';

    const msg = document.createElement('span');
    msg.className = 'cv-msg ' + getLineClass(entry.text);
    msg.innerHTML = highlightSearch(escapeHtml(entry.text), searchTerm);

    div.appendChild(pin);
    div.appendChild(ts);
    div.appendChild(lvl);
    div.appendChild(src);
    div.appendChild(msg);
    if (entry.repeatCount > 1) {
        const rep = document.createElement('span');
        rep.className = 'cv-repeat';
        rep.textContent = `×${entry.repeatCount}`;
        div.appendChild(rep);
    }

    div.addEventListener('click', () => openDetail(entry));
    div.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ctxTargetSeq = entry.seq;
        openCtx(ev.clientX, ev.clientY);
    });
    return div;
}

function renderWrapMode() {
    if (!logEl) return;
    const max = Math.min(filteredIdx.length, WRAP_MAX_ROWS);
    logEl.style.paddingTop = '0';
    logEl.style.paddingBottom = '0';
    logEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let fi = 0; fi < max; fi++) {
        const ei = filteredIdx[fi];
        const entry = entries[ei];
        if (!entry) continue;
        const row = rowElement(entry, ei);
        row.style.height = 'auto';
        row.style.minHeight = `${ROW_H}px`;
        frag.appendChild(row);
    }
    logEl.appendChild(frag);
    if (filteredIdx.length > WRAP_MAX_ROWS && countEl) {
        countEl.textContent = `${visibleCount()} visible (showing first ${WRAP_MAX_ROWS} in wrap mode)`;
    } else if (countEl) countEl.textContent = `${visibleCount()} visible`;
}

function openDetail(entry) {
    selectedIdx = entry.seq;
    if (!cvDetail || !cvDetailBody) return;
    cvDetail.hidden = false;
    const t = escapeHtml(entry.text);
    cvDetailBody.textContent = entry.text;
    let html = `<div><strong>${formatTime(entry.ts)}</strong> [${entry.level}] [${entry.source}]</div><pre style="margin:8px 0 0;white-space:pre-wrap;">${t}</pre>`;
    const trimmed = entry.text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            const j = JSON.parse(trimmed);
            html += `<pre class="cv-json-tree">${escapeHtml(JSON.stringify(j, null, 2))}</pre>`;
        } catch { /* ignore */ }
    }
    cvDetailBody.innerHTML = html;
    cvCorrHead.style.display = 'none';
    cvCorrList.style.display = 'none';
    cvCorrList.innerHTML = '';
}

cvDetailClose?.addEventListener('click', () => {
    cvDetail.hidden = true;
});

let scrollRaf = null;
function onScroll() {
    if (wordWrap) return;
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        renderVirtual();
    });
}

logScroll?.addEventListener('scroll', () => {
    const atBottom = logScroll.scrollTop + logScroll.clientHeight >= logScroll.scrollHeight - 40;
    if (!atBottom && autoScroll) {
        autoScroll = false;
        autoscrollBtn?.classList.remove('active');
    }
    onScroll();
});

window.addEventListener('resize', () => onScroll());

for (const tab of tabs) {
    tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        for (const t of tabs) t.classList.remove('active');
        tab.classList.add('active');
        tab.classList.remove('has-new');
        updateMitmToolbarVisibility();
        rebuildFilteredIndices();
    });
}

function updateMitmToolbarVisibility() {
    if (!mitmToolbar) return;
    if (activeTab === 'mitm') mitmToolbar.removeAttribute('hidden');
    else mitmToolbar.setAttribute('hidden', '');
}

updateMitmToolbarVisibility();

let searchTimer = null;
searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        searchTerm = searchInput.value.trim();
        rebuildFilteredIndices();
    }, 150);
});

regexCb?.addEventListener('change', () => {
    useRegex = !!regexCb.checked;
    rebuildFilteredIndices();
});

excludeInput?.addEventListener('input', () => {
    const v = excludeInput.value.trim();
    excludeTerms = v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
    rebuildFilteredIndices();
});

document.querySelectorAll('.cv-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
        const lv = chip.dataset.level;
        if (!lv) return;
        levelOn[lv] = !levelOn[lv];
        chip.classList.toggle('on', levelOn[lv]);
        rebuildFilteredIndices();
    });
});

document.querySelectorAll('.cv-src-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
        const src = cb.dataset.src;
        if (src) sourceOn[src] = cb.checked;
        rebuildFilteredIndices();
    });
});

[timeFromEl, timeToEl].forEach((el) => el?.addEventListener('change', () => rebuildFilteredIndices()));

autoscrollBtn?.addEventListener('click', () => {
    autoScroll = !autoScroll;
    autoscrollBtn.classList.toggle('active', autoScroll);
    if (autoScroll) scrollToBottom();
});

pauseBtn?.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.classList.toggle('active', paused);
    pauseBtn.title = paused ? 'Resume capture' : 'Pause capture';
    pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    const lbl = pauseBtn.querySelector('.cv-icon-btn__lbl');
    if (lbl) lbl.textContent = paused ? 'Resume' : 'Pause';
    const svg = pauseBtn.querySelector('.cv-icon-btn__icon svg');
    if (svg) {
        svg.innerHTML = paused
            ? '<path d="M5 3l8 5-8 5V3z" fill="currentColor"/>'
            : '<rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/>';
    }
});

wrapBtn?.addEventListener('click', () => {
    wordWrap = !wordWrap;
    wrapBtn.classList.toggle('active', wordWrap);
    rebuildFilteredIndices();
});

groupBtn?.addEventListener('click', () => {
    groupRepeats = !groupRepeats;
    groupBtn.classList.toggle('active', groupRepeats);
});

function copyFiltered() {
    const lines = [];
    for (const fi of filteredIdx) {
        const e = entries[fi];
        if (!e) continue;
        lines.push(`[${e.ts.toISOString()}] [${e.level}] [${e.source}] ${e.text}`);
    }
    return lines.join('\n');
}

copyBtn?.addEventListener('click', () => {
    navigator.clipboard.writeText(copyFiltered()).then(() => {
        const lbl = copyBtn.querySelector('.cv-icon-btn__lbl');
        const prev = lbl?.textContent;
        if (lbl) lbl.textContent = 'Copied';
        const t = copyBtn.title;
        copyBtn.title = 'Copied to clipboard';
        setTimeout(() => {
            copyBtn.title = t || 'Copy filtered lines';
            if (lbl && prev) lbl.textContent = prev;
        }, 1500);
    });
});

clearBtn?.addEventListener('click', () => {
    entries = [];
    filteredIdx = [];
    countAll = countMitm = countSystem = 0;
    entrySeq = 0;
    logEl.innerHTML = '';
    updateBadges();
    rebuildFilteredIndices();
});

saveBtn?.addEventListener('click', async () => {
    try {
        const ok = await api.saveConsoleLog?.(copyFiltered());
        if (ok) {
            const lbl = saveBtn.querySelector('.cv-icon-btn__lbl');
            const prev = lbl?.textContent;
            if (lbl) lbl.textContent = 'Saved';
            const t = saveBtn.title;
            saveBtn.title = 'File saved';
            setTimeout(() => {
                saveBtn.title = t || 'Save as .log';
                if (lbl && prev) lbl.textContent = prev;
            }, 2000);
        }
    } catch { /* ignore */ }
});

saveJsonBtn?.addEventListener('click', async () => {
    const payload = filteredIdx.map((ei) => {
        const e = entries[ei];
        return {
            ts: e.ts.toISOString(),
            tsMs: e.tsMs,
            level: e.level,
            source: e.source,
            module: e.module,
            stream: e.stream,
            text: e.text,
            repeatCount: e.repeatCount,
        };
    });
    try {
        const ok = await api.saveConsoleLogJson?.(payload);
        if (ok) {
            const lbl = saveJsonBtn.querySelector('.cv-icon-btn__lbl');
            const prev = lbl?.textContent;
            if (lbl) lbl.textContent = 'Saved';
            const t = saveJsonBtn.title;
            saveJsonBtn.title = 'File saved';
            setTimeout(() => {
                saveJsonBtn.title = t || 'Save as JSON';
                if (lbl && prev) lbl.textContent = prev;
            }, 2000);
        }
    } catch { /* ignore */ }
});

saveCsvBtn?.addEventListener('click', async () => {
    const header = 'ts_iso,level,source,module,text\n';
    const lines = [header];
    for (const fi of filteredIdx) {
        const e = entries[fi];
        if (!e) continue;
        const row = [
            e.ts.toISOString(),
            e.level,
            e.source,
            e.module || '',
            e.text.replace(/"/g, '""'),
        ].map((c) => `"${String(c)}"`).join(',');
        lines.push(row);
    }
    try {
        const ok = await api.saveConsoleLogCsv?.(lines.join('\n'));
        if (ok) {
            const lbl = saveCsvBtn.querySelector('.cv-icon-btn__lbl');
            const prev = lbl?.textContent;
            if (lbl) lbl.textContent = 'Saved';
            const t = saveCsvBtn.title;
            saveCsvBtn.title = 'File saved';
            setTimeout(() => {
                saveCsvBtn.title = t || 'Save as CSV';
                if (lbl && prev) lbl.textContent = prev;
            }, 2000);
        }
    } catch { /* ignore */ }
});

function openCtx(x, y) {
    if (!ctxMenu) return;
    ctxMenu.style.left = `${Math.min(x, window.innerWidth - 210)}px`;
    ctxMenu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
    ctxMenu.classList.add('open');
}

function closeCtx() {
    ctxMenu?.classList.remove('open');
}

document.addEventListener('click', closeCtx);
ctxMenu?.addEventListener('click', (ev) => {
    const item = ev.target.closest('.cv-ctx-item');
    if (!item) return;
    const act = item.dataset.act;
    const seq = ctxTargetSeq;
    if (seq == null) return;
    const entry = entries.find((e) => e.seq === seq);
    if (!entry) return;
    if (act === 'copy-line') {
        navigator.clipboard.writeText(`[${entry.ts.toISOString()}] ${entry.text}`);
    } else if (act === 'copy-ts') {
        navigator.clipboard.writeText(entry.ts.toISOString());
    } else if (act === 'bookmark') {
        if (bookmarks.has(seq)) bookmarks.delete(seq);
        else bookmarks.add(seq);
        saveBookmarks();
        renderVirtual();
        updateBadges();
    } else if (act === 'filter-src') {
        const s = entry.source;
        for (const k of Object.keys(sourceOn)) sourceOn[k] = k === s;
        document.querySelectorAll('.cv-src-cb').forEach((cb) => {
            cb.checked = cb.dataset.src === s;
        });
        rebuildFilteredIndices();
    } else if (act === 'exclude-line') {
        const ex = (excludeInput?.value || '') + (excludeInput?.value ? ',' : '') + entry.text.slice(0, 80);
        if (excludeInput) excludeInput.value = ex;
        excludeTerms = ex.split(',').map((x) => x.trim()).filter(Boolean);
        rebuildFilteredIndices();
    } else if (act === 'correlate') {
        void correlateEntry(entry);
    }
    closeCtx();
});

async function correlateEntry(entry) {
    try {
        const rows = await api.findRequestsNearTs?.({
            tsMs: entry.tsMs,
            windowMs: 2500,
        });
        openDetail(entry);
        if (!rows?.length) {
            cvCorrHead.style.display = 'block';
            cvCorrHead.textContent = 'Network (no requests in window)';
            cvCorrList.style.display = 'block';
            cvCorrList.innerHTML = '';
            return;
        }
        cvCorrHead.style.display = 'block';
        cvCorrHead.textContent = 'Network (time window)';
        cvCorrList.style.display = 'block';
        cvCorrList.innerHTML = rows.map((r) => {
            const id = r.id;
            const u = escapeHtml(String(r.url || ''));
            return `<li>#${id} <span>${r.status ?? '—'}</span> <a href="#" data-req="${id}">${u.slice(0, 120)}</a></li>`;
        }).join('');
        cvCorrList.querySelectorAll('a[data-req]').forEach((a) => {
            a.addEventListener('click', (ev) => {
                ev.preventDefault();
                const id = a.dataset.req;
                // Open log viewer focus — optional; user can search by id in Network Activity
                navigator.clipboard.writeText(`request id ${id}`);
            });
        });
    } catch { /* ignore */ }
}

document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeCtx();
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key === 'f') {
        ev.preventDefault();
        searchInput?.focus();
    }
    if (mod && ev.key === 'k') {
        ev.preventDefault();
        clearBtn?.click();
    }
    if (mod && ev.key === 's') {
        ev.preventDefault();
        saveBtn?.click();
    }
});

async function syncDebugMitmSelect() {
    if (!debugMitmSelect || !api.getDebugMitmLevel) return;
    try {
        const lvl = await api.getDebugMitmLevel();
        const n = typeof lvl === 'number' && Number.isFinite(lvl) ? lvl : parseInt(String(lvl), 10);
        const v = Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 1;
        debugMitmSelect.value = String(v);
    } catch { /* ignore */ }
}
if (debugMitmSelect && api.setDebugMitmLevel) {
    debugMitmSelect.addEventListener('change', async () => {
        const raw = parseInt(debugMitmSelect.value, 10);
        const v = Number.isFinite(raw) ? raw : 1;
        try {
            await api.setDebugMitmLevel(v);
        } catch { /* ignore */ }
    });
}

async function populateDbSessions() {
    if (!dbSessionSelect || !api.getConsoleLogSessions) return;
    try {
        const list = await api.getConsoleLogSessions();
        while (dbSessionSelect.options.length > 1) dbSessionSelect.remove(1);
        for (const row of list || []) {
            const opt = document.createElement('option');
            opt.value = String(row.id);
            const label = row.notes ? `${row.notes} (#${row.id})` : `Session #${row.id}`;
            opt.textContent = `${label} — ${row.console_count || 0} lines`;
            dbSessionSelect.appendChild(opt);
        }
    } catch { /* ignore */ }
}

dbSessionSelect?.addEventListener('change', async () => {
    const v = dbSessionSelect.value;
    if (!v) {
        liveMode = true;
        return;
    }
    liveMode = false;
    try {
        const rows = await api.getConsoleLogsFromDb?.({
            sessionId: Number(v),
            limit: 5000,
            offset: 0,
            order: 'asc',
        });
        entries = [];
        countAll = countMitm = countSystem = 0;
        let maxSeq = 0;
        for (const r of rows || []) {
            const raw = {
                text: r.text,
                ts: r.ts,
                level: r.level,
                source: r.source,
                module: r.module,
                stream: r.stream,
                seq: r.id != null ? Number(r.id) : undefined,
            };
            const e = normalizeEntry(raw);
            if (e.seq > maxSeq) maxSeq = e.seq;
            entries.push(e);
            countAll++;
            if (e.category === 'mitm') countMitm++;
            else countSystem++;
        }
        entrySeq = Math.max(entrySeq, maxSeq);
        updateBadges();
        rebuildFilteredIndices();
    } catch { /* ignore */ }
});

api.onConsoleLog?.((data) => {
    if (!liveMode || paused) return;
    if (!data) return;
    const lines = Array.isArray(data) ? data : [data];
    for (const item of lines) {
        const raw = typeof item === 'string' ? { text: item, ts: Date.now() } : { ...item };
        if (!raw.text) continue;
        const entry = normalizeEntry(raw);
        addEntry(entry);
    }
    if (countEl) countEl.textContent = `${visibleCount()} visible`;
});

(async () => {
    loadBookmarks();
    await syncDebugMitmSelect();
    await populateDbSessions();
    try {
        const history = await api.getConsoleHistory?.();
        if (history?.length) {
            let maxSeq = 0;
            for (const item of history) {
                const raw = typeof item === 'string' ? { text: item, ts: Date.now() } : { ...item };
                if (!raw.text) continue;
                const entry = normalizeEntry(raw);
                if (entry.seq > maxSeq) maxSeq = entry.seq;
                entries.push(entry);
                countAll++;
                if (entry.category === 'mitm') countMitm++;
                else countSystem++;
            }
            entrySeq = Math.max(entrySeq, maxSeq);
            updateBadges();
            rebuildFilteredIndices();
        }
    } catch { /* ignore */ }
    if (countEl) countEl.textContent = `${visibleCount()} visible`;
})();
