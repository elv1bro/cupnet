'use strict';

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLoadOptionsFromNavigationRetry, isTabErrorPageUrl } from '../../main-process/services/tab-error-page.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ERROR_PAGE_HREF = pathToFileURL(path.join(REPO_ROOT, 'error-page.html')).href;

describe('tab-error-page navigation retry', () => {
    it('buildLoadOptionsFromNavigationRetry builds POST loadURL options', () => {
        const opts = buildLoadOptionsFromNavigationRetry({
            url: 'https://example.com/submit',
            method: 'POST',
            postDataChunks: [Buffer.from('a=1&b=2')],
            contentType: 'application/x-www-form-urlencoded',
            referrer: 'https://example.com/form',
        });
        assert.equal(opts.postData?.length, 1);
        assert.equal(opts.postData[0].type, 'rawData');
        assert.equal(opts.postData[0].bytes.toString(), 'a=1&b=2');
        assert.match(opts.extraHeaders, /Content-Type: application\/x-www-form-urlencoded/);
        assert.equal(opts.httpReferrer, 'https://example.com/form');
    });

    it('buildLoadOptionsFromNavigationRetry returns empty for GET', () => {
        assert.deepEqual(buildLoadOptionsFromNavigationRetry({ url: 'https://x.com', method: 'GET' }), {});
    });
});

describe('isTabErrorPageUrl (A-318)', () => {
    it('matches the real error-page file URL, with or without a query/hash', () => {
        assert.equal(isTabErrorPageUrl(ERROR_PAGE_HREF), true);
        assert.equal(isTabErrorPageUrl(`${ERROR_PAGE_HREF}?url=https%3A%2F%2Fx.com&status=502`), true);
        assert.equal(isTabErrorPageUrl(`${ERROR_PAGE_HREF}#frag`), true);
        // The internal skip-check lower-cases the URL before calling in — must still match.
        assert.equal(isTabErrorPageUrl(ERROR_PAGE_HREF.toLowerCase()), true);
    });

    it('does not match remote URLs that merely contain the substring', () => {
        assert.equal(isTabErrorPageUrl('https://evil.com/error-page.html'), false);
        assert.equal(isTabErrorPageUrl('https://evil.com/a/error-page.html?x=1'), false);
        assert.equal(isTabErrorPageUrl('https://x.com/?p=error-page.html'), false);
        assert.equal(isTabErrorPageUrl('about:blank'), false);
        assert.equal(isTabErrorPageUrl(''), false);
        assert.equal(isTabErrorPageUrl(null), false);
    });
});
