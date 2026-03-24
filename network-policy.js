'use strict';

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function envBool(name, fallback = false) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const v = String(raw).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const _breakerCooldownMs = envInt('CUPNET_BREAKER_COOLDOWN_MS', 45000);

const networkPolicy = {
    timeouts: {
        workerRequestMs: envInt('CUPNET_TIMEOUT_WORKER_REQUEST_MS', 30000),
        clearSessionsMs: envInt('CUPNET_TIMEOUT_CLEAR_SESSIONS_MS', 10000),
        proxyOperationMs: envInt('CUPNET_TIMEOUT_PROXY_OP_MS', 15000),
        tlsHandshakeMs: envInt('CUPNET_TIMEOUT_TLS_HANDSHAKE_MS', 15000),
        upstreamRequestMs: envInt('CUPNET_TIMEOUT_UPSTREAM_REQUEST_MS', 30000),
        ipGeoMs: envInt('CUPNET_TIMEOUT_IP_GEO_MS', 8000),
        replayMs: envInt('CUPNET_TIMEOUT_REPLAY_MS', 30000),
        requestEditorMs: envInt('CUPNET_TIMEOUT_REQUEST_EDITOR_MS', 30000),
        passThroughMs: envInt('CUPNET_TIMEOUT_PASS_THROUGH_MS', 30000),
        captchaRequestMs: envInt('CUPNET_TIMEOUT_CAPTCHA_MS', 15000),
        captchaPollMs: envInt('CUPNET_TIMEOUT_CAPTCHA_POLL_MS', 90000),
        captchaPollIntervalMs: envInt('CUPNET_TIMEOUT_CAPTCHA_POLL_INTERVAL_MS', 3000),
        proxyTestMs: envInt('CUPNET_TIMEOUT_PROXY_TEST_MS', 15000),
    },
    retry: {
        maxRetries: envInt('CUPNET_RETRY_MAX', 2, 0, 10),
        baseDelayMs: envInt('CUPNET_RETRY_BASE_MS', 250),
        maxDelayMs: envInt('CUPNET_RETRY_MAX_DELAY_MS', 5000),
        budgetMs: envInt('CUPNET_RETRY_BUDGET_MS', 15000),
    },
    concurrency: {
        workerMaxPending: envInt('CUPNET_WORKER_MAX_PENDING', 1000),
        workerMaxInflight: envInt('CUPNET_WORKER_MAX_INFLIGHT', 200),
        workerStdinQueueMax: envInt('CUPNET_WORKER_STDIN_QUEUE_MAX', 2000),
        workerClientCacheMax: envInt('CUPNET_WORKER_CLIENT_CACHE_MAX', 20),
        /** Параллельных FFI-запросов на пару (browser, proxy) в azure-tls-worker. 1 = старый режим «всё по очереди». */
        workerFfiConcurrency: envInt('CUPNET_WORKER_FFI_CONCURRENCY', 4, 1, 32),
    },
    breaker: {
        enabled: envBool('CUPNET_BREAKER_ENABLED', true),
        minSamples: envInt('CUPNET_BREAKER_MIN_SAMPLES', 6),
        consecutiveFailuresToOpen: envInt('CUPNET_BREAKER_CONSEC_FAILS', 3),
        errorRateToOpenPct: envInt('CUPNET_BREAKER_ERROR_RATE_PCT', 60, 1, 100),
        cooldownMs: _breakerCooldownMs,
        // Must not exceed cooldownMs or half-open recovery is ineffective (L1)
        quarantineMs: Math.min(envInt('CUPNET_PROXY_QUARANTINE_MS', 120000), _breakerCooldownMs),
        ewmaAlphaPct: envInt('CUPNET_PROXY_EWMA_ALPHA_PCT', 30, 1, 100),
    },
    mitmPort: envInt('CUPNET_MITM_PORT', 8877, 1024, 65535),
    /** Локальный MITM: если клиент шлёт Basic — username=tabId (или _cupnet_global), пароль=password; без заголовка CONNECT всё равно принимаем. */
    mitmClientProxyAuth: {
        globalUsername: '_cupnet_global',
        password:       'cupnet',
    },
    db: {
        busyRetries: envInt('CUPNET_DB_BUSY_RETRIES', 3, 0, 10),
        busyBaseDelayMs: envInt('CUPNET_DB_BUSY_BASE_DELAY_MS', 15, 1, 500),
        busyMaxDelayMs: envInt('CUPNET_DB_BUSY_MAX_DELAY_MS', 120, 1, 2000),
        writeQueueMaxHigh: envInt('CUPNET_DB_WRITE_QUEUE_MAX_HIGH', 20000, 100, 200000),
        writeQueueMaxLow: envInt('CUPNET_DB_WRITE_QUEUE_MAX_LOW', 5000, 100, 50000),
        traceQueueMax: envInt('CUPNET_DB_TRACE_QUEUE_MAX', 5000, 1, 50000),
    },
    slo: {
        enabled: envBool('CUPNET_SLO_ALERTS_ENABLED', true),
        p95LatencyMsWarn: envInt('CUPNET_SLO_P95_WARN_MS', 2000),
        queueDepthWarn: envInt('CUPNET_SLO_QUEUE_DEPTH_WARN', 800),
        workerRestartsWarnPerHour: envInt('CUPNET_SLO_WORKER_RESTARTS_WARN', 6),
    },
    featureFlags: {
        proxyBreaker: envBool('CUPNET_FF_PROXY_BREAKER', true),
        proxyHealthWeighted: envBool('CUPNET_FF_PROXY_HEALTH_WEIGHTED', true),
        dbTraceQueue: envBool('CUPNET_FF_DB_TRACE_QUEUE', true),
    },
};

function retryableStatus(statusCode) {
    return statusCode === 408 || statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

function computeBackoffMs(attempt) {
    const n = Math.max(0, Number(attempt) || 0);
    const expo = Math.min(networkPolicy.retry.maxDelayMs, networkPolicy.retry.baseDelayMs * (2 ** n));
    return Math.max(networkPolicy.retry.baseDelayMs, Math.floor(Math.random() * expo));
}

module.exports = {
    networkPolicy,
    retryableStatus,
    computeBackoffMs,
};
