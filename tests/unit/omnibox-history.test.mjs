import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);

function canLoadBetterSqlite() {
    try {
        const Database = require('better-sqlite3');
        const d = new Database(':memory:');
        d.close();
        return true;
    } catch {
        return false;
    }
}

/** Skip when native module arch mismatches Node (e.g. x64 Node + arm64 better-sqlite3). */
const describeOmnibox = canLoadBetterSqlite() ? describe : describe.skip;

describeOmnibox('omnibox_history', () => {
    let db;
    let tmpDir;
    let TEST_DB;
    let origResolve;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-omnibox-'));
        const fakeElectronPath = path.join(tmpDir, 'electron-shim.cjs');
        fs.writeFileSync(
            fakeElectronPath,
            `'use strict';\nconst os = require('os');\nmodule.exports = { app: { getPath: () => os.tmpdir() } };\n`
        );
        const Module = require('module');
        origResolve = Module._resolveFilename.bind(Module);
        Module._resolveFilename = function resolveWithElectronShim(request, parent, isMain, options) {
            if (request === 'electron') return fakeElectronPath;
            return origResolve(request, parent, isMain, options);
        };
        // eslint-disable-next-line global-require
        db = require('../../db.js');
        TEST_DB = path.join(tmpDir, 'omnibox.db');
        db.initWithPath(TEST_DB);
    });

    afterAll(() => {
        try {
            const Module = require('module');
            if (origResolve) Module._resolveFilename = origResolve;
        } catch {
            /* ignore */
        }
        try {
            db?.close?.();
        } catch {
            /* ignore */
        }
        try {
            if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it('recordOmniboxVisit upserts so repeated visits still surface in suggestions', () => {
        db.recordOmniboxVisit({ url: 'https://example.com/a', title: 'Ex', typed: false });
        db.recordOmniboxVisit({ url: 'https://example.com/a', title: 'Ex2', typed: true });
        const rows = db.getOmniboxSuggestions('example', 10);
        const hit = rows.find((r) => r.url === 'https://example.com/a');
        expect(hit).toBeTruthy();
        expect(hit.title === 'Ex2' || hit.title === 'Ex').toBe(true);
    });

    it('getOmniboxSuggestions returns rows for host match', () => {
        db.recordOmniboxVisit({ url: 'https://unique-omni-test.dev/', title: 'T', typed: false });
        const rows = db.getOmniboxSuggestions('unique-omni', 8);
        expect(rows.some((r) => String(r.url || '').includes('unique-omni-test.dev'))).toBe(true);
    });

    it('ranks more recent typed visits ahead of stale low-traffic rows', () => {
        db.recordOmniboxVisit({ url: 'https://stale-omni.example/old', title: 'Old', typed: false });
        db.recordOmniboxVisit({ url: 'https://fresh-omni.example/new', title: 'New', typed: true });
        const rows = db.getOmniboxSuggestions('omni', 10);
        const iFresh = rows.findIndex((r) => r.url === 'https://fresh-omni.example/new');
        const iStale = rows.findIndex((r) => r.url === 'https://stale-omni.example/old');
        expect(iFresh).toBeGreaterThanOrEqual(0);
        expect(iStale).toBeGreaterThanOrEqual(0);
        expect(iFresh).toBeLessThan(iStale);
    });
});
