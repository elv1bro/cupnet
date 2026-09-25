import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const model = require('../../omnibox-model.js');
const { classifyOmniboxInput } = require('../../omnibox-input.js');

const NOW = Date.parse('2026-09-25T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();

function row(url, { title = null, visits = 1, typed = 0, days = 0, cg = 1 } = {}) {
    return {
        url,
        host: new URL(url).hostname,
        title,
        visit_count: visits,
        typed_count: typed,
        last_visit_at: iso(days),
        last_cookie_group_id: cg,
    };
}

function build(query, extra = {}) {
    const classified = classifyOmniboxInput(query);
    return model.buildOmniboxRows({ query, classified, engineLabel: 'DuckDuckGo', inlineEnabled: true, ...extra });
}

describe('rankSuggestions', () => {
    it('drops rows that do not match and boosts host prefixes over substrings', () => {
        const rows = [
            row('https://www.wikipedia.org/', { title: 'Wikipedia', visits: 2 }),
            row('https://blog.example.com/wiki-notes', { title: 'notes', visits: 2 }),
            row('https://unrelated.example/', { visits: 50 }),
        ];
        const ranked = model.rankSuggestions(rows, 'wiki', { nowMs: NOW });
        expect(ranked.map((r) => r.url)).toEqual(['https://www.wikipedia.org/', 'https://blog.example.com/wiki-notes']);
        expect(ranked[0].matchKind).toBe('host-prefix');
        expect(ranked[1].matchKind).toBe('url-substring');
    });

    it('prefers recent typed visits and ignores the recency-only cut-off', () => {
        const rows = [
            row('https://stale.example/old', { visits: 1, days: 60 }),
            row('https://fresh.example/new', { visits: 1, typed: 1, days: 0 }),
        ];
        const ranked = model.rankSuggestions(rows, 'example', { nowMs: NOW });
        expect(ranked[0].url).toBe('https://fresh.example/new');
    });

    it('matches host labels after a dot and title word prefixes', () => {
        const rows = [
            row('https://en.wikipedia.org/wiki/Main', { title: 'Main Page' }),
            row('https://docs.example.com/', { title: 'Wikis and docs' }),
        ];
        const ranked = model.rankSuggestions(rows, 'wiki', { nowMs: NOW });
        expect(ranked.find((r) => r.url.startsWith('https://en.')).matchKind).toBe('host-label-prefix');
        expect(ranked.find((r) => r.url.startsWith('https://docs.')).matchKind).toBe('title-word-prefix');
    });

    it('prefers the root URL of a host over deep pages on host-prefix', () => {
        const rows = [
            row('https://httpbin.org/get', { visits: 2 }),
            row('https://httpbin.org/', { visits: 2 }),
        ];
        const ranked = model.rankSuggestions(rows, 'httpb', { nowMs: NOW });
        expect(ranked[0].url).toBe('https://httpbin.org/');
    });
});

describe('findDefaultMatch + computeCompletion', () => {
    it('host-prefix match becomes the default and completes the host', () => {
        const ranked = model.rankSuggestions([row('https://www.wikipedia.org/', { title: 'Wikipedia' })], 'wiki', { nowMs: NOW });
        const def = model.findDefaultMatch(ranked, 'wiki');
        expect(def.url).toBe('https://www.wikipedia.org/');
        expect(model.computeCompletion('wiki', def)).toEqual({ text: 'wikipedia.org', url: 'https://www.wikipedia.org/' });
        expect(model.computeCompletion('WIKI', def).text).toBe('WIKIpedia.org');
        expect(model.computeCompletion('www.wiki', def).text).toBe('www.wikipedia.org');
        expect(model.computeCompletion('https://wiki', def).text).toBe('https://wikipedia.org');
    });

    it('deep pages complete the whole path', () => {
        const ranked = model.rankSuggestions([row('https://httpbin.org/get')], 'httpb', { nowMs: NOW });
        const def = model.findDefaultMatch(ranked, 'httpb');
        expect(model.computeCompletion('httpb', def).text).toBe('httpbin.org/get');
    });

    it('label-prefix and substring matches are never the default', () => {
        const ranked = model.rankSuggestions([
            row('https://en.wikipedia.org/wiki/Main'),
            row('https://blog.example.com/wiki-notes'),
        ], 'wiki', { nowMs: NOW });
        expect(model.findDefaultMatch(ranked, 'wiki')).toBeNull();
    });

    it('a learned shortcut wins even without a host prefix', () => {
        const ranked = model.rankSuggestions([row('https://en.wikipedia.org/wiki/Main', { title: 'Main Page' })], 'wiki', { nowMs: NOW });
        const def = model.findDefaultMatch(ranked, 'wiki', { shortcut: { text: 'wiki', url: 'https://en.wikipedia.org/wiki/Main' } });
        expect(def.matchKind).toBe('shortcut');
        expect(model.computeCompletion('wiki', def)).toBeNull();
    });

    it('needs at least two characters', () => {
        const ranked = model.rankSuggestions([row('https://wikipedia.org/')], 'w', { nowMs: NOW });
        expect(model.findDefaultMatch(ranked, 'w')).toBeNull();
    });
});

describe('buildOmniboxRows', () => {
    it('row 1 is the history default match, row 2 the search alternative, then history', () => {
        const suggestions = model.rankSuggestions([
            row('https://www.wikipedia.org/', { title: 'Wikipedia', visits: 3 }),
            row('https://en.wikipedia.org/wiki/Main', { title: 'Main Page' }),
        ], 'wiki', { nowMs: NOW });
        const { rows, completion } = build('wiki', { suggestions });
        expect(rows[0].kind).toBe('history');
        expect(rows[0].isDefault).toBe(true);
        expect(rows[0].url).toBe('https://www.wikipedia.org/');
        expect(rows[1].kind).toBe('search');
        expect(rows[1].label).toBe('Search DuckDuckGo for "wiki"');
        expect(rows[2].kind).toBe('history');
        expect(rows[2].url).toBe('https://en.wikipedia.org/wiki/Main');
        expect(completion.text).toBe('wikipedia.org');
    });

    it('typed URL is row 1 when nothing in history matches; search stays as row 2', () => {
        const { rows } = build('localhost:3000', { suggestions: [] });
        expect(rows[0].kind).toBe('url');
        expect(rows[0].url).toBe('http://localhost:3000');
        expect(rows[0].isDefault).toBe(true);
        expect(rows[1].kind).toBe('search');
    });

    it('a full scheme URL shows no search alternative', () => {
        const { rows } = build('https://example.com/x', { suggestions: [] });
        expect(rows.map((r) => r.kind)).toEqual(['url']);
    });

    it('plain words search by default', () => {
        const { rows, completion } = build('how to', { suggestions: [] });
        expect(rows[0].kind).toBe('search');
        expect(rows[0].isDefault).toBe(true);
        expect(completion).toBeNull();
    });

    it('switch-to-tab rows follow the primary rows and skip the active tab', () => {
        const tabs = [
            { id: 't1', url: 'https://httpbin.org/get', title: 'get', isActive: true },
            { id: 't2', url: 'https://httpbin.org/bytes/5', title: 'bytes', isActive: false, isolated: true },
        ];
        const { rows } = build('bytes', { suggestions: [], tabs, activeTabId: 't1' });
        const tab = rows.find((r) => r.kind === 'tab');
        expect(tab.tabId).toBe('t2');
        expect(tab.badge).toBe('isolated');
        expect(rows.findIndex((r) => r.kind === 'tab')).toBe(1);
    });

    it('quick links match on word prefix only (no subsequence)', () => {
        expect(build('htt', { suggestions: [] }).rows.some((r) => r.label === 'User guide')).toBe(false);
        expect(build('gui', { suggestions: [] }).rows.some((r) => r.label === 'User guide')).toBe(true);
        expect(build('hist', { suggestions: [] }).rows.some((r) => r.url === 'cupnet://history')).toBe(true);
    });

    it('internal alias opens the page as row 1 without a search row', () => {
        const { rows } = build('cupnet://settings', { suggestions: [] });
        expect(rows[0].kind).toBe('url');
        expect(rows[0].url).toBe('cupnet://settings');
        expect(rows.some((r) => r.kind === 'search')).toBe(false);
    });

    it('zero-suggest lists recent, top sites and quick links', () => {
        const recent = [row('https://a.example/', { title: 'A' }), row('https://b.example/')];
        const topSites = [row('https://a.example/'), row('https://c.example/', { visits: 9 })];
        const { rows, mode } = build('', { recent, topSites });
        expect(mode).toBe('zero');
        expect(rows[0].sub).toBe('Recent');
        expect(rows[0].label).toBe('A');
        expect(rows[1].label).toBe('b.example');
        expect(rows[2].sub).toBe('Top site');
        expect(rows[2].url).toBe('https://c.example/');
        expect(rows.filter((r) => r.sub === 'CupNet').length).toBe(model.QUICK_LINKS.length);
    });

    it('command mode filters by word prefix and falls back to subsequence', () => {
        const commands = [
            { label: 'Reload page', category: 'Navigation', keywords: 'refresh', run() {} },
            { label: 'Open Settings', category: 'Navigation', keywords: 'preferences', run() {} },
            { label: 'Take screenshot', category: 'Page', keywords: 'capture', run() {} },
        ];
        expect(build('> set', { commands }).rows.map((r) => r.label)).toEqual(['Open Settings']);
        expect(build('> refr', { commands }).rows.map((r) => r.label)).toEqual(['Reload page']);
        expect(build('> tks', { commands }).rows.map((r) => r.label)).toEqual(['Take screenshot']);
        expect(build('>', { commands }).rows.length).toBe(3);
    });

    it('caps the list and marks isolated history rows', () => {
        const suggestions = model.rankSuggestions(
            Array.from({ length: 20 }, (_, i) => row(`https://site${i}.example/`, { cg: i % 2 ? 7 : 1 })),
            'site', { nowMs: NOW, limit: 20 }
        );
        const { rows } = build('site', { suggestions, maxRows: 8 });
        expect(rows.length).toBe(8);
        expect(rows.some((r) => r.badge === 'isolated')).toBe(true);
    });

    it('inlineEnabled=false suppresses the completion but keeps the default row', () => {
        const suggestions = model.rankSuggestions([row('https://wikipedia.org/')], 'wiki', { nowMs: NOW });
        const { rows, completion } = build('wiki', { suggestions, inlineEnabled: false });
        expect(rows[0].isDefault).toBe(true);
        expect(completion).toBeNull();
    });
});

describe('text helpers', () => {
    it('wordPrefixMatch and subsequenceMatch', () => {
        expect(model.wordPrefixMatch('op set', 'Open Settings Navigation')).toBe(true);
        expect(model.wordPrefixMatch('htt', 'help documentation manual')).toBe(false);
        expect(model.subsequenceMatch('htt', 'help documentation manual')).toBe(true);
    });
    it('displayUrlText strips scheme and a root slash only', () => {
        expect(model.displayUrlText('https://www.wikipedia.org/')).toBe('www.wikipedia.org');
        expect(model.displayUrlText('https://httpbin.org/get/')).toBe('httpbin.org/get/');
    });
});
