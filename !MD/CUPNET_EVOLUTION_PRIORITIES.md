# CupNet — Приоритеты развития (P0/P1/P2)

Этот документ фиксирует расшифровку приоритетов развития CupNet для командного и масштабного внедрения.

## P0 (критично для масштабного внедрения)

### 1) Incident/Bug bundle export-import (единый артефакт для handoff)

**Что это**  
Единый переносимый файл-кейс, который содержит все необходимое для воспроизведения и расследования.

**Что должно входить в bundle**  
- выбранные запросы и ответы;
- trace-срез;
- активные rules/intercept/dns-overrides;
- cookies/session metadata;
- заметки автора кейса;
- версия приложения и runtime-контекст.

**Зачем**  
Снижает потери контекста между QA, Dev, SRE и ускоряет handoff.

**Как может выглядеть в CupNet**  
- `Export Case` в log/rules/dns окнах;
- `Import Case` с восстановлением контекста;
- проверка совместимости версии schema.

**Обязательный шаг при экспорте: выбор уровня защиты**  
При `Export Case` показывать модальное окно:
- `Без защиты (Raw)` — без редактирования данных;
- `Базовая защита (Balanced)` — маскировка очевидных секретов/PII;
- `Строгая защита (Strict)` — максимальная маскировка + удаление потенциально рискованных фрагментов body.

Без выбора уровня защиты экспорт не завершается.

**Как делать защиту так, чтобы было понятно "данные уже не те", но максимум пользы сохранялся**  
- Маскировать значения, но оставлять структуру:
  - `Authorization: Bearer sk_live_123...` -> `Authorization: Bearer <REDACTED:len=18>`;
  - `email=john@corp.com` -> `email=<REDACTED:email_domain=corp.com>`;
  - `cookie=session=abc123` -> `cookie=session=<REDACTED:len=6>`.
- В JSON сохранять ключи и типы, скрывать только чувствительные значения:
  - `"token":"abc"` -> `"token":"<REDACTED:string,len=3>"`.
- Для длинных тел сохранять безопасный preview + hash:
  - `body_preview`, `sha256`, `original_length`.
- Добавлять служебный блок в bundle:
  - `protection_level`,
  - `redaction_rules_version`,
  - `redacted_fields_count`,
  - `redaction_report` (какие поля скрыты и почему).

**Явная маркировка артефакта**  
- В header bundle: `ProtectedExport: Balanced/Strict`.
- В UI импортированного кейса баннер: `Data was redacted for safety`.
- Для каждого скрытого значения показывать badge `Redacted`.

**Минимальная schema bundle v1**  
- `meta` (appVersion, exportedAt, protectionLevel, report);
- `traffic` (requests, responses, traceLinks);
- `context` (rules, intercepts, dnsOverrides, sessionMeta);
- `notes` (summary, hypothesis, owner).

---

### 2) Data redaction и secure export (PII/secrets masking)

**Что это**  
Автоматическая маскировка чувствительных данных при просмотре и перед экспортом.

**Что маскируем**  
- токены (`Authorization`, API keys, Bearer/JWT);
- cookies/session ids;
- PII-поля (email, phone, user ids и т.п.);
- секреты в body/query/header.

**Зачем**  
Безопасный обмен артефактами внутри и вне команды.

**Как может выглядеть в CupNet**  
- профили redaction: `Strict`, `Balanced`, `Custom`;
- preview до экспорта;
- отчет: какие поля были редактированы.

---

### 3) Audit trail действий в правилах и сессиях

**Что это**  
Журнал действий: кто, когда и что менял/запускал.

**Что логировать**  
- изменения rules/intercepts/dns overrides;
- replay/mocking действия;
- экспорт/импорт артефактов;
- удаление/очистка данных.

**Зачем**  
Контроль изменений, прозрачность расследований, enterprise/compliance требования.

**Как может выглядеть в CupNet**  
- отдельный `Audit` viewer;
- фильтры по actor/action/object/time;
- экспорт аудита.

---

### 4) Diff mode для request/response сравнения

**Что это**  
Режим сравнения двух запросов/ответов с акцентом на важные отличия.

**Что сравнивать**  
- method/url/status;
- headers (added/removed/changed);
- body (структурный JSON/text diff);
- timing/latency.

**Зачем**  
Резко ускоряет root cause анализ "что изменилось между рабочим и сломанным случаем".

**Как может выглядеть в CupNet**  
- `Compare with...` в log-viewer;
- "smart highlight" критичных отличий;
- возможность сохранить diff в кейс.

**Куда лучше встроить Diff mode (теория интеграции в UI)**  
Главная точка входа: `log-viewer`, потому что там пользователь уже выбирает запросы.

Рекомендуемая схема:
- В таблице логов multi-select (2 элемента) -> кнопка `Compare`.
- В контекстном меню записи: `Compare with previous` / `Compare with...`.
- В `request-editor` добавить `Compare to original` для replay-сценариев.

**Расположение в интерфейсе**  
- Справа как отдельная вкладка в detail pane: `Details | Diff`.
- Для больших сравнений отдельное окно `Diff Viewer` (чтобы не сжимать основной лог).

**Логика сравнения v1**  
- Request: method, URL, query params, headers, body.
- Response: status, headers, body, timing.
- Отдельный блок "Impact summary":
  - `Breaking-risk headers changed`,
  - `Auth-related fields changed`,
  - `Payload schema changed`,
  - `Latency delta`.

**Варианты сравнения, которые особенно полезны**  
- До/после replay.
- Между двумя сессиями.
- Между профилями proxy/tls.
- Между baseline и импортированным incident bundle.

**Как связать Diff mode с Incident/Bug bundle**  
- Сохранять diff snapshot внутрь bundle.
- При импорте сразу предлагать `Open Diff vs local baseline`.
- В отчете handoff показывать не только raw запросы, но и выделенные отличия.

---

### 5) Experiment runner v1 для параметризованных прогонов

**Что это**  
Батч-запуск серии сценариев по параметрам.

**Типовые параметры**  
- proxy profile;
- tls profile/fingerprint;
- набор правил/intercepts;
- target endpoint.

**Зачем**  
Уходит ручной режим "по одному сценарию", повышается воспроизводимость исследований.

**Как может выглядеть в CupNet**  
- таблица `Scenario Matrix`;
- кнопка `Run all`;
- базовый отчет по статусам/ошибкам/latency.

## P1 (сильный рост ценности в командах)

### 1) Presets library (QA, Dev, SRE, Security, Anti-fraud)

**Что это**  
Готовые шаблоны сценариев под роль.

**Зачем**  
Быстрый старт, меньше ошибок конфигурации.

**Пример**  
QA preset: auth-expiry + retry + partial-failure mock.

---

### 2) Saved workspaces и сценарные shortcuts

**Что это**  
Сохранение текущего состояния работы:
- вкладки/фильтры;
- выбранные профили;
- активные rules/intercepts;
- выделенные запросы.

**Зачем**  
Повторяемость и быстрый возврат к расследованию.

---

### 3) Аннотации/теги/таймлайн заметки на уровне кейсов

**Что это**  
Командный слой контекста поверх сырого трафика.

**Зачем**  
Лучший handoff между людьми и сменами.

**Как может выглядеть**  
- теги на запросы/события;
- заметки в timeline;
- быстрые фильтры по меткам.

---

### 4) Run comparison report

**Что это**  
Сравнение двух прогонов с итоговым резюме.

**Зачем**  
Проверка гипотез и валидация фиксов на фактах.

**Как может выглядеть**  
- baseline vs candidate;
- статистика отличий;
- экспорт отчета.

---

### 5) Governance playbook + onboarding tracks

**Что это**  
Регламент использования инструмента в командах.

**Зачем**  
Превращает локальный инструмент в командный стандарт.

**Состав**  
- роли и ответственность;
- security-гайд;
- onboarding треки по группам.

## P2 (стратегическое развитие)

### 1) DSL/скрипты для экспериментов и сценариев

**Что это**  
Сценарный язык для автоматизации сложных исследований.

**Зачем**  
Сложные повторяемые эксперименты без ручного кликанья.

---

### 2) Интеграции в экосистему (incident, test, issue trackers)

**Что это**  
Интеграции с Jira/Linear/TestRail/PagerDuty/и др.

**Зачем**  
Сквозной процесс без копипаста артефактов.

---

### 3) Централизованные policy controls для enterprise usage

**Что это**  
Админ-политики на уровне организации.

**Зачем**  
Безопасное масштабирование и контроль рисков.

**Примеры политик**  
- запрет экспорта без redaction;
- whitelist/blacklist доменов;
- ограничения на mock/rewrite операции.

---

### 4) KPI dashboard для менеджмента и platform teams

**Что это**  
Панель метрик внедрения и ценности инструмента.

**Зачем**  
Видимый ROI и управляемая приоритизация roadmap.

**Примеры KPI**  
- MTTR/MTTD;
- time-to-repro;
- adoption по командам;
- качество handoff артефактов.

## Короткая последовательность внедрения

1. Сначала P0 (безопасность, воспроизводимость, сравнение).  
2. Затем P1 (командные workflows и скорость повседневной работы).  
3. После этого P2 (масштабирование и enterprise-контур).

