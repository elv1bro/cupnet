'use strict';

const api = window.electronAPI;

let allEntries = [];
let selectedId = null;

const tvRows = document.getElementById('tv-rows');
const tvCount = document.getElementById('tv-count');
const tvDetailEmpty = document.getElementById('tv-detail-empty');
const tvDetail = document.getElementById('tv-detail');
const tvDetailUrl = document.getElementById('tv-detail-url');
const tvReqHeaders = document.getElementById('tv-req-headers');
const tvResHeaders = document.getElementById('tv-res-headers');
const tvReqBody = document.getElementById('tv-req-body');
const tvResBody = document.getElementById('tv-res-body');
const tvClearBtn = document.getElementById('tv-clear-btn');

function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function truncUrl(url) {
    try {
        const u = new URL(url);
        let p = u.pathname;
        if (u.search) p += u.search.slice(0, 40) + (u.search.length > 40 ? '…' : '');
        return p || '/';
    } catch { return url.length > 80 ? url.slice(0, 80) + '…' : url; }
}
function methodCls(m) {
    const map = { GET:'m-get', POST:'m-post', PUT:'m-put', PATCH:'m-put', DELETE:'m-delete' };
    return map[(m||'').toUpperCase()] || 'm-other';
}
function statusCls(s) {
    if (!s) return 's-nil';
    if (s < 300) return 's-2xx';
    if (s < 400) return 's-3xx';
    if (s < 500) return 's-4xx';
    return 's-5xx';
}
function formatBody(b) {
    if (!b) return null;
    if (typeof b !== 'string') return JSON.stringify(b, null, 2);
    if (b.startsWith('__b64__:') || b.startsWith('<base64|')) return '[Binary data]';
    try { return JSON.stringify(JSON.parse(b), null, 2); } catch { return b; }
}

function renderList() {
    tvRows.innerHTML = '';
    allEntries.forEach((e, i) => {
        const row = document.createElement('div');
        row.className = 'tv-row' + (e.id === selectedId ? ' selected' : '');
        row.dataset.id = e.id;
        const dur = e.duration_ms ?? e.duration;
        row.innerHTML = `
            <div class="tv-td col-idx">${allEntries.length - i}</div>
            <div class="tv-td col-method"><span class="method-badge ${methodCls(e.method)}">${esc(e.method || 'GET')}</span></div>
            <div class="tv-td col-status"><span class="${statusCls(e.status)}">${e.status ?? '—'}</span></div>
            <div class="tv-td col-dur">${dur != null ? dur + 'ms' : '—'}</div>
            <div class="tv-td col-path">${esc(truncUrl(e.url))}</div>
        `;
        row.addEventListener('click', () => selectEntry(e.id));
        tvRows.appendChild(row);
    });
    tvCount.textContent = `${allEntries.length} entries`;
}

function selectEntry(id) {
    selectedId = id;
    renderList();
    loadDetail(id);
}

async function loadDetail(id) {
    if (!id || !api.getTraceEntry) {
        tvDetailEmpty.style.display = 'flex';
        tvDetail.classList.remove('visible');
        return;
    }
    try {
        const e = await api.getTraceEntry(id);
        if (!e) {
            tvDetailEmpty.style.display = 'flex';
            tvDetail.classList.remove('visible');
            return;
        }
        tvDetailEmpty.style.display = 'none';
        tvDetail.classList.add('visible');
        tvDetailUrl.textContent = e.url || '';

        const reqH = e.request_headers ? (typeof e.request_headers === 'string' ? JSON.parse(e.request_headers || '{}') : e.request_headers) : {};
        const resH = e.response_headers ? (typeof e.response_headers === 'string' ? JSON.parse(e.response_headers || '{}') : e.response_headers) : {};

        tvReqHeaders.innerHTML = Object.entries(reqH).map(([k,v]) =>
            `<div class="hdr-row"><span class="hdr-name">${esc(k)}</span><span class="hdr-val">${esc(v)}</span></div>`
        ).join('') || '<div class="body-empty">No headers</div>';

        tvResHeaders.innerHTML = Object.entries(resH).map(([k,v]) =>
            `<div class="hdr-row"><span class="hdr-name">${esc(k)}</span><span class="hdr-val">${esc(v)}</span></div>`
        ).join('') || '<div class="body-empty">No headers</div>';

        const reqBody = formatBody(e.request_body);
        tvReqBody.textContent = reqBody || '';
        tvReqBody.className = 'body-content' + (reqBody ? '' : ' body-empty');
        if (!reqBody) tvReqBody.textContent = 'No request body';

        const resBody = formatBody(e.response_body);
        tvResBody.textContent = resBody || '';
        tvResBody.className = 'body-content' + (resBody ? '' : ' body-empty');
        if (!resBody) tvResBody.textContent = 'No response body';
    } catch (err) {
        console.error('load trace detail:', err);
        tvDetailEmpty.style.display = 'flex';
        tvDetail.classList.remove('visible');
    }
}

document.querySelectorAll('.tv-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tv-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tv-tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.getElementById('tab-' + tab)?.classList.add('active');
    });
});

tvClearBtn?.addEventListener('click', async () => {
    if (!api.clearTraceEntries) return;
    if (!confirm('Clear all trace entries?')) return;
    await api.clearTraceEntries();
    allEntries = [];
    selectedId = null;
    renderList();
    tvDetailEmpty.style.display = 'flex';
    tvDetail.classList.remove('visible');
});

async function loadEntries() {
    if (!api.getTraceEntries) return;
    try {
        const list = await api.getTraceEntries(300, 0);
        allEntries = list || [];
        renderList();
        if (selectedId) loadDetail(selectedId);
    } catch (e) { console.error('load trace entries:', e); }
}

api.onNewTraceEntry?.((summary) => {
    allEntries.unshift(summary);
    renderList();
});

// Resizable list/detail split
(function () {
    const resizer = document.getElementById('tv-resizer');
    const listPane = document.getElementById('tv-list-pane');
    const container = document.getElementById('tv-body');
    if (!resizer || !listPane || !container) return;
    let dragging = false, startX = 0, startW = 0;
    resizer.addEventListener('mousedown', (e) => {
        dragging = true; startX = e.clientX; startW = listPane.offsetWidth;
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
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    });
})();

loadEntries();
