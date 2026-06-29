'use strict';

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadCache() {
    const src = readFileSync(path.join(root, 'favicon-cache.js'), 'utf8');
    const ctx = { window: {}, console };
    vm.runInNewContext(src, ctx);
    return ctx.window.CupNetFaviconCache;
}

describe('CupNetFaviconCache', () => {
    /** @type {ReturnType<typeof loadCache>} */
    let cache;

    beforeEach(() => {
        cache = loadCache();
    });

    it('hostKey extracts hostname', () => {
        expect(cache.hostKey('https://Example.COM/path')).toBe('example.com');
        expect(cache.hostKey('cupnet://settings')).toBe('');
    });

    it('resolveSync returns tab favicon and stores it', () => {
        const url = 'https://example.com/a';
        expect(cache.resolveSync(url, 'https://example.com/f.ico')).toBe('https://example.com/f.ico');
        expect(cache.get('example.com')).toBe('https://example.com/f.ico');
        expect(cache.resolveSync(url, null)).toBe('https://example.com/f.ico');
    });

    it('ingestTabs notes favicons from open tabs', () => {
        cache.ingestTabs([
            { url: 'https://foo.test/', faviconUrl: 'https://foo.test/icon.png' },
        ]);
        expect(cache.resolveSync('https://foo.test/page', null)).toBe('https://foo.test/icon.png');
    });
});
