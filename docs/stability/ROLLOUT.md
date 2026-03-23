# Stability Rollout

## Feature Flags

- `CUPNET_FF_PROXY_BREAKER`
- `CUPNET_FF_PROXY_HEALTH_WEIGHTED`
- `CUPNET_FF_DB_TRACE_QUEUE`

## План выката

1. **Stage 1 (10%)**
   - Включить breaker + health weighting.
   - Мониторить `proxy.connect_failed`, `proxy.circuit_opened`, `worker.overloaded`.
2. **Stage 2 (50%)**
   - Включить DB trace queue.
   - Следить за `dbTraceQueueDepth`, p95 latency.
3. **Stage 3 (100%)**
   - Оставить SLO alerts включенными.
   - Валидировать отсутствие роста error budget.

## Auto rollback guardrails

Откатить флаги, если:

- p95 > порога более 15 минут,
- частота `worker.exited` превышает порог,
- растет `proxy.connect_failed` без восстановления.
