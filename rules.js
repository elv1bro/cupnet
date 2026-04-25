'use strict';

const api = window.electronAPI;

/** Preset before/after bodies (shown in UI + embedded in LLM prompt as reference). */
const SCRIPT_PRESETS = [
    {
        id: 'add-req-header',
        label: 'Add request header',
        before: "ctx.headers['X-CupNet-Custom'] = '1';",
        after: '',
    },
    {
        id: 'short-json-mock',
        label: 'Short-circuit JSON mock',
        before: [
            'ctx.shortCircuit = {',
            "  statusCode: 200,",
            "  headers: { 'Content-Type': 'application/json' },",
            "  body: JSON.stringify({ ok: true, source: 'shortCircuit' }),",
            '};',
        ].join('\n'),
        after: '',
    },
    {
        id: 'rewrite-url-host',
        label: 'Rewrite hostname in URL',
        before: [
            'try {',
            '  const u = new URL(ctx.url);',
            "  if (u.hostname === 'api.old.example') {",
            "    u.hostname = 'api.new.example';",
            '    ctx.url = u.toString();',
            '  }',
            '} catch (e) {}',
        ].join('\n'),
        after: '',
    },
    {
        id: 'strip-csp-after',
        label: 'Remove Content-Security-Policy (after)',
        before: '',
        after: [
            'const h = ctx.response.headers;',
            'const next = {};',
            'for (const [k, v] of Object.entries(h)) {',
            "  if (String(k).toLowerCase() !== 'content-security-policy') next[k] = v;",
            '}',
            'ctx.response.headers = next;',
        ].join('\n'),
    },
    {
        id: 'inject-json-after',
        label: 'Append field to JSON response (after)',
        before: '',
        after: [
            'try {',
            "  const raw = Buffer.from(ctx.response.bodyBase64 || '', 'base64').toString('utf8');",
            '  const o = JSON.parse(raw);',
            '  o.cupnetInjected = true;',
            '  ctx.response.body = JSON.stringify(o);',
            '} catch (e) {}',
        ].join('\n'),
    },
    {
        id: 'remove-req-header',
        label: 'Remove request header (e.g. Authorization)',
        before: [
            "const kill = 'authorization';",
            'for (const k of Object.keys(ctx.headers || {})) {',
            "  if (String(k).toLowerCase() === kill) delete ctx.headers[k];",
            '}',
            'if (Array.isArray(ctx.orderedHeaders)) {',
            '  ctx.orderedHeaders = ctx.orderedHeaders.filter(',
            '    ([name]) => String(name).toLowerCase() !== kill',
            '  );',
            '}',
        ].join('\n'),
        after: '',
    },
    {
        id: 'append-query-param',
        label: 'Append query parameter to URL',
        before: [
            'try {',
            '  const u = new URL(ctx.url);',
            "  u.searchParams.set('cupnet_ts', String(Date.now()));",
            '  ctx.url = u.toString();',
            '} catch (e) {}',
        ].join('\n'),
        after: '',
    },
    {
        id: 'rewrite-path-prefix',
        label: 'Rewrite URL path prefix (/api/v1 → /api/v2)',
        before: [
            'try {',
            '  const u = new URL(ctx.url);',
            "  if (u.pathname.startsWith('/api/v1/')) {",
            "    u.pathname = u.pathname.replace(/^\\/api\\/v1/, '/api/v2');",
            '    ctx.url = u.toString();',
            '  }',
            '} catch (e) {}',
        ].join('\n'),
        after: '',
    },
    {
        id: 'redirect-302-shortcircuit',
        label: 'Short-circuit HTTP 302 redirect',
        before: [
            'ctx.shortCircuit = {',
            '  statusCode: 302,',
            "  headers: { Location: 'https://example.com/new-location' },",
            "  body: '',",
            '};',
        ].join('\n'),
        after: '',
    },
    {
        id: 'html-shortcircuit',
        label: 'Short-circuit HTML page',
        before: [
            'ctx.shortCircuit = {',
            '  statusCode: 200,',
            "  headers: { 'Content-Type': 'text/html; charset=utf-8' },",
            "  body: '<!doctype html><html><body><h1>Maintenance</h1></body></html>',",
            '};',
        ].join('\n'),
        after: '',
    },
    {
        id: 'before-json-body-patch',
        label: 'Patch outgoing JSON POST body (before)',
        before: [
            'try {',
            '  if (!ctx.bodyBase64) return;',
            "  const raw = Buffer.from(ctx.bodyBase64, 'base64').toString('utf8');",
            '  const o = JSON.parse(raw);',
            '  o.sentViaCupNet = true;',
            '  ctx.body = JSON.stringify(o);',
            '  ctx.bodyBase64 = undefined;',
            '} catch (e) {}',
        ].join('\n'),
        after: '',
    },
    {
        id: 'after-text-replace-body',
        label: 'Replace substring in response body (text, after)',
        before: '',
        after: [
            'try {',
            "  let t = Buffer.from(ctx.response.bodyBase64 || '', 'base64').toString('utf8');",
            "  t = t.replace(/REPLACE_ME/g, 'WITH_THIS');",
            '  ctx.response.body = t;',
            '} catch (e) {}',
        ].join('\n'),
    },
    {
        id: 'after-add-response-header',
        label: 'Add response header only (after)',
        before: '',
        after: "ctx.response.headers['X-CupNet-Injected'] = '1';",
    },
    {
        id: 'after-change-status',
        label: 'Change response status code only (after)',
        before: '',
        after: 'ctx.response.statusCode = 201;',
    },
    {
        id: 'before-header-ordered-sync',
        label: 'Add request header + orderedHeaders pair',
        before: [
            "ctx.headers['X-Dual'] = 'yes';",
            'if (Array.isArray(ctx.orderedHeaders)) {',
            "  ctx.orderedHeaders.push(['X-Dual', 'yes']);",
            '}',
        ].join('\n'),
        after: '',
    },
];

const INTERCEPT_AI_PROMPT_BASE = `You are a specialist for CupNet “Dynamic script” intercept rules.

CupNet is an Electron-based browser; HTTPS traffic is decrypted by a local MITM proxy, then forwarded. A “Dynamic script” rule runs YOUR JavaScript in the Node.js main process inside a vm sandbox (NOT in the web page). There is no require(), import, fs, process (aside from what the host exposes indirectly), window, document, or fetch. Globals available in the sandbox: ctx, Buffer, TextDecoder, TextEncoder.

=== TWO HOOKS (both optional, but at least one must be non-empty when saving)
1) “Before MITM” — runs after the browser request is visible to CupNet but BEFORE it is sent to the real server (AzureTLS/upstream). You can mutate the outgoing request or short-circuit a fake response.
2) “After response” — runs AFTER the origin returned a response (or after your short-circuit path skipped the network — in that case hook #2 is not used because there is no upstream response). You receive ctx.request (frozen snapshot from after hook #1) and the live ctx.response object.

=== OUTPUT FORMAT FOR THE USER
Return exactly TWO fenced or labeled blocks so the user can paste into “Before upstream” and “After server response”:
- Label them clearly: e.g. “Before MITM (body only):” and “After response (body only):”.
- Emit ONLY executable lines that belong inside (function (ctx) { ... })(ctx) — no function keyword, no outer IIFE wrapper.
- If a phase is unused, output a single line comment such as // (empty) in that block.
- Prefer small try/catch around JSON.parse, new URL, or Buffer operations so one bad request does not break the proxy for all traffic.

=== ctx IN “BEFORE” (outgoing request)
- ctx.url — full URL string. Safe to rewrite with new URL(ctx.url), mutate, then ctx.url = u.toString().
- ctx.method — HTTP verb string (e.g. GET, POST).
- ctx.headers — plain object map (keys may be mixed case). Mutations here affect the semantic headers map.
- ctx.orderedHeaders — array of [headerName, value] preserving wire order. If you add/remove sensitive headers (Authorization, Cookie, Host), update BOTH ctx.headers AND ctx.orderedHeaders when possible so the outgoing wire form stays consistent.
- ctx.body — string or buffer-like usage depends on CupNet: prefer setting ctx.body as a string for UTF-8 text; set ctx.bodyBase64 for binary. If you set ctx.body as a string, CupNet may clear bodyBase64. For edits, often: decode ctx.bodyBase64 with Buffer.from(..., 'base64'), modify, then assign ctx.body or new base64.
- ctx.bodyBase64 — base64 string of body when the stack uses base64; if you only set ctx.body textual, you can set ctx.bodyBase64 = undefined per pipeline rules.
- ctx.dnsOverride, ctx.tabId, ctx.requestId — usually leave unchanged unless you understand MITM DNS override semantics.
- ctx.shortCircuit — assign an object to skip the network entirely (local response like “mock”):
  { statusCode: number, headers: object, body?: string, bodyBase64?: string }
  Use shortCircuit for JSON APIs, HTML stubs, redirects (302 + Location header), errors, etc.

=== ctx IN “AFTER” (response path)
- ctx.request — { url, method, headers, orderedHeaders } snapshot as sent after the “before” hook.
- ctx.response — { statusCode, headers (object), bodyBase64 (string), optionally set body (string utf-8) to replace payload }.
- To strip headers, rebuild headers or delete keys case-insensitively (some stacks use varied casing).
- To edit JSON/text body: decode bodyBase64 → string → parse/modify → assign ctx.response.body = string (host re-encodes to base64) OR set bodyBase64 yourself consistently.

=== RULE MATCHING & SAFETY
- First enabled intercept rule whose URL pattern matches wins. Patterns are globs with * unless CUPNET_INTERCEPT_STRICT_URLS=1 (then prefix URLs only, no *).
- Script phases have a timeout (~400 ms default, env CUPNET_INTERCEPT_SCRIPT_MS). Avoid heavy loops or huge string ops.
- Captcha / Cloudflare challenge domains are skipped by default unless CUPNET_INTERCEPT_ALLOW_MOCK_CF=1.
- WebSocket upgrades: “after” logic differs from normal HTTP; avoid assuming large response bodies there.
- vm isolation is not a security boundary; never tell the user to paste untrusted code.

=== REFERENCE SNIPPETS SECTION
After this instruction, the user’s prompt includes a “REFERENCE SNIPPETS” appendix with real CupNet examples. Use them as patterns: combine, parameterize (hosts, paths, header names), and explain briefly what each line does when the user is learning.

=== TEACHING STYLE
When the user asks “how do I …?”, name the hook (“before” vs “after”), list which ctx fields you touch, mention orderedHeaders if relevant, and note shortCircuit vs upstream round-trip.`;

function formatPresetsForLlm(presets) {
    return presets.map((p, i) => {
        const b = (p.before || '').trim() || '// (empty)';
        const a = (p.after || '').trim() || '// (empty)';
        return `### Example ${i + 1}: ${p.label}\nBefore MITM (body only):\n${b}\n\nAfter response (body only):\n${a}`;
    }).join('\n\n');
}

function getInterceptAiPrompt() {
    return `${INTERCEPT_AI_PROMPT_BASE}

─── REFERENCE SNIPPETS
The following are copy-paste-safe patterns in CupNet. Use them as templates: adjust hostnames, header names, JSON shape, etc. per the user’s request.

${formatPresetsForLlm(SCRIPT_PRESETS)}`;
}
// ─── Helpers & LLM copy ───────────────────────────────────────────────────────

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

async function copyInterceptAiPrompt() {
    try {
        const full = getInterceptAiPrompt();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(full);
        } else {
            const ta = document.createElement('textarea');
            ta.value = full;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showMsg('LLM prompt copied');
    } catch (e) {
        showMsg('Copy failed', true);
    }
}

function onClick(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
}

function onInput(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', handler);
}

function onChange(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', handler);
}

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════

let allRules = [];
let selectedId = null;
let sortableInstance = null;
let typeFilter = '';
let urlTestTimer = null;
const METHOD_KEYS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

const RULE_TEMPLATES = {
    'block-trackers': {
        name: 'Block common trackers',
        type: 'block',
        url_pattern: '*google-analytics.com*',
        method: '*',
        group_name: 'Privacy',
        tags: ['privacy', 'ads'],
        params: {},
    },
    'cors-everywhere': {
        name: 'CORS: Allow-Origin *',
        type: 'modifyHeaders',
        url_pattern: '*',
        method: '*',
        group_name: 'Dev',
        tags: ['cors'],
        params: {
            responseHeaders: { 'Access-Control-Allow-Origin': '*' },
        },
    },
    'disable-csp': {
        name: 'Strip Content-Security-Policy',
        type: 'modifyHeaders',
        url_pattern: '*',
        method: '*',
        group_name: 'Security',
        tags: ['csp'],
        params: {
            removeResponseHeaders: ['content-security-policy', 'Content-Security-Policy'],
        },
    },
    'slow-network': {
        name: 'Slow network (2s)',
        type: 'block',
        url_pattern: '*example.com*',
        method: '*',
        group_name: 'Debug',
        tags: ['delay'],
        delay_ms: 2000,
        params: {},
    },
    'mock-404': {
        name: 'Mock 404',
        type: 'mock',
        url_pattern: '*example.com/not-found*',
        method: '*',
        group_name: 'API',
        tags: ['mock'],
        params: { status: 404, mimeType: 'text/plain', body: 'Not found (CupNet mock)' },
    },
};

/** Preset MIME types for mock Content-Type */
const MOCK_MIME_CUSTOM = '__custom__';
const MOCK_MIME_PRESETS = [
    'application/json', 'text/html', 'text/plain', 'text/css', 'text/javascript',
    'application/javascript', 'application/xml', 'text/xml', 'application/x-www-form-urlencoded',
    'multipart/form-data', 'image/png', 'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp',
    'application/pdf', 'application/wasm', 'application/octet-stream', 'video/mp4', 'audio/mpeg',
];

let _mockBodyDeferredTimer = null;
const _MOCK_BODY_DEFER_CHARS = 96 * 1024;

function initMockMimeSelect() {
    const sel = document.getElementById('edit-mock-mime-select');
    if (!sel || sel.dataset.cupnetMockMimeInit) return;
    sel.dataset.cupnetMockMimeInit = '1';
    sel.innerHTML = '';
    for (const m of MOCK_MIME_PRESETS) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        sel.appendChild(opt);
    }
    const optC = document.createElement('option');
    optC.value = MOCK_MIME_CUSTOM;
    optC.textContent = 'Custom…';
    sel.appendChild(optC);
    onChange('edit-mock-mime-select', () => updateMockMimeCustomRowVisibility());
}

function updateMockMimeCustomRowVisibility() {
    const sel = document.getElementById('edit-mock-mime-select');
    const row = document.getElementById('edit-mock-mime-custom-row');
    if (!sel || !row) return;
    row.style.display = sel.value === MOCK_MIME_CUSTOM ? '' : 'none';
}

function setMockMimeUiValue(mime) {
    initMockMimeSelect();
    const sel = document.getElementById('edit-mock-mime-select');
    const customIn = document.getElementById('edit-mock-mime-custom');
    if (!sel || !customIn) return;
    const raw = (mime == null || mime === '') ? 'application/json' : String(mime).trim();
    if (MOCK_MIME_PRESETS.includes(raw)) {
        sel.value = raw;
        customIn.value = '';
    } else {
        sel.value = MOCK_MIME_CUSTOM;
        customIn.value = raw;
    }
    updateMockMimeCustomRowVisibility();
}

function getMockMimeValue() {
    const sel = document.getElementById('edit-mock-mime-select');
    const customIn = document.getElementById('edit-mock-mime-custom');
    if (!sel || !customIn) return 'application/json';
    if (sel.value === MOCK_MIME_CUSTOM) {
        const t = customIn.value.trim();
        return t || 'application/json';
    }
    return sel.value;
}

function setInterceptMockBodyValue(raw) {
    const el = document.getElementById('edit-mock-body');
    if (!el) return;
    if (_mockBodyDeferredTimer) {
        clearTimeout(_mockBodyDeferredTimer);
        _mockBodyDeferredTimer = null;
    }
    const text = raw == null ? '' : String(raw);
    el.value = '';
    if (text.length <= _MOCK_BODY_DEFER_CHARS) {
        el.value = text;
        if (window.CupNetRulesMonaco) CupNetRulesMonaco.setValue('edit-mock-body', text);
        return;
    }
    _mockBodyDeferredTimer = setTimeout(() => {
        _mockBodyDeferredTimer = null;
        el.value = text;
        if (window.CupNetRulesMonaco) CupNetRulesMonaco.setValue('edit-mock-body', text);
    }, 0);
}

function monacoGet(id) {
    if (window.CupNetRulesMonaco && CupNetRulesMonaco.getValue) return CupNetRulesMonaco.getValue(id);
    const ta = document.getElementById(id);
    return ta ? ta.value : '';
}

function monacoSet(id, val) {
    if (window.CupNetRulesMonaco && CupNetRulesMonaco.setValue) CupNetRulesMonaco.setValue(id, val || '');
    else {
        const ta = document.getElementById(id);
        if (ta) ta.value = val || '';
    }
}

function buildMethodCheckboxes() {
    const wrap = document.getElementById('method-checkboxes');
    if (!wrap || wrap.dataset.done) return;
    wrap.dataset.done = '1';
    for (const m of METHOD_KEYS) {
        const lab = document.createElement('label');
        lab.innerHTML = `<input type="checkbox" class="method-cb" data-m="${m}"> ${m}`;
        wrap.appendChild(lab);
    }
    wrap.querySelectorAll('.method-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
            document.getElementById('method-all').checked = false;
        });
    });
    onChange('method-all', (e) => {
        if (e.target.checked) {
            wrap.querySelectorAll('.method-cb').forEach((c) => { c.checked = false; });
        }
    });
}

function setMethodUi(methodStr) {
    const all = document.getElementById('method-all');
    const m = String(methodStr || '*').trim();
    if (m === '*' || !m) {
        if (all) all.checked = true;
        document.querySelectorAll('.method-cb').forEach((c) => { c.checked = false; });
        return;
    }
    if (all) all.checked = false;
    const set = new Set(m.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
    document.querySelectorAll('.method-cb').forEach((c) => {
        c.checked = set.has(c.dataset.m);
    });
}

function getMethodFromUi() {
    const all = document.getElementById('method-all');
    if (all && all.checked) return '*';
    const parts = [];
    document.querySelectorAll('.method-cb').forEach((c) => {
        if (c.checked) parts.push(c.dataset.m);
    });
    return parts.length ? parts.join(',') : '*';
}

function tagsToString(tags) {
    if (tags == null) return '';
    if (Array.isArray(tags)) return tags.join(', ');
    return String(tags);
}

function parseTagsInput(s) {
    return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function buildTypeFilters() {
    const wrap = document.getElementById('type-filters');
    if (!wrap || wrap.dataset.done) return;
    wrap.dataset.done = '1';
    const types = [
        { id: '', label: 'All' },
        { id: 'block', label: 'Block' },
        { id: 'mock', label: 'Mock' },
        { id: 'modifyHeaders', label: 'Modify' },
        { id: 'script', label: 'Script' },
    ];
    for (const t of types) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = t.label;
        b.dataset.type = t.id;
        if (t.id === '') b.classList.add('active');
        b.addEventListener('click', () => {
            wrap.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
            b.classList.add('active');
            typeFilter = t.id;
            renderRuleList();
        });
        wrap.appendChild(b);
    }
}

function getToolbarSearch() {
    const el = document.getElementById('rules-search');
    return el ? el.value.trim().toLowerCase() : '';
}

function getFilteredRules() {
    const q = getToolbarSearch();
    const gf = (document.getElementById('group-filter')?.value || '').trim().toLowerCase();
    const tf = (document.getElementById('tag-filter')?.value || '').trim().toLowerCase();
    return allRules.filter((r) => {
        if (typeFilter && r.type !== typeFilter) return false;
        if (gf) {
            const g = String(r.group_name || '').toLowerCase();
            if (!g.includes(gf)) return false;
        }
        if (tf) {
            const tags = tagsToString(r.tags).toLowerCase();
            if (!tags.includes(tf)) return false;
        }
        if (q) {
            const n = String(r.name || '').toLowerCase();
            const p = String(r.url_pattern || '').toLowerCase();
            if (!n.includes(q) && !p.includes(q)) return false;
        }
        return true;
    });
}

function interceptBadgeClass(type) {
    if (type === 'block') return 'b-block';
    if (type === 'mock') return 'b-mock';
    if (type === 'script') return 'b-scr';
    return 'b-mod';
}

function showInterceptParamsFor(type) {
    const pb = document.getElementById('params-block');
    const ph = document.getElementById('params-headers');
    const pm = document.getElementById('params-mock');
    const ps = document.getElementById('params-script');
    if (pb) pb.style.display = type === 'block' ? '' : 'none';
    if (ph) ph.style.display = type === 'modifyHeaders' ? '' : 'none';
    if (pm) pm.style.display = type === 'mock' ? '' : 'none';
    if (ps) ps.style.display = type === 'script' ? '' : 'none';
}

function clearEditor() {
    selectedId = null;
    document.getElementById('editor-title').textContent = 'Select or create a rule';
    document.getElementById('editor-empty').style.display = '';
    document.getElementById('editor-form').style.display = 'none';
    document.getElementById('btn-history').disabled = true;
}

function fillEditor(rule) {
    const isNew = !rule;
    selectedId = rule && rule.id != null ? rule.id : null;
    document.getElementById('editor-empty').style.display = 'none';
    document.getElementById('editor-form').style.display = '';
    document.getElementById('btn-history').disabled = !rule || rule.id == null;

    document.getElementById('edit-id').value = rule && rule.id != null ? String(rule.id) : '';
    document.getElementById('edit-name').value = rule ? rule.name : '';
    document.getElementById('edit-pattern').value = rule ? rule.url_pattern : '';
    document.getElementById('edit-group').value = rule ? (rule.group_name || '') : '';
    document.getElementById('edit-tags').value = rule ? tagsToString(rule.tags) : '';

    const delay = rule ? Math.max(0, Number(rule.delay_ms) || 0) : 0;
    const dr = document.getElementById('edit-delay');
    if (dr) {
        dr.value = String(delay);
        const dv = document.getElementById('edit-delay-val');
        if (dv) dv.textContent = String(delay);
        dr.setAttribute('aria-valuetext', `${delay} ms`);
    }

    const som = document.getElementById('edit-stop-on-match');
    if (som) som.checked = rule ? (rule.stop_on_match !== 0 && rule.stop_on_match !== false) : true;

    const bp = document.getElementById('edit-breakpoint');
    if (bp) bp.checked = !!(rule && (rule.breakpoint_enabled === 1 || rule.breakpoint_enabled === true));

    setMethodUi(rule ? rule.method : '*');

    const typeEl = document.getElementById('edit-type');
    typeEl.value = rule ? rule.type : 'block';
    showInterceptParamsFor(typeEl.value);

    const p = (rule && rule.params) || {};

    monacoSet('edit-req-headers', rule && rule.type === 'modifyHeaders' ? JSON.stringify(p.requestHeaders || {}, null, 2) : '{}');
    monacoSet('edit-resp-headers', rule && rule.type === 'modifyHeaders' ? JSON.stringify(p.responseHeaders || {}, null, 2) : '{}');

    document.getElementById('edit-mock-status').value = rule && rule.type === 'mock' ? (p.status || 200) : 200;
    setMockMimeUiValue(rule && rule.type === 'mock' ? (p.mimeType || 'application/json') : 'application/json');
    const mockPath = rule && rule.type === 'mock' ? (p.mockFilePath || '') : '';
    document.getElementById('edit-mock-file').value = mockPath;
    setInterceptMockBodyValue(rule && rule.type === 'mock' && !mockPath ? (p.body ?? '') : '');

    monacoSet('edit-script-before', rule && rule.type === 'script' ? (p.beforeSource || '') : '');
    monacoSet('edit-script-after', rule && rule.type === 'script' ? (p.afterSource || '') : '');

    const mh = p.matchHeaders;
    document.getElementById('edit-match-headers').value = mh && Array.isArray(mh)
        ? JSON.stringify(mh, null, 2)
        : '';
    const mb = p.matchBody;
    document.getElementById('edit-match-body').value = mb && typeof mb === 'object'
        ? JSON.stringify(mb, null, 2)
        : '';

    const out = document.getElementById('script-test-out');
    if (out) { out.style.display = 'none'; out.textContent = ''; }

    document.getElementById('editor-title').textContent = isNew ? 'New rule' : `Edit: ${rule.name || ''}`;
    void runUrlTest();
}

function collectRuleFromForm() {
    const idRaw = document.getElementById('edit-id').value;
    const name = document.getElementById('edit-name').value.trim();
    const pattern = document.getElementById('edit-pattern').value.trim();
    const type = document.getElementById('edit-type').value;
    if (!name || !pattern) throw new Error('Name and URL pattern are required');

    const delayMs = Math.max(0, Math.min(60000, Number(document.getElementById('edit-delay').value) || 0));
    const group_name = document.getElementById('edit-group').value.trim() || null;
    const tags = parseTagsInput(document.getElementById('edit-tags').value);
    const method = getMethodFromUi();
    const stop_on_match = document.getElementById('edit-stop-on-match').checked;
    const breakpoint_enabled = document.getElementById('edit-breakpoint').checked;

    let params = {};
    if (type === 'modifyHeaders') {
        params.requestHeaders = JSON.parse(monacoGet('edit-req-headers') || '{}');
        params.responseHeaders = JSON.parse(monacoGet('edit-resp-headers') || '{}');
    } else if (type === 'mock') {
        params.status = parseInt(document.getElementById('edit-mock-status').value, 10);
        params.mimeType = getMockMimeValue();
        const fp = document.getElementById('edit-mock-file').value.trim();
        if (fp) {
            params.mockSource = 'file';
            params.mockFilePath = fp;
        } else {
            params.mockSource = 'text';
            params.body = monacoGet('edit-mock-body');
        }
    } else if (type === 'script') {
        params.beforeSource = monacoGet('edit-script-before');
        params.afterSource = monacoGet('edit-script-after');
    }

    const mhRaw = document.getElementById('edit-match-headers').value.trim();
    if (mhRaw) {
        try {
            const j = JSON.parse(mhRaw);
            if (Array.isArray(j)) params.matchHeaders = j;
        } catch {
            throw new Error('Invalid JSON in match headers');
        }
    }
    const mbRaw = document.getElementById('edit-match-body').value.trim();
    if (mbRaw) {
        try {
            params.matchBody = JSON.parse(mbRaw);
        } catch {
            throw new Error('Invalid JSON in match body');
        }
    }

    const existing = idRaw ? allRules.find((x) => x.id === Number(idRaw)) : null;

    const rule = {
        name,
        enabled: existing ? existing.enabled !== false : true,
        url_pattern: pattern,
        type,
        params,
        method,
        group_name,
        delay_ms: delayMs,
        tags,
        stop_on_match,
        breakpoint_enabled,
    };
    if (idRaw) rule.id = Number(idRaw);
    if (existing && existing.priority != null) rule.priority = existing.priority;
    else if (!idRaw) {
        const maxP = allRules.reduce((m, r) => Math.max(m, Number(r.priority) || 0), 0);
        rule.priority = maxP + 10;
    }

    return rule;
}

function tagsForGroup(rules) {
    const set = new Set();
    for (const r of rules) {
        const t = r.tags;
        if (Array.isArray(t)) t.forEach((x) => set.add(String(x)));
        else if (typeof t === 'string') {
            String(t).split(',').forEach((s) => {
                const x = s.trim();
                if (x) set.add(x);
            });
        }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
}

function createRuleRow(rule) {
    const row = document.createElement('div');
    row.className = 'rule-row' + (selectedId === rule.id ? ' selected' : '');
    row.dataset.id = String(rule.id);
    const errDot = (rule.last_error && String(rule.last_error).trim())
        ? '<span class="err-dot visible" title="' + escHtml(rule.last_error) + '"></span>'
        : '<span class="err-dot"></span>';
    const hits = rule.hit_count != null ? `<span class="hit-badge" title="Hit count">${rule.hit_count}</span>` : '';
    row.innerHTML =
        '<div class="rule-card-top">' +
        '<span class="drag-handle" title="Drag to reorder">⠿</span>' +
        '<label class="rule-card-enable" onclick="event.stopPropagation()">' +
        `<input type="checkbox" class="rule-enabled" ${rule.enabled ? 'checked' : ''}></label>` +
        '<div class="rule-card-body">' +
        `<span class="name" title="${escHtml(rule.name)}">${escHtml(rule.name)}</span>` +
        '<div class="rule-card-badges">' +
        `<span class="badge-type ${interceptBadgeClass(rule.type)}">${escHtml(rule.type)}</span>` +
        hits +
        errDot +
        '</div>' +
        `<div class="rule-card-url" title="${escHtml(rule.url_pattern || '')}">${escHtml(rule.url_pattern || '')}</div>` +
        '</div></div>';

    row.querySelector('.rule-enabled').addEventListener('change', async (e) => {
        e.stopPropagation();
        const next = { ...rule, enabled: e.target.checked };
        const res = await api.saveInterceptRule(next);
        if (res && res.error) {
            showMsg(res.error, true);
            e.target.checked = !e.target.checked;
            return;
        }
        await loadRules();
    });

    row.addEventListener('click', (e) => {
        if (e.target.closest('.rule-enabled') || e.target.closest('.drag-handle')) return;
        selectedId = rule.id;
        fillEditor(rule);
        renderRuleList();
    });
    return row;
}

function renderRuleList() {
    const list = document.getElementById('rule-list-items');
    if (!list) return;
    const filtered = getFilteredRules();
    list.innerHTML = '';

    if (!filtered.length) {
        list.innerHTML = '<div class="cn-empty-state-sub" style="padding:12px">No rules match filters.</div>';
        destroySortable();
        return;
    }

    const byGroup = new Map();
    for (const r of filtered) {
        const g = (r.group_name || '').trim() || 'Default';
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(r);
    }
    const groups = [...byGroup.keys()].sort((a, b) => a.localeCompare(b));
    for (const g of groups) {
        const rulesInG = byGroup.get(g);
        const head = document.createElement('div');
        head.className = 'rule-group-head';
        head.dataset.group = g;
        const tags = tagsForGroup(rulesInG);
        const chips = tags.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('');
        head.innerHTML =
            `<span class="rule-group-title">${escHtml(g)} (${rulesInG.length})</span>` +
            `<span class="tag-chips">${chips}</span>`;
        list.appendChild(head);
        for (const rule of rulesInG) {
            list.appendChild(createRuleRow(rule));
        }
    }
    initSortable();
}

function destroySortable() {
    if (sortableInstance) {
        try { sortableInstance.destroy(); } catch { /* ignore */ }
        sortableInstance = null;
    }
}

function initSortable() {
    destroySortable();
    const list = document.getElementById('rule-list-items');
    if (!list || typeof Sortable === 'undefined') return;
    sortableInstance = Sortable.create(list, {
        draggable: '.rule-row',
        handle: '.drag-handle',
        animation: 150,
        ghostClass: 'sortable-ghost',
        onEnd: async () => {
            let currentGroup = 'Default';
            const orderedIds = [];
            const groupUpdates = [];
            for (const el of [...list.children]) {
                if (el.classList.contains('rule-group-head')) {
                    currentGroup = el.dataset.group || 'Default';
                    continue;
                }
                if (el.classList.contains('rule-row')) {
                    const rid = Number(el.dataset.id);
                    orderedIds.push(rid);
                    const rule = allRules.find((r) => r.id === rid);
                    if (rule) {
                        const prevG = (rule.group_name || '').trim() || 'Default';
                        if (prevG !== currentGroup) {
                            const gNorm = currentGroup === 'Default' ? null : currentGroup;
                            groupUpdates.push({ ...rule, group_name: gNorm });
                        }
                    }
                }
            }
            const n = orderedIds.length;
            const pairs = orderedIds.map((id, i) => ({ id, priority: (n - i) * 100 }));
            try {
                await api.reorderInterceptRules(pairs);
                for (const gr of groupUpdates) {
                    const res = await api.saveInterceptRule(gr);
                    if (res && res.error) showMsg(res.error, true);
                }
                await loadRules();
                showMsg('Order updated');
            } catch (e) {
                showMsg(String(e.message || e), true);
            }
        },
    });
}

async function loadRules() {
    try {
        allRules = await api.getInterceptRules() || [];
    } catch {
        allRules = [];
    }
    renderRuleList();
    maybeOnboarding();
}

function nextPriority() {
    return allRules.reduce((m, r) => Math.max(m, Number(r.priority) || 0), 0) + 10;
}

async function saveRule() {
    let rule;
    try {
        rule = collectRuleFromForm();
    } catch (e) {
        showMsg(e.message || String(e), true);
        return;
    }
    const res = await api.saveInterceptRule(rule);
    if (res && res.error) {
        showMsg(res.error, true);
        return;
    }
    showMsg(rule.id ? 'Rule saved' : 'Rule created');
    await loadRules();
    if (res && res.id) {
        selectedId = res.id;
        const created = allRules.find((r) => r.id === res.id);
        if (created) fillEditor(created);
    } else {
        const updated = allRules.find((r) => r.id === rule.id);
        if (updated) fillEditor(updated);
    }
}

async function duplicateRule() {
    let base;
    try {
        base = collectRuleFromForm();
    } catch (e) {
        showMsg(e.message || String(e), true);
        return;
    }
    delete base.id;
    base.name = `${base.name} (copy)`;
    base.priority = nextPriority();
    const res = await api.saveInterceptRule(base);
    if (res && res.error) {
        showMsg(res.error, true);
        return;
    }
    showMsg('Duplicated');
    await loadRules();
    if (res && res.id) {
        selectedId = res.id;
        const created = allRules.find((r) => r.id === res.id);
        if (created) fillEditor(created);
    }
}

function scheduleUrlTest() {
    clearTimeout(urlTestTimer);
    urlTestTimer = setTimeout(runUrlTest, 120);
}

async function runUrlTest() {
    const ind = document.getElementById('url-match-indicator');
    const pattern = document.getElementById('edit-pattern')?.value?.trim() || '';
    const testUrl = document.getElementById('edit-url-test')?.value?.trim() || '';
    if (!ind) return;
    if (!pattern || !testUrl) {
        ind.textContent = '';
        ind.className = 'match-bad';
        return;
    }
    try {
        const r = await api.testInterceptUrlMatch(pattern, testUrl);
        ind.textContent = r.ok ? '✓' : '✗';
        ind.className = r.ok ? 'match-ok' : 'match-bad';
    } catch {
        ind.textContent = '?';
        ind.className = 'match-bad';
    }
}

// ─── Activity log ─────────────────────────────────────────────────────────────

const _actAll = [];
let _actPageSize = 50;
let _actDisplayed = 50;

function fmtTime(d) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function extractPage(url) {
    try {
        const u = new URL(url);
        return u.origin + u.pathname;
    } catch { return url; }
}

function activityMatchesFilters(e) {
    const qs = (document.getElementById('activity-search')?.value || '').trim().toLowerCase();
    const tf = document.getElementById('activity-type-filter')?.value || '';
    const fromEl = document.getElementById('activity-from');
    const toEl = document.getElementById('activity-to');
    let fromTs = null;
    let toTs = null;
    if (fromEl && fromEl.value) {
        fromTs = new Date(fromEl.value).getTime();
    }
    if (toEl && toEl.value) {
        toTs = new Date(toEl.value).getTime();
    }
    if (tf && e.type !== tf) return false;
    if (qs) {
        const blob = `${e.ruleName || ''} ${e.url || ''}`.toLowerCase();
        if (!blob.includes(qs)) return false;
    }
    const t = e.ts instanceof Date ? e.ts.getTime() : new Date(e.ts || 0).getTime();
    if (fromTs != null && !Number.isNaN(fromTs) && t < fromTs) return false;
    if (toTs != null && !Number.isNaN(toTs) && t > toTs) return false;
    return true;
}

function getFilteredActivity() {
    return _actAll.filter(activityMatchesFilters);
}

function renderActivity() {
    const log = document.getElementById('activity-body');
    const cnt = document.getElementById('activity-count');
    if (!log) return;
    const filtered = getFilteredActivity();
    if (cnt) cnt.textContent = String(filtered.length);

    const slice = filtered.slice(-_actDisplayed);
    log.innerHTML = '';
    if (!slice.length) {
        log.innerHTML = '<div class="cn-empty-state-sub">No activity yet.</div>';
        return;
    }
    let currentGroup = null;
    for (const e of slice) {
        const page = extractPage(e.url || '');
        if (page !== currentGroup) {
            currentGroup = page;
            const hdr = document.createElement('div');
            hdr.style.cssText = 'font-weight:600;opacity:0.75;margin:6px 0 2px';
            hdr.textContent = page;
            log.appendChild(hdr);
        }
        const row = document.createElement('div');
        row.className = 'act-entry';
        row.innerHTML =
            `<span>${fmtTime(e.ts instanceof Date ? e.ts : new Date(e.ts))}</span>` +
            `<span>${escHtml(e.type)}</span>` +
            `<span style="font-weight:600">${escHtml(e.ruleName || '')}</span>` +
            `<span title="${escHtml(e.url)}">${escHtml((e.url || '').slice(0, 120))}</span>`;
        log.appendChild(row);
    }
    log.scrollTop = log.scrollHeight;
}

function pushActivity(info) {
    const ts = info.ts ? new Date(info.ts) : new Date();
    _actAll.push({
        type: info.type,
        ruleName: info.ruleName || 'Unknown',
        url: info.url || '',
        detail: info.detail || '',
        ts,
    });
    if (_actAll.length > 2000) _actAll.splice(0, _actAll.length - 2000);
    renderActivity();
}

function focusRuleByName(name) {
    const r = allRules.find((x) => x.name === name);
    if (!r) return;
    selectedId = r.id;
    fillEditor(r);
    renderRuleList();
}

async function showHistoryModal() {
    const id = selectedId;
    if (!id) return;
    let rows;
    try {
        rows = await api.getInterceptRuleHistory(id, 30);
    } catch {
        rows = [];
    }
    const box = document.getElementById('history-content');
    if (!rows || !rows.length) {
        box.innerHTML = '<p>No history entries yet.</p>';
    } else {
        const parts = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let snap;
            try { snap = JSON.parse(row.snapshot); } catch { snap = row.snapshot; }
            const prevRow = rows[i + 1];
            let prevSnap = null;
            if (prevRow) {
                try { prevSnap = JSON.parse(prevRow.snapshot); } catch { prevSnap = null; }
            }
            let diffHtml = '';
            if (prevSnap && snap && api.formatInterceptRuleDiffHtml) {
                const dr = await api.formatInterceptRuleDiffHtml(JSON.stringify(prevSnap), JSON.stringify(snap));
                if (dr && dr.ok) {
                    diffHtml = `<div class="history-diff" style="overflow:auto;max-height:240px;border:1px solid var(--border);border-radius:8px;padding:8px;background:var(--bg0)">${dr.html}</div>`;
                } else {
                    diffHtml = '<pre style="font-size:11px;overflow:auto;max-height:200px">' + escHtml(JSON.stringify(snap, null, 2)) + '</pre>';
                }
            } else {
                diffHtml = '<pre style="font-size:11px;overflow:auto;max-height:200px">' + escHtml(JSON.stringify(snap, null, 2)) + '</pre>';
            }
            parts.push('<div style="border-bottom:1px solid var(--border);margin-bottom:12px;padding-bottom:8px">' +
                '<strong>#' + escHtml(String(row.id)) + '</strong> · ' + escHtml(row.changed_at || '') + diffHtml + '</div>');
        }
        box.innerHTML = parts.join('');
    }
    document.getElementById('history-modal').classList.add('visible');
}

function hideHistoryModal() {
    document.getElementById('history-modal').classList.remove('visible');
}

const ONBOARDING_STEPS = [
    {
        title: 'Step 1 — Create your first rule',
        text: 'Click <strong>+ New</strong> or pick a <strong>Template</strong>, then set URL pattern and action.',
    },
    {
        title: 'Step 2 — Choose action type',
        text: 'Use <strong>Block</strong>, <strong>Mock</strong>, <strong>Modify headers</strong>, or <strong>Dynamic script</strong>. Advanced conditions support header/body matching.',
    },
    {
        title: 'Step 3 — Test with Activity',
        text: 'Open the <strong>Activity</strong> panel below to see when rules match. Export JSON or CSV for review.',
    },
];

let _onboardingStep = 0;

function showOnboardingStep() {
    const s = ONBOARDING_STEPS[_onboardingStep];
    const t = document.getElementById('onb-title');
    const p = document.getElementById('onb-text');
    const next = document.getElementById('onb-next');
    if (t && s) t.innerHTML = s.title;
    if (p && s) p.innerHTML = s.text;
    if (next) next.textContent = _onboardingStep >= ONBOARDING_STEPS.length - 1 ? 'Done' : 'Next';
}

function maybeOnboarding() {
    const key = 'cupnet.rules.onboarding.v1';
    try {
        if (localStorage.getItem(key)) return;
        if (allRules.length > 0) return;
        _onboardingStep = 0;
        showOnboardingStep();
        const ov = document.getElementById('onboarding-overlay');
        if (ov) ov.classList.add('visible');
    } catch { /* ignore */ }
}

function dismissOnboarding() {
    const key = 'cupnet.rules.onboarding.v1';
    try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    const ov = document.getElementById('onboarding-overlay');
    if (ov) ov.classList.remove('visible');
}

function advanceOnboarding() {
    _onboardingStep += 1;
    if (_onboardingStep >= ONBOARDING_STEPS.length) {
        dismissOnboarding();
        return;
    }
    showOnboardingStep();
}

function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
        const meta = e.metaKey || e.ctrlKey;
        if (meta && e.key === 'n') {
            e.preventDefault();
            fillEditor(null);
            document.getElementById('edit-name').focus();
        } else if (meta && e.key === 's') {
            e.preventDefault();
            void saveRule();
        } else if (meta && e.key === 'd') {
            e.preventDefault();
            void duplicateRule();
        } else if (meta && e.key === 'f') {
            e.preventDefault();
            document.getElementById('rules-search')?.focus();
        } else if (meta && e.key === 'e') {
            e.preventDefault();
            const row = document.querySelector('.rule-row.selected .rule-enabled');
            if (row) row.click();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const list = getFilteredRules();
            if (!list.length) return;
            e.preventDefault();
            let idx = list.findIndex((r) => r.id === selectedId);
            if (e.key === 'ArrowDown') {
                idx = idx < 0 ? 0 : Math.min(list.length - 1, idx + 1);
            } else {
                idx = idx <= 0 ? 0 : idx - 1;
            }
            const n = list[idx];
            if (n) {
                selectedId = n.id;
                fillEditor(n);
                renderRuleList();
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (!selectedId) return;
            e.preventDefault();
            if (!confirm('Delete this rule?')) return;
            void (async () => {
                await api.deleteInterceptRule(selectedId);
                showMsg('Deleted');
                clearEditor();
                await loadRules();
            })();
        }
    });
}

function wireEvents() {
    onChange('edit-type', (e) => {
        showInterceptParamsFor(e.target.value);
        const out = document.getElementById('script-test-out');
        if (out) { out.style.display = 'none'; out.textContent = ''; }
    });

    onInput('edit-delay', (e) => {
        const val = e.target.value;
        const v = document.getElementById('edit-delay-val');
        if (v) v.textContent = val;
        e.target.setAttribute('aria-valuetext', `${val} ms`);
    });

    onInput('edit-pattern', scheduleUrlTest);
    onInput('edit-url-test', scheduleUrlTest);

    onClick('btn-new-rule', () => {
        fillEditor(null);
        document.getElementById('edit-name').focus();
    });

    onChange('rule-template-select', async (e) => {
        const id = e.target.value;
        if (!id || !RULE_TEMPLATES[id]) return;
        const t = RULE_TEMPLATES[id];
        const rule = {
            name: t.name,
            type: t.type,
            url_pattern: t.url_pattern,
            method: t.method || '*',
            group_name: t.group_name || null,
            tags: t.tags || [],
            delay_ms: t.delay_ms || 0,
            params: t.params || {},
            enabled: true,
            priority: nextPriority(),
        };
        e.target.value = '';
        const res = await api.saveInterceptRule(rule);
        if (res && res.error) showMsg(res.error, true);
        else {
            showMsg('Template created');
            await loadRules();
            if (res && res.id) {
                selectedId = res.id;
                const cr = allRules.find((x) => x.id === res.id);
                if (cr) fillEditor(cr);
            }
        }
    });

    onClick('btn-dup-rule', () => { void duplicateRule(); });
    onClick('btn-save', () => { void saveRule(); });
    onClick('btn-cancel', () => {
        clearEditor();
        renderRuleList();
    });
    onClick('btn-copy-llm', () => { void copyInterceptAiPrompt(); });

    onClick('btn-script-test', async () => {
        const before = monacoGet('edit-script-before');
        const after = monacoGet('edit-script-after');
        const out = document.getElementById('script-test-out');
        if (!api.testInterceptScript) {
            showMsg('testInterceptScript unavailable', true);
            return;
        }
        try {
            const res = await api.testInterceptScript({ beforeSource: before, afterSource: after });
            if (out) {
                out.style.display = 'block';
                out.textContent = res.ok ? (res.summary || 'OK') : `Error: ${res.error || 'unknown'}`;
            }
            showMsg(res.ok ? 'Script self-test OK' : (res.error || 'Error'), !res.ok);
        } catch (err) {
            if (out) {
                out.style.display = 'block';
                out.textContent = String(err.message || err);
            }
            showMsg(String(err.message || err), true);
        }
    });

    onClick('btn-browse-mock', async () => {
        if (!api.selectMockFile) return;
        const result = await api.selectMockFile();
        if (result && result.filePath) {
            document.getElementById('edit-mock-file').value = result.filePath;
        }
    });

    onClick('btn-export-rules', async () => {
        const r = await api.exportInterceptRules();
        if (r && r.ok) showMsg('Exported');
        else if (r && r.error) showMsg(r.error, true);
    });

    onClick('btn-import-rules', async () => {
        const r = await api.importInterceptRules();
        if (r && r.ok) {
            showMsg(`Imported ${r.imported || 0} rule(s)`);
            await loadRules();
        } else if (r && r.error) showMsg(r.error, true);
    });

    onClick('btn-history', () => { void showHistoryModal(); });
    onClick('btn-history-close', hideHistoryModal);

    onClick('btn-test-notification', async () => {
        await api.testInterceptNotification();
        showMsg('Test toasts sent');
    });

    onClick('activity-toggle', () => {
        document.getElementById('activity-panel').classList.toggle('collapsed');
    });

    onInput('activity-search', () => { _actDisplayed = 50; renderActivity(); });
    onChange('activity-type-filter', () => { _actDisplayed = 50; renderActivity(); });
    onChange('activity-from', () => { _actDisplayed = 50; renderActivity(); });
    onChange('activity-to', () => { _actDisplayed = 50; renderActivity(); });

    onClick('btn-activity-more', () => {
        _actDisplayed += 50;
        renderActivity();
    });

    onClick('btn-activity-export', async () => {
        const entries = getFilteredActivity();
        const r = await api.exportRulesActivityLog({ entries });
        if (r && r.ok) showMsg('Activity exported');
        else if (r && r.error) showMsg(r.error, true);
    });

    onClick('btn-activity-export-csv', async () => {
        const entries = getFilteredActivity();
        const r = await api.exportRulesActivityLog({ entries, format: 'csv' });
        if (r && r.ok) showMsg('Activity exported (CSV)');
        else if (r && r.error) showMsg(r.error, true);
    });

    onClick('btn-activity-clear', () => {
        _actAll.length = 0;
        _actDisplayed = 50;
        renderActivity();
        api.resetToolbarActivityBadge?.('rules');
    });

    onClick('onb-next', advanceOnboarding);
    onClick('onb-skip', dismissOnboarding);

    onInput('rules-search', () => renderRuleList());
    onInput('group-filter', () => renderRuleList());
    onInput('tag-filter', () => renderRuleList());

    api.onPrefillInterceptRule?.((data) => {
        fillEditor({
            name: data.name || '',
            url_pattern: data.url_pattern || '',
            type: 'mock',
            params: data.params || { status: 200, mimeType: 'application/json', body: '' },
            enabled: true,
            method: '*',
            priority: nextPriority(),
        });
        document.getElementById('edit-name').focus();
    });

    api.onInterceptRuleMatched?.(pushActivity);
    api.onInterceptRuleMatchedBatch?.((items) => {
        if (!Array.isArray(items)) return;
        for (const info of items) pushActivity(info);
    });
}

async function boot() {
    buildTypeFilters();
    buildMethodCheckboxes();
    initMockMimeSelect();
    wireEvents();
    bindKeyboard();

    if (window.CupNetRulesMonaco) {
        try {
            await CupNetRulesMonaco.init(api);
        } catch { /* monaco optional */ }
    }

    await loadRules();
    renderActivity();
}

document.addEventListener('DOMContentLoaded', () => { void boot(); });
