'use strict';

/**
 * Global shortcuts while the user focuses a tab (WebContentsView): key events do not reach
 * browser.html, so use webContents `before-input-event` on the main shell and on each tab.
 *
 * Ctrl+` debounce: one physical press can be delivered twice (tab webContents, then shell);
 * module-level debounce merges into a single toggle (avoids open→immediate close).
 * Cmd/Ctrl+K and Ctrl+Shift+` (same key as switcher + Shift) use the same debounce for the palette.
 */
let _lastToggleWindowSwitcherSendAt = 0;
let _lastToggleCommandPaletteSendAt = 0;
const TOGGLE_WINDOW_SWITCHER_DEBOUNCE_MS = 150;

function _sendToggleWindowSwitcher(mw) {
    const now = Date.now();
    if (now - _lastToggleWindowSwitcherSendAt < TOGGLE_WINDOW_SWITCHER_DEBOUNCE_MS) return;
    _lastToggleWindowSwitcherSendAt = now;
    mw.webContents.send('toggle-window-switcher');
}

function _sendToggleCommandPalette(mw) {
    if (!mw || mw.isDestroyed()) return;
    const now = Date.now();
    if (now - _lastToggleCommandPaletteSendAt < TOGGLE_WINDOW_SWITCHER_DEBOUNCE_MS) return;
    _lastToggleCommandPaletteSendAt = now;
    mw.webContents.send('toggle-command-palette');
}

/** Cmd/Ctrl+K — must match shell palette; tab WebContentsView does not bubble keydown to browser.html. */
function _isCommandPaletteShortcut(input) {
    if (input.type !== 'keyDown' || input.isRepeat) return false;
    if (!input.control && !input.meta) return false;
    if (input.key === 'k' || input.key === 'K') return true;
    if (input.code === 'KeyK') return true;
    return false;
}

/** Ctrl+Shift+` (Backquote) — same physical key as window switcher, with Shift; `input.key` may be '~' on US. */
function _isCommandPaletteAltShortcut(input) {
    if (input.type !== 'keyDown' || input.isRepeat) return false;
    if (!input.control && !input.meta) return false;
    if (!input.shift) return false;
    if (input.code !== 'Backquote') return false;
    return true;
}

function _isAnyCommandPaletteToggleShortcut(input) {
    return _isCommandPaletteShortcut(input) || _isCommandPaletteAltShortcut(input);
}

/**
 * Ctrl+` — window switcher: shell receives IPC in browser.html.
 * Secondary windows: focus main, then toggle.
 * Main window shell only: before-input-event fires here when focus is in the toolbar/shell HTML.
 */
function attachWindowSwitcherHotkey(win, getMainWindow) {
    if (!win || win.isDestroyed()) return;
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.isRepeat) return;
        if (_isAnyCommandPaletteToggleShortcut(input)) {
            const mw = getMainWindow();
            if (!mw || mw.isDestroyed()) return;
            event.preventDefault();
            if (win.id !== mw.id) {
                mw.show();
                mw.focus();
            }
            _sendToggleCommandPalette(mw);
            return;
        }
        if (!input.control) return;
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
 * When focus is inside a tab WebContentsView, keyboard events go to the tab webContents, not the shell.
 * Attach the same shortcut so Ctrl+` works while the user interacts with a loaded site.
 */
function attachWindowSwitcherHotkeyToTabWebContents(webContents, getMainWindow) {
    if (!webContents || webContents.isDestroyed()) return;
    webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.isRepeat) return;
        const mw = getMainWindow();
        if (!mw || mw.isDestroyed()) return;
        const owner = typeof webContents.getOwnerBrowserWindow === 'function'
            ? webContents.getOwnerBrowserWindow()
            : null;
        if (owner && owner.id !== mw.id) return;
        if (_isAnyCommandPaletteToggleShortcut(input)) {
            event.preventDefault();
            _sendToggleCommandPalette(mw);
            return;
        }
        if (!input.control) return;
        if (input.key !== '`' && input.code !== 'Backquote') return;
        event.preventDefault();
        _sendToggleWindowSwitcher(mw);
    });
}

module.exports = { attachWindowSwitcherHotkey, attachWindowSwitcherHotkeyToTabWebContents };
