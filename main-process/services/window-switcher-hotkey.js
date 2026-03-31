'use strict';

/**
 * One physical Ctrl+` can be delivered twice: first on the tab webContents, then after the
 * BrowserView is detached the shell may receive another keyDown for the same press.
 * Module-level debounce merges those into a single toggle (avoids open→immediate close).
 */
let _lastToggleWindowSwitcherSendAt = 0;
const TOGGLE_WINDOW_SWITCHER_DEBOUNCE_MS = 150;

function _sendToggleWindowSwitcher(mw) {
    const now = Date.now();
    if (now - _lastToggleWindowSwitcherSendAt < TOGGLE_WINDOW_SWITCHER_DEBOUNCE_MS) return;
    _lastToggleWindowSwitcherSendAt = now;
    mw.webContents.send('toggle-window-switcher');
}

/**
 * Ctrl+` — window switcher: shell receives IPC in browser.html.
 * Secondary windows: focus main, then toggle.
 * Main window shell only: before-input-event fires here when focus is in the toolbar/shell HTML.
 */
function attachWindowSwitcherHotkey(win, getMainWindow) {
    if (!win || win.isDestroyed()) return;
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !input.control) return;
        if (input.isRepeat) return;
        if (input.key !== '`' && input.code !== 'Backquote') return;
        const mw = getMainWindow();
        if (!mw || mw.isDestroyed()) return;
        event.preventDefault();
        if (win.id !== mw.id) {
            mw.show();
            mw.focus();
        }
        _sendToggleWindowSwitcher(mw);
    });
}

/**
 * When focus is inside a tab BrowserView, keyboard events go to the tab webContents, not the shell.
 * Attach the same shortcut so Ctrl+` works while the user interacts with a loaded site.
 */
function attachWindowSwitcherHotkeyToTabWebContents(webContents, getMainWindow) {
    if (!webContents || webContents.isDestroyed()) return;
    webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !input.control) return;
        if (input.isRepeat) return;
        if (input.key !== '`' && input.code !== 'Backquote') return;
        const mw = getMainWindow();
        if (!mw || mw.isDestroyed()) return;
        const owner = typeof webContents.getOwnerBrowserWindow === 'function'
            ? webContents.getOwnerBrowserWindow()
            : null;
        if (owner && owner.id !== mw.id) return;
        event.preventDefault();
        _sendToggleWindowSwitcher(mw);
    });
}

module.exports = { attachWindowSwitcherHotkey, attachWindowSwitcherHotkeyToTabWebContents };
