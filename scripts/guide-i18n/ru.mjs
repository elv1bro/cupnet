/** Руководство RU — та же структура и якоря, что EN */
export default function ru(kbdRow) {
    return `
<div class="g-hero">
    <img src="img.png" class="g-hero-logo" alt="CupNet">
    <div>
        <h1 class="g-hero-title">CupNet — Руководство</h1>
        <div class="g-hero-sub">Браузер для отладки трафика · встроенный MITM · AzureTLS · логи SQLite</div>
        <div style="margin-top:6px">
            <span class="g-pill">v2.0</span><span class="g-pill">SQLite</span>
            <span class="g-pill">CDP</span><span class="g-pill">AzureTLS</span>
        </div>
    </div>
</div>

<div id="brief" class="g-card g-brief">
    <h2>Кратко</h2>
    <ul>
        <li><b>Суть:</b> Electron-браузер: трафик вкладок идёт через стек CupNet — опциональный upstream-прокси, MITM HTTPS на <b>8877</b>, исходящий TLS через worker <b>AzureTLS</b> (JA3 / HTTP2 как у выбранного браузера).</li>
        <li><b>Логи:</b> события пишутся в <b>SQLite</b> (CDP + путь MITM). Кнопка <b>REC</b> в тулбаре включает/останавливает запись; <b>Log</b> открывает просмотрщик (FTS, HAR, replay, trace, сравнение запросов).</li>
        <li><b>Менеджер прокси:</b> профили с шифрованием в OS keychain, <b>Apply globally</b> / <b>Apply to active tab</b>, живая статистика MITM в шапке окна (req/s, задержка, ошибки, TLS-профиль).</li>
        <li><b>Тулбар:</b> DNS, редактор запросов, правила и перехват, анализатор страницы, системная консоль, настройки (отдельное окно).</li>
        <li><b>Стартовая страница:</b> поиск, быстрые ссылки, виджет прокси/IP (бейдж MITM, область прокси для вкладки), переключатель cookies <b>Shared / Isolated</b>, <b>внешний proxy</b> для curl и скриптов.</li>
        <li><b>Доверие:</b> встроенные вкладки CupNet автоматически доверяют CA MITM. Для внешних программ — файл PEM в user-data (см. <a href="#mitm">MITM и CA</a>) или маршрутизация через внешний proxy.</li>
    </ul>
</div>

<div class="g-card g-toc">
    <h2>Содержание</h2>
    <a href="#brief">0. Кратко</a>
    <a href="#gs">1. Быстрый старт</a>
    <a href="#traffic">2. Путь трафика и запись</a>
    <a href="#proxy">3. Менеджер прокси</a>
    <a href="#fingerprint">4. Отпечаток и TLS</a>
    <a href="#toolbar">5. Панель инструментов</a>
    <a href="#hotkeys">6. Горячие клавиши</a>
    <a href="#logs">7. Сетевые логи · Trace · Compare</a>
    <a href="#editor">8. Редактор запросов</a>
    <a href="#rules">9. Правила и перехват</a>
    <a href="#cookies">10. Менеджер cookies</a>
    <a href="#isolated">11. Изолированные вкладки</a>
    <a href="#dns">12. Подмена DNS</a>
    <a href="#analyzer">13. Анализатор страницы</a>
    <a href="#console">14. Системная консоль</a>
    <a href="#newtab">15. Стартовая страница</a>
    <a href="#settings">16. Окно настроек</a>
    <a href="#mitm">17. MITM · Файл CA · Обход доменов</a>
    <a href="#issues">18. Частые проблемы</a>
</div>

<div id="gs" class="g-card">
    <h2>1) Быстрый старт</h2>
    <ol>
        <li>Из папки проекта: <code>ELECTRON_RUN_AS_NODE= npm start</code> (IDE вроде Cursor могут выставить <code>ELECTRON_RUN_AS_NODE=1</code> — обнуляйте для запуска Electron).</li>
        <li>Открывается главное окно: таб-бар и строка навигации. В адресной строке — URL или поисковый запрос.</li>
        <li>Для записи новых запросов в БД должен быть включён <b>REC</b>; на плашке <b>Log #N</b> — номер сессии и счётчик.</li>
        <li>Клик по <b>таблетке прокси</b> (слева от адреса) открывает Менеджер прокси — подключите upstream или оставайтесь в режиме только локального MITM.</li>
        <li>Новая вкладка: <kbd>Ctrl T</kbd> или <b>+</b>. Изолированная: <kbd>Ctrl ⇧T</kbd> или <b>+🔒</b>.</li>
    </ol>
    <div class="g-tip">Работа без upstream — нормальное состояние. При активном MITM AzureTLS по-прежнему формирует TLS к серверам.</div>
</div>

<div id="traffic" class="g-card">
    <h2>2) Путь трафика и запись</h2>
    <p>Вкладки направляют Chromium на локальный MITM CupNet (<b>127.0.0.1:8877</b>). Расшифрованный HTTPS идёт в <b>AzureTLS worker</b> — для сайта это выглядит как рукопожатие настоящего браузера (профиль из настроек профиля или умолчания).</p>
    <ul>
        <li><b>REC</b> — левая часть плашки Log: при OFF новые строки в БД (и зависящие функции вроде части автоскриншотов) не копятся.</li>
        <li>При переключении REC может появиться выбор: продолжить текущую сессию логов или начать новую.</li>
        <li>Баннер <b>mitm-init</b> на стартовой странице — стек сети ещё поднимается; первые секунды загрузка может быть медленнее.</li>
    </ul>
    <div class="g-tip success">Правила подсветки срабатывают после записи ответа. Перехват (mock/block/заголовки) в режиме MITM выполняется в контуре MITM, а не через protocol.handle страницы — стабильнее для строгих антиботов.</div>
</div>

<div id="proxy" class="g-card">
    <h2>3) Менеджер прокси</h2>
    <p>Открытие: таблетка в тулбаре или ссылка <b>Manage →</b> на стартовой странице. Схемы: <code>http</code>, <code>https</code>, <code>socks4</code>, <code>socks5</code>.</p>
    <h3>Профили</h3>
    <ul>
        <li><b>+ New</b> и список слева — имя, шаблон URL, заметки.</li>
        <li>Секреты хранятся через OS keychain (<code>safeStorage</code>), не в открытом виде в SQLite.</li>
        <li><b>⚡ Test</b> — развернуть переменные, замерить задержку, показать IP/гео/ASN.</li>
        <li><b>Apply globally</b> — подключить профиль для всего браузера (если нет переопределения на вкладку).</li>
        <li><b>Apply to active tab</b> — применить текущую форму (SID, RAND и т.д.) только к активной вкладке.</li>
        <li><b>⧉ Copy</b> — дублировать профиль; <b>✕ Delete</b> — удалить; <b>✕ Disconnect</b> — снять upstream.</li>
    </ul>
    <h3>Шаблоны</h3>
    <div class="g-tip">
        <code>{RAND:min-max}</code> — новое случайное число при каждом подключении<br>
        <code>{SID}</code> — эфемерный ID (пустой → автогенерация <code>cupnet</code> + цифры)<br>
        <code>{ИМЯ}</code> — значение из таблицы переменных профиля
    </div>
    <details><summary>Пример</summary>
        <pre>socks5://user-{SID}:{PASSWORD}@{COUNTRY}.provider.com:{RAND:10000-19999}</pre>
    </details>
    <h3>Статистика в шапке (MITM / AzureTLS)</h3>
    <p>Живые req/s, средняя задержка, число pending-запросов, всего обработано, счётчик ошибок и активный TLS-профиль — удобно ловить «залипший» upstream или перегруз worker.</p>
    <span class="g-status ok">✓ После глобального Connect активная вкладка обычно перезагружается, чтобы встать в новую цепочку.</span>
</div>

<div id="fingerprint" class="g-card">
    <h2>4) Отпечаток и TLS</h2>
    <p>Секция <b>🎭 Fingerprint / Identity</b> внутри редактирования профиля. Применяется при Connect / Apply.</p>
    <h3>HTTP / CDP</h3>
    <ul>
        <li><b>User-Agent</b> — пресеты (Chrome Win/Mac, Firefox, Safari, Mobile): заголовки и <code>navigator.userAgent</code>.</li>
        <li><b>Timezone</b> — зоны из списка, влияет на <code>Intl</code> и <code>Date</code>.</li>
        <li><b>Language</b> — <code>Accept-Language</code> и <code>navigator.language</code>.</li>
    </ul>
    <h3>TLS (AzureTLS)</h3>
    <ul>
        <li>Режим <b>Template</b> — Chrome 133, Firefox 138, Safari 18, iOS 18, Edge 133, Opera 119 (как в UI).</li>
        <li>Режим <b>Custom JA3</b> — вручную строка JA3; кнопки-prefill подставляют эталон из шаблона.</li>
    </ul>
    <p><b>⚡ Traffic Optimization</b> — мастер-переключатель и фильтры по типам ресурсов (картинки, CSS, шрифты, медиа, WebSocket) с whitelist для captcha-доменов.</p>
    <div class="g-tip success">Disconnect сбрасывает глобальные оверрайды. Привязка «только эта вкладка» исчезает при закрытии вкладки.</div>
</div>

<div id="toolbar" class="g-card">
    <h2>5) Панель инструментов</h2>
    ${kbdRow('← → ↻ ⌂', 'Назад / Вперёд / Обновить / Домой (стартовая страница)')}
    ${kbdRow('Таблетка прокси', 'Direct или имя профиля + подпись. Открывает Менеджер прокси. Бейдж режима при MITM.')}
    ${kbdRow('Адресная строка', 'URL или поиск, Enter')}
    <hr class="g-hr" style="margin:10px 0">
    ${kbdRow('<b>REC · Log #N</b>', 'REC — запись в БД вкл/выкл. Log — просмотрщик; # — сессия и счётчик.')}
    ${kbdRow('<b>DevTools</b>', 'Инструменты активной вкладки. Также <kbd>F12</kbd>.')}
    ${kbdRow('<b>Cookies</b>', 'Менеджер cookies')}
    ${kbdRow('<b>DNS</b>', 'Подмена DNS (бейдж — число срабатываний)')}
    ${kbdRow('<b>Req Editor</b>', 'Редактор HTTP-запросов')}
    ${kbdRow('<b>Rules</b>', 'Правила и перехват (бейдж — hits)')}
    ${kbdRow('<b>Analyzer</b>', 'Анализатор: формы, captcha, endpoint scout')}
    ${kbdRow('<b>Console</b>', 'Системная консоль — логи процесса')}
    ${kbdRow('<b>Settings</b>', 'Окно настроек: General / Tracking / Devices / Performance')}
</div>

<div id="hotkeys" class="g-card">
    <h2>6) Горячие клавиши</h2>
    <p>На macOS вместо <kbd>Ctrl</kbd> используйте <kbd>⌘</kbd> там, где в меню указано CmdOrCtrl. Те же действия есть в меню приложения.</p>
    <h3>Вкладки и навигация</h3>
    ${kbdRow('<kbd>Ctrl T</kbd>', 'Новая вкладка')}
    ${kbdRow('<kbd>Ctrl ⇧T</kbd>', 'Новая изолированная вкладка')}
    ${kbdRow('<kbd>Ctrl W</kbd>', 'Закрыть активную')}
    ${kbdRow('<kbd>Ctrl Tab</kbd> / <kbd>Ctrl ⇧Tab</kbd>', 'Следующая / предыдущая вкладка')}
    ${kbdRow('<kbd>Ctrl 1-9</kbd>', 'Фокус на вкладку N (9 = последняя)')}
    ${kbdRow('<kbd>Ctrl L</kbd>', 'Фокус в адресной строке')}
    ${kbdRow('<kbd>Ctrl R</kbd> / <kbd>F5</kbd>', 'Обновить')}
    ${kbdRow('<kbd>Ctrl ⇧R</kbd>', 'Жёсткое обновление (без кэша)')}
    ${kbdRow('<kbd>Alt ←</kbd> / <kbd>Alt →</kbd>', 'Назад / вперёд')}
    <h3>Инструменты</h3>
    ${kbdRow('<kbd>Ctrl P</kbd>', 'Менеджер прокси')}
    ${kbdRow('<kbd>Ctrl ⇧L</kbd>', 'Сетевые логи')}
    ${kbdRow('<kbd>Ctrl Alt C</kbd>', 'Менеджер cookies (mac: ⌘⌥C)')}
    ${kbdRow('<kbd>Ctrl ⇧M</kbd>', 'DNS Manager (пункт меню)')}
    ${kbdRow('<kbd>Ctrl ⇧A</kbd>', 'Page Analyzer')}
    ${kbdRow('<kbd>Ctrl ⇧K</kbd>', 'System Console')}
    ${kbdRow('<kbd>F2</kbd>', 'Скриншот сейчас')}
    ${kbdRow('<kbd>F12</kbd>', 'DevTools — активная вкладка')}
    ${kbdRow('<kbd>Ctrl ⇧I</kbd>', 'DevTools — оболочка браузера')}
</div>

<div id="logs" class="g-card">
    <h2>7) Сетевые логи · Trace · Compare</h2>
    <p>HTTP(S) и WebSocket попадают в SQLite: URL, метод, заголовки, тела (в т.ч. бинарные в пригодном виде), длительности, скриншоты отдельными строками.</p>
    <ul>
        <li><b>Фильтры</b> — метод, статус, content-type, вкладка, сессия.</li>
        <li><b>FTS</b> — полнотекст по URL и телу ответа.</li>
        <li><b>Export HAR</b> — HAR 1.2 для Charles, DevTools и др.</li>
        <li><b>Replay</b> — открыть запись в Редакторе запросов.</li>
        <li><b>Trace</b> — полные снимки req/resp в БД; ⌘/Ctrl+клик открывает окно Trace viewer.</li>
        <li><b>Compare</b> — добавить запрос в слот A/B и открыть окно сравнения.</li>
        <li><b>Сессии</b> — переключение, переименование, удаление.</li>
    </ul>
    <h3>Автоскриншоты</h3>
    <p>Интервал и триггеры — <b>Settings → Tracking</b> (и связанные поля в General). Повторяющиеся кадры отбрасываются. Документ стартовой страницы в лог не пишется и не скриншотится намеренно.</p>
</div>

<div id="editor" class="g-card">
    <h2>8) Редактор запросов</h2>
    <p>Отправка через <code>net.fetch</code> Electron — мягче ограничения, чем у sandbox renderer.</p>
    <ul>
        <li>Метод, URL, таблица query, заголовки, тело (None / Raw / JSON / form).</li>
        <li>Опционально свой TLS-профиль на запрос.</li>
        <li>Панель ответа: статус, заголовки, форматирование JSON, тайминги.</li>
        <li><b>Copy as cURL</b>.</li>
    </ul>
    <div class="g-tip">Заголовки с ★ / системные могут быть переписаны сетевым стеком.</div>
</div>

<div id="rules" class="g-card">
    <h2>9) Правила и перехват</h2>
    <p>Кнопка <b>Rules</b> — два типа правил.</p>
    <h3>Highlight Rules</h3>
    <p>После выполнения запроса: условия по URL, методу, статусу, MIME, длительности, хосту, телам, ошибкам — операторы <code>contains</code>, <code>equals</code>, regex, сравнения. Действия: подсветка, скриншот, уведомление, block-mark в логе.</p>
    <h3>Interceptor</h3>
    <p>До сети: шаблоны с <code>*</code>. Действия: <b>block</b>, изменение заголовков запроса/ответа, <b>mock</b> ответа.</p>
    <div class="g-tip">В режиме <b>MITM</b> перехват совместим с политикой CupNet: не переводить весь HTTPS на protocol.handle вкладки — иначе вы меняете клиентский стек и рискуете триггерами у Cloudflare/Turnstile.</div>
</div>

<div id="cookies" class="g-card">
    <h2>10) Менеджер cookies</h2>
    <ul>
        <li>Выбор сессии/вкладки, поиск, правки inline, импорт/экспорт JSON или Netscape <code>cookies.txt</code> (до ~10 МБ в импорте).</li>
        <li><b>Current tab</b> — фильтр по домену активной навигации.</li>
        <li><b>Share to tab</b> — копирование между shared/isolated сессиями с фильтром по домену.</li>
    </ul>
</div>

<div id="isolated" class="g-card">
    <h2>11) Изолированные вкладки</h2>
    <p><b>+🔒</b> — отдельная partition Chromium: свои cookies, кэш, storage. Закрытие вкладки удаляет данные. Нужны cookies — экспорт до закрытия.</p>
    <div class="g-tip success">Удобно для параллельных аккаунтов и «чистых» регистраций.</div>
</div>

<div id="dns" class="g-card">
    <h2>12) Подмена DNS</h2>
    <p>Кнопка <b>DNS</b> открывает менеджер записей host → IP. Для wildcard-хостов при HTTPS могут понадобиться опции MITM CORS — предупреждение в интерфейсе.</p>
</div>

<div id="analyzer" class="g-card">
    <h2>13) Анализатор страницы</h2>
    <p>Отдельное окно: формы, эвристики captcha, собранные endpoints, действия по вкладке. Обновляйте снимок при переходах между страницами.</p>
</div>

<div id="console" class="g-card">
    <h2>14) Системная консоль</h2>
    <p>Поток stdout/stderr главного процесса и связанные сообщения. Сохранение буфера в файл — через UI окна.</p>
</div>

<div id="newtab" class="g-card">
    <h2>15) Стартовая страница</h2>
    <ul>
        <li><b>Поиск</b> — движки DDG / Google / Yandex / Bing, выбор сохраняется в <code>localStorage</code>.</li>
        <li><b>Quick Links</b> — URL или ярлык профиля прокси; <b>📖 Guide</b> открывает это руководство во вкладке.</li>
        <li><b>Виджет прокси/IP</b> — статус, бейдж MITM, upstream, внешний IP и гео, плашка Global vs имя профиля для вкладки.</li>
        <li><b>Cookie bar</b> — Shared / Isolated, счётчик, Open, Clear all с подтверждением.</li>
        <li><b>External proxy</b> — слушатель HTTP на выбранном порте: curl/скрипты/LAN идут через CupNet (TLS + логи). Только при активном MITM; иначе виджет покажет подсказку.</li>
    </ul>
</div>

<div id="settings" class="g-card">
    <h2>16) Окно настроек</h2>
    <p><b>Settings</b> в тулбаре открывает отдельное окно (не выдвижная панель под адресом).</p>
    <h3>General</h3>
    <ul>
        <li><b>Unblock copy / paste</b> — не даём сайтам блокировать Ctrl+C/V и вставку из контекстного меню.</li>
        <li><b>MITM bypass domains</b> — строка на паттерн; совпадения идут мимо MITM (полезно для встроенных challenge).</li>
        <li><b>URL filter patterns</b> — glob построчно; совпадения не пишутся в лог после <b>Save filters</b>.</li>
    </ul>
    <h3>Tracking</h3>
    <p>Что может вызывать автоскриншоты: клик, окончание загрузки, изменение «pending» сети, активность мыши, пауза ввода, окончание скролла, срабатывание правил. Пороги и лимиты настраиваются.</p>
    <h3>Devices</h3>
    <p>Режимы и приоритеты камеры/микрофона для getUserMedia.</p>
    <h3>Performance</h3>
    <p>Таблица процессов Browser/Renderer/GPU/Utility с CPU и памятью, обновление каждые несколько секунд.</p>
</div>

<div id="mitm" class="g-card">
    <h2>17) MITM · Файл CA · Обход доменов</h2>
    <p>Локальный MITM на <b>8877</b> завершает TLS своим CA, при необходимости логирует содержимое, затем строит новое TLS к upstream через AzureTLS.</p>
    <h3>Доверие внутри CupNet</h3>
    <p>Вкладки приложения получают доверие к этому CA через код инициализации — отдельно импортировать сертификат для обычной работы браузера обычно <b>не</b> нужно.</p>
    <h3>Файл для внешних программ</h3>
    <p>Публичный PEM записывается в каталог данных приложения:</p>
    <ul>
        <li><b>macOS:</b> <code>~/Library/Application Support/CupNet/mitm-ca/ca-cert.pem</code></li>
        <li><b>Windows:</b> <code>%APPDATA%\\CupNet\\mitm-ca\\ca-cert.pem</code></li>
        <li><b>Linux:</b> <code>~/.config/CupNet/mitm-ca/ca-cert.pem</code></li>
    </ul>
    <p>Импортируйте в доверенные только на контролируемых машинах. Для CLI предпочтительнее поднимать <b>External proxy</b> на стартовой странице и слать трафик через него.</p>
    <h3>Обход (bypass)</h3>
    <p>Список в <b>Settings → General → MITM bypass domains</b>, синхронизируется с поведением MITM.</p>
    <span class="g-status warn">⚠ Не устанавливайте чужие CA и не распространяйте свой PEM публично.</span>
</div>

<div id="issues" class="g-card">
    <h2>18) Частые проблемы</h2>
    <ul>
        <li><b>Не стартует из IDE</b> — внешний терминал: <code>ELECTRON_RUN_AS_NODE= npm start</code>.</li>
        <li><b>Нативный модуль</b> — <code>npm run rebuild:arm64</code> (Apple Silicon) или <code>npx electron-rebuild</code>.</li>
        <li><b>SSL в логах / ошибки upstream</b> — проверить прокси кнопкой Test, счётчик err в статистике MITM.</li>
        <li><b>Captcha / CF «крутит»</b> — добавьте challenge-домены в bypass; не смешивайте перехват через protocol.handle всего HTTPS с MITM-режимом.</li>
        <li><b>Внешний proxy не стартует</b> — нужен MITM-режим трафика; текст ошибки на карточке.</li>
        <li><b>Лог пуст при открытых сайтах</b> — проверьте, что <b>REC</b> включён.</li>
    </ul>
    <details><summary>Команды разработчика</summary>
        <pre>cd node/cupnet2
npm install --ignore-scripts
npm run rebuild:arm64
ELECTRON_RUN_AS_NODE= npm start</pre>
    </details>
</div>

<div class="g-footer">© CupNet 2.0 — Все права защищены.</div>
`;
}
