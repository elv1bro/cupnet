'use strict';

/**
 * MitmProxy state that must survive a MITM restart (A-027). A restart replaces the instance, and
 * the new one starts with an empty per-tab upstream map and no fail-closed block, so without this:
 *  - a tab bound to a proxy profile silently goes out through the global (possibly direct) route;
 *  - a fail-closed block is lifted and traffic egresses directly.
 * Either way the real IP leaks.
 */

/**
 * @param {object|null} proxy - the MitmProxy being replaced
 * @returns {{ tabUpstreams: Array<[string, object]>, egressBlocked: boolean, egressBlockReason: string }|null}
 */
function snapshotMitmRuntimeState(proxy) {
    if (!proxy) return null;
    const map = proxy._tabProxyMap;
    return {
        tabUpstreams: map && typeof map.entries === 'function'
            ? [...map.entries()].map(([tid, cfg]) => [tid, { ...cfg }])
            : [],
        egressBlocked: !!proxy._egressBlocked,
        egressBlockReason: proxy._egressBlockReason || '',
    };
}

/**
 * Re-apply a snapshot to the new MitmProxy. Call before wiring the global route: re-applying a
 * working global upstream lifts the block (as it should), a missing one keeps it.
 * @param {object|null} proxy
 * @param {ReturnType<typeof snapshotMitmRuntimeState>} snap
 */
function restoreMitmRuntimeState(proxy, snap) {
    if (!proxy || !snap) return;
    for (const [tid, cfg] of snap.tabUpstreams) {
        try { proxy.setTabUpstream(tid, cfg); } catch { /* ignore a bad entry */ }
    }
    if (snap.egressBlocked) proxy.setEgressBlocked(true, snap.egressBlockReason);
}

module.exports = { snapshotMitmRuntimeState, restoreMitmRuntimeState };
