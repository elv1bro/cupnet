# CupNet Audience Analysis Report

Документ подготовлен по плану: анализ продукта CupNet по ключевым пользовательским группам, с фокусом на применимость, плюсы/минусы, пробелы и приоритизированные улучшения.

## Section A: Executive Summary

CupNet уже выглядит как сильный инженерный инструмент в нише "браузер + трафик + interception + fingerprinting". Основная ценность продукта:

- объединение функций, которые обычно размазаны между DevTools, Charles/Proxyman, mitmproxy и отдельными внутренними тулзами;
- фокус на прикладном сценарии "быстро воспроизвести, объяснить, зафиксировать и переиграть сетевое поведение";
- хорошая база для QA, разработки и исследовательских anti-bot сценариев.

Текущий лимит масштабирования продукта не в ядре MITM, а в "операционной зрелости":

- onboarding и понятные рабочие сценарии по ролям;
- enterprise guardrails (аудит, роли, безопасное хранение, governance);
- командные workflows (шаринг артефактов, воспроизводимость, интеграция в процессы).

Ключевой вывод: продукт готов к пилотам в инженерных командах, но для широкого внедрения внутри компаний нужны P0/P1 улучшения в UX, безопасности и совместной работе.

## Section B: Group Matrix

### Матрица по 6 группам

| Группа | Где ценность максимальна | Плюсы | Минусы/риски | Чего не хватает |
|---|---|---|---|---|
| QA / Test Automation | Воспроизводимость багов, triage flaky тестов | Intercept/mock, trace, HAR, управление cookies, правила | Нет "готовых QA-шаблонов" сценариев, ручной flow | Test presets, replay suites, экспорт "bug packet" |
| Web / Backend Dev | Отладка API, auth/cookies/headers, повтор запросов | Единая среда для перехвата и проверки гипотез, быстрый cycle | Шум интерфейса при сложных кейсах, мало быстрых guided-path | Dev shortcuts, comparison mode, "diff by request" UX |
| Security / AppSec | Анализ клиентского поведения и HTTP attack surface | MITM, interception, fingerprint profile, trace | Недостаточно controls для enterprise-security | Audit trail, sensitive-data redaction, policy mode |
| Support / SRE | Расследование инцидентов, handoff между командами | Логи, trace, HAR экспорт, события правил | Нет стандартизированного incident пакета | Incident bundle, case timeline, correlation tags |
| Anti-fraud / Anti-bot | Гипотезы по fingerprint/proxy behavior | TLS profile, proxy templates, rules/interceptor | Недостаточно автоматизации серий экспериментов | Experiment runner, run-to-run compare, scenario scripts |
| Tech Leads / Managers | Внедрение внутреннего инструмента в команды | Потенциально высокий ROI на debug/triage | Высокий риск "локального инструмента одного человека" | Onboarding path, ownership model, KPI dashboard |

## Section B.1: Детальный анализ по группам

### 1) QA / Test Automation Engineers

**Профиль и JTBD**
- 4-10+ лет в web/API тестировании, владение e2e и сервисными тестами.
- Ключевые задачи: быстро воспроизвести дефект, стабилизировать flaky проверки, подготовить доказательную базу для dev-команды.

**Плюсы**
- Mock/block/modify rules помогают изолировать проблемный внешний фактор.
- Trace + HAR ускоряют ретроспективу "что пошло не так".
- Cookie manager и tab isolation полезны для сценариев state-dependent багов.

**Минусы**
- Много ручной работы при сборе набора воспроизведения для баг-репорта.
- Нет преднастроенных QA-профилей под типовые кейсы (auth timeout, race, partial failure).
- Не хватает "step-by-step" flow для нового QA в команде.

**Чего не хватает**
- "QA Repro Pack": URL + cookies + selected requests + rules + trace в одном экспорте.
- Набор встроенных QA шаблонов interception.
- Batch replay для группы запросов в рамках сценария.

**Топ улучшений для QA**
- P0: экспорт bug reproduction pack.
- P1: библиотека QA presets.
- P1: request-set replay и compare.
- P2: интеграция с test management (Jira/Xray/TestRail payload).
- P2: автогенерация "repro steps draft" по логам.

### 2) Web / Backend Developers

**Профиль и JTBD**
- 5-12+ лет, ежедневно дебажат API, auth, retries, CORS, session/state issues.
- Цель: сократить time-to-fix сложных сетевых багов.

**Плюсы**
- Удобно проверять гипотезы через interception/rules без модификации сервиса.
- Сочетание browser контекста + network данных в одном месте.
- HAR/trace и request editor дают практический цикл "увидел -> изменил -> проверил".

**Минусы**
- Высокая когнитивная нагрузка при первых сессиях.
- Не все сценарии имеют "быстрый путь" (нужно много переключений между окнами).
- Нет достаточно мощного сравнения "до/после" в одном фокусе.

**Чего не хватает**
- Developer quick-actions (one-click mock for endpoint family, one-click header set).
- Сравнение двух request/response с акцентом на важные поля.
- Saved workspaces для повторяемых сервисных сценариев.

**Топ улучшений для Dev**
- P0: diff mode для request/response pair.
- P1: saved workspace + shortcuts.
- P1: quick actions для interceptor/rules.
- P2: plugin hooks под кастомные преобразования.
- P2: lightweight API for scripted workflows.

### 3) Security / AppSec / Pentest

**Профиль и JTBD**
- 7-12+ лет, фокус на безопасных проверках и контролируемом анализе поведения клиента.
- Нужна точность данных + строгие guardrails.

**Плюсы**
- MITM + interception дают полезную поверхность для динамических проверок.
- TLS profile/fingerprint полезен для исследования клиентской идентичности.
- Trace data повышает качество доказательной базы в security findings.

**Минусы/риски**
- Недостаточно встроенных механизмов redaction для чувствительных данных.
- Нет audit-level протокола "кто/что изменил" в правилах и сессиях.
- Риски хранения секретов/токенов без политики retention.

**Чего не хватает**
- Policy mode: запрет небезопасных операций без explicit confirm.
- Redaction profiles (PII/secrets) для UI/экспорта.
- Аудит действий пользователя внутри инструмента.

**Топ улучшений для AppSec**
- P0: data redaction pipeline + masked export.
- P0: security audit trail.
- P1: retention policy controls.
- P1: signed export artifacts.
- P2: role-based access mode для team usage.

### 4) Support / SRE / Incident Response

**Профиль и JTBD**
- 6-10+ лет, расследуют деградации и межкомандные инциденты.
- Основная ценность: быстро локализовать и передать артефакты дальше.

**Плюсы**
- Сильный базовый стек: timeline запросов, trace, HAR, replay.
- Можно быстро показать "симптом в трафике" для handoff в dev.

**Минусы**
- Нет компактного "incident narrative" формата.
- Сложно повторить анализ коллеги один-в-один.
- Нет нормализованных тегов для классификации кейсов.

**Чего не хватает**
- Incident bundle (данные + краткий контекст + таймлайн).
- Correlation labels/annotations на уровне кейса.
- Case templates для типовых инцидентов (latency/auth/ratelimit).

**Топ улучшений для SRE/Support**
- P0: incident bundle export/import.
- P1: annotations + tags + timeline notes.
- P1: canned incident templates.
- P2: агрегированный отчёт по повторяющимся сигнатурам.
- P2: интеграции с incident tools (PagerDuty/JSM payload).

### 5) Anti-fraud / Anti-bot Researchers

**Профиль и JTBD**
- 5-10+ лет, проводят controlled эксперименты над fingerprint/proxy behavior.
- Нужна воспроизводимость и сравнение серий запусков.

**Плюсы**
- TLS fingerprinting, proxy templates и interception хорошо подходят для гипотез.
- DNS overrides и правила повышают вариативность тестовых условий.

**Минусы**
- Мало нативной автоматизации для серий экспериментов.
- Недостаточная поддержка сравнения run-to-run.
- Отчётность по экспериментам не стандартизована.

**Чего не хватает**
- Experiment runner (матрица параметров).
- Сравнение прогонов по сигнальным метрикам.
- Сохранение экспериментальных профилей и результатов.

**Топ улучшений для Anti-fraud**
- P0: сценарный runner (profile x proxy x rule-set).
- P1: run comparison report.
- P1: experiment metadata schema.
- P2: DSL для экспериментальных сценариев.
- P2: integration API для external scoring.

### 6) Tech Leads / Engineering Managers

**Профиль и JTBD**
- 8-15+ лет, управляют внедрением внутренних dev-tools.
- Смотрят на ROI, риски, стандартизацию и ownership.

**Плюсы**
- Потенциал экономии времени на debug/triage.
- Унификация подхода к сетевому анализу в разных командах.

**Минусы**
- Нет явной модели ownership/поддержки.
- Нет измеримого dashboard по adoption/value.
- Сложно оценить риски governance без enterprise controls.

**Чего не хватает**
- Rollout blueprint (pilot -> scale).
- Governance policies и список guardrails.
- KPI dashboard и регулярный review cadence.

**Топ улучшений для менеджмента**
- P0: pilot framework + success metrics kit.
- P1: governance checklist + operational playbook.
- P1: usage analytics dashboard.
- P2: role-based onboarding tracks.
- P2: централизованная policy конфигурация.

## Section C: Unified Backlog P0/P1/P2

### P0 (критично для масштабного внедрения)
- Incident/Bug bundle export-import (единый артефакт для handoff).
- Data redaction и secure export (PII/secrets masking).
- Audit trail действий в правилах и сессиях.
- Diff mode для request/response сравнения.
- Experiment runner v1 для параметризованных прогонов.

### P1 (сильный рост ценности в командах)
- Presets library (QA, Dev, SRE, Security, Anti-fraud).
- Saved workspaces и сценарные shortcuts.
- Аннотации/теги/таймлайн заметки на уровне кейсов.
- Run comparison report.
- Governance playbook + onboarding tracks.

### P2 (стратегическое развитие)
- DSL/скрипты для экспериментов и сценариев.
- Интеграции в экосистему (incident, test, issue trackers).
- Централизованные policy controls для enterprise usage.
- KPI dashboard для менеджмента и platform teams.

## Section D: Risks and Dependencies

### Основные риски
- Продукт воспринимается как "нишевый тул одного инженера", а не командная платформа.
- Security-команды ограничат использование без redaction/audit controls.
- Высокий onboarding cost без role-based guided flows.

### Зависимости для реализации roadmap
- Дизайн единой модели артефактов (bundle schema).
- Компонентная переработка UX для сценарных режимов.
- Введение безопасного pipeline экспорта/хранения данных.
- Метрики usage/adoption с прозрачной телеметрией внутри продукта.

## Section E: Pilot Plan (4-6 weeks)

### Week 1: Подготовка пилота
- Выбрать 2-3 команды (QA + Dev + SRE).
- Зафиксировать baseline метрики: MTTR, время triage, доля воспроизводимых кейсов.
- Подготовить role-based сценарии использования.

### Week 2-3: Controlled usage
- Запуск с регламентом: какие кейсы решаем через CupNet.
- Сбор обратной связи по friction points.
- Промежуточные quick-fix корректировки UX.

### Week 4: Consolidation
- Свести количественные и качественные результаты.
- Зафиксировать список P0/P1 по факту пилота.
- Принять решение по масштабированию.

### Week 5-6: Scale readiness
- Подготовить onboarding pack.
- Утвердить governance и security guardrails.
- Определить owner team и cadence review.

## AI Prompt Pack for Repeatable Analysis

Ниже готовые промпты высокого уровня, которые можно запускать повторно при каждом релизе продукта.

### Universal system prompt

```text
Ты продуктовый аналитик B2B developer-tools с 12+ годами опыта в инструментах сетевой отладки и инженерных платформах.

Оцени продукт CupNet для указанной целевой группы.

Формат ответа:
1) Профиль группы и ключевые JTBD
2) Топ-7 плюсов продукта для группы
3) Топ-7 минусов/рисков с конкретикой
4) Чего не хватает (must-have / nice-to-have)
5) Приоритизация улучшений P0/P1/P2
6) Метрики, по которым можно доказать эффект

Ограничения:
- Только конкретные выводы, без общих формулировок.
- Для каждого минуса предложи проверяемую гипотезу улучшения.
- Учитывай onboarding, security, governance и операционную стоимость внедрения.
```

### Persona prompts

#### QA / Test Automation

```text
Ты Senior QA Architect с 10+ годами опыта в e2e и API automation.
Ты отвечаешь за flaky triage, воспроизводимость и скорость передачи багов в разработку.

Проанализируй CupNet для QA:
- Какие сценарии triage ускоряются?
- Где инструмент не закрывает системные QA боли?
- Какие функции нужны, чтобы сделать его ежедневным QA инструментом?

Дай: плюсы, минусы, чего не хватает, P0/P1/P2, KPI эффекта.
```

#### Web / Backend Developer

```text
Ты Principal Engineer с 12+ годами в web/backend разработке и production debugging.
Твоя задача: оценить CupNet как ежедневный инструмент разработки.

Фокус:
- Отладка auth/cookies/headers/retries/caching
- Скорость цикла "гипотеза -> проверка -> фиксация"
- Сравнение с DevTools + Charles/Proxyman/mitmproxy

Ответ: плюсы, минусы, пробелы, приоритеты улучшений, критерии adoption.
```

#### Security / AppSec

```text
Ты Lead AppSec Engineer с 10+ годами опыта в web security testing.
Оцени CupNet с позиции безопасного анализа и enterprise readiness.

Проверь:
- Точность и полнота артефактов
- Риски хранения/экспорта чувствительных данных
- Аудитируемость действий и governance

Ответ: плюсы, риски, чего не хватает, P0/P1/P2, guardrails/hardening.
```

#### Support / SRE / Incident Response

```text
Ты Staff SRE с 9+ годами в incident investigation.
Оцени CupNet как инструмент для снижения MTTD/MTTR и улучшения handoff.

Проверь:
- Насколько быстро локализуется корень проблемы
- Насколько легко передать кейс между командами
- Какие артефакты отсутствуют для postmortem

Ответ: плюсы, минусы, пробелы, P0/P1/P2, метрики результата.
```

#### Anti-fraud / Anti-bot

```text
Ты Senior Anti-Fraud Research Engineer с 8+ годами опыта.
Оцени CupNet для controlled экспериментов по fingerprint/proxy behavior.

Проверь:
- Воспроизводимость экспериментов
- Качество сравнения разных прогонов
- Ограничения для глубокой проверки антибот-гипотез

Ответ: плюсы, минусы, чего не хватает, P0/P1/P2, регулярные сценарии.
```

#### Tech Leads / Engineering Managers

```text
Ты Engineering Manager с 12+ годами опыта внедрения внутренних dev-tools.
Оцени CupNet с позиции ROI, масштабирования и governance.

Проверь:
- Где продукт дает максимальный эффект для команд
- Какие барьеры внедрения и владения
- Что нужно для масштабирования внутри организации

Ответ: плюсы, минусы, пробелы, rollout plan, KPI внедрения.
```

