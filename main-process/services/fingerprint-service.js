'use strict';
/**
 * Переопределение UA/языка на уровне session (без CDP).
 * Раньше использовался debugger.attach + Emulation.* — это ломало Cloudflare Turnstile
 * (детект автоматизации) и конфликтовало с логированием по CDP.
 */
function createFingerprintService({ sysLog, safeCatch, getTabManager }) {
    async function applyFingerprintToWebContents(wc, fp) {
        if (!fp || !wc || wc.isDestroyed()) return;
        if (fp.user_agent) {
            try {
                wc.session.setUserAgent(fp.user_agent, fp.language || '');
            } catch (e) {
                sysLog('warn', 'fingerprint', 'setUserAgent failed: ' + (e?.message || e));
            }
        }
        // Часовой пояс без CDP здесь не переопределяем (нужен Emulation.setTimezoneOverride).
    }

    async function applyFingerprintToAllTabs(fp) {
        const tabManager = typeof getTabManager === 'function' ? getTabManager() : null;
        if (!tabManager) return;
        for (const tab of tabManager.getAllTabs()) {
            if (tab.direct) continue;
            if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
                await applyFingerprintToWebContents(tab.view.webContents, fp).catch((err) => {
                    safeCatch({ module: 'main', eventCode: 'fingerprint.apply.failed', context: { tabId: tab.id } }, err, 'info');
                });
            }
        }
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
    }

    return {
        applyFingerprintToWebContents,
        applyFingerprintToAllTabs,
        resetFingerprintOnWebContents,
    };
}

module.exports = { createFingerprintService };
