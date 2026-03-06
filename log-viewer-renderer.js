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
const clearSearchBtn = document.getElementById('clear-search');
const filterSession  = document.getElementById('filter-session');
// Multi-select state (empty Set = "all")
const selectedTypes    = new Set();
const selectedStatuses = new Set();
const selectedTabs     = new Set();
const lvCount        = document.getElementById('lv-count');
const autoScrollBtn  = document.getElementById('auto-scroll-btn');
const exportHarBtn   = document.getElementById('export-har-btn');
const openRulesBtn   = document.getElementById('open-rules-btn');
const clearLogsBtn   = document.getElementById('clear-logs');
const replayBar      = document.getElementById('lv-replay-bar');
const replayBtn      = document.getElementById('lv-replay-btn');
const copyUrlBtn     = document.getElementById('lv-copy-url');
const replayDiff     = document.getElementById('lv-replay-diff');
const replayResult   = document.getElementById('lv-replay-result');
const replayBody     = document.getElementById('replay-body');
const replayStatus   = document.getElementById('replay-status-badge');
const tabBtns        = document.querySelectorAll('.lv-tab-btn');
const tabContents    = document.querySelectorAll('.lv-tab-content');

// ─── Utilities ────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

/** Parse <base64|mime|image/png|DATA> → { mime, data } or null */
function parseBase64Body(b) {
    if (!b || !b.startsWith('<base64|')) return null;
    const inner = b.slice(8, b.endsWith('>') ? b.length - 1 : b.length);
    const sep   = inner.indexOf('|');
    if (sep === -1) return null;
    const qualifier = inner.slice(0, sep); // 'mime'
    const rest      = inner.slice(sep + 1);
    if (qualifier === 'mime') {
        const sep2 = rest.indexOf('|');
        if (sep2 === -1) return null;
        return { mime: rest.slice(0, sep2), data: rest.slice(sep2 + 1) };
    }
    return null;
}
function parseHeaders(h) {
    if (!h) return null;
    if (typeof h === 'string') { try { return JSON.parse(h); } catch { return null; } }
    return h;
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

function buildRow(entry, idx) {
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
    const dur     = entry.duration_ms ?? entry.duration;

    const hl = highlightRules[url];
    if (hl) { row.style.borderLeft = `3px solid ${hl}`; row.classList.add('hl-rule'); }

    if (type === 'screenshot') {
        row.classList.add('lv-row-screenshot');
        // Thumbnail is never stored in memory — only shown in detail panel on click
        const ts = entry.created_at
            ? new Date(entry.created_at).toLocaleTimeString()
            : '';
        row.innerHTML =
            `<div class="lv-td col-idx">${idx + 1}</div>` +
            `<div class="lv-td col-method"><span class="method-badge m-other">📷</span></div>` +
            `<div class="lv-td col-status"><span class="lv-status s-ok">—</span></div>` +
            `<div class="lv-td col-type"><span class="type-chip type-screenshot">screenshot</span></div>` +
            `<div class="lv-td col-dur"><span class="lv-dur">${ts}</span></div>` +
            `<div class="lv-td col-path"><span class="lv-path">${esc(url)}</span></div>`;
        row.addEventListener('click', () => selectEntry(idx));
        return row;
    }

    row.innerHTML =
        `<div class="lv-td col-idx">${idx + 1}</div>` +
        `<div class="lv-td col-method"><span class="method-badge ${methodCls(method)}">${esc(method) || '—'}</span></div>` +
        `<div class="lv-td col-status"><span class="lv-status ${entry.error ? 's-err' : statusCls(status)}">${status || (entry.error ? 'ERR' : '—')}</span></div>` +
        `<div class="lv-td col-type"><span class="type-chip" title="${esc(type)}">${esc(type) || '—'}</span></div>` +
        `<div class="lv-td col-dur"><span class="lv-dur ${durCls(dur)}">${formatDur(dur)}</span></div>` +
        `<div class="lv-td col-path"><span class="lv-path" title="${esc(url)}">${esc(truncUrl(url))}</span></div>`;

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
            renderVirtual();
            scrollToBottom();
        } else {
            const last = filteredEntries.length - 1;
            if (last >= renderStart && last < renderEnd) renderVirtual();
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
async function selectEntry(idx) {
    if (idx < 0 || idx >= filteredEntries.length) return;
    selectedIndex = idx;
    renderVirtual();
    ensureVisible(idx);
    const entry = filteredEntries[idx];
    showDetail(entry);
    // Screenshots don't have request/response headers — skip DB fetch
    if (entry.type !== 'screenshot' && entry.id && !entry.response_headers && !entry.request_headers) {
        try {
            const full = await api.getRequestDetail(entry.id);
            if (full) { Object.assign(entry, full); showDetail(entry); }
        } catch {}
    }
}

function showDetail(entry) {
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
    document.getElementById('d-tab').textContent      = (entry.tabId || entry.tab_id || '—');

    // Replay bar
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

    // Headers
    renderHeaders(document.getElementById('request-headers'),  parseHeaders(entry.request_headers  || entry.request?.headers));
    renderHeaders(document.getElementById('response-headers'), parseHeaders(entry.response_headers || entry.response?.headers));

    // Request body
    const reqBody = entry.request_body || entry.request?.body;
    const reqCt   = (entry.request_headers?.['content-type'] || entry.request_headers?.['Content-Type'] || '').toLowerCase();
    const reqWrap = document.getElementById('request-body-wrap');
    const reqSizeEl = document.getElementById('req-body-size');
    if (reqSizeEl) reqSizeEl.textContent = reqBody ? `${(reqBody.length / 1024).toFixed(1)} KB` : 'No body';

    const isFormEncoded = reqCt.includes('application/x-www-form-urlencoded') ||
        (reqBody && !reqCt && /^[\w%+.-]+=/.test(reqBody.slice(0, 60)));
    const formPairs = (isFormEncoded && reqBody) ? parseFormBody(reqBody) : null;

    if (formPairs && formPairs.length) {
        renderFormBody(reqWrap, formPairs, reqBody);
    } else {
        const reqFmt = formatBody(reqBody);
        if (reqFmt) {
            reqWrap.innerHTML = `<div class="body-content">${esc(reqFmt)}</div>`;
        } else {
            reqWrap.innerHTML = '<span style="padding:14px;color:var(--text-dim);font-style:italic;display:block">(empty)</span>';
        }
    }

    // Wire up request body toolbar buttons
    wireReqBodyBtns(reqBody, formPairs);

    // Response body
    const respBody   = entry.response_body || entry.responseBody;
    const respParsed = respBody ? parseBase64Body(respBody) : null;    // binary/image?
    const respFmt    = formatBody(respBody);
    const respWrap   = document.getElementById('response-body-wrap');
    const respSizeEl = document.getElementById('resp-body-size');
    if (respSizeEl) respSizeEl.textContent = respBody ? `${(respBody.length / 1024).toFixed(1)} KB` : 'No body';

    // Determine content type for Save
    const respCt  = (entry.response_headers?.['content-type'] || entry.response_headers?.['Content-Type'] || '').toLowerCase();
    const isImage = respParsed && respParsed.mime.startsWith('image/');
    const isJson  = !isImage && (respCt.includes('json') || (respFmt && respFmt.trimStart().startsWith('{') || respFmt?.trimStart().startsWith('[')));
    const isHtml  = !isImage && respCt.includes('html');
    let screenshotB64 = null;

    if (type === 'screenshot') {
        // Lazy-load: show spinner, then fetch base64 by ssDbId
        respWrap.innerHTML = '<div class="body-empty" id="ss-loading">⏳ Loading screenshot…</div>';

        const renderScreenshot = (b64) => {
            if (!b64) { respWrap.innerHTML = '<div class="body-empty">No screenshot data</div>'; return; }
            respWrap.innerHTML = `
                <div class="screenshot-wrap">
                    <div class="ss-action-bar">
                        <button class="body-act-btn" id="ss-copy-btn">⎘ Copy image</button>
                        <button class="body-act-btn" id="ss-save-btn">↓ Save PNG</button>
                    </div>
                    <img id="ss-preview-img" src="data:image/png;base64,${b64}">
                </div>`;
            document.getElementById('ss-copy-btn').addEventListener('click', async () => {
                try {
                    const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob());
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                    flashBtn(document.getElementById('ss-copy-btn'), '✓ Copied');
                } catch { flashBtn(document.getElementById('ss-copy-btn'), '✗ Failed'); }
            });
            document.getElementById('ss-save-btn').addEventListener('click', () => {
                const a = document.createElement('a');
                a.href = `data:image/png;base64,${b64}`;
                a.download = `screenshot-${Date.now()}.png`;
                a.click();
            });
        };

        if (entry.imageData) {
            // Already in memory (rare: came from an old code path)
            renderScreenshot(entry.imageData);
        } else if (entry.ssDbId) {
            // Fetch from main process on demand
            api.getScreenshotData(entry.ssDbId).then(renderScreenshot).catch(() => {
                respWrap.innerHTML = '<div class="body-empty">Failed to load screenshot</div>';
            });
        } else {
            respWrap.innerHTML = '<div class="body-empty">No screenshot data</div>';
        }
    } else if (isImage) {
        const { mime, data } = respParsed;
        const src = `data:${mime};base64,${data}`;
        respWrap.innerHTML = `
            <div class="screenshot-wrap">
                <div class="ss-action-bar">
                    <span style="font-size:10px;color:var(--text-dim);margin-right:4px">${mime}</span>
                    <button class="body-act-btn" id="img-copy-btn">⎘ Copy image</button>
                    <button class="body-act-btn" id="img-save-btn">↓ Save</button>
                </div>
                <img id="resp-img-preview" src="${src}" style="max-width:100%;border-radius:6px;border:1px solid var(--border);display:block">
            </div>`;

        document.getElementById('img-copy-btn').addEventListener('click', async () => {
            try {
                const blob = await fetch(src).then(r => r.blob());
                await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
                flashBtn(document.getElementById('img-copy-btn'), '✓ Copied');
            } catch { flashBtn(document.getElementById('img-copy-btn'), '✗ Failed'); }
        });
        document.getElementById('img-save-btn').addEventListener('click', () => {
            const ext = mime.split('/')[1] || 'bin';
            const a = document.createElement('a');
            a.href = src; a.download = `image-${Date.now()}.${ext}`; a.click();
        });
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
    const hasBody = type !== 'screenshot' && !isImage && !!respFmt;
    if (respCopyBtn) {
        respCopyBtn.onclick = hasBody ? () => {
            navigator.clipboard.writeText(respFmt).then(
                () => flashBtn(respCopyBtn, '✓ Copied'),
                () => flashBtn(respCopyBtn, '✗ Failed')
            );
        } : null;
        respCopyBtn.style.display = hasBody ? '' : 'none';
    }
    if (respSaveBtn) {
        respSaveBtn.onclick = hasBody ? () => {
            const ext  = isJson ? 'json' : isHtml ? 'html' : 'txt';
            const mime = isJson ? 'application/json' : isHtml ? 'text/html' : 'text/plain';
            const blob = new Blob([respFmt], { type: mime });
            const url  = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `response-${Date.now()}.${ext}`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } : null;
        respSaveBtn.style.display = hasBody ? '' : 'none';
    }

    activateTab(lastActiveTab);
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
    const hasSave = !!rawBody;

    // Show/hide buttons depending on content type
    if (btnText) btnText.style.display = hasForm ? '' : 'none';
    if (btnArr)  btnArr.style.display  = hasForm ? '' : 'none';
    if (btnObj)  btnObj.style.display  = hasForm ? '' : 'none';
    if (btnSave) btnSave.style.display = hasSave ? '' : 'none';

    if (btnText && hasForm) {
        btnText.onclick = () => {
            const text = formPairs.map(p => `${p.key} = ${p.value}`).join('\n');
            navigator.clipboard.writeText(text).then(
                () => flashBtn(btnText, '✓ Copied'),
                () => flashBtn(btnText, '✗ Failed')
            );
        };
    }
    if (btnArr && hasForm) {
        btnArr.onclick = () => {
            const lines = formPairs.map(p =>
                `  [${JSON.stringify(p.key)}, ${JSON.stringify(p.value)}]`
            ).join(',\n');
            navigator.clipboard.writeText(`[\n${lines}\n]`).then(
                () => flashBtn(btnArr, '✓ Copied'),
                () => flashBtn(btnArr, '✗ Failed')
            );
        };
    }
    if (btnObj && hasForm) {
        btnObj.onclick = () => {
            const lines = formPairs.map(p =>
                `  ${JSON.stringify(p.key)}: ${JSON.stringify(p.value)}`
            ).join(',\n');
            navigator.clipboard.writeText(`{\n${lines}\n}`).then(
                () => flashBtn(btnObj, '✓ Copied'),
                () => flashBtn(btnObj, '✗ Failed')
            );
        };
    }
    if (btnSave && hasSave) {
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
        const row = document.createElement('div');
        row.className = 'hdr-row';
        row.innerHTML = `<span class="hdr-name">${esc(k)}</span><span class="hdr-val">${esc(Array.isArray(v) ? v.join(', ') : v)}</span>`;
        container.appendChild(row);
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

// ─── Toolbar actions ──────────────────────────────────────────────────────────
const debouncedFilter = debounce(applyFilters, 280);
searchInput?.addEventListener('input', debouncedFilter);
ftsCheckbox?.addEventListener('change', applyFilters);
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

openRulesBtn?.addEventListener('click', () => api.openRulesWindow());

// ─── Live events ──────────────────────────────────────────────────────────────
api.onNewLogEntry((entry) => addEntry(entry));

api.onRuleHighlight?.((({ url, color }) => {
    highlightRules[url] = color;
    renderVirtual();
}));

// ─── Resize observer ──────────────────────────────────────────────────────────
new ResizeObserver(() => renderVirtual()).observe(lvScroll);

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
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
        renderVirtual();
    }
}
init();

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
