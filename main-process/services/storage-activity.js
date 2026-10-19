'use strict';

/**
 * Storage-activity monitor (stack-trace capture).
 *
 * Injected into a tab's main world by tab-manager `injectStorageActivityMonitor` when
 * `activityMonitorEnabled && activityMonitorStorageStackTraces` are on and logging is recording.
 * It patches `Storage.prototype` (setItem / removeItem / clear) so every write carries a JS stack
 * trace, then reports through the `window.cupnetStorageActivity` bridge exposed by preload-view.js,
 * which forwards over the `browser-storage-activity` IPC handled in
 * main-process/ipc/handlers/db-logging-ipc.js.
 *
 * The hook MUST live in the page's main world (an isolated world has its own Storage.prototype and
 * would never see the page's own writes), so it can only reach the main process through a
 * main-world global. The reporter is therefore resolved lazily and every call is guarded: if the
 * `cupnetStorageActivity` bridge is absent (e.g. preload chose not to expose it), the wrappers
 * silently no-op and still delegate to the native Storage method. That keeps this script safe to
 * inject on any page regardless of whether the bridge is present.
 *
 * getItem is intentionally NOT wrapped: reads are high-frequency, carry no mutation, and the IPC
 * consumer only understands the set/remove/clear ops.
 */
const STORAGE_ACTIVITY_SCRIPT = `(function () {
    if (window.__cupnetStorageActInstalled) return;
    window.__cupnetStorageActInstalled = true;
    function report(payload) {
        try {
            if (window.cupnetStorageActivity && window.cupnetStorageActivity.report) {
                window.cupnetStorageActivity.report(payload);
            }
        } catch (_) {}
    }
    try {
        var Sp = Storage.prototype;
        if (Sp.__cupnetStorageActHooked) return;
        Sp.__cupnetStorageActHooked = true;
        var oSet = Sp.setItem;
        var oRemove = Sp.removeItem;
        var oClear = Sp.clear;
        function kindOf(st) {
            try {
                if (st === window.localStorage) return 'ls';
                if (st === window.sessionStorage) return 'ss';
            } catch (_) {}
            return 'ls';
        }
        Sp.setItem = function (k, v) {
            try {
                report({
                    kind: kindOf(this),
                    op: 'set',
                    key: String(k),
                    newValue: String(v),
                    stack: new Error().stack
                });
            } catch (_) {}
            return oSet.call(this, k, v);
        };
        Sp.removeItem = function (k) {
            try {
                report({
                    kind: kindOf(this),
                    op: 'remove',
                    key: String(k),
                    stack: new Error().stack
                });
            } catch (_) {}
            return oRemove.call(this, k);
        };
        Sp.clear = function () {
            try {
                report({ kind: kindOf(this), op: 'clear', stack: new Error().stack });
            } catch (_) {}
            return oClear.call(this);
        };
    } catch (_) {}
})();`;

function getStorageActivityScript() {
    return STORAGE_ACTIVITY_SCRIPT;
}

module.exports = {
    STORAGE_ACTIVITY_SCRIPT,
    getStorageActivityScript,
};
