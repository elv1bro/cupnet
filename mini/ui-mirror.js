'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mirror — before/after trail for the `mirror` intercept rule.
//
// A "Mirror host" rule (type: 'mirror', set up in Rules) serves an upstream host A under the
// matched client host B: the interceptor fetches A through the egress worker, rewrites the body,
// Location and Set-Cookie back to B, and hands us the raw and rewritten bodies. The server keeps a
// bounded trail at GET /api/mirror (list) and GET /api/mirror/<id> (one row + before/after bodies).
// This page lists the captures and shows the diff, reusing the Compare page's line-diff renderer.
// ─────────────────────────────────────────────────────────────────────────────

const MIR = { items: [], total: 0, sel: null, q: '' };

async function loadMirror() {
  const r = await api('/api/mirror?limit=500');
  MIR.items = r.items || [];
  MIR.total = r.total || 0;
  renderMirList();
  if (MIR.sel && !MIR.items.some((it) => it.id === MIR.sel)) MIR.sel = null;
}

function mirCountBadge() {
  const b = $('mirCount');
  if (!b) return;
  b.hidden = !MIR.total;
  b.textContent = MIR.total > 999 ? '999+' : String(MIR.total);
}

function renderMirList() {
  mirCountBadge();
  const q = MIR.q.trim().toLowerCase();
  const rows = q
    ? MIR.items.filter((it) => `${it.clientHost} ${it.upstreamHost} ${it.clientUrl} ${it.ruleName}`.toLowerCase().includes(q))
    : MIR.items;
  const box = clear($('mirRows'));
  $('mirShown').textContent = MIR.total ? `${rows.length} of ${MIR.total}` : '';
  if (!MIR.total) {
    box.append(h('div', { class: 'empty' }, 'No mirrored responses yet. Add a Mirror host rule in Rules, then load the mirrored host.'));
    return;
  }
  if (!rows.length) {
    box.append(h('div', { class: 'empty' }, 'Nothing matches the filter.'));
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
          it.hits ? h('span', { class: 'pill' }, `${it.hits} repl`) : null,
          h('span', { class: it.changed ? 'ok' : 'muted' }, it.changed ? 'changed' : 'no change'))),
      h('div', { class: 'acts muted mono' }, fmtAgo(it.ts)));
    row.addEventListener('click', () => { MIR.sel = it.id; renderMirList(); guard(openMir)(it.id); });
    box.append(row);
  }
}

async function openMir(id) {
  const body = clear($('mirBody'));
  body.append(h('div', { class: 'empty' }, 'Loading…'));
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
      h('b', null, row.upstreamHost), h('span', { class: 'muted' }, ' served as '), h('b', null, row.clientHost)),
    h('div', { class: 'meta muted mono' },
      h('span', null, `${row.method} ${row.clientUrl}`),
      h('span', null, `HTTP ${row.status || '—'}`),
      row.contentType ? h('span', null, row.contentType) : null,
      h('span', null, `${row.hits || 0} replacement${row.hits === 1 ? '' : 's'}`),
      row.ruleName ? h('span', null, `rule: ${row.ruleName}`) : null,
      h('span', null, new Date(row.ts).toLocaleString()))));

  if (!row.hasBodies || (row.before == null && row.after == null)) {
    out.append(h('div', { class: 'note' }, row.rewrote
      ? 'The response was rewritten, but the bodies were not stored (binary content, or too large to keep).'
      : 'No body was stored for this response (binary content, or nothing to rewrite).'));
    return;
  }
  const before = row.before || '';
  const after = row.after || '';
  if (before === after) {
    out.append(h('div', { class: 'note' }, 'The upstream body and the rewritten body are identical — host/header rewriting only.'));
  }
  const D = window.CupNetDiff;
  const diff = D.lineDiff(before, after);
  if (diff.tooBig) {
    out.append(h('div', { class: 'note' }, 'The two bodies are too different to diff line by line.'));
    return;
  }
  out.append(h('div', { class: 'muted pad' },
    h('span', { class: 'err' }, '← upstream'), ' vs ', h('span', { class: 'ok' }, 'client →'), '  ',
    h('span', { class: 'ok' }, `+${diff.added}`), ' ', h('span', { class: 'err' }, `−${diff.removed}`), ' lines'));
  out.append(lineDiffView(diff.ops));
}

$('mirRefresh')?.addEventListener('click', guard(loadMirror));
$('mirQ')?.addEventListener('input', () => { MIR.q = $('mirQ').value; renderMirList(); });
$('mirClear')?.addEventListener('click', guard(async () => {
  if (!MIR.total) return;
  if (!(await confirmBox('Erase the whole mirror trail? The before/after bodies are deleted.', 'Clear', true))) return;
  await del('/api/mirror');
  MIR.items = []; MIR.total = 0; MIR.sel = null;
  renderMirList();
  clear($('mirBody')).append(h('div', { class: 'empty' }, 'The mirror trail is empty.'));
  toast('Mirror trail cleared', 'ok');
}));
