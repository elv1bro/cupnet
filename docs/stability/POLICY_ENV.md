# Stability Policy Env

Файл описывает ключевые env-параметры из `network-policy.js` для dev/staging/prod.

## Baseline

Снимок baseline политики и окружения:

```bash
npm run baseline:stability
```

Выход сохраняется в `_debug/stability-baseline.json`.

## Рекомендуемые значения

### Dev

- `CUPNET_BREAKER_ENABLED=true`
- `CUPNET_FF_PROXY_BREAKER=true`
- `CUPNET_FF_PROXY_HEALTH_WEIGHTED=true`
- `CUPNET_TIMEOUT_UPSTREAM_REQUEST_MS=30000`
- `CUPNET_WORKER_MAX_PENDING=1000`

### Staging

- `CUPNET_BREAKER_ENABLED=true`
- `CUPNET_BREAKER_COOLDOWN_MS=45000`
- `CUPNET_PROXY_QUARANTINE_MS=120000`
- `CUPNET_SLO_ALERTS_ENABLED=true`
- `CUPNET_SLO_P95_WARN_MS=2000`

### Prod

- `CUPNET_BREAKER_ENABLED=true`
- `CUPNET_FF_PROXY_BREAKER=true`
- `CUPNET_FF_PROXY_HEALTH_WEIGHTED=true`
- `CUPNET_DB_BUSY_RETRIES=3`
- `CUPNET_SLO_ALERTS_ENABLED=true`

## Проверка runtime

Через IPC:

- `stability-metrics-snapshot`
- `stability-slo-status`
- `proxy-resilience-state`
