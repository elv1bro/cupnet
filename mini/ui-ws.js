'use strict';
/* CupNet mini UI — WebSocket inspector. Connections are keyed by the seq of their upgrade request; every
 * message is a `kind: 'ws'` log entry, so the page works the same for the live session and a saved one.
 * Sending and closing go through /api/ws and need the connection to be open in the live session. */

const WS = {
  conns: new Map(), open: new Set(), sel: null, msg: null, full: null, re: null,
  dir: store.get('ws-dir', ''), types: store.get('ws-types', { text: true, binary: true, control: true }),
  view: store.get('ws-view', 'auto'), cdir: store.get('ws-cdir', 'out'), ctype: store.get('ws-ctype', 'text'),
  openOnly: false, connQ: '', rendered: 0,
};
const WS_ROWS = 2000;
const WS_HEX_MAX = 64 * 1024;
const wsControl = (t) => t === 'ping' || t === 'pong' || t === 'close' || t === 'end';
const wsUrl = (u) => String(u || '').replace(/^http(s?):/i, 'ws$1:');
const wsIsOpen = (c) => !shown && !c.ended && WS.open.has(c.id);

function wsConn(id, url, ts) {
  let c = WS.conns.get(id);
  if (!c) { c = { id, url: url || '', ts: ts || 0, msgs: [], n: { in: 0, out: 0 }, bytes: 0, last: ts || 0, ended: false, close: '' }; WS.conns.set(id, c); }
  if (!c.url && url) c.url = url;
  if (ts && (!c.ts || ts < c.ts)) c.ts = ts;
  return c;
}

/** ingest() hook: collect upgrade requests and messages. */
function wsIngest(items) {
  const fresh = [];
  let conns = false;
  for (const e of items) {
    if (e.kind === 'request' && e.status === 101 && e.type === 'websocket') { if (!WS.conns.has(e.seq)) conns = true; wsConn(e.seq, e.url, e.ts); continue; }
    if (e.kind !== 'ws' || !e.ws) continue;
    if (!WS.conns.has(e.ws)) conns = true;
    const c = wsConn(e.ws, e.url, e.ts);
    c.msgs.push(e); c.last = e.ts;
    if (e.dir) { c.n[e.dir]++; c.bytes += e.resSize || 0; }
    if (e.type === 'close' && !c.close) c.close = e.note || 'close';
    if (e.type === 'end') { c.ended = true; conns = true; }
    if (e.ws === WS.sel) fresh.push(e);
  }
  if (conns && !shown) debounce('ws-open', 400, () => guard(wsRefreshOpen)());
  if (PAGE !== 'ws') return;
  if (WS.sel == null || !WS.conns.has(WS.sel)) { if (conns) debounce('ws-conns', 250, renderWs); return; }
  if (conns || fresh.length) debounce('ws-conns', 250, renderWsConns);
  if (fresh.length) { wsAppend(fresh); renderWsHead(); }
}
function wsReset() {
  WS.conns.clear(); WS.open.clear(); WS.sel = null; WS.msg = null; WS.full = null;
  renderWsBadge();
  if (PAGE === 'ws') renderWs();
  if (!shown) guard(wsRefreshOpen)();
}
async function wsRefreshOpen() {
  if (shown) { WS.open.clear(); renderWsBadge(); return; }
  const r = await api('/api/ws');
  WS.open = new Set((r.open || []).map((c) => c.id));
  renderWsBadge();
  if (PAGE === 'ws') { renderWsConns(); renderWsHead(); renderWsCompose(); }
}
function renderWsBadge() {
  const n = shown ? 0 : [...WS.conns.values()].filter(wsIsOpen).length;
  const b = $('wsCount');
  b.hidden = !n; b.textContent = String(n);
}

// ── connections ──
function renderWsConns() {
  const box = clear($('wsConns'));
  const q = WS.connQ.toLowerCase();
  const list = [...WS.conns.values()].filter((c) => (!WS.openOnly || wsIsOpen(c)) && (!q || c.url.toLowerCase().includes(q))).sort((a, b) => b.id - a.id);
  if (!list.length) {
    box.append(h('div', { class: 'empty' }, WS.conns.size ? 'Нет подходящих соединений' : 'В этой сессии ещё нет WebSocket-соединений.',
      WS.conns.size ? null : h('div', { class: 'hint' }, 'Соединения wss://, которые браузер открывает через CupNet, появляются здесь вместе с каждым сообщением.')));
    return;
  }
  for (const c of list) {
    const open = wsIsOpen(c);
    const [host, path] = splitUrl(c.url);
    box.append(h('div', { class: `prow ws-conn${c.id === WS.sel ? ' sel' : ''}`, dataset: { id: c.id }, onclick: () => wsSelect(c.id) },
      h('span', { class: `dot${open ? ' ok' : ''}`, title: open ? 'Открыто' : 'Закрыто' }),
      h('div', { class: 'ws-conn-main' },
        h('div', { class: 'title' }, h('b', { title: wsUrl(c.url) }, path || '/')),
        h('div', { class: 'meta' }, h('span', null, host), h('span', null, fmtTime(c.ts)))),
      h('div', { class: 'ws-conn-n' },
        h('span', { title: 'Отправлено страницей' }, `↑ ${c.n.out.toLocaleString()}`),
        h('span', { title: 'Получено от сервера' }, `↓ ${c.n.in.toLocaleString()}`))));
  }
}
function wsSelect(id) {
  WS.sel = id; WS.msg = null; WS.full = null;
  document.querySelectorAll('#wsConns .ws-conn').forEach((r) => r.classList.toggle('sel', Number(r.dataset.id) === id));
  renderWsMain();
}
/** Open the inspector on one connection (from Traffic). */
function wsReveal(id, msgSeq) {
  go('ws');
  wsSelect(id);
  if (msgSeq) wsPick(msgSeq, true);
}

// ── messages ──
function wsSetQuery(q) {
  const box = $('wsQ');
  box.classList.remove('bad');
  WS.re = null;
  q = q.trim();
  if (!q) return;
  const m = /^\/(.+)\/([a-z]*)$/.exec(q);
  try { WS.re = m ? new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  catch { box.classList.add('bad'); }
}
function wsMatch(e) {
  if (WS.dir && e.dir && e.dir !== WS.dir) return false;
  if (!WS.types[wsControl(e.type) ? 'control' : e.type === 'binary' ? 'binary' : 'text']) return false;
  if (WS.re && !WS.re.test(e.note || '')) return false;
  return true;
}
function wsRow(e) {
  const arrow = e.dir === 'out' ? '↑' : e.dir === 'in' ? '↓' : '•';
  return h('div', {
    class: `ws-row ws-${e.dir || 'sys'} ws-t-${e.type}${e.seq === WS.msg ? ' sel' : ''}`, dataset: { seq: e.seq },
    onclick: () => { if (!getSelection().toString()) wsPick(e.seq); },
  },
  h('span', { class: 'ws-ar', title: e.dir === 'out' ? 'Страница → сервер' : e.dir === 'in' ? 'Сервер → страница' : '' }, arrow),
  h('span', { class: 'ws-tm' }, fmtTime(e.ts)),
  h('span', { class: 'ws-ty' }, e.type),
  h('span', { class: 'ws-pv' }, e.note || ''),
  e.inj ? tag('внедрено', 'accent') : null,
  h('span', { class: 'ws-sz' }, e.dir ? fmtSize(e.resSize) || '0 B' : ''));
}
function wsAppend(list) {
  const c = WS.conns.get(WS.sel);
  if (!c) return;
  const box = $('wsList');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const frag = document.createDocumentFragment();
  for (const e of list) if (wsMatch(e)) { frag.append(wsRow(e)); WS.rendered++; }
  box.append(frag);
  while (WS.rendered > WS_ROWS && box.firstChild) { box.firstChild.remove(); WS.rendered--; }
  renderWsShown();
  if (atBottom && $('wsFollow').checked) box.scrollTop = box.scrollHeight;
}
function renderWsMsgs() {
  const box = clear($('wsList'));
  const c = WS.conns.get(WS.sel);
  WS.rendered = 0;
  $('wsEmpty').hidden = true;
  if (!c) return;
  const list = c.msgs.filter(wsMatch);
  const from = Math.max(0, list.length - WS_ROWS);
  if (from) box.append(h('div', { class: 'ws-more muted' }, `${from.toLocaleString()} более старых сообщений не показаны — сузьте фильтр, чтобы увидеть их`));
  const frag = document.createDocumentFragment();
  for (let i = from; i < list.length; i++) frag.append(wsRow(list[i]));
  box.append(frag);
  WS.rendered = list.length - from;
  $('wsEmpty').hidden = list.length > 0;
  $('wsEmpty').textContent = c.msgs.length ? 'Нет сообщений по фильтру' : 'Сообщений пока нет';
  renderWsShown();
  box.scrollTop = box.scrollHeight;
}
function renderWsShown() {
  const c = WS.conns.get(WS.sel);
  $('wsShown').textContent = c ? `${c.msgs.filter(wsMatch).length.toLocaleString()} / ${c.msgs.length.toLocaleString()}` : '';
}

// ── one message ──
function b64Bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function hexDump(bytes) {
  const lines = [];
  const n = Math.min(bytes.length, WS_HEX_MAX);
  for (let i = 0; i < n; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, n));
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const asc = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${asc}`);
  }
  if (bytes.length > n) lines.push(`… ещё ${fmtSize(bytes.length - n)}`);
  return lines.join('\n');
}
/** Full entry → { text, bytes, binary, json } */
function wsPayload(full) {
  const body = String(full?.data?.body ?? '');
  if (body.startsWith('__b64__:')) {
    const bytes = b64Bytes(body.slice(8));
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
    return { text, bytes, binary: true, b64: body.slice(8), json: undefined };
  }
  let json;
  if (/^\s*[[{]/.test(body)) { try { json = JSON.parse(body); } catch { /* not JSON */ } }
  return { text: body, bytes: null, binary: false, b64: null, json };
}
async function wsPick(seq, scroll) {
  WS.msg = seq; WS.full = null;
  document.querySelectorAll('#wsList .ws-row').forEach((r) => r.classList.toggle('sel', Number(r.dataset.seq) === seq));
  if (scroll) { const r = document.querySelector(`#wsList .ws-row[data-seq="${seq}"]`); if (r) r.scrollIntoView({ block: 'center' }); }
  const box = $('wsMsg');
  box.hidden = false;
  clear(box).append(h('div', { class: 'muted ws-pad' }, 'Загрузка…'));
  try {
    const full = await api(`/api/log/${seq}${qs()}`);
    if (WS.msg !== seq) return;
    WS.full = full;
    renderWsMsg();
  } catch (err) { clear(box).append(h('div', { class: 'err ws-pad' }, err.message)); }
}
function renderWsMsg() {
  const box = clear($('wsMsg'));
  const e = WS.full;
  if (!e) { box.hidden = true; return; }
  box.hidden = false;
  const d = e.data || {};
  const p = wsPayload(e);
  const views = [['auto', 'Авто'], ['text', 'Текст'], ['json', 'JSON'], ['hex', 'Hex']];
  const head = h('div', { class: 'ws-msg-head' },
    h('b', { class: `ws-ar ws-${e.dir || 'sys'}` }, e.dir === 'out' ? '↑ Страница → сервер' : e.dir === 'in' ? '↓ Сервер → страница' : '• Соединение'),
    tag(e.type),
    e.dir ? h('span', { class: 'muted' }, fmtSize(e.resSize) || '0 B') : null,
    h('span', { class: 'muted' }, fmtTime(e.ts)),
    e.inj ? tag('внедрено CupNet', 'accent') : null,
    d.compressed ? h('span', { class: 'tag', title: 'Распаковано для показа; в канале передавалось сжатым' }, 'permessage-deflate') : null,
    d.truncated ? tag('обрезано', 'warn') : null,
    d.inflateError ? tag(`распаковка не удалась: ${d.inflateError}`, 'err') : null,
    h('span', { class: 'spacer' }),
    e.dir && !wsControl(e.type) ? seg(views, WS.view, (v) => { WS.view = v; store.set('ws-view', v); renderWsMsg(); }) : null,
    e.dir && !wsControl(e.type) ? h('button', { class: 'btn sm', onclick: () => copy(p.text ?? p.b64 ?? '', 'Сообщение скопировано') }, 'Копировать') : null,
    e.dir && (e.type === 'text' || e.type === 'binary') ? h('button', {
      class: 'btn sm', title: 'Поместить это сообщение в редактор',
      onclick: () => wsCompose(e.dir, p.binary && p.text == null ? 'hex' : 'text', p.binary && p.text == null ? hexOf(p.bytes) : p.text ?? ''),
    }, 'Изменить и отправить') : null,
    h('button', { class: 'btn sm', onclick: () => showInTraffic(e.seq), title: 'Это сообщение в Трафике' }, `#${e.seq}`),
    h('button', { class: 'icon', title: 'Закрыть', onclick: () => { WS.msg = null; WS.full = null; renderWsMsg(); document.querySelectorAll('#wsList .ws-row.sel').forEach((r) => r.classList.remove('sel')); } }, '✕'));
  box.append(head);
  const body = h('div', { class: 'ws-msg-body' });
  if (e.type === 'close' || e.type === 'end') {
    body.append(kvGrid([
      ...(d.code ? [['Код', `${d.code}${WS_CLOSE[d.code] ? ` · ${WS_CLOSE[d.code]}` : ''}`], ['Причина', d.reason || '—']] : []),
      ['Примечание', e.note || ''], ['Время', new Date(e.ts).toISOString()],
    ]));
  } else {
    let v = WS.view;
    if (v === 'auto') v = p.json !== undefined ? 'json' : p.binary && p.text == null ? 'hex' : 'text';
    if (v === 'json') {
      let j = p.json;
      if (j === undefined && p.text != null) { try { j = JSON.parse(p.text); } catch { /* not JSON */ } }
      body.append(j === undefined ? h('div', { class: 'muted' }, 'Не JSON') : jsonPre(JSON.stringify(j, null, 2)));
    } else if (v === 'hex') {
      const bytes = p.bytes || new TextEncoder().encode(p.text || '');
      body.append(h('pre', { class: 'codebox ws-hex' }, bytes.length ? hexDump(bytes) : '(пусто)'));
    } else {
      body.append(h('pre', { class: 'codebox' }, p.text != null ? (p.text || '(пусто)') : '[бинарные данные — не валидный UTF-8, см. Hex]'));
    }
  }
  box.append(body);
}
const WS_CLOSE = { 1000: 'штатно', 1001: 'уход', 1002: 'ошибка протокола', 1003: 'неподдерживаемые данные', 1005: 'нет статуса', 1006: 'аварийно', 1007: 'неверный payload', 1008: 'нарушение политики', 1009: 'слишком большой', 1010: 'требуется расширение', 1011: 'ошибка сервера', 1012: 'перезапуск сервиса', 1013: 'повторите позже' };
const hexOf = (bytes) => [...(bytes || [])].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// ── head + composer ──
function renderWsHead() {
  const box = clear($('wsHead'));
  const c = WS.conns.get(WS.sel);
  if (!c) return;
  const open = wsIsOpen(c);
  append(box, [
    badge(open ? 'ОТКРЫТО' : 'ЗАКРЫТО', open ? 's2' : ''),
    h('span', { class: 'mono ws-url', title: wsUrl(c.url) }, wsUrl(c.url)),
    h('span', { class: 'muted' }, `↑ ${c.n.out.toLocaleString()} · ↓ ${c.n.in.toLocaleString()} · ${fmtSize(c.bytes) || '0 B'}`),
    c.close ? h('span', { class: 'muted', title: 'Кадр закрытия' }, c.close) : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onclick: () => showInTraffic(c.id), title: 'Запрос на апгрейд (заголовки, cookie) в Трафике' }, 'Рукопожатие'),
    open ? h('button', { class: 'btn sm danger', onclick: () => wsCloseModal(c) }, 'Закрыть…') : null,
  ]);
}
function renderWsCompose() {
  const c = WS.conns.get(WS.sel);
  const open = !!c && wsIsOpen(c);
  $('wsCompose').hidden = !c;
  $('wsSend').disabled = !open;
  $('wsData').disabled = !open;
  $('wsComposeHint').hidden = open;
  $('wsComposeHint').textContent = shown ? 'Сохранённая сессия — отправка работает только на открытом соединении в живой сессии'
    : 'Соединение закрыто — перезагрузите страницу в Chrome, чтобы открыть новое';
}
function wsCompose(dir, type, data) {
  WS.cdir = dir; WS.ctype = type;
  renderWsComposeCtl();
  $('wsData').value = data;
  $('wsData').focus();
}
function renderWsComposeCtl() {
  const dirBox = clear($('wsCDir'));
  dirBox.append(seg([['out', '↑ Серверу'], ['in', '↓ Странице']], WS.cdir, (v) => { WS.cdir = v; store.set('ws-cdir', v); renderWsComposeCtl(); }));
  $('wsCType').value = WS.ctype;
  $('wsData').placeholder = WS.ctype === 'hex' ? 'Байты в hex — 48 65 6c 6c 6f' : WS.ctype === 'base64' ? 'Байты в base64' : WS.ctype === 'ping' ? 'Необязательный payload для ping (≤125 байт)'
    : `Сообщение ${WS.cdir === 'out' ? 'серверу, как будто его отправила страница' : 'странице, как будто его отправил сервер'} — Ctrl+Enter отправляет`;
}
async function wsSend() {
  const c = WS.conns.get(WS.sel);
  if (!c) return;
  const raw = $('wsData').value;
  const t = WS.ctype;
  const body = { dir: WS.cdir, type: t === 'hex' || t === 'base64' ? 'binary' : t, data: raw };
  if (t === 'hex') {
    const clean = raw.replace(/0x/gi, '').replace(/[\s,:]/g, '');
    if (!/^([0-9a-f]{2})*$/i.test(clean)) throw new Error('Hex должен быть парами 0-9 a-f');
    body.data = btoa(String.fromCharCode(...(clean.match(/../g) || []).map((x) => parseInt(x, 16))));
    body.base64 = true;
  } else if (t === 'base64') {
    try { atob(raw.replace(/\s/g, '')); } catch { throw new Error('Невалидный base64'); }
    body.data = raw.replace(/\s/g, ''); body.base64 = true;
  }
  await post(`/api/ws/${c.id}/send`, body);
  toast(WS.cdir === 'out' ? 'Отправлено серверу' : 'Отправлено странице', 'ok');
}
function wsCloseModal(c) {
  const code = h('input', { type: 'number', value: '1000', min: '1000', max: '4999' });
  const reason = h('input', { type: 'text', value: '', placeholder: 'Необязательно, ≤123 байт', maxLength: 123 });
  modal('Закрыть соединение', h('div', null,
    h('p', { class: 'muted' }, 'Отправляет кадр закрытия и странице, и серверу.'),
    h('div', { class: 'form' }, ...field('Код', code, '1000 штатно · 1001 уход · 4000–4999 приложение'), ...field('Причина', reason))), [
    { label: 'Отмена' },
    { label: 'Закрыть соединение', cls: 'danger', fn: async () => { await post(`/api/ws/${c.id}/close`, { code: Number(code.value) || 1000, reason: reason.value }); toast('Кадр закрытия отправлен', 'ok'); } },
  ]);
}

// ── page ──
function renderWsMain() {
  const has = WS.conns.has(WS.sel);
  $('wsNone').hidden = has;
  $('wsPane').hidden = !has;
  if (!has) { clear($('wsList')); clear($('wsMsg')); WS.rendered = 0; return; }
  renderWsHead();
  renderWsMsgs();
  renderWsMsg();
  renderWsCompose();
  renderWsComposeCtl();
}
function renderWs() {
  renderWsConns();
  if (WS.sel == null || !WS.conns.has(WS.sel)) {
    const first = [...WS.conns.values()].sort((a, b) => (wsIsOpen(b) - wsIsOpen(a)) || b.id - a.id)[0];
    WS.sel = first ? first.id : null;
    if (first) renderWsConns();
  }
  renderWsMain();
}
function renderWsFilters() {
  clear($('wsDir')).append(seg([['', 'Все'], ['out', '↑ Отправлено'], ['in', '↓ Получено']], WS.dir, (v) => { WS.dir = v; store.set('ws-dir', v); renderWsFilters(); renderWsMsgs(); }));
  clear($('wsTypes')).append(...[['text', 'Текст'], ['binary', 'Бинарные'], ['control', 'Служебные']].map(([k, label]) =>
    h('button', { class: `chip${WS.types[k] ? ' on' : ''}`, title: k === 'control' ? 'ping, pong, close' : '', onclick: () => { WS.types[k] = !WS.types[k]; store.set('ws-types', WS.types); renderWsFilters(); renderWsMsgs(); } }, label)));
}
function loadWs() {
  wsSetQuery($('wsQ').value);
  renderWsFilters();
  renderWs();
  if (!shown) guard(wsRefreshOpen)();
}

$('wsQ').addEventListener('input', () => debounce('ws-q', 150, () => { wsSetQuery($('wsQ').value); renderWsMsgs(); }));
$('wsConnQ').addEventListener('input', () => { WS.connQ = $('wsConnQ').value.trim(); renderWsConns(); });
$('wsOpenOnly').addEventListener('change', () => { WS.openOnly = $('wsOpenOnly').checked; renderWsConns(); });
$('wsCType').addEventListener('change', () => { WS.ctype = $('wsCType').value; store.set('ws-ctype', WS.ctype); renderWsComposeCtl(); });
$('wsSend').addEventListener('click', guard(wsSend));
$('wsData').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); if (!$('wsSend').disabled) guard(wsSend)(); }
});

/** Traffic detail for one WebSocket message. */
function renderWsDetail(d, e) {
  const p = wsPayload(e);
  const dd = e.data || {};
  d.append(sect('Сообщение', kvGrid([
    ['Направление', e.dir === 'out' ? '↑ страница → сервер' : e.dir === 'in' ? '↓ сервер → страница' : 'соединение'],
    ['Тип', e.type], ['Размер', fmtSize(e.resSize) || '0 B'], ['Время', new Date(e.ts).toISOString()], ['URL', wsUrl(e.url)],
    ...(e.inj ? [['Внедрено', 'отправлено из CupNet']] : []), ...(dd.compressed ? [['Сжатие', 'permessage-deflate (распаковано)']] : []),
    ...(dd.code ? [['Код закрытия', `${dd.code} ${dd.reason || ''}`]] : []),
  ])));
  if (!wsControl(e.type)) {
    const pre = p.json !== undefined ? jsonPre(JSON.stringify(p.json, null, 2)) : h('pre', { class: 'codebox' }, p.text ?? hexDump(p.bytes));
    d.append(sect('Payload', pre));
  }
  d.append(h('div', { class: 'cn-acts ws-pad' }, h('button', { class: 'btn sm primary', onclick: () => wsReveal(e.ws, e.seq) }, 'Открыть в WebSockets')));
}
