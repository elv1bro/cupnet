'use strict';

const api = window.electronAPI;

const compareBtn = document.getElementById('compare-btn');
const refreshBtn = document.getElementById('refresh-btn');
const statusEl = document.getElementById('status');
const leftListEl = document.getElementById('left-list');
const rightListEl = document.getElementById('right-list');
const listsPaneEl = document.getElementById('lists-pane');
const paneLinksEl = document.getElementById('pane-links');
const detailBodyEl = document.getElementById('detail-body');
const levelSelect = document.getElementById('compare-level');
const noiseToggle = document.getElementById('noise-toggle');
const dimensionMode = document.getElementById('dimension-mode');

let state = { left: null, right: null, result: null };
let selectedPairIndex = 0;
let hasAutoCompared = false;
let jsonFilters = { req: 'all', resp: 'all' };
let jsonFocus = { req: false, resp: false };
let _linksRaf = null;

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function methodCls(m) { return String(m || 'GET').toUpperCase(); }
function statusCls(s) { const n = Number(s); if (n >= 200 && n < 300) return 's2'; if (n >= 300 && n < 400) return 's3'; if (n >= 400 && n < 500) return 's4'; if (n >= 500) return 's5'; return ''; }
function truncPath(url, max = 72) { try { const u = new URL(String(url || '')); const p = u.pathname + (u.search ? u.search.slice(0, 30) : ''); return p.length > max ? p.slice(0, max) + '…' : p; } catch { const s = String(url || ''); return s.length > max ? s.slice(0, max) + '…' : s; } }
function tryParseJson(text) { try { return JSON.parse(String(text || '')); } catch { return null; } }
function isLikelyHtml(text) { const s = String(text || '').trim().toLowerCase(); return !!s && (s.startsWith('<!doctype html') || s.startsWith('<html') || s.includes('<body') || s.includes('</html>')); }
function visibleDim(name) { const v = String(dimensionMode?.value || 'all'); return v === 'all' || v === name; }
function statusClassNum(code) { const n = Number(code || 0); return n ? Math.floor(n / 100) : 0; }

function collectJsonDiffKinds(left, right, base = '$', out = [], cap = 120) {
    if (out.length >= cap) return out;
    const lt = Object.prototype.toString.call(left);
    const rt = Object.prototype.toString.call(right);
    if (lt !== rt) { out.push({ path: base, kind: 'type' }); return out; }
    if (left == null || right == null) { if (left !== right) out.push({ path: base, kind: left == null ? 'added' : 'removed' }); return out; }
    if (typeof left !== 'object') { if (left !== right) out.push({ path: base, kind: 'changed' }); return out; }
    if (Array.isArray(left)) {
        const max = Math.max(left.length, right.length);
        for (let i = 0; i < max && out.length < cap; i++) {
            if (i >= left.length) out.push({ path: `${base}[${i}]`, kind: 'added' });
            else if (i >= right.length) out.push({ path: `${base}[${i}]`, kind: 'removed' });
            else collectJsonDiffKinds(left[i], right[i], `${base}[${i}]`, out, cap);
        }
        return out;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const k of keys) {
        if (out.length >= cap) break;
        if (!(k in left)) out.push({ path: `${base}.${k}`, kind: 'added' });
        else if (!(k in right)) out.push({ path: `${base}.${k}`, kind: 'removed' });
        else collectJsonDiffKinds(left[k], right[k], `${base}.${k}`, out, cap);
    }
    return out;
}

function analyzeHtmlSnapshot(text) {
    const raw = String(text || '');
    if (!isLikelyHtml(raw)) return null;
    try {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        const scripts = Array.from(doc.querySelectorAll('script'));
        const scriptSrc = scripts.map(s => s.getAttribute('src')).filter(Boolean);
        const linksCss = Array.from(doc.querySelectorAll('link[rel~="stylesheet"]')).map(l => l.getAttribute('href')).filter(Boolean);
        const forms = Array.from(doc.forms || []);
        const formStats = forms.map((f, idx) => ({ idx, action: f.getAttribute('action') || '', method: (f.getAttribute('method') || 'GET').toUpperCase(), fields: f.querySelectorAll('input,select,textarea,button').length }));
        const orphanFields = Array.from(doc.querySelectorAll('input,select,textarea,button')).filter(el => !el.closest('form')).length;
        const iframes = Array.from(doc.querySelectorAll('iframe'));
        const insecureScripts = scriptSrc.filter(s => /^http:\/\//i.test(s)).length;
        return {
            raw,
            title: (doc.querySelector('title')?.textContent || '').trim(),
            scriptsExternal: scriptSrc.length,
            scriptsInline: scripts.length - scriptSrc.length,
            scriptsList: scriptSrc.slice(0, 16),
            cssExternal: linksCss.length,
            cssList: linksCss.slice(0, 16),
            styleTags: doc.querySelectorAll('style').length,
            formsCount: forms.length,
            formFieldsTotal: formStats.reduce((s, f) => s + f.fields, 0),
            forms: formStats.slice(0, 12),
            orphanFields,
            iframesCount: iframes.length,
            iframeSandboxed: iframes.filter(i => i.hasAttribute('sandbox')).length,
            nodes: doc.querySelectorAll('*').length,
            interactive: doc.querySelectorAll('button,a[href],input,select,textarea').length,
            insecureScripts,
        };
    } catch { return null; }
}

function buildSandboxPreviewDoc(rawHtml) {
    const raw = String(rawHtml || '');
    if (!raw.trim()) return '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#fff;color:#111;padding:12px">Empty preview</body></html>';
    try {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
            if (/refresh/i.test(String(m.getAttribute('http-equiv') || ''))) m.remove();
        });
        doc.querySelectorAll('iframe').forEach((el) => {
            const p = doc.createElement('div');
            p.textContent = '[iframe blocked in sandbox preview]';
            p.style.cssText = 'padding:6px 8px;border:1px dashed #aaa;margin:6px 0;font:12px/1.4 monospace;color:#555;background:#fafafa;';
            el.replaceWith(p);
        });
        doc.querySelectorAll('[src],[href],[srcset]').forEach((el) => {
            if (el.hasAttribute('src')) { el.setAttribute('data-original-src', el.getAttribute('src') || ''); el.removeAttribute('src'); }
            if (el.hasAttribute('href')) { el.setAttribute('data-original-href', el.getAttribute('href') || ''); el.removeAttribute('href'); }
            if (el.hasAttribute('srcset')) { el.removeAttribute('srcset'); }
        });
        const html = doc.documentElement?.outerHTML || raw;
        return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:;"><style>html,body{margin:0;padding:0;background:#fff;color:#111}body{font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}</style></head><body>${html}</body></html>`;
    } catch {
        return '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#fff;color:#111;padding:12px">Preview parse error</body></html>';
    }
}

function tinyHash(text) {
    const s = String(text || '');
    return `${s.length}:${s.slice(0, 64)}:${s.slice(-64)}`;
}

function diffSets(a = [], b = []) {
    const A = new Set(a), B = new Set(b);
    return { added: [...B].filter(x => !A.has(x)), removed: [...A].filter(x => !B.has(x)) };
}

function reqItemHtml(req, opts = {}) {
    const m = methodCls(req.method);
    const sc = statusCls(req.status);
    const classes = ['rq'];
    if (opts.anchor) classes.push('anchor');
    if (opts.active) classes.push('active');
    if (opts.missing) classes.push('missing');
    return `<div class="${classes.join(' ')}" data-pair-idx="${opts.pairIdx ?? ''}" data-req-id="${req.id}">
        <div class="rq-row">
            <span class="rq-method ${m}">${esc(m)}</span>
            ${req.status ? `<span class="rq-status ${sc}">${esc(req.status)}</span>` : ''}
            <span class="rq-path">${esc(truncPath(req.url))}</span>
            ${opts.pairNo ? `<span class="pair-badge">#${opts.pairNo}</span>` : ''}
        </div>
        ${opts.missing ? '<div class="rq-miss-tag">no match</div>' : ''}
    </div>`;
}

function renderColumns() {
    const res = state.result;
    if (!res) {
        leftListEl.innerHTML = state.left ? reqItemHtml(state.left, { anchor: true }) + '<div class="col-empty">Click Compare to load</div>' : '<div class="col-empty">Add from Network Activity</div>';
        rightListEl.innerHTML = state.right ? reqItemHtml(state.right, { anchor: true }) + '<div class="col-empty">Click Compare to load</div>' : '<div class="col-empty">Add from Network Activity</div>';
        return;
    }
    const pairs = res.pairs || [];
    const leftMap = new Map();
    const rightMap = new Map();
    let pairNo = 1;
    pairs.forEach((p, idx) => {
        if (p.type === 'match') {
            leftMap.set(Number(p.left?.id), { idx, no: pairNo });
            rightMap.set(Number(p.right?.id), { idx, no: pairNo });
            pairNo++;
        } else if (p.left) leftMap.set(Number(p.left.id), { idx, no: null });
        else if (p.right) rightMap.set(Number(p.right.id), { idx, no: null });
    });

    leftListEl.innerHTML = (res.leftList || []).map((req, i) => {
        const x = leftMap.get(Number(req.id));
        return reqItemHtml(req, {
            anchor: i === 0,
            active: x?.idx === selectedPairIndex,
            missing: x && pairs[x.idx]?.type === 'missing-right',
            pairNo: x?.no || '',
            pairIdx: x ? x.idx : '',
        });
    }).join('') || '<div class="col-empty">No requests</div>';

    rightListEl.innerHTML = (res.rightList || []).map((req, j) => {
        const x = rightMap.get(Number(req.id));
        return reqItemHtml(req, {
            anchor: j === 0,
            active: x?.idx === selectedPairIndex,
            missing: x && pairs[x.idx]?.type === 'missing-left',
            pairNo: x?.no || '',
            pairIdx: x ? x.idx : '',
        });
    }).join('') || '<div class="col-empty">No requests</div>';

    [leftListEl, rightListEl].forEach((el) => {
        el.querySelectorAll('.rq[data-pair-idx]').forEach((item) => {
            item.addEventListener('click', () => {
                const idx = item.dataset.pairIdx;
                if (idx === '' || idx == null) return;
                selectedPairIndex = Number(idx);
                render();
            });
        });
    });
    schedulePaneLinksRender();
}

function schedulePaneLinksRender() {
    if (_linksRaf) cancelAnimationFrame(_linksRaf);
    _linksRaf = requestAnimationFrame(() => {
        _linksRaf = null;
        drawPaneLinks();
    });
}

function drawPaneLinks() {
    if (!listsPaneEl || !paneLinksEl) return;
    paneLinksEl.innerHTML = '';
    const wr = listsPaneEl.getBoundingClientRect();
    if (!wr.width || !wr.height) return;
    paneLinksEl.setAttribute('viewBox', `0 0 ${Math.max(1, Math.round(wr.width))} ${Math.max(1, Math.round(wr.height))}`);
    paneLinksEl.setAttribute('width', `${Math.max(1, Math.round(wr.width))}`);
    paneLinksEl.setAttribute('height', `${Math.max(1, Math.round(wr.height))}`);

    const leftItems = leftListEl ? Array.from(leftListEl.querySelectorAll('.rq[data-pair-idx]')) : [];
    const rightMap = new Map();
    if (rightListEl) {
        rightListEl.querySelectorAll('.rq[data-pair-idx]').forEach((el) => {
            const idx = String(el.getAttribute('data-pair-idx') || '');
            if (idx) rightMap.set(idx, el);
        });
    }
    const top = wr.top;
    const bottom = wr.bottom;
    for (const l of leftItems) {
        const idx = String(l.getAttribute('data-pair-idx') || '');
        if (!idx) continue;
        const r = rightMap.get(idx);
        if (!r) continue;
        const lr = l.getBoundingClientRect();
        const rr = r.getBoundingClientRect();
        if (!(lr.bottom > top && lr.top < bottom && rr.bottom > top && rr.top < bottom)) continue;
        const x1 = lr.right - wr.left;
        const y1 = lr.top + lr.height / 2 - wr.top;
        const x2 = rr.left - wr.left;
        const y2 = rr.top + rr.height / 2 - wr.top;
        const cx = (x1 + x2) / 2;
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('class', `pane-link ${Number(idx) === Number(selectedPairIndex) ? 'active' : ''}`);
        p.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`);
        paneLinksEl.appendChild(p);
    }
}

function renderHeaderDiffTable(hdrs) {
    if (!hdrs) return '<div style="color:#6f809f;font-size:11px;padding:8px">No data</div>';
    const { added = [], removed = [], changed = [] } = hdrs;
    if (!added.length && !removed.length && !changed.length) return '<div style="color:#6f809f;font-size:11px;padding:8px">No differences</div>';
    const rows = [];
    for (const h of added) rows.push(`<tr class="hdr-added"><td>${esc(h.key)}</td><td></td><td>${esc(JSON.stringify(h.value))}</td></tr>`);
    for (const h of removed) rows.push(`<tr class="hdr-removed"><td>${esc(h.key)}</td><td>${esc(JSON.stringify(h.value))}</td><td></td></tr>`);
    for (const h of changed) rows.push(`<tr class="hdr-changed"><td>${esc(h.key)}</td><td>${esc(JSON.stringify(h.before))}</td><td>${esc(JSON.stringify(h.after))}</td></tr>`);
    return `<table class="hdr-table"><thead><tr><th>Header</th><th>Left</th><th>Right</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function riskLevel(pair, htmlLeft, htmlRight) {
    const d = pair?.diff;
    if (!d) return 'low';
    let risk = 0;
    if (d.summary?.statusChanged) risk += 2;
    if (Math.abs(Number(d.summary?.latencyDeltaMs || 0)) > 500) risk += 1;
    if ((d.request?.headers?.changed || []).some(h => /authorization|cookie|token/i.test(h.key))) risk += 2;
    if ((d.response?.headers?.changed || []).some(h => /content-security-policy|set-cookie/i.test(h.key))) risk += 2;
    if (htmlLeft?.insecureScripts || htmlRight?.insecureScripts) risk += 1;
    if ((htmlRight?.iframeSandboxed || 0) < (htmlLeft?.iframeSandboxed || 0)) risk += 1;
    if (risk >= 5) return 'high';
    if (risk >= 3) return 'medium';
    return 'low';
}

function buildExecutiveSummary(pair, htmlLeft, htmlRight) {
    const d = pair?.diff || {};
    const reqHdr = d.request?.headers || { added: [], removed: [], changed: [] };
    const respHdr = d.response?.headers || { added: [], removed: [], changed: [] };
    const jsonReq = collectJsonDiffKinds(tryParseJson(d.request?.body?.beforeText), tryParseJson(d.request?.body?.afterText));
    const jsonResp = collectJsonDiffKinds(tryParseJson(d.response?.body?.beforeText), tryParseJson(d.response?.body?.afterText));
    return {
        statusChanged: !!d.summary?.statusChanged,
        contractChanged: (jsonReq.length + jsonResp.length) > 0,
        schemaPaths: jsonReq.length + jsonResp.length,
        authImpact: (reqHdr.changed || []).some(h => /authorization|cookie|token/i.test(h.key)),
        uiImpact: !!(htmlLeft || htmlRight),
        htmlScriptDelta: Math.abs((htmlLeft?.scriptsExternal || 0) - (htmlRight?.scriptsExternal || 0)),
        risk: riskLevel(pair, htmlLeft, htmlRight),
    };
}

function jsonFiltersHtml(target, rows) {
    const active = jsonFilters[target] || 'all';
    const btn = (k, t) => `<button class="btn" data-json-filter="${target}:${k}" style="${active === k ? 'border-color:#3b82f6;color:#fff' : ''}">${t}</button>`;
    return `<div class="json-tools">${btn('all', 'All')} ${btn('changed', 'Changed')} ${btn('added', 'Added')} ${btn('removed', 'Removed')} ${btn('type', 'Type')}</div>
        <div class="json-paths">${rows.map(r => `<div class="path">[${r.kind}] ${esc(r.path)}</div>`).join('') || '<div class="path">No changed paths</div>'}</div>`;
}

function filteredJsonRows(target, rows) {
    const f = jsonFilters[target] || 'all';
    return f === 'all' ? rows : rows.filter(r => r.kind === f);
}

async function renderDetail() {
    const res = state.result;
    if (!res || !res.pairs?.length) {
        detailBodyEl.innerHTML = '<div class="empty-msg">Add two requests from Network Activity,<br>then click <b>▶ Compare</b>.</div>';
        return;
    }
    const pair = res.pairs[selectedPairIndex];
    if (!pair) {
        detailBodyEl.innerHTML = '<div class="empty-msg">Select a request pair from side columns.</div>';
        return;
    }
    if (pair.type === 'missing-right' || pair.type === 'missing-left') {
        const side = pair.type === 'missing-right' ? 'Right' : 'Left';
        const req = pair.left || pair.right;
        detailBodyEl.innerHTML = `<div class="metrics"><div class="metric"><span class="m-label">Type</span><span class="m-val err">Missing on ${side}</span></div></div>
            <div class="card"><div class="card-hd">Unmatched Request</div><div class="card-body" style="font-family:'SF Mono','Consolas',monospace">${esc(req?.method || 'GET')} ${esc(req?.url || '—')}</div></div>`;
        return;
    }
    const d = pair.diff;
    if (!d) {
        detailBodyEl.innerHTML = '<div class="empty-msg">No diff available for selected pair.</div>';
        return;
    }

    const reqJsonL = tryParseJson(d.request?.body?.beforeText);
    const reqJsonR = tryParseJson(d.request?.body?.afterText);
    const respJsonL = tryParseJson(d.response?.body?.beforeText);
    const respJsonR = tryParseJson(d.response?.body?.afterText);
    const reqJsonRows = collectJsonDiffKinds(reqJsonL, reqJsonR);
    const respJsonRows = collectJsonDiffKinds(respJsonL, respJsonR);
    const htmlLeft = analyzeHtmlSnapshot(d.response?.body?.beforeText || '');
    const htmlRight = analyzeHtmlSnapshot(d.response?.body?.afterText || '');
    const exec = buildExecutiveSummary(pair, htmlLeft, htmlRight);

    const cards = [];
    cards.push(`<div class="metrics">
        <div class="metric"><span class="m-label">Confidence</span><span class="m-val ${pair.confidence === 'high' ? 'ok' : (pair.confidence === 'low' ? 'err' : 'warn')}">${esc(pair.confidence || 'medium')}</span></div>
        <div class="metric"><span class="m-label">Score</span><span class="m-val">${esc(pair.score ?? '—')}</span></div>
        <div class="metric"><span class="m-label">Risk</span><span class="m-val ${exec.risk === 'high' ? 'err' : (exec.risk === 'medium' ? 'warn' : 'ok')}">${exec.risk}</span></div>
        <div class="metric"><span class="m-label">Status</span><span class="m-val ${d.summary?.statusChanged ? 'warn' : 'ok'}">${esc(d.left?.status ?? '—')} → ${esc(d.right?.status ?? '—')}</span></div>
        <div class="metric"><span class="m-label">Latency Δ</span><span class="m-val ${Math.abs(Number(d.summary?.latencyDeltaMs || 0)) > 500 ? 'warn' : ''}">${Number(d.summary?.latencyDeltaMs || 0) > 0 ? '+' : ''}${esc(d.summary?.latencyDeltaMs ?? 0)} ms</span></div>
        <div class="metric"><span class="m-label">Match key</span><span class="m-val" style="font-size:11px;font-weight:400">${esc(pair.left?.match_key || '—')}</span></div>
    </div>`);

    if (visibleDim('transport') || visibleDim('all')) {
        cards.push(`<div class="card"><div class="card-hd">Executive Summary</div><div class="card-body">
            <div class="analysis-row"><span class="k">Contract changed</span><span>${exec.contractChanged ? 'yes' : 'no'}</span></div>
            <div class="analysis-row"><span class="k">Schema paths changed</span><span>${exec.schemaPaths}</span></div>
            <div class="analysis-row"><span class="k">Auth/Cookie impact</span><span>${exec.authImpact ? 'yes' : 'no'}</span></div>
            <div class="analysis-row"><span class="k">UI/HTML impact</span><span>${exec.uiImpact ? 'yes' : 'no'}</span></div>
        </div></div>`);
        cards.push(`<div class="card"><div class="card-hd">Request Headers</div><div class="card-body">${renderHeaderDiffTable(d.request?.headers)}</div></div>`);
        cards.push(`<div class="card"><div class="card-hd">Response Headers</div><div class="card-body">${renderHeaderDiffTable(d.response?.headers)}</div></div>`);
    }

    if (visibleDim('data') || visibleDim('all')) {
        let reqBodyHtml = `<div class="split"><div class="split-col"><div class="split-label">Left (A)</div><pre>${esc(d.request?.body?.beforeText || '(empty)')}</pre></div><div class="split-col"><div class="split-label">Right (B)</div><pre>${esc(d.request?.body?.afterText || '(empty)')}</pre></div></div>`;
        if (reqJsonL && reqJsonR) {
            const fRows = filteredJsonRows('req', reqJsonRows);
            const r = await api.formatJsonDiffHtml(JSON.stringify(reqJsonL), JSON.stringify(reqJsonR)).catch(() => null);
            if (r?.success) reqBodyHtml = `<div class="card-body">${jsonFiltersHtml('req', fRows)}<div class="json-tools"><button class="btn" data-json-focus="req">${jsonFocus.req ? 'Show all' : 'Focus changes'}</button></div><div class="json-wrap ${jsonFocus.req ? 'focus-changes' : ''}" data-json-wrap="req">${r.html}</div></div>`;
        }
        cards.push(`<div class="card"><div class="card-hd">Request Body</div>${reqBodyHtml}</div>`);

        let respBodyHtml = `<div class="split"><div class="split-col"><div class="split-label">Left (A)</div><pre>${esc(d.response?.body?.beforeText || '(empty)')}</pre></div><div class="split-col"><div class="split-label">Right (B)</div><pre>${esc(d.response?.body?.afterText || '(empty)')}</pre></div></div>`;
        if (respJsonL && respJsonR) {
            const fRows = filteredJsonRows('resp', respJsonRows);
            const r = await api.formatJsonDiffHtml(JSON.stringify(respJsonL), JSON.stringify(respJsonR)).catch(() => null);
            if (r?.success) respBodyHtml = `<div class="card-body">${jsonFiltersHtml('resp', fRows)}<div class="json-tools"><button class="btn" data-json-focus="resp">${jsonFocus.resp ? 'Show all' : 'Focus changes'}</button></div><div class="json-wrap ${jsonFocus.resp ? 'focus-changes' : ''}" data-json-wrap="resp">${r.html}</div></div>`;
        }
        cards.push(`<div class="card"><div class="card-hd">Response Body</div>${respBodyHtml}</div>`);
    }

    if ((visibleDim('ui') || visibleDim('all')) && (htmlLeft || htmlRight)) {
        const L = htmlLeft || {};
        const R = htmlRight || {};
        const scriptDelta = diffSets(L.scriptsList || [], R.scriptsList || []);
        const cssDelta = diffSets(L.cssList || [], R.cssList || []);
        cards.push(`<div class="card"><div class="card-hd">HTML Impact Summary</div><div class="card-body">
            <div class="analysis-grid">
                <div class="analysis-box">
                    <div class="analysis-hd">Left</div>
                    <div class="analysis-row"><span class="k">title</span><span>${esc(L.title || '—')}</span></div>
                    <div class="analysis-row"><span class="k">scripts ext/inline</span><span>${L.scriptsExternal || 0}/${L.scriptsInline || 0}</span></div>
                    <div class="analysis-row"><span class="k">css links/style</span><span>${L.cssExternal || 0}/${L.styleTags || 0}</span></div>
                    <div class="analysis-row"><span class="k">forms/fields</span><span>${L.formsCount || 0}/${L.formFieldsTotal || 0}</span></div>
                    <div class="analysis-row"><span class="k">iframes/sandboxed</span><span>${L.iframesCount || 0}/${L.iframeSandboxed || 0}</span></div>
                </div>
                <div class="analysis-box">
                    <div class="analysis-hd">Right</div>
                    <div class="analysis-row"><span class="k">title</span><span>${esc(R.title || '—')}</span></div>
                    <div class="analysis-row"><span class="k">scripts ext/inline</span><span>${R.scriptsExternal || 0}/${R.scriptsInline || 0}</span></div>
                    <div class="analysis-row"><span class="k">css links/style</span><span>${R.cssExternal || 0}/${R.styleTags || 0}</span></div>
                    <div class="analysis-row"><span class="k">forms/fields</span><span>${R.formsCount || 0}/${R.formFieldsTotal || 0}</span></div>
                    <div class="analysis-row"><span class="k">iframes/sandboxed</span><span>${R.iframesCount || 0}/${R.iframeSandboxed || 0}</span></div>
                </div>
            </div>
            <div class="analysis-grid" style="margin-top:10px">
                <div class="analysis-box"><div class="analysis-hd">Scripts added/removed</div><div class="analysis-list">${(scriptDelta.added.map(x => `+ ${x}`).concat(scriptDelta.removed.map(x => `- ${x}`))).map(x => `<div>${esc(x)}</div>`).join('') || '<div>—</div>'}</div></div>
                <div class="analysis-box"><div class="analysis-hd">CSS added/removed</div><div class="analysis-list">${(cssDelta.added.map(x => `+ ${x}`).concat(cssDelta.removed.map(x => `- ${x}`))).map(x => `<div>${esc(x)}</div>`).join('') || '<div>—</div>'}</div></div>
            </div>
            <div class="analysis-grid" style="margin-top:10px">
                <div><div class="analysis-hd" style="margin-bottom:6px">Left preview (sandbox)</div><iframe class="html-preview-frame" data-preview-side="left" sandbox=""></iframe></div>
                <div><div class="analysis-hd" style="margin-bottom:6px">Right preview (sandbox)</div><iframe class="html-preview-frame" data-preview-side="right" sandbox=""></iframe></div>
            </div>
        </div></div>`);
    }

    if (visibleDim('security') || visibleDim('all')) {
        const reqHdr = d.request?.headers || { changed: [], added: [], removed: [] };
        const respHdr = d.response?.headers || { changed: [], added: [], removed: [] };
        const authImpact = (reqHdr.changed || []).some(h => /authorization|cookie|token/i.test(h.key));
        const setCookieDelta = [...(respHdr.added || []), ...(respHdr.changed || []), ...(respHdr.removed || [])].some(h => /set-cookie/i.test(h.key));
        const cspDelta = [...(respHdr.added || []), ...(respHdr.changed || []), ...(respHdr.removed || [])].some(h => /content-security-policy/i.test(h.key));
        cards.push(`<div class="card"><div class="card-hd">Security Signals</div><div class="card-body">
            <div class="analysis-row"><span class="k">Auth/Cookie headers changed</span><span>${authImpact ? 'yes' : 'no'}</span></div>
            <div class="analysis-row"><span class="k">Set-Cookie changed</span><span>${setCookieDelta ? 'yes' : 'no'}</span></div>
            <div class="analysis-row"><span class="k">CSP changed</span><span>${cspDelta ? 'yes' : 'no'}</span></div>
            <div class="analysis-row"><span class="k">Status class changed</span><span>${statusClassNum(d.left?.status) !== statusClassNum(d.right?.status) ? 'yes' : 'no'}</span></div>
            <div class="analysis-row"><span class="k">Risk level</span><span>${buildExecutiveSummary(pair, htmlLeft, htmlRight).risk}</span></div>
        </div></div>`);
    }

    detailBodyEl.innerHTML = cards.join('');

    detailBodyEl.querySelectorAll('button[data-json-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const [target, kind] = String(btn.dataset.jsonFilter || '').split(':');
            if (!target || !kind) return;
            jsonFilters[target] = kind;
            renderDetail().catch(() => {});
        });
    });
    detailBodyEl.querySelectorAll('button[data-json-focus]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = String(btn.dataset.jsonFocus || '');
            if (!target) return;
            jsonFocus[target] = !jsonFocus[target];
            renderDetail().catch(() => {});
        });
    });
    detailBodyEl.querySelectorAll('iframe[data-preview-side]').forEach((frame) => {
        const side = frame.getAttribute('data-preview-side');
        try {
            const raw = side === 'left' ? (htmlLeft?.raw || '') : (htmlRight?.raw || '');
            const safeDoc = buildSandboxPreviewDoc(raw);
            const h = tinyHash(safeDoc);
            if (frame.dataset.previewHash !== h) {
                frame.dataset.previewHash = h;
                frame.srcdoc = safeDoc;
            }
        } catch {}
    });
}

function render() {
    compareBtn.disabled = !state.left || !state.right;
    renderColumns();
    renderDetail().catch(() => {});
    const pairs = state.result?.pairs || [];
    const matched = pairs.filter(p => p.type === 'match').length;
    const missing = pairs.length - matched;
    statusEl.textContent = pairs.length ? `${matched} matched · ${missing} missing · ${pairs.length} total` : '';
    schedulePaneLinksRender();
}

async function refresh() {
    statusEl.textContent = 'Loading…';
    state = await api.getCompare().catch(() => ({ left: null, right: null, result: null }));
    render();
}

async function runCompare() {
    if (!state.left || !state.right) return;
    statusEl.textContent = 'Comparing…';
    selectedPairIndex = 0;
    const options = { level: String(levelSelect?.value || 'standard'), removeNoiseHeaders: !!noiseToggle?.checked };
    const res = await api.runCompare(options).catch(() => null);
    if (res?.success === false) statusEl.textContent = res.error || 'Compare failed';
}

refreshBtn?.addEventListener('click', refresh);
compareBtn?.addEventListener('click', runCompare);
dimensionMode?.addEventListener('change', () => renderDetail().catch(() => {}));
levelSelect?.addEventListener('change', () => runCompare());
noiseToggle?.addEventListener('change', () => runCompare());
leftListEl?.addEventListener('scroll', schedulePaneLinksRender, { passive: true });
rightListEl?.addEventListener('scroll', schedulePaneLinksRender, { passive: true });
window.addEventListener('resize', schedulePaneLinksRender);

api.onCompareUpdated?.((payload) => {
    state = payload || { left: null, right: null, result: null };
    if (state.result?.options) {
        levelSelect.value = state.result.options.level || 'standard';
        noiseToggle.checked = !!state.result.options.removeNoiseHeaders;
    }
    render();
    if (!hasAutoCompared && state.left && state.right && !state.result) {
        hasAutoCompared = true;
        runCompare();
    }
});

refresh().then(() => {
    if (state.left && state.right && !state.result) {
        hasAutoCompared = true;
        runCompare();
    }
}).catch(() => {});
