'use strict';

const api = window.electronAPI;


const FETCH_ONLY_FORBIDDEN = new Set([
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length',
    'cookie2', 'date', 'dnt', 'expect', 'keep-alive',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);

function isRestricted(name) {
    if (!name) return false;
    const lo = name.toLowerCase().trim();
    return FETCH_ONLY_FORBIDDEN.has(lo) || lo.startsWith('proxy-');
}

const COMMON_HEADERS = [
    'Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization',
    'Cache-Control', 'Content-Type', 'Cookie', 'Origin', 'Referer',
    'User-Agent', 'X-Requested-With', 'X-API-Key',
];
const CONTENT_TYPE_VALUES = [
    'application/json', 'application/x-www-form-urlencoded', 'multipart/form-data',
    'text/plain', 'text/html', 'application/xml', 'image/png',
];

let uid = 1;
const nid = () => uid++;

const state = {
    params: [],
    headers: [],
    formFields: [],
    multipart: [],
    bodyType: 'none',
};

const LAYOUT_KEY = 'cupnet-request-editor-layout-v2';
const HISTORY_KEY = 'cupnet-request-editor-history-v1';
const MAX_HISTORY = 48;
let requestHistory = [];
let activeHistoryId = null;
let pendingHistoryId = null;

let CM = null;
let bodyView = null;
let respView = null;
let bodyLangComp = null;
let respLangComp = null;
let currentCancelToken = null;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tryFormatJson(str) {
    try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

function statusPill(c) {
    if (c >= 200 && c < 300) return 's2';
    if (c >= 300 && c < 400) return 's3';
    if (c >= 400 && c < 500) return 's4';
    return 's5';
}
function statusCls(c) {
    if (c >= 200 && c < 300) return 'c2';
    if (c >= 300 && c < 400) return 'c3';
    if (c >= 400 && c < 500) return 'c4';
    return 'c5';
}
function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
function shortUrl(u) {
    try {
        const x = new URL(u);
        const s = x.host + x.pathname;
        return s.slice(0, 56) + (s.length > 56 ? '…' : '');
    } catch { return String(u || '').slice(0, 56); }
}

function loadCM() {
    if (CM) return CM;
    try {
        CM = api.getRequestEditorCodeMirror?.();
    } catch { CM = null; }
    return CM;
}

function getBodyText() {
    if (bodyView) return bodyView.state.doc.toString();
    const ta = document.getElementById('body-fallback-ta');
    return ta ? ta.value : '';
}
function setBodyText(t) {
    const s = String(t ?? '');
    if (bodyView) {
        bodyView.dispatch({ changes: { from: 0, to: bodyView.state.doc.length, insert: s } });
        return;
    }
    const ta = document.getElementById('body-fallback-ta');
    if (ta) ta.value = s;
}
function getActiveEnvVars() {
    const sel = document.getElementById('env-select');
    const id = sel && sel.value;
    if (!id) return {};
    const row = envRows.find(r => String(r.id) === String(id));
    if (!row) return {};
    try { return typeof row.variables_json === 'string' ? JSON.parse(row.variables_json || '{}') : (row.variables_json || {}); }
    catch { return {}; }
}

function applyTemplate(str) {
    let s = String(str ?? '');
    const vars = getActiveEnvVars();
    s = s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => {
        const key = String(k).trim();
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{{${key}}}`;
    });
    return s;
}

function mergeAuthIntoRequest(baseUrl, baseHeaders) {
    let url = applyTemplate(baseUrl);
    const headers = { ...baseHeaders };
    const t = document.getElementById('auth-type')?.value || 'none';
    if (t === 'bearer') {
        const tok = document.getElementById('auth-bearer-token')?.value || '';
        if (tok) headers['Authorization'] = 'Bearer ' + tok;
    } else if (t === 'basic') {
        const u = document.getElementById('auth-basic-user')?.value || '';
        const p = document.getElementById('auth-basic-pass')?.value || '';
        const b64 = typeof btoa !== 'undefined' ? btoa(unescape(encodeURIComponent(`${u}:${p}`))) : '';
        if (u || p) headers['Authorization'] = 'Basic ' + b64;
    } else if (t === 'apikey') {
        const kn = document.getElementById('auth-apikey-name')?.value || '';
        const kv = document.getElementById('auth-apikey-value')?.value || '';
        const where = document.getElementById('auth-apikey-in')?.value || 'header';
        if (kn && kv != null) {
            if (where === 'header') headers[kn] = kv;
            else {
                try {
                    const u = new URL(url.includes('://') ? url : 'https://' + url);
                    u.searchParams.set(kn, kv);
                    url = u.toString();
                } catch { /* ignore */ }
            }
        }
    } else if (t === 'custom') {
        const hn = document.getElementById('auth-custom-name')?.value || '';
        const hv = document.getElementById('auth-custom-value')?.value || '';
        if (hn) headers[hn] = hv;
    }
    return { url, headers };
}

function getAuthState() {
    return {
        type: document.getElementById('auth-type')?.value || 'none',
        bearerToken: document.getElementById('auth-bearer-token')?.value || '',
        basicUser: document.getElementById('auth-basic-user')?.value || '',
        basicPass: document.getElementById('auth-basic-pass')?.value || '',
        apikeyName: document.getElementById('auth-apikey-name')?.value || '',
        apikeyValue: document.getElementById('auth-apikey-value')?.value || '',
        apikeyIn: document.getElementById('auth-apikey-in')?.value || 'header',
        customName: document.getElementById('auth-custom-name')?.value || '',
        customValue: document.getElementById('auth-custom-value')?.value || '',
    };
}

function setAuthState(auth) {
    if (!auth || typeof auth !== 'object') return;
    const el = (id) => document.getElementById(id);
    if (auth.type) { const e = el('auth-type'); if (e) e.value = auth.type; }
    const map = {
        'auth-bearer-token': auth.bearerToken,
        'auth-basic-user': auth.basicUser,
        'auth-basic-pass': auth.basicPass,
        'auth-apikey-name': auth.apikeyName,
        'auth-apikey-value': auth.apikeyValue,
        'auth-apikey-in': auth.apikeyIn,
        'auth-custom-name': auth.customName,
        'auth-custom-value': auth.customValue,
    };
    for (const [id, val] of Object.entries(map)) {
        const e = el(id);
        if (e && val != null) e.value = val;
    }
    syncAuthPanels();
}

function parseUrlToParams(raw) {
    if (!raw) return;
    try {
        const url = new URL(raw.includes('://') ? raw : 'https://' + raw);
        state.params = [];
        url.searchParams.forEach((v, k) => {
            state.params.push({ id: nid(), on: true, key: k, value: v });
        });
        renderParams();
        updateCounts();
    } catch { /* ignore */ }
}

function buildUrlWithParams() {
    const base = (urlIn.value.split('?')[0] || '').trim();
    const active = state.params.filter(p => p.on && p.key.trim());
    if (!active.length) return applyTemplate(base);
    const qs = active.map(p =>
        `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`
    ).join('&');
    return applyTemplate(base) + '?' + qs;
}

const methodSel = document.getElementById('method-select');
const urlIn = document.getElementById('url-input');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');
const copyCurlBtn = document.getElementById('copy-curl-btn');
const newWindowBtn = document.getElementById('new-window-btn');
const historyToggleBtn = document.getElementById('history-toggle-btn');
const respPill = document.getElementById('resp-pill');
const proxyInfoName = document.getElementById('proxy-info-name');
const proxyInfoWrap = document.getElementById('proxy-info-wrap');
const historyPane = document.getElementById('history-pane');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const historySearch = document.getElementById('history-search');

const paramsTbody = document.getElementById('params-tbody');
const headersTbody = document.getElementById('headers-tbody');
const formTbody = document.getElementById('form-tbody');
const multipartTbody = document.getElementById('multipart-tbody');
const bodyNone = document.getElementById('body-none-msg');
const bodyCmWrap = document.getElementById('body-cm-wrap');
const formBody = document.getElementById('form-body');
const multipartBody = document.getElementById('multipart-body');
const bodyCtHint = document.getElementById('body-ct-hint');
const formatJsonBtn = document.getElementById('format-json-btn');

const cntParams = document.getElementById('cnt-params');
const cntHeaders = document.getElementById('cnt-headers');
const cntBody = document.getElementById('cnt-body');
const cntRespH = document.getElementById('cnt-resp-headers');

const respEmpty = document.getElementById('resp-empty');
const respContent = document.getElementById('resp-content');
const riStatus = document.getElementById('ri-status');
const riTime = document.getElementById('ri-time');
const riSize = document.getElementById('ri-size');
const respActions = document.getElementById('resp-actions');
const respCmHost = document.getElementById('resp-cm-host');
const respPreFallback = document.getElementById('resp-pre-fallback');
const respPrettyEl = document.getElementById('tab-pretty-resp');
const htmlPreviewIframe = document.getElementById('html-preview-iframe');
const htmlPreviewEmpty = document.getElementById('html-preview-empty');
const htmlPreviewRefreshBtn = document.getElementById('html-preview-refresh');
const respHTbody = document.getElementById('resp-headers-tbody');
const respCookiesTbody = document.getElementById('resp-cookies-tbody');
const cookiesEmpty = document.getElementById('cookies-empty');
const cookiesTableWrap = document.getElementById('cookies-table-wrap');
const imagePreviewImg = document.getElementById('image-preview-img');
const imagePreviewEmpty = document.getElementById('image-preview-empty');

let lastResponseBody = '';
let lastResponseCT = '';
let lastImageBlobUrl = null;

const CT_HINT = {
    none: '', raw: '',
    json: 'Sets Content-Type: application/json',
    'form-urlencoded': 'Sets Content-Type: application/x-www-form-urlencoded',
    'form-data': 'multipart/form-data (built on send)',
};

function fillDatalists() {
    const dn = document.getElementById('common-header-names');
    const ct = document.getElementById('common-content-types');
    if (dn) {
        dn.innerHTML = COMMON_HEADERS.map(h => `<option value="${esc(h)}">`).join('');
    }
    if (ct) {
        ct.innerHTML = CONTENT_TYPE_VALUES.map(h => `<option value="${esc(h)}">`).join('');
    }
}
fillDatalists();

function renderKvTable(tbody, rows, onChange, onDelete) {
    tbody.innerHTML = '';
    for (const row of rows) {
        const tr = document.createElement('tr');
        tr.className = 'kv-row' + (row.on ? '' : ' disabled');
        const tdC = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.checked = row.on;
        chk.addEventListener('change', () => { row.on = chk.checked; tr.classList.toggle('disabled', !chk.checked); onChange(); });
        tdC.appendChild(chk);
        const tdK = document.createElement('td');
        const keyIn = document.createElement('input');
        keyIn.className = 'kv-input';
        keyIn.value = row.key || '';
        keyIn.placeholder = 'Key';
        keyIn.spellcheck = false;
        if (tbody.id === 'headers-tbody') {
            keyIn.setAttribute('list', 'common-header-names');
        }
        keyIn.addEventListener('input', () => { row.key = keyIn.value; onChange(); });
        tdK.appendChild(keyIn);
        const tdV = document.createElement('td');
        const valIn = document.createElement('input');
        valIn.className = 'kv-input';
        valIn.value = row.value || '';
        valIn.placeholder = 'Value';
        valIn.spellcheck = false;
        if (tbody.id === 'headers-tbody') valIn.setAttribute('list', 'common-content-types');
        valIn.addEventListener('input', () => { row.value = valIn.value; onChange(); });
        tdV.appendChild(valIn);
        const tdD = document.createElement('td'); tdD.className = 'kv-del';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'kv-del-btn';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => onDelete(row.id));
        tdD.appendChild(delBtn);
        tr.append(tdC, tdK, tdV, tdD);
        tbody.appendChild(tr);
    }
}

function renderParams() {
    renderKvTable(paramsTbody, state.params, () => { urlIn.value = buildUrlWithParams(); updateCounts(); },
        id => { state.params = state.params.filter(p => p.id !== id); renderParams(); updateCounts(); });
}

document.getElementById('add-param-btn').addEventListener('click', () => {
    state.params.push({ id: nid(), on: true, key: '', value: '' });
    renderParams(); updateCounts();
});

function renderHeaders() {
    headersTbody.innerHTML = '';
    for (const row of state.headers) {
        const tr = document.createElement('tr');
        tr.className = 'kv-row' + (row.on ? '' : ' disabled');
        const tdC = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.checked = row.on;
        chk.addEventListener('change', () => { row.on = chk.checked; tr.classList.toggle('disabled', !chk.checked); updateCounts(); });
        tdC.appendChild(chk);
        const tdK = document.createElement('td');
        const kWrap = document.createElement('div');
        kWrap.style.cssText = 'display:flex;align-items:center;gap:3px';
        const keyIn = document.createElement('input');
        keyIn.className = 'kv-input';
        keyIn.value = row.key || '';
        keyIn.placeholder = 'Header name';
        keyIn.setAttribute('list', 'common-header-names');
        keyIn.spellcheck = false;
        const star = document.createElement('span');
        star.className = 'restrict-star' + (isRestricted(row.key) ? ' show' : '');
        star.textContent = '*';
        star.title = 'May be ignored in net.fetch fallback';
        if (isRestricted(row.key)) keyIn.classList.add('restricted');
        keyIn.addEventListener('input', () => {
            row.key = keyIn.value;
            const r = isRestricted(row.key);
            keyIn.classList.toggle('restricted', r);
            star.classList.toggle('show', r);
            updateCounts();
        });
        kWrap.append(keyIn, star);
        tdK.appendChild(kWrap);
        const tdV = document.createElement('td');
        const valIn = document.createElement('input');
        valIn.className = 'kv-input';
        valIn.value = row.value || '';
        valIn.setAttribute('list', 'common-content-types');
        valIn.spellcheck = false;
        valIn.addEventListener('input', () => { row.value = valIn.value; });
        tdV.appendChild(valIn);
        const tdD = document.createElement('td'); tdD.className = 'kv-del';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'kv-del-btn';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => {
            state.headers = state.headers.filter(h => h.id !== row.id);
            renderHeaders(); updateCounts();
        });
        tdD.appendChild(delBtn);
        tr.append(tdC, tdK, tdV, tdD);
        headersTbody.appendChild(tr);
    }
}

document.getElementById('add-header-btn').addEventListener('click', () => {
    state.headers.push({ id: nid(), on: true, key: '', value: '' });
    renderHeaders(); updateCounts();
});

const headersBulkToggle = document.getElementById('headers-bulk-toggle');
const bulkHeadersWrap = document.getElementById('bulk-headers-wrap');
const bulkHeadersTa = document.getElementById('bulk-headers-ta');
const headersTableWrap = document.getElementById('headers-table-wrap');
let headersBulkMode = false;

headersBulkToggle?.addEventListener('click', () => {
    headersBulkMode = !headersBulkMode;
    if (headersBulkMode) {
        const lines = state.headers.filter(h => h.on && h.key).map(h => `${h.key}: ${h.value}`);
        bulkHeadersTa.value = lines.join('\n');
        headersTableWrap.style.display = 'none';
        bulkHeadersWrap.classList.add('visible');
        headersBulkToggle.textContent = 'Table view';
    } else {
        const lines = bulkHeadersTa.value.split('\n').filter(Boolean);
        state.headers = [];
        for (const line of lines) {
            const c = line.indexOf(':');
            if (c > 0) {
                state.headers.push({ id: nid(), on: true, key: line.slice(0, c).trim(), value: line.slice(c + 1).trim() });
            }
        }
        headersTableWrap.style.display = '';
        bulkHeadersWrap.classList.remove('visible');
        headersBulkToggle.textContent = 'Bulk edit';
        renderHeaders(); updateCounts();
    }
});

function renderFormFields() {
    renderKvTable(formTbody, state.formFields, () => updateCounts(),
        id => { state.formFields = state.formFields.filter(f => f.id !== id); renderFormFields(); updateCounts(); });
}

document.getElementById('add-form-btn').addEventListener('click', () => {
    state.formFields.push({ id: nid(), on: true, key: '', value: '' });
    renderFormFields(); updateCounts();
});

function renderMultipart() {
    multipartTbody.innerHTML = '';
    for (const row of state.multipart) {
        const tr = document.createElement('tr');
        tr.className = 'kv-row' + (row.on ? '' : ' disabled');
        const tdC = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.checked = row.on;
        chk.addEventListener('change', () => { row.on = chk.checked; updateCounts(); });
        tdC.appendChild(chk);
        const tdK = document.createElement('td');
        const keyIn = document.createElement('input');
        keyIn.className = 'kv-input';
        keyIn.value = row.key || '';
        keyIn.addEventListener('input', () => { row.key = keyIn.value; });
        tdK.appendChild(keyIn);
        const tdT = document.createElement('td');
        const sel = document.createElement('select');
        sel.innerHTML = '<option value="text">Text</option><option value="file">File</option>';
        sel.value = row.kind || 'text';
        sel.addEventListener('change', () => { row.kind = sel.value; renderMultipart(); });
        tdT.appendChild(sel);
        const tdV = document.createElement('td');
        if (row.kind === 'file') {
            const pathSpan = document.createElement('span');
            pathSpan.style.cssText = 'font-size:11px;color:var(--text-dim)';
            pathSpan.textContent = row.filePath ? row.fileName || row.filePath : '(no file)';
            const pick = document.createElement('button');
            pick.type = 'button';
            pick.className = 'sm-btn';
            pick.textContent = 'Choose…';
            pick.addEventListener('click', async () => {
                const r = await api.requestEditorPickFile?.();
                if (r && r.path) {
                    row.filePath = r.path;
                    row.fileName = r.path.split(/[/\\]/).pop();
                    renderMultipart();
                }
            });
            tdV.append(pathSpan, document.createTextNode(' '), pick);
        } else {
            const valIn = document.createElement('input');
            valIn.className = 'kv-input';
            valIn.value = row.value || '';
            valIn.addEventListener('input', () => { row.value = valIn.value; });
            tdV.appendChild(valIn);
        }
        const tdD = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'kv-del-btn';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => {
            state.multipart = state.multipart.filter(m => m.id !== row.id);
            renderMultipart(); updateCounts();
        });
        tdD.appendChild(delBtn);
        tr.append(tdC, tdK, tdT, tdV, tdD);
        multipartTbody.appendChild(tr);
    }
}

document.getElementById('add-multipart-btn').addEventListener('click', () => {
    state.multipart.push({ id: nid(), on: true, key: '', kind: 'text', value: '' });
    renderMultipart(); updateCounts();
});

document.querySelectorAll('[name=btype]').forEach(r => {
    r.addEventListener('change', () => {
        if (!r.checked) return;
        state.bodyType = r.value;
        updateBodyUI();
        updateCounts();
        syncBodyEditorLanguage();
    });
});

function updateBodyUI() {
    const t = state.bodyType;
    bodyNone.style.display = t === 'none' ? '' : 'none';
    const showCm = (t === 'raw' || t === 'json');
    bodyCmWrap.style.display = showCm ? '' : 'none';
    const ta = document.getElementById('body-fallback-ta');
    if (ta) {
        if (showCm && !bodyView) ta.style.display = '';
        else ta.style.display = 'none';
    }
    formBody.style.display = t === 'form-urlencoded' ? 'flex' : 'none';
    multipartBody.style.display = t === 'form-data' ? 'flex' : 'none';
    bodyCtHint.textContent = CT_HINT[t] || '';
    if (formatJsonBtn) formatJsonBtn.style.display = t === 'json' ? '' : 'none';
    document.querySelectorAll('.bt-opt').forEach(l => {
        l.classList.toggle('sel', l.querySelector('input')?.value === t);
    });
}

formatJsonBtn?.addEventListener('click', () => {
    setBodyText(tryFormatJson(getBodyText()));
});

function updateCounts() {
    const pc = state.params.filter(p => p.on && p.key).length;
    const hc = state.headers.filter(h => h.on && h.key).length;
    cntParams.textContent = pc || 0;
    cntParams.classList.toggle('on', pc > 0);
    cntHeaders.textContent = hc || 0;
    cntHeaders.classList.toggle('on', hc > 0);
    const hasBody = state.bodyType !== 'none';
    cntBody.textContent = hasBody ? '*' : '—';
    cntBody.classList.toggle('on', hasBody);
}

document.querySelectorAll('#req-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('#req-tabs .tab-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.tab === tab));
        document.querySelectorAll('#req-pane .tab-content').forEach(c =>
            c.classList.toggle('active', c.id === 'tab-' + tab));
    });
});

document.querySelectorAll('#resp-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.rtab;
        document.querySelectorAll('#resp-tabs .tab-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.rtab === tab));
        document.querySelectorAll('#resp-pane .tab-content').forEach(c =>
            c.classList.toggle('active', c.id === 'tab-' + tab + '-resp'));
        if (tab === 'pretty') renderPrettyInto(respPrettyEl, lastResponseBody);
        if (tab === 'html') renderHtmlPreview(lastResponseBody, lastResponseCT);
        if (tab === 'image') refreshImagePreview();
    });
});

function showBodyEditorFallback() {
    const ta = document.getElementById('body-fallback-ta');
    if (ta) ta.style.display = '';
}

function initCodeMirror() {
    const m = loadCM();
    if (!m || !m.EditorView) {
        showBodyEditorFallback();
        return;
    }
    let createdBody = false;
    try {
        const { EditorView, EditorState, basicSetup, Compartment, json, oneDark } = m;
        bodyLangComp = new Compartment();
        respLangComp = new Compartment();

        const bodyExtensions = [
            basicSetup,
            oneDark,
            bodyLangComp.of(json()),
            EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
        ];
        bodyView = new EditorView({
            state: EditorState.create({ doc: '', extensions: bodyExtensions }),
            parent: bodyCmWrap,
        });
        createdBody = true;

        const respExtensions = [
            EditorState.readOnly.of(true),
            basicSetup,
            oneDark,
            respLangComp.of([]),
            EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
            EditorView.domEventHandlers({
                keydown: (e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
                        e.preventDefault();
                        try { m.openSearchPanel?.(respView); } catch { /* ignore */ }
                    }
                },
            }),
        ];
        respView = new EditorView({
            state: EditorState.create({ doc: '', extensions: respExtensions }),
            parent: respCmHost,
        });
        const ta = document.getElementById('body-fallback-ta');
        if (ta) ta.style.display = 'none';
    } catch (err) {
        console.error('Request Editor: CodeMirror init failed', err);
        if (createdBody && bodyView) {
            try { bodyView.destroy(); } catch { /* ignore */ }
            bodyView = null;
        }
        if (respView) {
            try { respView.destroy(); } catch { /* ignore */ }
            respView = null;
        }
        bodyLangComp = null;
        respLangComp = null;
        showBodyEditorFallback();
    }
}

function syncBodyEditorLanguage() {
    const m = loadCM();
    if (!bodyView || !m) return;
    const { json, xml, html } = m;
    let lang = [];
    if (state.bodyType === 'json') lang = json();
    else if (state.bodyType === 'raw') lang = html();
    bodyView.dispatch({
        effects: bodyLangComp.reconfigure(lang),
    });
}

urlIn.addEventListener('paste', () => { requestAnimationFrame(() => parseUrlToParams(urlIn.value)); });
urlIn.addEventListener('blur', () => { parseUrlToParams(urlIn.value); });
methodSel.addEventListener('change', () => { methodSel.className = methodSel.value; });

const divH = document.getElementById('divider-h');
const reqPane = document.getElementById('req-pane');
const splitEl = document.getElementById('split');
let drag = false, dragX = 0, dragW = 0;
divH?.addEventListener('mousedown', e => {
    drag = true; dragX = e.clientX;
    dragW = reqPane.getBoundingClientRect().width;
    divH.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
});
document.addEventListener('mousemove', e => {
    if (!drag) return;
    const histW = historyPane && !historyPane.classList.contains('collapsed')
        ? Math.round(historyPane.getBoundingClientRect().width) : 0;
    const minReqW = 320;
    const minRespW = 260;
    const maxW = Math.max(minReqW, (splitEl?.clientWidth || window.innerWidth) - minRespW - histW);
    const w = Math.max(minReqW, Math.min(dragW + (e.clientX - dragX), maxW));
    reqPane.style.width = w + 'px';
});
document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = false;
    divH?.classList.remove('dragging');
    document.body.style.userSelect = '';
    saveLayout();
});

function applyProxyInfo(info) {
    if (!proxyInfoName) return;
    if (info && info.active && info.proxyName) {
        proxyInfoName.textContent = info.proxyName;
        proxyInfoName.className = 'active';
    } else {
        proxyInfoName.textContent = 'Direct';
        proxyInfoName.className = 'direct';
    }
}
function refreshProxyInfo() {
    if (!api.getCurrentProxy) return;
    api.getCurrentProxy().then(applyProxyInfo).catch(() => {
        if (proxyInfoName) { proxyInfoName.textContent = '—'; proxyInfoName.className = ''; }
    });
}
refreshProxyInfo();
if (api.onProxyStatusChanged) api.onProxyStatusChanged(applyProxyInfo);

async function sendRequest() {
    const built = buildUrlWithParams().trim();
    if (!built) { urlIn.focus(); return; }
    const method = methodSel.value;
    pendingHistoryId = pushHistorySnapshot({
        method, url: built, headers: state.headers, bodyType: state.bodyType,
        bodyText: getBodyText(), formFields: state.formFields,
    });

    const hdrObj = {};
    for (const h of state.headers) {
        if (h.on && h.key.trim()) hdrObj[h.key.trim()] = applyTemplate(h.value);
    }
    const merged = mergeAuthIntoRequest(built, hdrObj);
    let urlFinal = merged.url;
    Object.assign(hdrObj, merged.headers);

    let body;
    let bodyBase64;
    const noBody = ['GET', 'HEAD', 'OPTIONS'].includes(method);

    if (!noBody && state.bodyType === 'json') {
        body = applyTemplate(getBodyText());
        if (!hdrObj['content-type'] && !hdrObj['Content-Type']) hdrObj['Content-Type'] = 'application/json';
    } else if (!noBody && state.bodyType === 'raw') {
        body = applyTemplate(getBodyText());
    } else if (!noBody && state.bodyType === 'form-urlencoded') {
        body = state.formFields.filter(f => f.on && f.key)
            .map(f => `${encodeURIComponent(f.key)}=${encodeURIComponent(applyTemplate(f.value))}`)
            .join('&');
        if (!hdrObj['content-type'] && !hdrObj['Content-Type']) {
            hdrObj['Content-Type'] = 'application/x-www-form-urlencoded';
        }
    } else if (!noBody && state.bodyType === 'form-data') {
        const textParts = [];
        const files = [];
        for (const p of state.multipart) {
            if (!p.on || !p.key) continue;
            if (p.kind === 'file') {
                if (p.filePath) files.push({ key: p.key, path: p.filePath, filename: p.fileName });
            } else {
                textParts.push({ key: p.key, value: applyTemplate(p.value || '') });
            }
        }
        const mp = await api.requestEditorBuildMultipart({ text: textParts, files });
        if (!mp.success) {
            alert(mp.error || 'Multipart build failed');
            return;
        }
        if (mp.warning) console.warn('Multipart:', mp.warning);
        bodyBase64 = mp.bodyBase64;
        hdrObj['Content-Type'] = mp.contentType;
    }

    currentCancelToken = 're_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span class="spin"></span>';
    if (cancelBtn) { cancelBtn.classList.add('visible'); cancelBtn.dataset.token = currentCancelToken; }
    respPill.className = ''; respPill.style.display = 'none';
    respEmpty.style.display = 'flex';
    respContent.classList.remove('visible');

    try {
        const r = await api.executeRequest({
            method,
            url: urlFinal,
            headers: hdrObj,
            body: bodyBase64 ? undefined : body,
            bodyBase64,
            cancelToken: currentCancelToken,
        });
        renderResponse(r);
    } catch (e) {
        renderError(e.message);
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        if (cancelBtn) { cancelBtn.classList.remove('visible'); }
        currentCancelToken = null;
    }
}

if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
        const t = cancelBtn.dataset.token;
        if (t) api.cancelExecuteRequest?.(t);
    });
}

sendBtn.addEventListener('click', sendRequest);
urlIn.addEventListener('keydown', e => { if (e.key === 'Enter') sendRequest(); });

function setRespText(s) {
    const m = loadCM();
    if (respView && m) {
        respView.dispatch({
            changes: { from: 0, to: respView.state.doc.length, insert: s },
            effects: respLangComp.reconfigure([]),
        });
    } else if (respPreFallback) {
        respPreFallback.style.display = '';
        respPreFallback.textContent = s;
    }
}

function renderResponse(r) {
    if (r.cancelled) {
        renderError('Cancelled');
        return;
    }
    if (!r.success) { renderError(r.error || 'Error'); return; }

    respPill.className = statusPill(r.status);
    respPill.textContent = `${r.status}`;
    respPill.style.display = '';

    riStatus.innerHTML = `<span class="${statusCls(r.status)}" style="font-weight:700">${r.status}</span>`;
    riTime.innerHTML = `Time: <b>${r.duration}ms</b>`;
    riSize.innerHTML = `Size: <b>${fmtBytes(new Blob([r.body || '']).size)}</b>`
        + (r.tlsProfile ? ` &nbsp;<span style="color:var(--accent);font-size:11px">TLS: ${esc(r.tlsProfile)}</span>` : '');

    const ctRaw = r.headers['content-type'] || r.headers['Content-Type'] || '';
    const ct = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw).toLowerCase();
    const rawBody = r.body || '';
    lastResponseBody = rawBody;
    lastResponseCT = ct;

    const m = loadCM();
    if (respView && m) {
        let langExt = [];
        if (ct.includes('xml') && m.xml) langExt = m.xml();
        else if (ct.includes('html') && m.html) langExt = m.html();
        else if (ct.includes('json') && m.json) langExt = m.json();
        respView.dispatch({
            changes: { from: 0, to: respView.state.doc.length, insert: ct.includes('json') ? tryFormatJson(rawBody) : rawBody },
            effects: respLangComp.reconfigure(langExt),
        });
    } else {
        setRespText(ct.includes('json') ? tryFormatJson(rawBody) : rawBody);
    }

    if (htmlPreviewIframe) { htmlPreviewIframe.srcdoc = ''; htmlPreviewIframe.style.display = 'none'; }
    if (htmlPreviewEmpty) htmlPreviewEmpty.style.display = '';

    respHTbody.innerHTML = '';
    const hEntries = Object.entries(r.headers || {});
    cntRespH.textContent = hEntries.length;
    for (const [k, v] of hEntries) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td style="padding:4px 8px;color:var(--accent);font-family:var(--font-mono);font-size:12px">${esc(k)}</td>
            <td style="padding:4px 8px;font-family:var(--font-mono);font-size:12px;word-break:break-all">${esc(String(v))}</td>`;
        respHTbody.appendChild(tr);
    }

    const setCookies = [];
    for (const [k, v] of hEntries) {
        if (String(k).toLowerCase() === 'set-cookie') {
            if (Array.isArray(v)) setCookies.push(...v.map(String));
            else setCookies.push(String(v));
        }
    }
    if (respCookiesTbody) {
        respCookiesTbody.innerHTML = '';
        if (!setCookies.length) {
            cookiesEmpty.style.display = '';
            cookiesTableWrap.style.display = 'none';
        } else {
            cookiesEmpty.style.display = 'none';
            cookiesTableWrap.style.display = '';
            for (const c of setCookies) {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td style="word-break:break-all;font-size:12px">${esc(c)}</td>`;
                respCookiesTbody.appendChild(tr);
            }
        }
    }

    if (lastImageBlobUrl) { URL.revokeObjectURL(lastImageBlobUrl); lastImageBlobUrl = null; }
    if (ct.startsWith('image/') && rawBody.length) {
        try {
            const blob = new Blob([rawBody], { type: ct });
            lastImageBlobUrl = URL.createObjectURL(blob);
            imagePreviewImg.src = lastImageBlobUrl;
            imagePreviewImg.style.display = '';
            imagePreviewEmpty.style.display = 'none';
        } catch {
            imagePreviewImg.style.display = 'none';
            imagePreviewEmpty.style.display = '';
            imagePreviewEmpty.textContent = 'Could not preview image';
        }
    } else {
        imagePreviewImg.style.display = 'none';
        imagePreviewEmpty.style.display = '';
        imagePreviewEmpty.textContent = 'No image in response';
    }

    respActions.innerHTML = '';
    const copyBodyBtn = btn('Copy body', () => navigator.clipboard.writeText(r.body || '').catch(() => {}));
    const copyCurlBtn2 = btn('Copy cURL', () => navigator.clipboard.writeText(buildCurl()).catch(() => {}));
    respActions.append(copyBodyBtn, copyCurlBtn2);

    respEmpty.style.display = 'none';
    respContent.classList.add('visible');

    if (ct.startsWith('image/')) {
        document.querySelector('#resp-tabs [data-rtab="image"]')?.click();
    } else if (ct.includes('json')) {
        document.querySelector('#resp-tabs [data-rtab="pretty"]')?.click();
    } else if (ct.includes('html')) {
        document.querySelector('#resp-tabs [data-rtab="html"]')?.click();
    } else {
        document.querySelector('#resp-tabs [data-rtab="body"]')?.click();
    }

    if (pendingHistoryId) {
        updateHistoryResult(pendingHistoryId, { status: r.status, ok: true });
        pendingHistoryId = null;
    }
}

function refreshImagePreview() {
    if (lastImageBlobUrl && imagePreviewImg) {
        imagePreviewImg.src = lastImageBlobUrl;
        imagePreviewImg.style.display = '';
        imagePreviewEmpty.style.display = 'none';
    }
}

function renderError(msg) {
    respPill.className = 'err';
    respPill.textContent = 'Error';
    respPill.style.display = '';
    riStatus.innerHTML = `<span style="color:var(--danger)">${esc(msg)}</span>`;
    riTime.textContent = '';
    riSize.textContent = '';
    setRespText(msg);
    lastResponseBody = msg;
    lastResponseCT = '';
    if (respPrettyEl) respPrettyEl.innerHTML = '';
    respHTbody.innerHTML = '';
    respEmpty.style.display = 'none';
    respContent.classList.add('visible');
    document.querySelector('#resp-tabs [data-rtab="body"]')?.click();
    if (pendingHistoryId) {
        updateHistoryResult(pendingHistoryId, { status: 'ERR', ok: false });
        pendingHistoryId = null;
    }
}

function btn(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sm-btn';
    b.textContent = label;
    b.addEventListener('click', () => {
        onClick();
        const orig = b.textContent;
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = orig; }, 1200);
    });
    return b;
}

function buildCurl() {
    const sq = s => String(s).replace(/'/g, "'\\''");
    const hdrObj = {};
    for (const h of state.headers) {
        if (h.on && h.key) hdrObj[h.key] = h.value;
    }
    const merged = mergeAuthIntoRequest(buildUrlWithParams(), hdrObj);
    const parts = [`curl -X ${methodSel.value} '${sq(merged.url)}'`];
    for (const [k, v] of Object.entries(merged.headers)) {
        if (k && v != null) parts.push(`  -H '${sq(k)}: ${sq(v)}'`);
    }
    const t = state.bodyType;
    const bt = getBodyText();
    if (t === 'json' && bt) parts.push(`  -d '${sq(bt)}'`);
    else if (t === 'raw' && bt) parts.push(`  --data-raw '${sq(bt)}'`);
    else if (t === 'form-urlencoded') {
        const d = state.formFields.filter(f => f.on && f.key).map(f => `${f.key}=${f.value}`).join('&');
        if (d) parts.push(`  -d '${sq(d)}'`);
    } else if (t === 'form-data') {
        for (const p of state.multipart) {
            if (!p.on || !p.key) continue;
            if (p.kind === 'file' && p.filePath) {
                parts.push(`  -F '${sq(p.key)}=@${sq(p.filePath)}'`);
            } else if (p.kind !== 'file') {
                parts.push(`  -F '${sq(p.key)}=${sq(p.value || '')}'`);
            }
        }
    }
    return parts.join(' \\\n');
}

copyCurlBtn?.addEventListener('click', () => {
    navigator.clipboard.writeText(buildCurl()).catch(() => {});
    copyCurlBtn.textContent = 'Copied';
    setTimeout(() => { copyCurlBtn.textContent = 'Copy as cURL'; }, 1200);
});

newWindowBtn?.addEventListener('click', () => { api.openRequestEditorNewWindow?.(); });

function copyRows(rows) {
    return (rows || []).map(r => ({ id: nid(), on: !!r.on, key: r.key || '', value: r.value || '' }));
}
function copyMultipart(rows) {
    return (rows || []).map(r => ({
        id: nid(), on: !!r.on, key: r.key || '', kind: r.kind || 'text',
        value: r.value || '', filePath: r.filePath || '', fileName: r.fileName || '',
    }));
}
function collectSnapshotBase() {
    return {
        method: methodSel.value,
        url: buildUrlWithParams().trim(),
        headers: copyRows(state.headers),
        bodyType: state.bodyType,
        bodyText: getBodyText(),
        formFields: copyRows(state.formFields),
        multipart: copyMultipart(state.multipart),
        auth: getAuthState(),
        ts: Date.now(),
    };
}
function pushHistorySnapshot(override = {}) {
    const entry = { id: 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), ...collectSnapshotBase(), ...override };
    requestHistory.unshift(entry);
    if (requestHistory.length > MAX_HISTORY) requestHistory = requestHistory.slice(0, MAX_HISTORY);
    activeHistoryId = entry.id;
    saveHistory();
    renderHistoryFiltered();
    return entry.id;
}
function updateHistoryResult(id, patch = {}) {
    const h = requestHistory.find(x => x.id === id);
    if (!h) return;
    Object.assign(h, patch);
    saveHistory();
    renderHistoryFiltered();
}
function applyHistoryEntry(entry) {
    if (!entry) return;
    methodSel.value = entry.method || 'GET';
    methodSel.className = methodSel.value;
    urlIn.value = entry.url || '';
    state.headers = copyRows(entry.headers || []);
    state.bodyType = entry.bodyType || 'none';
    state.formFields = copyRows(entry.formFields || []);
    state.multipart = entry.multipart && entry.multipart.length ? copyMultipart(entry.multipart) : [];
    setBodyText(entry.bodyText || '');
    const radio = document.querySelector(`[name=btype][value="${state.bodyType}"]`);
    if (radio) radio.checked = true;
    if (entry.auth) setAuthState(entry.auth);
    parseUrlToParams(urlIn.value);
    renderHeaders();
    renderFormFields();
    renderMultipart();
    updateBodyUI();
    syncBodyEditorLanguage();
    updateCounts();
    activeHistoryId = entry.id;
    renderHistoryFiltered();
}
function renderHistoryFiltered() {
    const q = (historySearch && historySearch.value || '').toLowerCase().trim();
    if (!historyList) return;
    historyList.innerHTML = '';
    const list = q
        ? requestHistory.filter(h => (h.url || '').toLowerCase().includes(q) || (h.method || '').toLowerCase().includes(q))
        : requestHistory;
    if (!list.length) {
        if (historyEmpty) historyEmpty.style.display = '';
        return;
    }
    if (historyEmpty) historyEmpty.style.display = 'none';
    for (const h of list) {
        const el = document.createElement('div');
        el.className = 'h-item' + (h.id === activeHistoryId ? ' active' : '');
        const statusCls = h.ok === false ? 'err' : (h.ok === true ? 'ok' : '');
        const statusTxt = h.status ? String(h.status) : '—';
        const m = String(h.method || 'GET').toUpperCase();
        el.innerHTML = `
            <div class="h-row">
                <span class="h-method ${m}">${esc(m)}</span>
                <span class="h-url" title="${esc(h.url || '')}">${esc(shortUrl(h.url || ''))}</span>
            </div>
            <div class="h-meta">
                <span>${fmtTime(h.ts)}</span>
                <span class="h-status ${statusCls}">${esc(statusTxt)}</span>
            </div>`;
        el.addEventListener('click', () => applyHistoryEntry(h));
        historyList.appendChild(el);
    }
}
if (historySearch) historySearch.addEventListener('input', renderHistoryFiltered);

function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(requestHistory)); } catch { /* ignore */ }
}
function loadHistory() {
    try {
        const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        if (Array.isArray(arr)) requestHistory = arr.slice(0, MAX_HISTORY);
    } catch { /* ignore */ }
    renderHistoryFiltered();
}
function saveLayout() {
    try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({
            reqWidth: reqPane.style.width || '',
            historyCollapsed: historyPane?.classList.contains('collapsed') || false,
        }));
    } catch { /* ignore */ }
}
function loadLayout() {
    try {
        const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
        const saved = v.reqWidth;
        if (saved && saved.endsWith('px')) {
            reqPane.style.width = saved;
        } else {
            reqPane.style.width = Math.round(window.innerWidth * 0.36) + 'px';
        }
        if (v.historyCollapsed && historyPane) historyPane.classList.add('collapsed');
    } catch { /* ignore */ }
}

historyToggleBtn?.addEventListener('click', () => {
    if (!historyPane) return;
    historyPane.classList.toggle('collapsed');
    saveLayout();
});

document.getElementById('mode-history-btn')?.addEventListener('click', () => {
    document.getElementById('panel-history').classList.remove('panel-hidden');
    document.getElementById('panel-collections').classList.add('panel-hidden');
    document.getElementById('mode-history-btn').classList.add('active');
    document.getElementById('mode-collections-btn').classList.remove('active');
});
document.getElementById('mode-collections-btn')?.addEventListener('click', () => {
    document.getElementById('panel-history').classList.add('panel-hidden');
    document.getElementById('panel-collections').classList.remove('panel-hidden');
    document.getElementById('mode-collections-btn').classList.add('active');
    document.getElementById('mode-history-btn').classList.remove('active');
    loadCollectionsTree();
});

let collectionRows = [];
let selectedCollectionFolderId = null;
function collectionDepth(row) {
    let d = 0;
    let pid = row.parent_id;
    const byId = new Map(collectionRows.map(r => [r.id, r]));
    while (pid != null) {
        const p = byId.get(pid);
        if (!p) break;
        d++;
        pid = p.parent_id;
    }
    return d;
}

async function loadCollectionsTree() {
    const r = await api.requestEditorListCollections?.();
    if (!r || !r.success) return;
    collectionRows = r.rows || [];
    const tree = document.getElementById('collections-tree');
    const empty = document.getElementById('collections-empty');
    if (!tree) return;
    tree.innerHTML = '';
    if (!collectionRows.length) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';
    const sorted = [...collectionRows].sort((a, b) => {
        const da = collectionDepth(a);
        const db = collectionDepth(b);
        if (da !== db) return da - db;
        return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
    });
    for (const row of sorted) {
        const depth = collectionDepth(row);
        const div = document.createElement('div');
        div.className = 'c-node ' + (row.node_type === 'folder' ? 'folder' : 'request');
        div.style.paddingLeft = (8 + depth * 12) + 'px';
        div.dataset.id = row.id;

        const label = document.createElement('span');
        if (row.node_type === 'folder') {
            label.textContent = row.name;
            label.className = 'c-folder-label';
        } else {
            label.innerHTML = `<b>${esc(row.method || 'GET')}</b> ${esc(row.name || '')}`;
            label.className = 'c-name';
        }

        const actions = document.createElement('span');
        actions.className = 'c-actions';
        const renBtn = document.createElement('button');
        renBtn.type = 'button';
        renBtn.className = 'c-act-btn';
        renBtn.textContent = 'Ren';
        renBtn.title = 'Rename';
        renBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newName = prompt('New name', row.name);
            if (!newName || newName === row.name) return;
            await api.requestEditorSaveCollectionNode?.({ ...row, name: newName });
            loadCollectionsTree();
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'c-act-btn c-act-del';
        delBtn.textContent = 'Del';
        delBtn.title = 'Delete';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete "${row.name}"?`)) return;
            await api.requestEditorDeleteCollectionNode?.(row.id);
            loadCollectionsTree();
        });
        actions.append(renBtn, delBtn);

        div.append(label, actions);
        div.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.c-node').forEach(n => n.classList.remove('active'));
            div.classList.add('active');
            if (row.node_type === 'folder') {
                selectedCollectionFolderId = row.id;
            } else {
                selectedCollectionFolderId = row.parent_id || null;
                loadCollectionRequest(row);
            }
        });
        tree.appendChild(div);
    }
}

function loadCollectionRequest(row) {
    methodSel.value = row.method || 'GET';
    methodSel.className = methodSel.value;
    urlIn.value = row.url || '';
    try {
        state.params = [];
        const pj = row.params_json ? JSON.parse(row.params_json) : [];
        if (Array.isArray(pj)) {
            pj.forEach(x => state.params.push({
                id: nid(), on: x.on !== false, key: x.key || '', value: x.value || '',
            }));
        }
    } catch { state.params = []; }
    try {
        state.headers = [];
        const h = row.headers_json ? JSON.parse(row.headers_json) : {};
        for (const [k, v] of Object.entries(h)) {
            state.headers.push({ id: nid(), on: true, key: k, value: v });
        }
    } catch { state.headers = []; }
    state.bodyType = row.body_type || 'none';
    setBodyText(row.body || '');
    try {
        state.formFields = [];
        const ff = row.form_fields_json ? JSON.parse(row.form_fields_json) : [];
        if (Array.isArray(ff)) ff.forEach(x => state.formFields.push({ id: nid(), on: true, key: x.key, value: x.value }));
    } catch { /* ignore */ }
    try {
        state.multipart = [];
        const mp = row.multipart_json ? JSON.parse(row.multipart_json) : [];
        if (Array.isArray(mp)) mp.forEach(x => state.multipart.push({
            id: nid(), on: true, key: x.key, kind: x.kind || 'text', value: x.value, filePath: x.filePath, fileName: x.fileName,
        }));
    } catch { /* ignore */ }
    try {
        const auth = row.auth_json ? JSON.parse(row.auth_json) : null;
        if (auth) setAuthState(auth);
    } catch { /* ignore */ }
    const radio = document.querySelector(`[name=btype][value="${state.bodyType}"]`);
    if (radio) radio.checked = true;
    if (state.params.length) renderParams();
    else parseUrlToParams(urlIn.value);
    renderHeaders();
    renderFormFields();
    renderMultipart();
    updateBodyUI();
    syncBodyEditorLanguage();
    updateCounts();
}

document.getElementById('new-folder-btn')?.addEventListener('click', async () => {
    const name = prompt('Folder name', 'New folder');
    if (!name) return;
    await api.requestEditorSaveCollectionNode?.({ node_type: 'folder', name, sort_order: 0 });
    loadCollectionsTree();
});

document.getElementById('save-collection-btn')?.addEventListener('click', async () => {
    const folders = collectionRows.filter(r => r.node_type === 'folder');
    let folderHint = '';
    if (selectedCollectionFolderId) {
        const f = folders.find(r => r.id === selectedCollectionFolderId);
        if (f) folderHint = ` (into "${f.name}")`;
    }
    const name = prompt(`Request name${folderHint}`, 'My request');
    if (!name) return;
    const payload = {
        node_type: 'request',
        name,
        sort_order: 0,
        parent_id: selectedCollectionFolderId,
        method: methodSel.value,
        url: buildUrlWithParams(),
        params_json: JSON.stringify(state.params),
        headers_json: JSON.stringify(Object.fromEntries(
            state.headers.filter(h => h.on && h.key).map(h => [h.key, h.value]),
        )),
        body: getBodyText(),
        body_type: state.bodyType,
        auth_json: JSON.stringify(getAuthState()),
        form_fields_json: JSON.stringify(state.formFields.map(f => ({ key: f.key, value: f.value }))),
        multipart_json: JSON.stringify(state.multipart.map(m => ({
            key: m.key, kind: m.kind, value: m.value, filePath: m.filePath, fileName: m.fileName,
        }))),
    };
    await api.requestEditorSaveCollectionNode?.(payload);
    loadCollectionsTree();
});

let envRows = [];
async function refreshEnvironments() {
    const r = await api.requestEditorListEnvironments?.();
    if (!r || !r.success) return;
    envRows = r.rows || [];
    const sel = document.getElementById('env-select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">No environment</option>';
    for (const row of envRows) {
        const o = document.createElement('option');
        o.value = String(row.id);
        o.textContent = row.name;
        sel.appendChild(o);
    }
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
}

const envDialog = document.getElementById('env-dialog');
document.getElementById('env-manage-btn')?.addEventListener('click', async () => {
    await refreshEnvironments();
    renderEnvList();
    envDialog?.showModal();
});

function renderEnvList() {
    const list = document.getElementById('env-list');
    if (!list) return;
    list.innerHTML = '';
    for (const row of envRows) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sm-btn';
        b.style.display = 'block';
        b.style.width = '100%';
        b.style.textAlign = 'left';
        b.style.marginBottom = '4px';
        b.textContent = row.name;
        b.addEventListener('click', () => {
            document.getElementById('env-edit-id').value = String(row.id);
            document.getElementById('env-edit-name').value = row.name;
            document.getElementById('env-edit-vars').value = row.variables_json || '{}';
        });
        list.appendChild(b);
    }
}

document.getElementById('env-add-btn')?.addEventListener('click', () => {
    document.getElementById('env-edit-id').value = '';
    document.getElementById('env-edit-name').value = 'New';
    document.getElementById('env-edit-vars').value = '{}';
});

document.getElementById('env-save-btn')?.addEventListener('click', async () => {
    const id = document.getElementById('env-edit-id').value;
    const name = document.getElementById('env-edit-name').value;
    let vars = document.getElementById('env-edit-vars').value;
    try { JSON.parse(vars); } catch { alert('Invalid JSON'); return; }
    await api.requestEditorUpsertEnvironment?.({ id: id ? Number(id) : undefined, name, variables_json: vars });
    await refreshEnvironments();
    renderEnvList();
});

document.getElementById('env-delete-btn')?.addEventListener('click', async () => {
    const id = document.getElementById('env-edit-id').value;
    if (!id) return;
    await api.requestEditorDeleteEnvironment?.(Number(id));
    await refreshEnvironments();
    renderEnvList();
});

document.getElementById('env-close')?.addEventListener('click', () => envDialog?.close());

const importDialog = document.getElementById('import-dialog');
document.getElementById('import-btn')?.addEventListener('click', () => {
    importDialog?.showModal();
});
document.getElementById('import-close')?.addEventListener('click', () => importDialog?.close());
document.getElementById('import-apply')?.addEventListener('click', () => {
    const ta = document.getElementById('import-ta');
    const raw = ta.value.trim();
    if (!raw) return;
    let parsed = null;
    if (raw.startsWith('{')) {
        try {
            const j = JSON.parse(raw);
            parsed = window.CupNetParsePostman?.(j);
        } catch { /* ignore */ }
    }
    if (!parsed) parsed = window.CupNetParseCurl?.(raw);
    if (!parsed) {
        alert('Could not parse cURL or Postman collection');
        return;
    }
    methodSel.value = parsed.method || 'GET';
    methodSel.className = methodSel.value;
    urlIn.value = parsed.url || '';
    state.headers = [];
    for (const [k, v] of Object.entries(parsed.headers || {})) {
        state.headers.push({ id: nid(), on: true, key: k, value: String(v) });
    }
    if (parsed.body) {
        try { JSON.parse(parsed.body); state.bodyType = 'json'; } catch { state.bodyType = 'raw'; }
        document.querySelector(`[name=btype][value="${state.bodyType}"]`).checked = true;
        setBodyText(parsed.body);
    }
    parseUrlToParams(urlIn.value);
    renderHeaders();
    renderFormFields();
    updateBodyUI();
    syncBodyEditorLanguage();
    updateCounts();
    importDialog.close();
});

const codegenDialog = document.getElementById('codegen-dialog');
document.getElementById('codegen-btn')?.addEventListener('click', () => {
    updateCodegenOut();
    codegenDialog?.showModal();
});
document.getElementById('codegen-close')?.addEventListener('click', () => codegenDialog?.close());
document.getElementById('codegen-lang')?.addEventListener('change', updateCodegenOut);
function updateCodegenOut() {
    const lang = document.getElementById('codegen-lang').value;
    const hdr = {};
    for (const h of state.headers) {
        if (h.on && h.key) hdr[h.key] = applyTemplate(h.value);
    }
    const merged = mergeAuthIntoRequest(buildUrlWithParams(), hdr);
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(methodSel.value) ? '' : applyTemplate(getBodyText());
    const out = window.CupNetCodegen?.generateRequestCode(lang, {
        method: methodSel.value,
        url: merged.url,
        headers: merged.headers,
        body,
    });
    document.getElementById('codegen-out').value = out || '';
}
document.getElementById('codegen-copy')?.addEventListener('click', () => {
    const t = document.getElementById('codegen-out').value;
    navigator.clipboard.writeText(t).catch(() => {});
});

document.getElementById('open-cookie-manager-btn')?.addEventListener('click', () => {
    api.openCookieManager?.(null);
});

function syncAuthPanels() {
    const t = document.getElementById('auth-type')?.value || 'none';
    const show = {
        bearer: 'auth-bearer',
        basic: 'auth-basic',
        apikey: 'auth-apikey',
        custom: 'auth-custom',
    };
    for (const id of ['auth-bearer', 'auth-basic', 'auth-apikey', 'auth-custom']) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('panel-hidden', show[t] !== id);
    }
}
document.getElementById('auth-type')?.addEventListener('change', syncAuthPanels);

function initFromData(data) {
    if (!data) return;
    document.querySelectorAll('.body-missing-warn').forEach(el => el.remove());
    const m = (data.method || 'GET').toUpperCase();
    methodSel.value = m;
    methodSel.className = m;
    if (data.url) {
        urlIn.value = data.url;
        parseUrlToParams(data.url);
    }
    state.headers = [];
    for (const [k, v] of Object.entries(data.headers || {})) {
        state.headers.push({ id: nid(), on: true, key: k, value: v });
    }
    if (data.body && data.body.trim()) {
        let detected = 'raw';
        try { JSON.parse(data.body); detected = 'json'; } catch { /* ignore */ }
        const ctHeader = Object.entries(data.headers || {}).find(([k]) => k.toLowerCase() === 'content-type');
        if (ctHeader) {
            const ct = String(ctHeader[1]).toLowerCase();
            if (ct.includes('json')) detected = 'json';
            else if (ct.includes('x-www-form-urlencoded')) detected = 'form-urlencoded';
        }
        if (detected === 'form-urlencoded') {
            state.bodyType = 'form-urlencoded';
            document.querySelector('[name=btype][value=form-urlencoded]').checked = true;
            try {
                const params = new URLSearchParams(data.body);
                state.formFields = [];
                params.forEach((v, k) => state.formFields.push({ id: nid(), on: true, key: k, value: v }));
            } catch { /* ignore */ }
        } else {
            state.bodyType = detected;
            document.querySelector(`[name=btype][value=${detected}]`).checked = true;
            setBodyText(detected === 'json' ? tryFormatJson(data.body) : data.body);
        }
    }
    renderParams();
    renderHeaders();
    renderFormFields();
    renderMultipart();
    updateBodyUI();
    syncBodyEditorLanguage();
    updateCounts();
    if (['POST', 'PUT', 'PATCH'].includes(m) && state.bodyType === 'none') {
        const warn = document.createElement('div');
        warn.className = 'body-missing-warn';
        warn.innerHTML = 'Original body was not captured. Add it in the <b>Body</b> tab.';
        const bodyTab = document.getElementById('tab-body');
        if (bodyTab) bodyTab.prepend(warn);
        document.querySelector('#req-tabs [data-tab="body"]')?.click();
    }
}

if (api.onRequestEditorInit) api.onRequestEditorInit(initFromData);

document.addEventListener('keydown', e => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'Enter') { e.preventDefault(); sendRequest(); }
    if (meta && e.key === 'l') { e.preventDefault(); urlIn.focus(); }
    if (meta && e.key === 's') { e.preventDefault(); document.getElementById('save-collection-btn')?.click(); }
    if (meta && e.key === 'i') { e.preventDefault(); importDialog?.showModal(); }
});

loadLayout();
loadHistory();
initCodeMirror();
updateBodyUI();
syncAuthPanels();
refreshEnvironments();
if (htmlPreviewRefreshBtn) {
    htmlPreviewRefreshBtn.addEventListener('click', () => renderHtmlPreview(lastResponseBody, lastResponseCT));
}

function renderPrettyInto(container, text) {
    if (!container) return;
    container.innerHTML = '';
    if (!text || !text.trim()) {
        container.innerHTML = '<div class="jt-not-json">No response body</div>';
        return;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
        container.innerHTML = '<div class="jt-not-json">Not valid JSON — use Raw tab</div>';
        return;
    }
    container.appendChild(buildJsonNode(parsed, null, true));
}

function buildJsonNode(value, key, isRoot = false, isLast = true) {
    const wrapper = document.createElement('div');
    wrapper.className = 'jt-node';
    const row = document.createElement('div');
    row.className = 'jt-row';
    if (value !== null && typeof value === 'object') {
        const isArr = Array.isArray(value);
        const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
        const count = entries.length;
        const open = isArr ? '[' : '{';
        const close = isArr ? ']' : '}';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'jt-toggle';
        row.appendChild(toggle);
        if (key !== null) {
            const keyEl = document.createElement('span');
            keyEl.className = 'jt-key';
            keyEl.textContent = isArr ? String(key) : `"${key}"`;
            const colon = document.createElement('span');
            colon.className = 'jt-colon'; colon.textContent = ':';
            row.appendChild(keyEl); row.appendChild(colon);
        }
        const braceOpen = document.createElement('span');
        braceOpen.className = 'jt-brace'; braceOpen.textContent = open;
        row.appendChild(braceOpen);
        const summary = document.createElement('span');
        summary.className = 'jt-summary';
        summary.textContent = count === 0 ? '' : (isArr ? `${count} items` : `${count} keys`);
        row.appendChild(summary);
        wrapper.appendChild(row);
        if (count === 0) {
            const braceClose = document.createElement('span');
            braceClose.className = 'jt-brace'; braceClose.textContent = close + (isLast ? '' : ',');
            row.appendChild(braceClose);
            toggle.style.display = 'none';
            summary.style.display = 'none';
        } else {
            const children = document.createElement('div');
            children.className = 'jt-children';
            entries.forEach(([k, v], idx) => {
                children.appendChild(buildJsonNode(v, k, false, idx === entries.length - 1));
            });
            wrapper.appendChild(children);
            const closeRow = document.createElement('div');
            closeRow.className = 'jt-row';
            const ph = document.createElement('span'); ph.className = 'jt-placeholder';
            const braceClose = document.createElement('span');
            braceClose.className = 'jt-brace';
            braceClose.textContent = close + (isLast ? '' : ',');
            closeRow.appendChild(ph); closeRow.appendChild(braceClose);
            wrapper.appendChild(closeRow);
            toggle.addEventListener('click', e => {
                e.stopPropagation();
                const collapsed = toggle.classList.toggle('collapsed');
                children.classList.toggle('hidden', collapsed);
                closeRow.style.display = collapsed ? 'none' : '';
                summary.style.display = collapsed ? '' : 'none';
            });
            summary.style.display = 'none';
        }
    } else {
        const ph = document.createElement('span'); ph.className = 'jt-placeholder';
        row.appendChild(ph);
        if (key !== null) {
            const keyEl = document.createElement('span');
            keyEl.className = 'jt-key';
            keyEl.textContent = `"${key}"`;
            const colon = document.createElement('span');
            colon.className = 'jt-colon'; colon.textContent = ':';
            row.appendChild(keyEl); row.appendChild(colon);
        }
        const valEl = document.createElement('span');
        if (value === null) valEl.className = 'jt-null', valEl.textContent = 'null';
        else if (typeof value === 'boolean') valEl.className = 'jt-bool', valEl.textContent = String(value);
        else if (typeof value === 'number') valEl.className = 'jt-num', valEl.textContent = String(value);
        else {
            valEl.className = 'jt-str';
            const display = value.length > 200 ? value.slice(0, 200) + '…' : value;
            valEl.textContent = `"${display}"`;
            valEl.title = 'Click to copy';
            valEl.addEventListener('click', () => {
                navigator.clipboard.writeText(value).catch(() => {});
            });
        }
        row.appendChild(valEl);
        if (!isLast) {
            const comma = document.createElement('span');
            comma.className = 'jt-comma'; comma.textContent = ',';
            row.appendChild(comma);
        }
        wrapper.appendChild(row);
    }
    return wrapper;
}

function renderHtmlPreview(html, ct) {
    if (!htmlPreviewIframe || !htmlPreviewEmpty) return;
    const ctStr = String(ct || '');
    const isHtml = ctStr.includes('html') || /<html|<!doctype/i.test((html || '').slice(0, 500));
    if (!html || !isHtml) {
        htmlPreviewIframe.style.display = 'none';
        htmlPreviewEmpty.style.display = '';
        htmlPreviewEmpty.textContent = html ? 'Response is not HTML' : 'No HTML response';
        return;
    }
    const cspTag = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; script-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none';">`;
    let safeHtml = html;
    if (/<head[\s>]/i.test(safeHtml)) safeHtml = safeHtml.replace(/(<head[^>]*>)/i, `$1${cspTag}`);
    else if (/<html[\s>]/i.test(safeHtml)) safeHtml = safeHtml.replace(/(<html[^>]*>)/i, `$1<head>${cspTag}</head>`);
    else safeHtml = `<html><head>${cspTag}</head><body>${safeHtml}</body></html>`;
    htmlPreviewIframe.srcdoc = safeHtml;
    htmlPreviewIframe.style.display = '';
    htmlPreviewEmpty.style.display = 'none';
}
