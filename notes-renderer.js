'use strict';

/* global Quill */
const api = window.electronAPI;

const el = {
    list: document.getElementById('notes-list'),
    title: document.getElementById('notes-title-input'),
    match: document.getElementById('notes-match-input'),
    metaSummary: document.getElementById('notes-meta-summary'),
    metaDetails: document.getElementById('notes-meta-details'),
    btnMetaToggle: document.getElementById('btn-meta-toggle'),
    search: document.getElementById('notes-search-input'),
    chkEnc: document.getElementById('chk-encrypt'),
    encryptRow: document.getElementById('encrypt-row'),
    pw1: document.getElementById('pw1'),
    lockOverlay: document.getElementById('editor-lock-overlay'),
    unlockPw: document.getElementById('unlock-pw'),
    err: document.getElementById('notes-err'),
    saveStatus: document.getElementById('save-status'),
    btnSave: document.getElementById('btn-save'),
    btnDel: document.getElementById('btn-del'),
    btnLock: document.getElementById('btn-lock-toggle'),
    btnSetPassword: document.getElementById('btn-set-password'),
    btnPwToggle: document.getElementById('btn-pw-toggle'),
    btnUnlockPwToggle: document.getElementById('btn-unlock-pw-toggle'),
    editorEmptyHint: document.getElementById('editor-empty-hint'),
    tagFilter: document.getElementById('notes-tag-filter'),
    tags: document.getElementById('notes-tags-input'),
    btnPin: document.getElementById('btn-pin'),
    btnDup: document.getElementById('btn-dup'),
    exportDd: document.getElementById('export-dd'),
    wordCount: document.getElementById('notes-word-count'),
    findBar: document.getElementById('note-find-bar'),
    findInput: document.getElementById('note-find-input'),
    findCount: document.getElementById('note-find-count'),
    findPrev: document.getElementById('note-find-prev'),
    findNext: document.getElementById('note-find-next'),
    findClose: document.getElementById('note-find-close'),
};

const quill = new Quill('#notes-editor', {
    theme: 'snow',
    placeholder: 'Start writing…',
    modules: {
        toolbar: {
            container: [
                ['bold', 'italic', 'underline', 'strike'],
                [{ header: 1 }, { header: 2 }],
                [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
                ['blockquote', 'code-block'],
                ['link', 'image'],
                ['cnRequest'],
                [{ color: [] }, { background: [] }],
                ['clean'],
            ],
            handlers: {
                cnRequest() {
                    openCnRequestPrompt();
                },
            },
        },
    },
});

if (typeof window.setupCnBlockDelegatedActions === 'function') {
    window.setupCnBlockDelegatedActions(quill.root);
}

/* ── "+ Request" prompt (DOM-based, not window.prompt) ────────────────── */
function openCnRequestPrompt() {
    const overlay = document.getElementById('cn-req-prompt');
    const input = document.getElementById('cn-req-prompt-input');
    const errEl = document.getElementById('cn-req-prompt-err');
    const okBtn = document.getElementById('cn-req-prompt-ok');
    const cancelBtn = document.getElementById('cn-req-prompt-cancel');
    if (!overlay || !input) return;

    errEl.textContent = '';
    input.value = '';
    overlay.style.display = '';

    requestAnimationFrame(() => input.focus());

    function close() {
        overlay.style.display = 'none';
        input.removeEventListener('keydown', onKey);
        okBtn.removeEventListener('click', submit);
        cancelBtn.removeEventListener('click', close);
        overlay.removeEventListener('mousedown', onOverlayClick);
    }

    function submit() {
        const raw = input.value.trim();
        if (!raw) { errEl.textContent = 'Please enter a request ID'; return; }
        const rid = Number(raw);
        if (!Number.isFinite(rid) || rid <= 0) { errEl.textContent = 'ID must be a positive number'; return; }
        if (typeof api.notesGetRequestForEmbed !== 'function') {
            errEl.textContent = 'API not available — restart the app';
            return;
        }
        errEl.textContent = '';
        okBtn.disabled = true;
        okBtn.textContent = 'Loading…';
        api.notesGetRequestForEmbed(rid).then((data) => {
            if (!data) { errEl.textContent = 'Request not found'; okBtn.disabled = false; okBtn.textContent = 'Insert'; return; }
            close();
            if (typeof window.insertCnBlock === 'function') {
                window.insertCnBlock(quill, 'request', data);
                markDirty();
            }
        }).catch((e) => {
            console.error('[notes] cnRequest embed', e);
            errEl.textContent = 'Failed to load request';
            okBtn.disabled = false;
            okBtn.textContent = 'Insert';
        });
    }

    function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    function onOverlayClick(e) {
        if (e.target === overlay) close();
    }

    input.addEventListener('keydown', onKey);
    okBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', onOverlayClick);
}

(function setupNotesQuillToolbarChrome() {
    const tb = document.querySelector('#editor-container .ql-toolbar');
    if (!tb) return;

    const btnCaptions = {
        bold: 'Bold', italic: 'Italic', underline: 'Under', strike: 'Strike',
        blockquote: 'Quote', 'code-block': 'Code', link: 'Link', image: 'Image',
        clean: 'Clear',
    };
    const btnTitles = {
        bold: 'Bold (Ctrl+B)', italic: 'Italic (Ctrl+I)', underline: 'Underline (Ctrl+U)',
        strike: 'Strikethrough', blockquote: 'Blockquote', 'code-block': 'Code block',
        link: 'Insert link (Ctrl+K)', image: 'Insert image',
        clean: 'Clear formatting',
    };
    function headerCaption(v) { return v === '1' ? 'H1' : v === '2' ? 'H2' : 'H'; }
    function listCaption(v) { return v === 'ordered' ? 'Num.' : v === 'bullet' ? 'Bullet' : v === 'check' ? 'Check' : 'List'; }
    function listTitle(v) { return v === 'ordered' ? 'Numbered list' : v === 'bullet' ? 'Bullet list' : 'Checklist'; }

    function addCaption(el, text) {
        const cap = document.createElement('span');
        cap.className = 'ql-btn-cap';
        cap.textContent = text;
        el.appendChild(cap);
    }

    tb.querySelectorAll('button').forEach((btn) => {
        const cls = [...btn.classList].find((c) => c.startsWith('ql-') && c !== 'ql-active');
        if (!cls) return;
        const fmt = cls.slice(3);

        if (fmt === 'cnRequest') {
            btn.innerHTML = '';
            const icon = document.createElement('span');
            icon.className = 'ql-btn-icon-text';
            icon.textContent = '+';
            icon.setAttribute('aria-hidden', 'true');
            btn.appendChild(icon);
            addCaption(btn, 'Request');
            btn.setAttribute('title', 'Insert request card from Network Activity (by numeric ID)');
            return;
        }

        let caption = btnCaptions[fmt] || '';
        if (fmt === 'header') caption = headerCaption(btn.getAttribute('value'));
        if (fmt === 'list') caption = listCaption(btn.getAttribute('value'));
        if (caption) addCaption(btn, caption);

        const title = btnTitles[fmt] || '';
        if (fmt === 'header') btn.setAttribute('title', 'Heading ' + (btn.getAttribute('value') || ''));
        else if (fmt === 'list') btn.setAttribute('title', listTitle(btn.getAttribute('value')));
        else if (title) btn.setAttribute('title', title);
    });

    tb.querySelectorAll('.ql-picker').forEach((picker) => {
        const cls = [...picker.classList].find((c) => c.startsWith('ql-') && c !== 'ql-expanded' && c !== 'ql-picker');
        if (!cls) return;
        const fmt = cls.slice(3);
        const text = fmt === 'color' ? 'Color' : fmt === 'background' ? 'Marker' : '';
        if (!text) return;
        const cap = document.createElement('span');
        cap.className = 'ql-btn-cap ql-picker-cap';
        cap.textContent = text;
        picker.appendChild(cap);
    });
})();

const AUTOSAVE_MS = 1500;
let ctxPageUrl = '';
let ctxDomain = '';
let currentId = null;
/** Last full list from API (for tag filter dropdown). */
let _listRowsAllForTags = [];
let pendingLocked = false;
const pwdCache = new Map();

let baseline = null;
let _loading = false;
let autosaveTimer = null;
let pinnedState = false;
let pendingPinned = false;
let findMatches = [];
let findMatchIdx = 0;
let _wordCountTimer = null;

function setErr(msg) { el.err.textContent = msg || ''; }

/** Strip Electron IPC noise so the user sees the real message. */
function formatNotesIpcError(e) {
    let m = String(e?.message || e);
    m = m.replace(/^Error invoking remote method 'notes-get':\s*/i, '');
    m = m.replace(/^Error invoking remote method 'notes-save':\s*/i, '');
    m = m.replace(/^Error invoking remote method 'notes-delete':\s*/i, '');
    m = m.replace(/^Error invoking remote method 'notes-pin':\s*/i, '');
    m = m.replace(/^Error invoking remote method 'notes-export':\s*/i, '');
    m = m.replace(/^Error:\s*/i, '');
    return m.trim();
}

function isWrongPasswordFromNotesGet(e) {
    const m = String(e?.message || e);
    return /Wrong password/i.test(m);
}

/**
 * Load note for the editor. If cached password is stale, drop cache and return locked row.
 */
async function notesGetForSelect(id) {
    const cached = pwdCache.get(id);
    try {
        return await api.notesGet(id, cached || null);
    } catch (e) {
        if (cached && isWrongPasswordFromNotesGet(e)) {
            pwdCache.delete(id);
            return await api.notesGet(id, null);
        }
        throw e;
    }
}

function fmtDate(s) {
    if (!s) return '\u2014';
    try {
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return s;
        return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    } catch { return s; }
}

function setSaveStatus(state) {
    const st = el.saveStatus;
    st.classList.remove('saving', 'saved', 'unsaved');
    if (state === 'saving') {
        st.textContent = 'Saving\u2026';
        st.classList.add('saving');
    } else if (state === 'saved') {
        st.textContent = 'Saved';
        st.classList.add('saved');
    } else if (state === 'unsaved') {
        st.textContent = 'Unsaved';
        st.classList.add('unsaved');
    } else {
        st.textContent = '';
    }
}

function updateLockOverlay() {
    if (!el.lockOverlay) return;
    const show = !!pendingLocked;
    el.lockOverlay.classList.toggle('visible', show);
    el.lockOverlay.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!show) {
        el.unlockPw.value = '';
        setPwVisibility(el.unlockPw, el.btnUnlockPwToggle, false);
    }
    updateToolbarButtons();
}

function setPwVisibility(input, btn, showPlain) {
    if (!input || !btn) return;
    input.type = showPlain ? 'text' : 'password';
    const open = btn.querySelector('.eye-open');
    const off = btn.querySelector('.eye-off');
    if (open && off) {
        open.style.display = showPlain ? 'none' : 'inline';
        off.style.display = showPlain ? 'inline' : 'none';
    }
    btn.setAttribute('aria-label', showPlain ? 'Hide password' : 'Show password');
    btn.setAttribute('title', showPlain ? 'Hide password' : 'Show password');
}

function syncLockButton() {
    const on = el.chkEnc.checked;
    el.btnLock.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.encryptRow.classList.toggle('visible', on && !pendingLocked);
}

function syncPinButton() {
    if (!el.btnPin) return;
    const on = currentId ? pinnedState : pendingPinned;
    el.btnPin.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function updateToolbarButtons() {
    if (el.btnSave) el.btnSave.disabled = !!pendingLocked;
    el.btnDel.disabled = !currentId;
    if (el.btnPin) el.btnPin.disabled = !!pendingLocked;
    if (el.btnDup) el.btnDup.disabled = !currentId || !!pendingLocked;
    if (el.exportDd) {
        el.exportDd.style.pointerEvents = !currentId || pendingLocked ? 'none' : '';
        el.exportDd.style.opacity = !currentId || pendingLocked ? '0.35' : '';
    }
    if (el.tags) el.tags.disabled = !!pendingLocked;
    syncPinButton();
}

function scheduleBaselineAfterLoad(cb) {
    _loading = true;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            setTimeout(() => {
                _loading = false;
                captureBaseline();
                if (typeof cb === 'function') cb();
                else setSaveStatus(currentId || baselineHasContent() ? 'saved' : '');
                updateEmptyHint();
            }, 0);
        });
    });
}

function captureBaseline() {
    baseline = {
        title: el.title.value,
        match: el.match.value,
        html: quill.root.innerHTML,
        enc: el.chkEnc.checked,
        tags: el.tags ? el.tags.value : '',
        pinned: currentId ? pinnedState : pendingPinned,
    };
    if (!_loading && isDirtyNow()) setSaveStatus('unsaved');
    else if (!_loading) setSaveStatus(currentId || baselineHasContent() ? 'saved' : '');
}

function baselineHasContent() {
    return (el.title.value || '').trim() !== ''
        || (el.match.value || '').trim() !== ''
        || (el.tags && (el.tags.value || '').trim() !== '')
        || quill.getText().replace(/\s/g, '').length > 0;
}

/** Rebuild CupNet block cards from ```cupnet JSON fences (saved markdown round-trip). */
function applyNoteBodyHtml(html) {
    const raw = html || '';
    const hydrated = typeof window.hydrateCupnetBlocksHtml === 'function'
        ? window.hydrateCupnetBlocksHtml(raw)
        : raw;
    quill.root.innerHTML = hydrated;
}

function isDirtyNow() {
    if (!baseline) return false;
    const pinNow = currentId ? pinnedState : pendingPinned;
    return el.title.value !== baseline.title
        || el.match.value !== baseline.match
        || quill.root.innerHTML !== baseline.html
        || el.chkEnc.checked !== baseline.enc
        || (el.tags && (el.tags.value || '') !== (baseline.tags || ''))
        || pinNow !== baseline.pinned;
}

function markDirty() {
    if (_loading || !baseline) return;
    if (isDirtyNow()) {
        setSaveStatus('unsaved');
        scheduleAutosave();
    } else {
        setSaveStatus(currentId ? 'saved' : '');
    }
}

function clearAutosaveTimer() {
    if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
    }
}

function scheduleAutosave() {
    clearAutosaveTimer();
    if (_loading || pendingLocked || el.chkEnc.checked) return;
    autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        if (!isDirtyNow() || _loading || pendingLocked || el.chkEnc.checked) return;
        void doAutosave();
    }, AUTOSAVE_MS);
}

async function doAutosave() {
    if (_loading || pendingLocked || el.chkEnc.checked) return;
    if (!isDirtyNow()) return;
    setSaveStatus('saving');
    setErr('');
    try {
        await saveNoteInternal();
        setSaveStatus('saved');
    } catch (e) {
        setErr(String(e?.message || e));
        setSaveStatus('unsaved');
    }
}

function updateEmptyHint() {
    if (!el.editorEmptyHint) return;
    const emptyDraft = !currentId
        && !pendingLocked
        && !(el.title.value || '').trim()
        && !(el.match.value || '').trim()
        && quill.getText().replace(/\s/g, '').length === 0;
    el.editorEmptyHint.classList.toggle('visible', emptyDraft);
}

function updateMeta(data) {
    if (!data || !data.id) {
        el.metaSummary.textContent = '';
        el.metaDetails.textContent = '';
        el.btnMetaToggle.style.display = 'none';
        return;
    }
    el.btnMetaToggle.style.display = 'flex';
    const oneLine = `Created ${fmtDate(data.created_at)}`;
    el.metaSummary.textContent = oneLine;
    el.metaDetails.textContent = [
        `Created: ${fmtDate(data.created_at)}`,
        `Domain index: ${data.domain || '\u2014'}`,
        `Pattern: ${data.url_match != null && data.url_match !== '' ? data.url_match : '\u2014'}`,
        `Page at creation: ${data.page_url || '\u2014'}`,
    ].join('\n');
}

function setDraftMetaSummary() {
    el.btnMetaToggle.style.display = 'flex';
    el.metaSummary.textContent = `Draft \u2014 tab: ${ctxDomain || '(no site)'} \u00B7 ${ctxPageUrl || '\u2014'}`;
    el.metaDetails.textContent = [
        'Not saved yet.',
        `Tab context: domain ${ctxDomain || '(none)'} \u00B7 URL ${ctxPageUrl || '\u2014'}`,
        'Edit the site/pattern field to bind this note (domain, host, glob).',
    ].join('\n');
}

function parseTagList(s) {
    if (!s || typeof s !== 'string') return [];
    return s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function refreshTagFilterOptions() {
    if (!el.tagFilter) return;
    const cur = el.tagFilter.value;
    const set = new Set();
    for (const row of _listRowsAllForTags) {
        for (const t of parseTagList(row.tags)) set.add(t);
    }
    const tags = [...set].sort();
    el.tagFilter.textContent = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = 'All tags';
    el.tagFilter.appendChild(optAll);
    for (const t of tags) {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = t;
        el.tagFilter.appendChild(o);
    }
    if (cur === '' || tags.includes(cur)) el.tagFilter.value = cur;
}

async function loadList() {
    setErr('');
    const search = el.search.value.trim();
    const baseFilter = { limit: 500, search: search || undefined };
    const tagSel = el.tagFilter ? el.tagFilter.value.trim() : '';
    if (tagSel) baseFilter.tag = tagSel;

    let listRowsAll = [];
    try {
        listRowsAll = await api.notesList(baseFilter);
    } catch (e) {
        setErr(String(e?.message || e));
    }
    _listRowsAllForTags = listRowsAll;

    let listRowsThis = [];
    if (ctxDomain) {
        try {
            listRowsThis = await api.notesList({
                ...baseFilter,
                domain: ctxDomain,
                refineByUrlMatch: true,
                pageUrl: ctxPageUrl || '',
            });
        } catch (e) {
            if (!listRowsAll.length) setErr(String(e?.message || e));
        }
    }

    const thisIds = new Set(listRowsThis.map((r) => r.id));
    const listRowsAllRest = listRowsAll.filter((r) => !thisIds.has(r.id));

    renderListGrouped(listRowsThis, listRowsAllRest, ctxDomain || '');
    refreshTagFilterOptions();
}

function createNoteItemElement(row) {
    const div = document.createElement('div');
    div.className = 'note-item' + (row.id === currentId ? ' active' : '');
    div.dataset.id = String(row.id);

    const titleEl = document.createElement('div');
    titleEl.className = 'ni-title';
    if (row.is_pinned) {
        const pin = document.createElement('span');
        pin.className = 'ni-pin';
        pin.textContent = '\uD83D\uDCCC';
        pin.title = 'Pinned';
        titleEl.appendChild(pin);
    }
    if (row.is_encrypted) {
        const lock = document.createElement('span');
        lock.className = 'ni-lock';
        lock.textContent = '\uD83D\uDD12';
        titleEl.appendChild(lock);
        titleEl.appendChild(document.createTextNode((row.title || '').trim() || 'Encrypted'));
    } else {
        titleEl.appendChild(document.createTextNode(row.title || '(untitled)'));
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'ni-meta';
    const dateSpan = document.createElement('span');
    dateSpan.textContent = fmtDate(row.updated_at || row.created_at);
    metaEl.appendChild(dateSpan);

    if (row.url_match || row.domain) {
        const pill = document.createElement('span');
        pill.className = 'ni-domain';
        pill.textContent = row.url_match || row.domain;
        metaEl.appendChild(pill);
    }

    if (!row.is_encrypted && row.preview) {
        const prev = document.createElement('span');
        prev.textContent = row.preview.replace(/\s+/g, ' ').slice(0, 48);
        prev.style.color = 'var(--text-muted)';
        metaEl.appendChild(prev);
    }

    div.appendChild(titleEl);
    div.appendChild(metaEl);

    const tagStr = row.tags != null ? String(row.tags) : '';
    const tagParts = tagStr.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagParts.length) {
        const tagWrap = document.createElement('div');
        tagWrap.className = 'ni-tags';
        for (const tg of tagParts.slice(0, 6)) {
            const sp = document.createElement('span');
            sp.className = 'ni-tag';
            sp.textContent = tg;
            tagWrap.appendChild(sp);
        }
        div.appendChild(tagWrap);
    }

    div.addEventListener('click', () => selectNote(row.id));
    return div;
}

function renderListGrouped(listRowsThis, listRowsAllRest, domainLabel) {
    el.list.innerHTML = '';

    const sec1 = document.createElement('div');
    sec1.className = 'notes-section';
    const h1 = document.createElement('div');
    h1.className = 'notes-section-head';
    h1.textContent = 'This site';
    sec1.appendChild(h1);
    const ctx = document.createElement('div');
    ctx.className = 'notes-section-context';
    ctx.textContent = domainLabel || 'No active tab';
    sec1.appendChild(ctx);

    if (!domainLabel) {
        const empty = document.createElement('div');
        empty.className = 'notes-section-empty';
        empty.textContent = 'Open a browser tab with https:// or http:// so a site is active. Notes bound to that site appear here.';
        sec1.appendChild(empty);
    } else if (listRowsThis.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'notes-section-empty';
        empty.textContent = 'No notes for this site yet. Match the site/pattern field to the current tab.';
        sec1.appendChild(empty);
    } else {
        for (const row of listRowsThis) sec1.appendChild(createNoteItemElement(row));
    }
    el.list.appendChild(sec1);

    const sec2 = document.createElement('div');
    sec2.className = 'notes-section';
    const h2 = document.createElement('div');
    h2.className = 'notes-section-head';
    h2.textContent = 'All sites';
    sec2.appendChild(h2);
    const sub = document.createElement('div');
    sub.className = 'notes-section-sub';
    sub.textContent = domainLabel
        ? 'Other notes (not listed above).'
        : 'Every saved note.';
    sec2.appendChild(sub);

    if (listRowsAllRest.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'notes-section-empty';
        empty.textContent = domainLabel ? 'No other notes.' : 'No notes yet.';
        sec2.appendChild(empty);
    } else {
        for (const row of listRowsAllRest) sec2.appendChild(createNoteItemElement(row));
    }
    el.list.appendChild(sec2);
}

async function selectNote(id) {
    if (!_loading && isDirtyNow()) {
        clearAutosaveTimer();
        if (!confirm('You have unsaved changes. Switch to another note?')) return;
    }
    clearAutosaveTimer();
    closeFindBar();
    setErr('');
    currentId = id;
    pendingLocked = false;
    updateLockOverlay();
    el.chkEnc.checked = false;
    el.pw1.value = '';
    el.title.readOnly = false;
    el.match.readOnly = false;
    quill.enable(true);
    syncLockButton();
    updateToolbarButtons();

    for (const n of el.list.querySelectorAll('.note-item'))
        n.classList.toggle('active', Number(n.dataset.id) === id);

    _loading = true;
    try {
        const row = await notesGetForSelect(id);
        if (!row) {
            _loading = false;
            return;
        }

        el.match.value = row.url_match != null ? row.url_match : '';

        if (row.locked) {
            pendingLocked = true;
            updateLockOverlay();
            el.title.value = row.title || '';
            if (el.tags) el.tags.value = row.tags != null ? String(row.tags) : '';
            pinnedState = !!row.is_pinned;
            pendingPinned = false;
            quill.setText('');
            quill.enable(false);
            el.title.readOnly = true;
            el.match.readOnly = true;
            el.chkEnc.disabled = true;
            el.btnLock.disabled = true;
            el.encryptRow.classList.remove('visible');
            updateMeta({ id: row.id, created_at: row.created_at, domain: row.domain, url_match: row.url_match, page_url: row.page_url });
            scheduleBaselineAfterLoad(() => { setSaveStatus(''); updateEmptyHint(); });
            return;
        }

        el.chkEnc.disabled = false;
        el.btnLock.disabled = false;
        el.chkEnc.checked = !!row.is_encrypted;
        syncLockButton();
        el.title.value = row.title || '';
        if (el.tags) el.tags.value = row.tags != null ? String(row.tags) : '';
        pinnedState = !!row.is_pinned;
        pendingPinned = false;

        applyNoteBodyHtml(row.bodyHtml);

        updateMeta(row);
        scheduleBaselineAfterLoad(() => { updateEmptyHint(); });
    } catch (e) {
        _loading = false;
        setErr(formatNotesIpcError(e));
    }
}

async function tryUnlock() {
    setErr('');
    const pw = el.unlockPw.value;
    if (!pw) { setErr('Enter password'); return; }
    _loading = true;
    try {
        const row = await api.notesGet(currentId, pw);
        if (!row || row.locked) {
            _loading = false;
            setErr('Wrong password');
            return;
        }
        pwdCache.set(currentId, pw);
        pendingLocked = false;
        updateLockOverlay();
        el.title.readOnly = false;
        el.match.readOnly = false;
        quill.enable(true);
        el.chkEnc.disabled = false;
        el.btnLock.disabled = false;
        el.chkEnc.checked = true;
        syncLockButton();
        el.match.value = row.url_match != null ? row.url_match : '';
        el.title.value = row.title || '';
        if (el.tags) el.tags.value = row.tags != null ? String(row.tags) : '';
        pinnedState = !!row.is_pinned;
        pendingPinned = false;
        applyNoteBodyHtml(row.bodyHtml);
        updateMeta(row);
        scheduleBaselineAfterLoad();
    } catch (e) {
        _loading = false;
        setErr(formatNotesIpcError(e));
    }
}

function newNote(skipConfirm) {
    if (!skipConfirm && !_loading && isDirtyNow()) {
        clearAutosaveTimer();
        if (!confirm('You have unsaved changes. Create a new note?')) return;
    }
    clearAutosaveTimer();
    closeFindBar();
    setErr('');
    baseline = null;
    currentId = null;
    pendingLocked = false;
    updateLockOverlay();
    el.title.value = '';
    if (el.tags) el.tags.value = '';
    pinnedState = false;
    pendingPinned = false;
    quill.setText('');
    quill.enable(true);
    el.match.value = ctxDomain || '';
    el.chkEnc.checked = false;
    el.chkEnc.disabled = false;
    el.btnLock.disabled = false;
    el.pw1.value = '';
    setPwVisibility(el.pw1, el.btnPwToggle, false);
    syncLockButton();
    setDraftMetaSummary();
    el.metaDetails.classList.remove('visible');
    el.btnMetaToggle.setAttribute('aria-expanded', 'false');
    for (const n of el.list.querySelectorAll('.note-item')) n.classList.remove('active');
    updateToolbarButtons();
    scheduleBaselineAfterLoad(() => { setSaveStatus(''); updateEmptyHint(); });
}

async function saveNoteInternal() {
    if (pendingLocked) throw new Error('Unlock the note first');
    const isEnc = el.chkEnc.checked;
    const title = el.title.value;
    const bodyHtml = quill.root.innerHTML;
    const page_url = ctxPageUrl || '';
    const url_match = el.match.value.trim();
    const tags = el.tags ? el.tags.value : '';
    const is_pinned = currentId ? pinnedState : pendingPinned;

    if (isEnc) {
        const p1 = el.pw1.value.trim();
        let password;
        if (p1) {
            password = p1;
        } else if (currentId && pwdCache.get(currentId)) {
            password = pwdCache.get(currentId);
        } else {
            throw new Error('Enter a password, then click Set password or press Ctrl+S');
        }
        const id = await api.notesSave({
            id: currentId, title, bodyHtml, page_url, url_match,
            is_encrypted: true, password,
            tags,
            is_pinned,
        });
        currentId = id;
        pwdCache.set(id, password);
        el.pw1.value = '';
        setPwVisibility(el.pw1, el.btnPwToggle, false);
        await loadList();
        await selectNoteSkipDirtyCheck(id);
        return;
    }

    const id = await api.notesSave({
        id: currentId, title, bodyHtml, page_url, url_match,
        is_encrypted: false,
        tags,
        is_pinned,
    });
    currentId = id;
    pwdCache.delete(id);
    await loadList();
    const row = await api.notesGet(id, null);
    if (row) updateMeta(row);
    scheduleBaselineAfterLoad();
}

async function selectNoteSkipDirtyCheck(id) {
    clearAutosaveTimer();
    closeFindBar();
    setErr('');
    currentId = id;
    pendingLocked = false;
    updateLockOverlay();
    el.chkEnc.checked = false;
    el.pw1.value = '';
    el.title.readOnly = false;
    el.match.readOnly = false;
    quill.enable(true);
    syncLockButton();
    updateToolbarButtons();
    for (const n of el.list.querySelectorAll('.note-item'))
        n.classList.toggle('active', Number(n.dataset.id) === id);
    _loading = true;
    try {
        const row = await notesGetForSelect(id);
        if (!row) {
            _loading = false;
            return;
        }
        el.match.value = row.url_match != null ? row.url_match : '';
        if (row.locked) {
            pendingLocked = true;
            updateLockOverlay();
            el.title.value = row.title || '';
            if (el.tags) el.tags.value = row.tags != null ? String(row.tags) : '';
            pinnedState = !!row.is_pinned;
            pendingPinned = false;
            quill.setText('');
            quill.enable(false);
            el.title.readOnly = true;
            el.match.readOnly = true;
            el.chkEnc.disabled = true;
            el.btnLock.disabled = true;
            el.encryptRow.classList.remove('visible');
            updateMeta({ id: row.id, created_at: row.created_at, domain: row.domain, url_match: row.url_match, page_url: row.page_url });
            scheduleBaselineAfterLoad(() => { setSaveStatus(''); updateEmptyHint(); });
            return;
        }
        el.chkEnc.disabled = false;
        el.btnLock.disabled = false;
        el.chkEnc.checked = !!row.is_encrypted;
        syncLockButton();
        el.title.value = row.title || '';
        if (el.tags) el.tags.value = row.tags != null ? String(row.tags) : '';
        pinnedState = !!row.is_pinned;
        pendingPinned = false;
        applyNoteBodyHtml(row.bodyHtml);
        updateMeta(row);
        scheduleBaselineAfterLoad(() => { updateEmptyHint(); });
    } catch (e) {
        _loading = false;
        setErr(formatNotesIpcError(e));
    }
}

async function saveNote() {
    setErr('');
    clearAutosaveTimer();
    if (pendingLocked) { setErr('Unlock the note first'); return; }
    setSaveStatus('saving');
    try {
        await saveNoteInternal();
        setSaveStatus('saved');
    } catch (e) {
        setErr(formatNotesIpcError(e));
        setSaveStatus('unsaved');
    }
}

async function deleteNote() {
    if (!currentId) return;
    if (!confirm('Delete this note?')) return;
    clearAutosaveTimer();
    setErr('');
    try {
        const delId = currentId;
        await api.notesDelete(delId);
        pwdCache.delete(delId);
        currentId = null;
        newNote(true);
        await loadList();
    } catch (e) { setErr(formatNotesIpcError(e)); }
}

async function togglePin() {
    if (pendingLocked) return;
    if (!currentId) {
        pendingPinned = !pendingPinned;
        syncPinButton();
        markDirty();
        return;
    }
    const next = !pinnedState;
    setErr('');
    try {
        await api.notesPin(currentId, next);
        pinnedState = next;
        syncPinButton();
        if (baseline) baseline.pinned = pinnedState;
        await loadList();
    } catch (e) {
        setErr(formatNotesIpcError(e));
    }
}

async function duplicateNote() {
    if (!currentId || pendingLocked) return;
    clearAutosaveTimer();
    setErr('');
    try {
        const row = await notesGetForSelect(currentId);
        if (!row || row.locked) {
            setErr('Cannot duplicate a locked note');
            return;
        }
        const title = `${row.title || 'Untitled'} (copy)`;
        const pw = row.is_encrypted ? pwdCache.get(currentId) : null;
        if (row.is_encrypted && !pw) {
            setErr('Unlock and save the note before duplicating');
            return;
        }
        const payload = {
            id: null,
            title,
            bodyHtml: row.bodyHtml,
            page_url: ctxPageUrl || row.page_url || '',
            url_match: row.url_match || '',
            tags: row.tags || '',
            is_pinned: false,
            is_encrypted: !!row.is_encrypted,
        };
        if (row.is_encrypted) payload.password = pw;
        const id = await api.notesSave(payload);
        await loadList();
        await selectNoteSkipDirtyCheck(id);
        setSaveStatus('saved');
    } catch (e) {
        setErr(formatNotesIpcError(e));
    }
}

async function doExport(fmt) {
    if (!currentId || pendingLocked) return;
    setErr('');
    try {
        const pw = el.chkEnc.checked ? pwdCache.get(currentId) : null;
        if (el.chkEnc.checked && !pw) {
            setErr('Unlock the note to export');
            return;
        }
        const res = await api.notesExport({
            id: currentId,
            format: fmt,
            password: pw || undefined,
        });
        if (res && res.canceled) return;
        if (el.exportDd) el.exportDd.removeAttribute('open');
    } catch (e) {
        setErr(formatNotesIpcError(e));
    }
}

function updateWordCount() {
    if (!el.wordCount) return;
    const text = quill.getText() || '';
    const trimmed = text.replace(/\s+$/, '');
    const chars = trimmed.length;
    const words = trimmed.trim() ? trimmed.trim().split(/\s+/).length : 0;
    el.wordCount.textContent = `${words} words \u00B7 ${chars} characters`;
}

function scheduleWordCount() {
    if (_wordCountTimer) clearTimeout(_wordCountTimer);
    _wordCountTimer = setTimeout(() => {
        _wordCountTimer = null;
        updateWordCount();
    }, 200);
}

function rebuildFindMatches() {
    const q = (el.findInput?.value || '').trim();
    const text = quill.getText() || '';
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    findMatches = [];
    if (!q) {
        findMatchIdx = 0;
        return;
    }
    let pos = 0;
    while (pos < lower.length) {
        const i = lower.indexOf(ql, pos);
        if (i === -1) break;
        findMatches.push({ index: i, length: q.length });
        pos = i + 1;
    }
    if (findMatchIdx >= findMatches.length) findMatchIdx = 0;
}

function applyFindHighlight() {
    if (!findMatches.length || !el.findInput?.value.trim()) {
        syncFindCount();
        return;
    }
    const m = findMatches[findMatchIdx];
    if (!m) return;
    quill.focus();
    quill.setSelection(m.index, m.length, 'silent');
    syncFindCount();
}

function syncFindCount() {
    if (!el.findCount) return;
    const n = findMatches.length;
    if (!n) el.findCount.textContent = '';
    else el.findCount.textContent = `${findMatchIdx + 1} / ${n}`;
}

function syncFindFromInput() {
    rebuildFindMatches();
    applyFindHighlight();
}

function findNext() {
    if (!findMatches.length) return;
    findMatchIdx = (findMatchIdx + 1) % findMatches.length;
    applyFindHighlight();
}

function findPrev() {
    if (!findMatches.length) return;
    findMatchIdx = (findMatchIdx - 1 + findMatches.length) % findMatches.length;
    applyFindHighlight();
}

function openFindBar() {
    if (!el.findBar) return;
    el.findBar.classList.add('visible');
    el.findBar.setAttribute('aria-hidden', 'false');
    setTimeout(() => el.findInput?.focus(), 0);
}

function closeFindBar() {
    if (!el.findBar) return;
    el.findBar.classList.remove('visible');
    el.findBar.setAttribute('aria-hidden', 'true');
    findMatches = [];
    findMatchIdx = 0;
    if (el.findCount) el.findCount.textContent = '';
}

function setupImagePaste() {
    quill.root.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type && item.type.indexOf('image') === 0) {
                e.preventDefault();
                const file = item.getAsFile();
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const range = quill.getSelection(true);
                    const idx = range ? range.index : quill.getLength();
                    quill.insertEmbed(idx, 'image', reader.result, 'user');
                    quill.setSelection(idx + 1, 0, 'silent');
                };
                reader.readAsDataURL(file);
                return;
            }
        }
    });
    quill.root.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    });
    quill.root.addEventListener('drop', (e) => {
        const f = e.dataTransfer?.files?.[0];
        if (!f || !f.type.startsWith('image/')) return;
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
            const idx = quill.getLength();
            quill.insertEmbed(idx, 'image', reader.result, 'user');
            quill.setSelection(idx + 1, 0, 'silent');
        };
        reader.readAsDataURL(f);
    });
}

setupImagePaste();

el.chkEnc.addEventListener('change', () => {
    syncLockButton();
    markDirty();
});

el.btnLock.addEventListener('click', () => {
    if (el.chkEnc.disabled) return;
    el.chkEnc.checked = !el.chkEnc.checked;
    el.chkEnc.dispatchEvent(new Event('change'));
});

el.btnSetPassword.addEventListener('click', () => {
    if (!el.chkEnc.checked) return;
    void saveNote();
});

let _pwShow = false;
el.btnPwToggle.addEventListener('click', () => {
    _pwShow = !_pwShow;
    setPwVisibility(el.pw1, el.btnPwToggle, _pwShow);
});

let _unlockPwShow = false;
el.btnUnlockPwToggle.addEventListener('click', () => {
    _unlockPwShow = !_unlockPwShow;
    setPwVisibility(el.unlockPw, el.btnUnlockPwToggle, _unlockPwShow);
});

['input', 'change'].forEach((ev) => {
    el.title.addEventListener(ev, () => { markDirty(); updateEmptyHint(); });
    el.match.addEventListener(ev, () => { markDirty(); updateEmptyHint(); });
    el.pw1.addEventListener(ev, markDirty);
});
quill.on('text-change', () => { markDirty(); updateEmptyHint(); scheduleWordCount(); });

el.search.addEventListener('input', () => loadList());
if (el.tagFilter) el.tagFilter.addEventListener('change', () => loadList());
if (el.tags) {
    ['input', 'change'].forEach((ev) => {
        el.tags.addEventListener(ev, () => { markDirty(); updateEmptyHint(); });
    });
}

el.btnMetaToggle.addEventListener('click', () => {
    const exp = el.btnMetaToggle.getAttribute('aria-expanded') === 'true';
    el.btnMetaToggle.setAttribute('aria-expanded', exp ? 'false' : 'true');
    el.metaDetails.classList.toggle('visible', !exp);
});

document.getElementById('btn-new').addEventListener('click', () => newNote());
document.getElementById('btn-save').addEventListener('click', () => void saveNote());
document.getElementById('btn-del').addEventListener('click', () => deleteNote());
document.getElementById('btn-unlock').addEventListener('click', () => tryUnlock());
el.unlockPw.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

api.onNotesInit((payload) => {
    ctxPageUrl = payload?.pageUrl || '';
    ctxDomain = payload?.domain || '';
    newNote();
    loadList();
});

api.onNotesContextUpdate((payload) => {
    ctxPageUrl = payload?.pageUrl || '';
    ctxDomain = payload?.domain || '';
    if (!currentId) {
        el.match.value = ctxDomain || '';
        setDraftMetaSummary();
        scheduleBaselineAfterLoad(() => { updateEmptyHint(); });
    }
    loadList();
});

api.onNotesEmbedBlock?.((blockData) => {
    if (!blockData) return;
    if (pendingLocked) {
        setErr('Unlock the note first to paste a block');
        return;
    }
    if (typeof window.insertCnBlock === 'function') {
        window.insertCnBlock(quill, blockData.kind || 'request', blockData);
        markDirty();
    }
});

window.addEventListener('beforeunload', (e) => {
    if (!_loading && isDirtyNow()) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void saveNote();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const t = e.target;
        if (t && (t.id === 'notes-search-input' || t.closest?.('#note-find-bar'))) return;
        e.preventDefault();
        openFindBar();
    }
    if (e.key === 'Escape' && el.findBar?.classList.contains('visible')) {
        e.preventDefault();
        closeFindBar();
    }
});

if (el.btnPin) el.btnPin.addEventListener('click', () => void togglePin());
if (el.btnDup) el.btnDup.addEventListener('click', () => void duplicateNote());

document.getElementById('export-menu')?.querySelectorAll('button[data-fmt]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const fmt = btn.getAttribute('data-fmt');
        if (fmt) void doExport(fmt);
    });
});

if (el.findInput) {
    el.findInput.addEventListener('input', () => syncFindFromInput());
}
if (el.findNext) el.findNext.addEventListener('click', () => findNext());
if (el.findPrev) el.findPrev.addEventListener('click', () => findPrev());
if (el.findClose) el.findClose.addEventListener('click', () => closeFindBar());

updateToolbarButtons();
updateLockOverlay();
updateWordCount();

