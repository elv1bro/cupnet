# Main-process services

Вынесенная логика из `main-process/index.js` (strangler). Зависимости передаются через `require` и фабрики/геттеры.

## Уже вынесено

| Модуль | Назначение |
|--------|------------|
| `settings-store.js` | `settings.json`, CapMonster M7, кэш, sync `effectiveTrafficMode`; `cancelPendingSave()` на выходе |
| `ui-prefs-store.js` | `ui-prefs.json` |
| `ext-ports-store.js` | `ext-ports.json` (путь через `app.getPath('userData')`) |
| `console-capture.js` | `installConsoleCapture(getViewerWindow)` → перехват stdout/stderr; `dispose()` на выходе |
| `ipc-batch-messenger.js` | `createIpcBatchMessenger(…)` — батчи логов / intercept / DNS / TLS broadcast; `disposePendingBatches()` на `will-quit` |
| `network-helpers.js` | `getLocalIp`, `generatePassword`, `sanitizeProxyUrl` (+ `_lastMasked`), `withTimeout` |
| `proxy-notify-broadcast.js` | `createProxyNotifyBroadcast({…})` → `notifyProxyStatus`, `notifyMitmReady`, `notifyProxyProfilesList` |
| `cdp-network-logging.js` | `createCdpNetworkLogging({…})` → `setupNetworkLogging` + CDP WeakSet’ы, `handleRuleActions` (внутри модуля) |
| `fingerprint-service.js` | `createFingerprintService({ sysLog, safeCatch, getTabManager })` → apply/reset fingerprint на вкладках |
| `screenshot-service.js` | `createScreenshotService({…})` → `captureScreenshot` / `requestScreenshot` (внутренний dedup + rate limit) |
| `page-analyzer-injected-scripts.js` | Строки `executeJavaScript` для форм / captcha / meta / endpoints (вынесено из `cupnet-runtime.js`) |
| `traffic-mode-service.js` | `createTrafficModeService(deps)` — режим трафика, bypass, TLS passthrough |
| `proxy-service.js` | `createProxyMitmService(deps)` — старт MITM, ProxyChain, failover, IP/geo |
| `main-window.js` | `createMainWindowApi(d)` — главное окно, меню, иконка Dock, диалог выхода |
| `sub-windows.js` | `createSubWindowsApi(d)` — вторичные окна, compare, IVAC, cookie/DNS/modal |

## Оптимальный порядок дальнейшего выноса

1. ~~Сервисы выше~~ — по плану Phase 0 persistence/CDP/screenshot/fingerprint сделаны.
2. ~~**IPC**~~ — `handlers/*.js` + `register-main-ipc.js`; контекст: `ipc-scope-key-list.json` + **явные** `ipcScopeGet`/`ipcScopeSet` в `cupnet-runtime.js` (см. `ipc/README.md`).
3. ~~**Окна + proxy/traffic**~~ — `main-window.js`, `sub-windows.js`, `proxy-service.js`, `traffic-mode-service.js`; wiring в `cupnet-runtime.js` (`dSub`, `notifyTabsDebounce`, …).

Дальше (опционально): полностью заменить `let` в runtime на работу только через `createAppContext()`, сузить `cupnet-runtime.js` до чистого lifecycle. Сейчас добавлена live-синхронизация snapshot `appCtx` из runtime-состояния (модули/окна/proxy/logging/mitm/metrics), чтобы убрать «одноразовый» контекст.

После каждого крупного шага: `bash tests/run-all.sh`, ручной smoke (`npm start`).
