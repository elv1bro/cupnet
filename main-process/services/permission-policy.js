'use strict';

/**
 * Tab-session permission policy (A-188) — behaves like Google Chrome instead of Electron's default
 * "approve every request" (which let any site silently use the camera, microphone, geolocation, MIDI,
 * clipboard read, … and exposed device ids/labels via enumerateDevices without asking).
 *
 *  - Permissions Chrome grants without asking (measured on Chrome 153: clipboard write, sensors,
 *    background sync, wake lock, storage access, payment handler, keyboard/pointer lock, fullscreen)
 *    are allowed.
 *  - Everything Chrome asks about is NOT granted until the user allows it in a prompt; the decision is
 *    remembered per session + requesting origin + permission for the lifetime of the app.
 *  - The check handler answers "not granted" for undecided permissions. Electron's check handler is
 *    boolean, so navigator.permissions reports "denied" (Chrome: "prompt") — but consistently in every
 *    realm, and enumerateDevices no longer leaks ids/labels.
 *  - cameraMode "none" (Settings → device permissions) always blocks video, as before.
 *
 * Quiet test mode (CUPNET_E2E=1) never shows a dialog: undecided requests are denied.
 */

/** Electron permission names Chrome grants without a prompt. */
const AUTO_ALLOW = new Set([
    'clipboard-sanitized-write',
    'background-sync',
    'sensors',
    'screen-wake-lock',
    'storage-access',
    'top-level-storage-access',
    'payment-handler',
    'keyboardLock',
    'pointerLock',
    'fullscreen',
    'mediaKeySystem',
]);

/** Never granted and never prompted: Chrome decides these heuristically / has no UI we can mirror. */
const SILENT_DENY = new Set(['persistent-storage', 'periodic-background-sync', 'background-fetch', 'unknown']);

/** Human-readable text for the prompt ("<host> wants to …"). */
const PROMPT_TEXT = {
    'media:video': 'use your camera',
    'media:audio': 'use your microphone',
    geolocation: 'know your location',
    'geolocation-approximate': 'know your approximate location',
    notifications: 'show notifications',
    midi: 'use your MIDI devices',
    midiSysex: 'control and reprogram your MIDI devices',
    'clipboard-read': 'see text and images copied to the clipboard',
    'display-capture': 'capture your screen',
    'idle-detection': 'know when you are actively using this device',
    'window-management': 'manage windows on all your displays',
    'local-fonts': 'use the fonts installed on your computer',
    'captured-surface-control': 'scroll and zoom the tabs you share',
    'local-network-access': 'look for and connect to devices on your local network',
    'local-network': 'connect to devices on your local network',
    'loopback-network': 'connect to apps on this device',
    openExternal: 'open an external application',
    fileSystem: 'edit files on your device',
    hid: 'connect to HID devices',
    serial: 'connect to serial ports',
    usb: 'connect to USB devices',
    nfc: 'use NFC',
    'smart-card': 'use your smart cards',
    'automatic-fullscreen': 'automatically enter full screen',
    'web-app-installation': 'install web apps',
    'web-printing': 'print without asking',
    'speaker-selection': 'use your speakers',
    ar: 'use augmented reality',
    vr: 'use virtual reality',
    'hand-tracking': 'track your hands',
};

function _originOf(url) {
    try {
        const u = new URL(String(url || ''));
        return u.origin && u.origin !== 'null' ? u.origin : String(url || '');
    } catch {
        return String(url || '');
    }
}

/** Requested media kinds of a 'media' request/check: ['video'], ['audio'] or both. */
function mediaKinds(details) {
    if (!details) return ['video', 'audio'];
    if (Array.isArray(details.mediaTypes) && details.mediaTypes.length) {
        return details.mediaTypes.filter((t) => t === 'video' || t === 'audio');
    }
    if (details.mediaType === 'video' || details.mediaType === 'audio') return [details.mediaType];
    return ['video', 'audio'];
}

/** Permission keys a request/check covers (media is split into camera and microphone). */
function permissionKeys(permission, details) {
    if (permission === 'media') return mediaKinds(details).map((k) => `media:${k}`);
    return [permission];
}

/**
 * @param {object} opts
 * @param {(req: { origin: string, keys: string[], texts: string[], webContents: any, details: any }) => Promise<boolean>} [opts.prompt]
 *        asks the user; resolves true to allow. Omitted → undecided requests are denied.
 */
function createPermissionPolicy({ prompt } = {}) {
    /** @type {WeakMap<object, Map<string, boolean>>} session → "origin|key" → decision */
    const decisions = new WeakMap();
    /** @type {WeakMap<object, Map<string, Promise<boolean>>>} in-flight prompts, deduplicated */
    const pending = new WeakMap();

    function _store(sess) {
        let m = decisions.get(sess);
        if (!m) { m = new Map(); decisions.set(sess, m); }
        return m;
    }

    function _decided(sess, origin, key) {
        const m = decisions.get(sess);
        return m && m.has(`${origin}|${key}`) ? m.get(`${origin}|${key}`) : undefined;
    }

    /** Synchronous answer for the check handler (and the fast path of a request). */
    function check(sess, permission, origin, details, { denyVideo = false } = {}) {
        if (AUTO_ALLOW.has(permission)) return true;
        if (SILENT_DENY.has(permission)) return false;
        const keys = permissionKeys(permission, details);
        if (!keys.length) return false;
        if (denyVideo && keys.includes('media:video')) return false;
        return keys.every((k) => _decided(sess, origin, k) === true);
    }

    /** Asynchronous answer for the request handler: auto rules, remembered decision, else prompt. */
    async function request(sess, webContents, permission, details, { denyVideo = false } = {}) {
        if (AUTO_ALLOW.has(permission)) return true;
        if (SILENT_DENY.has(permission)) return false;
        const origin = _originOf(details && (details.requestingUrl || details.securityOrigin));
        const keys = permissionKeys(permission, details);
        if (!keys.length) return false;
        if (denyVideo && keys.includes('media:video')) return false;
        const known = keys.map((k) => _decided(sess, origin, k));
        if (known.some((d) => d === false)) return false;
        const ask = keys.filter((k, i) => known[i] === undefined);
        if (!ask.length) return true;
        if (typeof prompt !== 'function') return false;

        let inflight = pending.get(sess);
        if (!inflight) { inflight = new Map(); pending.set(sess, inflight); }
        const pk = `${origin}|${ask.join('+')}`;
        let p = inflight.get(pk);
        if (!p) {
            const texts = ask.map((k) => PROMPT_TEXT[k] || `use "${k}"`);
            p = Promise.resolve()
                .then(() => prompt({ origin, keys: ask, texts, webContents, details }))
                .then((v) => v === true, () => false)
                .then((allowed) => {
                    const m = _store(sess);
                    for (const k of ask) m.set(`${origin}|${k}`, allowed);
                    return allowed;
                })
                .finally(() => inflight.delete(pk));
            inflight.set(pk, p);
        }
        return p;
    }

    /** Forget decisions (e.g. when a partition's site data is cleared). */
    function reset(sess) {
        if (sess) decisions.delete(sess);
    }

    /**
     * Install the policy on an Electron session.
     * @param {import('electron').Session} sess
     * @param {{ denyVideo?: boolean }} [o]
     */
    function install(sess, o = {}) {
        if (!sess) return;
        const denyVideo = !!o.denyVideo;
        sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
            check(sess, permission, _originOf(requestingOrigin || (details && details.requestingUrl)), details, { denyVideo }));
        sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
            request(sess, webContents, permission, details, { denyVideo })
                .then((ok) => callback(!!ok), () => callback(false));
        });
    }

    /** Decisions already stored for this origin, keyed the way permissions.query names them. */
    function snapshot(sess, origin) {
        const m = decisions.get(sess);
        const out = {};
        if (!m || !origin) return out;
        const prefix = `${origin}|`;
        for (const [k, v] of m) {
            if (!k.startsWith(prefix)) continue;
            const key = k.slice(prefix.length);
            if (key === 'media:video') out.camera = v;
            else if (key === 'media:audio') out.microphone = v;
            else out[key] = v;
        }
        return out;
    }

    return { check, request, install, reset, snapshot };
}

/**
 * Default prompt: a modal question on the window that hosts the tab. Chrome-like wording.
 * @returns {(req: { origin: string, texts: string[], webContents: any }) => Promise<boolean>}
 */
function createDialogPrompt({ dialog, BrowserWindow }) {
    return async ({ origin, texts, webContents }) => {
        if (process.env.CUPNET_E2E === '1') return false;
        let host = origin;
        try { host = new URL(origin).host || origin; } catch { /* keep origin */ }
        let parent = null;
        try { parent = (webContents && BrowserWindow.fromWebContents(webContents)) || null; } catch { parent = null; }
        if (!parent) {
            try { parent = BrowserWindow.getFocusedWindow() || null; } catch { parent = null; }
        }
        const opts = {
            type: 'question',
            buttons: ['Allow', 'Block'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            title: 'Permission request',
            message: `${host} wants to`,
            detail: texts.map((t) => `• ${t}`).join('\n'),
        };
        const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        return res && res.response === 0;
    };
}

module.exports = {
    AUTO_ALLOW,
    SILENT_DENY,
    createPermissionPolicy,
    createDialogPrompt,
    permissionKeys,
};
