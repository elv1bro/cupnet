'use strict';

const path = require('path');

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
    testDir: path.join(__dirname, 'tests', 'e2e'),
    // beforeAll: launch + firstWindow + waitMitmReady (до 180s) — иначе хук обрывается раньше MITM
    timeout: 420_000,
    expect: { timeout: 45_000 },
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: [['list']],
};
