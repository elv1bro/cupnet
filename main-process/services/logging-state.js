'use strict';

/**
 * Shared "recording enabled" flag for modules that cannot receive getIsLoggingEnabled via factory
 * (e.g. tab-manager storage inject). Wired from cupnet-runtime after isLoggingEnabled exists.
 */
let _get = () => false;

function setGetIsLoggingEnabled(fn) {
    _get = typeof fn === 'function' ? fn : () => false;
}

function isRecordingEnabled() {
    try {
        return !!_get();
    } catch {
        return false;
    }
}

module.exports = { setGetIsLoggingEnabled, isRecordingEnabled };
