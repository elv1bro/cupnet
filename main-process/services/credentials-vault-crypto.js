'use strict';

const vaultSession = require('./vault-session-service.js');
const {
    encryptFieldForStorage,
    decryptFieldFromStorage,
} = require('../../credentials-crypto.js');

function requireUnlockedMasterKey() {
    const key = vaultSession.getMasterKey();
    if (!key) {
        const err = new Error('Vault is locked');
        err.code = 'CREDENTIALS_LOCKED';
        throw err;
    }
    vaultSession.bumpActivity();
    return key;
}

function enc(plaintextUtf8) {
    return encryptFieldForStorage(plaintextUtf8, requireUnlockedMasterKey());
}

function dec(buf, passwordFallback) {
    return decryptFieldFromStorage(buf, vaultSession.getMasterKey(), passwordFallback);
}

function isUnlocked() {
    return vaultSession.getActiveVaultId() != null && vaultSession.getMasterKey() != null;
}

function activeVaultId() {
    return vaultSession.getActiveVaultId();
}

module.exports = {
    vaultSession,
    requireUnlockedMasterKey,
    enc,
    dec,
    isUnlocked,
    activeVaultId,
};
