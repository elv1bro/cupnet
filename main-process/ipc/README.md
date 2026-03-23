# Main-process IPC

## Структура

| Файл | Роль |
|------|------|
| **`register-main-ipc.js`** | Оркестратор: подключает все `handlers/*` **в фиксированном порядке** (как в прежнем монолите). |
| **`register-all.js`** | Точка для `index.js`: `registerAllMainIpc(ctx)`. |
| **`handlers/*.js`** | Один домен ≈ один модуль, экспорт `register…Ipc(ctx)`. |
| **`ipc-scope-key-list.json`** | Список полей `ctx`; в **`cupnet-runtime.js`** (внутри `app.whenReady`) — `ipcScopeGet` / `ipcScopeSet` + **`build-ipc-scope-delegates.js`** (без `eval`). |
| **`build-ipc-scope-delegates.js`** | Сборка объекта `ipcScope` из явных get/set. |
| **`_ipc-scope-accessors.inc.js`** | Сгенерированные switch для get/set; регенерация: `node scripts/gen-ipc-scope-accessors.cjs > main-process/ipc/_ipc-scope-accessors.inc.js` |

## Модули `handlers/`

| Файл | Домен |
|------|--------|
| `mitm-startup-ipc.js` | `mitm-ready-state`, метрики первого кадра / long tasks |
| `tracking-ipc.js` | `report-mouse-*`, `report-tab-*` |
| `tabs-ipc.js` | вкладки, навигация |
| `db-logging-ipc.js` | запросы в БД, сессии, старт/стоп логирования |
| `trace-har-ipc.js` | HAR, bundle, diff, replay |
| `rules-ipc.js` | highlight + intercept rules |
| `launcher-ipc.js` | открытие proxy manager, console, page analyzer, IVAC |
| `page-analyzer-ipc.js` | анализ страницы, CapMonster, Turnstile |
| `misc-ipc.js` | uptime, splash, version, ui-pref, geo / direct IP |
| `proxy-ipc.js` | текущий прокси, connect/disconnect, профили |
| `screenshots-ipc.js` | скриншоты |
| `trace-viewer-ipc.js` | trace mode, homepage |
| `cookies-dns-ipc.js` | cookies, DNS, isolate/direct, DevTools |
| `log-compare-execute-ipc.js` | log viewer, compare, JSONL, rules mock, request editor, `execute-request` |
| `settings-toolbar-ipc.js` | агрегированные настройки toolbar, bypass, traffic |
| `diagnostics-ipc.js` | `get-app-metrics` |
| `quick-connect-ipc.js` | `quick-connect-profile` |
| `mitm-tls-resilience-ipc.js` | MITM stats, TLS, stability, `connect-direct` |
| `ext-proxy-ipc.js` | `ext-proxy:*` |

## Новые IPC или новые поля `ctx`

1. Добавить хэндлер(ы) в подходящий файл в `handlers/` (или новый файл + `require` в `register-main-ipc.js` **в нужном месте порядка**).
2. Дополнить **`ipc-scope-key-list.json`** и при необходимости **`ipcScopeWritableKeys`** в **`main-process/cupnet-runtime.js`** (рядом с регистрацией IPC), затем перегенерировать **`_ipc-scope-accessors.inc.js`** скриптом выше и вставить в `cupnet-runtime.js` перед `buildIpcScopeObject`.

## Устаревшее

- `scripts/gen-register-main-ipc.cjs` рассчитан на **монолитный** слайс из `index.js` и **не** поддерживает текущую схему с `handlers/`. Правки вносить **напрямую в `handlers/*.js`**.
