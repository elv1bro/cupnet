'use strict';

/**
 * Build ipcScope object from explicit get/set functions (no eval).
 * ipcScopeGet / ipcScopeSet must close over main-process bindings.
 */
function buildIpcScopeObject(ipcScopeKeyList, ipcScopeWritableKeys, ipcScopeGet, ipcScopeSet) {
    const ipcScope = Object.create(null);
    for (const key of ipcScopeKeyList) {
        if (ipcScopeWritableKeys.has(key)) {
            Object.defineProperty(ipcScope, key, {
                get() { return ipcScopeGet(key); },
                set(v) { ipcScopeSet(key, v); },
                enumerable: true,
                configurable: true,
            });
        } else {
            Object.defineProperty(ipcScope, key, {
                get() { return ipcScopeGet(key); },
                enumerable: true,
                configurable: true,
            });
        }
    }
    return ipcScope;
}

module.exports = { buildIpcScopeObject };
