import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    WEBRTC_PROXIED_POLICY,
    WEBRTC_DIRECT_POLICY,
    tabNeedsWebRtcProtection,
    setWebRtcPolicy,
} = require('../../main-process/services/webrtc-policy.js');

function fakeWebContents({ destroyed = false, throws = false } = {}) {
    return {
        policy: null,
        isDestroyed: () => destroyed,
        setWebRTCIPHandlingPolicy(p) {
            if (throws) throw new Error('boom');
            this.policy = p;
        },
    };
}

describe('webrtc-policy (A-054)', () => {
    it('uses the only policy that blocks non-proxied UDP (STUN srflx leak)', () => {
        expect(WEBRTC_PROXIED_POLICY).toBe('disable_non_proxied_udp');
        expect(WEBRTC_DIRECT_POLICY).toBe('default');
    });

    it('protects a tab with a global upstream, a per-tab proxy or a fail-closed egress block', () => {
        expect(tabNeedsWebRtcProtection({ globalUpstream: '1.2.3.4:8080' })).toBe(true);
        expect(tabNeedsWebRtcProtection({ tabProxyProfileId: 7 })).toBe(true);
        expect(tabNeedsWebRtcProtection({ egressBlocked: true })).toBe(true);
        expect(tabNeedsWebRtcProtection({ globalUpstream: null, tabProxyProfileId: null, egressBlocked: false })).toBe(false);
        expect(tabNeedsWebRtcProtection()).toBe(false);
    });

    it('sets disable_non_proxied_udp when protected and default otherwise', () => {
        const wc = fakeWebContents();
        expect(setWebRtcPolicy(wc, true)).toBe('disable_non_proxied_udp');
        expect(wc.policy).toBe('disable_non_proxied_udp');
        expect(setWebRtcPolicy(wc, false)).toBe('default');
        expect(wc.policy).toBe('default');
    });

    it('ignores missing, destroyed or failing webContents', () => {
        expect(setWebRtcPolicy(null, true)).toBe(null);
        const destroyed = fakeWebContents({ destroyed: true });
        expect(setWebRtcPolicy(destroyed, true)).toBe(null);
        expect(destroyed.policy).toBe(null);
        expect(setWebRtcPolicy(fakeWebContents({ throws: true }), true)).toBe(null);
    });
});
