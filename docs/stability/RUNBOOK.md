# Stability Runbook

## Симптом: `worker.overloaded`

1. Проверить `stability-metrics-snapshot` (`queueDepth`, `workerOverloaded`).
2. Снизить нагрузку:
   - уменьшить `CUPNET_WORKER_MAX_PENDING`,
   - временно снизить входящий поток/параллелизм.
3. Проверить состояние прокси через `proxy-resilience-state`.

## Симптом: частые `proxy.circuit_opened`/`proxy.quarantined`

1. Проверить качество пула прокси (валидность, гео, лимиты провайдера).
2. Увеличить fallback-кандидаты (`FALLBACK_PROXIES` в шаблоне профиля).
3. При массовом деграде перевести систему в direct fallback.

## Симптом: рост p95 latency

1. Проверить `stability-slo-status` и worker queue depth.
2. Проверить upstream и TLS handshake ошибки.
3. Снизить retry budget (`CUPNET_RETRY_BUDGET_MS`) и max retries.

## Safe Mode

- Отключить weighted rotation: `CUPNET_FF_PROXY_HEALTH_WEIGHTED=false`
- При необходимости отключить breaker: `CUPNET_FF_PROXY_BREAKER=false`
- Переключиться в direct mode на время инцидента.
