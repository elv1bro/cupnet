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

function syncInterceptAiPromptElements() {
    const ed = document.getElementById('intercept-ai-prompt-editor');
    if (ed) ed.value = getInterceptAiPrompt();
}

function populateScriptPresetSelect() {
    const sel = document.getElementById('script-snippet-preset');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    for (const p of SCRIPT_PRESETS) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label;
        sel.appendChild(o);
    }
}

function getSelectedScriptPreset() {
    const sel = document.getElementById('script-snippet-preset');
    const id = sel && sel.value;
    if (!id) return null;
    return SCRIPT_PRESETS.find((x) => x.id === id) || null;
}

function applyScriptPresetToFields() {
    const p = getSelectedScriptPreset();
    if (!p) {
        showMsg('Choose a preset first', true);
        return;
    }
    const b = document.getElementById('edit-script-before');
    const a = document.getElementById('edit-script-after');
    if (b) b.value = p.before;
    if (a) a.value = p.after;
    showMsg('Preset applied to fields');
}

async function copyScriptPresetClipboard() {
    const p = getSelectedScriptPreset();
    if (!p) {
        showMsg('Choose a preset first', true);
        return;
    }
    const text = [
        `CupNet Dynamic script — ${p.label}`,
        '',
        '--- Before MITM ---',
        p.before || '// (empty)',
        '',
        '--- After response ---',
        p.after || '// (empty)',
    ].join('\n');
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showMsg('Snippet copied');
    } catch (e) {
        showMsg('Copy failed', true);
    }
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
// INTERCEPT RULES
// ═══════════════════════════════════════════════════════════════════════════════

let editingInterceptId = null;

/** Preset MIME types for mock Content-Type (order matches UI select). */
const MOCK_MIME_CUSTOM = '__custom__';
const MOCK_MIME_PRESETS = [
    'application/json',
    'text/html',
    'text/plain',
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/xml',
    'text/xml',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'image/png',
    'image/jpeg',
    'image/svg+xml',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/wasm',
    'application/octet-stream',
    'video/mp4',
    'audio/mpeg',
];

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

/** Chromium spellcheck + synchronous multi‑MB .value assignment can freeze the window; defer huge payloads. */
const _MOCK_BODY_DEFER_CHARS = 96 * 1024;
let _mockBodyDeferredTimer = null;

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
        return;
    }
    _mockBodyDeferredTimer = setTimeout(() => {
        _mockBodyDeferredTimer = null;
        el.value = text;
    }, 0);
}

// ── Mock body source toggle (text vs file) ─────────────────────────────────

function getMockBodySource() {
    const checked = document.querySelector('input[name="mock-body-source"]:checked');
    return checked ? checked.value : 'text';
}

function setMockBodySource(src) {
    const radio = document.querySelector(`input[name="mock-body-source"][value="${src === 'file' ? 'file' : 'text'}"]`);
    if (radio) radio.checked = true;
    syncMockBodySourceVisibility();
}

function syncMockBodySourceVisibility() {
    const isFile = getMockBodySource() === 'file';
    const textRow = document.getElementById('mock-body-text-row');
    const fileRow = document.getElementById('mock-body-file-row');
    if (textRow) textRow.style.display = isFile ? 'none' : '';
    if (fileRow) fileRow.style.display = isFile ? '' : 'none';
}

document.querySelectorAll('input[name="mock-body-source"]').forEach(r => {
    r.addEventListener('change', syncMockBodySourceVisibility);
});

onClick('btn-browse-mock-file', async () => {
    if (!api.selectMockFile) return;
    const result = await api.selectMockFile();
    if (result && result.filePath) {
        document.getElementById('edit-mock-file-path').value = result.filePath;
        const info = document.getElementById('mock-file-info');
        if (info) {
            const sizeKb = result.size != null ? `${(result.size / 1024).toFixed(1)} KB` : '';
            info.textContent = sizeKb ? `File size: ${sizeKb}` : '';
        }
    }
});

function showInterceptParamsFor(type) {
    document.getElementById('intercept-params-block').style.display   = type === 'block'         ? 'block' : 'none';
    document.getElementById('intercept-params-headers').style.display = type === 'modifyHeaders' ? 'block' : 'none';
    document.getElementById('intercept-params-mock').style.display    = type === 'mock'          ? 'block' : 'none';
    document.getElementById('intercept-params-script').style.display  = type === 'script'        ? 'block' : 'none';
}

onChange('edit-intercept-type', e => {
    showInterceptParamsFor(e.target.value);
    const out = document.getElementById('script-test-out');
    if (out) { out.classList.remove('visible'); out.textContent = ''; }
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
    setMockMimeUiValue(rule?.type === 'mock' ? (rule.params?.mimeType || 'application/json') : 'application/json');
    setMockBodySource(rule?.type === 'mock' ? (rule.params?.mockSource || 'text') : 'text');
    setInterceptMockBodyValue(rule?.type === 'mock' ? (rule.params?.body ?? '') : '');
    document.getElementById('edit-mock-file-path').value = rule?.type === 'mock' ? (rule.params?.mockFilePath || '') : '';
    const mockFileInfo = document.getElementById('mock-file-info');
    if (mockFileInfo) mockFileInfo.textContent = '';
    const sb = document.getElementById('edit-script-before');
    const sa = document.getElementById('edit-script-after');
    if (sb) sb.value = rule?.type === 'script' ? (rule.params?.beforeSource || '') : '';
    if (sa) sa.value = rule?.type === 'script' ? (rule.params?.afterSource  || '') : '';
    const out = document.getElementById('script-test-out');
    if (out) { out.classList.remove('visible'); out.textContent = ''; }
    document.getElementById('intercept-edit-form').classList.add('visible');
    document.getElementById('edit-intercept-name').focus();
}

function hideInterceptForm() {
    document.getElementById('intercept-edit-form').classList.remove('visible');
    editingInterceptId = null;
    if (_mockBodyDeferredTimer) {
        clearTimeout(_mockBodyDeferredTimer);
        _mockBodyDeferredTimer = null;
    }
    const mockEl = document.getElementById('edit-mock-body');
    if (mockEl) mockEl.value = '';
}

function interceptBadgeClass(type) {
    if (type === 'block') return 'badge-block';
    if (type === 'mock') return 'badge-mock';
    if (type === 'script') return 'badge-script';
    return 'badge-modify';
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
        const badgeCls = interceptBadgeClass(rule.type);
        const item = document.createElement('div');
        item.className = 'rule-item';
        item.innerHTML =
            `<label class="toggle">
                <input type="checkbox" class="intercept-toggle" data-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
                <span class="toggle-track"></span>
             </label>
             <span class="rule-name">${escHtml(rule.name)}</span>
             <span class="badge ${badgeCls}">${escHtml(rule.type)}</span>
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

onClick('btn-copy-intercept-ai-prompt', () => { void copyInterceptAiPrompt(); });
onClick('btn-script-preset-insert', () => applyScriptPresetToFields());
onClick('btn-script-preset-copy', () => { void copyScriptPresetClipboard(); });

onClick('btn-test-script', async () => {
    const before = document.getElementById('edit-script-before')?.value ?? '';
    const after  = document.getElementById('edit-script-after')?.value ?? '';
    const out = document.getElementById('script-test-out');
    if (!api.testInterceptScript) {
        showMsg('testInterceptScript is not available (update the app)', true);
        return;
    }
    try {
        const res = await api.testInterceptScript({
            beforeSource: before,
            afterSource: after,
        });
        if (out) {
            out.classList.add('visible');
            out.textContent = res.ok
                ? (res.summary || 'OK')
                : `Error: ${res.error || 'unknown'}`;
        }
        showMsg(res.ok ? 'Script self-test: OK' : (res.error || 'Error'), !res.ok);
    } catch (e) {
        if (out) {
            out.classList.add('visible');
            out.textContent = String(e.message || e);
        }
        showMsg(String(e.message || e), true);
    }
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
        params.mimeType = getMockMimeValue();
        params.mockSource = getMockBodySource();
        if (params.mockSource === 'file') {
            params.mockFilePath = document.getElementById('edit-mock-file-path').value.trim();
            if (!params.mockFilePath) { showMsg('File path is required for file-based mock', true); return; }
        } else {
            params.body = document.getElementById('edit-mock-body').value;
        }
    } else if (type === 'script') {
        params.beforeSource = document.getElementById('edit-script-before').value;
        params.afterSource  = document.getElementById('edit-script-after').value;
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
    const interceptTabBtn = document.querySelector('.tab-btn[data-tab="intercept"]');
    if (interceptTabBtn) interceptTabBtn.click();

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
        let icon = '🔧';
        let typeCls = 'act-type-modify';
        if (e.type === 'mock') { icon = '⚡'; typeCls = 'act-type-mock'; }
        else if (e.type === 'block') { icon = '🚫'; typeCls = 'act-type-block'; }
        else if (e.type === 'script') { icon = '📜'; typeCls = 'act-type-script'; }
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
    api.resetToolbarActivityBadge?.('rules');
});

// ─── Init ─────────────────────────────────────────────────────────────────────
initMockMimeSelect();
populateScriptPresetSelect();
syncInterceptAiPromptElements();
loadInterceptRules();
