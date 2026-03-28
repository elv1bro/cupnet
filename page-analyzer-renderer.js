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
const badgeStorage = document.getElementById('badge-storage');
const badgeScout   = document.getElementById('badge-scout');

const panelForms   = document.getElementById('panel-forms');

const formsEmpty   = document.getElementById('forms-empty');
const formsList    = document.getElementById('forms-list');
const metaContent  = document.getElementById('meta-content');
const storageContent = document.getElementById('storage-content');
const scoutHomeEl = document.getElementById('scout-home');
const scoutScriptsEl = document.getElementById('scout-scripts');
const scoutEndpointsEl = document.getElementById('scout-endpoints');
const scoutDurationEl = document.getElementById('scout-duration');
const scoutRunBtn = document.getElementById('scout-run');
const scoutCopyBtn = document.getElementById('scout-copy');
const scoutEmptyEl = document.getElementById('scout-empty');
const scoutTableEl = document.getElementById('scout-table');
const scoutTbodyEl = document.getElementById('scout-tbody');

let _activePanel = 'forms';
let _selectedTabId = null;
let _tabsList = [];
let _lastForms = [];
let _lastCaptcha = {};
let _lastMeta = {};
let _lastStorage = { sessionStorage: {}, localStorage: {} };
/** Раскрытые узлы дерева (ключи включают session | local). */
const _storageOpenPaths = { session: new Set(), local: new Set() };
let _storageStoreBlockOpen = { session: true, local: false };
/** 'session' | 'local' — показываем лоадер на блоке до конца записи и повторного чтения */
let _storageApplyLoading = null;
let _lastScout = {};
let _autoRefreshTimer = null;
let _analysisInFlight = false;
let _inlineEditCount = 0;
/** Фокус в textarea Web Storage — не дергать авто-анализ (иначе сброс текста и потеря фокуса). */
let _storageEditorActiveCount = 0;
function bindStorageEditorPause(host) {
    host.addEventListener('focusin', (e) => {
        const t = e.target;
        if (t && t.classList?.contains('st-store-json-edit')) {
            _storageEditorActiveCount++;
        }
    });
    host.addEventListener('focusout', (e) => {
        const t = e.target;
        if (t && t.classList?.contains('st-store-json-edit')) {
            _storageEditorActiveCount = Math.max(0, _storageEditorActiveCount - 1);
        }
    });
}
bindStorageEditorPause(storageContent);
const _formsOpenState = new Set();
const _fieldExpandState = new Set();

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
        const icon = t.isolated ? '🍪' : '🌐';
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
    if (!force && (_inlineEditCount > 0 || _storageEditorActiveCount > 0)) return;
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
            api.analyzePageStorage(tabId),
        ];
        if (includeScout) jobs.push(api.analyzePageEndpoints(tabId));
        const result = await Promise.all(jobs);
        const forms = result[0];
        const captcha = result[1];
        const meta = result[2];
        const storage = result[3] || { sessionStorage: {}, localStorage: {} };
        const scout = includeScout ? result[4] : null;

        _lastForms = forms || [];
        _lastCaptcha = captcha || {};
        _lastMeta = meta || {};
        _lastStorage = storage || { sessionStorage: {}, localStorage: {} };
        if (includeScout) _lastScout = scout || {};

        renderForms(_lastForms, tabId);
        renderCaptcha(_lastCaptcha);
        renderMeta(_lastMeta);
        renderStorage();
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

    const ss = _lastStorage?.sessionStorage || {};
    const ls = _lastStorage?.localStorage || {};
    const stc = Object.keys(ss).length + Object.keys(ls).length;
    badgeStorage.textContent = stc;
    badgeStorage.classList.toggle('has-items', stc > 0);

    const sc = (_lastScout.endpoints || []).length;
    badgeScout.textContent = sc;
    badgeScout.classList.toggle('has-items', sc > 0);
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

// ── Render captcha (detection only, no solver) ──
const captchaSections = document.getElementById('captcha-sections');

function renderCaptcha(data) {
    if (!captchaSections) return;
    captchaSections.innerHTML = '';

    const types = [
        { key: 'recaptcha', icon: '🔵', title: 'reCAPTCHA', items: data.recaptcha || [] },
        { key: 'hcaptcha',  icon: '🟡', title: 'hCaptcha',  items: data.hcaptcha || [] },
        { key: 'turnstile', icon: '🟣', title: 'Turnstile',  items: data.turnstile || [] },
        { key: 'geetest',   icon: '🟠', title: 'GeeTest',   items: data.geetest || [] },
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

    captchaSections.onclick = (e) => {
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
            const items = (key === 'recaptcha' ? data.recaptcha : key === 'hcaptcha' ? data.hcaptcha : key === 'turnstile' ? data.turnstile : key === 'geetest' ? data.geetest : data.other) || [];
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
    };
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
    } else if (type === 'geetest') {
        if (item.gt) params.push(['gt', item.gt]);
        if (item.challenge) params.push(['challenge', item.challenge]);
        if (item.apiServer) params.push(['apiServer', item.apiServer]);
        if (item.version) params.push(['version', item.version]);
        if (item.scriptSrc) params.push(['scriptSrc', item.scriptSrc]);
    }
    if (item.iframeSrc) params.push(['iframeSrc', item.iframeSrc]);
    if (item.selector && item.selector !== 'iframe') params.push(['selector', item.selector]);
    return params;
}

// ── Render meta / Web Storage tree ──
function tryParseObjectString(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

function _storagePathRoot(storeKind, storageKey) {
    return `r:${storeKind}:${JSON.stringify(String(storageKey))}`;
}

function _storagePathJson(storeKind, storageKey, pathSegs) {
    return `j:${storeKind}:${JSON.stringify([String(storageKey), ...pathSegs])}`;
}

function normalizeStorageEntries(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('Нужен JSON-объект вида { "ключ": "значение", ... }');
    }
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (k === '') continue;
        if (v === null || v === undefined) out[k] = '';
        else if (typeof v === 'object') out[k] = JSON.stringify(v);
        else out[k] = String(v);
    }
    return out;
}

function appendJsonTree(el, val, depth, storeKind, storageKey, pathSegs) {
    if (depth > 14) {
        const sp = document.createElement('span');
        sp.className = 'jt-lit';
        sp.textContent = '(depth limit)';
        el.appendChild(sp);
        return;
    }
    if (val === null) {
        const sp = document.createElement('span');
        sp.className = 'jt-lit jt-null';
        sp.textContent = 'null';
        el.appendChild(sp);
        return;
    }
    const typ = typeof val;
    if (typ !== 'object') {
        const sp = document.createElement('span');
        sp.className = 'jt-lit ' + (typ === 'string' ? 'jt-str' : typ === 'boolean' ? 'jt-bool' : 'jt-num');
        sp.textContent = typ === 'string' ? JSON.stringify(val) : String(val);
        el.appendChild(sp);
        return;
    }
    if (Array.isArray(val)) {
        if (val.length === 0) {
            el.appendChild(document.createTextNode('[]'));
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'jt-nested';
        val.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'jt-row';
            const lab = document.createElement('span');
            lab.className = 'jt-idx';
            lab.textContent = `${i}: `;
            row.appendChild(lab);
            const cell = document.createElement('span');
            if (item !== null && typeof item === 'object') {
                const inner = document.createElement('details');
                inner.className = 'jt-details';
                inner.dataset.paStoreKind = storeKind;
                const childSegs = [...pathSegs, i];
                const pkey = _storagePathJson(storeKind, storageKey, childSegs);
                inner.dataset.paStPath = pkey;
                if (_storageOpenPaths[storeKind].has(pkey)) inner.open = true;
                const is = document.createElement('summary');
                is.textContent = Array.isArray(item) ? `[${item.length}]` : `{${Object.keys(item).length}}`;
                inner.appendChild(is);
                const ib = document.createElement('div');
                appendJsonTree(ib, item, depth + 1, storeKind, storageKey, childSegs);
                inner.appendChild(ib);
                cell.appendChild(inner);
            } else {
                appendJsonTree(cell, item, depth + 1, storeKind, storageKey, [...pathSegs, i]);
            }
            row.appendChild(cell);
            wrap.appendChild(row);
        });
        el.appendChild(wrap);
        return;
    }
    const keys = Object.keys(val).sort();
    if (keys.length === 0) {
        el.appendChild(document.createTextNode('{}'));
        return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'jt-nested';
    for (const k of keys) {
        const row = document.createElement('div');
        row.className = 'jt-row';
        const lab = document.createElement('span');
        lab.className = 'jt-prop';
        lab.textContent = `${k}: `;
        row.appendChild(lab);
        const item = val[k];
        const cell = document.createElement('span');
        if (item !== null && typeof item === 'object') {
            const inner = document.createElement('details');
            inner.className = 'jt-details';
            inner.dataset.paStoreKind = storeKind;
            const childSegs = [...pathSegs, k];
            const pkey = _storagePathJson(storeKind, storageKey, childSegs);
            inner.dataset.paStPath = pkey;
            if (_storageOpenPaths[storeKind].has(pkey)) inner.open = true;
            const is = document.createElement('summary');
            is.textContent = Array.isArray(item) ? `[${item.length}]` : `{${Object.keys(item).length}}`;
            inner.appendChild(is);
            const ib = document.createElement('div');
            appendJsonTree(ib, item, depth + 1, storeKind, storageKey, childSegs);
            inner.appendChild(ib);
            cell.appendChild(inner);
        } else {
            appendJsonTree(cell, item, depth + 1, storeKind, storageKey, [...pathSegs, k]);
        }
        row.appendChild(cell);
        wrap.appendChild(row);
    }
    el.appendChild(wrap);
}

function mountStorageTreeRecord(host, record, storeKind) {
    host.replaceChildren();
    const rec = record || {};
    const keys = Object.keys(rec).sort();
    if (!keys.length) {
        const empty = document.createElement('div');
        empty.className = 'st-empty';
        empty.textContent = '(empty)';
        host.appendChild(empty);
        return;
    }
    const openSet = _storageOpenPaths[storeKind];
    for (const k of keys) {
        const raw = rec[k] == null ? '' : String(rec[k]);
        const detOuter = document.createElement('details');
        detOuter.className = 'st-entry';
        detOuter.dataset.paStoreKind = storeKind;
        const rpath = _storagePathRoot(storeKind, k);
        detOuter.dataset.paStPath = rpath;
        if (openSet.has(rpath)) detOuter.open = true;
        const sum = document.createElement('summary');
        const sk = document.createElement('span');
        sk.className = 'st-key';
        sk.textContent = k;
        const sm = document.createElement('span');
        sm.className = 'st-meta';
        const parsed = tryParseObjectString(raw);
        sm.textContent = parsed != null ? 'JSON' : `${raw.length} chars`;
        sum.appendChild(sk);
        sum.appendChild(sm);
        detOuter.appendChild(sum);
        const body = document.createElement('div');
        body.className = 'st-body';
        if (parsed != null) {
            appendJsonTree(body, parsed, 0, storeKind, k, []);
        } else {
            const pre = document.createElement('pre');
            pre.className = 'st-leaf-pre';
            pre.textContent = raw;
            body.appendChild(pre);
        }
        detOuter.appendChild(body);
        host.appendChild(detOuter);
    }
}

function bindStorageTreeToggle(host) {
    host.addEventListener('toggle', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLDetailsElement) || !t.dataset.paStPath) return;
        const kind = t.dataset.paStoreKind;
        if (kind !== 'session' && kind !== 'local') return;
        const set = _storageOpenPaths[kind];
        if (t.open) set.add(t.dataset.paStPath);
        else set.delete(t.dataset.paStPath);
    }, true);
}

async function applyStorageToPage(storeKind, entries) {
    const tabId = getSelectedTabId();
    if (!tabId) {
        statusEl.textContent = 'Нет выбранной вкладки';
        return;
    }
    if (typeof api.applyPageStorage !== 'function') {
        statusEl.textContent = 'applyPageStorage недоступен (обновите preload)';
        return;
    }
    _storageApplyLoading = storeKind;
    renderMeta(_lastMeta);
    renderStorage();
    updateBadges();
    await new Promise((r) => requestAnimationFrame(() => r()));

    let errMsg = null;
    try {
        const res = await api.applyPageStorage(tabId, { target: storeKind, entries });
        if (!res?.ok) {
            errMsg = 'Запись не удалась: ' + (res?.error || '?');
        } else {
            const snap = await api.analyzePageStorage(tabId);
            _lastStorage = snap || { sessionStorage: {}, localStorage: {} };
        }
    } catch (err) {
        errMsg = 'Ошибка: ' + (err.message || err);
    } finally {
        _storageApplyLoading = null;
        renderMeta(_lastMeta);
        renderStorage();
        updateBadges();
        statusEl.textContent = errMsg || 'Данные с вкладки подгружены в форму';
        setTimeout(() => { statusEl.textContent = 'Ready'; }, 2200);
    }
}

function appendStorageInspector(storageSec, ss, ls) {
    const view = document.createElement('div');
    view.className = 'meta-storage-view';

    function buildStoreBlock(storeKind, rec) {
        const block = document.createElement('details');
        block.className = 'st-store-block';
        block.dataset.paStoreKind = storeKind;
        block.open = _storageStoreBlockOpen[storeKind];
        block.addEventListener('toggle', () => {
            _storageStoreBlockOpen[storeKind] = block.open;
        });

        const n = Object.keys(rec).length;
        const sum = document.createElement('summary');
        sum.className = 'st-store-summary';
        sum.textContent = `${storeKind === 'session' ? 'sessionStorage' : 'localStorage'} · ${n} ключ(ей)`;

        const body = document.createElement('div');
        body.className = 'st-store-body';

        const toolbar = document.createElement('div');
        toolbar.className = 'st-store-toolbar';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn btn-sm btn-primary';
        copyBtn.textContent = '⎘ Копировать JSON';
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'btn btn-sm';
        applyBtn.textContent = 'Записать на страницу';
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'btn btn-sm';
        resetBtn.textContent = 'Сбросить';

        const ta = document.createElement('textarea');
        ta.className = 'st-store-json-edit';
        ta.spellcheck = false;
        ta.value = JSON.stringify(rec, null, 2);
        ta.title = 'Объект { ключ: строка }; вложенные значения будут сохранены как JSON-строка';

        const treeHost = document.createElement('div');
        treeHost.className = 'st-tree';
        mountStorageTreeRecord(treeHost, rec, storeKind);
        bindStorageTreeToggle(treeHost);

        const treeCaption = document.createElement('div');
        treeCaption.className = 'st-tree-caption';
        treeCaption.textContent = 'Дерево (только просмотр)';

        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(ta.value).then(() => {
                statusEl.textContent = '✓ JSON в буфере';
                setTimeout(() => { statusEl.textContent = 'Ready'; }, 1600);
            }).catch(() => {});
        });
        applyBtn.addEventListener('click', async () => {
            try {
                const flat = normalizeStorageEntries(JSON.parse(ta.value));
                await applyStorageToPage(storeKind, flat);
            } catch (err) {
                statusEl.textContent = 'JSON: ' + (err.message || err);
            }
        });
        resetBtn.addEventListener('click', () => {
            ta.value = JSON.stringify(rec, null, 2);
            statusEl.textContent = 'Сброшено к снимку';
            setTimeout(() => { statusEl.textContent = 'Ready'; }, 1400);
        });

        toolbar.appendChild(copyBtn);
        toolbar.appendChild(applyBtn);
        toolbar.appendChild(resetBtn);

        body.appendChild(toolbar);
        body.appendChild(ta);
        body.appendChild(treeCaption);
        body.appendChild(treeHost);

        if (storeKind === _storageApplyLoading) {
            body.classList.add('st-store-body--loading');
            const ov = document.createElement('div');
            ov.className = 'st-store-loading';
            ov.setAttribute('aria-busy', 'true');
            const spin = document.createElement('span');
            spin.className = 'st-store-loading-spin';
            const tx = document.createElement('span');
            tx.className = 'st-store-loading-text';
            tx.textContent = 'Запись и загрузка с вкладки…';
            ov.appendChild(spin);
            ov.appendChild(tx);
            body.appendChild(ov);
            ta.disabled = true;
            copyBtn.disabled = true;
            applyBtn.disabled = true;
            resetBtn.disabled = true;
        }

        block.appendChild(sum);
        block.appendChild(body);
        return block;
    }

    view.appendChild(buildStoreBlock('session', ss));
    view.appendChild(buildStoreBlock('local', ls));
    storageSec.appendChild(view);
}

function renderMeta(data) {
    metaContent.innerHTML = '';
    _storageEditorActiveCount = 0;
    const d = data || {};
    const hasPageInfo = !!(d.title || d.url);

    if (hasPageInfo) {
        const sections = [
            { title: 'Page', rows: [
                ['Title', d.title],
                ['URL', d.url],
                ['Charset', d.charset],
                ['Doctype', d.doctype],
            ]},
            { title: `Meta Tags (${(d.meta||[]).length})`, rows: (d.meta||[]).map(m => [m.name, m.content]) },
            { title: `Scripts (${(d.scripts?.external||0) + (d.scripts?.inline||0)})`, rows: [
                ['Inline', d.scripts?.inline],
                ['External', d.scripts?.external],
                ...(d.scripts?.srcs||[]).slice(0, 20).map((s, i) => [`  src[${i}]`, s]),
            ]},
            { title: `Iframes (${(d.iframes||[]).length})`, rows: (d.iframes||[]).map(f => [f.id || f.name || '(anon)', f.src]) },
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
}

function renderStorage() {
    if (!storageContent) return;
    storageContent.innerHTML = '';
    _storageEditorActiveCount = 0;
    const ss = _lastStorage?.sessionStorage || {};
    const ls = _lastStorage?.localStorage || {};
    const ns = Object.keys(ss).length;
    const nl = Object.keys(ls).length;

    const storageSec = document.createElement('div');
    storageSec.className = 'meta-section';
    const stTitle = document.createElement('div');
    stTitle.className = 'meta-section-title';
    stTitle.textContent = `Web storage (${ns} session · ${nl} local)`;
    storageSec.appendChild(stTitle);
    appendStorageInspector(storageSec, ss, ls);
    storageContent.appendChild(storageSec);
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

// Initial load
api.getTabs?.().then((tabs) => {
    populateTabSelect(tabs);
    setupAutoRefresh();
    if (autoCheck.checked) setTimeout(() => runAnalysis({ includeScout: false }), 300);
}).catch(() => {});

window.addEventListener('beforeunload', () => {
    if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
});
