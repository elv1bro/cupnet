'use strict';

/**
 * Проверяет тот же скрипт детекции, что и Page Analyzer (`_analyzeCaptchaScript`),
 * на публичных демо 2Captcha. Нужен интернет.
 *
 * Запуск: npx playwright test tests/e2e/captcha-demo-detection.e2e.spec.js
 * Пропуск: CUPNET_SKIP_EXTERNAL=1
 */

const path = require('path');
const { test, expect, chromium } = require('@playwright/test');
const { _analyzeCaptchaScript } = require(
    path.join(__dirname, '../../main-process/services/page-analyzer-injected-scripts')
);

const skipExternal = process.env.CUPNET_SKIP_EXTERNAL === '1';

async function runAnalyzer(page) {
    return page.evaluate((scriptSrc) => {
        const run = new Function(`return (${scriptSrc})()`);
        return run();
    }, _analyzeCaptchaScript);
}

async function waitForCaptchaDetect(page, check, { tries = 40, delayMs = 2000 } = {}) {
    let last = null;
    for (let i = 0; i < tries; i++) {
        last = await runAnalyzer(page);
        if (check(last)) return last;
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return last;
}

test.describe('2Captcha demo — детекция виджетов (скрипт Page Analyzer)', () => {
    test.skip(skipExternal, 'CUPNET_SKIP_EXTERNAL=1');

    let browser;

    test.beforeAll(async () => {
        browser = await chromium.launch();
    });

    test.afterAll(async () => {
        await browser?.close();
    });

    test('reCAPTCHA v2 — есть sitekey / iframe', async () => {
        const page = await browser.newPage();
        try {
            await page.goto('https://2captcha.com/demo/recaptcha-v2', {
                waitUntil: 'domcontentloaded',
                timeout: 90_000,
            });
            await page.waitForSelector('.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="google.com"]', {
                timeout: 45_000,
            });
            const r = await runAnalyzer(page);
            expect(r.recaptcha.length, 'recaptcha entries').toBeGreaterThan(0);
            expect(r.totalCount).toBeGreaterThan(0);
            const hasSitekey = r.recaptcha.some((x) => String(x.sitekey || '').length > 10);
            expect(hasSitekey, 'expected non-empty sitekey on demo').toBe(true);
        } finally {
            await page.close();
        }
    });

    test('reCAPTCHA v3 — скрипт api.js с render=', async () => {
        const page = await browser.newPage();
        try {
            await page.goto('https://2captcha.com/demo/recaptcha-v3', {
                waitUntil: 'domcontentloaded',
                timeout: 90_000,
            });
            /* <script> в head невидим — иначе Playwright ждёт visible до таймаута */
            await page.waitForSelector('script[src*="recaptcha/api.js"]', {
                state: 'attached',
                timeout: 45_000,
            });
            const r = await runAnalyzer(page);
            expect(r.recaptcha.length).toBeGreaterThan(0);
            const v3 = r.recaptcha.find((x) => x.version === 'v3');
            expect(v3, 'v3 widget').toBeTruthy();
            expect(String(v3.sitekey || '').length).toBeGreaterThan(10);
        } finally {
            await page.close();
        }
    });

    test('hCaptcha — виджет или script api', async () => {
        const page = await browser.newPage();
        try {
            await page.goto('https://2captcha.com/demo/hcaptcha', {
                waitUntil: 'domcontentloaded',
                timeout: 90_000,
            });
            const r = await waitForCaptchaDetect(page, (x) => (x.hcaptcha || []).length > 0, {
                tries: 35,
                delayMs: 2000,
            });
            expect(r.hcaptcha.length).toBeGreaterThan(0);
            expect(r.totalCount).toBeGreaterThan(0);
        } finally {
            await page.close();
        }
    });

    test('Cloudflare Turnstile — cf-turnstile или iframe challenges', async () => {
        const page = await browser.newPage();
        try {
            await page.goto('https://2captcha.com/demo/turnstile', {
                waitUntil: 'domcontentloaded',
                timeout: 90_000,
            });
            await page.waitForSelector('.cf-turnstile, iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]', {
                timeout: 45_000,
            });
            const r = await runAnalyzer(page);
            expect(r.turnstile.length).toBeGreaterThan(0);
            expect(r.totalCount).toBeGreaterThan(0);
        } finally {
            await page.close();
        }
    });

    /** Публичный демо-ключ на странице (get.php / документация 2Captcha). */
    const GEETEST_DEMO_GT = '81388ea1fc187e0c335c0a8907ff2625';

    test('GeeTest V3 — gt из скриптов / виджет geetest', async () => {
        const page = await browser.newPage();
        try {
            await page.goto('https://2captcha.com/demo/geetest', {
                waitUntil: 'domcontentloaded',
                timeout: 90_000,
            });
            await page.waitForSelector(
                'script[src*="geetest"], script[src*="gt.js"], .geetest_holder, .gee-test',
                { state: 'attached', timeout: 45_000 },
            );
            /* Сначала может появиться только vendor/gt.js без gt — ждём загрузки api.geetest.com/gettype.php */
            const r = await waitForCaptchaDetect(
                page,
                (x) => (x.geetest || []).some((g) => String(g.gt || '').length === 32),
                { tries: 35, delayMs: 2000 },
            );
            expect((r.geetest || []).length, 'geetest entries').toBeGreaterThan(0);
            const hasDemoGt = (r.geetest || []).some(
                (g) => String(g.gt || '') === GEETEST_DEMO_GT,
            );
            expect(hasDemoGt, 'expected demo gt on 2Captcha GeeTest page').toBe(true);
        } finally {
            await page.close();
        }
    });
});
