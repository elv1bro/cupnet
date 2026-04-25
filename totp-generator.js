/**
 * Browser TOTP (RFC 6238) for Credentials vault UI.
 * Supports SHA-1, SHA-256, SHA-512 algorithms.
 * Exposes window.cupnetTotp.generate(secretBase32, options) -> { code, secondsRemaining }
 */
(function (global) {
    'use strict';

    function decodeBase32(s) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const cleaned = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
        let bits = 0;
        let value = 0;
        const out = [];
        for (let i = 0; i < cleaned.length; i++) {
            const v = alphabet.indexOf(cleaned[i]);
            if (v < 0) continue;
            value = (value << 5) | v;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                out.push((value >>> bits) & 0xff);
            }
        }
        return new Uint8Array(out);
    }

    const HASH_MAP = {
        'sha1': 'SHA-1', 'sha-1': 'SHA-1',
        'sha256': 'SHA-256', 'sha-256': 'SHA-256',
        'sha512': 'SHA-512', 'sha-512': 'SHA-512',
    };

    function resolveHash(algo) {
        if (!algo) return 'SHA-1';
        return HASH_MAP[String(algo).toLowerCase()] || 'SHA-1';
    }

    function secondsRemaining(period, nowMs) {
        const p = Math.max(1, Number(period) || 30);
        const s = Math.floor((nowMs != null ? nowMs : Date.now()) / 1000);
        return p - (s % p);
    }

    async function generate(secretBase32, opts) {
        const options = opts && typeof opts === 'object' ? opts : {};
        const period = Math.max(1, Number(options.period) || 30);
        const digits = Math.min(8, Math.max(6, Number(options.digits) || 6));
        const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
        const hash = resolveHash(options.algorithm);
        const key = decodeBase32(secretBase32);
        if (!key.length) return { code: '', secondsRemaining: secondsRemaining(period, nowMs) };
        const counter = Math.floor(nowMs / 1000 / period);
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        let c = counter;
        for (let i = 7; i >= 0; i--) {
            view.setUint8(i, c & 0xff);
            c = Math.floor(c / 256);
        }
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            key,
            { name: 'HMAC', hash },
            false,
            ['sign'],
        );
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
        const offset = sig[sig.length - 1] & 0x0f;
        const code =
            ((sig[offset] & 0x7f) << 24)
            | ((sig[offset + 1] & 0xff) << 16)
            | ((sig[offset + 2] & 0xff) << 8)
            | (sig[offset + 3] & 0xff);
        const mod = 10 ** digits;
        return {
            code: String(code % mod).padStart(digits, '0'),
            secondsRemaining: secondsRemaining(period, nowMs),
        };
    }

    global.cupnetTotp = { generate, secondsRemaining, decodeBase32 };
})(typeof window !== 'undefined' ? window : globalThis);
