'use strict';

/** CupNet mini exit-IP monitor (mini/ip-monitor.js) against a fake worker — no network. */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { IpMonitor } = require('../../mini/ip-monitor.js');
const { SessionLog } = require('../../mini/session-log.js');

const tmpDirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'cupnet-ipmon-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

/** Fake worker: answers IP endpoints with `w.ip` (per proxy when `w.byProxy` is set) and geo lookups. */
function fakeWorker() {
    const w = {
        ip: '203.0.113.10', byProxy: null, fail: null, calls: [], geoCalls: 0,
        async request(o) {
            w.calls.push(o);
            if (w.fail) return { statusCode: 0, error: w.fail };
            const ip = w.byProxy ? w.byProxy[o.proxy || 'direct'] : w.ip;
            if (/ipinfo\.io\//.test(o.url)) {
                w.geoCalls++;
                const at = /ipinfo\.io\/([^/]+)\/json/.exec(o.url)[1];
                return { statusCode: 200, body: JSON.stringify({ ip: at, country: 'de', city: 'Berlin', org: 'AS1 Test' }) };
            }
            if (/ipify/.test(o.url)) return { statusCode: 200, body: JSON.stringify({ ip }) };
            return { statusCode: 200, body: `${ip}\n` };
        },
    };
    return w;
}

function monitor(o = {}) {
    const worker = o.worker || fakeWorker();
    const ctx = { worker, proxy: null, browser: 'chrome', blocked: false, label: 'Direct', mode: 'direct', ...(o.ctx || {}) };
    const mon = new IpMonitor({ file: o.file, getContext: () => ctx, intervalMs: 60000 });
    return { mon, worker, ctx };
}

describe('IpMonitor', () => {
    it('records start, then nothing while the IP holds, then a change', async () => {
        const { mon, worker } = monitor();
        await mon.checkNow();
        await mon.checkNow();
        worker.ip = '203.0.113.11';
        await mon.checkNow();
        const ev = mon.history();
        expect(ev.map((e) => e.type)).toEqual(['change', 'start']);
        expect(ev[0]).toMatchObject({ ip: '203.0.113.11', prevIp: '203.0.113.10', country: 'DE', city: 'Berlin', label: 'Direct' });
        expect(ev[0].heldMs).toBeGreaterThanOrEqual(0);
        expect(mon.summary()).toMatchObject({ ip: '203.0.113.11', ok: true, checks: 3, changes1h: 1 });
        // Fresh connection per check, geo only for new IPs.
        expect(worker.calls.filter((c) => !/ipinfo/.test(c.url)).every((c) => c.forceHttp1 && c.headers.Connection === 'close')).toBe(true);
        expect(worker.geoCalls).toBe(2);
    });

    it('labels a user-made connection change as a switch and never stores the proxy URL', async () => {
        const { mon, worker, ctx } = monitor();
        worker.byProxy = { direct: '198.51.100.1', 'http://u:secret@px.test:8000': '198.51.100.2' };
        await mon.checkNow();
        ctx.proxy = 'http://u:secret@px.test:8000';
        ctx.label = 'My proxy';
        mon.noteSwitch();
        await mon.checkNow();
        const [sw] = mon.history();
        expect(sw).toMatchObject({ type: 'switch', ip: '198.51.100.2', prevIp: '198.51.100.1', label: 'My proxy', via: 'proxy' });
        expect(JSON.stringify(mon.history())).not.toContain('secret');
        expect(worker.calls.at(-1).proxy).toBe('http://u:secret@px.test:8000');
    });

    it('records one error per outage and recovery with the same IP', async () => {
        const { mon, worker } = monitor();
        await mon.checkNow();
        worker.fail = 'proxyconnect tcp: dial tcp: connection refused';
        await mon.checkNow();
        await mon.checkNow();
        expect(mon.summary()).toMatchObject({ ok: false, consecutiveFailures: 2, lastError: 'Proxy refused the connection' });
        worker.fail = null;
        await mon.checkNow();
        expect(mon.history().map((e) => e.type)).toEqual(['recovered', 'error', 'start']);
    });

    it('skips checks while the kill switch blocks direct traffic', async () => {
        const { mon, worker } = monitor({ ctx: { blocked: true, blockReason: 'Kill switch' } });
        await mon.checkNow();
        await mon.checkNow();
        expect(worker.calls).toHaveLength(0);
        expect(mon.summary()).toMatchObject({ blocked: true, ok: false });
        expect(mon.history().map((e) => e.type)).toEqual(['blocked']);
    });

    it('drops an answer for a connection that changed while the check ran', async () => {
        const worker = fakeWorker();
        const ctx = { worker, proxy: null, browser: 'chrome', blocked: false, label: 'Direct' };
        const slow = worker.request;
        let first = true;
        worker.request = async (o) => {
            if (first) { first = false; ctx.proxy = 'http://px.test:1'; ctx.label = 'P'; }
            return slow(o);
        };
        worker.byProxy = { direct: '192.0.2.1', 'http://px.test:1': '192.0.2.2' };
        const mon = new IpMonitor({ getContext: () => ctx });
        await mon.checkNow();
        const ev = mon.history();
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ ip: '192.0.2.2', label: 'P' });
    });

    it('persists history, marks a stop, and starts a new run against the last known IP', async () => {
        const file = path.join(tmp(), 'ip-history.jsonl');
        const a = monitor({ file });
        a.mon.start();
        await a.mon.checkNow();
        a.mon.stop();
        const b = monitor({ file });
        b.worker.ip = '203.0.113.99';
        await b.mon.checkNow();
        const ev = b.mon.history();
        expect(ev.map((e) => e.type)).toEqual(['start', 'stop', 'start']);
        expect(ev[0]).toMatchObject({ ip: '203.0.113.99', prevIp: '203.0.113.10' });
        expect(ev[0].id).toBeGreaterThan(ev[1].id);
        expect(b.mon.history({ after: ev[1].id }).map((e) => e.id)).toEqual([ev[0].id]);
        const epoch = b.mon.summary().epoch;
        expect(epoch).not.toBe(a.mon.summary().epoch);
        b.mon.clearHistory();
        expect(b.mon.summary().epoch).not.toBe(epoch);
        expect(readFileSync(file, 'utf8')).toBe('');
    });

    it('survives a torn line in the history file', () => {
        const file = path.join(tmp(), 'ip-history.jsonl');
        writeFileSync(file, '{"id":1,"at":1,"type":"start","ip":"192.0.2.9"}\n{"id":2,"at":2,"ty');
        const { mon } = monitor({ file });
        expect(mon.history()).toHaveLength(1);
        expect(mon.lastEventId).toBe(1);
    });

    it('clamps the interval and stops scheduling when disabled', () => {
        const { mon } = monitor();
        mon.configure({ intervalMs: 10 });
        expect(mon.intervalMs).toBe(5000);
        mon.start();
        expect(mon.state.nextCheckAt).not.toBeNull();
        mon.configure({ enabled: false });
        expect(mon.state.nextCheckAt).toBeNull();
        mon.stop();
    });
});

describe('SessionLog.logIp', () => {
    it('logs an ip entry whose summary carries the one-line note', () => {
        const log = new SessionLog({ dir: tmp() });
        log.logIp({ id: 1, at: Date.now(), type: 'change', ip: '192.0.2.2', prevIp: '192.0.2.1', city: 'Berlin', country: 'DE', label: 'P' });
        const row = log.list().find((e) => e.kind === 'ip');
        expect(row).toMatchObject({ type: 'change', note: '192.0.2.1 → 192.0.2.2 · Berlin, DE · P' });
        expect(log.get(row.seq).data.ip).toBe('192.0.2.2');
        return log.close();
    });
});
