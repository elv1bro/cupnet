'use strict';

/**
 * Capture-phase clipboard unblock (Don't F*** With Paste pattern).
 * Must run before page scripts register their own capture listeners — preload injects via sync IPC.
 */
const PASTE_UNLOCK_SCRIPT = `(function () {
    if (window.__cupnetPasteUnlocked) return;
    window.__cupnetPasteUnlocked = true;
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
