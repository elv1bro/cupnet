'use strict';

/**
 * In-memory favicon cache keyed by hostname. Reuses tab favicons and probes
 * origin / Google fallback only once per host (negative entries cached briefly).
 */
(function () {
    const MAX_ENTRIES = 512;
    const NEGATIVE_TTL_MS = 5 * 60 * 1000;
    /** @type {Map<string, { url: string|null, at: number, negative?: boolean }>} */
    const cache = new Map();
    /** @type {Map<string, Promise<string|null>>} */
    const inflight = new Map();

    function hostKey(rawUrl) {
        const s = String(rawUrl || '').trim();
        if (!s) return '';
        try {
            const u = new URL(s.includes('://') ? s : `https://${s}`);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            return u.hostname.toLowerCase();
        } catch {
            return '';
        }
    }

    function originFaviconUrl(rawUrl) {
        try {
            const u = new URL(String(rawUrl).includes('://') ? rawUrl : `https://${rawUrl}`);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
            return `${u.origin}/favicon.ico`;
        } catch {
            return null;
        }
    }

    function googleFaviconUrl(host) {
        return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
    }

    function touch(key, entry) {
        if (cache.has(key)) cache.delete(key);
        cache.set(key, entry);
        while (cache.size > MAX_ENTRIES) {
            const first = cache.keys().next().value;
            cache.delete(first);
        }
    }

    function get(host) {
        const key = String(host || '').toLowerCase();
        if (!key) return null;
        const row = cache.get(key);
        if (!row) return null;
        if (row.negative && Date.now() - row.at > NEGATIVE_TTL_MS) {
            cache.delete(key);
            return null;
        }
        return row.url || null;
    }

    function note(host, url) {
        const key = String(host || '').toLowerCase();
        if (!key || !url) return;
        touch(key, { url: String(url), at: Date.now(), negative: false });
    }

    function noteFromUrl(pageUrl, faviconUrl) {
        const key = hostKey(pageUrl);
        if (key && faviconUrl) note(key, faviconUrl);
    }

    function ingestTabs(tabList) {
        if (!Array.isArray(tabList)) return;
        for (const tab of tabList) {
            if (tab?.faviconUrl && tab?.url) noteFromUrl(tab.url, tab.faviconUrl);
        }
    }

    function resolveSync(rawUrl, tabFaviconUrl) {
        const key = hostKey(rawUrl);
        if (!key) return tabFaviconUrl || null;
        const cached = get(key);
        if (cached) return cached;
        if (tabFaviconUrl) {
            note(key, tabFaviconUrl);
            return tabFaviconUrl;
        }
        return null;
    }

    function probeImage(url, timeoutMs = 2500) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                img.onload = null;
                img.onerror = null;
                img.src = '';
                resolve(v);
            };
            const img = new Image();
            const timer = setTimeout(() => finish(null), timeoutMs);
            img.onload = () => finish(url);
            img.onerror = () => finish(null);
            img.src = url;
        });
    }

    async function load(rawUrl, tabFaviconUrl) {
        const key = hostKey(rawUrl);
        if (!key) return tabFaviconUrl || null;

        const cached = get(key);
        if (cached) return cached;

        const row = cache.get(key);
        if (row?.negative && Date.now() - row.at <= NEGATIVE_TTL_MS) return null;

        if (tabFaviconUrl) {
            note(key, tabFaviconUrl);
            return tabFaviconUrl;
        }

        if (inflight.has(key)) return inflight.get(key);

        const task = (async () => {
            const origin = originFaviconUrl(rawUrl);
            if (origin) {
                const ok = await probeImage(origin);
                if (ok) {
                    note(key, ok);
                    return ok;
                }
            }
            const g = googleFaviconUrl(key);
            const gOk = await probeImage(g);
            if (gOk) {
                note(key, gOk);
                return gOk;
            }
            touch(key, { url: null, at: Date.now(), negative: true });
            return null;
        })().finally(() => {
            inflight.delete(key);
        });

        inflight.set(key, task);
        return task;
    }

    /** Load up to `limit` missing favicons with bounded concurrency. */
    async function loadMany(entries, limit = 8, concurrency = 3) {
        const todo = [];
        for (const { url, tabFaviconUrl } of entries) {
            if (todo.length >= limit) break;
            const key = hostKey(url);
            if (!key) continue;
            if (get(key)) continue;
            const row = cache.get(key);
            if (row?.negative && Date.now() - row.at <= NEGATIVE_TTL_MS) continue;
            todo.push({ url, tabFaviconUrl, key });
        }
        for (let i = 0; i < todo.length; i += concurrency) {
            const chunk = todo.slice(i, i + concurrency);
            await Promise.all(chunk.map(({ url, tabFaviconUrl }) => load(url, tabFaviconUrl)));
        }
    }

    window.CupNetFaviconCache = {
        hostKey,
        get,
        note,
        noteFromUrl,
        ingestTabs,
        resolveSync,
        load,
        loadMany,
    };
})();
