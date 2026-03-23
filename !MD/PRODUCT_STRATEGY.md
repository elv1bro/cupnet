# CupNet: Product Strategy

> Краткий анализ как product strategist. Только CupNet (`node/cupnet2/`).

---

## Что это за продукт

**CupNet** — desktop-браузер (Electron) для **анализа и модификации сетевого трафика** с тремя ключевыми отличиями:

1. **MITM-прокси** — весь трафик идёт через локальный прокси (8877), можно читать и менять запросы/ответы
2. **TLS fingerprint spoofing** — через AzureTLS имитируется Chrome, Firefox, Safari, iOS, Edge, Opera (JA3, HTTP/2)
3. **Rules + Intercept** — автоматические действия (highlight, screenshot, block, mock) по условиям

Плюс: логирование в SQLite, FTS5-поиск, HAR export, Replay, Cookie Manager, изолированные вкладки с разными прокси и fingerprint.

**В одном предложении:** Charles Proxy + TLS fingerprint spoofing + правила автоматизации.

---

## Кому это нужно

| Аудитория | Задача | Почему CupNet |
|-----------|--------|---------------|
| **Scraping / парсинг** | Обход Cloudflare, DataDome, Akamai | TLS fingerprint как у реального Chrome — меньше блокировок |
| **Арбитраж / SMM** | Мультиаккаунт, разные гео | Прокси + изолированные вкладки + смена fingerprint |
| **Разработчики** | Отладка API, mock ответов | MITM, Replay, Intercept (block/modify/mock), HAR |
| **QA / тестировщики** | Проверка поведения при ошибках | Mock ответов, block запросов, правила |
| **Security researchers** | Анализ трафика, fingerprinting | Полный доступ к запросам, смена TLS-профиля |

**Главная боль:** сайты блокируют по TLS (JA3) и fingerprint. Обычный прокси или DevTools не меняют TLS. CupNet меняет.

---

## Как усиливать продукт

### Быстро (1–2 недели)

- **Copy as cURL** — из лога в один клик (ROADMAP 1.1)
- **Keyboard shortcuts** — Ctrl+T, Ctrl+W, Ctrl+L (ROADMAP 1.2)
- **Индикатор прокси** в адресной строке — флаг + имя профиля (ROADMAP 1.3)
- **sanitizeProxyUrl** — валидация URL, маскировка пароля (ROADMAP 1.7)
- **Landing** — одна страница: что это, для кого, скачать

### Среднесрочно (1–2 месяца)

- **Workspaces** — сохранённые наборы (прокси + вкладки + правила), переключение одним кликом
- **Timeline/Waterfall** — визуализация запросов как в Chrome DevTools
- **Cookie-профили** — snapshot/restore для быстрого переключения контекста
- **Diff сессий** — сравнение двух сессий (новые/изменённые запросы)
- **Unit-тесты** — rules-engine, db, utils (снижение регрессий)

### Долгосрочно (3+ месяца)

- **Headless/CLI** — запуск без GUI для CI/CD, `cupnet --headless --output=results.har`
- **AI-ассистент** — «найди аномалии», «почему медленно», «сгенерируй правило»
- **Sync-сервер** — общий pool прокси и правил для команды
- **Антидетект-аналитика** — автосмена прокси/TLS при признаках блокировки

---

## Позиционирование

**Вариант A — Developer Tools:**  
«Charles Proxy с TLS fingerprint и правилами». ЦА: devs, QA. Конкуренты: Charles, Fiddler, Proxyman.

**Вариант B — Anti-Detect:**  
«Браузер для обхода антибота с полным контролем трафика». ЦА: scraping, арбитраж. Конкуренты: Multilogin, GoLogin, Dolphin Anty.

**Рекомендация:** начать с **B** — там выше готовность платить и меньше прямых аналогов с таким сочетанием (MITM + TLS + rules). Dev tools — вторичный слой.

---

## Монетизация

- **Freemium** — базовая версия бесплатно, Pro ($15–30/мес) за sync, AI, workspaces
- **One-time** — $49–99 за perpetual license
- **B2B / White-label** — $200–500/мес для агентств

---

## Главные риски

1. **HEADCHR_IFRAME** — fingerprint-тесты Intoli не проходят (window.chrome в iframe). Для anti-detect это дыра.
2. **Монолит main.js** — сложно поддерживать, нужен рефакторинг.
3. **Нет позиционирования** — продукт не объясняет, зачем он нужен. Нужен landing и чёткое «для кого».

---

## Резюме

**CupNet** — сильный технический продукт на стыке dev tools и anti-detect. Уникальность: MITM + TLS spoofing + rules в одном приложении.

**Следующий шаг:** выбрать позиционирование (dev tools или anti-detect), сделать landing, найти 2–3 платящих пользователей и итеративно усиливать под их задачи.
