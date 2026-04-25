'use strict';

/**
 * External automated captcha solving is not part of CupNet.
 * Kept for stable IPC error shapes and CaptchaSolverError usage in the main process.
 */
class CaptchaSolverError extends Error {
    constructor(code, message, meta) {
        super(message);
        this.name = 'CaptchaSolverError';
        this.code = code;
        this.meta = meta;
    }
}

async function solveTurnstileWithCapMonster() {
    throw new CaptchaSolverError('DISABLED', 'Automated Turnstile solving is not available.');
}

module.exports = { CaptchaSolverError, solveTurnstileWithCapMonster };
