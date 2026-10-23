'use strict';
// CupNet mini UI — Search across sessions: URLs, headers, bodies, WebSocket and console messages.
// Loaded after ui.js (shared helpers: h, $, api, toast, seg, store, cmpShowInTraffic, …).

const SR = {
  opts: Object.assign({ regex: false, caseSensitive: false, fields: ['url', 'headers', 'bodies'], kinds: ['request', 'ws', 'console'], scope: 'all', host: '' }, store.get('sr-opts', {})),
  ctl: null, groups: new Map(), hits: 0, total: 0, bytes: 0, t0: 0, running: false, last: null,
};
const SR_FIELDS = [['url', 'URL'], ['headers', 'Заголовки'], ['bodies', 'Тела']];
const SR_KINDS = [['request', 'Запросы'], ['ws', 'WebSocket'], ['console', 'Консоль']];
const SR_SCOPES = [['all', 'Все'], ['week', '7 дней'], ['day', '24 ч'], ['shown', 'Эта сессия']];
const SR_LABEL = { url: 'URL', reqHeaders: 'Заголовки запроса', reqBody: 'Тело запроса', resHeaders: 'Заголовки ответа', resBody: 'Тело ответа' };
/** Detail tab to open for a match in this field. */
const SR_TAB = { url: 'headers', reqHeaders: 'headers', resHeaders: 'headers', reqBody: 'request', resBody: 'response' };

const srSave = () => store.set('sr-opts', SR.opts);
/** `20261022-174501-ab12` → a Date (the id is the start time), else null. */
function srSessionDate(id) {
  const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(id);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
function srToggle(list, k) {
  const i = list.indexOf(k);
  if (i >= 0) { if (list.length > 1) list.splice(i, 1); } else list.push(k);
}
/** Russian plural: pick one/few/many form by count. */
function srPlural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function renderSrOpts() {
  const o = SR.opts;
  clear($('srMode')).append(seg([['text', 'Текст'], ['regex', 'Regex']], o.regex ? 'regex' : 'text', (v) => { o.regex = v === 'regex'; srSave(); renderSrOpts(); }));
  $('srCase').classList.toggle('on', o.caseSensitive);
  clear($('srFields')).append(...SR_FIELDS.map(([k, label]) => h('button', { type: 'button', class: `chip${o.fields.includes(k) ? ' on' : ''}`, onclick: () => { srToggle(o.fields, k); srSave(); renderSrOpts(); } }, label)));
  clear($('srKinds')).append(...SR_KINDS.map(([k, label]) => h('button', { type: 'button', class: `chip${o.kinds.includes(k) ? ' on' : ''}`, onclick: () => { srToggle(o.kinds, k); srSave(); renderSrOpts(); } }, label)));
  clear($('srScope')).append(seg(SR_SCOPES, o.scope, (v) => { o.scope = v; srSave(); renderSrOpts(); }));
  $('srQ').placeholder = o.regex ? 'Регулярное выражение, напр. "token"\\s*:\\s*"[^"]+"' : 'Текст в URL, заголовках, телах и сообщениях — напр. токен, email, id';
}

/** Session ids in the chosen scope (newest first) and their total size. */
async function srSessions() {
  const { current: cur, sessions } = await api('/api/sessions');
  const now = Date.now();
  const sid = shown || cur;
  const pick = SR.opts.scope === 'shown' ? sessions.filter((s) => s.id === sid)
    : SR.opts.scope === 'day' ? sessions.filter((s) => s.mtime >= now - 86400e3)
      : SR.opts.scope === 'week' ? sessions.filter((s) => s.mtime >= now - 7 * 86400e3)
        : sessions;
  return { cur, list: pick, bytes: pick.reduce((n, s) => n + (s.bytes || 0), 0) };
}

function srStop() {
  if (SR.ctl) { SR.ctl.abort(); SR.ctl = null; }
  if (SR.running) { SR.running = false; srStatus({ stopped: true }); }
  renderSrRun();
}
function renderSrRun() {
  $('srGo').hidden = SR.running;
  $('srStop').hidden = !SR.running;
}

async function srRun() {
  const q = $('srQ').value;
  if (!q.trim()) { $('srQ').focus(); return; }
  srStop();
  const ctl = new AbortController();
  SR.ctl = ctl;
  const { cur, list, bytes } = await srSessions();
  if (ctl.signal.aborted) return;
  if (!list.length) { toast('Нет сессий в этом диапазоне', 'warn'); SR.ctl = null; return; }
  SR.groups = new Map(); SR.hits = 0; SR.total = list.length; SR.bytes = bytes; SR.done = 0; SR.read = 0; SR.t0 = Date.now(); SR.cur = cur;
  SR.running = true; SR.last = { q, regex: SR.opts.regex };
  clear($('srResults'));
  $('srEmpty').hidden = true;
  renderSrRun();
  srStatus({});
  const body = {
    q, regex: SR.opts.regex, caseSensitive: SR.opts.caseSensitive, fields: SR.opts.fields, kinds: SR.opts.kinds,
    host: $('srHost').value.trim(), sessions: list.map((s) => s.id),
  };
  let r;
  try {
    r = await fetch('/api/search', { method: 'POST', signal: ctl.signal, headers: { 'X-CupNet-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { if (!ctl.signal.aborted) { SR.running = false; renderSrRun(); toast(e.message, 'err'); } return; }
  if (!r.ok) {
    let m = r.statusText; try { m = (await r.json()).error || m; } catch { /* not JSON */ }
    SR.running = false; SR.ctl = null; renderSrRun(); srStatus({ error: m });
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) { try { srEvent(JSON.parse(line)); } catch { /* partial / bad line */ } }
      }
    }
  } catch (e) { if (ctl.signal.aborted) return; toast(e.message, 'err'); }
  if (SR.ctl === ctl) SR.ctl = null;
  if (SR.running) { SR.running = false; srStatus({ stopped: true }); }
  renderSrRun();
}

function srEvent(ev) {
  if (ev.type === 'hit') srAddHit(ev.hit);
  else if (ev.type === 'progress') { SR.read = ev.bytes; if (ev.sessionHits != null) SR.done++; srStatus({}); }
  else if (ev.type === 'done') { SR.running = false; srStatus({ end: ev }); renderSrRun(); }
  else if (ev.type === 'error') { SR.running = false; srStatus({ error: ev.error }); renderSrRun(); }
}

function srStatus({ end, error, stopped }) {
  const box = clear($('srStatus'));
  box.hidden = false;
  const pct = SR.bytes ? Math.min(100, Math.round((SR.read / SR.bytes) * 100)) : 0;
  const hits = `${SR.hits.toLocaleString()} ${srPlural(SR.hits, 'совпадение', 'совпадения', 'совпадений')}`;
  const where = `${SR.done} из ${SR.total} сессий`;
  if (error) { append(box, [h('span', { class: 'err' }, error)]); return; }
  if (end) {
    const ms = end.ms < 1000 ? `${end.ms} мс` : `${(end.ms / 1000).toFixed(1)} с`;
    append(box, [h('b', null, hits), h('span', { class: 'muted' }, ` — в ${end.scanned} из ${end.sessions} сессий · ${fmtSize(end.bytes) || '0 B'} · ${ms}`),
      end.truncated ? tag(`показаны первые ${end.hits} — уточните запрос`, 'warn') : null,
      end.timedOut ? tag('остановлено по тайм-ауту — сузьте выбор сессий или запрос', 'warn') : null]);
    if (!SR.hits) { $('srEmpty').hidden = false; $('srEmpty').textContent = 'Ничего не найдено. Бинарные тела не ищутся; попробуйте Regex, другие типы или Все сессии.'; }
    return;
  }
  if (stopped) { append(box, [h('b', null, hits), h('span', { class: 'muted' }, ` · остановлено на ${where}`)]); return; }
  append(box, [h('span', { class: 'sr-spin' }), h('b', null, hits), h('span', { class: 'muted' }, ` · поиск ${where} · ${fmtSize(SR.read) || '0 B'} из ${fmtSize(SR.bytes) || '0 B'}`),
    h('span', { class: 'sr-bar' }, h('i', { style: `width:${pct}%` }))]);
}

function srGroup(id) {
  let g = SR.groups.get(id);
  if (g) return g;
  const d = srSessionDate(id);
  const count = h('span', { class: 'tag' }, '0');
  const rows = h('div', { class: 'sr-rows' });
  const head = h('div', { class: 'sr-ghead' },
    h('span', { class: 'sr-caret' }, '▾'),
    h('b', { class: 'mono' }, id),
    id === SR.cur ? tag('активна', 'ok') : null,
    d ? h('span', { class: 'muted' }, d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) : null,
    count,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn sm ghost', title: 'Показать эту сессию в Трафике', onclick: (ev) => { ev.stopPropagation(); openSession(id); go('traffic'); } }, 'Открыть сессию'));
  const box = h('div', { class: 'sr-group' }, head, rows);
  head.addEventListener('click', () => { box.classList.toggle('closed'); });
  $('srResults').append(box);
  g = { box, rows, count, n: 0 };
  SR.groups.set(id, g);
  return g;
}

function srFieldLabel(hit, f) {
  if (f !== 'message') return SR_LABEL[f] || f;
  return hit.kind === 'ws' ? `WS ${hit.dir === 'out' ? '↑ отпр.' : hit.dir === 'in' ? '↓ получ.' : 'сообщение'}` : `Консоль ${hit.type || ''}`.trim();
}

function srAddHit(hit) {
  SR.hits++;
  const g = srGroup(hit.session);
  g.n++; g.count.textContent = g.n.toLocaleString();
  const [hostPart, pathPart] = splitUrl(hit.url || '');
  const lead = hit.kind === 'request'
    ? [badge(hit.method || '?', `m-${hit.method}`), badge(String(hit.status || 'ERR'), stCls(hit.status))]
    : [tag(hit.kind === 'ws' ? 'ws' : 'консоль', hit.kind === 'ws' ? 'accent' : '')];
  const row = h('div', { class: 'sr-row', tabindex: 0, title: 'Показать в Трафике' },
    h('div', { class: 'sr-line' }, lead,
      h('span', { class: 'sr-url ell mono' }, hostPart ? h('b', null, hostPart) : null, pathPart),
      h('span', { class: 'faint mono' }, `#${hit.seq}`),
      h('span', { class: 'faint' }, fmtTime(hit.ts))),
    hit.matches.map((m) => h('div', { class: 'sr-match' },
      h('span', { class: 'sr-f' }, srFieldLabel(hit, m.field)),
      h('span', { class: 'sr-snip mono' }, m.pre, h('mark', null, m.hit), m.post),
      m.count > 1 ? h('span', { class: 'faint' }, `×${m.count >= 999 ? '999+' : m.count}`) : null)));
  const open = () => srOpen(hit);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
  g.rows.append(row);
}

/** Show a hit in Traffic, on the tab of its first match, with the body find set to the match. */
function srOpen(hit) {
  const m = hit.matches[0];
  const tab = hit.kind === 'request' ? SR_TAB[m.field] : null;
  if (tab) {
    dTab = tab; store.set('dTab', dTab);
    if (tab !== 'headers' && m.hit && m.hit.length < 160) bodyFindSeed = { seq: hit.seq, which: tab, q: m.hit };
  }
  cmpShowInTraffic({ sid: hit.session, seq: hit.seq });
}

function loadSearch() {
  renderSrOpts();
  renderSrRun();
  if (!SR.running && !SR.groups.size) $('srEmpty').hidden = false;
  setTimeout(() => $('srQ').focus(), 0);
}

$('srQ').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); guard(srRun)(); } });
$('srGo').addEventListener('click', guard(srRun));
$('srStop').addEventListener('click', srStop);
$('srCase').addEventListener('click', () => { SR.opts.caseSensitive = !SR.opts.caseSensitive; srSave(); renderSrOpts(); });
$('srHost').value = SR.opts.host || '';
$('srHost').addEventListener('input', () => { SR.opts.host = $('srHost').value.trim(); srSave(); });
$('srHost').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); guard(srRun)(); } });
document.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'f') { ev.preventDefault(); go('search'); $('srQ').select(); }
});
