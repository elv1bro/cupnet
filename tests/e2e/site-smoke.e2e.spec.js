'use strict';

/**
 * E2E: normal-site compatibility smoke — CupNet must render the ordinary web through the MITM.
 *
 * For every site in the list: the main document answers < 400, no anti-bot interstitial / block page is
 * shown, the page has text and links, an instant scroll moves the viewport, and (where the site has one)
 * the primary text input takes focus and accepts inserted text. This is the "can a person use it" bar of
 * docs/ai/BROWSER_IDENTITY_STATUS.md §3c: it measures compatibility with the open web with the shipping
 * identity, not whether any vendor's challenge is passed.
 *
 * Needs network. Run:  CUPNET_MITM_PORT=18877 npx playwright test tests/e2e/site-smoke.e2e.spec.js
 * Skip:                CUPNET_SKIP_EXTERNAL=1
 * Site list override:  CUPNET_SITE_SMOKE_SITES="https://a.example/,https://b.example/"
 * Identity:            CUPNET_SITE_SMOKE_TEMPLATE=chrome-win  (a browser-identity-catalog template id;
 *                      default: engine mode, the shipping default)
 */

const { test, expect } = require('@playwright/test');
const {
    launchCupnet,
    getMainWindow,
    waitForAppContext,
    waitMitmReady,
    navigateAndWait,
    readActiveTabBodyText,
    executeActiveTabJavaScript,
} = require('./helpers.js');

const skipExternal = process.env.CUPNET_SKIP_EXTERNAL === '1';
const TEMPLATE = (process.env.CUPNET_SITE_SMOKE_TEMPLATE || '').trim();
const TYPED_TEXT = 'cupnet smoke';

/**
 * Default list — a spread of page types and CDNs: plain HTML, a wiki, a search form, a login form, Q&A and
 * a package registry behind Cloudflare, a corporate site, news. `expect` must appear in the body text;
 * `input` is the primary text field to type into when the site has one.
 */
const DEFAULT_SITES = [
    { url: 'https://example.com/', expect: /Example Domain/i },
    { url: 'https://en.wikipedia.org/wiki/Main_Page', expect: /Wikipedia/i, input: 'input[name="search"]' },
    { url: 'https://duckduckgo.com/', expect: /DuckDuckGo/i, input: '#searchbox_input, input[name="q"]' },
    { url: 'https://github.com/login', expect: /Sign in/i, input: 'input[name="login"]' },
    { url: 'https://stackoverflow.com/questions', expect: /Questions/i },
    { url: 'https://www.npmjs.com/package/express', expect: /express/i },
    { url: 'https://www.mozilla.org/en-US/', expect: /Mozilla/i },
    { url: 'https://www.bbc.com/news', expect: /BBC/i },
];

function sitesFromEnv() {
    const raw = (process.env.CUPNET_SITE_SMOKE_SITES || '').trim();
    if (!raw) return DEFAULT_SITES;
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((url) => ({ url, expect: null }));
}
const SITES = sitesFromEnv();

/** Anti-bot interstitials and block pages, matched against the title + the first 1500 chars of body text. */
const INTERSTITIAL =
    /just a moment|attention required|checking your browser|verif(y|ying) you are (a )?human|access denied|request blocked|enable javascript and cookies|are you a robot|unusual traffic|pardon our interruption/i;

/** Runs in the tab: main-document status, render facts, and an instant scroll. */
const PROBE_JS = `(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const status = nav && typeof nav.responseStatus === 'number' ? nav.responseStatus : null;
    const before = window.scrollY;
    const scrollable = document.documentElement.scrollHeight > window.innerHeight + 50;
    window.scrollTo({ top: 600, left: 0, behavior: 'instant' });
    return {
        status,
        title: document.title,
        readyState: document.readyState,
        textLen: (document.body && document.body.innerText || '').length,
        links: document.querySelectorAll('a[href]').length,
        scrollable,
        scrolled: window.scrollY > before,
        ua: navigator.userAgent,
    };
})()`;

/**
 * Focus a typeable field: the hint selector when given and present, otherwise the first visible, enabled
 * text-like input / textarea on the page. Returns whether something was focused (selectors rot, so the
 * generic fallback keeps the interaction check from being brittle). Reads the value back from
 * document.activeElement, not by re-querying.
 */
function focusInputJs(selector) {
    const hint = selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null';
    return `(() => {
        const typeable = (e) => {
            if (e.disabled || e.readOnly || e.offsetParent === null) return false;
            if (e.tagName === 'TEXTAREA') return true;
            const t = (e.getAttribute('type') || 'text').toLowerCase();
            return ['text', 'search', 'email', 'url', ''].includes(t);
        };
        let el = ${hint};
        if (!el || !typeable(el)) {
            el = [...document.querySelectorAll('input, textarea')].find(typeable) || null;
        }
        if (!el) return { found: false, focused: false };
        el.focus();
        return { found: true, focused: document.activeElement === el, name: el.getAttribute('name') || el.id || el.tagName };
    })()`;
}

const ACTIVE_VALUE_JS = `(() => { const el = document.activeElement; return el ? String(el.value ?? '') : null; })()`;

/**
 * A real editing action in the renderer (IME-style commit into the focused element). Unlike OS key events
 * it does not need the window to be visible or focused, so it works in quiet e2e mode (CUPNET_E2E).
 */
async function insertTextIntoActiveTab(electronApp, text) {
    await electronApp.evaluate(async (_electron, s) => {
        const tm = globalThis.__cupnetAppContext?.modules?.tabManager;
        const wc = tm?.getActiveTab?.()?.view?.webContents;
        if (!wc || wc.isDestroyed()) throw new Error('no active tab WebContents');
        await wc.insertText(s);
    }, text);
}

// Not serial: sites are independent, so one site failing must not skip the rest. Kept sequential and
// sharing one Electron instance (beforeAll) by playwright.config.js (fullyParallel: false, workers: 1).
test.describe('normal-site compatibility smoke (through the MITM)', () => {
    test.skip(skipExternal, 'CUPNET_SKIP_EXTERNAL=1');

    let electronApp;
    /** @type {import('@playwright/test').Page} */
    let mainWindow;

    test.beforeAll(async () => {
        electronApp = await launchCupnet();
        await electronApp.firstWindow({ timeout: 120_000 });
        mainWindow = await getMainWindow(electronApp, 120_000);
        await mainWindow.waitForLoadState('domcontentloaded');
        await waitForAppContext(electronApp, 120_000);
        await waitMitmReady(electronApp, 180_000);
        if (TEMPLATE) {
            const res = await mainWindow.evaluate(
                (t) => window.electronAPI.setIdentity({ mode: 'template', templateId: t }),
                TEMPLATE
            );
            expect(res?.success, `setIdentity(template ${TEMPLATE})`).toBe(true);
        }
    });

    test.afterAll(async () => {
        if (!electronApp) return;
        if (TEMPLATE) {
            try {
                await mainWindow.evaluate(() => window.electronAPI.setIdentity({ mode: 'engine' }));
            } catch {
                /* closing anyway */
            }
        }
        await electronApp.close();
    });

    for (const site of SITES) {
        const host = new URL(site.url).hostname;
        test(`site) ${host} renders through the MITM and accepts basic interaction`, async () => {
            await navigateAndWait(electronApp, site.url, 120_000, {
                urlIncludes: host.replace(/^www\./, ''),
                minBodyLength: 100,
            });

            const probe = await executeActiveTabJavaScript(electronApp, PROBE_JS);
            const body = await readActiveTabBodyText(electronApp);
            const head = `${probe.title}\n${body.slice(0, 1500)}`;
            const info = JSON.stringify({
                url: site.url,
                status: probe.status,
                title: probe.title,
                textLen: probe.textLen,
                links: probe.links,
            });

            if (probe.status != null) expect(probe.status, `main document status ${info}`).toBeLessThan(400);
            expect(head, `anti-bot interstitial / block page ${info}`).not.toMatch(INTERSTITIAL);
            expect(probe.textLen, `body text ${info}`).toBeGreaterThan(100);
            // Links are only a weak render proxy: a valid minimal page (example.com) has exactly one.
            expect(probe.links, `at least one link ${info}`).toBeGreaterThanOrEqual(1);
            if (site.expect) expect(body, `expected content ${info}`).toMatch(site.expect);
            if (probe.scrollable) expect(probe.scrolled, `instant scroll ${info}`).toBe(true);
            expect(probe.ua, 'tab UA must not leak the engine').not.toMatch(/Electron|CupNet/);

            // Best-effort interaction: when a typeable field is present it must accept inserted text.
            // If the site has none (or the hint selector rotted and no generic field is found), render is
            // already proven above, so the interaction is skipped rather than failed.
            if (site.input) {
                const hint = typeof site.input === 'string' ? site.input : null;
                const f = await executeActiveTabJavaScript(electronApp, focusInputJs(hint));
                if (f.found) {
                    expect(f.focused, `input focusable ${info}`).toBe(true);
                    await insertTextIntoActiveTab(electronApp, TYPED_TEXT);
                    const value = await executeActiveTabJavaScript(electronApp, ACTIVE_VALUE_JS);
                    expect(value, `inserted text landed in focused field (${f.name}) ${info}`).toContain(TYPED_TEXT);
                } else {
                    // eslint-disable-next-line no-console
                    console.warn(`[site-smoke] no typeable input found on ${host}; interaction skipped`);
                }
            }
        });
    }
});
