'use strict';

/** History tool window (history.html): browse, search, open, delete and clear browsing history. */
const api = window.electronAPI;

const tbody = document.getElementById('history-tbody');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const statsEl = document.getElementById('stats');
const searchEl = document.getElementById('search');
const rangeEl = document.getElementById('range');
const retentionEl = document.getElementById('retention');
const recordIsolatedEl = document.getElementById('record-isolated');
const inlineCompleteEl = document.getElementById('inline-complete');
const clearMenu = document.getElementById('clear-menu');
const clearBtn = document.getElementById('clear-btn');
const closedBar = document.getElementById('closed-bar');
const closedList = document.getElementById('closed-list');
const loadMoreBtn = document.getElementById('load-more');
const statusMsg = document.getElementById('status-msg');

const PAGE = 300;
let offset = 0;
let total = 0;
let rows = [];
let reloadTimer = null;
let statusTimer = null;

function setStatus(msg, cls = '', ms = 3000) {
    statusMsg.textContent = msg;
    statusMsg.className = `msg ${cls}`;
    clearTimeout(statusTimer);
    if (ms > 0) statusTimer = setTimeout(() => { statusMsg.textContent = 'Ready'; statusMsg.className = 'msg'; }, ms);
}

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
}

function rangeFilter() {
    const v = rangeEl.value;
    const now = Date.now();
    const today = startOfDay(now);
    if (v === 'today') return { sinceMs: today };
    if (v === 'yesterday') return { sinceMs: today - 86400000, untilMs: today };
    if (v === '7d') return { sinceMs: now - 7 * 86400000 };
    if (v === '30d') return { sinceMs: now - 30 * 86400000 };
    return {};
}

function queryOpts(extra) {
    return { query: searchEl.value.trim(), ...rangeFilter(), ...(extra || {}) };
}

function dayLabel(ts) {
    const today = startOfDay(Date.now());
    const d = startOfDay(ts);
    if (d === today) return 'Today';
    if (d === today - 86400000) return 'Yesterday';
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function timeLabel(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function transitionLabel(t) {
    switch (t) {
        case 'typed': return 'Typed';
        case 'in_page': return 'In-page';
        case 'reload': return 'Reload';
        case 'redirect': return 'Redirect';
        default: return 'Link';
    }
}

function renderRows() {
    if (!rows.length) {
        tbody.innerHTML = '';
        emptyEl.hidden = false;
        loadMoreBtn.hidden = true;
        return;
    }
    emptyEl.hidden = true;
    let lastDay = null;
    const html = [];
    for (const r of rows) {
        const ts = Date.parse(r.visited_at);
        const day = Number.isFinite(ts) ? startOfDay(ts) : 0;
        if (day !== lastDay) {
            lastDay = day;
            html.push(`<tr class="day-row"><td colspan="5">${esc(Number.isFinite(ts) ? dayLabel(ts) : 'Unknown date')}</td></tr>`);
        }
        const isolated = r.cookie_group_id != null && Number(r.cookie_group_id) !== 1;
        const title = r.title || r.host || r.url;
        html.push(
            `<tr class="visit" data-id="${r.id}" data-url="${esc(r.url)}">`
            + `<td class="time">${esc(Number.isFinite(ts) ? timeLabel(ts) : '')}</td>`
            + `<td class="title" title="${esc(title)}">${esc(title)}${isolated ? '<span class="badge">isolated</span>' : ''}</td>`
            + `<td class="url" title="${esc(r.url)}">${esc(r.url)}</td>`
            + `<td class="meta">${esc(transitionLabel(r.transition))}${r.session_id ? ` · #${esc(r.session_id)}` : ''}</td>`
            + `<td class="actions">`
            + `<button type="button" class="act" data-act="newtab" title="Open in new tab">⧉</button>`
            + `<button type="button" class="act" data-act="copy" title="Copy URL">⎘</button>`
            + `<button type="button" class="act del" data-act="delete-visit" title="Remove this visit">×</button>`
            + `<button type="button" class="act del" data-act="delete-url" title="Remove all visits of this URL">⌫</button>`
            + `</td></tr>`
        );
    }
    tbody.innerHTML = html.join('');
    loadMoreBtn.hidden = rows.length >= total;
}

async function reload({ append = false } = {}) {
    try {
        if (!append) { offset = 0; rows = []; }
        const [list, count] = await Promise.all([
            api.historyList(queryOpts({ limit: PAGE, offset })),
            api.historyCount(queryOpts()),
        ]);
        total = Number(count) || 0;
        rows = append ? rows.concat(list || []) : (list || []);
        offset = rows.length;
        countEl.textContent = `${total} visit${total === 1 ? '' : 's'}`;
        renderRows();
    } catch (e) {
        setStatus(`Load failed: ${e?.message || e}`, 'err', 6000);
    }
    void refreshStats();
}

async function refreshStats() {
    try {
        const s = await api.historyStats();
        statsEl.textContent = `${s.urls} URLs · ${s.visits} visits · ${s.shortcuts} shortcuts`;
    } catch { /* ignore */ }
}

async function loadSettings() {
    try {
        const s = await api.historyGetSettings();
        const days = String(s.historyRetentionDays ?? 90);
        if (![...retentionEl.options].some((o) => o.value === days)) {
            const opt = document.createElement('option');
            opt.value = days; opt.textContent = `${days} days`;
            retentionEl.appendChild(opt);
        }
        retentionEl.value = days;
        recordIsolatedEl.checked = s.historyRecordIsolatedTabs !== false;
        inlineCompleteEl.checked = s.omniboxInlineComplete !== false;
    } catch { /* ignore */ }
}

async function saveSettings() {
    try {
        await api.historySetSettings({
            historyRetentionDays: Number(retentionEl.value),
            historyRecordIsolatedTabs: recordIsolatedEl.checked,
            omniboxInlineComplete: inlineCompleteEl.checked,
        });
        setStatus('Settings saved', 'ok');
    } catch (e) {
        setStatus(`Save failed: ${e?.message || e}`, 'err', 6000);
    }
}

async function renderRecentlyClosed() {
    try {
        const list = await api.historyRecentlyClosed();
        if (!Array.isArray(list) || !list.length) { closedBar.hidden = true; closedList.innerHTML = ''; return; }
        closedBar.hidden = false;
        closedList.innerHTML = list.map((e) => (
            `<button type="button" class="closed-chip" data-id="${e.id}" title="${esc(e.url)}">`
            + `<span class="t">${esc(e.title || e.url)}</span>${e.isolated ? '<span class="badge">isolated</span>' : ''}</button>`
        )).join('');
    } catch { closedBar.hidden = true; }
}

function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { void reload(); void renderRecentlyClosed(); }, 250);
}

// ── events ────────────────────────────────────────────────────────────────
searchEl.addEventListener('input', scheduleReload);
rangeEl.addEventListener('change', () => void reload());
retentionEl.addEventListener('change', () => void saveSettings());
recordIsolatedEl.addEventListener('change', () => void saveSettings());
inlineCompleteEl.addEventListener('change', () => void saveSettings());
loadMoreBtn.addEventListener('click', () => void reload({ append: true }));

clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearMenu.classList.toggle('open');
});
document.addEventListener('click', () => clearMenu.classList.remove('open'));
clearMenu.querySelector('.menu').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    e.stopPropagation();
    clearMenu.classList.remove('open');
    const range = b.dataset.range;
    const label = { hour: 'the last hour', day: 'the last 24 hours', week: 'the last 7 days', all: 'ALL browsing history and learned shortcuts' }[range] || range;
    if (!window.confirm(`Clear ${label}? This cannot be undone.`)) return;
    try {
        const r = await api.historyClear(range);
        setStatus(`Removed ${r?.visits ?? 0} visits, ${r?.urls ?? 0} URLs`, 'ok', 5000);
        void reload();
    } catch (err) {
        setStatus(`Clear failed: ${err?.message || err}`, 'err', 6000);
    }
});

closedList.addEventListener('click', async (e) => {
    const chip = e.target.closest('.closed-chip');
    if (!chip) return;
    try {
        const r = await api.historyReopen(Number(chip.dataset.id));
        if (r?.isolatedFallback) setStatus('Reopened in the shared cookie group (isolated group no longer exists)', 'ok', 6000);
        else if (r) setStatus('Tab reopened', 'ok');
        void renderRecentlyClosed();
    } catch (err) {
        setStatus(`Reopen failed: ${err?.message || err}`, 'err', 6000);
    }
});

tbody.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr.visit');
    if (!tr) return;
    const url = tr.dataset.url;
    const id = Number(tr.dataset.id);
    const act = e.target.closest('button.act')?.dataset.act;
    try {
        if (act === 'copy') {
            await navigator.clipboard.writeText(url);
            setStatus('URL copied', 'ok');
            return;
        }
        if (act === 'delete-visit') {
            await api.historyDeleteVisit(id);
            rows = rows.filter((r) => r.id !== id);
            total = Math.max(0, total - 1);
            countEl.textContent = `${total} visit${total === 1 ? '' : 's'}`;
            renderRows();
            setStatus('Visit removed', 'ok');
            return;
        }
        if (act === 'delete-url') {
            if (!window.confirm(`Remove every visit of\n${url}\nfrom history?`)) return;
            await api.historyDeleteUrl(url);
            void reload();
            setStatus('URL removed from history', 'ok');
            return;
        }
        const newTab = act === 'newtab' || e.metaKey || e.ctrlKey;
        await api.historyOpenUrl(url, newTab ? 'new-tab' : 'current');
    } catch (err) {
        setStatus(`Action failed: ${err?.message || err}`, 'err', 6000);
    }
});

document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchEl.focus(); searchEl.select(); }
    if (e.key === 'Escape' && clearMenu.classList.contains('open')) clearMenu.classList.remove('open');
});

api.onHistoryChanged?.(() => scheduleReload());
api.onHistoryWindowInit?.((init) => {
    if (init?.focusClear) clearMenu.classList.add('open');
});

void loadSettings();
void reload();
void renderRecentlyClosed();
searchEl.focus();
