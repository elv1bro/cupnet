'use strict';
/**
 * Persistent app settings (settings.json), in-memory cache.
 * Sync effectiveTrafficMode → main process via configure({ onEffectiveTrafficModeLoaded }).
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { normalizeTrafficMode } = require('../../traffic-mode-router');
const { sysLog } = require('../../sys-log');

/** Schema version in settings.json — bump when adding migrations. */
const CURRENT_SETTINGS_VERSION = 1;

const SETTINGS_DEFAULTS = {
    _version: CURRENT_SETTINGS_VERSION,
    /** First-launch welcome wizard; forced false when no settings.json yet. */
    onboardingComplete: true,
    lastLogPath: null,
    filterPatterns: ['*google.com*', '*cloudflare.com*', '*analytics*', '*tracking*'],
    homepage: '',
    /** Open this many tabs without a confirmation when opening another (1–200). */
    maxTabsBeforeWarning: 10,
    pasteUnlock: true,
    currentProxy: '',
    effectiveTrafficMode: 'mitm',
    tracking: {
        onUserClick: true,
        onPageLoadComplete: true,
        onNetworkPendingChange: true,
        onMouseActivity: false,
        onTypingEnd: true,
        onScrollEnd: false,
        onRuleMatchScreenshot: true,
        pendingDeltaThreshold: 3,
        cooldownMs: 2000,
        maxPerMinute: 12,
    },
    trafficOpts: {
        trafficEnabled: false,
        blockImages: false,
        blockCSS: false,
        blockFonts: false,
        blockMedia: false,
        blockWebSocket: false,
        tlsPassthroughDomains: ['challenges.cloudflare.com'],
        captchaWhitelist: [
            '*.google.com', '*.gstatic.com', '*.recaptcha.net',
            'challenges.cloudflare.com', '*.cloudflare.com',
            '*.hcaptcha.com', 'turnstile.com', '*.turnstile.com',
        ],
    },
    /** Camera: enforce only all|none via session handlers; custom + order are UI / notes (stealth). */
    devicePermissions: {
        cameraMode: 'all',
        cameraPriority: [],
        cameraDisabledIds: [],
        /** Match by label — deviceId in Chromium depends on origin (file:// vs https://). */
        cameraDisabledLabels: [],
        microphoneMode: 'all',
        microphonePriority: [],
    },
    /** Log-viewer Activity Monitor: console, exceptions, storage, CSP (CDP Runtime/Log/DOMStorage). */
    activityMonitorEnabled: false,
    /** Max console API events per tab per second before coalescing into one "suppressed" row. */
    activityMonitorRateLimit: 100,
    /** Optional inject: wrap localStorage/sessionStorage for stack traces (not implemented in CDP path). */
    activityMonitorStorageStackTraces: false,
};

let _cached = null;
let _saveSettingsTimer = null;
let _onEffectiveTrafficModeLoaded = null;

function configure(opts = {}) {
    if (typeof opts.onEffectiveTrafficModeLoaded === 'function') {
        _onEffectiveTrafficModeLoaded = opts.onEffectiveTrafficModeLoaded;
    }
}

function getSettingsFilePath() {
    return path.join(app.getPath('userData'), 'settings.json');
}

function getCached() {
    return _cached;
}

function normalizeTrackingSettings(raw) {
    const base = SETTINGS_DEFAULTS.tracking;
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        onUserClick: src.onUserClick !== false,
        onPageLoadComplete: src.onPageLoadComplete !== false,
        onNetworkPendingChange: src.onNetworkPendingChange !== false,
        onMouseActivity: src.onMouseActivity === true,
        onTypingEnd: src.onTypingEnd !== false,
        onScrollEnd: src.onScrollEnd === true,
        onRuleMatchScreenshot: src.onRuleMatchScreenshot !== false,
        pendingDeltaThreshold: Math.max(1, Math.min(50, Number(src.pendingDeltaThreshold) || base.pendingDeltaThreshold)),
        cooldownMs: Math.max(200, Math.min(30000, Number(src.cooldownMs) || base.cooldownMs)),
        maxPerMinute: Math.max(1, Math.min(120, Number(src.maxPerMinute) || base.maxPerMinute)),
    };
}

/** Extra domains for captcha whitelist (older settings.json without them broke Turnstile with blockImages). */
const CAPTCHA_WL_RECOMMENDED = ['*.cloudflare.com', 'turnstile.com', '*.turnstile.com'];

function normalizeTrafficOpts(raw) {
    const base = SETTINGS_DEFAULTS.trafficOpts;
    const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
    const wl = Array.isArray(merged.captchaWhitelist) ? [...merged.captchaWhitelist] : [...(base.captchaWhitelist || [])];
    const norm = (s) => String(s || '').trim().toLowerCase();
    const have = new Set(wl.map(norm));
    for (const rec of CAPTCHA_WL_RECOMMENDED) {
        const k = norm(rec);
        if (k && !have.has(k)) {
            wl.push(rec);
            have.add(k);
        }
    }
    merged.captchaWhitelist = wl;
    return merged;
}

function normalizeDevicePermissions(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    let cameraMode = String(src.cameraMode || '').toLowerCase();
    if (cameraMode !== 'none' && cameraMode !== 'custom') cameraMode = 'all';
    const cameraPriority = Array.isArray(src.cameraPriority)
        ? src.cameraPriority.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    const cameraDisabledIds = Array.isArray(src.cameraDisabledIds)
        ? src.cameraDisabledIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    const cameraDisabledLabels = Array.isArray(src.cameraDisabledLabels)
        ? src.cameraDisabledLabels.map((s) => String(s || '').trim()).filter(Boolean)
        : [];
    let microphoneMode = String(src.microphoneMode || '').toLowerCase();
    if (microphoneMode !== 'none') microphoneMode = 'all';
    const microphonePriority = Array.isArray(src.microphonePriority)
        ? src.microphonePriority.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    return {
        cameraMode,
        cameraPriority,
        cameraDisabledIds,
        cameraDisabledLabels,
        microphoneMode,
        microphonePriority,
    };
}

function normalizeMaxTabsBeforeWarning(raw) {
    const n = Number(raw && raw.maxTabsBeforeWarning);
    if (Number.isFinite(n) && n >= 1) return Math.min(200, Math.floor(n));
    return SETTINGS_DEFAULTS.maxTabsBeforeWarning;
}

function settingsForDisk(s) {
    let out;
    try {
        out = JSON.parse(JSON.stringify(s));
    } catch {
        return s;
    }
    return out;
}

function _syncTrafficModeFromSettings() {
    if (_cached && _onEffectiveTrafficModeLoaded) {
        _onEffectiveTrafficModeLoaded(normalizeTrafficMode(_cached.effectiveTrafficMode));
    }
}

/**
 * Apply migrations from disk `raw` to current schema. Mutates conceptual copy; returns normalized flags.
 * @param {object} raw
 * @returns {{ migrated: boolean }}
 */
function migrateSettingsVersion(raw) {
    let v = Number(raw._version);
    if (!Number.isFinite(v) || v < 1) v = 0;
    let migrated = false;
    if (v < 1) {
        migrated = true;
        v = 1;
    }
    raw._version = CURRENT_SETTINGS_VERSION;
    return { migrated };
}

function materializeSettingsFromRaw(raw) {
    const merged = {
        ...SETTINGS_DEFAULTS,
        ...raw,
        trafficOpts: normalizeTrafficOpts(raw.trafficOpts),
        tracking: normalizeTrackingSettings(raw.tracking),
        devicePermissions: normalizeDevicePermissions(raw.devicePermissions),
        maxTabsBeforeWarning: normalizeMaxTabsBeforeWarning(raw),
        activityMonitorEnabled: raw.activityMonitorEnabled === true,
        activityMonitorRateLimit: Math.max(50, Math.min(500, Number(raw.activityMonitorRateLimit) || SETTINGS_DEFAULTS.activityMonitorRateLimit)),
        activityMonitorStorageStackTraces: raw.activityMonitorStorageStackTraces === true,
    };
    merged._version = CURRENT_SETTINGS_VERSION;
    if (merged.effectiveTrafficMode === 'browser_proxy') {
        merged.effectiveTrafficMode = 'mitm';
    }
    delete merged.capmonster;
    return merged;
}

/**
 * Build a fresh settings object (factory reset). Does not touch disk.
 */
function buildFactoryResetSettings() {
    return materializeSettingsFromRaw({
        ...SETTINGS_DEFAULTS,
        trafficOpts: {},
        tracking: undefined,
        devicePermissions: {},
        onboardingComplete: true,
    });
}

/**
 * Export-safe snapshot (no secrets).
 */
function exportSettingsSafe(s) {
    const out = JSON.parse(JSON.stringify(s || SETTINGS_DEFAULTS));
    out._exportMeta = {
        app: 'CupNet',
        exportedAt: new Date().toISOString(),
        settingsVersion: CURRENT_SETTINGS_VERSION,
    };
    return out;
}

/**
 * Deep-merge imported JSON into current settings. Unknown keys ignored at top level selectively.
 * @param {object} current from loadSettings()
 * @param {object} imported parsed object
 */
function mergeImportedSettings(current, imported) {
    if (!imported || typeof imported !== 'object') return current;
    const importedClean = { ...imported };
    delete importedClean._exportMeta;
    const next = { ...current };
    const keys = [
        'filterPatterns', 'homepage', 'maxTabsBeforeWarning', 'pasteUnlock',
        'currentProxy', 'effectiveTrafficMode', 'onboardingComplete',
        'activityMonitorEnabled', 'activityMonitorRateLimit', 'activityMonitorStorageStackTraces',
        'lastLogPath',
    ];
    for (const k of keys) {
        if (importedClean[k] !== undefined) next[k] = importedClean[k];
    }
    if (importedClean.tracking && typeof importedClean.tracking === 'object') {
        next.tracking = normalizeTrackingSettings({ ...current.tracking, ...importedClean.tracking });
    }
    if (importedClean.trafficOpts && typeof importedClean.trafficOpts === 'object') {
        next.trafficOpts = normalizeTrafficOpts({ ...current.trafficOpts, ...importedClean.trafficOpts });
    }
    if (importedClean.devicePermissions && typeof importedClean.devicePermissions === 'object') {
        next.devicePermissions = normalizeDevicePermissions({ ...current.devicePermissions, ...importedClean.devicePermissions });
    }
    next._version = CURRENT_SETTINGS_VERSION;
    return materializeSettingsFromRaw(next);
}

function loadSettings() {
    if (_cached) return _cached;
    const settingsFilePath = getSettingsFilePath();
    try {
        if (fs.existsSync(settingsFilePath)) {
            const raw = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
            const hadBrowserProxy = raw.effectiveTrafficMode === 'browser_proxy';
            const { migrated } = migrateSettingsVersion(raw);
            _cached = materializeSettingsFromRaw(raw);
            if (migrated || hadBrowserProxy) {
                saveSettings(_cached);
            }
            _syncTrafficModeFromSettings();
            return _cached;
        }
    } catch (e) {
        sysLog('warn', 'settings', 'Failed to load settings: ' + e.message);
    }
    _cached = {
        ...SETTINGS_DEFAULTS,
        trafficOpts: normalizeTrafficOpts({}),
        tracking: normalizeTrackingSettings(),
        devicePermissions: normalizeDevicePermissions(),
        maxTabsBeforeWarning: SETTINGS_DEFAULTS.maxTabsBeforeWarning,
        activityMonitorRateLimit: SETTINGS_DEFAULTS.activityMonitorRateLimit,
    };
    _cached._version = CURRENT_SETTINGS_VERSION;
    _cached.onboardingComplete = false;
    _syncTrafficModeFromSettings();
    return _cached;
}

function saveSettings(s) {
    _cached = s;
    if (_saveSettingsTimer) clearTimeout(_saveSettingsTimer);
    _saveSettingsTimer = setTimeout(() => {
        _saveSettingsTimer = null;
        fs.writeFile(getSettingsFilePath(), JSON.stringify(settingsForDisk(s), null, 2), (err) => {
            if (err) sysLog('warn', 'settings', 'Failed to save: ' + err.message);
        });
    }, 300);
}

function cancelPendingSave() {
    if (_saveSettingsTimer) {
        clearTimeout(_saveSettingsTimer);
        _saveSettingsTimer = null;
    }
}

module.exports = {
    SETTINGS_DEFAULTS,
    CURRENT_SETTINGS_VERSION,
    configure,
    getCached,
    getSettingsFilePath,
    loadSettings,
    saveSettings,
    cancelPendingSave,
    normalizeTrackingSettings,
    normalizeTrafficOpts,
    normalizeDevicePermissions,
    normalizeMaxTabsBeforeWarning,
    buildFactoryResetSettings,
    exportSettingsSafe,
    mergeImportedSettings,
};
