'use strict';

/**
 * Live WebSocket connections seen by the MITM (CupNet mini). Each connection is keyed by the seq of its
 * upgrade request in the session log; every message is logged as a `kind: 'ws'` entry (see
 * SessionLog.logWs). The hub keeps the relays of open connections so the UI can send or close.
 */

/** Upgrade requests waiting for their relay (requestId → seq); the relay follows within the same tick. */
const PENDING_MAX = 500;
/** Payload limit for a message sent from the UI. */
const SEND_MAX = 16 * 1024 * 1024;

class WsHub {
    /** @param {{ getLog: () => import('./session-log').SessionLog | null }} o */
    constructor({ getLog }) {
        this.getLog = getLog;
        this._seqByRequest = new Map();
        /** ws id → { id, url, openedAt, relay, counts: { in, out } } */
        this.open = new Map();
    }

    /** The upgrade request was logged as `seq` (called from onRequestLogged). */
    noteUpgrade(requestId, seq) {
        if (!requestId || !seq) return;
        this._seqByRequest.set(requestId, seq);
        while (this._seqByRequest.size > PENDING_MAX) this._seqByRequest.delete(this._seqByRequest.keys().next().value);
    }

    /** MitmProxy onWebSocket hook. */
    attach({ requestId, url, relay }) {
        const id = this._seqByRequest.get(requestId);
        this._seqByRequest.delete(requestId);
        if (!id) return; // not logged (CupNet's own endpoint): pass-through only
        const c = { id, url, openedAt: Date.now(), relay, counts: { in: 0, out: 0 }, deflate: !!relay.deflate };
        this.open.set(id, c);
        relay.on('message', (m) => {
            c.counts[m.dir] = (c.counts[m.dir] || 0) + 1;
            this.getLog()?.logWs(id, { ...m, url });
        });
        relay.on('close', () => {
            this.open.delete(id);
            this.getLog()?.logWs(id, { type: 'end', dir: undefined, url, note: 'connection closed', data: Buffer.alloc(0), size: 0 });
        });
    }

    /** Open connections, for the UI. */
    list() {
        return [...this.open.values()].map((c) => ({ id: c.id, url: c.url, openedAt: c.openedAt, counts: { ...c.counts }, deflate: c.deflate }));
    }

    /**
     * Send one message on an open connection.
     * @param {number} id
     * @param {{ dir: 'out'|'in', type: string, data?: string, base64?: boolean, code?: number, reason?: string }} b
     */
    send(id, b) {
        const c = this.open.get(Number(id));
        if (!c) throw new Error('connection is not open');
        if (b?.dir !== 'out' && b?.dir !== 'in') throw new Error('dir must be "out" (to the server) or "in" (to the page)');
        const data = b.base64 ? Buffer.from(String(b.data || ''), 'base64') : Buffer.from(String(b.data ?? ''), 'utf8');
        if (data.length > SEND_MAX) throw new Error('message is over 16 MB');
        return c.relay.send(b.dir, { type: b.type, data, code: b.code, reason: b.reason });
    }

    close(id, code, reason) {
        const c = this.open.get(Number(id));
        if (!c) throw new Error('connection is not open');
        c.relay.close(Number(code) || 1000, reason || 'closed by CupNet');
        return { ok: true };
    }

    closeAll() {
        for (const c of this.open.values()) { try { c.relay.close(1001, 'CupNet is stopping'); } catch { /* ignore */ } }
    }
}

module.exports = { WsHub };
