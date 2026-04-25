'use strict';

/**
 * Structured stdout/stderr capture for System Console.
 * Entries: { text, ts, level, source, module, stream, pid? }
 */

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];

/** @typedef {'mitm'|'system'|'worker'|'ffi'|'dns'|'main'|'app'} ConsoleSource */

/**
 * Infer log level from line text and stream.
 * @param {string} line
 * @param {'stdout'|'stderr'} stream
 */
function inferLevel(line, stream) {
    const s = String(line);
    const lower = s.toLowerCase();
    if (stream === 'stderr') {
        if (/\berror\b|exception|fatal|\bfail(ed)?\b|econnrefused|enoent/.test(lower)) return 'error';
        if (/\bwarn(ing)?\b/.test(lower)) return 'warn';
    }
    if (/\bERROR\b|\[error\]|Error:|Exception:/.test(s)) return 'error';
    if (/\bWARN(ING)?\b|\[warn\]/.test(s)) return 'warn';
    if (/\bDEBUG\b|\[debug\]/.test(s)) return 'debug';
    if (/\bTRACE\b|\[trace\]/.test(s)) return 'trace';
    return 'info';
}

/**
 * Classify source / module from log line prefix patterns.
 * @param {string} line
 * @returns {{ source: ConsoleSource, module: string|null }}
 */
function inferSourceModule(line) {
    const s = String(line);
    if (s.startsWith('[mitm]')) {
        const rest = s.slice(6).trimStart();
        if (/^dns\b|^\[dns\]/i.test(rest) || s.includes('DNS overrides')) {
            return { source: 'dns', module: null };
        }
        return { source: 'mitm', module: null };
    }
    if (s.startsWith('[mitm-proxy]')) return { source: 'mitm', module: 'proxy' };
    if (s.startsWith('[mitm-cors]')) return { source: 'mitm', module: 'cors' };
    if (s.startsWith('[ext-proxy]')) return { source: 'mitm', module: 'ext-proxy' };
    if (s.includes('[ffi-dbg]')) return { source: 'ffi', module: null };
    if (s.includes('[worker-dbg]')) return { source: 'worker', module: null };
    if (s.startsWith('[main]')) return { source: 'main', module: null };
    if (s.startsWith('[cupnet]')) return { source: 'app', module: 'cupnet' };
    return { source: 'system', module: null };
}

/**
 * Build a structured console entry from a raw line (used by stdout/stderr and tests).
 * @param {string} line
 * @param {'stdout'|'stderr'} stream
 * @param {number} [ts]
 */
function buildConsoleEntryFromLine(line, stream, ts) {
    const text = String(line);
    const { source, module } = inferSourceModule(text);
    let level = inferLevel(text, stream);
    if (source === 'mitm' && level === 'info' && /CUPNET_DEBUG_MITM/.test(text)) level = 'debug';
    return {
        text,
        ts: typeof ts === 'number' ? ts : Date.now(),
        level,
        source,
        module,
        stream,
        pid: typeof process !== 'undefined' ? process.pid : undefined,
    };
}

/**
 * @param {object} getViewerWindow
 * @param {object} [options]
 * @param {number} [options.bufferMax]
 * @param {() => number|null|undefined} [options.getSessionId]
 * @param {(rows: object[]) => void} [options.onPersistBatch]
 * @param {number} [options.persistIntervalMs]
 */
function installConsoleCapture(getViewerWindow, options = {}) {
    const bufferMax = options.bufferMax ?? 10000;
    const persistIntervalMs = options.persistIntervalMs ?? 500;
    const getSessionId = typeof options.getSessionId === 'function' ? options.getSessionId : () => null;
    const onPersistBatch = typeof options.onPersistBatch === 'function' ? options.onPersistBatch : null;

    const buffer = [];
    let batchTimer = null;
    let batch = [];
    let persistTimer = null;
    /** @type {object[]} */
    let persistQueue = [];

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

    function schedulePersist() {
        if (!onPersistBatch || !persistQueue.length) return;
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            const rows = persistQueue;
            persistQueue = [];
            try {
                onPersistBatch(rows);
            } catch { /* ignore */ }
        }, persistIntervalMs);
    }

    function enqueuePersist(entry) {
        if (!onPersistBatch) return;
        const sid = getSessionId();
        persistQueue.push({
            sessionId: sid != null && Number.isFinite(Number(sid)) ? Number(sid) : null,
            ts: entry.ts,
            level: entry.level,
            source: entry.source,
            module: entry.module,
            stream: entry.stream,
            text: entry.text,
        });
        schedulePersist();
    }

    function captureLine(text, stream) {
        const clean = String(text).replace(/\n+$/, '');
        if (!clean) return;
        const lines = clean.split('\n');
        for (const line of lines) {
            if (!line) continue;
            const entry = buildConsoleEntryFromLine(line, stream);
            buffer.push(entry);
            if (buffer.length > bufferMax) {
                buffer.splice(0, Math.floor(bufferMax * 0.2));
            }
            batch.push(entry);
            enqueuePersist(entry);
        }
        if (!batchTimer) {
            batchTimer = setTimeout(flushBatch, 60);
        }
    }

    let _lineId = 0;
    function pushManualEntry(partial) {
        const entry = {
            text: String(partial.text ?? ''),
            ts: typeof partial.ts === 'number' ? partial.ts : Date.now(),
            level: LOG_LEVELS.includes(partial.level) ? partial.level : 'info',
            source: partial.source || 'app',
            module: partial.module != null ? String(partial.module) : null,
            stream: partial.stream === 'stderr' ? 'stderr' : 'stdout',
            pid: process.pid,
            id: ++_lineId,
        };
        if (!entry.text) return;
        buffer.push(entry);
        if (buffer.length > bufferMax) {
            buffer.splice(0, Math.floor(bufferMax * 0.2));
        }
        batch.push(entry);
        enqueuePersist(entry);
        if (!batchTimer) {
            batchTimer = setTimeout(flushBatch, 60);
        }
    }

    /**
     * Structured log from main-process modules (preferred over raw write).
     * @param {'error'|'warn'|'info'|'debug'|'trace'} level
     * @param {string} [module]
     * @param {string} message
     * @param {unknown} [meta]
     */
    function cupnetLog(level, module, message, meta) {
        let text = String(message ?? '');
        if (meta !== undefined) {
            try {
                text += typeof meta === 'string' ? meta : ` ${JSON.stringify(meta)}`;
            } catch {
                text += ' [meta]';
            }
        }
        const prefix = module ? `[cupnet][${module}] ` : '[cupnet] ';
        pushManualEntry({
            text: prefix + text,
            level: LOG_LEVELS.includes(level) ? level : 'info',
            source: 'app',
            module: module || 'cupnet',
            stream: level === 'error' || level === 'warn' ? 'stderr' : 'stdout',
        });
        // Do not write to origOut/origErr here — patched stdout would capture again and duplicate.
    }

    process.stdout.write = function (chunk, encoding, callback) {
        captureLine(typeof chunk === 'string' ? chunk : chunk.toString(), 'stdout');
        return origOut(chunk, encoding, callback);
    };
    process.stderr.write = function (chunk, encoding, callback) {
        captureLine(typeof chunk === 'string' ? chunk : chunk.toString(), 'stderr');
        return origErr(chunk, encoding, callback);
    };

    return {
        getConsoleBufferSnapshot: () => buffer.map((e) => ({ ...e })),
        cupnetLog,
        pushManualEntry,
        buildConsoleEntryFromLine,
        flushPersistQueue() {
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            if (onPersistBatch && persistQueue.length) {
                const rows = persistQueue;
                persistQueue = [];
                try {
                    onPersistBatch(rows);
                } catch { /* ignore */ }
            }
        },
        dispose() {
            if (batchTimer) {
                clearTimeout(batchTimer);
                batchTimer = null;
            }
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            persistQueue = [];
            batch = [];
            process.stdout.write = origOut;
            process.stderr.write = origErr;
        },
    };
}

module.exports = {
    installConsoleCapture,
    buildConsoleEntryFromLine,
    inferLevel,
    inferSourceModule,
    LOG_LEVELS,
};
