'use strict';

const api = window.electronAPI;

const screenPicker = document.getElementById('pg-screen-picker');
const screenPassword = document.getElementById('pg-screen-password');
const screenEdit = document.getElementById('pg-screen-edit');
const profileGrid = document.getElementById('pg-profile-grid');
const pickerSub = document.getElementById('pg-picker-sub');

const passwordAvatar = document.getElementById('pg-password-avatar');
const passwordName = document.getElementById('pg-password-name');
const passwordInput = document.getElementById('pg-password');
const signinBtn = document.getElementById('pg-signin-btn');
const signinError = document.getElementById('pg-error');
const backFromPassword = document.getElementById('pg-back-from-password');

const editEyebrow = document.getElementById('pg-edit-eyebrow');
const editTitle = document.getElementById('pg-edit-title');
const editAvatar = document.getElementById('pg-edit-avatar');
const editColorsEl = document.getElementById('pg-edit-colors');
const editName = document.getElementById('pg-edit-name');
const editPassword = document.getElementById('pg-edit-password');
const editConfirm = document.getElementById('pg-edit-confirm');
const editSaveBtn = document.getElementById('pg-edit-save');
const editCancelBtn = document.getElementById('pg-edit-cancel');
const editError = document.getElementById('pg-edit-error');
const closeBtn = document.getElementById('pg-close');

let gateState = null;
let selectedProfile = null;
/** @type {'create'|'setup'} */
let editMode = 'create';
let legacyVaultId = null;
let autoSetupLaunched = false;

const editPick = { color: '#3b82f6', colorManual: false };

function showScreen(name) {
    for (const el of [screenPicker, screenPassword, screenEdit]) {
        el?.classList.add('hidden');
    }
    if (name === 'picker') screenPicker?.classList.remove('hidden');
    if (name === 'password') screenPassword?.classList.remove('hidden');
    if (name === 'edit') screenEdit?.classList.remove('hidden');
}

function setError(el, msg) {
    if (el) el.textContent = msg || '';
}

function profileInitials(name) {
    const raw = String(name || '').trim();
    if (!raw) return '?';
    const parts = raw.split(/[\s·\-_]+/).filter(Boolean);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    if (raw.length >= 2) return raw.slice(0, 2).toUpperCase();
    return raw[0].toUpperCase();
}

function defaultColorForName(name) {
    const colors = gateState?.avatarOptions?.colors || ['#3b82f6'];
    const s = String(name || '').trim().toLowerCase();
    if (!s) return colors[0];
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return colors[h % colors.length];
}

function applyAvatarEl(el, name, color) {
    if (!el) return;
    const c = color || '#3b82f6';
    el.style.background = `linear-gradient(145deg, ${c} 0%, ${c}dd 100%)`;
    el.textContent = profileInitials(name);
}

function displayName(p) {
    if (!p) return 'Profile';
    if (p.name === 'Default' && gateState?.mode === 'setup') return 'Primary workspace';
    return p.name || `Profile ${p.id}`;
}

function avatarDisplayName(p) {
    if (!p) return '';
    if (p.name === 'Default' && gateState?.mode === 'setup') return '';
    return p.name || '';
}

function formatLastLogin(iso) {
    if (!iso) return null;
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        const now = new Date();
        const diffMs = now - d;
        const diffDays = Math.floor(diffMs / 86400000);
        if (diffDays === 0) return 'Active today';
        if (diffDays === 1) return 'Active yesterday';
        if (diffDays < 14) return `Active ${diffDays} days ago`;
        return `Last active ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    } catch {
        return null;
    }
}

function profileMeta(p) {
    if (!p) return '';
    const parts = [];
    if (typeof p.credentialCount === 'number' && p.credentialCount > 0) {
        parts.push(`${p.credentialCount} credential${p.credentialCount === 1 ? '' : 's'}`);
    }
    const last = formatLastLogin(p.lastLoginAt);
    if (last) parts.push(last);
    return parts.join(' · ') || 'Encrypted vault';
}

function profileNeedsSetup(p) {
    if (p?.needsSetup === true) return true;
    if (gateState?.mode !== 'setup') return false;
    if (p.id === gateState.legacyVaultId) return true;
    if (gateState.profiles?.length === 1 && p.id === gateState.profiles[0].id) return true;
    if (String(p.name || '').trim() === 'Default') return true;
    return false;
}

function makeAvatarEl(p, extraClass) {
    const el = document.createElement('div');
    el.className = 'pg-avatar' + (extraClass ? ` ${extraClass}` : '');
    applyAvatarEl(el, avatarDisplayName(p) || displayName(p), p.avatarColor);
    return el;
}

function renderPicker() {
    if (!profileGrid) return;
    profileGrid.innerHTML = '';
    const profiles = gateState?.profiles || [];

    if (gateState?.mode === 'setup' && pickerSub) {
        pickerSub.classList.remove('hidden');
        pickerSub.textContent = 'Set up your primary profile — choose a display name, accent color, and password.';
    } else if (pickerSub) {
        pickerSub.classList.add('hidden');
    }

    for (const p of profiles) {
        const needsSetup = profileNeedsSetup(p);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'pg-profile-card';
        card.appendChild(makeAvatarEl(p));
        const nameEl = document.createElement('span');
        nameEl.className = 'pg-profile-name';
        nameEl.textContent = displayName(p);
        card.appendChild(nameEl);
        const metaEl = document.createElement('span');
        metaEl.className = 'pg-profile-meta';
        metaEl.textContent = needsSetup ? 'Setup required' : profileMeta(p);
        card.appendChild(metaEl);
        if (needsSetup) {
            const badge = document.createElement('span');
            badge.className = 'pg-profile-badge';
            badge.textContent = 'Setup';
            card.appendChild(badge);
        }
        card.addEventListener('click', () => {
            if (needsSetup) openEditScreen('setup', p);
            else openPasswordScreen(p);
        });
        profileGrid.appendChild(card);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pg-profile-card add';
    const addAvatar = document.createElement('div');
    addAvatar.className = 'pg-avatar add-icon';
    addAvatar.textContent = '+';
    addBtn.appendChild(addAvatar);
    const addLabel = document.createElement('span');
    addLabel.className = 'pg-profile-name';
    addLabel.textContent = 'New profile';
    addBtn.appendChild(addLabel);
    const addMeta = document.createElement('span');
    addMeta.className = 'pg-profile-meta';
    addMeta.textContent = 'Separate vault';
    addBtn.appendChild(addMeta);
    addBtn.addEventListener('click', () => openEditScreen('create', null));
    profileGrid.appendChild(addBtn);
}

function maybeAutoOpenSetup() {
    if (autoSetupLaunched || gateState?.mode !== 'setup') return;
    const profiles = gateState?.profiles || [];
    if (profiles.length === 0) {
        autoSetupLaunched = true;
        openEditScreen('setup', null);
        return;
    }
    const setupProfile = profiles.find((p) => profileNeedsSetup(p));
    if (setupProfile) {
        autoSetupLaunched = true;
        openEditScreen('setup', setupProfile);
    }
}

function openPasswordScreen(p) {
    selectedProfile = p;
    setError(signinError, '');
    passwordInput.value = '';
    applyAvatarEl(passwordAvatar, p.name, p.avatarColor);
    if (passwordName) {
        passwordName.textContent = displayName(p);
    }
    showScreen('password');
    setTimeout(() => passwordInput?.focus(), 80);
}

function buildColorPicker() {
    if (!editColorsEl || !gateState?.avatarOptions) return;
    const { colors } = gateState.avatarOptions;
    editColorsEl.innerHTML = '';

    for (const color of colors) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.color = color;
        btn.className = 'pg-color-pick' + (editPick.color === color ? ' selected' : '');
        btn.style.background = color;
        btn.addEventListener('click', () => {
            editPick.color = color;
            editPick.colorManual = true;
            syncColorPickerSelection();
            updateEditPreview();
        });
        editColorsEl.appendChild(btn);
    }
}

function syncColorPickerSelection() {
    if (!editColorsEl) return;
    for (const btn of editColorsEl.querySelectorAll('.pg-color-pick')) {
        btn.classList.toggle('selected', btn.dataset.color === editPick.color);
    }
}

function updateEditPreview() {
    const name = (editName?.value || '').trim();
    if (!editPick.colorManual) {
        editPick.color = defaultColorForName(name);
        syncColorPickerSelection();
    }
    applyAvatarEl(editAvatar, name, editPick.color);
}

function openEditScreen(mode, profile) {
    editMode = mode;
    selectedProfile = profile;
    setError(editError, '');
    editPassword.value = '';
    editConfirm.value = '';

    if (mode === 'setup') {
        editEyebrow.textContent = 'First-time setup';
        editTitle.textContent = profile ? 'Configure your workspace' : 'Create your workspace';
        editSaveBtn.textContent = 'Complete setup';
        legacyVaultId = profile?.id ?? gateState?.legacyVaultId ?? null;
        editName.value = profile && profile.name !== 'Default' ? profile.name : (gateState?.suggestedName || '');
        editPick.color = profile?.avatarColor || defaultColorForName(editName.value);
        editPick.colorManual = !!profile?.avatarColor;
    } else {
        editEyebrow.textContent = 'New profile';
        editTitle.textContent = 'Add workspace profile';
        editSaveBtn.textContent = 'Create profile';
        legacyVaultId = null;
        editName.value = '';
        editPick.color = defaultColorForName('');
        editPick.colorManual = false;
    }

    buildColorPicker();
    updateEditPreview();
    showScreen('edit');
    setTimeout(() => editName?.focus(), 80);
}

async function initGate() {
    gateState = await api.profileGateStatus?.().catch(() => ({
        mode: 'setup',
        profiles: [],
        avatarOptions: { colors: [] },
    })) || { mode: 'setup', profiles: [] };

    legacyVaultId = gateState.legacyVaultId ?? null;
    showScreen('picker');
    renderPicker();
    maybeAutoOpenSetup();
}

async function doSignIn() {
    setError(signinError, '');
    const vaultId = selectedProfile?.id;
    const password = passwordInput?.value || '';
    if (!vaultId) return;
    if (!password) {
        setError(signinError, 'Enter your profile password.');
        return;
    }
    signinBtn.disabled = true;
    signinBtn.textContent = 'Unlocking…';
    try {
        const r = await api.profileLogin({ vaultId, password });
        if (!r?.success) setError(signinError, r?.error || 'Incorrect password.');
    } catch (e) {
        setError(signinError, String(e?.message || e));
    } finally {
        signinBtn.disabled = false;
        signinBtn.textContent = 'Unlock workspace';
    }
}

async function doEditSave() {
    setError(editError, '');
    const name = (editName?.value || '').trim();
    const password = editPassword?.value || '';
    const confirm = editConfirm?.value || '';
    if (!name) {
        setError(editError, 'Display name is required.');
        return;
    }
    if (password.length < 12) {
        setError(editError, 'Password must be at least 12 characters.');
        return;
    }
    if (password !== confirm) {
        setError(editError, 'Passwords do not match.');
        return;
    }

    editSaveBtn.disabled = true;
    const prevLabel = editSaveBtn.textContent;
    editSaveBtn.textContent = editMode === 'setup' ? 'Setting up…' : 'Creating…';

    try {
        let r;
        const payload = {
            name,
            password,
            confirm,
            avatarColor: editPick.color,
        };
        if (editMode === 'setup') {
            r = await api.profileCompleteSetup({
                ...payload,
                legacyVaultId: legacyVaultId ?? selectedProfile?.id ?? gateState?.legacyVaultId,
            });
        } else {
            r = await api.profileCreate(payload);
        }
        if (!r?.success) setError(editError, r?.error || 'Could not save profile.');
    } catch (e) {
        setError(editError, String(e?.message || e));
    } finally {
        editSaveBtn.disabled = false;
        editSaveBtn.textContent = prevLabel;
    }
}

signinBtn?.addEventListener('click', () => void doSignIn());
passwordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doSignIn();
});
backFromPassword?.addEventListener('click', () => {
    showScreen('picker');
    renderPicker();
});

editName?.addEventListener('input', () => updateEditPreview());
editSaveBtn?.addEventListener('click', () => void doEditSave());
editCancelBtn?.addEventListener('click', () => {
    showScreen('picker');
    renderPicker();
});
editConfirm?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doEditSave();
});

closeBtn?.addEventListener('click', () => {
    void api.profileGateQuit?.().catch(() => window.close());
});

function initAshParticles() {
    const container = document.getElementById('ash-canvas');
    if (!container) return;
    const COUNT = 24;
    const EMBER = ['#ff6a1a', '#ff7b20', '#ff8c2a', '#ffa040', '#ffb050'];
    const ASH = ['rgba(180,195,220,0.5)', 'rgba(190,200,225,0.4)', 'rgba(170,185,210,0.45)'];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < COUNT; i++) {
        const isEmber = i < COUNT * 0.6;
        const el = document.createElement('div');
        el.className = 'particle';
        const x = (Math.random() * 96 + 2).toFixed(1) + '%';
        const sz = (isEmber
            ? (Math.random() * 3 + 1.5)
            : (Math.random() * 4 + 1)).toFixed(1) + 'px';
        const dur = (Math.random() * 4 + 3).toFixed(2) + 's';
        const delay = (-Math.random() * 7).toFixed(2) + 's';
        const dist = '-' + (Math.random() * 40 + 30).toFixed(0) + 'vh';
        const dx0 = ((Math.random() - 0.5) * 20).toFixed(1) + 'px';
        const dx1 = ((Math.random() - 0.5) * 50).toFixed(1) + 'px';
        const peakA = isEmber
            ? (Math.random() * 0.5 + 0.3).toFixed(2)
            : (Math.random() * 0.3 + 0.15).toFixed(2);
        const color = isEmber
            ? EMBER[Math.floor(Math.random() * EMBER.length)]
            : ASH[Math.floor(Math.random() * ASH.length)];
        el.style.cssText = [
            `--x:${x}`, `--sz:${sz}`, `--dur:${dur}`, `--delay:${delay}`,
            `--dist:${dist}`, `--dx0:${dx0}`, `--dx1:${dx1}`,
            `--peak-a:${peakA}`, `--color:${color}`,
        ].join(';');
        fragment.appendChild(el);
    }
    container.appendChild(fragment);
}

initAshParticles();
void initGate();
