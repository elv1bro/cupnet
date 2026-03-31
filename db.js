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

function migrateSchema() {
    // Add new columns to proxy_profiles if they don't exist (for existing DBs)
    const cols = db.pragma('table_info(proxy_profiles)').map(c => c.name);
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
                created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            INSERT INTO intercept_rules__cupnet_new (id, name, enabled, url_pattern, type, params, created_at)
                SELECT id, name, enabled, url_pattern, type, params, created_at FROM intercept_rules;
            DROP TABLE intercept_rules;
            ALTER TABLE intercept_rules__cupnet_new RENAME TO intercept_rules;
            COMMIT;
        `);
    }
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
    const noteCols = db.pragma('table_info(user_notes)').map(c => c.name);
    if (noteCols.length && !noteCols.includes('url_match')) {
        db.exec(`ALTER TABLE user_notes ADD COLUMN url_match TEXT NOT NULL DEFAULT ''`);
        db.exec(`UPDATE user_notes SET url_match = domain WHERE url_match = '' OR url_match IS NULL`);
    }
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

        CREATE TABLE IF NOT EXISTS rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            conditions  TEXT    NOT NULL,
            actions     TEXT    NOT NULL,
            hit_count   INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS intercept_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            url_pattern TEXT    NOT NULL,
            type        TEXT    NOT NULL CHECK(type IN ('block','modifyHeaders','mock','script')),
            params      TEXT,
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

        CREATE TABLE IF NOT EXISTS trace_entries (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts              TEXT    NOT NULL,
            method          TEXT    NOT NULL DEFAULT 'GET',
            url             TEXT    NOT NULL,
            request_headers TEXT,
            request_body    TEXT,
            status          INTEGER,
            response_headers TEXT,
            response_body   TEXT,
            duration_ms     INTEGER,
            tab_id          TEXT,
            session_id      INTEGER,
            browser         TEXT,
            proxy           TEXT,
            created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_trace_created ON trace_entries(created_at);
        CREATE INDEX IF NOT EXISTS idx_trace_session ON trace_entries(session_id);

        CREATE TABLE IF NOT EXISTS user_notes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            domain          TEXT    NOT NULL,
            url_match       TEXT    NOT NULL DEFAULT '',
            page_url        TEXT    NOT NULL,
            title           TEXT    NOT NULL DEFAULT '',
            body_plain      TEXT,
            body_encrypted  BLOB,
            is_encrypted    INTEGER NOT NULL DEFAULT 0 CHECK(is_encrypted IN (0, 1)),
            created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_user_notes_domain ON user_notes(domain);
        CREATE INDEX IF NOT EXISTS idx_user_notes_created ON user_notes(created_at);

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
    `);
}

// ─── Cached prepared statements (initialized after db.init()) ────────────────
let _stmtCreateSession = null;
let _stmtCreateExtSession = null;
let _stmtInsertRequest = null;
let _stmtInsertWsEvent = null;
let _stmtInsertSS      = null;
let _stmtInsertTrace   = null;
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
    _stmtInsertTrace   = db.prepare(`
        INSERT INTO trace_entries (ts, method, url, request_headers, request_body, status, response_headers, response_body, duration_ms, tab_id, session_id, browser, proxy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    // Cascade: remove related requests first, then the session itself
    db.prepare(`DELETE FROM requests WHERE session_id = ?`).run(id);
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

// ─── Trace entries ────────────────────────────────────────────────────────────

function insertTraceEntry(entry) {
    const row = _stmtInsertTrace.get(
        entry.ts || new Date().toISOString(),
        entry.method || 'GET',
        entry.url || '',
        entry.requestHeaders ? JSON.stringify(entry.requestHeaders) : null,
        entry.requestBody || null,
        entry.status ?? null,
        entry.responseHeaders ? JSON.stringify(entry.responseHeaders) : null,
        entry.responseBody != null ? String(entry.responseBody).slice(0, 50000) : null,
        entry.duration != null ? Math.round(entry.duration) : null,
        entry.tabId || null,
        entry.sessionId ?? null,
        entry.browser || null,
        entry.proxy || null
    );
    return row ? row.id : null;
}

function insertTraceEntryQueued(entry) {
    if (!networkPolicy.featureFlags.dbTraceQueue) {
        return Promise.resolve(insertTraceEntry(entry));
    }
    return enqueueWrite(() => insertTraceEntry(entry), 'low').catch(() => null);
}

function queryTraceEntries(limit = 200, offset = 0) {
    return db.prepare(`
        SELECT id, ts, method, url, status, duration_ms, tab_id, session_id, browser, created_at
        FROM trace_entries ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
}

function getTraceEntriesBySession(sessionId, limit = 2000, offset = 0) {
    return db.prepare(`
        SELECT *
        FROM trace_entries
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset);
}

function getTraceEntry(id) {
    return db.prepare(`SELECT * FROM trace_entries WHERE id = ?`).get(id);
}

function countTraceEntries() {
    return db.prepare(`SELECT COUNT(*) as cnt FROM trace_entries`).get().cnt;
}

function clearTraceEntries() {
    db.prepare(`DELETE FROM trace_entries`).run();
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

// ─── Proxy profiles ──────────────────────────────────────────────────────────

function normalizeTrafficMode(_mode) {
    return 'mitm';
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
        variables: r.variables ? JSON.parse(r.variables) : {}
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
    const row = db.prepare(`SELECT name, url_encrypted, variables, user_agent, timezone, language,
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

// ─── Rules ───────────────────────────────────────────────────────────────────

function getRules() {
    return db.prepare(`SELECT * FROM rules ORDER BY id LIMIT 1000`).all().map(parseJsonFields('conditions', 'actions'));
}

function saveRule(rule) {
    const conditions = JSON.stringify(rule.conditions || []);
    const actions    = JSON.stringify(rule.actions || []);
    if (rule.id) {
        db.prepare(`UPDATE rules SET name=?, enabled=?, conditions=?, actions=? WHERE id=?`)
          .run(rule.name, rule.enabled ? 1 : 0, conditions, actions, rule.id);
        return rule.id;
    }
    const row = db.prepare(
        `INSERT INTO rules (name, enabled, conditions, actions) VALUES (?,?,?,?) RETURNING id`
    ).get(rule.name, rule.enabled !== false ? 1 : 0, conditions, actions);
    return row ? row.id : null;
}

function deleteRule(id) {
    db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
}

function toggleRule(id, enabled) {
    db.prepare(`UPDATE rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

function incrementRuleHit(id) {
    db.prepare(`UPDATE rules SET hit_count = hit_count + 1 WHERE id = ?`).run(id);
}

// ─── Intercept rules ─────────────────────────────────────────────────────────

function getInterceptRules() {
    return db.prepare(`SELECT * FROM intercept_rules WHERE enabled = 1 ORDER BY id LIMIT 1000`).all().map(parseJsonFields('params'));
}

function getAllInterceptRules() {
    return db.prepare(`SELECT * FROM intercept_rules ORDER BY id LIMIT 1000`).all().map(parseJsonFields('params'));
}

function saveInterceptRule(rule) {
    const params = JSON.stringify(rule.params || {});
    if (rule.id) {
        db.prepare(`UPDATE intercept_rules SET name=?, enabled=?, url_pattern=?, type=?, params=? WHERE id=?`)
          .run(rule.name, rule.enabled ? 1 : 0, rule.url_pattern, rule.type, params, rule.id);
        return rule.id;
    }
    const row = db.prepare(
        `INSERT INTO intercept_rules (name, enabled, url_pattern, type, params) VALUES (?,?,?,?,?) RETURNING id`
    ).get(rule.name, rule.enabled !== false ? 1 : 0, rule.url_pattern, rule.type, params);
    return row ? row.id : null;
}

function deleteInterceptRule(id) {
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
    if (isWildcardHost && !mitmCors) throw new Error('Wildcard host is only allowed for MITM CORS-only rules');
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

function insertTraceEntryAsync(entry) {
    return enqueueWrite(() => insertTraceEntry(entry), 'low');
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

function saveRuleAsync(rule) {
    return enqueueWrite(() => saveRule(rule), 'high');
}

function deleteRuleAsync(id) {
    return enqueueWrite(() => deleteRule(id), 'high');
}

function toggleRuleAsync(id, enabled) {
    return enqueueWrite(() => toggleRule(id, enabled), 'high');
}

function incrementRuleHitAsync(id) {
    return enqueueWrite(() => incrementRuleHit(id), 'low');
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

function clearTraceEntriesAsync() {
    return enqueueWrite(() => clearTraceEntries(), 'high');
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

    let sqlList = `
        SELECT id, domain, url_match, page_url, title, is_encrypted, created_at, updated_at,
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
    sqlList += ` ORDER BY datetime(updated_at) DESC LIMIT ?`;
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
    if (rec.id) {
        const nid = Number(rec.id);
        if (isEnc) {
            db.prepare(`
                UPDATE user_notes SET domain = ?, url_match = ?, title = ?, body_plain = NULL,
                    body_encrypted = ?, is_encrypted = 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id = ?
            `).run(domain, urlMatch, title, rec.body_encrypted, nid);
        } else {
            db.prepare(`
                UPDATE user_notes SET domain = ?, url_match = ?, title = ?, body_plain = ?,
                    body_encrypted = NULL, is_encrypted = 0,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id = ?
            `).run(domain, urlMatch, title, rec.body_plain ?? '', nid);
        }
        return nid;
    }
    if (isEnc) {
        const r = db.prepare(`
            INSERT INTO user_notes (domain, url_match, page_url, title, body_plain, body_encrypted, is_encrypted)
            VALUES (?, ?, ?, ?, NULL, ?, 1)
        `).run(domain, urlMatch, pageUrl, title, rec.body_encrypted);
        return Number(r.lastInsertRowid);
    }
    const r = db.prepare(`
        INSERT INTO user_notes (domain, url_match, page_url, title, body_plain, body_encrypted, is_encrypted)
        VALUES (?, ?, ?, ?, ?, NULL, 0)
    `).run(domain, urlMatch, pageUrl, title, rec.body_plain ?? '');
    return Number(r.lastInsertRowid);
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
    _stmtInsertSS = _stmtInsertTrace = _stmtEndSession = null;
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
    insertRequest, updateRequest, setRequestAnnotation, queryRequests, queryRequestsFull, countRequests, getRequest, ftsSearch,
    insertRequestAsync, updateRequestAsync, setRequestAnnotationAsync,
    // ws
    insertWsEvent, insertWsEventAsync, queryWsEvents, queryWsEventsBySession,
    // screenshots
    insertScreenshot, insertScreenshotAsync, getScreenshotsForSession, getScreenshotEntriesForSession, getScreenshotData,
    // proxy profiles
    getProxyProfiles, saveProxyProfile, updateProxyProfileById,
    getProxyProfileEncrypted, updateProxyProfileTest, updateProxyProfileGeo, deleteProxyProfile,
    saveProxyProfileAsync, updateProxyProfileByIdAsync, updateProxyProfileTestAsync, updateProxyProfileGeoAsync, deleteProxyProfileAsync,
    // rules
    getRules, saveRule, deleteRule, toggleRule, incrementRuleHit,
    saveRuleAsync, deleteRuleAsync, toggleRuleAsync, incrementRuleHitAsync,
    // intercept rules
    getInterceptRules, getAllInterceptRules, saveInterceptRule, deleteInterceptRule,
    saveInterceptRuleAsync, deleteInterceptRuleAsync,
    // dns overrides
    getDnsOverrides, saveDnsOverride, deleteDnsOverride, toggleDnsOverride,
    saveDnsOverrideAsync, deleteDnsOverrideAsync, toggleDnsOverrideAsync,
    // cookie groups
    getCookieGroups, getCookieGroup, createCookieGroup, renameCookieGroup, deleteCookieGroup,
    createCookieGroupAsync, renameCookieGroupAsync, deleteCookieGroupAsync,
    // trace
    insertTraceEntry, insertTraceEntryAsync, insertTraceEntryQueued, queryTraceEntries, getTraceEntriesBySession, getTraceEntry, countTraceEntries, clearTraceEntries, clearTraceEntriesAsync,
    getWriteQueueStats,
    // user notes
    listUserNotes, getUserNote, saveUserNote, deleteUserNote, saveUserNoteAsync, deleteUserNoteAsync,
};
