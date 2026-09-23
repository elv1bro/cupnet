'use strict';

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _shouldAutoRetryHttp1, _responseSuggestsHttp1Retry } = require('../../mitm-proxy.js');

describe('mitm HTTP/1.1 fallback heuristics', () => {
    it('detects upstream proxy termination messages', () => {
        const msg = 'upstream connect error or disconnect/reset before headers. reset reason: connection termination';
        assert.equal(_shouldAutoRetryHttp1(msg), true);
    });

    it('responseSuggestsHttp1Retry matches 502 gateway body', () => {
        const body = Buffer.from(
            'upstream connect error or disconnect/reset before headers. reset reason: connection termination',
            'utf8',
        ).toString('base64');
        assert.equal(_responseSuggestsHttp1Retry({ statusCode: 502, bodyBase64: body }), true);
    });

    it('ignores unrelated 404 responses', () => {
        const body = Buffer.from('Not Found', 'utf8').toString('base64');
        assert.equal(_responseSuggestsHttp1Retry({ statusCode: 404, bodyBase64: body }), false);
    });
});
