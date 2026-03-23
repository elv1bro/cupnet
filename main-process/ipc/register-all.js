'use strict';

const { registerMainProcessIpc } = require('./register-main-ipc.js');

/**
 * Регистрация всего IPC главного процесса.
 * @param {object} ctx — см. ipc-scope-key-list.json + eval-геттеры в index.js
 */
function registerAllMainIpc(ctx) {
    registerMainProcessIpc(ctx);
}

/** @deprecated используйте registerAllMainIpc */
function noteMainProcessRegistersIpcBelow() {
    // оставлено для совместимости со старыми ссылками в документации
}

module.exports = { registerAllMainIpc, registerMainProcessIpc, noteMainProcessRegistersIpcBelow };
