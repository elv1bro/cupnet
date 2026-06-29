'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const { networkPolicy, computeBackoffMs } = require('./network-policy');
const { safeCatch } = require('./sys-log');

let db = null;
let _writeQueueHigh = [];
let _writeQueueLow = [];
let _writeQueueProcessing = false;
let _writeQueueDroppedLow = 0;
let _writeQueueDroppedHigh = 0;
let _writeQueueBusyRetries = 0;
/** Fair scheduling: after 3 high-priority tasks, take one low if available (M5). */
let _fairHighStreak = 0;

function isBusyError(e) {
    const msg = String(e?.message || e || '');
    return e?.code === 'SQLITE_BUSY' || msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
}

function _busyDelayMs(attempt) {
    const jitter = computeBackoffMs(attempt);
    return Math.min(
        networkPolicy.db.busyMaxDelayMs,
        networkPolicy.db.busyBaseDelayMs + jitter
    );
}

function _scheduleWriteProcessing() {
    if (_writeQueueProcessing) return;
    _writeQueueProcessing = true;
    setImmediate(_processWriteQueue);
}

function enqueueWrite(task, priority = 'high') {
    return new Promise((resolve, reject) => {
        const q = priority === 'low' ? _writeQueueLow : _writeQueueHigh;
        const limit = priority === 'low'
            ? networkPolicy.db.writeQueueMaxLow
            : networkPolicy.db.writeQueueMaxHigh;
        if (q.length >= limit) {
            if (priority === 'low') {
                _writeQueueDroppedLow++;
            } else {
                _writeQueueDroppedHigh++;
            }
            const overflowErr = new Error(`DB write queue overflow (${priority})`);
            safeCatch({
                module: 'db',
                eventCode: 'db.queue.overflow',
                context: { priority, limit, queueDepth: q.length },
            }, overflowErr, 'warn');
            reject(overflowErr);
            return;
        }
        q.push({
            fn: task,
            resolve,
            reject,
            attempt: 0,
            priority,
        });
        _scheduleWriteProcessing();
    });
}

function _takeNextWriteTask() {
    if (_writeQueueLow.length > 0 && _fairHighStreak >= 3) {
        _fairHighStreak = 0;
        return _writeQueueLow.shift();
    }
    if (_writeQueueHigh.length > 0) {
        _fairHighStreak++;
        return _writeQueueHigh.shift();
    }
    _fairHighStreak = 0;
    if (_writeQueueLow.length > 0) return _writeQueueLow.shift();
    return null;
}

function _requeueWriteTask(task, delayMs) {
    setTimeout(() => {
        const q = task.priority === 'low' ? _writeQueueLow : _writeQueueHigh;
        q.unshift(task);
        _scheduleWriteProcessing();
    }, delayMs);
}

function _processWriteQueue() {
    const task = _takeNextWriteTask();
    if (!task) {
        _writeQueueProcessing = false;
        return;
    }
    try {
        const result = task.fn();
        task.resolve(result);
        setImmediate(_processWriteQueue);
    } catch (e) {
        if (isBusyError(e) && task.attempt < networkPolicy.db.busyRetries) {
            task.attempt++;
            _writeQueueBusyRetries++;
            const delay = _busyDelayMs(task.attempt);
            _requeueWriteTask(task, delay);
        } else {
            safeCatch({
                module: 'db',
                eventCode: 'db.write.failed',
                context: { priority: task.priority, attempt: task.attempt },
            }, e, 'warn');
            task.reject(e);
            setImmediate(_processWriteQueue);
        }
    }
}

function getDbPath() {
    return path.join(app.getPath('userData'), 'cupnet.db');
}

/**
 * Initialize with an explicit file path.
 * Used by unit tests to avoid requiring Electron's app.getPath.
 */
function initWithPath(dbPath) {
    if (db) return db;
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    createSchema();
    migrateSchema();
    _prepareStmts();
    return db;
}

function init() {
    return initWithPath(getDbPath());
}

/** Add commercial intercept_rules columns for existing DBs (idempotent). */
function migrateInterceptRulesCommercialColumns() {
    const ir = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='intercept_rules'`).get();
    if (!ir) return;
    let cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    const add = (sql) => {
        try {
            db.exec(sql);
        } catch { /* ignore */ }
    };
    if (!cols.includes('priority')) add(`ALTER TABLE intercept_rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('method')) add(`ALTER TABLE intercept_rules ADD COLUMN method TEXT DEFAULT '*'`); // NOSONAR
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('group_name')) add(`ALTER TABLE intercept_rules ADD COLUMN group_name TEXT DEFAULT NULL`);
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('hit_count')) add(`ALTER TABLE intercept_rules ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0`);
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('last_hit_at')) add(`ALTER TABLE intercept_rules ADD COLUMN last_hit_at TEXT DEFAULT NULL`);
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('delay_ms')) add(`ALTER TABLE intercept_rules ADD COLUMN delay_ms INTEGER NOT NULL DEFAULT 0`);
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('tags')) add(`ALTER TABLE intercept_rules ADD COLUMN tags TEXT DEFAULT NULL`);
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('last_error')) add(`ALTER TABLE intercept_rules ADD COLUMN last_error TEXT DEFAULT NULL`);
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('stop_on_match')) add(`ALTER TABLE intercept_rules ADD COLUMN stop_on_match INTEGER NOT NULL DEFAULT 1`);
    cols = db.pragma('table_info(intercept_rules)').map((c) => c.name);
    if (!cols.includes('breakpoint_enabled')) add(`ALTER TABLE intercept_rules ADD COLUMN breakpoint_enabled INTEGER NOT NULL DEFAULT 0`);
}

function migrateSchema() {
    // Add new columns to proxy_profiles if they don't exist (for existing DBs)
    let cols = db.pragma('table_info(proxy_profiles)').map(c => c.name);
    if (!cols.includes('is_template'))     db.exec(`ALTER TABLE proxy_profiles ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('variables'))       db.exec(`ALTER TABLE proxy_profiles ADD COLUMN variables TEXT`);
    if (!cols.includes('notes'))           db.exec(`ALTER TABLE proxy_profiles ADD COLUMN notes TEXT`);
    if (!cols.includes('last_ip'))         db.exec(`ALTER TABLE proxy_profiles ADD COLUMN last_ip TEXT`);
    if (!cols.includes('last_geo'))        db.exec(`ALTER TABLE proxy_profiles ADD COLUMN last_geo TEXT`);
    if (!cols.includes('sort_order'))      db.exec(`ALTER TABLE proxy_profiles ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    // Fingerprint / Identity fields
    if (!cols.includes('user_agent'))      db.exec(`ALTER TABLE proxy_profiles ADD COLUMN user_agent TEXT`);
    if (!cols.includes('timezone'))        db.exec(`ALTER TABLE proxy_profiles ADD COLUMN timezone TEXT`);
    if (!cols.includes('language'))        db.exec(`ALTER TABLE proxy_profiles ADD COLUMN language TEXT`);
    // TLS fingerprint fields
    if (!cols.includes('tls_profile'))     db.exec(`ALTER TABLE proxy_profiles ADD COLUMN tls_profile TEXT DEFAULT 'chrome'`);
    if (!cols.includes('tls_ja3_mode'))    db.exec(`ALTER TABLE proxy_profiles ADD COLUMN tls_ja3_mode TEXT DEFAULT 'template'`);
    if (!cols.includes('tls_ja3_custom'))  db.exec(`ALTER TABLE proxy_profiles ADD COLUMN tls_ja3_custom TEXT`);
    if (!cols.includes('traffic_mode'))    db.exec(`ALTER TABLE proxy_profiles ADD COLUMN traffic_mode TEXT NOT NULL DEFAULT 'mitm'`);
    db.exec(`UPDATE proxy_profiles SET traffic_mode='mitm' WHERE traffic_mode IS NULL OR traffic_mode='' OR traffic_mode='browser_proxy'`);
    // Legacy DBs: columns referenced by getProxyProfiles() but missing on very old installs
    cols = db.pragma('table_info(proxy_profiles)').map((c) => c.name);
    if (!cols.includes('last_tested_at'))  db.exec(`ALTER TABLE proxy_profiles ADD COLUMN last_tested_at TEXT`);
    if (!cols.includes('last_latency_ms')) db.exec(`ALTER TABLE proxy_profiles ADD COLUMN last_latency_ms INTEGER`);
    if (!cols.includes('created_at')) {
        db.exec(`ALTER TABLE proxy_profiles ADD COLUMN created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    }
    // Screenshots: add BLOB column for binary storage (33% smaller than base64 TEXT)
    const ssCols = db.pragma('table_info(screenshots)').map(c => c.name);
    if (!ssCols.includes('data_blob'))       db.exec(`ALTER TABLE screenshots ADD COLUMN data_blob BLOB`);
    if (!ssCols.includes('screenshot_meta')) db.exec(`ALTER TABLE screenshots ADD COLUMN screenshot_meta TEXT`);
    // External proxy ports: track session source
    const sessCols = db.pragma('table_info(sessions)').map(c => c.name);
    if (!sessCols.includes('source'))      db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'browser'`);
    if (!sessCols.includes('ext_port'))    db.exec(`ALTER TABLE sessions ADD COLUMN ext_port INTEGER`);
    // Requests: manual tags/notes + cached host
    const reqCols = db.pragma('table_info(requests)').map(c => c.name);
    if (!reqCols.includes('host'))         db.exec(`ALTER TABLE requests ADD COLUMN host TEXT`);
    if (!reqCols.includes('tag'))          db.exec(`ALTER TABLE requests ADD COLUMN tag TEXT`);
    if (!reqCols.includes('note'))         db.exec(`ALTER TABLE requests ADD COLUMN note TEXT`);
    if (!reqCols.includes('has_note'))     db.exec(`ALTER TABLE requests ADD COLUMN has_note INTEGER NOT NULL DEFAULT 0`);
    if (!reqCols.includes('ws_message_count')) db.exec(`ALTER TABLE requests ADD COLUMN ws_message_count INTEGER NOT NULL DEFAULT 0`);
    const dnsCols = db.pragma('table_info(dns_overrides)').map(c => c.name);
    if (!dnsCols.includes('mitm_inject_cors')) {
        db.exec(`ALTER TABLE dns_overrides ADD COLUMN mitm_inject_cors INTEGER NOT NULL DEFAULT 0`);
    }
    if (!dnsCols.includes('rewrite_host')) {
        db.exec(`ALTER TABLE dns_overrides ADD COLUMN rewrite_host TEXT`);
    }
    // ws_events.connection_id: must run AFTER createSchema; index only if column exists (new DB or post-ALTER).
    const wsCols = db.pragma('table_info(ws_events)').map(c => c.name);
    if (wsCols.length && !wsCols.includes('connection_id')) {
        db.exec(`ALTER TABLE ws_events ADD COLUMN connection_id TEXT`);
    }
    if (db.pragma('table_info(ws_events)').map(c => c.name).includes('connection_id')) {
        try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_ws_events_conn ON ws_events(session_id, tab_id, url, connection_id)`);
        } catch { /* ignore */ }
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_host ON requests(host)`);
    } catch { /* ignore */ }
    // browser_events: Activity Monitor (console, storage, exceptions)
    const beTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='browser_events'`).get();
    if (!beTable) {
        db.exec(`
            CREATE TABLE browser_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
                tab_id      TEXT,
                event_type  TEXT    NOT NULL,
                level       TEXT,
                summary     TEXT    NOT NULL,
                detail      TEXT,
                source_url  TEXT,
                source_line INTEGER,
                origin      TEXT,
                created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_bevents_session ON browser_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_bevents_tab     ON browser_events(tab_id);
            CREATE INDEX IF NOT EXISTS idx_bevents_type    ON browser_events(event_type);
        `);
    }
    // System Console (main process stdout/stderr structured capture)
    const clTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='console_logs'`).get();
    if (!clTable) {
        db.exec(`
            CREATE TABLE console_logs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
                ts          INTEGER NOT NULL,
                level       TEXT    NOT NULL,
                source      TEXT,
                module      TEXT,
                stream      TEXT,
                text        TEXT    NOT NULL,
                created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_console_logs_session ON console_logs(session_id);
            CREATE INDEX IF NOT EXISTS idx_console_logs_ts ON console_logs(ts);
            CREATE INDEX IF NOT EXISTS idx_console_logs_created ON console_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_console_logs_level ON console_logs(level);
        `);
    }
    // intercept_rules: SQLite не меняет CHECK на ALTER — пересоздаём таблицу, если нет типа script
    const irMaster = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='intercept_rules'`).get();
    if (irMaster?.sql && !irMaster.sql.includes("'script'")) {
        db.exec(`
            BEGIN IMMEDIATE;
            CREATE TABLE intercept_rules__cupnet_new (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                enabled     INTEGER NOT NULL DEFAULT 1,
                url_pattern TEXT    NOT NULL,
                type        TEXT    NOT NULL CHECK(type IN ('block','modifyHeaders','mock','script')),
                params      TEXT,
                priority    INTEGER NOT NULL DEFAULT 0,
                method      TEXT    DEFAULT '*',
                group_name  TEXT    DEFAULT NULL,
                hit_count   INTEGER NOT NULL DEFAULT 0,
                last_hit_at TEXT    DEFAULT NULL,
                delay_ms    INTEGER NOT NULL DEFAULT 0,
                tags        TEXT    DEFAULT NULL,
                last_error  TEXT    DEFAULT NULL,
                stop_on_match INTEGER NOT NULL DEFAULT 1,
                breakpoint_enabled INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            INSERT INTO intercept_rules__cupnet_new (id, name, enabled, url_pattern, type, params, created_at)
                SELECT id, name, enabled, url_pattern, type, params, created_at FROM intercept_rules;
            DROP TABLE intercept_rules;
            ALTER TABLE intercept_rules__cupnet_new RENAME TO intercept_rules;
            COMMIT;
        `);
    }
    try {
        db.exec(`DROP TABLE IF EXISTS rules`);
    } catch { /* ignore */ }
    /** trace-mode feature was removed (MITM-only refactor). Drop legacy table on existing DBs. */
    try {
        db.exec(`DROP TABLE IF EXISTS trace_entries`);
    } catch { /* ignore */ }
    migrateInterceptRulesCommercialColumns();
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS intercept_rule_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id    INTEGER NOT NULL,
                snapshot   TEXT    NOT NULL,
                changed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_ir_history_rule ON intercept_rule_history(rule_id);
        `);
    } catch { /* ignore */ }
    // cookie_groups: ensure table exists for DBs created before this feature
    const hasCookieGroups = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cookie_groups'`).get();
    if (!hasCookieGroups) {
        db.exec(`
            CREATE TABLE cookie_groups (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT    NOT NULL UNIQUE,
                created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            INSERT INTO cookie_groups (id, name) VALUES (1, 'Default');
        `);
    }
    let noteCols = db.pragma('table_info(user_notes)').map(c => c.name);
    if (noteCols.length && !noteCols.includes('url_match')) {
        db.exec(`ALTER TABLE user_notes ADD COLUMN url_match TEXT NOT NULL DEFAULT ''`);
        db.exec(`UPDATE user_notes SET url_match = domain WHERE url_match = '' OR url_match IS NULL`);
    }
    noteCols = db.pragma('table_info(user_notes)').map(c => c.name);
    if (noteCols.length && !noteCols.includes('is_pinned')) {
        db.exec(`ALTER TABLE user_notes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1))`);
    }
    noteCols = db.pragma('table_info(user_notes)').map(c => c.name);
    if (noteCols.length && !noteCols.includes('tags')) {
        db.exec(`ALTER TABLE user_notes ADD COLUMN tags TEXT NOT NULL DEFAULT ''`);
    }
    const hasNoteReqLinks = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='note_request_links'`).get();
    if (!hasNoteReqLinks) {
        db.exec(`
            CREATE TABLE note_request_links (
                note_id    INTEGER NOT NULL REFERENCES user_notes(id) ON DELETE CASCADE,
                request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                PRIMARY KEY (note_id, request_id)
            );
            CREATE INDEX IF NOT EXISTS idx_note_request_links_note ON note_request_links(note_id);
            CREATE INDEX IF NOT EXISTS idx_note_request_links_req ON note_request_links(request_id);
        `);
    }
    const hasCredVault = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='credentials_vault'`).get();
    if (!hasCredVault) {
        db.exec(`
            CREATE TABLE credentials_vault (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT    NOT NULL DEFAULT 'Default',
                verify_blob   BLOB    NOT NULL,
                hint          TEXT    NOT NULL DEFAULT '',
                last_login_at TEXT,
                created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE credentials (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                vault_id                INTEGER NOT NULL DEFAULT 1 REFERENCES credentials_vault(id) ON DELETE CASCADE,
                item_type               TEXT    NOT NULL DEFAULT 'login',
                domain                  TEXT    NOT NULL,
                url_match               TEXT    NOT NULL DEFAULT '',
                label                   TEXT    NOT NULL DEFAULT '',
                login                   TEXT    NOT NULL DEFAULT '',
                password_encrypted      BLOB,
                extra_encrypted         BLOB,
                notes                   TEXT    NOT NULL DEFAULT '',
                last_ip                 TEXT    NOT NULL DEFAULT '',
                last_proxy_profile_id   INTEGER,
                last_proxy_profile_name TEXT    NOT NULL DEFAULT '',
                last_used_at            TEXT,
                tags                    TEXT    NOT NULL DEFAULT '',
                is_favorite             INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
                folder_id               INTEGER REFERENCES credential_folders(id) ON DELETE SET NULL,
                deleted_at              TEXT,
                created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_credentials_domain ON credentials(domain);
            CREATE INDEX IF NOT EXISTS idx_credentials_login ON credentials(login);
            CREATE INDEX IF NOT EXISTS idx_credentials_item_type ON credentials(item_type);
            CREATE INDEX IF NOT EXISTS idx_credentials_folder ON credentials(folder_id);
            CREATE INDEX IF NOT EXISTS idx_credentials_deleted ON credentials(deleted_at);
            CREATE INDEX IF NOT EXISTS idx_credentials_vault ON credentials(vault_id);
        `);
    }
    // Credential folders
    const hasCredFolders = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='credential_folders'`).get();
    if (!hasCredFolders) {
        db.exec(`
            CREATE TABLE credential_folders (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                vault_id   INTEGER NOT NULL DEFAULT 1 REFERENCES credentials_vault(id) ON DELETE CASCADE,
                name       TEXT    NOT NULL,
                parent_id  INTEGER REFERENCES credential_folders(id) ON DELETE SET NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_credential_folders_vault ON credential_folders(vault_id);
        `);
    }
    // Credential URIs (multiple per item, with match strategy)
    const hasCredUris = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='credential_uris'`).get();
    if (!hasCredUris) {
        db.exec(`
            CREATE TABLE credential_uris (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
                uri           TEXT    NOT NULL,
                match_type    INTEGER NOT NULL DEFAULT 0,
                sort_order    INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_credential_uris_cred ON credential_uris(credential_id);
        `);
    }
    // Credential custom fields
    const hasCredFields = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='credential_custom_fields'`).get();
    if (!hasCredFields) {
        db.exec(`
            CREATE TABLE credential_custom_fields (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
                name          TEXT    NOT NULL DEFAULT '',
                value_encrypted BLOB,
                field_type    TEXT    NOT NULL DEFAULT 'text',
                sort_order    INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_credential_fields_cred ON credential_custom_fields(credential_id);
        `);
    }
    // Migrate existing credentials table: add new columns if missing
    const credCols = db.pragma('table_info(credentials)').map(c => c.name);
    if (!credCols.includes('item_type'))  db.exec(`ALTER TABLE credentials ADD COLUMN item_type TEXT NOT NULL DEFAULT 'login'`);
    if (!credCols.includes('folder_id'))  db.exec(`ALTER TABLE credentials ADD COLUMN folder_id INTEGER REFERENCES credential_folders(id) ON DELETE SET NULL`);
    if (!credCols.includes('deleted_at')) db.exec(`ALTER TABLE credentials ADD COLUMN deleted_at TEXT`);
    if (!credCols.includes('vault_id'))   db.exec(`ALTER TABLE credentials ADD COLUMN vault_id INTEGER NOT NULL DEFAULT 1`);
    // Vault table: add name, last_login_at, hint if missing
    const vaultCols = db.pragma('table_info(credentials_vault)').map(c => c.name);
    if (vaultCols.length && !vaultCols.includes('hint')) {
        db.exec(`ALTER TABLE credentials_vault ADD COLUMN hint TEXT NOT NULL DEFAULT ''`);
    }
    if (vaultCols.length && !vaultCols.includes('name')) {
        db.exec(`ALTER TABLE credentials_vault ADD COLUMN name TEXT NOT NULL DEFAULT 'Default'`);
    }
    if (vaultCols.length && !vaultCols.includes('last_login_at')) {
        db.exec(`ALTER TABLE credentials_vault ADD COLUMN last_login_at TEXT`);
    }
    // Credential folders: add vault_id if missing
    const folderCols = db.pragma('table_info(credential_folders)').map(c => c.name);
    if (folderCols.length && !folderCols.includes('vault_id')) {
        db.exec(`ALTER TABLE credential_folders ADD COLUMN vault_id INTEGER NOT NULL DEFAULT 1`);
    }
    // Create vault_id indexes if missing
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_credentials_vault ON credentials(vault_id)`); } catch { /* ignore */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_credential_folders_vault ON credential_folders(vault_id)`); } catch { /* ignore */ }
    // Migrate legacy url_match into credential_uris
    try {
        const hasUriTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='credential_uris'`).get();
        if (hasUriTable) {
            const legacyRows = db.prepare(`
                SELECT c.id, c.url_match FROM credentials c
                WHERE c.url_match != '' AND c.url_match IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM credential_uris u WHERE u.credential_id = c.id)
            `).all();
            if (legacyRows.length) {
                const ins = db.prepare(`INSERT INTO credential_uris (credential_id, uri, match_type, sort_order) VALUES (?, ?, 0, 0)`);
                const migrate = db.transaction((rows) => {
                    for (const r of rows) ins.run(r.id, r.url_match);
                });
                migrate(legacyRows);
            }
        }
    } catch { /* ignore migration errors for older DBs */ }
    // Auto-purge trash older than 30 days
    try {
        db.prepare(`DELETE FROM credentials WHERE deleted_at IS NOT NULL AND datetime(deleted_at) < datetime('now', '-30 days')`).run();
    } catch { /* ignore */ }
}

function createSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            ended_at    TEXT,
            proxy_info  TEXT,
            tab_id      TEXT,
            notes       TEXT
        );

        CREATE TABLE IF NOT EXISTS requests (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            tab_id          TEXT,
            request_id      TEXT,
            url             TEXT    NOT NULL,
            method          TEXT    NOT NULL DEFAULT 'GET',
            status          INTEGER,
            type            TEXT,
            duration_ms     INTEGER,
            request_headers TEXT,
            response_headers TEXT,
            request_body    TEXT,
            response_body   TEXT,
            error           TEXT,
            host            TEXT,
            tag             TEXT,
            note            TEXT,
            has_note        INTEGER NOT NULL DEFAULT 0,
            ws_message_count INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
        CREATE INDEX IF NOT EXISTS idx_requests_tab     ON requests(tab_id);
        CREATE INDEX IF NOT EXISTS idx_requests_url     ON requests(url);
        CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests(status);
        CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
        CREATE INDEX IF NOT EXISTS idx_requests_duration ON requests(duration_ms);
        CREATE INDEX IF NOT EXISTS idx_requests_host   ON requests(host);

        CREATE TABLE IF NOT EXISTS ws_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            tab_id      TEXT,
            url         TEXT    NOT NULL,
            direction   TEXT    NOT NULL CHECK(direction IN ('send','recv')),
            payload     TEXT,
            connection_id TEXT,
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ws_events_session ON ws_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_ws_events_tab     ON ws_events(tab_id);

        CREATE TABLE IF NOT EXISTS screenshots (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            tab_id      TEXT,
            url         TEXT,
            data_b64    TEXT,
            screenshot_meta TEXT,
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_screenshots_session ON screenshots(session_id);

        CREATE TABLE IF NOT EXISTS browser_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            tab_id      TEXT,
            event_type  TEXT    NOT NULL,
            level       TEXT,
            summary     TEXT    NOT NULL,
            detail      TEXT,
            source_url  TEXT,
            source_line INTEGER,
            origin      TEXT,
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bevents_session ON browser_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_bevents_tab     ON browser_events(tab_id);
        CREATE INDEX IF NOT EXISTS idx_bevents_type    ON browser_events(event_type);

        CREATE TABLE IF NOT EXISTS proxy_profiles (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT    NOT NULL,
            url_encrypted   BLOB,
            url_display     TEXT,
            country         TEXT,
            is_template     INTEGER NOT NULL DEFAULT 0,
            variables       TEXT,
            notes           TEXT,
            last_tested_at  TEXT,
            last_latency_ms INTEGER,
            last_ip         TEXT,
            last_geo        TEXT,
            sort_order      INTEGER NOT NULL DEFAULT 0,
            traffic_mode    TEXT    NOT NULL DEFAULT 'mitm',
            created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS cookie_groups (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL UNIQUE,
            created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT OR IGNORE INTO cookie_groups (id, name) VALUES (1, 'Default');

        CREATE TABLE IF NOT EXISTS intercept_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            url_pattern TEXT    NOT NULL,
            type        TEXT    NOT NULL CHECK(type IN ('block','modifyHeaders','mock','script')),
            params      TEXT,
            priority    INTEGER NOT NULL DEFAULT 0,
            method      TEXT    DEFAULT '*',
            group_name  TEXT    DEFAULT NULL,
            hit_count   INTEGER NOT NULL DEFAULT 0,
            last_hit_at TEXT    DEFAULT NULL,
            delay_ms    INTEGER NOT NULL DEFAULT 0,
            tags        TEXT    DEFAULT NULL,
            last_error  TEXT    DEFAULT NULL,
            stop_on_match INTEGER NOT NULL DEFAULT 1,
            breakpoint_enabled INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS dns_overrides (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            host        TEXT    NOT NULL,
            ip          TEXT    NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dns_overrides_host ON dns_overrides(host);

        CREATE TABLE IF NOT EXISTS user_notes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            domain          TEXT    NOT NULL,
            url_match       TEXT    NOT NULL DEFAULT '',
            page_url        TEXT    NOT NULL,
            title           TEXT    NOT NULL DEFAULT '',
            body_plain      TEXT,
            body_encrypted  BLOB,
            is_encrypted    INTEGER NOT NULL DEFAULT 0 CHECK(is_encrypted IN (0, 1)),
            is_pinned       INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
            tags            TEXT    NOT NULL DEFAULT '',
            created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_user_notes_domain ON user_notes(domain);
        CREATE INDEX IF NOT EXISTS idx_user_notes_created ON user_notes(created_at);

        CREATE TABLE IF NOT EXISTS note_request_links (
            note_id    INTEGER NOT NULL REFERENCES user_notes(id) ON DELETE CASCADE,
            request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            PRIMARY KEY (note_id, request_id)
        );
        CREATE INDEX IF NOT EXISTS idx_note_request_links_note ON note_request_links(note_id);
        CREATE INDEX IF NOT EXISTS idx_note_request_links_req ON note_request_links(request_id);

        CREATE TABLE IF NOT EXISTS credentials_vault (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT    NOT NULL DEFAULT 'Default',
            verify_blob   BLOB    NOT NULL,
            hint          TEXT    NOT NULL DEFAULT '',
            last_login_at TEXT,
            created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS credentials (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            vault_id                INTEGER NOT NULL DEFAULT 1 REFERENCES credentials_vault(id) ON DELETE CASCADE,
            domain                  TEXT    NOT NULL,
            url_match               TEXT    NOT NULL DEFAULT '',
            label                   TEXT    NOT NULL DEFAULT '',
            login                   TEXT    NOT NULL DEFAULT '',
            password_encrypted      BLOB,
            extra_encrypted         BLOB,
            notes                   TEXT    NOT NULL DEFAULT '',
            last_ip                 TEXT    NOT NULL DEFAULT '',
            last_proxy_profile_id   INTEGER,
            last_proxy_profile_name TEXT    NOT NULL DEFAULT '',
            last_used_at            TEXT,
            tags                    TEXT    NOT NULL DEFAULT '',
            is_favorite             INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
            created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_credentials_domain ON credentials(domain);
        CREATE INDEX IF NOT EXISTS idx_credentials_login ON credentials(login);

        CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(
            url,
            response_body,
            request_id UNINDEXED,
            content='requests',
            content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS requests_fts_insert AFTER INSERT ON requests BEGIN
            INSERT INTO requests_fts(rowid, url, response_body, request_id)
            VALUES (new.id, new.url, COALESCE(new.response_body,''), new.request_id);
        END;

        CREATE TRIGGER IF NOT EXISTS requests_fts_delete AFTER DELETE ON requests BEGIN
            INSERT INTO requests_fts(requests_fts, rowid, url, response_body, request_id)
            VALUES ('delete', old.id, old.url, COALESCE(old.response_body,''), old.request_id);
        END;

        CREATE TRIGGER IF NOT EXISTS requests_fts_update AFTER UPDATE ON requests BEGIN
            INSERT INTO requests_fts(requests_fts, rowid, url, response_body, request_id)
            VALUES ('delete', old.id, old.url, COALESCE(old.response_body,''), old.request_id);
            INSERT INTO requests_fts(rowid, url, response_body, request_id)
            VALUES (new.id, new.url, COALESCE(new.response_body,''), new.request_id);
        END;

        CREATE TABLE IF NOT EXISTS request_editor_collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER REFERENCES request_editor_collections(id) ON DELETE CASCADE,
            node_type TEXT NOT NULL CHECK(node_type IN ('folder','request')),
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            method TEXT,
            url TEXT,
            headers_json TEXT,
            body TEXT,
            body_type TEXT,
            auth_json TEXT,
            params_json TEXT,
            form_fields_json TEXT,
            multipart_json TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_re_collections_parent ON request_editor_collections(parent_id);
        CREATE INDEX IF NOT EXISTS idx_re_collections_type ON request_editor_collections(node_type);

        CREATE TABLE IF NOT EXISTS request_editor_environments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            variables_json TEXT NOT NULL DEFAULT '{}',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS omnibox_history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            url             TEXT    NOT NULL UNIQUE,
            host            TEXT    NOT NULL DEFAULT '',
            title           TEXT,
            visit_count     INTEGER NOT NULL DEFAULT 0,
            typed_count     INTEGER NOT NULL DEFAULT 0,
            last_visit_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_omnibox_host ON omnibox_history(host);
        CREATE INDEX IF NOT EXISTS idx_omnibox_last ON omnibox_history(last_visit_at);
    `);
}

// ─── Cached prepared statements (initialized after db.init()) ────────────────
let _stmtCreateSession = null;
let _stmtCreateExtSession = null;
let _stmtInsertRequest = null;
let _stmtInsertWsEvent = null;
let _stmtInsertSS      = null;
let _stmtInsertBrowserEvent = null;
let _stmtEndSession    = null;
let _stmtCountReqs     = null;
let _stmtGetSession    = null;

function _prepareStmts() {
    _stmtCreateSession = db.prepare(`INSERT INTO sessions (proxy_info, tab_id) VALUES (?, ?) RETURNING *`);
    _stmtCreateExtSession = db.prepare(`INSERT INTO sessions (proxy_info, tab_id, source, ext_port) VALUES (?, ?, 'external', ?) RETURNING *`);
    _stmtInsertRequest = db.prepare(`
        INSERT INTO requests
            (session_id, tab_id, request_id, url, method, status, type, duration_ms,
             request_headers, response_headers, request_body, response_body, error, host, tag, note, has_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id`);
    _stmtInsertWsEvent = db.prepare(`INSERT INTO ws_events (session_id, tab_id, url, direction, payload, connection_id) VALUES (?,?,?,?,?,?)`);
    _stmtInsertSS      = db.prepare(`INSERT INTO screenshots (session_id, tab_id, url, data_blob, screenshot_meta) VALUES (?,?,?,?,?) RETURNING id`);
    _stmtInsertBrowserEvent = db.prepare(`
        INSERT INTO browser_events (session_id, tab_id, event_type, level, summary, detail, source_url, source_line, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
    `);
    _stmtEndSession    = db.prepare(`UPDATE sessions SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`);
    _stmtCountReqs     = db.prepare(`SELECT COUNT(*) as cnt FROM requests WHERE session_id = ?`);
    _stmtGetSession    = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

function createSession(proxyInfo, tabId) {
    return _stmtCreateSession.get(proxyInfo || null, tabId || null);
}

function createExternalSession(proxyInfo, tabId, extPort) {
    return _stmtCreateExtSession.get(proxyInfo || null, tabId || null, extPort);
}

function endSession(sessionId) {
    _stmtEndSession.run(sessionId);
}

function getSessions(limit = 100, offset = 0) {
    return db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
             .all(limit, offset);
}

function getSessionsWithStats(limit = 200, offset = 0) {
    return db.prepare(`
        SELECT s.id, s.started_at, s.ended_at, s.proxy_info, s.notes,
               s.source, s.ext_port,
               COUNT(r.id) AS request_count
        FROM sessions s
        LEFT JOIN requests r ON r.session_id = s.id
        GROUP BY s.id
        HAVING COUNT(r.id) > 0
        ORDER BY s.started_at DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
}

function renameSession(id, name) {
    db.prepare(`UPDATE sessions SET notes = ? WHERE id = ?`).run(name || null, id);
}

function getSession(id) {
    return _stmtGetSession.get(id);
}

function deleteSession(id) {
    // Cascade: remove related rows first, then the session itself
    db.prepare(`DELETE FROM requests WHERE session_id = ?`).run(id);
    db.prepare(`DELETE FROM browser_events WHERE session_id = ?`).run(id);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

function listUnnamedSessionIds(keepSessionId) {
    const keep = keepSessionId != null ? Number(keepSessionId) : -1;
    return db.prepare(`
        SELECT id FROM sessions
        WHERE (notes IS NULL OR TRIM(notes) = '')
        AND id != ?
    `).all(keep).map(r => r.id);
}

/** All sessions with empty/whitespace notes, except keepSessionId (e.g. current LIVE). */
function deleteUnnamedSessions(keepSessionId) {
    const ids = listUnnamedSessionIds(keepSessionId);
    for (const id of ids) deleteSession(id);
    return { deleted: ids.length };
}

function requestRowToInsertEntry(row) {
    let reqH = null;
    let respH = null;
    if (row.request_headers) {
        try { reqH = JSON.parse(row.request_headers); } catch { reqH = null; }
    }
    if (row.response_headers) {
        try { respH = JSON.parse(row.response_headers); } catch { respH = null; }
    }
    return {
        requestId: row.request_id,
        url: row.url,
        method: row.method,
        status: row.status,
        type: row.type,
        duration: row.duration_ms,
        requestHeaders: reqH,
        responseHeaders: respH,
        requestBody: row.request_body,
        responseBody: row.response_body,
        error: row.error,
        tag: row.tag,
        note: row.note,
    };
}

/** Copy listed request rows (by DB id, ascending = chronological) into a new named session. */
function createSessionFromRequestIds(requestIds, name) {
    const ids = [...new Set((requestIds || []).map(Number))]
        .filter(n => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
    if (!ids.length) return null;
    const sess = createSession(null, null);
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed) renameSession(sess.id, trimmed);
    for (const rid of ids) {
        const row = getRequest(rid);
        if (!row) continue;
        const entry = requestRowToInsertEntry(row);
        insertRequest(sess.id, row.tab_id, entry);
    }
    return getSession(sess.id);
}

function deleteEmptySessions(keepId) {
    // Remove sessions with no requests, except the one currently active
    db.prepare(`
        DELETE FROM sessions
        WHERE id NOT IN (SELECT DISTINCT session_id FROM requests WHERE session_id IS NOT NULL)
        ${keepId ? 'AND id != ?' : ''}
    `).run(...(keepId ? [keepId] : []));
}

// ─── Requests ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB

function _truncBody(body) {
    if (!body) return null;
    if (typeof body === 'string' && body.length > MAX_BODY_BYTES) return body.slice(0, MAX_BODY_BYTES);
    if (Buffer.isBuffer(body) && body.length > MAX_BODY_BYTES) return body.slice(0, MAX_BODY_BYTES);
    return body;
}

function _extractHost(url) {
    try {
        return new URL(String(url || '')).host || null;
    } catch {
        return null;
    }
}

function insertRequest(sessionId, tabId, entry) {
    const host = entry.host || _extractHost(entry.url);
    const row = _stmtInsertRequest.get(
        sessionId,
        tabId || null,
        entry.requestId || null,
        entry.url || '',
        entry.method || 'GET',
        entry.status || null,
        entry.type || null,
        entry.duration != null ? Math.round(entry.duration) : null,
        entry.requestHeaders ? JSON.stringify(entry.requestHeaders) : null,
        entry.responseHeaders ? JSON.stringify(entry.responseHeaders) : null,
        _truncBody(entry.requestBody),
        _truncBody(entry.responseBody),
        entry.error || null,
        host,
        entry.tag || null,
        entry.note || null,
        entry.note ? 1 : 0
    );
    return row ? row.id : null;
}

function updateRequest(id, fields) {
    const allowed = ['status', 'type', 'duration_ms', 'response_headers', 'response_body', 'error', 'host', 'tag', 'note', 'has_note'];
    const updates = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) {
            updates.push(`${k} = ?`);
            values.push(typeof v === 'object' ? JSON.stringify(v) : v);
        }
    }
    if (!updates.length) return;
    values.push(id);
    db.prepare(`UPDATE requests SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

function setRequestAnnotation(id, { tag, note }) {
    const normalizedNote = typeof note === 'string' ? note.trim() : '';
    db.prepare(`UPDATE requests SET tag = ?, note = ?, has_note = ? WHERE id = ?`)
      .run(tag || null, normalizedNote || null, normalizedNote ? 1 : 0, id);
}

function queryRequests(filters = {}, limit = 100, offset = 0) {
    const conditions = ['1=1'];
    const params = [];

    if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.tabId)     { conditions.push('tab_id = ?');     params.push(filters.tabId); }
    if (filters.method)    { conditions.push('method = ?');      params.push(filters.method.toUpperCase()); }
    if (filters.status)    { conditions.push('status = ?');      params.push(Number(filters.status)); }
    if (filters.type)      { conditions.push('type = ?');         params.push(filters.type); }
    if (filters.url)       { conditions.push('url LIKE ?');       params.push(`%${filters.url}%`); }
    if (filters.minDuration != null) { conditions.push('duration_ms >= ?'); params.push(filters.minDuration); }
    if (filters.maxDuration != null) { conditions.push('duration_ms <= ?'); params.push(filters.maxDuration); }
    if (filters.since)     { conditions.push('created_at >= ?'); params.push(filters.since); }

    const sql = `SELECT id, session_id, tab_id, request_id, url, method, status, type,
                        duration_ms, error, response_headers, host, tag, has_note, note, created_at, ws_message_count,
                        CASE WHEN lower(COALESCE(type, '')) = 'cupnet'
                                  AND url IN ('cupnet://session/proxy', 'cupnet://session/direct')
                             THEN response_body ELSE NULL END AS response_body
                 FROM requests
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY id DESC
                 LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...params, limit, offset);
}

function countRequests(filters = {}) {
    const conditions = ['1=1'];
    const params = [];
    if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.tabId)     { conditions.push('tab_id = ?');     params.push(filters.tabId); }
    if (filters.url)       { conditions.push('url LIKE ?');       params.push(`%${filters.url}%`); }
    if (filters.status)    { conditions.push('status = ?');      params.push(Number(filters.status)); }
    return db.prepare(`SELECT COUNT(*) as cnt FROM requests WHERE ${conditions.join(' AND ')}`)
             .get(...params).cnt;
}

function getRequest(id) {
    return db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id);
}

function queryRequestsFull(filters = {}, limit = 100, offset = 0) {
    const conditions = ['1=1'];
    const params = [];
    if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.tabId)     { conditions.push('tab_id = ?');     params.push(filters.tabId); }
    if (filters.method)    { conditions.push('method = ?');      params.push(filters.method.toUpperCase()); }
    if (filters.status)    { conditions.push('status = ?');      params.push(Number(filters.status)); }
    if (filters.type)      { conditions.push('type = ?');        params.push(filters.type); }
    if (filters.url)       { conditions.push('url LIKE ?');      params.push(`%${filters.url}%`); }
    const sql = `SELECT * FROM requests WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...params, limit, offset);
}

function ftsSearch(query, sessionId, limit = 100, offset = 0) {
    const ftsQuery = query.split(/\s+/).map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const sql = sessionId
        ? `SELECT r.id, r.session_id, r.tab_id, r.url, r.method, r.status, r.type, r.duration_ms, r.response_headers,
                  r.host, r.tag, r.has_note, r.note, r.created_at
           FROM requests_fts fts JOIN requests r ON fts.rowid = r.id
           WHERE requests_fts MATCH ? AND r.session_id = ?
           ORDER BY r.id DESC LIMIT ? OFFSET ?`
        : `SELECT r.id, r.session_id, r.tab_id, r.url, r.method, r.status, r.type, r.duration_ms, r.response_headers,
                  r.host, r.tag, r.has_note, r.note, r.created_at
           FROM requests_fts fts JOIN requests r ON fts.rowid = r.id
           WHERE requests_fts MATCH ?
           ORDER BY r.id DESC LIMIT ? OFFSET ?`;
    try {
        return sessionId
            ? db.prepare(sql).all(ftsQuery, sessionId, limit, offset)
            : db.prepare(sql).all(ftsQuery, limit, offset);
    } catch {
        return [];
    }
}

// ─── WebSocket events ────────────────────────────────────────────────────────

function bumpWsHandshakeMessageCount(sessionId, connectionId) {
    if (!connectionId) return null;
    const sid = parseInt(String(sessionId), 10);
    if (!sid) return null;
    const rid = String(connectionId);
    db.prepare(`
        UPDATE requests SET ws_message_count = COALESCE(ws_message_count, 0) + 1
        WHERE session_id = ? AND request_id = ? AND LOWER(COALESCE(type, '')) = 'websocket'
    `).run(sid, rid);
    const row = db.prepare(`
        SELECT id, ws_message_count FROM requests
        WHERE session_id = ? AND request_id = ? AND LOWER(COALESCE(type, '')) = 'websocket'
        LIMIT 1
    `).get(sid, rid);
    return row ? { handshakeDbId: row.id, ws_message_count: row.ws_message_count } : null;
}

function insertWsEvent(sessionId, tabId, url, direction, payload, connectionId = null) {
    _stmtInsertWsEvent.run(sessionId, tabId || null, url, direction, payload || null, connectionId || null);
    return bumpWsHandshakeMessageCount(sessionId, connectionId);
}

/**
 * MITM handshake логирует как https://host/path; CDP кладёт wss://host/path — совпадаем по обоим.
 */
function _wsUrlVariants(url) {
    const s = String(url || '').trim();
    if (!s) return [];
    const v = new Set([s]);
    try {
        const u = new URL(s);
        const host = u.hostname + (u.port ? `:${u.port}` : '');
        const rest = u.pathname + (u.search || '');
        if (u.protocol === 'https:' || u.protocol === 'wss:') {
            v.add(`wss://${host}${rest}`);
            v.add(`https://${host}${rest}`);
        }
        if (u.protocol === 'http:' || u.protocol === 'ws:') {
            v.add(`ws://${host}${rest}`);
            v.add(`http://${host}${rest}`);
        }
    } catch { /* ignore */ }
    return [...v];
}

/** Hard ceiling for WS frame queries (export / log viewer pass explicit limit). */
const WS_EVENTS_QUERY_MAX = 500_000_000;

/** WebSocket frames for Log Viewer Messages tab (chronological). */
function queryWsEvents(sessionId, tabId, url, connectionId = null, limit = 10000) {
    const sid = parseInt(String(sessionId), 10);
    if (!sid || !url) return [];
    const lim = Math.min(Math.max(1, Number(limit) || 10000), WS_EVENTS_QUERY_MAX);
    const tid = tabId != null ? String(tabId) : null;
    const variants = _wsUrlVariants(url);
    const inList = variants.map(() => '?').join(', ');
    if (connectionId) {
        return db.prepare(`
            SELECT id, direction, payload, connection_id, created_at
            FROM ws_events
            WHERE session_id = ?
              AND url IN (${inList})
              AND COALESCE(tab_id, '') = COALESCE(?, '')
              AND COALESCE(connection_id, '') = COALESCE(?, '')
            ORDER BY id ASC
            LIMIT ?
        `).all(sid, ...variants, tid, String(connectionId), lim);
    }
    return db.prepare(`
        SELECT id, direction, payload, connection_id, created_at
        FROM ws_events
        WHERE session_id = ?
          AND url IN (${inList})
          AND COALESCE(tab_id, '') = COALESCE(?, '')
        ORDER BY id ASC
        LIMIT ?
    `).all(sid, ...variants, tid, lim);
}

/** Все WebSocket-фреймы сессии (экспорт HAR / bundle). */
function queryWsEventsBySession(sessionId, limit = 50000) {
    const sid = parseInt(String(sessionId), 10);
    if (!sid) return [];
    const lim = Math.min(Math.max(1, Number(limit) || 50000), WS_EVENTS_QUERY_MAX);
    return db.prepare(`
        SELECT id, session_id, tab_id, url, direction, payload, connection_id, created_at
        FROM ws_events
        WHERE session_id = ?
        ORDER BY id ASC
        LIMIT ?
    `).all(sid, lim);
}

// ─── Screenshots ─────────────────────────────────────────────────────────────

function insertScreenshot(sessionId, tabId, url, dataB64, screenshotMeta = null) {
    if (!dataB64 || typeof dataB64 !== 'string') return null;
    const buf = Buffer.from(dataB64, 'base64');
    const metaJson = (screenshotMeta && typeof screenshotMeta === 'object')
        ? JSON.stringify(screenshotMeta)
        : null;
    const row = _stmtInsertSS.get(sessionId, tabId || null, url || null, buf, metaJson);
    return row ? row.id : null;
}

function getScreenshotsForSession(sessionId) {
    return db.prepare(`SELECT id, tab_id, url, created_at FROM screenshots WHERE session_id = ?`)
             .all(sessionId);
}

/** Returns screenshot metadata (NO image data) formatted as log entries. Image data is lazy-loaded on demand. */
function getScreenshotEntriesForSession(sessionId) {
    return db.prepare(`SELECT id, session_id, tab_id, url, screenshot_meta, created_at FROM screenshots WHERE session_id = ? ORDER BY id ASC`)
             .all(sessionId)
             .map(row => ({
                 id:         'ss-' + row.id,
                 ssDbId:     row.id,       // numeric DB id for lazy image fetch
                 type:       'screenshot',
                 url:        row.url || '',
                 screenshotMeta: (() => {
                     try { return row.screenshot_meta ? JSON.parse(row.screenshot_meta) : null; }
                     catch { return null; }
                 })(),
                 tabId:      row.tab_id,
                 tab_id:     row.tab_id,
                 session_id: row.session_id,
                 created_at: row.created_at,
                 // imageData intentionally omitted — fetched on demand via getScreenshotData()
             }));
}

function getScreenshotData(id) {
    const row = db.prepare(`SELECT data_blob, data_b64 FROM screenshots WHERE id = ?`).get(id);
    if (!row) return null;
    if (row.data_blob) return Buffer.from(row.data_blob).toString('base64');
    return row.data_b64 || null;
}

// ─── Browser events (Activity Monitor: console, storage, exceptions) ─────────

const MAX_BROWSER_EVENT_DETAIL = 2 * 1024 * 1024;

function _normBrowserEventDetail(detail) {
    if (detail == null) return null;
    const s = typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (s.length > MAX_BROWSER_EVENT_DETAIL) return s.slice(0, MAX_BROWSER_EVENT_DETAIL) + '\n…[truncated]';
    return s;
}

function insertBrowserEvent(sessionId, tabId, event) {
    const et = String(event.event_type || '').trim() || 'unknown';
    const summary = String(event.summary != null ? event.summary : '').slice(0, 8000);
    const row = _stmtInsertBrowserEvent.get(
        sessionId,
        tabId || null,
        et,
        event.level != null ? String(event.level) : null,
        summary,
        _normBrowserEventDetail(event.detail),
        event.source_url != null ? String(event.source_url) : null,
        event.source_line != null && Number.isFinite(Number(event.source_line)) ? Math.round(Number(event.source_line)) : null,
        event.origin != null ? String(event.origin) : null
    );
    return row ? row.id : null;
}

function insertBrowserEventAsync(sessionId, tabId, event) {
    return enqueueWrite(() => insertBrowserEvent(sessionId, tabId, event), 'low');
}

/** Query browser events (optional filters). */
function getBrowserEvents(sessionId, opts = {}) {
    const sid = parseInt(String(sessionId), 10);
    if (!sid) return [];
    const lim = Math.min(Math.max(1, Number(opts.limit) || 10000), 50000);
    const conditions = ['session_id = ?'];
    const params = [sid];
    if (opts.tabId) {
        conditions.push('tab_id = ?');
        params.push(String(opts.tabId));
    }
    if (opts.eventType) {
        conditions.push('event_type = ?');
        params.push(String(opts.eventType));
    }
    const sql = `
        SELECT id, session_id, tab_id, event_type, level, summary, detail, source_url, source_line, origin, created_at
        FROM browser_events
        WHERE ${conditions.join(' AND ')}
        ORDER BY id ASC
        LIMIT ?
    `;
    params.push(lim);
    return db.prepare(sql).all(...params);
}

/** Rows formatted for log-viewer merge (same shape as live CDP broadcast). */
function getBrowserEventsForSession(sessionId) {
    return getBrowserEvents(sessionId, { limit: 10000 }).map((row) => ({
        _browserEvent: true,
        id: row.id,
        event_type: row.event_type,
        level: row.level,
        summary: row.summary,
        detail: row.detail,
        source_url: row.source_url,
        source_line: row.source_line,
        origin: row.origin,
        url: row.summary || '',
        type: row.event_type === 'exception' ? 'exception' : (String(row.event_type || '').startsWith('ls-') || String(row.event_type || '').startsWith('ss-') ? 'storage' : 'browser'),
        tabId: row.tab_id,
        tab_id: row.tab_id,
        session_id: row.session_id,
        sessionId: row.session_id,
        created_at: row.created_at,
    }));
}

// ─── Proxy profiles ──────────────────────────────────────────────────────────

function normalizeTrafficMode(_mode) {
    return 'mitm';
}

/** One bad `variables` JSON row must not break the whole proxy list UI. */
function parseProxyProfileVariablesCell(raw) {
    if (raw == null || raw === '') return {};
    if (typeof raw !== 'string') return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
        safeCatch({ module: 'db', eventCode: 'proxy.profile.variables.invalid', context: { op: 'parseProxyProfileVariablesCell' } }, e, 'info');
        return {};
    }
}

function getProxyProfiles() {
    return db.prepare(`
        SELECT id, name, url_display, country, is_template, variables, notes,
               last_tested_at, last_latency_ms, last_ip, last_geo, sort_order,
               user_agent, timezone, language,
               tls_profile, tls_ja3_mode, tls_ja3_custom, traffic_mode,
               created_at
        FROM proxy_profiles ORDER BY sort_order ASC, name ASC LIMIT 1000
    `).all().map(r => ({
        ...r,
        traffic_mode: normalizeTrafficMode(r.traffic_mode),
        variables: parseProxyProfileVariablesCell(r.variables),
    }));
}

function saveProxyProfile(name, urlEncrypted, urlDisplay, opts = {}) {
    const existing = db.prepare(`SELECT id FROM proxy_profiles WHERE name = ?`).get(name);
    const vars = opts.variables ? JSON.stringify(opts.variables) : null;
    if (existing) {
        db.prepare(`UPDATE proxy_profiles
                    SET url_encrypted=?, url_display=?, country=?,
                        is_template=?, variables=?, notes=?, sort_order=?,
                        user_agent=?, timezone=?, language=?,
                        tls_profile=?, tls_ja3_mode=?, tls_ja3_custom=?,
                        traffic_mode=?
                    WHERE id=?`)
          .run(urlEncrypted, urlDisplay, opts.country || null,
               opts.isTemplate ? 1 : 0, vars, opts.notes || null,
               opts.sortOrder ?? 0, opts.user_agent || null, opts.timezone || null,
               opts.language || null,
               opts.tls_profile || 'chrome', opts.tls_ja3_mode || 'template', opts.tls_ja3_custom || null,
               normalizeTrafficMode(opts.traffic_mode),
               existing.id);
        return existing.id;
    }
    const row = db.prepare(`
        INSERT INTO proxy_profiles (name, url_encrypted, url_display, country, is_template, variables, notes, sort_order,
                                    user_agent, timezone, language, tls_profile, tls_ja3_mode, tls_ja3_custom, traffic_mode)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id
    `).get(name, urlEncrypted, urlDisplay, opts.country || null,
           opts.isTemplate ? 1 : 0, vars, opts.notes || null, opts.sortOrder ?? 0,
           opts.user_agent || null, opts.timezone || null, opts.language || null,
           opts.tls_profile || 'chrome', opts.tls_ja3_mode || 'template', opts.tls_ja3_custom || null,
           normalizeTrafficMode(opts.traffic_mode));
    return row ? row.id : null;
}

function updateProxyProfileById(id, fields) {
    const allowed = ['name','url_encrypted','url_display','country','is_template','variables','notes','sort_order',
                     'user_agent','timezone','language','tls_profile','tls_ja3_mode','tls_ja3_custom','traffic_mode'];
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
        if (!allowed.includes(k)) continue;
        sets.push(`${k}=?`);
        if (k === 'variables' && typeof v === 'object') vals.push(JSON.stringify(v));
        else if (k === 'traffic_mode') vals.push(normalizeTrafficMode(v));
        else vals.push(v);
    }
    if (!sets.length) return;
    vals.push(id);
    db.prepare(`UPDATE proxy_profiles SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

function getProxyProfileEncrypted(id) {
    const row = db.prepare(`SELECT name, url_encrypted, url_display, variables, user_agent, timezone, language,
                                   tls_profile, tls_ja3_mode, tls_ja3_custom, traffic_mode
                            FROM proxy_profiles WHERE id = ?`).get(id);
    if (!row) return null;
    row.traffic_mode = normalizeTrafficMode(row.traffic_mode);
    return row;
}

function updateProxyProfileTest(id, latencyMs, ip, geo) {
    db.prepare(`UPDATE proxy_profiles
                SET last_tested_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    last_latency_ms=?, last_ip=?, last_geo=?
                WHERE id=?`)
      .run(latencyMs, ip || null, geo || null, id);
}

function updateProxyProfileGeo(id, ip, geo) {
    db.prepare(`UPDATE proxy_profiles SET last_ip=?, last_geo=? WHERE id=?`).run(ip||null, geo||null, id);
}

function deleteProxyProfile(id) {
    db.prepare(`DELETE FROM proxy_profiles WHERE id = ?`).run(id);
}

// ─── Intercept rules ─────────────────────────────────────────────────────────

function parseInterceptRuleRow(row) {
    if (!row) return row;
    const r = parseJsonFields('params')(row);
    if (r.tags && typeof r.tags === 'string') {
        try {
            r.tags = JSON.parse(r.tags);
        } catch {
            r.tags = r.tags.split(',').map((s) => s.trim()).filter(Boolean);
        }
    }
    return r;
}

function getInterceptRules() {
    return db.prepare(`SELECT * FROM intercept_rules WHERE enabled = 1 ORDER BY priority DESC, id LIMIT 1000`).all().map(parseInterceptRuleRow);
}

function getAllInterceptRules() {
    return db.prepare(`SELECT * FROM intercept_rules ORDER BY priority DESC, id LIMIT 1000`).all().map(parseInterceptRuleRow);
}

function interceptRuleToRow(rule) {
    const params = JSON.stringify(rule.params || {});
    const method = rule.method != null && String(rule.method).trim() !== '' ? String(rule.method).trim() : '*';
    const priority = Number(rule.priority) || 0;
    const delayMs = Math.max(0, Math.min(60000, Number(rule.delay_ms) || 0));
    const stopOn = rule.stop_on_match !== false ? 1 : 0;
    const bp = rule.breakpoint_enabled ? 1 : 0;
    let tagsJson = null;
    if (rule.tags != null) {
        tagsJson = Array.isArray(rule.tags) ? JSON.stringify(rule.tags) : String(rule.tags);
    }
    return {
        name: rule.name,
        enabled: rule.enabled !== false ? 1 : 0,
        url_pattern: rule.url_pattern,
        type: rule.type,
        params,
        priority,
        method,
        group_name: rule.group_name != null && String(rule.group_name).trim() !== '' ? String(rule.group_name).trim() : null,
        delay_ms: delayMs,
        tags: tagsJson,
        stop_on_match: stopOn,
        breakpoint_enabled: bp,
    };
}

function saveInterceptRule(rule) {
    const snap = interceptRuleToRow(rule);
    if (rule.id) {
        const prev = db.prepare(`SELECT * FROM intercept_rules WHERE id=?`).get(rule.id);
        if (prev) {
            try {
                db.prepare(`INSERT INTO intercept_rule_history (rule_id, snapshot) VALUES (?, ?)`).run(
                    rule.id,
                    JSON.stringify(prev),
                );
            } catch { /* table may be missing in tests */ }
        }
        db.prepare(`UPDATE intercept_rules SET name=?, enabled=?, url_pattern=?, type=?, params=?,
            priority=?, method=?, group_name=?, delay_ms=?, tags=?, stop_on_match=?, breakpoint_enabled=?
            WHERE id=?`)
            .run(
                snap.name, snap.enabled, snap.url_pattern, snap.type, snap.params,
                snap.priority, snap.method, snap.group_name, snap.delay_ms, snap.tags,
                snap.stop_on_match, snap.breakpoint_enabled,
                rule.id,
            );
        return rule.id;
    }
    const row = db.prepare(
        `INSERT INTO intercept_rules (name, enabled, url_pattern, type, params, priority, method, group_name, delay_ms, tags, stop_on_match, breakpoint_enabled)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(
        snap.name, snap.enabled, snap.url_pattern, snap.type, snap.params,
        snap.priority, snap.method, snap.group_name, snap.delay_ms, snap.tags,
        snap.stop_on_match, snap.breakpoint_enabled,
    );
    return row ? row.id : null;
}

function incrementInterceptRuleHit(id) {
    db.prepare(`UPDATE intercept_rules SET hit_count = hit_count + 1, last_hit_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error = NULL WHERE id = ?`).run(id);
}

function incrementInterceptRuleHitAsync(id) {
    return enqueueWrite(() => incrementInterceptRuleHit(id), 'low');
}

function setInterceptRuleError(id, errText) {
    const t = errText != null && String(errText).trim() !== '' ? String(errText).slice(0, 2000) : null;
    db.prepare(`UPDATE intercept_rules SET last_error = ? WHERE id = ?`).run(t, id);
}

function setInterceptRuleErrorAsync(id, errText) {
    return enqueueWrite(() => setInterceptRuleError(id, errText), 'low');
}

function reorderInterceptRules(pairs) {
    if (!Array.isArray(pairs) || !pairs.length) return;
    const upd = db.prepare(`UPDATE intercept_rules SET priority=? WHERE id=?`);
    const tx = db.transaction((rows) => {
        for (const p of rows) {
            if (p && p.id != null) upd.run(Number(p.priority) || 0, p.id);
        }
    });
    tx(pairs);
}

function reorderInterceptRulesAsync(pairs) {
    return enqueueWrite(() => reorderInterceptRules(pairs), 'high');
}

function getInterceptRuleHistory(ruleId, limit = 50) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    try {
        return db.prepare(`SELECT id, rule_id, snapshot, changed_at FROM intercept_rule_history WHERE rule_id=? ORDER BY id DESC LIMIT ?`)
            .all(ruleId, lim);
    } catch {
        return [];
    }
}

function deleteInterceptRule(id) {
    try {
        db.prepare(`DELETE FROM intercept_rule_history WHERE rule_id = ?`).run(id);
    } catch { /* ignore */ }
    db.prepare(`DELETE FROM intercept_rules WHERE id = ?`).run(id);
}

// ─── DNS overrides ────────────────────────────────────────────────────────────

function getDnsOverrides() {
    return db.prepare(`
        SELECT id, host, ip, enabled, mitm_inject_cors, rewrite_host, created_at, updated_at
        FROM dns_overrides
        ORDER BY host COLLATE NOCASE ASC
    `).all().map(r => ({
        ...r,
        enabled: !!r.enabled,
        mitm_inject_cors: !!r.mitm_inject_cors,
        rewrite_host: r.rewrite_host || '',
    }));
}

function _normalizeDnsRewriteHost(rule) {
    const raw = String(rule?.rewrite_host ?? '').trim();
    if (!raw) return null;
    if (raw.length > 255) throw new Error('Rewrite Host: max 255 characters');
    for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c < 33 || c > 126) throw new Error('Rewrite Host: only printable ASCII');
    }
    return raw;
}

function saveDnsOverride(rule) {
    const host = String(rule?.host || '').trim().toLowerCase();
    const ip = String(rule?.ip || '').trim();
    const enabled = rule?.enabled !== false ? 1 : 0;
    const mitmCors = rule?.mitm_inject_cors === true ? 1 : 0;
    if (!host) throw new Error('Host is required');
    const isWildcardHost = host.startsWith('*.');
    if (isWildcardHost && ip) throw new Error('Wildcard host (*.example.com) cannot be combined with IP redirect');
    if (!ip && !mitmCors) throw new Error('IPv4 is required unless MITM CORS-only (no DNS redirect) is enabled');

    const rewriteHost = _normalizeDnsRewriteHost(rule);
    if (rewriteHost) {
        if (isWildcardHost) throw new Error('Rewrite Host is not supported for wildcard rules');
        if (!ip) throw new Error('Rewrite Host requires an IPv4 redirect');
    }

    if (rule?.id) {
        db.prepare(`
            UPDATE dns_overrides
            SET host = ?, ip = ?, enabled = ?, mitm_inject_cors = ?, rewrite_host = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?
        `).run(host, ip, enabled, mitmCors, rewriteHost, rule.id);
        return rule.id;
    }

    const existing = db.prepare(`SELECT id FROM dns_overrides WHERE host = ?`).get(host);
    if (existing) {
        db.prepare(`
            UPDATE dns_overrides
            SET ip = ?, enabled = ?, mitm_inject_cors = ?, rewrite_host = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?
        `).run(ip, enabled, mitmCors, rewriteHost, existing.id);
        return existing.id;
    }

    const row = db.prepare(`
        INSERT INTO dns_overrides (host, ip, enabled, mitm_inject_cors, rewrite_host)
        VALUES (?, ?, ?, ?, ?)
        RETURNING id
    `).get(host, ip, enabled, mitmCors, rewriteHost);
    return row ? row.id : null;
}

function deleteDnsOverride(id) {
    db.prepare(`DELETE FROM dns_overrides WHERE id = ?`).run(id);
}

function toggleDnsOverride(id, enabled) {
    db.prepare(`
        UPDATE dns_overrides
        SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
    `).run(enabled ? 1 : 0, id);
}

// ─── Cookie groups ────────────────────────────────────────────────────────────

function getCookieGroups() {
    return db.prepare(`SELECT id, name, created_at FROM cookie_groups ORDER BY id ASC LIMIT 500`).all();
}

function createCookieGroup(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Cookie group name is required');
    const row = db.prepare(`INSERT INTO cookie_groups (name) VALUES (?) RETURNING *`).get(trimmed);
    return row || null;
}

function renameCookieGroup(id, newName) {
    if (id === 1) throw new Error('Cannot rename the Default group');
    const trimmed = String(newName || '').trim();
    if (!trimmed) throw new Error('Cookie group name is required');
    db.prepare(`UPDATE cookie_groups SET name = ? WHERE id = ?`).run(trimmed, id);
}

function deleteCookieGroup(id) {
    if (id === 1) throw new Error('Cannot delete the Default group');
    db.prepare(`DELETE FROM cookie_groups WHERE id = ?`).run(id);
}

function getCookieGroup(id) {
    return db.prepare(`SELECT * FROM cookie_groups WHERE id = ?`).get(id) || null;
}

// ─── Async queued write-path ────────────────────────────────────────────────

function createSessionAsync(proxyInfo, tabId) {
    return enqueueWrite(() => createSession(proxyInfo, tabId), 'high');
}

function createExternalSessionAsync(proxyInfo, tabId, extPort) {
    return enqueueWrite(() => createExternalSession(proxyInfo, tabId, extPort), 'high');
}

function endSessionAsync(sessionId) {
    return enqueueWrite(() => endSession(sessionId), 'high');
}

function renameSessionAsync(id, name) {
    return enqueueWrite(() => renameSession(id, name), 'high');
}

function deleteSessionAsync(id) {
    return enqueueWrite(() => deleteSession(id), 'high');
}

async function deleteUnnamedSessionsAsync(keepSessionId) {
    const ids = listUnnamedSessionIds(keepSessionId);
    for (const id of ids) {
        await deleteSessionAsync(id);
    }
    return { deleted: ids.length };
}

/** Copy requests in chunks so the DB lock yields between batches — other IPC (e.g. get-request-detail) can run. */
async function createSessionFromRequestIdsAsync(requestIds, name) {
    const ids = [...new Set((requestIds || []).map(Number))]
        .filter(n => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
    if (!ids.length) return null;
    const sess = await createSessionAsync(null, null);
    if (!sess) return null;
    const sid = sess.id;
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed) await renameSessionAsync(sid, trimmed);
    const BATCH = 80;
    for (let i = 0; i < ids.length; i += BATCH) {
        const slice = ids.slice(i, i + BATCH);
        await enqueueWrite(() => {
            for (const rid of slice) {
                const row = getRequest(rid);
                if (!row) continue;
                insertRequest(sid, row.tab_id, requestRowToInsertEntry(row));
            }
        }, 'high');
    }
    return getSession(sid);
}

function deleteEmptySessionsAsync(keepId) {
    return enqueueWrite(() => deleteEmptySessions(keepId), 'low');
}

function insertRequestAsync(sessionId, tabId, entry) {
    return enqueueWrite(() => insertRequest(sessionId, tabId, entry), 'high');
}

function updateRequestAsync(id, fields) {
    return enqueueWrite(() => updateRequest(id, fields), 'high');
}

function setRequestAnnotationAsync(id, data) {
    return enqueueWrite(() => setRequestAnnotation(id, data), 'high');
}

function insertWsEventAsync(sessionId, tabId, url, direction, payload, connectionId = null) {
    return enqueueWrite(() => insertWsEvent(sessionId, tabId, url, direction, payload, connectionId), 'low');
}

function insertScreenshotAsync(sessionId, tabId, url, dataB64, screenshotMeta = null) {
    return enqueueWrite(() => insertScreenshot(sessionId, tabId, url, dataB64, screenshotMeta), 'low');
}

function saveProxyProfileAsync(name, urlEncrypted, urlDisplay, opts = {}) {
    return enqueueWrite(() => saveProxyProfile(name, urlEncrypted, urlDisplay, opts), 'high');
}

function updateProxyProfileByIdAsync(id, fields) {
    return enqueueWrite(() => updateProxyProfileById(id, fields), 'high');
}

function updateProxyProfileTestAsync(id, latencyMs, ip, geo) {
    return enqueueWrite(() => updateProxyProfileTest(id, latencyMs, ip, geo), 'low');
}

function updateProxyProfileGeoAsync(id, ip, geo) {
    return enqueueWrite(() => updateProxyProfileGeo(id, ip, geo), 'low');
}

function deleteProxyProfileAsync(id) {
    return enqueueWrite(() => deleteProxyProfile(id), 'high');
}

function saveInterceptRuleAsync(rule) {
    return enqueueWrite(() => saveInterceptRule(rule), 'high');
}

function deleteInterceptRuleAsync(id) {
    return enqueueWrite(() => deleteInterceptRule(id), 'high');
}

function saveDnsOverrideAsync(rule) {
    return enqueueWrite(() => saveDnsOverride(rule), 'high');
}

function deleteDnsOverrideAsync(id) {
    return enqueueWrite(() => deleteDnsOverride(id), 'high');
}

function toggleDnsOverrideAsync(id, enabled) {
    return enqueueWrite(() => toggleDnsOverride(id, enabled), 'high');
}

function createCookieGroupAsync(name) {
    return enqueueWrite(() => createCookieGroup(name), 'high');
}

function renameCookieGroupAsync(id, newName) {
    return enqueueWrite(() => renameCookieGroup(id, newName), 'high');
}

function deleteCookieGroupAsync(id) {
    return enqueueWrite(() => deleteCookieGroup(id), 'high');
}

// ─── User notes (CupNet) ───────────────────────────────────────────────────

function _escapeLikeFragment(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function listUserNotes(filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit) || 500, 1), 2000);
    const domain = filter.domain != null ? String(filter.domain).trim().toLowerCase() : '';
    const searchRaw = filter.search != null ? String(filter.search).trim() : '';
    const hasSearch = searchRaw.length > 0;
    const likePat = hasSearch ? `%${_escapeLikeFragment(searchRaw)}%` : null;
    const tagRaw = filter.tag != null ? String(filter.tag).trim().toLowerCase() : '';
    const hasTag = tagRaw.length > 0;

    let sqlList = `
        SELECT id, domain, url_match, page_url, title, is_encrypted, is_pinned, tags, created_at, updated_at,
               CASE WHEN is_encrypted = 1 THEN NULL ELSE substr(COALESCE(body_plain,''), 1, 240) END AS preview
        FROM user_notes
        WHERE 1=1`;
    const params = [];
    if (domain) {
        sqlList += ` AND domain = ?`;
        params.push(domain);
    }
    if (hasSearch) {
        sqlList += ` AND (title LIKE ? ESCAPE '\\' OR (is_encrypted = 0 AND body_plain LIKE ? ESCAPE '\\'))`;
        params.push(likePat, likePat);
    }
    if (hasTag) {
        sqlList += ` AND instr(',' || lower(replace(COALESCE(tags,''), ' ', '')) || ',', ',' || ? || ',') > 0`;
        params.push(tagRaw);
    }
    sqlList += ` ORDER BY is_pinned DESC, datetime(updated_at) DESC LIMIT ?`;
    params.push(limit);
    return db.prepare(sqlList).all(...params);
}

function getUserNote(id) {
    return db.prepare(`SELECT * FROM user_notes WHERE id = ?`).get(Number(id)) || null;
}

function saveUserNote(rec) {
    const domain = String(rec.domain || '').trim() || '(no site)';
    const urlMatch = String(rec.url_match ?? '');
    const pageUrl = String(rec.page_url || '');
    const isEnc = rec.is_encrypted ? 1 : 0;
    const title = String(rec.title ?? '');
    const tags = String(rec.tags ?? '');
    const isPinned = rec.is_pinned ? 1 : 0;
    if (rec.id) {
        const nid = Number(rec.id);
        if (isEnc) {
            db.prepare(`
                UPDATE user_notes SET domain = ?, url_match = ?, title = ?, body_plain = NULL,
                    body_encrypted = ?, is_encrypted = 1,
                    tags = ?, is_pinned = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id = ?
            `).run(domain, urlMatch, title, rec.body_encrypted, tags, isPinned, nid);
        } else {
            db.prepare(`
                UPDATE user_notes SET domain = ?, url_match = ?, title = ?, body_plain = ?,
                    body_encrypted = NULL, is_encrypted = 0,
                    tags = ?, is_pinned = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id = ?
            `).run(domain, urlMatch, title, rec.body_plain ?? '', tags, isPinned, nid);
        }
        return nid;
    }
    if (isEnc) {
        const r = db.prepare(`
            INSERT INTO user_notes (domain, url_match, page_url, title, body_plain, body_encrypted, is_encrypted, is_pinned, tags)
            VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)
        `).run(domain, urlMatch, pageUrl, title, rec.body_encrypted, isPinned, tags);
        return Number(r.lastInsertRowid);
    }
    const r = db.prepare(`
        INSERT INTO user_notes (domain, url_match, page_url, title, body_plain, body_encrypted, is_encrypted, is_pinned, tags)
        VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(domain, urlMatch, pageUrl, title, rec.body_plain ?? '', isPinned, tags);
    return Number(r.lastInsertRowid);
}

function setUserNotePinned(id, pinned) {
    const v = pinned ? 1 : 0;
    db.prepare(`UPDATE user_notes SET is_pinned = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(v, Number(id));
}

function linkNoteToRequest(noteId, requestId) {
    db.prepare(`
        INSERT OR IGNORE INTO note_request_links (note_id, request_id) VALUES (?, ?)
    `).run(Number(noteId), Number(requestId));
}

function unlinkNoteFromRequest(noteId, requestId) {
    db.prepare(`DELETE FROM note_request_links WHERE note_id = ? AND request_id = ?`).run(Number(noteId), Number(requestId));
}

function listNoteRequestLinks(noteId) {
    return db.prepare(`
        SELECT r.id AS request_id, r.url, r.method, r.status, r.created_at
        FROM note_request_links l
        JOIN requests r ON r.id = l.request_id
        WHERE l.note_id = ?
        ORDER BY r.created_at DESC
    `).all(Number(noteId));
}

function listLinkedNotesForRequest(requestId) {
    return db.prepare(`
        SELECT n.id, n.title
        FROM note_request_links l
        JOIN user_notes n ON n.id = l.note_id
        WHERE l.request_id = ?
        ORDER BY n.updated_at DESC
    `).all(Number(requestId));
}

function setUserNotePinnedAsync(id, pinned) {
    return enqueueWrite(() => setUserNotePinned(id, pinned), 'high');
}

function linkNoteToRequestAsync(noteId, requestId) {
    return enqueueWrite(() => linkNoteToRequest(noteId, requestId), 'high');
}

function unlinkNoteFromRequestAsync(noteId, requestId) {
    return enqueueWrite(() => unlinkNoteFromRequest(noteId, requestId), 'high');
}

function deleteUserNote(id) {
    db.prepare(`DELETE FROM user_notes WHERE id = ?`).run(Number(id));
}

function saveUserNoteAsync(rec) {
    return enqueueWrite(() => saveUserNote(rec), 'high');
}

function deleteUserNoteAsync(id) {
    return enqueueWrite(() => deleteUserNote(id), 'high');
}

// ─── Credentials vault (CupNet) ───────────────────────────────────────────────

function getCredentialsVaultMeta(vaultId) {
    const id = vaultId != null ? Number(vaultId) : null;
    if (id != null) {
        return db.prepare(`SELECT id, name, verify_blob, hint, last_login_at, created_at FROM credentials_vault WHERE id = ?`).get(id) || null;
    }
    return db.prepare(`SELECT id, name, verify_blob, hint, last_login_at, created_at FROM credentials_vault ORDER BY id ASC LIMIT 1`).get() || null;
}

function listVaults() {
    return db.prepare(`SELECT id, name, hint, last_login_at, created_at FROM credentials_vault ORDER BY id ASC`).all();
}

function createVault(name, verifyBlob) {
    if (!verifyBlob || !Buffer.isBuffer(verifyBlob)) throw new Error('Invalid vault blob');
    const r = db.prepare(`
        INSERT INTO credentials_vault (name, verify_blob, created_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(String(name || 'Default'), verifyBlob);
    return Number(r.lastInsertRowid);
}

function initCredentialsVault(verifyBlob) {
    return createVault('Default', verifyBlob);
}

function getVaultById(id) {
    return db.prepare(`SELECT * FROM credentials_vault WHERE id = ?`).get(Number(id)) || null;
}

function updateVaultLastLogin(vaultId) {
    db.prepare(`UPDATE credentials_vault SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(Number(vaultId));
}

function renameVault(vaultId, name) {
    db.prepare(`UPDATE credentials_vault SET name = ? WHERE id = ?`).run(String(name), Number(vaultId));
}

function deleteVault(vaultId) {
    const vid = Number(vaultId);
    db.transaction(() => {
        const credIds = db.prepare(`SELECT id FROM credentials WHERE vault_id = ?`).all(vid).map(r => r.id);
        for (const cid of credIds) {
            db.prepare(`DELETE FROM credential_uris WHERE credential_id = ?`).run(cid);
            db.prepare(`DELETE FROM credential_custom_fields WHERE credential_id = ?`).run(cid);
        }
        db.prepare(`DELETE FROM credentials WHERE vault_id = ?`).run(vid);
        db.prepare(`DELETE FROM credential_folders WHERE vault_id = ?`).run(vid);
        db.prepare(`DELETE FROM credentials_vault WHERE id = ?`).run(vid);
    })();
}

function updateCredentialsVaultVerifyBlob(vaultId, verifyBlob) {
    if (!verifyBlob || !Buffer.isBuffer(verifyBlob)) throw new Error('Invalid vault blob');
    db.prepare(`UPDATE credentials_vault SET verify_blob = ? WHERE id = ?`).run(verifyBlob, Number(vaultId));
}

function listCredentials(filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit) || 500, 1), 2000);
    const domain = filter.domain != null ? String(filter.domain).trim().toLowerCase() : '';
    const searchRaw = filter.search != null ? String(filter.search).trim() : '';
    const hasSearch = searchRaw.length > 0;
    const likePat = hasSearch ? `%${_escapeLikeFragment(searchRaw)}%` : null;
    const tagRaw = filter.tag != null ? String(filter.tag).trim().toLowerCase() : '';
    const hasTag = tagRaw.length > 0;
    const favoritesOnly = filter.favoritesOnly === true ? 1 : null;
    const itemType = filter.itemType ? String(filter.itemType) : '';
    const folderId = filter.folderId != null ? Number(filter.folderId) : null;
    const trashOnly = filter.trashOnly === true;
    const noFolder = filter.noFolder === true;
    const sortBy = filter.sortBy || 'updated';
    const vaultId = filter.vaultId != null ? Number(filter.vaultId) : null;

    let sql = `
        SELECT id, vault_id, item_type, domain, url_match, label, login, notes, last_ip, last_proxy_profile_id, last_proxy_profile_name,
               last_used_at, tags, is_favorite, folder_id, deleted_at, created_at, updated_at
        FROM credentials
        WHERE 1=1`;
    const params = [];
    if (vaultId != null) {
        sql += ` AND vault_id = ?`;
        params.push(vaultId);
    }
    if (trashOnly) {
        sql += ` AND deleted_at IS NOT NULL`;
    } else {
        sql += ` AND deleted_at IS NULL`;
    }
    if (domain) {
        sql += ` AND domain = ?`;
        params.push(domain);
    }
    if (itemType) {
        sql += ` AND item_type = ?`;
        params.push(itemType);
    }
    if (folderId != null) {
        sql += ` AND folder_id = ?`;
        params.push(folderId);
    }
    if (noFolder) {
        sql += ` AND (folder_id IS NULL)`;
    }
    if (favoritesOnly != null) {
        sql += ` AND is_favorite = ?`;
        params.push(favoritesOnly);
    }
    if (hasSearch) {
        sql += ` AND (
            domain LIKE ? ESCAPE '\\' OR login LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\'
            OR url_match LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
        )`;
        params.push(likePat, likePat, likePat, likePat, likePat, likePat);
    }
    if (hasTag) {
        sql += ` AND instr(',' || lower(replace(COALESCE(tags,''), ' ', '')) || ',', ',' || ? || ',') > 0`;
        params.push(tagRaw);
    }
    const orderMap = {
        name: `label COLLATE NOCASE ASC, domain COLLATE NOCASE ASC`,
        updated: `is_favorite DESC, datetime(updated_at) DESC`,
        created: `datetime(created_at) DESC`,
        lastUsed: `datetime(COALESCE(last_used_at, '1970-01-01')) DESC`,
    };
    sql += ` ORDER BY ${orderMap[sortBy] || orderMap.updated} LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params).map((r) => ({
        ...r,
        is_favorite: !!r.is_favorite,
    }));
}

function getCredential(id) {
    const row = db.prepare(`SELECT * FROM credentials WHERE id = ?`).get(Number(id)) || null;
    if (!row) return null;
    return { ...row, is_favorite: !!row.is_favorite };
}

function getAllCredentialCipherRows(vaultId) {
    if (vaultId != null) {
        return db.prepare(`SELECT id, password_encrypted, extra_encrypted FROM credentials WHERE vault_id = ?`).all(Number(vaultId));
    }
    return db.prepare(`SELECT id, password_encrypted, extra_encrypted FROM credentials`).all();
}

function saveCredential(rec) {
    const itemType = ['login', 'card', 'identity', 'note'].includes(rec.item_type) ? rec.item_type : 'login';
    const domain = String(rec.domain || '').trim().toLowerCase() || '(no site)';
    const urlMatch = String(rec.url_match ?? '');
    const label = String(rec.label ?? '');
    const login = String(rec.login ?? '');
    const notes = String(rec.notes ?? '');
    const tags = String(rec.tags ?? '');
    const isFav = rec.is_favorite ? 1 : 0;
    const lastIp = String(rec.last_ip ?? '');
    const lastPid = rec.last_proxy_profile_id != null && rec.last_proxy_profile_id !== ''
        ? Number(rec.last_proxy_profile_id)
        : null;
    const lastPname = String(rec.last_proxy_profile_name ?? '');
    const lastUsed = rec.last_used_at != null ? String(rec.last_used_at) : null;
    const folderId = rec.folder_id != null ? Number(rec.folder_id) : null;
    const vaultId = rec.vault_id != null ? Number(rec.vault_id) : 1;

    if (rec.id) {
        const nid = Number(rec.id);
        db.prepare(`
            UPDATE credentials SET
                item_type = ?, domain = ?, url_match = ?, label = ?, login = ?,
                password_encrypted = ?, extra_encrypted = ?,
                notes = ?, last_ip = ?, last_proxy_profile_id = ?, last_proxy_profile_name = ?,
                last_used_at = COALESCE(?, last_used_at),
                tags = ?, is_favorite = ?, folder_id = ?, vault_id = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?
        `).run(
            itemType, domain, urlMatch, label, login,
            rec.password_encrypted ?? null,
            rec.extra_encrypted ?? null,
            notes, lastIp, lastPid, lastPname,
            lastUsed,
            tags, isFav, folderId, vaultId,
            nid,
        );
        return nid;
    }
    const r = db.prepare(`
        INSERT INTO credentials (
            vault_id, item_type, domain, url_match, label, login, password_encrypted, extra_encrypted,
            notes, last_ip, last_proxy_profile_id, last_proxy_profile_name, last_used_at, tags, is_favorite, folder_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
        vaultId, itemType, domain, urlMatch, label, login,
        rec.password_encrypted ?? null,
        rec.extra_encrypted ?? null,
        notes, lastIp, lastPid, lastPname,
        lastUsed,
        tags, isFav, folderId,
    );
    return Number(r.lastInsertRowid);
}

function setCredentialFavorite(id, pinned) {
    const v = pinned ? 1 : 0;
    db.prepare(`
        UPDATE credentials SET is_favorite = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?
    `).run(v, Number(id));
}

function deleteCredential(id) {
    db.prepare(`DELETE FROM credentials WHERE id = ?`).run(Number(id));
}

function updateCredentialCipherFields(id, passwordEnc, extraEnc) {
    db.prepare(`
        UPDATE credentials SET password_encrypted = ?, extra_encrypted = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
    `).run(passwordEnc ?? null, extraEnc ?? null, Number(id));
}

/** Update last-used metadata after fill-from-toolbar or similar. */
function updateCredentialLastUsedMeta(id, { last_used_at, last_ip, last_proxy_profile_id, last_proxy_profile_name }) {
    const lastUsed = last_used_at != null ? String(last_used_at) : new Date().toISOString();
    const lip = String(last_ip ?? '');
    const pid = last_proxy_profile_id != null && last_proxy_profile_id !== '' ? Number(last_proxy_profile_id) : null;
    const pname = String(last_proxy_profile_name ?? '');
    db.prepare(`
        UPDATE credentials SET
            last_used_at = ?,
            last_ip = ?,
            last_proxy_profile_id = ?,
            last_proxy_profile_name = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
    `).run(lastUsed, lip, pid, pname, Number(id));
}

// ─── Credential soft-delete (trash) ──────────────────────────────────────────

function softDeleteCredential(id) {
    db.prepare(`UPDATE credentials SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(Number(id));
}

function restoreCredential(id) {
    db.prepare(`UPDATE credentials SET deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(Number(id));
}

function purgeTrash(vaultId) {
    if (vaultId != null) {
        db.prepare(`DELETE FROM credentials WHERE deleted_at IS NOT NULL AND vault_id = ?`).run(Number(vaultId));
    } else {
        db.prepare(`DELETE FROM credentials WHERE deleted_at IS NOT NULL`).run();
    }
}

function countTrashItems(vaultId) {
    if (vaultId != null) {
        const row = db.prepare(`SELECT COUNT(*) AS cnt FROM credentials WHERE deleted_at IS NOT NULL AND vault_id = ?`).get(Number(vaultId));
        return row?.cnt || 0;
    }
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM credentials WHERE deleted_at IS NOT NULL`).get();
    return row?.cnt || 0;
}

// ─── Credential folders ─────────────────────────────────────────────────────

function listCredentialFolders(vaultId) {
    if (vaultId != null) {
        return db.prepare(`SELECT * FROM credential_folders WHERE vault_id = ? ORDER BY sort_order ASC, name COLLATE NOCASE ASC`).all(Number(vaultId));
    }
    return db.prepare(`SELECT * FROM credential_folders ORDER BY sort_order ASC, name COLLATE NOCASE ASC`).all();
}

function createCredentialFolder(name, parentId, vaultId) {
    const r = db.prepare(`INSERT INTO credential_folders (vault_id, name, parent_id) VALUES (?, ?, ?)`).run(
        vaultId != null ? Number(vaultId) : 1,
        String(name || 'New Folder'),
        parentId != null ? Number(parentId) : null,
    );
    return Number(r.lastInsertRowid);
}

function renameCredentialFolder(id, name) {
    db.prepare(`UPDATE credential_folders SET name = ? WHERE id = ?`).run(String(name), Number(id));
}

function deleteCredentialFolder(id) {
    db.prepare(`UPDATE credentials SET folder_id = NULL WHERE folder_id = ?`).run(Number(id));
    db.prepare(`UPDATE credential_folders SET parent_id = NULL WHERE parent_id = ?`).run(Number(id));
    db.prepare(`DELETE FROM credential_folders WHERE id = ?`).run(Number(id));
}

function moveCredentialToFolder(credentialId, folderId) {
    db.prepare(`UPDATE credentials SET folder_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
        folderId != null ? Number(folderId) : null,
        Number(credentialId),
    );
}

// ─── Credential URIs ────────────────────────────────────────────────────────

function listCredentialUris(credentialId) {
    return db.prepare(`SELECT * FROM credential_uris WHERE credential_id = ? ORDER BY sort_order ASC, id ASC`).all(Number(credentialId));
}

function saveCredentialUris(credentialId, uris) {
    const cid = Number(credentialId);
    const del = db.prepare(`DELETE FROM credential_uris WHERE credential_id = ?`);
    const ins = db.prepare(`INSERT INTO credential_uris (credential_id, uri, match_type, sort_order) VALUES (?, ?, ?, ?)`);
    db.transaction(() => {
        del.run(cid);
        if (Array.isArray(uris)) {
            for (let i = 0; i < uris.length; i++) {
                const u = uris[i];
                ins.run(cid, String(u.uri || ''), Number(u.match_type) || 0, i);
            }
        }
    })();
}

// ─── Credential custom fields ───────────────────────────────────────────────

function listCredentialCustomFields(credentialId) {
    return db.prepare(`SELECT * FROM credential_custom_fields WHERE credential_id = ? ORDER BY sort_order ASC, id ASC`).all(Number(credentialId));
}

function saveCredentialCustomFields(credentialId, fields) {
    const cid = Number(credentialId);
    const del = db.prepare(`DELETE FROM credential_custom_fields WHERE credential_id = ?`);
    const ins = db.prepare(`INSERT INTO credential_custom_fields (credential_id, name, value_encrypted, field_type, sort_order) VALUES (?, ?, ?, ?, ?)`);
    db.transaction(() => {
        del.run(cid);
        if (Array.isArray(fields)) {
            for (let i = 0; i < fields.length; i++) {
                const f = fields[i];
                ins.run(cid, String(f.name || ''), f.value_encrypted ?? null, String(f.field_type || 'text'), i);
            }
        }
    })();
}

// ─── Credential type-specific counts ────────────────────────────────────────

function countCredentialsByType(vaultId) {
    let sql = `SELECT item_type, COUNT(*) AS cnt FROM credentials WHERE deleted_at IS NULL`;
    const params = [];
    if (vaultId != null) {
        sql += ` AND vault_id = ?`;
        params.push(Number(vaultId));
    }
    sql += ` GROUP BY item_type`;
    const rows = db.prepare(sql).all(...params);
    const out = { login: 0, card: 0, identity: 0, note: 0, total: 0 };
    for (const r of rows) {
        out[r.item_type] = r.cnt;
        out.total += r.cnt;
    }
    return out;
}

// ─── Vault hint ─────────────────────────────────────────────────────────────

function setVaultHint(vaultId, hint) {
    db.prepare(`UPDATE credentials_vault SET hint = ? WHERE id = ?`).run(String(hint ?? ''), Number(vaultId || 1));
}

function getVaultHint(vaultId) {
    const row = db.prepare(`SELECT hint FROM credentials_vault WHERE id = ?`).get(Number(vaultId || 1));
    return row?.hint || '';
}

// ─── Request Editor: collections & environments ─────────────────────────────

function listRequestEditorCollectionTree() {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT id, parent_id, node_type, name, sort_order, method, url, headers_json, body, body_type,
                   auth_json, params_json, form_fields_json, multipart_json, created_at, updated_at
            FROM request_editor_collections
            ORDER BY COALESCE(parent_id, 0), sort_order ASC, id ASC
        `).all();
    } catch {
        return [];
    }
}

function insertRequestEditorCollectionRow(row) {
    const r = db.prepare(`
        INSERT INTO request_editor_collections (
            parent_id, node_type, name, sort_order, method, url, headers_json, body, body_type,
            auth_json, params_json, form_fields_json, multipart_json, updated_at
        ) VALUES (
            @parent_id, @node_type, @name, @sort_order, @method, @url, @headers_json, @body, @body_type,
            @auth_json, @params_json, @form_fields_json, @multipart_json, strftime('%Y-%m-%dT%H:%M:%fZ','now')
        )
    `).run({
        parent_id: row.parent_id ?? null,
        node_type: row.node_type || 'request',
        name: String(row.name || 'Untitled'),
        sort_order: Number(row.sort_order) || 0,
        method: row.method ?? null,
        url: row.url ?? null,
        headers_json: row.headers_json ?? null,
        body: row.body ?? null,
        body_type: row.body_type ?? null,
        auth_json: row.auth_json ?? null,
        params_json: row.params_json ?? null,
        form_fields_json: row.form_fields_json ?? null,
        multipart_json: row.multipart_json ?? null,
    });
    return r.lastInsertRowid;
}

function updateRequestEditorCollectionRow(id, row) {
    db.prepare(`
        UPDATE request_editor_collections SET
            parent_id = @parent_id,
            name = @name,
            sort_order = @sort_order,
            method = @method,
            url = @url,
            headers_json = @headers_json,
            body = @body,
            body_type = @body_type,
            auth_json = @auth_json,
            params_json = @params_json,
            form_fields_json = @form_fields_json,
            multipart_json = @multipart_json,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @id
    `).run({
        id: Number(id),
        parent_id: row.parent_id ?? null,
        name: String(row.name || 'Untitled'),
        sort_order: Number(row.sort_order) || 0,
        method: row.method ?? null,
        url: row.url ?? null,
        headers_json: row.headers_json ?? null,
        body: row.body ?? null,
        body_type: row.body_type ?? null,
        auth_json: row.auth_json ?? null,
        params_json: row.params_json ?? null,
        form_fields_json: row.form_fields_json ?? null,
        multipart_json: row.multipart_json ?? null,
    });
}

function deleteRequestEditorCollectionNode(id) {
    db.prepare(`DELETE FROM request_editor_collections WHERE id = ?`).run(Number(id));
}

function listRequestEditorEnvironments() {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT id, name, variables_json, sort_order, created_at, updated_at
            FROM request_editor_environments
            ORDER BY sort_order ASC, id ASC
        `).all();
    } catch {
        return [];
    }
}

function upsertRequestEditorEnvironment(row) {
    const id = row.id != null ? Number(row.id) : 0;
    if (id > 0) {
        db.prepare(`
            UPDATE request_editor_environments
            SET name = ?, variables_json = ?, sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?
        `).run(String(row.name || 'Environment'), String(row.variables_json || '{}'), Number(row.sort_order) || 0, id);
        return id;
    }
    const r = db.prepare(`
        INSERT INTO request_editor_environments (name, variables_json, sort_order, updated_at)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(String(row.name || 'Environment'), String(row.variables_json || '{}'), Number(row.sort_order) || 0);
    return r.lastInsertRowid;
}

function deleteRequestEditorEnvironment(id) {
    db.prepare(`DELETE FROM request_editor_environments WHERE id = ?`).run(Number(id));
}

/** Top hosts by request count in the log DB (Chrome-like omnibox suggestions). */
function getOmniboxTopHosts(limit = 12) {
    if (!db) return [];
    const lim = Math.max(1, Math.min(40, Number(limit) || 12));
    try {
        const rows = db.prepare(`
            SELECT host, COUNT(*) AS cnt
            FROM requests
            WHERE host IS NOT NULL AND TRIM(host) != ''
              AND LOWER(COALESCE(url, '')) NOT LIKE 'cupnet:%'
              AND LOWER(COALESCE(url, '')) NOT LIKE 'file:%'
              AND LOWER(COALESCE(url, '')) NOT LIKE 'devtools:%'
            GROUP BY host
            ORDER BY cnt DESC
            LIMIT ?
        `).all(lim);
        return rows.map((r) => ({ host: r.host, count: r.cnt }));
    } catch {
        return [];
    }
}

function _escapeOmniboxLike(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function _omniboxFrecency(row, nowMs) {
    const last = Date.parse(row.last_visit_at);
    const t = Number.isFinite(last) ? last : nowMs;
    const ageDays = Math.max(0, (nowMs - t) / 86400000);
    const base = Number(row.visit_count) + Number(row.typed_count) * 3;
    return base * Math.exp(-ageDays / 14);
}

/**
 * Upsert a visit into omnibox history (main-frame navigations).
 * @param {{ url: string, title?: string|null, typed?: boolean }} payload
 */
function recordOmniboxVisit(payload = {}) {
    if (!db) return;
    const url = typeof payload.url === 'string' ? payload.url.trim() : '';
    if (!url || url === 'about:blank') return;
    if (!/^https?:\/\//i.test(url)) return;
    const low = url.toLowerCase();
    if (low.startsWith('devtools:')) return;
    let host = typeof payload.host === 'string' ? payload.host.trim() : '';
    if (!host) {
        try { host = new URL(url).hostname || ''; } catch { host = ''; }
    }
    const title = payload.title != null ? String(payload.title).slice(0, 512) : '';
    const typedInc = payload.typed ? 1 : 0;
    const now = new Date().toISOString();
    try {
        db.prepare(`
            INSERT INTO omnibox_history (url, host, title, visit_count, typed_count, last_visit_at)
            VALUES (@url, @host, @title, 1, @typedInc, @now)
            ON CONFLICT(url) DO UPDATE SET
                visit_count = omnibox_history.visit_count + 1,
                typed_count = omnibox_history.typed_count + excluded.typed_count,
                title = CASE WHEN TRIM(COALESCE(excluded.title, '')) != ''
                    THEN excluded.title ELSE omnibox_history.title END,
                last_visit_at = excluded.last_visit_at,
                host = CASE WHEN TRIM(COALESCE(excluded.host, '')) != ''
                    THEN excluded.host ELSE omnibox_history.host END
        `).run({ url, host, title, typedInc, now });
    } catch (e) {
        safeCatch({ module: 'db', eventCode: 'omnibox.visit.failed' }, e, 'warn');
    }
}

/**
 * Frecency-ranked omnibox suggestions; falls back to log top-hosts when history is empty.
 * @param {string} query
 * @param {number} limit
 * @returns {Array<{ url: string, host: string, title: string|null, score: number }>}
 */
function getOmniboxSuggestions(query, limit = 12) {
    if (!db) return [];
    const lim = Math.max(1, Math.min(40, Number(limit) || 12));
    const q = String(query || '').trim();
    const nowMs = Date.now();
    let rows = [];
    try {
        if (!q) {
            rows = db.prepare(`
                SELECT url, host, title, visit_count, typed_count, last_visit_at
                FROM omnibox_history
                ORDER BY last_visit_at DESC
                LIMIT ?
            `).all(Math.min(120, lim * 6));
        } else {
            const likePat = `%${_escapeOmniboxLike(q)}%`;
            rows = db.prepare(`
                SELECT url, host, title, visit_count, typed_count, last_visit_at
                FROM omnibox_history
                WHERE LOWER(host) LIKE LOWER(?) ESCAPE '\\'
                   OR LOWER(url) LIKE LOWER(?) ESCAPE '\\'
                   OR LOWER(COALESCE(title, '')) LIKE LOWER(?) ESCAPE '\\'
                ORDER BY last_visit_at DESC
                LIMIT 80
            `).all(likePat, likePat, likePat);
        }
    } catch (e) {
        safeCatch({ module: 'db', eventCode: 'omnibox.suggestions.failed' }, e, 'warn');
        rows = [];
    }
    const scored = rows.map((r) => ({
        url: r.url,
        host: r.host || '',
        title: r.title || null,
        score: _omniboxFrecency(r, nowMs),
    }));
    scored.sort((a, b) => b.score - a.score);
    let out = scored.slice(0, lim);
    if (!out.length) {
        const hosts = getOmniboxTopHosts(lim);
        out = hosts.map((h) => ({
            url: `https://${h.host}`,
            host: h.host,
            title: null,
            score: 0,
        }));
        if (q) {
            const ql = q.toLowerCase();
            out = out.filter((x) => String(x.host).toLowerCase().includes(ql));
        }
    } else if (q && out.length < lim) {
        const have = new Set(out.map((x) => x.url));
        const hosts = getOmniboxTopHosts(lim * 2);
        const ql = q.toLowerCase();
        for (const h of hosts) {
            if (out.length >= lim) break;
            const u = `https://${h.host}`;
            if (have.has(u)) continue;
            if (!String(h.host).toLowerCase().includes(ql)) continue;
            out.push({ url: u, host: h.host, title: null, score: 0.01 });
            have.add(u);
        }
    }
    return out;
}

// ─── System Console logs (persisted from main-process capture) ──────────────

function insertConsoleLogsBatch(rows) {
    if (!db || !Array.isArray(rows) || rows.length === 0) return 0;
    const ins = db.prepare(`
        INSERT INTO console_logs (session_id, ts, level, source, module, stream, text)
        VALUES (@session_id, @ts, @level, @source, @module, @stream, @text)
    `);
    const tx = db.transaction((items) => {
        let n = 0;
        for (const r of items) {
            ins.run({
                session_id: r.sessionId != null && r.sessionId !== '' ? Number(r.sessionId) : null,
                ts: Number(r.ts) || Date.now(),
                level: String(r.level || 'info'),
                source: r.source != null ? String(r.source) : null,
                module: r.module != null ? String(r.module) : null,
                stream: r.stream != null ? String(r.stream) : null,
                text: String(r.text ?? ''),
            });
            n++;
        }
        return n;
    });
    return tx(rows);
}

function insertConsoleLogsBatchAsync(rows) {
    return enqueueWrite(() => insertConsoleLogsBatch(rows), 'low');
}

function rowToConsoleLogEntry(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        ts: row.ts,
        level: row.level,
        source: row.source,
        module: row.module,
        stream: row.stream,
        text: row.text,
        createdAt: row.created_at,
    };
}

/**
 * @param {{ sessionId?: number|null, limit?: number, offset?: number, sinceTs?: number, untilTs?: number, order?: 'asc'|'desc' }} opts
 */
function queryConsoleLogs(opts = {}) {
    if (!db) return [];
    const limit = Math.min(5000, Math.max(1, Number(opts.limit) || 500));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const sessionId = opts.sessionId != null && opts.sessionId !== '' ? Number(opts.sessionId) : null;
    const sinceTs = opts.sinceTs != null ? Number(opts.sinceTs) : null;
    const untilTs = opts.untilTs != null ? Number(opts.untilTs) : null;
    let sql = `SELECT id, session_id, ts, level, source, module, stream, text, created_at FROM console_logs WHERE 1=1`;
    const params = [];
    if (sessionId) {
        sql += ` AND session_id = ?`;
        params.push(sessionId);
    }
    if (sinceTs != null && Number.isFinite(sinceTs)) {
        sql += ` AND ts >= ?`;
        params.push(sinceTs);
    }
    if (untilTs != null && Number.isFinite(untilTs)) {
        sql += ` AND ts <= ?`;
        params.push(untilTs);
    }
    const ord = opts.order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ts ${ord}, id ${ord} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return db.prepare(sql).all(...params).map(rowToConsoleLogEntry);
}

function getConsoleLogSessionsSummary(limit = 50) {
    if (!db) return [];
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    try {
        return db.prepare(`
            SELECT s.id AS id, s.started_at AS started_at, s.notes AS notes,
                   COUNT(c.id) AS console_count,
                   MAX(c.ts) AS last_ts
            FROM console_logs c
            INNER JOIN sessions s ON s.id = c.session_id
            GROUP BY s.id
            ORDER BY last_ts DESC
            LIMIT ?
        `).all(lim);
    } catch {
        return [];
    }
}

function findRequestsNearTimestamp(sessionId, tsMs, windowMs = 2000) {
    if (!db || sessionId == null) return [];
    const sid = Number(sessionId);
    if (!Number.isFinite(sid)) return [];
    const w = Math.max(50, Number(windowMs) || 2000);
    const t = Number(tsMs);
    if (!Number.isFinite(t)) return [];
    const lo = new Date(t - w).toISOString();
    const hi = new Date(t + w).toISOString();
    try {
        return db.prepare(`
            SELECT id, url, method, status, created_at, duration_ms
            FROM requests
            WHERE session_id = ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at ASC
            LIMIT 40
        `).all(sid, lo, hi);
    } catch {
        return [];
    }
}

function purgeConsoleLogsOlderThanDays(days = 7) {
    if (!db) return 0;
    const d = Math.max(1, Math.min(365, Number(days) || 7));
    try {
        const r = db.prepare(`
            DELETE FROM console_logs
            WHERE datetime(created_at) < datetime('now', ?)
        `).run(`-${d} days`);
        return r.changes || 0;
    } catch {
        return 0;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseJsonFields(...fields) {
    return (row) => {
        for (const f of fields) {
            if (row[f] && typeof row[f] === 'string') {
                try { row[f] = JSON.parse(row[f]); } catch { /* keep as string */ }
            }
        }
        return row;
    };
}

function close() {
    const maxDrain = 5000;
    let drained = 0;
    while (drained < maxDrain && (_writeQueueHigh.length > 0 || _writeQueueLow.length > 0)) {
        const task = _takeNextWriteTask();
        if (!task) break;
        try {
            const result = task.fn();
            task.resolve(result);
        } catch (e) {
            try { task.reject(e); } catch { /* ignore */ }
        }
        drained++;
    }
    if (db) { db.close(); db = null; }
    _writeQueueHigh = [];
    _writeQueueLow = [];
    _fairHighStreak = 0;
    _writeQueueProcessing = false;
    _writeQueueDroppedLow = 0;
    _writeQueueDroppedHigh = 0;
    _writeQueueBusyRetries = 0;
    _stmtCreateSession = _stmtCreateExtSession = _stmtInsertRequest = _stmtInsertWsEvent = null;
    _stmtInsertSS = _stmtInsertBrowserEvent = _stmtEndSession = null;
    _stmtCountReqs = _stmtGetSession = null;
}

function getDb() { return db; }
function getWriteQueueStats() {
    return {
        highPriorityDepth: _writeQueueHigh.length,
        lowPriorityDepth: _writeQueueLow.length,
        droppedLow: _writeQueueDroppedLow,
        droppedHigh: _writeQueueDroppedHigh,
        busyRetries: _writeQueueBusyRetries,
    };
}

module.exports = {
    init, initWithPath, close, getDb, getDbPath,
    // sessions
    createSession, createExternalSession, endSession, getSessions, getSessionsWithStats, renameSession, getSession, deleteSession, deleteUnnamedSessions, deleteEmptySessions,
    requestRowToInsertEntry, createSessionFromRequestIds,
    createSessionAsync, createExternalSessionAsync, endSessionAsync, renameSessionAsync, deleteSessionAsync, deleteUnnamedSessionsAsync, deleteEmptySessionsAsync, createSessionFromRequestIdsAsync,
    // requests
    insertRequest, updateRequest, setRequestAnnotation, queryRequests, queryRequestsFull, countRequests, getRequest, ftsSearch, getOmniboxTopHosts, recordOmniboxVisit, getOmniboxSuggestions,
    insertConsoleLogsBatch, insertConsoleLogsBatchAsync, queryConsoleLogs, getConsoleLogSessionsSummary, findRequestsNearTimestamp, purgeConsoleLogsOlderThanDays,
    insertRequestAsync, updateRequestAsync, setRequestAnnotationAsync,
    // ws
    insertWsEvent, insertWsEventAsync, queryWsEvents, queryWsEventsBySession,
    // screenshots
    insertScreenshot, insertScreenshotAsync, getScreenshotsForSession, getScreenshotEntriesForSession, getScreenshotData,
    insertBrowserEvent, insertBrowserEventAsync, getBrowserEvents, getBrowserEventsForSession,
    // proxy profiles
    getProxyProfiles, saveProxyProfile, updateProxyProfileById,
    getProxyProfileEncrypted, updateProxyProfileTest, updateProxyProfileGeo, deleteProxyProfile,
    saveProxyProfileAsync, updateProxyProfileByIdAsync, updateProxyProfileTestAsync, updateProxyProfileGeoAsync, deleteProxyProfileAsync,
    // intercept rules
    getInterceptRules, getAllInterceptRules, saveInterceptRule, deleteInterceptRule,
    saveInterceptRuleAsync, deleteInterceptRuleAsync,
    incrementInterceptRuleHit, incrementInterceptRuleHitAsync,
    reorderInterceptRules, reorderInterceptRulesAsync,
    setInterceptRuleError, setInterceptRuleErrorAsync,
    getInterceptRuleHistory,
    // dns overrides
    getDnsOverrides, saveDnsOverride, deleteDnsOverride, toggleDnsOverride,
    saveDnsOverrideAsync, deleteDnsOverrideAsync, toggleDnsOverrideAsync,
    // cookie groups
    getCookieGroups, getCookieGroup, createCookieGroup, renameCookieGroup, deleteCookieGroup,
    createCookieGroupAsync, renameCookieGroupAsync, deleteCookieGroupAsync,
    getWriteQueueStats,
    // user notes
    listUserNotes, getUserNote, saveUserNote, deleteUserNote, saveUserNoteAsync, deleteUserNoteAsync,
    setUserNotePinned, linkNoteToRequest, unlinkNoteFromRequest, listNoteRequestLinks, listLinkedNotesForRequest,
    setUserNotePinnedAsync, linkNoteToRequestAsync, unlinkNoteFromRequestAsync,
    // credentials vault
    getCredentialsVaultMeta, initCredentialsVault, updateCredentialsVaultVerifyBlob,
    listVaults, createVault, getVaultById, updateVaultLastLogin, renameVault, deleteVault,
    listCredentials, getCredential, getAllCredentialCipherRows, saveCredential, deleteCredential,
    setCredentialFavorite, updateCredentialCipherFields, updateCredentialLastUsedMeta,
    // credentials: soft-delete / trash
    softDeleteCredential, restoreCredential, purgeTrash, countTrashItems,
    // credential folders
    listCredentialFolders, createCredentialFolder, renameCredentialFolder, deleteCredentialFolder, moveCredentialToFolder,
    // credential URIs
    listCredentialUris, saveCredentialUris,
    // credential custom fields
    listCredentialCustomFields, saveCredentialCustomFields,
    // credential counts + hint
    countCredentialsByType, setVaultHint, getVaultHint,
    // request editor
    listRequestEditorCollectionTree, insertRequestEditorCollectionRow, updateRequestEditorCollectionRow,
    deleteRequestEditorCollectionNode,
    listRequestEditorEnvironments, upsertRequestEditorEnvironment, deleteRequestEditorEnvironment,
};
