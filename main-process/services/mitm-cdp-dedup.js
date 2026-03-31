'use strict';

/**
 * MITM vs CDP log dedup:
 * - Primary: X-CupNet-Rid header (tryClaimRid / releaseRid) — same ID on wire for both paths.
 * - Fallback: bidirectional (tab, url, method, status) + time window when rid is absent.
 */

const _mitmKeys = new Map();
const _cdpKeys = new Map();
const WINDOW_MS = 12_000;
const MAX_KEYS = 800;

const _ridMap = new Map();
const MAX_RIDS = 50_000;

function _makeKey(tabId, url, method, status) {
    return `${tabId}|${String(method || 'GET').toUpperCase()}|${String(url || '')}|${status ?? ''}`;
}

function _prune(map) {
    if (map.size <= MAX_KEYS) return;
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, t] of map) {
        if (t < cutoff) map.delete(key);
    }
}

function markMitmLogged(tabId, url, method, status) {
    const k = _makeKey(tabId, url, method, status);
    _mitmKeys.set(k, Date.now());
    _prune(_mitmKeys);
}

function markCdpLogged(tabId, url, method, status) {
    const k = _makeKey(tabId, url, method, status);
    _cdpKeys.set(k, Date.now());
    _prune(_cdpKeys);
}

function _recent(map, tabId, url, method, status) {
    const k = _makeKey(tabId, url, method, status);
    const t = map.get(k);
    if (t == null) return false;
    if (Date.now() - t > WINDOW_MS) {
        map.delete(k);
        return false;
    }
    return true;
}

function shouldSkipCdpShadowAsMitmDuplicate(tabId, url, method, status) {
    return _recent(_mitmKeys, tabId, url, method, status);
}

function shouldSkipMitmAsCdpDuplicate(tabId, url, method, status) {
    return _recent(_cdpKeys, tabId, url, method, status);
}

/**
 * @param {string|null|undefined} rid
 * @returns {true|false|null} true = claimed (first writer); false = duplicate; null = no rid (use legacy dedup)
 */
function tryClaimRid(rid) {
    if (!rid || typeof rid !== 'string') return null;
    if (_ridMap.has(rid)) return false;
    _ridMap.set(rid, Date.now());
    if (_ridMap.size > MAX_RIDS) {
        const iter = _ridMap.keys();
        for (let i = 0; i < MAX_RIDS / 2; i++) {
            const k = iter.next().value;
            if (k) _ridMap.delete(k);
        }
    }
    return true;
}

function releaseRid(rid) {
    if (!rid || typeof rid !== 'string') return;
    _ridMap.delete(rid);
}

module.exports = {
    markMitmLogged,
    markCdpLogged,
    shouldSkipCdpShadowAsMitmDuplicate,
    shouldSkipMitmAsCdpDuplicate,
    tryClaimRid,
    releaseRid,
};
