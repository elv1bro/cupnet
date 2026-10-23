'use strict';
/* CupNet mini UI. Served under a strict CSP (script-src 'self'): no inline scripts or handlers, and
 * user data never goes through innerHTML — every node is built with h(). */

// ─────────────────────────────────────────────────────────────────────────────
// Core helpers
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const ATTR_ONLY = new Set(['list', 'for', 'role', 'colspan', 'rowspan', 'viewBox']);
function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (ATTR_ONLY.has(k) || k.startsWith('aria-') || k.startsWith('data-')) n.setAttribute(k, v === true ? '' : String(v));
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(n, kids);
  return n;
}
function append(n, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(n, k);
    else n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}
const clear = (n) => { n.textContent = ''; return n; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(`cupnet-mini:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`cupnet-mini:${k}`, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

let TOKEN = '';
async function auth() {
  const hp = new URLSearchParams(location.hash.slice(1));
  try { TOKEN = sessionStorage.getItem('cupnet-token') || ''; } catch { /* storage blocked */ }
  if (hp.get('t')) TOKEN = hp.get('t');
  else if (hp.get('c')) {
    const r = await fetch('/api/auth/exchange', { method: 'POST', headers: { 'X-CupNet-Code': hp.get('c') } });
    if (r.ok) TOKEN = (await r.json()).token;
  }
  if (location.hash) history.replaceState(null, '', location.pathname);
  try { if (TOKEN) sessionStorage.setItem('cupnet-token', TOKEN); } catch { /* ignore */ }
  return !!TOKEN;
}
async function api(path, opts = {}) {
  const body = opts.body != null && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;
  const r = await fetch(path, { ...opts, body, headers: { 'X-CupNet-Token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.error) || r.statusText || `HTTP ${r.status}`);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const put = (path, body = {}) => api(path, { method: 'PUT', body });
const del = (path) => api(path, { method: 'DELETE' });
async function apiBlob(path) {
  const r = await fetch(path, { headers: { 'X-CupNet-Token': TOKEN } });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error || m; } catch { /* not JSON */ } throw new Error(m); }
  return { blob: await r.blob(), type: r.headers.get('X-CupNet-Content-Type') || '' };
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function copy(text, what = 'Скопировано') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = h('textarea', { value: text }); document.body.append(t); t.select();
    try { document.execCommand('copy'); } finally { t.remove(); }
  }
  toast(what, 'ok');
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message || String(e), 'err'); return undefined; } };
async function busy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; if (label) btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}
let _deb = new Map();
function debounce(key, ms, fn) { clearTimeout(_deb.get(key)); _deb.set(key, setTimeout(fn, ms)); }

const fmtSize = (n) => n == null || n === 0 ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtTime = (ts) => { if (!ts) return ''; const d = new Date(ts); return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
const fmtAgo = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  return s < 60 ? `${Math.max(s, 0)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ts).toLocaleDateString();
};
const splitUrl = (u) => { const m = /^[a-z]+:\/\/([^/?#]*)([^#]*)/i.exec(u || ''); return m ? [m[1], m[2] || '/'] : ['', u || '']; };
const flag = (cc) => { cc = String(cc || '').toUpperCase(); return /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : ''; };
const stCls = (s) => (!s ? 'sf' : s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : 's2');
const pairsOf = (obj) => {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) for (const one of (Array.isArray(v) ? v : [v])) out.push([k, String(one ?? '')]);
  return out;
};
const headerOf = (obj, name) => { const k = Object.keys(obj || {}).find((x) => x.toLowerCase() === name); const v = k ? obj[k] : ''; return String(Array.isArray(v) ? v[0] : v ?? ''); };
const originPath = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u || '').split(/[?#]/)[0]; } };
const tag = (text, cls = '') => h('span', { class: `tag ${cls}` }, text);
const badge = (text, cls = '') => h('span', { class: `badge ${cls}` }, text);
const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(([v, label]) =>
  h('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => onPick(v) }, label)));
const sw = (checked, label, onChange, title) => h('label', { class: 'switch', title },
  h('input', { type: 'checkbox', checked, onchange: (ev) => onChange(ev.target.checked) }), h('span'), label);

// Request headers that must not be copied into a new request (the client sets them).
const HOP = new Set(['host', 'content-length', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'proxy-authorization']);
const sendableHeaders = (obj) => pairsOf(obj).filter(([k]) => !k.startsWith(':') && !HOP.has(k.toLowerCase()));

// ─────────────────────────────────────────────────────────────────────────────
// Toasts + modal
// ─────────────────────────────────────────────────────────────────────────────
function toast(msg, kind = '', o = {}) {
  const t = h('div', { class: `toast ${kind}` }, msg);
  if (o.action) {
    t.append(' ', h('button', { class: 'btn sm', onclick: () => { t.remove(); o.action.fn(); } }, o.action.label));
  }
  $('toasts').append(t);
  setTimeout(() => t.remove(), o.ms || (kind === 'err' ? 7000 : 3500));
}
let _modalClose = null;
function modal(title, body, buttons = []) {
  const wrap = $('modalWrap'), m = clear($('modal'));
  const close = () => { wrap.hidden = true; clear(m); _modalClose = null; };
  m.append(h('h2', null, title), body);
  const row = h('div', { class: 'row-end' });
  for (const b of buttons) {
    const btn = h('button', { class: `btn ${b.cls || ''}`, type: 'button' }, b.label);
    btn.addEventListener('click', guard(async () => {
      if (!b.fn) return close();
      const keep = await busy(btn, null, () => b.fn(close));
      if (keep !== false) close();
    }));
    row.append(btn);
  }
  m.append(row);
  wrap.hidden = false; _modalClose = close;
  const first = m.querySelector('textarea, input, select'); if (first) first.focus();
  return { close, root: m };
}
$('modalWrap').addEventListener('mousedown', (ev) => { if (ev.target === $('modalWrap') && _modalClose) _modalClose(); });
function confirmBox(text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    modal('Подтверждение', h('p', null, text), [
      { label: 'Отмена', fn: () => fin(false) },
      { label: okLabel, cls: danger ? 'danger' : 'primary', fn: () => fin(true) },
    ]);
    const obs = new MutationObserver(() => { if ($('modalWrap').hidden) { obs.disconnect(); fin(false); } });
    obs.observe($('modalWrap'), { attributes: true, attributeFilter: ['hidden'] });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────
const TITLES = { traffic: 'Трафик', activity: 'Активность', search: 'Поиск', console: 'Консоль', ws: 'WebSockets', analyzer: 'Анализатор страницы', proxies: 'Прокси', ipwatch: 'Монитор IP', dns: 'Переопределения DNS', sitemap: 'Карта сайта', notes: 'Заметки', compare: 'Сравнение', mirror: 'Зеркало', cookies: 'Cookies', repeater: 'Репитер', intruder: 'Интрудер', rules: 'Правила', paused: 'Точки останова', sessions: 'Сессии', settings: 'Настройки', guide: 'Гайд' };
let PAGE = 'traffic';
function go(page) {
  if (!TITLES[page]) page = 'traffic';
  PAGE = page; store.set('page', page);
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  document.querySelectorAll('#pages > section').forEach((s) => { s.hidden = s.id !== `page-${page}`; });
  $('pageTitle').textContent = TITLES[page];
  if (typeof syncHelpBtn === 'function') syncHelpBtn(page);
  const load = { traffic: () => scheduleDraw(false), activity: () => loadActivity(), search: () => loadSearch(), console: () => loadConsole(), ws: () => loadWs(), analyzer: () => loadAnalyzer(), proxies: loadProxies, ipwatch: loadIpw, dns: loadDns, sitemap: loadSiteMap, notes: loadNotes, compare: loadCompare, mirror: loadMirror, cookies: loadCookies, rules: loadRules, paused: loadPaused, sessions: loadSessions, settings: loadSettings, guide: loadGuide, repeater: renderRpCode, intruder: loadIntruder }[page];
  if (load) guard(load)();
}
document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
$('launch').addEventListener('click', guard(async () => { await post('/api/chrome', {}); toast('Chrome запускается с прокси CupNet', 'ok'); }));
$('quit').addEventListener('click', guard(async () => {
  if (!(await confirmBox('Остановить CupNet mini? Сессия будет запечатана при выходе.', 'Выход', true))) return;
  await post('/api/quit'); $('stats').textContent = 'остановлено'; window.close();
}));
$('egress').addEventListener('click', () => go('proxies'));
$('helpBtn').addEventListener('click', () => { if (typeof showHelp === 'function') showHelp(PAGE); });
// HAR import → a new session (cross-compatible with old CupNet 2 and other tools' HAR exports).
$('harImportBtn').addEventListener('click', () => $('harImport').click());
$('harImport').addEventListener('change', guard(async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  await busy($('harImportBtn'), 'Импорт…', async () => {
    const r = await fetch('/api/sessions/import', { method: 'POST', headers: { 'X-CupNet-Token': TOKEN, 'Content-Type': 'application/octet-stream' }, body: file });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    toast(`Импортировано ${data.entries.toLocaleString()} запросов → сессия ${data.sessionId}`, 'ok',
      { ms: 6000, action: { label: 'Открыть', fn: guard(async () => { await fillSessionSelect(); openSession(data.sessionId); go('traffic'); }) } });
    if (PAGE === 'sessions') loadSessions();
  });
}));
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (_modalClose) { _modalClose(); return; }
  if (PAGE === 'traffic' && !$('detail').hidden) closeDetail();
});

// ─────────────────────────────────────────────────────────────────────────────
// Status, stats and the egress pill
// ─────────────────────────────────────────────────────────────────────────────
let ST = null;
const EG = { data: null, key: '', at: 0, pending: false };
const EGRESS_RECHECK_MS = 120000;
function egressKey(px) {
  if (!px) return '';
  return `${px.mode}|${px.active?.id || ''}|${px.active?.pinnedSid || ''}|${px.active?.updatedAt || ''}|${px.cliUpstream || ''}|${px.blocked}`;
}
async function checkEgress(force = false) {
  if (EG.pending) return;
  EG.pending = true; renderEgress();
  try {
    const r = await api(`/api/egress${force ? '?force=1' : ''}`);
    EG.data = r.egress; EG.at = Date.now();
    if (ST) ST.proxy = r.status;
  } catch (e) { EG.data = { ok: false, error: e.message }; EG.at = Date.now(); }
  finally { EG.pending = false; renderEgress(); if (PAGE === 'proxies') renderConn(); }
}
function connLabel(px) {
  if (!px) return '—';
  if (px.mode === 'proxy') return px.active?.name || 'Прокси';
  if (px.mode === 'cli') return 'CLI-апстрим';
  return 'Напрямую';
}
function geoText(e) {
  if (!e || !e.ok) return '';
  return [e.city, e.region && e.region !== e.city ? e.region : '', e.country].filter(Boolean).join(', ');
}
function renderEgress() {
  const px = ST?.proxy; const pill = $('egress'); const dot = pill.querySelector('.dot');
  const label = connLabel(px);
  let cls = '', text = label, title = 'Внешний IP — нажмите, чтобы управлять прокси';
  if (px?.blocked && px.mode === 'direct') { cls = 'err'; text = 'Заблокировано — kill switch включён, прокси нет'; }
  else if (EG.data?.ok) { cls = px?.mode === 'direct' ? 'warn' : 'ok'; text = `${label} · ${flag(EG.data.country)} ${EG.data.ip}`; title = `${EG.data.ip} · ${geoText(EG.data)}${EG.data.org ? ` · ${EG.data.org}` : ''}${ST?.ipWatch?.enabled ? `\nМонитор IP: ${ST.ipWatch.changes1h} изменений за последний час` : ''}\nНажмите, чтобы управлять прокси`; }
  else if (EG.pending || (ST?.ipWatch?.enabled && !EG.data)) { text = `${label} · проверка…`; }
  else if (EG.data && !EG.data.ok) { cls = 'err'; text = `${label} · ${EG.data.error || 'проверка не удалась'}`; }
  pill.className = `pill ${cls}`;
  dot.className = `dot ${EG.pending && !EG.data ? 'busy' : ''}`;
  $('egressText').textContent = text; pill.title = title;
}
let _lastPaused = 0;
/** Offer to install the CA once per app load if it isn't trusted yet (removes Chrome's flag banner). */
let _caOffered = false;
async function maybeOfferCaInstall() {
  if (_caOffered) return;
  _caOffered = true;
  const ca = await api('/api/ca/status').catch(() => null);
  if (!ca || ca.supported === false || ca.trusted) return;
  toast('Сертификат CupNet не установлен в систему — Chrome показывает предупреждение', 'warn',
    { ms: 12000, action: { label: 'Установить', fn: () => go('settings') } });
}
async function pollStatus() {
  try {
    const st = await api('/api/status');
    ST = st;
    if (st.version) { const sv = $('sideVer'); if (sv) sv.textContent = `v${st.version}`; }
    $('quit').hidden = !st.canQuit;
    const s = st.stats;
    const parts = [`прокси 127.0.0.1:${st.mitmPort}`];
    if (s) {
      parts.push(`${s.requests.toLocaleString()} запр.`);
      if (s.reqPerSec) parts.push(`${s.reqPerSec}/с`);
      if (s.avgMs) parts.push(`сред. ${Math.round(s.avgMs)} мс`);
      if (s.errors) parts.push(`${s.errors} ошиб.`);
      if (!s.workerReady) parts.push('TLS-воркер запускается…');
    }
    // Live traffic volume (sent + received) — aggregated by the Activity feed from the same stream.
    if (typeof ACT === 'object' && (ACT.bin || ACT.bout)) parts.push(`⇅ ${fmtSize(ACT.bin + ACT.bout)}`);
    if (st.writeErrors) parts.push(`${st.writeErrors} ошибок записи`);
    $('stats').textContent = parts.join(' · ');
    $('stats').className = `mono ${st.writeErrors || (s && !s.workerReady) ? 'warn' : 'muted'}`;
    const pc = $('pausedCount');
    pc.hidden = !st.paused; pc.textContent = st.paused || '';
    const dc = $('dnsCount');
    dc.hidden = !st.dns?.enabled; dc.textContent = st.dns?.enabled || '';
    if (st.paused > _lastPaused && PAGE !== 'paused') toast(`${st.paused} запрос(ов) остановлено точкой останова`, 'warn', { action: { label: 'Открыть', fn: () => go('paused') } });
    _lastPaused = st.paused;
    const key = egressKey(st.proxy);
    const w = st.ipWatch;
    if (w?.enabled) {
      // The IP monitor keeps the egress fresh; no separate probes from the UI.
      if (key !== EG.key) { EG.key = key; EG.data = null; EG.at = 0; }
      if (st.proxy?.egress && st.proxy.egressAt >= EG.at) { EG.data = st.proxy.egress; EG.at = st.proxy.egressAt; }
      if (w.consecutiveFailures && (w.lastCheckAt || 0) > (w.lastOkAt || 0) && !w.blocked) EG.data = { ok: false, error: w.lastError };
    } else if (key !== EG.key) { EG.key = key; EG.data = st.proxy?.egress || null; EG.at = EG.data ? Date.now() : 0; if (!EG.data) checkEgress(); }
    else if (Date.now() - EG.at > EGRESS_RECHECK_MS) checkEgress();
    onIpStatus(w || null);
    onCookieStatus(st.cookies);
    renderEgress();
    if (PAGE === 'proxies') { P.status = st.proxy; renderConn(); }
    if (PAGE === 'activity' && typeof renderActStats === 'function') renderActStats();
    maybeOfferCaInstall();
  } catch (e) {
    $('stats').textContent = `нет соединения: ${e.message}`; $('stats').className = 'mono err';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Traffic: data, filter, virtual grid
// ─────────────────────────────────────────────────────────────────────────────
const ROW = 26;
let current = '', shown = '';
let all = [], view = [], bySeq = new Map(), selSeq = null, gen = 0;
const methods = new Set(), types = new Set();
const qs = () => (shown ? `?session=${encodeURIComponent(shown)}` : '');

function parseQuery(q) {
  const f = { inc: [], exc: [], status: null, method: null, type: null, mime: null, host: null };
  for (const t of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = /^(status|method|type|mime|host):(.+)$/.exec(t);
    if (m) f[m[1]] = m[2];
    else if (t.startsWith('-') && t.length > 1) f.exc.push(t.slice(1));
    else f.inc.push(t);
  }
  return f;
}
const statusOk = (s, want) => {
  if (!want) return true;
  if (want === 'fail') return !s;
  if (/^\dxx$/.test(want)) return Math.floor((s || 0) / 100) === Number(want[0]);
  return String(s ?? '').startsWith(want);
};
let F = null;
function buildFilter() {
  F = parseQuery($('q').value);
  F.kind = $('fKind').value; F.m = $('fMethod').value; F.st = $('fStatus').value; F.t = $('fType').value;
  F.noOptions = $('hideOptions').checked;
}
function matches(e) {
  if (F.kind && e.kind !== F.kind) return false;
  if (e.kind === 'session-start' || e.kind === 'session-end') return F.kind === '';
  if (F.noOptions && e.method === 'OPTIONS') return false;
  if (F.m && e.method !== F.m) return false;
  if (!statusOk(e.status, F.st) || !statusOk(e.status, F.status)) return false;
  if (F.t && e.type !== F.t) return false;
  if (F.method && String(e.method || '').toLowerCase() !== F.method) return false;
  if (F.type && !String(e.type || '').toLowerCase().includes(F.type)) return false;
  if (F.mime && !String(e.mime || '').toLowerCase().includes(F.mime)) return false;
  const url = e._lc || (e._lc = String(e.url || e.note || '').toLowerCase());
  if (F.host && !splitUrl(url)[0].includes(F.host)) return false;
  for (const t of F.inc) if (!url.includes(t)) return false;
  for (const t of F.exc) if (url.includes(t)) return false;
  return true;
}
function addOption(sel, set, v) { if (!v || set.has(v)) return; set.add(v); sel.append(h('option', { value: v }, v)); }
function ingest(items) {
  const atBottom = isAtBottom();
  for (const e of items) {
    if (bySeq.has(e.seq)) continue;
    bySeq.set(e.seq, all.length);
    all.push(e);
    if (e.kind === 'request') { addOption($('fMethod'), methods, e.method); addOption($('fType'), types, e.type); }
    if (matches(e)) view.push(all.length - 1);
  }
  if (typeof consoleIngest === 'function') consoleIngest(items);
  if (typeof wsIngest === 'function') wsIngest(items);
  if (typeof activityIngest === 'function') activityIngest(items);
  scheduleDraw(atBottom && $('follow').checked);
}
function refilter() {
  buildFilter();
  view = [];
  for (let i = 0; i < all.length; i++) if (matches(all[i])) view.push(i);
  scheduleDraw($('follow').checked);
}
for (const id of ['q', 'fKind', 'fMethod', 'fStatus', 'fType', 'hideOptions']) $(id).addEventListener(id === 'q' ? 'input' : 'change', refilter);

const grid = $('grid'), spacer = $('spacer');
let drawQueued = false, stick = false;
/** A row to scroll into view once it is loaded (opened from Search or Compare). */
let revealSeq = null;
const pool = [];
function isAtBottom() { return grid.scrollTop + grid.clientHeight >= grid.scrollHeight - ROW * 2; }
function scheduleDraw(toBottom) { stick = stick || toBottom; if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }
const CELLS = ['n', 'tm', 'm', 'st', '', 'host', 'p', 'r-al', 'r-al tm'];
function rowNode(i) {
  let r = pool[i];
  if (!r) {
    r = h('div', { class: 'r cols' }, CELLS.map((c) => h('div', { class: c })));
    r.addEventListener('click', (ev) => {
      const seq = Number(r.dataset.seq);
      // Cmd/Ctrl-click a second row: compare it with the selected one.
      if ((ev.metaKey || ev.ctrlKey) && selSeq != null && selSeq !== seq) { const sid = shown || current; openCompare({ seq: selSeq, sid }, { seq, sid }); return; }
      select(seq);
    });
    pool[i] = r; spacer.append(r);
  }
  return r;
}
function draw() {
  drawQueued = false;
  $('count').textContent = `${view.length.toLocaleString()} / ${all.length.toLocaleString()}`;
  $('empty').hidden = all.length > 0;
  spacer.style.height = `${view.length * ROW}px`;
  if (stick) { grid.scrollTop = grid.scrollHeight; stick = false; }
  if (revealSeq != null) {
    const pos = bySeq.has(revealSeq) ? view.indexOf(bySeq.get(revealSeq)) : -1;
    if (pos >= 0) { grid.scrollTop = Math.max(0, pos * ROW - (grid.clientHeight - ROW) / 2); revealSeq = null; }
  }
  const first = Math.max(0, Math.floor(grid.scrollTop / ROW) - 10);
  const n = Math.max(0, Math.min(view.length - first, Math.ceil(grid.clientHeight / ROW) + 20));
  for (let k = 0; k < n; k++) {
    const e = all[view[first + k]];
    const r = rowNode(k);
    r.hidden = false;
    r.style.top = `${(first + k) * ROW}px`;
    if (r.dataset.seq !== String(e.seq)) {
      r.dataset.seq = e.seq;
      const [host, p] = splitUrl(e.url);
      const ev = e.kind !== 'request';
      const c = r.children;
      c[0].textContent = e.seq;
      c[1].textContent = fmtTime(e.ts);
      c[2].textContent = ev ? '' : (e.method || ''); c[2].className = `m m-${e.method || ''}`;
      c[3].textContent = ev ? (e.kind === 'page-event' ? 'event' : e.kind === 'ip' ? 'ip' : e.kind === 'console' ? 'console' : e.kind === 'ws' ? `ws ${e.dir === 'out' ? '↑' : e.dir === 'in' ? '↓' : '•'}` : '') : (e.status || 'ERR'); c[3].className = `st ${ev ? '' : stCls(e.status)}${e.kind === 'console' ? ` cn-${e.sev || 'info'}` : e.kind === 'ws' ? ` ws-st ws-${e.dir || 'sys'}` : ''}`;
      c[4].textContent = e.type || '';
      c[5].textContent = host; c[5].title = e.dns ? `${host} → ${e.dns.ip} (DNS override)` : host; c[5].classList.toggle('dns', !!e.dns);
      c[6].textContent = e.kind === 'console' || e.kind === 'ws' ? (e.note || '') : ev && !e.url ? (e.note || e.kind) : p; c[6].title = e.kind === 'console' ? `${e.note || ''}\n${e.url || ''}` : e.url || e.note || '';
      c[7].textContent = fmtSize(e.resSize);
      c[8].textContent = e.duration != null ? `${e.duration} ms` : '';
      r.className = `r cols${ev ? ' ev' : ''}${e.type === 'repeater' ? ' rep' : ''}${ev ? '' : !e.status ? ' tf' : e.status >= 500 ? ' t5' : e.status >= 400 ? ' t4' : ''}`;
    }
    r.classList.toggle('sel', e.seq === selSeq);
  }
  for (let k = n; k < pool.length; k++) if (pool[k]) { pool[k].hidden = true; pool[k].dataset.seq = ''; }
}
grid.addEventListener('scroll', () => scheduleDraw(false), { passive: true });
window.addEventListener('resize', () => scheduleDraw(false));
grid.addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  ev.preventDefault();
  if (!view.length) return;
  let pos = view.findIndex((i) => all[i].seq === selSeq);
  pos = pos < 0 ? 0 : Math.max(0, Math.min(view.length - 1, pos + (ev.key === 'ArrowDown' ? 1 : -1)));
  select(all[view[pos]].seq);
  const top = pos * ROW;
  if (top < grid.scrollTop) grid.scrollTop = top;
  else if (top + ROW > grid.scrollTop + grid.clientHeight) grid.scrollTop = top + ROW - grid.clientHeight;
});

// ── resizable split ──
(() => {
  const det = $('detail'), rz = $('resizer');
  const w = store.get('detailWidth', 0);
  if (w) det.style.width = `${w}px`;
  rz.addEventListener('mousedown', (ev) => {
    ev.preventDefault(); rz.classList.add('drag');
    const right = $('split').getBoundingClientRect().right;
    const move = (e) => { const nw = Math.max(360, Math.min(right - 320, right - e.clientX)); det.style.width = `${nw}px`; };
    const up = () => { rz.classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); store.set('detailWidth', det.offsetWidth); scheduleDraw(false); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
})();

// ── sessions: live stream or a saved one ──
function resetView() {
  gen++; all = []; view = []; bySeq = new Map(); selSeq = null; revealSeq = null; methods.clear(); types.clear();
  for (const s of [$('fMethod'), $('fType')]) while (s.options.length > 1) s.remove(1);
  closeDetail(); buildFilter(); scheduleDraw(true);
  if (typeof consoleReset === 'function') consoleReset();
  if (typeof wsReset === 'function') wsReset();
  if (typeof activityReset === 'function') activityReset();
}
async function streamLive(myGen) {
  let lastSeq = 0;
  while (myGen === gen) {
    try {
      const r = await fetch(`/api/log/stream?after=${lastSeq}`, { headers: { 'X-CupNet-Token': TOKEN } });
      if (!r.ok) throw new Error(r.statusText);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done || myGen !== gen) { if (myGen !== gen) reader.cancel(); break; }
        buf += dec.decode(value, { stream: true });
        const cut = buf.lastIndexOf('\n');
        if (cut < 0) continue;
        const lines = buf.slice(0, cut).split('\n'); buf = buf.slice(cut + 1);
        const items = [];
        for (const l of lines) if (l) { try { items.push(JSON.parse(l)); } catch { /* skip */ } }
        if (items.length) { lastSeq = items[items.length - 1].seq; ingest(items); }
      }
    } catch { /* reconnect below */ }
    if (myGen !== gen) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
}
async function loadSaved(id, myGen) {
  let after = 0;
  for (;;) {
    const items = await api(`/api/log?session=${encodeURIComponent(id)}&after=${after}&limit=20000`);
    if (myGen !== gen) return;
    if (!items.length) break;
    ingest(items); after = items[items.length - 1].seq;
  }
}
function openSession(id) {
  shown = id === current ? '' : id;
  $('session').value = id;
  resetView();
  const g = gen;
  if (shown) loadSaved(shown, g).catch((e) => toast(e.message, 'err'));
  else streamLive(g);
}
$('session').addEventListener('change', () => openSession($('session').value));
async function fillSessionSelect() {
  const { current: cur, sessions } = await api('/api/sessions');
  current = cur;
  const sel = $('session'); const keep = sel.value || cur;
  clear(sel);
  for (const s of sessions) sel.append(h('option', { value: s.id }, s.id === cur ? `● Эфир — ${s.id}` : `${s.id} · ${fmtSize(s.bytes) || '0 B'}`));
  sel.value = sessions.some((s) => s.id === keep) ? keep : cur;
  return sessions;
}

// ── HAR export of the filtered rows ──
function compressSeqs(seqs) {
  const out = []; let a = null, b = null;
  for (const n of seqs) {
    if (a == null) { a = b = n; continue; }
    if (n === b + 1) { b = n; continue; }
    out.push(a === b ? `${a}` : `${a}-${b}`); a = b = n;
  }
  if (a != null) out.push(a === b ? `${a}` : `${a}-${b}`);
  return out.join(',');
}
$('harBtn').addEventListener('click', guard(async () => {
  const sid = shown || current;
  const reqs = view.map((i) => all[i]).filter((e) => e.kind === 'request');
  const total = all.reduce((n, e) => n + (e.kind === 'request' ? 1 : 0), 0);
  if (!reqs.length) { toast('Нет запросов для экспорта', 'warn'); return; }
  let q = '';
  if (reqs.length !== total) {
    q = `?seqs=${compressSeqs(reqs.map((e) => e.seq).sort((x, y) => x - y))}`;
    if (q.length > 12000) { toast('Слишком много разрозненных строк для одного экспорта — сузьте фильтр или очистите его, чтобы экспортировать всю сессию', 'warn'); return; }
  }
  await busy($('harBtn'), 'HAR…', async () => {
    const { blob } = await apiBlob(`/api/sessions/${encodeURIComponent(sid)}/har${q}`);
    download(blob, `cupnet-${sid}${q ? '-filtered' : ''}.har`);
  });
  toast(`Экспортировано ${reqs.length.toLocaleString()} запросов в HAR`, 'ok');
}));

// ── Full session export: the raw JSONL (everything, not just requests) ──
$('jsonlBtn').addEventListener('click', guard(async () => {
  const sid = shown || current;
  await busy($('jsonlBtn'), 'Экспорт…', async () => {
    const { blob } = await apiBlob(`/api/sessions/${encodeURIComponent(sid)}`);
    download(blob, `cupnet-${sid}.jsonl`);
  });
  toast('Вся сессия экспортирована в JSONL', 'ok');
}));

// ─────────────────────────────────────────────────────────────────────────────
// Traffic: detail panel
// ─────────────────────────────────────────────────────────────────────────────
let dTab = store.get('dTab', 'headers'), dEntry = null;
function closeDetail() { $('detail').hidden = true; $('resizer').hidden = true; selSeq = null; dEntry = null; scheduleDraw(false); }
$('dclose').addEventListener('click', closeDetail);
document.querySelectorAll('#dtabs [data-d]').forEach((b) => b.addEventListener('click', () => { dTab = b.dataset.d; store.set('dTab', dTab); renderDetail(); }));
async function select(seq) {
  selSeq = seq; scheduleDraw(false);
  $('detail').hidden = false; $('resizer').hidden = false;
  const myGen = gen;
  try {
    const e = await api(`/api/log/${seq}${qs()}`);
    if (myGen !== gen || selSeq !== seq) return;
    dEntry = e; renderDetail();
  } catch (err) { clear($('dbody')).append(h('div', { class: 'note warn' }, err.message)); }
}
function kvGrid(pairs, empty = '(нет)') {
  const g = h('div', { class: 'kv' });
  if (!pairs.length) g.append(h('div', { class: 'k dim' }, empty), h('div'));
  for (const [k, v] of pairs) g.append(h('div', { class: 'k' }, k), h('div', null, v));
  return g;
}
const sect = (title, body, open = true, extra = null) => h('details', { class: 'sect', open }, h('summary', null, title, extra ? [' ', extra] : null), body);

function renderDetail() {
  document.querySelectorAll('#dtabs [data-d]').forEach((b) => b.classList.toggle('on', b.dataset.d === dTab));
  const d = clear($('dbody')); d.scrollTop = 0;
  const e = dEntry; if (!e) return;
  const isReq = e.kind === 'request';
  $('dMethod').textContent = isReq ? e.method : e.kind; $('dMethod').className = `badge m-${isReq ? e.method : ''}`;
  $('dStatus').textContent = isReq ? (e.status || 'ERR') : ''; $('dStatus').className = `badge ${stCls(e.status)}`; $('dStatus').hidden = !isReq;
  $('dUrl').textContent = e.url || e.note || ''; $('dUrl').title = e.url || e.note || '';
  document.querySelector('.dactions').hidden = !isReq;
  if (e.kind === 'console' && typeof renderConsoleDetail === 'function') { $('dMethod').textContent = e.type || 'console'; renderConsoleDetail(d, e); return; }
  if (e.kind === 'ws' && typeof renderWsDetail === 'function') { $('dMethod').textContent = `ws ${e.type}`; renderWsDetail(d, e); return; }
  if (!isReq) {
    d.append(sect('Событие', kvGrid([['Тип', e.kind], ['URL', e.url || ''], ['Время', new Date(e.ts).toISOString()]])), sect('Данные', jsonPre(JSON.stringify(e.data ?? e, null, 2))));
    return;
  }
  ({ headers: tabHeaders, request: tabRequest, response: tabResponse, cookies: tabCookies, raw: tabRaw, json: tabJson }[dTab] || tabHeaders)(d, e);
}
function tabHeaders(d, e) {
  d.append(sect('Общее', kvGrid([
    ['URL', e.url], ['Метод', e.method], ['Статус', String(e.status || 'ошибка')], ['Тип', e.type || ''],
    ['Длительность', e.duration != null ? `${e.duration} мс` : ''], ['Время', new Date(e.ts).toLocaleString()],
    ['Тело запроса', fmtSize(e.reqSize) || '—'], ['Тело ответа', fmtSize(e.resSize) || '—'],
    ...(e.dns ? [['Переопределение DNS', h('span', null, h('span', { class: 'mono' }, `${e.dns.host} → ${e.dns.ip}`), ' ', h('button', { class: 'btn sm', onclick: () => go('dns') }, 'Правила'))]] : []),
    ...(e.error ? [['Ошибка', String(e.error)]] : []),
    ...(e.status === 101 && e.type === 'websocket' && typeof wsReveal === 'function' ? [['WebSocket', h('button', { class: 'btn sm', onclick: () => wsReveal(e.seq) }, 'Открыть сообщения')]] : []),
  ])));
  const rs = pairsOf(e.responseHeaders), rq = pairsOf(e.requestHeaders);
  d.append(sect('Заголовки ответа', kvGrid(rs), true, tag(rs.length)), sect('Заголовки запроса', kvGrid(rq), true, tag(rq.length)));
}
function tabRequest(d, e) {
  let qp = [];
  try { qp = [...new URL(e.url).searchParams.entries()]; } catch { /* not a URL */ }
  if (qp.length) d.append(sect('Строка запроса', kvGrid(qp), true, tag(qp.length)));
  d.append(sect('Тело', bodyView(e, 'request', qs())));
}
function tabResponse(d, e) { d.append(bodyView(e, 'response', qs())); }
function parseSetCookie(line) {
  const parts = String(line).split(';').map((s) => s.trim()).filter(Boolean);
  const [nv, ...attrs] = parts;
  const i = (nv || '').indexOf('=');
  return { name: i < 0 ? nv : nv.slice(0, i), value: i < 0 ? '' : nv.slice(i + 1), attrs: attrs.join('; ') };
}
function tabCookies(d, e) {
  const reqCookies = [];
  for (const [k, v] of pairsOf(e.requestHeaders)) {
    if (k.toLowerCase() !== 'cookie') continue;
    for (const p of v.split(';').map((s) => s.trim()).filter(Boolean)) { const i = p.indexOf('='); reqCookies.push(i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]); }
  }
  const set = [];
  for (const [k, v] of pairsOf(e.responseHeaders)) if (k.toLowerCase() === 'set-cookie') for (const line of v.split('\n')) if (line.trim()) set.push(parseSetCookie(line));
  d.append(sect('Cookie запроса', kvGrid(reqCookies, 'Нет заголовка Cookie'), true, tag(reqCookies.length)));
  const tbl = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { class: 'w-180' }, 'Имя'), h('th', null, 'Значение'), h('th', null, 'Атрибуты'))),
    h('tbody', null, set.length ? set.map((c) => h('tr', null, h('td', { class: 'mono', title: c.name }, c.name), h('td', { class: 'mono', title: c.value }, c.value), h('td', { class: 'muted', title: c.attrs }, c.attrs)))
      : h('tr', null, h('td', { colspan: 3, class: 'muted' }, 'Нет заголовков Set-Cookie'))));
  d.append(sect('Установлены ответом', tbl, true, tag(set.length)));
}
function bodyText(body) {
  if (body == null || body === '') return '';
  const s = String(body);
  return s.startsWith('__b64__:') ? `[бинарное тело, ${fmtSize(Math.floor((s.length - 8) * 3 / 4))}]` : s;
}
function rawHttp(e, maxBody = 512 * 1024) {
  const [, path] = splitUrl(e.url);
  const cut = (s) => (s.length > maxBody ? `${s.slice(0, maxBody)}\n… [ещё ${fmtSize(s.length - maxBody)} — используйте «Скачать»]` : s);
  const hasHost = pairsOf(e.requestHeaders).some(([k]) => /^(host|:authority)$/i.test(k));
  const req = [`${e.method} ${path} HTTP/1.1`, ...(hasHost ? [] : [`Host: ${splitUrl(e.url)[0]}`]), ...pairsOf(e.requestHeaders).map(([k, v]) => `${k}: ${v}`)].join('\n');
  const res = [`HTTP/1.1 ${e.status || 0}`, ...pairsOf(e.responseHeaders).map(([k, v]) => `${k}: ${v}`)].join('\n');
  return `${req}\n\n${cut(bodyText(e.requestBody))}${e.requestBodyTruncated ? '\n… [обрезано]' : ''}\n\n${res}\n\n${cut(bodyText(e.responseBody))}${e.responseBodyTruncated ? '\n… [обрезано]' : ''}`;
}
function tabRaw(d, e) {
  const text = rawHttp(e);
  d.append(h('div', { class: 'bodybar' }, h('span', { class: 'muted' }, 'Запрос и ответ в виде текста HTTP/1.1'), h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onclick: () => copy(rawHttp(e, Infinity), 'Сырой HTTP скопирован') }, 'Копировать')), h('pre', { class: 'codebox' }, text));
}
function tabJson(d, e) {
  const text = JSON.stringify(e, null, 2);
  d.append(h('div', { class: 'bodybar' }, h('span', { class: 'muted' }, 'Полная запись лога'), h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onclick: () => copy(text, 'JSON скопирован') }, 'Копировать')), jsonPre(text));
}

// ── body viewer (traffic detail + repeater) ──
function jsonPre(text) {
  const pre = h('pre', { class: 'codebox' });
  if (text.length > 600000) { pre.textContent = text; return pre; }
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let last = 0, m;
  const frag = document.createDocumentFragment();
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const cls = m[1] ? (m[2] ? 'j-k' : 'j-s') : m[3] ? 'j-b' : m[0] === 'null' ? 'j-z' : 'j-n';
    frag.append(h('span', { class: cls }, m[1] || m[0]));
    if (m[2]) frag.append(m[2]);
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  pre.append(frag);
  return pre;
}
function markPre(text, q) {
  const pre = h('pre', { class: 'codebox' });
  const marks = [];
  if (!q) { pre.textContent = text; return { pre, marks }; }
  const lc = text.toLowerCase(), ql = q.toLowerCase();
  let pos = 0, i;
  const frag = document.createDocumentFragment();
  while ((i = lc.indexOf(ql, pos)) >= 0 && marks.length < 5000) {
    if (i > pos) frag.append(text.slice(pos, i));
    const mk = h('mark', null, text.slice(i, i + q.length)); marks.push(mk); frag.append(mk);
    pos = i + q.length;
  }
  frag.append(text.slice(pos));
  pre.append(frag);
  return { pre, marks };
}
/** One-shot text for "Find in body" when a body opens (set by Search before it shows a hit). */
let bodyFindSeed = null;
const extFor = (ct) => { const m = /\/([a-z0-9.+-]+)/.exec(ct || ''); if (!m) return '.bin'; const t = m[1].replace(/\+.*$/, ''); return '.' + ({ javascript: 'js', 'x-javascript': 'js', plain: 'txt', jpeg: 'jpg', 'octet-stream': 'bin', 'x-www-form-urlencoded': 'txt' }[t] || t); };
function bodyView(e, which, sessQs) {
  const box = h('div');
  const body = which === 'request' ? e.requestBody : e.responseBody;
  const hdrs = which === 'request' ? e.requestHeaders : e.responseHeaders;
  const ct = headerOf(hdrs, 'content-type').toLowerCase();
  const size = which === 'request' ? e.reqSize : e.resSize;
  const bodyUrl = `/api/log/${e.seq}/body/${which}${sessQs}`;
  const bar = h('div', { class: 'bodybar' }, tag(ct.split(';')[0] || 'без content-type'), h('span', { class: 'muted' }, fmtSize(size) || '0 B'));
  box.append(bar);
  if (body == null || body === '') { box.append(h('div', { class: 'empty' }, 'Нет тела')); return box; }
  const dl = h('button', { class: 'btn sm', onclick: guard(async () => { const { blob } = await apiBlob(bodyUrl); download(blob, `cupnet-${e.seq}-${which}${extFor(ct)}`); }) }, 'Скачать');
  const isB64 = String(body).startsWith('__b64__:');
  if (isB64 && /^(image|video|audio)\//.test(ct)) {
    bar.append(h('span', { class: 'spacer' }), dl);
    const pv = h('div', { class: 'preview' }, 'загрузка…'); box.append(pv);
    apiBlob(bodyUrl).then(({ blob }) => {
      const url = URL.createObjectURL(new Blob([blob], { type: ct.split(';')[0] }));
      const t = ct.startsWith('image/') ? 'img' : ct.startsWith('video/') ? 'video' : 'audio';
      clear(pv).append(h(t, { src: url, controls: t !== 'img' }));
    }).catch((err) => { pv.textContent = err.message; });
    return box;
  }
  if (isB64) { bar.append(h('span', { class: 'spacer' }), dl); box.append(h('div', { class: 'note' }, 'Бинарное тело. Используйте «Скачать», чтобы получить байты.')); return box; }

  let text = String(body);
  let truncated = which === 'request' ? e.requestBodyTruncated : e.responseBodyTruncated;
  const isJson = /json/.test(ct) || /^\s*[[{]/.test(text.slice(0, 64));
  const isForm = /x-www-form-urlencoded/.test(ct);
  const modes = isJson ? [['pretty', 'Красиво'], ['raw', 'Сырой']] : isForm ? [['form', 'Форма'], ['raw', 'Сырой']] : [];
  let mode = modes.length ? modes[0][0] : 'raw';
  let q = '', marks = [], cur = -1;
  if (bodyFindSeed && bodyFindSeed.seq === e.seq && bodyFindSeed.which === which) { q = bodyFindSeed.q; bodyFindSeed = null; }
  const segBox = h('span');
  const find = h('input', { type: 'search', placeholder: 'Поиск в теле…', value: q });
  const cnt = h('span', { class: 'muted mono' });
  const content = h('div');
  const copyBtn = h('button', { class: 'btn sm', onclick: () => copy(text, 'Тело скопировано') }, 'Копировать');
  bar.append(segBox, find, cnt, h('span', { class: 'spacer' }), copyBtn, dl);
  const renderSeg = () => { clear(segBox); if (modes.length) segBox.append(seg(modes, mode, (v) => { mode = v; renderSeg(); paint(); })); };
  const paint = () => {
    clear(content); marks = []; cur = -1;
    if (truncated) {
      content.append(h('div', { class: 'note warn' }, `Показаны первые ${fmtSize(text.length)}. `,
        h('button', { class: 'btn sm', onclick: guard(async (ev) => { await busy(ev.target, 'Загрузка…', async () => { text = await (await apiBlob(bodyUrl)).blob.text(); truncated = false; }); paint(); }) }, 'Загрузить всё тело')));
    }
    if (mode === 'form' && !q) {
      content.append(kvGrid([...new URLSearchParams(text).entries()]));
    } else if (mode === 'pretty') {
      let out = text;
      if (text.length < 20 * 1048576) { try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ } }
      if (q) { const r = markPre(out, q); marks = r.marks; content.append(r.pre); } else content.append(jsonPre(out));
    } else {
      const r = markPre(text, q); marks = r.marks; content.append(r.pre);
    }
    cnt.textContent = q ? `${marks.length >= 5000 ? '5000+' : marks.length} найдено` : '';
    if (marks.length) step(0);
  };
  const step = (dir) => {
    if (!marks.length) return;
    if (cur >= 0) marks[cur].classList.remove('cur');
    cur = dir === 0 ? 0 : (cur + dir + marks.length) % marks.length;
    marks[cur].classList.add('cur'); marks[cur].scrollIntoView({ block: 'center' });
    cnt.textContent = `${cur + 1} / ${marks.length >= 5000 ? '5000+' : marks.length}`;
  };
  find.addEventListener('input', () => debounce('find', 200, () => { q = find.value; paint(); }));
  find.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); step(ev.shiftKey ? -1 : 1); } });
  renderSeg(); paint();
  box.append(content);
  return box;
}

// ── detail actions ──
async function fullBodyText(e, which) {
  const body = which === 'request' ? e.requestBody : e.responseBody;
  if (body == null) return '';
  const truncated = which === 'request' ? e.requestBodyTruncated : e.responseBodyTruncated;
  if (!truncated) return String(body);
  return (await apiBlob(`/api/log/${e.seq}/body/${which}${qs()}`)).blob.text();
}
const isB64Body = (b) => String(b ?? '').startsWith('__b64__:');
$('aCopyUrl').addEventListener('click', () => dEntry && copy(dEntry.url, 'URL скопирован'));
$('aCopyCurl').addEventListener('click', guard(async () => {
  const e = dEntry; if (!e) return;
  if (!window.CupNetCodegen) throw new Error('Генератор кода не загрузился');
  const body = isB64Body(e.requestBody) ? '' : await fullBodyText(e, 'request');
  const code = window.CupNetCodegen.generateRequestCode('curl', { method: e.method, url: e.url, headers: Object.fromEntries(sendableHeaders(e.requestHeaders)), body });
  copy(code, isB64Body(e.requestBody) ? 'curl скопирован (бинарное тело пропущено)' : 'curl скопирован');
}));
$('aRepeat').addEventListener('click', guard(async () => {
  const e = dEntry; if (!e) return;
  rpLoad({ method: e.method, url: e.url, headers: sendableHeaders(e.requestHeaders), body: isB64Body(e.requestBody) ? '' : await fullBodyText(e, 'request') });
  go('repeater');
}));
$('aIntrude').addEventListener('click', guard(async () => {
  const e = dEntry; if (!e) return;
  openInIntruder({ method: e.method, url: e.url, headers: sendableHeaders(e.requestHeaders), body: isB64Body(e.requestBody) ? '' : await fullBodyText(e, 'request') });
}));
$('aResend').addEventListener('click', guard(async () => {
  const e = dEntry; if (!e) return;
  if (isB64Body(e.requestBody)) throw new Error('Бинарные тела запросов пока нельзя переотправить');
  const r = await busy($('aResend'), 'Отправка…', async () => post('/api/replay', { method: e.method, url: e.url, headers: sendableHeaders(e.requestHeaders), body: await fullBodyText(e, 'request') }));
  if (r.error) toast(`Переотправка не удалась: ${r.error}`, 'err');
  else toast(`Переотправлено → ${r.status} за ${r.duration} мс (#${r.seq})`, r.status >= 400 ? 'warn' : 'ok', shown ? {} : { action: { label: 'Показать', fn: () => select(r.seq) } });
}));
$('aMock').addEventListener('click', guard(async () => {
  const e = dEntry; if (!e) return;
  if (isB64Body(e.responseBody)) throw new Error('Из лога можно сделать заглушку только для текстовых ответов');
  const body = await fullBodyText(e, 'response');
  const [, path] = splitUrl(originPath(e.url));
  const rule = {
    name: `Заглушка ${e.method} ${path}`.slice(0, 120), type: 'mock', url_pattern: originPath(e.url), method: e.method, enabled: true,
    params: { status: e.status || 200, mimeType: headerOf(e.responseHeaders, 'content-type') || 'text/plain', body },
  };
  const { id } = await post('/api/rules', rule);
  toast('Правило-заглушка создано и включено', 'ok');
  R.sel = id; R.ed = null; go('rules');
}));
$('aBreak').addEventListener('click', guard(async () => {
  const e = dEntry; if (!e) return;
  const [, path] = splitUrl(originPath(e.url));
  const { id } = await post('/api/rules', { name: `Пауза ${e.method} ${path}`.slice(0, 120), type: 'modifyHeaders', url_pattern: originPath(e.url), method: e.method, params: {}, breakpoint_enabled: true, enabled: true });
  toast(`Следующий ${e.method} к этому URL остановится в «Точках останова»`, 'ok', { action: { label: 'Изменить правило', fn: () => { R.sel = id; R.ed = null; go('rules'); } } });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Proxies
// ─────────────────────────────────────────────────────────────────────────────
const P = { providers: [], byId: new Map(), profiles: [], status: null, testing: new Set(), sel: null, ed: null, edInit: '', result: null, preview: null };
async function loadProxies() {
  if (!P.providers.length) { P.providers = await api('/api/proxies/providers'); P.byId = new Map(P.providers.map((p) => [p.id, p])); }
  applyListing(await api('/api/proxies'));
}
function applyListing(r) {
  if (!r || !r.profiles) return;
  P.profiles = r.profiles; P.status = r.status;
  if (ST) ST.proxy = r.status;
  const key = egressKey(r.status);
  if (key !== EG.key) { EG.key = key; EG.data = r.status.egress || null; EG.at = EG.data ? Date.now() : 0; if (!EG.data) checkEgress(); }
  renderEgress(); renderConn(); renderPFilters(); renderPList();
  if (P.sel && P.sel !== 'new' && !P.profiles.some((p) => p.id === P.sel)) { P.sel = null; P.ed = null; }
  if (!P.ed) renderPEditor();
}
function renderConn() {
  const px = P.status; if (!px) return;
  const conn = $('conn');
  conn.classList.toggle('blocked', !!(px.blocked && px.mode === 'direct'));
  const nameBox = clear($('connName'));
  nameBox.append(h('i', { class: `dot ${px.mode === 'direct' ? (px.blocked ? 'err' : 'warn') : 'ok'}` }), connLabel(px));
  if (px.active?.sticky) nameBox.append(tag('sticky', 'accent'));
  $('connSub').textContent = px.mode === 'proxy' ? px.active.display : px.mode === 'cli' ? `${px.cliUpstream} (--upstream)` : (px.blocked ? px.blockReason : 'Без прокси — сайты видят IP этой машины');
  $('connSub').title = $('connSub').textContent;
  const eg = EG.data;
  if (px.blocked && px.mode === 'direct') { $('connIp').textContent = 'Заблокировано'; $('connGeo').textContent = 'Kill switch включён'; }
  else if (EG.pending && !eg) { $('connIp').textContent = 'проверка…'; $('connGeo').textContent = ''; }
  else if (eg?.ok) { $('connIp').textContent = `${flag(eg.country)} ${eg.ip}`; $('connGeo').textContent = [geoText(eg), eg.org, eg.latencyMs ? `${eg.latencyMs} ms` : ''].filter(Boolean).join(' · '); }
  else { $('connIp').textContent = '—'; $('connGeo').textContent = eg?.error || ''; }
  $('pNewIp').disabled = !(px.mode === 'proxy' && px.active?.sticky);
  $('pNewIp').title = $('pNewIp').disabled ? 'Только для sticky-сессий ({SID} / режим sticky) — ротационные прокси меняют IP при каждом соединении' : 'Новая sticky-сессия → новый внешний IP';
  $('pDisconnect').disabled = px.mode === 'direct';
  $('pKill').checked = !!px.killSwitch;
}
$('pCheck').addEventListener('click', () => checkEgress(true));
$('pNewIp').addEventListener('click', guard(async () => { applyListing(await post('/api/proxies/new-ip')); toast('Новая сессия — проверяю внешний IP…', 'ok'); checkEgress(true); }));
$('pDisconnect').addEventListener('click', guard(async () => { applyListing(await post('/api/proxies/disconnect')); toast(P.status.killSwitch ? 'Отключено — kill switch блокирует трафик' : 'Отключено — трафик идёт напрямую', 'warn'); }));
$('pKill').addEventListener('change', guard(async (ev) => { applyListing(await post('/api/proxies/kill-switch', { enabled: ev.target.checked })); toast(ev.target.checked ? 'Kill switch включён: прямых соединений нет' : 'Kill switch выключен', ev.target.checked ? 'ok' : 'warn'); }));

const pCountry = (p) => (p.country || p.lastTest?.country || '').toLowerCase();
const pStatus = (p) => (P.testing.has(p.id) ? 'testing' : !p.lastTest ? 'untested' : p.lastTest.ok ? 'ok' : 'fail');
function fillSelect(sel, values, allLabel) {
  const keep = sel.value;
  append(clear(sel), [h('option', { value: '' }, allLabel), values.map(([v, l]) => h('option', { value: v }, l))]);
  sel.value = values.some(([v]) => v === keep) ? keep : '';
}
function renderPFilters() {
  const provs = new Map(), countries = new Map(), groups = new Set();
  for (const p of P.profiles) {
    provs.set(p.provider, p.providerName);
    const cc = pCountry(p); if (cc) countries.set(cc, p.countryName || cc.toUpperCase());
    if (p.group) groups.add(p.group);
  }
  fillSelect($('pfProvider'), [...provs].sort((a, b) => a[1].localeCompare(b[1])), 'Все провайдеры');
  fillSelect($('pfCountry'), [...countries].sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => [c, `${flag(c)} ${n}`]), 'Все страны');
  fillSelect($('pfGroup'), [...groups].sort().map((g) => [g, g]), 'Все группы');
}
function pFiltered() {
  const q = $('pq').value.trim().toLowerCase(), prov = $('pfProvider').value, cc = $('pfCountry').value, st = $('pfStatus').value, grp = $('pfGroup').value;
  return P.profiles.filter((p) => {
    if (prov && p.provider !== prov) return false;
    if (cc && pCountry(p) !== cc) return false;
    if (grp && p.group !== grp) return false;
    if (st && pStatus(p) !== st) return false;
    if (q) {
      const hay = `${p.name} ${p.host}:${p.port} ${p.group} ${p.providerName} ${p.countryName} ${p.notes} ${p.lastTest?.ip || ''} ${p.lastTest?.org || ''}`.toLowerCase();
      if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}
for (const id of ['pq', 'pfProvider', 'pfCountry', 'pfStatus', 'pfGroup']) $(id).addEventListener(id === 'pq' ? 'input' : 'change', () => renderPList());
const PLIST_MAX = 1000;
function renderPList() {
  const list = pFiltered();
  const box = clear($('plist'));
  $('pCount').textContent = list.length === P.profiles.length ? `${P.profiles.length} прокси` : `${list.length} из ${P.profiles.length}`;
  const px = P.status;
  if (!$('pq').value && !$('pfProvider').value && !$('pfCountry').value && !$('pfStatus').value && !$('pfGroup').value) {
    const isDirect = px?.mode === 'direct';
    box.append(h('div', { class: `prow direct${isDirect ? ' sel' : ''}` },
      h('i', { class: `dot ${isDirect ? (px.blocked ? 'err' : 'warn') : ''}` }),
      h('div', null, h('div', { class: 'title' }, h('b', null, 'Напрямую'), isDirect ? tag(px.blocked ? 'заблокировано' : 'активно', px.blocked ? 'err' : 'warn') : null),
        h('div', { class: 'meta' }, h('span', null, px?.killSwitch ? 'Заблокировано, пока включён kill switch' : 'Без прокси — ваш собственный IP'))),
      h('div', { class: 'acts' }, isDirect ? null : h('button', { class: 'btn sm', onclick: guard(async (ev) => { ev.stopPropagation(); applyListing(await post('/api/proxies/disconnect')); }) }, 'Использовать'))));
  }
  if (!P.profiles.length) {
    box.append(h('div', { class: 'empty' }, h('p', null, 'Пока нет прокси.'), h('p', { class: 'muted' }, 'Добавьте аккаунт провайдера (Decodo, Oxylabs, IPRoyal, NodeMaven), вставьте URL прокси или импортируйте список.'),
      h('button', { class: 'btn primary', onclick: () => openPEditor('new') }, '+ Добавить прокси'), ' ', h('button', { class: 'btn', onclick: openImport }, 'Импорт списка')));
    return;
  }
  if (!list.length) { box.append(h('div', { class: 'empty' }, 'Ничего не подходит под фильтр.')); return; }
  for (const p of list.slice(0, PLIST_MAX)) box.append(pRow(p));
  if (list.length > PLIST_MAX) box.append(h('div', { class: 'empty' }, `Показаны первые ${PLIST_MAX} — уточните фильтр.`));
}
function pRow(p) {
  const st = pStatus(p), t = p.lastTest;
  const port = String(p.port || '').replace(/\{RAND:(\d+)-(\d+)\}/i, '$1–$2');
  const meta = [h('span', { class: 'mono' }, p.host ? `${p.scheme}://${p.host}${port ? `:${port}` : ''}` : '')];
  const cc = pCountry(p);
  if (cc && cc !== 'random') meta.push(h('span', null, `${flag(cc)} ${p.countryName || cc.toUpperCase()}`));
  if (st === 'testing') meta.push(h('span', { class: 'muted' }, 'проверка…'));
  else if (t?.ok) meta.push(h('span', { class: 'mono ok' }, t.ip), h('span', null, `${t.latencyMs} мс`), h('span', { class: 'faint' }, fmtAgo(t.at)));
  else if (t) meta.push(h('span', { class: 'err', title: t.error }, t.error || 'ошибка'));
  const row = h('div', { class: `prow${P.sel === p.id ? ' sel' : ''}`, onclick: () => openPEditor(p.id) },
    h('i', { class: `dot ${st === 'testing' ? 'busy' : st === 'ok' ? 'ok' : st === 'fail' ? 'err' : ''}`, title: ({ testing: 'проверка', ok: 'работает', fail: 'ошибка', untested: 'не проверен' }[st] || st) }),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'title' }, h('b', { title: p.name }, p.name), p.active ? tag('подключён', 'ok') : null, tag(p.providerName, p.kind === 'provider' ? 'accent' : ''),
        p.sticky ? tag('sticky') : null, p.group ? tag(p.group) : null),
      h('div', { class: 'meta' }, meta)),
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm', disabled: st === 'testing', title: 'Проверить IP, гео и задержку через этот прокси', onclick: (ev) => { ev.stopPropagation(); testProxies([p.id]); } }, 'Тест'),
      p.active ? h('button', { class: 'btn sm', disabled: true }, 'Подключён')
        : h('button', { class: 'btn sm primary', onclick: guard(async (ev) => { ev.stopPropagation(); await connectProxy(p.id); }) }, 'Подключить')));
  return row;
}
async function connectProxy(id) {
  applyListing(await post(`/api/proxies/${id}/connect`));
  toast(`Подключено: ${P.status.active?.name || 'прокси'} — новые запросы идут через него`, 'ok');
  checkEgress(true);
}
/** Tests run TEST_PARALLEL at a time from here so each row updates as soon as its own check finishes. */
const TEST_PARALLEL = 6;
async function testProxies(ids) {
  for (const id of ids) P.testing.add(id);
  renderPList();
  const results = [];
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        const r = await post(`/api/proxies/${id}/test`);
        results.push(r.result);
        P.testing.delete(id);
        applyListing(r);
        if (P.sel === id) { P.result = r.result; renderPResult(); }
      } catch (e) {
        results.push({ ok: false, error: e.message });
        P.testing.delete(id); renderPList();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TEST_PARALLEL, ids.length) }, worker));
  if (ids.length === 1) {
    const t = results[0];
    toast(t.ok ? `Работает: ${flag(t.country)} ${t.ip} · ${t.latencyMs} мс` : `Ошибка: ${t.error}`, t.ok ? 'ok' : 'err');
  } else {
    const ok = results.filter((x) => x.ok).length;
    toast(`Проверено ${results.length}: ${ok} работают, ${results.length - ok} с ошибкой`, ok === results.length ? 'ok' : 'warn');
  }
}
$('pAdd').addEventListener('click', () => openPEditor('new'));
$('pTestAll').addEventListener('click', guard(async () => {
  const ids = pFiltered().map((p) => p.id);
  if (!ids.length) { toast('Нет прокси для проверки', 'warn'); return; }
  await busy($('pTestAll'), `Проверка ${ids.length}…`, () => testProxies(ids));
}));

// ── proxy editor ──
function providerDefaults(meta) {
  const o = {};
  for (const f of meta?.optionFields || []) if (f.default !== undefined) o[f.key] = f.default;
  return o;
}
function edFromProfile(p) {
  const first = P.providers[0];
  if (!p) {
    return { id: null, kind: 'provider', provider: first?.id || '', name: '', group: '', notes: '', username: '', password: '', hasPassword: false,
      country: first?.countries[0]?.code || '', sessionMode: first?.session?.sticky ? 'sticky' : 'rotating', durationMin: first?.duration?.default || null,
      options: providerDefaults(first), template: '', vars: {} };
  }
  const meta = P.byId.get(p.provider);
  return { id: p.id, kind: p.kind, provider: p.kind === 'provider' ? p.provider : (first?.id || ''), name: p.name, group: p.group, notes: p.notes,
    username: p.username, password: '', hasPassword: p.hasPassword, country: p.kind === 'provider' ? p.country : (first?.countries[0]?.code || ''),
    sessionMode: p.kind === 'provider' ? p.sessionMode : 'rotating', durationMin: p.durationMin ?? meta?.duration?.default ?? null,
    options: { ...providerDefaults(meta), ...(p.options || {}) }, template: p.template || '', vars: { ...(p.vars || {}) } };
}
const edPayload = (ed) => ({ kind: ed.kind, provider: ed.provider, name: ed.name, group: ed.group, notes: ed.notes, username: ed.username, password: ed.password,
  country: ed.country, sessionMode: ed.sessionMode, durationMin: ed.durationMin, options: ed.options, template: ed.template, vars: ed.vars });
const edDirty = () => P.ed && JSON.stringify(edPayload(P.ed)) !== P.edInit;
async function openPEditor(id) {
  if (edDirty() && P.sel !== id && !(await confirmBox('Отменить несохранённые изменения этого прокси?', 'Отменить', true))) return;
  P.sel = id;
  P.ed = edFromProfile(id === 'new' ? null : P.profiles.find((p) => p.id === id));
  P.edInit = JSON.stringify(edPayload(P.ed));
  P.result = id === 'new' ? null : P.profiles.find((p) => p.id === id)?.lastTest || null;
  renderPList(); renderPEditor();
}
const tplVars = (t) => [...new Set([...String(t || '').matchAll(/\{([A-Z_][A-Z0-9_]*)\}/gi)].map((m) => m[1].toUpperCase()))].filter((v) => v !== 'PASSWORD' && v !== 'SID');
function field(label, control, hint, top = false) {
  const out = [h('label', { class: top ? 'top' : '' }, label), control];
  if (hint) out.push(h('div', { class: 'hint' }, hint));
  return out;
}
function renderPEditor() {
  const box = clear($('pEditor'));
  const ed = P.ed;
  if (!P.sel || !ed) {
    box.append(h('div', { class: 'empty' },
      h('p', null, h('b', null, 'Выберите прокси для изменения или добавьте новый.')),
      h('p', { class: 'muted' }, 'Прокси применяются ко всему трафику проксируемого Chrome. Пароли хранятся в зашифрованном виде в каталоге данных и больше не показываются.'),
      h('button', { class: 'btn primary', onclick: () => openPEditor('new') }, '+ Добавить прокси'), ' ',
      h('button', { class: 'btn', onclick: openImport }, 'Импорт списка')));
    return;
  }
  const prof = ed.id ? P.profiles.find((p) => p.id === ed.id) : null;
  const meta = P.byId.get(ed.provider);
  const changed = () => { schedulePreview(); markDirty(); };
  const rerender = () => { renderPEditor(); schedulePreview(); };

  box.append(h('div', { class: 'edit-head' }, h('h2', { class: 'ell' }, ed.id ? (prof?.name || 'Прокси') : 'Новый прокси'),
    prof?.active ? tag('подключён', 'ok') : null,
    ed.id ? h('button', { class: 'btn sm', onclick: guard(async () => { const r = await post(`/api/proxies/${ed.id}/duplicate`); P.ed = null; applyListing(r); openPEditor(r.profile.id); toast('Дублировано', 'ok'); }) }, 'Дублировать') : null,
    ed.id ? h('button', { class: 'btn sm danger', onclick: guard(async () => {
      if (!(await confirmBox(`Удалить прокси «${prof?.name}»?${prof?.active ? ' Он подключён — трафик пойдёт напрямую.' : ''}`, 'Удалить', true))) return;
      const r = await del(`/api/proxies/${ed.id}`); P.sel = null; P.ed = null; applyListing(r); toast('Удалено', 'ok');
    }) }, 'Удалить') : null));

  const form = h('div', { class: 'form' });
  form.append(...field('Тип', seg([['provider', 'Аккаунт провайдера'], ['custom', 'URL прокси']], ed.kind, (v) => { ed.kind = v; rerender(); markDirty(); })));

  if (ed.kind === 'provider') {
    const provSel = h('select', { onchange: (ev) => {
      ed.provider = ev.target.value; const m = P.byId.get(ed.provider);
      ed.country = m?.countries[0]?.code || ''; ed.options = providerDefaults(m); ed.durationMin = m?.duration?.default || null;
      if (m && !m.session?.[ed.sessionMode]) ed.sessionMode = m.session?.rotating ? 'rotating' : 'sticky';
      rerender(); markDirty();
    } }, P.providers.map((p) => h('option', { value: p.id, selected: p.id === ed.provider }, `${p.name} · ${p.type}`)));
    form.append(...field('Провайдер', provSel));
    form.append(...field('Имя пользователя', h('input', { value: ed.username, placeholder: 'Имя пользователя аккаунта (без префиксов user- / страны)', spellcheck: false, autocomplete: 'off', oninput: (ev) => { ed.username = ev.target.value; changed(); } })));
    form.append(...field('Пароль', h('input', { type: 'password', value: ed.password, autocomplete: 'new-password', placeholder: ed.hasPassword ? '•••••• сохранён — введите, чтобы заменить' : 'Пароль аккаунта', oninput: (ev) => { ed.password = ev.target.value; changed(); } })));
    const regions = new Map();
    for (const c of meta?.countries || []) { const r = c.region || 'Прочее'; if (!regions.has(r)) regions.set(r, []); regions.get(r).push(c); }
    const cSel = h('select', { onchange: (ev) => { ed.country = ev.target.value; changed(); } },
      [...regions].map(([r, cs]) => h('optgroup', { label: r }, cs.map((c) => h('option', { value: c.code, selected: c.code === ed.country }, `${flag(c.code)} ${c.name}`)))));
    form.append(...field('Страна', cSel));
    const modes = [];
    if (meta?.session?.rotating !== false) modes.push(['rotating', 'Ротационный']);
    if (meta?.session?.sticky) modes.push(['sticky', 'Sticky']);
    const sessHint = ed.sessionMode === 'sticky' ? 'Один внешний IP на время сессии; «Новый IP» начинает новую сессию.' : 'Новый внешний IP при каждом соединении.';
    form.append(...field('Сессия', seg(modes, ed.sessionMode, (v) => { ed.sessionMode = v; rerender(); markDirty(); }), sessHint));
    if (ed.sessionMode === 'sticky' && meta?.duration?.supported) {
      const d = meta.duration;
      form.append(...field('Длина сессии', h('div', { class: 'inline' },
        h('input', { type: 'number', min: d.min, max: d.max, value: ed.durationMin ?? d.default, oninput: (ev) => { ed.durationMin = Number(ev.target.value) || d.default; changed(); } }),
        h('span', { class: 'muted' }, `${d.unit || 'мин'} (${d.min}–${d.max})`))));
    }
    for (const f of meta?.optionFields || []) {
      const val = ed.options[f.key];
      let ctl;
      if (f.type === 'select') ctl = h('select', { onchange: (ev) => { ed.options[f.key] = ev.target.value; changed(); } }, (f.choices || []).map((c) => h('option', { value: c.value, selected: String(c.value) === String(val ?? '') }, c.label)));
      else if (f.type === 'checkbox') ctl = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!val, onchange: (ev) => { ed.options[f.key] = ev.target.checked; changed(); } }), f.hint || '');
      else ctl = h('input', { value: val ?? '', placeholder: f.placeholder || (f.optional ? 'optional' : ''), oninput: (ev) => { ed.options[f.key] = ev.target.value; changed(); } });
      form.append(...field(f.label || f.key, ctl, f.type === 'checkbox' ? null : f.hint));
    }
  } else {
    form.append(...field('Proxy URL', h('input', { class: 'mono', value: ed.template, spellcheck: false, autocomplete: 'off', placeholder: 'socks5://user:pass@host:1080 · http://host:8080 · host:port:user:pass',
      oninput: (ev) => { ed.template = ev.target.value; changed(); debounce('vars', 400, () => { if (JSON.stringify(tplVars(ed.template)) !== box.dataset.vars) rerender(); }); } }),
      h('span', null, 'http, https, socks4, socks5, socks5h. Placeholders: ', h('code', null, '{SID}'), ' sticky session, ', h('code', null, '{RAND:1000-9999}'), ', ', h('code', null, '{PASSWORD}'), ', any ', h('code', null, '{VAR}'), '. A password typed in the URL is moved to encrypted storage.')));
    if (/\{PASSWORD\}/i.test(ed.template) || ed.hasPassword) {
      form.append(...field('Password', h('input', { type: 'password', value: ed.password, autocomplete: 'new-password', placeholder: ed.hasPassword ? '•••••• saved — type to replace' : 'Fills {PASSWORD}', oninput: (ev) => { ed.password = ev.target.value; changed(); } })));
    }
    const vars = tplVars(ed.template);
    box.dataset.vars = JSON.stringify(vars);
    for (const v of vars) {
      form.append(...field(`{${v}}`, h('input', { class: 'mono', value: ed.vars[v] ?? '', placeholder: `Value for {${v}}`, oninput: (ev) => { ed.vars[v] = ev.target.value; changed(); } })));
    }
  }
  const groups = [...new Set(P.profiles.map((p) => p.group).filter(Boolean))];
  form.append(h('datalist', { id: 'pGroups' }, groups.map((g) => h('option', { value: g }))));
  form.append(...field('Название', h('input', { value: ed.name, placeholder: 'Авто (провайдер · страна · режим)', oninput: (ev) => { ed.name = ev.target.value; markDirty(); } })));
  form.append(...field('Группа', h('input', { value: ed.group, list: 'pGroups', placeholder: 'напр. US residential', oninput: (ev) => { ed.group = ev.target.value; markDirty(); } })));
  form.append(...field('Заметки', h('textarea', { rows: 2, value: ed.notes, oninput: (ev) => { ed.notes = ev.target.value; markDirty(); } }), null, true));
  form.append(...field('Подключается как', h('div', { id: 'pPreview', class: 'preview-url' }, P.preview || '…')));
  box.append(form);

  const saveBtn = h('button', { class: 'btn', id: 'pSave', onclick: guard(() => busy(saveBtn, 'Сохранение…', () => saveProxy(false))) }, 'Сохранить');
  const connBtn = h('button', { class: 'btn primary', onclick: guard(() => busy(connBtn, 'Подключение…', () => saveProxy(true))) }, prof?.active ? 'Сохранить и переподключить' : 'Сохранить и подключить');
  const testBtn = h('button', { class: 'btn', onclick: guard(() => busy(testBtn, 'Проверка…', async () => { const id = edDirty() || !ed.id ? await saveProxy(false) : ed.id; if (id) await testProxies([id]); })) }, 'Тест');
  const newIp = ed.id && prof?.sticky ? h('button', { class: 'btn', title: 'Перевыпустить sticky-сессию', onclick: guard(async () => { applyListing(await post(`/api/proxies/${ed.id}/new-ip`)); toast('Новый id сессии', 'ok'); if (prof.active) checkEgress(true); schedulePreview(); }) }, 'Новый IP') : null;
  box.append(h('div', { class: 'row-end', style: 'justify-content:flex-start' }, connBtn, saveBtn, testBtn, newIp, h('span', { id: 'pDirty', class: 'muted', hidden: true }, 'несохранённые изменения')));
  box.append(h('div', { id: 'pResult' }));
  renderPResult(); markDirty(); schedulePreview(0);
}
function markDirty() { const d = $('pDirty'); if (d) d.hidden = !edDirty(); }
function renderPResult() {
  const box = $('pResult'); if (!box) return;
  clear(box);
  const t = P.result; if (!t) return;
  if (t.ok) {
    box.append(h('div', { class: 'result ok' }, h('b', null, `${flag(t.country)} ${t.ip}`), ' · ', geoText(t), t.org ? ` · ${t.org}` : '', ` · ${t.latencyMs} ms`, t.timezone ? ` · ${t.timezone}` : '', h('span', { class: 'faint' }, ` · tested ${fmtAgo(t.at)}`)));
  } else box.append(h('div', { class: 'result err' }, h('b', null, 'Проверка не удалась: '), t.error || 'неизвестная ошибка', t.at ? h('span', { class: 'faint' }, ` · ${fmtAgo(t.at)}`) : null));
}
function schedulePreview(ms = 350) {
  debounce('pPreview', ms, async () => {
    const ed = P.ed; const el = $('pPreview'); if (!ed || !el) return;
    try {
      const r = await post('/api/proxies/preview', { profile: edPayload(ed), id: ed.id });
      P.preview = r.display; el.textContent = r.display; el.className = 'preview-url';
    } catch (e) { el.textContent = e.message; el.className = 'preview-url err'; }
  });
}
async function saveProxy(andConnect) {
  const ed = P.ed;
  const r = ed.id ? await put(`/api/proxies/${ed.id}`, edPayload(ed)) : await post('/api/proxies', edPayload(ed));
  const id = r.profile.id;
  P.sel = id; P.ed = null; applyListing(r);
  P.ed = edFromProfile(r.profile); P.edInit = JSON.stringify(edPayload(P.ed));
  renderPList(); renderPEditor();
  if (andConnect) await connectProxy(id);
  else toast('Сохранено', 'ok');
  return id;
}

// ── bulk import ──
function openImport() {
  const ta = h('textarea', { class: 'code', spellcheck: false, placeholder: 'По одному прокси в строке:\nhost:port\nhost:port:user:pass\nuser:pass@host:port\nsocks5://user:pass@host:1080' });
  const group = h('input', { placeholder: 'Группа (необязательно)' });
  const prefix = h('input', { placeholder: 'Префикс имени (необязательно)' });
  const out = h('div');
  const preview = async () => {
    const r = await post('/api/proxies/import', { text: ta.value, group: group.value, namePrefix: prefix.value, dryRun: true });
    clear(out).append(h('p', null, h('b', null, `${r.added.length} новых`), ` · ${r.duplicates} дубликатов · ${r.errors.length} ошибок · ${r.total} строк`));
    if (r.added.length) out.append(h('pre', { class: 'codebox', style: 'max-height:180px' }, r.added.slice(0, 50).map((a) => `${a.name}  ${a.display}`).join('\n') + (r.added.length > 50 ? `\n… ещё ${r.added.length - 50}` : '')));
    if (r.errors.length) out.append(h('pre', { class: 'codebox err', style: 'max-height:120px' }, r.errors.slice(0, 50).map((e) => `строка ${e.line}: ${e.reason}`).join('\n')));
    return r;
  };
  ta.addEventListener('input', () => debounce('imp', 500, guard(preview)));
  modal('Импорт прокси', h('div', null, ta, h('div', { class: 'toolbar sub', style: 'padding:8px 0' }, group, prefix), out), [
    { label: 'Отмена' },
    { label: 'Импорт', cls: 'primary', fn: async () => {
      const r = await post('/api/proxies/import', { text: ta.value, group: group.value, namePrefix: prefix.value });
      applyListing(r);
      toast(`Импортировано прокси: ${r.added.length}${r.duplicates ? ` · пропущено дубликатов: ${r.duplicates}` : ''}${r.errors.length ? ` · ошибочных строк: ${r.errors.length}` : ''}`, r.added.length ? 'ok' : 'warn');
      if (r.added.length && await confirmBox(`Проверить импортированные прокси (${r.added.length}) сейчас?`, 'Проверить')) testProxies(r.added.map((a) => a.id));
      return true;
    } },
  ]);
}
$('pImport').addEventListener('click', openImport);

// ─────────────────────────────────────────────────────────────────────────────
// IP monitor
// ─────────────────────────────────────────────────────────────────────────────
const IPW = {
  events: [], lastId: 0, epoch: '', state: null, loaded: false, syncing: false, toastAt: 0,
  range: store.get('ipw-range', 3600000), filter: store.get('ipw-filter', 'all'),
};
const IPW_TYPES = {
  start: ['Запущено', 'accent'], switch: ['Переключено', 'accent'], change: ['Изменено', 'warn'], error: ['Ошибка', 'err'],
  recovered: ['Восстановлено', 'ok'], blocked: ['Заблокировано', 'err'], stop: ['Остановлено', ''],
};
const IPW_INTERVALS = [[5, '5s'], [15, '15s'], [30, '30s'], [60, '1m'], [300, '5m']];
const IPW_RANGES = [[3600000, '1h'], [6 * 3600000, '6h'], [24 * 3600000, '24h'], [7 * 24 * 3600000, '7d']];
const MODE_LABEL = { rotating: 'ротационный', sticky: 'sticky', static: 'статический', direct: 'напрямую', cli: 'CLI' };
const fmtDur = (ms) => {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  const hr = Math.floor(m / 60); if (hr < 24) return `${hr}h ${m % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
};
const fmtStamp = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const ipColor = (ip) => { let x = 0; for (const c of String(ip)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${x % 360} 60% 58%)`; };
const placeOf = (e) => [e.city, e.region && e.region !== e.city ? e.region : '', e.country].filter(Boolean).join(', ');
const isChange = (e) => e.type === 'change' || e.type === 'switch' || e.type === 'start';
// Russian plural for "событие" (event)
const ipwPlural = (n) => { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return 'событий'; if (b > 1 && b < 5) return 'события'; if (b === 1) return 'событие'; return 'событий'; };

async function syncIpHistory(full = false) {
  if (IPW.syncing) return [];
  IPW.syncing = true;
  try {
    let after = !full && IPW.loaded ? IPW.lastId : 0;
    let r = await api(`/api/ip-history?limit=5000${after ? `&after=${after}` : ''}`);
    if (after && r.state.epoch !== IPW.epoch) { after = 0; r = await api('/api/ip-history?limit=5000'); }
    const asc = r.events.slice().reverse();
    if (!after) IPW.events = asc; else IPW.events.push(...asc);
    if (IPW.events.length > 5000) IPW.events.splice(0, IPW.events.length - 5000);
    IPW.state = r.state;
    IPW.lastId = r.state.lastEventId || 0;
    IPW.epoch = r.state.epoch || '';
    const fresh = IPW.loaded && after ? r.events : [];
    IPW.loaded = true;
    return fresh;
  } finally { IPW.syncing = false; }
}

/** From pollStatus: pick up new history events, notify about unexpected changes. */
function onIpStatus(w) {
  const badge = $('ipCount');
  badge.hidden = !w?.changes1h; badge.textContent = w?.changes1h || '';
  badge.title = w ? `Изменений IP за последний час: ${w.changes1h}` : '';
  if (!w) return;
  IPW.state = w;
  const resync = !IPW.loaded || w.epoch !== IPW.epoch || w.lastEventId < IPW.lastId;
  if (resync || w.lastEventId > IPW.lastId) {
    guard(async () => {
      const fresh = await syncIpHistory(resync);
      notifyIp(fresh);
      if (PAGE === 'ipwatch') renderIpw();
    })();
  } else if (PAGE === 'ipwatch') renderIpwHero();
}

function notifyIp(fresh) {
  if (!fresh.length || PAGE === 'ipwatch') return;
  // A rotating proxy changes IP by design; tell about it only for connections that should hold one IP.
  const changed = fresh.filter((e) => e.type === 'change' && e.mode !== 'rotating');
  const failed = fresh.filter((e) => e.type === 'error');
  if ((!changed.length && !failed.length) || Date.now() - IPW.toastAt < 20000) return;
  IPW.toastAt = Date.now();
  const open = { label: 'Открыть', fn: () => go('ipwatch') };
  if (changed.length) {
    const e = changed[0];
    toast(`Внешний IP изменился: ${e.prevIp || '?'} → ${flag(e.country)} ${e.ip}${placeOf(e) ? ` · ${placeOf(e)}` : ''}`, 'warn', { action: open, ms: 9000 });
  } else {
    toast(`Проверка IP не удалась: ${failed[0].error || 'ошибка'}`, 'err', { action: open });
  }
}

async function loadIpw() {
  await syncIpHistory(true);
  renderIpw();
}
function renderIpw() {
  renderIpwHero();
  renderIpwTiles();
  renderIpwTimeline();
  renderIpwTable();
}

const setIpw = guard(async (patch) => {
  await post('/api/settings', patch);
  await pollStatus();
  renderIpw();
});

function renderIpwHero() {
  const w = IPW.state; if (!w) return;
  const now = Date.now();
  const failing = w.consecutiveFailures > 0 && (w.lastCheckAt || 0) > (w.lastOkAt || 0);
  const cls = !w.enabled ? 'off' : w.blocked || failing ? 'err' : w.ip ? (w.mode === 'direct' ? 'warn' : 'ok') : '';
  $('ipwHero').className = `card ipw-hero${cls ? ` is-${cls}` : ''}`;
  const ipEl = clear($('ipwIp'));
  if (w.blocked) ipEl.append('Заблокировано');
  else if (w.ip) ipEl.append(h('span', { class: 'flag' }, flag(w.country)), ' ', h('span', { class: failing ? 'faint' : '', title: 'Нажмите, чтобы скопировать', onclick: () => copy(w.ip, 'IP скопирован') }, w.ip));
  else ipEl.append(w.enabled ? 'проверка…' : '—');
  $('ipwGeo').textContent = w.blocked ? (w.lastError || 'Kill switch включён, прокси не подключён')
    : failing ? `Последняя проверка не удалась: ${w.lastError}` : [placeOf(w), w.org].filter(Boolean).join(' · ');
  $('ipwGeo').className = `ipw-geo${w.blocked || failing ? ' err' : ''}`;
  const meta = clear($('ipwMeta'));
  meta.append(tag(w.label || 'Напрямую', 'accent'));
  if (MODE_LABEL[w.mode]) meta.append(tag(MODE_LABEL[w.mode], w.mode === 'direct' ? 'warn' : ''));
  if (w.ip && w.since && !w.blocked) meta.append(h('span', null, 'держится ', h('b', null, fmtDur(now - w.since))));
  if (w.lastOkAt) meta.append(h('span', null, `проверено ${fmtAgo(w.lastOkAt)}`));
  if (w.latencyMs) meta.append(h('span', null, `${w.latencyMs} мс`));

  const swBox = clear($('ipwSwitch'));
  swBox.append(sw(w.enabled, 'Мониторинг внешнего IP', (v) => setIpw({ ipWatch: v }), 'Проверять внешний IP по таймеру и записывать каждое изменение'));
  const sec = Math.round(w.intervalMs / 1000);
  const opts = IPW_INTERVALS.some(([v]) => v === sec) ? IPW_INTERVALS : [...IPW_INTERVALS, [sec, `${sec}s`]];
  clear($('ipwInterval')).append(seg(opts, sec, (v) => setIpw({ ipWatch: true, ipWatchSec: v })));
  let next = 'off', frac = 0;
  if (w.enabled) {
    if (w.running) next = 'проверка…';
    else if (w.nextCheckAt) {
      const left = Math.max(0, w.nextCheckAt - now);
      next = `следующая через ${Math.ceil(left / 1000)} с`;
      frac = 1 - Math.min(1, left / w.intervalMs);
    }
  }
  $('ipwNext').textContent = next;
  $('ipwBar').style.width = `${Math.round(frac * 100)}%`;
}

function renderIpwTiles() {
  const w = IPW.state; if (!w) return;
  const since = Date.now() - IPW.range;
  const holds = IPW.events.filter((e) => e.at >= since && e.type === 'change' && e.heldMs != null).map((e) => e.heldMs);
  const avg = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null;
  const tile = (v, k, cls = '', title = '') => h('div', { class: `tile ${cls}`, title }, h('div', { class: 'tile-v' }, v), h('div', { class: 'tile-k' }, k));
  clear($('ipwTiles')).append(
    tile(String(w.changes1h), 'изменений · 1ч', w.changes1h ? 'warn' : ''),
    tile(String(w.changes24h), 'изменений · 24ч'),
    tile(String(w.uniqueIps24h), 'уникальных IP · 24ч'),
    tile(avg == null ? '—' : fmtDur(avg), `сред. удержание · ${IPW_RANGES.find(([v]) => v === IPW.range)?.[1] || ''}`, '', 'Среднее время, что IP держался до самостоятельной смены'),
    tile(w.checks.toLocaleString(), 'проверок за запуск'),
    tile(String(w.failures), 'неуспешных проверок', w.failures ? 'err' : ''),
  );
}

/** History → [{ from, to, ip?, err?, ev }] spans (stop/blocked leave gaps). */
function ipSpans(now) {
  const out = [];
  const ev = IPW.events;
  let cur = null;
  const close = (at) => { if (cur) { cur.to = at; out.push(cur); cur = null; } };
  for (const e of ev) {
    if (e.type === 'stop' || e.type === 'blocked') { close(e.at); continue; }
    if (e.type === 'error') { close(e.at); cur = { from: e.at, err: true, ev: e }; continue; }
    if (cur && !cur.err && cur.ip === e.ip) continue;
    close(e.at);
    cur = { from: e.at, ip: e.ip, ev: e };
  }
  if (cur) {
    if (IPW.state?.enabled && !IPW.state.blocked) close(now);
    else close(Math.max(cur.from, IPW.state?.lastCheckAt || cur.from));
  }
  return out;
}

function renderIpwTimeline() {
  clear($('ipwRange')).append(seg(IPW_RANGES, IPW.range, (v) => { IPW.range = v; store.set('ipw-range', v); renderIpw(); }));
  const now = Date.now(), from = now - IPW.range;
  const band = clear($('ipwBand'));
  const total = new Map();
  const spans = ipSpans(now).filter((s) => s.to > from);
  for (const s of spans) {
    const a = Math.max(s.from, from), b = Math.min(s.to, now);
    const left = ((a - from) / IPW.range) * 100, width = ((b - a) / IPW.range) * 100;
    const geo = s.ev ? placeOf(s.ev) : '';
    const title = s.err
      ? `Проверки не проходят: ${s.ev.error || ''}\n${fmtStamp(s.from)} – ${fmtStamp(s.to)} (${fmtDur(s.to - s.from)})`
      : `${s.ip}${geo ? ` · ${geo}` : ''}${s.ev.org ? ` · ${s.ev.org}` : ''}\n${fmtStamp(s.from)} – ${fmtStamp(s.to)} (${fmtDur(s.to - s.from)})`;
    const seg_ = h('div', { class: `ipw-span${s.err ? ' err' : ''}`, title });
    seg_.style.left = `${left}%`; seg_.style.width = `max(2px, ${width}%)`;
    if (!s.err) {
      seg_.style.background = ipColor(s.ip);
      const t = total.get(s.ip) || { ms: 0, ev: s.ev }; t.ms += b - a; total.set(s.ip, t);
    }
    band.append(seg_);
  }
  if (!spans.length) band.append(h('div', { class: 'ipw-band-empty' }, 'Нет данных за этот период'));
  const axis = clear($('ipwAxis'));
  for (let i = 0; i <= 4; i++) {
    const at = from + (IPW.range * i) / 4;
    const lbl = h('span', null, i === 4 ? 'сейчас' : IPW.range > 24 * 3600000
      ? new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
    lbl.style.left = `${i * 25}%`;
    axis.append(lbl);
  }
  const legend = clear($('ipwLegend'));
  const items = [...total.entries()].sort((a, b) => b[1].ms - a[1].ms);
  for (const [ip, t] of items.slice(0, 16)) {
    const sw_ = h('i'); sw_.style.background = ipColor(ip);
    legend.append(h('span', { class: 'ipw-leg', title: [placeOf(t.ev), t.ev.org].filter(Boolean).join(' · ') },
      sw_, flag(t.ev.country), ' ', h('span', { class: 'mono' }, ip), h('span', { class: 'faint' }, fmtDur(t.ms))));
  }
  if (items.length > 16) legend.append(h('span', { class: 'faint' }, `+ ещё ${items.length - 16}`));
}

function ipwRows() {
  const q = $('ipwQ').value.trim().toLowerCase();
  return IPW.events.filter((e) => {
    if (IPW.filter === 'changes' && !isChange(e)) return false;
    if (IPW.filter === 'errors' && e.type !== 'error' && e.type !== 'blocked') return false;
    if (!q) return true;
    return [e.ip, e.prevIp, e.city, e.region, e.country, e.org, e.label, e.error, e.type].some((x) => String(x || '').toLowerCase().includes(q));
  });
}

function renderIpwTable() {
  clear($('ipwFilter')).append(seg([['all', 'Все'], ['changes', 'Изменения'], ['errors', 'Ошибки']], IPW.filter, (v) => {
    IPW.filter = v; store.set('ipw-filter', v); renderIpwTable();
  }));
  const rows = ipwRows();
  const body = clear($('ipwRows'));
  const ipCell = (ip) => {
    if (!ip) return h('td', { class: 'faint' }, '—');
    const dot = h('i', { class: 'ipw-dot' }); dot.style.background = ipColor(ip);
    return h('td', { class: 'mono', title: 'Нажмите, чтобы скопировать', onclick: () => copy(ip, 'IP скопирован') }, dot, ip);
  };
  for (const e of rows.slice().reverse().slice(0, 1000)) {
    const [label, cls] = IPW_TYPES[e.type] || [e.type, ''];
    body.append(h('tr', { class: `ipw-${e.type}` },
      h('td', { class: 'mono faint', title: new Date(e.at).toISOString() }, fmtStamp(e.at)),
      h('td', null, tag(label, cls)),
      ipCell(e.ip),
      ipCell(e.prevIp),
      h('td', { title: placeOf(e) }, e.type === 'error' ? h('span', { class: 'err' }, e.error || '')
        : e.note && !e.ip ? h('span', { class: 'muted' }, e.note) : [flag(e.country), ' ', placeOf(e)]),
      h('td', { class: 'muted', title: e.org || '' }, e.org || ''),
      h('td', { title: e.mode ? `${e.label || ''} (${MODE_LABEL[e.mode] || e.mode})` : (e.label || '') }, e.label || '', e.mode && MODE_LABEL[e.mode] ? h('span', { class: 'faint' }, ` · ${MODE_LABEL[e.mode]}`) : null),
      h('td', { class: 'r-al mono', title: e.heldMs != null ? 'Сколько держался предыдущий IP' : '' }, fmtDur(e.heldMs)),
    ));
  }
  $('ipwEmpty').hidden = IPW.events.length > 0;
  $('ipwShown').textContent = rows.length === IPW.events.length ? `${rows.length.toLocaleString()} ${ipwPlural(rows.length)}` : `${rows.length.toLocaleString()} / ${IPW.events.length.toLocaleString()}`;
}
$('ipwQ').addEventListener('input', () => debounce('ipwq', 120, renderIpwTable));
$('ipwCheck').addEventListener('click', guard(async () => {
  await busy($('ipwCheck'), 'Проверка…', async () => {
    const r = await post('/api/ip-history/check');
    IPW.state = r.state;
    await syncIpHistory();
  });
  await pollStatus();
  renderIpw();
  const w = IPW.state;
  if (w.blocked) toast(w.lastError || 'Заблокировано', 'err');
  else if (w.consecutiveFailures) toast(`Проверка IP не удалась: ${w.lastError}`, 'err');
  else toast(`Внешний IP ${w.ip}${placeOf(w) ? ` · ${placeOf(w)}` : ''}`, 'ok');
}));
$('ipwCsv').addEventListener('click', () => {
  const cols = ['id', 'at', 'type', 'ip', 'prevIp', 'country', 'region', 'city', 'org', 'label', 'mode', 'via', 'latencyMs', 'heldMs', 'error'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(',')].concat(ipwRows().map((e) => cols.map((c) => esc(c === 'at' ? new Date(e.at).toISOString() : e[c])).join(',')));
  download(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }), `cupnet-ip-history-${new Date().toISOString().slice(0, 10)}.csv`);
});
$('ipwClear').addEventListener('click', guard(async () => {
  if (!(await confirmBox('Удалить всю историю IP? В логах сессий копии сохранятся.', 'Удалить', true))) return;
  await del('/api/ip-history');
  await syncIpHistory(true);
  renderIpw();
  toast('История IP очищена', 'ok');
}));
setInterval(() => { if (PAGE === 'ipwatch' && IPW.state) renderIpwHero(); }, 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Header table (Repeater, Breakpoints)
// ─────────────────────────────────────────────────────────────────────────────
function headerTable(rows, onChange = () => {}) {
  const box = h('div');
  let bulk = false;
  const paint = () => {
    clear(box);
    const bar = h('div', { class: 'bodybar' }, h('span', { class: 'muted' }, `заголовков: ${rows.filter((r) => r[2] !== false && r[0]).length}`), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => { bulk = !bulk; paint(); } }, bulk ? 'Таблица' : 'Массовое редактирование'));
    box.append(bar);
    if (bulk) {
      const ta = h('textarea', { class: 'code', spellcheck: false, value: rows.map(([k, v, on]) => `${on === false ? '# ' : ''}${k}: ${v}`).join('\n'),
        oninput: () => {
          rows.length = 0;
          for (const line of ta.value.split('\n')) {
            const off = /^\s*(#|\/\/)/.test(line); const l = line.replace(/^\s*(#|\/\/)\s?/, '');
            const i = l.indexOf(':', l.startsWith(':') ? 1 : 0);
            if (i > 0) rows.push([l.slice(0, i).trim(), l.slice(i + 1).trim(), !off]);
          }
          onChange();
        } });
      box.append(ta, h('div', { class: 'hint muted' }, 'По одному «Имя: значение» в строке; # отключает строку.'));
      return;
    }
    const tb = h('tbody');
    rows.forEach((r, i) => {
      tb.append(h('tr', { class: r[2] === false ? 'off' : '' },
        h('td', null, h('input', { type: 'checkbox', checked: r[2] !== false, onchange: (ev) => { r[2] = ev.target.checked; ev.target.closest('tr').className = r[2] ? '' : 'off'; onChange(); } })),
        h('td', null, h('input', { type: 'text', value: r[0], placeholder: 'Имя', spellcheck: false, oninput: (ev) => { r[0] = ev.target.value; onChange(); } })),
        h('td', null, h('input', { type: 'text', value: r[1], placeholder: 'Значение', spellcheck: false, oninput: (ev) => { r[1] = ev.target.value; onChange(); } })),
        h('td', null, h('button', { class: 'icon', title: 'Убрать', onclick: () => { rows.splice(i, 1); paint(); onChange(); } }, '✕'))));
    });
    box.append(h('table', { class: 'htable' }, tb), h('button', { class: 'btn sm ghost', onclick: () => { rows.push(['', '', true]); paint(); box.querySelector('tr:last-child input[type=text]')?.focus(); } }, '+ Добавить заголовок'));
  };
  paint();
  return box;
}
const enabledPairs = (rows) => rows.filter((r) => r[2] !== false && String(r[0]).trim()).map(([k, v]) => [String(k).trim(), String(v)]);

// ─────────────────────────────────────────────────────────────────────────────
// Repeater
// ─────────────────────────────────────────────────────────────────────────────
const RP = { rows: [['Accept', '*/*', true]], tab: 'headers', respTab: 'body', last: null };
function rpLoad({ method, url, headers, body }) {
  $('rpMethod').value = [...$('rpMethod').options].some((o) => o.value === method) ? method : 'GET';
  $('rpUrl').value = url || '';
  RP.rows = (headers || []).map(([k, v]) => [k, v, true]);
  $('rpBody').value = body || '';
  renderRpHeaders(); renderRpCode();
  if (body) rpShowTab('body');
}
function renderRpHeaders() { clear($('rpHeaders')).append(headerTable(RP.rows, () => debounce('rpcode', 300, renderRpCode))); }
function rpShowTab(t) {
  RP.tab = t;
  document.querySelectorAll('#rpTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  $('rpHeaders').hidden = t !== 'headers'; $('rpBodyWrap').hidden = t !== 'body'; $('rpCodeWrap').hidden = t !== 'code';
  if (t === 'code') renderRpCode();
}
document.querySelectorAll('#rpTabs button').forEach((b) => b.addEventListener('click', () => rpShowTab(b.dataset.t)));
function rpRequest() { return { method: $('rpMethod').value, url: $('rpUrl').value.trim(), headers: enabledPairs(RP.rows), body: $('rpBody').value }; }
function renderRpCode() {
  if (!window.CupNetCodegen) { $('rpCode').textContent = 'Генератор кода не загрузился.'; return; }
  const r = rpRequest();
  $('rpCode').textContent = window.CupNetCodegen.generateRequestCode($('rpLang').value, { ...r, headers: Object.fromEntries(r.headers) });
}
$('rpLang').addEventListener('change', renderRpCode);
for (const id of ['rpUrl', 'rpBody']) $(id).addEventListener('input', () => debounce('rpcode', 300, renderRpCode));
$('rpMethod').addEventListener('change', renderRpCode);
$('rpCopyCode').addEventListener('click', () => copy($('rpCode').textContent, 'Код скопирован'));
$('rpCurl').addEventListener('click', () => {
  const ta = h('textarea', { class: 'code', spellcheck: false, placeholder: "curl 'https://example.com/api' -H 'Accept: application/json' --data-raw '{…}'" });
  modal('Импорт curl', ta, [{ label: 'Отмена' }, { label: 'Импорт', cls: 'primary', fn: () => {
    const r = window.CupNetParseCurl ? window.CupNetParseCurl(ta.value) : null;
    if (!r || !r.url) throw new Error('Не удалось разобрать эту команду curl');
    rpLoad({ method: r.method, url: r.url, headers: pairsOf(r.headers), body: r.body || '' });
    toast('Импортировано', 'ok');
  } }]);
});
async function rpSend() {
  const r = rpRequest();
  if (!/^https?:\/\//i.test(r.url)) { toast('Введите http(s) URL', 'warn'); $('rpUrl').focus(); return; }
  const head = clear($('rpRespHead'));
  head.append(h('i', { class: 'dot busy' }), h('span', { class: 'muted' }, ` ${r.method} ${r.url}`));
  $('rpRespTabs').hidden = true; clear($('rpResp'));
  const res = await busy($('rpSend'), 'Отправка…', () => post('/api/replay', { ...r, followRedirects: $('rpFollow').checked }));
  RP.last = res.seq ? await api(`/api/log/${res.seq}`).catch(() => null) : null;
  renderRpResponse(res);
}
function renderRpResponse(res) {
  const head = clear($('rpRespHead'));
  if (res.error && !res.status) {
    head.append(badge('ошибка', 'sf'), ' ', h('span', { class: 'err' }, res.error));
    return;
  }
  const e = RP.last;
  append(head, [badge(res.status || 'ERR', stCls(res.status)), h('span', { class: 'mono' }, `${res.duration} мс`), e ? h('span', { class: 'muted' }, fmtSize(e.resSize) || '0 B') : null,
    h('span', { class: 'spacer' }), res.seq ? h('button', { class: 'btn sm', title: 'Показать в Трафике (эфирная сессия)', onclick: () => { if (shown) openSession(current); go('traffic'); setTimeout(() => select(res.seq), 50); } }, `#${res.seq} в Трафике`) : null]);
  if (res.error) head.append(h('span', { class: 'err' }, res.error));
  $('rpRespTabs').hidden = !e;
  renderRpRespTab();
}
function renderRpRespTab() {
  document.querySelectorAll('#rpRespTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === RP.respTab));
  const box = clear($('rpResp')); const e = RP.last; if (!e) return;
  if (RP.respTab === 'headers') box.append(kvGrid(pairsOf(e.responseHeaders)));
  else box.append(bodyView(e, 'response', ''));
}
document.querySelectorAll('#rpRespTabs button').forEach((b) => b.addEventListener('click', () => { RP.respTab = b.dataset.t; renderRpRespTab(); }));
$('rpIntrude').addEventListener('click', () => openInIntruder(rpRequest()));
$('rpSend').addEventListener('click', guard(rpSend));
$('rpUrl').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') guard(rpSend)(); });
document.addEventListener('keydown', (ev) => { if (PAGE === 'repeater' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); guard(rpSend)(); } });

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────
const RULE_TYPES = [
  ['inject', 'Внедрить JS в HTML', 'Добавляет ваш скрипт в подходящие HTML-страницы (в <head> перед скриптами страницы или в конец <body>).'],
  ['mock', 'Заглушка ответа', 'Отвечает вашим статусом и телом; запрос не доходит до сайта.'],
  ['block', 'Блокировка', 'Прерывает запрос; ничего не отправляется.'],
  ['modifyHeaders', 'Изменить заголовки', 'Задаёт или удаляет заголовки запроса перед отправкой и заголовки ответа до того, как их увидит Chrome.'],
  ['script', 'Скрипт-хуки', 'JS, который правит запрос перед отправкой (ctx.url, ctx.method, ctx.headers, ctx.body, ctx.shortCircuit) и ответ после (ctx.request, ctx.response.statusCode / headers / body).'],
  ['pause', 'Только пауза (точка останова)', 'Задерживает подходящие запросы в «Точках останова», чтобы их можно было изменить, пропустить или заблокировать.'],
];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
// Russian plural for "срабатывание" (hit)
const rHitPlural = (n) => { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return 'срабатываний'; if (b > 1 && b < 5) return 'срабатывания'; if (b === 1) return 'срабатывание'; return 'срабатываний'; };
const R = { rules: [], sel: null, ed: null, edInit: '' };
const isEmptyHeaderParams = (p) => !Object.keys(p.requestHeaders || {}).length && !(p.removeRequestHeaders || []).length && !Object.keys(p.responseHeaders || {}).length && !(p.removeResponseHeaders || []).length;
const uiType = (r) => (r.type === 'modifyHeaders' && r.breakpoint_enabled && isEmptyHeaderParams(r.params || {}) ? 'pause' : r.type);
const RULE_TEMPLATES = {
  inject: () => ({ position: 'head', source: "// Runs in the page before its own scripts.\n// Report to the CupNet log: navigator.sendBeacon('/__cupnet/event', JSON.stringify({ hello: 1 }))\nconsole.log('[cupnet] injected into', location.href);\n" }),
  mock: () => ({ status: 200, mimeType: 'application/json', body: '{"ok":true}' }),
  block: () => ({}),
  modifyHeaders: () => ({ requestHeaders: {}, removeRequestHeaders: [], responseHeaders: {}, removeResponseHeaders: [] }),
  script: () => ({ beforeSource: '// ctx.headers["x-example"] = "1";\n', afterSource: '' }),
  pause: () => ({}),
};
function edFromRule(r) {
  if (!r) return { id: null, name: '', type: 'inject', url_pattern: '', methods: [], priority: 0, delay_ms: 0, stop_on_match: true, breakpoint_enabled: false, group_name: '', enabled: true, params: RULE_TEMPLATES.inject(), matchHeaders: [], matchBody: { mode: '', value: '' } };
  const p = JSON.parse(JSON.stringify(r.params || {}));
  const mh = Array.isArray(p.matchHeaders) ? p.matchHeaders : []; delete p.matchHeaders;
  const mb = p.matchBody && p.matchBody.mode ? p.matchBody : { mode: '', value: '' }; delete p.matchBody;
  return { id: r.id, name: r.name, type: uiType(r), url_pattern: r.url_pattern, methods: r.method && r.method !== '*' ? r.method.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [],
    priority: r.priority || 0, delay_ms: r.delay_ms || 0, stop_on_match: r.stop_on_match !== false, breakpoint_enabled: !!r.breakpoint_enabled, group_name: r.group_name || '', enabled: r.enabled !== false,
    params: p, matchHeaders: mh, matchBody: mb };
}
function ruleRow(ed) {
  const params = ed.type === 'pause' ? {} : { ...ed.params };
  const mh = ed.matchHeaders.filter((m) => m.key);
  if (mh.length) params.matchHeaders = mh;
  if (ed.matchBody.mode && ed.matchBody.value) params.matchBody = ed.matchBody;
  return { ...(ed.id != null ? { id: ed.id } : {}), name: ed.name.trim(), type: ed.type === 'pause' ? 'modifyHeaders' : ed.type, url_pattern: ed.url_pattern.trim(), params,
    method: ed.methods.length ? ed.methods.join(',') : '*', priority: Number(ed.priority) || 0, delay_ms: Number(ed.delay_ms) || 0, stop_on_match: ed.stop_on_match,
    breakpoint_enabled: ed.type === 'pause' ? true : ed.breakpoint_enabled, group_name: ed.group_name.trim() || null, enabled: ed.enabled };
}
const rDirty = () => R.ed && JSON.stringify(ruleRow(R.ed)) !== R.edInit;
async function loadRules() {
  R.rules = await api('/api/rules');
  if (R.sel != null && R.sel !== 'new' && !R.rules.some((r) => r.id === R.sel)) { R.sel = null; R.ed = null; }
  if (R.sel != null && !R.ed) { R.ed = edFromRule(R.sel === 'new' ? null : R.rules.find((r) => r.id === R.sel)); R.edInit = JSON.stringify(ruleRow(R.ed)); }
  renderRList(); renderREditor();
}
$('rq').addEventListener('input', () => renderRList());
function renderRList() {
  const q = $('rq').value.trim().toLowerCase();
  const base = R.rules.filter((r) => r.type !== 'mirror'); // mirror rules live on the Mirror tab
  const list = base.filter((r) => !q || `${r.name} ${r.url_pattern} ${r.type} ${r.group_name || ''}`.toLowerCase().includes(q));
  const box = clear($('rlist'));
  if (!base.length) {
    box.append(h('div', { class: 'empty' }, h('p', null, 'Пока нет правил.'), h('p', { class: 'muted' }, 'Правила внедряют JS в страницы, подменяют или блокируют запросы, переписывают заголовки и останавливают запросы для редактирования.'),
      h('button', { class: 'btn primary', onclick: () => openRule('new') }, '+ Новое правило')));
    return;
  }
  for (const r of list) {
    const t = uiType(r);
    box.append(h('div', { class: `prow${R.sel === r.id ? ' sel' : ''}${r.enabled ? '' : ' off'}`, onclick: () => openRule(r.id) },
      h('input', { type: 'checkbox', checked: !!r.enabled, title: r.enabled ? 'Включено' : 'Выключено', onclick: (ev) => ev.stopPropagation(),
        onchange: guard(async (ev) => { await post(`/api/rules/${r.id}/enabled`, { enabled: ev.target.checked }); r.enabled = ev.target.checked; renderRList(); }) }),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'title' }, h('b', { title: r.name }, r.name), tag((RULE_TYPES.find((x) => x[0] === t) || [, t])[1], t === 'pause' ? 'warn' : 'accent'),
          r.breakpoint_enabled && t !== 'pause' ? tag('пауза', 'warn') : null, r.method && r.method !== '*' ? tag(r.method) : null, r.group_name ? tag(r.group_name) : null),
        h('div', { class: 'meta' }, h('span', { class: 'mono', title: r.url_pattern }, r.url_pattern), r.last_error ? h('span', { class: 'err', title: r.last_error }, r.last_error) : null)),
      h('div', { class: 'acts muted mono', title: r.last_hit_at ? `последнее срабатывание ${new Date(r.last_hit_at).toLocaleString()}` : 'ни разу не сработало' }, `${r.hit_count || 0} ${rHitPlural(r.hit_count || 0)}`)));
  }
  if (!list.length) box.append(h('div', { class: 'empty' }, 'Ничего не найдено.'));
}
async function openRule(id) {
  if (rDirty() && R.sel !== id && !(await confirmBox('Отменить несохранённые изменения этого правила?', 'Отменить', true))) return;
  R.sel = id;
  R.ed = edFromRule(id === 'new' ? null : R.rules.find((r) => r.id === id));
  R.edInit = JSON.stringify(ruleRow(R.ed));
  renderRList(); renderREditor();
}
$('rNew').addEventListener('click', () => openRule('new'));
function kvObjEditor(obj, onChange) {
  const rows = Object.entries(obj || {}).map(([k, v]) => [k, String(v), true]);
  const sync = () => { for (const k of Object.keys(obj)) delete obj[k]; for (const [k, v] of enabledPairs(rows)) obj[k] = v; onChange(); };
  return headerTable(rows, sync);
}
function listEditor(arr, onChange, placeholder) {
  return h('textarea', { class: 'mono', rows: 2, spellcheck: false, placeholder, value: (arr || []).join('\n'),
    oninput: (ev) => { arr.length = 0; arr.push(...ev.target.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)); onChange(); } });
}
function renderREditor() {
  const box = clear($('rEditor'));
  const ed = R.ed;
  if (R.sel == null || !ed) {
    box.append(h('div', { class: 'empty' }, h('p', null, h('b', null, 'Выберите правило для изменения или создайте новое.')),
      h('p', { class: 'muted' }, 'Правила выполняются в MITM для каждого подходящего запроса проксируемого Chrome. Чем выше приоритет, тем раньше выполнение.'),
      h('button', { class: 'btn primary', onclick: () => openRule('new') }, '+ Новое правило')));
    return;
  }
  const changed = () => { const d = $('rDirty'); if (d) d.hidden = !rDirty(); };
  const p = ed.params;
  box.append(h('div', { class: 'edit-head' }, h('h2', { class: 'ell' }, ed.id != null ? ed.name || 'Правило' : 'Новое правило'),
    ed.id != null ? h('button', { class: 'btn sm', onclick: guard(async () => { const row = ruleRow(ed); delete row.id; row.name = `${row.name} (копия)`; const { id } = await post('/api/rules', row); R.sel = id; R.ed = null; await loadRules(); toast('Дублировано', 'ok'); }) }, 'Дублировать') : null,
    ed.id != null ? h('button', { class: 'btn sm danger', onclick: guard(async () => { if (!(await confirmBox(`Удалить правило «${ed.name}»?`, 'Удалить', true))) return; await del(`/api/rules/${ed.id}`); R.sel = null; R.ed = null; await loadRules(); toast('Удалено', 'ok'); }) }, 'Удалить') : null));

  const form = h('div', { class: 'form' });
  form.append(...field('Включено', sw(ed.enabled, '', (v) => { ed.enabled = v; changed(); })));
  form.append(...field('Название', h('input', { value: ed.name, placeholder: 'Что делает это правило', oninput: (ev) => { ed.name = ev.target.value; changed(); } })));
  const typeSel = h('select', { onchange: (ev) => { ed.type = ev.target.value; ed.params = RULE_TEMPLATES[ed.type](); renderREditor(); changed(); } },
    RULE_TYPES.map(([v, l]) => h('option', { value: v, selected: v === ed.type }, l)));
  form.append(...field('Действие', typeSel, (RULE_TYPES.find((t) => t[0] === ed.type) || [])[2]));
  form.append(...field('Шаблон URL', h('input', { class: 'mono', value: ed.url_pattern, spellcheck: false, placeholder: 'https://example.com/api/  ·  *://*.example.com/*  ·  *',
    oninput: (ev) => { ed.url_pattern = ev.target.value; changed(); } }), 'URL без * совпадает с этим origin и префиксом пути (строка запроса игнорируется). * — подстановка по всему URL.'));
  const mBox = h('div', { class: 'inline' });
  const paintMethods = () => {
    append(clear(mBox), [h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !ed.methods.length, onchange: () => { ed.methods = []; paintMethods(); changed(); } }), 'Любой'),
      METHODS.map((m) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: ed.methods.includes(m), onchange: (ev) => {
        ed.methods = ev.target.checked ? [...ed.methods, m] : ed.methods.filter((x) => x !== m); paintMethods(); changed();
      } }), h('span', { class: `m m-${m}` }, m)))]);
  };
  paintMethods();
  form.append(...field('Методы', mBox));

  // ── action-specific ──
  if (ed.type === 'inject') {
    form.append(...field('Позиция', seg([['head', 'Начало <head>'], ['body-end', 'Конец <body>']], p.position || 'head', (v) => { p.position = v; renderREditor(); changed(); })));
    form.append(...field('Скрипт', h('textarea', { class: 'code', spellcheck: false, value: p.source || '', oninput: (ev) => { p.source = ev.target.value; changed(); } }), null, true));
  } else if (ed.type === 'mock') {
    form.append(...field('Статус', h('input', { type: 'number', min: 100, max: 599, value: p.status ?? 200, oninput: (ev) => { p.status = Number(ev.target.value) || 200; changed(); } })));
    form.append(h('datalist', { id: 'mimes' }, ['application/json', 'text/html; charset=utf-8', 'text/plain; charset=utf-8', 'application/javascript', 'text/css', 'image/svg+xml'].map((m) => h('option', { value: m }))));
    form.append(...field('Content-Type', h('input', { class: 'mono', list: 'mimes', value: p.mimeType || '', oninput: (ev) => { p.mimeType = ev.target.value; changed(); } })));
    form.append(...field('Тело', h('textarea', { class: 'code', spellcheck: false, value: p.body || '', oninput: (ev) => { p.body = ev.target.value; changed(); } }), null, true));
  } else if (ed.type === 'modifyHeaders') {
    for (const k of ['requestHeaders', 'responseHeaders']) p[k] = p[k] || {};
    for (const k of ['removeRequestHeaders', 'removeResponseHeaders']) p[k] = p[k] || [];
    form.append(...field('Задать в запросе', kvObjEditor(p.requestHeaders, changed), null, true));
    form.append(...field('Убрать из запроса', listEditor(p.removeRequestHeaders, changed, 'По одному имени заголовка в строке'), null, true));
    form.append(...field('Задать в ответе', kvObjEditor(p.responseHeaders, changed), null, true));
    form.append(...field('Убрать из ответа', listEditor(p.removeResponseHeaders, changed, 'напр. content-security-policy'), null, true));
  } else if (ed.type === 'script') {
    form.append(...field('Перед запросом', h('textarea', { class: 'code short', spellcheck: false, value: p.beforeSource || '', oninput: (ev) => { p.beforeSource = ev.target.value; changed(); } }), 'ctx.url, ctx.method, ctx.headers, ctx.body; задайте ctx.shortCircuit = { statusCode, headers, body }, чтобы ответить без сети.', true));
    form.append(...field('После ответа', h('textarea', { class: 'code short', spellcheck: false, value: p.afterSource || '', oninput: (ev) => { p.afterSource = ev.target.value; changed(); } }), 'ctx.request, ctx.response.statusCode, ctx.response.headers, ctx.response.bodyBase64 (или задайте ctx.response.body).', true));
  }

  // ── conditions + behaviour ──
  const mhBox = h('div');
  const paintMh = () => {
    clear(mhBox);
    ed.matchHeaders.forEach((m, i) => {
      mhBox.append(h('div', { class: 'inline', style: 'margin-bottom:4px' },
        h('input', { class: 'mono', value: m.key || '', placeholder: 'header', style: 'width:150px', oninput: (ev) => { m.key = ev.target.value; changed(); } }),
        h('select', { onchange: (ev) => { m.op = ev.target.value; paintMh(); changed(); } }, [['eq', 'равно'], ['contains', 'содержит'], ['regex', 'соответствует regex'], ['exists', 'присутствует'], ['notexists', 'отсутствует']].map(([v, l]) => h('option', { value: v, selected: (m.op || 'eq') === v }, l))),
        /exists/.test(m.op || '') ? null : h('input', { class: 'mono grow', value: m.value || '', placeholder: 'значение', oninput: (ev) => { m.value = ev.target.value; changed(); } }),
        h('button', { class: 'icon', onclick: () => { ed.matchHeaders.splice(i, 1); paintMh(); changed(); } }, '✕')));
    });
    mhBox.append(h('button', { class: 'btn sm ghost', onclick: () => { ed.matchHeaders.push({ key: '', op: 'eq', value: '' }); paintMh(); } }, '+ Условие по заголовку'));
  };
  paintMh();
  const cond = h('div', { class: 'form' });
  cond.append(...field('Заголовки запроса', mhBox, null, true));
  cond.append(...field('Тело запроса', h('div', { class: 'inline' },
    h('select', { onchange: (ev) => { ed.matchBody.mode = ev.target.value; changed(); } }, [['', 'любое тело'], ['contains', 'содержит'], ['regex', 'соответствует regex']].map(([v, l]) => h('option', { value: v, selected: ed.matchBody.mode === v }, l))),
    h('input', { class: 'mono grow', value: ed.matchBody.value || '', placeholder: 'текст или regex', oninput: (ev) => { ed.matchBody.value = ev.target.value; changed(); } }))));
  cond.append(...field('Приоритет', h('input', { type: 'number', value: ed.priority, oninput: (ev) => { ed.priority = Number(ev.target.value) || 0; changed(); } }), 'Чем выше, тем раньше выполнение.'));
  cond.append(...field('Задержка', h('div', { class: 'inline' }, h('input', { type: 'number', min: 0, max: 60000, value: ed.delay_ms, oninput: (ev) => { ed.delay_ms = Number(ev.target.value) || 0; changed(); } }), h('span', { class: 'muted' }, 'мс перед действием'))));
  cond.append(...field('Остановиться при совпадении', sw(ed.stop_on_match, 'Не выполнять правила с меньшим приоритетом после этого', (v) => { ed.stop_on_match = v; changed(); })));
  if (ed.type !== 'pause') cond.append(...field('Пауза', sw(ed.breakpoint_enabled, 'Также задерживать подходящие запросы в «Точках останова»', (v) => { ed.breakpoint_enabled = v; changed(); })));
  cond.append(...field('Группа', h('input', { value: ed.group_name, placeholder: 'необязательно', oninput: (ev) => { ed.group_name = ev.target.value; changed(); } })));

  const adv = h('textarea', { class: 'code short', spellcheck: false, value: JSON.stringify(ruleRow(ed).params, null, 2) });
  const advBox = h('details', { class: 'sect' }, h('summary', null, 'Params JSON (продвинутое)'), adv,
    h('div', { class: 'row-end' }, h('button', { class: 'btn sm', onclick: guard(() => {
      const obj = JSON.parse(adv.value || '{}');
      const next = edFromRule({ ...ruleRow(ed), params: obj, id: ed.id });
      next.type = ed.type; Object.assign(ed, { params: next.params, matchHeaders: next.matchHeaders, matchBody: next.matchBody });
      renderREditor(); changed(); toast('Параметры применены', 'ok');
    }) }, 'Применить JSON')));
  advBox.addEventListener('toggle', () => { if (advBox.open) adv.value = JSON.stringify(ruleRow(ed).params, null, 2); });

  box.append(form, h('h3', null, 'Условия и поведение'), cond, advBox);
  const saveBtn = h('button', { class: 'btn primary', onclick: guard(() => busy(saveBtn, 'Сохранение…', async () => {
    const row = ruleRow(ed);
    if (!row.name) throw new Error('Дайте правилу название');
    if (!row.url_pattern) throw new Error('Шаблон URL обязателен');
    const { id } = await post('/api/rules', row);
    R.sel = id; R.ed = null; await loadRules(); toast('Правило сохранено', 'ok');
  })) }, 'Сохранить правило');
  box.append(h('div', { class: 'row-end', style: 'justify-content:flex-start' }, saveBtn, h('span', { id: 'rDirty', class: 'muted', hidden: !rDirty() }, 'несохранённые изменения')));
}
$('rExport').addEventListener('click', guard(async () => {
  const rules = (await api('/api/rules')).map(({ id, hit_count, last_hit_at, last_error, created_at, ...r }) => r);
  download(new Blob([JSON.stringify({ cupnetRules: 1, rules }, null, 2)], { type: 'application/json' }), 'cupnet-rules.json');
}));
$('rImport').addEventListener('click', () => {
  const ta = h('textarea', { class: 'code', spellcheck: false, placeholder: 'Вставьте экспортированный JSON правил или выберите файл' });
  const file = h('input', { type: 'file', accept: '.json,application/json', onchange: async (ev) => { const f = ev.target.files[0]; if (f) ta.value = await f.text(); } });
  modal('Импорт правил', h('div', null, file, ta), [{ label: 'Отмена' }, { label: 'Импорт', cls: 'primary', fn: async () => {
    const j = JSON.parse(ta.value);
    const list = Array.isArray(j) ? j : Array.isArray(j?.rules) ? j.rules : null;
    if (!list) throw new Error('Ожидался массив правил или { rules: [...] }');
    let ok = 0; const errs = [];
    for (const r of list) {
      const { id, hit_count, last_hit_at, last_error, created_at, ...row } = r || {};
      try { await post('/api/rules', row); ok++; } catch (e) { errs.push(`${row.name || '?'}: ${e.message}`); }
    }
    await loadRules();
    toast(`Импортировано правил: ${ok}${errs.length ? ` · с ошибкой: ${errs.length}: ${errs.slice(0, 2).join('; ')}` : ''}`, errs.length ? 'warn' : 'ok');
  } }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Breakpoints
// ─────────────────────────────────────────────────────────────────────────────
const BP = { items: [], sel: null, ed: null };
async function loadPaused() {
  BP.items = await api('/api/breakpoints');
  if (BP.sel && !BP.items.some((b) => b.id === BP.sel)) { BP.sel = null; BP.ed = null; renderBpEditor(); }
  if (!BP.sel && BP.items.length) openBp(BP.items[0].id);
  renderBpList();
}
function renderBpList() {
  const box = clear($('bplist'));
  if (!BP.items.length) { box.append(h('div', { class: 'empty' }, 'Нет остановленных запросов.')); return; }
  for (const b of BP.items) {
    const left = Math.max(0, Math.round((b.timeoutMs - (Date.now() - b.at)) / 1000));
    const [host, path] = splitUrl(b.url);
    box.append(h('div', { class: `prow${BP.sel === b.id ? ' sel' : ''}`, onclick: () => openBp(b.id) },
      h('i', { class: 'dot warn' }),
      h('div', { style: 'min-width:0' }, h('div', { class: 'title' }, h('span', { class: `m m-${b.method}` }, b.method), h('b', { title: b.url }, path)),
        h('div', { class: 'meta' }, h('span', null, host), h('span', { class: 'faint' }, `правило: ${b.ruleName}`))),
      h('div', { class: 'acts mono muted' }, `${left}s`)));
  }
}
function openBp(id) {
  const b = BP.items.find((x) => x.id === id); if (!b) return;
  BP.sel = id;
  BP.ed = { method: b.method, url: b.url, rows: b.headers.map(([k, v]) => [k, v, true]), body: b.body, binary: String(b.body).startsWith('__b64__:') };
  renderBpList(); renderBpEditor();
}
function renderBpEditor() {
  const box = clear($('bpEditor'));
  const ed = BP.ed;
  if (!ed) { box.append(h('div', { class: 'empty' }, 'Ничего не остановлено. Добавьте правило с действием ', h('b', null, 'Пауза'), ' или используйте ', h('b', null, 'Остановить на URL'), ' в Трафике.')); return; }
  const resume = (action, edited) => guard(async () => {
    const body = edited ? { action, method: ed.method, url: ed.url, headers: enabledPairs(ed.rows), ...(ed.binary ? {} : { body: ed.body }) } : { action };
    await post(`/api/breakpoints/${BP.sel}`, body);
    toast(action === 'block' ? 'Заблокировано' : edited ? 'Пропущено с вашими изменениями' : 'Пропущено', action === 'block' ? 'warn' : 'ok');
    BP.sel = null; BP.ed = null; renderBpEditor(); await loadPaused(); pollStatus();
  });
  box.append(h('div', { class: 'edit-head' }, h('h2', null, 'Остановленный запрос'),
    h('button', { class: 'btn primary', onclick: resume('forward', true) }, 'Пропустить'),
    h('button', { class: 'btn', onclick: resume('forward', false) }, 'Пропустить без изменений'),
    h('button', { class: 'btn danger', onclick: resume('block', false) }, 'Заблокировать')));
  const form = h('div', { class: 'form' });
  form.append(...field('Метод', h('input', { class: 'mono', value: ed.method, style: 'width:120px', oninput: (ev) => { ed.method = ev.target.value.toUpperCase(); } })));
  form.append(...field('URL', h('input', { class: 'mono', value: ed.url, spellcheck: false, oninput: (ev) => { ed.url = ev.target.value; } })));
  form.append(...field('Заголовки', headerTable(ed.rows), null, true));
  form.append(...field('Тело', ed.binary ? h('div', { class: 'note' }, 'Бинарное тело — пропускается без изменений.') : h('textarea', { class: 'code short', spellcheck: false, value: ed.body, oninput: (ev) => { ed.body = ev.target.value; } }), null, true));
  box.append(form);
}
setInterval(() => {
  if (PAGE === 'paused') guard(loadPaused)();
}, 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────
async function loadSessions() {
  const sessions = await fillSessionSelect();
  const tb = clear($('sessions'));
  for (const s of sessions) {
    const isLive = s.id === current;
    const viewing = (shown || current) === s.id;
    const btn = (label, fn, title) => h('button', { class: 'btn sm', title, onclick: guard(fn) }, label);
    tb.append(h('tr', null,
      h('td', { title: s.keyId ? `id ключа ${s.keyId}` : '' }, h('span', { class: 'mono' }, s.id), isLive ? [' ', tag('эфир', 'ok')] : null, viewing ? [' ', tag('просмотр', 'accent')] : null),
      h('td', null, fmtSize(s.bytes) || '0 B'),
      h('td', null, new Date(s.mtime).toLocaleString()),
      h('td', null, s.sealed ? tag('запечатана', 'ok') : ''),
      h('td', null,
        btn('Открыть', () => { openSession(s.id); go('traffic'); }),
        btn('HAR', async (ev) => busy(ev.target, '…', async () => download((await apiBlob(`/api/sessions/${s.id}/har`)).blob, `cupnet-${s.id}.har`)), 'Экспорт в HAR 1.2'),
        btn('JSONL', async () => download((await apiBlob(`/api/sessions/${s.id}`)).blob, `cupnet-${s.id}.jsonl`), 'Сырой лог сессии'),
        btn('Запечатать', async () => {
          const r = await post(`/api/sessions/${s.id}/seal`);
          for (const [what, name] of [['key', `${r.id}.cupkey`], ['sealed', `${r.id}.cupsess`]]) download((await apiBlob(`/api/sessions/${s.id}/${what}`)).blob, name);
          toast('Запечатано: храните .cupkey отдельно от .cupsess', 'ok');
          loadSessions();
        }, 'Зашифровать собственным ключом сессии и скачать оба файла'),
        btn('Поделиться', (ev) => shareSession(s.id, ev.target), 'Запечатать и получить ссылку для локального хоста обмена (viewer.html)'))));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────
// Guide — static reference page; only the version/date and session id come from /api/status.
async function loadGuide() {
  const st = ST || await api('/api/status');
  if (st.version) $('guideVer').textContent = st.version;
  if (st.released) $('guideDate').textContent = st.released;
  const sess = $('guideSess');
  if (sess) {
    sess.hidden = !st.sessionId;
    if (st.sessionId) clear(sess).append('Сессия ', h('b', null, cutText(st.sessionId, 16)));
  }
}

const S = { data: null, browser: null };
async function loadSettings() {
  const s = await api('/api/settings');
  S.data = s; S.browser = s.browser;
  renderTls();
  $('tlsCli').hidden = !s.browserFromCli;
  $('sCors').checked = !!s.cors; $('sH1').checked = !!s.forceHttp1;
  $('sIpWatch').checked = s.ipWatch !== false; $('sIpSec').value = s.ipWatchSec || 15;
  $('sPass').value = (s.tlsPassthrough || []).join('\n');
  $('sAgent').checked = !!s.pageAgent; $('sAgentEx').value = (s.pageAgentExclude || []).join('\n');
  renderShareState(s);
  const st = ST || await api('/api/status');
  const caSt = await api('/api/ca/status').catch(() => null);
  const trustText = (caSt?.trust || st.trust) === 'system'
    ? 'CupNet CA в системном хранилище доверия'
    : 'SPKI-пин в выделенном профиле Chrome (ничего не ставится в систему)';
  const setup = clear($('setup'));
  const row = (k, v) => [h('div', null, k), h('div', null, v)];
  setup.append(h('h2', null, 'Настройка'), h('div', { class: 'setup-grid' },
    row('Прокси для Chrome', h('code', null, `http://127.0.0.1:${st.mitmPort}`)),
    row('Доверие к сертификату', trustText),
    row('Файл CA', h('code', null, st.ca.certPath)),
    row('CA SHA-256', h('code', null, st.ca.sha256)),
    row('CA SPKI', h('code', null, st.ca.spki)),
    row('Файл правил', h('code', null, st.rulesFile)),
    row('Каталог данных', h('code', null, st.dataDir))),
  h('h3', null, 'Сертификат CupNet CA'), caInstallPanel(caSt, st));
}

/**
 * One-click CA install. When the CA is not yet trusted, offers a button that asks the app to install
 * it (the OS shows its own password dialog). When it is trusted, confirms and shows the remove command.
 */
function caInstallPanel(caSt, st) {
  const wrap = h('div', { class: 'ca-setup' });
  if (!caSt) {
    wrap.append(h('p', { class: 'muted' }, 'Не удалось получить статус сертификата.'),
      h('h4', null, 'Установить вручную'), h('pre', { class: 'codebox' }, st.ca.commands.install));
    return wrap;
  }
  if (caSt.supported === false) {
    wrap.append(h('p', { class: 'muted' }, 'Автоустановка недоступна на этой системе (нужен NSS certutil). Установите CA вручную:'),
      h('pre', { class: 'codebox' }, caSt.commands.install));
    return wrap;
  }
  if (caSt.trusted) {
    wrap.append(
      h('p', null, '✓ Сертификат установлен и доверен — Chrome запускается без предупреждающего баннера.'),
      h('p', { class: 'muted' }, 'Чтобы удалить его из системы, выполните в терминале:'),
      h('pre', { class: 'codebox' }, caSt.commands.remove));
    return wrap;
  }
  const btn = h('button', { class: 'btn primary' }, 'Установить сертификат');
  btn.onclick = async () => {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Устанавливаю…';
    toast('Подтвердите пароль в системном окне', 'warn', { ms: 6000 });
    try {
      const r = await post('/api/ca/install');
      if (r && r.ok) {
        toast('Сертификат установлен', 'ok');
        toast('Закройте окна Chrome CupNet и откройте заново, чтобы убрать баннер', 'ok', { ms: 9000 });
        await loadSettings();
      } else {
        toast((r && r.error) || 'Не удалось установить сертификат', 'err');
        btn.disabled = false; btn.textContent = old;
      }
    } catch (e) {
      toast(e.message || 'Не удалось установить сертификат', 'err');
      btn.disabled = false; btn.textContent = old;
    }
  };
  wrap.append(
    h('p', null, 'Chrome показывает предупреждение про флаг командной строки, потому что сертификат CupNet ещё не в системе. Установите его — предупреждение исчезнет, и Chrome будет доверять сертификатам CupNet как обычным.'),
    btn);
  return wrap;
}
function renderTls() {
  const box = clear($('tlsProfiles'));
  for (const p of S.data.tlsProfiles) {
    box.append(h('div', { class: `radio${S.browser === p.id ? ' on' : ''}`, onclick: () => { S.browser = p.id; renderTls(); } },
      h('b', null, p.name), h('span', { class: 'muted' }, p.note)));
  }
}
function renderShareState(s) {
  const sh = s.share || {};
  $('sShare').checked = !!s.shareHost; $('sSharePort').value = s.sharePort || sh.port || 8879;
  const el = clear($('sShareState'));
  if (sh.running) el.append('Раздаётся по ', h('code', null, sh.url), ' (только этот компьютер).');
  else if (sh.error) el.append(h('span', { class: 'err' }, `Не запущено: ${sh.error}`));
  else el.append('Выключено.');
}
async function saveSettings(btn) {
  const patch = {
    cors: $('sCors').checked, forceHttp1: $('sH1').checked, ipWatch: $('sIpWatch').checked, ipWatchSec: Number($('sIpSec').value) || 15,
    tlsPassthrough: $('sPass').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
    pageAgent: $('sAgent').checked, pageAgentExclude: $('sAgentEx').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
    shareHost: $('sShare').checked, sharePort: Number($('sSharePort').value) || 8879 };
  if (S.browser && S.browser !== S.data?.browser) patch.browser = S.browser;
  await busy(btn, 'Сохранение…', async () => { S.data = await post('/api/settings', patch); });
  renderShareState(S.data);
  S.browser = S.data.browser; renderTls(); $('tlsCli').hidden = !S.data.browserFromCli;
  $('sPass').value = (S.data.tlsPassthrough || []).join('\n');
  $('sAgentEx').value = (S.data.pageAgentExclude || []).join('\n');
  toast('Настройки сохранены — применяются к новым соединениям', 'ok');
}
$('sSave').addEventListener('click', guard(() => saveSettings($('sSave'))));
$('sSave2').addEventListener('click', guard(() => saveSettings($('sSave2'))));

// ─────────────────────────────────────────────────────────────────────────────
// Compare two requests
// ─────────────────────────────────────────────────────────────────────────────
// A side is { seq, sid }: sid is the session id, so a pin survives switching sessions in Traffic.
const CMP = { a: null, b: null, ea: null, eb: null, key: '', gen: 0, only: store.get('cmp-only', true), vol: store.get('cmp-vol', true), modes: {} };
let PIN = null;
const CMP_TEXT_MAX = 8 * 1048576;
const sideLabel = (e) => `#${e.seq} ${e.method || ''} ${splitUrl(e.url)[1]}`;
const sideKey = (s) => `${s.sid}:${s.seq}`;
function renderPinChip() {
  const c = clear($('pinChip'));
  c.hidden = !PIN;
  if (!PIN) return;
  c.title = `Сторона A следующего сравнения (сессия ${PIN.sid})`;
  c.append(h('b', null, 'A'), h('span', { class: 'mono ell' }, PIN.label),
    h('button', { class: 'icon', title: 'Открепить', onclick: () => { PIN = null; renderPinChip(); } }, '✕'));
}
function openCompare(a, b) {
  CMP.a = a; CMP.b = b; CMP.modes = {};
  go('compare');
}
function previousSame(e) {
  const key = originPath(e.url);
  for (let i = Math.min(bySeq.get(e.seq) ?? all.length, all.length) - 1; i >= 0; i--) {
    const x = all[i];
    if (x.kind === 'request' && x.seq < e.seq && x.method === e.method && originPath(x.url) === key) return x;
  }
  return null;
}
$('aPin').addEventListener('click', () => {
  const e = dEntry; if (!e) return;
  PIN = { seq: e.seq, sid: shown || current, label: sideLabel(e) };
  renderPinChip();
  toast(`#${e.seq} закреплён как A — выберите другой запрос и нажмите «Сравнить»`, 'ok');
});
$('aCompare').addEventListener('click', () => {
  const e = dEntry; if (!e) return;
  const sid = shown || current;
  if (PIN && !(PIN.seq === e.seq && PIN.sid === sid)) { openCompare({ seq: PIN.seq, sid: PIN.sid }, { seq: e.seq, sid }); return; }
  const prev = previousSame(e);
  if (!prev) { toast('Не с чем сравнивать: сначала закрепите запрос как A или нажмите Cmd/Ctrl по второй строке', 'warn'); return; }
  openCompare({ seq: prev.seq, sid }, { seq: e.seq, sid });
});
$('cmpSwap').addEventListener('click', () => {
  if (!CMP.a || !CMP.b) return;
  [CMP.a, CMP.b, CMP.ea, CMP.eb] = [CMP.b, CMP.a, CMP.eb, CMP.ea];
  CMP.key = CMP.ea && CMP.eb ? `${sideKey(CMP.a)}|${sideKey(CMP.b)}` : '';
  CMP.modes = {};
  guard(loadCompare)();
});
const cmpFromInputs = () => {
  const a = Number($('cmpA').value), b = Number($('cmpB').value);
  if (!(a > 0 && b > 0)) { toast('Введите два номера запросов', 'warn'); return; }
  const sid = shown || current;
  openCompare({ seq: a, sid }, { seq: b, sid });
};
$('cmpLoad').addEventListener('click', cmpFromInputs);
for (const id of ['cmpA', 'cmpB']) $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') cmpFromInputs(); });

function renderCmpOpts() {
  clear($('cmpOpts')).append(
    sw(CMP.only, 'Только различия', (v) => { CMP.only = v; store.set('cmp-only', v); renderCompare(); }, 'Скрыть одинаковые строки и неизменные строки тела'),
    ' ',
    sw(CMP.vol, 'Игнорировать изменчивые заголовки', (v) => { CMP.vol = v; store.set('cmp-vol', v); renderCompare(); }, 'Date, ETag, CF-Ray, id запросов, Content-Length и другие заголовки, меняющиеся каждый раз'));
}
async function loadCompare() {
  renderCmpOpts();
  $('cmpA').value = CMP.a?.seq ?? ''; $('cmpB').value = CMP.b?.seq ?? '';
  if (!CMP.a || !CMP.b) return;
  const key = `${sideKey(CMP.a)}|${sideKey(CMP.b)}`;
  if (key === CMP.key && CMP.ea && CMP.eb) { renderCompare(); return; }
  const my = ++CMP.gen;
  clear($('cmpBody')).append(h('div', { class: 'empty' }, 'Загрузка…'));
  const get = (s) => api(`/api/log/${s.seq}?session=${encodeURIComponent(s.sid)}`);
  try {
    const [ea, eb] = await Promise.all([get(CMP.a), get(CMP.b)]);
    if (my !== CMP.gen) return;
    if (ea.kind !== 'request' || eb.kind !== 'request') throw new Error('Сравнивать можно только запросы — один из этих элементов является событием');
    CMP.ea = ea; CMP.eb = eb; CMP.key = key;
    renderCompare();
  } catch (err) {
    if (my !== CMP.gen) return;
    CMP.key = '';
    clear($('cmpBody')).append(h('div', { class: 'note warn' }, err.message));
  }
}

/** Common head and tail of two strings → nodes with the differing middle marked (long text is cut around it). */
function inlineDiff(x, y, ctx = 160, midMax = 4000) {
  x = String(x); y = String(y);
  const n = Math.min(x.length, y.length);
  let p = 0;
  while (p < n && x[p] === y[p]) p++;
  let s = 0;
  while (s < n - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const side = (t) => {
    const from = Math.max(0, p - ctx), end = t.length - s, to = Math.min(t.length, end + ctx);
    const mid = t.slice(p, end);
    return [from > 0 ? h('span', { class: 'muted' }, `…${from.toLocaleString()} симв… `) : null, t.slice(from, p),
      mid ? h('span', { class: 'ihl' }, mid.length > midMax ? `${mid.slice(0, midMax)}… [ещё ${(mid.length - midMax).toLocaleString()}]` : mid) : null,
      t.slice(end, to), to < t.length ? h('span', { class: 'muted' }, ` …${(t.length - to).toLocaleString()} симв…`) : null];
  };
  return [side(x), side(y)];
}
const cutText = (t, max = 4000) => (t.length > max ? [t.slice(0, max), h('span', { class: 'muted' }, ` … [ещё ${(t.length - max).toLocaleString()} симв.]`)] : t);
const DMARK = { same: '', changed: '~', added: '+', removed: '−', info: '' };

/** Name / A / B table of diffPairs-style rows ({name, a: string[]|null, b: string[]|null, state}). */
function diffTable(rows, o = {}) {
  const vis = CMP.only ? rows.filter((r) => r.state !== 'same' && r.state !== 'info') : rows;
  const box = h('div');
  const cell = (v, other, state) => {
    if (v == null) return h('span', { class: 'muted' }, '—');
    if (state === 'changed' && other && v.length === 1 && other.length === 1) return null;
    return v.map((x) => h('div', { class: 'dv' }, x === '' ? h('span', { class: 'muted' }, '(пусто)') : cutText(x)));
  };
  if (vis.length) {
    box.append(h('table', { class: 'tbl dtbl' },
      h('colgroup', null, h('col', { class: 'w-18' }), h('col', { class: o.wide ? 'w-300' : 'w-180' }), h('col'), h('col')),
      h('thead', null, h('tr', null, h('th'), h('th', null, o.name || 'Имя'), h('th', null, 'A'), h('th', null, 'B'))),
      h('tbody', null, vis.map((r) => {
        let ca = cell(r.a, r.b, r.state), cb = cell(r.b, r.a, r.state);
        if (ca === null) { const [x, y] = inlineDiff(r.a[0], r.b[0]); ca = h('div', { class: 'dv' }, x); cb = h('div', { class: 'dv' }, y); }
        return h('tr', { class: `d-${r.state}` }, h('td', { class: 'dm' }, DMARK[r.state] || ''), h('td', { class: 'mono dn', title: r.name }, r.name), h('td', { class: 'mono' }, ca), h('td', { class: 'mono' }, cb));
      }))));
  }
  const hidden = rows.length - vis.length;
  if (!rows.length) box.append(h('div', { class: 'muted pad' }, o.empty || 'Нет ни с одной стороны'));
  else if (!vis.length) box.append(h('div', { class: 'muted pad' }, `Все ${rows.length} одинаковы`));
  else if (hidden) box.append(h('div', { class: 'muted pad' }, `${hidden} одинаковых скрыто`));
  return box;
}
const toRows = (r) => r.rows;
const cntTag = (n) => (n == null ? tag('…') : n ? tag(`${n} ${cmpDiffPlural(n)}`, 'warn') : tag('одинаково', 'ok'));
// Russian plural for "различие" (difference)
const cmpDiffPlural = (n) => { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return 'различий'; if (b > 1 && b < 5) return 'различия'; if (b === 1) return 'различие'; return 'различий'; };

function renderCompare() {
  const a = CMP.ea, b = CMP.eb, D = window.CupNetDiff;
  if (!a || !b) return;
  const root = clear($('cmpBody'));
  if (!D) { root.append(h('div', { class: 'note warn' }, 'Библиотека diff не загрузилась (/lib/diff.js)')); return; }
  const vol = (extra) => new Set([...(CMP.vol ? D.VOLATILE : []), ...extra]);

  // ── both sides ──
  const sideCard = (e, s, letter) => h('div', { class: 'cmp-side' },
    h('div', { class: 'cmp-line' }, h('b', { class: `cmp-k k-${letter}` }, letter), badge(e.method, `m-${e.method}`), badge(String(e.status || 'ERR'), stCls(e.status)),
      h('span', { class: 'muted mono' }, `#${e.seq}`), h('span', { class: 'muted' }, fmtTime(e.ts)), e.duration != null ? h('span', { class: 'muted' }, `${e.duration} ms`) : null,
      s.sid !== (shown || current) ? tag(s.sid === current ? 'эфирная сессия' : s.sid, 'accent') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', title: 'Показать этот запрос в Трафике', onclick: () => cmpShowInTraffic(s) }, 'Трафик'),
      h('button', { class: 'btn sm', title: 'Открыть этот запрос в Репитере', onclick: guard(async () => {
        rpLoad({ method: e.method, url: e.url, headers: sendableHeaders(e.requestHeaders), body: isB64Body(e.requestBody) ? '' : await cmpBodyText(e, 'request', s.sid) });
        go('repeater');
      }) }, 'Репитер')),
    h('div', { class: 'mono cmp-url', title: e.url }, e.url));
  root.append(h('div', { class: 'cmp-sides' }, sideCard(a, CMP.a, 'A'), sideCard(b, CMP.b, 'B')));
  const nav = h('div', { class: 'cmp-nav' });
  root.append(nav);

  const sections = [];
  const section = (id, title, n, content, note = null) => {
    const t = cntTag(n);
    const el = h('div', { class: 'card cmp-sec', id: `cmp-${id}` }, h('div', { class: 'card-head' }, h('h2', null, title), t, note ? h('span', { class: 'muted' }, note) : null), content);
    const chip = h('button', { class: `cmp-chip${n ? ' is-diff' : n === 0 ? ' is-same' : ''}`, onclick: () => el.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, title, n ? h('i', null, n) : null);
    nav.append(chip);
    sections.push(el);
    root.append(el);
    let tagNode = t;
    return (m) => {
      const nt = cntTag(m); tagNode.replaceWith(nt); tagNode = nt;
      chip.className = `cmp-chip${m ? ' is-diff' : m === 0 ? ' is-same' : ''}`;
      append(clear(chip), [title, m ? h('i', null, m) : null]);
    };
  };

  // Overview: sizes as sizes; duration and size only inform.
  // summaryRows returns English keys as names; map them to Russian display labels here.
  const OV_LABELS = { Method: 'Метод', URL: 'URL', Status: 'Статус', Type: 'Тип', MIME: 'MIME', Duration: 'Длительность', 'Request body': 'Тело запроса', 'Response body': 'Тело ответа' };
  const ov = D.summaryRows(a, b).map((r) => {
    const size = /body$/.test(r.name);
    const row = { name: OV_LABELS[r.name] || r.name, a: [size ? fmtSize(Number(r.a)) || '0 B' : r.a], b: [size ? fmtSize(Number(r.b)) || '0 B' : r.b], state: r.state };
    if ((size || r.name === 'Duration') && r.state === 'changed') row.state = 'info';
    return row;
  });
  if (a.error || b.error) ov.push({ name: 'Ошибка', a: [String(a.error || '')], b: [String(b.error || '')], state: String(a.error || '') === String(b.error || '') ? 'same' : 'changed' });
  section('overview', 'Обзор', ov.filter((r) => r.state === 'changed').length, diffTable(ov, { name: 'Поле' }));

  const q = D.diffPairs(D.queryPairs(a.url), D.queryPairs(b.url), { caseless: false });
  section('query', 'Строка запроса', q.differences, diffTable(q.rows, { name: 'Параметр', empty: 'Строки запроса нет ни с одной стороны' }));

  const rh = D.diffPairs(D.pairsOf(a.requestHeaders), D.pairsOf(b.requestHeaders), { ignore: vol(['cookie']) });
  const ord = D.orderDiff(D.pairsOf(a.requestHeaders).map(([k]) => k), D.pairsOf(b.requestHeaders).map(([k]) => k));
  const rhBox = h('div', null, diffTable(rh.rows, { empty: 'Нет заголовков запроса' }), orderView(ord));
  section('reqh', 'Заголовки запроса', rh.differences + (ord.same ? 0 : 1), rhBox, 'Cookie сравнивается ниже');

  const ck = D.diffPairs(D.cookiePairs(a.requestHeaders), D.cookiePairs(b.requestHeaders), { caseless: false });
  section('cookies', 'Cookie запроса', ck.differences, diffTable(ck.rows, { name: 'Cookie', empty: 'Заголовка Cookie нет ни с одной стороны' }));

  const setReqBody = section('reqb', 'Тело запроса', null, bodyDiff(a, b, 'request', (n) => setReqBody(n)));

  const sh = D.diffPairs(D.pairsOf(a.responseHeaders), D.pairsOf(b.responseHeaders), { ignore: vol(['set-cookie']) });
  section('resh', 'Заголовки ответа', sh.differences, diffTable(sh.rows, { empty: 'Нет заголовков ответа' }), CMP.vol ? 'изменчивые заголовки игнорируются' : null);

  const sc = D.diffPairs(D.setCookiePairs(a.responseHeaders), D.setCookiePairs(b.responseHeaders), { caseless: false });
  section('setc', 'Set-Cookie', sc.differences, diffTable(sc.rows, { name: 'Cookie', empty: 'Set-Cookie нет ни с одной стороны' }));

  const setResBody = section('resb', 'Тело ответа', null, bodyDiff(a, b, 'response', (n) => setResBody(n)));
}
function cmpShowInTraffic(s) {
  if (s.sid !== (shown || current)) openSession(s.sid);
  go('traffic');
  revealSeq = s.seq;
  select(s.seq);
}
function orderView(o) {
  if (o.same) return h('div', { class: 'muted pad' }, 'Порядок заголовков: одинаков для заголовков, которые отправляют оба запроса');
  const list = (names, other) => {
    const inOther = new Set(other);
    return h('ol', { class: 'ord mono' }, names.map((n) => h('li', { class: o.moved.has(n) ? 'moved' : inOther.has(n) ? '' : 'only' }, n)));
  };
  return h('details', { class: 'sect ord-wrap', open: true }, h('summary', null, 'Порядок заголовков различается ', tag(`перемещено: ${o.moved.size}`, 'warn')),
    h('p', { class: 'muted' }, 'Анти-бот системы снимают отпечаток с порядка заголовков. Перемещённые заголовки отмечены; приглушённые есть только с одной стороны.'),
    h('div', { class: 'ord-cols' }, h('div', null, h('b', null, 'A'), list(o.a, o.b)), h('div', null, h('b', null, 'B'), list(o.b, o.a))));
}

async function cmpBodyText(e, which, sid) {
  const body = which === 'request' ? e.requestBody : e.responseBody;
  if (body == null || body === '') return '';
  if (!(which === 'request' ? e.requestBodyTruncated : e.responseBodyTruncated)) return String(body);
  return (await apiBlob(`/api/log/${e.seq}/body/${which}?session=${encodeURIComponent(sid)}`)).blob.text();
}
async function cmpBodyHash(e, which, sid) {
  const { blob } = await apiBlob(`/api/log/${e.seq}/body/${which}?session=${encodeURIComponent(sid)}`);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function bodyDiff(a, b, which, setCount) {
  const box = h('div', null, h('div', { class: 'muted pad' }, 'Загрузка тел…'));
  const sa = CMP.a.sid, sb = CMP.b.sid;
  const size = (e) => (which === 'request' ? e.reqSize : e.resSize) || 0;
  const ct = (e) => headerOf(which === 'request' ? e.requestHeaders : e.responseHeaders, 'content-type').toLowerCase();
  const raw = (e) => (which === 'request' ? e.requestBody : e.responseBody);
  const meta = h('div', { class: 'bodybar' },
    h('b', { class: 'cmp-k k-A' }, 'A'), tag(ct(a).split(';')[0] || 'нет content-type'), h('span', { class: 'muted' }, fmtSize(size(a)) || '0 B'),
    h('b', { class: 'cmp-k k-B' }, 'B'), tag(ct(b).split(';')[0] || 'нет content-type'), h('span', { class: 'muted' }, fmtSize(size(b)) || '0 B'));
  const done = (n, ...nodes) => { clear(box).append(meta, ...nodes); setCount(n); };
  (async () => {
    await null; // let the caller keep the section's setter before the first count arrives
    const ra = raw(a), rb = raw(b);
    const emptyA = ra == null || ra === '', emptyB = rb == null || rb === '';
    if (emptyA && emptyB) return done(0, h('div', { class: 'muted pad' }, 'Тела нет ни с одной стороны'));
    if (isB64Body(ra) || isB64Body(rb)) {
      if (emptyA || emptyB) return done(1, h('div', { class: 'note' }, `Тело (бинарное) есть только у ${emptyA ? 'B' : 'A'}.`));
      const [ha, hb] = await Promise.all([cmpBodyHash(a, which, sa), cmpBodyHash(b, which, sb)]);
      return done(ha === hb ? 0 : 1, h('div', { class: `note ${ha === hb ? '' : 'warn'}` }, ha === hb ? 'Бинарные тела идентичны' : 'Бинарные тела различаются',
        h('div', { class: 'mono muted' }, `A sha256 ${ha.slice(0, 16)}…  B sha256 ${hb.slice(0, 16)}…`)));
    }
    if (size(a) > CMP_TEXT_MAX || size(b) > CMP_TEXT_MAX) {
      const [ha, hb] = await Promise.all([cmpBodyHash(a, which, sa), cmpBodyHash(b, which, sb)]);
      return done(ha === hb ? 0 : 1, h('div', { class: 'note' }, `Слишком велико, чтобы сравнивать на странице (больше ${fmtSize(CMP_TEXT_MAX)}). Тела ${ha === hb ? 'идентичны' : 'различаются'}.`));
    }
    const [ta, tb] = await Promise.all([cmpBodyText(a, which, sa), cmpBodyText(b, which, sb)]);
    if (ta === tb) return done(0, h('div', { class: 'muted pad' }, `Идентично (${fmtSize(ta.length) || '0 B'})`));
    const D = window.CupNetDiff;
    const ja = D.tryJson(ta), jb = D.tryJson(tb);
    const isJson = ja !== undefined && jb !== undefined;
    const isForm = /x-www-form-urlencoded/.test(ct(a)) && /x-www-form-urlencoded/.test(ct(b));
    const modes = isJson ? [['struct', 'Структура'], ['lines', 'Строки']] : isForm ? [['fields', 'Поля'], ['lines', 'Строки']] : [];
    const mk = `${which}`;
    let mode = CMP.modes[mk] || (modes[0]?.[0] ?? 'lines');
    const content = h('div');
    const segBox = h('span');
    const paint = () => {
      clear(content);
      if (mode === 'struct') {
        const r = D.jsonDiff(ja, jb);
        const rows = r.rows.map((x) => ({ name: x.path, a: x.a === undefined ? null : [x.a], b: x.b === undefined ? null : [x.b], state: x.kind === 'type' ? 'changed' : x.kind }));
        content.append(diffTable(rows, { name: 'Путь', wide: true, empty: 'Одинаковый JSON' }));
        if (r.truncated) content.append(h('div', { class: 'note warn' }, `Показаны первые ${rows.length.toLocaleString()} различий`));
        return rows.length;
      }
      if (mode === 'fields') {
        const r = D.diffPairs([...new URLSearchParams(ta)], [...new URLSearchParams(tb)], { caseless: false });
        content.append(diffTable(r.rows, { name: 'Поле' }));
        return r.differences;
      }
      const pa = isJson ? JSON.stringify(ja, null, 2) : ta, pb = isJson ? JSON.stringify(jb, null, 2) : tb;
      const r = D.lineDiff(pa, pb);
      if (r.tooBig) {
        content.append(h('div', { class: 'note' }, 'Слишком разные, чтобы сравнивать построчно.'));
        return 1;
      }
      content.append(h('div', { class: 'muted pad' }, h('span', { class: 'ok' }, `+${r.added}`), ' ', h('span', { class: 'err' }, `−${r.removed}`), ' строк', isJson ? ' (форматированный JSON)' : ''),
        lineDiffView(r.ops));
      return r.added + r.removed;
    };
    const renderSeg = () => { clear(segBox); if (modes.length) segBox.append(seg(modes, mode, (v) => { mode = v; CMP.modes[mk] = v; renderSeg(); setCount(paint()); })); };
    meta.append(h('span', { class: 'spacer' }), segBox);
    renderSeg();
    done(paint(), content);
  })().catch((err) => done(null, h('div', { class: 'note warn' }, err.message)));
  return box;
}
// Russian plural for "строка" (line)
const lnPlural = (n) => { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return 'строк'; if (b > 1 && b < 5) return 'строки'; if (b === 1) return 'строка'; return 'строк'; };
function lineDiffView(ops) {
  const D = window.CupNetDiff;
  const MAX = 6000;
  const view = h('div', { class: 'ldiff mono' });
  const line = (o, nodes) => h('div', { class: `ln ln-${o.t === '+' ? 'add' : o.t === '-' ? 'del' : 'eq'}` },
    h('span', { class: 'g' }, o.a ?? ''), h('span', { class: 'g' }, o.b ?? ''), h('span', { class: 'gs' }, o.t === '=' ? '' : o.t === '-' ? '−' : '+'),
    h('span', { class: 'tx' }, nodes || cutText(o.text, 2000)));
  // A run of removed lines followed by added ones: pair them up and mark what changed inside each.
  const run = (dels, adds) => {
    const out = [];
    const pair = Math.min(dels.length, adds.length);
    const marks = [];
    for (let i = 0; i < pair; i++) marks.push(dels[i].text.length + adds[i].text.length < 400000 ? inlineDiff(dels[i].text, adds[i].text) : null);
    dels.forEach((o, i) => out.push(line(o, marks[i]?.[0])));
    adds.forEach((o, i) => out.push(line(o, marks[i]?.[1])));
    return out;
  };
  const emit = (list, into) => {
    let dels = [], adds = [], n = 0;
    const flush = () => { if (dels.length || adds.length) { into.append(...run(dels, adds)); dels = []; adds = []; } };
    for (const o of list) {
      if (++n > MAX) { flush(); into.append(h('div', { class: 'ln ln-skip' }, `… ещё ${(list.length - MAX).toLocaleString()} строк не показано`)); return; }
      if (o.t === '-') { if (adds.length) flush(); dels.push(o); continue; }
      if (o.t === '+') { adds.push(o); continue; }
      flush();
      if (o.t === 'skip') {
        const sk = h('div', { class: 'ln ln-skip', title: 'Показать эти строки' }, `⋯ ${o.count.toLocaleString()} ${lnPlural(o.count)} без изменений`);
        sk.addEventListener('click', () => { const f = document.createDocumentFragment(); emit(ops.slice(o.from, o.from + o.count), f); sk.replaceWith(f); });
        into.append(sk);
      } else into.append(line(o));
    }
    flush();
  };
  emit(CMP.only ? D.hunks(ops, 3) : ops, view);
  return view;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookies
// ─────────────────────────────────────────────────────────────────────────────
// Everything goes over the MITM path: changes for Chrome are queued and ride on the next
// first-party response from the site, wire rules rewrite cookies in flight.
const CK = { data: null, rev: -1, epoch: '', site: store.get('ck-site', ''), checked: new Set(), loading: false, loadedAt: 0 };
const CK_ROWS_MAX = 1500;
const ckDomainMatch = (host, domain) => !!domain && (host === domain || host.endsWith(`.${domain}`));
const ckSiteKey = (d) => d.split('.').reverse().join('.');
const ckExpired = (c) => c.expires != null && c.expires < Date.now();
const ckPendingFor = (c) => (CK.data?.ops || []).filter((o) => o.state === 'pending' && o.key === c.id);
const ckRulesFor = (c) => (CK.data?.overrides || []).filter((o) => (o.name === '*' || o.name === c.name) && (o.domain === '*' || ckDomainMatch(c.domain, o.domain) || ckDomainMatch(o.domain, c.domain)));
const ckOpenSite = guard(async (domain) => { await post('/api/chrome', { url: `https://${domain}/` }); toast(`Открываю ${domain} в Chrome`, 'ok'); });
const ckQueued = (domain, what = 'В очереди') => toast(`${what} — применится в Chrome при следующей загрузке страницы с ${domain}`, 'ok', { action: { label: 'Открыть сайт', fn: () => ckOpenSite(domain) }, ms: 6000 });

async function loadCookies() {
  CK.loading = true;
  try { applyCookies(await api('/api/cookies')); } finally { CK.loading = false; CK.loadedAt = Date.now(); }
}
function applyCookies(s) {
  CK.data = s; CK.rev = s.rev; CK.epoch = s.epoch;
  const ids = new Set(s.list.map((c) => c.id));
  for (const id of CK.checked) if (!ids.has(id)) CK.checked.delete(id);
  onCookieStatus(s);
  if (PAGE === 'cookies') renderCookies();
}
function onCookieStatus(c) {
  const b = $('ckCount');
  b.hidden = !c?.pending; b.textContent = c?.pending || '';
  b.title = c?.pending ? `Изменений cookie в ожидании следующей загрузки страницы: ${c.pending}` : '';
  // The jar changes with every logged request; refresh the open page at most every few seconds.
  if (PAGE === 'cookies' && c && !CK.loading && (c.rev !== CK.rev || c.epoch !== CK.epoch) && Date.now() - CK.loadedAt > 3000 && $('modalWrap').hidden) guard(loadCookies)();
}
const ckCall = async (p, body, method = 'POST') => { const s = await api(p, { method, body }); applyCookies(s); return s; };

function ckSites() {
  const map = new Map();
  for (const c of CK.data.list) {
    let s = map.get(c.domain);
    if (!s) map.set(c.domain, s = { domain: c.domain, live: 0, deleted: 0, lastSeen: 0, pending: 0 });
    if (c.deleted) s.deleted++; else s.live++;
    s.lastSeen = Math.max(s.lastSeen, c.lastSeen || 0);
  }
  for (const o of CK.data.ops) {
    if (o.state !== 'pending') continue;
    let s = map.get(o.domain);
    if (!s) map.set(o.domain, s = { domain: o.domain, live: 0, deleted: 0, lastSeen: 0, pending: 0 });
    s.pending++;
  }
  return [...map.values()].sort((a, b) => ckSiteKey(a.domain).localeCompare(ckSiteKey(b.domain)));
}
/** Cookies of the selected site: its own, plus domain cookies of parent domains that Chrome sends there too. */
function ckVisible() {
  const site = CK.site, show = $('ckShow').value, q = $('ckQ').value.trim().toLowerCase();
  return CK.data.list.filter((c) => {
    if (site && c.domain !== site && (c.hostOnly || !ckDomainMatch(site, c.domain))) return false;
    if (show === 'live' && c.deleted) return false;
    if (show === 'deleted' && !c.deleted) return false;
    if (show === 'inferred' && !(c.inferred && !c.deleted)) return false;
    if (show === 'overridden' && !ckRulesFor(c).length) return false;
    return !q || c.name.toLowerCase().includes(q) || String(c.value).toLowerCase().includes(q);
  });
}

function renderCookies() {
  if (!CK.data) return;
  renderCkSites();
  renderCkCards();
  renderCkRows();
}
function renderCkSites() {
  const q = $('ckSiteQ').value.trim().toLowerCase();
  const sites = ckSites();
  if (CK.site && !sites.some((s) => s.domain === CK.site)) { CK.site = ''; store.set('ck-site', ''); }
  const row = (key, title, meta, extra = null) => h('div', { class: `prow ck-prow${CK.site === key ? ' sel' : ''}`, title: key || 'Все отслеживаемые cookie', onclick: () => { CK.site = key; store.set('ck-site', key); CK.checked.clear(); renderCookies(); $('ckScroll').scrollTop = 0; } },
    h('div', { class: 'ell' }, h('div', { class: 'title' }, h('b', null, title)), h('div', { class: 'meta' }, meta)), extra);
  const live = CK.data.list.reduce((n, c) => n + (c.deleted ? 0 : 1), 0);
  const box = clear($('ckSites'));
  box.append(row('', 'Все сайты', [h('span', null, `cookies: ${live.toLocaleString()}`), h('span', null, `сайтов: ${sites.length}`)]));
  for (const s of sites) {
    if (q && !s.domain.includes(q)) continue;
    box.append(row(s.domain, s.domain,
      [h('span', null, `${s.live} активных`), s.deleted ? h('span', null, `${s.deleted} удалённых`) : null, s.lastSeen ? h('span', null, fmtAgo(s.lastSeen)) : null],
      s.pending ? tag(`${s.pending} в очереди`, 'accent') : null));
  }
}
function renderCkCards() {
  const box = clear($('ckCards'));
  const site = CK.site, d = CK.data;
  if (site) {
    const own = d.list.filter((c) => c.domain === site && !c.deleted);
    box.append(h('div', { class: 'card ck-card' }, h('div', { class: 'card-head' }, h('h2', { class: 'mono' }, site), tag(`${own.length} активных`), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => ckOpenSite(site) }, 'Открыть сайт'),
      h('button', { class: 'btn sm', disabled: !own.length, title: 'Поставить в очередь удаление всех активных cookie этого домена в Chrome', onclick: guard(async () => {
        if (!(await confirmBox(`Удалить ${own.length} cookie домена ${site} в Chrome? Это произойдёт при следующей загрузке страницы с сайта.`, 'Удалить', true))) return;
        await ckCall('/api/cookies/ops', { op: 'delete', ids: own.map((c) => c.id) }); ckQueued(site, `Удаление (${own.length}) в очереди`);
      }) }, 'Удалить их в Chrome'),
      h('button', { class: 'btn sm', title: 'Clear-Site-Data: "cookies" — Chrome удаляет все cookie сайта, включая те, что CupNet не видел (только HTTPS)', onclick: guard(async () => {
        if (!(await confirmBox(`Очистить все cookie домена ${site} в Chrome (Clear-Site-Data)? Работает только на HTTPS-страницах.`, 'Очистить', true))) return;
        await ckCall('/api/cookies/ops', { op: 'clear', domain: site }); ckQueued(site, 'Очистка сайта в очереди');
      }) }, 'Очистить данные сайта'),
      h('button', { class: 'btn sm ghost', title: 'Удалить отслеживаемые копии из CupNet; в Chrome cookie останутся', onclick: guard(async () => {
        const r = await ckCall('/api/cookies', { domain: site }, 'DELETE'); toast(`Забыто cookie: ${r.forgotten}`, 'ok');
      }) }, 'Забыть')),
    ));
  }
  const rules = d.overrides.filter((o) => !site || o.domain === '*' || ckDomainMatch(site, o.domain) || ckDomainMatch(o.domain, site));
  if (rules.length) {
    box.append(h('div', { class: 'card ck-card' }, h('div', { class: 'card-head' }, h('h2', null, 'Правила на лету'), h('span', { class: 'muted' }, 'переписывают cookie между Chrome и сайтом; собственное хранилище Chrome не трогается')),
      h('table', { class: 'tbl' }, h('tbody', null, rules.map((o) => h('tr', { class: o.enabled ? '' : 'off' },
        h('td', { class: 'ck-c-sw' }, sw(o.enabled, '', guard(async (v) => { await ckCall(`/api/cookies/overrides/${o.id}`, { enabled: v }); }))),
        h('td', { class: 'ck-c-tag' }, tag(o.action, o.action === 'pin' ? 'accent' : 'warn')),
        h('td', { class: 'mono ell', title: ckRuleText(o) }, ckRuleText(o), o.note ? h('span', { class: 'muted' }, ` — ${o.note}`) : null),
        h('td', { class: 'ck-c-hits muted', title: o.lastHitAt ? `последнее ${fmtStamp(o.lastHitAt)}` : 'ещё ни разу' }, `${(o.hits || 0).toLocaleString()} ${rHitPlural(o.hits || 0)}`),
        h('td', { class: 'ck-c-edit r-al' }, h('button', { class: 'btn sm', onclick: () => ckRuleModal(o) }, 'Изменить'))))))));
  }
  const ops = d.ops.filter((o) => !site || ckDomainMatch(o.domain, site) || ckDomainMatch(site, o.domain)).slice(0, 50);
  if (ops.length) {
    const opText = (o) => (o.op === 'clear' ? `очистить все cookie домена ${o.domain}` : `${o.op} ${o.cookie.name}${o.op === 'set' ? `=${o.cookie.value.length > 60 ? `${o.cookie.value.slice(0, 60)}…` : o.cookie.value}` : ''} · ${o.cookie.hostOnly ? '' : '.'}${o.cookie.domain}${o.cookie.path}`);
    const stCls2 = { pending: 'accent', applied: 'ok', cancelled: '', expired: 'warn', replaced: '' };
    const pending = ops.filter((o) => o.state === 'pending').length;
    box.append(h('div', { class: 'card ck-card' }, h('div', { class: 'card-head' }, h('h2', null, 'Изменения для Chrome'),
      pending ? h('span', { class: 'muted' }, 'применятся при следующей загрузке страницы с сайта — откройте или перезагрузите её') : null, h('span', { class: 'spacer' }),
      ops.length > pending ? h('button', { class: 'btn sm ghost', onclick: guard(() => ckCall('/api/cookies/ops', { op: 'clear-done' })) }, 'Очистить завершённые') : null),
      h('table', { class: 'tbl' }, h('tbody', null, ops.map((o) => h('tr', null,
        h('td', { class: 'ck-c-tag' }, tag(o.state, stCls2[o.state])),
        h('td', { class: 'mono ell', title: opText(o) }, opText(o)),
        h('td', { class: 'ck-c-when muted ell', title: o.appliedUrl || '' }, o.appliedAt ? `применено ${fmtAgo(o.appliedAt)}` : `в очереди ${fmtAgo(o.createdAt)}`),
        h('td', { class: 'ck-c-acts r-al' }, o.state === 'pending' ? [h('button', { class: 'btn sm', onclick: () => ckOpenSite(o.domain) }, 'Открыть'), h('button', { class: 'btn sm ghost', onclick: guard(() => ckCall(`/api/cookies/ops/${o.id}`, undefined, 'DELETE')) }, 'Отмена')] : null)))))));
  }
}
const ckRuleText = (o) => (o.action === 'pin' ? `${o.name}=${o.value} → ${o.domain}` : `${o.name} ${o.action === 'strip' ? 'не отправляется на' : 'не сохраняется с'} ${o.domain}`);

function renderCkRows() {
  const list = ckVisible();
  const tb = clear($('ckRows'));
  const shownList = list.slice(0, CK_ROWS_MAX);
  for (const c of shownList) {
    const rules = ckRulesFor(c), pend = ckPendingFor(c);
    const parent = CK.site && c.domain !== CK.site;
    const chk = h('input', { type: 'checkbox', checked: CK.checked.has(c.id), onclick: (ev) => ev.stopPropagation(), onchange: (ev) => { if (ev.target.checked) CK.checked.add(c.id); else CK.checked.delete(c.id); renderCkBulk(); } });
    const exp = c.expires == null ? h('span', { class: 'muted' }, 'Сессия') : h('span', { title: new Date(c.expires).toString() }, fmtStamp(c.expires));
    tb.append(h('tr', { class: `ck-row${c.deleted ? ' is-deleted' : ''}`, onclick: () => ckEditor(c) },
      h('td', null, chk),
      h('td', { class: 'mono ell', title: c.name }, c.name, c.inferred ? [' ', tag('выведен', '')] : null),
      h('td', { class: 'mono ell ck-val', title: c.value.length > 2000 ? `${c.value.slice(0, 2000)}…` : c.value }, c.value === '' ? h('span', { class: 'muted' }, '(пусто)') : c.value),
      h('td', { class: 'mono ell', title: `${c.hostOnly ? 'только хост' : 'домен и поддомены'} · путь ${c.path}` }, `${c.hostOnly ? '' : '.'}${c.domain}`, h('span', { class: 'muted' }, c.path), parent ? [' ', tag('родитель')] : null),
      h('td', { class: 'ell' }, c.deleted ? tag('удалён', 'err') : [exp, ckExpired(c) ? [' ', tag('истёк', 'warn')] : null]),
      h('td', { class: 'ck-flags' }, c.secure ? tag('Secure') : null, c.httpOnly ? tag('HttpOnly') : null, c.sameSite ? tag(c.sameSite) : null, c.partitioned ? tag('CHIPS') : null,
        rules.map((o) => tag(o.action === 'pin' ? 'закреплён' : o.action === 'strip' ? 'срезан' : 'заблокирован', o.enabled ? 'accent' : '')),
        pend.map((o) => tag(`${o.op} в очереди`, 'warn'))),
      h('td', { class: 'r-al muted', title: `задан ${c.setCount}× · отправлен ${c.sentCount}×${c.blockedCount ? ` · заблокирован ${c.blockedCount}×` : ''}${c.lastUrl ? `\n${c.lastUrl}` : ''}` }, fmtAgo(c.lastSeen)),
      h('td', { class: 'r-al', onclick: (ev) => ev.stopPropagation() },
        h('button', { class: 'icon', title: 'Копировать значение', onclick: () => copy(c.value, 'Значение скопировано') }, '⧉'),
        c.deleted ? null : h('button', { class: 'icon', title: 'Удалить в Chrome', onclick: guard(async () => { await ckCall('/api/cookies/ops', { op: 'delete', ids: [c.id] }); ckQueued(c.domain, `Удаление ${c.name}`); }) }, '🗑'))));
  }
  $('ckShown').textContent = list.length > CK_ROWS_MAX ? `показано ${CK_ROWS_MAX.toLocaleString()} из ${list.length.toLocaleString()} — уточните фильтр` : `${list.length.toLocaleString()} cookie`;
  $('ckAll').checked = shownList.length > 0 && shownList.every((c) => CK.checked.has(c.id));
  const empty = $('ckEmpty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    append(clear(empty), [CK.data.list.length
      ? h('p', null, 'Под фильтр не попало ни одного cookie.')
      : [h('p', null, h('b', null, 'Пока нет cookie.')), h('p', { class: 'muted' }, 'Cookie появляются здесь по мере того, как Chrome отправляет или получает их через CupNet. Откройте сайт в проксируемом Chrome или добавьте cookie кнопкой + Добавить cookie.')]]);
  }
  renderCkBulk();
}
function renderCkBulk() {
  const bar = clear($('ckBulk'));
  const ids = [...CK.checked];
  bar.hidden = !ids.length;
  if (!ids.length) return;
  const sel = CK.data.list.filter((c) => CK.checked.has(c.id));
  bar.append(h('b', null, `Выбрано: ${ids.length}`),
    h('button', { class: 'btn sm danger', onclick: guard(async () => {
      const live = sel.filter((c) => !c.deleted);
      if (!live.length) { toast('Выбраны только удалённые cookie', 'warn'); return; }
      await ckCall('/api/cookies/ops', { op: 'delete', ids: live.map((c) => c.id) });
      CK.checked.clear(); renderCookies();
      ckQueued([...new Set(live.map((c) => c.domain))].join(', '), `Удаление (${live.length}) в очереди`);
    }) }, 'Удалить в Chrome'),
    h('button', { class: 'btn sm', onclick: () => ckExportModal(true) }, 'Экспорт…'),
    h('button', { class: 'btn sm ghost', title: 'Удалить отслеживаемые копии; в Chrome cookie останутся', onclick: guard(async () => { const r = await ckCall('/api/cookies', { ids }, 'DELETE'); CK.checked.clear(); renderCookies(); toast(`Забыто cookie: ${r.forgotten}`, 'ok'); }) }, 'Забыть'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm ghost', onclick: () => { CK.checked.clear(); renderCkRows(); } }, 'Снять выделение'));
}

const ckLocalInput = (ms) => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
function ckEditor(c) {
  const isNew = !c;
  const base = c || { name: '', value: '', domain: CK.site || '', hostOnly: true, path: '/', expires: Date.now() + 365 * 86400000, secure: true, httpOnly: false, sameSite: 'Lax', partitioned: false };
  const f = {
    name: h('input', { type: 'text', value: base.name, placeholder: 'session_id', spellcheck: false }),
    value: h('textarea', { class: 'code', rows: 4, spellcheck: false }, base.value),
    domain: h('input', { type: 'text', value: base.domain, placeholder: 'example.com', spellcheck: false }),
    scope: h('select', null, h('option', { value: 'host' }, 'Только этот хост'), h('option', { value: 'domain' }, 'Домен и его поддомены')),
    path: h('input', { type: 'text', value: base.path, spellcheck: false }),
    session: h('input', { type: 'checkbox', checked: base.expires == null }),
    expires: h('input', { type: 'datetime-local', value: ckLocalInput(base.expires ?? Date.now() + 365 * 86400000) }),
    secure: h('input', { type: 'checkbox', checked: !!base.secure }),
    httpOnly: h('input', { type: 'checkbox', checked: !!base.httpOnly }),
    sameSite: h('select', null, h('option', { value: '' }, 'Не задано (Chrome: Lax)'), ['Lax', 'Strict', 'None'].map((v) => h('option', { value: v }, v))),
    partitioned: h('input', { type: 'checkbox', checked: !!base.partitioned }),
  };
  f.scope.value = base.hostOnly ? 'host' : 'domain';
  f.sameSite.value = base.sameSite || '';
  const syncExp = () => { f.expires.disabled = f.session.checked; };
  f.session.addEventListener('change', syncExp); syncExp();
  const spec = () => ({
    name: f.name.value.trim(), value: f.value.value.replace(/\r?\n/g, ''), domain: f.domain.value.trim(), hostOnly: f.scope.value === 'host', path: f.path.value.trim() || '/',
    expires: f.session.checked ? null : new Date(f.expires.value).getTime() || null,
    secure: f.secure.checked, httpOnly: f.httpOnly.checked, sameSite: f.sameSite.value || null, partitioned: f.partitioned.checked,
  });
  const chk = (input, label) => h('label', { class: 'chk' }, input, label);
  const body = h('div', null,
    c && c.inferred ? h('div', { class: 'note' }, 'Встречен только в заголовке запроса Cookie, поэтому его домен, путь и флаги — предположение, пока сайт его не установит.') : null,
    h('div', { class: 'form ck-form' },
      field('Имя', f.name),
      field('Значение', f.value, null, true),
      field('Домен', f.domain),
      field('Область', f.scope, 'У host-only cookie нет атрибута Domain; cookie с префиксом __Host- должны быть host-only.'),
      field('Путь', f.path),
      field('Истекает', h('div', { class: 'inline' }, chk(f.session, 'Сессионный cookie'), f.expires)),
      field('Флаги', h('div', { class: 'inline' }, chk(f.secure, 'Secure'), chk(f.httpOnly, 'HttpOnly'), chk(f.partitioned, 'Partitioned (CHIPS)'))),
      field('SameSite', f.sameSite)));
  if (c) {
    body.append(h('div', { class: 'muted ck-stats' },
      `Впервые встречен ${fmtStamp(c.firstSeen)} · установлен сайтом ${c.setCount}× · отправлен ${c.sentCount}×${c.blockedCount ? ` · заблокирован ${c.blockedCount}×` : ''}`,
      c.lastUrl ? h('div', { class: 'mono ell' }, c.lastUrl) : null));
    if (c.history?.length) {
      body.append(sect(`История (${c.history.length})`, h('table', { class: 'tbl ck-hist' }, h('tbody', null, c.history.map((x) => h('tr', null,
        h('td', { class: 'w-130 muted' }, fmtStamp(x.at)), h('td', { class: 'w-90' }, tag(x.via, x.via.includes('delete') ? 'err' : x.via === 'manual' ? 'accent' : '')),
        h('td', { class: 'mono ell', title: x.value }, x.value === '' ? h('span', { class: 'muted' }, '(пусто)') : x.value),
        h('td', { class: 'mono ell muted w-180', title: x.url || '' }, x.url || ''))))), c.history.length <= 6));
    }
  }
  modal(isNew ? 'Добавить cookie' : `Cookie ${c.name}`, body, [
    { label: 'Отмена' },
    c && !c.deleted ? { label: 'Удалить в Chrome', cls: 'danger', fn: async () => { await ckCall('/api/cookies/ops', { op: 'delete', ids: [c.id] }); ckQueued(c.domain, `Удаление ${c.name}`); } } : null,
    { label: 'Закрепить на лету', fn: async () => {
      const s = spec();
      await ckCall('/api/cookies/overrides', { action: 'pin', domain: s.domain, name: s.name, value: s.value, note: 'from cookie editor' });
      toast(`Запросы к ${s.domain} теперь отправляют ${s.name} с этим значением, что бы ни было в Chrome`, 'ok');
    } },
    { label: isNew ? 'Добавить в Chrome' : 'Сохранить в Chrome', cls: 'primary', fn: async () => {
      const s = spec();
      await ckCall('/api/cookies/ops', { op: 'set', cookie: s });
      // A changed identity is a different cookie: drop the old one so Chrome does not keep both.
      if (c && !c.deleted && (c.name !== s.name || c.domain !== s.domain.toLowerCase().replace(/^\./, '') || c.path !== s.path || c.hostOnly !== s.hostOnly)) await ckCall('/api/cookies/ops', { op: 'delete', ids: [c.id] });
      ckQueued(s.domain, `${s.name} в очереди`);
    } },
  ].filter(Boolean));
}

function ckRuleModal(o) {
  const ed = { action: o?.action || 'pin', domain: o?.domain ?? (CK.site || ''), name: o?.name || '', value: o?.value || '', note: o?.note || '', enabled: o ? o.enabled : true };
  const HELP = {
    pin: 'Отправлять это значение на сайт вместо того, что есть в Chrome (добавляет cookie, если в Chrome его нет). Хранилище Chrome не меняется.',
    strip: 'Убирать cookie из запросов к сайту. Укажите * в имени, чтобы вообще не отправлять cookie.',
    block: 'Удалять подходящие строки Set-Cookie из ответов, чтобы Chrome никогда не сохранял этот cookie.',
  };
  const segBox = h('div'), help = h('div', { class: 'hint' });
  const name = h('input', { type: 'text', value: ed.name, placeholder: 'имя или * для всех cookie', spellcheck: false, oninput: (ev) => { ed.name = ev.target.value; } });
  const value = h('input', { type: 'text', value: ed.value, spellcheck: false, oninput: (ev) => { ed.value = ev.target.value; } });
  const valueRow = field('Значение', value);
  const paint = () => {
    clear(segBox).append(seg([['pin', 'Закрепить значение'], ['strip', 'Срезать из запросов'], ['block', 'Блокировать Set-Cookie']], ed.action, (v) => { ed.action = v; paint(); }));
    help.textContent = HELP[ed.action];
    for (const n of valueRow) n.hidden = ed.action !== 'pin';
  };
  const body = h('div', { class: 'form' },
    h('label', null, 'Действие'), segBox, help,
    field('Домен', h('input', { type: 'text', value: ed.domain, placeholder: 'example.com или * для всех сайтов', spellcheck: false, oninput: (ev) => { ed.domain = ev.target.value; } }), 'Совпадает с доменом и его поддоменами.'),
    field('Cookie', name), valueRow,
    field('Заметка', h('input', { type: 'text', value: ed.note, oninput: (ev) => { ed.note = ev.target.value; } })),
    h('label'), sw(ed.enabled, 'Включено', (v) => { ed.enabled = v; }));
  paint();
  modal(o ? 'Изменить правило на лету' : 'Новое правило на лету', body, [
    { label: 'Отмена' },
    o ? { label: 'Удалить', cls: 'danger', fn: async () => { await ckCall(`/api/cookies/overrides/${o.id}`, undefined, 'DELETE'); toast('Правило удалено', 'ok'); } } : null,
    { label: 'Сохранить', cls: 'primary', fn: async () => {
      const payload = { ...ed, domain: ed.domain.trim(), name: ed.name.trim() };
      await ckCall(o ? `/api/cookies/overrides/${o.id}` : '/api/cookies/overrides', payload);
      toast(o ? 'Правило сохранено' : 'Правило добавлено — применяется к следующим запросам', 'ok');
    } },
  ].filter(Boolean));
}

function ckImportModal() {
  const text = h('textarea', { class: 'code ck-import', rows: 12, spellcheck: false, placeholder: 'Вставьте cookie: JSON-массив (экспорт EditThisCookie / Cookie-Editor / CupNet) или Netscape cookies.txt' });
  const out = h('div', { class: 'muted' }, 'Пока ничего не проверено.');
  const file = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', onchange: () => {
    const fl = file.files[0]; if (!fl) return;
    const r = new FileReader();
    r.onload = () => { text.value = String(r.result || ''); preview(); };
    r.readAsText(fl);
  } });
  const preview = guard(async () => {
    if (!text.value.trim()) { clear(out).append('Нечего импортировать.'); return; }
    const r = await post('/api/cookies/import', { text: text.value, dryRun: true });
    append(clear(out), [h('b', { class: r.parsed ? 'ok' : 'warn' }, `Распознано cookie: ${r.parsed}`),
      r.errors.length ? h('ul', { class: 'ck-errs' }, r.errors.slice(0, 12).map((e) => h('li', { class: 'warn' }, e))) : null]);
  });
  text.addEventListener('input', () => debounce('ckimp', 400, preview));
  modal('Импорт cookie в Chrome', h('div', null,
    h('p', { class: 'muted' }, 'Импортированные cookie ставятся в очередь и записываются в Chrome при следующей загрузке страницы с каждого сайта.'),
    h('div', { class: 'ck-file' }, file), text, out), [
    { label: 'Отмена' },
    { label: 'Импорт', cls: 'primary', fn: async () => {
      if (!text.value.trim()) { toast('Сначала вставьте текст или выберите файл', 'warn'); return false; }
      const r = await post('/api/cookies/import', { text: text.value });
      applyCookies(r);
      if (!r.queued) { toast(r.errors[0] || 'Cookie не распознаны', 'warn'); return false; }
      toast(`В очередь для Chrome поставлено cookie: ${r.queued}${r.errors.length ? ` · пропущено: ${r.errors.length}` : ''}`, 'ok');
      return undefined;
    } },
  ]);
}

function ckExportModal(selectedOnly = false) {
  let fmt = store.get('ck-fmt', 'json');
  let scope = selectedOnly && CK.checked.size ? 'selected' : CK.site ? 'site' : 'all';
  const fmtBox = h('div'), scopeBox = h('div');
  const paint = () => {
    clear(fmtBox).append(seg([['json', 'JSON'], ['netscape', 'Netscape cookies.txt']], fmt, (v) => { fmt = v; store.set('ck-fmt', v); paint(); }));
    const opts = [];
    if (CK.checked.size) opts.push(['selected', `Выбранные (${CK.checked.size})`]);
    if (CK.site) opts.push(['site', CK.site]);
    opts.push(['all', 'Все сайты']);
    clear(scopeBox).append(seg(opts, scope, (v) => { scope = v; paint(); }));
  };
  paint();
  modal('Экспорт cookie', h('div', { class: 'form' }, h('label', null, 'Формат'), fmtBox, h('label', null, 'Cookies'), scopeBox,
    h('div', { class: 'hint' }, 'Файл содержит значения cookie — обращайтесь с ним как с паролем.')), [
    { label: 'Отмена' },
    { label: 'Скачать', cls: 'primary', fn: async () => {
      const q = new URLSearchParams({ format: fmt });
      if (scope === 'selected') q.set('ids', [...CK.checked].join(','));
      if (scope === 'site') q.set('domain', CK.site);
      const { blob } = await apiBlob(`/api/cookies/export?${q}`);
      download(blob, `cookies${scope === 'site' ? `-${CK.site}` : ''}.${fmt === 'netscape' ? 'txt' : 'json'}`);
    } },
  ]);
}

$('ckSiteQ').addEventListener('input', () => debounce('cksite', 150, renderCkSites));
$('ckQ').addEventListener('input', () => debounce('ckq', 150, renderCkRows));
$('ckShow').addEventListener('change', renderCkRows);
$('ckAll').addEventListener('change', (ev) => {
  for (const c of ckVisible().slice(0, CK_ROWS_MAX)) { if (ev.target.checked) CK.checked.add(c.id); else CK.checked.delete(c.id); }
  renderCkRows();
});
$('ckAdd').addEventListener('click', () => ckEditor(null));
$('ckRule').addEventListener('click', () => ckRuleModal(null));
$('ckImport').addEventListener('click', ckImportModal);
$('ckExport').addEventListener('click', () => ckExportModal(false));

// ─────────────────────────────────────────────────────────────────────────────
// Boot (after the deferred ui-inspect.js has run, so its pages and hooks exist)
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (!(await auth())) {
    $('login').hidden = false; $('pages').hidden = true; $('stats').textContent = 'нет токена доступа';
    return;
  }
  buildFilter();
  renderRpHeaders();
  try { await fillSessionSelect(); } catch (e) { toast(e.message, 'err'); }
  openSession(current);
  go(store.get('page', 'traffic'));
  grid.focus();
  pollStatus(); setInterval(pollStatus, 2000);
});
