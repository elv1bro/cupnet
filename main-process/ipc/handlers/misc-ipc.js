'use strict';

/**
 * Uptime, splash, version, ui-pref, IP geo.
 * @param {object} ctx
 */
function registerMiscIpc(ctx) {
    const _appStartTime = Date.now();
    let _startupSplashConsumed = false;
    function consumeStartupSplashState() {
        if (_startupSplashConsumed) return { show: false, durationMs: 0 };
        _startupSplashConsumed = true;
        return { show: true, durationMs: 3000 };
    }
    ctx.ipcMain.handle('get-uptime', () => Date.now() - _appStartTime);
    ctx.ipcMain.handle('consume-startup-splash', () => consumeStartupSplashState());
    ctx.ipcMain.handle('get-app-version', () => ctx.app.getVersion());

    ctx.ipcMain.handle('get-ui-pref', (_, key, def) => {
        const v = ctx.uiPrefsStore.loadUiPrefs()[key];
        return v !== undefined ? v : (def !== undefined ? def : null);
    });
    ctx.ipcMain.handle('set-ui-pref', (_, key, value) => { ctx.uiPrefsStore.saveUiPref(key, value); return true; });

    ctx.ipcMain.handle('check-ip-geo', async () => ctx.checkCurrentIpGeo());

    ctx.ipcMain.handle('get-direct-ip', async () => {
        try {
            const directSess = ctx.session.fromPartition('direct-ip-check');
            await directSess.setProxy({ mode: 'direct' });
            const win = new ctx.BrowserWindow({ show: false, webPreferences: { session: directSess } });
            try {
                await win.loadURL('https://ipinfo.io/json');
                const text = await win.webContents.executeJavaScript('document.body.innerText');
                const d = JSON.parse(text);
                return { ip: d.ip || '', city: d.city || '', country: d.country || '', country_name: d.country || '', region: d.region || '', org: d.org || '' };
            } finally {
                win.destroy();
            }
        } catch (e) {
            ctx.sysLog('warn', 'direct-ip', 'Failed to get direct IP: ' + (e?.message || e));
            return { ip: '', city: '', country: '', country_name: '' };
        }
    });
}

module.exports = { registerMiscIpc };
