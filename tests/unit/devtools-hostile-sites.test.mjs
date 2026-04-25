import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    isDevtoolsHostileUrl,
    isDevtoolsHostileWebContents,
    addDevtoolsHostileHost,
    setDevtoolsHostileHosts,
    listDevtoolsHostileHosts,
    DEFAULT_HOSTILE_HOSTS,
} = require('../../main-process/services/devtools-hostile-sites.js');

function fakeWc(url, { destroyed = false } = {}) {
    return {
        isDestroyed: () => destroyed,
        getURL: () => url,
    };
}

describe('devtools-hostile-sites', () => {
    beforeEach(() => {
        setDevtoolsHostileHosts(DEFAULT_HOSTILE_HOSTS);
    });

    it('matches the registered host and its subdomains', () => {
        expect(isDevtoolsHostileUrl('https://ozforensics.com/trynow')).toBe(true);
        expect(isDevtoolsHostileUrl('https://www.ozforensics.com/trynow')).toBe(true);
        expect(isDevtoolsHostileUrl('https://demo.ozforensics.com/path?x=1')).toBe(true);
    });

    it('does not match unrelated hosts that merely contain the suffix', () => {
        expect(isDevtoolsHostileUrl('https://notozforensics.com/')).toBe(false);
        expect(isDevtoolsHostileUrl('https://ozforensics.com.evil.example/')).toBe(false);
    });

    it('ignores file://, about:, chrome://, data: and other internal schemes', () => {
        expect(isDevtoolsHostileUrl('about:blank')).toBe(false);
        expect(isDevtoolsHostileUrl('file:///tmp/new-tab.html')).toBe(false);
        expect(isDevtoolsHostileUrl('chrome://settings')).toBe(false);
        expect(isDevtoolsHostileUrl('chrome-error://chromewebdata/')).toBe(false);
        expect(isDevtoolsHostileUrl('data:text/html,<p>hi</p>')).toBe(false);
    });

    it('handles invalid input safely', () => {
        expect(isDevtoolsHostileUrl('')).toBe(false);
        expect(isDevtoolsHostileUrl(null)).toBe(false);
        expect(isDevtoolsHostileUrl(undefined)).toBe(false);
        expect(isDevtoolsHostileUrl('not a url')).toBe(false);
    });

    it('unwraps view-source: URLs so they still match', () => {
        expect(isDevtoolsHostileUrl('view-source:https://ozforensics.com/x')).toBe(true);
    });

    it('strips port from host', () => {
        expect(isDevtoolsHostileUrl('https://ozforensics.com:8443/x')).toBe(true);
    });

    it('isDevtoolsHostileWebContents follows the URL test and tolerates destroyed/missing wc', () => {
        expect(isDevtoolsHostileWebContents(null)).toBe(false);
        expect(isDevtoolsHostileWebContents(undefined)).toBe(false);
        expect(isDevtoolsHostileWebContents(fakeWc('https://ozforensics.com/'))).toBe(true);
        expect(isDevtoolsHostileWebContents(fakeWc('https://example.com/'))).toBe(false);
        expect(isDevtoolsHostileWebContents(fakeWc('https://ozforensics.com/', { destroyed: true }))).toBe(false);
    });

    it('addDevtoolsHostileHost extends the registry; setDevtoolsHostileHosts replaces it', () => {
        expect(isDevtoolsHostileUrl('https://example.com/')).toBe(false);
        expect(addDevtoolsHostileHost('Example.COM')).toBe(1);
        expect(addDevtoolsHostileHost('example.com')).toBe(0);
        expect(isDevtoolsHostileUrl('https://example.com/')).toBe(true);
        expect(isDevtoolsHostileUrl('https://api.example.com/')).toBe(true);

        setDevtoolsHostileHosts([]);
        expect(isDevtoolsHostileUrl('https://ozforensics.com/')).toBe(false);
        expect(listDevtoolsHostileHosts()).toEqual([]);
    });
});
