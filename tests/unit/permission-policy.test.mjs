'use strict';

/**
 * Tab-session permission policy (A-188): nothing sensitive is granted without the user's consent,
 * Chrome's no-prompt permissions stay allowed, decisions are remembered per session + origin.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createPermissionPolicy, permissionKeys } = require('../../main-process/services/permission-policy.js');

const ORIGIN = 'https://site.example';
const req = (extra = {}) => ({ requestingUrl: `${ORIGIN}/page`, ...extra });

function fakeSession() {
    return {
        check: null, request: null,
        setPermissionCheckHandler(fn) { this.check = fn; },
        setPermissionRequestHandler(fn) { this.request = fn; },
    };
}
const ask = (sess, permission, details) => new Promise((resolve) => sess.request(null, permission, resolve, details));

describe('permission-policy', () => {
    it('undecided sensitive permissions are not granted by the check handler (no silent grant)', () => {
        const sess = fakeSession();
        createPermissionPolicy().install(sess);
        for (const p of ['geolocation', 'notifications', 'midi', 'clipboard-read', 'idle-detection', 'window-management', 'local-fonts', 'persistent-storage']) {
            expect(sess.check(null, p, ORIGIN, {})).toBe(false);
        }
        expect(sess.check(null, 'media', ORIGIN, { mediaType: 'video' })).toBe(false);
        expect(sess.check(null, 'media', ORIGIN, { mediaType: 'audio' })).toBe(false);
    });

    it("Chrome's no-prompt permissions stay allowed", () => {
        const sess = fakeSession();
        createPermissionPolicy().install(sess);
        for (const p of ['clipboard-sanitized-write', 'sensors', 'background-sync', 'screen-wake-lock', 'storage-access', 'payment-handler', 'pointerLock', 'keyboardLock', 'fullscreen']) {
            expect(sess.check(null, p, ORIGIN, {})).toBe(true);
        }
    });

    it('without a prompt (quiet mode) requests are denied', async () => {
        const sess = fakeSession();
        createPermissionPolicy().install(sess);
        expect(await ask(sess, 'geolocation', req())).toBe(false);
        expect(await ask(sess, 'media', req({ mediaTypes: ['video', 'audio'] }))).toBe(false);
    });

    it('a user decision is asked once, remembered per origin, and then answers the check handler', async () => {
        const prompt = vi.fn(async () => true);
        const sess = fakeSession();
        createPermissionPolicy({ prompt }).install(sess);
        const [a, b] = await Promise.all([ask(sess, 'geolocation', req()), ask(sess, 'geolocation', req())]);
        expect(a).toBe(true);
        expect(b).toBe(true);
        expect(prompt).toHaveBeenCalledTimes(1); // concurrent requests share one prompt
        expect(sess.check(null, 'geolocation', ORIGIN, {})).toBe(true);
        expect(await ask(sess, 'geolocation', req())).toBe(true);
        expect(prompt).toHaveBeenCalledTimes(1);
        // another origin is asked separately
        expect(sess.check(null, 'geolocation', 'https://other.example', {})).toBe(false);
    });

    it('a block is remembered; camera and microphone are separate decisions', async () => {
        const prompt = vi.fn(async ({ keys }) => keys.length === 1 && keys[0] === 'media:audio');
        const sess = fakeSession();
        createPermissionPolicy({ prompt }).install(sess);
        expect(await ask(sess, 'media', req({ mediaTypes: ['video'] }))).toBe(false);
        expect(await ask(sess, 'media', req({ mediaTypes: ['audio'] }))).toBe(true);
        expect(sess.check(null, 'media', ORIGIN, { mediaType: 'audio' })).toBe(true);
        expect(sess.check(null, 'media', ORIGIN, { mediaType: 'video' })).toBe(false);
        // both together: video already blocked → denied without asking again
        expect(await ask(sess, 'media', req({ mediaTypes: ['video', 'audio'] }))).toBe(false);
        expect(prompt).toHaveBeenCalledTimes(2);
    });

    it('cameraMode "none" blocks video even after the user allowed it, but not audio', async () => {
        const prompt = vi.fn(async () => true);
        const sess = fakeSession();
        const policy = createPermissionPolicy({ prompt });
        policy.install(sess, { denyVideo: true });
        expect(await ask(sess, 'media', req({ mediaTypes: ['video'] }))).toBe(false);
        expect(await ask(sess, 'media', req({ mediaTypes: ['audio'] }))).toBe(true);
        expect(sess.check(null, 'media', ORIGIN, { mediaType: 'video' })).toBe(false);
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    it('silent-deny permissions never prompt', async () => {
        const prompt = vi.fn(async () => true);
        const sess = fakeSession();
        createPermissionPolicy({ prompt }).install(sess);
        expect(await ask(sess, 'persistent-storage', req())).toBe(false);
        expect(await ask(sess, 'unknown', req())).toBe(false);
        expect(prompt).not.toHaveBeenCalled();
    });

    it('permissionKeys splits media into camera / microphone', () => {
        expect(permissionKeys('media', { mediaTypes: ['video', 'audio'] })).toEqual(['media:video', 'media:audio']);
        expect(permissionKeys('media', { mediaType: 'audio' })).toEqual(['media:audio']);
        expect(permissionKeys('geolocation', {})).toEqual(['geolocation']);
    });
});
