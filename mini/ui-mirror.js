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

// Labels shared by the inline summary and the fullscreen studio.
const REP_KINDS = [['word', 'Найти / заменить'], ['url', 'Подменить путь']];
// Where a content replacement looks: whole document (tags), text nodes only, or text + URL attributes.
const REP_SCOPES = [['all', 'Везде'], ['text', 'Только текст'], ['attr', 'Текст + атрибуты']];
const mirRepPlural = (n) => { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return 'замен'; if (b > 1 && b < 5) return 'замены'; if (b === 1) return 'замена'; return 'замен'; };
const repKindLabel = (r) => (r.kind === 'url' ? 'путь' : 'текст');
// Scope is stored as two independent engine flags; map them to one of the three REP_SCOPES choices.
const repScope = (r) => (r.tags ? 'all' : r.urls ? 'attr' : 'text');
const setRepScope = (r, v) => { r.tags = v === 'all'; r.urls = v === 'attr'; };
// Defaults match the old web tool: substring match over the whole document, case-insensitive.
const newReplaceRule = () => ({ from: '', to: '', kind: 'word', regex: false, urls: false, tags: true, whole: false, cs: false });

// Quick-insert fragments for the regex helper. Label is Russian; the snippet itself is a pattern.
const REGEX_SNIPPETS = [
  ['\\d+', 'цифры'],
  ['\\w+', 'слово'],
  ['\\s+', 'пробелы'],
  ['.*?', 'любой текст'],
  ['[A-Za-zА-Яа-я]+', 'буквы'],
  ['(…)', 'группа → $1'],
  ['a|b', 'или'],
  ['^', 'начало'],
  ['$', 'конец'],
  ['https?:\\/\\/[^"\'\\s]+', 'ссылка'],
  ['[\\w.+-]+@[\\w.-]+', 'e-mail'],
];

// A small sample so a new mirror's replacements can be tried before any traffic exists. Users paste a
// real page's source over it. Shows text (word), attribute (urls) and whole-document (tags) behaviour.
const MIR_SAMPLE_DEFAULT = `<h1>Пример страницы</h1>
<p>Здравствуйте! Это демонстрация замен. Откройте настоящую страницу через зеркало,
скопируйте её исходный код и вставьте сюда — результат слева обновляется на лету.</p>
<a href="https://origin.example.com/account">Личный кабинет</a>
<img src="/img/logo.png" alt="Логотип">`;

// Compact inline summary of a mirror's replace[] rules + a button into the fullscreen studio. The
// studio is where rules are actually edited (with a live unified red/green diff). Mutates ed.replace.
function mirReplaceEditor(ed, onChange) {
  if (!Array.isArray(ed.replace)) ed.replace = [];
  const box = h('div', { class: 'mir-rep' });
  const paint = () => {
    clear(box);
    const n = ed.replace.length;
    const chips = h('div', { class: 'mir-rep-chips' });
    if (!n) {
      chips.append(h('span', { class: 'muted' }, 'Замен пока нет. Откройте редактор, чтобы искать и заменять текст в ответе с живым предпросмотром.'));
    } else {
      ed.replace.forEach((r) => chips.append(h('span', { class: 'mir-rep-chip', title: `${r.from || '—'} → ${r.to || '—'}` },
        h('span', { class: 'mir-rep-badge' }, repKindLabel(r)),
        h('span', { class: 'mono ell' }, r.from || '—'),
        h('span', { class: 'muted' }, '→'),
        h('span', { class: 'mono ell' }, r.to || '—'))));
    }
    box.append(chips, h('div', { class: 'inline', style: 'margin-top:8px' },
      h('button', { class: 'btn sm primary', onclick: () => openReplaceStudio(ed, () => { onChange(); paint(); }) },
        n ? `Редактор замен (${n}) — полный экран` : '+ Открыть редактор замен')));
  };
  paint();
  return box;
}

// ── fullscreen replace studio: rules on the left, source + a single red/green diff on the right ──
const RSX = { sample: null, url: null };

// Regex helper: inserts a snippet at the caret of the rule's «найти» input and turns regex mode on.
function openRegexHelper(input, enableRegex) {
  const insert = (snip) => {
    const s = input.selectionStart == null ? input.value.length : input.selectionStart;
    const e = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, s) + snip + input.value.slice(e);
    if (enableRegex) enableRegex();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    const pos = s + snip.length;
    try { input.setSelectionRange(pos, pos); } catch { /* ignore */ }
  };
  const grid = h('div', { class: 'rsx-rx-grid' },
    REGEX_SNIPPETS.map(([snip, label]) => h('button', { class: 'btn sm', type: 'button', onclick: () => insert(snip) },
      h('code', null, snip), h('span', { class: 'muted' }, label))));
  const body = h('div', { class: 'form' },
    h('p', { class: 'muted' }, 'Нажмите фрагмент — он вставится в поле «найти» и включит режим регулярного выражения. В поле «заменить на» используйте $1, $2 для групп и $& для всего совпадения.'),
    grid);
  modal('Помощник по регулярным выражениям', body, [{ label: 'Закрыть', cls: 'primary' }]);
}

// Build the preview by asking the server to run the real rewrite engine, then render one unified diff.
function openReplaceStudio(ed, onChange) {
  if (!Array.isArray(ed.replace)) ed.replace = [];
  if (RSX.sample == null) RSX.sample = store.get('mir-sample', MIR_SAMPLE_DEFAULT);
  if (RSX.url == null) RSX.url = store.get('mir-url', ed.upstreamHost ? `https://${ed.upstreamHost}/` : '');

  let preview = { output: '', hits: 0, perRule: [], changed: false };
  let view = store.get('mir-studio-view', 'diff'); // 'diff' | 'out'
  let findQ = '';
  let findEls = [];
  let findCur = 0;
  let srcOpen = true;

  const rulesBox = h('div', { class: 'rsx-rules' });
  const src = h('textarea', { class: 'rsx-src mono', spellcheck: false, placeholder: 'Вставьте сюда исходный код страницы или загрузите его по ссылке выше…' });
  src.value = RSX.sample;
  const urlInput = h('input', { class: 'rsx-url mono', type: 'url', placeholder: 'https://origin.example.com/ — загрузить исходный код', value: RSX.url });
  const fetchStatus = h('span', { class: 'muted mono rsx-fetch-st' }, '');
  const outPane = h('div', { class: 'rsx-out mono' });
  const hitsLabel = h('span', { class: 'mono muted' }, '');
  const findInput = h('input', { class: 'rsx-find-in mono', type: 'search', placeholder: 'Поиск в результате…', value: findQ });
  const findCount = h('span', { class: 'muted mono rsx-find-n' }, '');
  const selBtn = h('button', { class: 'btn sm', disabled: true, title: 'Создать правило из выделенного исходника' }, '+ Из выделения');

  // ── unified diff rendering (red = removed, green = added), with in-result search ──
  const buildOps = () => {
    const D = window.CupNetDiff;
    const a = src.value;
    const b = preview.output != null ? preview.output : '';
    if (view === 'out') return { ops: [{ t: '=', text: b }], line: false };
    const td = D && D.tokenDiff ? D.tokenDiff(a, b) : null;
    if (td && !td.tooBig) return { ops: td.ops, line: false };
    const ld = D.lineDiff(a, b);
    return { ops: ld.ops, line: true };
  };
  const clsFor = (t) => (t === '-' ? 'rsx-del' : t === '+' ? 'rsx-ins' : null);
  const appendText = (frag, text, cls) => {
    const q = findQ.trim();
    const make = (t) => (cls ? h('span', { class: cls }, t) : document.createTextNode(t));
    if (!q) { if (text) frag.append(make(text)); return; }
    const ql = q.toLowerCase();
    const lower = text.toLowerCase();
    let i = 0;
    let idx;
    while ((idx = lower.indexOf(ql, i)) >= 0) {
      if (idx > i) frag.append(make(text.slice(i, idx)));
      const mk = h('mark', { class: `rsx-find${cls ? ` ${cls}` : ''}` }, text.slice(idx, idx + q.length));
      findEls.push(mk);
      frag.append(mk);
      i = idx + q.length;
    }
    if (i < text.length) frag.append(make(text.slice(i)));
  };
  const paintOut = () => {
    clear(outPane);
    findEls = [];
    const built = buildOps();
    if (built.line) {
      // Huge document: fall back to a read-only line diff (no in-result search there).
      outPane.append(lineDiffView(built.ops));
    } else {
      const frag = document.createDocumentFragment();
      let any = false;
      for (const op of built.ops) {
        if (!op.text) continue;
        any = true;
        appendText(frag, op.text, clsFor(op.t));
      }
      if (!any) frag.append(h('span', { class: 'muted' }, '(пусто)'));
      outPane.append(frag);
    }
    if (findCur >= findEls.length) findCur = 0;
    paintFindCursor();
    const n = preview.hits;
    hitsLabel.textContent = n ? `${n} ${mirRepPlural(n)}` : (preview.changed ? 'изменено' : 'без изменений');
    hitsLabel.className = `mono ${n || preview.changed ? 'ok' : 'muted'}`;
  };
  const paintFindCursor = () => {
    findEls.forEach((el, i) => el.classList.toggle('cur', i === findCur));
    findCount.textContent = findEls.length ? `${findCur + 1}/${findEls.length}` : (findQ.trim() ? '0' : '');
    if (findEls[findCur]) findEls[findCur].scrollIntoView({ block: 'center' });
  };
  const stepFind = (d) => { if (!findEls.length) return; findCur = (findCur + d + findEls.length) % findEls.length; paintFindCursor(); };

  const recompute = () => debounce('rsx-preview', 160, async () => {
    RSX.sample = src.value;
    store.set('mir-sample', src.value);
    try {
      preview = await post('/api/mirror/preview', { source: src.value, replace: ed.replace });
    } catch (e) {
      preview = { output: src.value, hits: 0, perRule: [], changed: false };
    }
    paintOut();
    paintRuleHits();
    onChange();
  });

  // ── view toggle (Diff / Результат) ──
  const viewBtns = h('div', { class: 'rsx-view' });
  const paintViewBtns = () => {
    clear(viewBtns);
    [['diff', 'Diff'], ['out', 'Результат']].forEach(([v, l]) =>
      viewBtns.append(h('button', { class: `btn sm rsx-vbtn${view === v ? ' on' : ''}`, onclick: () => { view = v; store.set('mir-studio-view', v); paintViewBtns(); paintOut(); } }, l)));
  };

  // ── source URL load + "open in Chrome" ──
  const loadUrl = guard(async () => {
    const url = (urlInput.value || '').trim();
    if (!url) { toast('Укажите ссылку', 'warn'); return; }
    fetchStatus.textContent = 'Загрузка…';
    fetchStatus.className = 'muted mono rsx-fetch-st';
    const r = await post('/api/mirror/fetch', { url });
    if (!r || r.error) {
      fetchStatus.textContent = (r && r.error) || 'ошибка';
      fetchStatus.className = 'err mono rsx-fetch-st';
      return;
    }
    src.value = r.body || '';
    RSX.sample = src.value;
    RSX.url = url;
    store.set('mir-sample', src.value);
    store.set('mir-url', url);
    const ok = r.statusCode >= 200 && r.statusCode < 400;
    fetchStatus.textContent = `HTTP ${r.statusCode} · ${(r.body || '').length} симв.`;
    fetchStatus.className = `${ok ? 'ok' : 'warn'} mono rsx-fetch-st`;
    if (!srcOpen) toggleSrc();
    recompute();
  });
  const chromeUrl = () => {
    const up = (urlInput.value || '').trim();
    const pat = (ed.url_pattern || '').trim();
    if (/^https?:\/\//i.test(pat)) return pat;
    if (pat && !/[*?]/.test(pat)) return `https://${pat.replace(/^\/+/, '')}`;
    if (/^https?:\/\//i.test(up)) return up;
    if (ed.upstreamHost) return `https://${ed.upstreamHost}/`;
    return '';
  };
  const openChrome = guard(async () => {
    const url = chromeUrl();
    if (!url) { toast('Нет адреса — укажите хост клиента (url_pattern) или ссылку', 'warn'); return; }
    await post('/api/chrome', { url });
    toast(`Открываю в Chrome: ${url}`, 'ok');
  });

  // ── rule rows (drag to reorder via the grip) ──
  let ruleEls = [];
  let dragFrom = -1;
  const paintRuleHits = () => ruleEls.forEach((el, i) => {
    const n = preview.perRule[i] || 0;
    el.textContent = n ? `${n} ${mirRepPlural(n)}` : '';
    el.className = `rsx-hit mono ${n ? 'ok' : 'muted'}`;
  });
  const paintRules = () => {
    clear(rulesBox);
    ruleEls = [];
    if (!ed.replace.length) rulesBox.append(h('div', { class: 'muted', style: 'padding:4px 2px 10px' }, 'Нет правил. Добавьте первое кнопкой «+ Правило» или выделите текст в исходнике.'));
    ed.replace.forEach((r, i) => {
      const isUrl = r.kind === 'url';
      const hit = h('span', { class: 'rsx-hit mono muted' }, '');
      ruleEls.push(hit);
      const grip = h('span', { class: 'rsx-grip', draggable: true, title: 'Перетащите, чтобы изменить порядок' }, '⋮⋮');
      grip.addEventListener('dragstart', (ev) => { dragFrom = i; ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', String(i)); } catch { /* ignore */ } });
      const fromIn = h('input', { class: 'mono', value: r.from || '', placeholder: isUrl ? '/client/path' : 'найти', oninput: (ev) => { r.from = ev.target.value; recompute(); } });
      const row = h('div', { class: 'rsx-rule' },
        h('div', { class: 'rsx-rule-top' },
          grip,
          h('select', { class: 'rsx-kind', onchange: (ev) => { r.kind = ev.target.value === 'url' ? 'url' : 'word'; if (r.kind === 'url') { r.regex = r.urls = r.tags = r.whole = r.cs = false; } paintRules(); recompute(); } },
            REP_KINDS.map(([v, l]) => h('option', { value: v, selected: (r.kind || 'word') === v }, l))),
          hit,
          h('button', { class: 'icon', title: 'Удалить правило', onclick: () => { ed.replace.splice(i, 1); paintRules(); recompute(); } }, '✕')),
        h('div', { class: 'rsx-rule-io' },
          fromIn,
          h('span', { class: 'muted' }, '→'),
          h('input', { class: 'mono', value: r.to || '', placeholder: isUrl ? '/upstream/path' : 'заменить на', oninput: (ev) => { r.to = ev.target.value; recompute(); } })),
        isUrl
          ? h('div', { class: 'rsx-rule-note muted' }, 'Подменяет путь запроса, а не текст ответа — в предпросмотре не участвует.')
          : h('div', { class: 'rsx-opts' },
            h('label', { class: 'rsx-opt' }, h('span', { class: 'muted' }, 'Где:'),
              h('select', { class: 'rsx-scope', onchange: (ev) => { setRepScope(r, ev.target.value); recompute(); } },
                REP_SCOPES.map(([v, l]) => h('option', { value: v, selected: repScope(r) === v }, l)))),
            h('label', { class: 'chk', title: 'Трактовать «найти» как регулярное выражение' },
              h('input', { type: 'checkbox', checked: !!r.regex, onchange: (ev) => { r.regex = ev.target.checked; paintRules(); recompute(); } }), 'Регулярка'),
            h('button', { class: 'icon rsx-rx-help', type: 'button', title: 'Помощник по регулярным выражениям', onclick: () => openRegexHelper(fromIn, () => { r.regex = true; }) }, '?'),
            h('label', { class: `chk${r.regex ? ' off' : ''}`, title: 'Совпадать только по целым словам' },
              h('input', { type: 'checkbox', checked: !!r.whole, disabled: !!r.regex, onchange: (ev) => { r.whole = ev.target.checked; recompute(); } }), 'Целые слова'),
            h('label', { class: 'chk', title: 'Учитывать регистр букв' },
              h('input', { type: 'checkbox', checked: !!r.cs, onchange: (ev) => { r.cs = ev.target.checked; recompute(); } }), 'Регистр')));
      row.addEventListener('dragover', (ev) => { if (dragFrom >= 0) { ev.preventDefault(); row.classList.add('drop'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        row.classList.remove('drop');
        if (dragFrom < 0 || dragFrom === i) return;
        const [moved] = ed.replace.splice(dragFrom, 1);
        ed.replace.splice(i, 0, moved);
        dragFrom = -1;
        paintRules();
        recompute();
      });
      rulesBox.append(row);
    });
    paintRuleHits();
  };

  const addRule = (from = '', to = '') => { ed.replace.push({ ...newReplaceRule(), from, to }); paintRules(); recompute(); };

  // enable "+ Из выделения" only when the source textarea has a selection
  const refreshSel = () => { selBtn.disabled = src.selectionStart === src.selectionEnd; };
  src.addEventListener('select', refreshSel);
  src.addEventListener('keyup', refreshSel);
  src.addEventListener('mouseup', refreshSel);
  src.addEventListener('input', () => { recompute(); refreshSel(); });
  selBtn.addEventListener('click', () => {
    const sel = src.value.slice(src.selectionStart, src.selectionEnd);
    if (sel) addRule(sel, sel);
  });

  findInput.addEventListener('input', () => { findQ = findInput.value; findCur = 0; paintOut(); });
  findInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); } });
  urlInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); loadUrl(); } });

  // collapsible source editor
  const srcWrap = h('div', { class: 'rsx-src-wrap' }, src);
  const srcToggle = h('button', { class: 'btn sm', onclick: () => toggleSrc() }, 'Скрыть исходник');
  function toggleSrc() {
    srcOpen = !srcOpen;
    srcWrap.hidden = !srcOpen;
    srcToggle.textContent = srcOpen ? 'Скрыть исходник' : 'Показать исходник';
  }

  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); onChange(); };
  const onKey = (ev) => { if (ev.key === 'Escape' && document.activeElement !== findInput && document.activeElement !== src && document.activeElement !== urlInput) { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);

  const overlay = h('div', { class: 'rsx' },
    h('div', { class: 'rsx-head' },
      h('div', { class: 'rsx-title' }, h('b', null, 'Редактор замен'), h('span', { class: 'muted ell' }, ed.name ? ` · ${ed.name}` : '')),
      h('div', { class: 'rsx-tools' },
        h('button', { class: 'btn sm primary', onclick: () => addRule() }, '+ Правило'),
        selBtn,
        h('span', { class: 'rsx-search' },
          findInput,
          h('button', { class: 'icon', title: 'Назад (Shift+Enter)', onclick: () => stepFind(-1) }, '↑'),
          h('button', { class: 'icon', title: 'Вперёд (Enter)', onclick: () => stepFind(1) }, '↓'),
          findCount),
        h('button', { class: 'btn sm', onclick: close }, 'Готово')),
    ),
    h('div', { class: 'rsx-body' },
      h('div', { class: 'rsx-col rsx-left' }, rulesBox),
      h('div', { class: 'rsx-main' },
        h('div', { class: 'rsx-srcbar' },
          urlInput,
          h('button', { class: 'btn sm', onclick: loadUrl }, 'Загрузить'),
          fetchStatus,
          h('span', { class: 'grow' }),
          srcToggle,
          h('button', { class: 'btn sm', title: 'Открыть зеркало в проксируемом Chrome со всеми стилями', onclick: openChrome }, 'Открыть в Chrome')),
        srcWrap,
        h('div', { class: 'rsx-result-head' },
          h('span', null, 'Результат'),
          h('span', { class: 'muted' }, '— красным удалённое, зелёным добавленное'),
          h('span', { class: 'grow' }),
          hitsLabel,
          viewBtns),
        outPane)));

  document.body.append(overlay);
  paintViewBtns();
  paintRules();
  recompute();
  setTimeout(() => src.focus(), 0);
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
  form.append(...field('Хост клиента (URL-шаблон)', h('input', { class: 'mono', value: ed.url_pattern, spellcheck: false, placeholder: 'example.com  ·  https://mirror.example.com/  ·  *://mirror.local/*',
    oninput: (ev) => { ed.url_pattern = ev.target.value; changed(); } }), 'Адрес, который открывает браузер. Можно просто хост (example.com) — совпадёт с любой схемой и путём. URL без * — origin и префикс пути (query игнорируется). * — подстановка по всему URL.'));
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

  form.append(...field('Замены содержимого', mirReplaceEditor(ed, changed), 'Применяются к текстовым ответам. В редакторе (полный экран) можно загрузить исходник по ссылке и увидеть единый diff: красным — удалённое, зелёным — добавленное. «Найти / заменить» по умолчанию ищет подстроку по всему документу без учёта регистра (можно включить целые слова, регистр, регулярку); «Подменить путь» загружает один путь вместо другого.', true));

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
