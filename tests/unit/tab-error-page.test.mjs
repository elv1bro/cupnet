'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoadOptionsFromNavigationRetry } from '../../main-process/services/tab-error-page.js';

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
