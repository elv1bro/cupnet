'use strict';

/**
 * Single-flight gate for MITM start and restart (A-027).
 * The placeholder promise is published before `fn` runs, so an overlapping
 * call joins the in-flight operation instead of starting a second proxy.
 */
function createSingleFlight() {
    /** @type {Promise<any>|null} */
    let current = null;

    /**
     * Start `fn`, or return the promise already in flight.
     * @template T
     * @param {() => T|Promise<T>} fn
     * @returns {Promise<T>}
     */
    function run(fn) {
        if (current) return current;
        let resolve;
        let reject;
        const p = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        current = p;
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                if (current === p) current = null;
            });
        return p;
    }

    function inFlight() {
        return current;
    }

    return { run, inFlight };
}

module.exports = { createSingleFlight };
