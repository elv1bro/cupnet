'use strict';

/**
 * Fresh profile shows onboarding once; complete + optional reset.
 */
const { test, expect } = require('@playwright/test');
const { launchCupnet, waitForAppContext, waitMitmReady, waitForWindowByTitle } = require('./helpers.js');

test('onb1) fresh userData shows Welcome window; completeOnboarding closes flow', async () => {
    const electronApp = await launchCupnet();
    try {
        const mainWindow = await electronApp.firstWindow({ timeout: 120_000 });
        await mainWindow.waitForLoadState('domcontentloaded');
        await waitForAppContext(electronApp, 120_000);
        await waitMitmReady(electronApp, 180_000);

        const welcome = await waitForWindowByTitle(electronApp, 'Welcome to CupNet', 45_000).catch(() => null);
        expect(welcome).toBeTruthy();

        const done = await mainWindow.evaluate(() => window.electronAPI.completeOnboarding());
        expect(done?.success).toBe(true);

        try {
            await welcome.close({ runBeforeUnload: false });
        } catch {
            /* ignore */
        }

        const all = await mainWindow.evaluate(() => window.electronAPI.getSettingsAll());
        expect(all?.onboardingComplete).toBe(true);
    } finally {
        await electronApp.close();
    }
});
