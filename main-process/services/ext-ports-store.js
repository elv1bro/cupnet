'use strict';
/**
 * Персистентный список внешних прокси-портов (userData/ext-ports.json).
 * Активные инстансы и ошибки старта остаются в main-process/index.js.
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sysLog } = require('../../sys-log');

function getExtPortsConfigPath() {
    return path.join(app.getPath('userData'), 'ext-ports.json');
}

function loadExtPortsConfig() {
    try {
        const raw = fs.readFileSync(getExtPortsConfigPath(), 'utf8');
        return JSON.parse(raw);
    } catch {
        return { ports: [] };
    }
}

function saveExtPortsConfig(config) {
    try {
        fs.writeFileSync(getExtPortsConfigPath(), JSON.stringify(config, null, 2));
    } catch (e) {
        sysLog('warn', 'ext-proxy', 'Failed to save ext-ports config: ' + (e?.message || e));
    }
}

module.exports = {
    getExtPortsConfigPath,
    loadExtPortsConfig,
    saveExtPortsConfig,
};
