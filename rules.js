'use strict';

const api = window.electronAPI;

// ─── Tab switching ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function showMsg(msg, isError = false) {
    let el = document.getElementById('_rules-msg');
    if (!el) {
        el = document.createElement('div');
        el.id = '_rules-msg';
        el.style.cssText = `position:fixed;bottom:16px;right:16px;padding:10px 16px;border-radius:8px;
            font-size:12.5px;font-weight:600;z-index:9999;transition:opacity 0.3s`;
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = isError ? 'rgba(239,68,68,0.18)' : 'rgba(34,197,94,0.18)';
    el.style.color       = isError ? '#f87171' : '#4ade80';
    el.style.border      = `1px solid ${isError ? 'rgba(239,68,68,0.35)' : 'rgba(34,197,94,0.35)'}`;
    el.style.opacity     = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

function onClick(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
}

function onChange(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HIGHLIGHT RULES
// ═══════════════════════════════════════════════════════════════════════════════

const FIELDS = ['url', 'method', 'status', 'type', 'duration', 'responseBody', 'requestBody', 'host', 'error'];
const OPS    = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'gt', 'lt', 'gte', 'lte', 'between', 'exists', 'notExists'];
const ACTION_TYPES = ['highlight', 'screenshot', 'notification', 'block'];

let editingRuleId = null;

function makeConditionRow(cond = {}) {
    const row = document.createElement('div');
    row.className = 'builder-row';
    row.innerHTML =
        `<select class="cond-field">${FIELDS.map(f => `<option value="${f}"${cond.field === f ? ' selected' : ''}>${f}</option>`).join('')}</select>` +
        `<select class="cond-op">${OPS.map(o => `<option value="${o}"${cond.op === o ? ' selected' : ''}>${o}</option>`).join('')}</select>` +
        `<input type="text" class="cond-value" placeholder="value" value="${escHtml(cond.value || '')}">` +
        `<button class="btn-danger btn-sm" title="Remove condition">✕</button>`;
    row.querySelector('.btn-danger').addEventListener('click', () => row.remove());
    return row;
}

function makeActionRow(action = {}) {
    const row = document.createElement('div');
    row.className = 'builder-row';
    row.innerHTML =
        `<select class="action-type">${ACTION_TYPES.map(t => `<option value="${t}"${action.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>` +
        `<input class="action-color" type="color" value="${action.color || '#3b82f6'}" title="Highlight color" style="flex:0 0 auto">` +
        `<button class="btn-danger btn-sm" title="Remove action">✕</button>`;
    row.querySelector('.btn-danger').addEventListener('click', () => row.remove());
    const typeSelect  = row.querySelector('.action-type');
    const colorInput  = row.querySelector('.action-color');
    const syncColor   = () => { colorInput.style.display = typeSelect.value === 'highlight' ? '' : 'none'; };
    typeSelect.addEventListener('change', syncColor);
    syncColor();
    return row;
}

function getConditions() {
    return [...document.querySelectorAll('#conditions-builder .builder-row')].map(row => ({
        field: row.querySelector('.cond-field').value,
        op:    row.querySelector('.cond-op').value,
        value: row.querySelector('.cond-value').value
    }));
}

function getActions() {
    return [...document.querySelectorAll('#actions-builder .builder-row')].map(row => {
        const type  = row.querySelector('.action-type').value;
        const color = row.querySelector('.action-color').value;
        return type === 'highlight' ? { type, color } : { type };
    });
}

function showRuleForm(rule = null) {
    editingRuleId = rule ? rule.id : null;
    document.getElementById('edit-rule-id').value   = editingRuleId || '';
    document.getElementById('edit-rule-name').value = rule ? rule.name : '';
    const cb = document.getElementById('conditions-builder');
    const ab = document.getElementById('actions-builder');
    cb.innerHTML = '';
    ab.innerHTML = '';
    if (rule) {
        (rule.conditions || []).forEach(c => cb.appendChild(makeConditionRow(c)));
        (rule.actions    || []).forEach(a => ab.appendChild(makeActionRow(a)));
    } else {
        cb.appendChild(makeConditionRow());
        ab.appendChild(makeActionRow());
    }
    document.getElementById('rule-edit-form').classList.add('visible');
    document.getElementById('edit-rule-name').focus();
}

function hideRuleForm() {
    document.getElementById('rule-edit-form').classList.remove('visible');
    editingRuleId = null;
}

async function loadRules() {
    const rules = await api.getRules();
    const list  = document.getElementById('rules-list');
    list.innerHTML = '';
    if (!rules || !rules.length) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎯</div>No rules yet — click "+ New Rule" to create one.</div>';
        return;
    }
    for (const rule of rules) {
        const item = document.createElement('div');
        item.className = 'rule-item';
        const actionBadges = (rule.actions || [])
            .map(a => `<span class="badge badge-${a.type === 'block' ? 'block' : a.type === 'highlight' ? 'hl' : 'default'}">${a.type}</span>`)
            .join(' ');
        item.innerHTML =
            `<label class="toggle">
                <input type="checkbox" class="rule-toggle" data-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
                <span class="toggle-track"></span>
             </label>
             <span class="rule-name">${escHtml(rule.name)}</span>
             <span style="display:flex;gap:4px;flex-shrink:0">${actionBadges}</span>
             <span class="rule-hits" title="Times triggered">${rule.hit_count || 0} hits</span>
             <span class="rule-meta">${(rule.conditions || []).length} cond</span>
             <button class="btn-secondary btn-sm btn-edit-rule">Edit</button>
             <button class="btn-danger btn-sm btn-delete-rule">Delete</button>`;
        item.querySelector('.rule-toggle').addEventListener('change', async e => {
            await api.toggleRule(rule.id, e.target.checked);
        });
        item.querySelector('.btn-edit-rule').addEventListener('click', () => showRuleForm(rule));
        item.querySelector('.btn-delete-rule').addEventListener('click', async () => {
            if (!confirm(`Delete rule "${rule.name}"?`)) return;
            await api.deleteRule(rule.id);
            showMsg('Rule deleted');
            await loadRules();
        });
        list.appendChild(item);
    }
}

onClick('btn-add-rule', () => showRuleForm());
onClick('btn-cancel-rule', hideRuleForm);
onClick('btn-add-condition', () => {
    document.getElementById('conditions-builder')?.appendChild(makeConditionRow());
});
onClick('btn-add-action', () => {
    document.getElementById('actions-builder')?.appendChild(makeActionRow());
});

onClick('btn-save-rule', async () => {
    const name       = document.getElementById('edit-rule-name').value.trim();
    const conditions = getConditions();
    const actions    = getActions();
    if (!name)             { showMsg('Rule name is required', true); return; }
    if (!conditions.length){ showMsg('At least one condition is required', true); return; }
    if (!actions.length)   { showMsg('At least one action is required', true); return; }
    const rule = { name, enabled: true, conditions, actions };
    if (editingRuleId) rule.id = editingRuleId;
    await api.saveRule(rule);
    hideRuleForm();
    showMsg(editingRuleId ? 'Rule updated' : 'Rule saved');
    await loadRules();
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTERCEPT RULES
// ═══════════════════════════════════════════════════════════════════════════════

let editingInterceptId = null;

function showInterceptParamsFor(type) {
    document.getElementById('intercept-params-block').style.display   = type === 'block'         ? 'block' : 'none';
    document.getElementById('intercept-params-headers').style.display = type === 'modifyHeaders'  ? 'block' : 'none';
    document.getElementById('intercept-params-mock').style.display    = type === 'mock'           ? 'block' : 'none';
}

onChange('edit-intercept-type', e => {
    showInterceptParamsFor(e.target.value);
});

function showInterceptForm(rule = null) {
    editingInterceptId = rule ? rule.id : null;
    document.getElementById('edit-intercept-id').value      = editingInterceptId || '';
    document.getElementById('edit-intercept-name').value    = rule ? rule.name : '';
    document.getElementById('edit-intercept-pattern').value = rule ? rule.url_pattern : '';
    const typeEl = document.getElementById('edit-intercept-type');
    typeEl.value = rule ? rule.type : 'block';
    showInterceptParamsFor(typeEl.value);
    document.getElementById('edit-req-headers').value  = rule?.type === 'modifyHeaders' ? JSON.stringify(rule.params?.requestHeaders  || {}, null, 2) : '';
    document.getElementById('edit-resp-headers').value = rule?.type === 'modifyHeaders' ? JSON.stringify(rule.params?.responseHeaders || {}, null, 2) : '';
    document.getElementById('edit-mock-status').value  = rule?.type === 'mock' ? (rule.params?.status   || 200)              : 200;
    document.getElementById('edit-mock-mime').value    = rule?.type === 'mock' ? (rule.params?.mimeType || 'application/json') : 'application/json';
    document.getElementById('edit-mock-body').value    = rule?.type === 'mock' ? (rule.params?.body      || '')               : '';
    document.getElementById('intercept-edit-form').classList.add('visible');
    document.getElementById('edit-intercept-name').focus();
}

function hideInterceptForm() {
    document.getElementById('intercept-edit-form').classList.remove('visible');
    editingInterceptId = null;
}

async function loadInterceptRules() {
    const rules = await api.getInterceptRules();
    const list  = document.getElementById('intercept-list');
    list.innerHTML = '';
    if (!rules || !rules.length) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛡</div>No intercept rules yet — click "+ New Rule" to create one.</div>';
        return;
    }
    for (const rule of rules) {
        const badgeCls = rule.type === 'block' ? 'badge-block' : rule.type === 'mock' ? 'badge-mock' : 'badge-modify';
        const item = document.createElement('div');
        item.className = 'rule-item';
        item.innerHTML =
            `<label class="toggle">
                <input type="checkbox" class="intercept-toggle" data-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
                <span class="toggle-track"></span>
             </label>
             <span class="rule-name">${escHtml(rule.name)}</span>
             <span class="badge ${badgeCls}">${rule.type}</span>
             <span class="rule-meta" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(rule.url_pattern)}">${escHtml(rule.url_pattern)}</span>
             <button class="btn-secondary btn-sm btn-edit-intercept">Edit</button>
             <button class="btn-danger btn-sm btn-delete-intercept">Delete</button>`;
        item.querySelector('.intercept-toggle').addEventListener('change', async e => {
            const saveRes = await api.saveInterceptRule({ ...rule, enabled: e.target.checked });
            if (saveRes && saveRes.error) {
                showMsg(saveRes.error, true);
                e.target.checked = !e.target.checked;
                return;
            }
        });
        item.querySelector('.btn-edit-intercept').addEventListener('click', () => showInterceptForm(rule));
        item.querySelector('.btn-delete-intercept').addEventListener('click', async () => {
            if (!confirm(`Delete rule "${rule.name}"?`)) return;
            await api.deleteInterceptRule(rule.id);
            showMsg('Intercept rule deleted');
            await loadInterceptRules();
        });
        list.appendChild(item);
    }
}

onClick('btn-add-intercept', () => showInterceptForm());
onClick('btn-cancel-intercept', hideInterceptForm);

onClick('btn-test-notification', async () => {
    await api.testInterceptNotification();
    showMsg('Test notifications sent to all windows');
});

onClick('btn-save-intercept', async () => {
    const name    = document.getElementById('edit-intercept-name').value.trim();
    const pattern = document.getElementById('edit-intercept-pattern').value.trim();
    const type    = document.getElementById('edit-intercept-type').value;
    if (!name || !pattern) { showMsg('Name and URL pattern are required', true); return; }

    let params = {};
    if (type === 'modifyHeaders') {
        try { params.requestHeaders  = JSON.parse(document.getElementById('edit-req-headers').value  || '{}'); }
        catch { showMsg('Invalid JSON for request headers', true);  return; }
        try { params.responseHeaders = JSON.parse(document.getElementById('edit-resp-headers').value || '{}'); }
        catch { showMsg('Invalid JSON for response headers', true); return; }
    } else if (type === 'mock') {
        params.status   = parseInt(document.getElementById('edit-mock-status').value, 10);
        params.mimeType = document.getElementById('edit-mock-mime').value.trim();
        params.body     = document.getElementById('edit-mock-body').value;
    }

    const rule = { name, enabled: true, url_pattern: pattern, type, params };
    if (editingInterceptId) rule.id = editingInterceptId;
    const saveRes = await api.saveInterceptRule(rule);
    if (saveRes && saveRes.error) {
        showMsg(saveRes.error, true);
        return;
    }
    hideInterceptForm();
    showMsg(editingInterceptId ? 'Rule updated' : 'Rule saved');
    await loadInterceptRules();
});

// ─── Prefill from log-viewer ───────────────────────────────────────────────────
api.onPrefillInterceptRule?.((data) => {
    // Switch to Intercept tab
    const interceptTabBtn = document.querySelector('.tab-btn[data-tab="intercept"]');
    if (interceptTabBtn) interceptTabBtn.click();

    // Open form with pre-filled data
    showInterceptForm({
        name: data.name || '',
        url_pattern: data.url_pattern || '',
        type: 'mock',
        params: data.params || { status: 200, mimeType: 'application/json', body: '' },
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ═══════════════════════════════════════════════════════════════════════════════

const activityLog   = document.getElementById('activity-log');
const activityCount = document.getElementById('activity-count');
let _actEntries     = [];
let _actCurrentPage = null;

function fmtTime(d) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function extractPage(url) {
    try {
        const u = new URL(url);
        return u.origin + u.pathname;
    } catch { return url; }
}

function renderActivity() {
    if (!activityLog) return;
    activityLog.innerHTML = '';
    if (!_actEntries.length) {
        activityLog.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📡</div>No intercept activity yet. Rules will appear here when they fire.</div>';
        return;
    }
    let currentGroup = null;
    for (const e of _actEntries) {
        if (e.page !== currentGroup) {
            currentGroup = e.page;
            const hdr = document.createElement('div');
            hdr.className = 'act-group-header';
            hdr.innerHTML = `<span>📄</span><span class="act-group-url" title="${escHtml(e.page)}">${escHtml(e.page)}</span>`;
            activityLog.appendChild(hdr);
        }
        const row = document.createElement('div');
        row.className = 'act-entry';
        const icon = e.type === 'mock' ? '⚡' : e.type === 'block' ? '🚫' : '🔧';
        const typeCls = e.type === 'mock' ? 'act-type-mock' : e.type === 'block' ? 'act-type-block' : 'act-type-modify';
        let html = `<span class="act-time">${fmtTime(e.ts)}</span>` +
            `<span class="act-icon">${icon}</span>` +
            `<span class="act-rule ${typeCls}">${escHtml(e.ruleName)}</span>` +
            `<span class="act-url" title="${escHtml(e.url)}">${escHtml(e.url)}</span>`;
        if (e.detail) {
            html += `<span class="act-detail">${escHtml(e.detail)}</span>`;
        }
        if (e.bodyPreview) {
            html += `<div class="act-body">${escHtml(e.bodyPreview)}</div>`;
        }
        html += `<span class="act-links">
            <button class="act-link act-link-rule" type="button" data-rule="${escHtml(e.ruleName)}">Rule</button>
            <button class="act-link act-link-req" type="button" data-url="${escHtml(e.url)}">Request</button>
        </span>`;
        row.innerHTML = html;
        row.querySelector('.act-link-rule')?.addEventListener('click', () => {
            focusInterceptRuleByName(e.ruleName);
        });
        row.querySelector('.act-link-req')?.addEventListener('click', async () => {
            await api.openLogViewerWithUrl?.(e.url);
        });
        activityLog.appendChild(row);
    }
    activityLog.scrollTop = activityLog.scrollHeight;
}

async function focusInterceptRuleByName(ruleName) {
    const interceptTabBtn = document.querySelector('.tab-btn[data-tab="intercept"]');
    if (interceptTabBtn) interceptTabBtn.click();
    await loadInterceptRules();
    const items = [...document.querySelectorAll('#intercept-list .rule-item')];
    const target = items.find(item => {
        const nameEl = item.querySelector('.rule-name');
        return nameEl && nameEl.textContent.trim() === String(ruleName || '').trim();
    });
    if (!target) return;
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateActivityCount() {
    if (activityCount) activityCount.textContent = _actEntries.length;
}

function _onInterceptRuleMatched(info) {
    const page = extractPage(info.url);
    if (page !== _actCurrentPage) {
        _actCurrentPage = page;
    }
    _actEntries.push({
        type: info.type,
        ruleName: info.ruleName || 'Unknown',
        url: info.url || '',
        detail: info.detail || '',
        bodyPreview: info.bodyPreview || '',
        page: _actCurrentPage,
        ts: info.ts ? new Date(info.ts) : new Date(),
    });
    updateActivityCount();
    // Re-render only if Activity tab is visible
    const actTab = document.getElementById('tab-activity');
    if (actTab && actTab.classList.contains('active')) {
        renderActivity();
    }
}
api.onInterceptRuleMatched?.(_onInterceptRuleMatched);
api.onInterceptRuleMatchedBatch?.((items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    for (const info of items) _onInterceptRuleMatched(info);
});

// Show activity when switching to tab
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'activity') renderActivity();
    });
});
onClick('btn-clear-activity', () => {
    _actEntries = [];
    _actCurrentPage = null;
    updateActivityCount();
    renderActivity();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadRules();
loadInterceptRules();
