'use strict';
/**
 * Fingerprint service: applies UA/language/timezone from proxy profiles to tabs.
 *
 * UA + language → session.setUserAgent (no CDP, safe from CF Turnstile detection).
 * Timezone → CDP Emulation.setTimezoneOverride (per-webContents, only when CDP debugger is attached).
 */
function createFingerprintService({ sysLog, safeCatch, getTabManager, getDb }) {
    async function applyFingerprintToWebContents(wc, fp) {
        if (process.env.CUPNET_DISABLE_FINGERPRINT === '1') return;
        if (!fp || !wc || wc.isDestroyed()) return;
        if (fp.user_agent) {
            try {
                wc.session.setUserAgent(fp.user_agent, fp.language || '');
            } catch (e) {
                sysLog('warn', 'fingerprint', 'setUserAgent failed: ' + (e?.message || e));
            }
        }
        if (fp.timezone) {
            try {
                const dbg = wc.debugger;
                if (dbg.isAttached()) {
                    await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: fp.timezone });
                }
            } catch (e) {
                sysLog('info', 'fingerprint', 'setTimezoneOverride skipped: ' + (e?.message || e));
            }
        }
    }

    async function applyFingerprintToAllTabs(fp) {
        const tabManager = typeof getTabManager === 'function' ? getTabManager() : null;
        if (!tabManager) return;
        for (const tab of tabManager.getAllTabs()) {
            if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                await applyFingerprintToWebContents(tab.view.webContents, fp).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'fingerprint.apply.failed', context: { tabId: tab.id } }, err, 'info');
                });
            }
        }
    }

    /**
     * Apply fingerprint from a proxy profile to a specific tab's webContents.
     * Called when per-tab proxy is selected.
     */
    async function applyFingerprintFromProfile(wc, proxyProfileId) {
        if (!proxyProfileId || !wc || wc.isDestroyed()) return;
        const db = typeof getDb === 'function' ? getDb() : null;
        if (!db) return;
        const profile = db.getProxyProfileEncrypted(proxyProfileId);
        if (!profile) return;
        await applyFingerprintToWebContents(wc, {
            user_agent: profile.user_agent || null,
            language:   profile.language   || null,
            timezone:   profile.timezone   || null,
        });
    }

    async function resetFingerprintOnWebContents(wc) {
        if (!wc || wc.isDestroyed()) return;
        try {
            const { session: electronSession } = require('electron');
            const def = electronSession.defaultSession.getUserAgent();
            wc.session.setUserAgent(def);
        } catch (e) {
            sysLog('warn', 'fingerprint', 'resetFingerprintOnWebContents failed: ' + (e?.message || e));
        }
        try {
            const dbg = wc.debugger;
            if (dbg.isAttached()) {
                await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: '' });
            }
        } catch {}
    }

    return {
        applyFingerprintToWebContents,
        applyFingerprintToAllTabs,
        applyFingerprintFromProfile,
        resetFingerprintOnWebContents,
    };
}

module.exports = { createFingerprintService };
