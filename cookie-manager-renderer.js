'use strict';

const api = window.electronAPI;

// ─── State ────────────────────────────────────────────────────────────────────
let allCookies      = [];
let filteredCookies = [];
let activeTabId     = null;
let allTabs         = [];
let editingCookie   = null;
let sortCol         = 'domain';
let sortAsc         = true;
let autoRefreshTimer    = null;
let currentTabDomain    = '';   // hostname of the active tab's current URL

// ─── DOM ──────────────────────────────────────────────────────────────────────
const tabSelect         = document.getElementById('tab-select');
const tbody             = document.getElementById('cookie-tbody');
const countLabel        = document.getElementById('count-label');
const statusMsg         = document.getElementById('status-msg');
const editPanel         = document.getElementById('edit-panel');
const editPanelTitle    = document.getElementById('edit-panel-title');
const shareModal        = document.getElementById('share-modal');
const importFileInput   = document.getElementById('import-file-input');

const filterDomain          = document.getElementById('filter-domain');
const filterName            = document.getElementById('filter-name');
const filterValue           = document.getElementById('filter-value');
const filterHttpOnly        = document.getElementById('filter-httponly');
const filterSecure          = document.getElementById('filter-secure');
const filterSession         = document.getElementById('filter-session');
const filterCurrentDomain   = document.getElementById('filter-current-domain');
const filterCurDomainText   = document.getElementById('filter-cur-domain-text');

// ─── Delegated row actions (single listener, no re-registration on re-render) ─
tbody.addEventListener('click', e => {
    const btn = e.target.closest('button');
    const tr  = e.target.closest('tr[data-idx]');
    if (!tr) return;
    const idx = +tr.dataset.idx;
    const c   = filteredCookies[idx];
    if (!c) return;
    if (btn) {
        e.stopPropagation();
        if (btn.classList.contains('btn-edit-row'))  { openEdit(c); return; }
        if (btn.classList.contains('btn-del-row'))   { deleteCookie(c); return; }
        if (btn.classList.contains('btn-copy-val'))  { copyToClipboard(c.value); return; }
    } else {
        openEdit(c);
    }
});

// ─── Status helper ────────────────────────────────────────────────────────────
let statusTimer = null;
function setStatus(msg, type = 'info', ms = 3000) {
    statusMsg.textContent = msg;
    statusMsg.className = `status-msg ${type}`;
    clearTimeout(statusTimer);
    if (ms > 0) statusTimer = setTimeout(() => {
        statusMsg.textContent = 'Ready';
        statusMsg.className = 'status-msg';
    }, ms);
}

// ─── Tab selector ─────────────────────────────────────────────────────────────
function tabLabel(t) {
    const num   = t.num ? `#${t.num}` : '';
    const title = t.title || 'New Tab';
    const url   = t.url   || '(blank)';
    return `${num} ${title} — ${url}`;
}

function populateTabs(tabs, keepActiveId) {
    allTabs = tabs || [];
    const prevId = keepActiveId || activeTabId;
    tabSelect.innerHTML = '';
    for (const t of allTabs) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = tabLabel(t);
        tabSelect.appendChild(opt);
    }
    // Restore selection if the tab still exists, otherwise pick first
    if (prevId && tabSelect.querySelector(`option[value="${prevId}"]`)) {
        tabSelect.value = prevId;
    } else if (allTabs.length) {
        tabSelect.value = allTabs[0].id;
        if (!activeTabId) activeTabId = allTabs[0].id;
    }
}

tabSelect.addEventListener('change', () => {
    activeTabId = tabSelect.value;
    allCookies = [];
    filteredCookies = [];
    renderTable();
    setActiveDomain(activeTabId);   // update domain filter for new tab
    loadCookies();
    startAutoRefresh();
});

// ─── Auto-refresh ─────────────────────────────────────────────────────────────
const AUTO_REFRESH_MS = 3000;

function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(() => {
        if (activeTabId && !editingCookie) loadCookiesSilent();
    }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

// ─── Load cookies ─────────────────────────────────────────────────────────────
async function loadCookies() {
    if (!activeTabId) return;
    try {
        allCookies = await api.getCookies(activeTabId, {});
        applyFilters();
        setStatus(`${allCookies.length} cookies`, 'ok', 1500);
    } catch (e) {
        setStatus(`Error: ${e.message}`, 'err');
    }
}

/** Quick structural equality check — avoids full JSON serialisation every 3s */
function cookiesChanged(a, b) {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
        if (a[i].name !== b[i].name || a[i].value !== b[i].value ||
            a[i].domain !== b[i].domain || a[i].expirationDate !== b[i].expirationDate) return true;
    }
    return false;
}

/** Silent refresh — no status flash, preserves edit state */
async function loadCookiesSilent() {
    if (!activeTabId) return;
    try {
        const fresh = await api.getCookies(activeTabId, {});
        if (cookiesChanged(fresh, allCookies)) {
            allCookies = fresh;
            applyFilters();
        }
    } catch {}
}

// ─── Current-domain filter helpers ────────────────────────────────────────────
function extractDomain(url) {
    if (!url || url === '(blank)') return '';
    try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * Called whenever the active tab changes or the toggle changes.
 * Syncs the domain text input with the current-tab toggle state.
 */
function syncDomainFilter() {
    const locked = filterCurrentDomain.checked;
    if (locked) {
        filterDomain.value    = currentTabDomain;
        filterDomain.readOnly = true;
        filterDomain.setAttribute('readonly', '');
        filterDomain.placeholder = currentTabDomain || 'no domain';
    } else {
        filterDomain.value    = '';            // clear when toggled off
        filterDomain.readOnly = false;
        filterDomain.removeAttribute('readonly');
        filterDomain.placeholder = 'domain…';
    }
    applyFilters();
}

/** Update domain derived from a given tab's URL, then sync */
function setActiveDomain(tabId) {
    const tab = allTabs.find(t => t.id === tabId);
    currentTabDomain = tab ? extractDomain(tab.url) : '';
    syncDomainFilter();
}

filterCurrentDomain.addEventListener('change', syncDomainFilter);

// When domain input is manually edited (only possible when checkbox is off)
filterDomain.addEventListener('input', () => {
    if (!filterCurrentDomain.checked) applyFilters();
});

// ─── Filters ──────────────────────────────────────────────────────────────────
function applyFilters() {
    const sDomain  = filterDomain.value.toLowerCase();
    const sName    = filterName.value.toLowerCase();
    const sValue   = filterValue.value.toLowerCase();
    const onlyHttp = filterHttpOnly.checked;
    const onlySec  = filterSecure.checked;
    const onlySess = filterSession.checked;

    filteredCookies = allCookies.filter(c => {
        if (sDomain) {
            const cd = (c.domain || '').toLowerCase();
            if (!cd.includes(sDomain) && !sDomain.endsWith(cd)) return false;
        }
        if (sName   && !(c.name  || '').toLowerCase().includes(sName))   return false;
        if (sValue  && !(c.value || '').toLowerCase().includes(sValue))  return false;
        if (onlyHttp && !c.httpOnly) return false;
        if (onlySec  && !c.secure)  return false;
        if (onlySess && c.expirationDate) return false;
        return true;
    });

    filteredCookies = sortCookies(filteredCookies);
    renderTable();
}

[filterName, filterValue].forEach(el => el.addEventListener('input', applyFilters));
[filterHttpOnly, filterSecure, filterSession].forEach(el => el.addEventListener('change', applyFilters));

// ─── Sort ─────────────────────────────────────────────────────────────────────
function sortCookies(arr) {
    return [...arr].sort((a, b) => {
        const va = (a[sortCol] ?? '').toString().toLowerCase();
        const vb = (b[sortCol] ?? '').toString().toLowerCase();
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
}

document.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (sortCol === col) { sortAsc = !sortAsc; }
        else { sortCol = col; sortAsc = true; }
        document.querySelectorAll('th').forEach(t => t.classList.remove('sorted'));
        th.classList.add('sorted');
        th.textContent = th.textContent.replace(/[▲▼]\s*/g, '').trim();
        th.textContent = (sortAsc ? '▲ ' : '▼ ') + th.textContent;
        filteredCookies = sortCookies(filteredCookies);
        renderTable();
    });
});

// ─── Render table ─────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatExpires(c) {
    if (!c.expirationDate) return '<span style="color:var(--muted)">Session</span>';
    const d = new Date(c.expirationDate * 1000);
    const now = Date.now();
    const ms  = d.getTime() - now;
    if (ms < 0) return `<span style="color:var(--danger)">Expired</span>`;
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'});
}

function renderTable() {
    countLabel.textContent = `${filteredCookies.length} / ${allCookies.length} cookies`;

    if (!filteredCookies.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No cookies found</td></tr>`;
        return;
    }

    tbody.innerHTML = filteredCookies.map((c, i) => {
        const flags = [
            c.httpOnly ? `<span class="flag http">HttpOnly</span>` : '',
            c.secure   ? `<span class="flag sec">Secure</span>` : '',
            c.sameSite ? `<span class="flag same">${c.sameSite}</span>` : '',
            !c.expirationDate ? `<span class="flag sess">Session</span>` : '',
        ].filter(Boolean).join('');

        return `<tr data-idx="${i}">
            <td class="cell-name"  title="${escHtml(c.name)}">${escHtml(c.name)}</td>
            <td class="cell-value" title="${escHtml(c.value)}">${escHtml(truncate(c.value, 40))}</td>
            <td class="cell-domain" title="${escHtml(c.domain)}">${escHtml(c.domain)}</td>
            <td title="${escHtml(c.path)}">${escHtml(truncate(c.path, 20))}</td>
            <td style="white-space:nowrap;font-size:11px">${formatExpires(c)}</td>
            <td><div class="cell-flags">${flags}</div></td>
            <td>
                <div class="actions-cell">
                    <button class="btn btn-ghost btn-sm btn-edit-row" data-idx="${i}" title="Edit">✎</button>
                    <button class="btn btn-danger btn-sm btn-del-row"  data-idx="${i}" title="Delete">✕</button>
                    <button class="btn btn-ghost btn-sm btn-copy-val"  data-idx="${i}" title="Copy value">⧉</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function truncate(s, len) {
    s = s ?? '';
    return s.length > len ? s.slice(0, len) + '…' : s;
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text || '').catch(() => {});
    setStatus('Value copied to clipboard', 'ok', 1500);
}

// ─── Edit panel ───────────────────────────────────────────────────────────────
function openEdit(cookie) {
    editingCookie = cookie || null;
    editPanelTitle.textContent = cookie ? `Edit: ${cookie.name}` : 'New Cookie';
    document.getElementById('e-name').value     = cookie?.name       ?? '';
    document.getElementById('e-value').value    = cookie?.value      ?? '';
    document.getElementById('e-domain').value   = cookie?.domain     ?? '';
    document.getElementById('e-path').value     = cookie?.path       ?? '/';
    document.getElementById('e-expires').value  = cookie?.expirationDate ?? '';
    document.getElementById('e-samesite').value = cookie?.sameSite   ?? '';
    document.getElementById('e-httponly').checked = cookie?.httpOnly ?? false;
    document.getElementById('e-secure').checked   = cookie?.secure   ?? false;
    document.getElementById('btn-delete-from-edit').style.display = cookie ? '' : 'none';
    editPanel.classList.add('open');
}

function closeEdit() {
    editPanel.classList.remove('open');
    editingCookie = null;
}

document.getElementById('btn-close-edit').addEventListener('click', closeEdit);
document.getElementById('btn-cancel-edit').addEventListener('click', closeEdit);

document.getElementById('btn-save-cookie').addEventListener('click', async () => {
    const name    = document.getElementById('e-name').value.trim();
    const domain  = document.getElementById('e-domain').value.trim();
    const path    = document.getElementById('e-path').value.trim() || '/';

    if (!name || !domain) { setStatus('Name and Domain are required', 'err'); return; }

    const expiresRaw = document.getElementById('e-expires').value.trim();
    const details = {
        name,
        value:          document.getElementById('e-value').value,
        domain,
        path,
        httpOnly:       document.getElementById('e-httponly').checked,
        secure:         document.getElementById('e-secure').checked,
        url:            `${document.getElementById('e-secure').checked ? 'https' : 'http'}://${domain.replace(/^\./, '')}${path}`,
    };
    const ss = document.getElementById('e-samesite').value;
    if (ss) details.sameSite = ss;
    if (expiresRaw) details.expirationDate = Number(expiresRaw);

    const result = await api.setCookie(activeTabId, details);
    if (result.success) {
        setStatus(`Cookie "${name}" saved`, 'ok');
        closeEdit();
        await loadCookies();   // full refresh with status after a write
    } else {
        setStatus(`Error: ${result.error}`, 'err', 0);
    }
});

document.getElementById('btn-delete-from-edit').addEventListener('click', async () => {
    if (editingCookie) await deleteCookie(editingCookie);
    closeEdit();
});

// ─── Delete ───────────────────────────────────────────────────────────────────
async function deleteCookie(c) {
    const url = `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
    await api.removeCookie(activeTabId, url, c.name);
    setStatus(`Deleted "${c.name}"`, 'ok');
    await loadCookies();
}

// ─── Toolbar buttons ──────────────────────────────────────────────────────────
document.getElementById('btn-add-new').addEventListener('click', () => openEdit(null));

document.getElementById('btn-clear-all').addEventListener('click', async () => {
    const domFilter = filterDomain.value.trim();
    const msg = domFilter
        ? `Delete all cookies for domain "${domFilter}"?`
        : 'Delete ALL cookies for this tab?';
    if (!confirm(msg)) return;
    const result = await api.clearCookies(activeTabId, domFilter || null);
    if (result.success) {
        setStatus(`Deleted ${result.count} cookies`, 'ok');
        await loadCookies();
    } else {
        setStatus(`Error: ${result.error}`, 'err');
    }
});

// ─── Export ───────────────────────────────────────────────────────────────────
document.getElementById('btn-export-json').addEventListener('click', () => {
    const data   = JSON.stringify(filteredCookies, null, 2);
    const tab    = allTabs.find(t => t.id === activeTabId);
    const domain = filteredCookies[0]?.domain?.replace(/^\./, '') || 'cookies';
    downloadFile(`${domain}.cookies.json`, data, 'application/json');
    setStatus(`Exported ${filteredCookies.length} cookies as JSON`, 'ok');
});

document.getElementById('btn-export-netscape').addEventListener('click', () => {
    const lines = ['# Netscape HTTP Cookie File', '# Generated by CupNet 2.0', ''];
    const sanitize = (v) => String(v ?? '').replace(/[\r\n\t]/g, ' ');
    for (const c of filteredCookies) {
        const flag     = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const secure   = c.secure ? 'TRUE' : 'FALSE';
        const expires  = c.expirationDate ? Math.floor(c.expirationDate) : 0;
        lines.push(`${sanitize(c.domain)}\t${flag}\t${sanitize(c.path || '/')}\t${secure}\t${expires}\t${sanitize(c.name)}\t${sanitize(c.value)}`);
    }
    const domain = filteredCookies[0]?.domain?.replace(/^\./, '') || 'cookies';
    downloadFile(`${domain}.cookies.txt`, lines.join('\n'), 'text/plain');
    setStatus(`Exported ${filteredCookies.length} cookies as Netscape format`, 'ok');
});

function downloadFile(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Import ───────────────────────────────────────────────────────────────────
document.getElementById('btn-import').addEventListener('click', () => {
    importFileInput.value = '';
    importFileInput.click();
});

importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files[0];
    if (!file) return;
    const MAX_IMPORT_SIZE = 10 * 1024 * 1024; // 10 MB
    if (file.size > MAX_IMPORT_SIZE) { setStatus('File too large (max 10 MB)', 'err'); return; }
    const text = await file.text();
    let cookies = [];

    if (file.name.endsWith('.json')) {
        try { cookies = JSON.parse(text); } catch { setStatus('Invalid JSON file', 'err'); return; }
        if (!Array.isArray(cookies)) { setStatus('Expected a JSON array of cookies', 'err'); return; }
    } else {
        // Netscape format
        for (const line of text.split('\n')) {
            if (line.startsWith('#') || !line.trim()) continue;
            const parts = line.split('\t');
            if (parts.length < 7) continue;
            cookies.push({
                domain: parts[0], path: parts[2],
                secure: parts[3] === 'TRUE',
                expirationDate: Number(parts[4]) || undefined,
                name: parts[5], value: parts[6]
            });
        }
    }

    let ok = 0, fail = 0;
    for (const c of cookies) {
        const url = `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
        const result = await api.setCookie(activeTabId, { ...c, url });
        result.success ? ok++ : fail++;
    }
    setStatus(`Imported: ${ok} ok, ${fail} failed`, ok > 0 ? 'ok' : 'err');
    await loadCookies();
});

// ─── Share modal ──────────────────────────────────────────────────────────────
document.getElementById('btn-share').addEventListener('click', () => {
    const sourceTab = allTabs.find(t => t.id === activeTabId);
    document.getElementById('share-source-label').textContent =
        sourceTab ? tabLabel(sourceTab) : activeTabId;

    const targetSel = document.getElementById('share-target-select');
    targetSel.innerHTML = '';
    for (const t of allTabs) {
        if (t.id === activeTabId) continue;
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = tabLabel(t);
        targetSel.appendChild(opt);
    }
    if (!targetSel.options.length) {
        setStatus('No other tabs to share to', 'err'); return;
    }
    document.getElementById('share-domain-filter').value = '';
    shareModal.classList.add('open');
});

document.getElementById('btn-share-cancel').addEventListener('click', () => shareModal.classList.remove('open'));
shareModal.addEventListener('click', e => { if (e.target === shareModal) shareModal.classList.remove('open'); });

document.getElementById('btn-share-confirm').addEventListener('click', async () => {
    const toTabId  = document.getElementById('share-target-select').value;
    const domain   = document.getElementById('share-domain-filter').value.trim() || null;
    shareModal.classList.remove('open');
    const result = await api.shareCookies(activeTabId, toTabId, domain);
    if (result.success) {
        setStatus(`Shared ${result.count} cookies to another tab`, 'ok');
    } else {
        setStatus(`Share failed: ${result.error}`, 'err');
    }
});

// ─── IPC events ───────────────────────────────────────────────────────────────

/** Initial set of tabs + which tab to focus */
api.onCookieTabsList((tabs) => {
    populateTabs(tabs);
    if (!activeTabId && tabs.length) activeTabId = tabs[0].id;
    if (activeTabId) {
        tabSelect.value = activeTabId;
        setActiveDomain(activeTabId);
        loadCookies();
        startAutoRefresh();
    }
});

/**
 * Main window switched active tab (or explicitly set one for us).
 * Always follow the active tab automatically.
 */
api.onSetActiveCookieTab((tabId) => {
    if (activeTabId === tabId) return;   // already on this tab
    activeTabId = tabId;
    if (tabSelect.querySelector(`option[value="${tabId}"]`)) {
        tabSelect.value = tabId;
    }
    allCookies = [];
    filteredCookies = [];
    renderTable();
    setActiveDomain(tabId);
    loadCookies();
    startAutoRefresh();
});

/** Tabs list changed (tab added/closed/URL changed) — update dropdown and domain filter */
api.onTabsUpdated((tabs) => {
    const prev = activeTabId;
    populateTabs(tabs, prev);

    // If our active tab was removed, switch to first available
    if (prev && !tabs.find(t => t.id === prev) && tabs.length) {
        activeTabId = tabs[0].id;
        tabSelect.value = activeTabId;
        setActiveDomain(activeTabId);
        loadCookies();
    } else {
        // URL of the active tab may have changed — update domain filter if needed
        const activeTab = tabs.find(t => t.id === activeTabId);
        const newDomain = activeTab ? extractDomain(activeTab.url) : '';
        if (newDomain !== currentTabDomain) {
            currentTabDomain = newDomain;
            syncDomainFilter();
        }
    }

    // Update share modal target list too if it's open
    if (!document.getElementById('share-modal').classList.contains('open')) return;
    const targetSel = document.getElementById('share-target-select');
    targetSel.innerHTML = '';
    for (const t of tabs) {
        if (t.id === activeTabId) continue;
        const o = document.createElement('option');
        o.value = t.id; o.textContent = tabLabel(t);
        targetSel.appendChild(o);
    }
});

window.addEventListener('beforeunload', stopAutoRefresh);

// ─── Init ─────────────────────────────────────────────────────────────────────
api.getTabs().then(tabs => {
    if (!allTabs.length) populateTabs(tabs);
    if (!activeTabId && tabs.length) activeTabId = tabs[0].id;
    if (activeTabId) {
        tabSelect.value = activeTabId;
        setActiveDomain(activeTabId);   // ← apply current-domain filter on open
        loadCookies();
        startAutoRefresh();
    }
}).catch(() => {});
