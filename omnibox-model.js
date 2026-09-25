'use strict';

/**
 * Omnibox model — pure functions shared by the main process (ranking) and the shell renderer
 * (row composition). No DOM, no Electron.
 *
 * Exposed as `module.exports` (CommonJS) and `window.CupNetOmniboxModel` (browser).
 */
(function omniboxModelFactory(root) {
    const SEARCH_ENGINE_LABELS = {
        duckduckgo: 'DuckDuckGo',
        google: 'Google',
        brave: 'Brave',
        yandex: 'Yandex',
        bing: 'Bing',
        custom: 'Custom',
    };

    /** Internal pages offered on word-prefix match (and all of them in zero-suggest). */
    const QUICK_LINKS = [
        { label: 'Settings', keywords: ['settings', 'preferences', 'options'], url: 'cupnet://settings' },
        { label: 'User guide', keywords: ['guide', 'help', 'manual', 'documentation'], url: 'cupnet://guide' },
        { label: 'History', keywords: ['history', 'visited', 'recent'], url: 'cupnet://history' },
        { label: 'Identity check', keywords: ['identity', 'fingerprint', 'check'], url: 'cupnet://identity-check' },
        { label: 'Start page', keywords: ['home', 'start', 'newtab', 'dashboard'], url: 'cupnet://home' },
    ];

    const FRECENCY_HALF_LIFE_DAYS = 14;
    const DEFAULT_MATCH_MIN_SCORE = 0.05;

    function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

    function matchRange(hay, needle) {
        const h = lower(hay);
        const n = lower(needle).trim();
        if (!n || !h) return null;
        const i = h.indexOf(n);
        if (i < 0) return null;
        return [i, i + n.length];
    }

    function words(text) {
        return lower(text).split(/[^a-z0-9а-яё]+/i).filter(Boolean);
    }

    /** Every query word must be a prefix of some word in `text`. */
    function wordPrefixMatch(query, text) {
        const qw = words(query);
        if (!qw.length) return true;
        const tw = words(text);
        return qw.every((q) => tw.some((t) => t.startsWith(q)));
    }

    function subsequenceMatch(query, text) {
        const q = lower(query).trim();
        const t = lower(text);
        if (!q) return true;
        if (t.includes(q)) return true;
        let qi = 0;
        for (let i = 0; i < t.length && qi < q.length; i++) {
            if (t[i] === q[qi]) qi++;
        }
        return qi === q.length;
    }

    function stripScheme(url) {
        return String(url || '').replace(/^[a-z][a-z\d+\-.]*:\/\//i, '');
    }

    function stripWww(host) {
        return String(host || '').replace(/^www\./i, '');
    }

    /** `www.wikipedia.org/` → `www.wikipedia.org`; `httpbin.org/get` stays. */
    function displayUrlText(url) {
        let s = stripScheme(url);
        if (/^[^/?#]+\/$/.test(s)) s = s.slice(0, -1);
        return s;
    }

    function urlPath(url) {
        try {
            const u = new URL(String(url));
            return (u.pathname || '/') + (u.search || '');
        } catch {
            return '/';
        }
    }

    function frecency(row, nowMs) {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        const last = Date.parse(row.last_visit_at || row.lastVisitAt || '');
        const t = Number.isFinite(last) ? last : now;
        const ageDays = Math.max(0, (now - t) / 86400000);
        const visits = Number(row.visit_count ?? row.visitCount ?? 0);
        const typed = Number(row.typed_count ?? row.typedCount ?? 0);
        const base = visits + typed * 3;
        return base * Math.exp(-ageDays / FRECENCY_HALF_LIFE_DAYS);
    }

    /** Query normalised for host matching: lower-case, no scheme. */
    function normQuery(q) {
        return lower(q).trim().replace(/^https?:\/\//, '');
    }

    /**
     * @returns {{ kind: string, boost: number }|null}
     */
    function matchKindFor(row, q) {
        const ql = normQuery(q);
        if (!ql) return null;
        const host = lower(row.host);
        const hostNoWww = stripWww(host);
        const urlNs = lower(stripScheme(row.url));
        const urlNsNoWww = stripWww(urlNs);
        const title = lower(row.title);
        const qlNoWww = stripWww(ql);

        if (host.startsWith(ql) || hostNoWww.startsWith(qlNoWww) || urlNs.startsWith(ql) || urlNsNoWww.startsWith(qlNoWww)) {
            const root = urlPath(row.url) === '/';
            return { kind: 'host-prefix', boost: root ? 3.9 : 3 };
        }
        const labels = host.split('.');
        if (labels.some((l, i) => i > 0 && l.startsWith(ql))) return { kind: 'host-label-prefix', boost: 2 };
        if (title && words(title).some((w) => w.startsWith(ql))) return { kind: 'title-word-prefix', boost: 1.5 };
        if (urlNs.includes(ql)) return { kind: 'url-substring', boost: 1 };
        if (title && title.includes(ql)) return { kind: 'title-substring', boost: 0.7 };
        return null;
    }

    function scoreSuggestion(row, q, nowMs) {
        const m = matchKindFor(row, q);
        if (!m) return null;
        return { score: frecency(row, nowMs) * m.boost, matchKind: m.kind };
    }

    /**
     * Rank DB candidate rows for a query. Rows that do not match at all are dropped.
     * @param {Array<object>} rows { url, host, title, visit_count, typed_count, last_visit_at, last_cookie_group_id }
     */
    function rankSuggestions(rows, q, opts) {
        const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
        const limit = opts && Number.isFinite(opts.limit) ? opts.limit : 8;
        const out = [];
        for (const r of Array.isArray(rows) ? rows : []) {
            const s = scoreSuggestion(r, q, nowMs);
            if (!s) continue;
            out.push({
                url: r.url,
                host: r.host || '',
                title: r.title || null,
                score: s.score,
                matchKind: s.matchKind,
                cookieGroupId: r.last_cookie_group_id ?? r.cookieGroupId ?? null,
                visitCount: Number(r.visit_count ?? r.visitCount ?? 0),
                typedCount: Number(r.typed_count ?? r.typedCount ?? 0),
                lastVisitAt: r.last_visit_at || r.lastVisitAt || null,
            });
        }
        out.sort((a, b) => b.score - a.score || String(a.url).length - String(b.url).length);
        return out.slice(0, limit);
    }

    /**
     * The row Enter opens without moving the highlight: a learned shortcut, else the best
     * host-prefix history match. Never a substring/title match (Chrome rule).
     */
    function findDefaultMatch(ranked, q, opts) {
        const query = String(q || '').trim();
        if (query.length < 2) return null;
        const shortcut = opts && opts.shortcut && opts.shortcut.url ? opts.shortcut : null;
        if (shortcut) {
            const hit = (ranked || []).find((r) => r.url === shortcut.url);
            if (hit) return { ...hit, matchKind: 'shortcut' };
            let host = '';
            try { host = new URL(shortcut.url).hostname; } catch { host = ''; }
            return { url: shortcut.url, host, title: shortcut.title || null, score: Infinity, matchKind: 'shortcut', cookieGroupId: null };
        }
        for (const r of ranked || []) {
            if (r.matchKind === 'host-prefix' && r.score >= DEFAULT_MATCH_MIN_SCORE) return r;
        }
        return null;
    }

    /**
     * Inline completion for the default match: the typed text plus the rest of the URL (no scheme,
     * `www.` dropped when the user did not type it). Null when the URL does not start with the text.
     */
    function computeCompletion(q, row) {
        if (!row || !row.url) return null;
        const raw = String(q || '');
        const ql = normQuery(raw);
        if (!ql) return null;
        const disp = displayUrlText(row.url);
        const candidates = [disp, stripWww(disp)];
        for (const c of candidates) {
            const cl = lower(c);
            if (cl.startsWith(ql) && cl.length > ql.length) {
                return { text: raw + c.slice(ql.length), url: row.url };
            }
        }
        return null;
    }

    function historyRow(r, sub, q) {
        const label = r.title ? String(r.title) : displayUrlText(r.url);
        const preview = displayUrlText(r.url);
        return {
            kind: 'history',
            icon: 'history',
            label,
            sub: sub || 'History',
            url: r.url,
            urlPreview: preview !== label ? preview : '',
            match: matchRange(label, q) || null,
            previewMatch: matchRange(preview, q) || null,
            badge: r.cookieGroupId != null && Number(r.cookieGroupId) !== 1 ? 'isolated' : '',
            deletable: true,
            matchKind: r.matchKind || null,
        };
    }

    function searchRow(q, engineLabel) {
        const label = `Search ${engineLabel || 'the web'} for "${q}"`;
        return { kind: 'search', icon: 'search', label, sub: 'Search', query: q, match: matchRange(label, q) };
    }

    function urlRow(classified, q) {
        const isInternal = classified.kind === 'internal';
        const shown = isInternal ? classified.url : displayUrlText(classified.url);
        return {
            kind: 'url',
            icon: isInternal ? 'quick' : 'url',
            label: shown,
            sub: isInternal ? 'CupNet page' : 'Open',
            url: classified.url,
            urlPreview: '',
            match: matchRange(shown, q),
        };
    }

    function quickLinkRow(ql, q) {
        return {
            kind: 'url',
            icon: 'quick',
            label: ql.label,
            sub: 'CupNet',
            url: ql.url,
            urlPreview: ql.url,
            match: matchRange(ql.label, q),
        };
    }

    function tabRow(t, q) {
        const tu = String(t.url || '');
        const tt = String(t.title || '');
        const label = tt || tu || 'Tab';
        return {
            kind: 'tab',
            icon: 'tab',
            label,
            sub: 'Switch to tab',
            tabId: t.id,
            url: tu,
            urlPreview: tu,
            match: matchRange(label, q) || null,
            previewMatch: matchRange(tu, q) || null,
            badge: t.isolated ? 'isolated' : '',
        };
    }

    function quickLinksFor(q) {
        const ql = lower(q).trim();
        if (ql.length < 2) return [];
        return QUICK_LINKS.filter((x) => x.keywords.some((k) => k.startsWith(ql)) || words(x.label).some((w) => w.startsWith(ql)));
    }

    /**
     * Build the dropdown rows.
     * @param {object} input
     * @param {string} input.query
     * @param {object} input.classified  result of classifyOmniboxInput
     * @param {string} [input.engineLabel]
     * @param {Array<object>} [input.tabs] tab list (id, url, title, isolated, isActive)
     * @param {string|null} [input.activeTabId]
     * @param {Array<object>} [input.suggestions] ranked history rows (rankSuggestions output)
     * @param {{text:string,url:string}|null} [input.shortcut]
     * @param {Array<object>} [input.commands] command palette entries (label, category, keywords, shortcut, run)
     * @param {Array<object>} [input.recent] zero-suggest recent rows
     * @param {Array<object>} [input.topSites] zero-suggest top rows
     * @param {boolean} [input.inlineEnabled]
     * @param {number} [input.maxRows]
     * @returns {{ rows: Array<object>, completion: {text:string,url:string}|null, mode: string }}
     */
    function buildOmniboxRows(input) {
        const q = String(input.query || '').trim();
        const classified = input.classified || { kind: q ? 'search' : 'empty', query: q };
        const maxRows = Number.isFinite(input.maxRows) ? input.maxRows : 8;
        const ql = lower(q);

        if (classified.kind === 'command') {
            const cq = String(classified.query || '').trim();
            const all = Array.isArray(input.commands) ? input.commands : [];
            const hay = (c) => `${c.label} ${c.category || ''} ${c.keywords || ''}`;
            let cmds = all.filter((c) => wordPrefixMatch(cq, hay(c)));
            if (!cmds.length && cq) cmds = all.filter((c) => subsequenceMatch(cq, hay(c)));
            const rows = cmds.map((c) => ({
                kind: 'cmd',
                icon: 'cmd',
                label: c.label,
                sub: c.category || '',
                shortcut: c.shortcut || '',
                run: c.run,
                match: matchRange(c.label, cq),
            }));
            return { rows, completion: null, mode: 'command' };
        }

        if (classified.kind === 'empty') {
            const rows = [];
            const seen = new Set();
            for (const r of Array.isArray(input.recent) ? input.recent : []) {
                if (rows.length >= 6) break;
                if (seen.has(r.url)) continue;
                seen.add(r.url);
                rows.push(historyRow(r, 'Recent', ''));
            }
            let top = 0;
            for (const r of Array.isArray(input.topSites) ? input.topSites : []) {
                if (top >= 4) break;
                if (seen.has(r.url)) continue;
                seen.add(r.url);
                rows.push(historyRow(r, 'Top site', ''));
                top++;
            }
            for (const x of QUICK_LINKS) rows.push(quickLinkRow(x, ''));
            return { rows: rows.slice(0, Math.max(maxRows, 12)), completion: null, mode: 'zero' };
        }

        const ranked = Array.isArray(input.suggestions) ? input.suggestions : [];
        const shortcut = input.shortcut && input.shortcut.url ? input.shortcut : null;
        const def = findDefaultMatch(ranked, q, { shortcut });
        const rows = [];
        const usedUrls = new Set();

        if (def) {
            rows.push({ ...historyRow(def, def.matchKind === 'shortcut' ? 'Shortcut' : 'History', q), isDefault: true });
            usedUrls.add(def.url);
            if (classified.kind === 'url' || classified.kind === 'internal') rows.push(urlRow(classified, q));
            else rows.push(searchRow(q, input.engineLabel));
        } else if (classified.kind === 'url' || classified.kind === 'internal') {
            rows.push({ ...urlRow(classified, q), isDefault: true });
            if (classified.scheme !== 'typed' && classified.kind !== 'internal') rows.push(searchRow(q, input.engineLabel));
        } else {
            rows.push({ ...searchRow(q, input.engineLabel), isDefault: true });
        }

        const tabs = Array.isArray(input.tabs) ? input.tabs : [];
        let tabCount = 0;
        for (const t of tabs) {
            if (tabCount >= 2) break;
            if (t.id === input.activeTabId) continue;
            const tu = lower(t.url);
            const tt = lower(t.title);
            if (!tu.includes(ql) && !tt.includes(ql)) continue;
            rows.push(tabRow(t, q));
            tabCount++;
        }

        for (const r of ranked) {
            if (rows.length >= maxRows) break;
            if (usedUrls.has(r.url)) continue;
            usedUrls.add(r.url);
            rows.push(historyRow(r, 'History', q));
        }

        for (const x of quickLinksFor(q)) {
            if (rows.length >= maxRows) break;
            if (usedUrls.has(x.url)) continue;
            rows.push(quickLinkRow(x, q));
        }

        const completion = def && input.inlineEnabled !== false ? computeCompletion(q, def) : null;
        return { rows: rows.slice(0, maxRows), completion, mode: 'url' };
    }

    const mod = {
        SEARCH_ENGINE_LABELS,
        QUICK_LINKS,
        matchRange,
        wordPrefixMatch,
        subsequenceMatch,
        stripScheme,
        stripWww,
        displayUrlText,
        frecency,
        matchKindFor,
        scoreSuggestion,
        rankSuggestions,
        findDefaultMatch,
        computeCompletion,
        buildOmniboxRows,
        quickLinksFor,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (root && typeof root === 'object') root.CupNetOmniboxModel = mod;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
