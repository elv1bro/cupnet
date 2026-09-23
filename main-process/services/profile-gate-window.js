'use strict';

const { BrowserWindow, screen } = require('electron');
const { registerTrustedShell } = require('../ipc/ipc-trusted-sender.js');

/**
 * Profile login gate — frameless splash before the main browser window.
 * @param {object} d — runtime deps
 */
function createProfileGateWindowApi(d) {
    let profileGateWindow = null;

    function closeProfileGate() {
        if (profileGateWindow && !profileGateWindow.isDestroyed()) {
            profileGateWindow.close();
        }
        profileGateWindow = null;
    }

    function openMainAfterLogin() {
        closeProfileGate();
        if (!d.mainWindow || d.mainWindow.isDestroyed()) {
            d.createMainWindow();
        } else {
            try {
                d.mainWindow.show();
                d.mainWindow.focus();
            } catch { /* ignore */ }
        }
        if (typeof d.syncAppContextSnapshot === 'function') d.syncAppContextSnapshot();
    }

    /** Hide main window and show profile picker (switch / add profile). */
    function openProfileSwitchGate() {
        if (d.mainWindow && !d.mainWindow.isDestroyed()) {
            try { d.mainWindow.hide(); } catch { /* ignore */ }
        }
        createProfileGateWindow();
    }

    function createProfileGateWindow() {
        if (profileGateWindow && !profileGateWindow.isDestroyed()) {
            profileGateWindow.focus();
            return profileGateWindow;
        }

        const W = 960;
        const H = 620;

        const winOpts = {
            width: W,
            height: H,
            minWidth: W,
            minHeight: H,
            maxWidth: W,
            maxHeight: H,
            center: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            frame: false,
            transparent: true,
            hasShadow: true,
            show: false,
            icon: d.iconPath,
            webPreferences: {
                preload: d.path.join(d.cupnetRoot, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        };

        if (process.platform === 'darwin') {
            winOpts.titleBarStyle = 'hidden';
            winOpts.backgroundMaterial = 'ultra-dark';
        }

        profileGateWindow = new BrowserWindow(winOpts);
        registerTrustedShell(profileGateWindow.webContents);

        try {
            profileGateWindow.setBackgroundColor('#00000000');
        } catch { /* ignore */ }

        profileGateWindow.loadFile(d.getAssetPath('profile-gate.html'));
        profileGateWindow.once('ready-to-show', () => {
            try { profileGateWindow.show(); } catch { /* ignore */ }
        });

        profileGateWindow.on('closed', () => {
            profileGateWindow = null;
            if (d.forceAppQuit) return;
            const hasMainWindow = d.mainWindow && !d.mainWindow.isDestroyed();
            if (hasMainWindow) {
                // Switch-gate was dismissed without logging in: the main window is only hidden,
                // so re-show it instead of leaving the app running with no visible window.
                // (On successful login openMainAfterLogin already showed it — show() is a no-op then.)
                try { d.mainWindow.show(); d.mainWindow.focus(); } catch { /* ignore */ }
            } else {
                // Initial gate cancelled before any main window existed → nothing to return to.
                try { d.app.quit(); } catch { /* ignore */ }
            }
        });

        return profileGateWindow;
    }

    return {
        createProfileGateWindow,
        closeProfileGate,
        openMainAfterLogin,
        openProfileSwitchGate,
        getProfileGateWindow: () => profileGateWindow,
    };
}

module.exports = { createProfileGateWindowApi };
