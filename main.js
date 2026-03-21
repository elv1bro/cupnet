'use strict';

// ─── MITM CA trust: MUST run before Electron/Chromium init ────────────────────
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Resolve userData path manually (app.getPath is not yet available before require('electron'))
// Electron stores it at: ~/Library/Application Support/<productName> (mac)
//                        %APPDATA%/<productName> (win)
//                        ~/.config/<productName> (linux)
const PRODUCT_NAME = 'CupNet';
function resolveUserDataDir() {
    if (process.platform === 'darwin')
        return path.join(os.homedir(), 'Library', 'Application Support', PRODUCT_NAME);
    if (process.platform === 'win32')
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), PRODUCT_NAME);
    return path.join(os.homedir(), '.config', PRODUCT_NAME);
}

const { loadOrGenerateCA } = require('./mitm-proxy.js');
const caDir = path.join(resolveUserDataDir(), 'mitm-ca');
loadOrGenerateCA(caDir);
const caPath = path.join(caDir, 'ca-cert.pem');
if (fs.existsSync(caPath)) {
    process.env.NODE_EXTRA_CA_CERTS = caPath;
}

require('./main-process/index.js');
