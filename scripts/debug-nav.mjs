#!/usr/bin/env node
'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { _electron as electron } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function electronPath() {
    if (process.platform === 'darwin') {
        return path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    }
    return path.join(root, 'node_modules/electron/dist/electron');
}

async function waitFor(fn, timeoutMs = 120_000, intervalMs = 300) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const v = await fn();
            if (v) return v;
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitFor timeout ${timeoutMs}ms`);
}

async function main() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupnet-debug-'));
    const env = { ...process.env, CUPNET_E2E: '1', CUPNET_DEBUG_MITM: '1' };
    delete env.ELECTRON_RUN_AS_NODE;

    const app = await electron.launch({
        cwd: root,
        executablePath: electronPath(),
        args: ['.', `--user-data-dir=${userDataDir}`],
        env,
    });

    const logs = [];
    app.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
    const proc = app.process();
    proc.stderr?.on('data', (d) => logs.push(`[stderr] ${d.toString().trimEnd()}`));
    proc.stdout?.on('data', (d) => logs.push(`[stdout] ${d.toString().trimEnd()}`));

    await waitFor(async () => {
        return app.evaluate(() => {
            const ctx = globalThis.__cupnetAppContext;
            return !!(ctx?.mitm?.ready && ctx?.modules?.tabManager?.getActiveTab?.());
        });
    }, 120_000);

    const pre = await app.evaluate(async () => {
        const tm = globalThis.__cupnetAppContext?.modules?.tabManager;
        const tab = tm?.getActiveTab?.();
        const wc = tab?.view?.webContents;
        const sess = wc?.session;
        let resolveProxy = '';
        try {
            resolveProxy = await sess.resolveProxy('https://example.com/');
        } catch (e) {
            resolveProxy = `err:${e?.message || e}`;
        }
        return {
            tabUrl: wc?.getURL?.() || '',
            tabTitle: tab?.title || '',
            resolveProxy,
            mitmReady: !!globalThis.__cupnetAppContext?.mitm?.ready,
        };
    });
    console.log('PRE-NAV', JSON.stringify(pre, null, 2));

    // curl through MITM while app is running
    const caPath = path.join(userDataDir, 'mitm-ca', 'ca-cert.pem');
    const curl = spawn('curl', [
        '-sS', '-m', '20', '--proxy', 'http://127.0.0.1:8877',
        '-k', 'https://example.com/',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let curlOut = '';
    curl.stdout.on('data', (d) => { curlOut += d; });
    let curlErr = '';
    curl.stderr.on('data', (d) => { curlErr += d; });
    const curlCode = await new Promise((r) => curl.on('close', r));
    console.log('CURL', { code: curlCode, err: curlErr.slice(0, 200), bodyLen: curlOut.length, snippet: curlOut.slice(0, 120) });

    const navResult = await app.evaluate(async () => {
        const tm = globalThis.__cupnetAppContext?.modules?.tabManager;
        const tab = tm?.getActiveTab?.();
        const wc = tab?.view?.webContents;
        if (!wc || wc.isDestroyed()) return { error: 'no wc' };

        const errors = [];
        const handler = (_e, code, desc, url, isMain) => {
            if (isMain) errors.push({ code, desc, url });
        };
        wc.on('did-fail-load', handler);
        wc.on('did-finish-load', () => { errors.push({ code: 0, desc: 'did-finish-load', url: wc.getURL() }); });

        const t0 = Date.now();
        try {
            await Promise.race([
                wc.loadURL('https://example.com/'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('loadURL timeout 30s')), 30_000)),
            ]);
        } catch (e) {
            errors.push({ code: -999, desc: e?.message || String(e), url: 'https://example.com/' });
        }

        await new Promise((r) => setTimeout(r, 2000));
        wc.removeListener('did-fail-load', handler);

        let body = '';
        try {
            body = await wc.executeJavaScript(`document.body ? document.body.innerText.slice(0, 200) : ''`);
        } catch (e) {
            body = `execErr:${e?.message || e}`;
        }

        return {
            ms: Date.now() - t0,
            finalUrl: wc.getURL(),
            title: tab.title,
            errors,
            body,
        };
    });
    console.log('NAV', JSON.stringify(navResult, null, 2));

    const mitmStats = await app.evaluate(() => {
        const p = globalThis.__cupnetAppContext?.modules?.mitmProxy;
        return p?.getStats?.() || null;
    }).catch(() => null);
    console.log('MITM_STATS', mitmStats);

    console.log('--- LOGS (last 60) ---');
    logs.slice(-60).forEach((l) => console.log(l));

    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
