#!/usr/bin/env node
'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { _electron as electron } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const HARD_TIMEOUT = setTimeout(() => {
    console.log('RESULT: TIMEOUT');
    process.exit(2);
}, 45_000);
HARD_TIMEOUT.unref();

function electronPath() {
    if (process.platform === 'darwin') {
        return path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    }
    return path.join(root, 'node_modules/electron/dist/electron');
}

async function waitFor(app, fn, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            if (await app.evaluate(fn)) return;
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('waitFor timeout');
}

async function main() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-tabnav-'));
    const env = { ...process.env, CUPNET_E2E: '1' };
    delete env.ELECTRON_RUN_AS_NODE;

    const app = await electron.launch({
        cwd: root,
        executablePath: electronPath(),
        args: ['.', `--user-data-dir=${userDataDir}`],
        env,
    });

    await waitFor(app, () => {
        const ctx = globalThis.__cupnetAppContext;
        return !!(ctx?.mitm?.ready && ctx?.modules?.tabManager?.getActiveTab?.());
    });

    await app.evaluate(() => {
        globalThis.__navEvents = [];
        const wc = globalThis.__cupnetAppContext?.modules?.tabManager?.getActiveTab?.()?.view?.webContents;
        if (!wc || wc.isDestroyed()) return;
        wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
            if (isMain) globalThis.__navEvents.push({ ev: 'fail', code, desc, url });
        });
        wc.on('did-finish-load', () => {
            globalThis.__navEvents.push({ ev: 'finish', url: wc.getURL() });
        });
        wc.loadURL('https://example.com/').catch((e) => {
            globalThis.__navEvents.push({ ev: 'reject', msg: e?.message || String(e) });
        });
    });

    let finalUrl = '';
    let events = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        finalUrl = await app.evaluate(() => {
            const wc = globalThis.__cupnetAppContext?.modules?.tabManager?.getActiveTab?.()?.view?.webContents;
            return wc && !wc.isDestroyed() ? wc.getURL() : '';
        }).catch(() => '');
        events = await app.evaluate(() => globalThis.__navEvents || []).catch(() => []);
        if (finalUrl.startsWith('https://example.com')) break;
        if (events.some((e) => e.ev === 'fail' || e.ev === 'reject')) break;
        await new Promise((r) => setTimeout(r, 400));
    }

    const stats = await app.evaluate(() => globalThis.__cupnetAppContext?.modules?.mitmProxy?.getStats?.() || null).catch(() => null);
    const ok = finalUrl.startsWith('https://example.com') && (stats?.requests || 0) > 0;

    console.log('RESULT:', ok ? 'PASS' : 'FAIL');
    console.log('FINAL_URL:', finalUrl);
    console.log('MITM_REQUESTS:', stats?.requests ?? 'null');
    console.log('EVENTS:', JSON.stringify(events));

    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    clearTimeout(HARD_TIMEOUT);
    process.exit(ok ? 0 : 1);
}

main().catch((e) => {
    console.log('RESULT: ERROR', e?.message || e);
    process.exit(1);
});
