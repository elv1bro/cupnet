# CupNet 2.0

Electron-браузер со встроенным прокси, перехватом сетевого трафика и расширенным логированием.

---

## Запуск

```bash
cd node/cupnet
npm install --ignore-scripts
npm run rebuild:arm64       # только для Apple Silicon (arm64)
ELECTRON_RUN_AS_NODE= npm start
```

> **Важно для macOS (Apple Silicon):** нативный модуль `better-sqlite3` должен быть скомпилирован под `arm64`. Скрипт `rebuild:arm64` делает это автоматически через `arch -arm64`.  
> **Важно для запуска из Cursor IDE:** переменная `ELECTRON_RUN_AS_NODE` наследуется от IDE и переключает Electron в режим headless Node.js. Скрипт `start` явно сбрасывает её.

---

## Архитектура

```
main.js                  — главный процесс Electron
├── db.js                — SQLite база данных (better-sqlite3)
├── tab-manager.js       — управление вкладками (BrowserView)
├── request-interceptor.js — перехват запросов по сессии
├── rules-engine.js      — движок правил (условия → действия)
├── har-exporter.js      — экспорт в HAR 1.2
├── preload.js           — IPC-мост для browser.html / proxy-selector.html
└── preload-view.js      — минимальный preload для BrowserView-вкладок

browser.html             — главное окно (тулбар + таб-бар)
browser-renderer.js      — логика тулбара и таб-бара

log-viewer.html          — окно просмотра сетевых логов
log-viewer-renderer.js   — виртуальный скролл, фильтры, HAR, replay

proxy-selector.html      — окно настроек (прокси, стартовая страница…)
proxy-selector.js        — логика настроек

rules.html               — редактор правил и перехватчика
rules.js                 — логика редактора

new-tab.html             — встроенная стартовая страница
quick-proxy-change.html  — быстрая смена прокси
```

---

## Что нового в версии 2.0

### 1. SQLite-база данных (`db.js`)

Вместо записи в JSONL-файлы все данные теперь хранятся в SQLite через `better-sqlite3`.

**Таблицы:**

| Таблица | Описание |
|---|---|
| `sessions` | Сессии работы (старт/конец, прокси, вкладка) |
| `requests` | HTTP-запросы с заголовками, телами, статусами и временем |
| `ws_events` | WebSocket фреймы (send/recv) |
| `screenshots` | Скриншоты в base64 |
| `proxy_profiles` | Сохранённые прокси-профили (URL зашифрован) |
| `rules` | Правила подсветки и уведомлений |
| `intercept_rules` | Правила перехвата (block / modifyHeaders / mock) |

**FTS5 (Full-Text Search):**  
Виртуальная таблица `requests_fts` с триггерами — полнотекстовый поиск по URL и телу ответа без сканирования всей таблицы.

**Индексы:**  
`session_id`, `tab_id`, `url`, `status`, `created_at` — быстрая фильтрация по любому параметру.

---

### 2. Многовкладочность (`tab-manager.js`)

- Каждая вкладка — отдельный `BrowserView` с изолированной `session.fromPartition`
- Вкладки не разделяют cookies, кэш и прокси-настройки
- При создании вкладки автоматически применяется текущий прокси
- Таб-бар рендерится в `browser.html` динамически через IPC
- `tab-list-updated` событие синхронизирует UI с состоянием вкладок
- `target=_blank` ссылки открываются в новой вкладке (через `setWindowOpenHandler`)
- Загрузка страницы (`did-start-loading` / `did-stop-loading`) → обновляет индикатор в тулбаре
- Переключение вкладки → URL-бар обновляется до URL активной вкладки

---

### 3. Перехват запросов (`request-interceptor.js`)

Прикрепляется к `tabSession` при создании каждой вкладки.

**Типы правил:**

| Тип | Что делает |
|---|---|
| `block` | Отменяет запрос (`cancel: true`) |
| `modifyHeaders` | Добавляет/изменяет/удаляет заголовки запроса и ответа |
| `mock` | Возвращает фиктивный ответ (статус + MIME + тело) |

**Реализация (macOS / Electron 28+):**
- `block` и `modifyHeaders` — через `webRequest.onBeforeSendHeaders` / `onHeadersReceived` (надёжные, не затрагивают тело)
- `mock` — через `session.protocol.handle('http', ...)` и `session.protocol.handle('https', ...)` (новый API, заменяет устаревший `interceptStreamProtocol`)
- Pass-through запросов через `net.fetch(request)` внутри обработчика — не вызывает рекурсии (документировано в Electron)
- Удаление заголовков — регистронезависимое
- `detachFromSession` — корректно отключает все хуки при закрытии вкладки

---

### 4. Движок правил (`rules-engine.js`)

Обрабатывает каждый входящий HTTP-запрос и сопоставляет с активными правилами из БД.

**Поля условий:** `url`, `method`, `status`, `type`, `duration`, `responseBody`, `requestBody`, `host`, `error`

**Операторы:** `equals`, `notEquals`, `contains`, `notContains`, `startsWith`, `endsWith`, `matches` (regex), `gt`, `lt`, `gte`, `lte`, `between`, `exists`, `notExists`

**Действия при совпадении:**
- `highlight` — подсвечивает строку в лог-вьювере выбранным цветом
- `screenshot` — делает автоматический скриншот активной вкладки
- `notification` — показывает системное уведомление (через `Notification` API Electron)
- `block` — отменяет запрос

---

### 5. HAR-экспортер (`har-exporter.js`)

Экспортирует данные сессии из SQLite в формат **HAR 1.2** (HTTP Archive).

- Корректно формирует структуру `log.entries` с timing, заголовками, телами
- Поддерживает фильтрацию по `sessionId`
- Файл сохраняется через `dialog.showSaveDialog` с расширением `.har`
- Совместим с Chrome DevTools, Charles Proxy, Fiddler

---

### 6. Просмотрщик логов (`log-viewer.html` + `log-viewer-renderer.js`)

#### Виртуальный скролл
- Рендерится только видимая часть списка (фиксированный `ROW_HEIGHT`)
- Корректно работает с сотнями тысяч записей без подвисания
- Автопрокрутка с кнопкой отключения при ручном скролле
- Клавиатурная навигация: `↑ ↓ Home End`

#### Фильтры и поиск
- По типу (`XHR`, `Fetch`, `Document`, `WebSocket`…)
- По HTTP-статусу
- По вкладке (`tabId`)
- По сессии
- **FTS-поиск** (чекбокс) — полнотекстовый поиск через SQLite FTS5 по URL и телу ответа

#### Действия
- **Export HAR** — экспорт текущей сессии в `.har`
- **Replay** — повторная отправка запроса через `net.fetch`, сравнение с оригинальным ответом (diff)
- **Intercept Rules** — открывает редактор правил прямо из лог-вьювера
- **Подсветка** — записи, сработавшие по правилу, выделяются цветом в реальном времени

#### Детальная панель
- Полные заголовки запроса и ответа
- Тело ответа (с декодированием base64 для изображений)
- Скриншоты (предпросмотр в панели)
- Результат Replay с diff

---

### 7. Редактор правил (`rules.html` + `rules.js`)

Два раздела:

**Highlight Rules** — визуальные правила на основе условий:
- Конструктор условий (поле + оператор + значение), несколько условий на одно правило
- Действия: highlight (с выбором цвета), screenshot, notification, block
- Включение/выключение каждого правила через toggle
- Счётчик срабатываний (`hit_count`)

**Intercept Rules** — правила перехвата запросов:
- `block` — без дополнительных параметров
- `modifyHeaders` — JSON-поля для заголовков запроса/ответа и списков удаляемых заголовков
- `mock` — HTTP-статус, MIME-тип, тело ответа

---

### 8. Прокси-профили

- Сохранение профилей с именем, страной и URL в зашифрованном виде
- Шифрование через `safeStorage` Electron (AES через keychain macOS / libsecret Linux / DPAPI Windows)
- Отображается только маскированный URL (пароль заменён на `***`)
- Кнопка **Test** — проверяет доступность прокси и сохраняет задержку (`last_latency_ms`)
- Цветовая индикация скорости: зелёный (<500ms), жёлтый (<2s), красный (>2s)
- Кнопка **Use** — подставляет URL профиля в поле прокси

---

### 9. Стартовая страница (`new-tab.html`)

Встроенная страница, открывающаяся в новых вкладках.

- **Часы** — большие, обновляются каждую секунду, дата на русском
- **Поиск** с выбором поискового движка: Google, DuckDuckGo, Яндекс, Bing
  - Умный разбор ввода: URL / hostname / IP / поисковый запрос
  - Выбор движка сохраняется в `localStorage`
- **Быстрые ссылки**: Google, GitHub, Gmail, YouTube, X, Google Translate
- Тёмная тема, фоновая сетка

**Настройка стартовой страницы:**  
В Proxy Settings → секция «Start Page» — можно задать произвольный URL или оставить пустым для встроенной страницы.

---

### 10. Тулбар и интерфейс

**Кнопки навигации** (SVG-иконки, без эмодзи):
- ← Back, → Forward, ↻ Reload, ⌂ Home

**Кнопки действий** (SVG-иконка + текстовая подпись):
- `Log` — открывает Network Activity Log
- `Screen` — делает скриншот активной вкладки
- `DevTools` — открывает Chrome DevTools для активной BrowserView-вкладки

**DevTools (исправлено):**  
`F12` и `Cmd+Shift+I` (Shell) открывают DevTools правильного контекста. Меню → View:
- `Developer Tools (Page)` — DevTools для сайта в активной вкладке
- `Developer Tools (Shell)` — DevTools для `browser.html` (UI оболочки)

---

### 11. Исправленные баги

| Проблема | Решение |
|---|---|
| DevTools открывался для `browser.html` вместо сайта | Кастомный обработчик `toggleDevTools` на активный BrowserView |
| `TOOLBAR_HEIGHT = 120px` при реальных 95px | Исправлено на 95 (35 tab-bar + 60 toolbar) — убран зазор |
| `did-finish-load` с `.on()` создавал дублирующие вкладки при reload | Заменено на `.once()` |
| Индикатор загрузки не работал | `did-start-loading` / `did-stop-loading` форвардятся в toolbar |
| URL-бар не обновлялся при навигации | `did-navigate` отправляет `url-updated` в mainWindow |
| URL-бар не обновлялся при смене вкладки | `switchTab()` отправляет `url-updated` + `set-loading-state` |
| `target=_blank` ссылки терялись | `setWindowOpenHandler` → открытие в новой вкладке |
| Фавиконки всегда показывали 🌐 | `page-favicon-updated` → реальная `<img>` с fallback |
| Перехватчик (`request-interceptor`) не работал | `attachToSession` не вызывался нигде — добавлен во все точки создания вкладок |
| `interceptStreamProtocol` не работал на macOS в Electron 28 | Заменён на `session.protocol.handle()` (API Electron 25+) |
| Бесконечная рекурсия при pass-through в перехватчике | `net.fetch(request)` внутри `protocol.handle` не рекурсивен |
| Только `http` перехватывался, не `https` | Зарегистрированы обработчики для обоих протоколов |
| `ELECTRON_RUN_AS_NODE=1` от Cursor IDE ломал запуск | `package.json start` явно сбрасывает переменную |
| `better-sqlite3` скомпилирован под x86_64 на Apple Silicon | `rebuild:arm64` через `arch -arm64` + universal Node.js от Cursor |

---

## Структура базы данных

```sql
sessions          id, started_at, ended_at, proxy_info, tab_id, notes
requests          id, session_id, tab_id, request_id, url, method,
                  status, type, duration_ms, request_headers,
                  response_headers, request_body, response_body, error, created_at
ws_events         id, session_id, tab_id, url, direction, payload, created_at
screenshots       id, session_id, tab_id, url, data_b64, created_at
proxy_profiles    id, name, url_encrypted, url_display, country,
                  last_tested_at, last_latency_ms, created_at
rules             id, name, enabled, conditions(JSON), actions(JSON), hit_count
intercept_rules   id, name, enabled, url_pattern, type, params(JSON)
requests_fts      виртуальная FTS5 таблица (url + response_body)
```

---

## Зависимости

| Пакет | Версия | Назначение |
|---|---|---|
| `electron` | ^28.0.0 | Фреймворк приложения |
| `better-sqlite3` | ^9.4.3 | Синхронный SQLite-драйвер |
| `proxy-chain` | ^2.5.9 | Анонимизация прокси URL |
| `@electron/rebuild` | ^3.6.0 | Пересборка нативных модулей |
| `electron-builder` | ^24.13.0 | Сборка дистрибутива |
