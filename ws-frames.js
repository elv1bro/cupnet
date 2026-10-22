'use strict';

/**
 * WebSocket frame tap for the MITM tunnel (RFC 6455 + permessage-deflate for display).
 *
 * `relayWebSocket` forwards the raw bytes of both directions untouched, parses a copy to report every
 * message, and can inject frames of its own. Injected frames are only written between whole messages
 * (never inside a frame or a fragmented message), so the peer always sees a valid frame stream.
 * Injected data frames are sent uncompressed (RSV1 = 0), which permessage-deflate allows.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const OPCODES = { 0: 'continuation', 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };
const OPCODE_BY_TYPE = { text: 1, binary: 2, close: 8, ping: 9, pong: 10 };
/** Payload bytes kept per message for the log; the wire is never cut. */
const DEFAULT_CAPTURE_MAX = 4 * 1024 * 1024;
/** Inflated bytes kept per message (decompression bombs stop here). */
const INFLATE_MAX = 16 * 1024 * 1024;
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/**
 * Incremental frame parser for one direction. `feed(buf, onBoundary)` consumes bytes and calls
 * `onMessage` per complete message (control frames included); `onBoundary(pos)` fires each time the
 * stream is between messages after `pos` bytes of `buf`.
 */
class FrameParser {
    constructor({ onMessage, captureMax = DEFAULT_CAPTURE_MAX } = {}) {
        this.onMessage = onMessage || (() => {});
        this.captureMax = captureMax;
        this._head = Buffer.alloc(0);
        this._frame = null; // { opcode, fin, rsv1, len, left, mask, maskOff, chunks, kept }
        this._msg = null;   // fragmented data message in progress
        this.error = null;
    }

    /** Between messages: no partial frame and no unfinished fragmented message. */
    get atBoundary() { return !this._frame && !this._msg && this._head.length === 0; }

    feed(buf, onBoundary) {
        if (this.error) return;
        let i = 0;
        while (i < buf.length) {
            if (!this._frame) {
                const need = this._headerNeed(buf, i);
                if (need < 0) {
                    this._head = Buffer.concat([this._head, buf.subarray(i)]);
                    return;
                }
                const take = need - this._head.length;
                const head = this._head.length ? Buffer.concat([this._head, buf.subarray(i, i + take)]) : buf.subarray(i, i + take);
                i += take;
                this._head = Buffer.alloc(0);
                if (!this._startFrame(head)) return;
                if (this._frame.left === 0 && this._endFrame() && onBoundary) onBoundary(i);
                continue;
            }
            const f = this._frame;
            const n = Math.min(f.left, buf.length - i);
            this._capture(f, buf.subarray(i, i + n));
            f.left -= n;
            i += n;
            if (f.left === 0 && this._endFrame() && onBoundary) onBoundary(i);
        }
    }

    /** Header size of the frame starting at buf[i] (with buffered bytes), or -1 when incomplete. */
    _headerNeed(buf, i) {
        const avail = this._head.length + (buf.length - i);
        const at = (k) => (k < this._head.length ? this._head[k] : buf[i + k - this._head.length]);
        if (avail < 2) return -1;
        const b1 = at(1);
        const l7 = b1 & 0x7f;
        const need = 2 + (l7 === 126 ? 2 : l7 === 127 ? 8 : 0) + (b1 & 0x80 ? 4 : 0);
        return avail >= need ? need : -1;
    }

    _startFrame(h) {
        const b0 = h[0], b1 = h[1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f;
        let p = 2;
        if (len === 126) { len = h.readUInt16BE(2); p = 4; }
        else if (len === 127) {
            const big = h.readBigUInt64BE(2);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this._fail('frame too large');
            len = Number(big); p = 10;
        }
        const mask = b1 & 0x80 ? h.subarray(p, p + 4) : null;
        if (!OPCODES[opcode]) return this._fail(`bad opcode ${opcode}`);
        if (opcode >= 8 && (len > 125 || !(b0 & 0x80))) return this._fail('bad control frame');
        if (opcode === 0 && !this._msg) return this._fail('continuation without a message');
        if ((opcode === 1 || opcode === 2) && this._msg) return this._fail('new message inside a fragmented one');
        this._frame = { opcode, fin: !!(b0 & 0x80), len, left: len, mask: mask && Buffer.from(mask), maskOff: 0, chunks: [], kept: 0 };
        // Data frames open the message before any payload, so their bytes are captured into it.
        if (opcode === 1 || opcode === 2) this._msg = { opcode, compressed: !!(b0 & 0x40), chunks: [], kept: 0, size: 0 };
        return true;
    }

    _fail(msg) {
        this.error = msg;
        this._frame = null; this._msg = null; this._head = Buffer.alloc(0);
        return false;
    }

    _capture(f, part) {
        const msg = f.opcode >= 8 ? null : this._msg;
        const kept = msg ? msg.kept : f.kept;
        const room = Math.max(0, this.captureMax - kept);
        const keep = part.length > room ? part.subarray(0, room) : part;
        if (keep.length) {
            const out = Buffer.from(keep);
            if (f.mask) for (let k = 0; k < out.length; k++) out[k] ^= f.mask[(f.maskOff + k) & 3];
            (msg || f).chunks.push(out);
            if (msg) msg.kept += out.length; else f.kept += out.length;
        }
        f.maskOff += part.length;
        if (msg) msg.size += part.length;
    }

    /** Frame done. Returns true when the stream is now between messages. */
    _endFrame() {
        const f = this._frame;
        this._frame = null;
        if (f.opcode >= 8) {
            this.onMessage({ opcode: f.opcode, payload: Buffer.concat(f.chunks), size: f.len, truncated: f.kept < f.len, compressed: false });
            return !this._msg;
        }
        if (!f.fin) return false;
        const m = this._msg;
        this._msg = null;
        this.onMessage({ opcode: m.opcode, payload: Buffer.concat(m.chunks), size: m.size, truncated: m.kept < m.size, compressed: m.compressed });
        return true;
    }
}

/** One frame. `mask` = client → server. Control payloads are cut to 125 bytes. */
function encodeFrame({ opcode, payload = Buffer.alloc(0), mask = false, fin = true, rsv1 = false }) {
    let data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    if (opcode >= 8 && data.length > 125) data = data.subarray(0, 125);
    const len = data.length;
    const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
    const head = Buffer.alloc(2 + ext + (mask ? 4 : 0));
    head[0] = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
    head[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
    if (ext === 2) head.writeUInt16BE(len, 2);
    else if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2);
    if (!mask) return Buffer.concat([head, data]);
    const key = crypto.randomBytes(4);
    key.copy(head, 2 + ext);
    const out = Buffer.from(data);
    for (let k = 0; k < out.length; k++) out[k] ^= key[k & 3];
    return Buffer.concat([head, out]);
}

/** Close frame payload: 2-byte code + UTF-8 reason. */
function closePayload(code, reason) {
    if (!code) return Buffer.alloc(0);
    const r = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
    const b = Buffer.alloc(2 + r.length);
    b.writeUInt16BE(code, 0);
    r.copy(b, 2);
    return b;
}

function parseClose(payload) {
    if (!payload || payload.length < 2) return {};
    return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') };
}

/** permessage-deflate negotiated in the 101 response? */
function deflateNegotiated(responseHeaders) {
    const h = responseHeaders || {};
    const k = Object.keys(h).find((x) => x.toLowerCase() === 'sec-websocket-extensions');
    const v = k ? String(Array.isArray(h[k]) ? h[k].join(',') : h[k]) : '';
    return /(^|,)\s*permessage-deflate\b/i.test(v);
}

/** Per-direction inflater keeping the LZ77 window across messages (context takeover). */
class Inflater {
    constructor() { this._z = null; this.broken = false; }

    _ensure() {
        if (this._z) return this._z;
        const z = zlib.createInflateRaw({ windowBits: 15 });
        z.on('error', () => {}); // reported through inflate() instead
        this._z = z;
        return z;
    }

    reset() {
        if (this._z) { try { this._z.close(); } catch { /* ignore */ } }
        this._z = null;
        this.broken = false;
    }

    inflate(payload) {
        return new Promise((resolve) => {
            const z = this._ensure();
            const out = [];
            let n = 0, over = false, done = false;
            const finish = (err) => {
                if (done) return;
                done = true;
                z.off('data', onData); z.off('error', onErr);
                if (err) { this.reset(); this.broken = true; return resolve({ error: err.message || String(err) }); }
                resolve({ data: Buffer.concat(out), truncated: over });
            };
            const onData = (c) => {
                if (n + c.length > INFLATE_MAX) { over = true; out.push(c.subarray(0, Math.max(0, INFLATE_MAX - n))); n = INFLATE_MAX; return; }
                out.push(c); n += c.length;
            };
            const onErr = (e) => finish(e);
            z.on('data', onData);
            z.once('error', onErr);
            z.write(Buffer.concat([payload, DEFLATE_TAIL]));
            z.flush(zlib.constants.Z_SYNC_FLUSH, () => finish(null));
        });
    }
}

/**
 * Relay a WebSocket after the 101: client ⇄ upstream with a message tap and frame injection.
 *
 * Emits `message` ({ dir: 'out'|'in', type, data: Buffer, size, compressed, truncated, injected, code,
 * reason, inflateError, ts }) in wire order per direction, and `close` once both sockets are gone.
 * `dir` 'out' = client → server, 'in' = server → client.
 *
 * @param {{ client: import('stream').Duplex, upstream: import('stream').Duplex, responseHeaders?: object,
 *   clientRemainder?: Buffer, upstreamRemainder?: Buffer, captureMax?: number }} o
 */
function relayWebSocket(o) {
    const ev = new EventEmitter();
    const { client, upstream } = o;
    const deflate = deflateNegotiated(o.responseHeaders);
    let closing = false, closed = false;
    const sides = {
        out: { src: client, dst: upstream, mask: true },
        in: { src: upstream, dst: client, mask: false },
    };

    for (const dir of ['out', 'in']) {
        const s = sides[dir];
        s.queue = [];
        s.sentClose = false;
        s.chain = Promise.resolve();
        s.inflater = deflate ? new Inflater() : null;
        s.parser = new FrameParser({ captureMax: o.captureMax, onMessage: (m) => report(dir, m) });
        s.write = (buf) => {
            if (closing || s.dst.destroyed || s.dst.writableEnded) return true;
            try { return s.dst.write(buf); } catch { return true; }
        };
        s.flushQueue = () => {
            while (s.queue.length) {
                const f = s.queue.shift();
                s.write(f.bytes);
                emitLater(dir, f.msg);
            }
        };
        s.forward = (chunk) => {
            if (!chunk || !chunk.length) return true;
            if (s.parser.error) return s.write(chunk); // unknown framing: plain pass-through
            let start = 0, ok = true;
            s.parser.feed(chunk, (pos) => {
                if (!s.queue.length) return;
                ok = s.write(chunk.subarray(start, pos)) && ok;
                start = pos;
                s.flushQueue();
            });
            if (start < chunk.length) ok = s.write(chunk.subarray(start)) && ok;
            if (s.queue.length && s.parser.atBoundary) s.flushQueue();
            return ok;
        };
    }

    function emitLater(dir, msg) {
        const s = sides[dir];
        s.chain = s.chain.then(() => { if (msg) ev.emit('message', msg); }).catch(() => {});
    }

    function report(dir, m) {
        const s = sides[dir];
        const ts = Date.now();
        const type = OPCODES[m.opcode] || String(m.opcode);
        const base = { dir, type, size: m.size, truncated: m.truncated, compressed: m.compressed, injected: false, ts };
        if (m.opcode === 8) Object.assign(base, parseClose(m.payload));
        if (m.compressed && s.inflater && !m.truncated) {
            const payload = m.payload;
            s.chain = s.chain.then(async () => {
                const r = await s.inflater.inflate(payload);
                ev.emit('message', r.error ? { ...base, data: payload, inflateError: r.error } : { ...base, data: r.data, truncated: !!r.truncated });
            }).catch(() => {});
            return;
        }
        if (m.compressed && s.inflater && m.truncated) {
            // The window is lost with the cut payload; later messages may fail to inflate.
            s.inflater.reset();
            base.inflateError = 'payload over the capture limit — not inflated';
        }
        s.chain = s.chain.then(() => { ev.emit('message', { ...base, data: m.payload }); }).catch(() => {});
    }

    // Bytes that arrived with the handshake go through the tap first.
    sides.in.forward(o.upstreamRemainder);
    sides.out.forward(o.clientRemainder);

    for (const dir of ['out', 'in']) {
        const s = sides[dir];
        s.src.on('data', (chunk) => {
            if (closing) { s.parser.feed(chunk); return; }
            if (!s.forward(chunk)) {
                s.src.pause();
                s.dst.once('drain', () => s.src.resume());
            }
        });
        s.src.on('end', () => { try { s.dst.end(); } catch { /* ignore */ } });
        s.src.on('error', () => { try { s.dst.destroy(); } catch { /* ignore */ } });
        s.src.on('close', () => {
            try { s.dst.destroy(); } catch { /* ignore */ }
            if (closed) return;
            if (client.destroyed && upstream.destroyed) {
                closed = true;
                Promise.all([sides.out.chain, sides.in.chain]).then(() => ev.emit('close'));
            }
        });
    }

    /**
     * Inject one message. dir 'out' → to the server, 'in' → to the page.
     * @param {'out'|'in'} dir
     * @param {{ type: 'text'|'binary'|'ping'|'pong'|'close', data?: string|Buffer, code?: number, reason?: string }} m
     */
    ev.send = (dir, m) => {
        const s = sides[dir];
        if (!s) throw new Error('dir must be "out" or "in"');
        const opcode = OPCODE_BY_TYPE[m?.type];
        if (!opcode) throw new Error('type must be text, binary, ping, pong or close');
        if (closing || closed || s.dst.destroyed || s.dst.writableEnded) throw new Error('connection is closed');
        if (s.sentClose) throw new Error('a close frame was already sent this way');
        let payload = opcode === 8 ? closePayload(Number(m.code) || 1000, m.reason)
            : Buffer.isBuffer(m.data) ? m.data : Buffer.from(String(m.data ?? ''), 'utf8');
        if (opcode >= 8 && payload.length > 125) payload = payload.subarray(0, 125);
        if (opcode === 8) s.sentClose = true;
        const bytes = encodeFrame({ opcode, payload, mask: s.mask });
        const msg = {
            dir, type: m.type, size: payload.length, truncated: false, compressed: false, injected: true, ts: Date.now(),
            data: payload, ...(opcode === 8 ? parseClose(payload) : {}),
        };
        if (s.parser.atBoundary) { s.write(bytes); emitLater(dir, msg); return { queued: false }; }
        s.queue.push({ bytes, msg });
        return { queued: true };
    };

    /** Close both sides with a close frame, then drop the sockets. */
    ev.close = (code = 1000, reason = 'closed by CupNet') => {
        if (closing || closed) return;
        for (const dir of ['out', 'in']) {
            const s = sides[dir];
            if (!s.sentClose) { try { ev.send(dir, { type: 'close', code, reason }); } catch { /* gone */ } }
        }
        closing = true;
        setTimeout(() => {
            try { client.end(); } catch { /* ignore */ }
            try { upstream.end(); } catch { /* ignore */ }
            setTimeout(() => { try { client.destroy(); } catch { /* ignore */ } try { upstream.destroy(); } catch { /* ignore */ } }, 1000).unref?.();
        }, 300).unref?.();
    };

    Object.defineProperty(ev, 'open', { get: () => !closing && !closed && !client.destroyed && !upstream.destroyed });
    ev.deflate = deflate;
    return ev;
}

module.exports = { FrameParser, encodeFrame, relayWebSocket, deflateNegotiated, parseClose, OPCODES };
