# E2E-тесты (Playwright + Electron)

Запуск:

```bash
npm run test:e2e
```

Smoke (same as CI):

```bash
npm run test:e2e:smoke
```

Выборочно:

```bash
npx playwright test tests/e2e/user-agent.e2e.spec.js
npx playwright test tests/e2e/windows.e2e.spec.js
npx playwright test tests/e2e/intercept.e2e.spec.js
npx playwright test tests/e2e/traffic-proxy.e2e.spec.js
npx playwright test tests/e2e/cookie-manager.e2e.spec.js
npx playwright test tests/e2e/proxy-profiles.e2e.spec.js
npx playwright test tests/e2e/har-export.e2e.spec.js
npx playwright test tests/e2e/credentials.e2e.spec.js
npx playwright test tests/e2e/settings.e2e.spec.js
npx playwright test tests/e2e/dns-overrides.e2e.spec.js
npx playwright test tests/e2e/notes.e2e.spec.js
npx playwright test tests/e2e/fts-search.e2e.spec.js
npx playwright test tests/e2e/trace-mode.e2e.spec.js
npx playwright test tests/e2e/request-editor.e2e.spec.js
npx playwright test tests/e2e/onboarding.e2e.spec.js
npx playwright test tests/e2e/p2-features.e2e.spec.js
```

Требования: интернет (запросы к `httpbin.org`, `ipinfo.io` для geo/direct-ip), установленные зависимости (`npm ci`).

Поведение:

- Поднимается отдельный экземпляр CupNet с временным `--user-data-dir` и **`CUPNET_E2E=1`**.
- В этом режиме при выходе **не показываются** модалки подтверждения закрытия (см. `confirmExitDialog` в `main-process/services/main-window.js`).
- В `main-process/index.js` при `CUPNET_E2E=1` **отключён** глобальный single-instance lock, чтобы повторные запуски Playwright (retry) не получали мгновенный `app.quit()`.

Обычный `npm test` (`tests/run-all.sh`) — только unit/integration без GUI.
