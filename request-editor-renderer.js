'use strict';

const api = window.electronAPI;

// ─── Forbidden headers (Fetch API spec + Electron-specific) ───────────────────
const FETCH_ONLY_FORBIDDEN = new Set([
    'accept-charset','accept-encoding','access-control-request-headers',
    'access-control-request-method','connection','content-length',
    'cookie2','date','dnt','expect','keep-alive',
    'te','trailer','transfer-encoding','upgrade','via',
]);

function isRestricted(name) {
    if (!name) return false;
    const lo = name.toLowerCase().trim();
    return FETCH_ONLY_FORBIDDEN.has(lo) || lo.startsWith('proxy-');
}

const METHOD_COLORS = {
    GET:'#22c55e', POST:'#60a5fa', PUT:'#fb923c',
    DELETE:'#f87171', PATCH:'#fbbf24', HEAD:'#c084fc', OPTIONS:'#9ca3af',
};

// ─── State ────────────────────────────────────────────────────────────────────
let uid = 1;
const nid = () => uid++;

const state = {
    params:     [],
    headers:    [],
    formFields: [],
    bodyType:   'none',
};

// ─── DOM ──────────────────────────────────────────────────────────────────────
const methodSel       = document.getElementById('method-select');
const urlIn           = document.getElementById('url-input');
const sendBtn         = document.getElementById('send-btn');
const copyCurlBtn     = document.getElementById('copy-curl-btn');
const historyToggleBtn= document.getElementById('history-toggle-btn');
const respPill        = document.getElementById('resp-pill');
const proxyInfoName   = document.getElementById('proxy-info-name');
const proxyInfoWrap   = document.getElementById('proxy-info-wrap');
const historyPane     = document.getElementById('history-pane');
const historyList     = document.getElementById('history-list');
const historyEmpty    = document.getElementById('history-empty');

const paramsTbody  = document.getElementById('params-tbody');
const headersTbody = document.getElementById('headers-tbody');
const formTbody    = document.getElementById('form-tbody');
const bodyTA       = document.getElementById('body-textarea');
const bodyNone     = document.getElementById('body-none-msg');
const formBody     = document.getElementById('form-body');
const bodyCtHint   = document.getElementById('body-ct-hint');
const formatJsonBtn= document.getElementById('format-json-btn');

const cntParams    = document.getElementById('cnt-params');
const cntHeaders   = document.getElementById('cnt-headers');
const cntBody      = document.getElementById('cnt-body');
const cntRespH     = document.getElementById('cnt-resp-headers');

const respEmpty    = document.getElementById('resp-empty');
const respContent  = document.getElementById('resp-content');
const riStatus     = document.getElementById('ri-status');
const riTime       = document.getElementById('ri-time');
const riSize       = document.getElementById('ri-size');
const respActions  = document.getElementById('resp-actions');
const respBodyEl      = document.getElementById('tab-body-resp');
const respPrettyEl    = document.getElementById('tab-pretty-resp');
const respHtmlEl      = document.getElementById('tab-html-resp');
const respHTbody      = document.getElementById('resp-headers-tbody');
const htmlPreviewIframe = document.getElementById('html-preview-iframe');
const htmlPreviewEmpty  = document.getElementById('html-preview-empty');
const htmlPreviewRefreshBtn = document.getElementById('html-preview-refresh');

let lastResponseBody = '';
let lastResponseCT   = '';
const LAYOUT_KEY = 'cupnet-request-editor-layout-v1';
const HISTORY_KEY = 'cupnet-request-editor-history-v1';
const MAX_HISTORY = 24;
let requestHistory = [];
let activeHistoryId = null;
let pendingHistoryId = null;

// ─── Utilities ────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function tryFormatJson(str) {
    try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

function statusCls(c) {
    if (c >= 200 && c < 300) return 'c2';
    if (c >= 300 && c < 400) return 'c3';
    if (c >= 400 && c < 500) return 'c4';
    return 'c5';
}
function statusPill(c) {
    if (c >= 200 && c < 300) return 's2';
    if (c >= 300 && c < 400) return 's3';
    if (c >= 400 && c < 500) return 's4';
    return 's5';
}
function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function fmtTime(ts) {
    try {
        return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}
function shortUrl(u) {
    try {
        const x = new URL(u);
        return (x.host + x.pathname).slice(0, 56) + ((x.host + x.pathname).length > 56 ? '…' : '');
    } catch {
        return String(u || '').slice(0, 56);
    }
}

// ─── URL ↔ Params sync ────────────────────────────────────────────────────────
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
    } catch {}
}

function buildUrl() {
    const base = urlIn.value.split('?')[0];
    const active = state.params.filter(p => p.on && p.key.trim());
    if (!active.length) return base;
    const qs = active.map(p =>
        `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`
    ).join('&');
    return base + '?' + qs;
}

// ─── Generic KV table ─────────────────────────────────────────────────────────
function renderKvTable(tbody, rows, onChange, onDelete) {
    tbody.innerHTML = '';
    for (const row of rows) {
        const tr = document.createElement('tr');
        tr.className = 'kv-row' + (row.on ? '' : ' disabled');

        // Checkbox
        const tdC = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.checked = row.on;
        chk.addEventListener('change', () => {
            row.on = chk.checked;
            tr.classList.toggle('disabled', !chk.checked);
            onChange();
        });
        tdC.appendChild(chk);

        // Key
        const tdK = document.createElement('td');
        const keyIn = document.createElement('input');
        keyIn.className = 'kv-input'; keyIn.value = row.key || '';
        keyIn.placeholder = 'Key'; keyIn.spellcheck = false;
        keyIn.addEventListener('input', () => { row.key = keyIn.value; onChange(); });
        tdK.appendChild(keyIn);

        // Value
        const tdV = document.createElement('td');
        const valIn = document.createElement('input');
        valIn.className = 'kv-input'; valIn.value = row.value || '';
        valIn.placeholder = 'Value'; valIn.spellcheck = false;
        valIn.addEventListener('input', () => { row.value = valIn.value; onChange(); });
        tdV.appendChild(valIn);

        // Delete
        const tdD = document.createElement('td'); tdD.className = 'kv-del';
        const delBtn = document.createElement('button');
        delBtn.className = 'kv-del-btn'; delBtn.textContent = '×';
        delBtn.addEventListener('click', () => onDelete(row.id));
        tdD.appendChild(delBtn);

        tr.append(tdC, tdK, tdV, tdD);
        tbody.appendChild(tr);
    }
}

// ─── Params ───────────────────────────────────────────────────────────────────
function renderParams() {
    renderKvTable(
        paramsTbody, state.params,
        () => { urlIn.value = buildUrl(); updateCounts(); },
        id => { state.params = state.params.filter(p => p.id !== id); renderParams(); updateCounts(); }
    );
}

document.getElementById('add-param-btn').addEventListener('click', () => {
    state.params.push({ id: nid(), on: true, key: '', value: '' });
    renderParams(); updateCounts();
});

// ─── Headers (with restriction badge) ────────────────────────────────────────
function renderHeaders() {
    headersTbody.innerHTML = '';
    for (const row of state.headers) {
        const tr = document.createElement('tr');
        tr.className = 'kv-row' + (row.on ? '' : ' disabled');

        // Checkbox
        const tdC = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.checked = row.on;
        chk.addEventListener('change', () => {
            row.on = chk.checked;
            tr.classList.toggle('disabled', !chk.checked);
            updateCounts();
        });
        tdC.appendChild(chk);

        // Key + restriction badge
        const tdK = document.createElement('td');
        const kWrap = document.createElement('div');
        kWrap.style.cssText = 'display:flex;align-items:center;gap:3px';

        const keyIn = document.createElement('input');
        keyIn.className = 'kv-input'; keyIn.value = row.key || '';
        keyIn.placeholder = 'Header name'; keyIn.spellcheck = false;

        const star = document.createElement('span');
        star.className = 'restrict-star' + (isRestricted(row.key) ? ' show' : '');
        star.textContent = '★';
        star.title = 'This header may be ignored when using Electron net.fetch fallback (works fine with AzureTLS/MITM proxy)';

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

        // Value
        const tdV = document.createElement('td');
        const valIn = document.createElement('input');
        valIn.className = 'kv-input'; valIn.value = row.value || '';
        valIn.placeholder = 'Value'; valIn.spellcheck = false;
        valIn.addEventListener('input', () => { row.value = valIn.value; });
        tdV.appendChild(valIn);

        // Delete
        const tdD = document.createElement('td'); tdD.className = 'kv-del';
        const delBtn = document.createElement('button');
        delBtn.className = 'kv-del-btn'; delBtn.textContent = '×';
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

// ─── Form fields ──────────────────────────────────────────────────────────────
function renderFormFields() {
    renderKvTable(
        formTbody, state.formFields,
        () => updateCounts(),
        id => { state.formFields = state.formFields.filter(f => f.id !== id); renderFormFields(); updateCounts(); }
    );
}

document.getElementById('add-form-btn').addEventListener('click', () => {
    state.formFields.push({ id: nid(), on: true, key: '', value: '' });
    renderFormFields(); updateCounts();
});

// ─── Body type ────────────────────────────────────────────────────────────────
const CT_HINT = {
    none: '', raw: '',
    json: 'Sets: Content-Type: application/json',
    'form-urlencoded': 'Sets: Content-Type: application/x-www-form-urlencoded',
};

document.querySelectorAll('[name=btype]').forEach(r => {
    r.addEventListener('change', () => {
        if (!r.checked) return;
        state.bodyType = r.value;
        updateBodyUI();
        updateCounts();
    });
});

function updateBodyUI() {
    const t = state.bodyType;
    bodyNone.style.display   = t === 'none' ? '' : 'none';
    bodyTA.style.display     = (t === 'raw' || t === 'json') ? '' : 'none';
    formBody.style.display   = t === 'form-urlencoded' ? 'flex' : 'none';
    bodyCtHint.textContent   = CT_HINT[t] || '';
    formatJsonBtn.style.display = t === 'json' ? '' : 'none';
    document.querySelectorAll('.bt-opt').forEach(l => {
        l.classList.toggle('sel', l.querySelector('input')?.value === t);
    });
}

formatJsonBtn.addEventListener('click', () => {
    bodyTA.value = tryFormatJson(bodyTA.value);
});

// ─── Counts ───────────────────────────────────────────────────────────────────
function updateCounts() {
    const pc = state.params.filter(p => p.on && p.key).length;
    const hc = state.headers.filter(h => h.on && h.key).length;
    cntParams.textContent = pc || 0;
    cntParams.classList.toggle('on', pc > 0);
    cntHeaders.textContent = hc || 0;
    cntHeaders.classList.toggle('on', hc > 0);
    const hasBody = state.bodyType !== 'none';
    cntBody.textContent = hasBody ? '●' : '—';
    cntBody.classList.toggle('on', hasBody);
}

// ─── Tab switching ────────────────────────────────────────────────────────────
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
        // Lazy-render on tab switch
        if (tab === 'pretty') renderPrettyInto(respPrettyEl, lastResponseBody);
        if (tab === 'html')   renderHtmlPreview(lastResponseBody, lastResponseCT);
    });
});

if (htmlPreviewRefreshBtn) {
    htmlPreviewRefreshBtn.addEventListener('click', () => {
        renderHtmlPreview(lastResponseBody, lastResponseCT);
    });
}

// ─── URL input ────────────────────────────────────────────────────────────────
urlIn.addEventListener('paste', () => {
    requestAnimationFrame(() => parseUrlToParams(urlIn.value));
});
urlIn.addEventListener('blur', () => {
    parseUrlToParams(urlIn.value);
});

// ─── Method ───────────────────────────────────────────────────────────────────
methodSel.addEventListener('change', () => {
    methodSel.className = methodSel.value;
});

// ─── Resizable divider ────────────────────────────────────────────────────────
const divH    = document.getElementById('divider-h');
const reqPane = document.getElementById('req-pane');
const splitEl = document.getElementById('split');
let drag = false, dragX = 0, dragW = 0;

divH.addEventListener('mousedown', e => {
    drag = true; dragX = e.clientX;
    dragW = reqPane.getBoundingClientRect().width;
    divH.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
});
document.addEventListener('mousemove', e => {
    if (!drag) return;
    const histW = historyPane && !historyPane.classList.contains('collapsed')
        ? Math.round(historyPane.getBoundingClientRect().width)
        : 0;
    const minReqW = 360;
    const minRespW = 300;
    const maxW = Math.max(minReqW, (splitEl?.clientWidth || window.innerWidth) - minRespW - histW);
    const w = Math.max(minReqW, Math.min(dragW + (e.clientX - dragX), maxW));
    reqPane.style.width = w + 'px';
});
document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = false;
    divH.classList.remove('dragging');
    document.body.style.userSelect = '';
    saveLayout();
});

// ─── Send request ─────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendRequest);
urlIn.addEventListener('keydown', e => { if (e.key === 'Enter') sendRequest(); });

// ─── Current proxy info ───────────────────────────────────────────────────────
function applyProxyInfo(info) {
    if (!proxyInfoName) return;
    if (info && info.active && info.proxyName) {
        proxyInfoName.textContent = info.proxyName;
        proxyInfoName.className = 'active';
        if (proxyInfoWrap) proxyInfoWrap.title = `${info.proxyName}\nTLS fingerprint — from Proxy Manager session settings`;
    } else {
        proxyInfoName.textContent = 'Direct';
        proxyInfoName.className = 'direct';
        if (proxyInfoWrap) proxyInfoWrap.title = 'No proxy — direct connection\nTLS fingerprint — from Proxy Manager session settings';
    }
}

function refreshProxyInfo() {
    if (!api.getCurrentProxy) return;
    api.getCurrentProxy().then(applyProxyInfo).catch(() => {
        if (proxyInfoName) { proxyInfoName.textContent = '—'; proxyInfoName.className = ''; }
    });
}

// Initial load
refreshProxyInfo();

// Live update when proxy changes
if (api.onProxyStatusChanged) {
    api.onProxyStatusChanged(applyProxyInfo);
}

async function sendRequest() {
    const url = buildUrl().trim();
    if (!url) { urlIn.focus(); return; }

    const method = methodSel.value;
    pendingHistoryId = pushHistorySnapshot({
        method,
        url,
        headers: state.headers,
        bodyType: state.bodyType,
        bodyText: bodyTA.value,
        formFields: state.formFields,
    });

    // Collect headers
    const headers = {};
    for (const h of state.headers) {
        if (h.on && h.key.trim()) headers[h.key.trim()] = h.value;
    }

    // Collect body
    let body;
    const noBody = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (!noBody && state.bodyType !== 'none') {
        if (state.bodyType === 'json') {
            body = bodyTA.value;
            if (!headers['content-type'] && !headers['Content-Type'])
                headers['Content-Type'] = 'application/json';
        } else if (state.bodyType === 'raw') {
            body = bodyTA.value;
        } else if (state.bodyType === 'form-urlencoded') {
            body = state.formFields
                .filter(f => f.on && f.key)
                .map(f => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`)
                .join('&');
            if (!headers['content-type'] && !headers['Content-Type'])
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
    }

    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span class="spin"></span> Sending…';
    respPill.className = ''; respPill.style.display = 'none';
    respEmpty.style.display = 'flex';
    respContent.style.display = 'none';

    try {
        const r = await api.executeRequest({ method, url, headers, body });
        renderResponse(r);
    } catch (e) {
        renderError(e.message);
    } finally {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '▶ Send';
    }
}

// ─── Render response ──────────────────────────────────────────────────────────
function renderResponse(r) {
    if (!r.success) { renderError(r.error || 'Unknown error'); return; }

    // Status pill
    respPill.className = statusPill(r.status);
    respPill.textContent = `${r.status} ${r.statusText || ''}`;
    respPill.style.display = '';

    // Info bar
    const cls = statusCls(r.status);
    riStatus.innerHTML = `<span class="${cls}" style="font-weight:700;font-size:14px">${r.status}</span>`
        + ` <span style="color:#9ca3af">${esc(r.statusText || '')}</span>`;
    riTime.innerHTML = `<span style="color:#6b7280">Time:</span> <b>${r.duration}ms</b>`;
    riSize.innerHTML = `<span style="color:#6b7280">Size:</span> <b>${fmtBytes(new Blob([r.body||'']).size)}</b>`
        + (r.tlsProfile ? ` &nbsp;<span style="color:#3b82f6;font-size:11px">🛡 TLS: ${r.tlsProfile}</span>` : '');

    // Body — headers values may be arrays (HTTP/2 multi-value), normalize to string
    const ctRaw = r.headers['content-type'] || r.headers['Content-Type'] || '';
    const ct = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw).toLowerCase();
    const rawBody = r.body || '';
    lastResponseBody = rawBody;
    lastResponseCT   = ct;

    // Raw tab
    respBodyEl.textContent = ct.includes('json') ? tryFormatJson(rawBody) : rawBody;

    // Pre-render Pretty if already on that tab; else leave lazy
    if (respPrettyEl?.classList.contains('active')) {
        renderPrettyInto(respPrettyEl, rawBody);
    } else {
        // Clear stale tree so switching will re-render fresh
        if (respPrettyEl) respPrettyEl.innerHTML = '';
    }
    // Clear HTML preview
    if (htmlPreviewIframe) { htmlPreviewIframe.srcdoc = ''; htmlPreviewIframe.style.display = 'none'; }
    if (htmlPreviewEmpty) htmlPreviewEmpty.style.display = '';

    // Response headers
    respHTbody.innerHTML = '';
    const hEntries = Object.entries(r.headers || {});
    cntRespH.textContent = hEntries.length;
    for (const [k, v] of hEntries) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td style="padding:3px 8px;color:#93c5fd;font-family:monospace;font-size:12px;white-space:nowrap">${esc(k)}</td>
                        <td style="padding:3px 8px;font-family:monospace;font-size:12px;word-break:break-all">${esc(v)}</td>`;
        respHTbody.appendChild(tr);
    }

    // Action buttons
    respActions.innerHTML = '';
    const copyBodyBtn = btn('Copy body', () => navigator.clipboard.writeText(r.body || ''));
    const copyCurlBtn2 = btn('Copy cURL', () => navigator.clipboard.writeText(buildCurl()));
    respActions.append(copyBodyBtn, copyCurlBtn2);

    respEmpty.style.display = 'none';
    respContent.style.display = 'flex';

    // Auto-switch: JSON → Pretty tab, HTML → HTML tab, else Raw
    if (ct.includes('json')) {
        document.querySelector('#resp-tabs [data-rtab="pretty"]').click();
    } else if (ct.includes('html')) {
        document.querySelector('#resp-tabs [data-rtab="html"]').click();
    } else {
        document.querySelector('#resp-tabs [data-rtab="body"]').click();
    }
    if (pendingHistoryId) {
        updateHistoryResult(pendingHistoryId, { status: r.status, ok: true });
        pendingHistoryId = null;
    }
}

function renderError(msg) {
    respPill.className = 'err'; respPill.textContent = 'Error'; respPill.style.display = '';
    riStatus.innerHTML = `<span style="color:#f87171">Request Failed</span>`;
    riTime.textContent = ''; riSize.textContent = '';
    respBodyEl.textContent = msg;
    lastResponseBody = msg; lastResponseCT = '';
    if (respPrettyEl) respPrettyEl.innerHTML = '';
    respHTbody.innerHTML = '';
    respEmpty.style.display = 'none';
    respContent.style.display = 'flex';
    document.querySelector('#resp-tabs [data-rtab="body"]').click();
    if (pendingHistoryId) {
        updateHistoryResult(pendingHistoryId, { status: 'ERR', ok: false });
        pendingHistoryId = null;
    }
}

function btn(label, onClick) {
    const b = document.createElement('button');
    b.className = 'sm-btn'; b.textContent = label;
    b.addEventListener('click', () => {
        onClick();
        const orig = b.textContent;
        b.textContent = '✓ Copied';
        setTimeout(() => { b.textContent = orig; }, 1200);
    });
    return b;
}

// ─── Copy as cURL ─────────────────────────────────────────────────────────────
copyCurlBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(buildCurl());
    copyCurlBtn.textContent = '✓ Copied';
    setTimeout(() => { copyCurlBtn.textContent = 'cURL'; }, 1200);
});

function buildCurl() {
    const parts = [`curl -X ${methodSel.value} '${buildUrl()}'`];
    for (const h of state.headers) {
        if (h.on && h.key) parts.push(`  -H '${h.key}: ${h.value.replace(/'/g, "\\'")}'`);
    }
    const t = state.bodyType;
    if (t === 'json' && bodyTA.value)
        parts.push(`  -d '${bodyTA.value.replace(/'/g, "\\'")}'`);
    else if (t === 'raw' && bodyTA.value)
        parts.push(`  --data-raw '${bodyTA.value.replace(/'/g, "\\'")}'`);
    else if (t === 'form-urlencoded') {
        const d = state.formFields.filter(f => f.on && f.key)
            .map(f => `${f.key}=${f.value}`).join('&');
        if (d) parts.push(`  -d '${d}'`);
    }
    return parts.join(' \\\n');
}

// ─── History ──────────────────────────────────────────────────────────────────
function copyRows(rows) {
    return (rows || []).map(r => ({ id: nid(), on: !!r.on, key: r.key || '', value: r.value || '' }));
}
function collectSnapshotBase() {
    return {
        method: methodSel.value,
        url: buildUrl().trim(),
        headers: copyRows(state.headers),
        bodyType: state.bodyType,
        bodyText: bodyTA.value || '',
        formFields: copyRows(state.formFields),
        ts: Date.now(),
    };
}
function pushHistorySnapshot(override = {}) {
    const entry = { id: 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), ...collectSnapshotBase(), ...override };
    requestHistory.unshift(entry);
    if (requestHistory.length > MAX_HISTORY) requestHistory = requestHistory.slice(0, MAX_HISTORY);
    activeHistoryId = entry.id;
    saveHistory();
    renderHistory();
    return entry.id;
}
function updateHistoryResult(id, patch = {}) {
    const h = requestHistory.find(x => x.id === id);
    if (!h) return;
    Object.assign(h, patch);
    saveHistory();
    renderHistory();
}
function applyHistoryEntry(entry) {
    if (!entry) return;
    methodSel.value = entry.method || 'GET';
    methodSel.className = methodSel.value;
    urlIn.value = entry.url || '';
    state.headers = copyRows(entry.headers || []);
    state.bodyType = entry.bodyType || 'none';
    state.formFields = copyRows(entry.formFields || []);
    bodyTA.value = entry.bodyText || '';
    const radio = document.querySelector(`[name=btype][value="${state.bodyType}"]`);
    if (radio) radio.checked = true;
    parseUrlToParams(urlIn.value);
    renderHeaders();
    renderFormFields();
    updateBodyUI();
    updateCounts();
    activeHistoryId = entry.id;
    renderHistory();
}
function renderHistory() {
    if (!historyList) return;
    historyList.innerHTML = '';
    if (!requestHistory.length) {
        if (historyEmpty) historyEmpty.style.display = '';
        return;
    }
    if (historyEmpty) historyEmpty.style.display = 'none';
    for (const h of requestHistory) {
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
function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(requestHistory)); } catch {}
}
function loadHistory() {
    try {
        const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        if (Array.isArray(arr)) requestHistory = arr.slice(0, MAX_HISTORY);
    } catch {}
    renderHistory();
}
function saveLayout() {
    try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({
            reqWidth: reqPane.style.width || '',
            historyCollapsed: historyPane?.classList.contains('collapsed') || false,
        }));
    } catch {}
}
function loadLayout() {
    try {
        const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
        if (v.reqWidth) {
            reqPane.style.width = v.reqWidth;
        } else {
            // Default split: 10% history / 40% request / 50% response.
            reqPane.style.width = '40%';
        }
        if (v.historyCollapsed && historyPane) historyPane.classList.add('collapsed');
    } catch {}
}

historyToggleBtn?.addEventListener('click', () => {
    if (!historyPane) return;
    historyPane.classList.toggle('collapsed');
    saveLayout();
});

// ─── Init from main process ───────────────────────────────────────────────────
function initFromData(data) {
    if (!data) return;

    // Method
    const m = (data.method || 'GET').toUpperCase();
    methodSel.value = m;
    methodSel.className = m;

    // URL (parse query into params)
    if (data.url) {
        urlIn.value = data.url;
        parseUrlToParams(data.url);
    }

    // Headers
    state.headers = [];
    for (const [k, v] of Object.entries(data.headers || {})) {
        state.headers.push({ id: nid(), on: true, key: k, value: v });
    }

    // Body
    if (data.body && data.body.trim()) {
        let detected = 'raw';
        try { JSON.parse(data.body); detected = 'json'; } catch {}

        // Check Content-Type from headers
        const ctHeader = Object.entries(data.headers || {})
            .find(([k]) => k.toLowerCase() === 'content-type');
        if (ctHeader) {
            const ct = ctHeader[1].toLowerCase();
            if (ct.includes('json')) detected = 'json';
            else if (ct.includes('x-www-form-urlencoded')) detected = 'form-urlencoded';
        }

        if (detected === 'form-urlencoded') {
            state.bodyType = 'form-urlencoded';
            document.querySelector('[name=btype][value=form-urlencoded]').checked = true;
            // Parse form fields
            try {
                const params = new URLSearchParams(data.body);
                state.formFields = [];
                params.forEach((v, k) => state.formFields.push({ id: nid(), on: true, key: k, value: v }));
            } catch {}
        } else {
            state.bodyType = detected;
            document.querySelector(`[name=btype][value=${detected}]`).checked = true;
            bodyTA.value = detected === 'json' ? tryFormatJson(data.body) : data.body;
        }
    }

    renderParams();
    renderHeaders();
    renderFormFields();
    updateBodyUI();
    updateCounts();

    // Warn if body is empty for methods that normally have a body
    const bodyMethods = ['POST', 'PUT', 'PATCH'];
    if (bodyMethods.includes(m) && state.bodyType === 'none') {
        const warn = document.createElement('div');
        warn.className = 'body-missing-warn';
        warn.innerHTML = '⚠ Original request body was not captured. Add it manually in the <b>Body</b> tab before sending.';
        const bodyTab = document.getElementById('tab-body');
        if (bodyTab) bodyTab.prepend(warn);
        // Also auto-switch to Body tab
        document.querySelector('#req-tabs [data-tab="body"]')?.click();
    }

    // Keep user-defined split width (persisted in localStorage)
}

if (api.onRequestEditorInit) {
    api.onRequestEditorInit(initFromData);
}

loadLayout();
loadHistory();

// ─── Pretty JSON tree ──────────────────────────────────────────────────────────

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
        // Not JSON — show plain with syntax hint
        container.innerHTML = `<div class="jt-not-json">⚠ Not valid JSON — use the <b>Raw</b> tab to view as plain text</div>`;
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
        const isArr   = Array.isArray(value);
        const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
        const count   = entries.length;
        const open    = isArr ? '[' : '{';
        const close   = isArr ? ']' : '}';

        // Toggle button
        const toggle = document.createElement('button');
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
            // Inline close for empty
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

            // Closing brace row
            const closeRow = document.createElement('div');
            closeRow.className = 'jt-row';
            const ph = document.createElement('span'); ph.className = 'jt-placeholder';
            const braceClose = document.createElement('span');
            braceClose.className = 'jt-brace';
            braceClose.textContent = close + (isLast ? '' : ',');
            closeRow.appendChild(ph); closeRow.appendChild(braceClose);
            wrapper.appendChild(closeRow);

            // Toggle collapse
            toggle.addEventListener('click', e => {
                e.stopPropagation();
                const collapsed = toggle.classList.toggle('collapsed');
                children.classList.toggle('hidden', collapsed);
                closeRow.style.display = collapsed ? 'none' : '';
                summary.style.display  = collapsed ? '' : 'none';
            });
            summary.style.display = 'none'; // visible only when collapsed
        }

    } else {
        // Leaf value
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
        if (value === null) {
            valEl.className = 'jt-null'; valEl.textContent = 'null';
        } else if (typeof value === 'boolean') {
            valEl.className = 'jt-bool'; valEl.textContent = String(value);
        } else if (typeof value === 'number') {
            valEl.className = 'jt-num'; valEl.textContent = String(value);
        } else {
            valEl.className = 'jt-str';
            const display = value.length > 200 ? value.slice(0, 200) + '…' : value;
            valEl.textContent = `"${display}"`;
            valEl.title = 'Click to copy value';
            valEl.addEventListener('click', () => {
                navigator.clipboard.writeText(value).catch(() => {});
                const orig = valEl.textContent;
                valEl.textContent = '✓ copied';
                setTimeout(() => { valEl.textContent = orig; }, 800);
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

// ─── Sandboxed HTML Preview ────────────────────────────────────────────────────

function renderHtmlPreview(html, ct) {
    if (!htmlPreviewIframe || !htmlPreviewEmpty) return;

    const ctStr = String(ct || '');
    const isHtml = ctStr.includes('html') || /<html|<!doctype/i.test((html || '').slice(0, 500));
    if (!html || !isHtml) {
        htmlPreviewIframe.style.display = 'none';
        htmlPreviewEmpty.style.display  = '';
        htmlPreviewEmpty.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/></svg><span>${html ? 'Response is not HTML' : 'No HTML response'}</span>`;
        return;
    }

    // Inject a strict CSP meta tag to block ALL external network activity:
    // - no scripts (no src= scripts, no inline JS)
    // - no external images (only data: and blob: allowed)
    // - no external fonts, frames, objects, media
    // - inline styles OK so the page renders reasonably
    const cspTag = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; script-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none';">`;

    let safeHtml = html;
    if (/<head[\s>]/i.test(safeHtml)) {
        safeHtml = safeHtml.replace(/(<head[^>]*>)/i, `$1${cspTag}`);
    } else if (/<html[\s>]/i.test(safeHtml)) {
        safeHtml = safeHtml.replace(/(<html[^>]*>)/i, `$1<head>${cspTag}</head>`);
    } else {
        safeHtml = `<html><head>${cspTag}</head><body>${safeHtml}</body></html>`;
    }

    htmlPreviewIframe.srcdoc = safeHtml;
    htmlPreviewIframe.style.display = '';
    htmlPreviewEmpty.style.display  = 'none';
}
