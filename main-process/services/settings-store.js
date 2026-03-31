'use strict';
/**
 * Персистентные настройки приложения (settings.json), CapMonster (M7), кэш в памяти.
 * Синхронизация effectiveTrafficMode → main-процесс через configure({ onEffectiveTrafficModeLoaded }).
 */
const path = require('path');
const fs = require('fs');
const { app, safeStorage } = require('electron');
const { normalizeTrafficMode } = require('../../traffic-mode-router');
const { sysLog } = require('../../sys-log');

const SETTINGS_DEFAULTS = {
    lastLogPath: null,
    filterPatterns: ['*google.com*', '*cloudflare.com*', '*analytics*', '*tracking*'],
    homepage: '',
    /** Open this many tabs without a confirmation when opening another (1–200). */
    maxTabsBeforeWarning: 10,
    pasteUnlock: true,
    traceMode: false,
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
    bypassDomains: ['challenges.cloudflare.com'],
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
    capmonster: {
        apiKey: '',
        autoInject: true,
        autoSubmit: false,
        pollTimeoutMs: 90000,
        pollIntervalMs: 3000,
    },
    /** Camera: enforce only all|none via session handlers; custom + order are UI / notes (stealth). */
    devicePermissions: {
        cameraMode: 'all',
        cameraPriority: [],
        cameraDisabledIds: [],
        /** Совпадение по label — deviceId в Chromium зависит от origin (file:// vs https://). */
        cameraDisabledLabels: [],
        microphoneMode: 'all',
        microphonePriority: [],
    },
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

/** Доп. домены для captcha whitelist (старые settings.json без них ломали Turnstile при blockImages). */
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

function normalizeCapmonsterSettings(raw) {
    const base = SETTINGS_DEFAULTS.capmonster;
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        apiKey: String(src.apiKey || '').trim(),
        autoInject: src.autoInject !== false,
        autoSubmit: src.autoSubmit === true,
        pollTimeoutMs: Math.max(30000, Math.min(180000, Number(src.pollTimeoutMs) || base.pollTimeoutMs)),
        pollIntervalMs: Math.max(1000, Math.min(10000, Number(src.pollIntervalMs) || base.pollIntervalMs)),
    };
}

/** Serialize settings for disk; encrypt CapMonster API key when safeStorage is available (M7). */
function settingsForDisk(s) {
    let out;
    try {
        out = JSON.parse(JSON.stringify(s));
    } catch {
        return s;
    }
    if (out.capmonster && typeof out.capmonster === 'object' && safeStorage.isEncryptionAvailable()) {
        const key = String(out.capmonster.apiKey || '').trim();
        if (key) {
            try {
                out.capmonster = {
                    ...out.capmonster,
                    apiKeyEnc: safeStorage.encryptString(key).toString('base64'),
                    apiKey: '',
                };
            } catch (e) {
                sysLog('warn', 'settings', 'capmonster encrypt failed: ' + (e?.message || e));
            }
        } else {
            delete out.capmonster.apiKeyEnc;
        }
    }
    return out;
}

function hydrateCapmonsterFromDisk(rawCm) {
    const base = normalizeCapmonsterSettings(rawCm);
    if (rawCm && typeof rawCm === 'object' && rawCm.apiKeyEnc && typeof rawCm.apiKeyEnc === 'string'
        && safeStorage.isEncryptionAvailable()) {
        try {
            const plain = safeStorage.decryptString(Buffer.from(rawCm.apiKeyEnc, 'base64'));
            base.apiKey = String(plain || '').trim();
        } catch (e) {
            sysLog('warn', 'settings', 'capmonster decrypt failed: ' + (e?.message || e));
        }
    }
    return base;
}

function _syncTrafficModeFromSettings() {
    if (_cached && _onEffectiveTrafficModeLoaded) {
        _onEffectiveTrafficModeLoaded(normalizeTrafficMode(_cached.effectiveTrafficMode));
    }
}

function loadSettings() {
    if (_cached) return _cached;
    const settingsFilePath = getSettingsFilePath();
    try {
        if (fs.existsSync(settingsFilePath)) {
            const raw = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
            _cached = {
                ...SETTINGS_DEFAULTS,
                ...raw,
                trafficOpts: normalizeTrafficOpts(raw.trafficOpts),
                tracking: normalizeTrackingSettings(raw.tracking),
                capmonster: hydrateCapmonsterFromDisk(raw.capmonster),
                devicePermissions: normalizeDevicePermissions(raw.devicePermissions),
                maxTabsBeforeWarning: normalizeMaxTabsBeforeWarning(raw),
            };
            if (_cached.effectiveTrafficMode === 'browser_proxy') {
                _cached.effectiveTrafficMode = 'mitm';
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
        capmonster: normalizeCapmonsterSettings(),
        devicePermissions: normalizeDevicePermissions(),
        maxTabsBeforeWarning: SETTINGS_DEFAULTS.maxTabsBeforeWarning,
    };
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
    configure,
    getCached,
    getSettingsFilePath,
    loadSettings,
    saveSettings,
    cancelPendingSave,
    normalizeTrackingSettings,
    normalizeTrafficOpts,
    normalizeCapmonsterSettings,
    normalizeDevicePermissions,
    normalizeMaxTabsBeforeWarning,
};
