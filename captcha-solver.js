'use strict';

const https = require('https');
const { networkPolicy } = require('./network-policy');

const CAPMONSTER_BASE = 'https://api.capmonster.cloud';

class CaptchaSolverError extends Error {
    constructor(code, message, details = {}) {
        super(message || code || 'Captcha solver error');
        this.name = 'CaptchaSolverError';
        this.code = code || 'SOLVER_ERROR';
        this.details = details || {};
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function _postJson(pathname, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload || {});
        const req = https.request(
            CAPMONSTER_BASE + pathname,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: networkPolicy.timeouts.captchaRequestMs,
            },
            res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try { json = text ? JSON.parse(text) : {}; } catch {
                        reject(new CaptchaSolverError('CAPMONSTER_BAD_JSON', 'CapMonster returned invalid JSON.'));
                        return;
                    }
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new CaptchaSolverError('CAPMONSTER_HTTP_ERROR', `CapMonster HTTP ${res.statusCode}.`, { statusCode: res.statusCode, response: json }));
                        return;
                    }
                    resolve(json);
                });
            }
        );
        req.on('timeout', () => req.destroy(new CaptchaSolverError('CAPMONSTER_TIMEOUT', 'CapMonster request timeout.')));
        req.on('error', err => reject(new CaptchaSolverError('CAPMONSTER_NETWORK_ERROR', err?.message || 'Network error.')));
        req.write(body);
        req.end();
    });
}

function normalizeCapMonsterError(errorCode, errorDescription) {
    const code = String(errorCode || '').trim();
    const desc = String(errorDescription || '').trim() || code || 'Unknown CapMonster error';
    if (!code) return null;

    if (code === 'ERROR_KEY_DOES_NOT_EXIST' || code === 'ERROR_KEY_INVALID') {
        return new CaptchaSolverError('INVALID_API_KEY', 'Invalid CapMonster API key.', { providerCode: code, providerDescription: desc });
    }
    if (code === 'ERROR_ZERO_BALANCE') {
        return new CaptchaSolverError('INSUFFICIENT_BALANCE', 'CapMonster balance is empty.', { providerCode: code, providerDescription: desc });
    }
    if (code === 'ERROR_TASK_NOT_SUPPORTED' || code === 'ERROR_TASK_ABSENT') {
        return new CaptchaSolverError('TASK_NOT_SUPPORTED', 'Turnstile task is not supported by provider.', { providerCode: code, providerDescription: desc });
    }
    if (code === 'ERROR_PROXY_CONNECTION_FAILED' || code === 'ERROR_PROXY_CONNECT_TIMEOUT') {
        return new CaptchaSolverError('PROXY_ERROR', 'Provider proxy error while solving challenge.', { providerCode: code, providerDescription: desc });
    }
    return new CaptchaSolverError('CAPMONSTER_ERROR', desc, { providerCode: code, providerDescription: desc });
}

async function solveTurnstileWithCapMonster({
    apiKey,
    pageUrl,
    sitekey,
    action = '',
    cData = '',
    userAgent = '',
    timeoutMs = networkPolicy.timeouts.captchaPollMs,
    pollIntervalMs = networkPolicy.timeouts.captchaPollIntervalMs,
}) {
    if (!apiKey || !String(apiKey).trim()) {
        throw new CaptchaSolverError('MISSING_API_KEY', 'CapMonster API key is required.');
    }
    if (!pageUrl || !String(pageUrl).trim()) {
        throw new CaptchaSolverError('MISSING_PAGE_URL', 'pageUrl is required for Turnstile solving.');
    }
    if (!sitekey || !String(sitekey).trim()) {
        throw new CaptchaSolverError('MISSING_SITEKEY', 'sitekey is required for Turnstile solving.');
    }

    const createResp = await _postJson('/createTask', {
        clientKey: String(apiKey).trim(),
        task: {
            type: 'TurnstileTaskProxyless',
            websiteURL: String(pageUrl),
            websiteKey: String(sitekey),
            action: String(action || ''),
            data: String(cData || ''),
            userAgent: String(userAgent || ''),
        },
    });
    const createErr = normalizeCapMonsterError(createResp.errorCode, createResp.errorDescription);
    if (createErr) throw createErr;
    if (!createResp.taskId) {
        throw new CaptchaSolverError('CAPMONSTER_NO_TASK_ID', 'CapMonster did not return taskId.', { response: createResp });
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        await sleep(pollIntervalMs);
        const pollResp = await _postJson('/getTaskResult', {
            clientKey: String(apiKey).trim(),
            taskId: createResp.taskId,
        });
        const pollErr = normalizeCapMonsterError(pollResp.errorCode, pollResp.errorDescription);
        if (pollErr) throw pollErr;

        if (pollResp.status === 'processing') continue;
        if (pollResp.status !== 'ready') {
            throw new CaptchaSolverError('CAPMONSTER_BAD_STATUS', `Unexpected task status: ${pollResp.status || 'unknown'}.`, { response: pollResp });
        }
        const token = pollResp?.solution?.token;
        if (!token) {
            throw new CaptchaSolverError('CAPMONSTER_NO_TOKEN', 'CapMonster returned ready status without token.', { response: pollResp });
        }
        return {
            taskId: createResp.taskId,
            token,
            cost: pollResp.cost || null,
            solveCount: pollResp.solveCount || null,
            createdAt: pollResp.createTime || null,
            endedAt: pollResp.endTime || null,
        };
    }

    throw new CaptchaSolverError('CAPMONSTER_POLL_TIMEOUT', 'Timed out waiting for Turnstile solution.', { timeoutMs });
}

module.exports = {
    CaptchaSolverError,
    solveTurnstileWithCapMonster,
};
