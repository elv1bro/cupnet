'use strict';

/**
 * Per-webContents WebRTC IP handling (A-054).
 *
 * 'default_public_interface_only' only hides private/local addresses: STUN binding requests still
 * go out over UDP on the default route, outside the HTTP proxy / MITM, so the srflx candidate is the
 * host's real public IP (IPv4 and IPv6). 'disable_non_proxied_udp' is the only policy that keeps
 * WebRTC from sending UDP around the proxy (it may still use TURN over TCP through the proxy).
 *
 * Applied per-webContents, never via the global --force-webrtc-ip-handling-policy switch
 * (see the comments in main-process/cupnet-runtime.js).
 */
const WEBRTC_PROXIED_POLICY = 'disable_non_proxied_udp';
const WEBRTC_DIRECT_POLICY = 'default';

/**
 * Whether a tab's real IP must stay hidden: a global upstream, a per-tab proxy profile,
 * or a fail-closed egress block (proxy required but unavailable).
 * @param {{ globalUpstream?: unknown, tabProxyProfileId?: unknown, egressBlocked?: boolean }} state
 */
function tabNeedsWebRtcProtection({ globalUpstream, tabProxyProfileId, egressBlocked } = {}) {
    return !!(globalUpstream || tabProxyProfileId || egressBlocked);
}

/**
 * @param {Electron.WebContents | null | undefined} webContents
 * @param {boolean} protect
 * @returns {string | null} the policy that was set, or null when the webContents is gone
 */
function setWebRtcPolicy(webContents, protect) {
    if (!webContents || webContents.isDestroyed()) return null;
    const policy = protect ? WEBRTC_PROXIED_POLICY : WEBRTC_DIRECT_POLICY;
    try {
        webContents.setWebRTCIPHandlingPolicy(policy);
    } catch {
        return null;
    }
    return policy;
}

module.exports = {
    WEBRTC_PROXIED_POLICY,
    WEBRTC_DIRECT_POLICY,
    tabNeedsWebRtcProtection,
    setWebRtcPolicy,
};
