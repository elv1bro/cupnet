'use strict';

const path = require('path');
const profileSession = require('../../services/profile-session.js');
const settingsStore = require('../../services/settings-store.js');
const uiPrefsStore = require('../../services/ui-prefs-store.js');
const vaultSession = require('../../services/vault-session-service.js');
const { validatePassword } = require('../../services/password-policy.js');
const { createVaultVerifyBlob, verifyVaultPassword } = require('../../../credentials-crypto.js');
const { migrateNotesToMasterKey } = require('./notes-ipc.js');

// The password manager was removed; locking the session key (which still protects
// encrypted notes) is a direct vaultSession.lockAll call.
function clearCredentialsVaultSession() {
    vaultSession.lockAll('profile-session-clear');
}
const {
    initNewProfileDataFiles,
    needsProfileSetup,
    markProfileSetupComplete,
    readMigrationState,
    getPrimaryLegacyVaultId,
} = require('../../services/profile-data-migration.js');
const {
    PROFILE_AVATAR_COLORS,
    profileInitials,
    normalizeAvatarColor,
    defaultColorForName,
} = require('../../services/profile-avatars.js');

function clearProfileSession() {
    profileSession.clearProfileSession();
}

function applyProfileScopedStores(vaultId) {
    settingsStore.setActiveProfileVaultId(vaultId);
    uiPrefsStore.setActiveProfileVaultId(vaultId);
    settingsStore.reloadSettings();
    uiPrefsStore.reloadUiPrefs();
}

function mapProfileRow(v, db) {
    let credCount = 0;
    try {
        credCount = db.countActiveCredentialsForVault(v.id);
    } catch { /* ignore */ }
    return {
        id: v.id,
        name: v.name,
        hint: v.hint || '',
        lastLoginAt: v.last_login_at || null,
        avatarIcon: profileInitials(v.name),
        avatarColor: v.avatar_color || '#3b82f6',
        credentialCount: credCount,
    };
}

async function finishProfileLogin(ctx, { vaultId, name, password }) {
    const meta = ctx.db.getCredentialsVaultMeta(vaultId);
    const unlock = await vaultSession.unlockVault({
        vaultId,
        name,
        password,
        verifyBlob: meta?.verify_blob,
    });
    if (!unlock.success) {
        throw new Error(unlock.error || 'Unlock failed');
    }
    if (unlock.upgradedVerifyBlob) {
        ctx.db.updateCredentialsVaultVerifyBlob(vaultId, unlock.upgradedVerifyBlob);
    }
    ctx.db.updateVaultLastLogin(vaultId);
    applyProfileScopedStores(vaultId);
    try {
        migrateNotesToMasterKey(ctx.db, password);
    } catch { /* ignore */ }
    broadcastProfileSessionChanged(ctx);
    if (typeof ctx.onProfileLoggedIn === 'function') {
        await ctx.onProfileLoggedIn({ vaultId, name });
    }
}

function broadcastProfileSessionChanged(ctx) {
    try {
        const vaultId = profileSession.getActiveVaultId();
        let avatarColor = '#3b82f6';
        const name = profileSession.getProfileName();
        if (vaultId != null && ctx.db) {
            const v = ctx.db.getVaultById(vaultId);
            if (v?.avatar_color) avatarColor = v.avatar_color;
        }
        const payload = {
            active: profileSession.isProfileActive(),
            vaultId,
            name,
            avatarColor,
            initials: profileInitials(name),
        };
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
            ctx.mainWindow.webContents.send('profile-session-changed', payload);
        }
    } catch { /* ignore */ }
}

function profileRowNeedsSetup(setup, profile, legacyVaultId, profileCount) {
    if (!setup || !profile) return false;
    if (legacyVaultId != null && profile.id === legacyVaultId) return true;
    if (profileCount === 1) return true;
    if (String(profile.name || '').trim() === 'Default') return true;
    return false;
}

/**
 * Single-profile app: choose the one vault to expose to the UI (most-recently
 * used wins, with a stable id tiebreak). Any extra vault rows that exist in the
 * DB (e.g. from an older multi-profile build) are ignored everywhere, so the
 * gate and the status-bar panel only ever see one profile.
 * @param {Array<{id?: number, last_login_at?: string}>} rows
 */
function pickPrimaryVaultRow(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!list.length) return null;
    return list.slice().sort((a, b) => {
        const ta = Date.parse(a.last_login_at || '') || 0;
        const tb = Date.parse(b.last_login_at || '') || 0;
        if (tb !== ta) return tb - ta;
        return (a.id || 0) - (b.id || 0);
    })[0];
}

function registerProfileIpc(ctx) {
    const { guardIpcHandler } = require('../ipc-trusted-sender.js');
    const handle = (channel, fn) => ctx.ipcMain.handle(channel, guardIpcHandler(channel, fn));

    handle('profile-gate-status', () => {
        try {
            const setup = needsProfileSetup(ctx.db);
            // Single-profile app: expose only the primary vault, never a picker.
            const primaryRow = ctx.db ? pickPrimaryVaultRow(ctx.db.listVaults()) : null;
            const profiles = primaryRow ? [mapProfileRow(primaryRow, ctx.db)] : [];

            const migration = readMigrationState();
            let legacyVaultId = migration.primaryVaultId ?? getPrimaryLegacyVaultId();
            if (legacyVaultId == null && profiles.length === 1) {
                legacyVaultId = profiles[0].id;
            }
            const legacyProfile = legacyVaultId != null
                ? profiles.find((p) => p.id === legacyVaultId)
                : null;
            let legacyCredCount = 0;
            if (legacyVaultId != null && ctx.db) {
                legacyCredCount = ctx.db.countActiveCredentialsForVault(legacyVaultId);
            }
            const suggestedName = legacyProfile && legacyProfile.name !== 'Default'
                ? legacyProfile.name
                : '';

            const profilesWithSetup = profiles.map((p) => ({
                ...p,
                needsSetup: profileRowNeedsSetup(setup, p, legacyVaultId, profiles.length),
            }));

            return {
                mode: setup ? 'setup' : 'signin',
                profiles: profilesWithSetup,
                legacyVaultId,
                legacyCredCount,
                suggestedName,
                avatarOptions: {
                    colors: PROFILE_AVATAR_COLORS,
                },
            };
        } catch (e) {
            ctx.sysLog?.('warn', 'profile', String(e?.message || e));
            return {
                mode: 'setup',
                profiles: [],
                avatarOptions: { colors: PROFILE_AVATAR_COLORS },
            };
        }
    });

    handle('profile-list', () => {
        try {
            if (!ctx.db) return [];
            // Single-profile app: only the primary vault is ever listed.
            const primaryRow = pickPrimaryVaultRow(ctx.db.listVaults());
            return primaryRow ? [mapProfileRow(primaryRow, ctx.db)] : [];
        } catch {
            return [];
        }
    });

    handle('profile-session-status', () => {
        const vaultId = profileSession.getActiveVaultId();
        let avatarColor = '#3b82f6';
        const name = profileSession.getProfileName();
        if (vaultId != null && ctx.db) {
            const v = ctx.db.getVaultById(vaultId);
            if (v?.avatar_color) avatarColor = v.avatar_color;
        }
        return {
            active: profileSession.isProfileActive(),
            vaultId,
            name,
            avatarColor,
            initials: profileInitials(name),
            vaultUnlocked: vaultSession.isVaultUnlocked(vaultId),
        };
    });

    handle('profile-complete-setup', async (_, payload) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            if (!needsProfileSetup(ctx.db)) {
                return { success: false, error: 'Profile setup already completed' };
            }

            const name = String(payload?.name || '').trim();
            const password = String(payload?.password || '');
            const confirm = String(payload?.confirm || '');
            const avatarColor = normalizeAvatarColor(payload?.avatarColor || defaultColorForName(name));
            const avatarIcon = profileInitials(name);

            if (!name) return { success: false, error: 'Profile name is required' };
            const pwCheckSetup = validatePassword(password);
            if (!pwCheckSetup.ok) return { success: false, error: pwCheckSetup.error };
            if (password !== confirm) return { success: false, error: 'Passwords do not match' };

            const blob = await createVaultVerifyBlob(password);
            const migration = readMigrationState();
            const vaults = ctx.db.listVaults();
            let vaultId = Number(payload?.legacyVaultId) || migration.primaryVaultId || null;

            if (vaultId != null && !ctx.db.getVaultById(vaultId)) vaultId = null;
            if (vaultId == null && vaults.length === 1) vaultId = vaults[0].id;

            const userData = ctx.app.getPath('userData');
            const globalSettings = path.join(userData, 'settings.json');
            const globalUi = path.join(userData, 'ui-prefs.json');

            if (vaultId != null) {
                ctx.db.updateCredentialsVaultVerifyBlob(vaultId, blob);
                ctx.db.renameVault(vaultId, name);
                ctx.db.updateVaultAvatar(vaultId, avatarIcon, avatarColor);
                profileSession.ensureProfileDir(vaultId);
                profileSession.seedProfileFromGlobal(vaultId, globalSettings, globalUi);
            } else {
                vaultId = ctx.db.createVault(name, blob);
                ctx.db.updateVaultAvatar(vaultId, avatarIcon, avatarColor);
                initNewProfileDataFiles(vaultId);
                profileSession.seedProfileFromGlobal(vaultId, globalSettings, globalUi);
                try {
                    if (typeof ctx.db.migrateNotesToProfile === 'function') {
                        ctx.db.migrateNotesToProfile(vaultId);
                    }
                } catch { /* ignore */ }
            }

            markProfileSetupComplete();
            await finishProfileLogin(ctx, { vaultId, name, password });
            return { success: true, vaultId, name };
        } catch (e) {
            ctx.sysLog?.('warn', 'profile', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('profile-login', async (_, payload) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            if (needsProfileSetup(ctx.db)) {
                return { success: false, error: 'Complete profile setup first' };
            }
            const vaultId = Number(payload?.vaultId);
            const password = String(payload?.password || '');
            if (!Number.isFinite(vaultId) || vaultId <= 0) {
                return { success: false, error: 'Select a profile' };
            }
            if (!password) return { success: false, error: 'Password is required' };

            const meta = ctx.db.getCredentialsVaultMeta(vaultId);
            if (!meta) return { success: false, error: 'Profile not found' };
            if (!(await verifyVaultPassword(meta.verify_blob, password))) {
                return { success: false, error: 'Invalid password' };
            }

            vaultSession.lockAll('profile-switch');
            clearCredentialsVaultSession();
            await finishProfileLogin(ctx, { vaultId, name: meta.name, password });
            return { success: true, vaultId, name: meta.name };
        } catch (e) {
            ctx.sysLog?.('warn', 'profile', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    // Single-profile gate: creating additional profiles is not offered.

    handle('profile-logout', () => {
        vaultSession.lockAll('logout');
        clearCredentialsVaultSession();
        settingsStore.setActiveProfileVaultId(null);
        uiPrefsStore.setActiveProfileVaultId(null);
        settingsStore.reloadSettings();
        uiPrefsStore.reloadUiPrefs();
        broadcastProfileSessionChanged(ctx);
        return { success: true };
    });

    handle('profile-open-switch-gate', async () => {
        try {
            vaultSession.lockAll('switch-gate');
            clearCredentialsVaultSession();
            settingsStore.setActiveProfileVaultId(null);
            uiPrefsStore.setActiveProfileVaultId(null);
            settingsStore.reloadSettings();
            uiPrefsStore.reloadUiPrefs();
            broadcastProfileSessionChanged(ctx);
            if (typeof ctx.onProfileSwitchGate === 'function') {
                await ctx.onProfileSwitchGate();
            }
            return { success: true };
        } catch (e) {
            ctx.sysLog?.('warn', 'profile', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('profile-gate-quit', () => {
        try { ctx.app.quit(); } catch { /* ignore */ }
        return { success: true };
    });

    handle('vault-session-activity', () => {
        vaultSession.bumpActivity();
        return { success: true };
    });
}

module.exports = { registerProfileIpc, applyProfileScopedStores };
