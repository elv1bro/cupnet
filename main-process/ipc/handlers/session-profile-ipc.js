'use strict';

const { dialog } = require('electron');
const { parseLaunchProfile, summarizeSessionProfile } = require('../../../session-profile');
const { loadSessionProfile, loadSessionProfileFromJson } = require('../../services/session-profile-loader');
const { buildLaunchProfileFromRequest } = require('../../services/export-launch-profile');

/**
 * Session profile: load tab state from JSON file.
 * @param {object} ctx
 */
const LAST_LAUNCH_PROFILE_PATH_KEY = 'lastLaunchProfilePath';

function registerSessionProfileIpc(ctx) {
    ctx.ipcMain.handle('open-session-profile-modal', async () => {
        if (typeof ctx.createSessionProfileModalWindow === 'function') {
            ctx.createSessionProfileModalWindow();
            return { success: true };
        }
        return { success: false, error: 'Session profile dialog unavailable' };
    });

    ctx.ipcMain.on('close-session-profile-modal', () => {
        const win = ctx.sessionProfileModalWindow;
        if (win && !win.isDestroyed()) win.close();
    });

    ctx.ipcMain.handle('get-last-launch-profile-path', () => {
        const p = String(ctx.uiPrefsStore.loadUiPrefs()[LAST_LAUNCH_PROFILE_PATH_KEY] || '').trim();
        return p || '';
    });

    ctx.ipcMain.handle('set-last-launch-profile-path', (_, filePath) => {
        const p = String(filePath || '').trim();
        if (p) ctx.uiPrefsStore.saveUiPref(LAST_LAUNCH_PROFILE_PATH_KEY, p);
        return { success: true };
    });

    ctx.ipcMain.handle('pick-session-profile-file', async () => {
        const win = ctx.sessionProfileModalWindow && !ctx.sessionProfileModalWindow.isDestroyed?.()
            ? ctx.sessionProfileModalWindow
            : (ctx.mainWindow && !ctx.mainWindow.isDestroyed?.() ? ctx.mainWindow : null);
        const last = String(ctx.uiPrefsStore.loadUiPrefs()[LAST_LAUNCH_PROFILE_PATH_KEY] || '').trim();
        const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
            title: 'Import launch profile',
            properties: ['openFile'],
            defaultPath: last || undefined,
            filters: [
                { name: 'CupNet launch profile', extensions: ['json', 'cupnet-session', 'cupnet-launch'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (canceled || !filePaths?.[0]) return { success: false, canceled: true };
        const picked = filePaths[0];
        ctx.uiPrefsStore.saveUiPref(LAST_LAUNCH_PROFILE_PATH_KEY, picked);
        return { success: true, path: picked };
    });

    ctx.ipcMain.handle('read-session-profile-file', async (_, filePath) => {
        const fs = require('fs');
        const p = String(filePath || '').trim();
        if (!p) return { success: false, error: 'No file path' };
        try {
            const stat = fs.statSync(p);
            if (stat.size > 10 * 1024 * 1024) {
                return { success: false, error: 'File too large (max 10 MB)' };
            }
            const text = fs.readFileSync(p, 'utf8');
            const parsed = parseLaunchProfile(text);
            if (!parsed.ok) return { success: false, error: parsed.error };
            return {
                success: true,
                path: p,
                profile: parsed.profile,
                summary: summarizeSessionProfile(parsed.profile),
            };
        } catch (e) {
            return { success: false, error: e?.message || 'Could not read file' };
        }
    });

    ctx.ipcMain.handle('parse-session-profile-json', async (_, jsonStr) => {
        const parsed = parseLaunchProfile(jsonStr);
        if (!parsed.ok) return { success: false, error: parsed.error };
        return {
            success: true,
            profile: parsed.profile,
            summary: summarizeSessionProfile(parsed.profile),
        };
    });

    ctx.ipcMain.handle('validate-launch-profile', async (_, profile) => parseLaunchProfile(profile));

    ctx.ipcMain.handle('load-session-profile', async (_, payload) => {
        try {
            const body = payload && typeof payload === 'object' ? payload : {};
            if (body.sourcePath) {
                ctx.uiPrefsStore.saveUiPref(LAST_LAUNCH_PROFILE_PATH_KEY, String(body.sourcePath).trim());
            }
            let raw = body.profile;
            if (!raw && body.json) raw = body.json;
            if (!raw && body.filePath) {
                const fs = require('fs');
                raw = fs.readFileSync(String(body.filePath), 'utf8');
            }
            if (!raw) return { success: false, error: 'No session profile provided' };

            const opts = {};
            if (typeof raw !== 'object' || raw === null) {
                opts.urlOverride = body.urlOverride;
                opts.newTab = body.newTab;
            }

            const modal = ctx.sessionProfileModalWindow;
            if (modal && !modal.isDestroyed?.()) {
                modal.close();
            }

            void loadSessionProfileFromJson(ctx, raw, opts)
                .then((result) => {
                    const main = ctx.mainWindow && !ctx.mainWindow.isDestroyed?.() ? ctx.mainWindow : null;
                    if (!main) return;
                    if (result?.success) {
                        main.webContents.send('session-profile-loaded', result);
                    } else {
                        main.webContents.send('session-profile-load-failed', result);
                    }
                })
                .catch((e) => {
                    ctx.sysLog?.('error', 'session-profile', `Load failed: ${e?.message || e}`);
                    const main = ctx.mainWindow && !ctx.mainWindow.isDestroyed?.() ? ctx.mainWindow : null;
                    if (main) {
                        main.webContents.send('session-profile-load-failed', {
                            success: false,
                            error: e?.message || 'Load failed',
                        });
                    }
                });

            return { success: true, started: true };
        } catch (e) {
            ctx.sysLog?.('error', 'session-profile', `Load failed: ${e?.message || e}`);
            return { success: false, error: e?.message || 'Load failed' };
        }
    });

    ctx.ipcMain.handle('export-launch-profile-from-request', async (_, requestId) => {
        const fs = require('fs');
        const built = await buildLaunchProfileFromRequest(ctx, requestId);
        if (!built.success) return built;
        const parent = ctx.mainWindow && !ctx.mainWindow.isDestroyed?.() ? ctx.mainWindow : undefined;
        const { canceled, filePath } = await dialog.showSaveDialog(parent, {
            title: 'Export launch profile',
            defaultPath: `cupnet-launch-request-${built.requestId}.json`,
            filters: [
                { name: 'CupNet launch profile', extensions: ['json'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (canceled || !filePath) return { success: false, canceled: true };
        try {
            fs.writeFileSync(filePath, `${JSON.stringify(built.profile, null, 2)}\n`, 'utf8');
            ctx.sysLog?.('info', 'launch-profile', `Exported request #${built.requestId} → ${filePath}`);
            return { success: true, path: filePath, profile: built.profile };
        } catch (e) {
            return { success: false, error: e?.message || 'Could not write file' };
        }
    });

    ctx.ipcMain.handle('apply-launch-profile-from-request', async (_, requestId, opts = {}) => {
        try {
            const built = await buildLaunchProfileFromRequest(ctx, requestId);
            if (!built.success) return built;
            const loadOpts = {
                newTab: opts?.newTab != null ? !!opts.newTab : true,
                urlOverride: opts?.urlOverride,
            };
            return loadSessionProfile(ctx, built.profile, loadOpts);
        } catch (e) {
            return { success: false, error: e?.message || 'Apply failed' };
        }
    });
}

module.exports = { registerSessionProfileIpc };
