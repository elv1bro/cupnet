'use strict';

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { STORAGE_ACTIVITY_SCRIPT, getStorageActivityScript } from '../../main-process/services/storage-activity.js';

/**
 * Runs the injected STORAGE_ACTIVITY_SCRIPT against a mock main-world environment.
 *
 * The script references the bare globals `window` and `Storage`, so we execute its body with those
 * bound via `new Function`. localStorage/sessionStorage are instances of the mock `Storage` class
 * whose prototype the script patches — mirroring how a real page's storage works.
 *
 * @param {{ bridge?: { report: Function } | undefined }} opts
 * @returns {{ window: object, localStorage: object, sessionStorage: object }}
 */
function runInMockWorld({ bridge } = {}) {
    class Storage {
        constructor() { this._m = new Map(); }
        setItem(k, v) { this._m.set(String(k), String(v)); }
        removeItem(k) { this._m.delete(String(k)); }
        clear() { this._m.clear(); }
        getItem(k) { return this._m.has(String(k)) ? this._m.get(String(k)) : null; }
    }
    const localStorage = new Storage();
    const sessionStorage = new Storage();
    const window = { localStorage, sessionStorage };
    if (bridge !== undefined) window.cupnetStorageActivity = bridge;

    // eslint-disable-next-line no-new-func
    new Function('window', 'Storage', STORAGE_ACTIVITY_SCRIPT)(window, Storage);
    return { window, localStorage, sessionStorage, Storage };
}

describe('storage-activity injected script', () => {
    it('getStorageActivityScript returns the script string', () => {
        assert.equal(getStorageActivityScript(), STORAGE_ACTIVITY_SCRIPT);
        assert.equal(typeof STORAGE_ACTIVITY_SCRIPT, 'string');
        assert.ok(STORAGE_ACTIVITY_SCRIPT.length > 0);
    });

    it('reports set/remove/clear for localStorage with kind, op, key and a stack', () => {
        const events = [];
        const { localStorage } = runInMockWorld({ bridge: { report: (p) => events.push(p) } });

        localStorage.setItem('token', 'abc');
        localStorage.removeItem('token');
        localStorage.clear();

        assert.equal(events.length, 3);

        assert.equal(events[0].kind, 'ls');
        assert.equal(events[0].op, 'set');
        assert.equal(events[0].key, 'token');
        assert.equal(events[0].newValue, 'abc');
        assert.equal(typeof events[0].stack, 'string');
        assert.ok(events[0].stack.length > 0);

        assert.equal(events[1].kind, 'ls');
        assert.equal(events[1].op, 'remove');
        assert.equal(events[1].key, 'token');

        assert.equal(events[2].kind, 'ls');
        assert.equal(events[2].op, 'clear');
    });

    it('tags sessionStorage writes with kind "ss"', () => {
        const events = [];
        const { sessionStorage } = runInMockWorld({ bridge: { report: (p) => events.push(p) } });

        sessionStorage.setItem('k', 'v');

        assert.equal(events.length, 1);
        assert.equal(events[0].kind, 'ss');
        assert.equal(events[0].op, 'set');
    });

    it('still writes through to the native Storage method after reporting', () => {
        const { localStorage } = runInMockWorld({ bridge: { report: () => {} } });
        localStorage.setItem('a', '1');
        assert.equal(localStorage.getItem('a'), '1');
        localStorage.removeItem('a');
        assert.equal(localStorage.getItem('a'), null);
    });

    it('no-ops safely when the cupnetStorageActivity bridge is absent (external pages)', () => {
        // preload may withhold the bridge; the wrapper must not throw and must still persist writes.
        const { localStorage } = runInMockWorld({ bridge: undefined });
        assert.doesNotThrow(() => {
            localStorage.setItem('a', '1');
            localStorage.removeItem('a');
            localStorage.clear();
        });
        localStorage.setItem('b', '2');
        assert.equal(localStorage.getItem('b'), '2');
    });

    it('does not report when report() itself throws', () => {
        const { localStorage } = runInMockWorld({ bridge: { report: () => { throw new Error('bridge down'); } } });
        assert.doesNotThrow(() => localStorage.setItem('a', '1'));
        assert.equal(localStorage.getItem('a'), '1');
    });

    it('is idempotent — a second injection does not double-report', () => {
        const events = [];
        const { window, Storage } = runInMockWorld({ bridge: { report: (p) => events.push(p) } });

        // Re-run the script in the same world (as a re-inject on the same page would).
        // eslint-disable-next-line no-new-func
        new Function('window', 'Storage', STORAGE_ACTIVITY_SCRIPT)(window, Storage);

        window.localStorage.setItem('k', 'v');
        assert.equal(events.length, 1);
    });
});
