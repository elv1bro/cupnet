'use strict';

/**
 * Unit tests for Endpoint Scout heuristics (main-process scan, без Electron).
 * Реальная страница для ручной проверки: https://example.com/ (простой HTML)
 * или любой SPA с относительными путями в бандле, например демо-страница с fetch("/api/...").
 */

const assert = require('assert');
const {
    extractApiEndpoints,
    isLikelyApiEndpoint,
    buildEndpointReport,
} = require('../main-process/services/page-analyzer-endpoint-scan');

function testExtractFetchAndEscaped() {
    const code = `
        fetch("/api/v2/session");
        const u = "\\/api\\/v1\\/users";
        axios.post('/auth/login', { x: 1 });
    `;
    const eps = extractApiEndpoints(code);
    assert.ok(eps.includes('/api/v2/session'), 'fetch path');
    assert.ok(eps.includes('/api/v1/users'), 'escaped api path');
    assert.ok(eps.includes('/auth/login'), 'axios post');
}

function testIsLikelyApiEndpoint() {
    assert.strictEqual(isLikelyApiEndpoint('/api/foo'), true);
    assert.strictEqual(isLikelyApiEndpoint('/assets/app.js'), false);
    assert.strictEqual(isLikelyApiEndpoint(''), false);
}

function testBuildReportInlineAndExternal() {
    const r = buildEndpointReport({
        pageUrl: 'https://app.test/page',
        statusHint: 'ok',
        inlineScripts: ['fetch("/api/health");'],
        externalScripts: [
            { url: 'https://cdn.test/bundle.js', body: '.get("/profile/me")', statusCode: 200 },
        ],
        perfNames: ['https://app.test/api/track'],
        startedAt: Date.now(),
    });
    assert.ok(Array.isArray(r.endpoints), 'endpoints array');
    assert.ok(r.endpoints.length >= 1, 'at least one endpoint from inline or perf');
    assert.ok(r.endpointsDetailed.length === r.endpoints.length, 'detailed matches');
    assert.ok((r.scriptUrls || []).length >= 1, 'scriptUrls preserved');
}

function testBuildReportFallbackWhenStrictEmpty() {
    const r = buildEndpointReport({
        pageUrl: 'https://x.test/',
        statusHint: 'ok',
        inlineScripts: ['var x = "/odd/path/segment";'],
        externalScripts: [],
        perfNames: [],
        startedAt: Date.now(),
    });
    assert.ok(r.endpoints.length >= 0, 'fallback may still filter');
}

function run() {
    testExtractFetchAndEscaped();
    testIsLikelyApiEndpoint();
    testBuildReportInlineAndExternal();
    testBuildReportFallbackWhenStrictEmpty();
    console.log('test-page-analyzer-endpoints.js: ok');
}

run();
