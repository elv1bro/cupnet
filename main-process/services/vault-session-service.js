'use strict';

const { powerMonitor } = require('electron');
const profileSession = require('./profile-session.js');
const {
    verifyVaultPassword,
    deriveSessionKeyFromVerifyBlob,
    createVaultVerifyBlob,
    isCv02Blob,
} = require('../../credentials-crypto.js');

/** @type {Map<number, { key: Buffer, name: string }>} */
const _vaultKeys = new Map();
let _activeVaultId = null;

/** @type {Map<number, { fails: number, lockedUntil: number }>} */
const _unlockAttempts = new Map();

let _autoLockMinutes = 15;
let _idleTimer = null;
let _onLockCallbacks = [];

function configure(opts = {}) {
    if (Number.isFinite(opts.autoLockMinutes) && opts.autoLockMinutes >= 0) {
        _autoLockMinutes = Math.max(0, Math.floor(opts.autoLockMinutes));
    }
}

function onLock(cb) {
    if (typeof cb === 'function') _onLockCallbacks.push(cb);
}

function _zeroKey(key) {
    if (key && Buffer.isBuffer(key)) key.fill(0);
}

function _notifyLock() {
    for (const cb of _onLockCallbacks) {
        try { cb(); } catch { /* ignore */ }
    }
}

function _clearIdleTimer() {
    if (_idleTimer) {
        clearTimeout(_idleTimer);
        _idleTimer = null;
    }
}

function _scheduleIdleLock() {
    _clearIdleTimer();
    if (_autoLockMinutes <= 0 || _vaultKeys.size === 0) return;
    _idleTimer = setTimeout(() => {
        // Profile workspace stays unlocked until explicit sign-out or OS lock/suspend.
        if (profileSession.isProfileActive()) return;
        lockAll('idle');
    }, _autoLockMinutes * 60 * 1000);
    if (_idleTimer.unref) _idleTimer.unref();
}

function bumpActivity() {
    if (_vaultKeys.size > 0) _scheduleIdleLock();
}

function _checkRateLimit(vaultId) {
    const st = _unlockAttempts.get(vaultId) || { fails: 0, lockedUntil: 0 };
    const now = Date.now();
    if (st.lockedUntil > now) {
        const sec = Math.ceil((st.lockedUntil - now) / 1000);
        return { ok: false, error: `Too many attempts. Try again in ${sec}s`, retryAfterSec: sec };
    }
    return { ok: true };
}

function _recordUnlockFail(vaultId) {
    const st = _unlockAttempts.get(vaultId) || { fails: 0, lockedUntil: 0 };
    st.fails += 1;
    if (st.fails >= 10) st.lockedUntil = Date.now() + 5 * 60 * 1000;
    else if (st.fails >= 5) st.lockedUntil = Date.now() + 30 * 1000;
    _unlockAttempts.set(vaultId, st);
}

function _recordUnlockSuccess(vaultId) {
    _unlockAttempts.delete(vaultId);
}

function getActiveVaultId() {
    return _activeVaultId;
}

function isVaultUnlocked(vaultId) {
    const id = vaultId != null ? Number(vaultId) : _activeVaultId;
    return id != null && _vaultKeys.has(id);
}

function getMasterKey(vaultId) {
    const id = vaultId != null ? Number(vaultId) : _activeVaultId;
    if (id == null) return null;
    return _vaultKeys.get(id)?.key ?? null;
}

function getVaultName(vaultId) {
    const id = vaultId != null ? Number(vaultId) : _activeVaultId;
    if (id == null) return '';
    return _vaultKeys.get(id)?.name ?? '';
}

/**
 * Unlock vault — derives session key, does not retain password string.
 * @param {{ vaultId: number, name: string, password: string, verifyBlob: Buffer }} opts
 */
async function unlockVault(opts) {
    const vaultId = Number(opts.vaultId);
    const password = String(opts.password || '');
    const verifyBlob = opts.verifyBlob;
    const name = String(opts.name || '');

    const rate = _checkRateLimit(vaultId);
    if (!rate.ok) return { success: false, error: rate.error, retryAfterSec: rate.retryAfterSec };

    const ok = await verifyVaultPassword(verifyBlob, password);
    if (!ok) {
        _recordUnlockFail(vaultId);
        return { success: false, error: 'Invalid password' };
    }

    const key = await deriveSessionKeyFromVerifyBlob(verifyBlob, password);
    if (!key || key.length !== 32) {
        return { success: false, error: 'Could not derive session key' };
    }

    const prev = _vaultKeys.get(vaultId);
    if (prev?.key) _zeroKey(prev.key);

    _vaultKeys.set(vaultId, { key, name });
    _activeVaultId = vaultId;
    _recordUnlockSuccess(vaultId);
    profileSession.activateProfile({ vaultId, name });
    _scheduleIdleLock();

    let upgradedVerifyBlob = null;
    if (verifyBlob && !isCv02Blob(verifyBlob)) {
        upgradedVerifyBlob = await createVaultVerifyBlob(password);
    }

    return { success: true, vaultId, name, upgradedVerifyBlob };
}

function lockVault(vaultId, reason) {
    const id = vaultId != null ? Number(vaultId) : _activeVaultId;
    if (id == null) return;
    const entry = _vaultKeys.get(id);
    if (entry?.key) _zeroKey(entry.key);
    _vaultKeys.delete(id);
    if (_activeVaultId === id) _activeVaultId = null;
    if (_vaultKeys.size === 0) {
        _clearIdleTimer();
        profileSession.clearProfileSession();
        _notifyLock();
    }
}

function lockAll(reason) {
    for (const [id, entry] of _vaultKeys) {
        if (entry?.key) _zeroKey(entry.key);
        _vaultKeys.delete(id);
    }
    _activeVaultId = null;
    _clearIdleTimer();
    profileSession.clearProfileSession();
    _notifyLock();
}

function _initPowerMonitor() {
    if (_powerInit) return;
    _powerInit = true;
    try {
        powerMonitor.on('lock-screen', () => lockAll('lock-screen'));
        powerMonitor.on('suspend', () => lockAll('suspend'));
    } catch { /* ignore headless */ }
}
let _powerInit = false;

function initFromSettings(settings) {
    configure({
        autoLockMinutes: settings?.vaultAutoLockMinutes ?? 15,
    });
    _initPowerMonitor();
}

function _resetForTests() {
    lockAll('test');
    _unlockAttempts.clear();
    _onLockCallbacks = [];
    _autoLockMinutes = 15;
}

module.exports = {
    configure,
    onLock,
    bumpActivity,
    unlockVault,
    lockVault,
    lockAll,
    getActiveVaultId,
    isVaultUnlocked,
    getMasterKey,
    getVaultName,
    initFromSettings,
    _resetForTests,
};
