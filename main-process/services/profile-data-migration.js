'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const profileSession = require('./profile-session.js');
const settingsStore = require('./settings-store.js');

const MIGRATION_VERSION = 1;

function getMigrationStatePath() {
    return path.join(app.getPath('userData'), 'profile-migration-state.json');
}

function readMigrationState() {
    try {
        const raw = JSON.parse(fs.readFileSync(getMigrationStatePath(), 'utf8'));
        return raw && typeof raw === 'object' ? raw : { version: 0 };
    } catch {
        return { version: 0 };
    }
}

function writeMigrationState(state) {
    try {
        fs.writeFileSync(getMigrationStatePath(), JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.warn('[profile-migration] failed to write state:', e?.message || e);
    }
}

function getPrimaryVaultId(db) {
    try {
        const vaults = db.listVaults();
        if (!vaults.length) return null;
        return vaults.reduce((min, v) => (min == null || v.id < min ? v.id : min), null);
    } catch {
        return null;
    }
}

/**
 * One-time upgrade: legacy global settings + unscoped notes → first profile (lowest vault id).
 * Credentials vaults already map 1:1 to profiles; proxy_profiles stay shared in SQLite.
 *
 * @param {{ db: object, sysLog?: Function }} ctx
 * @returns {object} migration state
 */
function runProfileDataMigration(ctx) {
    let existing = readMigrationState();
    if (Number(existing.version) >= MIGRATION_VERSION) {
        return ensureProfileSetupFlag(existing);
    }

    const userData = app.getPath('userData');
    const globalSettings = path.join(userData, 'settings.json');
    const globalUi = path.join(userData, 'ui-prefs.json');
    const primaryVaultId = ctx.db ? getPrimaryVaultId(ctx.db) : null;

    let notesAssigned = 0;
    let vaultsEnsured = 0;

    if (ctx.db) {
        try {
            const vaults = ctx.db.listVaults();
            for (const v of vaults) {
                profileSession.ensureProfileDir(v.id);
                vaultsEnsured += 1;
            }
        } catch (e) {
            ctx.sysLog?.('warn', 'profile-migration', `vault dirs: ${e?.message || e}`);
        }

        if (primaryVaultId != null) {
            profileSession.seedProfileFromGlobal(primaryVaultId, globalSettings, globalUi);
            try {
                if (typeof ctx.db.migrateNotesToProfile === 'function') {
                    notesAssigned = ctx.db.migrateNotesToProfile(primaryVaultId);
                }
            } catch (e) {
                ctx.sysLog?.('warn', 'profile-migration', `notes: ${e?.message || e}`);
            }
        }
    }

    const state = {
        version: MIGRATION_VERSION,
        migratedAt: new Date().toISOString(),
        primaryVaultId,
        vaultsEnsured,
        notesAssigned,
        settingsSeededFromGlobal: primaryVaultId != null && fs.existsSync(globalSettings),
        uiPrefsSeededFromGlobal: primaryVaultId != null && fs.existsSync(globalUi),
        profileSetupComplete: false,
    };

    writeMigrationState(state);
    ctx.sysLog?.(
        'info',
        'profile-migration',
        `v${MIGRATION_VERSION} primaryVault=${primaryVaultId ?? 'none'} notes=${notesAssigned} vaultDirs=${vaultsEnsured}`,
    );
    return state;
}

/** Fresh profile folder for newly created profiles (no copy from global legacy). */
function initNewProfileDataFiles(vaultId) {
    const vid = Number(vaultId);
    if (!Number.isFinite(vid) || vid <= 0) return;
    profileSession.ensureProfileDir(vid);
    const settingsPath = profileSession.getProfileSettingsPath(vid);
    const uiPath = profileSession.getProfileUiPrefsPath(vid);
    if (!fs.existsSync(settingsPath)) {
        try {
            const fresh = settingsStore.buildFactoryResetSettings();
            fs.writeFileSync(settingsPath, JSON.stringify(fresh, null, 2), 'utf8');
        } catch { /* ignore */ }
    }
    if (!fs.existsSync(uiPath)) {
        try {
            fs.writeFileSync(uiPath, JSON.stringify({}, null, 2), 'utf8');
        } catch { /* ignore */ }
    }
}

function getPrimaryLegacyVaultId() {
    return readMigrationState().primaryVaultId ?? null;
}

/** Legacy installs must complete one-time profile setup (name, password, avatar). */
function needsProfileSetup(db = null) {
    if (process.env.CUPNET_E2E === '1' || process.env.CUPNET_SKIP_PROFILE_GATE === '1') {
        return false;
    }
    const state = readMigrationState();
    if (state.profileSetupCompletedAt) return false;

    if (state.profileSetupComplete === true) {
        // Recover from bogus auto-complete (e.g. old last_login_at heuristic).
        if (db && typeof db.getVaultById === 'function') {
            const vid = state.primaryVaultId ?? getPrimaryVaultId(db);
            const v = vid != null ? db.getVaultById(vid) : null;
            if (v && String(v.name || '').trim() === 'Default') return true;
        }
        return false;
    }
    return true;
}

function markProfileSetupComplete() {
    const state = {
        ...readMigrationState(),
        profileSetupComplete: true,
        profileSetupCompletedAt: new Date().toISOString(),
    };
    writeMigrationState(state);
    return state;
}

function ensureProfileSetupFlag(state) {
    if (state.profileSetupComplete === undefined) {
        state.profileSetupComplete = false;
        writeMigrationState(state);
    }
    return state;
}

module.exports = {
    MIGRATION_VERSION,
    runProfileDataMigration,
    initNewProfileDataFiles,
    readMigrationState,
    getPrimaryLegacyVaultId,
    needsProfileSetup,
    markProfileSetupComplete,
    ensureProfileSetupFlag,
};
