import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import net from 'net';
import zlib from 'zlib';

const require = createRequire(import.meta.url);
const { FrameParser, encodeFrame, relayWebSocket, deflateNegotiated } = require('../../ws-frames.js');

const parseAll = (buf, chunk = buf.length) => {
    const out = [];
    const p = new FrameParser({ onMessage: (m) => out.push(m) });
    for (let i = 0; i < buf.length; i += chunk) p.feed(buf.subarray(i, i + chunk));
    return { out, p };
};

describe('FrameParser / encodeFrame', () => {
    it('round-trips masked and unmasked frames of every length class, byte by byte', () => {
        for (const n of [0, 5, 125, 126, 300, 65535, 65536, 70000]) {
            const payload = Buffer.alloc(n, 0x61);
            for (const mask of [false, true]) {
                const { out, p } = parseAll(encodeFrame({ opcode: 2, payload, mask }), n > 1000 ? 997 : 1);
                expect(out).toHaveLength(1);
                expect(out[0].opcode).toBe(2);
                expect(out[0].payload.equals(payload)).toBe(true);
                expect(out[0].size).toBe(n);
                expect(p.atBoundary).toBe(true);
            }
        }
    });

    it('assembles fragmented messages with a control frame in between', () => {
        const buf = Buffer.concat([
            encodeFrame({ opcode: 1, payload: 'hel', fin: false, mask: true }),
            encodeFrame({ opcode: 9, payload: 'p', mask: true }),
            encodeFrame({ opcode: 0, payload: 'lo', fin: true, mask: true }),
        ]);
        const { out } = parseAll(buf, 3);
        expect(out.map((m) => [m.opcode, m.payload.toString()])).toEqual([[9, 'p'], [1, 'hello']]);
    });

    it('reports boundaries only between whole messages', () => {
        const a = encodeFrame({ opcode: 1, payload: 'a', fin: false });
        const ping = encodeFrame({ opcode: 9, payload: '' });
        const b = encodeFrame({ opcode: 0, payload: 'b' });
        const c = encodeFrame({ opcode: 1, payload: 'c' });
        const buf = Buffer.concat([a, ping, b, c]);
        const at = [];
        new FrameParser().feed(buf, (pos) => at.push(pos));
        expect(at).toEqual([a.length + ping.length + b.length, buf.length]);
    });

    it('caps the captured payload but keeps counting the size', () => {
        const out = [];
        const p = new FrameParser({ captureMax: 10, onMessage: (m) => out.push(m) });
        p.feed(encodeFrame({ opcode: 2, payload: Buffer.alloc(100, 1), mask: true }));
        expect(out[0].payload.length).toBe(10);
        expect(out[0].size).toBe(100);
        expect(out[0].truncated).toBe(true);
    });

    it('flags bad framing instead of throwing', () => {
        const p = new FrameParser();
        p.feed(Buffer.from([0x83, 0x00]));
        expect(p.error).toMatch(/opcode/);
    });

    it('detects permessage-deflate', () => {
        expect(deflateNegotiated({ 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' })).toBe(true);
        expect(deflateNegotiated({})).toBe(false);
    });
});

// ── relay over real sockets: browser ⇄ [client | relay | upstream] ⇄ server ──
const servers = [];
afterAll(() => { for (const s of servers) s.close(); });
function socketPair() {
    return new Promise((resolve) => {
        const srv = net.createServer((inner) => resolve([inner, outer]));
        servers.push(srv);
        let outer;
        srv.listen(0, '127.0.0.1', () => { outer = net.connect(srv.address().port, '127.0.0.1'); });
    });
}
function collector(sock) {
    const out = [];
    const p = new FrameParser({ onMessage: (m) => out.push(m) });
    sock.on('data', (c) => p.feed(c));
    return out;
}
const until = async (fn, ms = 2000) => {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
};

describe('relayWebSocket', () => {
    it('forwards bytes, reports messages and injects only at message boundaries', async () => {
        const [client, browser] = await socketPair();
        const [server, upstream] = await socketPair();
        const atServer = collector(server);
        const atBrowser = collector(browser);
        const relay = relayWebSocket({ client, upstream, responseHeaders: {} });
        const seen = [];
        relay.on('message', (m) => seen.push(m));

        // A fragmented message whose first half arrives before the injection.
        const first = encodeFrame({ opcode: 1, payload: 'frag-', fin: false, mask: true });
        browser.write(first);
        await until(() => relay.open);
        await new Promise((r) => setTimeout(r, 50));
        expect(relay.send('out', { type: 'text', data: 'injected' })).toEqual({ queued: true });
        browser.write(encodeFrame({ opcode: 0, payload: 'ment', mask: true }));
        server.write(encodeFrame({ opcode: 2, payload: Buffer.from([1, 2, 3]) }));
        relay.send('in', { type: 'text', data: 'to page' });

        await until(() => atServer.length === 2 && atBrowser.length === 2);
        expect(atServer.map((m) => m.payload.toString())).toEqual(['frag-ment', 'injected']);
        expect(atBrowser.map((m) => m.opcode).sort()).toEqual([1, 2]);
        await until(() => seen.length === 4);
        const out = seen.filter((m) => m.dir === 'out');
        expect(out.map((m) => [m.data.toString(), m.injected])).toEqual([['frag-ment', false], ['injected', true]]);
        expect(seen.find((m) => m.dir === 'in' && m.type === 'binary').data).toEqual(Buffer.from([1, 2, 3]));

        let closed = false;
        relay.on('close', () => { closed = true; });
        relay.close();
        await until(() => atServer.some((m) => m.opcode === 8) && atBrowser.some((m) => m.opcode === 8));
        await until(() => closed, 3000);
    });

    it('inflates permessage-deflate messages with context takeover', async () => {
        const [client, browser] = await socketPair();
        const [server, upstream] = await socketPair();
        collector(browser);
        const relay = relayWebSocket({ client, upstream, responseHeaders: { 'sec-websocket-extensions': 'permessage-deflate' } });
        const seen = [];
        relay.on('message', (m) => seen.push(m));
        const def = zlib.createDeflateRaw();
        const compress = (text) => new Promise((resolve) => {
            const parts = [];
            const onData = (c) => parts.push(c);
            def.on('data', onData);
            def.write(text);
            def.flush(zlib.constants.Z_SYNC_FLUSH, () => {
                def.off('data', onData);
                const b = Buffer.concat(parts);
                resolve(b.subarray(0, b.length - 4)); // strip 00 00 ff ff
            });
        });
        for (const t of ['{"hello":"world"}', '{"hello":"world","again":true}']) {
            server.write(encodeFrame({ opcode: 1, payload: await compress(t), rsv1: true }));
        }
        await until(() => seen.length === 2);
        expect(seen.map((m) => m.data.toString())).toEqual(['{"hello":"world"}', '{"hello":"world","again":true}']);
        expect(seen.every((m) => m.compressed && !m.inflateError)).toBe(true);
        client.destroy(); upstream.destroy(); server.destroy(); browser.destroy();
    });
});
