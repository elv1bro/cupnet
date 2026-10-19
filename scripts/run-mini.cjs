#!/usr/bin/env node
'use strict';

// Run CupNet mini on Electron's bundled Node (ELECTRON_RUN_AS_NODE) — better-sqlite3 is rebuilt for
// Electron's ABI by `npm install`, so plain `node` cannot load it. No Electron window is created.

const path = require('path');
const { spawn } = require('child_process');

const electronBin = require('electron'); // path to the Electron binary when required from Node
const entry = path.join(__dirname, '..', 'mini', 'cupnet-mini.js');

const child = spawn(electronBin, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
