# CupNet: Product & UX Analysis

> Анализ на основе кода, структуры, README и ROADMAP. Только `node/cupnet2/`.

---

## 1. Что это за продукт на самом деле

**CupNet** — Electron-браузер, который объединяет:

- **MITM-прокси** (порт 8877) — весь трафик идёт через локальный прокси, TLS-терминация, подмена сертификатов (node-forge)
- **TLS fingerprint spoofing** — через AzureTLS (Go FFI): JA3, HTTP/2, имитация Chrome/Firefox/Safari/iOS/Edge/Opera
- **Network inspector** — логирование в SQLite, FTS5-поиск по URL и body, виртуальный скролл (сотни тысяч записей)
- **Rules Engine** — условия (url, method, status, regex, duration, responseBody…) → действия (highlight, screenshot, notification, block)
- **Intercept Rules** — block, modifyHeaders, mock ответов через `session.protocol.handle`
- **Proxy profiles** — шифрование через `safeStorage`, TLS-профиль, User-Agent, timezone, language на профиль
- **Изолированные вкладки** — `session.fromPartition`, отдельные cookies/cache на вкладку

**Окна приложения:** `browser.html` (главное), `log-viewer.html`, `proxy-manager.html`, `rules.html`, `cookie-manager.html`, `request-editor.html`, `modal-logging.html`, `quick-proxy-change.html`, `trace-viewer.html`, `new-tab.html` (стартовая), `index.html` (User Manual).

**Признак из кода:** `browser.html` — proxy pill, log pill (REC toggle + Log #N), url-input, tool dock (DevTools, Cookies, Screenshot, Rules, Request Editor).

---

## 2. Какие проблемы он решает

| Проблема | Как решает CupNet |
|----------|-------------------|
| **Блокировка по TLS/JA3** | AzureTLS подменяет fingerprint на Chrome/Firefox/Safari и др. |
| **Анализ трафика** | MITM + SQLite + FTS5 — полная история, поиск по body |
| **Отладка API** | Replay, HAR export, Request Editor (есть Copy as cURL в request-editor) |
| **Mock/block при разработке** | Intercept Rules: block, modifyHeaders, mock |
| **Мультиаккаунт / гео** | Proxy profiles + изолированные вкладки + fingerprint на профиль |
| **Автоматизация сценариев** | Rules: highlight, screenshot, notification при совпадении условий |

---

## 3. User flows и сценарии использования

### Flow 1: Первый запуск → просмотр трафика

1. Запуск → `browser.html` → первая вкладка с `new-tab.html`
2. **REC выключен** — логирование не идёт. Пользователь должен нажать REC.
3. При первом нажатии REC → `modal-logging.html` (модалка «Start Logging» с опциями, countdown)
4. После подтверждения → создаётся сессия, запросы пишутся в SQLite
5. Клик по Log pill → `log-viewer.html` с запросами

**Проблема:** новый пользователь не понимает, что нужно включить REC. Нет подсказки.

### Flow 2: Подключение прокси

1. Клик по proxy pill (Direct) в тулбаре → `proxy-manager.html`
2. Add profile → имя, URL (с шаблонами `{SID}`, `{RAND:min-max}`), страна, TLS-профиль, User-Agent
3. Test → проверка latency, цвет (зелёный/жёлтый/красный)
4. Connect → прокси применяется ко всем вкладкам
5. Direct — сброс прокси

**Признак:** `proxy-manager-renderer.js` — TLS_TEMPLATE_DESCS, TLS_JA3_PRESETS, UA_PRESETS.

### Flow 3: Анализ запроса (Replay, HAR)

1. Log viewer → выбор записи → детальная панель (headers, body)
2. Replay → отправка через `net.fetch` с сохранением fingerprint → diff с оригиналом
3. Export HAR → `dialog.showSaveDialog` → HAR 1.2
4. Request Editor — открывается из лога (если есть кнопка) или из тулбара — ручной ввод URL, method, headers, body, Execute

**Признак:** `log-viewer-renderer.js` — `replayRequest`, `exportHar`; `request-editor-renderer.js` — method, url, headers, body, send.

### Flow 4: Правила (Highlight + Intercept)

1. Rules → `rules.html` — две вкладки: Highlight Rules, Intercept Rules
2. **Highlight:** условия (field, operator, value) + действия (highlight color, screenshot, notification, block)
3. **Intercept:** url_pattern, type (block/modifyHeaders/mock), params (JSON)
4. Правила из лога → «Intercept Rules» открывает редактор

**Признак:** `rules-engine.js` — `evaluate`, `matchesRule`, `matchCondition`; `request-interceptor.js` — attachToSession.

### Flow 5: Изолированная вкладка

1. New isolated tab (кнопка с замком) → новая вкладка с `persist:isolated_*` partition
2. Отдельные cookies, cache, без наследования от shared session
3. Для мультиаккаунта / тестов

### Flow 6: Trace mode

1. Включение trace → полный request/response в `trace_entries`, live-обновление
2. Trace viewer — отдельное окно для просмотра

---

## 4. Сильные стороны продукта

1. **Уникальная связка** — MITM + TLS spoofing + rules в одном приложении. Charles/Fiddler не дают fingerprint; антидетект-браузеры не дают такого уровня инспекции.

2. **Виртуальный скролл в log-viewer** — `ROW_HEIGHT` фиксированный, рендерится только видимое. Работает с сотнями тысяч записей (README).

3. **FTS5-поиск** — полнотекстовый поиск по URL и response_body без полного сканирования.

4. **Proxy profiles с fingerprint** — TLS-профиль (chrome/firefox/safari…), User-Agent, timezone, language на профиль. Шаблоны `{SID}`, `{RAND}`.

5. **Replay с diff** — повторная отправка с сохранением fingerprint, сравнение ответов.

6. **Изолированные вкладки** — один клик, отдельная сессия.

7. **Тёмная тема** — единый стиль (--bg0, --accent, --text) во всех окнах.

8. **Copy as cURL** — есть в log-viewer (вкладка Raw, кнопка «⎘ curl») и в Request Editor. Нет в контекстном меню по правому клику на строке в списке (ROADMAP 1.1).

9. **Cookie Manager** — отдельное окно, управление cookies по вкладкам.

10. **index.html** — встроенная документация (User Manual).

---

## 5. Слабые стороны продукта

1. **Нет onboarding** — первый запуск: new-tab с поиском и ссылками, но нет объяснения «что это» и «как начать». REC выключен по умолчанию.

2. **modal-logging** — при первом REC показывается модалка с countdown и опциями. Назначение неочевидно; можно пропустить и не понять.

3. **Нет keyboard shortcuts** — ROADMAP 1.2: нет Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+R. `browser.html` title говорит «Ctrl+T» для new-tab, но обработчик может отсутствовать.

4. **Copy as cURL** — есть в детальной панели лога (вкладка Raw → кнопка curl), но нет в контекстном меню по правому клику на строке. Нужно: выбрать запрос → открыть Raw → нажать кнопку. ROADMAP 1.1: правый клик → Copy as cURL.

5. **Нет индикатора прокси в адресной строке** — ROADMAP 1.3: пользователь не видит, через какой прокси работает вкладка, пока не откроет Proxy Manager.

6. **Много окон** — browser, log-viewer, proxy-manager, rules, cookie-manager, request-editor, modal-logging, quick-proxy-change, trace-viewer. Легко потеряться.

7. **index.html устарел** — «Logs: logs/YYYY-MM-DD/*.jsonl» — сейчас SQLite. «Documentation version: v2025.08.14».

8. **sanitizeProxyUrl — no-op** — ROADMAP 1.7: пароль прокси может утечь в логи.

9. **Нет подсветки совпадений FTS** — поиск работает, но найденные фрагменты не подсвечиваются (ROADMAP 1.6).

10. **main.js ~2500 строк** — монолит, сложно поддерживать (ROADMAP).

---

## 6. Функции, которые стоит добавить

**Быстро (ROADMAP 1.x):**

- Copy as cURL из log-viewer по правому клику
- Keyboard shortcuts (Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+R)
- Индикатор прокси в адресной строке (флаг + имя)
- Подсветка совпадений в FTS-результатах
- Export CSV рядом с Export HAR
- sanitizeProxyUrl — реальная валидация и маскировка пароля

**Среднесрочно (ROADMAP 2.x):**

- Workspaces — сохранённые наборы (прокси + вкладки + правила)
- Timeline/Waterfall — визуализация запросов
- Diff двух сессий
- Cookie-профили — snapshot/restore
- Автомониторинг прокси (background check)
- Transform-правила с JS (модификация body)

**Долгосрочно (ROADMAP 3.x):**

- Headless/CLI для CI/CD
- AI-ассистент для анализа трафика
- Sync-сервер для команды
- User Scripts (Tampermonkey-подобные)
- Антидетект-аналитика (автосмена при блокировке)

---

## 7. Улучшения UX

1. **Onboarding при первом запуске** — короткий туториал: «Включите REC для записи трафика → откройте сайт → Log покажет запросы». Или tooltip на REC при первом запуске.

2. **REC по умолчанию** — или «Start logging automatically» в настройках. Сейчас пользователь может забыть включить и не увидеть запросы.

3. **Объяснение modal-logging** — зачем countdown, что означают опции. Или убрать/упростить.

4. **Индикатор прокси в url-bar** — флаг страны + «Direct»/имя профиля. Сейчас только в proxy pill; при открытом Log viewer не видно.

5. **Единая точка входа для настроек** — Proxy Manager, Settings panel в browser, Rules — разбросаны. Идея: один «Settings» с вкладками.

6. **Контекстное меню в log-viewer** — правый клик на запросе: Copy as cURL, Copy URL, Open in Request Editor, Add Intercept Rule (url_pattern = этот URL).

7. **Подсветка FTS-совпадений** — `highlightMatch(text, query)` в теле ответа при поиске.

8. **Breadcrumbs / навигация по окнам** — «Browser → Log → Request #123» чтобы понимать, где находишься.

9. **Обновить index.html** — SQLite, актуальные пути, убрать JSONL.

10. **Suspend вкладок** — ROADMAP 1.4: при 5+ вкладках экономия RAM. Сейчас все вкладки в памяти.

---

## 8. Функции, которые сильно увеличат ценность

1. **Copy as cURL из лога** — must-have для devs. Сейчас есть в Request Editor, но нужно открыть редактор и вручную ввести. Правый клик в логе → Copy as cURL = 1 клик.

2. **Timeline/Waterfall** — визуализация «когда что грузилось» как в Chrome DevTools. Данные уже есть (duration, created_at). Сильно упрощает анализ производительности.

3. **Workspaces** — переключение контекста одним кликом: «Проект A» (прокси DE + правила X) vs «Проект B» (прокси US + другие правила). Сейчас нужно вручную менять прокси и правила.

4. **AI-ассистент** — «Найди аномальные запросы», «Почему страница грузится 4 секунды», «Сгенерируй intercept-правило для блокировки рекламы». Высокая ценность при умеренной сложности (Ollama/OpenAI API).

5. **Headless/CLI** — `cupnet --headless --proxy=... --output=results.har` для CI/CD. Открывает рынок автоматизации и тестирования.

6. **Антидетект-аналитика** — автоопределение блокировки/капчи по ответам и смена прокси/TLS. Ключевая ценность для scraping-аудитории.

7. **Cookie-профили** — «до логина» / «после логина» — быстрый переключатель. Сейчас cookies привязаны к вкладке; snapshot/restore даёт гибкость.

8. **Sync-сервер** — общий pool прокси и правил для команды. Увеличивает ценность для агентств и команд.
