# E2E-тесты (Playwright + Electron)

Запуск:

```bash
npm run test:e2e
```

Выборочно:

```bash
npx playwright test tests/e2e/user-agent.e2e.spec.js   # исходящий UA после MITM (Chrome-like)
npm run test:e2e:windows    # вспомогательные окна
npm run test:e2e:intercept # block / mock / modifyHeaders
npm run test:e2e:traffic   # MITM, connect-direct, check-ip-geo, sys log
```

Требования: интернет (запросы к `httpbin.org`, `ipinfo.io` для geo/direct-ip), установленные зависимости (`npm ci`).

Поведение:

- Поднимается отдельный экземпляр CupNet с временным `--user-data-dir` и **`CUPNET_E2E=1`**.
- В этом режиме при выходе **не показываются** модалки подтверждения закрытия (см. `confirmExitDialog` в `main-process/services/main-window.js`).
- В `main-process/index.js` при `CUPNET_E2E=1` **отключён** глобальный single-instance lock, чтобы повторные запуски Playwright (retry) не получали мгновенный `app.quit()`.

Обычный `npm test` (`tests/run-all.sh`) — только unit/integration без GUI.
