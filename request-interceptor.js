'use strict';

const db = require('./db');
const { networkPolicy } = require('./network-policy');
const { safeCatch, sysLog } = require('./sys-log');

/** Логировать каждое срабатывание правила (block/modifyHeaders/mock). Выключить: CUPNET_INTERCEPT_LOG_MATCHES=0 */
function _interceptLogMatchesEnabled() {
    return process.env.CUPNET_INTERCEPT_LOG_MATCHES !== '0';
}

/** Логировать снимок правил при attach/resync. Выключить: CUPNET_INTERCEPT_LOG_RULES=0 */
function _interceptLogRulesEnabled() {
    return process.env.CUPNET_INTERCEPT_LOG_RULES !== '0';
}

function _interceptLogStdout() {
    return process.env.CUPNET_INTERCEPT_LOG_STDOUT === '1';
}

function _mirrorStdout(message, data) {
    if (!_interceptLogStdout()) return;
    try {
        const extra = data !== undefined ? ` ${JSON.stringify(data)}` : '';
        console.log(`[request-interceptor] ${message}${extra}`);
    } catch { /* ignore */ }
}

/**
 * Текущие правила (в системный лог / Console viewer).
 */
function _logRulesSnapshot(reason) {
    if (!_interceptLogRulesEnabled()) return;
    try {
        const rows = db.getAllInterceptRules();
        const rules = rows.map(r => ({
            id: r.id,
            enabled: !!r.enabled,
            name: r.name,
            type: r.type,
            pattern: r.url_pattern,
        }));
        const enabledCount = rules.filter(r => r.enabled).length;
        const hasAny = enabledCount > 0;
        const msg = `Правила intercept (${reason}): ${enabledCount} вкл. / ${rules.length} всего; protocol.handle=${hasAny ? 'да' : 'нет'}`;
        const payload = { reason, protocolHandleActive: hasAny, rules };
        sysLog('info', 'request-interceptor', msg, payload);
        _mirrorStdout(msg, payload);
    } catch (err) {
        safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.log_rules.failed' }, err, 'warn');
    }
}

function _logRuleApplied(stage, info) {
    if (!_interceptLogMatchesEnabled()) return;
    const url = String(info.url || '').slice(0, 256);
    const msg = `Сработало правило [${stage}] «${info.ruleName || '?'}» type=${info.type}`;
    const payload = {
        stage,
        ruleName: info.ruleName,
        type: info.type,
        url,
        tabId: info.tabId ?? undefined,
        method: info.method,
        detail: info.detail,
        status: info.status,
    };
    sysLog('info', 'request-interceptor', msg, payload);
    _mirrorStdout(msg, payload);
}

let _onRuleMatch = null;
function setOnRuleMatch(fn) { _onRuleMatch = typeof fn === 'function' ? fn : null; }

/** Optional (details) => tabId — см. setResolveTabIdFromDetails */
let _resolveTabIdFromDetails = null;
function setResolveTabIdFromDetails(fn) {
    _resolveTabIdFromDetails = typeof fn === 'function' ? fn : null;
}

/**
 * Сколько вкладок ссылается на эту Electron session. Несколько обычных вкладок делят
 * persist:cupnet-shared — хуки webRequest должны быть ровно один раз, иначе дубли
 * ломают заголовки/навигацию (в т.ч. Cloudflare). detachFromSession уменьшает счётчик.
 */
const _sessionAttachRefCount = new WeakMap();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely parse a value that may already be an object or a JSON string.
 */
function parseParams(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return {}; }
}

let _cachedRules = null;
let _cacheTime = 0;
const RULES_CACHE_TTL = 3000;

function loadRules() {
    const now = Date.now();
    if (_cachedRules && (now - _cacheTime) < RULES_CACHE_TTL) return _cachedRules;
    try {
        _cachedRules = db.getAllInterceptRules()
            .filter(r => r.enabled)
            .map(r => ({ ...r, params: parseParams(r.params) }));
        _cacheTime = now;
        return _cachedRules;
    } catch (err) {
        safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.rules.load_failed' }, err);
        return [];
    }
}

function invalidateRulesCache() {
    _cachedRules = null;
    _cacheTime = 0;
    resyncWebRequestHooks();
}

/**
 * Строгие intercept-паттерны: только конкретный префикс https?://host/... без * и без &lt;all_urls&gt;.
 * Сохранение правил валидируется; webRequest никогда не получает &lt;all_urls&gt; из-за широких glob.
 * Включение: CUPNET_INTERCEPT_STRICT_URLS=1
 */
function isStrictInterceptMode() {
    return process.env.CUPNET_INTERCEPT_STRICT_URLS === '1';
}

/**
 * Проверка паттерна для строгого режима (и для webRequest URL list).
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateStrictInterceptUrlPattern(pattern) {
    const p = String(pattern || '').trim();
    if (!p) return { ok: false, error: 'Пустой URL pattern' };
    if (p.includes('*')) {
        return {
            ok: false,
            error: 'В строгом режиме (CUPNET_INTERCEPT_STRICT_URLS=1) символ * запрещён. Укажите префикс, например https://api.example.com/v1/',
        };
    }
    if (p.toLowerCase() === '<all_urls>') return { ok: false, error: 'Запрещено использовать <all_urls> в строгом режиме' };
    if (/\s/.test(p)) return { ok: false, error: 'Уберите пробелы из URL pattern' };
    if (!/^https?:\/\//i.test(p)) return { ok: false, error: 'Нужна схема https:// или http://' };
    let u;
    try {
        u = new URL(p);
    } catch {
        return { ok: false, error: 'Некорректный URL' };
    }
    if (!u.hostname) return { ok: false, error: 'Укажите хост' };
    if (u.username || u.password) return { ok: false, error: 'Не используйте user:password в pattern' };
    return { ok: true };
}

/** Сопоставление URL со строгим префиксом (без *). */
function urlMatchesStrictPattern(pattern, url) {
    if (!validateStrictInterceptUrlPattern(pattern).ok) return false;
    let base;
    let req;
    try {
        base = new URL(pattern.trim());
        req = new URL(url);
    } catch {
        return false;
    }
    if (base.protocol.toLowerCase() !== req.protocol.toLowerCase()) return false;
    if (base.hostname.toLowerCase() !== req.hostname.toLowerCase()) return false;
    if (base.port !== req.port) return false;
    const bp = base.pathname || '/';
    const rp = req.pathname || '/';
    if (bp === '/' || bp === '') return true;
    if (rp === bp) return true;
    if (bp.endsWith('/')) return rp.startsWith(bp);
    return rp.startsWith(`${bp}/`);
}

function ruleMatchesUrl(pattern, url) {
    if (isStrictInterceptMode()) return urlMatchesStrictPattern(pattern, url);
    return matchesPattern(pattern, url);
}

/** Для IPC перед сохранением правила */
function validateInterceptRuleForSave(rule) {
    if (!isStrictInterceptMode()) return { ok: true };
    return validateStrictInterceptUrlPattern(rule?.url_pattern);
}

// (webRequest hooks полностью удалены — CF Turnstile детектит сам факт регистрации
//  onBeforeSendHeaders / onHeadersReceived, даже с узким URL-фильтром.
//  Все типы правил теперь через protocol.handle — он не детектируется.)

/**
 * Matches a URL against a glob-like pattern.
 * Supports * as wildcard; also handles exact match and substring fallback.
 */
function matchesPattern(pattern, url) {
    if (!pattern) return false;
    if (pattern === '<all_urls>' || pattern === '*') return true;
    try {
        const regexStr = '^' + pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*') + '$';
        return new RegExp(regexStr, 'i').test(url);
    } catch {
        return url.includes(pattern);
    }
}

// ─── Session attachment ───────────────────────────────────────────────────────

/**
 * Единый обработчик через protocol.handle — block, modifyHeaders, mock.
 * protocol.handle() прозрачен для антиботов (в отличие от webRequest, который детектируется
 * Cloudflare Turnstile даже при узком URL-фильтре). Для pass-through / modifyHeaders нужен
 * tabSession.fetch(..., { bypassCustomProtocolHandlers: true }) — иначе net.fetch без сессии
 * даёт ERR_CERT_INVALID при MITM. Принудительно net: CUPNET_INTERCEPT_USE_NET_FETCH=1.
 */
function _syncProtocolHandlers(tabSession) {
    if (!tabSession) return;
    const { net } = require('electron');
    const allRules = loadRules();

    if (allRules.length > 0) {
        const timeoutMs = networkPolicy.timeouts.passThroughMs;

        /** MITM: доверие к CA только на Session; net.fetch обходит verifyProc → -207. */
        const fetchThroughSession = (input, init) => {
            if (process.env.CUPNET_INTERCEPT_USE_NET_FETCH !== '1'
                && typeof tabSession.fetch === 'function') {
                return tabSession.fetch(input, init);
            }
            return net.fetch(input, init);
        };

        const protocolHandler = async (request) => {
            const rules = loadRules();
            for (const rule of rules) {
                if (!ruleMatchesUrl(rule.url_pattern, request.url)) continue;

                // ── Block ────────────────────────────────────────────────
                if (rule.type === 'block') {
                    _logRuleApplied('protocol', {
                        type: 'block', ruleName: rule.name, url: request.url,
                        tabId: null, detail: 'cancel',
                    });
                    if (_onRuleMatch) {
                        try { _onRuleMatch({ type: 'block', ruleName: rule.name, url: request.url, tabId: null }); } catch (err) {
                            safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'block' } }, err);
                        }
                    }
                    return new Response('Blocked by CupNet', { status: 403, headers: { 'Content-Type': 'text/plain' } });
                }

                // ── Mock ─────────────────────────────────────────────────
                if (rule.type === 'mock') {
                    const body       = rule.params.body       ?? '';
                    const mimeType   = rule.params.mimeType   || 'text/plain';
                    const statusCode = rule.params.status     || 200;
                    _logRuleApplied('protocol', {
                        type: 'mock', ruleName: rule.name, url: request.url,
                        tabId: null, method: request.method || 'GET',
                        status: statusCode, detail: `${statusCode} ${mimeType}`,
                    });
                    if (_onRuleMatch) {
                        const bodyPreview = typeof body === 'string' && body.length > 0
                            ? body.substring(0, 120) + (body.length > 120 ? '…' : '') : '(empty)';
                        try {
                            _onRuleMatch({
                                type: 'mock', ruleName: rule.name, url: request.url,
                                tabId: null, method: request.method || 'GET',
                                status: statusCode, mimeType,
                                body: typeof body === 'string' ? body : String(body ?? ''),
                                detail: `${statusCode} ${mimeType}`, bodyPreview,
                            });
                        } catch (err) {
                            safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'mock' } }, err);
                        }
                    }
                    return new Response(body, { status: statusCode, headers: { 'Content-Type': mimeType } });
                }

                // ── ModifyHeaders ────────────────────────────────────────
                if (rule.type === 'modifyHeaders') {
                    const toSetReq    = rule.params.requestHeaders         || {};
                    const toRemoveReq = rule.params.removeRequestHeaders   || [];
                    const toSetResp   = rule.params.responseHeaders        || {};
                    const toRemoveResp = rule.params.removeResponseHeaders || [];
                    const hasReqChanges  = Object.keys(toSetReq).length > 0 || toRemoveReq.length > 0;
                    const hasRespChanges = Object.keys(toSetResp).length > 0 || toRemoveResp.length > 0;

                    let resp;
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                    try {
                        if (hasReqChanges) {
                            const newHeaders = {};
                            for (const [k, v] of request.headers.entries()) newHeaders[k] = v;
                            for (const [k, v] of Object.entries(toSetReq)) newHeaders[k] = v;
                            for (const k of toRemoveReq) {
                                delete newHeaders[k];
                                const lower = k.toLowerCase();
                                for (const ex of Object.keys(newHeaders)) {
                                    if (ex.toLowerCase() === lower) delete newHeaders[ex];
                                }
                            }
                            const fetchOpts = {
                                method: request.method,
                                headers: newHeaders,
                                bypassCustomProtocolHandlers: true,
                                signal: ctrl.signal,
                            };
                            if (!['GET', 'HEAD'].includes(request.method) && request.body) {
                                fetchOpts.body = request.body;
                            }
                            resp = await fetchThroughSession(request.url, fetchOpts);
                        } else {
                            resp = await fetchThroughSession(request, {
                                bypassCustomProtocolHandlers: true,
                                signal: ctrl.signal,
                            });
                        }
                    } finally {
                        clearTimeout(timer);
                    }

                    if (hasRespChanges) {
                        const rh = new Headers(resp.headers);
                        for (const [k, v] of Object.entries(toSetResp)) rh.set(k, v);
                        for (const k of toRemoveResp) rh.delete(k);
                        resp = new Response(resp.body, {
                            status: resp.status,
                            statusText: resp.statusText,
                            headers: rh,
                        });
                    }

                    const dp = [];
                    if (Object.keys(toSetReq).length)  dp.push(`ReqSet: ${Object.keys(toSetReq).join(', ')}`);
                    if (toRemoveReq.length)             dp.push(`ReqRemove: ${toRemoveReq.join(', ')}`);
                    if (Object.keys(toSetResp).length)  dp.push(`RespSet: ${Object.keys(toSetResp).join(', ')}`);
                    if (toRemoveResp.length)            dp.push(`RespRemove: ${toRemoveResp.join(', ')}`);
                    const detailStr = dp.join('; ') || 'Headers modified';
                    _logRuleApplied('protocol', {
                        type: 'modifyHeaders', ruleName: rule.name, url: request.url,
                        tabId: null, detail: detailStr,
                    });
                    if (_onRuleMatch) {
                        try { _onRuleMatch({ type: 'modifyHeaders', ruleName: rule.name, url: request.url, tabId: null, detail: detailStr }); } catch (err) {
                            safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'modifyHeaders' } }, err);
                        }
                    }
                    return resp;
                }
            }

            // No rule matched — pass through
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                try {
                    return await fetchThroughSession(request, {
                        bypassCustomProtocolHandlers: true,
                        signal: ctrl.signal,
                    });
                } finally {
                    clearTimeout(timer);
                }
            } catch (err) {
                const msg = String(err?.message || err);
                return new Response(JSON.stringify({
                    error: 'cupnet_pass_through',
                    message: msg,
                }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        };

        try { tabSession.protocol.handle('http', protocolHandler); }
        catch (e) { safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.protocol.handle.failed', context: { scheme: 'http' } }, e); }
        try { tabSession.protocol.handle('https', protocolHandler); }
        catch (e) { safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.protocol.handle.failed', context: { scheme: 'https' } }, e); }
    } else {
        try { tabSession.protocol.unhandle('http'); }  catch { /* ignore */ }
        try { tabSession.protocol.unhandle('https'); } catch { /* ignore */ }
    }
}

/** Обратная совместимость: syncMockProtocolHandlers → теперь обрабатывает ВСЕ типы правил. */
function syncMockProtocolHandlers(tabSession) {
    _syncProtocolHandlers(tabSession);
}

function _removeAllHooks(tabSession) {
    // Снимаем legacy webRequest (на случай если остались от предыдущей версии)
    try { tabSession.webRequest.onBeforeSendHeaders(null); } catch { /* ignore */ }
    try { tabSession.webRequest.onHeadersReceived(null); }   catch { /* ignore */ }
    // Снимаем protocol handlers
    try { tabSession.protocol.unhandle('http'); }  catch { /* ignore */ }
    try { tabSession.protocol.unhandle('https'); } catch { /* ignore */ }
}

/**
 * Attaches intercept rules to a given Electron session.
 *
 * Все типы правил (block, modifyHeaders, mock) обрабатываются через session.protocol.handle().
 * webRequest API полностью не используется — Cloudflare Turnstile детектирует сам факт
 * регистрации onBeforeSendHeaders / onHeadersReceived, даже с узким URL-фильтром.
 * protocol.handle() прозрачен для антиботов.
 *
 * Pass-through / modifyHeaders: `fetchThroughSession` → `tabSession.fetch` (см. `_syncProtocolHandlers`).
 *
 * Для одной и той же session (общая partition) хуки ставятся один раз.
 */
const _STEALTH = Number(process.env.CUPNET_STEALTH_LEVEL || 0);

/** Все сессии, к которым мы когда-либо делали attach (для resync при изменении правил). */
const _attachedSessions = new Set();

function attachToSession(tabSession, _tabId) {
    if (_STEALTH >= 2) return;
    if (!tabSession) return;
    const prev = _sessionAttachRefCount.get(tabSession) || 0;
    const next = prev + 1;
    _sessionAttachRefCount.set(tabSession, next);
    _attachedSessions.add(tabSession);
    if (next === 1) {
        _syncProtocolHandlers(tabSession);
        _logRulesSnapshot('attach-session');
    }
}

/**
 * Пересинхронизировать protocol handlers на всех сессиях:
 * есть правила → зарегистрировать protocol.handle; нет правил → unhandle.
 */
function resyncWebRequestHooks() {
    for (const sess of _attachedSessions) {
        const refCount = _sessionAttachRefCount.get(sess) || 0;
        if (refCount <= 0) { _attachedSessions.delete(sess); continue; }
        _syncProtocolHandlers(sess);
    }
    _logRulesSnapshot('resync');
}

/**
 * Detaches intercept hooks when последняя вкладка с этой session закрыта.
 */
function detachFromSession(tabSession) {
    if (!tabSession) return;
    const prev = _sessionAttachRefCount.get(tabSession) || 0;
    const next = Math.max(0, prev - 1);
    if (next <= 0) {
        _sessionAttachRefCount.delete(tabSession);
        _attachedSessions.delete(tabSession);
        _removeAllHooks(tabSession);
    } else {
        _sessionAttachRefCount.set(tabSession, next);
    }
}

module.exports = {
    attachToSession,
    detachFromSession,
    syncMockProtocolHandlers,
    resyncWebRequestHooks,
    matchesPattern,
    ruleMatchesUrl,
    invalidateRulesCache,
    isStrictInterceptMode,
    validateStrictInterceptUrlPattern,
    validateInterceptRuleForSave,
    urlMatchesStrictPattern,
    setOnRuleMatch,
    setResolveTabIdFromDetails,
};
