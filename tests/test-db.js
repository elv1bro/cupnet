'use strict';
/**
 * Tests for db.js — SQLite layer.
 * Run: node tests/test-db.js
 *
 * Uses db.initWithPath(':memory:') — no Electron required.
 * better-sqlite3 must match the current node architecture.
 * Run via Electron's bundled node (arm64 Mac):
 *   ELECTRON_RUN_AS_NODE=1 /path/to/Electron.app/Contents/MacOS/Electron tests/test-db.js
 * Or from the project root (standard node if arch matches):
 *   node tests/test-db.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');

// ── Load db without Electron dependency ──────────────────────────────────────
// We mock `electron` minimally since db.js imports it at module level.
// The actual app.getPath call is bypassed by using initWithPath() directly.
const Module = require('module');
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = (request, ...args) => {
    if (request === 'electron') return 'electron';
    return origResolve(request, ...args);
};
require.cache['electron'] = {
    id: 'electron', filename: 'electron', loaded: true,
    exports: { app: { getPath: () => os.tmpdir() } },
};

let db;
try {
    db = require('../db');
} catch (e) {
    if (e.message && e.message.includes('incompatible architecture')) {
        console.log('\n⚠  Skipping db tests: better-sqlite3 native addon architecture mismatch.');
        console.log('   Run with Electron\'s node: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/test-db.js\n');
        process.exit(0);
    }
    throw e;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-db-test-'));
const TEST_DB = path.join(tmpDir, 'test.db');

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

before(() => {
    db.initWithPath(TEST_DB);
});

after(() => {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ─── Sessions ─────────────────────────────────────────────────────────────────

test('createSession: returns a row with an id', () => {
    const row = db.createSession('http://proxy:8080', 'tab_1');
    assert.ok(row, 'Should return a row');
    assert.ok(typeof row.id === 'number' && row.id > 0, `Expected numeric id, got ${row.id}`);
});

test('createSession: works with null proxy_info', () => {
    const row = db.createSession(null, 'tab_2');
    assert.ok(row.id > 0);
});

test('getSessions: returns sessions sorted by id desc (most recent first)', () => {
    const s1 = db.createSession('proxy-A', 'tab_1');
    const s2 = db.createSession('proxy-B', 'tab_2');
    const list = db.getSessions(10, 0);
    const ids = list.map(s => s.id);
    // Both should appear in the list; s2 has higher auto-increment id → comes first
    assert.ok(ids.includes(s1.id), 's1 should be in the list');
    assert.ok(ids.includes(s2.id), 's2 should be in the list');
    // In DESC order s2 (higher id) should appear before s1
    assert.ok(ids.indexOf(s2.id) < ids.indexOf(s1.id), 'Higher id (newer) should come first');
});

test('endSession: sets ended_at', () => {
    const s = db.createSession(null, null);
    db.endSession(s.id);
    const list = db.getSessions(100, 0);
    const found = list.find(r => r.id === s.id);
    assert.ok(found, 'Session should still exist');
    assert.ok(found.ended_at, 'ended_at should be set');
});

test('renameSession: sets notes field', () => {
    const s = db.createSession(null, null);
    db.renameSession(s.id, 'My test session');
    const list = db.getSessions(100, 0);
    const found = list.find(r => r.id === s.id);
    assert.equal(found.notes, 'My test session');
});

test('deleteSession: removes session and cascades to requests', () => {
    const s = db.createSession('proxy-del', 'tab_del');
    db.insertRequest(s.id, 'tab_del', {
        requestId: 'r1', url: 'https://example.com', method: 'GET',
        status: 200, type: 'document', duration: 100,
    });
    db.deleteSession(s.id);
    const list = db.getSessions(100, 0);
    assert.ok(!list.find(r => r.id === s.id), 'Session should be deleted');
    // Verify cascaded deletion
    const reqs = db.queryRequests({ sessionId: s.id });
    assert.equal(reqs.length, 0, 'Requests should be cascade-deleted');
});

test('deleteEmptySessions: removes sessions with no requests', () => {
    const empty = db.createSession('empty-proxy', null);
    const withReqs = db.createSession('busy-proxy', null);
    db.insertRequest(withReqs.id, null, { requestId: 'rx', url: 'https://keep.me', method: 'GET', status: 200, type: 'xhr', duration: 10 });

    db.deleteEmptySessions(withReqs.id); // keep withReqs as "current"

    const list = db.getSessions(100, 0);
    assert.ok(!list.find(s => s.id === empty.id),    'Empty session should be deleted');
    assert.ok(list.find(s => s.id === withReqs.id),  'Session with requests should remain');
});

// ─── Requests ─────────────────────────────────────────────────────────────────

test('insertRequest: returns a numeric id', () => {
    const s   = db.createSession(null, null);
    const id  = db.insertRequest(s.id, 'tab_1', {
        requestId: 'abc', url: 'https://example.com/api',
        method: 'POST', status: 201, type: 'xhr', duration: 55,
        requestHeaders:  { 'content-type': 'application/json' },
        responseHeaders: { 'x-req-id': '123' },
        requestBody:     '{"key":"val"}',
        responseBody:    '{"ok":true}',
    });
    assert.ok(typeof id === 'number' && id > 0);
});

test('getRequest: retrieves full request detail', () => {
    const s  = db.createSession(null, null);
    const id = db.insertRequest(s.id, 'tab_x', {
        requestId: 'full-test', url: 'https://full.test/path?q=1',
        method: 'GET', status: 200, type: 'document', duration: 123,
        requestHeaders: { accept: '*/*' },
        responseBody: '<html>ok</html>',
    });
    const row = db.getRequest(id);
    assert.ok(row, 'Should find the request');
    assert.equal(row.url,    'https://full.test/path?q=1');
    assert.equal(row.method, 'GET');
    assert.equal(row.status, 200);
    assert.equal(row.duration_ms, 123);
    assert.equal(row.response_body, '<html>ok</html>');
});

test('queryRequests: filter by sessionId', () => {
    const s1 = db.createSession(null, null);
    const s2 = db.createSession(null, null);
    db.insertRequest(s1.id, null, { requestId: 'q1', url: 'https://s1.com', method: 'GET', status: 200, type: 'xhr', duration: 10 });
    db.insertRequest(s1.id, null, { requestId: 'q2', url: 'https://s1-b.com', method: 'GET', status: 200, type: 'xhr', duration: 20 });
    db.insertRequest(s2.id, null, { requestId: 'q3', url: 'https://s2.com', method: 'GET', status: 200, type: 'xhr', duration: 30 });

    const s1Reqs = db.queryRequests({ sessionId: s1.id });
    assert.ok(s1Reqs.every(r => r.session_id === s1.id), 'All results should belong to s1');
    assert.ok(s1Reqs.length >= 2, 'Should find at least 2 requests for s1');
});

test('queryRequests: filter by method', () => {
    const s = db.createSession(null, null);
    db.insertRequest(s.id, null, { requestId: 'm1', url: 'https://a.com', method: 'GET',  status: 200, type: 'xhr', duration: 1 });
    db.insertRequest(s.id, null, { requestId: 'm2', url: 'https://b.com', method: 'POST', status: 201, type: 'xhr', duration: 1 });
    db.insertRequest(s.id, null, { requestId: 'm3', url: 'https://c.com', method: 'PUT',  status: 200, type: 'xhr', duration: 1 });

    const posts = db.queryRequests({ sessionId: s.id, method: 'POST' });
    assert.ok(posts.every(r => r.method === 'POST'));
    assert.ok(posts.length >= 1);
});

test('queryRequests: filter by status code', () => {
    const s = db.createSession(null, null);
    db.insertRequest(s.id, null, { requestId: 'st1', url: 'https://ok.com', method: 'GET', status: 200, type: 'xhr', duration: 1 });
    db.insertRequest(s.id, null, { requestId: 'st2', url: 'https://err.com', method: 'GET', status: 404, type: 'xhr', duration: 1 });

    const notFound = db.queryRequests({ sessionId: s.id, status: 404 });
    assert.ok(notFound.every(r => r.status === 404));
    assert.ok(notFound.length >= 1);
});

test('queryRequests: filter by URL fragment', () => {
    const s = db.createSession(null, null);
    db.insertRequest(s.id, null, { requestId: 'u1', url: 'https://api.example.com/v2/users', method: 'GET', status: 200, type: 'xhr', duration: 1 });
    db.insertRequest(s.id, null, { requestId: 'u2', url: 'https://other.domain.net/page', method: 'GET', status: 200, type: 'xhr', duration: 1 });

    const results = db.queryRequests({ sessionId: s.id, url: 'api.example.com' });
    assert.ok(results.every(r => r.url.includes('api.example.com')));
    assert.ok(results.length >= 1);
});

test('queryRequests: pagination (limit/offset)', () => {
    const s = db.createSession(null, null);
    for (let i = 0; i < 10; i++) {
        db.insertRequest(s.id, null, { requestId: `pag-${i}`, url: `https://page.test/${i}`, method: 'GET', status: 200, type: 'xhr', duration: i });
    }
    const page1 = db.queryRequests({ sessionId: s.id }, 5, 0);
    const page2 = db.queryRequests({ sessionId: s.id }, 5, 5);
    assert.equal(page1.length, 5);
    assert.equal(page2.length, 5);
    // Pages should not overlap
    const ids1 = new Set(page1.map(r => r.id));
    const ids2 = new Set(page2.map(r => r.id));
    for (const id of ids2) {
        assert.ok(!ids1.has(id), 'Pages should not overlap');
    }
});

test('countRequests: returns correct count', () => {
    const s = db.createSession(null, null);
    db.insertRequest(s.id, null, { requestId: 'c1', url: 'https://count.test/1', method: 'GET', status: 200, type: 'xhr', duration: 1 });
    db.insertRequest(s.id, null, { requestId: 'c2', url: 'https://count.test/2', method: 'GET', status: 200, type: 'xhr', duration: 1 });
    db.insertRequest(s.id, null, { requestId: 'c3', url: 'https://count.test/3', method: 'POST', status: 201, type: 'xhr', duration: 1 });

    const total = db.countRequests({ sessionId: s.id });
    assert.ok(total >= 3, `Expected >= 3, got ${total}`);

    const posts = db.queryRequests({ sessionId: s.id, method: 'POST' }).length;
    assert.ok(posts >= 1);
});

// ─── WebSocket events ─────────────────────────────────────────────────────────

test('insertWsEvent: does not throw', () => {
    const s = db.createSession(null, null);
    assert.doesNotThrow(() => {
        db.insertWsEvent(s.id, 'tab_ws', 'wss://echo.ws', 'send', 'ping');
        db.insertWsEvent(s.id, 'tab_ws', 'wss://echo.ws', 'recv', 'pong');
    });
});

// ─── Screenshots ──────────────────────────────────────────────────────────────

test('insertScreenshot: returns numeric id', () => {
    const s  = db.createSession(null, null);
    const id = db.insertScreenshot(s.id, 'tab_ss', 'autoscreen:///test.png', 'BASE64DATA==');
    assert.ok(typeof id === 'number' && id > 0);
});

test('getScreenshotEntriesForSession: returns formatted entries', () => {
    const s  = db.createSession(null, null);
    db.insertScreenshot(s.id, 'tab_1', 'screen_a.png', 'AAAA==');
    db.insertScreenshot(s.id, 'tab_1', 'screen_b.png', 'BBBB==');

    const entries = db.getScreenshotEntriesForSession(s.id);
    assert.ok(entries.length >= 2, 'Should return both screenshots');
    assert.equal(entries[0].type, 'screenshot');
    assert.ok(entries[0].ssDbId, 'Should include lazy screenshot DB id');
    assert.ok(entries[0].id.startsWith('ss-'), 'id should be prefixed with "ss-"');
});

// ─── Proxy profiles ───────────────────────────────────────────────────────────

test('saveProxyProfile: insert and retrieve', () => {
    const id = db.saveProxyProfile('Test Proxy', null, 'http://proxy.test:8080', {
        isTemplate: 0,
        country: 'US',
    });
    assert.ok(typeof id === 'number' && id > 0, 'Should return numeric id');

    const list = db.getProxyProfiles();
    const found = list.find(p => p.id === id);
    assert.ok(found, 'Should find profile in list');
    assert.equal(found.name, 'Test Proxy');
    assert.equal(found.url_display, 'http://proxy.test:8080');
    assert.equal(found.traffic_mode, 'browser_proxy');
});

test('saveProxyProfile: update if name already exists', () => {
    const name = 'Duplicate Name ' + Date.now();
    const id1  = db.saveProxyProfile(name, null, 'http://v1:8080', {});
    const id2  = db.saveProxyProfile(name, null, 'http://v2:8080', {});
    assert.equal(id1, id2, 'Second save with same name should return same id');
    const found = db.getProxyProfiles().find(p => p.id === id1);
    assert.equal(found.url_display, 'http://v2:8080', 'Should update display URL');
});

test('deleteProxyProfile: removes profile', () => {
    const id = db.saveProxyProfile('To Delete ' + Date.now(), null, 'http://del.test', {});
    db.deleteProxyProfile(id);
    const found = db.getProxyProfiles().find(p => p.id === id);
    assert.ok(!found, 'Profile should be deleted');
});

test('updateProxyProfileTest: updates test stats', () => {
    const id = db.saveProxyProfile('Tested Proxy ' + Date.now(), null, 'http://tested.test', {});
    db.updateProxyProfileTest(id, 250, '1.2.3.4', 'New York, US');
    const found = db.getProxyProfiles().find(p => p.id === id);
    assert.equal(found.last_latency_ms, 250);
    assert.equal(found.last_ip, '1.2.3.4');
    assert.equal(found.last_geo, 'New York, US');
});

test('proxy profile traffic_mode: supports CRUD + fallback default', () => {
    const id = db.saveProxyProfile('Mode Profile ' + Date.now(), null, 'http://mode.test', {
        traffic_mode: 'mitm',
    });
    const found = db.getProxyProfiles().find(p => p.id === id);
    assert.ok(found, 'Profile should exist');
    assert.equal(found.traffic_mode, 'mitm');

    db.updateProxyProfileById(id, { traffic_mode: 'browser_proxy' });
    const updated = db.getProxyProfiles().find(p => p.id === id);
    assert.equal(updated.traffic_mode, 'browser_proxy');

    db.updateProxyProfileById(id, { traffic_mode: 'unexpected' });
    const fallback = db.getProxyProfiles().find(p => p.id === id);
    assert.equal(fallback.traffic_mode, 'browser_proxy');
});

// ─── FTS search ───────────────────────────────────────────────────────────────

test('ftsSearch: finds requests by URL keyword', () => {
    const s = db.createSession(null, null);
    db.insertRequest(s.id, null, {
        requestId: 'fts1', url: 'https://api.example.com/checkoutpage',
        method: 'GET', status: 200, type: 'document', duration: 100,
        responseBody: '{"result":"ok"}',
    });
    db.insertRequest(s.id, null, {
        requestId: 'fts2', url: 'https://other.site.com/login',
        method: 'POST', status: 200, type: 'xhr', duration: 50,
        responseBody: '{"token":"abc"}',
    });

    const results = db.ftsSearch('checkoutpage', s.id);
    assert.ok(results.some(r => r.url.includes('checkoutpage')), 'Should find checkoutpage URL');
});

test('ftsSearch: returns empty array on no match', () => {
    const s = db.createSession(null, null);
    db.insertRequest(s.id, null, {
        requestId: 'fts3', url: 'https://xyz.com/abc',
        method: 'GET', status: 200, type: 'xhr', duration: 1,
    });
    const results = db.ftsSearch('zzznomatchzzz', s.id);
    assert.ok(Array.isArray(results), 'Should return array');
    assert.equal(results.length, 0);
});

// ─── getSessionsWithStats ─────────────────────────────────────────────────────

test('getSessionsWithStats: returns sessions with request counts', () => {
    const s = db.createSession('stats-proxy', null);
    db.insertRequest(s.id, null, { requestId: 'sw1', url: 'https://a.com', method: 'GET', status: 200, type: 'xhr', duration: 1 });
    db.insertRequest(s.id, null, { requestId: 'sw2', url: 'https://b.com', method: 'GET', status: 200, type: 'xhr', duration: 1 });

    const list = db.getSessionsWithStats(100, 0);
    const found = list.find(r => r.id === s.id);
    assert.ok(found, 'Session should appear in stats list');
    assert.ok(found.request_count >= 2, `Expected >= 2 requests, got ${found.request_count}`);
});

test('getSessionsWithStats: empty sessions excluded (HAVING COUNT > 0)', () => {
    const empty = db.createSession('no-requests', null);
    const list  = db.getSessionsWithStats(100, 0);
    assert.ok(!list.find(s => s.id === empty.id), 'Empty session should not appear in stats');
});

test('insertTraceEntryQueued: enqueues and writes trace row', async () => {
    const id = await db.insertTraceEntryQueued({
        ts: new Date().toISOString(),
        method: 'GET',
        url: 'https://trace.queue.test',
        requestHeaders: { a: 'b' },
        responseHeaders: { c: 'd' },
        status: 200,
        duration: 12,
    });
    assert.ok(typeof id === 'number' && id > 0, 'Queued trace write should return id');
});

test('async write-path: createSessionAsync/insertRequestAsync works', async () => {
    const s = await db.createSessionAsync('async-proxy', 'tab_async');
    assert.ok(s && s.id > 0, 'createSessionAsync should return session');
    const reqId = await db.insertRequestAsync(s.id, 'tab_async', {
        requestId: 'async-1',
        url: 'https://async.queue.test',
        method: 'GET',
        status: 200,
        type: 'xhr',
        duration: 4,
    });
    assert.ok(reqId && reqId > 0, 'insertRequestAsync should return request id');
});

test('write queue stats expose high/low depths and drops', async () => {
    await db.insertTraceEntryQueued({
        ts: new Date().toISOString(),
        method: 'GET',
        url: 'https://trace.queue.stats.test',
        status: 200,
    });
    const stats = db.getWriteQueueStats();
    assert.equal(typeof stats.highPriorityDepth, 'number');
    assert.equal(typeof stats.lowPriorityDepth, 'number');
    assert.equal(typeof stats.droppedLow, 'number');
    assert.equal(typeof stats.droppedHigh, 'number');
    assert.equal(typeof stats.busyRetries, 'number');
});

console.log('\n✓ All db tests passed\n');
