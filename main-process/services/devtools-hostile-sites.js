'use strict';

/**
 * DevTools/CDP-hostile sites registry.
 *
 * Some anti-fraud / liveness / banking sites detect that DevTools is open and
 * react with a runaway `debugger;` loop, infinite recursion, or other hangs
 * that freeze the entire renderer. Electron exposes Chromium's debugger via
 * `webContents.debugger.attach()` over the same CDP transport as DevTools, so
 * to those sites our network logging looks identical to "DevTools is open"
 * — and they will trigger the same defenses.
 *
 * For URLs whose host matches an entry below the runtime will:
 *   1. Refuse to attach `webContents.debugger`/CDP (cdp-network-logging.js).
 *   2. Detach CDP eagerly on `will-navigate` / `did-navigate` (same module).
 *   3. Block opening the in-app DevTools window (cookies-dns-ipc.js + main-window.js).
 *   4. Skip `executeJavaScript` injects that touch storage / forms / paste-unlock
 *      so we don't add extra surface for fingerprint-style detection (tab-manager.js).
 *
 * Traffic recording still works through the MITM proxy — only the per-tab CDP
 * shadow path is disabled. That keeps the page usable both with logging on and
 * with logging off, which is the point of CupNet ("a browser that works
 * everywhere"). The price is that for these tabs the Log Viewer won't show the
 * CDP-only fields (resourceType, in-renderer initiator stack, DOMStorage events).
 *
 * Hosts are matched as suffixes: `ozforensics.com` covers `ozforensics.com`,
 * `www.ozforensics.com`, `demo.ozforensics.com`, etc. — but **not**
 * `notozforensics.com`.
 */

/** Lowercase, no leading dot. Add new sites as we find them. */
const DEFAULT_HOSTILE_HOSTS = [
    /** Liveness/biometry demo hangs renderer when CDP is attached or DevTools is open. */
    'ozforensics.com',
];

const _hostileHosts = new Set(DEFAULT_HOSTILE_HOSTS.map((h) => _normalizeHost(h)).filter(Boolean));

function _normalizeHost(host) {
    if (typeof host !== 'string') return '';
    let h = host.trim().toLowerCase();
    if (!h) return '';
    if (h.startsWith('.')) h = h.slice(1);
    /** Accept hosts with port; strip it. IPv6 brackets are kept intact. */
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        if (end > 0) return h.slice(0, end + 1);
        return h;
    }
    const colon = h.indexOf(':');
    if (colon > 0) h = h.slice(0, colon);
    return h;
}

/** Schemes that never carry remote pages we'd care about. Keeps file:// new-tab/etc. fast-path. */
const _SAFE_SCHEMES = new Set([
    'file:', 'about:', 'chrome:', 'chrome-error:', 'chrome-extension:',
    'devtools:', 'data:', 'javascript:', 'blob:',
]);

function _hostFromUrl(url) {
    if (typeof url !== 'string' || url.length === 0) return '';
    /** view-source:https://… — unwrap so we still match the inner site. */
    let raw = url;
    if (raw.startsWith('view-source:')) raw = raw.slice('view-source:'.length);
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return '';
    }
    if (_SAFE_SCHEMES.has(parsed.protocol)) return '';
    return _normalizeHost(parsed.hostname || '');
}

/**
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
function isDevtoolsHostileUrl(url) {
    const host = _hostFromUrl(url);
    if (!host) return false;
    if (_hostileHosts.has(host)) return true;
    /** Suffix match: any subdomain of a registered host. */
    for (const h of _hostileHosts) {
        if (host.length > h.length + 1 && host.endsWith('.' + h)) return true;
    }
    return false;
}

/**
 * @param {{ isDestroyed?: () => boolean, getURL?: () => string } | null | undefined} webContents
 * @returns {boolean}
 */
function isDevtoolsHostileWebContents(webContents) {
    if (!webContents) return false;
    try {
        if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return false;
        const url = typeof webContents.getURL === 'function' ? webContents.getURL() : '';
        return isDevtoolsHostileUrl(url);
    } catch {
        return false;
    }
}

/**
 * Add a host (or a list of hosts) at runtime — useful when wiring this to
 * a user-editable settings list in the future. Returns the count of new hosts.
 * @param {string|string[]} hostOrList
 * @returns {number}
 */
function addDevtoolsHostileHost(hostOrList) {
    const list = Array.isArray(hostOrList) ? hostOrList : [hostOrList];
    let added = 0;
    for (const raw of list) {
        const h = _normalizeHost(raw);
        if (!h) continue;
        if (!_hostileHosts.has(h)) {
            _hostileHosts.add(h);
            added += 1;
        }
    }
    return added;
}

/**
 * Replace the runtime list (defaults + previously added) with the given set.
 * Pass an empty array to disable the feature entirely.
 * @param {string[]} hosts
 */
function setDevtoolsHostileHosts(hosts) {
    _hostileHosts.clear();
    if (Array.isArray(hosts)) {
        for (const raw of hosts) {
            const h = _normalizeHost(raw);
            if (h) _hostileHosts.add(h);
        }
    }
}

/**
 * @returns {string[]} snapshot of the current registry.
 */
function listDevtoolsHostileHosts() {
    return Array.from(_hostileHosts).sort();
}

module.exports = {
    isDevtoolsHostileUrl,
    isDevtoolsHostileWebContents,
    addDevtoolsHostileHost,
    setDevtoolsHostileHosts,
    listDevtoolsHostileHosts,
    DEFAULT_HOSTILE_HOSTS,
};
