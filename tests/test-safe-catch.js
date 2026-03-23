'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const Module = require('module');
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = (request, ...args) => {
    if (request === 'electron') return 'electron';
    return origResolve(request, ...args);
};
require.cache.electron = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: {
        app: { getPath: () => os.tmpdir() },
        BrowserWindow: { getAllWindows: () => [] },
        ipcMain: { handle: () => {} },
    },
};

const { safeCatch, getEntries } = require('../sys-log');

test('safeCatch: writes structured event with required fields', () => {
    safeCatch(
        { module: 'tests', eventCode: 'db.write.failed', context: { op: 'unit' } },
        new Error('boom'),
        'warn'
    );
    const last = getEntries('warn', 1)[0];
    assert.ok(last, 'Expected log entry');
    assert.equal(last.module, 'tests');
    assert.ok(last.message.includes('db.write.failed'));
    assert.equal(last.data.eventCode, 'db.write.failed');
    assert.equal(last.data.context.op, 'unit');
    assert.ok(typeof last.data.stack === 'string' || last.data.stack === null);
});

console.log('\n✓ safeCatch tests passed\n');
