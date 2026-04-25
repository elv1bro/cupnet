'use strict';

/**
 * Canonical keyboard shortcuts (documentation + shared reference).
 * Main window implements Cmd/Ctrl+K (command palette) and related bindings in browser-renderer.js.
 */
const CUPNET_KEYBOARD_SHORTCUTS = [
    { id: 'commandPalette', label: 'Address bar: type > for commands (Cmd/Ctrl+K inserts >)', keys: 'CmdOrCtrl+K or Ctrl+Shift+`', scope: 'Global (main window)' },
    { id: 'settings', label: 'Open Settings', keys: 'CmdOrCtrl+,', scope: 'Main window' },
    { id: 'logViewer', label: 'Open Log Viewer', keys: 'Ctrl+L', scope: 'Main window' },
    { id: 'credentials', label: 'Open Credentials', keys: 'CmdOrCtrl+Shift+L', scope: 'Main window' },
    { id: 'proxyManager', label: 'Open Proxy Manager', keys: 'CmdOrCtrl+Shift+P', scope: 'Main window' },
    { id: 'addressBar', label: 'Focus address bar', keys: 'CmdOrCtrl+L', scope: 'Main window' },
    { id: 'findInPage', label: 'Find in page', keys: 'CmdOrCtrl+F', scope: 'Page / tools' },
    { id: 'save', label: 'Save (forms)', keys: 'CmdOrCtrl+S', scope: 'Editor windows' },
    { id: 'escape', label: 'Close modal / palette', keys: 'Escape', scope: 'Global' },
];

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CUPNET_KEYBOARD_SHORTCUTS };
}
if (typeof window !== 'undefined') {
    window.CUPNET_KEYBOARD_SHORTCUTS = CUPNET_KEYBOARD_SHORTCUTS;
}
