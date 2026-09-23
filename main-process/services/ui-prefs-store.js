'use strict';
/**
 * UI-настройки, общие для вкладок (userData/ui-prefs.json).
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { writeFileSecure, ensureSecureDir } = require('./secure-fs.js');

let _prefsPath = null;
let _cached = null;
let _activeProfileVaultId = null;

function _resolvePath() {
    if (_activeProfileVaultId != null) {
        return path.join(app.getPath('userData'), 'profiles', String(_activeProfileVaultId), 'ui-prefs.json');
    }
    if (!_prefsPath) _prefsPath = path.join(app.getPath('userData'), 'ui-prefs.json');
    return _prefsPath;
}

function setActiveProfileVaultId(vaultId) {
    _activeProfileVaultId = vaultId != null ? Number(vaultId) : null;
    _cached = null;
}

function reloadUiPrefs() {
    _cached = null;
    return loadUiPrefs();
}

function loadUiPrefs() {
    if (_cached) return _cached;
    try {
        _cached = JSON.parse(fs.readFileSync(_resolvePath(), 'utf8'));
    } catch {
        _cached = {};
    }
    return _cached;
}

function saveUiPref(key, value) {
    const prefs = loadUiPrefs();
    prefs[key] = value;
    try {
        const p = _resolvePath();
        ensureSecureDir(path.dirname(p));
        writeFileSecure(p, JSON.stringify(prefs, null, 2), 'utf8');
    } catch (e) {
        console.error('[ui-prefs] write error:', e.message);
    }
}

module.exports = {
    loadUiPrefs,
    saveUiPref,
    setActiveProfileVaultId,
    reloadUiPrefs,
};
