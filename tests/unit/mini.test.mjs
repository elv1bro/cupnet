'use strict';

/**
 * CupNet mini: Chrome command line + profile prefs, CA helpers, CLI args, session log, and a hermetic
 * end-to-end run (MiniApp → MITM → Go worker → local HTTPS origin) covering the CA chain Chrome's
 * SPKI flag relies on, inject rules with CSP nonces, /__cupnet/event and the UI API access checks.
 * The end-to-end part skips when the Go worker binary is not built (`npm run build:go`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import zlib from 'zlib';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.CUPNET_AZURETLS_CHILD_PROCESS = '1';

const { buildChromeArgs, ensureProfilePrefs, WEBRTC_POLICY } = require('../../mini/chrome.js');
const { spkiHashFromCertPem, caInstructions } = require('../../mini/ca.js');
const { parseArgs } = require('../../mini/cupnet-mini.js');
const { SessionLog, SessionIndex, newSessionId, bodySize } = require('../../mini/session-log.js');
const { RuleStore } = require('../../mini/rule-store.js');
const { BODY_PREVIEW_CHARS } = require('../../mini/ui-server.js');
const hasNodeSqlite = (() => { try { require('node:sqlite'); return true; } catch { return false; } })();

const tmpDirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'cupnet-mini-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

describe('buildChromeArgs', () => {
    it('isolates the profile, proxies through the MITM and pins the CA SPKI', () => {
        const args = buildChromeArgs({ mitmPort: 9001, profileDir: '/p', caSpki: 'abc=', url: 'https://x.test/' });
        expect(args).toEqual([
            '--user-data-dir=/p', '--proxy-server=http://127.0.0.1:9001', '--no-first-run',
            '--no-default-browser-check', '--ignore-certificate-errors-spki-list=abc=', 'https://x.test/',
        ]);
    });
    it('passes no trust flag for trust=system, requires the SPKI for spki, ignores non-http urls', () => {
        const sys = buildChromeArgs({ mitmPort: 1, profileDir: '/p', trust: 'system', url: 'javascript:alert(1)' });
        expect(sys.some((a) => a.includes('spki') || a.startsWith('javascript'))).toBe(false);
        expect(() => buildChromeArgs({ mitmPort: 1, profileDir: '/p' })).toThrow(/caSpki/);
    });
});

describe('ensureProfilePrefs', () => {
    it('sets the WebRTC policy once and keeps existing prefs', () => {
        const dir = tmp();
        mkdirSync(path.join(dir, 'Default'));
        writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ keep: 1, webrtc: { other: true } }));
        expect(ensureProfilePrefs(dir)).toBe(true);
        expect(ensureProfilePrefs(dir)).toBe(false);
        const prefs = JSON.parse(readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
        expect(prefs).toEqual({ keep: 1, webrtc: { other: true, ip_handling_policy: WEBRTC_POLICY } });
    });
});

describe('CA helpers', () => {
    it('spkiHashFromCertPem = base64(sha256(SPKI DER)) of the certificate key', () => {
        const { generateCA, getCACertPem } = require('../../mitm-ca.js');
        generateCA();
        const pem = getCACertPem();
        const der = new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
        expect(spkiHashFromCertPem(pem)).toBe(crypto.createHash('sha256').update(der).digest('base64'));
    });
    it('leaf certs chain to the CA (issuer = CA subject, AKI = SKI), also for a CA loaded from disk', () => {
        const mitmCa = require('../../mitm-ca.js');
        const dir = tmp();
        mitmCa.loadOrGenerateCA(dir); // generate + save
        const before = mitmCa.getFakeCert('chain.test').cert;
        mitmCa.generateCA(); // a different CA in memory: the cached leaf must not be reused
        mitmCa.loadOrGenerateCA(dir); // load the saved one back
        const ca = new crypto.X509Certificate(mitmCa.getCACertPem());
        const leaf = new crypto.X509Certificate(mitmCa.getFakeCert('chain.test').cert);
        expect(leaf.issuer).toBe(ca.subject);
        expect(leaf.checkIssued(ca)).toBe(true);
        expect(leaf.verify(ca.publicKey)).toBe(true);
        expect(new crypto.X509Certificate(before).checkIssued(ca)).toBe(true);
    });
    it('gives per-OS user-scope trust commands with the path quoted', () => {
        expect(caInstructions('/a b/ca.pem', 'darwin').install).toContain('login.keychain-db "/a b/ca.pem"');
        expect(caInstructions('C:\\ca.pem', 'win32').install).toMatch(/^certutil -user -addstore Root/);
        expect(caInstructions('/ca.pem', 'linux').install).toContain('sql:$HOME/.pki/nssdb');
    });
});

describe('parseArgs', () => {
    it('handles commands, --k v, --k=v and flags', () => {
        expect(parseArgs(['start', '--port', '9000', '--chrome', '--url=https://a/?x=1', '--trust', 'system']))
            .toEqual({ _: ['start'], port: '9000', chrome: true, url: 'https://a/?x=1', trust: 'system' });
    });
});

describe('SessionLog', () => {
    it('writes complete entries to one JSONL file per session and keeps only summaries + offsets in memory', async () => {
        const dir = tmp();
        const log = new SessionLog({ dir });
        expect(log.sessionId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
        const big = 'x'.repeat(3 * 1024 * 1024);
        const seen = [];
        log.on('entry', (e) => seen.push(e));
        log.logRequest({
            method: 'POST', url: 'https://a/', status: 200, duration: 5, requestBody: '__b64__:AAEC',
            responseHeaders: { 'Content-Type': 'text/plain; charset=utf-8' }, responseBody: big,
        });
        log.logPageEvent('https://a/', { k: 1 });
        const list = log.list(1);
        expect(list.map((e) => e.kind)).toEqual(['request', 'page-event']);
        expect(list[0]).toMatchObject({ mime: 'text/plain', reqSize: 3, resSize: big.length });
        expect(list[0].responseBody).toBeUndefined(); // summaries only
        expect(list[0].off).toBeUndefined();
        expect(seen.map((e) => e.seq)).toEqual([2, 3]);
        expect(log.get(2).responseBody).toBe(big); // nothing truncated
        expect(log.get(3).data).toEqual({ k: 1 });
        let closed = false;
        log.on('close', () => { closed = true; });
        await log.close();
        expect(closed).toBe(true);
        const lines = readFileSync(log.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(lines.map((e) => e.kind)).toEqual(['session-start', 'request', 'page-event', 'session-end']);
        expect(SessionLog.listSessions(dir).map((s) => s.id)).toEqual([log.sessionId]);
        expect(newSessionId(new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^20260102-030405-/);
    });

    it('SessionIndex scans a saved file by line heads, reads entries on demand and picks up appended lines', () => {
        const dir = tmp();
        const log = new SessionLog({ dir, sessionId: '20260101-000000-test' });
        const longUrl = `https://a/${'p'.repeat(80 * 1024)}`; // summary itself beyond the 64 KB head
        log.logRequest({ method: 'GET', url: longUrl, status: 200, responseBody: 'y'.repeat(200 * 1024) });
        log.logRequest({ method: 'GET', url: 'https://b/', status: 404 });
        const idx = SessionIndex.open(log.file);
        expect(idx.count).toBe(3);
        expect(idx.list(0).map((e) => e.url)).toEqual([undefined, longUrl, 'https://b/']);
        expect(idx.list(2, 10).map((e) => e.seq)).toEqual([3]);
        expect(idx.get(2).responseBody).toHaveLength(200 * 1024);
        expect(idx.get(99)).toBeNull();

        // A half-written last line is left for the next refresh().
        log.close();
        expect(idx.refresh()).toBe(1); // session-end
        appendFileSync(log.file, '{"seq":9,"kind":"request","url":"https://c/"');
        expect(idx.refresh()).toBe(0);
        appendFileSync(log.file, '}\n');
        expect(idx.refresh()).toBe(1);
        expect(idx.lastSeq).toBe(9);
    });

    it('bodySize counts base64 bodies as bytes', () => {
        expect(bodySize(null)).toBe(0);
        expect(bodySize('ok')).toBe(2);
        expect(bodySize('ж')).toBe(2);
        expect(bodySize(`__b64__:${Buffer.alloc(10).toString('base64')}`)).toBe(10);
        expect(bodySize(`__b64__:${Buffer.alloc(11).toString('base64')}`)).toBe(11);
    });
});

describe('RuleStore', () => {
    it('keeps db.js row shape and order, persists atomically and batches hit counters', async () => {
        const file = path.join(tmp(), 'rules.json');
        const s = new RuleStore(file);
        const a = s.saveInterceptRule({ name: 'a', type: 'block', url_pattern: '*a*', priority: 1, tags: 'x, y' });
        const b = s.saveInterceptRule({ name: 'b', type: 'mock', url_pattern: '*b*', priority: 5, enabled: false, delay_ms: 1e9 });
        expect(s.getAllInterceptRules().map((r) => r.name)).toEqual(['b', 'a']); // priority DESC
        expect(s.getInterceptRules().map((r) => r.id)).toEqual([a]);
        const ra = s.getAllInterceptRules().find((r) => r.id === a);
        expect(ra).toMatchObject({ method: '*', tags: ['x', 'y'], stop_on_match: true, hit_count: 0, params: {} });
        expect(s.getAllInterceptRules().find((r) => r.id === b).delay_ms).toBe(60000);
        ra.name = 'mutated';
        expect(s.getAllInterceptRules().find((r) => r.id === a).name).toBe('a'); // copies

        s.incrementInterceptRuleHit(a);
        s.setInterceptRuleError(b, 'e'.repeat(5000));
        expect(JSON.parse(readFileSync(file, 'utf8')).rules.find((r) => r.id === a).hit_count).toBe(0); // not yet
        s.close(); // flushes pending counters
        const s2 = new RuleStore(file);
        expect(s2.getAllInterceptRules().find((r) => r.id === a).hit_count).toBe(1);
        expect(s2.getAllInterceptRules().find((r) => r.id === b).last_error).toHaveLength(2000);
        expect(s2.saveInterceptRule({ id: a, name: 'a2', type: 'block', url_pattern: '*' })).toBe(a);
        expect(s2.getAllInterceptRules().find((r) => r.id === a)).toMatchObject({ name: 'a2', hit_count: 1 });
        s2.deleteInterceptRule(b);
        expect(s2.saveInterceptRule({ name: 'c', type: 'block', url_pattern: '*' })).toBe(b + 1); // ids not reused
        expect(new RuleStore(file).getAllInterceptRules().map((r) => r.name)).toEqual(['a2', 'c']);
    });

    it('is what request-interceptor reads once injected (no db.js / better-sqlite3)', async () => {
        const interceptor = require('../../request-interceptor.js');
        const s = new RuleStore(path.join(tmp(), 'rules.json'));
        s.saveInterceptRule({ name: 'blk', type: 'block', url_pattern: '*blocked.test*' });
        interceptor.setRuleStore(s);
        try {
            const plan = await interceptor.planMitmIntercept({ url: 'https://blocked.test/x', method: 'GET', headers: {} });
            expect(plan).toMatchObject({ done: true, response: { statusCode: 403 } });
            expect((await interceptor.planMitmIntercept({ url: 'https://ok.test/', method: 'GET', headers: {} })).done).toBe(false);
        } finally {
            interceptor.setRuleStore(null);
        }
    });

    it.skipIf(!hasNodeSqlite)('imports rules once from the old SQLite store', () => {
        const dir = tmp();
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(path.join(dir, 'old.db'));
        db.exec(`CREATE TABLE intercept_rules (id INTEGER PRIMARY KEY, name TEXT, enabled INTEGER, url_pattern TEXT, type TEXT,
            params TEXT, priority INTEGER, method TEXT, group_name TEXT, hit_count INTEGER, last_hit_at TEXT, delay_ms INTEGER,
            tags TEXT, last_error TEXT, stop_on_match INTEGER, breakpoint_enabled INTEGER, created_at TEXT)`);
        db.prepare(`INSERT INTO intercept_rules VALUES (7, 'old', 1, '*', 'inject', '{"source":"1"}', 0, NULL, NULL, 3, NULL, 0,
            '["t"]', NULL, 0, 0, '2026-01-01')`).run();
        db.close();
        const s = new RuleStore(path.join(dir, 'rules.json'));
        expect(s.importFromSqlite(path.join(dir, 'old.db'))).toBe(1);
        expect(s.getAllInterceptRules()[0]).toMatchObject({ id: 7, name: 'old', params: { source: '1' }, tags: ['t'], hit_count: 3, stop_on_match: false });
        expect(s.importFromSqlite(path.join(dir, 'old.db'))).toBe(0); // store not empty any more
        expect(s.saveInterceptRule({ name: 'n', type: 'block', url_pattern: '*' })).toBe(8);
    });
});

describe('ProxyStore', () => {
    const { ProxyStore, ProxyManager, splitTemplatePassword, maskUrl } = require('../../mini/proxy-store.js');
    const open = (dir, key = 'proxies.key') => new ProxyStore(path.join(dir, 'proxies.json'), path.join(dir, key));

    it('moves a password typed into the URL into the encrypted field; the UI and the file never see it', () => {
        const dir = tmp();
        const s = open(dir);
        const p = s.save({ kind: 'custom', template: 'http://user:s3cr%3At@10.1.2.3:8080' });
        expect(p.template).toBe('http://user:{PASSWORD}@10.1.2.3:8080');
        expect(s.resolve(p).url).toBe('http://user:s3cr%3At@10.1.2.3:8080');
        const pub = s.publicProfile(p);
        expect(pub).toMatchObject({ name: '10.1.2.3', display: 'http://user:•••@10.1.2.3:8080', hasPassword: true, host: '10.1.2.3', port: '8080' });
        expect(JSON.stringify(s.list())).not.toContain('s3cr');
        expect(readFileSync(path.join(dir, 'proxies.json'), 'utf8')).not.toContain('s3cr');

        // Reopened with the same key file: still decrypts. Saving the template back keeps the password.
        const again = open(dir);
        expect(again.resolve(again.get(p.id)).url).toContain(':s3cr%3At@');
        again.save({ kind: 'custom', template: 'http://user:{PASSWORD}@10.1.2.3:9090', name: 'n' }, p.id);
        expect(again.resolve(again.get(p.id)).url).toBe('http://user:s3cr%3At@10.1.2.3:9090');
        // Another key file cannot read it.
        expect(open(dir, 'other.key').password(again.get(p.id))).toBe('');
    });

    it('pins {SID}/{RAND} for a sticky exit, re-rolls on New IP, validates the URL', () => {
        const s = open(tmp());
        const p = s.save({ kind: 'custom', template: 'socks5://u-{SID}:pw@gw.example:{RAND:20000-20999}' });
        const a = s.resolve(p).url;
        expect(a).toMatch(/^socks5:\/\/u-[^:]+:pw@gw\.example:20\d{3}$/);
        expect(s.resolve(s.get(p.id)).url).toBe(a);
        expect(s.publicProfile(p).sticky).toBe(true);
        const rolled = new Set(Array.from({ length: 5 }, () => s.reroll(p).url));
        expect(rolled.size).toBeGreaterThan(1);
        expect(() => s.save({ kind: 'custom', template: 'ftp://h:1' })).toThrow(/Unsupported scheme/);
        expect(() => s.save({ kind: 'custom', template: 'http://h:{PORT}' })).toThrow(/Unresolved variable \{PORT\}/);
        expect(s.save({ kind: 'custom', template: 'http://h:{PORT}', vars: { port: '3128' } }).vars).toEqual({ PORT: '3128' });
    });

    it('builds provider URLs from account fields and requires credentials', () => {
        const s = open(tmp());
        expect(() => s.save({ kind: 'provider', provider: 'decodo', username: 'acc' })).toThrow(/password is required/);
        expect(() => s.save({ kind: 'provider', provider: 'nope', username: 'a', password: 'b' })).toThrow(/Unknown provider/);
        const p = s.save({ kind: 'provider', provider: 'decodo', username: 'acc', password: 'pw', sessionMode: 'sticky' });
        expect(s.resolve(p).error).toBeNull();
        expect(s.publicProfile(p)).toMatchObject({ providerName: 'Decodo', sessionMode: 'sticky', hasPassword: true });
        expect(s.publicProfile(p).display).not.toContain(':pw@');
    });

    it('bulk import: dry run, duplicates, error lines without their contents', () => {
        const s = open(tmp());
        const text = 'http://u:topsecret@10.0.0.1:8080\n10.0.0.2:3128\nnot a proxy line\nhttp://u:topsecret@10.0.0.1:8080';
        const dry = s.importLines(text, { dryRun: true });
        expect(dry.added.map((a) => a.display)).toEqual(['http://u:•••@10.0.0.1:8080', 'http://10.0.0.2:3128']);
        expect(dry.errors).toHaveLength(1);
        expect(JSON.stringify(dry)).not.toContain('topsecret');
        expect(s.list()).toHaveLength(0);
        const real = s.importLines(text, { group: 'g' });
        expect(real.added.map((a) => a.group)).toEqual(['g', 'g']);
        expect(s.importLines(text).duplicates).toBeGreaterThanOrEqual(2);
        expect(s.list()).toHaveLength(2);
    });

    it('splitTemplatePassword / maskUrl', () => {
        expect(splitTemplatePassword('h:1')).toEqual({ template: 'http://h:1', password: null });
        expect(splitTemplatePassword('http://a:{PASSWORD}@h:1').password).toBeNull();
        expect(splitTemplatePassword('http://a:b@h:1')).toEqual({ template: 'http://a:{PASSWORD}@h:1', password: 'b' });
        expect(maskUrl('http://a:b@h:1')).toBe('http://a:•••@h:1');
        expect(maskUrl('http://a@h:1')).toBe('http://a@h:1');
    });

    const fakeMitm = (worker) => ({
        upstream: null, blocked: false, reason: '', browser: 'chrome', worker,
        setUpstream(u) { this.upstream = u; if (u) this.blocked = false; },
        setEgressBlocked(b, r) { this.blocked = !!b; this.reason = r; },
        isEgressBlocked() { return this.blocked; },
        getEgressBlockReason() { return this.blocked ? this.reason : ''; },
    });

    it('ProxyManager: connect / kill switch / disconnect, and never loops into its own port', async () => {
        const calls = [];
        const worker = { request: async (o) => { calls.push(o.proxy); return { statusCode: 200, body: JSON.stringify({ ip: '1.2.3.4', country: 'de' }) }; } };
        const mitm = fakeMitm(worker);
        const s = open(tmp());
        const pm = new ProxyManager(s, mitm, { selfPort: 18877 });
        const ok = s.save({ kind: 'custom', template: 'http://10.0.0.9:3128' });
        const self = s.save({ kind: 'custom', template: 'http://127.0.0.1:18877' });

        expect(() => pm.connect(self.id)).toThrow(/own proxy port/);
        expect((await pm.test(self.id)).error).toMatch(/own proxy port/);
        expect(calls).toEqual([]);
        expect(await pm.test(ok.id)).toMatchObject({ ok: true, ip: '1.2.3.4', country: 'DE' });
        expect(calls).toEqual(['http://10.0.0.9:3128']);

        expect(pm.connect(ok.id)).toMatchObject({ mode: 'proxy', blocked: false });
        expect(mitm.upstream).toBe('http://10.0.0.9:3128');
        pm.setKillSwitch(true);
        expect(mitm.blocked).toBe(false); // a proxy is connected
        expect(pm.disconnect()).toMatchObject({ mode: 'direct', killSwitch: true, blocked: true });
        expect(mitm.upstream).toBeNull();
        pm.setKillSwitch(false);
        expect(mitm.blocked).toBe(false);

        // A saved active profile that points back at the MITM is dropped on start.
        s.setActive(self.id);
        const pm2 = new ProxyManager(s, fakeMitm(worker), { selfPort: 18877 });
        pm2.restore();
        expect(pm2.mitm.upstream).toBeNull();
        expect(s.activeId).toBeNull();
        // --upstream from the CLI wins over the saved profile.
        s.setActive(ok.id);
        const pm3 = new ProxyManager(s, fakeMitm(worker), { cliUpstream: 'http://cli:1' });
        pm3.restore();
        expect(pm3.mitm.upstream).toBe('http://cli:1');
        expect(pm3.status().mode).toBe('cli');
    });
});

describe('HAR', () => {
    const { harEntry, writeHar } = require('../../mini/har.js');

    it('maps a logged entry to HAR 1.2 (query, cookies, base64 bodies, timings)', async () => {
        const e = harEntry({
            seq: 3, ts: Date.parse('2026-01-02T03:04:05Z'), method: 'POST', url: 'https://h/p?a=1&b=%20x', status: 201, duration: 12,
            requestHeaders: { Cookie: 'k=v; z=1', 'Content-Type': 'application/json' }, requestBody: '{"x":1}',
            responseHeaders: { 'content-type': 'image/png' }, responseBody: '__b64__:iVBORw==',
        });
        expect(e.startedDateTime).toBe('2026-01-02T03:04:05.000Z');
        expect(e.request.queryString).toEqual([{ name: 'a', value: '1' }, { name: 'b', value: ' x' }]);
        expect(e.request.cookies.map((c) => c.name)).toEqual(['k', 'z']);
        expect(e.request.postData).toMatchObject({ mimeType: 'application/json', text: '{"x":1}' });
        expect(e.response).toMatchObject({ status: 201, content: { mimeType: 'image/png', encoding: 'base64', text: 'iVBORw==' } });
        expect(e.time).toBe(12);

        const chunks = [];
        const req = (seq) => ({ seq, kind: 'request', ts: 0, method: 'GET', url: `https://h/${seq}`, status: 200 });
        await writeHar({ write: (c) => { chunks.push(c); return true; }, once: () => {} },
            [{ seq: 1, kind: 'session-start' }, req(2), { seq: 3, kind: 'page-event' }, req(4)], { comment: 'x' });
        const har = JSON.parse(chunks.join(''));
        expect(har.log).toMatchObject({ version: '1.2', comment: 'x', creator: { name: 'CupNet mini' } });
        expect(har.log.entries.map((x) => x._cupnetSeq)).toEqual([2, 4]);
    });
});

describe('pack-mini', () => {
    it('mini needs no npm packages besides the guarded electron/better-sqlite3 requires', () => {
        const { walkRequires } = require('../../scripts/pack-mini.cjs');
        const { files, packages } = walkRequires(path.join(repoRoot, 'mini', 'cupnet-mini.js'));
        expect([...packages.keys()].sort()).toEqual(['better-sqlite3', 'electron']);
        expect([...packages.get('better-sqlite3')]).toEqual(['db.js']);
        expect(files).toEqual(expect.arrayContaining(['mitm-proxy.js', 'request-interceptor.js', 'mini/ui-server.js']));
    });
});

// ─── end to end ───────────────────────────────────────────────────────────────────────────────────

function goWorkerBinary() {
    const { arch, platform } = process;
    const name = platform === 'darwin' ? `azuretls-worker-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}`
        : platform === 'linux' ? `azuretls-worker-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}`
            : platform === 'win32' ? 'azuretls-worker-win32-amd64.exe' : null;
    return name && path.join(repoRoot, 'azuretls-go', 'bin', name);
}
const haveBinary = existsSync(goWorkerBinary() || '');

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

/** One HTTPS request through the MITM (CONNECT + TLS). Resolves with status/headers/body and the peer cert chain. */
function viaMitm(mitmPort, targetPort, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(mitmPort, '127.0.0.1');
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 30_000);
        sock.on('error', reject);
        sock.once('connect', () => sock.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`));
        sock.once('data', (d) => {
            if (!/ 200 /.test(d.toString('latin1').split('\r\n')[0])) { clearTimeout(timer); reject(new Error(`CONNECT: ${d}`)); return; }
            const tlsSock = tls.connect({ socket: sock, servername: 'localhost', rejectUnauthorized: false }, () => {
                const peer = tlsSock.getPeerCertificate(true);
                const req = https.request({
                    createConnection: () => tlsSock, host: '127.0.0.1', port: targetPort, method, path: reqPath,
                    headers: { Host: `127.0.0.1:${targetPort}`, 'User-Agent': 'Mozilla/5.0 Chrome/140.0.0.0', Connection: 'close', ...headers },
                }, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        clearTimeout(timer);
                        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), peer });
                    });
                });
                req.on('error', (e) => { clearTimeout(timer); reject(e); });
                req.end(body);
            });
            tlsSock.on('error', (e) => { clearTimeout(timer); reject(e); });
        });
    });
}

function ui(app, method, p, { token = app.token, host = `127.0.0.1:${app.uiPort}`, json, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
        const req = http.request({
            host: '127.0.0.1', port: app.uiPort, method, path: p,
            headers: { Host: host, ...(token ? { 'X-CupNet-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                const text = raw.toString('utf8');
                let data = text;
                try { data = JSON.parse(text); } catch { /* keep text */ }
                resolve({ status: res.statusCode, data, raw, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

describe.skipIf(!haveBinary)('MiniApp end to end (local HTTPS origin)', () => {
    let app;
    let origin;
    let originPort;
    let plainOrigin;
    let plainPort;
    const BIG = 'z'.repeat(3 * 1024 * 1024); // beyond the 2 MB preview of /api/log/:seq
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const PAGE = '<!doctype html><html><head><title>t</title></head><body><p>Привет</p></body></html>';
    const SITE_CSP = "default-src 'self'; script-src 'self' 'nonce-site'";

    beforeAll(async () => {
        const { MiniApp } = require('../../mini/mini-app.js');
        app = new MiniApp({ dataDir: tmp(), mitmPort: await freePort(), uiPort: 0 });
        await app.start();

        // Origin cert from the same CA module (any cert works: upstream TLS is not verified).
        const { getFakeCert } = require('../../mitm-ca.js');
        const cert = getFakeCert('127.0.0.1');
        origin = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
            if (req.url === '/page') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-security-policy': SITE_CSP });
                res.end(zlib.gzipSync(Buffer.from(PAGE)));
            } else if (req.url === '/big') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end(BIG);
            } else if (req.url === '/img') {
                res.writeHead(200, { 'content-type': 'image/png' });
                res.end(PNG);
            } else if (req.url === '/app.js') {
                res.writeHead(200, { 'content-type': 'application/javascript' });
                res.end('console.log(1)');
            } else if (req.url.startsWith('/echo')) {
                const c = [];
                req.on('data', (d) => c.push(d));
                req.on('end', () => {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ method: req.method, url: req.url, bp: req.headers['x-bp'] || null, body: Buffer.concat(c).toString() }));
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise((r) => origin.listen(0, '127.0.0.1', r));
        originPort = origin.address().port;
        plainOrigin = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`plain ${req.url}`); });
        await new Promise((r) => plainOrigin.listen(0, '127.0.0.1', r));
        plainPort = plainOrigin.address().port;
    }, 60_000);

    afterAll(async () => {
        await app?.stop();
        await new Promise((r) => (origin ? origin.close(() => r()) : r()));
        await new Promise((r) => (plainOrigin ? plainOrigin.close(() => r()) : r()));
    });

    it('presents leaf + CupNet CA, so the CA SPKI is in the chain Chrome checks', async () => {
        const r = await viaMitm(app.mitmPort, originPort, { reqPath: '/app.js' });
        expect(r.status).toBe(200);
        expect(r.body).toBe('console.log(1)');
        const issuer = r.peer.issuerCertificate;
        expect(issuer && issuer !== r.peer).toBeTruthy();
        expect(issuer.fingerprint256).toBe(app.ca.sha256);
        const caPem = readFileSync(app.caCertPath, 'utf8');
        expect(spkiHashFromCertPem(caPem)).toBe(app.ca.spki);
    });

    it('UI API rejects foreign Host headers and missing tokens', async () => {
        expect((await ui(app, 'GET', '/api/status', { host: `evil.test:${app.uiPort}` })).status).toBe(421);
        expect((await ui(app, 'GET', '/api/status', { token: null })).status).toBe(401);
        expect((await ui(app, 'GET', '/api/status', { token: 'x'.repeat(32) })).status).toBe(401);
        const ok = await ui(app, 'GET', '/api/status');
        expect(ok.status).toBe(200);
        expect(ok.data.ca.spki).toBe(app.ca.spki);
    });

    it('inject rule saved via the UI lands in documents with a CSP nonce; sub-resources untouched', async () => {
        const bad = await ui(app, 'POST', '/api/rules', { json: { name: 'x', type: 'inject', url_pattern: '*', params: { source: '' } } });
        expect(bad.status).toBe(400);
        const saved = await ui(app, 'POST', '/api/rules', {
            json: { name: 'hook', type: 'inject', url_pattern: `*127.0.0.1:${originPort}/*`, enabled: true, params: { source: 'window.__cn = "ок";' } },
        });
        expect(saved.status).toBe(200);
        expect((await ui(app, 'GET', '/api/rules')).data.some((r) => r.name === 'hook')).toBe(true);

        const doc = await viaMitm(app.mitmPort, originPort, { reqPath: '/page', headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } });
        expect(doc.status).toBe(200);
        expect(doc.headers['content-encoding']).toBeUndefined();
        const nonce = /<script nonce="([^"]+)" data-cupnet data-cupnet-rule="hook">window.__cn = "\\u043e\\u043a";<\/script>/.exec(doc.body)?.[1];
        expect(nonce).toBeTruthy();
        expect(doc.body).toContain('<head><script nonce=');
        expect(doc.body).toContain('<p>Привет</p>');
        expect(doc.headers['content-security-policy']).toBe(`${SITE_CSP} 'nonce-${nonce}'`);

        const js = await viaMitm(app.mitmPort, originPort, { reqPath: '/app.js', headers: { 'Sec-Fetch-Dest': 'script' } });
        expect(js.body).toBe('console.log(1)');

        const del = await ui(app, 'DELETE', `/api/rules/${saved.data.id}`);
        expect(del.status).toBe(200);
        const plain = await viaMitm(app.mitmPort, originPort, { reqPath: '/page', headers: { 'Sec-Fetch-Dest': 'document' } });
        expect(plain.body).not.toContain('data-cupnet');
    });

    it('/__cupnet/event is answered locally, write-only, and logged as a page event', async () => {
        const ev = await viaMitm(app.mitmPort, originPort, {
            method: 'POST', reqPath: '/__cupnet/event', body: JSON.stringify({ hello: 1 }),
            headers: { 'Content-Type': 'application/json', Referer: `https://127.0.0.1:${originPort}/page` },
        });
        expect(ev.status).toBe(204);
        expect((await viaMitm(app.mitmPort, originPort, { reqPath: '/__cupnet/event' })).status).toBe(405);
        expect((await viaMitm(app.mitmPort, originPort, { reqPath: '/__cupnet/log' })).status).toBe(404);

        const log = (await ui(app, 'GET', '/api/log')).data;
        const pe = log.filter((e) => e.kind === 'page-event');
        expect(pe).toHaveLength(1);
        expect((await ui(app, 'GET', `/api/log/${pe[0].seq}`)).data.data).toEqual({ hello: 1 });
        expect(log.some((e) => /\/__cupnet\//.test(e.url || '') && e.kind === 'request')).toBe(false);
        expect(log.some((e) => e.kind === 'request' && e.url?.endsWith('/page'))).toBe(true);

        const sessions = (await ui(app, 'GET', '/api/sessions')).data;
        expect(sessions.current).toBe(app.log.sessionId);
        const file = await ui(app, 'GET', `/api/sessions/${sessions.current}`);
        expect(file.status).toBe(200);
        expect(String(file.data)).toContain('"kind":"page-event"');
    });

    it('logs plain-HTTP proxy requests too (absolute-form, no CONNECT)', async () => {
        const body = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: app.mitmPort, path: `http://127.0.0.1:${plainPort}/hello`, headers: { Host: `127.0.0.1:${plainPort}` } }, (res) => {
                const c = [];
                res.on('data', (d) => c.push(d));
                res.on('end', () => resolve(Buffer.concat(c).toString()));
            }).on('error', reject);
        });
        expect(body).toBe('plain /hello');
        await new Promise((r) => setTimeout(r, 100));
        const e = (await ui(app, 'GET', '/api/log?limit=50000')).data.find((x) => x.url === `http://127.0.0.1:${plainPort}/hello`);
        expect(e).toMatchObject({ kind: 'request', status: 200, mime: 'text/plain', resSize: 12 });
        expect((await ui(app, 'GET', `/api/log/${e.seq}`)).data.responseBody).toBe('plain /hello');
    });

    it('logs bodies in full: 2 MB preview in /api/log/:seq, raw bytes from the sandboxed body endpoint', async () => {
        expect((await viaMitm(app.mitmPort, originPort, { reqPath: '/big' })).body).toHaveLength(BIG.length);
        await viaMitm(app.mitmPort, originPort, { reqPath: '/img' });
        await new Promise((r) => setTimeout(r, 100));
        const log = (await ui(app, 'GET', '/api/log?limit=50000')).data;
        const big = log.find((x) => x.url?.endsWith('/big'));
        const img = log.find((x) => x.url?.endsWith('/img'));
        expect(big.resSize).toBe(BIG.length);
        const one = (await ui(app, 'GET', `/api/log/${big.seq}`)).data;
        expect(one.responseBodyTruncated).toBe(true);
        expect(one.responseBody).toHaveLength(BODY_PREVIEW_CHARS);
        const full = await ui(app, 'GET', `/api/log/${big.seq}/body/response`);
        expect(full.raw.length).toBe(BIG.length);
        expect(full.headers['content-type']).toBe('application/octet-stream');
        expect(full.headers['content-security-policy']).toBe('sandbox');
        expect(full.headers['content-disposition']).toMatch(/^attachment;/);
        expect(full.headers['x-cupnet-content-type']).toBe('text/plain');
        const png = await ui(app, 'GET', `/api/log/${img.seq}/body/response`);
        expect(png.raw.equals(PNG)).toBe(true);
        expect(png.headers['x-cupnet-content-type']).toBe('image/png');
        expect((await ui(app, 'GET', `/api/log/${img.seq}/body/request`)).status).toBe(404);
        expect((await ui(app, 'GET', `/api/log/${img.seq}/body/response`, { token: null })).status).toBe(401);
    });

    it('a launch code is exchanged for the token exactly once', async () => {
        const code = app.newLaunchCode();
        const ex = (h) => ui(app, 'POST', '/api/auth/exchange', { token: null, headers: h });
        expect((await ex({})).status).toBe(401);
        expect((await ex({ 'X-CupNet-Code': 'nope' })).status).toBe(401);
        const ok = await ex({ 'X-CupNet-Code': code });
        expect(ok.status).toBe(200);
        expect(ok.data.token).toBe(app.token);
        expect((await ex({ 'X-CupNet-Code': code })).status).toBe(401);
        expect((await ui(app, 'GET', '/', { token: null })).headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    });

    it('/api/log/stream sends the backlog, then live entries as they are logged', async () => {
        const after = app.log.lastSeq - 1;
        const lines = [];
        let req;
        const gotLive = new Promise((resolve, reject) => {
            req = http.get({
                host: '127.0.0.1', port: app.uiPort, path: `/api/log/stream?after=${after}`,
                headers: { Host: `127.0.0.1:${app.uiPort}`, 'X-CupNet-Token': app.token },
            }, (res) => {
                expect(res.headers['content-type']).toMatch(/ndjson/);
                let buf = '';
                res.on('data', (d) => {
                    buf += d;
                    let i;
                    while ((i = buf.indexOf('\n')) >= 0) {
                        const l = buf.slice(0, i); buf = buf.slice(i + 1);
                        if (l) lines.push(JSON.parse(l));
                        if (lines.some((e) => e.url?.endsWith('/app.js?live'))) resolve();
                    }
                });
            });
            req.on('error', reject);
            setTimeout(() => reject(new Error('no live entry')), 10_000);
        });
        await new Promise((r) => setTimeout(r, 100));
        expect(lines.map((e) => e.seq)).toEqual([after + 1]); // backlog
        await viaMitm(app.mitmPort, originPort, { reqPath: '/app.js?live' });
        await gotLive;
        req.destroy();
        expect(lines.at(-1).responseBody).toBeUndefined(); // summaries only
    });

    it('opens saved sessions by id: list + entries + bodies, refreshed when the file grows', async () => {
        const id = '20250101-000000-past';
        const past = new SessionLog({ dir: app.sessionsDir, sessionId: id });
        past.logRequest({ method: 'GET', url: 'https://old/', status: 201, responseBody: 'old body' });
        const list = (await ui(app, 'GET', `/api/log?session=${id}`)).data;
        expect(list.map((e) => e.url)).toEqual([undefined, 'https://old/']);
        expect((await ui(app, 'GET', `/api/log/2?session=${id}`)).data.responseBody).toBe('old body');
        expect((await ui(app, 'GET', `/api/log/2/body/response?session=${id}`)).raw.toString()).toBe('old body');
        past.logRequest({ method: 'GET', url: 'https://old/2', status: 200 });
        expect((await ui(app, 'GET', `/api/log?session=${id}&after=2`)).data.map((e) => e.url)).toEqual(['https://old/2']);
        await past.close();
        expect((await ui(app, 'GET', '/api/log?session=nope')).status).toBe(404);
        expect((await ui(app, 'GET', `/api/log?session=${encodeURIComponent('../x')}`)).status).toBe(404);
        expect((await ui(app, 'GET', '/api/sessions')).data.sessions.map((s) => s.id)).toContain(id);
    });

    it('serves the UI assets with a strict CSP (no inline scripts)', async () => {
        const page = await ui(app, 'GET', '/', { token: null });
        const csp = page.headers['content-security-policy'];
        expect(csp).toMatch(/script-src 'self'(;|$)/);
        expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
        expect(String(page.data)).not.toMatch(/<script>(?!<\/script>)|\son[a-z]+="/i);
        for (const [p, type] of [['/ui.js', /javascript/], ['/ui.css', /css/], ['/lib/codegen.js', /javascript/], ['/lib/curl.js', /javascript/]]) {
            const r = await ui(app, 'GET', p, { token: null });
            expect(r.status, p).toBe(200);
            expect(r.headers['content-type'], p).toMatch(type);
        }
        expect((await ui(app, 'GET', '/lib/../ui-server.js', { token: null })).status).toBe(404);
    });

    it('proxy routes: no password leaves the server, preview / import / self-loop guard / kill switch', async () => {
        const saved = await ui(app, 'POST', '/api/proxies', { json: { kind: 'custom', template: 'http://me:hunter22@10.9.9.9:3128', name: 'p1' } });
        expect(saved.status).toBe(200);
        expect(saved.data.profile.display).toBe('http://me:•••@10.9.9.9:3128');
        const list = await ui(app, 'GET', '/api/proxies');
        expect(list.raw.toString()).not.toContain('hunter22');
        expect((await ui(app, 'POST', '/api/proxies', { json: { kind: 'custom', template: 'gopher://x:1' } })).status).toBe(400);

        const prev = await ui(app, 'POST', '/api/proxies/preview', { json: { profile: { kind: 'custom', template: 'http://a:{PASSWORD}@h:1' }, id: saved.data.profile.id } });
        expect(prev.data.display).toBe('http://a:•••@h:1');

        const dry = await ui(app, 'POST', '/api/proxies/import', { json: { text: '10.0.0.1:1\nbad line', dryRun: true } });
        expect(dry.data).toMatchObject({ added: [{ display: 'http://10.0.0.1:1' }], errors: [{ line: 2 }] });
        expect(dry.data.profiles).toBeUndefined();

        const self = await ui(app, 'POST', '/api/proxies', { json: { kind: 'custom', template: `http://127.0.0.1:${app.mitmPort}` } });
        const loop = await ui(app, 'POST', `/api/proxies/${self.data.profile.id}/connect`);
        expect(loop.status).toBe(400);
        expect(loop.data.error).toMatch(/own proxy port/);
        expect((await ui(app, 'POST', '/api/proxies/0123456789abcdef/connect')).status).toBe(404);

        const ks = await ui(app, 'POST', '/api/proxies/kill-switch', { json: { enabled: true } });
        expect(ks.data.status).toMatchObject({ mode: 'direct', killSwitch: true, blocked: true });
        await expect(viaMitm(app.mitmPort, originPort, { reqPath: '/app.js' }).then((r) => r.status, (e) => e.message)).resolves.not.toBe(200);
        expect((await ui(app, 'POST', '/api/replay', { json: { url: `https://127.0.0.1:${originPort}/echo` } })).status).toBe(409);
        await ui(app, 'POST', '/api/proxies/kill-switch', { json: { enabled: false } });
        expect((await viaMitm(app.mitmPort, originPort, { reqPath: '/app.js' })).status).toBe(200);

        for (const p of (await ui(app, 'GET', '/api/proxies')).data.profiles) {
            expect((await ui(app, 'DELETE', `/api/proxies/${p.id}`)).status).toBe(200);
        }
    });

    it('settings round-trip; repeater validates and logs as type repeater', async () => {
        const s = await ui(app, 'POST', '/api/settings', { json: { cors: true, tlsPassthrough: ['a.example', 'nope nope'] } });
        expect(s.data).toMatchObject({ cors: true });
        expect(s.data.tlsPassthrough).toContain('a.example');
        expect((await ui(app, 'GET', '/api/settings')).data.cors).toBe(true);
        await ui(app, 'POST', '/api/settings', { json: { cors: false, tlsPassthrough: [] } });

        expect((await ui(app, 'POST', '/api/replay', { json: { url: 'ftp://x/' } })).status).toBe(400);
        const r = await ui(app, 'POST', '/api/replay', {
            json: { method: 'POST', url: `https://127.0.0.1:${originPort}/echo?r=1`, headers: [['X-BP', 'rep'], ['', 'skipped']], body: 'hi' },
        });
        expect(r.status).toBe(200);
        expect(r.data.status).toBe(200);
        const e = (await ui(app, 'GET', `/api/log/${r.data.seq}`)).data;
        expect(e.type).toBe('repeater');
        expect(JSON.parse(e.responseBody)).toMatchObject({ method: 'POST', bp: 'rep', body: 'hi' });
    });

    it('breakpoints: a Pause rule holds the request until it is forwarded with edits (or blocked)', async () => {
        const rule = await ui(app, 'POST', '/api/rules', {
            json: { name: 'bp', type: 'pause', url_pattern: `https://127.0.0.1:${originPort}/echo`, enabled: true, breakpoint_enabled: true, params: {} },
        });
        expect(rule.status).toBe(200);
        const waitPaused = async () => {
            for (let i = 0; i < 100; i++) {
                const l = (await ui(app, 'GET', '/api/breakpoints')).data;
                if (l.length) return l;
                await new Promise((res) => setTimeout(res, 50));
            }
            throw new Error('nothing paused');
        };
        try {
            const pending = viaMitm(app.mitmPort, originPort, { reqPath: '/echo?bp=1' });
            const [held] = await waitPaused();
            expect(held).toMatchObject({ ruleName: 'bp', method: 'GET' });
            expect(held.url).toContain('/echo?bp=1');
            const fwd = await ui(app, 'POST', `/api/breakpoints/${held.id}`, { json: { action: 'forward', headers: [...held.headers, ['X-BP', 'edited']] } });
            expect(fwd.status).toBe(200);
            expect(JSON.parse((await pending).body)).toMatchObject({ bp: 'edited' });
            expect((await ui(app, 'POST', `/api/breakpoints/${held.id}`, { json: { action: 'forward' } })).status).toBe(404);

            const blocked = viaMitm(app.mitmPort, originPort, { reqPath: '/echo?bp=2' });
            const [h2] = await waitPaused();
            await ui(app, 'POST', `/api/breakpoints/${h2.id}`, { json: { action: 'block' } });
            const b = await blocked.then((x) => x.status, () => 0);
            expect(b).not.toBe(200);
        } finally {
            await ui(app, 'DELETE', `/api/rules/${rule.data.id}`);
        }
    });

    it('HAR export: whole session or seq ranges, requests only', async () => {
        const sid = app.log.sessionId;
        const all = await ui(app, 'GET', `/api/sessions/${sid}/har`);
        expect(all.status).toBe(200);
        expect(all.headers['content-disposition']).toMatch(/\.har"$/);
        const seqs = all.data.log.entries.map((e) => e._cupnetSeq);
        expect(seqs.length).toBeGreaterThan(3);
        const pick = `${seqs[0]}-${seqs[1]},${seqs.at(-1)},x,0`;
        const part = await ui(app, 'GET', `/api/sessions/${sid}/har?seqs=${encodeURIComponent(pick)}`);
        const inRange = seqs.filter((q) => (q >= seqs[0] && q <= seqs[1]) || q === seqs.at(-1));
        expect(part.data.log.entries.map((e) => e._cupnetSeq)).toEqual(inRange);
        expect((await ui(app, 'GET', '/api/sessions/nope/har')).status).toBe(404);
    });

    it('each session has its own key file from the start; seal via the API; stop seals the session', async () => {
        const sc = require('../../mini/session-crypto.js');
        const sid = app.log.sessionId;
        const k = app.sessionKey;
        expect(readFileSync(k.file, 'utf8')).toContain(`"sessionId": "${sid}"`);

        const sealed = await ui(app, 'POST', `/api/sessions/${sid}/seal`);
        expect(sealed.status).toBe(200);
        expect(sealed.data.id).toBe(k.id);
        expect((await ui(app, 'GET', `/api/sessions/${sid}/key`)).data.id).toBe(k.id);
        expect((await ui(app, 'GET', `/api/sessions/${sid}/sealed`)).status).toBe(200);
        expect((await ui(app, 'GET', `/api/sessions/${sid}/sealed`, { token: null })).status).toBe(401);
        expect((await ui(app, 'POST', '/api/sessions/nope/seal')).status).toBe(404);

        await app.stop();
        const plain = sc.openBuffer(readFileSync(path.join(app.sealedDir, `${k.id}.cupsess`)), sc.readKeyFile(k.file)).toString();
        const kinds = plain.trim().split('\n').map((l) => JSON.parse(l).kind);
        expect(kinds[0]).toBe('session-start');
        expect(kinds.at(-1)).toBe('session-end'); // sealed after the log was flushed
        expect(kinds).toContain('page-event');
    });
});
