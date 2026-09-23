'use strict';

/**
 * Default User-Agent strings aligned with `BROWSER_PROFILES` in `azure-tls-worker.js`.
 * When the user picks a TLS template in Proxy Manager, we update the UA field if it is
 * empty or still one of the known preset values — so TLS fingerprint and HTTP UA stay consistent.
 */

const TLS_TEMPLATE_DEFAULT_UA = {
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
    ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0',
    opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 OPR/136.0.0.0',
};

/**
 * UA strings from current + past Proxy Manager "preset" buttons (`proxy-manager-renderer.js` UA_PRESETS).
 * Old values are kept here so that profiles saved with a previous preset are still recognized as
 * "replaceable" and auto-upgrade to the current UA when the TLS template is (re)selected.
 */
const UA_PRESET_VALUES = [
    // current presets
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
    // legacy presets (keep so old saved profiles still auto-upgrade)
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
];

const VALID_TLS = new Set(['chrome', 'firefox', 'safari', 'ios', 'edge', 'opera']);

let _replaceableSet;
function getReplaceableUaSet() {
    if (!_replaceableSet) {
        _replaceableSet = new Set();
        for (const u of Object.values(TLS_TEMPLATE_DEFAULT_UA)) _replaceableSet.add(u);
        for (const u of UA_PRESET_VALUES) _replaceableSet.add(u);
    }
    return _replaceableSet;
}

/**
 * @param {string} tlsTemplate - chrome | firefox | safari | ios | edge | opera
 * @param {string} [currentUa] - current User-Agent field value
 * @returns {{ newUa: string | null }} - newUa is null if the field should stay unchanged (custom UA)
 */
function syncUserAgentFromTlsTemplate(tlsTemplate, currentUa) {
    const tpl = String(tlsTemplate || '').trim();
    if (!VALID_TLS.has(tpl)) return { newUa: null };
    const target = TLS_TEMPLATE_DEFAULT_UA[tpl];
    const cur = String(currentUa ?? '').trim();
    if (!cur) return { newUa: target };
    if (getReplaceableUaSet().has(cur)) return { newUa: target };
    return { newUa: null };
}

// Name must not be `api` — proxy-manager-renderer.js also declares `const api` in the same page global scope.
const cupnetTlsUaSync = {
    TLS_TEMPLATE_DEFAULT_UA,
    UA_PRESET_VALUES,
    syncUserAgentFromTlsTemplate,
    getReplaceableUaSet,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = cupnetTlsUaSync;
}
if (typeof window !== 'undefined') {
    window.cupnetProxyTlsUaSync = cupnetTlsUaSync;
}
