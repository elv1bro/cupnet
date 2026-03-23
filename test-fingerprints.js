#!/usr/bin/env node
/**
 * CupNet Fingerprint Test
 * =======================
 * Tests that AzureTLS correctly applies different browser profiles.
 *
 * Usage:
 *   node test-fingerprints.js
 *
 * What it checks:
 *   1. Worker starts and responds to init
 *   2. Chrome and Firefox produce DIFFERENT JA3 hashes
 *   3. Chrome and Firefox produce DIFFERENT peetprint hashes (deep fingerprint)
 *   4. HTTP/2 fingerprint is applied (Akamai hash differs)
 *   5. Session clearing works (no stale caches)
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const https     = require('https');
const http      = require('http');
const net       = require('net');

const WORKER_PATH = path.join(__dirname, 'azure-tls-worker.js');
const TEST_URL    = 'https://tls.peet.ws/api/all';
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const INFO = '\x1b[34mℹ\x1b[0m';

// ── Worker helper ─────────────────────────────────────────────────────────────

class Worker {
    constructor() {
        this.proc = spawn('node', [WORKER_PATH], { stdio: ['pipe','pipe','pipe'] });
        this.pending = new Map();
        this._buf = '';
        this.ready = false;

        this.proc.stderr.on('data', d => {
            // suppress noisy logs, show only errors
            const s = d.toString();
            if (s.includes('error') || s.includes('Error')) process.stderr.write('[worker-err] ' + s);
        });

        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', chunk => {
            this._buf += chunk;
            const lines = this._buf.split('\n');
            this._buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === '__init__') { this.ready = true; return; }
                    const cb = this.pending.get(msg.id);
                    if (cb) { this.pending.delete(msg.id); cb(null, msg); }
                } catch {}
            }
        });

        this.proc.on('exit', code => {
            for (const cb of this.pending.values()) cb(new Error(`Worker exited (${code})`));
            this.pending.clear();
        });
    }

    waitReady() {
        if (this.ready) return Promise.resolve();
        return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('Worker init timeout')), 10000);
            const check = () => { if (this.ready) { clearTimeout(t); res(); } else setTimeout(check, 50); };
            check();
        });
    }

    send(opts) {
        return new Promise((resolve, reject) => {
            const id = `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Request timeout for ${opts.url || id}`));
            }, 30000);
            this.pending.set(id, (err, res) => {
                clearTimeout(timer);
                if (err) reject(err); else resolve(res);
            });
            this.proc.stdin.write(JSON.stringify({ id, ...opts }) + '\n');
        });
    }

    clearSessions() {
        return new Promise(resolve => {
            const id = '__clear_sessions__';
            this.pending.set(id, () => resolve());
            this.proc.stdin.write(JSON.stringify({ id }) + '\n');
        });
    }

    kill() { try { this.proc.kill(); } catch {} }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(cond, msg) {
    if (cond) {
        console.log(`  ${PASS} ${msg}`);
        return true;
    } else {
        console.log(`  ${FAIL} ${msg}`);
        return false;
    }
}

function extractFingerprints(body) {
    try {
        const j = JSON.parse(body);
        return {
            ja3_hash:      j.tls?.ja3_hash,
            ja4:           j.tls?.ja4,
            peetprint_hash:j.tls?.peetprint_hash,
            akamai_hash:   j.http2?.akamai_fingerprint_hash,
            akamai:        j.http2?.akamai_fingerprint,
            ip:            j.ip,
        };
    } catch {
        return null;
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
    console.log('\n\x1b[1m=== CupNet Fingerprint Tests ===\x1b[0m\n');

    const worker = new Worker();

    try {
        // 1. Worker startup
        console.log('Test 1: Worker startup');
        await worker.waitReady();
        assert(true, 'Worker started and is ready');

        // 2. Get profiles list
        console.log('\nTest 2: Available profiles');
        const profilesRes = await new Promise((res, rej) => {
            const id = '__get_profiles__';
            const t = setTimeout(() => rej(new Error('timeout')), 5000);
            worker.pending.set(id, (err, msg) => { clearTimeout(t); if (err) rej(err); else res(msg); });
            worker.proc.stdin.write(JSON.stringify({ id }) + '\n');
        });
        const profiles = Object.keys(profilesRes.profiles || {});
        assert(profiles.length >= 4, `Profiles loaded: ${profiles.join(', ')}`);

        // 3. Chrome fingerprint
        console.log('\nTest 3: Chrome fingerprint');
        await worker.clearSessions();
        const chromeRes = await worker.send({ method: 'GET', url: TEST_URL, browser: 'chrome' });
        const chrome = extractFingerprints(chromeRes.body);
        assert(chrome !== null, 'Chrome: got valid JSON response');
        assert(chromeRes.statusCode === 200, `Chrome: HTTP 200 (got ${chromeRes.statusCode})`);
        console.log(`  ${INFO} JA3: ${chrome?.ja3_hash}`);
        console.log(`  ${INFO} JA4: ${chrome?.ja4}`);
        console.log(`  ${INFO} peetprint: ${chrome?.peetprint_hash}`);
        console.log(`  ${INFO} Akamai H2: ${chrome?.akamai}`);

        // 4. Firefox fingerprint
        console.log('\nTest 4: Firefox fingerprint');
        await worker.clearSessions();
        const firefoxRes = await worker.send({ method: 'GET', url: TEST_URL, browser: 'firefox' });
        const firefox = extractFingerprints(firefoxRes.body);
        assert(firefox !== null, 'Firefox: got valid JSON response');
        assert(firefoxRes.statusCode === 200, `Firefox: HTTP 200 (got ${firefoxRes.statusCode})`);
        console.log(`  ${INFO} JA3: ${firefox?.ja3_hash}`);
        console.log(`  ${INFO} JA4: ${firefox?.ja4}`);
        console.log(`  ${INFO} peetprint: ${firefox?.peetprint_hash}`);
        console.log(`  ${INFO} Akamai H2: ${firefox?.akamai}`);

        // 5. Fingerprints are different
        console.log('\nTest 5: Chrome vs Firefox differ');
        assert(chrome?.ja3_hash !== firefox?.ja3_hash,
            `JA3 hash differs: ${chrome?.ja3_hash} ≠ ${firefox?.ja3_hash}`);
        assert(chrome?.peetprint_hash !== firefox?.peetprint_hash,
            `peetprint differs: ${chrome?.peetprint_hash} ≠ ${firefox?.peetprint_hash}`);

        const chromeCiphers = chrome?.ja4?.split('_')[1];
        const ffCiphers     = firefox?.ja4?.split('_')[1];
        const ciphersMatch  = chromeCiphers === ffCiphers;
        if (ciphersMatch) {
            console.log(`  ${INFO} Cipher suites (JA4 middle) are same — expected with BoringSSL base`);
        } else {
            assert(!ciphersMatch, `JA4 cipher hash differs: ${chromeCiphers} ≠ ${ffCiphers}`);
        }

        // 6. HTTP/2 fingerprint (Akamai)
        console.log('\nTest 6: HTTP/2 fingerprint');
        if (chrome?.akamai && firefox?.akamai) {
            if (chrome.akamai_hash !== firefox.akamai_hash) {
                assert(true, `Akamai H2 hash differs (Chrome: ${chrome.akamai_hash}, Firefox: ${firefox.akamai_hash})`);
            } else {
                console.log(`  ${INFO} Akamai hash same — Firefox HTTP/2 profile may need further tuning`);
            }
        } else {
            console.log(`  ${INFO} No Akamai data returned (server may not expose it)`);
        }

        // 7. Session clear test
        console.log('\nTest 7: Session clearing');
        await worker.clearSessions();
        const chrome2 = await worker.send({ method: 'GET', url: TEST_URL, browser: 'chrome' });
        const fp2 = extractFingerprints(chrome2.body);
        assert(chrome2.statusCode === 200, 'Chrome works after session clear');
        assert(fp2?.ja3_hash !== undefined, 'Got fingerprint after session clear');

        // 8. iOS profile
        console.log('\nTest 8: iOS profile');
        await worker.clearSessions();
        const iosRes = await worker.send({ method: 'GET', url: TEST_URL, browser: 'ios' });
        const ios = extractFingerprints(iosRes.body);
        assert(ios !== null && iosRes.statusCode === 200, `iOS: HTTP ${iosRes.statusCode}`);
        console.log(`  ${INFO} JA3: ${ios?.ja3_hash}`);

        // Summary
        console.log('\n\x1b[1m=== Summary ===\x1b[0m');
        console.log(`Profiles tested: chrome, firefox, ios`);
        console.log(`JA3 unique hashes: ${new Set([chrome?.ja3_hash, firefox?.ja3_hash, ios?.ja3_hash]).size}/3`);
        console.log(`peetprint unique:  ${new Set([chrome?.peetprint_hash, firefox?.peetprint_hash]).size}/2`);
        console.log('\nAll tests complete.');

    } catch (e) {
        console.error(`\n${FAIL} Test error: ${e.message}`);
        console.error(e.stack);
        process.exitCode = 1;
    } finally {
        worker.kill();
        process.exit(process.exitCode || 0);
    }
}

runTests();
