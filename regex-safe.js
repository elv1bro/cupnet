'use strict';

/**
 * Safer RegExp.test for user-controlled patterns (ReDoS mitigation).
 * @param {string} pattern
 * @param {string} haystack
 * @returns {boolean}
 */
function safeRegexTest(pattern, haystack) {
    const p = String(pattern ?? '');
    const h = String(haystack ?? '');
    if (p.length > 512) return false;
    if (h.length > 200000) return false;
    let re;
    try {
        re = new RegExp(p);
    } catch {
        return false;
    }
    const t0 = Date.now();
    let ok = false;
    try {
        ok = re.test(h);
    } catch {
        return false;
    }
    if (Date.now() - t0 > 200) return false;
    return ok;
}

module.exports = { safeRegexTest };
