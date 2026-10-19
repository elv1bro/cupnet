'use strict';

/**
 * upstream-tunnel.js (A-410): raw tunnels through http / https / socks4 / socks4a / socks5 upstreams,
 * against tiny in-process proxies and an echo target. Hermetic — loopback only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import net from 'net';
import tls from 'tls';

const require = createRequire(import.meta.url);
const { connectThroughProxy, parseProxyUrl } = require('../../upstream-tunnel.js');
const mitmCa = require('../../mitm-ca.js');

const servers = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => { servers.push(srv); r(srv.address().port); }));
afterAll(() => { for (const s of servers) try { s.close(); } catch { /* ignore */ } });

/** Collects bytes until `n` are available. */
function readN(sock, n) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const on = (c) => {
            buf = Buffer.concat([buf, c]);
            if (buf.length >= n) { sock.removeListener('data', on); sock.pause(); if (buf.length > n) sock.unshift(buf.subarray(n)); resolve(buf.subarray(0, n)); }
        };
        sock.on('data', on);
        sock.resume();
    });
}

function pipeTo(client, host, port, seen) {
    seen.push(`${host}:${port}`);
    const up = net.connect(port, host === 'localhost.test' ? '127.0.0.1' : host);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
    return up;
}

let echoPort;
const seen = { socks5: [], socks4: [], http: [] };

function socks5Server({ user, pass } = {}) {
    return net.createServer(async (c) => {
        c.on('error', () => {});
        const [ver, n] = await readN(c, 2);
        const methods = await readN(c, n);
        if (ver !== 5) return c.destroy();
        if (user) {
            if (!methods.includes(2)) { c.end(Buffer.from([5, 0xff])); return; }
            c.write(Buffer.from([5, 2]));
            const [, ul] = await readN(c, 2);
            const u = (await readN(c, ul)).toString();
            const [pl] = await readN(c, 1);
            const p = (await readN(c, pl)).toString();
            if (u !== user || p !== pass) { c.end(Buffer.from([1, 1])); return; }
            c.write(Buffer.from([1, 0]));
        } else {
            c.write(Buffer.from([5, 0]));
        }
        const [, cmd, , atyp] = await readN(c, 4);
        let host;
        if (atyp === 1) host = [...(await readN(c, 4))].join('.');
        else if (atyp === 3) { const [l] = await readN(c, 1); host = (await readN(c, l)).toString(); }
        else return c.destroy();
        const port = (await readN(c, 2)).readUInt16BE(0);
        if (cmd !== 1 || host === 'refused.test') { c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const up = pipeTo(c, host, port, seen.socks5);
        up.once('connect', () => {
            c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            c.pipe(up); up.pipe(c); c.resume();
        });
    });
}

function socks4Server() {
    return net.createServer(async (c) => {
        c.on('error', () => {});
        const head = await readN(c, 8);
        const port = head.readUInt16BE(2);
        let ip = [...head.subarray(4, 8)].join('.');
        const readZ = async () => { const out = []; for (;;) { const [b] = await readN(c, 1); if (b === 0) return Buffer.from(out).toString(); out.push(b); } };
        await readZ(); // user id
        if (ip.startsWith('0.0.0.') && ip !== '0.0.0.0') ip = await readZ(); // 4a
        const up = pipeTo(c, ip, port, seen.socks4);
        up.once('connect', () => {
            c.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
            c.pipe(up); up.pipe(c); c.resume();
        });
    });
}

function httpConnectHandler(c) {
    c.on('error', () => {});
    let buf = Buffer.alloc(0);
    const on = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        c.removeListener('data', on);
        const head = buf.toString('latin1', 0, i);
        const [, target] = /^CONNECT (\S+)/.exec(head) || [];
        if (!/proxy-authorization: basic dTpw/i.test(head)) { c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
        const [host, port] = target.split(':');
        const up = pipeTo(c, host, Number(port), seen.http);
        up.once('connect', () => {
            c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (buf.length > i + 4) up.write(buf.subarray(i + 4));
            c.pipe(up); up.pipe(c);
        });
    };
    c.on('data', on);
}

async function roundTrip(proxyUrl, host = '127.0.0.1') {
    const { socket, buffered } = await connectThroughProxy(proxyUrl, host, echoPort, { timeoutMs: 3000 });
    expect(buffered.length).toBe(0);
    const got = new Promise((r) => socket.once('data', (d) => r(d.toString())));
    socket.write('ping');
    const v = await got;
    socket.destroy();
    return v;
}

describe('connectThroughProxy', () => {
    let s5, s5auth, s4, hp, hsp;
    beforeAll(async () => {
        echoPort = await listen(net.createServer((c) => { c.on('error', () => {}); c.on('data', (d) => c.write(`echo:${d}`)); }));
        s5 = await listen(socks5Server());
        s5auth = await listen(socks5Server({ user: 'u', pass: 'p@ss' }));
        s4 = await listen(socks4Server());
        hp = await listen(net.createServer(httpConnectHandler));
        mitmCa.generateCA();
        const leaf = mitmCa.getFakeCert('proxy.test');
        hsp = await listen(tls.createServer({ key: leaf.key, cert: leaf.cert }, httpConnectHandler));
    });

    it('parses schemes and default ports, socks: means socks5', () => {
        expect(parseProxyUrl('socks://h')).toMatchObject({ scheme: 'socks5:', port: 1080 });
        expect(parseProxyUrl('http://a%40b:c@h')).toMatchObject({ scheme: 'http:', port: 80, username: 'a@b', password: 'c' });
        expect(() => parseProxyUrl('ftp://h:1')).toThrow(/Unsupported/);
    });

    it('socks5 without auth, target name sent to the proxy (no local DNS)', async () => {
        expect(await roundTrip(`socks5://127.0.0.1:${s5}`, 'localhost.test')).toBe('echo:ping');
        expect(seen.socks5.at(-1)).toBe(`localhost.test:${echoPort}`);
        expect(await roundTrip(`socks5h://127.0.0.1:${s5}`)).toBe('echo:ping');
    });

    it('socks5 with username/password; wrong password and refused targets reject', async () => {
        expect(await roundTrip(`socks5://u:p%40ss@127.0.0.1:${s5auth}`)).toBe('echo:ping');
        await expect(connectThroughProxy(`socks5://u:bad@127.0.0.1:${s5auth}`, '127.0.0.1', echoPort)).rejects.toThrow(/authentication failed/);
        await expect(connectThroughProxy(`socks5://127.0.0.1:${s5auth}`, '127.0.0.1', echoPort)).rejects.toThrow(/auth methods/);
        await expect(connectThroughProxy(`socks5://127.0.0.1:${s5}`, 'refused.test', 1)).rejects.toThrow(/connection refused/);
    });

    it('socks4 (local resolve) and socks4a (name to the proxy)', async () => {
        expect(await roundTrip(`socks4://127.0.0.1:${s4}`)).toBe('echo:ping');
        expect(await roundTrip(`socks4a://127.0.0.1:${s4}`, 'localhost.test')).toBe('echo:ping');
        expect(seen.socks4.at(-1)).toBe(`localhost.test:${echoPort}`);
    });

    it('http CONNECT with Basic auth; a 407 rejects with the status', async () => {
        expect(await roundTrip(`http://u:p@127.0.0.1:${hp}`)).toBe('echo:ping');
        const err = await connectThroughProxy(`http://127.0.0.1:${hp}`, '127.0.0.1', echoPort).catch((e) => e);
        expect(err.statusCode).toBe(407);
    });

    it('https:// proxy: CONNECT over TLS to the proxy', async () => {
        expect(await roundTrip(`https://u:p@127.0.0.1:${hsp}`)).toBe('echo:ping');
    });

    it('times out against a proxy that never answers', async () => {
        const silent = await listen(net.createServer((c) => c.on('error', () => {})));
        await expect(connectThroughProxy(`socks5://127.0.0.1:${silent}`, '127.0.0.1', echoPort, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    });
});
