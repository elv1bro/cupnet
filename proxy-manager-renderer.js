'use strict';

const api = window.electronAPI;

// ─── State ────────────────────────────────────────────────────────────────────
let profiles       = [];
let selectedId     = null;   // id of profile being edited
let isNew          = false;
let ephemeralVars  = {};     // {SID: 'value', ...} — not saved to profile
let lastResolvedVars = {};   // {SID: 'cupnet1234', RAND: '42351'} — values used in last connect
let _storedResolvedVars = {}; // persistent copy, survives profile switches
let connectedId    = null;   // id of currently connected profile
let currentIp      = '';
let searchQuery    = '';

// Built-in virtual Direct profile
const DIRECT_ID = '__direct__';
const DIRECT_PROFILE = {
    id:          DIRECT_ID,
    name:        'Direct',
    url_display: 'No proxy — direct connection',
    is_template: 0,
    tls_profile:    'chrome',
    tls_ja3_mode:   'template',
    tls_ja3_custom: null,
    traffic_mode: 'mitm',
    user_agent: null, timezone: null, language: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const profileList   = document.getElementById('profile-list');
const editorEmpty   = document.getElementById('editor-empty');
const editorWrap    = document.getElementById('editor-wrap');
const editorTitle   = document.getElementById('editor-title');
const searchInput   = document.getElementById('search-profiles');

const fName         = document.getElementById('f-name');
const fTemplate     = document.getElementById('f-template');
const fNotes        = document.getElementById('f-notes');
const fTrafficMode  = document.getElementById('f-traffic-mode');
const tplPreview    = document.getElementById('tpl-preview');
const varsSection   = document.getElementById('vars-section');
const varsTbody     = document.getElementById('vars-tbody');

// Fingerprint fields
const fUa           = document.getElementById('f-ua');
const fTimezone     = document.getElementById('f-timezone');
const fLanguage     = document.getElementById('f-language');
const fpActiveBadge = document.getElementById('fp-active-badge');
const fpSection     = document.getElementById('fp-section');

// UA presets
const UA_PRESETS = {
    'chrome-win': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'chrome-mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'firefox':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
    'safari':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15',
    'mobile':     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
};

document.querySelectorAll('.fp-preset').forEach(btn => {
    btn.addEventListener('click', () => {
        fUa.value = UA_PRESETS[btn.dataset.ua] || '';
        updateFpBadge();
    });
});

function updateFpBadge() {
    const hasCustom = fUa?.value.trim() || fTimezone?.value || fLanguage?.value || tlsGetMode() !== 'template' || tlsGetTemplate() !== 'chrome';
    if (fpActiveBadge) fpActiveBadge.style.display = hasCustom ? '' : 'none';
}

[fUa, fTimezone, fLanguage].forEach(el => el?.addEventListener('change', updateFpBadge));
fUa?.addEventListener('input', updateFpBadge);

// ─── TLS Fingerprint ──────────────────────────────────────────────────────────
// Combined profile: TLS fingerprint + HTTP/2 settings + User-Agent
const TLS_TEMPLATE_DESCS = {
    chrome:  'Chrome 133 (Windows)\nUA: Chrome/133.0.0.0\nHTTP/2: Chrome SETTINGS · WINDOW=15663105 · m,a,s,p\nJA3: TLS 1.3+GREASE+X25519MLKEM768. Industry standard.',
    firefox: 'Firefox 138 (Windows)\nUA: Firefox/138.0\nHTTP/2: Firefox SETTINGS (WINDOW=65536, MAX_FRAME=16384) · m,p,s,a\nJA3: no GREASE, unique extension order. Best privacy.',
    safari:  'Safari 18 (macOS)\nUA: Safari/605.1.15 Version/18.3\nHTTP/2: Safari SETTINGS (WINDOW=10485760) · m,s,a,p\nJA3: Apple TLS stack, fewer extensions.',
    ios:     'iOS 18 (Mobile Safari)\nUA: iPhone Mobile Safari\nHTTP/2: same as Safari · m,s,a,p\nJA3: mobile Apple fingerprint.',
    edge:    'Edge 133 (Windows)\nUA: Edg/133.0.0.0\nHTTP/2: identical to Chrome · m,a,s,p\nJA3: Chromium-based, Chrome-identical TLS.',
    opera:   'Opera 119 (Windows)\nUA: OPR/119.0.0.0\nHTTP/2: identical to Chrome · m,a,s,p\nJA3: Chromium-based, Chrome-identical TLS.',
};

// Real JA3 strings measured via tls.peet.ws for each AzureTLS profile
const TLS_JA3_PRESETS = {
    chrome:  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,18-10-5-13-27-51-45-17613-11-23-65037-43-16-0-35-65281,4588-29-23-24,0',
    firefox: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,17613-65037-13-11-45-35-10-65281-5-43-16-18-23-27-51-0,4588-29-23-24,0',
    safari:  '771,4865-4866-4867-49196-49195-52393-49200-49199-52392-49162-49161-49172-49171-157-156-53-47-255,0-11-10-35-16-22-23-13-43-45-51,29-23-24-25,0',
    ios:     '771,4865-4866-4867-49196-49195-52393-49200-49199-52392-49162-49161-49172-49171-157-156-53-47-255,0-11-10-35-16-22-23-13-43-45-51,29-23-24-25,0',
    edge:    '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,18-10-5-13-27-51-45-17613-11-23-65037-43-16-0-35-65281,4588-29-23-24,0',
    opera:   '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,18-10-5-13-27-51-45-17613-11-23-65037-43-16-0-35-65281,4588-29-23-24,0',
};

const tlsModeRadios   = document.querySelectorAll('input[name="tls-mode"]');
const tlsTemplateBlock = document.getElementById('tls-template-block');
const tlsCustomBlock  = document.getElementById('tls-custom-block');
const tlsTplDesc      = document.getElementById('tls-tpl-desc');
const fpTlsBadge      = document.getElementById('fp-tls-badge');

const ja3FullInput  = document.getElementById('tls-ja3-full');

function tlsGetMode()     { return document.querySelector('input[name="tls-mode"]:checked')?.value || 'template'; }
function tlsGetTemplate() { return document.querySelector('.tls-tpl-btn.active')?.dataset?.tls || 'chrome'; }

function tlsSetMode(mode) {
    document.querySelectorAll('input[name="tls-mode"]').forEach(r => { r.checked = r.value === mode; });
    if (tlsTemplateBlock) tlsTemplateBlock.style.display = mode === 'template' ? '' : 'none';
    if (tlsCustomBlock)   tlsCustomBlock.style.display   = mode === 'custom'   ? '' : 'none';
    if (fpTlsBadge) fpTlsBadge.style.display = mode === 'custom' ? '' : 'none';
}

function tlsSetTemplate(name) {
    document.querySelectorAll('.tls-tpl-btn').forEach(b => b.classList.toggle('active', b.dataset.tls === name));
    if (tlsTplDesc) tlsTplDesc.textContent = TLS_TEMPLATE_DESCS[name] || '';
}

function ja3BuildFull() {
    return ja3FullInput?.value.trim() || '';
}

function ja3ParseFull(str) {
    if (!str) return;
    if (ja3FullInput) ja3FullInput.value = str;
}

function ja3SyncFull() {
    // no-op: full string is the single source of truth
}

// Template buttons — also apply immediately to MITM worker
document.querySelectorAll('.tls-tpl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tpl = btn.dataset.tls;
        tlsSetTemplate(tpl);
        updateFpBadge();
        // Apply immediately so stats panel & live requests reflect the choice
        api.setTlsProfile && api.setTlsProfile(tpl).catch(() => {});
    });
});

// Mode radio
tlsModeRadios.forEach(r => {
    r.addEventListener('change', () => {
        tlsSetMode(r.value);
        updateFpBadge();
    });
});

// Copy full JA3
document.getElementById('tls-ja3-copy')?.addEventListener('click', () => {
    const str = ja3FullInput?.value || ja3BuildFull();
    navigator.clipboard.writeText(str).then(() => {
        const btn = document.getElementById('tls-ja3-copy');
        if (btn) { btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
    });
});

// Prefill buttons (fill custom JA3 fields from preset)
document.querySelectorAll('.ja3-prefill').forEach(btn => {
    btn.addEventListener('click', () => {
        const ja3 = TLS_JA3_PRESETS[btn.dataset.ja3];
        if (ja3) {
            ja3ParseFull(ja3);
            ja3SyncFull();
        }
    });
});

// TLS getters/setters for save/load
function tlsGetSaveData() {
    const mode = tlsGetMode();
    return {
        tls_profile:    tlsGetTemplate(),
        tls_ja3_mode:   mode,
        tls_ja3_custom: mode === 'custom' ? ja3BuildFull() : null,
    };
}

function tlsLoadFromProfile(profile) {
    const mode = profile.tls_ja3_mode || 'template';
    const tpl  = profile.tls_profile  || 'chrome';
    tlsSetMode(mode);
    tlsSetTemplate(tpl);
    if (mode === 'custom' && profile.tls_ja3_custom) {
        ja3ParseFull(profile.tls_ja3_custom);
        ja3SyncFull();
    } else {
        // Show the preset JA3 for the selected template
        ja3ParseFull(TLS_JA3_PRESETS[tpl] || TLS_JA3_PRESETS.chrome);
        ja3SyncFull();
    }
}

// Init: default state
tlsSetMode('template');
tlsSetTemplate('chrome');

const btnAddProfile = document.getElementById('btn-add-profile');
const btnSave       = document.getElementById('btn-save');
const btnCancel     = document.getElementById('btn-cancel');
const btnDelete     = document.getElementById('btn-delete');
const btnDuplicate  = document.getElementById('btn-duplicate');
const btnTest       = document.getElementById('btn-test');
const btnApplyTab   = document.getElementById('btn-apply-tab');
const btnApplyGlobal = document.getElementById('btn-apply-global');
const btnDisconnect = document.getElementById('btn-disconnect');
const btnCheckIp    = document.getElementById('btn-check-ip');

const statusDot     = document.getElementById('status-dot');
const statusLabel   = document.getElementById('status-label');
const statusIp      = document.getElementById('status-ip');
const saveStatus    = document.getElementById('save-status');
const testResult    = document.getElementById('test-result');

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function setSaveStatus(msg, type = '') {
    saveStatus.textContent = msg;
    saveStatus.style.color = type === 'ok' ? '#22c55e' : type === 'err' ? '#ef4444' : 'var(--dim)';
    if (type) setTimeout(() => { saveStatus.textContent = ''; }, 3000);
}

/** Parse template, return vars found: { name, type: 'sid'|'rand'|'saved', range? } */
function parseTemplateVars(template) {
    const result = [];
    const seen   = new Set();
    for (const m of (template || '').matchAll(/\{(RAND:(\d+)-(\d+)|([A-Z_][A-Z0-9_]*))\}/gi)) {
        const full = m[1];
        if (/^RAND:/i.test(full)) {
            const key = full.toUpperCase();
            if (!seen.has(key)) { seen.add(key); result.push({ name: full, type: 'rand', range: `${m[2]}–${m[3]}` }); }
        } else {
            const name = full.toUpperCase();
            if (!seen.has(name)) {
                seen.add(name);
                result.push({ name, type: name === 'SID' ? 'sid' : 'saved' });
            }
        }
    }
    return result;
}

/** Resolve template with current ephemeral + saved vars for preview */
function resolvePreview(template, savedVars) {
    if (!template) return '—';
    const merged = { ...savedVars, ...ephemeralVars };
    return template
        .replace(/\{RAND:(\d+)-(\d+)\}/gi, (_, mn, mx) => `<span class="var-rand">{RAND:${mn}-${mx}}</span>`)
        .replace(/\{SID\}/gi, () => {
            const v = ephemeralVars['SID'];
            if (v) return `<span style="color:#f9a8d4">${esc(v)}</span>`;
            return `<span style="color:#f9a8d4;opacity:.6" title="Auto: cupnet + 10 random digits">cupnet••••••••••</span>`;
        })
        .replace(/\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name) => {
            const key = Object.keys(merged).find(k => k.toUpperCase() === name.toUpperCase());
            if (key && merged[key]) return `<span style="color:#c4b5fd">${esc(merged[key])}</span>`;
            return `<span class="var-placeholder">${esc(match)}</span>`;
        });
}

/** Get current saved vars from vars table inputs */
function collectVarsFromForm() {
    const vars = {};
    if (!varsTbody) return vars;
    varsTbody.querySelectorAll('[data-varname]').forEach(inp => {
        const name = inp.dataset.varname;
        if (inp.dataset.vartype !== 'sid' && inp.dataset.vartype !== 'rand') {
            vars[name] = inp.value.trim();
        } else if (inp.dataset.vartype === 'sid') {
            ephemeralVars['SID'] = inp.value.trim();
        }
    });
    return vars;
}

/** Build all current non-ephemeral vars (saved + current editor inputs) */
function getCurrentSavedVars() {
    const profile = profiles.find(p => p.id === selectedId);
    const base    = profile?.variables || {};
    return { ...base, ...collectVarsFromForm() };
}

/** Full resolution for connect/test (replaces RAND too) */
function resolveTemplateFull(template, savedVars) {
    const merged = { ...savedVars, ...ephemeralVars };
    return template
        .replace(/\{RAND:(\d+)-(\d+)\}/gi, (_, mn, mx) => {
            const min = parseInt(mn, 10), max = parseInt(mx, 10);
            return String(Math.floor(Math.random() * (max - min + 1)) + min);
        })
        .replace(/\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name) => {
            const key = Object.keys(merged).find(k => k.toUpperCase() === name.toUpperCase());
            return key !== undefined ? String(merged[key] ?? '') : match;
        });
}

// ─── Profile list ─────────────────────────────────────────────────────────────
function renderProfileList() {
    const q = searchQuery.toLowerCase();
    profileList.innerHTML = '';

    // Always show Direct at top (unless search query doesn't match)
    const directMatches = !q || 'direct'.includes(q) || 'no proxy'.includes(q);
    if (directMatches) {
        const el = document.createElement('div');
        el.className = 'profile-item profile-item-direct';
        if (selectedId === DIRECT_ID) el.classList.add('active-profile');
        if (connectedId === DIRECT_ID) el.classList.add('connected');
        const connLabel = connectedId === DIRECT_ID ? `<span class="pi-connected-label">● CONNECTED</span>` : '';
        el.innerHTML = `
            <div class="pi-name"><span style="opacity:.7">🌐</span> Direct</div>
            <div class="pi-host" style="color:var(--dim)">No proxy — direct connection</div>
            <div class="pi-meta">${connLabel}</div>`;
        el.addEventListener('click', () => openDirectEditor());
        profileList.appendChild(el);
    }

    const filtered = profiles.filter(p =>
        !q || p.name.toLowerCase().includes(q) || (p.url_display || '').toLowerCase().includes(q)
    );

    if (!filtered.length && !directMatches) {
        profileList.innerHTML = `<div class="empty-list">${q ? 'No matches found.' : 'No profiles yet.<br>Click "+ New" to add one.'}</div>`;
        return;
    }

    for (const p of filtered) {
        const el = document.createElement('div');
        el.className = 'profile-item';
        if (p.id === selectedId) el.classList.add('active-profile');
        if (p.id === connectedId) el.classList.add('connected');

        const latBadge = p.last_latency_ms != null
            ? `<span class="pi-badge lat">${p.last_latency_ms}ms</span>` : '';
        const geoBadge = p.last_geo
            ? `<span class="pi-badge geo">${esc(p.last_geo)}</span>` : '';
        const ipBadge  = p.last_ip
            ? `<span class="pi-badge geo" style="color:#a5f3fc">${esc(p.last_ip)}</span>` : '';
        const connLabel = p.id === connectedId ? `<span class="pi-connected-label">● CONNECTED</span>` : '';
        const tplBadge  = p.is_template ? `<span class="pi-badge tmpl">template</span>` : '';
        const modeBadge = `<span class="pi-badge tmpl">${p.traffic_mode === 'mitm' ? 'mitm' : 'browser·dev'}</span>`;

        el.innerHTML = `
            <div class="pi-name">${esc(p.name)}</div>
            <div class="pi-host">${esc(p.url_display || '—')}</div>
            <div class="pi-meta">${tplBadge}${modeBadge}${ipBadge}${geoBadge}${latBadge}${connLabel}</div>`;

        el.addEventListener('click', () => openEditor(p.id));
        profileList.appendChild(el);
    }
}

// ─── Direct profile editor ────────────────────────────────────────────────────
function openDirectEditor() {
    selectedId    = DIRECT_ID;
    isNew         = false;
    ephemeralVars = {};
    lastResolvedVars = {};

    // Load saved Direct settings from localStorage (since it's not in DB)
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('direct_profile') || '{}'); } catch {}
    const profile = { ...DIRECT_PROFILE, ...saved };

    editorEmpty.style.display  = 'none';
    editorWrap.style.display   = 'flex';
    editorTitle.textContent    = '🌐 Direct — No Proxy';
    fName.value                = 'Direct';
    fTemplate.value            = '';
    fNotes.value               = '';
    if (fTrafficMode) {
        fTrafficMode.value = 'mitm';
        fTrafficMode.disabled = true;
    }
    varsSection.style.display  = 'none';
    varsTbody.innerHTML        = '';
    tplPreview.innerHTML       = '<span style="color:var(--green)">Direct connection (no proxy)</span>';

    // Hide proxy URL row, show read-only message
    const fTemplateRow = fTemplate.closest('.form-row');
    if (fTemplateRow) fTemplateRow.style.display = 'none';

    btnDelete.style.display    = 'none';
    btnDuplicate.style.display = 'none';
    testResult.classList.remove('visible', 'ok', 'err');
    setSaveStatus('');
    updateEditorActionButtons();

    if (fUa)       fUa.value       = profile.user_agent || '';
    if (fTimezone) fTimezone.value = profile.timezone   || '';
    if (fLanguage) fLanguage.value = profile.language   || '';
    tlsLoadFromProfile(profile);
    updateFpBadge();
    renderProfileList();
}

// ─── Editor ───────────────────────────────────────────────────────────────────
function openEditor(id) {
    selectedId = id;
    isNew      = false;
    ephemeralVars = {};
    lastResolvedVars = (id === connectedId) ? { ..._storedResolvedVars } : {};

    const profile = profiles.find(p => p.id === id);
    if (!profile) return;

    // Restore proxy URL row if was hidden by Direct editor
    const fTemplateRow = fTemplate.closest('.form-row');
    if (fTemplateRow) fTemplateRow.style.display = '';

    editorEmpty.style.display  = 'none';
    editorWrap.style.display   = 'flex';
    editorTitle.textContent    = profile.name;
    fName.value                = profile.name;
    fTemplate.value            = profile.url_display || '';  // show display (password masked) — real template comes from getProxyProfileUrl
    fNotes.value               = profile.notes || '';
    if (fTrafficMode) {
        fTrafficMode.value = 'mitm';
        fTrafficMode.disabled = false;
    }
    btnDelete.style.display    = '';
    btnDuplicate.style.display = '';
    updateEditorActionButtons();

    // Fingerprint fields
    if (fUa)       fUa.value       = profile.user_agent || '';
    if (fTimezone) fTimezone.value = profile.timezone   || '';
    if (fLanguage) fLanguage.value = profile.language   || '';
    tlsLoadFromProfile(profile);
    updateFpBadge();

    testResult.classList.remove('visible', 'ok', 'err');
    setSaveStatus('');

    // Fetch decrypted template for editor
    api.getProxyProfileUrl(id).then(template => {
        if (template) fTemplate.value = template;
        buildVarsTable(template || fTemplate.value, profile.variables || {});
        updatePreview();
    });

    renderProfileList();
}

function openNewEditor() {
    selectedId = null;
    isNew      = true;
    ephemeralVars = {};
    lastResolvedVars = {};

    const fTemplateRow = fTemplate.closest('.form-row');
    if (fTemplateRow) fTemplateRow.style.display = '';

    editorEmpty.style.display  = 'none';
    editorWrap.style.display   = 'flex';
    editorTitle.textContent    = 'New Profile';
    fName.value                = '';
    fTemplate.value            = '';
    fNotes.value               = '';
    if (fTrafficMode) {
        fTrafficMode.value = 'mitm';
        fTrafficMode.disabled = false;
    }
    varsSection.style.display  = 'none';
    varsTbody.innerHTML        = '';
    tplPreview.innerHTML       = '—';
    btnDelete.style.display    = 'none';
    btnDuplicate.style.display = 'none';
    testResult.classList.remove('visible', 'ok', 'err');
    setSaveStatus('');
    updateEditorActionButtons();
    // Clear fingerprint fields
    if (fUa)       fUa.value       = '';
    if (fTimezone) fTimezone.value = '';
    if (fLanguage) fLanguage.value = '';
    tlsLoadFromProfile({});
    updateFpBadge();

    fName.focus();
    renderProfileList();
}

function closeEditor() {
    selectedId = null;
    isNew      = false;
    editorEmpty.style.display = '';
    editorWrap.style.display  = 'none';
    renderProfileList();
}

function buildVarsTable(template, savedVars) {
    const vars = parseTemplateVars(template || '');
    if (!vars.length) { varsSection.style.display = 'none'; varsTbody.innerHTML = ''; return; }
    varsSection.style.display = '';
    varsTbody.innerHTML = '';
    const isConnected = selectedId && selectedId === connectedId;
    for (const v of vars) {
        const tr = document.createElement('tr');
        if (v.type === 'rand') {
            const curVal = isConnected && lastResolvedVars['RAND'] ? lastResolvedVars['RAND'] : null;
            const curHtml = curVal
                ? `<span class="var-current-val">${esc(curVal)}</span>`
                : `<span class="var-current-hint">new on each connect</span>`;
            tr.innerHTML = `
                <td class="var-name-cell" style="color:#86efac">{RAND}</td>
                <td><span class="var-rand-range">${v.range}</span> ${curHtml}</td>
                <td><span class="var-badge-rand">AUTO</span></td>`;
        } else if (v.type === 'sid') {
            const val = ephemeralVars['SID'] || '';
            const curVal = isConnected && lastResolvedVars['SID'] ? lastResolvedVars['SID'] : null;
            const curHtml = curVal
                ? `<div class="var-current-val">${esc(curVal)}</div>`
                : '';
            tr.innerHTML = `
                <td class="var-name-cell" style="color:#f9a8d4">{SID}</td>
                <td><input class="var-input" type="text" placeholder="blank = cupnet + 10 random digits"
                     data-varname="SID" data-vartype="sid" value="${esc(val)}"
                     title="Leave blank to auto-generate: cupnet0123456789">${curHtml}</td>
                <td><span class="var-badge-sid">EPHEMERAL</span></td>`;
        } else {
            const val = savedVars[v.name] || '';
            const curVal = isConnected && lastResolvedVars[v.name] ? lastResolvedVars[v.name] : null;
            const curHtml = curVal && curVal !== val
                ? `<div class="var-current-val">${esc(curVal)}</div>`
                : '';
            tr.innerHTML = `
                <td class="var-name-cell">{${esc(v.name)}}</td>
                <td><input class="var-input" type="text" placeholder="value"
                     data-varname="${esc(v.name)}" data-vartype="saved" value="${esc(val)}">${curHtml}</td>
                <td><span class="var-badge-saved">SAVED</span></td>`;
        }
        varsTbody.appendChild(tr);
    }

    // Live update preview on var change
    varsTbody.querySelectorAll('.var-input').forEach(inp => {
        inp.addEventListener('input', () => {
            if (inp.dataset.vartype === 'sid') ephemeralVars['SID'] = inp.value;
            updatePreview();
        });
    });
}

function updatePreview() {
    const tpl = fTemplate.value.trim();
    const saved = getCurrentSavedVars();
    tplPreview.innerHTML = tpl ? resolvePreview(tpl, saved) : '—';
}

fTemplate.addEventListener('input', debounce(() => {
    buildVarsTable(fTemplate.value, getCurrentSavedVars());
    updatePreview();
}, 300));

// ─── Save ─────────────────────────────────────────────────────────────────────
btnSave.addEventListener('click', async () => {
    // Direct profile — save to localStorage
    if (selectedId === DIRECT_ID) {
        const data = {
            user_agent: fUa?.value.trim() || null,
            timezone:   fTimezone?.value  || null,
            language:   fLanguage?.value  || null,
            ...tlsGetSaveData(),
        };
        try { localStorage.setItem('direct_profile', JSON.stringify(data)); } catch {}
        setSaveStatus('Saved ✓', 'ok');
        return;
    }

    const name     = fName.value.trim();
    const template = fTemplate.value.trim();
    if (!name)     { setSaveStatus('Name required', 'err'); return; }
    if (!template) { setSaveStatus('Proxy URL required', 'err'); return; }

    const savedVars  = collectVarsFromForm();
    btnSave.disabled = true;
    const profile = {
        id:         isNew ? undefined : selectedId,
        name,
        template,
        variables:  savedVars,
        notes:      fNotes.value.trim(),
        traffic_mode: 'mitm',
        user_agent: fUa?.value.trim()       || null,
        timezone:   fTimezone?.value        || null,
        language:   fLanguage?.value        || null,
        ...tlsGetSaveData(),
    };
    const result = await api.saveProxyProfileFull(profile);
    btnSave.disabled = false;
    if (result.success) {
        setSaveStatus('Saved ✓', 'ok');
        selectedId = result.id;
        isNew      = false;
        btnDelete.style.display = '';
        editorTitle.textContent = name;
        updateEditorActionButtons();
    } else {
        setSaveStatus(`Error: ${result.error}`, 'err');
    }
});

btnCancel.addEventListener('click', closeEditor);

btnDelete.addEventListener('click', async () => {
    if (!selectedId) return;
    const p = profiles.find(x => x.id === selectedId);
    if (!confirm(`Delete profile "${p?.name}"?`)) return;
    await api.deleteProxyProfileById(selectedId);
    closeEditor();
});

btnDuplicate?.addEventListener('click', async () => {
    if (!selectedId) return;
    const src = profiles.find(x => x.id === selectedId);
    if (!src) return;

    // Fetch decrypted template so the copy has the real URL
    const realTemplate = await api.getProxyProfileUrl(selectedId).catch(() => '');

    // Open "new" editor pre-filled with source data
    selectedId = null;
    isNew      = true;
    ephemeralVars = {};
    lastResolvedVars = {};

    editorEmpty.style.display  = 'none';
    editorWrap.style.display   = 'flex';
    editorTitle.textContent    = `Copy of ${src.name}`;
    fName.value                = `${src.name} (copy)`;
    fTemplate.value            = realTemplate || src.url_display || '';
    fNotes.value               = src.notes || '';
    if (fTrafficMode) {
        fTrafficMode.value = 'mitm';
        fTrafficMode.disabled = false;
    }
    btnDelete.style.display    = 'none';
    btnDuplicate.style.display = 'none';
    testResult.classList.remove('visible', 'ok', 'err');
    setSaveStatus('');
    updateEditorActionButtons();

    if (fUa)       fUa.value       = src.user_agent || '';
    if (fTimezone) fTimezone.value = src.timezone    || '';
    if (fLanguage) fLanguage.value = src.language    || '';
    tlsLoadFromProfile(src);
    updateFpBadge();

    buildVarsTable(fTemplate.value, src.variables || {});
    updatePreview();

    fName.focus();
    fName.select();
    renderProfileList();
});

// ─── Apply globally / to active tab ───────────────────────────────────────────
function updateApplyGlobalBtn() {
    if (!btnApplyGlobal) return;
    if (!selectedId || isNew) {
        btnApplyGlobal.disabled = true;
        btnApplyGlobal.textContent = 'Apply globally';
        return;
    }

    if (selectedId === DIRECT_ID) {
        if (connectedId === DIRECT_ID) {
            btnApplyGlobal.textContent = '↺ Apply globally (Direct)';
            btnApplyGlobal.disabled   = false;
        } else {
            btnApplyGlobal.textContent = 'Apply globally: Direct';
            btnApplyGlobal.disabled   = false;
        }
    } else {
        if (selectedId === connectedId) {
            btnApplyGlobal.textContent = '✕ Disconnect global';
        } else {
            btnApplyGlobal.textContent = 'Apply globally';
        }
        btnApplyGlobal.disabled = false;
    }
}

function updateApplyTabBtn() {
    if (!btnApplyTab) return;
    btnApplyTab.disabled = !selectedId || isNew;
}

function updateEditorActionButtons() {
    updateApplyGlobalBtn();
    updateApplyTabBtn();
}

btnApplyTab.addEventListener('click', async () => {
    if (!selectedId || isNew || !api.setTabProxy || !api.getTabs) return;
    collectVarsFromForm();
    const tabs = await api.getTabs();
    const active = tabs.find(t => t.isActive);
    if (!active) {
        setSaveStatus('No active tab in main window', 'err');
        return;
    }
    btnApplyTab.disabled = true;
    try {
        if (selectedId === DIRECT_ID) {
            const res = await api.setTabProxy(active.id, null);
            if (res?.success) {
                setSaveStatus('Active tab: use global / Direct upstream ✓', 'ok');
            } else {
                setSaveStatus(res?.error || 'Failed', 'err');
            }
            return;
        }
        const ev = Object.keys(ephemeralVars).length ? { ...ephemeralVars } : undefined;
        const res = await api.setTabProxy(active.id, selectedId, ev);
        if (res?.success) {
            setSaveStatus('Profile applied to active tab ✓', 'ok');
        } else {
            setSaveStatus(res?.error || 'Failed', 'err');
        }
    } catch (e) {
        setSaveStatus(String(e?.message || e), 'err');
    } finally {
        updateApplyTabBtn();
    }
});

// ─── Connect / Disconnect (global) ─────────────────────────────────────────
btnApplyGlobal.addEventListener('click', async () => {
    if (!selectedId) return;
    collectVarsFromForm();

    // ── Direct profile ──
    if (selectedId === DIRECT_ID) {
        btnApplyGlobal.disabled = true; btnApplyGlobal.textContent = '⟳ Applying…';
        const directData = {
            user_agent: fUa?.value.trim() || null,
            timezone:   fTimezone?.value  || null,
            language:   fLanguage?.value  || null,
            ...tlsGetSaveData(),
        };
        try { localStorage.setItem('direct_profile', JSON.stringify(directData)); } catch {}

        const result = await (api.connectDirect
            ? api.connectDirect(directData.tls_profile || 'chrome')
            : api.disconnectProxy());

        connectedId = DIRECT_ID;
        btnApplyGlobal.disabled = false;
        updateEditorActionButtons();
        setSaveStatus(result?.success !== false ? 'Direct + MITM active ✓' : `Error: ${result?.error}`, result?.success !== false ? 'ok' : 'err');
        renderProfileList();
        return;
    }

    // ── Disconnect currently active proxy ──
    if (selectedId === connectedId) {
        btnApplyGlobal.disabled = true; btnApplyGlobal.textContent = '⟳ Disconnecting…';
        await api.disconnectProxy();
        // State will be updated via onProxyStatusChanged event
        btnApplyGlobal.disabled = false;
        return;
    }

    // ── Connect proxy profile ──
    btnApplyGlobal.disabled = true; btnApplyGlobal.textContent = '⟳ Connecting…';
    const result = await api.connectProxyTemplate(selectedId, ephemeralVars);
    btnApplyGlobal.disabled = false;
    if (result.success) {
        connectedId = selectedId;
        _storedResolvedVars = result.resolvedVars || {};
        lastResolvedVars = { ..._storedResolvedVars };
        updateEditorActionButtons();
        setSaveStatus('Connected ✓', 'ok');
        // Rebuild vars table to show current resolved values
        const profile = profiles.find(p => p.id === selectedId);
        if (profile) buildVarsTable(fTemplate.value, profile.variables || {});
    } else {
        updateEditorActionButtons();
        setSaveStatus(`Connect failed: ${result.error}`, 'err');
    }
    renderProfileList();
});

// ─── Test ─────────────────────────────────────────────────────────────────────
btnTest.addEventListener('click', async () => {
    if (!selectedId) return;
    btnTest.disabled = true; btnTest.textContent = '⟳ Testing…';
    testResult.classList.remove('visible', 'ok', 'err');

    // Save first if new/dirty
    if (isNew) { setSaveStatus('Save first', 'err'); btnTest.disabled = false; btnTest.textContent = '⚡ Test'; return; }

    const result = await api.testProxyTemplate(selectedId, ephemeralVars);
    btnTest.disabled = false; btnTest.textContent = '⚡ Test';

    testResult.classList.add('visible');
    if (result.success && result.data) {
        testResult.classList.add('ok');
        const d = result.data;
        document.getElementById('tr-ip').textContent  = d.ip || '—';
        document.getElementById('tr-geo').textContent = [d.city, d.region, d.country].filter(Boolean).join(', ') || '—';
        document.getElementById('tr-org').textContent = d.org || '—';
        document.getElementById('tr-lat').textContent = result.latency ? `${result.latency}ms` : '—';
        document.getElementById('tr-url').textContent = result.resolvedUrl || '—';
    } else {
        testResult.classList.add('err');
        document.getElementById('tr-ip').textContent  = result.error || 'Failed';
        document.getElementById('tr-geo').textContent = '—';
        document.getElementById('tr-org').textContent = '—';
        document.getElementById('tr-lat').textContent = '—';
        document.getElementById('tr-url').textContent = result.resolvedUrl || '—';
    }
    renderProfileList();
});

// ─── Disconnect button (topbar) ───────────────────────────────────────────────
btnDisconnect.addEventListener('click', async () => {
    btnDisconnect.disabled = true;
    await api.disconnectProxy();
    btnDisconnect.disabled = false;
});

// ─── Check IP ─────────────────────────────────────────────────────────────────
btnCheckIp.addEventListener('click', async () => {
    btnCheckIp.disabled = true; btnCheckIp.textContent = '⟳ Checking…';
    const geo = await api.checkIpGeo();
    btnCheckIp.disabled = false; btnCheckIp.textContent = '⟳ Check IP';
    if (geo && geo.ip !== 'unknown') {
        currentIp = geo.ip;
        const location = [geo.city, geo.country_name].filter(Boolean).join(', ');
        statusIp.textContent = `${geo.ip}${location ? ' · ' + location : ''}`;
    }
});

// ─── Search ───────────────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => { searchQuery = searchInput.value; renderProfileList(); });

// ─── Add new ──────────────────────────────────────────────────────────────────
btnAddProfile.addEventListener('click', openNewEditor);

// ─── IPC events ───────────────────────────────────────────────────────────────
api.onProxyProfilesList((list) => {
    profiles = list || [];
    renderProfileList();
});

api.onProxyStatusChanged((info) => {
    const active    = info?.active;
    const isDirect  = info?.mode === 'direct';

    statusDot.className  = `status-dot ${active ? 'active' : (isDirect ? 'direct' : 'inactive')}`;
    statusLabel.textContent = active
        ? `Active: ${(info.proxyName || 'Proxy').slice(0, 40)}`
        : 'Direct (no upstream proxy)';
    btnDisconnect.style.display = active ? '' : 'none';

    if (!active && !isDirect) {
        connectedId = null;
        _storedResolvedVars = {};
        lastResolvedVars = {};
        renderProfileList();
    } else if (active && info.resolvedVars && Object.keys(info.resolvedVars).length) {
        _storedResolvedVars = info.resolvedVars;
        lastResolvedVars = { ..._storedResolvedVars };
    }
    if (isDirect) {
        connectedId = DIRECT_ID;
        if (selectedId !== DIRECT_ID) {
            openDirectEditor();
        } else {
            renderProfileList();
        }
    } else if (active) {
        connectedId = info.profileId || connectedId;
        renderProfileList();
    }

    // Refresh connect button text for the currently open editor
    updateEditorActionButtons();

    // Re-check IP automatically after proxy change
    statusIp.textContent = 'Checking…';
    setTimeout(async () => {
        try {
            const geo = await api.checkIpGeo();
            if (geo && geo.ip !== 'unknown') {
                currentIp = geo.ip;
                const location = [geo.city, geo.country_name].filter(Boolean).join(', ');
                statusIp.textContent = `${geo.ip}${location ? ' · ' + location : ''}`;
            } else {
                statusIp.textContent = '—';
            }
        } catch { statusIp.textContent = 'Error'; }
    }, 1200);
});

// ─── AzureTLS live stats ──────────────────────────────────────────────────────
const msDot    = document.getElementById('mitm-dot');
const msRps    = document.getElementById('ms-rps');
const msAvg    = document.getElementById('ms-avg');
const msPend   = document.getElementById('ms-pend');
const msTotal  = document.getElementById('ms-total');
const msErr    = document.getElementById('ms-err');
const msBrowser= document.getElementById('ms-browser');

function applyMitmStats(s) {
    if (!s) return;
    // Worker status dot
    if (msDot) {
        if (!s.workerReady) {
            msDot.className = 'mitm-stat-dot error';
            msDot.title = 'Worker not ready';
        } else if (s.pending > 5) {
            msDot.className = 'mitm-stat-dot busy';
            msDot.title = `${s.pending} requests in flight`;
        } else {
            msDot.className = 'mitm-stat-dot ready';
            msDot.title = 'Worker ready';
        }
    }
    if (msRps)    msRps.textContent    = s.reqPerSec > 0 ? s.reqPerSec.toFixed(1) : '0';
    if (msAvg)    msAvg.textContent    = s.avgMs > 0 ? s.avgMs + 'ms' : '—';
    if (msPend)   msPend.textContent   = s.pending;
    if (msTotal)  msTotal.textContent  = s.requests;
    if (msErr)    msErr.textContent    = s.errors;
    if (msBrowser) msBrowser.textContent = s.browser || 'chrome';

    // Highlight errors
    if (msErr) msErr.style.display = s.errors > 0 ? '' : 'none';
    const errLabel = msErr?.nextElementSibling;
    if (errLabel) errLabel.style.display = s.errors > 0 ? '' : 'none';
    const errSep = msErr?.parentElement?.previousElementSibling;
}

// Subscribe to live updates
api.onMitmStatsUpdate && api.onMitmStatsUpdate(applyMitmStats);

// Initial load
api.getMitmStats && api.getMitmStats().then(applyMitmStats).catch(() => {});

// ─── Init ─────────────────────────────────────────────────────────────────────
api.getProxyProfiles().then(list => {
    profiles = list || [];
    renderProfileList();
}).catch(() => {});

// Load initial proxy state — select Direct if that's the current mode
api.getCurrentProxy().then(info => {
    if (!info) return;
    const isDirect = info.mode === 'direct' || (!info.active && !info.proxyName);
    if (info.resolvedVars && Object.keys(info.resolvedVars).length) {
        _storedResolvedVars = info.resolvedVars;
        lastResolvedVars = { ..._storedResolvedVars };
    }
    if (isDirect) {
        connectedId = DIRECT_ID;
        openDirectEditor();
    } else if (info.active) {
        connectedId = info.profileId || null;
        if (connectedId) {
            selectedId = connectedId;
            openEditor(connectedId);
        }
        renderProfileList();
    }
}).catch(() => {});

// Initial IP check
api.checkIpGeo().then(geo => {
    if (geo && geo.ip !== 'unknown') {
        currentIp = geo.ip;
        const location = [geo.city, geo.country_name].filter(Boolean).join(', ');
        statusIp.textContent = `${geo.ip}${location ? ' · ' + location : ''}`;
    }
}).catch(() => {});

// ─── Traffic Optimization ─────────────────────────────────────────────────────
const trafficMaster   = document.getElementById('traffic-master-toggle');
const trafficToggles  = document.querySelectorAll('.traffic-opt');
const trafficGroup    = document.getElementById('traffic-toggles-group');
const captchaWLField  = document.getElementById('f-captcha-whitelist');
const trafficBadge    = document.getElementById('traffic-active-badge');

function updateTrafficUI() {
    const enabled = trafficMaster?.checked;
    if (trafficGroup) trafficGroup.classList.toggle('disabled', !enabled);
    if (trafficBadge) trafficBadge.style.display = enabled ? '' : 'none';
}

function collectTrafficOpts() {
    const opts = { trafficEnabled: !!trafficMaster?.checked };
    trafficToggles.forEach(t => { opts[t.dataset.opt] = t.checked; });
    opts.captchaWhitelist = (captchaWLField?.value || '')
        .split('\n').map(l => l.trim()).filter(Boolean);
    return opts;
}

function applyTrafficOptsToUI(opts) {
    if (!opts) return;
    if (trafficMaster) trafficMaster.checked = !!opts.trafficEnabled;
    trafficToggles.forEach(t => { t.checked = !!opts[t.dataset.opt]; });
    if (captchaWLField && opts.captchaWhitelist) {
        captchaWLField.value = opts.captchaWhitelist.join('\n');
    }
    updateTrafficUI();
}

trafficMaster?.addEventListener('change', () => {
    updateTrafficUI();
    api.saveTrafficOpts(collectTrafficOpts());
});

trafficToggles.forEach(t => {
    t.addEventListener('change', () => {
        api.saveTrafficOpts(collectTrafficOpts());
    });
});

let captchaWLTimer;
captchaWLField?.addEventListener('input', () => {
    clearTimeout(captchaWLTimer);
    captchaWLTimer = setTimeout(() => {
        api.saveTrafficOpts(collectTrafficOpts());
    }, 800);
});

api.getTrafficOpts().then(applyTrafficOptsToUI).catch(() => {});
