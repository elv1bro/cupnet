'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createProxyNotifyBroadcast } = require('../../main-process/services/proxy-notify-broadcast.js');

describe('proxy status egress blocked (A-037)', () => {
    it('broadcasts mode blocked with the reason', () => {
        const sent = [];
        const BrowserWindow = {
            getAllWindows() {
                return [{
                    id: 1,
                    isDestroyed: () => false,
                    webContents: { send(channel, info) { sent.push({ channel, info }); } },
                }];
            },
        };
        const { notifyProxyStatus } = createProxyNotifyBroadcast({
            safeCatch() {},
            BrowserWindow,
            getTabManager: () => null,
            getDb: () => null,
            getMainWindow: () => null,
            getProxyManagerWindow: () => null,
            getPersistentAnonymizedProxyUrl: () => null,
            getActProxy: () => '',
            getConnectedProfileName: () => '',
            getConnectedProfileId: () => null,
            getConnectedResolvedVars: () => ({}),
            getCurrentTrafficMode: () => 'mitm',
            getMitmReady: () => true,
            getMitmState: () => 'ready',
            getMitmError: () => '',
            getMitmProxy: () => ({
                isEgressBlocked: () => true,
                getEgressBlockReason: () => 'profile B failed',
            }),
        });
        notifyProxyStatus();
        expect(sent).toHaveLength(1);
        expect(sent[0].channel).toBe('proxy-status-changed');
        expect(sent[0].info.mode).toBe('blocked');
        expect(sent[0].info.egressBlocked).toBe(true);
        expect(sent[0].info.egressBlockReason).toBe('profile B failed');
        expect(sent[0].info.active).toBe(false);
    });
});
