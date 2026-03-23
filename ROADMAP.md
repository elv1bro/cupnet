# CupNet 2.0 — Roadmap & Improvement Plan

> Сгенерировано на основе технического ревью и анализа архитектуры.

---

## Текущее состояние

CupNet — специализированный Electron-браузер для анализа трафика:
**браузер + MITM-прокси + network inspector + TLS fingerprint spoofer + cookie manager**
в одном приложении с SQLite-базой для хранения всей истории сетевых запросов.

---

## 1. Быстрые улучшения (1–5 дней каждое)

### 1.1 Copy as cURL из лога
Правая кнопка на запросе → «Copy as cURL». Сериализация `entry.request.headers + method + body` в curl-строку прямо в `log-viewer-renderer.js`. Must-have для отладки.

### 1.2 Keyboard shortcuts
Сейчас нет `Ctrl+T` (новая вкладка), `Ctrl+W` (закрыть), `Ctrl+L` (фокус адресной строки), `Ctrl+R` (reload).
Добавляются через `globalShortcut` или `accelerator` в меню.

### 1.3 Индикатор активного прокси в адресной строке
Показывать флаг страны + имя профиля рядом с адресной строкой. Цветной фон = пользователь сразу видит через какой прокси работает вкладка.

### 1.4 «Заморозить» вкладку (suspend)
Скрыть BrowserView и убить WebContents, сохранив URL. При клике — восстановить.
Экономит RAM при 5+ вкладках.

### 1.5 Экспорт логов в CSV
Рядом с «Export HAR» добавить «Export CSV»: `SELECT` из БД + сериализация. Полезно для анализа в Excel / Google Sheets.

### 1.6 Подсветка совпадений в результатах FTS-поиска
Сейчас FTS5 поиск работает, но совпадения не подсвечиваются. Нужна функция `highlightMatch(text, query)` в `log-viewer-renderer.js`.

### 1.7 Фиксы существующих уязвимостей

#### `sanitizeProxyUrl` — функция-заглушка
```js
// Было (no-op):
function sanitizeProxyUrl(proxyUrl) {
    return proxyUrl;
}

// Нужно:
function sanitizeProxyUrl(proxyUrl) {
    const u = new URL(proxyUrl); // выбросит если формат неверный
    const safe = `${u.protocol}//${u.hostname}:${u.port}`;
    if (u.username) return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port}`;
    return safe;
}
```
**Почему плохо без этого:**
- `ProxyChain.anonymizeProxy()` упадёт с невнятной ошибкой вместо понятного «неверный URL»
- Пароль прокси может утечь в `console.error` / HAR-экспорт в открытом виде
- Название функции создаёт ложное ощущение защиты

#### `preload.js` — листенеры без cleanup
```js
// Было:
onLoadProxies: (cb) => ipcRenderer.on('load-proxies', (_, v) => cb(v)),

// Нужно:
onLoadProxies: (cb) => {
    const handler = (_, v) => cb(v);
    ipcRenderer.on('load-proxies', handler);
    return () => ipcRenderer.removeListener('load-proxies', handler);
},
```
**Почему плохо без этого:**
- Если `api.onXxx(cb)` вызывается дважды (DevTools reload, будущий HMR) — callback срабатывает N раз: двойной ре-рендер, мерцание UI
- Каждый листенер держит closure → memory leak при долгой работе
- Нет способа отписаться от канала

---

## 2. Среднесрочные улучшения (1–4 недели каждое)

### 2.1 Профили / Workspace
Именованный набор настроек: прокси-профиль + набор вкладок + cookie-набор + правила фильтрации. Один клик = переключение в контекст нужного проекта.

```
workspaces/
  workspace_A.json  → { proxy_profile_id, tabs: [...], cookie_profile_id, rules: [...] }
  workspace_B.json  → { ... }
```

### 2.2 Timeline-вид для логов (Waterfall)
Горизонтальный waterfall как в Chrome DevTools — каждый запрос в виде полоски с таймлайном.
Данные уже есть в БД (`startTime`, `duration`). Реализация: Canvas или SVG.

### 2.3 Сравнение двух сессий (diff view)
Выбрать две сессии → показать: новые запросы, исчезнувшие, изменившиеся ответы.
Реализация: два `SELECT` + set-difference в `log-viewer-renderer.js`.

### 2.4 Cookie-профили
- Сохранить набор кук под именем («до логина» / «авторизованный пользователь»)
- Быстро подгрузить ранее сохранённый набор
- Сравнить куки до/после действия

Добавить таблицу `cookie_profiles` в SQLite. В Cookie Manager — «Save snapshot» / «Restore snapshot».

### 2.5 Автоматический мониторинг прокси
Background job (`setInterval` в `main.js`): каждые N минут проверять все профили, писать `last_checked` / `last_latency` / `is_alive` в БД. Показывать мёртвые прокси красным без ручного нажатия «Test».

### 2.6 Transform-правила перехвата с JS
Расширить Intercept Rules новым типом `transform`: JS-функция получает request/response и возвращает модифицированные данные.

```js
// Пример:
(req, resp) => {
  const data = JSON.parse(resp.body);
  data.user.premium = true;
  return { ...resp, body: JSON.stringify(data) };
}
```

### 2.7 Плагины для парсинга протоколов
WebSocket фреймы сейчас показываются как raw bytes. Нужна папка `plugins/` — каждый плагин `{ name, detect(payload), parse(payload) → object }` для Protobuf, MessagePack, GraphQL, STOMP.

---

## 3. Долгосрочные направления (месяцы)

### 3.1 Командная работа / Sync-сервер
Lightweight sync-сервер (Node.js + WebSocket) в локальной сети. Несколько инстанций CupNet:
- Общий pool прокси-профилей
- Shared правила
- Просмотр логов коллеги в реальном времени

Технологии: `ws`, CRDT для конфликт-свободной синхронизации.

### 3.2 Headless / CLI-режим
Запуск без GUI — только MITM + логирование + правила. Использование в CI/CD:

```bash
cupnet --headless --proxy=socks5://... --session=my-test --output=results.har --rule=no-5xx
```

Требует вынесения ядра (`db.js`, `mitm-proxy.js`, `request-interceptor.js`, `rules-engine.js`) в отдельный `core/` пакет без Electron-зависимостей.

### 3.3 AI-ассистент для анализа трафика
Локальная LLM (Ollama) или API (OpenAI) как опциональный модуль:
- «Найди аномальные запросы в этой сессии»
- «Почему страница грузится 4 секунды?»
- «Какие эндпоинты использует приложение для авторизации?»
- «Сгенерируй intercept-правило чтобы заблокировать рекламу»

### 3.4 Визуальный граф зависимостей запросов
Дерево/граф: Document → Script → XHR → WebSocket. Цвет = статус-код, размер = duration.
Технология: `D3.js` или `Cytoscape.js`.

### 3.5 User Scripts (аналог Tampermonkey)
Скрипты, которые запускаются на страницах по паттерну URL. Хранятся в БД.
Интеграция: `webContents.executeJavaScript()` в `did-finish-load` в `tab-manager.js`.

### 3.6 Антидетект-аналитика
Модуль, анализирующий ответы сервера:
- Признаки капчи / блокировки
- Bot-detection сигнатуры
- Honeypot-поля в формах

Результат: автоматическая смена прокси или TLS-профиля при обнаружении блокировки.

---

## Архитектурный долг

| Приоритет | Проблема | Текущее состояние | Решение |
|---|---|---|---|
| 🔴 Высокий | `main.js` — монолит 2500+ строк | Всё в одном файле | Разбить на `ipc/`, `services/`, `windows/` |
| 🔴 Высокий | `preload.js` — листенеры без cleanup | `ipcRenderer.on` накапливается | Возвращать disposable-функции из всех `onXxx` |
| 🟠 Средний | Нет unit-тестов | Логика не тестируется | `vitest` для `utils.js`, `db.js`, `rules-engine.js` |
| 🟠 Средний | `sanitizeProxyUrl` — no-op | Нет валидации, пароль в логах | `new URL()` + маскировка пароля |
| 🟠 Средний | SQLite растёт неограниченно | Нет TTL / архивации | Auto-archive: запросы старше 30 дней → `archive.db` |
| 🟡 Низкий | Нет TypeScript | JS без типов | Постепенная миграция, начиная с `db.js` |
| 🟡 Низкий | settings в двух форматах | `settings.json` + `ui-prefs.json` | Единый `config.js` с JSON Schema валидацией |

---

## Уже исправленные баги (технический ревью)

- ✅ Race condition: двойной `finalizeLog` через `_finalizing` guard
- ✅ CDP `detach`-листенер накапливался при re-attach
- ✅ `savedVars` в `quick-connect-profile` не десериализовался из JSON
- ✅ Отсутствовал `await` на `setProxyAll(null)` при сбросе прокси
- ✅ Мёртвый IPC-канал `apply-quick-proxy-change` — добавлен обработчик
- ✅ `destroy()` без `isDestroyed()` в `tab-manager.js` (3 места)
- ✅ XSS через `localStorage` в `new-tab.html` — добавлен `escHtml()`
- ✅ Навигация по `javascript:` URL — добавлен `isSafeUrl()`
- ✅ `\n`-инъекция в Netscape cookie export — добавлен `sanitize()`
- ✅ Нет лимита на размер импортируемого файла — добавлен лимит 10 MB
- ✅ Накопление `setInterval` в `modal-logging.html` при повторном init
