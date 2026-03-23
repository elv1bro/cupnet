'use strict';
/**
 * Перехват stdout/stderr → окно console viewer (батч по таймеру).
 */
function installConsoleCapture(getViewerWindow, options = {}) {
    const bufferMax = options.bufferMax ?? 3000;
    const buffer = [];
    let batchTimer = null;
    let batch = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);

    function flushBatch() {
        batchTimer = null;
        if (!batch.length) return;
        const toSend = batch;
        batch = [];
        const win = typeof getViewerWindow === 'function' ? getViewerWindow() : null;
        if (win && !win.isDestroyed()) {
            try {
                win.webContents.send('console-log', toSend);
            } catch { /* ignore */ }
        }
    }

    function captureLine(text) {
        const clean = String(text).replace(/\n+$/, '');
        if (!clean) return;
        const lines = clean.split('\n');
        for (const line of lines) {
            if (!line) continue;
            const entry = { text: line, ts: Date.now() };
            buffer.push(entry);
            if (buffer.length > bufferMax) {
                buffer.splice(0, 1000);
            }
            batch.push(entry);
        }
        if (!batchTimer) {
            batchTimer = setTimeout(flushBatch, 60);
        }
    }

    process.stdout.write = function (chunk, encoding, callback) {
        captureLine(typeof chunk === 'string' ? chunk : chunk.toString());
        return origOut(chunk, encoding, callback);
    };
    process.stderr.write = function (chunk, encoding, callback) {
        captureLine(typeof chunk === 'string' ? chunk : chunk.toString());
        return origErr(chunk, encoding, callback);
    };

    return {
        getConsoleBufferSnapshot: () => buffer.slice(),
        dispose() {
            if (batchTimer) {
                clearTimeout(batchTimer);
                batchTimer = null;
            }
            batch = [];
            process.stdout.write = origOut;
            process.stderr.write = origErr;
        },
    };
}

module.exports = { installConsoleCapture };
