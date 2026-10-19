'use strict';

/**
 * Capture-phase clipboard unblock (Don't F*** With Paste pattern).
 * Must run before page scripts register their own capture listeners — preload injects via sync IPC.
 */
// No page-visible marker global (a `window.__cupnet*` property is a CupNet fingerprint): a re-inject
// just adds one more identical capture listener, which is harmless.
const PASTE_UNLOCK_SCRIPT = `(function () {
    const unblock = (e) => { e.stopImmediatePropagation(); return true; };
    ['copy', 'cut', 'paste', 'contextmenu'].forEach(t =>
        document.addEventListener(t, unblock, true)
    );
})();`;

function getPasteUnlockScript() {
    return PASTE_UNLOCK_SCRIPT;
}

module.exports = {
    PASTE_UNLOCK_SCRIPT,
    getPasteUnlockScript,
};
