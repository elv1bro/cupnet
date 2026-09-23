'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { verifyVaultPassword, createVaultVerifyBlob } = require('../../credentials-crypto.js');
const { ensureSecureDir, hardenExistingFile } = require('./secure-fs.js');

/** @type {{ vaultId: number, name: string, password: string } | null} */
let _active = null;

function isProfileActive() {
    return _active != null;
}

function getActiveVaultId() {
    return _active?.vaultId ?? null;
}

function getProfilePassword() {
    return null;
}

function getProfileName() {
    return _active?.name ?? '';
}

function getProfileDir(vaultId) {
    return path.join(app.getPath('userData'), 'profiles', String(vaultId));
}

function getProfileSettingsPath(vaultId) {
    return path.join(getProfileDir(vaultId), 'settings.json');
}

function getProfileUiPrefsPath(vaultId) {
    return path.join(getProfileDir(vaultId), 'ui-prefs.json');
}

function ensureProfileDir(vaultId) {
    const dir = getProfileDir(vaultId);
    ensureSecureDir(dir);
    return dir;
}

/** Copy global settings into profile folder on first login. */
function seedProfileFromGlobal(vaultId, globalSettingsPath, globalUiPrefsPath) {
    ensureProfileDir(vaultId);
    const settingsPath = getProfileSettingsPath(vaultId);
    const uiPath = getProfileUiPrefsPath(vaultId);
    if (!fs.existsSync(settingsPath)) {
        try {
            if (fs.existsSync(globalSettingsPath)) {
                fs.copyFileSync(globalSettingsPath, settingsPath);
            }
        } catch { /* ignore */ }
    }
    if (!fs.existsSync(uiPath)) {
        try {
            if (fs.existsSync(globalUiPrefsPath)) {
                fs.copyFileSync(globalUiPrefsPath, uiPath);
            }
        } catch { /* ignore */ }
    }
}

function activateProfile({ vaultId, name }) {
    _active = {
        vaultId: Number(vaultId),
        name: String(name || ''),
    };
}

function clearProfileSession() {
    _active = null;
}

function verifyProfilePassword(verifyBlob, password) {
    return verifyVaultPassword(verifyBlob, password);
}

function createProfileVerifyBlob(password) {
    return createVaultVerifyBlob(password);
}

function shouldSkipProfileGate() {
    return process.env.CUPNET_E2E === '1' || process.env.CUPNET_SKIP_PROFILE_GATE === '1';
}

module.exports = {
    isProfileActive,
    getActiveVaultId,
    getProfilePassword,
    getProfileName,
    getProfileDir,
    getProfileSettingsPath,
    getProfileUiPrefsPath,
    ensureProfileDir,
    seedProfileFromGlobal,
    activateProfile,
    clearProfileSession,
    verifyProfilePassword,
    createProfileVerifyBlob,
    shouldSkipProfileGate,
};
