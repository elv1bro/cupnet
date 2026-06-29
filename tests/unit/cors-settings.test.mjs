'use strict';

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

vi.mock('electron', () => ({
    app: {
        getPath: vi.fn(() => '/tmp/cupnet-vitest-userdata'),
    },
}));

const require = createRequire(import.meta.url);
const {
    SETTINGS_DEFAULTS,
    mergeImportedSettings,
    buildFactoryResetSettings,
} = require('../../main-process/services/settings-store.js');

describe('settings corsBypassEnabled', () => {
    it('defaults to false', () => {
        expect(SETTINGS_DEFAULTS.corsBypassEnabled).toBe(false);
        expect(buildFactoryResetSettings().corsBypassEnabled).toBe(false);
    });

    it('mergeImportedSettings turns on only for strict true', () => {
        const cur = buildFactoryResetSettings();
        expect(mergeImportedSettings(cur, { corsBypassEnabled: true }).corsBypassEnabled).toBe(true);
        expect(mergeImportedSettings(cur, { corsBypassEnabled: false }).corsBypassEnabled).toBe(false);
        expect(mergeImportedSettings(cur, { corsBypassEnabled: 1 }).corsBypassEnabled).toBe(false);
        expect(mergeImportedSettings(cur, { corsBypassEnabled: 'yes' }).corsBypassEnabled).toBe(false);
    });
});
