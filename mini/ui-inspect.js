'use strict';
/* CupNet mini UI — Console and Page analyzer. Loaded after ui.js and shares its helpers and state
 * (h, api, all, go, select…). Both pages talk to the page agent (mini/page-agent.js) through
 * /api/pages: console messages arrive in the session log (kind "console"), commands and the
 * analyzer scan go to the page and back. Same rules as ui.js: no innerHTML, every node built with h(). */

// ─────────────────────────────────────────────────────────────────────────────
// Live pages (shared by Console and Analyzer)
// ─────────────────────────────────────────────────────────────────────────────
const PG = { list: [], enabled: true, loaded: false, gen: 0, timer: 0 };
const PG_POLL_MS = 2500;
const isInspectPage = () => PAGE === 'console' || PAGE === 'analyzer';
async function refreshPages() {
  const r = await api('/api/pages');
  PG.list = r.pages || []; PG.enabled = !!r.enabled; PG.loaded = true;
  if (PAGE === 'console') { renderCnPages(); renderBanner($('cnBanner')); }
  if (PAGE === 'analyzer') { renderAnPages(); renderBanner($('anBanner')); renderAnHead(); }
}
/** Keeps polling /api/pages while Console or Analyzer is open; that also keeps the agents polling fast. */
function pagePoll() {
  clearTimeout(PG.timer);
  const my = ++PG.gen;
  if (!isInspectPage()) return;
  refreshPages().catch(() => { /* status bar shows a dead server */ }).finally(() => {
    if (my === PG.gen && isInspectPage()) PG.timer = setTimeout(pagePoll, PG_POLL_MS);
  });
}
const pageById = (id) => PG.list.find((p) => p.id === id) || null;
function pageLabel(p) {
  if (!p) return '';
  const [host, path] = splitUrl(p.url);
  return p.title ? `${p.title} — ${host}${path === '/' ? '' : path}` : `${host}${path}`;
}
function renderBanner(box) {
  clear(box);
  if (!PG.loaded || PG.enabled) return;
  box.append(h('div', { class: 'ins-banner' },
    h('div', null, h('b', null, 'The page agent is off.'), ' ',
      h('span', { class: 'muted' }, 'With it on, CupNet adds a small script to every HTML page it proxies: it forwards the console to the session log and answers the analyzer and the console prompt. It runs on the MITM path only, and is never written to the logged page.')),
    h('button', { class: 'btn primary sm', onclick: guard(async (ev) => {
      await busy(ev.currentTarget, 'Turning on…', () => post('/api/settings', { pageAgent: true }));
      toast('Page agent on — reload the pages you want to inspect', 'ok');
      await refreshPages();
    }) }, 'Turn on')));
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialized values (what the agent's serialize() produces) → expandable tree
// ─────────────────────────────────────────────────────────────────────────────
const isObjVal = (v) => v && typeof v === 'object' && (v.t === 'obj' || v.t === 'arr' || v.t === 'map' || v.t === 'set');
function valShort(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  if (t !== 'object') return String(v);
  switch (v.t) {
    case 's': return JSON.stringify(`${String(v.v).slice(0, 40)}…`);
    case 'n': return v.v;
    case 'u': return 'undefined';
    case 'big': return `${v.v}n`;
    case 'sym': return v.v;
    case 'fn': return 'ƒ';
    case 'cyc': return '[Circular]';
    case 'hole': return 'empty';
    case 'get': return '(…)';
    case 'date': return v.v;
    case 're': return v.v;
    case 'node': return v.v;
    case 'err': return v.name || 'Error';
    case 'arr': return `${v.cls && v.cls !== 'Array' ? v.cls : 'Array'}(${v.n})`;
    case 'map': return `Map(${v.n})`;
    case 'set': return `Set(${v.n})`;
    case 'obj': return v.cls && v.cls !== 'Object' ? v.cls : '{…}';
    default: return '?';
  }
}
function valPreview(v) {
  const kids = [];
  const list = (items, fmt) => {
    items.slice(0, 5).forEach((x, i) => { if (i) kids.push(', '); kids.push(fmt(x)); });
    if (v.more || items.length > 5) kids.push(items.length ? ', …' : '…');
  };
  if (v.t === 'arr') {
    kids.push(h('span', { class: 'v-cls' }, `${v.cls && v.cls !== 'Array' ? v.cls : ''}(${v.n}) `), '[');
    list(v.items || [], (x) => h('span', { class: 'v-pv' }, valShort(x)));
    kids.push(']');
  } else if (v.t === 'map' || v.t === 'set') {
    kids.push(h('span', { class: 'v-cls' }, `${v.t === 'map' ? 'Map' : 'Set'}(${v.n}) `), '{');
    if (v.t === 'map') list(v.entries || [], ([k, x]) => h('span', { class: 'v-pv' }, `${valShort(k)} => ${valShort(x)}`));
    else list(v.items || [], (x) => h('span', { class: 'v-pv' }, valShort(x)));
    kids.push('}');
  } else {
    if (v.cls && v.cls !== 'Object') kids.push(h('span', { class: 'v-cls' }, `${v.cls} `));
    kids.push('{');
    list(v.props || [], ([k, x]) => [h('span', { class: 'v-pk' }, k), ': ', h('span', { class: 'v-pv' }, valShort(x))]);
    kids.push('}');
  }
  return kids;
}
function valProps(v) {
  const box = h('div', { class: 'v-props' });
  const row = (k, x, cls = 'j-k') => box.append(h('div', { class: 'v-row' }, h('span', { class: cls }, String(k)), ': ', valNode(x)));
  if (v.t === 'arr') (v.items || []).forEach((x, i) => row(i, x));
  else if (v.t === 'set') (v.items || []).forEach((x, i) => row(i, x, 'v-idx'));
  else if (v.t === 'map') (v.entries || []).forEach(([k, x], i) => box.append(h('div', { class: 'v-row' }, h('span', { class: 'v-idx' }, String(i)), ': ', valNode(k), ' => ', valNode(x))));
  else (v.props || []).forEach(([k, x]) => row(k, x));
  const have = v.t === 'map' ? (v.entries || []).length : v.t === 'obj' ? (v.props || []).length : (v.items || []).length;
  if (v.more) box.append(h('div', { class: 'v-more' }, have ? `… ${(v.n - have).toLocaleString()} more` : 'Not captured (too deep) — inspect it from the console prompt'));
  else if (!have) box.append(h('div', { class: 'v-more' }, v.err ? 'Could not be read' : 'empty'));
  return box;
}
/** One value; objects collapse to a one-line preview and fill their children on first open. */
function valNode(v, o = {}) {
  if (v === null) return h('span', { class: 'j-z' }, 'null');
  const t = typeof v;
  if (t === 'string') return o.top ? h('span', { class: 'v-str' }, v) : h('span', { class: 'j-s' }, JSON.stringify(v));
  if (t === 'number') return h('span', { class: 'j-n' }, String(v));
  if (t === 'boolean') return h('span', { class: 'j-b' }, String(v));
  if (t !== 'object') return h('span', null, String(v));
  switch (v.t) {
    case 's': return h('span', { class: o.top ? 'v-str' : 'j-s', title: `${Number(v.n).toLocaleString()} characters` }, o.top ? v.v : JSON.stringify(v.v), h('span', { class: 'v-cut' }, ` …+${(v.n - String(v.v).length).toLocaleString()}`));
    case 'n': return h('span', { class: 'j-n' }, v.v);
    case 'big': return h('span', { class: 'j-n' }, `${v.v}n`);
    case 'u': return h('span', { class: 'j-z' }, 'undefined');
    case 'sym': return h('span', { class: 'v-sym' }, v.v);
    case 'cyc': return h('span', { class: 'j-z' }, '[Circular]');
    case 'hole': return h('span', { class: 'j-z' }, 'empty');
    case 'get': return h('span', { class: 'j-z', title: 'Getter — not invoked' }, '(…)');
    case 'date': return h('span', { class: 'v-date' }, v.v);
    case 're': return h('span', { class: 'v-re' }, v.v);
    case 'fn': {
      const d = h('details', { class: 'v-obj' }, h('summary', null, h('i', { class: 'v-fn' }, 'ƒ'), ` ${v.name || 'anonymous'}()`));
      d.addEventListener('toggle', () => { if (d.open && d.children.length < 2) d.append(h('pre', { class: 'v-src' }, v.v || '')); });
      return d;
    }
    case 'node': {
      if (!v.html) return h('span', { class: 'v-node' }, v.v);
      const d = h('details', { class: 'v-obj' }, h('summary', null, h('span', { class: 'v-node' }, v.v)));
      d.addEventListener('toggle', () => { if (d.open && d.children.length < 2) d.append(h('pre', { class: 'v-src' }, v.html)); });
      return d;
    }
    case 'err': {
      const d = h('details', { class: 'v-obj', open: !!o.open }, h('summary', null, h('span', { class: 'err' }, `${v.name || 'Error'}${v.msg ? `: ${v.msg}` : ''}`)));
      if (v.stack) d.append(h('pre', { class: 'v-src' }, v.stack));
      return d;
    }
    default: {
      if (!isObjVal(v)) return h('span', { class: 'j-z' }, JSON.stringify(v));
      const d = h('details', { class: 'v-obj' }, h('summary', null, valPreview(v)));
      const fill = () => { if (d.children.length < 2) d.append(valProps(v)); };
      if (o.open) { d.open = true; fill(); }
      d.addEventListener('toggle', () => { if (d.open) fill(); });
      return d;
    }
  }
}
/** Plain JSON-ish text of a serialized value (Copy value). */
function valText(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? (depth ? JSON.stringify(v) : v) : String(v);
  const pad = '  '.repeat(depth + 1), end = '  '.repeat(depth);
  switch (v.t) {
    case 's': return depth ? JSON.stringify(v.v) : v.v;
    case 'n': case 'sym': case 'date': case 're': case 'node': return String(v.v);
    case 'big': return `${v.v}n`;
    case 'u': return 'undefined';
    case 'fn': return v.v || `function ${v.name || ''}() {}`;
    case 'err': return v.stack || `${v.name}: ${v.msg}`;
    case 'arr': case 'set': return `[\n${(v.items || []).map((x) => pad + valText(x, depth + 1)).join(',\n')}${v.more ? `,\n${pad}…` : ''}\n${end}]`;
    case 'map': return `{\n${(v.entries || []).map(([k, x]) => `${pad}${valText(k, depth + 1)} => ${valText(x, depth + 1)}`).join(',\n')}\n${end}}`;
    case 'obj': return `{\n${(v.props || []).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${valText(x, depth + 1)}`).join(',\n')}${v.more ? `,\n${pad}…` : ''}\n${end}}`;
    default: return valShort(v);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Console
// ─────────────────────────────────────────────────────────────────────────────
const CN = {
  items: [], levels: store.get('cn-levels', { error: true, warn: true, info: true, verbose: true }),
  doc: '', re: null, group: store.get('cn-group', true), times: store.get('cn-times', true),
  paused: false, pending: 0, clearedAfter: 0, collapsed: new Set(), values: new Map(), via: new Map(),
  unseen: 0, hist: store.get('cn-hist', []), hpos: -1, draft: '', await: store.get('cn-await', true),
  r: null, stick: true, target: '', flash: 0,
};
const CN_MAX_ROWS = 3000;
const CN_LEVELS = [['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info'], ['verbose', 'Verbose']];
const CN_ICON = { error: '✕', exception: '✕', assert: '✕', resource: '✕', warn: '▲', csp: '⛨', deprecation: '▲', intervention: '▲', info: 'i', debug: '·', command: '›', result: '‹', group: '▾', time: '⏱', trace: '↳', table: '▦' };

function consoleIngest(items) {
  const fresh = [];
  for (const e of items) {
    if (e.kind !== 'console') continue;
    CN.items.push(e); fresh.push(e);
    if (PAGE !== 'console' && e.sev === 'error' && e.type !== 'result') CN.unseen++;
  }
  if (!fresh.length) return;
  renderCnBadge();
  if (PAGE !== 'console') return;
  if (CN.paused) { CN.pending += fresh.filter(cnMatch).length; renderCnPause(); return; }
  cnAppend(fresh);
  renderCnCounts();
}
function consoleReset() {
  CN.items = []; CN.clearedAfter = 0; CN.collapsed.clear(); CN.pending = 0; CN.unseen = 0;
  renderCnBadge();
  if (PAGE === 'console') renderCn();
}
function renderCnBadge() {
  const b = $('cnCount');
  b.hidden = !CN.unseen; b.textContent = CN.unseen > 99 ? '99+' : String(CN.unseen);
}

function cnSetQuery(q) {
  const box = $('cnQ');
  box.classList.remove('bad');
  CN.re = null;
  q = q.trim();
  if (!q) return;
  const m = /^\/(.+)\/([a-z]*)$/.exec(q);
  try { CN.re = m ? new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  catch { box.classList.add('bad'); }
}
const cnLive = (e) => e.seq > CN.clearedAfter && (!CN.doc || e.doc === CN.doc);
function cnMatch(e) {
  if (!cnLive(e)) return false;
  const repl = e.type === 'command' || e.type === 'result';
  if (!repl && !CN.levels[e.sev || 'info']) return false;
  if (CN.re && !CN.re.test(`${e.note || ''}\n${e.src || ''}\n${e.url || ''}`)) return false;
  return true;
}

/** Console source "https://x/app.js:12:5" → the script URL and a short label. */
function srcParts(src) {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(String(src || ''));
  const url = m ? m[1] : String(src || '');
  const file = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || url;
  return { url, label: `${file}${m && m[2] ? `:${m[2]}` : ''}` };
}
function findRequestFor(url) {
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'request' && all[i].url === url) return all[i].seq;
  return null;
}
function showInTraffic(seq) { go('traffic'); select(seq); }

function cnRow(e) {
  const lvl = e.type || 'log';
  const isGroup = lvl === 'group';
  const row = h('div', { class: `cn-row cn-${e.sev || 'info'} cn-t-${lvl}`, dataset: { seq: e.seq } });
  if (e.g) row.style.setProperty('--g', e.g);
  const multi = !CN.doc && new Set(CN.items.map((x) => x.doc)).size > 1;
  const src = e.src ? srcParts(e.src) : null;
  const line = h('div', { class: 'cn-line' },
    h('span', { class: 'cn-ic', title: lvl }, isGroup ? (CN.collapsed.has(e.seq) ? '▸' : '▾') : (CN_ICON[lvl] || CN_ICON[e.sev] || '')),
    CN.times ? h('span', { class: 'cn-tm' }, fmtTime(e.ts)) : null,
    h('span', { class: 'cn-msg' }, e.note || (isGroup ? 'console.group' : '')),
    h('span', { class: 'cn-x', hidden: true }),
    multi && e.doc ? h('span', { class: 'cn-pg', title: e.url }, splitUrl(e.url)[0]) : null,
    src ? h('a', { class: 'cn-src', href: '#', title: e.src, onclick: (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const seq = findRequestFor(src.url);
      if (seq) showInTraffic(seq); else toast('That script is not in this session', 'warn');
    } }, src.label) : null);
  row.append(line);
  line.addEventListener('click', () => {
    if (getSelection().toString()) return; // selecting text, not toggling
    if (isGroup) { if (CN.collapsed.has(e.seq)) CN.collapsed.delete(e.seq); else CN.collapsed.add(e.seq); renderCn(); return; }
    cnToggle(row, e);
  });
  if (lvl === 'result' && CN.values.has(e.seq)) cnInlineValue(row, e.seq);
  return row;
}
/** REPL result we already hold: show it as a tree in place of the one-line text. */
function cnInlineValue(row, seq) {
  const v = CN.values.get(seq);
  const msg = row.querySelector('.cn-msg');
  if (!msg || v === undefined) return;
  clear(msg).append(valNode(v, { top: false, open: false }));
  const via = CN.via.get(seq);
  if (via) msg.append(' ', tag(via === 'script' ? 'via <script> (page CSP blocks eval)' : via, 'warn'));
}
async function cnToggle(row, e) {
  if (row.classList.toggle('open')) {
    if (row.querySelector('.cn-detail')) return;
    const box = h('div', { class: 'cn-detail' }, h('span', { class: 'muted' }, 'Loading…'));
    row.append(box);
    try {
      const full = await api(`/api/log/${e.seq}${qs()}`);
      clear(box).append(consoleBody(full, { compact: true }));
    } catch (err) { clear(box).append(h('span', { class: 'err' }, err.message)); }
  }
}
/** Message, arguments, stack and source of one console entry (Console row and Traffic detail). */
function consoleBody(full, o = {}) {
  const d = full.data || {};
  const text = d.text || full.note || '';
  const out = h('div', { class: 'cn-body' });
  const args = Array.isArray(d.args) ? d.args : [];
  const onlyText = args.length === 1 && typeof args[0] === 'string' && args[0] === text;
  if (full.type === 'command') out.append(h('pre', { class: 'codebox cn-code' }, text));
  else if (args.length && !onlyText) {
    const list = h('div', { class: 'cn-args' });
    args.forEach((a, i) => list.append(h('div', { class: 'cn-arg' }, h('span', { class: 'v-idx' }, `${i}`), valNode(a, { top: true, open: isObjVal(a) && args.length === 1 }))));
    out.append(list);
  } else if (!o.compact || text.length > 160 || text.includes('\n')) out.append(h('pre', { class: 'codebox' }, text));
  if (d.stack) out.append(h('pre', { class: 'cn-stack' }, d.stack));
  const kv = [['Level', `${full.type || 'log'} · ${full.sev || 'info'}`], ['Time', new Date(full.ts).toISOString()], ['Page', full.url || '']];
  if (full.src) kv.push(['Source', full.src]);
  if (d.frame) kv.push(['Frame', 'iframe']);
  if (full.g) kv.push(['Group depth', String(full.g)]);
  const acts = h('div', { class: 'cn-acts' },
    h('button', { class: 'btn sm', onclick: () => copy(text, 'Message copied') }, 'Copy message'),
    args.length ? h('button', { class: 'btn sm', onclick: () => copy(args.map((a) => valText(a)).join('\n'), 'Value copied') }, 'Copy value') : null,
    full.type === 'command' ? h('button', { class: 'btn sm', onclick: () => { go('console'); cnEdit(text); } }, 'Edit in prompt') : null,
    o.compact ? h('button', { class: 'btn sm', onclick: () => showInTraffic(full.seq) }, `#${full.seq} in Traffic`) : null,
    !o.compact ? h('button', { class: 'btn sm', onclick: () => cnReveal(full.seq) }, 'Show in Console') : null);
  out.append(o.compact ? h('div', { class: 'cn-meta' }, kv.map(([k, v]) => h('span', null, h('b', null, k), ' ', v))) : kvGrid(kv), acts);
  return out;
}
/** Traffic detail for a console entry. */
function renderConsoleDetail(d, e) { d.append(consoleBody(e)); }

function cnAppend(list) {
  const box = $('cnList');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const R = CN.r || (CN.r = { last: null, hide: Object.create(null), rows: 0 });
  const frag = document.createDocumentFragment();
  for (const e of list) {
    if (!cnMatch(e)) continue;
    const doc = e.doc || '';
    const hb = R.hide[doc];
    if (hb != null) { if ((e.g || 0) > hb) continue; delete R.hide[doc]; }
    const key = `${doc}|${e.type}|${e.g || 0}|${e.src || ''}|${e.note}`;
    const repl = e.type === 'command' || e.type === 'result' || e.type === 'group';
    if (CN.group && !repl && R.last && R.last.key === key) {
      R.last.n++;
      const x = R.last.row.querySelector('.cn-x');
      x.hidden = false; x.textContent = R.last.n > 999 ? '999+' : String(R.last.n);
      R.last.row.dataset.seq = e.seq;
      continue;
    }
    const row = cnRow(e);
    R.last = { key, n: 1, row };
    frag.append(row); R.rows++;
    if (e.type === 'group' && CN.collapsed.has(e.seq)) R.hide[doc] = e.g || 0;
  }
  box.append(frag);
  while (R.rows > CN_MAX_ROWS && box.firstElementChild) { box.firstElementChild.remove(); R.rows--; }
  $('cnEmpty').hidden = R.rows > 0;
  if (CN.stick || (atBottom && !CN.paused)) { box.scrollTop = box.scrollHeight; CN.stick = false; }
}
function renderCn() {
  clear($('cnList'));
  CN.r = null; CN.stick = true;
  const list = CN.items.filter(cnMatch);
  cnAppend(list.length > CN_MAX_ROWS ? list.slice(-CN_MAX_ROWS) : list);
  const hint = $('cnEmpty');
  hint.textContent = CN.items.some(cnLive) ? 'No messages match the filter.'
    : shown ? 'No console messages in this session.' : 'No console messages yet. With the page agent on, every page you open in the CupNet Chrome sends its console here.';
  renderCnCounts(); renderCnPause();
}
function renderCnCounts() {
  const c = { error: 0, warn: 0, info: 0, verbose: 0 };
  for (const e of CN.items) if (cnLive(e) && e.type !== 'command' && e.type !== 'result') c[e.sev || 'info'] = (c[e.sev || 'info'] || 0) + 1;
  const box = clear($('cnLevels'));
  for (const [k, label] of CN_LEVELS) {
    box.append(h('button', { type: 'button', class: `chip lv-${k}${CN.levels[k] ? ' on' : ''}`, title: 'Click to show/hide · Alt-click to show only this level', onclick: (ev) => {
      if (ev.altKey) for (const [x] of CN_LEVELS) CN.levels[x] = x === k;
      else CN.levels[k] = !CN.levels[k];
      store.set('cn-levels', CN.levels); renderCn();
    } }, label, h('b', null, c[k] ? c[k].toLocaleString() : '0')));
  }
  $('cnShown').textContent = shown ? `session ${shown}` : '';
}
function renderCnPause() {
  const b = $('cnPause');
  b.classList.toggle('on', CN.paused);
  b.textContent = CN.paused ? (CN.pending ? `Resume · ${CN.pending} new` : 'Resume') : 'Pause';
}
function renderCnPages() {
  const docs = new Map();
  for (const p of PG.list) docs.set(p.id, { id: p.id, label: pageLabel(p), live: p.live, frame: p.frame, errors: p.errors });
  for (let i = CN.items.length - 1; i >= 0 && docs.size < 400; i--) {
    const e = CN.items[i];
    if (e.doc && !docs.has(e.doc)) docs.set(e.doc, { id: e.doc, label: `${splitUrl(e.url).join('')}`, live: false, frame: 0 });
  }
  const fill = (sel, first, list, value) => {
    const key = JSON.stringify([first, list.map((d) => [d.id, d.label, d.live, d.frame])]);
    if (sel.dataset.key !== key) {
      sel.dataset.key = key;
      clear(sel);
      if (first) sel.append(h('option', { value: '' }, first));
      for (const d of list) sel.append(h('option', { value: d.id }, `${d.live ? '●' : '○'} ${d.frame ? '↳ ' : ''}${d.label}`));
    }
    sel.value = list.some((d) => d.id === value) || (first && !value) ? value : (first ? '' : list[0]?.id || '');
  };
  const listAll = [...docs.values()];
  fill($('cnDoc'), 'All pages', listAll, CN.doc);
  if ($('cnDoc').value !== CN.doc) { CN.doc = $('cnDoc').value; renderCn(); }
  const live = listAll.filter((d) => d.live);
  if (!CN.target || !live.some((d) => d.id === CN.target)) CN.target = (CN.doc && live.some((d) => d.id === CN.doc)) ? CN.doc : live[0]?.id || '';
  fill($('cnTarget'), live.length ? null : 'No live page', live, CN.target);
  $('cnTarget').disabled = !live.length;
  $('cnRun').disabled = !live.length;
}

// ── prompt ──
function cnAutosize() { const t = $('cnCode'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 220)}px`; }
function cnEdit(text) { $('cnCode').value = text; cnAutosize(); $('cnCode').focus(); }
async function cnRun() {
  const t = $('cnCode'), code = t.value;
  if (!code.trim()) return;
  const id = CN.target;
  if (!id) { toast('No live page — open or reload a page in the CupNet Chrome', 'warn'); return; }
  if (CN.hist[CN.hist.length - 1] !== code) { CN.hist.push(code); if (CN.hist.length > 100) CN.hist.shift(); store.set('cn-hist', CN.hist); }
  CN.hpos = -1; t.value = ''; cnAutosize();
  if (CN.paused) { CN.paused = false; renderCnPause(); }
  CN.stick = true;
  $('cnRun').disabled = true; $('cnRunDot').hidden = false;
  try {
    const r = await post(`/api/pages/${id}/eval`, { code, await: CN.await });
    if (r.seq) {
      CN.values.set(r.seq, r.ok ? r.value : r.error);
      if (r.via && r.via !== 'eval') CN.via.set(r.seq, r.via);
      const row = $('cnList').querySelector(`.cn-row[data-seq="${r.seq}"]`);
      if (row) cnInlineValue(row, r.seq);
    }
    if (shown) toast(r.ok ? `‹ ${r.text}` : r.text, r.ok ? '' : 'err', { ms: 8000 });
  } catch (e) {
    toast(e.message, 'err');
    if (!t.value) { t.value = code; cnAutosize(); }
  } finally { $('cnRun').disabled = false; $('cnRunDot').hidden = true; }
}
$('cnCode').addEventListener('input', cnAutosize);
$('cnCode').addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); guard(cnRun)(); return; }
  if ((ev.key === 'l' || ev.key === 'k') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); cnClear(); return; }
  if (ev.key === 'ArrowUp' && !t.value.slice(0, t.selectionStart).includes('\n') && CN.hist.length) {
    ev.preventDefault();
    if (CN.hpos < 0) { CN.draft = t.value; CN.hpos = CN.hist.length; }
    CN.hpos = Math.max(0, CN.hpos - 1); t.value = CN.hist[CN.hpos]; cnAutosize();
  } else if (ev.key === 'ArrowDown' && CN.hpos >= 0 && !t.value.slice(t.selectionEnd).includes('\n')) {
    ev.preventDefault();
    CN.hpos++;
    if (CN.hpos >= CN.hist.length) { CN.hpos = -1; t.value = CN.draft; } else t.value = CN.hist[CN.hpos];
    cnAutosize();
  } else if (ev.key === 'Escape') { t.value = ''; CN.hpos = -1; cnAutosize(); }
});
$('cnRun').addEventListener('click', guard(cnRun));
$('cnTarget').addEventListener('change', () => { CN.target = $('cnTarget').value; });
$('cnAwait').checked = CN.await;
$('cnAwait').addEventListener('change', () => { CN.await = $('cnAwait').checked; store.set('cn-await', CN.await); });

// ── toolbar ──
function cnClear() { CN.clearedAfter = CN.items.length ? CN.items[CN.items.length - 1].seq : 0; CN.pending = 0; renderCn(); }
/** Scroll to one entry (from Traffic) and flash it; clears filters that would hide it. */
function cnReveal(seq) {
  const e = CN.items.find((x) => x.seq === seq);
  go('console');
  if (!e) return;
  if (!cnMatch(e)) {
    if (e.seq <= CN.clearedAfter) CN.clearedAfter = 0;
    if (CN.doc && CN.doc !== e.doc) CN.doc = '';
    CN.levels[e.sev || 'info'] = true; $('cnQ').value = ''; cnSetQuery('');
    renderCnPages(); renderCn();
  }
  const row = $('cnList').querySelector(`.cn-row[data-seq="${seq}"]`);
  if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600); }
}
$('cnQ').addEventListener('input', () => debounce('cnq', 120, () => { cnSetQuery($('cnQ').value); renderCn(); }));
$('cnDoc').addEventListener('change', () => { CN.doc = $('cnDoc').value; if (CN.doc && pageById(CN.doc)?.live) CN.target = CN.doc; renderCnPages(); renderCn(); });
$('cnGroup').checked = CN.group;
$('cnGroup').addEventListener('change', () => { CN.group = $('cnGroup').checked; store.set('cn-group', CN.group); renderCn(); });
$('cnTimes').checked = CN.times;
$('cnTimes').addEventListener('change', () => { CN.times = $('cnTimes').checked; store.set('cn-times', CN.times); renderCn(); });
$('cnPause').addEventListener('click', () => {
  CN.paused = !CN.paused;
  if (!CN.paused) { CN.pending = 0; renderCn(); } else renderCnPause();
});
$('cnClear').addEventListener('click', cnClear);
$('cnExport').addEventListener('click', () => {
  const list = CN.items.filter(cnMatch);
  if (!list.length) { toast('Nothing to export', 'warn'); return; }
  const text = list.map((e) => `${new Date(e.ts).toISOString()} ${(e.type || 'log').padEnd(9)} ${e.note || ''}${e.src ? `  (${e.src})` : ''}  [${e.url || ''}]`).join('\n');
  download(new Blob([`${text}\n`], { type: 'text/plain' }), `console-${shown || current}.log`);
});
$('cnList').addEventListener('scroll', () => {
  const box = $('cnList');
  $('cnJump').hidden = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
}, { passive: true });
$('cnJump').addEventListener('click', () => { const b = $('cnList'); b.scrollTop = b.scrollHeight; });

function loadConsole() {
  CN.unseen = 0; renderCnBadge();
  cnSetQuery($('cnQ').value);
  renderCnPages(); renderCn(); renderBanner($('cnBanner'));
  pagePoll();
  if (!$('cnCode').value) setTimeout(() => { if (PAGE === 'console' && document.activeElement === document.body) $('cnCode').focus(); }, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page analyzer
// ─────────────────────────────────────────────────────────────────────────────
const AN = {
  sel: '', reports: new Map(), errors: new Map(), busy: new Set(), tab: store.get('an-tab', 'overview'),
  auto: store.get('an-auto', false), timer: 0, epq: '', st: 'local', showGone: store.get('an-gone', false), q: '',
};
const AN_AUTO_MS = 5000;
const AN_TABS = [['overview', 'Overview'], ['forms', 'Forms'], ['captcha', 'Captcha'], ['endpoints', 'Endpoints'], ['storage', 'Storage'], ['cookies', 'Cookies'], ['security', 'Security'], ['meta', 'Meta']];

function anPagesShown() {
  const q = AN.q.toLowerCase();
  return PG.list.filter((p) => (AN.showGone || p.live || p.id === AN.sel) && (!q || `${p.title} ${p.url}`.toLowerCase().includes(q)));
}
function renderAnPages() {
  const list = anPagesShown();
  if (!AN.sel || !PG.list.some((p) => p.id === AN.sel)) {
    const first = list.find((p) => p.live && !p.frame) || list[0];
    if (first) { AN.sel = first.id; renderAnMain(); if (!AN.reports.has(first.id)) guard(anAnalyze)(); }
  }
  const box = clear($('anList'));
  const gone = PG.list.filter((p) => !p.live).length;
  $('anGoneN').textContent = gone ? `(${gone})` : '';
  if (!list.length) {
    box.append(h('div', { class: 'empty' }, !PG.enabled ? 'Turn the page agent on, then reload a page.'
      : PG.list.length ? 'No page matches.' : 'No pages yet. Open or reload a page in the CupNet Chrome.'));
    return;
  }
  for (const p of list) {
    const [host, path] = splitUrl(p.url);
    box.append(h('div', { class: `prow an-prow${p.id === AN.sel ? ' sel' : ''}${p.live ? '' : ' off'}`, onclick: () => {
      AN.sel = p.id; renderAnPages(); renderAnMain();
      if (!AN.reports.has(p.id) && p.live) guard(anAnalyze)();
    } },
    h('i', { class: `dot${p.live ? ' ok' : ''}`, title: p.live ? 'Live' : 'Closed or navigated away' }),
    h('div', { class: 'ell' },
      h('div', { class: 'title' }, p.frame ? tag('iframe') : null, h('b', { title: p.title }, p.title || host)),
      h('div', { class: 'meta' }, h('span', { class: 'mono', title: p.url }, `${host}${path}`))),
    h('div', { class: 'acts' },
      p.errors ? tag(String(p.errors), 'err') : null, p.warnings ? tag(String(p.warnings), 'warn') : null,
      p.visible === false && p.live ? h('span', { class: 'faint', title: 'Tab in the background' }, '◐') : null)));
  }
}
function anCounts(r) {
  if (!r) return {};
  const fields = (r.forms || []).reduce((n, f) => n + (f.fields || []).length, 0) + ((r.extra?.orphanFields) || []).length;
  return {
    forms: fields ? `${(r.forms || []).length}·${fields}` : 0,
    captcha: r.captcha?.totalCount || 0,
    endpoints: r.endpoints?.endpoints?.length || 0,
    storage: Object.keys(r.extra?.storage?.local || {}).length + Object.keys(r.extra?.storage?.session || {}).length,
    cookies: (r.cookies || []).length,
    security: (r.security || []).filter((s) => s.status === 'warn' || s.status === 'bad').length,
    meta: (r.meta?.meta || []).length,
  };
}
function renderAnHead() {
  const head = $('anHead');
  if (!head) return;
  const p = pageById(AN.sel);
  const r = AN.reports.get(AN.sel);
  clear(head);
  if (!p) return;
  const busyNow = AN.busy.has(p.id);
  head.append(
    h('div', { class: 'an-title' },
      h('i', { class: `dot${busyNow ? ' busy' : p.live ? ' ok' : ''}` }),
      h('div', { class: 'ell' }, h('div', { class: 'an-name ell', title: p.title }, p.title || splitUrl(p.url)[0]), h('div', { class: 'mono muted ell', title: p.url }, p.url))),
    h('div', { class: 'an-acts' },
      r ? h('span', { class: 'faint', title: `Scan took ${r.durationMs} ms` }, `scanned ${fmtAgo(r.at)}`) : null,
      sw(AN.auto, 'Auto', (v) => { AN.auto = v; store.set('an-auto', v); anSchedule(); }, `Re-scan every ${AN_AUTO_MS / 1000} s while this page is open`),
      h('button', { class: 'btn sm', disabled: !r, onclick: () => copy(JSON.stringify(r, null, 2), 'Report copied') }, 'Copy JSON'),
      h('button', { class: 'btn sm', onclick: () => { CN.doc = p.id; if (p.live) CN.target = p.id; go('console'); } }, 'Console'),
      h('button', { class: 'btn primary sm', disabled: busyNow || !p.live, title: p.live ? 'Scan the page again' : 'The page is gone — reload it in Chrome', onclick: guard(() => anAnalyze()) }, busyNow ? 'Scanning…' : r ? 'Rescan' : 'Scan')));
}
function renderAnMain() {
  const main = clear($('anMain'));
  const p = pageById(AN.sel);
  if (!p) { main.append(h('div', { class: 'empty' }, PG.list.length ? 'Pick a page on the left.' : 'Pages show up here once they load with the page agent on.')); return; }
  const r = AN.reports.get(p.id);
  main.append(h('div', { class: 'an-head', id: 'anHead' }));
  renderAnHead();
  const c = anCounts(r);
  main.append(h('div', { class: 'tabs', id: 'anTabs' }, AN_TABS.map(([k, label]) => h('button', { class: AN.tab === k ? 'on' : '', onclick: () => { AN.tab = k; store.set('an-tab', k); renderAnMain(); } },
    label, c[k] ? tag(String(c[k]), k === 'security' ? 'warn' : k === 'captcha' ? 'accent' : '') : null))));
  const body = h('div', { class: 'an-body', id: 'anBody' });
  main.append(body);
  const err = AN.errors.get(p.id);
  if (err) body.append(h('div', { class: 'note warn' }, err));
  if (!r) { if (!err) body.append(h('div', { class: 'empty' }, AN.busy.has(p.id) ? 'Scanning the page…' : p.live ? 'Not scanned yet.' : 'This page is gone — reload it in Chrome to scan it.')); return; }
  ({ overview: anOverview, forms: anForms, captcha: anCaptcha, endpoints: anEndpoints, storage: anStorage, cookies: anCookies, security: anSecurity, meta: anMeta }[AN.tab] || anOverview)(body, r, p);
}
async function anAnalyze(o = {}) {
  const id = AN.sel;
  if (!id || AN.busy.has(id)) return;
  AN.busy.add(id);
  if (!o.quiet) { renderAnHead(); if (!AN.reports.has(id)) renderAnMain(); }
  try {
    const r = await post(`/api/pages/${id}/analyze`, { fetchMissing: !!o.fetchMissing });
    AN.reports.set(id, r); AN.errors.delete(id);
  } catch (e) {
    AN.errors.set(id, e.message);
    if (!o.quiet) toast(e.message, 'err');
  } finally {
    AN.busy.delete(id);
    if (PAGE === 'analyzer' && AN.sel === id) {
      const body = $('anBody'), top = body ? body.scrollTop : 0;
      if (o.quiet && document.activeElement && $('anMain').contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) renderAnHead();
      else { renderAnMain(); if ($('anBody')) $('anBody').scrollTop = top; }
    }
  }
}
function anSchedule() {
  clearTimeout(AN.timer);
  if (!AN.auto || PAGE !== 'analyzer') return;
  AN.timer = setTimeout(async () => {
    if (PAGE !== 'analyzer') return;
    if (pageById(AN.sel)?.live) await anAnalyze({ quiet: true });
    anSchedule();
  }, AN_AUTO_MS);
}

// ── analyzer tabs ──
const tile = (v, k, cls = '', title) => h('div', { class: `tile ${cls}`, title }, h('div', { class: 'tile-v' }, v), h('div', { class: 'tile-k' }, k));
const ms = (n) => (n == null || n < 0 ? '—' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const fmtVal = (v) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(', ') : x}`).join(' · ') : String(v));
const copyBtn = (text, what) => h('button', { class: 'icon', title: 'Copy', onclick: (ev) => { ev.stopPropagation(); copy(text, what); } }, '⧉');

function anOverview(b, r, p) {
  const t = r.extra?.timing || {}, env = r.extra?.env || {}, doc = r.document;
  b.append(h('div', { class: 'ipw-tiles an-tiles' },
    tile(doc ? String(doc.status || 'ERR') : '—', 'Document', doc && (doc.status >= 400 || !doc.status) ? 'err' : '', doc ? `${doc.mime || ''} · ${fmtSize(doc.resSize) || '0 B'}` : 'The document request is not in this session'),
    tile(ms(t.ttfb), 'First byte'), tile(ms(t.domContentLoaded), 'DOM ready'), tile(ms(t.load), 'Load'),
    tile(String(t.resources ?? '—'), 'Resources', '', fmtVal(t.byType)),
    tile(String(p.errors || 0), 'Console errors', p.errors ? 'err' : ''),
    tile(env.webdriver ? 'true' : 'false', 'webdriver', env.webdriver ? 'err' : '', 'navigator.webdriver as the page sees it')));
  const docRows = [['URL', p.url], ['Title', r.meta?.title || p.title || ''], ['Referrer', p.referrer || '—'], ['Protocol', t.protocol || '—'], ['Navigation', t.type || '—'],
    ['Transfer', `${fmtSize(t.docBytes) || '—'} document (as Chrome received it, incl. CupNet agent) · ${fmtSize(t.resourceBytes) || '0 B'} resources`]];
  if (doc) docRows.push(['Response', `${doc.status} · ${doc.mime || ''} · ${fmtSize(doc.resSize) || '0 B'} · ${doc.duration ?? '?'} ms`]);
  const docBox = kvGrid(docRows);
  b.append(sect('Document', docBox, true, doc ? h('button', { class: 'btn sm', onclick: () => showInTraffic(doc.seq) }, `#${doc.seq} in Traffic`) : null));
  const tech = r.extra?.tech || [];
  b.append(sect('Technologies', tech.length ? h('div', { class: 'chips' }, tech.map((x) => tag(`${x.name}${x.version ? ` ${x.version}` : ''}`, 'accent'))) : h('div', { class: 'muted' }, 'Nothing recognised'), true, tag(tech.length)));
  if (r.captcha?.found) b.append(sect('Challenges', h('div', { class: 'chips' }, ['recaptcha', 'hcaptcha', 'turnstile', 'geetest', 'other'].filter((k) => (r.captcha[k] || []).length).map((k) => h('button', { class: 'tag warn an-link', onclick: () => { AN.tab = 'captcha'; renderAnMain(); } }, `${CAPTCHA_NAMES[k]} × ${r.captcha[k].length}`)))));
  const envRows = Object.entries(env).map(([k, v]) => [k, k === 'webdriver' && v ? h('span', { class: 'err' }, 'true — automation is visible to the page') : fmtVal(v)]);
  b.append(sect('Environment (as the page sees it)', kvGrid(envRows), true));
  if (doc) { const hp = pairsOf(doc.headers); b.append(sect('Response headers', kvGrid(hp), false, tag(hp.length))); }
}

function anFieldAction(form, f, type, value) {
  return post(`/api/pages/${AN.sel}/action`, { op: 'form', type, form, field: f.index, value }).then((r) => {
    if (r && r.ok === false) throw new Error(r.text || 'The page refused');
    return r;
  });
}
function anFieldRow(formIdx, f) {
  const pw = f.type === 'password' || f._pw;
  const val = h('input', { type: pw && !f._reveal ? 'password' : 'text', class: 'mono an-val', value: f.value || '', placeholder: f.placeholder || '', spellcheck: false });
  const set = guard(async () => { await anFieldAction(formIdx, f, 'set-value', val.value); f.value = val.value; toast(`${f.name || f.tag} set`, 'ok'); });
  val.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); set(); } });
  const act = (icon, type, title, after, on) => h('button', { class: `btn sm an-fact${on ? ' on' : ''}`, title, 'aria-label': title, onclick: guard(async () => { await anFieldAction(formIdx, f, type); if (after) after(); renderAnMain(); }) }, icon);
  const flags = [f.hidden || f.type === 'hidden' ? tag('hidden') : null, !f.visible && !f.hidden && f.type !== 'hidden' ? tag('invisible') : null,
    f.disabled ? tag('disabled', 'warn') : null, f.readonly ? tag('readonly', 'warn') : null, f.required ? tag('required', 'accent') : null];
  return h('tr', null,
    h('td', { class: 'faint' }, String(f.index)),
    h('td', { class: 'mono' }, f.tag === 'input' ? f.type || 'text' : f.tag),
    h('td', { class: 'mono', title: `${f.name || ''}${f.id ? ` #${f.id}` : ''}${f.className ? ` .${f.className}` : ''}` }, f.name || h('span', { class: 'faint' }, f.id ? `#${f.id}` : '—')),
    h('td', { class: 'an-valcell' }, h('div', { class: 'an-valrow' }, val, h('button', { class: 'btn sm', title: 'Write the value into the page (fires input + change)', onclick: set }, 'Set'))),
    h('td', { class: 'an-flags' }, flags),
    h('td', { class: 'an-facts' }, h('div', { class: 'an-factrow' },
      act('⌖', 'focus', 'Focus — scroll to the field and focus it'),
      f.hidden || f.type === 'hidden' || !f.visible ? act('◐', 'show', 'Show — force the field visible (type=hidden → text)', () => { f.hidden = false; f.visible = true; f._shown = true; })
        : f._shown ? act('◐', 'hide', 'Unshow — undo Show', () => { f._shown = false; }, true) : null,
      act('⊘', 'toggle-disabled', f.disabled ? 'Enable the field' : 'Disable the field', () => { f.disabled = !f.disabled; }, f.disabled),
      act('✎', 'toggle-readonly', f.readonly ? 'Make writable' : 'Make read-only', () => { f.readonly = !f.readonly; }, f.readonly),
      pw ? act('👁', 'toggle-password', f._reveal ? 'Mask — switch the page field back to password' : 'Reveal — switch the page field from password to text', () => { f._pw = true; f._reveal = !f._reveal; }, f._reveal) : null)));
}
function formCurl(form) {
  const pairs = (form.fields || []).filter((f) => f.name && f.tag !== 'button' && !['submit', 'button', 'reset', 'image', 'file'].includes(f.type)).map((f) => [f.name, f.value || '']);
  const body = new URLSearchParams(pairs).toString();
  const method = (form.method || 'GET').toUpperCase();
  let url = form.action || pageById(AN.sel)?.url || '';
  if (method === 'GET' && body) url += (url.includes('?') ? '&' : '?') + body;
  return { method, url, body: method === 'GET' ? '' : body, headers: method === 'GET' ? [] : [['Content-Type', 'application/x-www-form-urlencoded']] };
}
function anForms(b, r) {
  const forms = r.forms || [], orphans = r.extra?.orphanFields || [];
  if (!forms.length && !orphans.length) { b.append(h('div', { class: 'empty' }, 'No forms or inputs on this page.')); return; }
  const table = (formIdx, fields) => h('div', { class: 'an-tblwrap' }, h('table', { class: 'tbl an-ftbl' },
    h('thead', null, h('tr', null, h('th', { class: 'w-28' }, '#'), h('th', { class: 'w-60' }, 'Type'), h('th', { class: 'w-90' }, 'Name'), h('th', null, 'Value'), h('th', { class: 'w-90' }, 'Flags'), h('th', { class: 'an-facts-h' }, ''))),
    h('tbody', null, fields.map((f) => anFieldRow(formIdx, f)))));
  for (const form of forms) {
    const req = formCurl(form);
    b.append(h('div', { class: 'an-card' },
      h('div', { class: 'an-card-h' },
        h('b', null, `Form ${form.index}`), badge(req.method, `m-${req.method}`), h('span', { class: 'mono ell', title: form.action }, form.action || '(this page)'),
        form.id ? tag(`#${form.id}`) : null, form.name ? tag(`name=${form.name}`) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', title: 'Open the form submission (current values) in Repeater', onclick: () => { rpLoad(req); go('repeater'); } }, 'Repeater'),
        h('button', { class: 'btn sm', onclick: () => copy(curlOf(req), 'curl copied') }, 'Copy curl')),
      table(form.index, form.fields || [])));
  }
  if (orphans.length) b.append(h('div', { class: 'an-card' }, h('div', { class: 'an-card-h' }, h('b', null, 'Fields outside any form'), tag(orphans.length), h('span', { class: 'muted' }, 'Typical for SPAs — the request is built in JS (see Endpoints).')), table(-1, orphans)));
}
function curlOf(req) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return [`curl -X ${req.method} ${q(req.url)}`, ...req.headers.map(([k, v]) => `  -H ${q(`${k}: ${v}`)}`), ...(req.body ? [`  --data ${q(req.body)}`] : [])].join(' \\\n');
}

const CAPTCHA_NAMES = { recaptcha: 'reCAPTCHA', hcaptcha: 'hCaptcha', turnstile: 'Cloudflare Turnstile', geetest: 'GeeTest', other: 'Other' };
function anCaptcha(b, r) {
  const c = r.captcha || {};
  if (!c.found) { b.append(h('div', { class: 'empty' }, 'No captcha or challenge widget found in the page DOM.')); return; }
  for (const k of Object.keys(CAPTCHA_NAMES)) {
    for (const [i, it] of (c[k] || []).entries()) {
      const rows = Object.entries(it).filter(([, v]) => v !== '' && v != null).map(([kk, v]) => [kk, h('span', { class: 'an-copyable' }, fmtVal(v), copyBtn(fmtVal(v), `${kk} copied`))]);
      b.append(h('div', { class: 'an-card' },
        h('div', { class: 'an-card-h' }, h('b', null, CAPTCHA_NAMES[k]), (c[k] || []).length > 1 ? tag(`${i + 1}/${c[k].length}`) : null, it.iframe ? tag('in iframe') : null,
          h('span', { class: 'spacer' }),
          it.selector ? h('button', { class: 'btn sm', title: 'Outline the widget in the page', onclick: guard(async () => { const x = await post(`/api/pages/${AN.sel}/action`, { op: 'highlight', selector: it.selector }); if (x && x.ok === false) toast(x.text || 'Not found', 'warn'); }) }, 'Highlight') : null),
        kvGrid(rows)));
    }
  }
  b.append(h('p', { class: 'muted' }, 'Detection only: CupNet does not solve or bypass challenges.'));
}

function anEndpoints(b, r) {
  const ep = r.endpoints;
  if (!ep) { b.append(h('div', { class: 'empty' }, 'The endpoint scan did not run.')); return; }
  const cats = Object.entries(ep.categoryCounts || {}).sort((x, y) => y[1] - x[1]);
  const q = h('input', { type: 'search', placeholder: 'Filter endpoints…', value: AN.epq });
  const list = h('tbody');
  const det = ep.endpointsDetailed || [];
  const paint = () => {
    clear(list);
    const lq = AN.epq.toLowerCase();
    const rows = det.filter((d) => !lq || d.path.toLowerCase().includes(lq) || (d.payloadKeys || []).some((k) => k.toLowerCase().includes(lq)));
    for (const d of rows.slice(0, 1000)) {
      const tr = h('tr', { class: 'an-ep' },
        h('td', { title: d.path }, h('div', { class: 'mono' }, d.path), (d.sources || []).length ? h('div', { class: 'an-epsrc ell' }, (d.sources || []).join(', ')) : null),
        h('td', null, (d.methods || []).map((m) => badge(m, `m-${m}`))),
        h('td', { class: 'mono muted', title: (d.payloadKeys || []).join(', ') }, (d.payloadKeys || []).join(', ')),
        h('td', { class: 'r-al' }, String((d.hits || []).length)),
        h('td', null, copyBtn(d.path, 'Path copied')));
      const more = h('tr', { class: 'an-hits', hidden: true }, h('td', { colspan: 5 }, (d.hits || []).slice(0, 20).map((x) => h('div', { class: 'mono an-hit' }, h('span', { class: 'faint' }, `${x.source}${x.line ? `:${x.line}` : ''} `), x.preview || ''))));
      tr.addEventListener('click', () => { more.hidden = !more.hidden; tr.classList.toggle('open', !more.hidden); });
      list.append(tr, more);
    }
    if (!rows.length) list.append(h('tr', null, h('td', { colspan: 5, class: 'muted' }, det.length ? 'No endpoint matches.' : 'No endpoints found.')));
  };
  q.addEventListener('input', () => { AN.epq = q.value; paint(); });
  paint();
  const missing = ep.missing || [];
  b.append(h('div', { class: 'an-epbar' }, q,
    h('span', { class: 'muted' }, `${(ep.endpoints || []).length} endpoints · ${ep.inlineCount || 0} inline + ${ep.fromLog || 0} logged${ep.fetched ? ` + ${ep.fetched} fetched` : ''} scripts`),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', disabled: !(ep.endpoints || []).length, onclick: () => copy((ep.endpoints || []).join('\n'), 'Endpoints copied') }, 'Copy all')));
  if (cats.length) b.append(h('div', { class: 'chips an-cats' }, cats.map(([k, n]) => h('span', { class: 'tag' }, k, h('b', null, ` ${n}`)))));
  b.append(h('table', { class: 'tbl an-eptbl' }, h('thead', null, h('tr', null, h('th', null, 'Path · found in'), h('th', { class: 'w-110' }, 'Methods'), h('th', { class: 'w-180' }, 'Payload keys'), h('th', { class: 'w-60 r-al' }, 'Hits'), h('th', { class: 'w-28' }, ''))), list));
  if (missing.length) {
    b.append(h('div', { class: 'note warn an-missing' },
      h('div', null, h('b', null, `${missing.length} script(s) not in this session`), ' — loaded from cache, or before CupNet started. Fetching them sends GET requests through the current proxy and TLS profile (logged as type ', h('code', null, 'analyzer'), ').'),
      h('div', { class: 'an-miss-list mono' }, missing.slice(0, 12).map((u) => h('div', { class: 'ell', title: u }, u)), missing.length > 12 ? h('div', { class: 'faint' }, `… ${missing.length - 12} more`) : null),
      h('button', { class: 'btn sm', onclick: guard(async (ev) => { await busy(ev.currentTarget, 'Fetching…', () => anAnalyze({ fetchMissing: true })); }) }, 'Fetch and rescan')));
  }
  const scanned = ep.scannedScripts || [];
  if (scanned.length) {
    b.append(sect('Scanned scripts', h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Script'), h('th', { class: 'w-60' }, 'Status'), h('th', { class: 'w-90 r-al' }, 'Size'), h('th', { class: 'w-60 r-al' }, 'Hits'))),
      h('tbody', null, scanned.map((s) => {
        const seq = /^https?:/i.test(s.url) ? findRequestFor(s.url) : null;
        return h('tr', null, h('td', { class: 'mono', title: s.url }, seq ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); showInTraffic(seq); } }, s.url) : s.url),
          h('td', { class: `mono ${stCls(s.statusCode)}` }, String(s.statusCode || '—')), h('td', { class: 'r-al' }, fmtSize(s.bodyLength) || '0 B'), h('td', { class: 'r-al' }, String(s.endpointHits || 0)));
      }))), false, tag(scanned.length)));
  }
}

function anStorage(b, r) {
  const st = r.extra?.storage || { local: {}, session: {} };
  const data = st[AN.st] || {};
  const rows = Object.entries(data).map(([k, v]) => ({ k, v, k0: k, v0: v, del: false }));
  const tbody = h('tbody');
  const paint = () => {
    clear(tbody);
    for (const row of rows) {
      const kIn = h('input', { type: 'text', class: 'mono', value: row.k, spellcheck: false, oninput: (ev) => { row.k = ev.target.value; mark(); } });
      const vIn = h('textarea', { class: 'mono an-stv', value: row.v, rows: 1, spellcheck: false, oninput: (ev) => { row.v = ev.target.value; mark(); } });
      const pretty = (() => { try { const j = JSON.parse(row.v); return j && typeof j === 'object'; } catch { return false; } })();
      tbody.append(h('tr', { class: row.del ? 'del' : '' },
        h('td', null, kIn),
        h('td', null, vIn),
        h('td', { class: 'r-al' }, fmtSize(row.v.length) || '0 B'),
        h('td', { class: 'an-stacts' },
          pretty ? h('button', { class: 'icon', title: 'Format JSON', onclick: () => { row.v = JSON.stringify(JSON.parse(row.v), null, 2); paint(); mark(); } }, '{}') : null,
          copyBtn(row.v, 'Value copied'),
          h('button', { class: 'icon', title: row.del ? 'Keep' : 'Delete', onclick: () => { row.del = !row.del; paint(); mark(); } }, row.del ? '↺' : '✕'))));
    }
    if (!rows.length) tbody.append(h('tr', null, h('td', { colspan: 4, class: 'muted' }, `${AN.st === 'local' ? 'localStorage' : 'sessionStorage'} is empty`)));
  };
  const save = h('button', { class: 'btn primary sm', disabled: true }, 'Save to page');
  const revert = h('button', { class: 'btn sm', disabled: true, onclick: () => renderAnMain() }, 'Revert');
  const changes = () => {
    const out = {};
    for (const row of rows) {
      if (row.del) { if (row.k0 != null) out[row.k0] = null; continue; }
      if (!row.k) continue;
      if (row.k0 != null && row.k0 !== row.k) out[row.k0] = null;
      if (row.k !== row.k0 || row.v !== row.v0) out[row.k] = row.v;
    }
    return out;
  };
  const mark = () => { const n = Object.keys(changes()).length; save.disabled = !n; revert.disabled = !n; save.textContent = n ? `Save ${n} change${n > 1 ? 's' : ''}` : 'Save to page'; };
  save.addEventListener('click', guard(async () => {
    const data2 = changes();
    await busy(save, 'Saving…', () => post(`/api/pages/${AN.sel}/action`, { op: 'storage', which: AN.st, data: data2 }));
    toast('Storage updated in the page', 'ok');
    await anAnalyze({ quiet: true });
  }));
  paint();
  b.append(h('div', { class: 'an-epbar' },
    seg([['local', `localStorage · ${Object.keys(st.local || {}).length}`], ['session', `sessionStorage · ${Object.keys(st.session || {}).length}`]], AN.st, (v) => { AN.st = v; renderAnMain(); }),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onclick: () => { rows.push({ k: '', v: '', k0: null, v0: null, del: false }); paint(); mark(); tbody.querySelector('tr:last-child input')?.focus(); } }, '+ Add'),
    h('button', { class: 'btn sm', disabled: !rows.length, onclick: () => copy(JSON.stringify(data, null, 2), 'Storage copied') }, 'Copy JSON'),
    revert, save));
  b.append(h('table', { class: 'tbl an-sttbl' }, h('thead', null, h('tr', null, h('th', { class: 'w-180' }, 'Key'), h('th', null, 'Value'), h('th', { class: 'w-80 r-al' }, 'Size'), h('th', { class: 'w-80' }, ''))), tbody));
}

function anCookies(b, r) {
  const list = r.cookies || [];
  b.append(h('div', { class: 'an-epbar' },
    h('span', { class: 'muted' }, `${list.length} cookie(s) Chrome sends to this host · ${list.filter((c) => c.httpOnly).length} HttpOnly · ${list.filter((c) => c.inJs).length} visible to page JS`),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onclick: () => {
      try { $('ckSiteQ').value = new URL(pageById(AN.sel)?.url || '').hostname.replace(/^www\./, ''); } catch { /* no URL */ }
      CK.site = ''; store.set('ck-site', ''); go('cookies');
    } }, 'Open in Cookies')));
  if (!list.length) { b.append(h('div', { class: 'empty' }, 'No cookies for this host in the cookie store.')); return; }
  b.append(h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, h('th', { class: 'w-180' }, 'Name'), h('th', null, 'Value'), h('th', { class: 'w-180' }, 'Domain · path'), h('th', { class: 'w-130' }, 'Expires'), h('th', { class: 'w-180' }, 'Flags'))),
    h('tbody', null, list.map((c) => h('tr', null,
      h('td', { class: 'mono', title: c.name }, c.name),
      h('td', { class: 'mono', title: c.value }, h('span', { class: 'an-copyable' }, c.value, copyBtn(c.value, 'Value copied'))),
      h('td', { class: 'mono muted', title: `${c.domain}${c.path}` }, `${c.hostOnly ? '' : '.'}${c.domain}${c.path || '/'}`),
      h('td', { class: 'muted' }, c.expires ? new Date(c.expires * (c.expires < 1e11 ? 1000 : 1)).toLocaleString() : 'session'),
      h('td', null, c.secure ? tag('Secure') : null, c.httpOnly ? tag('HttpOnly', 'accent') : null, c.sameSite ? tag(c.sameSite) : null, c.partitioned ? tag('CHIPS') : null, c.inJs ? tag('in JS', 'ok') : null))))));
}

// Statuses from page-analyzer.js auditSecurityHeaders.
const SEC_ICON = { good: ['✓', 'ok'], warn: ['!', 'warn'], bad: ['✕', 'err'], info: ['i', ''] };
function anSecurity(b, r) {
  if (!r.security) { b.append(h('div', { class: 'empty' }, 'The document request is not in this session (loaded before CupNet started, or from cache) — reload the page to audit its headers.')); return; }
  const n = (s) => r.security.filter((x) => x.status === s).length;
  b.append(h('div', { class: 'chips an-cats' }, tag(`${n('good')} ok`, 'ok'), tag(`${n('bad')} missing`, 'err'), tag(`${n('warn')} to review`, 'warn'), tag(`${n('info')} info`)));
  b.append(h('div', { class: 'an-sec' }, r.security.map((s) => {
    const [ic, cls] = SEC_ICON[s.status] || SEC_ICON.info;
    return h('div', { class: `an-secrow ${cls}` }, h('span', { class: `an-secic ${cls}` }, ic),
      h('div', { class: 'an-secbody' }, h('div', null, h('b', null, s.name), s.note ? h('span', { class: 'muted' }, ` — ${s.note}`) : null),
        s.value ? h('div', { class: 'mono an-secval', title: s.value }, s.value) : null));
  })));
}

function anMeta(b, r) {
  const m = r.meta || {};
  b.append(sect('Page', kvGrid([['Title', m.title || ''], ['URL', m.url || ''], ['Charset', m.charset || '—'], ['Doctype', m.doctype || '—']])));
  const metas = m.meta || [];
  b.append(sect('Meta tags', kvGrid(metas.map((x) => [x.name || x.property || x.httpEquiv || x['http-equiv'] || '(meta)', x.content || ''])), true, tag(metas.length)));
  const links = m.links || [];
  if (links.length) b.append(sect('Links', kvGrid(links.map((x) => [x.rel || '(link)', x.href || ''])), true, tag(links.length)));
  const srcs = m.scripts?.srcs || [];
  b.append(sect('Scripts', h('div', null,
    h('div', { class: 'muted' }, `${m.scripts?.external || 0} external · ${m.scripts?.inline || 0} inline`),
    srcs.map((s) => { const seq = findRequestFor(s); return h('div', { class: 'mono ell an-src', title: s }, seq ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); showInTraffic(seq); } }, s) : s); })), true, tag(srcs.length)));
  const ifr = m.iframes || [];
  b.append(sect('Iframes', ifr.length ? kvGrid(ifr.map((f) => [f.id || f.name || '(anonymous)', f.src || 'about:blank'])) : h('div', { class: 'muted' }, 'None'), true, tag(ifr.length)));
}

$('anQ').addEventListener('input', () => { AN.q = $('anQ').value; renderAnPages(); });
$('anGone').checked = AN.showGone;
$('anGone').addEventListener('change', () => { AN.showGone = $('anGone').checked; store.set('an-gone', AN.showGone); renderAnPages(); });

async function loadAnalyzer() {
  renderAnMain();
  pagePoll();
  anSchedule();
}
