'use strict';

const { buildActivityMonitorScript } = require('../../services/activity-monitor-script');

/**
 * Activity Monitor capture transport (leak-free console + exception logging).
 *
 * Why this IPC exists:
 *   The old Activity Monitor received console/exception events by enabling the
 *   CDP `Runtime` domain, which is the classic bot-detection leak (BrowserScan
 *   "CDP = Robot"). The replacement hooks `console.*` in the page's MAIN world
 *   from the tab preload (see services/activity-monitor-script.js, injected by
 *   preload-view.js via webFrame.executeJavaScript — the same path anti-anti-
 *   debug uses), and ships each captured event back here over IPC. No CDP domain
 *   is enabled for this, so nothing is observable from page JS.
 *
 * Two channels:
 *   - `get-activity-monitor-sync` (sync): the preload asks whether capture is
 *     active and, if so, gets the main-world hook source parameterized with the
 *     nonce the PRELOAD generated (and passed in). The preload owns the nonce so
 *     it stays stable across a document's life — the same nonce is reused whether
 *     the hook is injected at document-start or later via `activity-monitor-update`
 *     — which keeps exactly one CustomEvent name per document and lets the hook's
 *     idempotency guard make re-injection a no-op. The nonce names the DOM
 *     CustomEvent the hook dispatches; it is unguessable and lives only in the
 *     preload closure + the injected hook closure, so a page can neither read it
 *     (to spoof events) nor detect a global.
 *   - `activity-monitor-event` (fire-and-forget): the preload's isolated-world
 *     listener forwards each CustomEvent's `detail` here; we hand it to
 *     ctx.ingestActivityEvent, which feeds the normal per-tab Activity Monitor
 *     DB queue. `event.sender` is the tab's webContents, which keys the queue.
 *
 * Gating: capture is only offered/accepted while a recording session is live
 * (ctx.isLoggingEnabled) AND the Activity Monitor setting is on. The preload
 * injects nothing when the sync call reports `enabled:false`, and the main
 * process drops any late events via ctx.ingestActivityEvent's own gating, so a
 * hook left installed from an earlier enabled phase is harmless.
 *
 * Live transitions: `setupNetworkLogging` pushes `activity-monitor-update`
 * ({enabled}) to a tab's preload whenever it (re)runs — recording start/stop,
 * the setting toggle, and each navigation — so console capture follows the
 * recording state on already-open tabs without a reload (matching the old
 * Runtime.enable behaviour).
 *
 * @param {object} ctx
 */
function registerActivityMonitorIpc(ctx) {
    // Sync: the tab preload must decide before any page <script> runs, so it
    // cannot await. `payload.nonce` is the preload-generated DOM event name.
    // Returns { enabled, script }.
    ctx.ipcMain.on('get-activity-monitor-sync', (event, payload) => {
        try {
            const s = ctx.loadSettings();
            const enabled = !!(ctx.isLoggingEnabled && s && s.activityMonitorEnabled === true);
            const nonce = payload && typeof payload.nonce === 'string' ? payload.nonce : '';
            if (!enabled || !nonce) { event.returnValue = { enabled: false, script: null }; return; }
            event.returnValue = { enabled: true, script: buildActivityMonitorScript(nonce) };
        } catch {
            event.returnValue = { enabled: false, script: null };
        }
    });

    // Fire-and-forget: one message per captured console call / page exception.
    // The payload is the structured object the main-world hook emitted; its
    // shape is validated and clamped inside ingestActivityEvent.
    ctx.ipcMain.on('activity-monitor-event', (event, payload) => {
        try {
            if (typeof ctx.ingestActivityEvent !== 'function') return;
            if (!event.sender || event.sender.isDestroyed()) return;
            ctx.ingestActivityEvent(event.sender, payload);
        } catch { /* never let a page's event crash the handler */ }
    });
}

module.exports = { registerActivityMonitorIpc };
