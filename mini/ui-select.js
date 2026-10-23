'use strict';
/**
 * CupNet mini — searchable select.
 *
 * Every native <select> in the document is upgraded in place: the select stays in the DOM (hidden) and keeps
 * being the source of truth, so the rest of the UI keeps using `sel.value = …`, `sel.options`, `onchange` and
 * `clear(sel).append(option…)` unchanged. A button after it shows the current option; clicking it opens one
 * shared popup with a search box, option groups and keyboard navigation. Picking an option sets the select's
 * value and fires the usual `input` + `change` events on the select.
 */
(() => {
  const RENDER_MAX = 1500;   // options rendered per popup; the search box narrows longer lists
  const MIN_W_CAP = 220;     // the button reserves room for its longest option, but never more than this

  const ST = new WeakMap();  // select → { btn, label, mo }
  let open = null;           // { sel, items, active } while the popup is shown
  let measureCtx = null;

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  // Programmatic value changes don't fire events, so the setters are wrapped to repaint the button.
  const wrap = (proto, prop, after) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d?.set) return;
    Object.defineProperty(proto, prop, { ...d, set(v) { d.set.call(this, v); after(this); } });
  };
  const resync = (sel) => { if (sel && ST.has(sel)) schedule(sel); };
  wrap(HTMLSelectElement.prototype, 'value', resync);
  wrap(HTMLSelectElement.prototype, 'selectedIndex', resync);
  wrap(HTMLSelectElement.prototype, 'disabled', resync);
  wrap(HTMLOptionElement.prototype, 'selected', (o) => resync(o.parentElement?.closest?.('select')));

  const pending = new Set();
  function schedule(sel) {
    if (!pending.size) queueMicrotask(() => { for (const s of pending) sync(s); pending.clear(); });
    pending.add(sel);
  }

  function enhance(sel) {
    if (ST.has(sel) || sel.multiple || sel.size > 1 || sel.dataset.native != null) return;
    const btn = el('button', 'cs');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const label = el('span', 'cs-v');
    btn.append(label);
    const st = { btn, label, mo: new MutationObserver(() => schedule(sel)) };
    ST.set(sel, st);
    st.mo.observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'title', 'disabled', 'hidden', 'label', 'selected', 'style'] });
    sel.classList.add('cs-native');
    sel.tabIndex = -1;
    sel.after(btn);
    btn.addEventListener('click', () => (open?.sel === sel ? close(true) : show(sel)));
    btn.addEventListener('keydown', (ev) => onButtonKey(ev, sel));
    sel.focus = (o) => btn.focus(o);
    for (const l of sel.labels || []) l.addEventListener('click', (ev) => { ev.preventDefault(); btn.focus(); });
    sync(sel);
  }

  function sync(sel) {
    const st = ST.get(sel);
    if (!st) return;
    const { btn, label } = st;
    if (!sel.isConnected) { if (btn.isConnected) btn.remove(); if (open?.sel === sel) close(false); return; }
    if (btn.previousElementSibling !== sel) sel.after(btn);
    const o = sel.options[sel.selectedIndex];
    label.textContent = o ? o.label || o.text : '';
    btn.className = ['cs', ...[...sel.classList].filter((c) => c !== 'cs-native'), !sel.value ? 'cs-empty' : '', open?.sel === sel ? 'open' : ''].filter(Boolean).join(' ');
    btn.disabled = sel.disabled;
    btn.hidden = sel.hidden;
    btn.title = sel.title || (o ? o.text : '');
    if (sel.style.cssText) btn.style.cssText = sel.style.cssText;
    btn.style.minWidth = '';
    const cs = getComputedStyle(btn), cssMin = parseFloat(cs.minWidth) || 0, cssMax = parseFloat(cs.maxWidth) || Infinity;
    btn.style.minWidth = `${Math.min(cssMax, Math.max(cssMin, minWidth(sel, cs)))}px`;
    if (open?.sel === sel) { render(); place(); }
  }

  function minWidth(sel, cs) {
    let longest = '';
    for (const o of sel.options) if ((o.label || o.text).length > longest.length) longest = o.label || o.text;
    if (!longest) return 0;
    measureCtx ||= document.createElement('canvas').getContext('2d');
    measureCtx.font = cs.font || '12px sans-serif';
    return Math.min(MIN_W_CAP, Math.ceil(measureCtx.measureText(longest).width) + 36);
  }

  // ── popup ──────────────────────────────────────────────────────────────────────────────────────────────────
  const pop = el('div', 'cs-pop');
  pop.hidden = true;
  const q = el('input', 'cs-q');
  q.type = 'search'; q.placeholder = 'Поиск…'; q.spellcheck = false; q.autocomplete = 'off';
  q.setAttribute('aria-label', 'Поиск по вариантам');
  const list = el('div', 'cs-list');
  list.setAttribute('role', 'listbox');
  const foot = el('div', 'cs-foot');
  pop.append(q, list, foot);
  list.tabIndex = -1;

  function show(sel, query = '') {
    if (sel.disabled) return;
    if (open) close(false);
    open = { sel, items: [], active: -1 };
    if (!pop.isConnected) document.body.append(pop);
    q.value = query;
    pop.hidden = false;
    ST.get(sel).btn.setAttribute('aria-expanded', 'true');
    ST.get(sel).btn.classList.add('open');
    render(true);
    place();
    q.focus({ preventScroll: true });
  }

  function close(refocus) {
    if (!open) return;
    const st = ST.get(open.sel);
    open = null;
    pop.hidden = true;
    clearNode(list);
    if (st) {
      st.btn.setAttribute('aria-expanded', 'false');
      st.btn.classList.remove('open');
      if (refocus) st.btn.focus({ preventScroll: true });
    }
  }

  const clearNode = (n) => { n.textContent = ''; return n; };
  const norm = (s) => String(s || '').toLowerCase();

  function render(scrollToSelected) {
    const { sel } = open;
    const needle = norm(q.value.trim());
    clearNode(list);
    open.items = [];
    let shown = 0, total = 0, lastGroup = null, activeIdx = -1;
    for (const o of sel.options) {
      total++;
      const group = o.parentElement?.tagName === 'OPTGROUP' ? o.parentElement : null;
      const text = o.label || o.text;
      if (needle && !norm(text).includes(needle) && !norm(o.value).includes(needle) && !norm(group?.label).includes(needle)) continue;
      if (shown >= RENDER_MAX) { shown++; continue; }
      if (group !== lastGroup) {
        lastGroup = group;
        if (group) list.append(el('div', 'cs-grp', group.label));
      }
      const row = el('div', 'cs-opt');
      row.setAttribute('role', 'option');
      if (o.disabled || group?.disabled) { row.classList.add('dis'); row.setAttribute('aria-disabled', 'true'); }
      if (o.index === sel.selectedIndex) { row.classList.add('sel'); row.setAttribute('aria-selected', 'true'); }
      paintMatch(row, text, needle);
      if (o.value && o.value !== text && needle && !norm(text).includes(needle) && norm(o.value).includes(needle)) row.append(el('span', 'cs-val', o.value));
      const i = open.items.length;
      open.items.push({ row, opt: o });
      row.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(i); });
      row.addEventListener('mousemove', () => { if (pointerMoved && open.active !== i) setActive(i, false); });
      if (o.index === sel.selectedIndex) activeIdx = i;
      list.append(row);
      shown++;
    }
    if (!open.items.length) list.append(el('div', 'cs-none', needle ? 'Ничего не найдено' : 'Нет вариантов'));
    foot.textContent = shown > RENDER_MAX ? `показано ${RENDER_MAX} из ${shown} — уточните ввод` : needle ? `${Math.min(shown, RENDER_MAX)} из ${total}` : '';
    foot.hidden = !foot.textContent;
    if (needle || activeIdx < 0 || open.items[activeIdx].row.classList.contains('dis')) activeIdx = nextEnabled(-1, 1);
    setActive(activeIdx, scrollToSelected ? 'center' : true);
  }

  function paintMatch(row, text, needle) {
    const at = needle ? norm(text).indexOf(needle) : -1;
    const t = el('span', 'cs-t');
    if (at < 0) t.textContent = text;
    else t.append(text.slice(0, at), el('mark', null, text.slice(at, at + needle.length)), text.slice(at + needle.length));
    row.append(t);
  }

  // Chrome fires mousemove when rows scroll under a still pointer; only real pointer moves change the highlight.
  let lastXY = '', pointerMoved = false;
  document.addEventListener('mousemove', (ev) => { const xy = `${ev.screenX},${ev.screenY}`; pointerMoved = xy !== lastXY; lastXY = xy; }, true);

  function nextEnabled(from, dir) {
    const n = open.items.length;
    for (let i = from + dir; i >= 0 && i < n; i += dir) if (!open.items[i].row.classList.contains('dis')) return i;
    return from >= 0 && from < n ? from : -1;
  }

  function setActive(i, scroll) {
    if (!open) return;
    open.items[open.active]?.row.classList.remove('act');
    open.active = i;
    const it = open.items[i];
    if (!it) return;
    it.row.classList.add('act');
    if (scroll) it.row.scrollIntoView({ block: scroll === 'center' ? 'center' : 'nearest' });
  }

  function pick(i) {
    const it = open?.items[i];
    if (!it || it.row.classList.contains('dis')) return;
    const sel = open.sel;
    const changed = sel.selectedIndex !== it.opt.index;
    close(true);
    if (!changed) return;
    sel.selectedIndex = it.opt.index;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function place() {
    if (!open) return;
    const r = ST.get(open.sel).btn.getBoundingClientRect();
    if (!r.width && !r.height) return close(false);
    const vw = innerWidth, vh = innerHeight, gap = 4;
    const w = Math.min(Math.max(r.width, 200), 480, vw - 16);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
    const below = vh - r.bottom - gap - 8, above = r.top - gap - 8;
    const up = below < 220 && above > below;
    pop.style.maxHeight = `${Math.max(120, Math.min(360, up ? above : below))}px`;
    pop.style.top = up ? '' : `${r.bottom + gap}px`;
    pop.style.bottom = up ? `${vh - r.top + gap}px` : '';
    pop.classList.toggle('up', up);
  }

  // ── keyboard ───────────────────────────────────────────────────────────────────────────────────────────────
  function onButtonKey(ev, sel) {
    if (ev.metaKey || ev.ctrlKey) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'F4'].includes(ev.key)) { ev.preventDefault(); show(sel); return; }
    if (ev.key.length === 1 && !ev.altKey) { ev.preventDefault(); show(sel, ev.key); }
  }

  function onPopKey(ev) {
    if (!open) return;
    const n = open.items.length;
    const move = (i) => { ev.preventDefault(); setActive(Math.max(0, Math.min(n - 1, i)), true); };
    switch (ev.key) {
      case 'ArrowDown': return move(nextEnabled(open.active, 1));
      case 'ArrowUp': return move(nextEnabled(open.active, -1));
      case 'PageDown': return move(open.active + 10);
      case 'PageUp': return move(open.active - 10);
      case 'Enter': ev.preventDefault(); return pick(open.active);
      case 'Escape': ev.preventDefault(); ev.stopPropagation(); return close(true);
      case 'Tab': return close(true);
      case 'Home': case 'End':
        if (ev.target !== q || !q.value) move(ev.key === 'Home' ? nextEnabled(-1, 1) : nextEnabled(n, -1));
    }
  }

  q.addEventListener('input', () => open && render(false));
  pop.addEventListener('keydown', onPopKey);
  document.addEventListener('mousedown', (ev) => {
    if (!open || pop.contains(ev.target) || ST.get(open.sel)?.btn.contains(ev.target)) return;
    close(false);
  }, true);
  document.addEventListener('focusin', (ev) => {
    if (open && !pop.contains(ev.target) && !ST.get(open.sel)?.btn.contains(ev.target)) close(false);
  });
  addEventListener('resize', place);
  document.addEventListener('scroll', (ev) => { if (open && !pop.contains(ev.target)) place(); }, true);
  addEventListener('blur', () => close(false));

  // ── discovery ──────────────────────────────────────────────────────────────────────────────────────────────
  const scan = (root) => {
    if (root.nodeType !== 1) return;
    if (root.tagName === 'SELECT') { ST.has(root) ? schedule(root) : enhance(root); return; }
    for (const s of root.getElementsByTagName('select')) ST.has(s) ? schedule(s) : enhance(s);
  };
  const dropped = (root) => {
    if (root.nodeType !== 1) return;
    if (root.tagName === 'SELECT') { if (ST.has(root)) schedule(root); return; }
    for (const s of root.getElementsByTagName('select')) if (ST.has(s)) schedule(s);
  };
  new MutationObserver((recs) => {
    for (const r of recs) { r.addedNodes.forEach(scan); r.removedNodes.forEach(dropped); }
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan(document.documentElement);

  /** Re-render a select's button after code changed it in a way the observers can't see. */
  window.csRefresh = (sel) => schedule(sel);
})();
