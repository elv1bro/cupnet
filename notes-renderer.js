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
    filterCurrent: document.getElementById('filter-current'),
    filterAll: document.getElementById('filter-all'),
};

const quill = new Quill('#notes-editor', {
    theme: 'snow',
    placeholder: 'Start writing…',
    modules: {
        toolbar: [
            ['bold', 'italic', 'strike'],
            [{ header: 1 }, { header: 2 }, { header: 3 }],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['blockquote', 'code-block'],
            ['link', 'clean'],
        ],
    },
});

const AUTOSAVE_MS = 1500;
let filterMode = 'current';
let ctxPageUrl = '';
let ctxDomain = '';
let currentId = null;
let listRows = [];
let pendingLocked = false;
const pwdCache = new Map();

let baseline = null;
let _loading = false;
let autosaveTimer = null;

function setErr(msg) { el.err.textContent = msg || ''; }

/** Strip Electron IPC noise so the user sees the real message. */
function formatNotesIpcError(e) {
    let m = String(e?.message || e);
    m = m.replace(/^Error invoking remote method 'notes-get':\s*/i, '');
    m = m.replace(/^Error invoking remote method 'notes-save':\s*/i, '');
    m = m.replace(/^Error invoking remote method 'notes-delete':\s*/i, '');
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

function updateToolbarButtons() {
    if (el.btnSave) el.btnSave.disabled = !!pendingLocked;
    el.btnDel.disabled = !currentId;
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
    };
    if (!_loading && isDirtyNow()) setSaveStatus('unsaved');
    else if (!_loading) setSaveStatus(currentId || baselineHasContent() ? 'saved' : '');
}

function baselineHasContent() {
    return (el.title.value || '').trim() !== ''
        || (el.match.value || '').trim() !== ''
        || quill.getText().replace(/\s/g, '').length > 0;
}

function isDirtyNow() {
    if (!baseline) return false;
    return el.title.value !== baseline.title
        || el.match.value !== baseline.match
        || quill.root.innerHTML !== baseline.html
        || el.chkEnc.checked !== baseline.enc;
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

async function loadList() {
    setErr('');
    const search = el.search.value.trim();
    if (filterMode === 'current' && !ctxDomain) {
        listRows = [];
        renderListPlaceholder('No active site \u2014 open a tab with https:// or choose All.');
        return;
    }
    const filter = { limit: 500, search: search || undefined };
    if (filterMode === 'current' && ctxDomain) {
        filter.domain = ctxDomain;
        filter.refineByUrlMatch = true;
        filter.pageUrl = ctxPageUrl || '';
    }
    try { listRows = await api.notesList(filter); }
    catch (e) { setErr(String(e?.message || e)); listRows = []; }
    renderList();
}

function renderListPlaceholder(msg) {
    el.list.innerHTML = '';
    const div = document.createElement('div');
    div.id = 'notes-list-empty';
    div.textContent = msg;
    el.list.appendChild(div);
}

function renderList() {
    el.list.innerHTML = '';
    for (const row of listRows) {
        const div = document.createElement('div');
        div.className = 'note-item' + (row.id === currentId ? ' active' : '');
        div.dataset.id = String(row.id);

        const titleEl = document.createElement('div');
        titleEl.className = 'ni-title';
        if (row.is_encrypted) {
            const lock = document.createElement('span');
            lock.className = 'ni-lock';
            lock.textContent = '\uD83D\uDD12';
            titleEl.appendChild(lock);
            titleEl.appendChild(document.createTextNode((row.title || '').trim() || 'Encrypted'));
        } else {
            titleEl.textContent = row.title || '(untitled)';
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
        div.addEventListener('click', () => selectNote(row.id));
        el.list.appendChild(div);
    }
}

async function selectNote(id) {
    if (!_loading && isDirtyNow()) {
        clearAutosaveTimer();
        if (!confirm('You have unsaved changes. Switch to another note?')) return;
    }
    clearAutosaveTimer();
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

        quill.root.innerHTML = row.bodyHtml || '';

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
        quill.root.innerHTML = row.bodyHtml || '';
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
    setErr('');
    baseline = null;
    currentId = null;
    pendingLocked = false;
    updateLockOverlay();
    el.title.value = '';
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
        quill.root.innerHTML = row.bodyHtml || '';
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

function setFilterMode(mode) {
    filterMode = mode;
    el.filterCurrent.classList.toggle('active', mode === 'current');
    el.filterAll.classList.toggle('active', mode === 'all');
    loadList();
}

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
quill.on('text-change', () => { markDirty(); updateEmptyHint(); });

el.search.addEventListener('input', () => loadList());

el.filterCurrent.addEventListener('click', () => setFilterMode('current'));
el.filterAll.addEventListener('click', () => setFilterMode('all'));

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
    if (filterMode === 'current') loadList();
});

window.addEventListener('beforeunload', (e) => {
    if (!_loading && isDirtyNow()) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void saveNote();
    }
});

updateToolbarButtons();
updateLockOverlay();

