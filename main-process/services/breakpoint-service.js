'use strict';

/** Pending breakpoint UI: id -> { resolve, timeout } */
const pending = new Map();

/**
 * @param {string} id
 * @param {(result: { action: string, patch?: object }) => void} resolve
 */
function registerBreakpoint(id, resolve) {
    const timeout = setTimeout(() => {
        if (pending.has(id)) {
            pending.delete(id);
            resolve({ action: 'forward' });
        }
    }, 30000);
    pending.set(id, { resolve, timeout });
}

/**
 * @param {string} id
 * @param {{ action: string, patch?: object }} result
 * @returns {boolean}
 */
function resumeBreakpoint(id, result) {
    const p = pending.get(id);
    if (!p) return false;
    clearTimeout(p.timeout);
    pending.delete(id);
    p.resolve(result || { action: 'forward' });
    return true;
}

module.exports = {
    registerBreakpoint,
    resumeBreakpoint,
};
