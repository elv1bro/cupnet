'use strict';
/* CupNet mini UI — DNS overrides, notes, site map and session sharing. Shares the global scope of ui.js
 * (h, api, toast, modal, go, …) and ui-inspect.js; same rules: no innerHTML, every node built with h(). */

// ─────────────────────────────────────────────────────────────────────────────
// DNS overrides
// ─────────────────────────────────────────────────────────────────────────────
const DN = { rules: [], activity: [], q: '', resolved: null };
const dnsWild = (host) => host.startsWith('*.');
async function loadDns() { dnsApply(await api('/api/dns')); }
function dnsApply(r) { DN.rules = r.rules || []; DN.activity = r.activity || []; renderDns(); }

function renderDns() {
  const q = $('dnsQ').value.trim().toLowerCase();
  const rows = DN.rules.filter((r) => !q || `${r.host} ${r.ip} ${r.note} ${r.rewriteHost || ''}`.toLowerCase().includes(q));
  const on = DN.rules.filter((r) => r.enabled).length;
  $('dnsShown').textContent = DN.rules.length ? `${on} вкл · ${DN.rules.length} правил` : '';
  const tb = clear($('dnsRows'));
  $('dnsEmpty').hidden = rows.length > 0;
  $('dnsEmpty').textContent = DN.rules.length ? 'Нет правил по фильтру.' : 'Пока нет переопределений — добавьте или импортируйте hosts-файл.';
  for (const r of rows) {
    tb.append(h('tr', { class: r.enabled ? '' : 'off' },
      h('td', null, h('label', { class: 'switch', title: r.enabled ? 'Вкл — нажмите, чтобы выключить' : 'Выкл — нажмите, чтобы включить' },
        h('input', { type: 'checkbox', checked: r.enabled, onchange: guard(async (ev) => dnsApply(await put(`/api/dns/${r.id}`, { enabled: ev.target.checked }))) }), h('span'))),
      h('td', { title: dnsWild(r.host) ? `${r.host.slice(2)} и все поддомены` : r.host }, h('span', { class: 'mono' }, r.host), dnsWild(r.host) ? [' ', tag('маска', 'accent')] : null),
      h('td', null, h('span', { class: 'mono' }, r.ip)),
      h('td', null, r.rewriteHost ? tag(`Host: ${r.rewriteHost}`, 'warn') : null, r.cors ? [' ', tag('CORS')] : null),
      h('td', { class: 'muted', title: r.note || '' }, r.note || ''),
      h('td', { class: 'r-al', title: r.lastHit ? `последний ${new Date(r.lastHit).toLocaleString()}` : 'Нет запросов с момента запуска' },
        r.hits ? h('b', null, r.hits.toLocaleString()) : h('span', { class: 'faint' }, '0'), r.lastHit ? h('div', { class: 'faint' }, fmtAgo(r.lastHit)) : null),
      h('td', { class: 'r-al' },
        h('button', { class: 'btn sm', onclick: () => dnsEditor(r) }, 'Изменить'),
        h('button', { class: 'btn sm danger', onclick: guard(async () => {
          if (!(await confirmBox(`Удалить переопределение ${r.host} → ${r.ip}?`, 'Удалить', true))) return;
          dnsApply(await del(`/api/dns/${r.id}`)); toast('Удалено', 'ok');
        }) }, 'Удалить'))));
  }
  renderDnsActivity();
}

function renderDnsActivity() {
  const tb = clear($('dnsAct'));
  $('dnsActEmpty').hidden = DN.activity.length > 0;
  for (const a of DN.activity.slice(0, 200)) {
    const [, path] = splitUrl(a.url);
    tb.append(h('tr', null,
      h('td', { class: 'mono faint' }, fmtTime(a.at)),
      h('td', null, a.method ? h('span', { class: `m m-${a.method}` }, a.method) : ''),
      h('td', null, a.status ? h('span', { class: `st ${stCls(a.status)}` }, a.status) : h('span', { class: 'st sf' }, 'ERR')),
      h('td', { class: 'mono', title: `${a.host} → ${a.ip}` }, a.host, h('span', { class: 'faint' }, ' → '), a.ip),
      h('td', { class: 'mono muted', title: a.url }, path),
      h('td', { class: 'r-al' }, a.seq ? h('button', { class: 'btn sm', title: 'Показать этот запрос в Трафике', onclick: () => cmpShowInTraffic({ sid: current, seq: a.seq }) }, `#${a.seq}`) : null)));
  }
}

function dnsEditor(r) {
  const isNew = !r;
  const v = { host: r?.host || '', ip: r?.ip || '', rewriteHost: r?.rewriteHost || '', cors: !!r?.cors, note: r?.note || '', enabled: r ? r.enabled : true };
  const err = h('div', { class: 'result err', hidden: true });
  const inp = (key, ph, extra = {}) => h('input', { type: 'text', class: 'mono', value: v[key], placeholder: ph, spellcheck: false, oninput: (ev) => { v[key] = ev.target.value; }, ...extra });
  const body = h('div', null,
    h('div', { class: 'form' },
      ...field('Хост', inp('host', 'api.example.com или *.example.com'), '*.example.com включает example.com и все поддомены'),
      ...field('IP', inp('ip', '203.0.113.10 или 2001:db8::1'), 'Сюда идёт TCP-соединение. URL, SNI и Host остаются настоящим хостом, поэтому HTTPS и HTTP/2 работают как обычно.'),
      ...field('Переопределить Host', inp('rewriteHost', 'необязательно — напр. staging.example.com'), 'Отправлять другой заголовок Host (виртуальные хосты на одном IP). Для таких запросов используется HTTP/1.1.'),
      ...field('Опции', h('div', { class: 'inline' },
        sw(v.cors, 'Добавлять разрешающие заголовки CORS', (x) => { v.cors = x; }),
        sw(v.enabled, 'Включено', (x) => { v.enabled = x; }))),
      ...field('Заметка', inp('note', 'необязательно', { class: '' }))),
    err);
  modal(isNew ? 'Новое переопределение DNS' : `Изменить ${r.host}`, body, [
    { label: 'Отмена' },
    { label: isNew ? 'Добавить' : 'Сохранить', cls: 'primary', fn: async () => {
      try {
        dnsApply(isNew ? await post('/api/dns', v) : await put(`/api/dns/${r.id}`, v));
        toast(isNew ? `${v.host.trim()} → ${v.ip.trim()} добавлено — применяется к новым соединениям` : 'Сохранено', 'ok');
        return true;
      } catch (e) { err.textContent = e.message; err.hidden = false; return false; }
    } },
  ]);
}

function dnsImport() {
  const ta = h('textarea', { class: 'mono code', spellcheck: false, placeholder: '# формат hosts-файла\n203.0.113.10  api.example.com  # staging API\n203.0.113.11  *.cdn.example.com\n# off: 203.0.113.12  old.example.com' });
  let replace = false;
  const file = h('input', { type: 'file', accept: '.txt,.hosts,text/plain', onchange: async (ev) => { const f = ev.target.files[0]; if (f) ta.value = await f.text(); } });
  modal('Импорт переопределений DNS', h('div', null,
    h('p', { class: 'muted' }, 'Вставьте hosts-файл или выберите его. Завершающий # комментарий становится заметкой, строки, начинающиеся с # off:, импортируются как выключенные правила; localhost пропускается.'),
    h('div', { class: 'ck-file' }, file), ta,
    sw(false, 'Заменить все текущие правила', (x) => { replace = x; })), [
    { label: 'Отмена' },
    { label: 'Импорт', cls: 'primary', fn: async () => {
      if (replace && DN.rules.length && !(await confirmBox(`Заменить все ${DN.rules.length} правил импортированными?`, 'Заменить', true))) return false;
      const r = await post('/api/dns/import', { text: ta.value, replace });
      dnsApply(r);
      toast(`Импортировано: ${r.added} добавлено, ${r.updated} обновлено${r.skipped ? `, ${r.skipped} пропущено` : ''}`, r.added || r.updated ? 'ok' : 'warn');
      return true;
    } },
  ]);
}

async function dnsResolve() {
  const host = $('dnsResHost').value.trim();
  if (!host) return;
  const out = clear($('dnsResOut'));
  out.append(h('span', { class: 'muted' }, 'Разрешение…'));
  const r = await busy($('dnsResBtn'), '…', () => post('/api/dns/resolve', { host }));
  clear(out);
  const sys = r.error ? h('span', { class: 'err' }, r.error) : r.addresses.length ? r.addresses.map((a) => [tag(`IPv${a.family}`), ' ', h('span', { class: 'mono' }, a.address), ' ']) : h('span', { class: 'muted' }, 'нет адресов');
  out.append(h('div', { class: 'kv dns-kv' },
    h('div', { class: 'k' }, 'Системный резолвер'), h('div', null, sys),
    h('div', { class: 'k' }, 'CupNet подключается к'), h('div', null, r.override
      ? [h('b', { class: 'mono ok' }, r.override.ip), h('span', { class: 'muted' }, ` — переопределение ${r.override.host}`)]
      : h('span', { class: 'muted' }, 'системный ответ (нет включённого переопределения)'))));
}

$('dnsQ').addEventListener('input', () => renderDns());
$('dnsAdd').addEventListener('click', () => dnsEditor(null));
$('dnsImport').addEventListener('click', dnsImport);
$('dnsExport').addEventListener('click', guard(async () => download((await apiBlob('/api/dns/export')).blob, 'cupnet-dns-hosts.txt')));
$('dnsResBtn').addEventListener('click', guard(dnsResolve));
$('dnsResHost').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') guard(dnsResolve)(); });
$('dnsActRefresh').addEventListener('click', guard(loadDns));
$('dnsActClear').addEventListener('click', guard(async () => { dnsApply(await del('/api/dns/activity')); toast('Журнал активности и счётчики сброшены', 'ok'); }));

// ─────────────────────────────────────────────────────────────────────────────
// Markdown (notes): a small, safe renderer — DOM nodes only, links limited to http(s) and cupnet:req refs
// ─────────────────────────────────────────────────────────────────────────────
const MD_INLINE = /(`[^`\n]+`)|(\|\|[^|\n]+\|\|)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(~~[^~\n]+~~)|(==[^=\n]+==)|\[([^\]\n]+)\]\(([^)\s]+)\)|(cupnet:req\/[\w-]+\/\d+)|(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])/g;
/** Same mask for every secret, so its length is not given away. */
const MD_MASK = '••••••••';
const MD_CALLOUTS = { note: 'Заметка', tip: 'Совет', important: 'Важно', warning: 'Предупреждение', caution: 'Осторожно', danger: 'Опасно' };
/** Stroke icon, 16×16 grid (same look as the nav icons). */
function svgIcon(...paths) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', 'ico'); svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
const ICON_LOCK = ['M4 7.5h8v6H4z', 'M5.5 7.5V5a2.5 2.5 0 015 0v2.5'];
const ICON_COPY = ['M5.5 5.5h7v8h-7z', 'M3.5 10.5v-8h7'];
const ICON_EYE = ['M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', 'M8 6.3a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4z'];
/** A secret: masked until "Show"; "Copy" copies it without showing it. */
function mdSecret(value, block = false) {
  let shown = false;
  const val = h(block ? 'pre' : 'span', { class: 'md-sv' }, MD_MASK);
  const toggle = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    shown = !shown; val.textContent = shown ? value : MD_MASK; wrap.classList.toggle('shown', shown);
    eye.title = shown ? 'Скрыть' : 'Показать';
    if (block) eye.lastChild.textContent = shown ? 'Скрыть' : 'Показать';
  };
  const eye = h('button', { type: 'button', class: 'md-sb', title: 'Показать', onclick: toggle }, svgIcon(...ICON_EYE), block ? h('span', null, 'Показать') : null);
  const cp = h('button', { type: 'button', class: 'md-sb', title: 'Копировать не показывая', onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); copy(value, 'Секрет скопирован'); } }, svgIcon(...ICON_COPY), block ? h('span', null, 'Копировать') : null);
  const wrap = block
    ? h('div', { class: 'md-secret block' }, h('div', { class: 'md-bh' }, svgIcon(...ICON_LOCK), h('span', null, 'Секрет'), h('span', { class: 'spacer' }), eye, cp), val)
    : h('span', { class: 'md-secret', title: 'Секрет' }, svgIcon(...ICON_LOCK), val, eye, cp);
  return wrap;
}
function mdCode(code, lang) {
  return h('div', { class: 'md-code' },
    h('div', { class: 'md-bh' }, h('span', { class: 'mono' }, lang || 'code'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'md-sb', title: 'Копировать код', onclick: (ev) => { ev.preventDefault(); copy(code, 'Код скопирован'); } }, svgIcon(...ICON_COPY), h('span', null, 'Копировать'))),
    h('pre', { class: 'codebox' }, code));
}
function mdRef(ref, label) {
  const m = /^cupnet:req\/([\w-]+)\/(\d+)$/.exec(ref);
  if (!m) return label;
  return h('a', { href: '#', class: 'md-ref', title: `Запрос #${m[2]} сессии ${m[1]} — показать в Трафике`, onclick: (ev) => { ev.preventDefault(); cmpShowInTraffic({ sid: m[1], seq: Number(m[2]) }); } }, label || `#${m[2]}`);
}
function mdLink(href, label) {
  if (/^cupnet:req\//.test(href)) return mdRef(href, label);
  if (!/^https?:\/\//i.test(href)) return label;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, label);
}
function mdInline(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(MD_INLINE)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(h('code', null, m[1].slice(1, -1)));
    else if (m[2]) out.push(mdSecret(m[2].slice(2, -2)));
    else if (m[3]) out.push(h('b', null, mdInline(m[3].slice(2, -2))));
    else if (m[4]) out.push(h('i', null, mdInline(m[4].slice(1, -1))));
    else if (m[5]) out.push(h('s', null, mdInline(m[5].slice(2, -2))));
    else if (m[6]) out.push(h('mark', null, mdInline(m[6].slice(2, -2))));
    else if (m[7]) out.push(mdLink(m[8], mdInline(m[7])));
    else if (m[9]) out.push(mdRef(m[9], `#${m[9].split('/').pop()}`));
    else if (m[10]) out.push(mdLink(m[10], m[10]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
/** Note text with secrets masked (list snippets, search previews). */
const mdMaskSecrets = (text) => String(text || '')
  .replace(/^\s*(```|~~~)\s*secret\s*\n[\s\S]*?(?:\n\s*\1\s*(?:\n|$)|$)/gim, `${MD_MASK}\n`)
  .replace(/\|\|[^|\n]+\|\|/g, MD_MASK);
function mdRender(text) {
  const root = h('div', { class: 'md' });
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = h('p');
    para.forEach((l, i) => { if (i) p.append(h('br')); append(p, mdInline(l)); });
    root.append(p); para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line))) {
      flush();
      const fence = m[1], code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) code.push(lines[i]);
      if (m[2].toLowerCase() === 'secret') root.append(mdSecret(code.join('\n'), true));
      else root.append(mdCode(code.join('\n'), m[2]));
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); root.append(h(`h${m[1].length}`, { class: 'md-h' }, mdInline(m[2]))); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); root.append(h('hr')); continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      const co = /^\s*\[!(\w+)\]\s*(.*)$/.exec(q[0] || '');
      const kind = co && MD_CALLOUTS[co[1].toLowerCase()] ? co[1].toLowerCase() : '';
      if (kind) {
        const title = co[2].trim();
        root.append(h('div', { class: `md-callout md-${kind}` }, h('div', { class: 'md-ct' }, title ? mdInline(title) : MD_CALLOUTS[kind]),
          [...mdRender(q.slice(1).join('\n')).childNodes]));
      } else root.append(h('blockquote', null, [...mdRender(q.join('\n')).childNodes]));
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line))) {
      flush();
      const ordered = /\d/.test(m[2]);
      const list = h(ordered ? 'ol' : 'ul');
      for (; i < lines.length; i++) {
        const lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!lm) {
          // A wrapped item: indented continuation line.
          if (/^\s{2,}\S/.test(lines[i]) && list.lastChild) { list.lastChild.append(h('br'), ...mdInline(lines[i].trim())); continue; }
          break;
        }
        if (/\d/.test(lm[2]) !== ordered) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(lm[3]);
        const li = h('li', { class: lm[1].length >= 2 ? 'md-sub' : '' });
        if (task) { li.classList.add('md-task'); li.append(h('input', { type: 'checkbox', checked: task[1] !== ' ', disabled: true }), ' ', ...mdInline(task[2])); }
        else li.append(...mdInline(lm[3]));
        list.append(li);
      }
      i--;
      root.append(list);
      continue;
    }
    para.push(line);
  }
  flush();
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notes
// ─────────────────────────────────────────────────────────────────────────────
const NT = { notes: [], tags: [], loaded: false, sel: store.get('nt-sel', null), tag: '', site: '', mode: store.get('nt-mode', 'split'), saving: false, pending: null, loading: null };
const ntSiteMatch = (site, host) => !!site && !!host && (site.startsWith('*.') ? host === site.slice(2) || host.endsWith(site.slice(1)) : host === site);
function ntEnsure() {
  if (NT.loaded) return Promise.resolve();
  if (!NT.loading) NT.loading = api('/api/notes').then((r) => { NT.notes = r.notes; NT.tags = r.tags; NT.loaded = true; }).finally(() => { NT.loading = null; });
  return NT.loading;
}
async function loadNotes() {
  await ntFlush();
  const r = await api('/api/notes');
  NT.notes = r.notes; NT.tags = r.tags; NT.loaded = true;
  if (NT.sel && !NT.notes.some((n) => n.id === NT.sel)) NT.sel = null;
  if (!NT.sel && NT.notes.length) NT.sel = NT.notes[0].id;
  renderNotes(true);
}
const ntById = (id) => NT.notes.find((n) => n.id === id) || null;
function ntRetag() {
  const m = new Map();
  for (const n of NT.notes) for (const t of n.tags) m.set(t, (m.get(t) || 0) + 1);
  NT.tags = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, count]) => ({ tag: t, count }));
}
function ntFiltered() {
  const q = $('ntQ').value.trim().toLowerCase();
  return NT.notes.filter((n) => (!NT.tag || n.tags.includes(NT.tag))
    && (!NT.site || (NT.site === '-' ? !n.site : n.site === NT.site))
    && (!q || `${n.title}\n${n.body}\n${n.site}\n${n.tags.join(' ')}`.toLowerCase().includes(q)));
}
function renderNotes(withEditor = false) {
  renderNtList();
  if (withEditor) renderNtEditor();
}
function renderNtList() {
  const sites = [...new Set(NT.notes.map((n) => n.site).filter(Boolean))].sort();
  const sel = $('ntSite');
  const keep = NT.site;
  append(clear(sel), [h('option', { value: '' }, 'Все сайты'), h('option', { value: '-' }, 'Без сайта'), sites.map((s) => h('option', { value: s }, s))]);
  sel.value = keep === '-' || sites.includes(keep) ? keep : '';
  NT.site = sel.value;
  const chips = clear($('ntTags'));
  if (NT.tags.length) {
    chips.append(h('button', { class: `chip${NT.tag ? '' : ' on'}`, onclick: () => { NT.tag = ''; renderNtList(); } }, 'все'));
    for (const t of NT.tags.slice(0, 40)) chips.append(h('button', { class: `chip${NT.tag === t.tag ? ' on' : ''}`, onclick: () => { NT.tag = NT.tag === t.tag ? '' : t.tag; renderNtList(); } }, `#${t.tag}`, h('b', null, t.count)));
  }
  chips.hidden = !NT.tags.length;
  const list = ntFiltered();
  const box = clear($('ntList'));
  if (!list.length) box.append(h('div', { class: 'empty' }, NT.notes.length ? 'Нет заметок по фильтру.' : 'Пока нет заметок.'));
  for (const n of list) {
    const first = mdMaskSecrets(n.body).split('\n').find((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^\s*(```|~~~)/.test(l)) || '';
    box.append(h('div', { class: `prow nt-prow${n.id === NT.sel ? ' sel' : ''}`, onclick: guard(async () => { await ntFlush(); NT.sel = n.id; store.set('nt-sel', n.id); renderNotes(true); }) },
      h('div', { class: 'ell' },
        h('div', { class: 'title' }, n.pinned ? h('span', { class: 'nt-pin', title: 'Закреплено' }, '★') : null, h('b', null, n.title || 'Без названия')),
        h('div', { class: 'nt-snip ell' }, first.replace(/[#*_`>[\]=]|\[!\w+\]/g, '').slice(0, 160)),
        h('div', { class: 'meta' }, n.site ? h('span', { class: 'mono' }, n.site) : null, n.tags.slice(0, 4).map((t) => h('span', { class: 'faint' }, `#${t}`)), h('span', { class: 'faint' }, fmtAgo(n.updated)))),
      null));
  }
  $('ntCount').textContent = NT.notes.length ? `${list.length} / ${NT.notes.length}` : '';
}

function ntPayload() {
  return { title: $('ntTitle')?.value ?? '', body: $('ntBody')?.value ?? '', site: $('ntSiteIn')?.value ?? '', tags: $('ntTagsIn')?.value ?? '' };
}
function ntSetState(text, cls = 'faint') { const s = $('ntState'); if (s) { s.textContent = text; s.className = cls; } }
/** Save the open note now if it has unsaved edits. */
async function ntFlush() {
  if (!NT.pending) return;
  const { id, data } = NT.pending;
  NT.pending = null;
  clearTimeout(_deb.get('ntsave'));
  NT.saving = true; ntSetState('Сохранение…');
  try {
    const n = await put(`/api/notes/${id}`, data);
    const i = NT.notes.findIndex((x) => x.id === id);
    if (i >= 0) NT.notes[i] = n;
    NT.notes.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
    ntRetag();
    if (NT.sel === id) { ntSetState(`Сохранено ${new Date(n.updated).toLocaleTimeString([], { hour12: false })}`); const si = $('ntSiteIn'); if (si) si.classList.remove('bad'); }
    if (PAGE === 'notes') renderNtList();
  } catch (e) {
    if (NT.sel === id) { ntSetState(e.message, 'err'); if (/site/i.test(e.message) && $('ntSiteIn')) $('ntSiteIn').classList.add('bad'); }
    else toast(`Заметка не сохранена: ${e.message}`, 'err');
  } finally { NT.saving = false; }
}
function ntChanged() {
  if (!NT.sel) return;
  NT.pending = { id: NT.sel, data: ntPayload() };
  ntSetState('Изменено');
  debounce('ntsave', 700, () => guard(ntFlush)());
  if (NT.mode !== 'edit') debounce('ntprev', 150, ntPreview);
}
function ntPreview() {
  const pv = $('ntPreview');
  if (pv) clear(pv).append(mdRender($('ntBody')?.value || ''));
}
async function ntNew(o = {}) {
  await ntFlush();
  const n = await post('/api/notes', { title: o.title || '', body: o.body || '', site: o.site ?? (NT.site && NT.site !== '-' ? NT.site : ''), tags: o.tags || (NT.tag ? [NT.tag] : []) });
  NT.notes.unshift(n); ntRetag();
  NT.sel = n.id; store.set('nt-sel', n.id);
  if (PAGE === 'notes') { renderNotes(true); $('ntTitle')?.focus(); }
  return n;
}
function ntMd(n) {
  const meta = [n.site ? `site: ${n.site}` : '', n.tags.length ? `tags: ${n.tags.map((t) => `#${t}`).join(' ')}` : ''].filter(Boolean).join(' · ');
  return `# ${n.title || 'Без названия'}\n\n${meta ? `_${meta}_\n\n` : ''}${n.body}\n`;
}
const ntFileName = (n) => `${(n.title || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note'}.md`;

// ── Notes editor: formatting toolbar, shortcuts, templates ──
/** Built-in templates. {{selection}} {{cursor}} {{date}} {{time}} {{site}} are filled on insert. */
const NT_BUILTIN = [
  { id: 'b-endpoint', name: 'Эндпоинт', body: '## {{cursor}}GET /path\n\n- **Авторизация:** \n- **Параметры:** \n- **Ответ:** \n- **Заметки:** {{selection}}\n' },
  { id: 'b-creds', name: 'Учётные данные', body: '### {{cursor}}Аккаунт\n\n- **Логин:** \n- **Пароль:** ||пароль||\n\n```secret\n{{selection}}\n```\n' },
  { id: 'b-finding', name: 'Находка', body: '## {{cursor}}Находка\n\n> [!WARNING] Влияние\n> {{selection}}\n\n**Шаги**\n1. \n\n**Ожидается:** \n**Фактически:** \n\n_{{date}} · {{site}}_\n' },
  { id: 'b-check', name: 'Чек-лист', body: '### Чек-лист — {{site}}\n\n- [ ] {{cursor}}Вход / выход\n- [ ] Ограничения частоты\n- [ ] Cookies и хранилище\n- [ ] Ответы с ошибками\n' },
  { id: 'b-log', name: 'Запись журнала', body: '**{{date}} {{time}}** — {{cursor}}{{selection}}\n' },
];
NT.tpls = null;
const ntTpls = async () => { if (!NT.tpls) NT.tpls = await api('/api/notes/templates'); return NT.tpls; };
const ntTa = () => $('ntBody');
/** Replace [s, e) through the edit stack (so ⌘Z works), then select [a, b). */
function ntReplace(ta, s, e, text, a, b = a) {
  ta.focus();
  ta.setSelectionRange(s, e);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok || ta.value.slice(s, s + text.length) !== text) { ta.setRangeText(text, s, e, 'end'); ntChanged(); }
  ta.setSelectionRange(a, b);
}
/** Toggle an inline wrapper (**, _, ~~, ==, `, ||) around the selection. */
function ntWrap(before, after = before, ph = 'text') {
  const ta = ntTa(); if (!ta) return;
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, sel = v.slice(s, e);
  if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    return ntReplace(ta, s, e, inner, s, s + inner.length);
  }
  if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    return ntReplace(ta, s - before.length, e + after.length, sel, s - before.length, e - before.length);
  }
  const inner = sel || ph;
  ntReplace(ta, s, e, `${before}${inner}${after}`, s + before.length, s + before.length + inner.length);
}
/** Rewrite the whole lines the selection touches. */
function ntLines(fn) {
  const ta = ntTa(); if (!ta) return;
  const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
  const s = v.lastIndexOf('\n', a - 1) + 1;
  let e = v.indexOf('\n', b > a && v[b - 1] === '\n' ? b - 1 : b);
  if (e < 0) e = v.length;
  const out = fn(v.slice(s, e).split('\n')).join('\n');
  if (a === b) ntReplace(ta, s, e, out, s + out.length);
  else ntReplace(ta, s, e, out, s, s + out.length);
}
function ntHeading(n) {
  const mk = `${'#'.repeat(n)} `;
  ntLines((ls) => {
    const body = ls.length > 1 ? ls.filter((l) => l.trim()) : ls;
    const all = body.every((l) => l.startsWith(mk));
    return ls.map((l) => (ls.length > 1 && !l.trim() ? l : all ? l.replace(/^#{1,6}\s+/, '') : mk + l.replace(/^#{1,6}\s+/, '')));
  });
}
const NT_LIST_RE = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;
const NT_LIST_IS = { ul: /^\s*[-*+]\s(?!\s*\[[ xX]\])/, ol: /^\s*\d+[.)]\s/, task: /^\s*[-*+]\s+\[[ xX]\]\s/ };
function ntList(kind) {
  const mk = { ul: () => '- ', ol: (i) => `${i + 1}. `, task: () => '- [ ] ' }[kind];
  ntLines((ls) => {
    const body = ls.filter((l) => l.trim());
    const all = body.length > 0 && body.every((l) => NT_LIST_IS[kind].test(l));
    let i = 0;
    return ls.map((l) => {
      if (!l.trim() && ls.length > 1) return l;
      const m = NT_LIST_RE.exec(l);
      const ind = m ? m[1] : /^\s*/.exec(l)[0];
      const rest = l.slice(m ? m[0].length : ind.length);
      return all ? ind + rest : ind + mk(i++) + rest;
    });
  });
}
function ntQuote() {
  ntLines((ls) => {
    const all = ls.every((l) => /^>/.test(l));
    return ls.map((l) => (all ? l.replace(/^>\s?/, '') : `> ${l}`));
  });
}
/** Put a fenced or callout block around the selected text (on lines of its own). */
function ntBlock(open, close, ph = '') {
  const ta = ntTa(); if (!ta) return;
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  const sel = v.slice(s, e).replace(/\n$/, '');
  const pre = s > 0 && v[s - 1] !== '\n' ? '\n' : '';
  const post = e < v.length && v[e] !== '\n' ? '\n' : '';
  const inner = sel || ph;
  const text = `${pre}${open}\n${inner}${close == null ? '' : `\n${close}`}${post}`;
  const at = s + pre.length + open.length + 1;
  ntReplace(ta, s, e, text, at, at + inner.length);
}
function ntCallout(kind) {
  const ta = ntTa(); if (!ta) return;
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).replace(/\n$/, '');
  const body = (sel || '').split('\n').map((l) => `> ${l}`).join('\n');
  const head = `> [!${kind.toUpperCase()}]`;
  const s = ta.selectionStart, v = ta.value;
  const pre = s > 0 && v[s - 1] !== '\n' ? '\n' : '';
  const post = ta.selectionEnd < v.length && v[ta.selectionEnd] !== '\n' ? '\n' : '';
  const text = `${pre}${head}\n${body}${post}`;
  const end = s + pre.length + head.length + 1 + body.length;
  ntReplace(ta, s, ta.selectionEnd, text, sel ? s + pre.length : end, end);
}
/** One line selected → inline ||secret||; several lines or nothing → a ```secret block. */
function ntSecret() {
  const ta = ntTa(); if (!ta) return;
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  if (sel && !sel.includes('\n')) ntWrap('||', '||');
  else ntBlock('```secret', '```', 'token, password or key');
}
function ntLink() {
  const ta = ntTa(); if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
  if (/^https?:\/\/\S+$/.test(sel)) { const t = `[link](${sel})`; return ntReplace(ta, s, e, t, s + 1, s + 5); }
  const label = sel || 'text', t = `[${label}](https://)`;
  ntReplace(ta, s, e, t, s + label.length + 3, s + label.length + 11);
}
function ntRule() {
  const ta = ntTa(); if (!ta) return;
  const v = ta.value, s = ta.selectionEnd;
  const pre = s > 0 && v[s - 1] !== '\n' ? '\n\n' : s > 1 && v[s - 2] !== '\n' ? '\n' : '';
  const t = `${pre}---\n`;
  ntReplace(ta, s, s, t, s + t.length);
}
/** Tab / Shift+Tab on list lines or a multi-line selection: indent or outdent. */
function ntIndent(out) {
  const ta = ntTa();
  const v = ta.value, multi = v.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
  const line = v.slice(v.lastIndexOf('\n', ta.selectionStart - 1) + 1).split('\n')[0];
  if (!multi && !NT_LIST_RE.test(line) && !out) { const p = ta.selectionStart; return ntReplace(ta, p, ta.selectionEnd, '  ', p + 2); }
  ntLines((ls) => ls.map((l) => (out ? l.replace(/^ {1,2}|^\t/, '') : l.trim() ? `  ${l}` : l)));
}
/** Enter inside a list or quote continues it; Enter on an empty item ends it. */
function ntEnter(ev) {
  const ta = ntTa();
  if (ta.selectionStart !== ta.selectionEnd) return;
  const v = ta.value, p = ta.selectionStart, ls = v.lastIndexOf('\n', p - 1) + 1;
  const line = v.slice(ls, p);
  const m = /^(\s*)(?:([-*+])\s+(\[[ xX]\])\s+|([-*+])\s+|(\d+)([.)])\s+|(>)\s?)/.exec(line);
  if (!m) return;
  const le = v.indexOf('\n', p) < 0 ? v.length : v.indexOf('\n', p);
  ev.preventDefault();
  if (line.length === m[0].length && !v.slice(p, le).trim()) { ntReplace(ta, ls, le, '', ls); return; }
  const next = m[3] ? `${m[1]}${m[2]} [ ] ` : m[4] ? `${m[1]}${m[4]} ` : m[5] ? `${m[1]}${Number(m[5]) + 1}${m[6]} ` : `${m[1]}> `;
  ntReplace(ta, p, p, `\n${next}`, p + 1 + next.length);
}
function ntFillTemplate(body, sel) {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const n = ntById(NT.sel);
  const vars = { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, site: n?.site || $('ntSiteIn')?.value || '', selection: sel };
  let text = body.replace(/\{\{(date|time|site|selection)\}\}/g, (_, k) => vars[k]);
  const at = text.indexOf('{{cursor}}');
  text = text.replace(/\{\{cursor\}\}/g, '');
  return { text, at: at < 0 ? text.length : at };
}
function ntInsertTemplate(t) {
  const ta = ntTa(); if (!ta) return;
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  const { text, at } = ntFillTemplate(t.body, v.slice(s, e));
  const pre = s > 0 && v[s - 1] !== '\n' && /\n/.test(text) ? '\n' : '';
  ntReplace(ta, s, e, pre + text, s + pre.length + at);
}
/** Small anchored menu (same look as the custom select). Items: {label, hint, fn, cls} | {group} | null. */
function ntMenu(anchor, items) {
  document.querySelector('.nt-menu')?.remove();
  const pop = h('div', { class: 'cs-pop nt-menu', role: 'menu' });
  const list = h('div', { class: 'cs-list' });
  const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
  const outside = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchor) close(); };
  const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); ntTa()?.focus(); } };
  for (const it of items) {
    if (!it) { list.append(h('div', { class: 'nt-menu-sep' })); continue; }
    if (it.group) { list.append(h('div', { class: 'cs-grp' }, it.group)); continue; }
    list.append(h('div', { class: `cs-opt${it.cls ? ` ${it.cls}` : ''}`, role: 'menuitem', title: it.title || '',
      onmousedown: (ev) => ev.preventDefault(),
      onclick: () => { close(); it.fn(); } }, h('span', { class: 'cs-t' }, it.label), it.hint ? h('span', { class: 'cs-val' }, it.hint) : null));
  }
  pop.append(list);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.minWidth = `${Math.max(200, r.width)}px`;
  pop.style.maxHeight = `${Math.min(420, innerHeight - r.bottom - 12)}px`;
  pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${r.bottom + 4}px`;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', esc, true);
}
async function ntTemplatesMenu(anchor) {
  if (document.querySelector('.nt-menu')) { document.querySelector('.nt-menu').remove(); return; }
  const mine = await ntTpls().catch(() => []);
  const ta = ntTa();
  const hasSel = !!ta && ta.selectionStart !== ta.selectionEnd;
  ntMenu(anchor, [
    { group: 'Шаблоны' },
    ...NT_BUILTIN.map((t) => ({ label: t.name, fn: () => ntInsertTemplate(t) })),
    ...(mine.length ? [{ group: 'Мои шаблоны' }, ...mine.map((t) => ({ label: t.name, hint: `${t.body.split('\n').length} строк`, fn: () => ntInsertTemplate(t) }))] : []),
    null,
    { label: hasSel ? 'Сохранить выделение как шаблон…' : 'Новый шаблон…', fn: () => ntTemplateModal(null, hasSel ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '') },
    ...(mine.length ? [{ label: 'Управление шаблонами…', fn: ntManageTemplates }] : []),
  ]);
}
function ntTemplateModal(t, body = '') {
  const name = h('input', { type: 'text', value: t?.name || '', placeholder: 'Баг-репорт', maxlength: 80 });
  const ta = h('textarea', { class: 'mono code short', spellcheck: false, value: t?.body ?? body });
  modal(t ? 'Изменить шаблон' : 'Новый шаблон', h('div', { class: 'form' },
    ...field('Название', name),
    ...field('Текст', ta, 'Markdown. {{cursor}} ставит курсор; {{selection}}, {{date}}, {{time}} и {{site}} подставляются при вставке.', true)), [
    { label: 'Отмена' },
    { label: t ? 'Сохранить' : 'Создать', cls: 'primary', fn: async () => {
      const data = { name: name.value, body: ta.value };
      if (t) await put(`/api/notes/templates/${t.id}`, data); else await post('/api/notes/templates', data);
      NT.tpls = null;
      toast(t ? 'Шаблон сохранён' : `Шаблон «${data.name.trim()}» создан`, 'ok');
      return true;
    } },
  ]);
}
async function ntManageTemplates() {
  const mine = await ntTpls();
  const body = h('div', { class: 'nt-tpl-list' });
  const draw = () => {
    clear(body);
    if (!NT.tpls.length) body.append(h('div', { class: 'empty' }, 'Пока нет своих шаблонов.'));
    for (const t of NT.tpls) {
      body.append(h('div', { class: 'nt-tpl-row' },
        h('div', { class: 'ell' }, h('b', null, t.name), h('div', { class: 'faint ell mono' }, mdMaskSecrets(t.body).split('\n').find((l) => l.trim()) || '')),
        h('button', { class: 'btn sm', onclick: () => ntTemplateModal(t) }, 'Изменить'),
        h('button', { class: 'btn sm danger', onclick: guard(async () => {
          await del(`/api/notes/templates/${t.id}`);
          NT.tpls = NT.tpls.filter((x) => x.id !== t.id); draw();
        }) }, 'Удалить')));
    }
  };
  NT.tpls = mine; draw();
  modal('Мои шаблоны', body, [{ label: 'Закрыть' }]);
}
const NT_KEYS = { b: () => ntWrap('**'), i: () => ntWrap('_'), k: ntLink, e: () => ntWrap('`', '`', 'code'), 'shift+h': () => ntWrap('==', '==', 'highlight'), 'shift+x': ntSecret, 'shift+7': () => ntList('ol'), 'shift+8': () => ntList('ul'), 'shift+9': () => ntList('task') };
function ntToolbar() {
  const tb = (label, title, fn, cls = '') => h('button', { type: 'button', class: `nt-tb${cls ? ` ${cls}` : ''}`, title,
    onmousedown: (ev) => ev.preventDefault(), onclick: () => fn() }, label);
  const sep = () => h('span', { class: 'nt-tsep' });
  const menuBtn = (label, title, items) => {
    const b = tb(label, title, () => ntMenu(b, items()), 'menu');
    return b;
  };
  const tpl = tb('Шаблоны', 'Вставить шаблон · сохранить выделение как шаблон', () => guard(() => ntTemplatesMenu(tpl))(), 'menu tpl');
  return h('div', { class: 'nt-tools', role: 'toolbar' },
    menuBtn('Заголовок', 'Заголовок', () => [1, 2, 3, 4].map((n) => ({ label: `${'#'.repeat(n)} Заголовок ${n}`, cls: `nt-mh${n}`, fn: () => ntHeading(n) }))),
    sep(),
    tb(h('b', null, 'B'), 'Жирный (⌘B)', () => ntWrap('**')),
    tb(h('i', null, 'I'), 'Курсив (⌘I)', () => ntWrap('_')),
    tb(h('s', null, 'S'), 'Зачёркнутый', () => ntWrap('~~')),
    tb(h('mark', null, 'H'), 'Выделение (⌘⇧H)', () => ntWrap('==', '==', 'highlight')),
    tb(h('code', null, '`c`'), 'Строчный код (⌘E)', () => ntWrap('`', '`', 'code')),
    tb('Ссылка', 'Ссылка (⌘K)', ntLink),
    sep(),
    tb('{ } Код', 'Блок кода', () => ntBlock('```', '```')),
    tb([svgIcon(...ICON_LOCK), h('span', null, 'Секрет')], 'Секрет (⌘⇧X) — маскируется как •••••••• в предпросмотре; одна строка → строчный, несколько → блок', ntSecret, 'secret'),
    menuBtn('Выноска', 'Блок-выноска', () => Object.entries(MD_CALLOUTS).map(([k, label]) => ({ label, cls: `nt-mc md-${k}`, fn: () => ntCallout(k) }))),
    sep(),
    tb('• Список', 'Маркированный список (⌘⇧8)', () => ntList('ul')),
    tb('1. Список', 'Нумерованный список (⌘⇧7)', () => ntList('ol')),
    tb('☐ Задачи', 'Список задач (⌘⇧9)', () => ntList('task')),
    tb('❝', 'Цитата', ntQuote),
    tb('—', 'Горизонтальная линия', ntRule),
    h('span', { class: 'spacer' }),
    tpl);
}

function renderNtEditor() {
  const box = clear($('ntEditor'));
  const n = ntById(NT.sel);
  if (!n) {
    box.append(h('div', { class: 'empty' },
      h('p', null, h('b', null, 'Заметки по сайтам, с которыми вы работаете.')),
      h('p', { class: 'muted' }, 'Markdown, теги и сайт на заметку. Сошлитесь на запрос через cupnet:req/<session>/<#> — или через «Добавить в заметку» в Трафике — и получите ссылку на запрос.'),
      h('button', { class: 'btn primary', onclick: guard(() => ntNew()) }, '+ Новая заметка')));
    return;
  }
  const title = h('input', { type: 'text', id: 'ntTitle', class: 'nt-title', value: n.title, placeholder: 'Без названия', oninput: ntChanged });
  const pinned = h('button', { class: `btn sm${n.pinned ? ' on' : ''}`, title: 'Закрепить вверху списка', onclick: guard(async () => {
    await ntFlush();
    const u = await put(`/api/notes/${n.id}`, { pinned: !n.pinned });
    Object.assign(n, u); NT.notes.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
    renderNotes(true);
  }) }, n.pinned ? '★ Закреплено' : '☆ Закрепить');
  box.append(h('div', { class: 'nt-head' }, title, h('span', { id: 'ntState', class: 'faint' }, `Сохранено ${fmtAgo(n.updated)}`), pinned,
    h('button', { class: 'btn sm', title: 'Скачать как Markdown', onclick: guard(async () => { await ntFlush(); download(new Blob([ntMd(ntById(n.id) || n)], { type: 'text/markdown' }), ntFileName(n)); }) }, '.md'),
    h('button', { class: 'btn sm danger', onclick: guard(async () => {
      if (!(await confirmBox(`Удалить заметку «${n.title || 'Без названия'}»?`, 'Удалить', true))) return;
      NT.pending = null;
      await del(`/api/notes/${n.id}`);
      NT.notes = NT.notes.filter((x) => x.id !== n.id); ntRetag();
      NT.sel = NT.notes[0]?.id || null; store.set('nt-sel', NT.sel);
      renderNotes(true); toast('Заметка удалена', 'ok');
    }) }, 'Удалить')));
  box.append(h('div', { class: 'nt-meta' },
    h('label', { class: 'nt-f' }, h('span', { class: 'muted' }, 'Сайт'), h('input', { type: 'text', id: 'ntSiteIn', class: 'mono', value: n.site, placeholder: 'shop.example.com или *.example.com', spellcheck: false, oninput: ntChanged })),
    h('label', { class: 'nt-f grow' }, h('span', { class: 'muted' }, 'Теги'), h('input', { type: 'text', id: 'ntTagsIn', value: n.tags.join(', '), placeholder: 'вход, api, captcha', oninput: ntChanged })),
    seg([['edit', 'Правка'], ['split', 'Разделить'], ['preview', 'Предпросмотр']], NT.mode, (v) => { NT.mode = v; store.set('nt-mode', v); renderNtEditor(); }),
    n.site ? h('button', { class: 'btn sm', title: 'Карта сайта (текущая сессия)', onclick: () => { smOpenSite(n.site.replace(/^\*\./, ''), dnsWild(n.site)); } }, 'Карта сайта') : null));
  const ta = h('textarea', { id: 'ntBody', class: 'mono nt-body', spellcheck: false, value: n.body, placeholder: '# Находки\n\n- Вход отправляется на /api/auth — cupnet:req/<session>/42\n- [ ] проверить ограничения частоты', oninput: ntChanged });
  ta.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return;
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.key === 'Tab' && !mod) { ev.preventDefault(); ntIndent(ev.shiftKey); return; }
    if (ev.key === 'Enter' && !mod && !ev.shiftKey && !ev.altKey) { ntEnter(ev); return; }
    if (!mod || ev.altKey) return;
    if (ev.key === 's' || ev.key === 'S') { ev.preventDefault(); guard(ntFlush)(); return; }
    // Physical key (layout-independent); fall back to the key for events without a code.
    const code = ev.code || '';
    const k = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code ? '' : /^[a-z0-9]$/i.test(ev.key) ? ev.key.toLowerCase() : '';
    const fn = NT_KEYS[`${ev.shiftKey ? 'shift+' : ''}${k}`];
    if (fn) { ev.preventDefault(); fn(); }
  });
  const pv = h('div', { id: 'ntPreview', class: 'nt-preview' });
  if (NT.mode !== 'preview') box.append(ntToolbar());
  box.append(h('div', { class: `nt-panes nt-${NT.mode}` }, NT.mode !== 'preview' ? ta : null, NT.mode !== 'edit' ? pv : null));
  if (NT.mode !== 'edit') pv.append(mdRender(n.body));
  if (NT.mode === 'preview' && !n.body.trim()) pv.append(h('div', { class: 'empty' }, 'Пустая заметка — переключитесь на Правку.'));
}

/** "Add to note" from a request in Traffic (or a page of the site map). */
async function ntAddFrom({ host, line, title }) {
  await ntEnsure();
  const matching = NT.notes.filter((n) => ntSiteMatch(n.site, host));
  const others = NT.notes.filter((n) => !matching.includes(n));
  const sel = h('select', { class: 'grow' },
    h('option', { value: '' }, `+ Новая заметка${host ? ` для ${host}` : ''}`),
    matching.length ? h('optgroup', { label: `Для ${host}` }, matching.map((n) => h('option', { value: n.id }, n.title || 'Без названия'))) : null,
    others.length ? h('optgroup', { label: 'Другие заметки' }, others.slice(0, 300).map((n) => h('option', { value: n.id }, n.title || 'Без названия'))) : null);
  if (matching[0]) sel.value = matching[0].id;
  const ta = h('textarea', { class: 'mono code short', spellcheck: false, value: line });
  modal('Добавить в заметку', h('div', null, h('div', { class: 'form' }, ...field('Заметка', sel), ...field('Текст', ta, 'Markdown; ссылка cupnet:req ведёт обратно к запросу.', true))), [
    { label: 'Отмена' },
    { label: 'Добавить', cls: 'primary', fn: async () => {
      let n;
      if (!sel.value) n = await ntNew({ title: title || host || 'Заметка', site: host || '', body: `${ta.value.trim()}\n` });
      else {
        await ntFlush();
        const cur = ntById(sel.value) || await api(`/api/notes/${sel.value}`);
        n = await put(`/api/notes/${cur.id}`, { body: `${cur.body.replace(/\s*$/, '')}${cur.body.trim() ? '\n' : ''}${ta.value.trim()}\n` });
        const i = NT.notes.findIndex((x) => x.id === n.id); if (i >= 0) NT.notes[i] = n;
        NT.notes.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
      }
      toast(`Добавлено в «${n.title || 'Без названия'}»`, 'ok', { action: { label: 'Открыть', fn: () => { NT.sel = n.id; store.set('nt-sel', n.id); go('notes'); } } });
      return true;
    } },
  ]);
}
const ntReqLine = (e, sid) => `- \`${e.method} ${e.status || 'ERR'}\` ${e.url} — cupnet:req/${sid}/${e.seq}`;
$('aNote').addEventListener('click', guard(async () => {
  if (!dEntry) return;
  const e = dEntry;
  await ntAddFrom({ host: splitUrl(e.url)[0].replace(/:\d+$/, ''), line: ntReqLine(e, shown || current) });
}));
/** Analyzer header: notes for the page's host. */
function ntHostButton(host) {
  const b = h('button', { class: 'btn sm', title: `Заметки для ${host}`, onclick: () => {
    const n = NT.notes.find((x) => ntSiteMatch(x.site, host));
    if (n) { NT.sel = n.id; store.set('nt-sel', n.id); go('notes'); } else guard(async () => { await ntNew({ title: host, site: host }); go('notes'); })();
  } }, 'Заметки');
  const label = () => { const c = NT.notes.filter((x) => ntSiteMatch(x.site, host)).length; b.textContent = c ? `Заметки · ${c}` : '+ Заметка'; };
  if (NT.loaded) label(); else ntEnsure().then(label, () => {});
  return b;
}
$('ntNew').addEventListener('click', guard(() => ntNew()));
$('ntQ').addEventListener('input', () => renderNtList());
$('ntSite').addEventListener('change', () => { NT.site = $('ntSite').value; renderNtList(); });
$('ntExport').addEventListener('click', guard(async () => {
  await ntFlush();
  const list = ntFiltered();
  if (!list.length) { toast('Нет заметок для экспорта', 'warn'); return; }
  download(new Blob([list.map(ntMd).join('\n---\n\n')], { type: 'text/markdown' }), 'cupnet-notes.md');
}));
window.addEventListener('beforeunload', () => { if (NT.pending) ntFlush(); });

// ─────────────────────────────────────────────────────────────────────────────
// Site map — every link of a site as a page (opened or not), every form with hidden fields marked
// ─────────────────────────────────────────────────────────────────────────────
const SM = {
  session: '', site: store.get('sm-site', ''), subs: store.get('sm-subs', true), data: null, sites: [], tab: store.get('sm-tab', 'pages'),
  filter: store.get('sm-filter', 'all'), hideFiles: store.get('sm-files', true), view: store.get('sm-view', 'tree'), sel: null, open: new Set(), closed: new Set(), expand: 'top',
  pv: store.get('sm-pv', 'page'), formPage: '', formHidden: store.get('sm-fhidden', false), fieldShow: 'all', auto: store.get('sm-auto', true), timer: null, gen: 0, loading: false,
};
const SM_RENDER_MAX = 3000;
const smStatusCls = (p) => (!p.opened ? 'not' : p.status >= 400 ? 'bad' : p.status >= 300 ? 'redir' : 'ok');
const smLabel = (p) => `${p.path}${p.query || ''}`;
const smPageByUrl = (url) => SM.data?.pages.find((p) => p.url === url) || null;
/** Folder state: explicit toggles win, else `expand` ('top' = first level open, 'all', 'none'). */
function smResetTree(expand = 'top') { SM.expand = expand; SM.open = new Set(); SM.closed = new Set(); }
const smIsOpen = (key, depth) => (SM.open.has(key) ? true : SM.closed.has(key) ? false : SM.expand === 'all' || (SM.expand === 'top' && depth === 0));

async function loadSiteMap() {
  const { current: cur, sessions } = await api('/api/sessions');
  const sel = $('smSession');
  const keep = SM.session || cur;
  append(clear(sel), sessions.map((s) => h('option', { value: s.id }, s.id === cur ? `● Текущая — ${s.id}` : s.id)));
  sel.value = sessions.some((s) => s.id === keep) ? keep : cur;
  SM.session = sel.value;
  $('smSubs').checked = SM.subs; $('smAuto').checked = SM.auto;
  await smFetch();
  smSchedule();
}
async function smFetch(quiet = false) {
  if (SM.loading) return;
  SM.loading = true;
  const g = ++SM.gen;
  if (!quiet) $('smState').textContent = 'Сканирование…';
  try {
    const qs = (site) => `/api/sitemap?session=${encodeURIComponent(SM.session)}${site ? `&site=${encodeURIComponent(site)}&subs=${SM.subs ? 1 : 0}` : ''}`;
    let r = await api(qs(SM.site));
    if (g !== SM.gen) return;
    SM.sites = r.sites || [];
    if (!SM.site || (!r.stats && SM.sites.length)) {
      const pick = SM.sites.find((s) => s.host === SM.site) || SM.sites[0];
      if (pick) { SM.site = pick.host; r = await api(qs(SM.site)); if (g !== SM.gen) return; }
    }
    SM.data = r.stats ? r : null;
    $('smState').textContent = SM.data ? `Просканировано HTML-документов: ${SM.data.stats.documents.toLocaleString()}` : '';
    renderSiteMap();
  } finally { SM.loading = false; }
}
function smSchedule() {
  clearTimeout(SM.timer);
  if (!SM.auto || PAGE !== 'sitemap' || SM.session !== current) return;
  SM.timer = setTimeout(async () => {
    if (PAGE !== 'sitemap') return;
    try { await smFetch(true); } catch { /* next tick */ }
    smSchedule();
  }, 6000);
}
function smOpenSite(site, subs) {
  SM.session = current; SM.site = site; store.set('sm-site', site);
  if (subs != null) { SM.subs = subs; store.set('sm-subs', subs); }
  SM.sel = null; smResetTree();
  go('sitemap');
}

function renderSiteMap() {
  const ss = clear($('smSite'));
  if (!SM.sites.length) ss.append(h('option', { value: '' }, 'Пока нет сайтов'));
  for (const s of SM.sites.slice(0, 500)) ss.append(h('option', { value: s.host }, `${s.host} — открыто: ${s.opened}${s.linked ? ` · ссылок: ${s.linked}` : ''}`));
  if (SM.site && !SM.sites.some((s) => s.host === SM.site)) ss.append(h('option', { value: SM.site }, SM.site));
  ss.value = SM.site;
  const d = SM.data;
  const tiles = clear($('smTiles'));
  const main = clear($('smMain'));
  document.querySelectorAll('#smTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === SM.tab));
  if (!d) {
    $('smTabs').hidden = true;
    main.append(h('div', { class: 'empty' },
      h('p', null, h('b', null, 'Просматривайте сайт в проксируемом Chrome — его карта строится сама из трафика.')),
      h('p', { class: 'muted' }, 'Каждая ссылка с каждой HTML-страницы, прошедшей через CupNet, становится страницей карты: зелёные были открыты, пустые — только в ссылках. Формы показаны со всеми полями, скрытые — красным.')));
    return;
  }
  $('smTabs').hidden = false;
  const s = d.stats;
  const t = (v, k, cls, title, fn) => { const el = tile(typeof v === 'number' ? v.toLocaleString() : v, k, cls, title); if (fn) { el.classList.add('sm-tile-btn'); el.addEventListener('click', fn); } return el; };
  tiles.append(
    t(s.pages, 'страниц', '', 'Уникальные URL этого сайта: открытые или в ссылках', () => smSetFilter('all')),
    t(s.opened, 'открыто', 'ok', 'Загружены как документ в этой сессии', () => smSetFilter('opened')),
    t(s.notOpened, 'не открыто', s.notOpened ? 'accent' : '', 'Есть ссылка со страницы, но ни разу не загружалась', () => smSetFilter('not')),
    t(s.forms, 'форм', '', 'Уникальные формы (одинаковые action и поля считаются один раз)', () => { SM.tab = 'forms'; renderSiteMap(); }),
    t(s.hiddenFields, 'скрытых полей', s.hiddenFields ? 'err' : '', 'type=hidden, атрибут hidden, инлайновые display:none / visibility:hidden / за экраном, либо внутри скрытого элемента', () => { SM.tab = 'forms'; SM.formHidden = true; renderSiteMap(); }),
    t(s.likelyHidden, 'возможно скрытых', s.likelyHidden ? 'warn' : '', 'Скрыты через класс (d-none, sr-only, honeypot…) или aria-hidden — проверьте в Анализаторе страницы', () => { SM.tab = 'forms'; SM.formHidden = true; renderSiteMap(); }),
    t(d.external.length, 'внешних хостов', '', 'Другие сайты, на которые ведут ссылки', () => { SM.tab = 'external'; renderSiteMap(); }));
  const c = { pages: s.pages, forms: s.forms, external: d.external.length };
  document.querySelectorAll('#smTabs button').forEach((b) => { const n = b.querySelector('.tag'); if (n) n.textContent = String(c[b.dataset.t] ?? ''); });
  if (SM.tab === 'forms') smForms(main);
  else if (SM.tab === 'external') smExternal(main);
  else smPages(main);
}
function smSetFilter(f) { SM.filter = f; store.set('sm-filter', f); SM.tab = 'pages'; renderSiteMap(); }

function smFilteredPages() {
  const q = ($('smQ')?.value || '').trim().toLowerCase();
  return SM.data.pages.filter((p) => (SM.filter === 'all' || (SM.filter === 'opened' ? p.opened : SM.filter === 'not' ? !p.opened : SM.filter === 'hidden' ? p.refs > 0 && p.hiddenRefs === p.refs : true))
    && (!SM.hideFiles || !p.file)
    && (!q || `${p.url} ${p.title || ''} ${p.text || ''}`.toLowerCase().includes(q)));
}

function smPages(main) {
  const q = h('input', { type: 'search', id: 'smQ', placeholder: 'Фильтр по URL, заголовку, тексту ссылки…', value: SM.lastQ || '', oninput: () => { SM.lastQ = q.value; debounce('smq', 120, smRenderList); } });
  const bar = h('div', { class: 'toolbar sub sm-bar' },
    seg([['all', 'Все'], ['opened', 'Открытые'], ['not', 'Не открытые'], ['hidden', 'Только скрытые ссылки']], SM.filter, (v) => { SM.filter = v; store.set('sm-filter', v); renderSiteMap(); }),
    h('label', { class: 'chk', title: 'Скрыть изображения, скрипты, PDF и другие файлы' }, h('input', { type: 'checkbox', checked: SM.hideFiles, onchange: (ev) => { SM.hideFiles = ev.target.checked; store.set('sm-files', SM.hideFiles); smRenderList(); } }), 'без файлов'),
    q,
    seg([['tree', 'Дерево'], ['list', 'Список']], SM.view, (v) => { SM.view = v; store.set('sm-view', v); renderSiteMap(); }),
    SM.view === 'tree' ? h('button', { class: 'btn sm', title: 'Развернуть все папки', onclick: () => { smResetTree('all'); smRenderList(); } }, 'Развернуть') : null,
    SM.view === 'tree' ? h('button', { class: 'btn sm', title: 'Свернуть все папки', onclick: () => { smResetTree('none'); smRenderList(); } }, 'Свернуть') : null,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted', id: 'smShown' }),
    h('button', { class: 'btn sm', title: 'Копировать показанные URL, по одному на строку', onclick: () => { const l = smFilteredPages(); copy(l.map((p) => p.url).join('\n'), `Скопировано URL: ${l.length}`); } }, 'Копировать URL'),
    h('button', { class: 'btn sm', title: 'Скачать карту в формате JSON', onclick: () => download(new Blob([JSON.stringify(SM.data, null, 2)], { type: 'application/json' }), `cupnet-sitemap-${SM.site}.json`) }, 'JSON'));
  main.append(bar, h('div', { class: 'split2 sm-split' }, h('div', { class: 'list-pane sm-list', id: 'smList' }), h('div', { class: 'edit-pane sm-detail', id: 'smDetail' })));
  smRenderList();
  smRenderDetail();
}

function smTree(pages) {
  const root = { key: '', name: '', kids: new Map(), pages: [], total: 0, opened: 0 };
  const multiHost = new Set(pages.map((p) => p.host)).size > 1;
  for (const p of pages) {
    const segs = p.path.split('/').filter(Boolean);
    let n = root;
    n.total++; if (p.opened) n.opened++;
    const parts = multiHost ? [p.host, ...segs] : segs;
    let key = '';
    for (let i = 0; i < parts.length; i++) {
      key += `/${parts[i]}`;
      let k = n.kids.get(parts[i]);
      if (!k) { k = { key, name: parts[i], kids: new Map(), pages: [], total: 0, opened: 0, host: multiHost && i === 0 }; n.kids.set(parts[i], k); }
      n = k; n.total++; if (p.opened) n.opened++;
    }
    n.pages.push(p);
  }
  return root;
}
function smPageRow(p, label, depth) {
  const cls = smStatusCls(p);
  const onlyHidden = p.refs > 0 && p.hiddenRefs === p.refs;
  return h('div', { class: `sm-row${SM.sel === p.url ? ' sel' : ''}${p.opened ? '' : ' is-not'}`, style: `--d:${depth}`, title: p.url, onclick: () => { SM.sel = p.url; smRenderList(); smRenderDetail(); } },
    h('i', { class: `sm-dot ${cls}`, title: p.opened ? `Открыто ${p.count}× · ${p.status || 'ошибка'}` : 'Не открыто — только в ссылках' }),
    h('span', { class: 'sm-name mono ell' }, label),
    p.title ? h('span', { class: 'sm-ttl ell' }, p.title) : !p.opened && p.text ? h('span', { class: 'sm-ttl ell faint' }, `“${p.text}”`) : null,
    h('span', { class: 'sm-tags' },
      p.opened && p.status && p.status !== 200 ? tag(String(p.status), p.status >= 400 ? 'err' : p.status >= 300 ? 'accent' : '') : null,
      onlyHidden ? tag('скрытая ссылка', 'err') : p.hiddenRefs ? tag(`${p.hiddenRefs} скрыто`, 'warn') : null,
      p.post ? tag('форма') : null, p.kinds.includes('iframe') || p.kinds.includes('frame') ? tag('frame') : null,
      p.file ? tag('файл') : null, p.dns ? tag('DNS', 'accent') : null,
      p.refs ? h('span', { class: 'faint sm-refs', title: `Ссылок ${p.refs}× с ${p.from.length}${p.from.length >= 20 ? '+' : ''} стр.` }, `←${p.refs}`) : null));
}
function smRenderList() {
  const box = $('smList');
  if (!box || !SM.data) return;
  clear(box);
  const pages = smFilteredPages();
  $('smShown').textContent = `${pages.length.toLocaleString()} из ${SM.data.pages.length.toLocaleString()}${SM.data.truncated ? ' (первые 20 000)' : ''}`;
  if (!pages.length) { box.append(h('div', { class: 'empty' }, 'Ничего не найдено.')); return; }
  let n = 0;
  const more = () => box.append(h('div', { class: 'empty' }, `… ещё ${(pages.length - n).toLocaleString()} — сузьте фильтр.`));
  const q = ($('smQ')?.value || '').trim();
  if (SM.view === 'list' || q) {
    for (const p of pages) { if (n >= SM_RENDER_MAX) return more(); box.append(smPageRow(p, SM.subs ? `${p.host}${smLabel(p)}` : smLabel(p), 0)); n++; }
    return undefined;
  }
  const leaf = (p, label, depth) => { const r = smPageRow(p, label, depth); r.prepend(h('span', { class: 'sm-tw' })); return r; };
  const walk = (node, depth, self = null) => {
    for (const p of node.pages) {
      if (n >= SM_RENDER_MAX) return;
      if (p === self) continue;
      box.append(leaf(p, node.key ? (p.query ? `${p.path.endsWith('/') ? '/' : ''}${p.query}` : `${node.name}${p.path.endsWith('/') ? '/' : ''}`) : smLabel(p), depth));
      n++;
    }
    const kids = [...node.kids.values()].sort((a, b) => (b.kids.size > 0) - (a.kids.size > 0) || a.name.localeCompare(b.name));
    for (const k of kids) {
      if (n >= SM_RENDER_MAX) return;
      // A folder with one page and nothing below is shown as that page.
      if (!k.kids.size && k.pages.length === 1) { const p = k.pages[0]; box.append(leaf(p, `${k.name}${p.path.endsWith('/') ? '/' : ''}${p.query || ''}`, depth)); n++; continue; }
      const open = smIsOpen(k.key, depth);
      const toggle = (ev) => {
        ev?.stopPropagation();
        if (open) { SM.open.delete(k.key); SM.closed.add(k.key); } else { SM.closed.delete(k.key); SM.open.add(k.key); }
        smRenderList();
      };
      const tw = h('span', { class: 'sm-tw', title: open ? 'Свернуть' : 'Развернуть' }, open ? '▾' : '▸');
      const bar = [h('span', { class: 'sm-bar-mini', title: `Открыто ${k.opened} из ${k.total}` }, h('i', { style: `width:${Math.round((k.opened / k.total) * 100)}%` })), h('span', { class: 'faint' }, `${k.opened}/${k.total}`)];
      // A folder that is also a page (/catalog with /catalog/shoes below) is one row: the twisty toggles, the row selects.
      const self = k.host ? null : k.pages.find((p) => !p.query) || null;
      let row;
      if (self) {
        row = smPageRow(self, `${k.name}/`, depth);
        row.classList.add('sm-dir');
        tw.addEventListener('click', toggle);
        row.prepend(tw);
        row.querySelector('.sm-tags').prepend(...bar);
      } else {
        row = h('div', { class: `sm-row sm-dir${k.host ? ' sm-host' : ''}`, style: `--d:${depth}`, onclick: toggle },
          tw, h('span', { class: 'sm-name mono ell' }, k.host ? k.name : `${k.name}/`), h('span', { class: 'sm-tags' }, bar));
      }
      box.append(row);
      n++;
      if (open) walk(k, depth + 1, self);
    }
  };
  walk(smTree(pages), 0);
  if (n >= SM_RENDER_MAX) more();
  return undefined;
}

/** Offline snapshots fetched this session (session/seq → response), a few at a time. */
const SM_SNAPS = new Map();
const smCanSnap = (p) => !!(p && p.opened && p.seq && p.status >= 200 && p.status < 300);
function smSnapView(p) {
  const key = `${SM.session}/${p.seq}`;
  const info = h('div', { class: 'sm-snapinfo' }, h('span', { class: 'faint' }, 'Создание снимка…'));
  const fr = h('iframe', { class: 'sm-frame', sandbox: '', referrerpolicy: 'no-referrer', title: `Снимок ${p.url}` });
  const box = h('div', { class: 'sm-framebox' }, fr);
  let width = store.get('sm-snapw', 'fit');
  const fit = () => {
    if (width === 'fit') { fr.style.width = '100%'; fr.style.height = '100%'; fr.style.transform = ''; fr.style.left = '0'; return; }
    const w = Number(width), k = Math.min(1, box.clientWidth / w);
    fr.style.width = `${w}px`; fr.style.height = `${box.clientHeight / k}px`; fr.style.transform = `scale(${k})`;
    fr.style.left = `${Math.max(0, (box.clientWidth - w * k) / 2)}px`;
  };
  new ResizeObserver(fit).observe(box);
  const show = (r) => {
    fr.srcdoc = r.html;
    const st = r.stats;
    const parts = [st.styles && `стилей: ${st.styles}`, st.images && `изображений: ${st.images}`, st.fonts && `шрифтов: ${st.fonts}`].filter(Boolean);
    append(clear(info), [
      h('span', { class: 'faint', title: 'Восстановлено из захваченного HTML и ресурсов, загруженных браузером. Скрипты удалены и ничего не загружается — страницы, отрисованные JavaScript, выглядят здесь пустыми или без стилей.' },
        `Офлайн-копия · захвачено ${fmtAgo(r.ts)}${parts.length ? ` · ${parts.join(', ')}` : ''}${st.scripts ? ` · скриптов отключено: ${st.scripts}` : ''}`),
      st.missing ? h('button', { class: 'btn sm ghost sm-miss', title: 'Ресурсы, используемые страницей, но ни разу не запрошенные через CupNet', onclick: () => modal(`Не захвачено (${st.missing})`,
        h('div', { class: 'sm-misslist mono' }, r.missing.map((u) => h('div', { class: 'ell', title: u }, u)), st.missing > r.missing.length ? h('div', { class: 'faint' }, `… и ещё ${st.missing - r.missing.length}`) : null), [{ label: 'Закрыть' }]) }, `не захвачено: ${st.missing}`) : null,
      st.skipped ? h('span', { class: 'faint' }, ` · слишком больших: ${st.skipped}`) : null,
      h('span', { class: 'spacer' }),
      seg([['fit', 'Вписать'], ['1280', '1280'], ['390', 'Телефон']], width, (v) => { width = v; store.set('sm-snapw', v); info.querySelectorAll('.seg button').forEach((b, i) => b.classList.toggle('on', ['fit', '1280', '390'][i] === v)); fit(); })]);
    fit();
  };
  const cached = SM_SNAPS.get(key);
  if (cached) show(cached);
  else {
    api(`/api/sitemap/snapshot/${p.seq}?session=${encodeURIComponent(SM.session)}`).then((r) => {
      SM_SNAPS.set(key, r);
      while (SM_SNAPS.size > 6) SM_SNAPS.delete(SM_SNAPS.keys().next().value);
      if (fr.isConnected) show(r);
    }, (e) => { clear(info).append(h('span', { class: 'err' }, e.message)); box.remove(); });
  }
  return h('div', { class: 'sm-snap' }, info, box);
}
function smRenderDetail() {
  const box = $('smDetail');
  if (!box) return;
  const p = SM.sel && smPageByUrl(SM.sel);
  const snapKey = smCanSnap(p) && SM.pv === 'page' ? `${SM.session}/${p.seq}` : '';
  // Keep a loaded snapshot on refreshes of the same page (re-inserting a frame reloads it).
  if (snapKey && box.dataset.snap === snapKey && box.querySelector('iframe')) return;
  clear(box);
  box.dataset.snap = snapKey;
  box.classList.toggle('sm-detail-page', !!snapKey);
  if (!p) {
    const s = SM.data.stats;
    box.append(h('div', { class: 'empty' },
      h('p', null, h('b', null, SM.data.site)),
      h('p', { class: 'muted' }, `Открыто ${s.opened} из ${s.pages} страниц (${s.pages ? Math.round((s.opened / s.pages) * 100) : 0}%). Выберите страницу, чтобы увидеть, откуда на неё ссылаются.`),
      h('p', { class: 'faint' }, 'Карта строится из HTML, прошедшего через CupNet (статический разбор). Ссылки, созданные JavaScript, появляются только после запроса страницы, которая их содержит.')));
    return;
  }
  const forms = SM.data.forms.filter((f) => f.pages.some((x) => x.url === p.url));
  const host = p.host;
  box.append(h('div', { class: 'edit-head' },
    h('i', { class: `sm-dot big ${smStatusCls(p)}` }),
    h('h2', { class: 'ell', title: p.title || p.url }, p.title || smLabel(p))));
  box.append(h('div', { class: 'preview-url sm-url' }, p.url));
  box.append(h('div', { class: 'sm-acts' },
    h('button', { class: 'btn primary sm', onclick: guard(async () => { await post('/api/chrome', { url: p.url }); toast('Открываю в Chrome', 'ok'); }) }, 'Открыть в Chrome'),
    p.seq ? h('button', { class: 'btn sm', onclick: () => cmpShowInTraffic({ sid: SM.session, seq: p.seq }) }, `#${p.seq} в Трафике`) : null,
    h('button', { class: 'btn sm', onclick: () => { rpLoad({ method: 'GET', url: p.url, headers: [['Accept', 'text/html,application/xhtml+xml,*/*;q=0.8']] }); go('repeater'); } }, 'Репитер'),
    h('button', { class: 'btn sm', onclick: () => copy(p.url, 'URL скопирован') }, 'Копировать URL'),
    h('button', { class: 'btn sm', onclick: guard(() => ntAddFrom({ host, line: `- ${p.opened ? '' : '(не открыто) '}${p.url}${p.title ? ` — ${p.title}` : ''}${p.seq ? ` — cupnet:req/${SM.session}/${p.seq}` : ''}` })) }, 'Добавить в заметку')));
  if (smCanSnap(p)) {
    box.append(h('div', { class: 'sm-pvtabs' }, seg([['page', 'Страница'], ['info', 'Детали']], SM.pv, (v) => { SM.pv = v; store.set('sm-pv', v); smRenderDetail(); })));
    if (snapKey) { box.append(smSnapView(p)); return; }
  }
  const onlyHidden = p.refs > 0 && p.hiddenRefs === p.refs;
  box.append(sect('Страница', kvGrid([
    ['Состояние', p.opened ? `открыто ${p.count}× · ${(p.methods || []).join(', ')} · ${p.status || 'ошибка'}` : 'не открыто — только в ссылках'],
    ...(p.ts ? [['Последняя загрузка', new Date(p.ts).toLocaleString()]] : []),
    ...(p.redirect ? [['Редирект на', p.redirect]] : []),
    ...(p.dns ? [['Подмена DNS', p.dns]] : []),
    ['Ссылки', p.refs ? `${p.refs}× с ${p.from.length}${p.from.length >= 20 ? '+' : ''} стр.` : 'нет ссылок (открыто напрямую)'],
    ...(p.hiddenRefs ? [['Скрытые ссылки', `${p.hiddenRefs} из ${p.refs}${onlyHidden ? ' — доступно только через скрытые ссылки' : ''}`]] : []),
    ...(p.kinds.length ? [['Типы ссылок', p.kinds.join(', ')]] : []),
    ...(p.text ? [['Текст ссылки', p.text]] : []),
    ...(p.nofollow ? [['rel', 'nofollow']] : []),
    ...(p.out != null ? [['На странице', `ссылок: ${p.out} · форм: ${p.forms}`]] : []),
  ])));
  if (onlyHidden) box.append(h('div', { class: 'note warn' }, 'Все ссылки на эту страницу находятся в скрытом элементе (или имеют скрывающий класс) — типично для ловушек-honeypot либо admin/debug-ссылок.'));
  if (p.from.length) {
    box.append(sect('Ссылки с', h('div', { class: 'sm-from' }, p.from.map((u) => {
      const fp = smPageByUrl(u);
      return h('div', { class: 'sm-from-row' }, fp ? h('i', { class: `sm-dot ${smStatusCls(fp)}` }) : null,
        h('a', { href: '#', class: 'mono ell', title: u, onclick: (ev) => { ev.preventDefault(); if (fp) { SM.sel = u; smRenderList(); smRenderDetail(); } else copy(u, 'URL скопирован'); } }, fp ? smLabel(fp) : u));
    })), true, tag(p.from.length)));
  }
  if (forms.length) {
    box.append(sect('Формы на этой странице', h('div', { class: 'sm-from' }, forms.map((f) => h('div', { class: 'sm-from-row' },
      badge(f.method || 'GET', `m-${f.method || 'GET'}`), h('span', { class: 'mono ell', title: f.action }, f.idx < 0 ? 'поля вне форм' : splitUrl(f.action)[1]),
      f.counts.hidden ? tag(`${f.counts.hidden} скрытых`, 'err') : null, f.counts.likely ? tag(`${f.counts.likely} возможно`, 'warn') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => { SM.formPage = p.url; SM.tab = 'forms'; store.set('sm-tab', 'forms'); renderSiteMap(); } }, 'Поля')))), true, tag(forms.length)));
  }
}

const SM_VIS = { hidden: ['скрыто', 'err'], likely: ['возможно скрыто', 'warn'], visible: ['видно', 'ok'] };
function smFormRequest(f, pageUrl) {
  const pairs = [];
  for (const x of f.fields) {
    if (!x.name || x.disabled || x.tag === 'button' || ['submit', 'button', 'reset', 'image', 'file'].includes(x.type)) continue;
    if ((x.type === 'checkbox' || x.type === 'radio') && !x.checked) continue;
    const v = x.options ? (x.options.find((o) => o.selected) || x.options[0])?.value ?? '' : x.value ?? (x.type === 'checkbox' || x.type === 'radio' ? 'on' : '');
    pairs.push([x.name, v]);
  }
  const enc = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const method = (f.method || 'GET').toUpperCase();
  const action = f.action || pageUrl;
  if (method === 'GET') { const u = new URL(action); u.search = enc; return { method, url: u.toString(), headers: [], body: '' }; }
  return { method, url: action, headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: enc };
}
function smForms(main) {
  const q = h('input', { type: 'search', placeholder: 'Фильтр по action, имени поля, подписи…', value: SM.formQ || '', oninput: () => { SM.formQ = q.value; debounce('smfq', 150, () => smFormCards(list)); } });
  const list = h('div', { class: 'sm-forms' });
  main.append(h('div', { class: 'toolbar sub sm-bar' },
    q,
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: SM.formHidden, onchange: (ev) => { SM.formHidden = ev.target.checked; store.set('sm-fhidden', SM.formHidden); smFormCards(list); } }), 'только формы со скрытыми полями'),
    h('span', { class: 'muted' }, 'Поля'),
    seg([['all', 'Все'], ['hidden', 'Скрытые'], ['visible', 'Видимые']], SM.fieldShow, (v) => { SM.fieldShow = v; renderSiteMap(); }),
    SM.formPage ? h('span', { class: 'tag accent sm-pagechip', title: SM.formPage }, `на ${splitUrl(SM.formPage)[1]}`, h('button', { class: 'icon', title: 'Показать формы всех страниц', onclick: () => { SM.formPage = ''; renderSiteMap(); } }, '✕')) : null,
    h('span', { class: 'spacer' }),
    h('span', { class: 'faint', title: 'Статический разбор HTML в том виде, в каком он пришёл. Поля, добавленные или скрытые через JavaScript или таблицы стилей, видны только в Анализаторе страницы (живая страница).' }, 'Статический HTML · скрытие через CSS/JS → Анализатор страницы')),
  h('div', { class: 'sm-scroll' }, list));
  smFormCards(list);
}
function smFormCards(list) {
  clear(list);
  const q = (SM.formQ || '').trim().toLowerCase();
  const forms = SM.data.forms.filter((f) => (!SM.formHidden || f.counts.hidden + f.counts.likely > 0)
    && (!SM.formPage || f.pages.some((x) => x.url === SM.formPage))
    && (!q || `${f.action} ${f.id} ${f.name} ${f.fields.map((x) => `${x.name} ${x.label || ''} ${x.placeholder || ''} ${x.type}`).join(' ')}`.toLowerCase().includes(q)));
  if (!forms.length) { list.append(h('div', { class: 'empty' }, SM.data.forms.length ? 'Ничего не найдено.' : 'На открытых страницах этого сайта нет форм.')); return; }
  for (const f of forms.slice(0, 300)) {
    const fields = f.fields.filter((x) => SM.fieldShow === 'all' || (SM.fieldShow === 'hidden' ? x.vis !== 'visible' : x.vis === 'visible'));
    const page = f.pages[0].url;
    const req = (() => { try { return smFormRequest(f, page); } catch { return null; } })();
    const pagesEl = h('details', { class: 'sm-fpages' }, h('summary', null, f.pageCount > 1 ? `на ${f.pageCount} страницах` : 'на 1 странице'),
      f.pages.map((x) => h('div', null, h('a', { href: '#', class: 'mono', onclick: (ev) => { ev.preventDefault(); SM.sel = x.url; SM.tab = 'pages'; renderSiteMap(); } }, x.url))));
    list.append(h('div', { class: `an-card sm-form${f.vis !== 'visible' ? ' sm-form-hid' : ''}` },
      h('div', { class: 'an-card-h' },
        f.idx < 0 ? h('b', null, 'Поля вне форм') : [badge(f.method || 'GET', `m-${f.method || 'GET'}`), h('span', { class: 'mono ell', title: f.action }, f.action)],
        f.id ? tag(`#${f.id}`) : null, f.name ? tag(`name=${f.name}`) : null, f.enctype && f.enctype !== 'application/x-www-form-urlencoded' ? tag(f.enctype) : null,
        f.vis !== 'visible' ? tag(`${SM_VIS[f.vis][0]}${f.why ? `: ${f.why}` : ''}`, SM_VIS[f.vis][1]) : null,
        h('span', { class: 'spacer' }),
        tag(`${f.counts.visible} видимых`, 'ok'),
        f.counts.hidden ? tag(`${f.counts.hidden} скрытых`, 'err') : null,
        f.counts.likely ? tag(`${f.counts.likely} возможно скрытых`, 'warn') : null,
        f.idx >= 0 && req ? h('button', { class: 'btn sm', title: 'Открыть отправку (значения по умолчанию) в Репитере', onclick: () => { rpLoad(req); go('repeater'); } }, 'Репитер') : null,
        f.idx >= 0 && req ? h('button', { class: 'btn sm', onclick: () => copy(curlOf(req), 'curl скопирован') }, 'curl') : null),
      h('div', { class: 'sm-fsub' }, pagesEl),
      fields.length ? h('div', { class: 'an-tblwrap' }, h('table', { class: 'tbl sm-ftbl' },
        h('thead', null, h('tr', null, h('th', { class: 'w-110' }, 'Видимость'), h('th', { class: 'w-110' }, 'Тип'), h('th', { class: 'w-150' }, 'Имя'), h('th', null, 'Подпись · placeholder'), h('th', null, 'Значение'), h('th', { class: 'w-150' }, 'Флаги'))),
        h('tbody', null, fields.map((x) => h('tr', { class: `sm-f-${x.vis}` },
          h('td', { title: x.why || '' }, tag(SM_VIS[x.vis][0], SM_VIS[x.vis][1]), x.why ? h('div', { class: 'sm-why' }, x.why) : null),
          h('td', { class: 'mono' }, x.tag === 'input' ? x.type : x.tag === x.type ? x.tag : `${x.tag}:${x.type}`),
          h('td', { class: 'mono', title: x.name }, x.name || h('span', { class: 'faint' }, x.id ? `#${x.id}` : '—')),
          h('td', { title: `${x.label || ''} ${x.placeholder || ''}`.trim() }, x.label || '', x.placeholder ? h('span', { class: 'faint' }, `${x.label ? ' · ' : ''}${x.placeholder}`) : null),
          h('td', { class: 'mono', title: x.options ? x.options.map((o) => `${o.selected ? '● ' : ''}${o.value} — ${o.text}`).join('\n') : x.value || '' },
            x.options ? `${(x.options.find((o) => o.selected) || x.options[0])?.text || ''} (вариантов: ${x.options.length})` : x.value ?? ''),
          h('td', { class: 'an-flags' }, x.required ? tag('required') : null, x.disabled ? tag('disabled') : null, x.readonly ? tag('readonly') : null, x.checked ? tag('checked') : null, x.autocomplete ? tag(`ac=${x.autocomplete}`) : null)))))) : h('div', { class: 'empty sm-nofields' }, 'Нет полей этого типа.')));
  }
  if (forms.length > 300) list.append(h('div', { class: 'empty' }, `… ещё ${forms.length - 300} форм — сузьте фильтр.`));
}
function smExternal(main) {
  const d = SM.data;
  const box = h('div', { class: 'sm-scroll' });
  main.append(box);
  if (!d.external.length) { box.append(h('div', { class: 'empty' }, 'Этот сайт не ссылается на другие хосты (на просмотренных страницах).')); return; }
  box.append(h('table', { class: 'tbl sm-ext' },
    h('thead', null, h('tr', null, h('th', null, 'Хост'), h('th', { class: 'w-110 r-al' }, 'Ссылок'), h('th', { class: 'w-180' }))),
    h('tbody', null, d.external.map((x) => {
      const known = SM.sites.some((s) => s.host === x.host && s.opened);
      return h('tr', null, h('td', { class: 'mono' }, x.host, known ? [' ', tag('открыт', 'ok')] : null), h('td', { class: 'r-al' }, x.links.toLocaleString()),
        h('td', { class: 'r-al' }, h('button', { class: 'btn sm', onclick: () => { SM.site = x.host; store.set('sm-site', x.host); SM.sel = null; SM.tab = 'pages'; guard(smFetch)(); } }, 'Карта'),
          h('button', { class: 'btn sm', onclick: () => ntAddFrom({ host: SM.site, line: `- ссылается на ${x.host} (${x.links}×)` }) }, 'Заметка')));
    }))));
}
document.querySelectorAll('#smTabs button').forEach((b) => b.addEventListener('click', () => { SM.tab = b.dataset.t; store.set('sm-tab', SM.tab); renderSiteMap(); }));
$('smSession').addEventListener('change', guard(async () => { SM.session = $('smSession').value; SM.site = ''; SM.sel = null; await smFetch(); smSchedule(); }));
$('smSite').addEventListener('change', guard(async () => { SM.site = $('smSite').value; store.set('sm-site', SM.site); SM.sel = null; SM.formPage = ''; smResetTree(); await smFetch(); }));
$('smSubs').addEventListener('change', guard(async () => { SM.subs = $('smSubs').checked; store.set('sm-subs', SM.subs); await smFetch(); }));
$('smAuto').addEventListener('change', () => { SM.auto = $('smAuto').checked; store.set('sm-auto', SM.auto); smSchedule(); });
$('smRefresh').addEventListener('click', guard(() => busy($('smRefresh'), '…', () => smFetch())));

// ─────────────────────────────────────────────────────────────────────────────
// Sharing sealed sessions (local test host)
// ─────────────────────────────────────────────────────────────────────────────
async function shareSession(id, btn) {
  const r = await busy(btn, '…', () => post(`/api/sessions/${id}/share`));
  const box = h('div');
  const render = (st) => {
    clear(box);
    const row = (label, value, opts = {}) => h('div', { class: 'sh-row' },
      h('div', { class: 'sh-k' }, label),
      h('div', { class: 'sh-v mono' }, opts.mask ? `${value.replace(/&k=.*$/, '&k=')}${'•'.repeat(12)}` : value),
      h('button', { class: 'btn sm', onclick: () => copy(value, 'Ссылка скопирована') }, 'Копировать'),
      st.running ? h('button', { class: 'btn sm', onclick: () => window.open(value, '_blank', 'noopener') }, 'Открыть') : null);
    box.append(
      h('div', { class: `result ${st.running ? 'ok' : st.error ? 'err' : ''}` },
        st.running ? ['Локальный хост обслуживает ', h('code', null, st.url), ' — открыть можно только с этого компьютера (127.0.0.1).']
          : st.error ? `Не удалось запустить локальный хост: ${st.error}` : 'Локальный хост выключен. Запустите его, чтобы открывать ссылки на этом компьютере.',
        h('div', { class: 'row-end sh-ctl' },
          h('button', { class: `btn sm${st.running ? '' : ' primary'}`, onclick: guard(async (ev) => {
            const s = await busy(ev.target, '…', () => post('/api/settings', { shareHost: !st.running }));
            render(s.share);
          }) }, st.running ? 'Остановить хост' : 'Запустить локальный хост'))),
      h('p', { class: 'muted' }, `Запечатано ${fmtSize(r.bytes)} в `, h('code', null, `${r.id}.cupsess`), '. Выберите, как получатель получит ключ:'),
      row('Ссылка + файл .cupkey', r.link),
      h('p', { class: 'faint sh-hint' }, 'Безопаснее: сама по себе ссылка ничего не открывает — получатель запрашивает файл .cupkey, который вы передаёте отдельно.'),
      r.linkWithKey ? row('Ссылка с ключом', r.linkWithKey, { mask: true }) : null,
      r.linkWithKey ? h('p', { class: 'faint sh-hint' }, 'Одна ссылка открывает сессию. Ключ находится в #fragment, который браузеры никогда не отправляют хосту — но любой, у кого есть ссылка, может прочитать все заголовки, cookie и токены в ней.') : null,
      h('p', { class: 'faint' }, 'Пока хостинг локальный; те же файлы позже заработают на любом статическом хосте (viewer.html + sealed/<id>.cupsess).'));
  };
  render(r.host);
  modal(`Поделиться ${id}`, box, [
    { label: '.cupkey', fn: async () => { download((await apiBlob(`/api/sessions/${id}/key`)).blob, `${r.id}.cupkey`); return false; } },
    { label: 'Готово', cls: 'primary' },
  ]);
}
