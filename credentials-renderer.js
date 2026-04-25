'use strict';
/* globals cupnetTotp */

const api = window.electronAPI;
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeAttr(s) { return String(s).replace(/"/g,'&quot;').replace(/&/g,'&amp;'); }
function fmtDate(iso) { if (!iso) return ''; try { const d = new Date(iso); return d.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) + ' ' + d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}); } catch { return iso; } }
function toastCred(msg, type) { if (typeof window.CupNetToast !== 'undefined') window.CupNetToast.show(msg, type); }

// ─── State ─────────────────────────────────────────────────────────────────
let ctxPageUrl = '', ctxDomain = '';
let listRows = [], currentId = null;
let navMode = 'all', navParam = '';
let domainSet = new Set(), domainCounts = {}, tagCounts = {};
let navCountAll = 0, navCountFav = 0, navCountSite = 0, navCountTrash = 0;
let typeCounts = { login: 0, card: 0, identity: 0, note: 0, total: 0 };
let folders = [];
let totpTimer = null;
let autolockTimer = null;
let clipboardClearTimer = null;
let credFormBaseline = '';
let kbListIdx = -1;
const AUTOLOCK_STORAGE_KEY = 'credentials-autolock-minutes';
const CLIPBOARD_CLEAR_MS = 20000;
const MATCH_TYPES = ['Default','Base domain','Host','Starts with','Exact','RegExp','Never'];

// ─── Helpers ───────────────────────────────────────────────────────────────
function matchGlobPattern(pattern, url) {
    if (!pattern || !url) return false;
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');
    try { return new RegExp('^' + esc + '$','i').test(url); } catch { return false; }
}
function noteMatchesUrlMatch(pat, url) {
    if (!pat || !url) return false;
    const p = pat.trim();
    if (!p) return false;
    if (p.includes('*') || p.includes('?')) return matchGlobPattern(p, url);
    try { const u = new URL(url); const h = u.hostname.toLowerCase(); return h === p.toLowerCase() || h.endsWith('.' + p.toLowerCase()); } catch { return false; }
}
function hueForKey(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return ((h % 360) + 360) % 360; }
function avatarLetter(r) { const s = r.label || r.domain || ''; return (s[0] || '?').toUpperCase(); }
function setPwVisibility(input, btn, show) {
    input.type = show ? 'text' : 'password';
    const eo = btn.querySelector('.eye-open'), ec = btn.querySelector('.eye-off');
    if (eo) eo.style.display = show ? 'none' : '';
    if (ec) ec.style.display = show ? '' : 'none';
}

// ─── Password scoring ──────────────────────────────────────────────────────
function scoreMasterPassword(pw) {
    if (!pw) return { score: 0, label: '', color: '' };
    let s = 0;
    if (pw.length >= 8) s++; if (pw.length >= 12) s++; if (pw.length >= 16) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^a-zA-Z0-9]/.test(pw)) s++;
    const labels = ['Very weak','Weak','Fair','Good','Strong','Very strong','Excellent'];
    const colors = ['#f85149','#f85149','#d29922','#d29922','#58a6ff','#3fb950','#3fb950'];
    const i = Math.min(s, labels.length - 1);
    return { score: s, label: labels[i], color: colors[i], pct: Math.min(100, (s / 6) * 100) };
}

// ─── Password & passphrase generators ──────────────────────────────────────
const EFF_WORDS = ['abandon','ability','able','about','above','absent','absorb','abstract','absurd','abuse',
    'access','accident','account','accuse','achieve','acid','acoustic','acquire','across','action',
    'actor','actual','adapt','address','adjust','admit','adult','advance','advice','aerobic',
    'affair','afford','afraid','again','agent','agree','ahead','alarm','album','alert',
    'alien','almost','alone','alpha','already','alter','always','amateur','amazing','among',
    'amount','anchor','ancient','anger','angle','angry','animal','annual','answer','antenna',
    'antique','anxiety','apart','apology','appear','apple','approve','april','arch','arctic',
    'arena','argue','armor','army','around','arrange','arrest','arrive','arrow','artist',
    'artwork','aspect','assault','asset','assist','assume','asthma','athlete','atom','attack',
    'attend','attract','auction','audit','august','aunt','author','avocado','avoid','awake',
    'aware','awesome','awful','axis','baby','bachelor','bacon','badge','balance','balcony',
    'bamboo','banana','banner','barrel','basket','battle','beach','beauty','become','before',
    'begin','believe','below','bench','benefit','best','betray','beyond','bicycle','birth',
    'blade','blanket','blast','bleak','bless','blind','blood','blossom','board','boat',
    'bonus','book','border','bottom','bounce','brain','brand','brave','bread','breeze',
    'brick','bridge','bright','bring','broken','brother','brown','brush','bubble','budget',
    'buffalo','build','bullet','bundle','burden','burger','burst','butter','buyer','cabin',
    'cable','cactus','camera','camp','canal','cancel','canvas','canyon','capable','capital',
    'captain','carbon','card','cargo','carpet','carry','castle','catalog','catch','cattle',
    'ceiling','celery','cement','census','century','cereal','certain','chair','chalk','champion',
    'change','chaos','chapter','charge','chase','cheap','cheese','cherry','chest','chicken',
    'chief','child','chimney','choice','chunk','circle','citizen','civil','claim','clap',
    'clarify','claw','clay','clean','clerk','clever','click','client','cliff','climb',
    'clock','close','cloth','cloud','cluster','coach','coconut','coffee','collect','color',
    'column','combine','comedy','comfort','comic','common','company','concert','connect','consider',
    'control','convince','cook','coral','core','corner','correct','cotton','couch','country',
    'couple','course','cousin','cover','coyote','crack','cradle','craft','crane','crash',
    'crater','crazy','cream','credit','creek','crew','cricket','crime','crisp','critic',
    'cross','crouch','crowd','cruise','crumble','crush','crystal','cube','culture','curious',
    'current','curtain','curve','cushion','custom','cycle','damage','dance','danger','daring',
    'daughter','dawn','debate','debris','decade','december','decide','decline','decorate','decrease',
    'define','defy','degree','delay','deliver','demand','denial','dentist','deny','depart',
    'depend','deposit','depth','deputy','derive','describe','desert','design','desk','detail',
    'detect','develop','device','devote','diagram','diamond','diary','diesel','diet','differ',
    'digital','dignity','dilemma','dinner','dinosaur','direct','dirty','disagree','discover','disease',
    'dismiss','disorder','display','distance','divert','divide','doctor','document','dollar','dolphin',
    'domain','donate','donkey','donor','door','double','dragon','drama','drastic','dream',
    'drift','drill','drink','drip','drive','drop','drum','during','dust','dutch',
    'dwarf','dynamic','eager','eagle','early','earn','earth','easily','east','easy',
    'ecology','economy','edge','edit','educate','effort','eight','either','elbow','elder',
    'electric','elegant','element','elephant','elevator','elite','else','embark','embody','embrace',
    'emerge','emotion','employ','empty','enable','enact','endorse','enemy','energy','enforce',
    'engage','engine','enhance','enjoy','enlist','enough','enrich','enroll','ensure','enter',
    'entire','entry','envelope','episode','equal','equip','erase','erode','erosion','error',
    'escape','essay','essence','estate','eternal','evidence','evil','evolve','exact','example'];

function generatePassword(length, useSymbols = true, useNumbers = true) {
    const up = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lo = 'abcdefghijklmnopqrstuvwxyz';
    const dg = '0123456789', sy = '!@#$%^&*_+-=?';
    let pool = up + lo;
    if (useNumbers) pool += dg;
    if (useSymbols) pool += sy;
    const len = Math.max(12, Math.min(64, length || 20));
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    const chars = [];
    chars[0] = up[arr[0] % up.length];
    chars[1] = lo[arr[1] % lo.length];
    let idx = 2;
    if (useNumbers) { chars[idx] = dg[arr[idx] % dg.length]; idx++; }
    if (useSymbols) { chars[idx] = sy[arr[idx] % sy.length]; idx++; }
    for (let i = idx; i < len; i++) chars[i] = pool[arr[i] % pool.length];
    for (let i = chars.length - 1; i > 0; i--) { const j = arr[i] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    return chars.join('');
}

function generatePassphrase(wordCount = 4, separator = '-', capitalize = true) {
    const count = Math.max(3, Math.min(10, wordCount));
    const arr = new Uint32Array(count);
    crypto.getRandomValues(arr);
    const words = [];
    for (let i = 0; i < count; i++) {
        let w = EFF_WORDS[arr[i] % EFF_WORDS.length];
        if (capitalize) w = w[0].toUpperCase() + w.slice(1);
        words.push(w);
    }
    return words.join(separator);
}

// ─── Import parsers ────────────────────────────────────────────────────────
const IMPORT_SOURCES = [
    { id: 'bitwarden-json', name: 'Bitwarden (JSON)', hint: '.json export', ext: '.json' },
    { id: 'bitwarden-csv', name: 'Bitwarden (CSV)', hint: '.csv export', ext: '.csv' },
    { id: 'chrome-csv', name: 'Chrome / Edge (CSV)', hint: 'chrome://settings/passwords export', ext: '.csv' },
    { id: 'firefox-csv', name: 'Firefox (CSV)', hint: 'about:logins export', ext: '.csv' },
    { id: 'lastpass-csv', name: 'LastPass (CSV)', hint: '.csv export', ext: '.csv' },
    { id: '1password-csv', name: '1Password (CSV)', hint: '.csv export', ext: '.csv' },
    { id: 'keepass-csv', name: 'KeePass (CSV)', hint: '.csv export', ext: '.csv' },
    { id: 'batch', name: 'Raw batch (delimiter / regex)', hint: 'Paste text directly' },
];

function parseCsvLine(line) {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
        else { if (c === ',') { out.push(cur); cur = ''; } else if (c === '"' && cur === '') inQ = true; else cur += c; }
    }
    out.push(cur);
    return out;
}

function parseCsvText(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    return lines.map(parseCsvLine);
}

function domainFromUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function parseImportSource(sourceId, text) {
    const items = [];
    if (sourceId === 'bitwarden-json') {
        try {
            const data = JSON.parse(text);
            const arr = data.items || data.logins || data;
            if (!Array.isArray(arr)) return [];
            for (const it of arr) {
                const type = it.type === 2 ? 'note' : it.type === 3 ? 'card' : it.type === 4 ? 'identity' : 'login';
                const login = it.login || {};
                const extra = {};
                if (login.totp) extra.totpSecret = login.totp;
                if (it.card) extra.card = it.card;
                if (it.identity) extra.identity = it.identity;
                if (it.fields) extra.customFields = it.fields;
                items.push({
                    item_type: type,
                    label: it.name || '',
                    login: login.username || '',
                    password: login.password || '',
                    domain: domainFromUrl((login.uris || [])[0]?.uri || ''),
                    url_match: (login.uris || []).map(u => u.uri).filter(Boolean).join(', '),
                    notes: it.notes || (type === 'note' ? (it.secureNote?.text || it.notes || '') : ''),
                    tags: (it.folderId ? '' : ''),
                    extra,
                });
            }
        } catch { return []; }
    } else if (sourceId === 'bitwarden-csv' || sourceId === 'lastpass-csv' || sourceId === '1password-csv' || sourceId === 'keepass-csv') {
        const rows = parseCsvText(text);
        if (rows.length < 2) return [];
        const hdr = rows[0].map(h => h.trim().toLowerCase());
        const col = (name, aliases) => {
            const idx = hdr.indexOf(name);
            if (idx >= 0) return idx;
            for (const a of (aliases || [])) { const i = hdr.indexOf(a); if (i >= 0) return i; }
            return -1;
        };
        const iName = col('name', ['title', 'entry']);
        const iUser = col('login_username', ['username', 'login', 'user']);
        const iPass = col('login_password', ['password', 'pass']);
        const iUrl = col('login_uri', ['url', 'login_url', 'web site']);
        const iNotes = col('notes', ['extra', 'comments']);
        const iFolder = col('folder', ['group']);
        const iTotp = col('login_totp', ['totp', 'otpauth']);

        for (let i = 1; i < rows.length; i++) {
            const r = rows[i]; if (!r.length || r.every(c => !c.trim())) continue;
            const g = (idx) => idx >= 0 && idx < r.length ? r[idx].trim() : '';
            const url = g(iUrl);
            const extra = {};
            const totp = g(iTotp);
            if (totp) extra.totpSecret = totp;
            items.push({
                label: g(iName), login: g(iUser), password: g(iPass),
                domain: domainFromUrl(url) || g(iUrl), url_match: url,
                notes: g(iNotes), tags: g(iFolder), extra,
            });
        }
    } else if (sourceId === 'chrome-csv' || sourceId === 'firefox-csv') {
        const rows = parseCsvText(text);
        if (rows.length < 2) return [];
        const hdr = rows[0].map(h => h.trim().toLowerCase());
        const iUser = hdr.indexOf('username') >= 0 ? hdr.indexOf('username') : hdr.indexOf('login');
        const iPass = hdr.indexOf('password');
        const iUrl = hdr.indexOf('url') >= 0 ? hdr.indexOf('url') : hdr.indexOf('origin');
        const iName = hdr.indexOf('name') >= 0 ? hdr.indexOf('name') : -1;

        for (let i = 1; i < rows.length; i++) {
            const r = rows[i]; if (!r.length || r.every(c => !c.trim())) continue;
            const g = (idx) => idx >= 0 && idx < r.length ? r[idx].trim() : '';
            const url = g(iUrl);
            items.push({
                label: g(iName) || domainFromUrl(url), login: g(iUser), password: g(iPass),
                domain: domainFromUrl(url), url_match: url, notes: '', tags: '',
            });
        }
    }
    return items;
}

// ─── Clipboard auto-clear ──────────────────────────────────────────────────
function clipboardWrite(text) {
    navigator.clipboard.writeText(text).catch(() => {});
    clearTimeout(clipboardClearTimer);
    clipboardClearTimer = setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
        toastCred('Clipboard cleared', 'info');
    }, CLIPBOARD_CLEAR_MS);
}

// ─── UI helpers ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Screens ───────────────────────────────────────────────────────────────
let _pickerSelectedVaultId = null;

function showScreen(name) {
    for (const el of document.querySelectorAll('[id^="screen-"]')) el.classList.add('hidden');
    for (const el of document.querySelectorAll('[id^="modal-"]')) el.classList.add('hidden');
    const target = $('screen-' + name);
    if (target) target.classList.remove('hidden');
    if (name === 'vault') { setAutolockSelectFromStorage(); resetAutolockTimer(); refreshVaultSwitcher(); }
    else { clearTimeout(autolockTimer); autolockTimer = null; }
    if (name === 'unlock') {
        setTimeout(() => $('unlock-pw')?.focus(), 50);
        api.credentialsVaultStatus().then(st => {
            const hintEl = $('unlock-hint');
            if (st.hint) { hintEl.textContent = 'Hint: ' + st.hint; hintEl.classList.remove('hidden'); }
            else hintEl.classList.add('hidden');
        }).catch(() => {});
    }
    if (name === 'picker') {
        renderVaultPicker();
    }
}

async function bootstrap() {
    const st = await api.credentialsVaultStatus();
    if (!st.exists) {
        if ($('setup-back-btn')) $('setup-back-btn').style.display = 'none';
        showScreen('setup');
        return;
    }
    if (st.vaultCount > 1 && !st.unlocked) { showScreen('picker'); return; }
    if (!st.unlocked) { showScreen('unlock'); return; }
    await enterVault();
}

async function enterVault() {
    showScreen('vault');
    await refreshAll();
}

// ─── Vault Picker (multi-vault) ────────────────────────────────────────────
async function renderVaultPicker() {
    const list = $('picker-vault-list');
    if (!list) return;
    let vaults = [];
    try { vaults = await api.credentialsVaultList(); } catch { /* ignore */ }
    list.innerHTML = '';
    _pickerSelectedVaultId = null;
    const unlockRow = $('picker-unlock-row');
    if (unlockRow) unlockRow.classList.add('hidden');
    const delBtn = $('picker-delete-vault-btn');
    if (delBtn) delBtn.disabled = true;

    for (const v of vaults) {
        const item = document.createElement('div');
        item.className = 'picker-vault-item';
        item.dataset.vid = v.id;
        const ico = `<div class="pv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 1.5l8 4v6c0 5-3.4 9.6-8 11-4.6-1.4-8-6-8-11v-6l8-4z"/></svg></div>`;
        const metaParts = [];
        if (v.last_login_at) metaParts.push('Last: ' + new Date(v.last_login_at).toLocaleDateString());
        if (v.unlocked) metaParts.push('unlocked');
        item.innerHTML = `${ico}<div style="flex:1"><div class="pv-name">${escapeHtml(v.name)}</div><div class="pv-meta">${metaParts.join(' &middot; ') || 'Created ' + new Date(v.created_at).toLocaleDateString()}</div></div>`;
        item.addEventListener('click', () => {
            for (const el of list.querySelectorAll('.picker-vault-item')) el.classList.remove('selected');
            item.classList.add('selected');
            _pickerSelectedVaultId = v.id;
            if (delBtn) delBtn.disabled = false;
            if (v.unlocked) {
                if (unlockRow) unlockRow.classList.add('hidden');
            } else {
                if (unlockRow) unlockRow.classList.remove('hidden');
                const label = $('picker-vault-name-label');
                if (label) label.textContent = 'Unlock: ' + v.name;
                const hintEl = $('picker-hint');
                if (v.hint) { hintEl.textContent = 'Hint: ' + v.hint; hintEl.classList.remove('hidden'); }
                else if (hintEl) hintEl.classList.add('hidden');
                $('picker-pw').value = '';
                $('picker-err').textContent = '';
                setTimeout(() => $('picker-pw')?.focus(), 50);
            }
        });
        item.addEventListener('dblclick', async () => {
            _pickerSelectedVaultId = v.id;
            if (v.unlocked) {
                const r = await api.credentialsVaultSwitch(v.id);
                if (r.success) await enterVault();
            } else {
                if (unlockRow) unlockRow.classList.remove('hidden');
                $('picker-pw')?.focus();
            }
        });
        list.appendChild(item);
    }

    if (vaults.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px">No vaults yet.</div>';
    }
}

async function refreshVaultSwitcher() {
    const sel = $('vault-switcher');
    if (!sel) return;
    let vaults = [];
    try { vaults = await api.credentialsVaultList(); } catch { /* ignore */ }
    const st = await api.credentialsVaultStatus();
    sel.innerHTML = '';
    for (const v of vaults) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name + (v.unlocked ? '' : ' (locked)');
        if (v.id === st.activeVaultId) opt.selected = true;
        sel.appendChild(opt);
    }
    const wrap = sel.closest('.vault-switch-wrap');
    if (wrap) wrap.style.display = vaults.length > 1 ? 'flex' : 'none';
}

async function refreshAll() {
    await Promise.all([refreshDomainsAndNav(), refreshTypeCounts(), refreshFolders()]);
    await loadRows();
}

// ─── Autolock ──────────────────────────────────────────────────────────────
function getAutolockMinutes() {
    const v = Number(localStorage.getItem(AUTOLOCK_STORAGE_KEY));
    return v > 0 ? v : (v === 0 ? 0 : 5);
}
function setAutolockSelectFromStorage() {
    const sel = $('autolock-select');
    if (sel) sel.value = String(getAutolockMinutes());
}
function resetAutolockTimer() {
    clearTimeout(autolockTimer);
    const mins = getAutolockMinutes();
    if (mins <= 0) return;
    autolockTimer = setTimeout(async () => {
        await api.credentialsLock();
        showScreen('unlock');
        toastCred('Vault locked after ' + mins + ' min idle', 'info');
    }, mins * 60 * 1000);
}
function bumpActivity() { resetAutolockTimer(); }

// ─── Nav & data ────────────────────────────────────────────────────────────
async function refreshTypeCounts() {
    try { typeCounts = await api.credentialsTypeCounts(); } catch { typeCounts = { login:0,card:0,identity:0,note:0,total:0 }; }
}
async function refreshFolders() {
    try { folders = await api.credentialsFoldersList(); } catch { folders = []; }
    populateFolderSelect();
}
function populateFolderSelect() {
    const sel = $('f-folder');
    if (!sel) return;
    sel.innerHTML = '<option value="">No folder</option>';
    for (const f of folders) sel.innerHTML += `<option value="${f.id}">${escapeHtml(f.name)}</option>`;
}

async function refreshDomainsAndNav() {
    try {
        const all = await api.credentialsList({ limit: 2000 });
        domainSet = new Set(); domainCounts = {}; tagCounts = {};
        navCountAll = all.length; navCountFav = 0; navCountSite = 0;
        for (const r of all) {
            domainSet.add(r.domain);
            domainCounts[r.domain] = (domainCounts[r.domain] || 0) + 1;
            if (r.is_favorite) navCountFav++;
            for (const t of (r.tags || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
                tagCounts[t] = (tagCounts[t] || 0) + 1;
            }
        }
        if (ctxDomain && ctxPageUrl) {
            const siteRows = all.filter(r => r.domain === ctxDomain);
            navCountSite = siteRows.filter(r => noteMatchesUrlMatch(r.url_match || '', ctxPageUrl)).length;
        }
        const trashRes = await api.credentialsCountTrash().catch(() => ({ count: 0 }));
        navCountTrash = trashRes.count || 0;
    } catch { /* ignore */ }
    renderNav();
}

const NAV_ICONS = {
    all: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 8h4M5 10h5"/></svg>',
    login: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="5" r="3"/><path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5"/></svg>',
    card: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="3" width="14" height="10" rx="2"/><path d="M1 7h14"/></svg>',
    identity: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="1" width="12" height="14" rx="2"/><circle cx="8" cy="6" r="2"/><path d="M5 12c0-1.7 1.3-3 3-3s3 1.3 3 3"/></svg>',
    note: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="1" width="12" height="14" rx="2"/><path d="M5 5h6M5 8h4"/></svg>',
    fav: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.5l2 4 4.5.6-3.2 3.2.8 4.4L8 11.6l-4 2.1.8-4.4L1.5 6.1 6 5.5z"/></svg>',
    site: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>',
    trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4h10M6 4V3a1 1 0 011-1h2a1 1 0 011 1v1M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4"/></svg>',
    folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3h4l2 2h6v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3z"/></svg>',
    health: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 14s-6-3.5-6-7.5a3.5 3.5 0 017 0 3.5 3.5 0 017 0c0 4-6 7.5-6 7.5z"/></svg>',
};

function renderNav() {
    const nav = $('cred-nav');
    if (!nav) return;
    const it = (mode, param, icon, label, count, extraClass) =>
        `<div class="nav-item${extraClass ? ' ' + extraClass : ''}${navMode === mode && navParam === (param || '') ? ' active' : ''}" data-nav="${mode}" data-param="${escapeAttr(param || '')}">
            <span class="nav-icon">${icon}</span><span class="nav-label">${escapeHtml(label)}</span>
            ${count != null ? `<span class="nav-count">${count}</span>` : ''}
        </div>`;
    let h = '<div class="nav-section">Items</div>';
    h += it('all', '', NAV_ICONS.all, 'All items', navCountAll);
    h += it('type', 'login', NAV_ICONS.login, 'Logins', typeCounts.login);
    h += it('type', 'card', NAV_ICONS.card, 'Cards', typeCounts.card);
    h += it('type', 'identity', NAV_ICONS.identity, 'Identities', typeCounts.identity);
    h += it('type', 'note', NAV_ICONS.note, 'Secure Notes', typeCounts.note);
    h += it('fav', '', NAV_ICONS.fav, 'Favorites', navCountFav);
    if (ctxDomain) h += it('site', '', NAV_ICONS.site, 'This site', navCountSite);
    h += it('trash', '', NAV_ICONS.trash, 'Trash', navCountTrash);
    h += it('health', '', NAV_ICONS.health, 'Health Reports', null);

    if (folders.length) {
        h += '<div class="nav-section">Folders</div>';
        for (const f of folders) {
            h += `<div class="nav-item nav-folder-item${navMode === 'folder' && navParam === String(f.id) ? ' active' : ''}" data-nav="folder" data-param="${f.id}">
                <span class="nav-icon">${NAV_ICONS.folder}</span><span class="nav-label">${escapeHtml(f.name)}</span>
                <span class="nav-folder-actions">
                    <button data-folder-rename="${f.id}" title="Rename"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z"/></svg></button>
                    <button data-folder-delete="${f.id}" title="Delete"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
                </span>
            </div>`;
        }
    }

    const domains = Object.keys(domainCounts).sort();
    if (domains.length) {
        h += '<div class="nav-section">Domains</div>';
        for (const d of domains.slice(0, 60)) h += it('domain', d, NAV_ICONS.login, d, domainCounts[d]);
    }
    const tags = Object.keys(tagCounts).sort();
    if (tags.length) {
        h += '<div class="nav-section">Tags</div>';
        for (const t of tags.slice(0, 40)) h += it('tag', t, '', '#' + t, tagCounts[t]);
    }
    nav.innerHTML = h;
    nav.querySelectorAll('.nav-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-folder-rename]') || e.target.closest('[data-folder-delete]')) return;
            navMode = el.dataset.nav;
            navParam = el.dataset.param || '';
            renderNav();
            loadRows();
        });
    });
    nav.querySelectorAll('[data-folder-rename]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const fid = Number(btn.dataset.folderRename);
            const f = folders.find(x => x.id === fid);
            const name = prompt('Rename folder:', f?.name || '');
            if (name && name.trim()) { await api.credentialsFolderRename(fid, name.trim()); await refreshFolders(); renderNav(); }
        });
    });
    nav.querySelectorAll('[data-folder-delete]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const fid = Number(btn.dataset.folderDelete);
            if (confirm('Delete this folder? Items will be moved to No Folder.')) {
                await api.credentialsFolderDelete(fid);
                await refreshFolders(); await refreshDomainsAndNav(); await loadRows();
            }
        });
    });
}

// ─── List ──────────────────────────────────────────────────────────────────
async function loadRows() {
    if (navMode === 'health') { showHealthPanel(); return; }
    hideHealthPanel();
    const search = $('cred-search')?.value?.trim() || '';
    const sortBy = $('sort-select')?.value || 'updated';
    const f = { limit: 2000, search, sortBy };
    if (navMode === 'fav') f.favoritesOnly = true;
    if (navMode === 'site' && ctxDomain) { f.domain = ctxDomain; f.refineByUrlMatch = true; f.pageUrl = ctxPageUrl; }
    if (navMode === 'domain' && navParam) f.domain = navParam;
    if (navMode === 'tag' && navParam) f.tag = navParam;
    if (navMode === 'type' && navParam) f.itemType = navParam;
    if (navMode === 'folder' && navParam) f.folderId = Number(navParam);
    if (navMode === 'trash') f.trashOnly = true;
    try {
        listRows = await api.credentialsList(f);
    } catch (e) {
        if (String(e).includes('locked') || String(e?.message || '').includes('locked')) { showScreen('unlock'); return; }
        listRows = [];
    }
    renderList();
}
const loadRowsDebounced = debounce(() => loadRows(), 200);

function renderList() {
    const el = $('cred-list');
    if (!el) return;
    $('list-count').textContent = listRows.length + ' items';
    if (!listRows.length) { el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px">No items</div>'; return; }
    let h = '';
    for (const r of listRows) {
        const letter = avatarLetter(r);
        const hue = hueForKey(r.domain || r.label || '');
        const isActive = r.id === currentId;
        const favicon = r.domain && r.domain !== '(no site)' ? `<img class="cred-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(r.domain)}&sz=32" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="cred-avatar" style="display:none;--ah:${hue}">${escapeHtml(letter)}</div>` : `<div class="cred-avatar" style="--ah:${hue}">${escapeHtml(letter)}</div>`;
        const typeBadge = r.item_type && r.item_type !== 'login' ? `<span class="type-badge">${escapeHtml(r.item_type)}</span>` : '';
        h += `<div class="cred-row${isActive ? ' active' : ''}" data-id="${r.id}" tabindex="0">
            <div class="cred-avatar-wrap">${favicon}</div>
            <div class="cred-row-text">
                <div class="title">${escapeHtml(r.label || r.domain)}</div>
                <div class="sub">${escapeHtml(r.login || r.domain || '')}</div>
            </div>
            ${typeBadge}
            ${r.is_favorite ? '<span class="fav" title="Favorite">&#9733;</span>' : ''}
        </div>`;
    }
    el.innerHTML = h;
    kbListIdx = -1;
    el.querySelectorAll('.cred-row').forEach((row, idx) => {
        row.addEventListener('click', () => selectCredential(Number(row.dataset.id)));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, Number(row.dataset.id)); });
    });
}

// ─── Context menu ──────────────────────────────────────────────────────────
function showContextMenu(e, id) {
    const menu = $('ctx-menu');
    const row = listRows.find(r => r.id === id);
    if (!row) return;
    const isTrash = navMode === 'trash';
    let h = '';
    if (!isTrash) {
        h += `<div class="ctx-menu-item" data-action="copy-login">Copy username</div>`;
        h += `<div class="ctx-menu-item" data-action="copy-password">Copy password</div>`;
        if (row.item_type === 'login') h += `<div class="ctx-menu-item" data-action="copy-totp">Copy TOTP</div>`;
        h += '<div class="ctx-menu-sep"></div>';
        h += `<div class="ctx-menu-item" data-action="edit">Edit</div>`;
        h += `<div class="ctx-menu-item" data-action="duplicate">Duplicate</div>`;
        h += `<div class="ctx-menu-item" data-action="move-folder">Move to folder&hellip;</div>`;
        h += '<div class="ctx-menu-sep"></div>';
        h += `<div class="ctx-menu-item danger" data-action="delete">Move to trash</div>`;
    } else {
        h += `<div class="ctx-menu-item" data-action="restore">Restore</div>`;
        h += `<div class="ctx-menu-item danger" data-action="delete-permanent">Delete permanently</div>`;
    }
    menu.innerHTML = h;
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.remove('hidden');
    const handler = async (ev) => {
        const item = ev.target.closest('.ctx-menu-item');
        if (!item) return;
        menu.classList.add('hidden');
        document.removeEventListener('click', closeMenu);
        const action = item.dataset.action;
        if (action === 'edit') selectCredential(id);
        else if (action === 'copy-login') { const full = await api.credentialsGet(id); clipboardWrite(full?.login || ''); toastCred('Username copied', 'success'); }
        else if (action === 'copy-password') { const full = await api.credentialsGet(id); clipboardWrite(full?.password || ''); toastCred('Password copied', 'success'); }
        else if (action === 'copy-totp') {
            const full = await api.credentialsGet(id);
            const sec = full?.extra?.totpSecret;
            if (sec && typeof cupnetTotp !== 'undefined') {
                const r = await cupnetTotp.generate(sec);
                clipboardWrite(r.code); toastCred('TOTP copied', 'success');
            }
        }
        else if (action === 'duplicate') { await selectCredential(id); duplicateCurrent(); }
        else if (action === 'move-folder') {
            const name = prompt('Folder name (or leave empty for No Folder):');
            if (name === null) return;
            if (!name.trim()) { await api.credentialsMoveToFolder(id, null); }
            else {
                let f = folders.find(x => x.name.toLowerCase() === name.trim().toLowerCase());
                if (!f) { const res = await api.credentialsFolderCreate(name.trim()); f = { id: res.id }; await refreshFolders(); }
                await api.credentialsMoveToFolder(id, f.id);
            }
            await refreshAll();
        }
        else if (action === 'delete') { await api.credentialsDelete(id, false); if (currentId === id) { currentId = null; showEmptyDetail(); } await refreshAll(); toastCred('Moved to trash', 'info'); }
        else if (action === 'restore') { await api.credentialsRestore(id); await refreshAll(); toastCred('Restored', 'success'); }
        else if (action === 'delete-permanent') { if (confirm('Permanently delete?')) { await api.credentialsDelete(id, true); if (currentId === id) { currentId = null; showEmptyDetail(); } await refreshAll(); } }
    };
    menu.addEventListener('click', handler, { once: true });
    const closeMenu = () => { menu.classList.add('hidden'); menu.removeEventListener('click', handler); };
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}

// ─── Detail form ───────────────────────────────────────────────────────────
function showEmptyDetail() {
    $('cred-detail-empty')?.classList.remove('hidden');
    $('cred-detail-form')?.classList.add('hidden');
    $('health-panel')?.classList.add('hidden');
}

function syncTypeFields() {
    const type = $('f-item-type').value;
    $('section-login').classList.toggle('hidden', type !== 'login');
    $('section-card').classList.toggle('hidden', type !== 'card');
    $('section-identity').classList.toggle('hidden', type !== 'identity');
    $('section-note').classList.toggle('hidden', type !== 'note');
}

async function selectCredential(id) {
    bumpActivity();
    currentId = id;
    renderList();
    clearTotpTimer();
    const data = await api.credentialsGet(id);
    if (!data) { showEmptyDetail(); return; }
    $('cred-detail-empty').classList.add('hidden');
    $('health-panel').classList.add('hidden');
    $('cred-detail-form').classList.remove('hidden');

    $('f-item-type').value = data.item_type || 'login';
    syncTypeFields();
    $('f-label').value = data.label || '';
    $('f-domain').value = data.domain || '';
    $('f-tags').value = data.tags || '';
    $('f-folder').value = data.folder_id || '';
    $('f-login').value = data.login || '';
    $('f-password').value = data.password || '';
    $('f-totp-secret').value = data.extra?.totpSecret || '';
    $('f-notes').value = data.notes || '';

    // Card
    const card = data.extra?.card || {};
    $('f-card-holder').value = card.cardholderName || '';
    $('f-card-number').value = card.number || '';
    $('f-card-exp').value = card.expMonth && card.expYear ? `${card.expMonth}/${card.expYear}` : '';
    $('f-card-cvv').value = card.code || '';
    $('f-card-brand').value = card.brand || '';

    // Identity
    const ident = data.extra?.identity || {};
    $('f-id-first').value = ident.firstName || '';
    $('f-id-last').value = ident.lastName || '';
    $('f-id-company').value = ident.company || '';
    $('f-id-email').value = ident.email || '';
    $('f-id-phone').value = ident.phone || '';
    $('f-id-address1').value = ident.address1 || '';
    $('f-id-address2').value = ident.address2 || '';
    $('f-id-city').value = ident.city || '';
    $('f-id-state').value = ident.state || '';
    $('f-id-zip').value = ident.postalCode || '';
    $('f-id-country').value = ident.country || '';

    // Secure note
    $('f-secure-note').value = data.extra?.secureNoteContent || data.notes || '';

    // URIs
    renderUris(data.uris || []);
    // Custom fields
    renderCustomFields(data.customFields || []);

    // Meta
    const metaIp = $('meta-ip-proxy');
    const metaDates = $('meta-dates');
    metaIp.textContent = [data.last_ip, data.last_proxy_profile_name].filter(Boolean).join(' · ') || '—';
    metaDates.textContent = `Created ${fmtDate(data.created_at)} · Updated ${fmtDate(data.updated_at)}${data.last_used_at ? ' · Used ' + fmtDate(data.last_used_at) : ''}`;

    applyCredBaseline();
    setCredentialSaveState('saved');
    startTotpTimer();
}

function clearDetailForm() {
    currentId = null;
    clearTotpTimer();
    $('cred-detail-empty').classList.add('hidden');
    $('health-panel').classList.add('hidden');
    $('cred-detail-form').classList.remove('hidden');
    $('f-item-type').value = 'login';
    syncTypeFields();
    $('f-label').value = '';
    $('f-domain').value = ctxDomain || '';
    $('f-tags').value = '';
    $('f-folder').value = navMode === 'folder' ? navParam : '';
    $('f-login').value = '';
    $('f-password').value = '';
    $('f-totp-secret').value = '';
    $('f-notes').value = '';
    for (const id of ['f-card-holder','f-card-number','f-card-exp','f-card-cvv']) $(id).value = '';
    $('f-card-brand').value = '';
    for (const id of ['f-id-first','f-id-last','f-id-company','f-id-email','f-id-phone','f-id-address1','f-id-address2','f-id-city','f-id-state','f-id-zip','f-id-country']) $(id).value = '';
    $('f-secure-note').value = '';
    renderUris([]);
    renderCustomFields([]);
    $('meta-ip-proxy').textContent = '—';
    $('meta-dates').textContent = '';
    $('delete-confirm-bar').classList.remove('visible');
    applyCredBaseline();
    refreshCredSaveIndicator();
    $('f-label').focus();
}

// ─── URI editor ────────────────────────────────────────────────────────────
function renderUris(uris) {
    const list = $('uri-list');
    list.innerHTML = '';
    (uris.length ? uris : []).forEach((u, i) => addUriRow(u.uri, u.match_type, i));
}
function addUriRow(uri = '', matchType = 0) {
    const list = $('uri-list');
    const row = document.createElement('div');
    row.className = 'uri-row';
    const opts = MATCH_TYPES.map((l, i) => `<option value="${i}"${i === matchType ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('');
    row.innerHTML = `<input type="text" value="${escapeAttr(uri)}" placeholder="https://example.com" class="uri-val">
        <select class="uri-match">${opts}</select>
        <button type="button" class="btn btn-icon btn-sm" title="Remove"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    list.appendChild(row);
}

// ─── Custom fields editor ──────────────────────────────────────────────────
function renderCustomFields(fields) {
    const list = $('custom-fields-list');
    list.innerHTML = '';
    for (const f of fields) addCustomFieldRow(f.name, f.value, f.field_type);
}
function addCustomFieldRow(name = '', value = '', fieldType = 'text') {
    const list = $('custom-fields-list');
    const row = document.createElement('div');
    row.className = 'cf-row';
    row.innerHTML = `<input type="text" value="${escapeAttr(name)}" placeholder="Field name" class="cf-name" style="max-width:140px">
        <input type="${fieldType === 'hidden' ? 'password' : 'text'}" value="${escapeAttr(fieldType === 'checkbox' ? '' : value)}" placeholder="Value" class="cf-value" ${fieldType === 'checkbox' ? 'style="display:none"' : ''}>
        ${fieldType === 'checkbox' ? `<label style="margin:0;font-size:12px"><input type="checkbox" class="cf-check" ${value === '1' || value === 'true' ? 'checked' : ''}> Checked</label>` : ''}
        <select class="cf-type"><option value="text"${fieldType==='text'?' selected':''}>Text</option><option value="hidden"${fieldType==='hidden'?' selected':''}>Hidden</option><option value="checkbox"${fieldType==='checkbox'?' selected':''}>Check</option></select>
        <button type="button" class="btn btn-icon btn-sm" title="Remove"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    list.appendChild(row);
}

function collectUris() {
    return [...$('uri-list').querySelectorAll('.uri-row')].map(r => ({
        uri: r.querySelector('.uri-val').value.trim(),
        match_type: Number(r.querySelector('.uri-match').value) || 0,
    })).filter(u => u.uri);
}
function collectCustomFields() {
    return [...$('custom-fields-list').querySelectorAll('.cf-row')].map(r => {
        const ft = r.querySelector('.cf-type').value;
        let val = '';
        if (ft === 'checkbox') val = r.querySelector('.cf-check')?.checked ? '1' : '0';
        else val = r.querySelector('.cf-value').value;
        return { name: r.querySelector('.cf-name').value.trim(), value: val, field_type: ft };
    });
}

// ─── Save state ────────────────────────────────────────────────────────────
function snapshotCredForm() {
    const fields = ['f-item-type','f-label','f-domain','f-tags','f-folder','f-login','f-password','f-totp-secret','f-notes',
        'f-card-holder','f-card-number','f-card-exp','f-card-cvv','f-card-brand',
        'f-id-first','f-id-last','f-id-company','f-id-email','f-id-phone','f-id-address1','f-id-address2','f-id-city','f-id-state','f-id-zip','f-id-country','f-secure-note'];
    return fields.map(id => $(id)?.value || '').join('\x00');
}
function applyCredBaseline() { credFormBaseline = snapshotCredForm(); }
function isCredFormDirty() { return snapshotCredForm() !== credFormBaseline; }
function setCredentialSaveState(state) {
    const el = $('save-status');
    if (!el) return;
    el.className = state;
    el.textContent = state === 'saving' ? 'Saving...' : state === 'unsaved' ? 'Unsaved changes' : state === 'saved' ? 'Saved' : state === 'err' ? 'Error' : '';
}
function refreshCredSaveIndicator() { setCredentialSaveState(isCredFormDirty() ? 'unsaved' : (currentId ? 'saved' : '')); }

// ─── TOTP ──────────────────────────────────────────────────────────────────
function clearTotpTimer() { if (totpTimer) { clearInterval(totpTimer); totpTimer = null; } $('totp-code-live').textContent = '—'; }
async function refreshTotpDisplay() {
    const sec = $('f-totp-secret')?.value?.trim();
    if (!sec || typeof cupnetTotp === 'undefined') { $('totp-code-live').textContent = '—'; return; }
    try {
        const r = await cupnetTotp.generate(sec);
        $('totp-code-live').textContent = r.code + '  (' + r.secondsRemaining + 's)';
    } catch { $('totp-code-live').textContent = 'Invalid'; }
}
function startTotpTimer() {
    clearTotpTimer();
    refreshTotpDisplay();
    totpTimer = setInterval(refreshTotpDisplay, 1000);
}

// ─── Save ──────────────────────────────────────────────────────────────────
async function saveCurrentCredential() {
    bumpActivity();
    setCredentialSaveState('saving');
    const type = $('f-item-type').value;
    const extra = {};
    const totp = $('f-totp-secret').value.trim();
    if (totp) extra.totpSecret = totp;
    if (type === 'card') {
        const exp = $('f-card-exp').value.trim().split('/');
        extra.card = {
            cardholderName: $('f-card-holder').value.trim(),
            number: $('f-card-number').value.trim(),
            expMonth: exp[0]?.trim() || '',
            expYear: exp[1]?.trim() || '',
            code: $('f-card-cvv').value.trim(),
            brand: $('f-card-brand').value,
        };
    }
    if (type === 'identity') {
        extra.identity = {
            firstName: $('f-id-first').value.trim(), lastName: $('f-id-last').value.trim(),
            company: $('f-id-company').value.trim(), email: $('f-id-email').value.trim(),
            phone: $('f-id-phone').value.trim(), address1: $('f-id-address1').value.trim(),
            address2: $('f-id-address2').value.trim(), city: $('f-id-city').value.trim(),
            state: $('f-id-state').value.trim(), postalCode: $('f-id-zip').value.trim(),
            country: $('f-id-country').value.trim(),
        };
    }
    if (type === 'note') extra.secureNoteContent = $('f-secure-note').value;

    const payload = {
        id: currentId || null,
        item_type: type,
        domain: $('f-domain').value.trim().toLowerCase() || '(no site)',
        label: $('f-label').value.trim(),
        login: $('f-login').value,
        password: $('f-password').value,
        extra,
        notes: $('f-notes').value,
        tags: $('f-tags').value,
        is_favorite: listRows.find(r => r.id === currentId)?.is_favorite || false,
        folder_id: $('f-folder').value ? Number($('f-folder').value) : null,
        uris: collectUris(),
        customFields: collectCustomFields(),
    };

    try {
        const res = await api.credentialsSave(payload);
        if (res.success) {
            currentId = res.id;
            applyCredBaseline();
            setCredentialSaveState('saved');
            await refreshAll();
            toastCred('Saved', 'success');
        } else {
            setCredentialSaveState('err');
            toastCred(res.error || 'Save failed', 'error');
        }
    } catch (e) {
        setCredentialSaveState('err');
        toastCred(String(e?.message || e), 'error');
    }
}

function duplicateCurrent() {
    currentId = null;
    $('f-label').value = ($('f-label').value || '') + ' (copy)';
    applyCredBaseline();
    refreshCredSaveIndicator();
    toastCred('Editing as new item — click Save', 'info');
}

// ─── Health panel ──────────────────────────────────────────────────────────
let healthData = null;
function showHealthPanel() {
    $('cred-detail-empty').classList.add('hidden');
    $('cred-detail-form').classList.add('hidden');
    $('health-panel').classList.remove('hidden');
    if (!healthData) runHealthScan();
    else renderHealthPanel();
}
function hideHealthPanel() { $('health-panel').classList.add('hidden'); }

async function runHealthScan() {
    const panel = $('health-panel');
    panel.innerHTML = '<div style="padding:24px;color:var(--text-muted)">Scanning vault...</div>';
    const allRows = await api.credentialsList({ limit: 2000, itemType: 'login' });
    const passwords = [];
    for (const r of allRows) {
        const full = await api.credentialsGet(r.id);
        if (full?.password) passwords.push({ id: r.id, label: r.label || r.domain, domain: r.domain, login: r.login, password: full.password });
    }
    const weak = [], reused = [];
    const pwCount = {};
    for (const p of passwords) {
        const sc = scoreMasterPassword(p.password);
        if (sc.score < 3) weak.push({ ...p, scoreLabel: sc.label });
        pwCount[p.password] = (pwCount[p.password] || []);
        pwCount[p.password].push(p);
    }
    for (const [pw, items] of Object.entries(pwCount)) {
        if (items.length > 1) reused.push(...items.map(i => ({ ...i, reusedCount: items.length })));
    }
    healthData = { weak, reused, total: passwords.length };
    renderHealthPanel();
}

function renderHealthPanel() {
    const panel = $('health-panel');
    if (!healthData) return;
    const { weak, reused, total } = healthData;
    const uniqueReused = [...new Map(reused.map(r => [r.id, r])).values()];
    let h = `<h2 style="font-size:16px;font-weight:600;margin-bottom:4px">Vault Health</h2>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${total} login passwords analyzed</div>`;
    h += `<div class="health-card">
        <div class="health-card-header">
            <span class="health-card-count ${weak.length ? 'warn' : 'ok'}">${weak.length}</span>
            <span class="health-card-title">Weak Passwords</span>
        </div>
        <div class="health-card-desc">Passwords that are too short or lack complexity.</div>`;
    if (weak.length) {
        h += '<div class="health-list">';
        for (const w of weak.slice(0, 20)) h += `<div class="health-list-item"><span class="hl-label">${escapeHtml(w.label)}</span><span class="hl-domain">${escapeHtml(w.domain)}</span><span style="color:var(--warn);font-size:11px">${escapeHtml(w.scoreLabel)}</span></div>`;
        h += '</div>';
    }
    h += '</div>';

    h += `<div class="health-card">
        <div class="health-card-header">
            <span class="health-card-count ${uniqueReused.length ? 'danger' : 'ok'}">${uniqueReused.length}</span>
            <span class="health-card-title">Reused Passwords</span>
        </div>
        <div class="health-card-desc">Items sharing the same password. Change them to unique passwords.</div>`;
    if (uniqueReused.length) {
        h += '<div class="health-list">';
        for (const r of uniqueReused.slice(0, 20)) h += `<div class="health-list-item"><span class="hl-label">${escapeHtml(r.label)}</span><span class="hl-domain">${escapeHtml(r.domain)}</span><span style="color:var(--danger);font-size:11px">Used ${r.reusedCount}x</span></div>`;
        h += '</div>';
    }
    h += '</div>';
    panel.innerHTML = h;
}

// ─── Import source ─────────────────────────────────────────────────────────
function openImportSourceModal() {
    const list = $('import-source-list');
    list.innerHTML = '';
    for (const src of IMPORT_SOURCES) {
        const el = document.createElement('div');
        el.className = 'import-source-item';
        el.innerHTML = `<div><div class="isi-name">${escapeHtml(src.name)}</div><div class="isi-hint">${escapeHtml(src.hint)}</div></div>`;
        el.addEventListener('click', () => { $('modal-import-source').classList.add('hidden'); handleImportSource(src); });
        list.appendChild(el);
    }
    $('modal-import-source').classList.remove('hidden');
}

async function handleImportSource(src) {
    if (src.id === 'batch') {
        $('modal-batch').classList.remove('hidden');
        return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = src.ext || '.csv,.json';
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        const items = parseImportSource(src.id, text);
        if (!items.length) { toastCred('No items parsed from file', 'warning'); return; }
        try {
            const res = await api.credentialsImportBatch({ items });
            if (res.success) {
                toastCred(`Imported ${res.imported} items (${res.skipped} skipped)`, 'success');
                await refreshAll();
            } else toastCred(res.error || 'Import failed', 'error');
        } catch (e) { toastCred(String(e?.message || e), 'error'); }
    };
    input.click();
}

// ─── Batch import (existing) ───────────────────────────────────────────────
function splitLines(text) { return text.split(/\r?\n/).filter(l => l.trim()); }
function detectDelimiterFromFirstLine(line) {
    if (line.includes('\t')) return '\t';
    const counts = { ',': 0, '|': 0, ';': 0 };
    for (const c of line) { if (c in counts) counts[c]++; }
    let best = ',', max = 0;
    for (const [k, v] of Object.entries(counts)) { if (v > max) { max = v; best = k; } }
    return best;
}
function normalizeHeaderKey(cell) {
    const c = cell.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    const map = { user: 'login', username: 'login', email: 'login', mail: 'login', name: 'label', title: 'label', site: 'domain', host: 'domain', website: 'domain', pw: 'password', pass: 'password', passwd: 'password', url: 'url_match', uri: 'url_match', urlmatch: 'url_match', tag: 'tags', folder: 'tags', group: 'tags', note: 'notes', comment: 'notes' };
    return map[c] || c;
}
let batchParsedItems = [];

function parseDelimitedRaw(text, delim, hasHeader, orderCsv) {
    const lines = splitLines(text);
    if (!lines.length) return [];
    const sep = delim || detectDelimiterFromFirstLine(lines[0]);
    let colKeys;
    let startIdx = 0;
    if (hasHeader) { colKeys = lines[0].split(sep).map(normalizeHeaderKey); startIdx = 1; }
    else { colKeys = (orderCsv || 'login,password').split(',').map(s => s.trim()); }
    const result = [];
    for (let i = startIdx; i < lines.length; i++) {
        const cells = lines[i].split(sep);
        const obj = {};
        colKeys.forEach((k, idx) => { if (idx < cells.length) obj[k] = cells[idx].trim(); });
        if (obj.login || obj.password || obj.domain) result.push(obj);
    }
    return result;
}

function parseRegexRaw(text, pattern, flags, gLogin, gPass, gDomain, gLabel, gUrl, gTags) {
    const lines = splitLines(text);
    const re = new RegExp(pattern, flags || 'u');
    const result = [];
    for (const line of lines) {
        const m = re.exec(line);
        if (!m) continue;
        const g = (n) => (n > 0 && n < m.length) ? (m[n] || '') : '';
        const obj = { login: g(gLogin), password: g(gPass), domain: g(gDomain), label: g(gLabel), url_match: g(gUrl), tags: g(gTags) };
        if (obj.login || obj.password || obj.domain) result.push(obj);
    }
    return result;
}

function getBatchDelimiter() {
    const v = $('batch-delim').value;
    if (v === 'auto') return null;
    if (v === 'tab') return '\t';
    if (v === 'custom') return $('batch-delim-custom').value || ',';
    return v;
}

function syncBatchPanels() {
    const mode = $('batch-mode').value;
    $('batch-delim-panel').classList.toggle('hidden', mode !== 'delim');
    $('batch-header-wrap').classList.toggle('hidden', mode !== 'delim');
    $('batch-order-wrap').classList.toggle('hidden', mode !== 'delim');
    $('batch-regex-panel').classList.toggle('hidden', mode !== 'regex');
}

function maskPasswordPreview(pw) {
    if (!pw) return '';
    return pw.length <= 3 ? '***' : pw.slice(0, 2) + '***' + pw.slice(-1);
}

function runBatchPreview() {
    const text = $('batch-text').value;
    const errEl = $('batch-err');
    if (!text.trim()) { errEl.textContent = 'Paste some data first'; errEl.className = ''; return; }
    try {
        if ($('batch-mode').value === 'regex') {
            batchParsedItems = parseRegexRaw(text, $('batch-regex').value, $('batch-regex-flags').value,
                +$('batch-g-login').value, +$('batch-g-pass').value, +$('batch-g-domain').value,
                +$('batch-g-label').value, +$('batch-g-url').value, +$('batch-g-tags').value);
        } else {
            batchParsedItems = parseDelimitedRaw(text, getBatchDelimiter(), $('batch-header').checked, $('batch-order').value);
        }
    } catch (e) { errEl.textContent = 'Parse error: ' + e.message; errEl.className = ''; return; }

    if (!batchParsedItems.length) { errEl.textContent = 'No items parsed'; errEl.className = ''; return; }
    errEl.textContent = batchParsedItems.length + ' items ready to import';
    errEl.className = 'ok';
    $('batch-import-btn').disabled = false;

    const cols = ['login','password','domain','label','url_match','tags'];
    $('batch-preview-head').innerHTML = cols.map(c => `<th>${escapeHtml(c)}</th>`).join('');
    $('batch-preview-body').innerHTML = batchParsedItems.slice(0, 50).map(r =>
        '<tr>' + cols.map(c => `<td>${escapeHtml(c === 'password' ? maskPasswordPreview(r[c]) : (r[c] || ''))}</td>`).join('') + '</tr>'
    ).join('');
    $('batch-preview-wrap').classList.remove('hidden');
}

// ─── Events ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Password toggles
    document.querySelectorAll('.btn-pw-toggle[data-toggle-pw]').forEach(btn => {
        let show = false;
        btn.addEventListener('click', () => {
            show = !show;
            const input = $(btn.dataset.togglePw);
            if (input) setPwVisibility(input, btn, show);
        });
    });

    // Setup
    $('setup-pw').addEventListener('input', () => {
        const sc = scoreMasterPassword($('setup-pw').value);
        $('setup-strength-fill').style.width = sc.pct + '%';
        $('setup-strength-fill').style.background = sc.color;
        $('setup-strength-label').textContent = sc.label;
        $('setup-strength-label').style.color = sc.color;
    });
    $('setup-submit').addEventListener('click', async () => {
        const pw = $('setup-pw').value, pw2 = $('setup-pw2').value;
        const name = ($('setup-name')?.value || '').trim() || 'Default';
        if (pw.length < 8) { $('setup-err').textContent = 'At least 8 characters'; return; }
        if (pw !== pw2) { $('setup-err').textContent = 'Passwords do not match'; return; }
        const isNewVault = $('setup-back-btn')?.style.display !== 'none';
        let res;
        if (isNewVault) {
            res = await api.credentialsVaultCreate({ name, password: pw, confirm: pw2 });
        } else {
            res = await api.credentialsVaultSetup({ name, password: pw, confirm: pw2 });
        }
        if (res.success) {
            const hint = $('setup-hint')?.value?.trim();
            if (hint) await api.credentialsVaultSetHint(hint);
            await enterVault();
        } else $('setup-err').textContent = res.error || 'Failed';
    });

    // Back from setup to picker
    $('setup-back-btn')?.addEventListener('click', () => showScreen('picker'));

    // Unlock
    const doUnlock = async () => {
        const res = await api.credentialsUnlock($('unlock-pw').value);
        if (res.success) { $('unlock-pw').value = ''; await enterVault(); }
        else $('unlock-err').textContent = res.error || 'Failed';
    };
    $('unlock-submit').addEventListener('click', doUnlock);
    $('unlock-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
    $('setup-pw2').addEventListener('keydown', e => { if (e.key === 'Enter') $('setup-submit').click(); });

    // Lock
    $('btn-lock').addEventListener('click', async () => {
        await api.credentialsLock();
        const vaults = await api.credentialsVaultList().catch(() => []);
        if (vaults.length > 1) showScreen('picker');
        else showScreen('unlock');
    });

    // ── Vault Picker events ─────────────────────────────────────────────────
    const pickerUnlockBtn = $('picker-unlock-btn');
    const pickerPw = $('picker-pw');

    async function doPickerUnlock() {
        if (!_pickerSelectedVaultId) return;
        const pw = pickerPw?.value || '';
        const res = await api.credentialsVaultSwitch(_pickerSelectedVaultId, pw);
        if (res.success) {
            pickerPw.value = '';
            await enterVault();
        } else {
            $('picker-err').textContent = res.error || 'Failed';
        }
    }
    pickerUnlockBtn?.addEventListener('click', doPickerUnlock);
    pickerPw?.addEventListener('keydown', e => { if (e.key === 'Enter') doPickerUnlock(); });

    $('picker-new-vault-btn')?.addEventListener('click', () => {
        $('setup-name').value = '';
        $('setup-pw').value = '';
        $('setup-pw2').value = '';
        $('setup-hint').value = '';
        $('setup-err').textContent = '';
        $('setup-back-btn').style.display = '';
        showScreen('setup');
    });

    $('picker-delete-vault-btn')?.addEventListener('click', async () => {
        if (!_pickerSelectedVaultId) return;
        const vaults = await api.credentialsVaultList().catch(() => []);
        const v = vaults.find(x => x.id === _pickerSelectedVaultId);
        if (!v) return;

        const needsPw = v.last_login_at &&
            (Date.now() - new Date(v.last_login_at).getTime()) < 30 * 24 * 60 * 60 * 1000;

        let pw = '';
        if (needsPw) {
            pw = prompt(`Vault "${v.name}" was used within 30 days. Enter master password to delete:`);
            if (pw == null) return;
        } else {
            if (!confirm(`Delete vault "${v.name}" and all its data? This cannot be undone.`)) return;
        }

        const res = await api.credentialsVaultDelete(_pickerSelectedVaultId, pw);
        if (res.success) {
            const remaining = await api.credentialsVaultList().catch(() => []);
            if (remaining.length === 0) {
                if ($('setup-back-btn')) $('setup-back-btn').style.display = 'none';
                showScreen('setup');
            }
            else renderVaultPicker();
        } else {
            alert(res.error || 'Failed to delete vault');
        }
    });

    // Vault switcher in toolbar
    $('vault-switcher')?.addEventListener('change', async (e) => {
        const vid = Number(e.target.value);
        const vaults = await api.credentialsVaultList().catch(() => []);
        const v = vaults.find(x => x.id === vid);
        if (!v) return;
        if (v.unlocked) {
            const r = await api.credentialsVaultSwitch(vid);
            if (r.success) await refreshAll();
        } else {
            const pw = prompt(`Enter password for vault "${v.name}":`);
            if (!pw) { refreshVaultSwitcher(); return; }
            const r = await api.credentialsVaultSwitch(vid, pw);
            if (r.success) await refreshAll();
            else { alert(r.error || 'Failed'); refreshVaultSwitcher(); }
        }
    });

    // Autolock
    $('autolock-select').addEventListener('change', () => {
        localStorage.setItem(AUTOLOCK_STORAGE_KEY, $('autolock-select').value);
        resetAutolockTimer();
    });

    // Search
    $('cred-search').addEventListener('input', loadRowsDebounced);

    // Sort
    $('sort-select').addEventListener('change', () => loadRows());

    // New item
    $('btn-new-account').addEventListener('click', () => clearDetailForm());

    // New folder
    $('btn-new-folder').addEventListener('click', async () => {
        const name = prompt('Folder name:');
        if (name && name.trim()) {
            await api.credentialsFolderCreate(name.trim());
            await refreshFolders();
            renderNav();
        }
    });

    // Item type change
    $('f-item-type').addEventListener('change', syncTypeFields);

    // Form dirty tracking
    $('cred-detail-form').addEventListener('input', refreshCredSaveIndicator);
    $('cred-detail-form').addEventListener('change', refreshCredSaveIndicator);

    // Save
    $('btn-save').addEventListener('click', saveCurrentCredential);

    // Duplicate
    $('btn-duplicate').addEventListener('click', duplicateCurrent);

    // Grab IP
    $('btn-grab-ip').addEventListener('click', async () => {
        const res = await api.credentialsGetTabProxyIp();
        $('meta-ip-proxy').textContent = [res.ip, res.proxyProfileName].filter(Boolean).join(' · ');
        toastCred('IP captured', 'info');
    });

    // Copy
    $('btn-copy-login').addEventListener('click', () => { clipboardWrite($('f-login').value); toastCred('Username copied', 'success'); });
    $('btn-copy-password').addEventListener('click', () => { clipboardWrite($('f-password').value); toastCred('Password copied', 'success'); });
    $('btn-copy-totp').addEventListener('click', async () => {
        const sec = $('f-totp-secret').value.trim();
        if (!sec || typeof cupnetTotp === 'undefined') return;
        try { const r = await cupnetTotp.generate(sec); clipboardWrite(r.code); toastCred('TOTP copied', 'success'); } catch { toastCred('Invalid TOTP secret', 'error'); }
    });

    // TOTP live update
    $('f-totp-secret').addEventListener('input', () => { startTotpTimer(); });

    // Delete
    $('btn-delete').addEventListener('click', () => $('delete-confirm-bar').classList.add('visible'));
    $('btn-delete-cancel').addEventListener('click', () => $('delete-confirm-bar').classList.remove('visible'));
    $('btn-delete-confirm').addEventListener('click', async () => {
        if (!currentId) return;
        const permanent = navMode === 'trash';
        await api.credentialsDelete(currentId, permanent);
        currentId = null;
        showEmptyDetail();
        $('delete-confirm-bar').classList.remove('visible');
        await refreshAll();
        toastCred(permanent ? 'Permanently deleted' : 'Moved to trash', 'info');
    });

    // Generator
    $('btn-gen-password').addEventListener('click', () => $('gen-popover').classList.toggle('hidden'));
    $('gen-close').addEventListener('click', () => $('gen-popover').classList.add('hidden'));
    document.querySelectorAll('.gen-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.gen-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const mode = tab.dataset.genMode;
            $('gen-password-opts').classList.toggle('hidden', mode !== 'password');
            $('gen-passphrase-opts').classList.toggle('hidden', mode !== 'passphrase');
        });
    });
    $('gen-apply').addEventListener('click', () => {
        const activeTab = document.querySelector('.gen-tab.active');
        const mode = activeTab?.dataset.genMode || 'password';
        let pw;
        if (mode === 'passphrase') {
            pw = generatePassphrase(+$('gen-words').value, $('gen-separator').value, $('gen-capitalize').checked);
        } else {
            pw = generatePassword(+$('gen-length').value, $('gen-symbols').checked, $('gen-numbers').checked);
        }
        $('f-password').value = pw;
        $('f-password').type = 'text';
        $('gen-popover').classList.add('hidden');
        refreshCredSaveIndicator();
    });

    // URI add
    $('btn-add-uri').addEventListener('click', () => addUriRow());
    // Custom field add
    $('btn-add-field').addEventListener('click', () => addCustomFieldRow());

    // Export
    const runExport = async (format) => {
        const res = await api.credentialsExport({ format });
        if (res?.canceled) return;
        if (res?.error) toastCred(res.error, 'error');
        else toastCred('Exported to ' + (res.filePath || format), 'success');
    };
    $('btn-export-json').addEventListener('click', () => runExport('json'));
    $('btn-export-csv').addEventListener('click', () => runExport('csv'));

    // Health
    $('btn-health').addEventListener('click', () => {
        navMode = 'health'; navParam = '';
        renderNav();
        healthData = null;
        showHealthPanel();
    });

    // Import source
    $('btn-import-source').addEventListener('click', openImportSourceModal);
    $('import-source-cancel').addEventListener('click', () => $('modal-import-source').classList.add('hidden'));
    $('import-source-backdrop').addEventListener('click', () => $('modal-import-source').classList.add('hidden'));

    // Batch import
    $('batch-mode').addEventListener('change', syncBatchPanels);
    $('batch-delim').addEventListener('change', () => {
        $('batch-delim-custom-wrap').classList.toggle('hidden', $('batch-delim').value !== 'custom');
    });
    $('batch-preview-btn').addEventListener('click', runBatchPreview);
    $('batch-close-btn').addEventListener('click', () => { $('modal-batch').classList.add('hidden'); });
    $('batch-backdrop').addEventListener('click', () => { $('modal-batch').classList.add('hidden'); });
    $('batch-import-btn').addEventListener('click', async () => {
        if (!batchParsedItems.length) return;
        const grabIp = $('batch-grab-ip').checked;
        try {
            const res = await api.credentialsImportBatch({ items: batchParsedItems, grabIp, pageUrl: ctxPageUrl });
            if (res.success) {
                toastCred(`Imported ${res.imported} items (${res.skipped} skipped)`, 'success');
                $('modal-batch').classList.add('hidden');
                batchParsedItems = [];
                await refreshAll();
            } else toastCred(res.error || 'Import failed', 'error');
        } catch (e) { toastCred(String(e?.message || e), 'error'); }
    });

    // Change master
    $('btn-change-master').addEventListener('click', () => {
        for (const id of ['cm-old','cm-new','cm-new2','cm-hint']) $(id).value = '';
        $('cm-err').textContent = '';
        $('modal-master').classList.remove('hidden');
    });
    $('cm-cancel').addEventListener('click', () => $('modal-master').classList.add('hidden'));
    $('master-backdrop').addEventListener('click', () => $('modal-master').classList.add('hidden'));
    $('cm-submit').addEventListener('click', async () => {
        const res = await api.credentialsChangeMaster({
            oldPassword: $('cm-old').value,
            newPassword: $('cm-new').value,
            confirm: $('cm-new2').value,
        });
        if (res.success) {
            const hint = $('cm-hint').value.trim();
            if (hint !== undefined) await api.credentialsVaultSetHint(hint);
            $('modal-master').classList.add('hidden');
            toastCred('Master password changed', 'success');
        } else $('cm-err').textContent = res.error || 'Failed';
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.closest('.auth-card') || e.target.closest('.batch-card') || e.target.closest('#modal-master') || e.target.closest('#modal-import-source')) return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); clearDetailForm(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentCredential(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('cred-search')?.focus(); }
        // Arrow key navigation in list
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const rows = $('cred-list')?.querySelectorAll('.cred-row');
            if (!rows?.length) return;
            if (document.activeElement?.closest('#cred-detail-form')) return;
            e.preventDefault();
            if (e.key === 'ArrowDown') kbListIdx = Math.min(kbListIdx + 1, rows.length - 1);
            else kbListIdx = Math.max(kbListIdx - 1, 0);
            rows.forEach((r, i) => r.classList.toggle('kb-focus', i === kbListIdx));
            rows[kbListIdx]?.scrollIntoView({ block: 'nearest' });
        }
        if (e.key === 'Enter' && kbListIdx >= 0) {
            const rows = $('cred-list')?.querySelectorAll('.cred-row');
            if (rows?.[kbListIdx]) {
                e.preventDefault();
                selectCredential(Number(rows[kbListIdx].dataset.id));
            }
        }
    });

    // Activity tracking for autolock
    for (const ev of ['mousedown','keydown','scroll','touchstart']) {
        document.addEventListener(ev, bumpActivity, { passive: true });
    }

    // IPC context
    if (api.onCredentialsInit) {
        api.onCredentialsInit((data) => {
            ctxPageUrl = data?.pageUrl || '';
            ctxDomain = data?.domain || '';
            bootstrap();
        });
    }
    if (api.onCredentialsContextUpdate) {
        api.onCredentialsContextUpdate((data) => {
            ctxPageUrl = data?.pageUrl || '';
            ctxDomain = data?.domain || '';
            if (!$('screen-vault')?.classList.contains('hidden')) {
                refreshDomainsAndNav();
                loadRows();
            }
        });
    }
    if (!api.onCredentialsInit) bootstrap();
    setAutolockSelectFromStorage();
});
