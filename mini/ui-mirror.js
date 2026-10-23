'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mirror — one place for everything about the `mirror` intercept rule.
//
// A mirror serves an upstream host A under a client host B: the interceptor fetches A through the
// egress worker, rewrites the body, Location and Set-Cookie back to B, and can also find/replace in
// the content. A mirror is stored as an intercept rule of type 'mirror' (params { upstreamHost,
// upstreamPort, replace[] }), but it is created and edited here, not on the Rules page.
//
// This tab has two views:
//   • "Hosts"  — create / edit / delete mirror rules (config + content replacement).
//   • "Log"    — the before/after trail of every mirrored response, with a line diff.
// ─────────────────────────────────────────────────────────────────────────────

// ── mirror-host rules (config) ───────────────────────────────────────────────
const MH = { rules: [], sel: null, ed: null, edInit: '' };

function mhDefaults() {
  return { id: null, name: '', enabled: true, url_pattern: '', upstreamHost: '', upstreamPort: 0, methods: [], priority: 0, replace: [] };
}
function mhFromRule(r) {
  if (!r) return mhDefaults();
  const p = r.params || {};
  return {
    id: r.id,
    name: r.name || '',
    enabled: r.enabled !== false,
    url_pattern: r.url_pattern || '',
    upstreamHost: p.upstreamHost || '',
    upstreamPort: Number(p.upstreamPort) || 0,
    methods: r.method && r.method !== '*' ? r.method.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [],
    priority: r.priority || 0,
    replace: Array.isArray(p.replace) ? JSON.parse(JSON.stringify(p.replace)) : [],
  };
}
function mhRow(ed) {
  return {
    ...(ed.id != null ? { id: ed.id } : {}),
    name: ed.name.trim(),
    type: 'mirror',
    url_pattern: ed.url_pattern.trim(),
    params: { upstreamHost: ed.upstreamHost.trim(), upstreamPort: Number(ed.upstreamPort) || 0, replace: ed.replace },
    method: ed.methods.length ? ed.methods.join(',') : '*',
    priority: Number(ed.priority) || 0,
    stop_on_match: true,
    breakpoint_enabled: false,
    enabled: ed.enabled,
  };
}
const mhDirty = () => MH.ed && JSON.stringify(mhRow(MH.ed)) !== MH.edInit;

// ── mirror log (before/after trail) ──────────────────────────────────────────
const MIR = { items: [], total: 0, sel: null, q: '' };

// ── load + view switch ───────────────────────────────────────────────────────
function mirViewName() {
  const on = document.querySelector('#mirView button.on');
  return on ? on.dataset.v : 'hosts';
}
function setMirView(v) {
  if (v !== 'hosts' && v !== 'log') v = 'hosts';
  document.querySelectorAll('#mirView button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $('mirHosts').hidden = v !== 'hosts';
  $('mirLog').hidden = v !== 'log';
  store.set('mir-view', v);
}

async function loadMirror() {
  setMirView(store.get('mir-view', 'hosts'));
  // mirror-host rules
  try {
    const all = await api('/api/rules');
    MH.rules = all.filter((r) => r.type === 'mirror');
  } catch { MH.rules = []; }
  if (MH.sel != null && MH.sel !== 'new' && !MH.rules.some((r) => r.id === MH.sel)) { MH.sel = null; MH.ed = null; }
  if (MH.sel != null && !MH.ed) {
    MH.ed = mhFromRule(MH.sel === 'new' ? null : MH.rules.find((r) => r.id === MH.sel));
    MH.edInit = JSON.stringify(mhRow(MH.ed));
  }
  renderMhList(); renderMhEditor();
  // audit trail
  const r = await api('/api/mirror?limit=500');
  MIR.items = r.items || [];
  MIR.total = r.total || 0;
  renderMirList();
  if (MIR.sel && !MIR.items.some((it) => it.id === MIR.sel)) MIR.sel = null;
}

// ── mirror-host list ─────────────────────────────────────────────────────────
function renderMhList() {
  const q = ($('mhQ').value || '').trim().toLowerCase();
  const list = MH.rules.filter((r) => !q || `${r.name} ${r.url_pattern} ${r.params?.upstreamHost || ''}`.toLowerCase().includes(q));
  const box = clear($('mhList'));
  if (!MH.rules.length) {
    box.append(h('div', { class: 'empty' },
      h('p', null, 'Пока нет зеркал.'),
      h('p', { class: 'muted' }, 'Зеркало отдаёт содержимое одного хоста под адресом другого и переписывает ответ (тело, Location, Set-Cookie) обратно, с опциональной заменой текста.'),
      h('button', { class: 'btn primary', onclick: () => openMh('new') }, '+ Новое зеркало')));
    return;
  }
  for (const r of list) {
    const upstream = r.params?.upstreamHost || '—';
    const reps = Array.isArray(r.params?.replace) ? r.params.replace.length : 0;
    box.append(h('div', { class: `prow${MH.sel === r.id ? ' sel' : ''}${r.enabled ? '' : ' off'}`, onclick: () => openMh(r.id) },
      h('input', { type: 'checkbox', checked: !!r.enabled, title: r.enabled ? 'Включено' : 'Выключено', onclick: (ev) => ev.stopPropagation(),
        onchange: guard(async (ev) => { await post(`/api/rules/${r.id}/enabled`, { enabled: ev.target.checked }); r.enabled = ev.target.checked; renderMhList(); }) }),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'title' }, h('b', { title: r.name }, r.name || '(без названия)'),
          r.method && r.method !== '*' ? tag(r.method) : null,
          reps ? tag(`${reps} замен${reps === 1 ? 'а' : ''}`, 'accent') : null),
        h('div', { class: 'meta' },
          h('span', { class: 'mono', title: r.url_pattern }, r.url_pattern),
          h('span', { class: 'muted' }, '←'),
          h('span', { class: 'mono', title: upstream }, upstream),
          r.last_error ? h('span', { class: 'err', title: r.last_error }, r.last_error) : null)),
      h('div', { class: 'acts muted mono', title: r.last_hit_at ? `последнее совпадение ${new Date(r.last_hit_at).toLocaleString()}` : 'ещё не срабатывало' }, `${r.hit_count || 0}`)));
  }
  if (!list.length) box.append(h('div', { class: 'empty' }, 'Ничего не найдено.'));
}

async function openMh(id) {
  if (mhDirty() && MH.sel !== id && !(await confirmBox('Отменить несохранённые изменения этого зеркала?', 'Отменить', true))) return;
  MH.sel = id;
  MH.ed = mhFromRule(id === 'new' ? null : MH.rules.find((r) => r.id === id));
  MH.edInit = JSON.stringify(mhRow(MH.ed));
  renderMhList(); renderMhEditor();
}

// Shared replace[] editor used by the mirror editor. Returns a node; mutates ed.replace in place.
function mirReplaceEditor(ed, onChange) {
  if (!Array.isArray(ed.replace)) ed.replace = [];
  const box = h('div');
  const paint = () => {
    clear(box);
    ed.replace.forEach((r, i) => {
      const isUrl = r.kind === 'url';
      const row = h('div', { class: 'sect', style: 'margin-bottom:6px' },
        h('div', { class: 'inline' },
          h('select', { onchange: (ev) => { r.kind = ev.target.value === 'url' ? 'url' : 'word'; if (r.kind === 'url') { r.regex = r.urls = r.tags = false; } paint(); onChange(); } },
            [['word', 'Найти / заменить'], ['url', 'Подменить путь']].map(([v, l]) => h('option', { value: v, selected: (r.kind || 'word') === v }, l))),
          h('input', { class: 'mono grow', value: r.from || '', placeholder: isUrl ? '/client/path' : 'найти', oninput: (ev) => { r.from = ev.target.value; onChange(); } }),
          h('span', { class: 'muted' }, '→'),
          h('input', { class: 'mono grow', value: r.to || '', placeholder: isUrl ? '/upstream/path' : 'заменить на', oninput: (ev) => { r.to = ev.target.value; onChange(); } }),
          h('button', { class: 'icon', title: 'Удалить', onclick: () => { ed.replace.splice(i, 1); paint(); onChange(); } }, '✕')),
        isUrl ? null : h('div', { class: 'inline', style: 'margin-top:4px' },
          h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!r.regex, onchange: (ev) => { r.regex = ev.target.checked; onChange(); } }), 'Регулярка ($1-группы)'),
          h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!r.urls, onchange: (ev) => { r.urls = ev.target.checked; onChange(); } }), 'В URL-атрибутах'),
          h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!r.tags, onchange: (ev) => { r.tags = ev.target.checked; onChange(); } }), 'Весь документ (вкл. теги)')));
      box.append(row);
    });
    box.append(h('button', { class: 'btn sm ghost', onclick: () => { ed.replace.push({ from: '', to: '', kind: 'word', regex: false, urls: false, tags: false }); paint(); } }, '+ Правило замены'));
  };
  paint();
  return box;
}

function renderMhEditor() {
  const box = clear($('mhEditor'));
  const ed = MH.ed;
  if (MH.sel == null || !ed) {
    box.append(h('div', { class: 'empty' },
      h('p', null, h('b', null, 'Выберите зеркало или создайте новое.')),
      h('p', { class: 'muted' }, 'Зеркало работает в MITM для каждого совпадающего запроса проксируемого Chrome: вместо хоста клиента загружается апстрим-хост, а ответ переписывается обратно.'),
      h('button', { class: 'btn primary', onclick: () => openMh('new') }, '+ Новое зеркало')));
    return;
  }
  const changed = () => { const d = $('mhDirty'); if (d) d.hidden = !mhDirty(); };

  box.append(h('div', { class: 'edit-head' },
    h('h2', { class: 'ell' }, ed.id != null ? ed.name || 'Зеркало' : 'Новое зеркало'),
    ed.id != null ? h('button', { class: 'btn sm', onclick: guard(async () => {
      const row = mhRow(ed); delete row.id; row.name = `${row.name} (копия)`;
      const { id } = await post('/api/rules', row); MH.sel = id; MH.ed = null; await loadMirror(); toast('Скопировано', 'ok');
    }) }, 'Копировать') : null,
    ed.id != null ? h('button', { class: 'btn sm danger', onclick: guard(async () => {
      if (!(await confirmBox(`Удалить зеркало «${ed.name}»?`, 'Удалить', true))) return;
      await del(`/api/rules/${ed.id}`); MH.sel = null; MH.ed = null; await loadMirror(); toast('Удалено', 'ok');
    }) }, 'Удалить') : null));

  const form = h('div', { class: 'form' });
  form.append(...field('Включено', sw(ed.enabled, '', (v) => { ed.enabled = v; changed(); })));
  form.append(...field('Название', h('input', { value: ed.name, placeholder: 'Что делает это зеркало', oninput: (ev) => { ed.name = ev.target.value; changed(); } })));
  form.append(...field('Хост клиента (URL-шаблон)', h('input', { class: 'mono', value: ed.url_pattern, spellcheck: false, placeholder: 'https://mirror.example.com/  ·  *://mirror.local/*',
    oninput: (ev) => { ed.url_pattern = ev.target.value; changed(); } }), 'Адрес, который открывает браузер. URL без * — это origin и префикс пути (query игнорируется). * — подстановка по всему URL.'));
  form.append(...field('Апстрим-хост', h('input', { class: 'mono', value: ed.upstreamHost, spellcheck: false, placeholder: 'origin.example.com',
    oninput: (ev) => { ed.upstreamHost = ev.target.value; changed(); } }), 'Реальный хост, который загружается. Его тело, Location и Set-Cookie переписываются обратно на хост клиента.'));
  form.append(...field('Порт апстрима', h('input', { type: 'number', min: 0, max: 65535, value: ed.upstreamPort || 0,
    oninput: (ev) => { ed.upstreamPort = Number(ev.target.value) || 0; changed(); } }), '0 — как у клиента (443).'));

  // methods
  const mBox = h('div', { class: 'inline' });
  const paintMethods = () => {
    append(clear(mBox), [h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !ed.methods.length, onchange: () => { ed.methods = []; paintMethods(); changed(); } }), 'Любой'),
      METHODS.map((mm) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: ed.methods.includes(mm), onchange: (ev) => {
        ed.methods = ev.target.checked ? [...ed.methods, mm] : ed.methods.filter((x) => x !== mm); paintMethods(); changed();
      } }), h('span', { class: `m m-${mm}` }, mm)))]);
  };
  paintMethods();
  form.append(...field('Методы', mBox, 'Какие запросы зеркалировать. По умолчанию — любые.'));

  form.append(...field('Замены содержимого', mirReplaceEditor(ed, changed), 'Применяются к текстовым ответам. «Найти / заменить» правит текст (с учётом границ слов); «Подменить путь» загружает один путь вместо другого.', true));

  const adv = h('details', { class: 'sect' }, h('summary', null, 'Дополнительно'),
    h('div', { class: 'form' }, ...field('Приоритет', h('input', { type: 'number', value: ed.priority, oninput: (ev) => { ed.priority = Number(ev.target.value) || 0; changed(); } }), 'Чем выше, тем раньше срабатывает среди всех правил перехвата.')));

  box.append(form, adv);
  const saveBtn = h('button', { class: 'btn primary', onclick: guard(() => busy(saveBtn, 'Сохранение…', async () => {
    const row = mhRow(ed);
    if (!row.name) throw new Error('Укажите название зеркала');
    if (!row.url_pattern) throw new Error('Укажите хост клиента (URL-шаблон)');
    if (!row.params.upstreamHost) throw new Error('Укажите апстрим-хост');
    const { id } = await post('/api/rules', row);
    MH.sel = id; MH.ed = null; await loadMirror(); toast('Зеркало сохранено', 'ok');
  })) }, 'Сохранить зеркало');
  box.append(h('div', { class: 'row-end', style: 'justify-content:flex-start' }, saveBtn, h('span', { id: 'mhDirty', class: 'muted', hidden: !mhDirty() }, 'несохранённые изменения')));
}

// ── mirror log (before/after trail) ──────────────────────────────────────────
function mirCountBadge() {
  for (const id of ['mirCount', 'mirLogCount']) {
    const b = $(id);
    if (!b) continue;
    b.hidden = !MIR.total;
    b.textContent = MIR.total > 999 ? '999+' : String(MIR.total);
  }
}

function renderMirList() {
  mirCountBadge();
  const q = MIR.q.trim().toLowerCase();
  const rows = q
    ? MIR.items.filter((it) => `${it.clientHost} ${it.upstreamHost} ${it.clientUrl} ${it.ruleName}`.toLowerCase().includes(q))
    : MIR.items;
  const box = clear($('mirRows'));
  $('mirShown').textContent = MIR.total ? `${rows.length} из ${MIR.total}` : '';
  if (!MIR.total) {
    box.append(h('div', { class: 'empty' }, 'Пока нет зеркалированных ответов. Создайте зеркало на вкладке «Зеркала хостов» и откройте его адрес.'));
    return;
  }
  if (!rows.length) {
    box.append(h('div', { class: 'empty' }, 'Ничего не найдено по фильтру.'));
    return;
  }
  for (const it of rows) {
    const status = it.status || 0;
    const kind = status >= 500 ? 'err' : status >= 400 ? 'warn' : status >= 300 ? '' : 'ok';
    const row = h('div', { class: `prow${it.id === MIR.sel ? ' sel' : ''}`, title: `${it.upstreamHost} → ${it.clientHost}` },
      h('span', { class: `dot ${kind}`, title: `HTTP ${status || '—'}` }),
      h('div', null,
        h('div', { class: 'title' }, h('b', null, `${it.method} ${it.clientUrl}`)),
        h('div', { class: 'meta' },
          h('span', null, it.clientHost),
          h('span', { class: 'muted' }, '←'),
          h('span', null, it.upstreamHost),
          it.hits ? h('span', { class: 'pill' }, `${it.hits} замен`) : null,
          h('span', { class: it.changed ? 'ok' : 'muted' }, it.changed ? 'изменено' : 'без изменений'))),
      h('div', { class: 'acts muted mono' }, fmtAgo(it.ts)));
    row.addEventListener('click', () => { MIR.sel = it.id; renderMirList(); guard(openMir)(it.id); });
    box.append(row);
  }
}

async function openMir(id) {
  const body = clear($('mirBody'));
  body.append(h('div', { class: 'empty' }, 'Загрузка…'));
  let row;
  try {
    row = await api(`/api/mirror/${id}`);
  } catch (err) {
    clear($('mirBody')).append(h('div', { class: 'note warn' }, err.message));
    return;
  }
  if (MIR.sel !== id) return; // selection moved on while loading
  const out = clear($('mirBody'));
  out.append(h('div', { class: 'mir-head' },
    h('div', { class: 'mir-route' },
      h('b', null, row.upstreamHost), h('span', { class: 'muted' }, ' отдан как '), h('b', null, row.clientHost)),
    h('div', { class: 'meta muted mono' },
      h('span', null, `${row.method} ${row.clientUrl}`),
      h('span', null, `HTTP ${row.status || '—'}`),
      row.contentType ? h('span', null, row.contentType) : null,
      h('span', null, `${row.hits || 0} замен`),
      row.ruleName ? h('span', null, `зеркало: ${row.ruleName}`) : null,
      h('span', null, new Date(row.ts).toLocaleString()))));

  if (!row.hasBodies || (row.before == null && row.after == null)) {
    out.append(h('div', { class: 'note' }, row.rewrote
      ? 'Ответ был переписан, но тела не сохранены (бинарный контент или слишком большой размер).'
      : 'Тело этого ответа не сохранено (бинарный контент или нечего переписывать).'));
    return;
  }
  const before = row.before || '';
  const after = row.after || '';
  if (before === after) {
    out.append(h('div', { class: 'note' }, 'Тело апстрима и переписанное тело совпадают — переписаны только хост/заголовки.'));
  }
  const D = window.CupNetDiff;
  const diff = D.lineDiff(before, after);
  if (diff.tooBig) {
    out.append(h('div', { class: 'note' }, 'Тела слишком различаются, чтобы показать построчный diff.'));
    return;
  }
  out.append(h('div', { class: 'muted pad' },
    h('span', { class: 'err' }, '← апстрим'), ' и ', h('span', { class: 'ok' }, 'клиент →'), '  ',
    h('span', { class: 'ok' }, `+${diff.added}`), ' ', h('span', { class: 'err' }, `−${diff.removed}`), ' строк'));
  out.append(lineDiffView(diff.ops));
}

// ── wiring ───────────────────────────────────────────────────────────────────
document.querySelectorAll('#mirView button').forEach((b) => b.addEventListener('click', () => { setMirView(b.dataset.v); if (b.dataset.v === 'hosts') renderMhList(); else renderMirList(); }));
$('mhQ')?.addEventListener('input', () => renderMhList());
$('mhNew')?.addEventListener('click', () => openMh('new'));
$('mirRefresh')?.addEventListener('click', guard(loadMirror));
$('mirQ')?.addEventListener('input', () => { MIR.q = $('mirQ').value; renderMirList(); });
$('mirClear')?.addEventListener('click', guard(async () => {
  if (!MIR.total) return;
  if (!(await confirmBox('Очистить весь журнал зеркал? Тела «до/после» будут удалены.', 'Очистить', true))) return;
  await del('/api/mirror');
  MIR.items = []; MIR.total = 0; MIR.sel = null;
  renderMirList();
  clear($('mirBody')).append(h('div', { class: 'empty' }, 'Журнал зеркал пуст.'));
  toast('Журнал зеркал очищен', 'ok');
}));
