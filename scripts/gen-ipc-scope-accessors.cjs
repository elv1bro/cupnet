#!/usr/bin/env node
/**
 * Regenerates main-process/ipc/_ipc-scope-accessors.inc.js after ipc-scope-key-list.json
 * or writable-keys set changes. Paste the output into cupnet-runtime.js (inside app.whenReady,
 * before buildIpcScopeObject) or pipe to file:
 *   node scripts/gen-ipc-scope-accessors.cjs > main-process/ipc/_ipc-scope-accessors.inc.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const keyListPath = path.join(root, 'main-process/ipc/ipc-scope-key-list.json');
const keys = JSON.parse(fs.readFileSync(keyListPath, 'utf8'));
const writ = new Set([
    'actProxy',
    'activeFingerprint',
    'compareResult',
    'connectedProfileId',
    'connectedProfileName',
    'connectedResolvedVars',
    'currentSessionId',
    'hadLoggingBeenStopped',
    'isLoggingEnabled',
    'lastMouseMoveTime',
    'logEntryCount',
    'persistentAnonymizedProxyUrl',
]);

let out = 'function ipcScopeGet(k) {\n    switch (k) {\n';
for (const k of keys) {
    out += `        case '${k}': return ${k};\n`;
}
out += '        default: return undefined;\n    }\n}\n';
out += 'function ipcScopeSet(k, v) {\n    switch (k) {\n';
for (const k of keys) {
    if (writ.has(k)) out += `        case '${k}': ${k} = v; return;\n`;
}
out += '        default: throw new Error("IPC read-only: " + k);\n    }\n}\n';

process.stdout.write(out);
