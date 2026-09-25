'use strict';

/**
 * Omnibox overlay (WebContentsView above the tab): renders the suggestion rows sent by the shell
 * (omnibox-controller.js → main → 'omnibox-overlay-update'). Clicks go back through the bridge.
 */
const api = window.omniboxOverlay;
const backdrop = document.getElementById('backdrop');
const dropdown = document.getElementById('dropdown');
const itemsList = document.getElementById('items');
const hintEl = document.getElementById('hint');

const CONTENT_MAX_WIDTH = 960;

function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function withMatch(text, match) {
    const s = String(text || '');
    if (!match || !Array.isArray(match) || match.length < 2) return esc(s);
    let a = Number(match[0]);
    let b = Number(match[1]);
    if (!Number.isFinite(a)) a = 0;
    if (!Number.isFinite(b)) b = 0;
    a = Math.max(0, Math.min(a, s.length));
    b = Math.max(a, Math.min(b, s.length));
    return esc(s.slice(0, a)) + '<b>' + esc(s.slice(a, b)) + '</b>' + esc(s.slice(b));
}

const ICONS = {
    search: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11 6.5a4.5 4.5 0 10-1 2.8l3.2 3.2.7-.7-3.2-3.2A4.5 4.5 0 0011 6.5zM7 10a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/></svg>',
    history: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 1a5.5 5.5 0 110 11A5.5 5.5 0 018 2.5z"/><path d="M8 4.5V8l2.2 1.3.5-.9L8.5 7.4V4.5H8z"/></svg>',
    tab: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zm0 1v8h10V4H3z"/></svg>',
    quick: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2l1.5 4H14l-4 3 1.5 5L8 11l-3.5 3L6 9 2 6h4.5L8 2z"/></svg>',
    cmd: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 3h12v2H2V3zm0 4h8v2H2V7zm0 4h12v2H2v-2z"/></svg>',
    url: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1a5 5 0 012.8.9L10 5.5A3.5 3.5 0 108 13c1.2 0 2.3-.6 2.9-1.5h1.6A5 5 0 118 3z"/></svg>',
};

function icon(kind) {
    return ICONS[String(kind || 'url')] || ICONS.url;
}

function render(data) {
    if (!data) { dropdown.style.display = 'none'; return; }
    dropdown.style.display = '';
    backdrop.classList.toggle('veil', data.backdrop === true);
    dropdown.classList.toggle('attached', data.attached === true);
    if (data.left != null && data.width != null) {
        dropdown.style.marginLeft = data.left + 'px';
        dropdown.style.width = data.width + 'px';
    }
    dropdown.style.setProperty('--content-max', (Number(data.maxWidth) || CONTENT_MAX_WIDTH) + 'px');
    if (data.topGap != null) dropdown.style.marginTop = data.topGap + 'px';

    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
        itemsList.innerHTML = '<li class="empty">' + esc(data.emptyText || 'No results') + '</li>';
    } else {
        itemsList.innerHTML = items.map((it, i) => {
            const cls = 'item' + (it.active ? ' active' : '');
            const kbd = it.shortcut ? '<span class="item-kbd">' + esc(it.shortcut) + '</span>' : '';
            const preview = it.urlPreview
                ? '<span class="item-url-preview">' + withMatch(it.urlPreview, it.previewMatch) + '</span>'
                : '';
            const badge = it.badge ? '<span class="item-badge item-badge--' + esc(it.badge) + '">' + esc(it.badge) + '</span>' : '';
            const del = it.deletable ? '<button type="button" class="item-del" data-idx="' + i + '" title="Remove from history (Shift+Del)" aria-label="Remove from history">×</button>' : '';
            return '<li class="' + cls + '" data-idx="' + i + '" role="option" aria-selected="' + (it.active ? 'true' : 'false') + '">'
                + '<span class="item-icon">' + icon(it.icon) + '</span>'
                + '<span class="item-main">'
                + '<span class="item-label-row">' + withMatch(it.label, it.match) + badge + '</span>'
                + preview
                + '</span>'
                + '<span class="item-cat">' + esc(it.sub || '') + '</span>'
                + kbd + del + '</li>';
        }).join('');
    }
    hintEl.textContent = data.hint || '';
    const activeEl = itemsList.querySelector('.item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

api.onUpdate(render);

backdrop.addEventListener('mousedown', (e) => {
    e.preventDefault();
    api.dismiss();
});

itemsList.addEventListener('mousedown', (e) => {
    const del = e.target.closest('.item-del');
    if (del) {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(del.dataset.idx);
        if (Number.isFinite(idx) && typeof api.deleteItem === 'function') api.deleteItem(idx);
        return;
    }
    const li = e.target.closest('.item');
    if (!li) return;
    e.preventDefault();
    const idx = Number(li.dataset.idx);
    if (Number.isFinite(idx)) api.selectItem(idx);
});
