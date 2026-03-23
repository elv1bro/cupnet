'use strict';

const api = window.electronAPI;

const MAX_LINES = 8000;
const TRIM_BATCH = 2000;

const logEl       = document.getElementById('cv-log');
const searchInput = document.getElementById('cv-search');
const countEl     = document.getElementById('cv-count');
const autoscrollBtn = document.getElementById('cv-autoscroll');
const pauseBtn    = document.getElementById('cv-pause');
const copyBtn     = document.getElementById('cv-copy');
const clearBtn    = document.getElementById('cv-clear');
const tabs        = document.querySelectorAll('.cv-tab');

let allLines   = [];
let activeTab  = 'all';
let autoScroll = true;
let paused     = false;
let searchTerm = '';

// Counters
let countAll = 0, countMitm = 0, countSystem = 0;

function classifyLine(text) {
    if (text.startsWith('[mitm]')) return 'mitm';
    return 'system';
}

function getLineClass(text) {
    if (text.startsWith('[mitm] TCP'))     return 'cv-mitm-tcp';
    if (text.startsWith('[mitm] CONNECT')) return 'cv-mitm-conn';
    if (text.startsWith('[mitm] →'))       return 'cv-mitm-req';
    if (text.startsWith('[mitm] ←'))       return 'cv-mitm-res';
    if (text.includes('[ffi-dbg]'))        return 'cv-ffi';
    if (text.includes('[worker-dbg]'))     return 'cv-worker';
    if (text.includes('[AUTO-RETRY]') || text.includes('Request error on attempt')) return 'cv-retry';
    if (text.startsWith('[main]'))         return 'cv-main';
    if (text.includes('ERROR') || text.includes('error:') || text.includes('Error')) return 'cv-err';
    if (text.includes('Warning') || text.includes('warn'))  return 'cv-warn';
    return '';
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightSearch(html, term) {
    if (!term) return html;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(new RegExp(`(${escaped})`, 'gi'), '<span class="cv-highlight">$1</span>');
}

function formatTime(d) {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
}

function addLine(text, category, ts) {
    const entry = { text, category, ts };
    allLines.push(entry);
    countAll++;
    if (category === 'mitm') countMitm++;
    else countSystem++;

    if (allLines.length > MAX_LINES) {
        const removed = allLines.splice(0, TRIM_BATCH);
        let rMitm = 0, rSys = 0;
        for (const r of removed) { if (r.category === 'mitm') rMitm++; else rSys++; }
        countAll -= removed.length;
        countMitm -= rMitm;
        countSystem -= rSys;
    }

    if (paused) return;
    if (matchesFilter(entry)) {
        appendDom(entry);
    }

    updateBadges();
    notifyInactiveTab(category);
}

function matchesFilter(entry) {
    if (activeTab !== 'all' && entry.category !== activeTab) return false;
    if (searchTerm && !entry.text.toLowerCase().includes(searchTerm)) return false;
    return true;
}

function appendDom(entry) {
    const div = document.createElement('div');
    div.className = 'cv-line ' + getLineClass(entry.text);
    let html = `<span class="cv-ts">${formatTime(entry.ts)}</span>`;
    html += highlightSearch(escapeHtml(entry.text), searchTerm);
    div.innerHTML = html;
    logEl.appendChild(div);

    if (autoScroll) {
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function rebuildDom() {
    logEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const entry of allLines) {
        if (!matchesFilter(entry)) continue;
        const div = document.createElement('div');
        div.className = 'cv-line ' + getLineClass(entry.text);
        let html = `<span class="cv-ts">${formatTime(entry.ts)}</span>`;
        html += highlightSearch(escapeHtml(entry.text), searchTerm);
        div.innerHTML = html;
        frag.appendChild(div);
    }
    logEl.appendChild(frag);
    updateCount();
    if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
}

function updateBadges() {
    document.getElementById('badge-all').textContent = countAll > 9999 ? `${Math.floor(countAll/1000)}k` : countAll;
    document.getElementById('badge-mitm').textContent = countMitm > 9999 ? `${Math.floor(countMitm/1000)}k` : countMitm;
    document.getElementById('badge-system').textContent = countSystem > 9999 ? `${Math.floor(countSystem/1000)}k` : countSystem;
}

function updateCount() {
    const visible = logEl.childElementCount;
    countEl.textContent = `${visible} visible`;
}

function notifyInactiveTab(category) {
    for (const tab of tabs) {
        const t = tab.dataset.tab;
        if (t === activeTab) continue;
        if (t === 'all' || t === category) {
            tab.classList.add('has-new');
        }
    }
}

// ── Tab switching ──
for (const tab of tabs) {
    tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        for (const t of tabs) t.classList.remove('active');
        tab.classList.add('active');
        tab.classList.remove('has-new');
        rebuildDom();
    });
}

// ── Search ──
let _searchTimer = null;
searchInput.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
        searchTerm = searchInput.value.trim().toLowerCase();
        rebuildDom();
    }, 200);
});

// ── Auto-scroll ──
autoscrollBtn.addEventListener('click', () => {
    autoScroll = !autoScroll;
    autoscrollBtn.classList.toggle('active', autoScroll);
    if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
});

logEl.addEventListener('scroll', () => {
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
    if (!atBottom && autoScroll) {
        autoScroll = false;
        autoscrollBtn.classList.remove('active');
    }
});

// ── Pause ──
pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    pauseBtn.classList.toggle('active', paused);
    if (!paused) rebuildDom();
});

// ── Copy ──
copyBtn.addEventListener('click', () => {
    const lines = [];
    for (const entry of allLines) {
        if (matchesFilter(entry)) {
            lines.push(`[${formatTime(entry.ts)}] ${entry.text}`);
        }
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = '⎘ Copy'; }, 1500);
    });
});

// ── Save ──
const saveBtn = document.getElementById('cv-save');
saveBtn.addEventListener('click', async () => {
    const lines = [];
    for (const entry of allLines) {
        if (matchesFilter(entry)) {
            lines.push(`[${formatTime(entry.ts)}] ${entry.text}`);
        }
    }
    const content = lines.join('\n');
    try {
        const ok = await api.saveConsoleLog?.(content);
        if (ok) {
            saveBtn.textContent = '✓ Saved';
            setTimeout(() => { saveBtn.textContent = '💾 Save .log'; }, 2000);
        }
    } catch {}
});

// ── Clear ──
clearBtn.addEventListener('click', () => {
    allLines = [];
    countAll = countMitm = countSystem = 0;
    logEl.innerHTML = '';
    updateBadges();
    updateCount();
});

// ── IPC: receive log lines from main process ──
api.onConsoleLog?.((data) => {
    if (!data) return;
    const lines = Array.isArray(data) ? data : [data];
    for (const item of lines) {
        const text = typeof item === 'string' ? item : (item.text || '');
        if (!text) continue;
        const category = classifyLine(text);
        const ts = item.ts ? new Date(item.ts) : new Date();
        addLine(text, category, ts);
    }
    updateCount();
});

// ── Request buffered history on load ──
(async () => {
    try {
        const history = await api.getConsoleHistory?.();
        if (history?.length) {
            for (const item of history) {
                const text = typeof item === 'string' ? item : (item.text || '');
                if (!text) continue;
                const category = classifyLine(text);
                const ts = item.ts ? new Date(item.ts) : new Date();
                addLine(text, category, ts);
            }
            updateCount();
        }
    } catch {}
})();
