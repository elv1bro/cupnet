'use strict';
/**
 * Батчинг IPC: лог-вьюер, intercept rules, DNS rules, TLS profile broadcast.
 * Зависимости передаются геттерами — окна могут быть null до открытия.
 */
function createIpcBatchMessenger({
    safeCatch,
    BrowserWindow,
    getMainWindow,
    getLogViewerWindows,
    getRulesWindow,
    getDnsManagerWindow,
}) {
    const LOG_IPC_BATCH_MS = 50;
    const LOG_IPC_BATCH_MAX = 200;
    const _logIpcQueues = new Map();

    const INTERCEPT_IPC_BATCH_MS = 80;
    const INTERCEPT_IPC_BATCH_MAX = 100;
    const _interceptIpcQueues = new Map();
    const _recentInterceptEvents = [];
    const RECENT_INTERCEPT_MAX = 120;

    const DNS_IPC_BATCH_MS = 80;
    const DNS_IPC_BATCH_MAX = 100;
    const _dnsIpcQueues = new Map();
    const _recentDnsEvents = [];
    const RECENT_DNS_MAX = 150;

    let _lastTlsProfileBroadcast = null;

    function _flushLogIpcQueue(wcId) {
        const q = _logIpcQueues.get(wcId);
        if (!q) return;
        if (q.timer) { clearTimeout(q.timer); q.timer = null; }
        const win = q.win;
        if (!win || win.isDestroyed()) {
            _logIpcQueues.delete(wcId);
            return;
        }
        const entries = q.entries.splice(0, q.entries.length);
        if (!entries.length) return;
        try {
            win.webContents.send('new-log-entry-batch', entries);
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'new-log-entry-batch' } }, err);
        }
    }

    function _enqueueLogEntryIpc(win, entry) {
        if (!win || win.isDestroyed()) return;
        const wcId = win.webContents.id;
        let q = _logIpcQueues.get(wcId);
        if (!q) {
            q = { entries: [], timer: null, win };
            _logIpcQueues.set(wcId, q);
        } else {
            q.win = win;
        }
        q.entries.push(entry);
        if (q.entries.length >= LOG_IPC_BATCH_MAX) {
            _flushLogIpcQueue(wcId);
            return;
        }
        if (!q.timer) {
            q.timer = setTimeout(() => _flushLogIpcQueue(wcId), LOG_IPC_BATCH_MS);
        }
    }

    function broadcastLogEntryToViewers(entry) {
        const list = typeof getLogViewerWindows === 'function' ? getLogViewerWindows() : [];
        for (const w of list) {
            _enqueueLogEntryIpc(w, entry);
        }
    }

    function _flushInterceptIpcQueue(wcId) {
        const q = _interceptIpcQueues.get(wcId);
        if (!q) return;
        if (q.timer) { clearTimeout(q.timer); q.timer = null; }
        const win = q.win;
        if (!win || win.isDestroyed()) {
            _interceptIpcQueues.delete(wcId);
            return;
        }
        const entries = q.entries.splice(0, q.entries.length);
        if (!entries.length) return;
        try {
            win.webContents.send('intercept-rule-matched-batch', entries);
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'intercept-rule-matched-batch' } }, err);
        }
    }

    function _enqueueInterceptIpc(win, info) {
        if (!win || win.isDestroyed()) return;
        const wcId = win.webContents.id;
        let q = _interceptIpcQueues.get(wcId);
        if (!q) {
            q = { entries: [], timer: null, win };
            _interceptIpcQueues.set(wcId, q);
        } else {
            q.win = win;
        }
        q.entries.push(info);
        if (q.entries.length >= INTERCEPT_IPC_BATCH_MAX) {
            _flushInterceptIpcQueue(wcId);
            return;
        }
        if (!q.timer) {
            q.timer = setTimeout(() => _flushInterceptIpcQueue(wcId), INTERCEPT_IPC_BATCH_MS);
        }
    }

    function broadcastInterceptRuleMatched(info) {
        const event = { ...info, ts: info?.ts || Date.now() };
        _recentInterceptEvents.push(event);
        if (_recentInterceptEvents.length > RECENT_INTERCEPT_MAX) {
            _recentInterceptEvents.splice(0, _recentInterceptEvents.length - RECENT_INTERCEPT_MAX);
        }
        const main = getMainWindow?.();
        _enqueueInterceptIpc(main, event);
        const list = typeof getLogViewerWindows === 'function' ? getLogViewerWindows() : [];
        for (const w of list) _enqueueInterceptIpc(w, event);
        _enqueueInterceptIpc(getRulesWindow?.(), event);
    }

    function _flushDnsIpcQueue(wcId) {
        const q = _dnsIpcQueues.get(wcId);
        if (!q) return;
        if (q.timer) { clearTimeout(q.timer); q.timer = null; }
        const win = q.win;
        if (!win || win.isDestroyed()) {
            _dnsIpcQueues.delete(wcId);
            return;
        }
        const entries = q.entries.splice(0, q.entries.length);
        if (!entries.length) return;
        try {
            win.webContents.send('dns-rule-matched-batch', entries);
        } catch (err) {
            safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'dns-rule-matched-batch' } }, err);
        }
    }

    function _enqueueDnsIpc(win, info) {
        if (!win || win.isDestroyed()) return;
        const wcId = win.webContents.id;
        let q = _dnsIpcQueues.get(wcId);
        if (!q) {
            q = { entries: [], timer: null, win };
            _dnsIpcQueues.set(wcId, q);
        } else {
            q.win = win;
        }
        q.entries.push(info);
        if (q.entries.length >= DNS_IPC_BATCH_MAX) {
            _flushDnsIpcQueue(wcId);
            return;
        }
        if (!q.timer) {
            q.timer = setTimeout(() => _flushDnsIpcQueue(wcId), DNS_IPC_BATCH_MS);
        }
    }

    function broadcastDnsRuleMatched(info) {
        const event = { ...info, ts: info?.ts || Date.now() };
        _recentDnsEvents.push(event);
        if (_recentDnsEvents.length > RECENT_DNS_MAX) {
            _recentDnsEvents.splice(0, _recentDnsEvents.length - RECENT_DNS_MAX);
        }
        const main = getMainWindow?.();
        _enqueueDnsIpc(main, event);
        _enqueueDnsIpc(getDnsManagerWindow?.(), event);
    }

    function broadcastTlsProfileChanged(profile) {
        if (!profile) return;
        if (_lastTlsProfileBroadcast === profile) return;
        _lastTlsProfileBroadcast = profile;
        BrowserWindow.getAllWindows().forEach((w) => {
            try {
                if (!w.isDestroyed()) w.webContents.send('tls-profile-changed', profile);
            } catch (err) {
                safeCatch({ module: 'main', eventCode: 'ipc.broadcast.failed', context: { channel: 'tls-profile-changed' } }, err, 'info');
            }
        });
    }

    function disposePendingBatches() {
        for (const q of _logIpcQueues.values()) {
            if (q.timer) clearTimeout(q.timer);
        }
        _logIpcQueues.clear();
        for (const q of _interceptIpcQueues.values()) {
            if (q.timer) clearTimeout(q.timer);
        }
        _interceptIpcQueues.clear();
        for (const q of _dnsIpcQueues.values()) {
            if (q.timer) clearTimeout(q.timer);
        }
        _dnsIpcQueues.clear();
    }

    return {
        broadcastLogEntryToViewers,
        broadcastInterceptRuleMatched,
        broadcastDnsRuleMatched,
        broadcastTlsProfileChanged,
        disposePendingBatches,
        getRecentInterceptEventsSlice: (n) => _recentInterceptEvents.slice(-n),
        getRecentDnsEventsSlice: (n) => _recentDnsEvents.slice(-n),
    };
}

module.exports = { createIpcBatchMessenger };
