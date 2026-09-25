'use strict';

/**
 * Browsing history + omnibox suggestion service (main process).
 *
 * Wraps the db.js history tables, owns retention, the "recently closed tabs" ring and change
 * notifications. Tab lifecycle events come from tab-manager through the hooks installed in
 * cupnet-runtime.js; the IPC surface is main-process/ipc/handlers/omnibox-history-ipc.js.
 */

const omniboxModel = require('../../omnibox-model.js');

const RECENTLY_CLOSED_MAX = 10;
const CLEAR_RANGES = {
    hour: 3600 * 1000,
    day: 24 * 3600 * 1000,
    week: 7 * 24 * 3600 * 1000,
    all: 0,
};

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.settingsStore
 * @param {() => object} deps.loadSettings
 * @param {(s: object) => void} deps.saveSettings
 * @param {object} deps.tabManager
 * @param {(tabId: string) => void} [deps.afterTabCreated] attach logging/interceptor like the new-tab IPC does
 * @param {() => number|null} [deps.getCurrentSessionId]
 * @param {(ctx: object, err: Error, level?: string) => void} [deps.safeCatch]
 */
function createHistoryService(deps) {
    const { db, settingsStore, loadSettings, saveSettings, tabManager } = deps;
    const safeCatch = typeof deps.safeCatch === 'function' ? deps.safeCatch : () => {};

    /** @type {Array<{ id: number, url: string, title: string, cookieGroupId: number, entries: Array<object>, index: number, closedAt: number }>} */
    let recentlyClosed = [];
    let nextClosedId = 1;
    const listeners = new Set();
    let emitTimer = null;
    let pendingKinds = new Set();

    function getSettings() {
        return settingsStore.normalizeHistorySettings(loadSettings() || {});
    }

    function setSettings(patch) {
        const s = loadSettings() || {};
        const next = settingsStore.normalizeHistorySettings({ ...s, ...(patch && typeof patch === 'object' ? patch : {}) });
        s.historyRetentionDays = next.historyRetentionDays;
        s.historyRecordIsolatedTabs = next.historyRecordIsolatedTabs;
        s.omniboxInlineComplete = next.omniboxInlineComplete;
        saveSettings(s);
        emitChanged('settings');
        return next;
    }

    function onChanged(cb) {
        if (typeof cb !== 'function') return () => {};
        listeners.add(cb);
        return () => listeners.delete(cb);
    }

    function emitChanged(kind) {
        pendingKinds.add(kind || 'change');
        if (emitTimer) return;
        emitTimer = setTimeout(() => {
            emitTimer = null;
            const kinds = [...pendingKinds];
            pendingKinds = new Set();
            for (const cb of listeners) {
                try { cb(kinds); } catch (e) { safeCatch({ module: 'history', eventCode: 'history.listener.failed' }, e, 'warn'); }
            }
        }, 150);
    }

    function shouldRecord(payload) {
        const cg = Number(payload?.cookieGroupId);
        if (Number.isFinite(cg) && cg > 1 && !getSettings().historyRecordIsolatedTabs) return false;
        return true;
    }

    function recordVisit(payload) {
        if (!payload || !shouldRecord(payload)) return null;
        const r = db.recordOmniboxVisit(payload);
        if (r) emitChanged('visit');
        return r;
    }

    function updateTitle(url, title) {
        const ok = db.updateOmniboxTitle(url, title);
        if (ok) emitChanged('title');
        return ok;
    }

    function mapRow(r) {
        return {
            url: r.url,
            host: r.host || '',
            title: r.title || null,
            cookieGroupId: r.last_cookie_group_id ?? r.cookieGroupId ?? null,
            visitCount: Number(r.visit_count ?? r.visitCount ?? 0),
            typedCount: Number(r.typed_count ?? r.typedCount ?? 0),
            lastVisitAt: r.last_visit_at || r.lastVisitAt || null,
        };
    }

    /** Ranked suggestions + the best learned shortcut for what was typed. */
    function suggest(query, limit = 8) {
        const q = String(query || '').trim();
        if (!q) return { rows: [], shortcut: null };
        const lim = Math.max(1, Math.min(20, Number(limit) || 8));
        const rows = omniboxModel.rankSuggestions(db.getOmniboxCandidates(q, 300), q, { limit: lim });
        const shortcut = db.getOmniboxShortcut(q);
        return { rows, shortcut };
    }

    function zeroSuggest() {
        return {
            recent: db.getOmniboxRecent(8).map(mapRow),
            topSites: db.getOmniboxTopSites(6).map(mapRow),
        };
    }

    function recordShortcut(text, url) {
        return db.recordOmniboxShortcut(text, url);
    }

    function deleteUrl(url) {
        const ok = db.deleteHistoryUrl(url);
        if (ok) emitChanged('delete');
        return ok;
    }

    function deleteVisit(id) {
        const ok = db.deleteHistoryVisit(id);
        if (ok) emitChanged('delete');
        return ok;
    }

    function clear(range) {
        const key = String(range || 'all');
        const span = Object.prototype.hasOwnProperty.call(CLEAR_RANGES, key) ? CLEAR_RANGES[key] : 0;
        const r = db.clearHistory(span > 0 ? { sinceMs: Date.now() - span } : {});
        emitChanged('clear');
        return r;
    }

    function list(opts) {
        return db.listHistoryVisits(opts || {});
    }

    function count(opts) {
        return db.countHistoryVisits(opts || {});
    }

    function stats() {
        return db.getHistoryStats();
    }

    function purge() {
        const days = getSettings().historyRetentionDays;
        if (!days) return { visits: 0, urls: 0 };
        const r = db.purgeHistoryOlderThan(days);
        if (r.visits || r.urls) emitChanged('purge');
        return r;
    }

    // ── Recently closed tabs ───────────────────────────────────────────────
    function noteClosedTab(snapshot) {
        if (!snapshot || !snapshot.url) return;
        const url = String(snapshot.url);
        if (url === 'about:blank' || /new-tab\.html$/i.test(url)) return;
        recentlyClosed.unshift({
            id: nextClosedId++,
            url,
            title: String(snapshot.title || ''),
            cookieGroupId: Number(snapshot.cookieGroupId) || 1,
            entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
            index: Number.isFinite(Number(snapshot.index)) ? Number(snapshot.index) : -1,
            closedAt: Date.now(),
        });
        if (recentlyClosed.length > RECENTLY_CLOSED_MAX) recentlyClosed.length = RECENTLY_CLOSED_MAX;
        emitChanged('closed');
    }

    function getRecentlyClosed() {
        return recentlyClosed.map((e) => ({
            id: e.id,
            url: e.url,
            title: e.title,
            cookieGroupId: e.cookieGroupId,
            isolated: e.cookieGroupId !== 1,
            closedAt: e.closedAt,
            depth: e.entries.length,
        }));
    }

    function takeRecentlyClosed(id) {
        if (!recentlyClosed.length) return null;
        let idx = 0;
        if (id != null) {
            idx = recentlyClosed.findIndex((e) => e.id === Number(id));
            if (idx < 0) return null;
        }
        const [entry] = recentlyClosed.splice(idx, 1);
        emitChanged('closed');
        return entry;
    }

    /**
     * Reopen a closed tab in its cookie group, restoring the navigation stack when Electron
     * supports it (`navigationHistory.restore`, present in Electron 44).
     */
    async function reopenClosedTab(id) {
        const entry = takeRecentlyClosed(id);
        if (!entry) return null;
        let cookieGroupId = entry.cookieGroupId || 1;
        let isolatedFallback = false;
        if (cookieGroupId !== 1) {
            let exists = false;
            try { exists = !!db.getCookieGroup(cookieGroupId); } catch { exists = false; }
            if (!exists) { cookieGroupId = 1; isolatedFallback = true; }
        }
        const tabId = await tabManager.createTab({
            url: null,
            cookieGroupId,
            existingSessionId: typeof deps.getCurrentSessionId === 'function' ? (deps.getCurrentSessionId() || null) : null,
        });
        tabManager.switchTab(tabId);
        try { if (typeof deps.afterTabCreated === 'function') deps.afterTabCreated(tabId); } catch (e) { safeCatch({ module: 'history', eventCode: 'history.reopen.attach.failed' }, e, 'warn'); }
        const tab = tabManager.getTab(tabId);
        const wc = tab?.view?.webContents;
        let restored = false;
        if (wc && !wc.isDestroyed() && entry.entries.length && wc.navigationHistory && typeof wc.navigationHistory.restore === 'function') {
            try {
                const index = entry.index >= 0 && entry.index < entry.entries.length ? entry.index : entry.entries.length - 1;
                await wc.navigationHistory.restore({ entries: entry.entries, index });
                restored = true;
            } catch (e) {
                safeCatch({ module: 'history', eventCode: 'history.reopen.restore.failed' }, e, 'info');
            }
        }
        if (!restored) tabManager.navigate(entry.url, tabId);
        return { tabId, url: entry.url, cookieGroupId, isolatedFallback, restored };
    }

    return {
        getSettings,
        setSettings,
        onChanged,
        recordVisit,
        updateTitle,
        suggest,
        zeroSuggest,
        recordShortcut,
        deleteUrl,
        deleteVisit,
        clear,
        list,
        count,
        stats,
        purge,
        noteClosedTab,
        getRecentlyClosed,
        takeRecentlyClosed,
        reopenClosedTab,
        CLEAR_RANGES,
    };
}

module.exports = { createHistoryService };
