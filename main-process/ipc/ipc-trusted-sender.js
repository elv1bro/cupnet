'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

/** @type {Set<number>} Trusted BrowserWindow webContents ids (shell + tool windows). */
const _trustedShellIds = new Set();

/** Tab WebContentsView ids — never trusted for vault/proxy/cookies IPC. */
const _tabViewIds = new Set();

function registerTrustedShell(webContents) {
    if (!webContents || webContents.isDestroyed?.()) return;
    _trustedShellIds.add(webContents.id);
    webContents.once('destroyed', () => {
        _trustedShellIds.delete(webContents.id);
    });
}

function registerTabView(webContents) {
    if (!webContents || webContents.isDestroyed?.()) return;
    _tabViewIds.add(webContents.id);
    webContents.once('destroyed', () => {
        _tabViewIds.delete(webContents.id);
    });
}

function isTrustedShell(event) {
    const wc = event?.sender;
    if (!wc || wc.isDestroyed?.()) return false;
    if (_tabViewIds.has(wc.id)) return false;
    return _trustedShellIds.has(wc.id);
}

function assertTrustedShell(event, channel) {
    if (isTrustedShell(event)) return true;
    const err = new Error(`IPC channel "${channel}" is restricted to trusted application windows`);
    err.code = 'IPC_UNTRUSTED_SENDER';
    throw err;
}

/**
 * Wrap ipcMain.handle handler — rejects calls from tab renderers / unknown senders.
 * @param {string} channel
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: any[]) => any} handler
 */
function guardIpcHandler(channel, handler) {
    return async (event, ...args) => {
        assertTrustedShell(event, channel);
        return handler(event, ...args);
    };
}

/** For ipcMain.on / ipcMain.handle without invoke — same guard. */
function guardIpcListener(channel, handler) {
    return (event, ...args) => {
        try {
            assertTrustedShell(event, channel);
        } catch {
            return;
        }
        return handler(event, ...args);
    };
}


/** file: URL of the app directory (no trailing slash). Internal pages live under it. */
function appFileRoot() {
    return pathToFileURL(path.join(__dirname, '..', '..')).href.replace(/\/+$/, '');
}

function senderUrl(event) {
    try {
        const frameUrl = event?.senderFrame?.url;
        if (frameUrl) return String(frameUrl);
    } catch { /* ignore */ }
    try {
        return String(event?.sender?.getURL?.() || '');
    } catch {
        return '';
    }
}

/**
 * CupNet file: page under the app directory (new-tab, settings, error page).
 * about:blank and https pages are not internal, even when they share a tab WebContentsView.
 */
function isInternalFileSender(event) {
    const url = senderUrl(event);
    if (!url.startsWith('file:')) return false;
    const root = appFileRoot();
    return url === root || url.startsWith(root + '/');
}

function assertTrustedOrInternal(event, channel) {
    if (isTrustedShell(event) || isInternalFileSender(event)) return true;
    const err = new Error(`IPC channel "${channel}" is restricted to trusted application windows`);
    err.code = 'IPC_UNTRUSTED_SENDER';
    throw err;
}

/**
 * Trusted shell OR an internal file: page (new-tab widget). Web content is rejected.
 * @param {string} channel
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: any[]) => any} handler
 */
function guardIpcHandlerAllowInternal(channel, handler) {
    return async (event, ...args) => {
        assertTrustedOrInternal(event, channel);
        return handler(event, ...args);
    };
}

/** ipcMain.on variant: untrusted senders are ignored. */
function guardIpcListenerAllowInternal(channel, handler) {
    return (event, ...args) => {
        try {
            assertTrustedOrInternal(event, channel);
        } catch {
            return;
        }
        return handler(event, ...args);
    };
}

function _resetForTests() {
    _trustedShellIds.clear();
    _tabViewIds.clear();
}

module.exports = {
    registerTrustedShell,
    registerTabView,
    isTrustedShell,
    isInternalFileSender,
    assertTrustedShell,
    assertTrustedOrInternal,
    guardIpcHandler,
    guardIpcListener,
    guardIpcHandlerAllowInternal,
    guardIpcListenerAllowInternal,
    _resetForTests,
};
