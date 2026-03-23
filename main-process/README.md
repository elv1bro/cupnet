# Main process (Electron)

## Точки входа

| Файл | Роль |
|------|------|
| **`index.js`** | Single-instance lock, глобальные `unhandledRejection` / `uncaughtException`, вызов **`attachMainProcess()`**. |
| **`cupnet-runtime.js`** | Оркестрация: command-line, `dSub` (общие ссылки на окна/сессию), вызов **`traffic-mode-service`**, **`proxy-service`**, **`sub-windows`**, **`main-window`**, IPC, `app.whenReady` / quit. |

Окна / proxy / traffic / MITM startup вынесены в `services/traffic-mode-service.js`, `services/proxy-service.js`, `services/sub-windows.js`, `services/main-window.js`; в `cupnet-runtime.js` остаётся wiring и IPC-scope.

## Связанные каталоги

- `services/` — вынесенные сервисы (settings, CDP, скриншоты, …).
- `ipc/handlers/` — IPC по доменам; см. `ipc/README.md`.
