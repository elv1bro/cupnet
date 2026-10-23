'use strict';
/* CupNet mini UI — Activity: one live system feed of EVERYTHING the session does (HTTP requests, rule
 * hits, console messages, WebSocket frames, IP changes, page lifecycle), with per-kind filters, a
 * counters strip (traffic volume, rate, errors, rule hits) and jump-to-Traffic. It reads the global
 * `all[]` that the single live stream already fills — there is no second stream — so a saved session
 * renders exactly like the live one. Globals from ui.js: h, clear, $, store, fmtSize, fmtTime, fmtAgo,
 * splitUrl, stCls, tag, badge, modal, toast, go, select, all, bySeq, PAGE, ST, shown, current. */

const ACT = {
  off: new Set(store.get('act-off', [])),      // kinds the user has filtered out
  errOnly: store.get('act-errOnly', false),
  follow: true, paused: false,
  q: '', re: null,
  view: [], scanned: 0, pool: [],
  cnt: { request: 0, rule: 0, console: 0, ws: 0, ip: 0, 'page-event': 0 },
  bin: 0, bout: 0, err: 0, ruleErr: 0, cnErr: 0, cnWarn: 0, ipErr: 0,
};
const ACT_KINDS = [
  ['request', 'Запросы'], ['rule', 'Правила'], ['console', 'Консоль'],
  ['ws', 'WebSocket'], ['ip', 'IP'], ['page-event', 'Страница'],
];
const ACT_LABEL = Object.fromEntries(ACT_KINDS);
const ACT_ROW = 24;
let actGrid, actSpacer, actBuilt = false, actQueued = false, actStick = false;

const actText = (e) => e._at || (e._at = [e.method, e.url, e.note, e.type].filter(Boolean).join(' ').toLowerCase());
function actIsErr(e) {
  if (e.kind === 'request') return !e.status || e.status >= 400;
  if (e.kind === 'ip') return e.type === 'error';          // IP-monitor failures carry type, not sev
  return (e.kind === 'console' || e.kind === 'rule') && e.sev === 'error';
}
// Total error events across every kind — matches exactly what the "только ошибки" filter keeps.
const actErrTotal = () => ACT.err + ACT.cnErr + ACT.ruleErr + ACT.ipErr;
function actMatch(e) {
  const k = e.kind;
  if (k === 'session-start' || k === 'session-end') return false;
  if (ACT.off.has(k)) return false;
  if (ACT.errOnly && !actIsErr(e)) return false;
  if (ACT.re) return ACT.re.test(actText(e));
  if (ACT.q) return actText(e).includes(ACT.q);
  return true;
}
function actTally(e) {
  if (e.kind in ACT.cnt) ACT.cnt[e.kind]++;
  if (e.kind === 'request') { if (!e.status || e.status >= 400) ACT.err++; ACT.bin += e.resSize || 0; ACT.bout += e.reqSize || 0; }
  else if (e.kind === 'rule') { if (e.sev === 'error') ACT.ruleErr++; }
  else if (e.kind === 'console') { if (e.sev === 'error') ACT.cnErr++; else if (e.sev === 'warn') ACT.cnWarn++; }
  else if (e.kind === 'ip') { if (e.type === 'error') ACT.ipErr++; }
}

/** ingest() hook: all[] already holds the new entries, so scan its tail once (tally + filter). */
function activityIngest() {
  for (let i = ACT.scanned; i < all.length; i++) {
    const e = all[i];
    actTally(e);
    if (actMatch(e)) ACT.view.push(i);
  }
  ACT.scanned = all.length;
  actBadge();
  if (PAGE === 'activity') { renderActStats(); if (!ACT.paused) scheduleActDraw(ACT.follow); }
}
/** resetView() hook: a new session (or cleared view) starts the feed from scratch. */
function activityReset() {
  ACT.view = []; ACT.scanned = 0;
  ACT.cnt = { request: 0, rule: 0, console: 0, ws: 0, ip: 0, 'page-event': 0 };
  ACT.bin = ACT.bout = ACT.err = ACT.ruleErr = ACT.cnErr = ACT.cnWarn = ACT.ipErr = 0;
  actBadge();
  if (PAGE === 'activity') { renderActStats(); renderActChips(); scheduleActDraw(true); }
}

/** Nav-button badge: count of attention-worthy events (request / console / rule / IP errors). */
function actBadge() {
  const b = $('actBadge'); if (!b) return;
  const n = actErrTotal();
  b.hidden = !n; b.textContent = n > 999 ? '999+' : String(n);
}

// ── counters strip ──
const actNum = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
function renderActStats() {
  const box = $('actStats'); if (!box) return;
  const s = (!shown && ST?.stats) ? ST.stats : null;   // live rate/avg/worker only apply to the live session
  const traffic = ACT.bin + ACT.bout;
  const cell = (label, value, cls, title) => h('div', { class: `act-stat ${cls || ''}`, title: title || '' },
    h('b', null, value), h('span', null, label));
  append(clear(box), [
    cell('запросов', actNum(ACT.cnt.request), '', `${ACT.cnt.request.toLocaleString()} HTTP-запросов в этой сессии`),
    cell('трафик', fmtSize(traffic) || '0 B', 'accent', `↓ получено ${fmtSize(ACT.bin) || '0 B'} · ↑ отправлено ${fmtSize(ACT.bout) || '0 B'}`),
    s && s.reqPerSec ? cell('в секунду', `${s.reqPerSec}/с`, '') : null,
    s && s.avgMs ? cell('сред.', `${Math.round(s.avgMs)} мс`, '', `мин ${Math.round(s.minMs || 0)} · макс ${Math.round(s.maxMs || 0)} мс`) : null,
    cell('ошибок', actNum(actErrTotal()), actErrTotal() ? 'err' : '',
      `столько же, сколько показывает «только ошибки» · запросы 4xx/5xx и сбои ${ACT.err} · консоль ${ACT.cnErr} · правила ${ACT.ruleErr} · IP ${ACT.ipErr}`),
    cell('правил', actNum(ACT.cnt.rule), ACT.ruleErr ? 'warn' : ACT.cnt.rule ? 'ok' : '', `${ACT.cnt.rule} срабатываний${ACT.ruleErr ? `, ${ACT.ruleErr} с ошибкой` : ''}`),
    cell('консоль', actNum(ACT.cnt.console), ACT.cnErr ? 'err' : ACT.cnWarn ? 'warn' : '', `${ACT.cnErr} ошибок · ${ACT.cnWarn} предупреждений`),
    cell('WebSocket', actNum(ACT.cnt.ws), '', 'кадров WebSocket'),
    s ? cell('воркер', s.workerReady ? 'готов' : 'запуск…', s.workerReady ? 'ok' : 'warn', `AzureTLS: в работе ${s.workerInFlight || 0}, очередь ${s.workerQueueDepth || 0}, перезапусков ${s.workerRestarts || 0}`) : null,
  ]);
}

// ── filter chips ──
function renderActChips() {
  const box = $('actKinds'); if (!box) return;
  append(clear(box), ACT_KINDS.map(([k, label]) =>
    h('button', { type: 'button', class: `chip${ACT.off.has(k) ? '' : ' on'}`, onclick: () => actToggleKind(k) },
      label, h('b', null, actNum(ACT.cnt[k] || 0)))));
}
function actToggleKind(k) {
  if (ACT.off.has(k)) ACT.off.delete(k); else ACT.off.add(k);
  store.set('act-off', [...ACT.off]);
  renderActChips(); refilterAct();
}
function actSetQuery(raw) {
  const v = String(raw || '').trim();
  const m = /^\/(.*)\/([a-z]*)$/.exec(v);
  ACT.re = null; ACT.q = '';
  if (m) { try { ACT.re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2]); } catch { ACT.q = v.toLowerCase(); } }
  else ACT.q = v.toLowerCase();
  refilterAct();
}
/** Recompute the visible slice from scratch (filters changed). */
function refilterAct() {
  ACT.view = [];
  for (let i = 0; i < all.length; i++) if (actMatch(all[i])) ACT.view.push(i);
  scheduleActDraw(ACT.follow);
}

// ── virtual list ──
function scheduleActDraw(toBottom) { actStick = actStick || toBottom; if (!actQueued) { actQueued = true; requestAnimationFrame(actDraw); } }
function actRow(k) {
  let r = ACT.pool[k];
  if (!r) {
    r = h('div', { class: 'act-r' }, h('div', { class: 'tm' }), h('div', { class: 'k' }), h('div', { class: 'main' }), h('div', { class: 'meta' }));
    r.addEventListener('click', () => { const seq = Number(r.dataset.seq); if (bySeq.has(seq)) actOpen(all[bySeq.get(seq)]); });
    ACT.pool[k] = r; actSpacer.append(r);
  }
  return r;
}
const ACT_ICON = { request: '', rule: '⚑', console: '›', ws: '⇅', ip: '◉', 'page-event': '◆' };
function fillActRow(r, e) {
  r.dataset.seq = e.seq;
  const c = r.children;
  c[0].textContent = fmtTime(e.ts);
  c[1].textContent = `${ACT_ICON[e.kind] || ''} ${ACT_LABEL[e.kind] || e.kind}`.trim();
  c[1].className = `k ak-${e.kind}`;
  const [host, p] = splitUrl(e.url);
  let main = '', meta = '', mcls = 'meta';
  if (e.kind === 'request') {
    main = `${e.method || ''} ${host}${p}`.trim();
    meta = [e.status || 'ERR', fmtSize(e.resSize), e.duration != null ? `${e.duration} ms` : ''].filter(Boolean).join(' · ');
    mcls = `meta ${stCls(e.status)}`;
  } else if (e.kind === 'rule') {
    main = `${e.note || 'правило'}${e.url ? `  ${e.url}` : ''}`;
    meta = e.sev === 'error' ? 'ошибка' : 'сработало';
    mcls = `meta ${e.sev === 'error' ? 's5' : 's2'}`;
  } else if (e.kind === 'console') {
    main = e.note || ''; meta = e.sev || 'info';
    mcls = `meta cn-${e.sev || 'info'}`;
  } else if (e.kind === 'ws') {
    main = `${e.dir === 'out' ? '↑' : e.dir === 'in' ? '↓' : '•'} ${e.note || e.type || ''}`.trim() + (host ? `  ${host}` : '');
    meta = fmtSize(e.resSize);
  } else {
    main = e.note || e.url || e.kind; if (host && e.url) main += `  ${host}`;
  }
  c[2].textContent = main; c[2].title = e.url || e.note || '';
  c[3].textContent = meta; c[3].className = mcls;
  r.className = `act-r ak-row-${e.kind}${actIsErr(e) ? ' err' : ''}`;
}
function actDraw() {
  actQueued = false;
  if (!actGrid) return;
  $('actCount').textContent = `${ACT.view.length.toLocaleString()} / ${all.length.toLocaleString()}`;
  $('actEmpty').hidden = all.length > 0;
  actSpacer.style.height = `${ACT.view.length * ACT_ROW}px`;
  if (actStick && ACT.follow && !ACT.paused) grid_scroll();
  actStick = false;
  const first = Math.max(0, Math.floor(actGrid.scrollTop / ACT_ROW) - 8);
  const n = Math.max(0, Math.min(ACT.view.length - first, Math.ceil(actGrid.clientHeight / ACT_ROW) + 16));
  for (let k = 0; k < n; k++) {
    const e = all[ACT.view[first + k]];
    const r = actRow(k);
    r.hidden = false; r.style.top = `${(first + k) * ACT_ROW}px`;
    fillActRow(r, e);
  }
  for (let k = n; k < ACT.pool.length; k++) if (ACT.pool[k]) { ACT.pool[k].hidden = true; ACT.pool[k].dataset.seq = ''; }
}
function grid_scroll() { actGrid.scrollTop = actGrid.scrollHeight; }

// ── row detail ──
function actOpen(e) {
  const row = (k, v) => v == null || v === '' ? null : h('div', { class: 'act-drow' }, h('div', { class: 'act-dk' }, k), h('div', { class: 'act-dv mono' }, String(v)));
  const [host, p] = splitUrl(e.url);
  const body = h('div', { class: 'act-detail' },
    row('Когда', `${fmtTime(e.ts)}  (${fmtAgo(e.ts)})`),
    row('Тип записи', ACT_LABEL[e.kind] || e.kind),
    e.kind === 'request' ? row('Метод', e.method) : null,
    e.kind === 'request' ? row('Статус', e.status || 'нет ответа') : null,
    e.url ? row('URL', e.url) : null,
    e.kind !== 'request' && host ? row('Хост', host) : null,
    e.type ? row('Ресурс', e.type) : null,
    e.mime ? row('MIME', e.mime) : null,
    e.reqSize != null ? row('Отправлено', fmtSize(e.reqSize) || '0 B') : null,
    e.resSize != null ? row('Получено', fmtSize(e.resSize) || '0 B') : null,
    e.duration != null ? row('Длительность', `${e.duration} мс`) : null,
    e.dns ? row('DNS', `${host} → ${e.dns.ip}`) : null,
    e.sev ? row('Уровень', e.sev) : null,
    e.note ? row('Сообщение', e.note) : null,
    e.rid != null ? row('ID правила', e.rid) : null,
    e.data ? h('div', { class: 'act-drow' }, h('div', { class: 'act-dk' }, 'Данные'),
      h('pre', { class: 'act-dv mono act-json' }, JSON.stringify(e.data, null, 2))) : null,
  );
  const buttons = [{ label: 'Закрыть' }];
  if (e.kind === 'request' || e.kind === 'ws') buttons.unshift({ label: 'Показать в трафике', cls: 'primary', fn: () => actToTraffic(e.kind === 'ws' ? (e.ws || e.seq) : e.seq) });
  modal(`Событие #${e.seq}`, body, buttons);
}
function actToTraffic(seq) {
  go('traffic');
  revealSeq = seq;
  select(seq);
}

// ── page wiring ──
function buildActivity() {
  actBuilt = true;
  actGrid = $('actGrid'); actSpacer = $('actSpacer');
  $('actQ').addEventListener('input', (ev) => debounce('act-q', 120, () => actSetQuery(ev.target.value)));
  $('actErr').addEventListener('change', (ev) => { ACT.errOnly = ev.target.checked; store.set('act-errOnly', ACT.errOnly); refilterAct(); });
  $('actFollow').addEventListener('change', (ev) => { ACT.follow = ev.target.checked; if (ACT.follow) { ACT.paused = false; $('actPause').classList.remove('on'); scheduleActDraw(true); } });
  $('actPause').addEventListener('click', () => { ACT.paused = !ACT.paused; $('actPause').classList.toggle('on', ACT.paused); if (!ACT.paused) scheduleActDraw(true); });
  $('actClear').addEventListener('click', () => { ACT.view = []; ACT.scanned = all.length; scheduleActDraw(false); });
  actGrid.addEventListener('scroll', () => scheduleActDraw(false), { passive: true });
  window.addEventListener('resize', () => { if (PAGE === 'activity') scheduleActDraw(false); });
}
function loadActivity() {
  if (!actBuilt) buildActivity();
  $('actErr').checked = ACT.errOnly;
  $('actFollow').checked = ACT.follow;
  $('actPause').classList.toggle('on', ACT.paused);
  renderActChips();
  renderActStats();
  refilterAct();
  scheduleActDraw(true);
}
