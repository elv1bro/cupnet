'use strict';

const api = window.electronAPI;

let allRules = [];
let filteredRules = [];
let editingRule = null;
let selectedRuleId = null;
let activityEntries = [];
let activityCurrentPage = null;

const tbody = document.getElementById('dns-tbody');
const countLabel = document.getElementById('count-label');
const statusMsg = document.getElementById('status-msg');
const editPanel = document.getElementById('edit-panel');
const editPanelTitle = document.getElementById('edit-panel-title');
const activityLog = document.getElementById('activity-log');
const activityCount = document.getElementById('activity-count');

const filterHost = document.getElementById('filter-host');
const filterIp = document.getElementById('filter-ip');
const filterEnabledOnly = document.getElementById('filter-enabled-only');

let statusTimer = null;
function setStatus(msg, type = 'info', ms = 3000) {
    statusMsg.textContent = msg;
    statusMsg.className = `status-msg ${type}`;
    clearTimeout(statusTimer);
    if (ms > 0) {
        statusTimer = setTimeout(() => {
            statusMsg.textContent = 'Ready';
            statusMsg.className = 'status-msg';
        }, ms);
    }
}

function isValidPlainDnsHost(value) {
    const parts = value.split('.');
    if (!parts.length || parts.some(p => !p || p.length > 63)) return false;
    return parts.every(p => /^[a-z0-9-]+$/i.test(p) && !p.startsWith('-') && !p.endsWith('-'));
}

function isValidDnsHost(host) {
    const value = String(host || '').trim().toLowerCase();
    if (!value || value.length > 253) return false;
    if (value.startsWith('*.')) {
        const rest = value.slice(2);
        return !!rest && isValidPlainDnsHost(rest) && rest.includes('.');
    }
    return isValidPlainDnsHost(value);
}

function isValidIpv4(ip) {
    const value = String(ip || '').trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
    return value.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
}

function escHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('ru-RU');
}

function extractPage(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return String(url || '');
    }
}

function formatTime(v) {
    const d = v instanceof Date ? v : new Date(v);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function openEdit(rule) {
    editingRule = rule || null;
    editPanelTitle.textContent = rule ? `Edit: ${rule.host}` : 'New DNS Rule';
    document.getElementById('e-host').value = rule?.host || '';
    document.getElementById('e-ip').value = rule?.ip || '';
    document.getElementById('e-enabled').checked = rule ? !!rule.enabled : true;
    const ec = document.getElementById('e-mitm-cors');
    if (ec) ec.checked = rule ? !!rule.mitm_inject_cors : false;
    editPanel.classList.add('open');
}

function closeEdit() {
    editPanel.classList.remove('open');
    editingRule = null;
}

function applyFilters() {
    const hostQuery = filterHost.value.trim().toLowerCase();
    const ipQuery = filterIp.value.trim().toLowerCase();
    const enabledOnly = filterEnabledOnly.checked;

    filteredRules = allRules.filter(r => {
        if (hostQuery && !(r.host || '').toLowerCase().includes(hostQuery)) return false;
        if (ipQuery && !(r.ip || '').toLowerCase().includes(ipQuery)) return false;
        if (enabledOnly && !r.enabled) return false;
        return true;
    });
    renderTable();
}

function renderTable() {
    countLabel.textContent = `${filteredRules.length} / ${allRules.length} rules`;

    if (!filteredRules.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No DNS override rules</td></tr>';
        return;
    }

    tbody.innerHTML = filteredRules.map((r, idx) => `
        <tr data-idx="${idx}" class="${r.enabled ? 'rule-enabled' : 'rule-disabled'}">
            <td>
                <input type="radio" name="selected-rule" ${selectedRuleId === r.id ? 'checked' : ''}>
            </td>
            <td class="cell-host" title="${escHtml(r.host)}">${escHtml(r.host)}</td>
            <td class="cell-ip" title="${escHtml(r.ip || '—')}">${escHtml(r.ip || '—')}</td>
            <td class="dns-cors-cell">
                <button type="button"
                    class="cors-toggle-btn ${r.mitm_inject_cors ? 'cors-toggle-on' : 'cors-toggle-off'} btn-cors-toggle"
                    aria-pressed="${r.mitm_inject_cors ? 'true' : 'false'}"
                    title="Click: toggle MITM CORS headers for this host (requires Origin on requests). Enabled DNS rule only.">
                    CORS ${r.mitm_inject_cors ? 'ON' : 'OFF'}
                </button>
            </td>
            <td>
                <span class="state-pill ${r.enabled ? 'enabled' : 'disabled'}">${r.enabled ? 'ON' : 'OFF'}</span>
            </td>
            <td title="${escHtml(r.updated_at || '')}">${escHtml(formatDate(r.updated_at || r.created_at))}</td>
            <td>
                <div class="actions-cell">
                    <button class="btn ${r.enabled ? 'btn-danger' : 'btn-success'} btn-sm btn-toggle">${r.enabled ? 'Disable' : 'Enable'}</button>
                    <button class="btn btn-ghost btn-sm btn-edit">Edit</button>
                    <button class="btn btn-danger btn-sm btn-delete">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function updateActivityCount() {
    if (activityCount) activityCount.textContent = String(activityEntries.length);
}

function renderActivity() {
    if (!activityLog) return;
    if (!activityEntries.length) {
        activityLog.innerHTML = '<div class="act-empty">No DNS activity yet.</div>';
        return;
    }
    let html = '';
    let currentGroup = null;
    for (const e of activityEntries) {
        if (e.page !== currentGroup) {
            currentGroup = e.page;
            html += `<div class="act-group-header">📄 <span class="act-group-url" title="${escHtml(e.page)}">${escHtml(e.page)}</span></div>`;
        }
        html += `<div class="act-row">
            <span class="act-time">${escHtml(formatTime(e.ts))}</span>
            <span class="act-rule">${escHtml(e.ruleName || `${e.host} -> ${e.ip}`)}</span>
            <span class="act-url" title="${escHtml(e.url || '')}">${escHtml(e.url || '')}</span>
            <button class="act-link" data-url="${escHtml(e.url || '')}">Request</button>
        </div>`;
    }
    activityLog.innerHTML = html;
    activityLog.querySelectorAll('.act-link').forEach(btn => {
        btn.addEventListener('click', async () => {
            const url = btn.dataset.url || '';
            if (!url) return;
            await api.openLogViewerWithUrl?.(url);
        });
    });
    activityLog.scrollTop = activityLog.scrollHeight;
}

function addActivityEvent(info) {
    const page = extractPage(info?.url || '');
    if (page !== activityCurrentPage) activityCurrentPage = page;
    activityEntries.push({
        ts: info?.ts ? new Date(info.ts) : new Date(),
        page: activityCurrentPage,
        url: info?.url || '',
        host: info?.host || '',
        ip: info?.ip || '',
        ruleName: info?.ruleName || '',
        tabId: info?.tabId || null,
    });
    if (activityEntries.length > 300) {
        activityEntries.splice(0, activityEntries.length - 300);
    }
    updateActivityCount();
    const activityTab = document.getElementById('tab-activity');
    if (activityTab?.classList.contains('active')) renderActivity();
}

async function loadRules() {
    try {
        const rules = await api.getDnsOverrides();
        allRules = Array.isArray(rules) ? rules : [];
        if (selectedRuleId && !allRules.find(r => r.id === selectedRuleId)) selectedRuleId = null;
        applyFilters();
    } catch (e) {
        setStatus(`Load error: ${e.message}`, 'err', 0);
    }
}

tbody.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-idx]');
    if (!tr) return;
    const idx = Number(tr.dataset.idx);
    const rule = filteredRules[idx];
    if (!rule) return;

    selectedRuleId = rule.id;

    if (e.target.classList.contains('btn-cors-toggle')) {
        const nextCors = !rule.mitm_inject_cors;
        if (!nextCors && !String(rule.ip || '').trim()) {
            setStatus('Сначала укажите IPv4 или удалите правило (сейчас только MITM CORS без редиректа).', 'err', 0);
            return;
        }
        const res = await api.saveDnsOverride({
            id: rule.id,
            host: rule.host,
            ip: rule.ip,
            enabled: rule.enabled,
            mitm_inject_cors: nextCors,
        });
        if (!res?.success) {
            setStatus(`CORS toggle failed: ${res?.error || 'unknown'}`, 'err', 0);
            return;
        }
        setStatus(`${rule.host}: MITM CORS ${nextCors ? 'on' : 'off'}`, 'ok');
        await loadRules();
        return;
    }

    if (e.target.classList.contains('btn-edit')) {
        openEdit(rule);
        return;
    }
    if (e.target.classList.contains('btn-delete')) {
        if (!confirm(`Delete DNS rule for "${rule.host}"?`)) return;
        const res = await api.deleteDnsOverride(rule.id);
        if (!res?.success) {
            setStatus(`Delete failed: ${res?.error || 'unknown error'}`, 'err', 0);
            return;
        }
        setStatus(`Deleted rule ${rule.host}`, 'ok');
        await loadRules();
        return;
    }
    if (e.target.classList.contains('btn-toggle')) {
        const res = await api.toggleDnsOverride(rule.id, !rule.enabled);
        if (!res?.success) {
            setStatus(`Toggle failed: ${res?.error || 'unknown error'}`, 'err', 0);
            return;
        }
        setStatus(`${rule.host}: ${rule.enabled ? 'disabled' : 'enabled'}`, 'ok');
        await loadRules();
        return;
    }
    renderTable();
});

document.getElementById('btn-add-new').addEventListener('click', () => openEdit(null));
document.getElementById('btn-refresh').addEventListener('click', () => loadRules());
document.getElementById('btn-clear-activity').addEventListener('click', () => {
    activityEntries = [];
    activityCurrentPage = null;
    updateActivityCount();
    renderActivity();
});

document.getElementById('btn-delete-selected').addEventListener('click', async () => {
    if (!selectedRuleId) {
        setStatus('Select a rule first', 'err');
        return;
    }
    const selected = allRules.find(r => r.id === selectedRuleId);
    if (!selected) return;
    if (!confirm(`Delete DNS rule for "${selected.host}"?`)) return;
    const res = await api.deleteDnsOverride(selectedRuleId);
    if (!res?.success) {
        setStatus(`Delete failed: ${res?.error || 'unknown error'}`, 'err', 0);
        return;
    }
    selectedRuleId = null;
    setStatus(`Deleted rule ${selected.host}`, 'ok');
    await loadRules();
});

document.getElementById('btn-close-edit').addEventListener('click', closeEdit);
document.getElementById('btn-cancel-edit').addEventListener('click', closeEdit);

document.getElementById('btn-save-rule').addEventListener('click', async () => {
    const host = document.getElementById('e-host').value.trim().toLowerCase();
    const ip = document.getElementById('e-ip').value.trim();
    const enabled = document.getElementById('e-enabled').checked;

    if (!isValidDnsHost(host)) {
        setStatus('Invalid host (example: api.example.com)', 'err');
        return;
    }

    const mitm_inject_cors = !!document.getElementById('e-mitm-cors')?.checked;
    if (host.startsWith('*.')) {
        if (!mitm_inject_cors) {
            setStatus('Шаблон *.domain — только вместе с MITM CORS', 'err');
            return;
        }
        if (ip) {
            setStatus('Шаблон *.domain нельзя сочетать с IPv4', 'err');
            return;
        }
    }
    if (mitm_inject_cors) {
        if (ip && !isValidIpv4(ip)) {
            setStatus('Invalid IPv4 (example: 1.2.3.4)', 'err');
            return;
        }
    } else {
        if (!isValidIpv4(ip)) {
            setStatus('Invalid IPv4 (example: 1.2.3.4)', 'err');
            return;
        }
    }
    const payload = {
        id: editingRule?.id || null,
        host,
        ip,
        enabled,
        mitm_inject_cors,
    };
    const res = await api.saveDnsOverride(payload);
    if (!res?.success) {
        setStatus(`Save failed: ${res?.error || 'unknown error'}`, 'err', 0);
        return;
    }
    selectedRuleId = res.id || editingRule?.id || null;
    setStatus(ip ? `Saved rule ${host} -> ${ip}` : `Saved rule ${host} (MITM CORS only, без DNS-редиректа)`, 'ok');
    closeEdit();
    await loadRules();
});

[filterHost, filterIp].forEach(el => el.addEventListener('input', applyFilters));
filterEnabledOnly.addEventListener('change', applyFilters);

api.onDnsOverridesUpdated?.((rules) => {
    if (Array.isArray(rules)) {
        allRules = rules;
        applyFilters();
    }
});

api.onDnsRuleMatched?.((info) => addActivityEvent(info));
api.onDnsRuleMatchedBatch?.((items) => {
    if (!Array.isArray(items) || !items.length) return;
    for (const info of items) addActivityEvent(info);
});

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        btn.classList.add('active');
        const target = document.getElementById(`tab-${btn.dataset.tab}`);
        if (target) target.classList.add('active');
        if (btn.dataset.tab === 'activity') renderActivity();
    });
});

loadRules();
updateActivityCount();
