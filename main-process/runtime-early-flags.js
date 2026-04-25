'use strict';

/**
 * Chromium command-line switches and early proxy-bypass hints (before app.whenReady).
 * Split from cupnet-runtime.js for readability.
 */

/** Stealth debug: CUPNET_STEALTH_LEVEL=N disables layers one-by-one for CF bisection. */
const STEALTH = Number(process.env.CUPNET_STEALTH_LEVEL || 0);

function logCupnetBisectEnv() {
    if (STEALTH) console.log(`[stealth] CUPNET_STEALTH_LEVEL=${STEALTH}`);
    if (process.env.CUPNET_DEVTOOLS === '1' || String(process.env.CUPNET_DEVTOOLS || '').toLowerCase() === 'true') {
        console.log('[cupnet] CUPNET_DEVTOOLS — Proxy Manager opens with DevTools (detach mode)');
    }
    if (process.env.CUPNET_RENDERER_CONSOLE_VERBOSE === '1') {
        console.log('[cupnet] CUPNET_RENDERER_CONSOLE_VERBOSE — all renderer console levels mirrored to main terminal');
    }
    const parts = [];
    const on = (k) => { if (process.env[k] === '1') parts.push(k); };
    on('CUPNET_DISABLE_TRAFFIC_WEBREQUEST');
    on('CUPNET_DISABLE_INTERCEPT_PROTOCOL');
    on('CUPNET_DISABLE_FINGERPRINT');
    on('CUPNET_TRAFFIC_FILTER_LOG');
    on('CUPNET_FORCE_HTTP1');
    if (STEALTH) parts.push(`CUPNET_STEALTH_LEVEL=${STEALTH}`);
    if (parts.length) console.log('[cupnet-bisect]', parts.join(' '));
}

/**
 * @param {import('electron').App} app
 * @param {{ path: typeof import('path'), fs: typeof import('fs'), safeCatch: Function }} deps
 */
function applyCupnetEarlyChromiumFlags(app, { path, fs, safeCatch }) {
    logCupnetBisectEnv();
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
    if (STEALTH < 7) {
        const earlySettingsPath = path.join(app.getPath('userData'), 'settings.json');
        let earlyBypass = [];
        try {
            earlyBypass = JSON.parse(fs.readFileSync(earlySettingsPath, 'utf8')).bypassDomains || [];
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'settings.parse.failed', context: { file: earlySettingsPath } }, err, 'info');
        }
        const bypassList = ['<local>', '*.youtube.com', '*.googlevideo.com', ...earlyBypass];
        app.commandLine.appendSwitch('proxy-bypass-list', [...new Set(bypassList)].join(','));
    }
}

module.exports = {
    STEALTH,
    applyCupnetEarlyChromiumFlags,
};
