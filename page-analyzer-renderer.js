'use strict';

const api = window.electronAPI;

const tabSelect   = document.getElementById('pa-tab-select');
const autoCheck   = document.getElementById('pa-auto');
const refreshBtn  = document.getElementById('pa-refresh');
const statusEl    = document.getElementById('pa-status');
const urlEl       = document.getElementById('pa-url');
const tabsBar     = document.getElementById('pa-tabs-bar');

const badgeForms   = document.getElementById('badge-forms');
const badgeCaptcha = document.getElementById('badge-captcha');
const badgeMeta    = document.getElementById('badge-meta');
const badgeScout   = document.getElementById('badge-scout');

const panelForms   = document.getElementById('panel-forms');
const panelCaptcha = document.getElementById('panel-captcha');
const panelMeta    = document.getElementById('panel-meta');

const formsEmpty   = document.getElementById('forms-empty');
const formsList    = document.getElementById('forms-list');
const metaContent  = document.getElementById('meta-content');
const scoutHomeEl = document.getElementById('scout-home');
const scoutScriptsEl = document.getElementById('scout-scripts');
const scoutEndpointsEl = document.getElementById('scout-endpoints');
const scoutDurationEl = document.getElementById('scout-duration');
const scoutRunBtn = document.getElementById('scout-run');
const scoutCopyBtn = document.getElementById('scout-copy');
const scoutEmptyEl = document.getElementById('scout-empty');
const scoutTableEl = document.getElementById('scout-table');
const scoutTbodyEl = document.getElementById('scout-tbody');
const captchaApiKeyEl = document.getElementById('captcha-api-key');
const captchaSitekeyOverrideEl = document.getElementById('captcha-sitekey-override');
const captchaSaveKeyBtn = document.getElementById('captcha-save-key');
const captchaAutoInjectEl = document.getElementById('captcha-auto-inject');
const captchaAutoSubmitEl = document.getElementById('captcha-auto-submit');
const captchaSolveBtn = document.getElementById('captcha-solve-turnstile');
const captchaRetryBtn = document.getElementById('captcha-retry-last');
const captchaSolverStatusEl = document.getElementById('captcha-solver-status');

let _activePanel = 'forms';
let _selectedTabId = null;
let _tabsList = [];
let _lastForms = [];
let _lastCaptcha = {};
let _lastMeta = {};
let _lastScout = {};
let _autoRefreshTimer = null;
let _analysisInFlight = false;
let _inlineEditCount = 0;
const _formsOpenState = new Set();
const _fieldExpandState = new Set();
let _capmonsterSettings = {
    apiKey: '',
    autoInject: true,
    autoSubmit: false,
};
let _lastTurnstileSolvePayload = null;

// ── Tab panel switching ──
for (const btn of tabsBar.querySelectorAll('.atab')) {
    btn.addEventListener('click', () => {
        _activePanel = btn.dataset.panel;
        tabsBar.querySelectorAll('.atab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        document.getElementById('panel-' + _activePanel)?.classList.add('active');
    });
}

// ── Tab selector ──
function populateTabSelect(tabs) {
    _tabsList = tabs || [];
    const prev = _selectedTabId;
    tabSelect.innerHTML = '';

    const optCur = document.createElement('option');
    optCur.value = '__current__';
    optCur.textContent = '🔵 Current Page';
    tabSelect.appendChild(optCur);

    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '────────────';
    tabSelect.appendChild(sep);

    for (const t of _tabsList) {
        const o = document.createElement('option');
        o.value = t.id;
        const icon = t.direct ? '⊘' : t.isolated ? '🍪' : '🌐';
        o.textContent = `#${t.num} ${icon} ${(t.title || t.url || 'New Tab').substring(0, 50)}`;
        if (t.isActive) o.textContent += ' ◀';
        tabSelect.appendChild(o);
    }

    if (prev && _tabsList.find(t => String(t.id) === String(prev))) {
        tabSelect.value = prev;
    } else {
        tabSelect.value = '__current__';
    }
}

function getSelectedTabId() {
    const v = tabSelect.value;
    if (v === '__current__') {
        const active = _tabsList.find(t => t.isActive);
        return active ? active.id : null;
    }
    return v || null;
}

tabSelect.addEventListener('change', () => {
    _selectedTabId = tabSelect.value;
    if (autoCheck.checked) runAnalysis();
});
autoCheck.addEventListener('change', () => {
    setupAutoRefresh();
    if (autoCheck.checked) runAnalysis();
});

// ── Refresh ──
refreshBtn.addEventListener('click', () => runAnalysis({ force: true, includeScout: false }));

// ── Analysis ──
async function runAnalysis(opts = {}) {
    const includeScout = opts.includeScout === true;
    const force = opts.force === true;
    if (!force && _inlineEditCount > 0) return;
    if (_analysisInFlight) return;
    const tabId = getSelectedTabId();
    if (!tabId) {
        statusEl.textContent = 'No tab selected';
        return;
    }

    const tab = _tabsList.find(t => String(t.id) === String(tabId));
    urlEl.textContent = tab ? (tab.url || '') : '';
    statusEl.textContent = 'Analyzing…';
    _analysisInFlight = true;

    try {
        const jobs = [
            api.analyzePageForms(tabId),
            api.analyzePageCaptcha(tabId),
            api.analyzePageMeta(tabId),
        ];
        if (includeScout) jobs.push(api.analyzePageEndpoints(tabId));
        const result = await Promise.all(jobs);
        const forms = result[0];
        const captcha = result[1];
        const meta = result[2];
        const scout = includeScout ? result[3] : null;

        _lastForms = forms || [];
        _lastCaptcha = captcha || {};
        _lastMeta = meta || {};
        if (includeScout) _lastScout = scout || {};

        renderForms(_lastForms, tabId);
        renderCaptcha(_lastCaptcha);
        renderMeta(_lastMeta);
        if (includeScout) renderScout(_lastScout);
        updateBadges();

        statusEl.textContent = includeScout
            ? `Analyzed · ${_lastForms.length} form(s), ${(_lastScout.endpoints || []).length} endpoint(s)`
            : `Analyzed · ${_lastForms.length} form(s)`;
    } catch (err) {
        statusEl.textContent = 'Error: ' + (err.message || err);
    } finally {
        _analysisInFlight = false;
    }
}

function setupAutoRefresh() {
    if (_autoRefreshTimer) {
        clearInterval(_autoRefreshTimer);
        _autoRefreshTimer = null;
    }
    if (!autoCheck.checked) return;
    _autoRefreshTimer = setInterval(() => {
        runAnalysis({ includeScout: false, force: false });
    }, 3000);
}

function updateBadges() {
    const fc = _lastForms.length;
    badgeForms.textContent = fc;
    badgeForms.classList.toggle('has-items', fc > 0);

    const cc = _lastCaptcha.totalCount || 0;
    badgeCaptcha.textContent = cc;
    badgeCaptcha.classList.toggle('has-items', cc > 0);

    const mc = (_lastMeta.meta || []).length;
    badgeMeta.textContent = mc || '—';

    const sc = (_lastScout.endpoints || []).length;
    badgeScout.textContent = sc;
    badgeScout.classList.toggle('has-items', sc > 0);
}

function setCaptchaSolveStatus(text, tone = 'neutral') {
    if (!captchaSolverStatusEl) return;
    captchaSolverStatusEl.textContent = text || 'Idle';
    captchaSolverStatusEl.classList.remove('ok', 'err');
    if (tone === 'ok') captchaSolverStatusEl.classList.add('ok');
    if (tone === 'err') captchaSolverStatusEl.classList.add('err');
}

function syncCapmonsterSettingsToUi() {
    if (captchaApiKeyEl) captchaApiKeyEl.value = _capmonsterSettings.apiKey || '';
    if (captchaAutoInjectEl) captchaAutoInjectEl.checked = _capmonsterSettings.autoInject !== false;
    if (captchaAutoSubmitEl) captchaAutoSubmitEl.checked = _capmonsterSettings.autoSubmit === true;
}

async function persistCapmonsterSettingsFromUi() {
    const next = {
        apiKey: String(captchaApiKeyEl?.value || '').trim(),
        autoInject: !!captchaAutoInjectEl?.checked,
        autoSubmit: !!captchaAutoSubmitEl?.checked,
    };
    _capmonsterSettings = await api.saveCapmonsterSettings(next);
    syncCapmonsterSettingsToUi();
    return _capmonsterSettings;
}

function pickTurnstileForSolve() {
    const list = _lastCaptcha?.turnstile || [];
    if (!list.length) return null;
    const withSitekey = list.find(x => x && x.sitekey);
    if (withSitekey) return withSitekey;
    const first = list[0];
    if (!first) return null;
    const iframeSrc = String(first.iframeSrc || '');
    let sitekey = '';
    try {
        if (iframeSrc) {
            const u = new URL(iframeSrc);
            sitekey = String(u.searchParams.get('k') || u.searchParams.get('sitekey') || u.searchParams.get('render') || '');
        }
    } catch {}
    return { ...first, sitekey };
}

function resolveTurnstileSitekeyOverride() {
    const v = String(captchaSitekeyOverrideEl?.value || '').trim();
    return v || '';
}

async function solveTurnstileCaptchaFlow(retry = false) {
    const tabId = getSelectedTabId();
    if (!tabId) {
        setCaptchaSolveStatus('No target tab selected.', 'err');
        return;
    }
    const item = retry ? _lastTurnstileSolvePayload : pickTurnstileForSolve();
    if (!item) {
        setCaptchaSolveStatus('Turnstile not detected on current page.', 'err');
        return;
    }
    const sitekeyOverride = resolveTurnstileSitekeyOverride();
    let runOptions = null;
    try {
        runOptions = await persistCapmonsterSettingsFromUi();
    } catch (e) {
        setCaptchaSolveStatus(`Settings save failed: ${e?.message || e}`, 'err');
        return;
    }
    if (!runOptions.apiKey) {
        setCaptchaSolveStatus('CapMonster API key is required.', 'err');
        return;
    }
    const tab = _tabsList.find(t => String(t.id) === String(tabId));
    const payload = {
        ...item,
        sitekey: sitekeyOverride || item.sitekey || '',
        pageUrl: item.pageUrl || _lastCaptcha?.pageUrl || tab?.url || '',
    };
    if (!payload.sitekey) {
        setCaptchaSolveStatus('Sitekey not found. Paste it into "Sitekey override" and retry.', 'err');
        if (captchaRetryBtn) captchaRetryBtn.disabled = false;
        return;
    }
    _lastTurnstileSolvePayload = payload;
    if (captchaRetryBtn) captchaRetryBtn.disabled = false;
    const started = Date.now();
    setCaptchaSolveStatus('detected -> solving', 'neutral');
    if (captchaSolveBtn) captchaSolveBtn.disabled = true;
    try {
        const result = await api.solveTurnstileCaptcha(tabId, payload, runOptions);
        if (!result?.ok) {
            const err = result?.error || {};
            setCaptchaSolveStatus(`solve failed: ${err.message || err.code || 'unknown error'}`, 'err');
            return;
        }
        const elapsed = Math.round((Date.now() - started) / 1000);
        const inj = result.inject || {};
        if (inj.injected) {
            const post = inj.submitted ? 'injected + submitted' : 'injected';
            const cb = Number(inj.callbacksInvoked || 0);
            const cbTail = cb > 0 ? `, callbacks:${cb}` : '';
            setCaptchaSolveStatus(`token received -> ${post}${cbTail} (${elapsed}s)`, 'ok');
        } else {
            setCaptchaSolveStatus(`token received, inject skipped (${inj.reason || 'auto-inject off'}, ${elapsed}s)`, 'ok');
        }
        statusEl.textContent = 'Turnstile token solved';
        setTimeout(() => { statusEl.textContent = 'Ready'; }, 1800);
    } catch (e) {
        setCaptchaSolveStatus(`solve failed: ${e?.message || e}`, 'err');
    } finally {
        if (captchaSolveBtn) captchaSolveBtn.disabled = false;
    }
}

// ── Render forms ──
function renderForms(forms, tabId) {
    formsList.innerHTML = '';
    formsEmpty.style.display = forms.length ? 'none' : '';

    for (const form of forms) {
        const card = document.createElement('div');
        card.className = 'form-card';

        const hiddenCount = form.fields.filter(f => f.hidden).length;
        const readonlyCount = form.fields.filter(f => f.readonly).length;

        const formKey = `f:${form.index}`;
        const header = document.createElement('div');
        header.className = 'form-header';
        header.innerHTML = `
            <div class="form-num">${form.index + 1}</div>
            <div class="form-info">
                <div class="form-name">${esc(form.id || form.name || `Form #${form.index + 1}`)}</div>
                <div class="form-meta">${esc(form.action || '—')} · ${form.fields.length} fields</div>
            </div>
            <div class="form-badges">
                <span class="fbadge fbadge-method">${form.method}</span>
                ${hiddenCount ? `<span class="fbadge fbadge-hidden">${hiddenCount} hidden</span>` : ''}
                ${readonlyCount ? `<span class="fbadge fbadge-readonly">${readonlyCount} readonly</span>` : ''}
            </div>
            <div class="form-actions">
                <button class="btn btn-sm pa-copy-form" data-form-index="${form.index}" title="Copy form data as JSON object">⎘ Copy as Object</button>
            </div>
        `;

        const body = document.createElement('div');
        body.className = 'form-body';
        body.style.display = _formsOpenState.has(formKey) ? '' : 'none';

        header.addEventListener('click', (e) => {
            if (e.target.closest('.pa-copy-form')) return;
            body.style.display = body.style.display === 'none' ? '' : 'none';
            if (body.style.display === 'none') _formsOpenState.delete(formKey);
            else _formsOpenState.add(formKey);
        });

        header.querySelector('.pa-copy-form')?.addEventListener('click', () => {
            copyFormAsObject(form);
        });

        if (form.fields.length) {
            const table = document.createElement('table');
            table.className = 'fields-table';
            table.innerHTML = `<thead><tr>
                <th style="width:30px">#</th>
                <th>Name</th>
                <th>Type</th>
                <th>Value</th>
                <th>Tags</th>
                <th style="width:170px">Actions</th>
            </tr></thead>`;
            const tbody = document.createElement('tbody');

            for (const field of form.fields) {
                const tr = document.createElement('tr');
                if (field.hidden) tr.className = 'field-hidden';
                else if (field.readonly) tr.className = 'field-readonly';
                if (field.disabled) tr.classList.add('field-disabled');

                const typeClass = field.hidden ? 'type-hidden' :
                    field.type === 'password' ? 'type-password' :
                    field.type === 'submit' ? 'type-submit' :
                    field.tag === 'select' ? 'type-select' : '';

                let tags = '';
                if (field.hidden)   tags += '<span class="ftag ftag-hidden">hidden</span>';
                if (field.readonly) tags += '<span class="ftag ftag-readonly">readonly</span>';
                if (field.disabled) tags += '<span class="ftag ftag-disabled">disabled</span>';
                if (field.required) tags += '<span class="ftag ftag-required">required</span>';
                if (!field.visible && !field.hidden) tags += '<span class="ftag ftag-invisible">invisible</span>';

                let rawValue = field.value || '';
                if (field.tag === 'select' && field.options?.length) {
                    const sel = field.options.find(o => o.selected);
                    rawValue = sel ? `${sel.text} (${sel.value})` : (field.value || '');
                }
                const isLong = rawValue.length > 80;
                const displayValue = isLong ? `[${rawValue.length} chars]` : rawValue;
                const fieldKey = `f:${form.index}:fld:${field.index}`;
                const fvId = `fv-${form.index}-${field.index}`;
                const isExpandedNow = _fieldExpandState.has(fieldKey);
                const inputType = (field.type || '').toLowerCase();
                const canInlineEdit = inputType !== 'file' && inputType !== 'submit' && inputType !== 'button' && inputType !== 'image' && inputType !== 'reset';

                tr.innerHTML = `
                    <td style="color:var(--dim)">${field.index}</td>
                    <td><span class="field-name">${esc(field.name || field.id || '—')}</span></td>
                    <td><span class="field-type ${typeClass}">${esc(field.type || field.tag)}</span></td>
                    <td>
                        <div class="field-value-wrap${isExpandedNow ? ' expanded' : ''}" id="${fvId}" data-field-key="${fieldKey}">
                            <span class="field-value" data-raw="${esc(rawValue)}">${esc(isExpandedNow ? rawValue : displayValue)}</span>${(canInlineEdit || rawValue || isLong) ? `<span class="fv-btns">${canInlineEdit ? `<button class="fv-btn fv-edit" data-fi="${form.index}" data-fld="${field.index}" title="Edit value">✎</button>` : ''}${isLong ? `<button class="fv-btn fv-expand" title="${isExpandedNow ? 'Collapse' : 'Expand'}">${isExpandedNow ? '⤡' : '⤢'}</button>` : ''}${rawValue ? '<button class="fv-btn fv-copy" title="Copy value">⎘</button>' : ''}</span>` : ''}
                        </div>
                    </td>
                    <td><div class="field-tags">${tags || '<span style="color:var(--dim)">—</span>'}</div></td>
                    <td>
                        <div class="field-actions">
                            <button class="field-action-btn" data-act="focus" data-fi="${form.index}" data-fld="${field.index}" title="Focus this field">Focus</button>
                            <button class="field-action-btn" data-act="${field.hidden || !field.visible ? 'show' : 'hide'}" data-fi="${form.index}" data-fld="${field.index}" title="${field.hidden || !field.visible ? 'Reveal hidden field' : 'Hide field'}">${field.hidden || !field.visible ? 'Show' : 'Hide'}</button>
                            <button class="field-action-btn" data-act="toggle-disabled" data-fi="${form.index}" data-fld="${field.index}" title="Toggle disabled">${field.disabled ? 'Enable' : 'Disable'}</button>
                            ${field.type === 'password' ? `<button class="field-action-btn" data-act="toggle-password-visibility" data-fi="${form.index}" data-fld="${field.index}" title="Toggle password visibility">Show pass</button>` : ''}
                        </div>
                    </td>
                `;
                tr._rawValue = rawValue;
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            body.appendChild(table);
        }

        card.appendChild(header);
        card.appendChild(body);
        formsList.appendChild(card);
    }

    const openInlineEditor = (row, fi, fld, triggerBtn) => {
        const wrap = row?.querySelector('.field-value-wrap');
        const valEl = wrap?.querySelector('.field-value');
        const oldVal = (valEl?.dataset?.raw ?? '').toString();
        if (!wrap) return;
        if (wrap.querySelector('.pa-inline-edit-wrap')) return;

        const editor = document.createElement('span');
        editor.className = 'pa-inline-edit-wrap';
        editor.style.display = 'inline-flex';
        editor.style.gap = '4px';
        editor.style.marginLeft = '6px';
        editor.style.verticalAlign = 'middle';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldVal;
        input.className = 'pa-inline-input';
        input.style.background = 'var(--bg3)';
        input.style.border = '1px solid var(--accent)';
        input.style.color = 'var(--hi)';
        input.style.borderRadius = '4px';
        input.style.padding = '1px 5px';
        input.style.fontSize = '11px';
        input.style.minWidth = '140px';
        input.style.maxWidth = '280px';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.className = 'field-action-btn';
        saveBtn.style.borderColor = 'var(--green)';
        saveBtn.style.color = 'var(--green)';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'field-action-btn';

        const cleanup = () => {
            editor.remove();
            if (triggerBtn) {
                triggerBtn.disabled = false;
                if (triggerBtn.classList.contains('fv-edit')) triggerBtn.textContent = '✎';
                else triggerBtn.textContent = '✎ Edit';
            }
            _inlineEditCount = Math.max(0, _inlineEditCount - 1);
        };

        const doSave = () => {
            const nextVal = input.value;
            saveBtn.disabled = true;
            cancelBtn.disabled = true;
            api.pageAnalyzerAction(tabId, { type: 'set-value', formIndex: fi, fieldIndex: fld, value: nextVal }).then((ok) => {
                if (!ok) return;
                if (valEl) {
                    valEl.dataset.raw = nextVal;
                    valEl.textContent = nextVal.length > 80 ? `[${nextVal.length} chars]` : nextVal;
                }
                setTimeout(() => runAnalysis({ includeScout: false }), 120);
            }).finally(() => cleanup());
        };

        saveBtn.addEventListener('click', doSave);
        cancelBtn.addEventListener('click', cleanup);
        input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') { ke.preventDefault(); doSave(); }
            if (ke.key === 'Escape') { ke.preventDefault(); cleanup(); }
        });

        editor.appendChild(input);
        editor.appendChild(saveBtn);
        editor.appendChild(cancelBtn);
        wrap.appendChild(editor);
        if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.textContent = triggerBtn.classList.contains('fv-edit') ? '…' : 'Editing...';
        }
        _inlineEditCount++;
        input.focus();
        input.select();
    };

    formsList.onclick = (e) => {
        // expand/collapse value
        const expandBtn = e.target.closest('.fv-expand');
        if (expandBtn) {
            const wrap = expandBtn.closest('.field-value-wrap');
            if (wrap) {
                const isExpanded = wrap.classList.toggle('expanded');
                expandBtn.textContent = isExpanded ? '⤡' : '⤢';
                expandBtn.title = isExpanded ? 'Collapse' : 'Expand';
                const valEl = wrap.querySelector('.field-value');
                const fk = wrap.dataset.fieldKey || '';
                if (fk) {
                    if (isExpanded) _fieldExpandState.add(fk);
                    else _fieldExpandState.delete(fk);
                }
                if (valEl) {
                    const raw = valEl.dataset.raw || '';
                    valEl.textContent = isExpanded ? raw : `[${raw.length} chars]`;
                }
            }
            return;
        }

        // copy value
        const copyBtn = e.target.closest('.fv-copy');
        if (copyBtn) {
            const wrap = copyBtn.closest('.field-value-wrap');
            const valEl = wrap?.querySelector('.field-value');
            if (valEl) {
                navigator.clipboard.writeText(valEl.dataset.raw || valEl.textContent).then(() => {
                    copyBtn.textContent = '✓';
                    setTimeout(() => { copyBtn.textContent = '⎘'; }, 1200);
                });
            }
            return;
        }

        // inline value edit from value cell icon
        const editBtnInline = e.target.closest('.fv-edit');
        if (editBtnInline) {
            const fi = parseInt(editBtnInline.dataset.fi || '', 10);
            const fld = parseInt(editBtnInline.dataset.fld || '', 10);
            if (!Number.isNaN(fi) && !Number.isNaN(fld)) {
                openInlineEditor(editBtnInline.closest('tr'), fi, fld, editBtnInline);
            }
            return;
        }

        // field action buttons
        const btn = e.target.closest('.field-action-btn');
        if (!btn) return;
        const act = btn.dataset.act;
        const fi  = parseInt(btn.dataset.fi, 10);
        const fld = parseInt(btn.dataset.fld, 10);
        if (act === 'edit-value') {
            openInlineEditor(btn.closest('tr'), fi, fld, btn);
            return;
        }
        api.pageAnalyzerAction(tabId, { type: act, formIndex: fi, fieldIndex: fld });
        if (act === 'show') {
            btn.textContent = 'Hide';
            btn.dataset.act = 'hide';
        } else if (act === 'hide') {
            btn.textContent = 'Show';
            btn.dataset.act = 'show';
        } else if (act === 'toggle-disabled') {
            btn.textContent = btn.textContent === 'Enable' ? 'Disable' : 'Enable';
        } else if (act === 'toggle-password-visibility') {
            setTimeout(() => runAnalysis({ includeScout: false, force: true }), 120);
        }
    };
}

function copyFormAsObject(form) {
    const obj = {};
    if (form.action) obj._action = form.action;
    if (form.method) obj._method = form.method;
    for (const f of form.fields) {
        const key = f.name || f.id || `field_${f.index}`;
        if (f.tag === 'select' && f.options) {
            const sel = f.options.find(o => o.selected);
            obj[key] = sel ? sel.value : (f.value || '');
        } else {
            obj[key] = f.value || '';
        }
    }
    navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).then(() => {
        statusEl.textContent = '✓ Copied form as JSON';
        setTimeout(() => { statusEl.textContent = 'Ready'; }, 2000);
    });
}

// ── Render captcha ──
const captchaSections = document.getElementById('captcha-sections');

function renderCaptcha(data) {
    captchaSections.innerHTML = '';

    const types = [
        { key: 'recaptcha', icon: '🔵', title: 'reCAPTCHA', items: data.recaptcha || [] },
        { key: 'hcaptcha',  icon: '🟡', title: 'hCaptcha',  items: data.hcaptcha || [] },
        { key: 'turnstile', icon: '🟣', title: 'Turnstile',  items: data.turnstile || [] },
        { key: 'other',     icon: '⚪', title: 'Other',      items: data.other || [], note: 'in development' },
    ];

    for (const t of types) {
        const sec = document.createElement('div');
        sec.className = 'captcha-section';

        const hasItems = t.items.length > 0;
        const badgeCls = hasItems ? 'found' : 'empty';

        let headerHTML = `<div class="captcha-section-header">
            <span class="captcha-section-icon">${t.icon}</span>
            <span class="captcha-section-title">${t.title}</span>
            <span class="captcha-section-badge ${badgeCls}">${t.items.length}</span>
            ${t.note ? `<span class="captcha-section-note">${esc(t.note)}</span>` : ''}
        </div>`;

        sec.innerHTML = headerHTML;

        if (hasItems) {
            for (const item of t.items) {
                const itemEl = document.createElement('div');
                itemEl.className = 'captcha-item';

                let paramsHTML = '';
                const params = _getCaptchaParams(t.key, item, data.pageUrl);
                for (const [pk, pv] of params) {
                    if (!pv) continue;
                    paramsHTML += `<span class="captcha-param-key">${esc(pk)}</span>
                        <span class="captcha-param-val" title="Click to copy" data-copy="${esc(pv)}">${esc(pv)}</span>`;
                }

                const via = item.iframe ? 'iframe' : (item.selector || 'DOM');
                const verLabel = item.version ? ` ${item.version}` : '';

                itemEl.innerHTML = `
                    <div class="captcha-item-header">
                        <span class="captcha-item-type">${t.title}${esc(verLabel)}</span>
                        <span class="captcha-via">${esc(via)}</span>
                    </div>
                    <div class="captcha-params">${paramsHTML}</div>
                    <div class="captcha-copy-row">
                        <button class="btn btn-sm captcha-copy-all" data-captcha-type="${t.key}" data-captcha-idx="${t.items.indexOf(item)}">⎘ Copy All Params</button>
                    </div>
                `;
                sec.appendChild(itemEl);
            }
        } else {
            sec.innerHTML += `<div class="captcha-no-items">Not detected on this page</div>`;
        }

        captchaSections.appendChild(sec);
    }

    captchaSections.addEventListener('click', (e) => {
        const valEl = e.target.closest('.captcha-param-val');
        if (valEl) {
            navigator.clipboard.writeText(valEl.dataset.copy || valEl.textContent).then(() => {
                const orig = valEl.textContent;
                valEl.textContent = '✓ copied';
                setTimeout(() => { valEl.textContent = orig; }, 1200);
            });
            return;
        }
        const copyAllBtn = e.target.closest('.captcha-copy-all');
        if (copyAllBtn) {
            const key = copyAllBtn.dataset.captchaType;
            const idx = parseInt(copyAllBtn.dataset.captchaIdx, 10);
            const items = (key === 'recaptcha' ? data.recaptcha : key === 'hcaptcha' ? data.hcaptcha : key === 'turnstile' ? data.turnstile : data.other) || [];
            const item = items[idx];
            if (item) {
                const obj = { type: key };
                const params = _getCaptchaParams(key, item, data.pageUrl);
                for (const [pk, pv] of params) { if (pv) obj[pk] = pv; }
                navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).then(() => {
                    copyAllBtn.textContent = '✓ Copied';
                    setTimeout(() => { copyAllBtn.textContent = '⎘ Copy All Params'; }, 1500);
                });
            }
        }
    });
}

function _getCaptchaParams(type, item, pageUrl) {
    const params = [];
    if (pageUrl) params.push(['pageUrl', pageUrl]);
    if (item.sitekey) params.push(['sitekey', item.sitekey]);
    if (type === 'recaptcha') {
        if (item.version)  params.push(['version', item.version]);
        if (item.action)   params.push(['action', item.action]);
        if (item.dataS)    params.push(['data-s', item.dataS]);
        if (item.callback) params.push(['callback', item.callback]);
        if (item.theme)    params.push(['theme', item.theme]);
        if (item.size)     params.push(['size', item.size]);
    } else if (type === 'hcaptcha') {
        if (item.theme) params.push(['theme', item.theme]);
        if (item.size)  params.push(['size', item.size]);
    } else if (type === 'turnstile') {
        if (item.action) params.push(['action', item.action]);
        if (item.cData)  params.push(['cData', item.cData]);
        if (item.theme)  params.push(['theme', item.theme]);
        if (item.size)   params.push(['size', item.size]);
    }
    if (item.iframeSrc) params.push(['iframeSrc', item.iframeSrc]);
    if (item.selector && item.selector !== 'iframe') params.push(['selector', item.selector]);
    return params;
}

// ── Render meta ──
function renderMeta(data) {
    metaContent.innerHTML = '';
    if (!data.title && !data.url) return;

    const sections = [
        { title: 'Page', rows: [
            ['Title', data.title],
            ['URL', data.url],
            ['Charset', data.charset],
            ['Doctype', data.doctype],
        ]},
        { title: `Meta Tags (${(data.meta||[]).length})`, rows: (data.meta||[]).map(m => [m.name, m.content]) },
        { title: `Scripts (${(data.scripts?.external||0) + (data.scripts?.inline||0)})`, rows: [
            ['Inline', data.scripts?.inline],
            ['External', data.scripts?.external],
            ...(data.scripts?.srcs||[]).slice(0, 20).map((s, i) => [`  src[${i}]`, s]),
        ]},
        { title: `Iframes (${(data.iframes||[]).length})`, rows: (data.iframes||[]).map(f => [f.id || f.name || '(anon)', f.src]) },
    ];

    for (const sec of sections) {
        if (!sec.rows.length) continue;
        const div = document.createElement('div');
        div.className = 'meta-section';
        div.innerHTML = `<div class="meta-section-title">${esc(sec.title)}</div>`;
        for (const [k, v] of sec.rows) {
            if (v === undefined || v === null || v === '') continue;
            const row = document.createElement('div');
            row.className = 'meta-row';
            row.innerHTML = `<span class="meta-key">${esc(String(k))}</span><span class="meta-val">${esc(String(v))}</span>`;
            div.appendChild(row);
        }
        if (div.querySelectorAll('.meta-row').length) metaContent.appendChild(div);
    }
}

function classifyEndpoint(ep) {
    const s = String(ep || '').toLowerCase();
    if (s.includes('/auth') || s.includes('/signin') || s.includes('/signup') || s.includes('/login')) return 'auth';
    if (s.includes('/otp') || s.includes('verifyotp') || s.includes('phone-otp')) return 'otp';
    if (s.includes('/slot') || s.includes('/appointment') || s.includes('/reserve')) return 'booking';
    if (s.includes('/payment') || s.includes('/invoice') || s.includes('/tran_')) return 'payment';
    if (s.includes('/profile') || s.includes('/user')) return 'profile';
    if (s.startsWith('/')) return 'api-path';
    return 'other';
}

function renderScout(data) {
    const d = data || {};
    const eps = d.endpointsDetailed || (d.endpoints || []).map(p => ({ path: p, sources: [] }));

    const statusTxt = d.statusHint === 'challenge' ? 'challenge' : 'ok';
    scoutHomeEl.textContent = `status: ${statusTxt}`;
    scoutScriptsEl.textContent = `scripts: ${(d.scriptUrls || []).length}`;
    scoutEndpointsEl.textContent = `endpoints: ${eps.length}`;
    scoutDurationEl.textContent = `duration: ${Math.round((d.durationMs || 0) / 1000)}s`;

    if (!eps.length) {
        scoutTableEl.style.display = 'none';
        scoutEmptyEl.style.display = '';
        scoutTbodyEl.innerHTML = '';
        return;
    }
    scoutEmptyEl.style.display = 'none';
    scoutTableEl.style.display = '';
    scoutTbodyEl.innerHTML = eps.map(item => {
        const ep = item.path || '';
        const cat = classifyEndpoint(ep);
        const hits = item.hits || [];
        const bestHit = hits.find(h => (h && h.preview && h.preview !== ''))
            || hits.find(h => (h && h.line && h.line > 0))
            || hits[0]
            || null;
        const hit = bestHit;
        const methods = (item.methods || []).join(', ') || '-';
        const shape = (item.payloadKeys || []).join(', ') || '-';
        const src = hit?.source || ((item.sources || [])[0] || '-');
        const line = hit?.line ? String(hit.line) : ((item.sources || []).length ? '1' : '-');
        const preview = hit?.preview || ((item.sources || []).length
            ? 'Matched by global scan in minified bundle; exact line is approximate.'
            : '-');
        return `<tr>
            <td class="ep-path" title="${esc(ep)}">${esc(ep)}</td>
            <td><span class="ep-cat">${cat}</span></td>
            <td>${esc(methods)}</td>
            <td title="${esc(shape)}">${esc(shape)}</td>
            <td title="${esc(src)}">${esc(src)}</td>
            <td>${esc(line)}</td>
            <td title="${esc(preview)}">${esc(preview)}</td>
        </tr>`;
    }).join('');
}

// ── Helpers ──
function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── IPC: receive tabs list ──
api.onAnalyzerTabsList?.((tabs) => {
    populateTabSelect(tabs);
    if (autoCheck.checked) runAnalysis({ includeScout: false });
});

api.onAnalyzerTabsUpdated?.((tabs) => {
    populateTabSelect(tabs);
});

scoutRunBtn?.addEventListener('click', () => {
    _activePanel = 'scout';
    tabsBar.querySelectorAll('.atab').forEach(b => b.classList.remove('active'));
    document.querySelector('.atab[data-panel="scout"]')?.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-scout')?.classList.add('active');
    runAnalysis({ includeScout: true });
});
scoutCopyBtn?.addEventListener('click', () => {
    const eps = (_lastScout.endpoints || []).join('\n');
    navigator.clipboard.writeText(eps).then(() => {
        statusEl.textContent = `✓ Copied ${(_lastScout.endpoints || []).length} endpoints`;
        setTimeout(() => { statusEl.textContent = 'Ready'; }, 1800);
    }).catch(() => {});
});

captchaSaveKeyBtn?.addEventListener('click', async () => {
    try {
        await persistCapmonsterSettingsFromUi();
        setCaptchaSolveStatus('Settings saved.', 'ok');
    } catch (e) {
        setCaptchaSolveStatus(`Settings save failed: ${e?.message || e}`, 'err');
    }
});
captchaAutoInjectEl?.addEventListener('change', () => { persistCapmonsterSettingsFromUi().catch(() => {}); });
captchaAutoSubmitEl?.addEventListener('change', () => { persistCapmonsterSettingsFromUi().catch(() => {}); });
captchaSolveBtn?.addEventListener('click', () => solveTurnstileCaptchaFlow(false));
captchaRetryBtn?.addEventListener('click', () => solveTurnstileCaptchaFlow(true));

// Initial load
Promise.all([
    api.getTabs?.(),
    api.getCapmonsterSettings?.().catch(() => null),
]).then(([tabs, capmonster]) => {
    if (capmonster && typeof capmonster === 'object') {
        _capmonsterSettings = { ..._capmonsterSettings, ...capmonster };
    }
    syncCapmonsterSettingsToUi();
    setCaptchaSolveStatus('Idle');
    populateTabSelect(tabs);
    setupAutoRefresh();
    if (autoCheck.checked) setTimeout(() => runAnalysis({ includeScout: false }), 300);
}).catch(() => {});

window.addEventListener('beforeunload', () => {
    if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
});
