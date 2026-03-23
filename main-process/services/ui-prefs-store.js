'use strict';
/**
 * UI-настройки, общие для вкладок (userData/ui-prefs.json).
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let _prefsPath = null;
let _cached = null;

function _resolvePath() {
    if (!_prefsPath) _prefsPath = path.join(app.getPath('userData'), 'ui-prefs.json');
    return _prefsPath;
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
        fs.writeFileSync(_resolvePath(), JSON.stringify(prefs, null, 2), 'utf8');
    } catch (e) {
        console.error('[ui-prefs] write error:', e.message);
    }
}

module.exports = {
    loadUiPrefs,
    saveUiPref,
};
