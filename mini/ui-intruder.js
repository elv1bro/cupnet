'use strict';
// CupNet mini UI — Intruder: send many variations of one request with payloads at marked positions.
// Loaded after ui.js (shared helpers: h, $, api, post, toast, seg, store, headerTable, enabledPairs,
// badge, stCls, fmtSize, cmpShowInTraffic, guard, go, current, shown, …).

const IN_MARK = '§'; // §
const IN_TYPES = [['sniper', 'Снайпер'], ['ram', 'Таран'], ['pitchfork', 'Вилы'], ['clusterbomb', 'Кассетная бомба']];
const IN_HELP = {
  sniper: 'По одной позиции за раз; остальные остаются базовыми. Запросов = позиции × payloads.',
  ram: 'Один и тот же payload подставляется во все позиции сразу. Один список payload.',
  pitchfork: 'По одному списку payload на позицию, идут параллельно; останавливается на самом коротком списке.',
  clusterbomb: 'Все сочетания списков по позициям. Запросов = произведение их длин.',
};
const IN_COLS = [['i', '#'], ['payload', 'Payload'], ['status', 'Статус'], ['length', 'Длина'], ['time', 'Время'], ['matched', 'Grep']];

const IN = {
  opts: Object.assign({ attackType: 'sniper', urlEncode: false, grep: '', grepRegex: false, concurrency: 8, followRedirects: false }, store.get('in-opts', {})),
  hdr: [['Accept', '*/*', true]],
  sets: store.get('in-sets', ['']),
  results: [], sort: { key: 'i', dir: 1 }, ctl: null, running: false, spec: null, t0: 0, count: 0, done: 0, errored: 0, matched: 0,
  paint: false, lastField: null,
};
const inSave = () => store.set('in-opts', IN.opts);
const inSaveSets = () => store.set('in-sets', IN.sets);
const inLines = (s) => String(s || '').split('\n').filter((x) => x.length);
/** Russian plural: pick one/few/many form by count. */
function inPlural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function inLoad({ method, url, headers, body }) {
  $('inMethod').value = [...$('inMethod').options].some((o) => o.value === method) ? method : 'GET';
  $('inUrl').value = url || '';
  IN.hdr = (headers || []).map(([k, v]) => [k, v, true]);
  $('inBody').value = body || '';
  renderInHeaders(); inRefresh();
}
const openInIntruder = (req) => { inLoad(req); go('intruder'); };

function renderInHeaders() { clear($('inHeaders')).append(headerTable(IN.hdr, inRefresh)); }
function inShowTab(t) {
  document.querySelectorAll('#inTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  $('inHeaders').hidden = t !== 'headers'; $('inBodyWrap').hidden = t !== 'body';
}

/** Number of § … § positions across the URL, header values and body. */
function inPositions() {
  const fields = [$('inUrl').value, ...enabledPairs(IN.hdr).map(([, v]) => v), $('inBody').value];
  return fields.reduce((n, s) => n + Math.floor((String(s).split(IN_MARK).length - 1) / 2), 0);
}
/** The payload-set line arrays the current attack type needs. */
function inSetArrays(positions) {
  const type = IN.opts.attackType;
  if (type === 'sniper' || type === 'ram') return [inLines(IN.sets[0])];
  return Array.from({ length: positions }, (_, i) => inLines(IN.sets[i]));
}
function inCount(positions, sets) {
  const type = IN.opts.attackType;
  if (type === 'sniper') return positions * (sets[0] ? sets[0].length : 0);
  if (type === 'ram') return sets[0] ? sets[0].length : 0;
  if (positions < 1) return 0;
  if (type === 'pitchfork') return Math.min(...sets.map((s) => (s ? s.length : 0)));
  return sets.reduce((a, s) => a * (s ? s.length : 0), 1);
}

/** Wrap the current selection in the last-focused template field with § … §. */
function inAddPosition() {
  const el = IN.lastField;
  if (!el || (el.id !== 'inUrl' && el.id !== 'inBody' && !el.closest('#inHeaders'))) { toast('Кликните в URL, значение заголовка или тело, выделите текст для фаззинга, затем добавьте позицию', 'warn'); return; }
  const s = el.selectionStart ?? el.value.length;
  const e = el.selectionEnd ?? el.value.length;
  el.value = `${el.value.slice(0, s)}${IN_MARK}${el.value.slice(s, e)}${IN_MARK}${el.value.slice(e)}`;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.setSelectionRange(s + 1, e + 1);
  inRefresh();
}
function inClearPositions() {
  for (const id of ['inUrl', 'inBody']) $(id).value = $(id).value.split(IN_MARK).join('');
  for (const r of IN.hdr) r[1] = String(r[1]).split(IN_MARK).join('');
  renderInHeaders(); inRefresh();
}

function renderInOpts() {
  clear($('inType')).append(seg(IN_TYPES, IN.opts.attackType, (v) => { IN.opts.attackType = v; inSave(); renderInOpts(); inRefresh(); }));
  $('inHelp').textContent = IN_HELP[IN.opts.attackType];
  $('inEncode').checked = IN.opts.urlEncode;
  $('inFollow').checked = IN.opts.followRedirects;
  $('inGrep').value = IN.opts.grep;
  $('inGrepRe').classList.toggle('on', IN.opts.grepRegex);
  $('inConc').value = IN.opts.concurrency;
  renderInPayloads();
}
function renderInPayloads() {
  const positions = inPositions();
  const box = clear($('inPayloads'));
  const type = IN.opts.attackType;
  const perPosition = type === 'pitchfork' || type === 'clusterbomb';
  const blocks = perPosition ? Math.max(1, positions) : 1;
  for (let i = 0; i < blocks; i++) {
    const label = perPosition ? `Позиция ${i + 1}` : 'Payloads';
    const ta = h('textarea', { class: 'mono code in-pl', spellcheck: false, placeholder: 'По одному payload в строке', value: IN.sets[i] || '',
      oninput: (ev) => { IN.sets[i] = ev.target.value; inSaveSets(); inRefresh(); } });
    box.append(h('div', { class: 'in-plblock' }, h('div', { class: 'in-pllabel' }, label, h('span', { class: 'muted' }, ` ${inLines(IN.sets[i]).length}`)), ta));
  }
  if (perPosition && positions < 1) box.append(h('div', { class: 'hint muted' }, 'Сначала отметьте позиции в запросе.'));
}

/** Update the live count hint and the Start button's enabled state. */
function inRefresh() {
  const positions = inPositions();
  const sets = inSetArrays(positions);
  const count = inCount(positions, sets);
  IN.count = count;
  const parts = [`${positions} ${inPlural(positions, 'позиция', 'позиции', 'позиций')}`];
  if (count > 0) parts.push(`${count.toLocaleString()} ${inPlural(count, 'запрос', 'запроса', 'запросов')}`);
  $('inPlan').textContent = parts.join(' · ');
  $('inPlan').classList.toggle('warn', count > 10000);
  $('inGo').disabled = IN.running || positions < 1 || count < 1 || count > 10000;
  if (IN.opts.attackType === 'pitchfork' || IN.opts.attackType === 'clusterbomb') renderInPayloads();
}

function inSpec() {
  return {
    template: { method: $('inMethod').value, url: $('inUrl').value.trim(), headers: enabledPairs(IN.hdr), body: $('inBody').value },
    attackType: IN.opts.attackType, urlEncode: IN.opts.urlEncode, grep: IN.opts.grep.trim(), grepRegex: IN.opts.grepRegex,
    concurrency: Number(IN.opts.concurrency) || 8, payloadSets: inSetArrays(inPositions()),
  };
}

function inStop() {
  if (IN.ctl) { IN.ctl.abort(); IN.ctl = null; }
  if (IN.running) { IN.running = false; inStatus({ stopped: true }); }
  inRunUi();
}
function inRunUi() {
  $('inGo').hidden = IN.running; $('inStop').hidden = !IN.running;
  if (!IN.running) inRefresh();
}

async function inRun() {
  const spec = inSpec();
  if (!/^https?:\/\//i.test(spec.template.url)) { toast('Введите http(s) URL', 'warn'); $('inUrl').focus(); return; }
  inStop();
  const ctl = new AbortController();
  IN.ctl = ctl; IN.spec = spec;
  IN.results = []; IN.done = 0; IN.errored = 0; IN.matched = 0; IN.count = 0; IN.t0 = Date.now(); IN.running = true;
  clear($('inResults')); $('inEmpty').hidden = true;
  inRunUi(); inStatus({});
  let r;
  try {
    r = await fetch('/api/intruder', { method: 'POST', signal: ctl.signal, headers: { 'X-CupNet-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
  } catch (e) { if (!ctl.signal.aborted) { IN.running = false; inRunUi(); toast(e.message, 'err'); } return; }
  if (!r.ok) {
    let m = r.statusText; try { m = (await r.json()).error || m; } catch { /* not JSON */ }
    IN.running = false; IN.ctl = null; inRunUi(); inStatus({ error: m });
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
        if (line.trim()) { try { inEvent(JSON.parse(line)); } catch { /* partial */ } }
      }
    }
  } catch (e) { if (ctl.signal.aborted) return; toast(e.message, 'err'); }
  if (IN.ctl === ctl) IN.ctl = null;
  if (IN.running) { IN.running = false; inStatus({ stopped: true }); }
  inRunUi();
}

function inEvent(ev) {
  if (ev.type === 'start') { IN.count = ev.count; inStatus({}); }
  else if (ev.type === 'result') { IN.results.push(ev); IN.done++; if (ev.error) IN.errored++; if (ev.matched) IN.matched++; inPaintSoon(); inStatus({}); }
  else if (ev.type === 'done') { IN.running = false; inStatus({ end: ev }); inPaintSoon(); inRunUi(); }
  else if (ev.type === 'error' || ev.type === 'warn') { if (ev.error) toast(ev.error, 'warn'); }
}

function inStatus({ end, error, stopped }) {
  const box = clear($('inStatus'));
  box.hidden = false;
  if (error) { box.append(h('span', { class: 'err' }, error)); return; }
  const pct = IN.count ? Math.min(100, Math.round((IN.done / IN.count) * 100)) : 0;
  const bar = h('div', { class: 'sr-bar' }, h('i', { style: `width:${pct}%` }));
  const ms = (end ? end.ms : Date.now() - IN.t0);
  const seconds = ms >= 1000 ? `${(ms / 1000).toFixed(1)} с` : `${ms} мс`;
  const summary = `${IN.done.toLocaleString()} из ${IN.count.toLocaleString()} · ${seconds}`;
  const tags = [];
  if (IN.matched) tags.push(tag(`${IN.matched} ${inPlural(IN.matched, 'совпадение', 'совпадения', 'совпадений')} grep`, 'ok'));
  if (IN.errored) tags.push(tag(`${IN.errored} ${inPlural(IN.errored, 'ошибка', 'ошибки', 'ошибок')}`, 'warn'));
  if (end && end.stopped) tags.push(tag('остановлено', 'warn'));
  append(box, [IN.running ? h('span', { class: 'sr-spin' }) : null, h('span', null, summary), ...tags, h('span', { class: 'spacer' }), bar]);
}

function inCmp(key) {
  return (a, b) => {
    let x = a[key]; let y = b[key];
    if (key === 'payload') { x = (a.payloads || []).join(' / '); y = (b.payloads || []).join(' / '); return String(x).localeCompare(String(y)); }
    if (key === 'matched') { x = a.matched ? 1 : 0; y = b.matched ? 1 : 0; }
    return (Number(x) || 0) - (Number(y) || 0);
  };
}
function inPaintSoon() { if (IN.paint) return; IN.paint = true; requestAnimationFrame(inPaint); }
function inPaint() {
  IN.paint = false;
  const tb = clear($('inResults'));
  const rows = IN.results.slice().sort((a, b) => IN.sort.dir * inCmp(IN.sort.key)(a, b));
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const payload = (row.payloads || []).join('  /  ');
    const tr = h('tr', { class: `in-row${row.matched ? ' hit' : ''}${row.error ? ' err' : ''}`, title: 'Открыть этот запрос в Трафике',
      onclick: guard(() => inInspect(row)) },
      h('td', { class: 'num' }, String(row.i + 1)),
      h('td', { class: 'mono in-pcell' }, payload || h('span', { class: 'muted' }, '(базовый)')),
      h('td', null, badge(row.status || 'ERR', stCls(row.status))),
      h('td', { class: 'num mono' }, String(row.length.toLocaleString())),
      h('td', { class: 'num mono' }, `${row.time} мс`),
      h('td', null, row.matched ? tag('совпадение', 'ok') : (row.error ? h('span', { class: 'err', title: row.error }, 'ошибка') : '')));
    frag.append(tr);
  }
  tb.append(frag);
}

async function inInspect(row) {
  const res = await post('/api/intruder/replay', { spec: IN.spec, index: row.i, followRedirects: IN.opts.followRedirects });
  if (!res || !res.seq) { toast(res && res.error ? res.error : 'Не удалось повторить', 'warn'); return; }
  cmpShowInTraffic({ sid: current, seq: res.seq });
}

function inSortBy(key) {
  if (IN.sort.key === key) IN.sort.dir *= -1; else { IN.sort.key = key; IN.sort.dir = key === 'i' ? 1 : -1; }
  document.querySelectorAll('#inHead th').forEach((th) => { th.classList.toggle('sort', th.dataset.k === IN.sort.key); th.classList.toggle('desc', th.dataset.k === IN.sort.key && IN.sort.dir < 0); });
  inPaint();
}

function loadIntruder() {
  if (!$('inHead').children.length) {
    $('inHead').append(h('tr', null, ...IN_COLS.map(([k, label]) => h('th', { 'data-k': k, class: k === 'i' ? 'sort' : '', onclick: () => inSortBy(k) }, label))));
  }
  renderInHeaders(); renderInOpts(); inRunUi();
  $('inEmpty').hidden = IN.results.length > 0 || IN.running;
}

// Remember the last template field touched, so "Add position" knows where to insert.
for (const id of ['inUrl', 'inBody']) {
  $(id).addEventListener('focus', (ev) => { IN.lastField = ev.target; });
  $(id).addEventListener('input', () => inRefresh());
}
$('inHeaders').addEventListener('focusin', (ev) => { if (ev.target.matches('input[type=text]')) IN.lastField = ev.target; });
document.querySelectorAll('#inTabs button').forEach((b) => b.addEventListener('click', () => inShowTab(b.dataset.t)));
$('inMethod').addEventListener('change', inRefresh);
$('inAddPos').addEventListener('click', inAddPosition);
$('inClearPos').addEventListener('click', inClearPositions);
$('inEncode').addEventListener('change', (ev) => { IN.opts.urlEncode = ev.target.checked; inSave(); });
$('inFollow').addEventListener('change', (ev) => { IN.opts.followRedirects = ev.target.checked; inSave(); });
$('inGrep').addEventListener('input', (ev) => { IN.opts.grep = ev.target.value; inSave(); });
$('inGrepRe').addEventListener('click', () => { IN.opts.grepRegex = !IN.opts.grepRegex; inSave(); renderInOpts(); });
$('inConc').addEventListener('change', (ev) => { IN.opts.concurrency = Math.min(32, Math.max(1, Number(ev.target.value) || 8)); inSave(); renderInOpts(); });
$('inGo').addEventListener('click', guard(inRun));
$('inStop').addEventListener('click', inStop);
$('inUrl').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); guard(inRun)(); } });
