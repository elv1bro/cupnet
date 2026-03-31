'use strict';

/**
 * Регистрация ipcMain: порядок вызовов совпадает с прежним монолитом.
 * Домены — в handlers/*.js; имена каналов не менять.
 */
const { registerMitmStartupIpc } = require('./handlers/mitm-startup-ipc');
const { registerTrackingIpc } = require('./handlers/tracking-ipc');
const { registerTabsIpc } = require('./handlers/tabs-ipc');
const { registerDbLoggingIpc } = require('./handlers/db-logging-ipc');
const { registerTraceHarIpc } = require('./handlers/trace-har-ipc');
const { registerRulesIpc } = require('./handlers/rules-ipc');
const { registerLauncherIpc } = require('./handlers/launcher-ipc');
const { registerPageAnalyzerIpc } = require('./handlers/page-analyzer-ipc');
const { registerMiscIpc } = require('./handlers/misc-ipc');
const { registerProxyIpc } = require('./handlers/proxy-ipc');
const { registerScreenshotsIpc } = require('./handlers/screenshots-ipc');
const { registerTraceViewerIpc } = require('./handlers/trace-viewer-ipc');
const { registerCookiesDnsIpc } = require('./handlers/cookies-dns-ipc');
const { registerLogCompareExecuteIpc } = require('./handlers/log-compare-execute-ipc');
const { registerSettingsToolbarIpc } = require('./handlers/settings-toolbar-ipc');
const { registerDiagnosticsIpc } = require('./handlers/diagnostics-ipc');
const { registerQuickConnectIpc } = require('./handlers/quick-connect-ipc');
const { registerMitmTlsResilienceIpc } = require('./handlers/mitm-tls-resilience-ipc');
const { registerExtProxyIpc } = require('./handlers/ext-proxy-ipc');
const { registerToolbarActivityBadgeIpc } = require('./handlers/toolbar-activity-badge-ipc');
const { registerNotesIpc } = require('./handlers/notes-ipc');

function registerMainProcessIpc(ctx) {
    registerMitmStartupIpc(ctx);
    registerToolbarActivityBadgeIpc(ctx);
    registerTrackingIpc(ctx);
    registerTabsIpc(ctx);
    registerDbLoggingIpc(ctx);
    registerTraceHarIpc(ctx);
    registerRulesIpc(ctx);
    registerLauncherIpc(ctx);
    registerPageAnalyzerIpc(ctx);
    registerMiscIpc(ctx);
    registerProxyIpc(ctx);
    registerScreenshotsIpc(ctx);
    registerTraceViewerIpc(ctx);
    registerCookiesDnsIpc(ctx);
    registerLogCompareExecuteIpc(ctx);
    registerSettingsToolbarIpc(ctx);
    registerDiagnosticsIpc(ctx);
    registerQuickConnectIpc(ctx);
    registerMitmTlsResilienceIpc(ctx);
    registerExtProxyIpc(ctx);
    registerNotesIpc(ctx);
}

module.exports = { registerMainProcessIpc };
