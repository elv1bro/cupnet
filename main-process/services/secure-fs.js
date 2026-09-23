'use strict';

const fs = require('fs');
const path = require('path');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function chmodQuiet(target, mode) {
    try {
        fs.chmodSync(target, mode);
    } catch {
        /* ignore on platforms that disallow chmod */
    }
}

function ensureSecureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    chmodQuiet(dirPath, DIR_MODE);
    return dirPath;
}

function _tmpPath(filePath) {
    return `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Atomic secure write: write to a sibling temp file, fsync, then rename over the target.
 * A crash/power loss mid-write leaves the previous file intact instead of a truncated/corrupt one.
 */
function writeFileSecure(filePath, data, encoding = 'utf8') {
    const dir = path.dirname(filePath);
    ensureSecureDir(dir);
    const tmp = _tmpPath(filePath);
    let fd;
    try {
        fd = fs.openSync(tmp, 'w', FILE_MODE);
        fs.writeFileSync(fd, data, encoding);
        try { fs.fsyncSync(fd); } catch { /* fsync unsupported */ }
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, filePath);
        chmodQuiet(filePath, FILE_MODE);
    } catch (e) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
    }
}

function writeFileSecureAsync(filePath, data, encoding = 'utf8') {
    return new Promise((resolve, reject) => {
        let tmp;
        try {
            const dir = path.dirname(filePath);
            ensureSecureDir(dir);
            tmp = _tmpPath(filePath);
        } catch (e) {
            reject(e);
            return;
        }
        const cleanupAndReject = (err) => {
            fs.unlink(tmp, () => reject(err));
        };
        fs.open(tmp, 'w', FILE_MODE, (openErr, fd) => {
            if (openErr) { reject(openErr); return; }
            fs.writeFile(fd, data, encoding, (writeErr) => {
                if (writeErr) {
                    fs.close(fd, () => cleanupAndReject(writeErr));
                    return;
                }
                fs.fsync(fd, () => {
                    fs.close(fd, (closeErr) => {
                        if (closeErr) { cleanupAndReject(closeErr); return; }
                        fs.rename(tmp, filePath, (renameErr) => {
                            if (renameErr) { cleanupAndReject(renameErr); return; }
                            chmodQuiet(filePath, FILE_MODE);
                            resolve();
                        });
                    });
                });
            });
        });
    });
}

function hardenExistingFile(filePath) {
    try {
        if (fs.existsSync(filePath)) chmodQuiet(filePath, FILE_MODE);
    } catch { /* ignore */ }
}

function hardenExistingDir(dirPath) {
    try {
        if (fs.existsSync(dirPath)) chmodQuiet(dirPath, DIR_MODE);
    } catch { /* ignore */ }
}

module.exports = {
    FILE_MODE,
    DIR_MODE,
    ensureSecureDir,
    writeFileSecure,
    writeFileSecureAsync,
    hardenExistingFile,
    hardenExistingDir,
};
