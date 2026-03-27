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
        const msg = `Правила intercept (${reason}): ${enabledCount} вкл. / ${rules.length} всего; MITM-path (protocol.handle не используется)`;
        const payload = { reason, protocolHandleActive: false, rules };
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
 * Режим только MITM: protocol.handle для http(s) не регистрируется —
 * intercept в mitm-proxy (planMitmIntercept). Вызов сохранён для совместимости (resync при смене режима в IPC).
 */
function setTrafficMode(_mode) {
    resyncWebRequestHooks();
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

// ─── MITM pipeline: mock/block после расшифровки (как «ответ AzureTLS»), без protocol short-circuit ──

/**
 * Запрос уходит на локальный MITM (127.0.0.1:mitmPort) — тогда mock/block обрабатываем в mitm-proxy,
 * а в protocol.handle пропускаем, иначе Turnstile/CF видят «левый» ответ без нормального прокси-пути.
 */
async function sessionUsesCupnetMitm(tabSession, url) {
    if (!tabSession || typeof tabSession.resolveProxy !== 'function') return false;
    try {
        const raw = await tabSession.resolveProxy(url);
        const first = String(raw || '').split(';').map((s) => s.trim())[0] || '';
        const port = networkPolicy.mitmPort;
        return new RegExp(`^PROXY\\s+127\\.0\\.0\\.1:${port}\\b`, 'i').test(first);
    } catch {
        return false;
    }
}

/**
 * Не применять intercept (mock/block/modifyHeaders) к URL challenge/captcha/CF.
 * Широкий pattern (*, &lt;all_urls&gt;) иначе подменяет скрипты Turnstile / cdn-cgi на origin.
 * Отключить: CUPNET_INTERCEPT_ALLOW_MOCK_CF=1
 */
function bypassInterceptMockBlockForSensitiveUrl(urlStr) {
    if (process.env.CUPNET_INTERCEPT_ALLOW_MOCK_CF === '1') return false;
    let u;
    try { u = new URL(urlStr); } catch { return false; }
    const host = (u.hostname || '').toLowerCase();
    const path = (u.pathname || '').toLowerCase();
    const search = (u.search || '').toLowerCase();
    if (host === 'challenges.cloudflare.com') return true;
    if (host === 'turnstile.com' || host.endsWith('.turnstile.com')) return true;
    if (host.endsWith('.cloudflareinsights.com')) return true;
    if (path.includes('challenge-platform') || path.includes('/cdn-cgi/challenge')) return true;
    if (path.includes('/cdn-cgi/')) return true;
    if (path.includes('__cf_chl') || search.includes('__cf_chl')) return true;
    if (host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com')) return true;
    if (host.includes('recaptcha.net')) return true;
    if (host.includes('google.com') && path.includes('recaptcha')) return true;
    if (host.includes('gstatic.com') && path.includes('recaptcha')) return true;
    return false;
}

function _patchRequestOptsForMitm(opts, p) {
    const toSetReq = p.requestHeaders || {};
    const toRemoveReq = p.removeRequestHeaders || [];
    if (!opts.headers) opts.headers = {};
    for (const [k, v] of Object.entries(toSetReq)) opts.headers[k] = v;
    for (const k of toRemoveReq) {
        delete opts.headers[k];
        const lower = String(k).toLowerCase();
        for (const ex of Object.keys(opts.headers)) {
            if (String(ex).toLowerCase() === lower) delete opts.headers[ex];
        }
    }
    if (Array.isArray(opts.orderedHeaders) && opts.orderedHeaders.length) {
        for (const [k, v] of Object.entries(toSetReq)) {
            let hit = false;
            opts.orderedHeaders = opts.orderedHeaders.map(([hk, hv]) => {
                if (String(hk).toLowerCase() === String(k).toLowerCase()) {
                    hit = true;
                    return [hk, v];
                }
                return [hk, hv];
            });
            if (!hit) opts.orderedHeaders.push([k, v]);
        }
        for (const k of toRemoveReq) {
            const lower = String(k).toLowerCase();
            opts.orderedHeaders = opts.orderedHeaders.filter(
                ([hk]) => String(hk).toLowerCase() !== lower
            );
        }
    }
}

/**
 * @param {object} opts — копия dnsAdjusted (headers/orderedHeaders можно мутировать)
 * @returns {{ done: true, response: object } | { done: false, opts: object, postProcess: object|null }}
 */
function planMitmIntercept(opts) {
    const url = String(opts.url || '');
    const rules = loadRules();
    for (const rule of rules) {
        if (!ruleMatchesUrl(rule.url_pattern, url)) continue;
        if (bypassInterceptMockBlockForSensitiveUrl(url)) continue;

        if (rule.type === 'block') {
            _logRuleApplied('mitm', {
                type: 'block', ruleName: rule.name, url,
                tabId: null, detail: 'short-circuit',
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({ type: 'block', ruleName: rule.name, url, tabId: null });
                } catch (err) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'block', stage: 'mitm' } }, err);
                }
            }
            return {
                done: true,
                response: {
                    statusCode: 403,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    bodyBase64: Buffer.from('Blocked by CupNet', 'utf8').toString('base64'),
                    dnsOverride: opts.dnsOverride || null,
                },
            };
        }

        if (rule.type === 'mock') {
            const body = rule.params.body ?? '';
            const mimeType = rule.params.mimeType || 'text/plain';
            const statusCode = rule.params.status || 200;
            _logRuleApplied('mitm', {
                type: 'mock', ruleName: rule.name, url,
                tabId: null, method: opts.method || 'GET',
                status: statusCode, detail: `${statusCode} ${mimeType}`,
            });
            if (_onRuleMatch) {
                const bodyPreview = typeof body === 'string' && body.length > 0
                    ? body.substring(0, 120) + (body.length > 120 ? '…' : '') : '(empty)';
                try {
                    _onRuleMatch({
                        type: 'mock', ruleName: rule.name, url,
                        tabId: null, method: opts.method || 'GET',
                        status: statusCode, mimeType,
                        body: typeof body === 'string' ? body : String(body ?? ''),
                        detail: `${statusCode} ${mimeType}`, bodyPreview,
                    });
                } catch (err) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'mock', stage: 'mitm' } }, err);
                }
            }
            return {
                done: true,
                response: {
                    statusCode,
                    headers: { 'Content-Type': mimeType },
                    bodyBase64: Buffer.from(String(body), 'utf8').toString('base64'),
                    dnsOverride: opts.dnsOverride || null,
                },
            };
        }

        if (rule.type === 'modifyHeaders') {
            const p = rule.params;
            _patchRequestOptsForMitm(opts, p);
            const hasResp =
                Object.keys(p.responseHeaders || {}).length > 0
                || (p.removeResponseHeaders || []).length > 0;
            const dp = [];
            if (Object.keys(p.requestHeaders || {}).length) dp.push(`ReqSet: ${Object.keys(p.requestHeaders).join(', ')}`);
            if ((p.removeRequestHeaders || []).length) dp.push(`ReqRemove: ${p.removeRequestHeaders.join(', ')}`);
            if (Object.keys(p.responseHeaders || {}).length) dp.push(`RespSet: ${Object.keys(p.responseHeaders).join(', ')}`);
            if ((p.removeResponseHeaders || []).length) dp.push(`RespRemove: ${p.removeResponseHeaders.join(', ')}`);
            const detailStr = dp.join('; ') || 'Headers modified';
            _logRuleApplied('mitm', {
                type: 'modifyHeaders', ruleName: rule.name, url,
                tabId: null, detail: detailStr,
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({ type: 'modifyHeaders', ruleName: rule.name, url, tabId: null, detail: detailStr });
                } catch (err) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'modifyHeaders', stage: 'mitm' } }, err);
                }
            }
            return { done: false, opts, postProcess: hasResp ? p : null };
        }
    }
    return { done: false, opts, postProcess: null };
}

function finalizeMitmInterceptResponse(res, ruleParams) {
    if (!res || !ruleParams) return res;
    const toSetResp = ruleParams.responseHeaders || {};
    const toRemoveResp = ruleParams.removeResponseHeaders || [];
    if (!Object.keys(toSetResp).length && !toRemoveResp.length) return res;
    const headers = { ...(res.headers || {}) };
    for (const [k, v] of Object.entries(toSetResp)) headers[k] = v;
    for (const k of toRemoveResp) {
        delete headers[k];
        const lower = String(k).toLowerCase();
        for (const ex of Object.keys(headers)) {
            if (String(ex).toLowerCase() === lower) delete headers[ex];
        }
    }
    return { ...res, headers };
}

/** Для IPC перед сохранением правила */
function validateInterceptRuleForSave(rule) {
    if (!isStrictInterceptMode()) return { ok: true };
    return validateStrictInterceptUrlPattern(rule?.url_pattern);
}

// (webRequest hooks удалены — CF детектит onBeforeSendHeaders / onHeadersReceived.)
// block/mock при прокси на CupNet MITM: planMitmIntercept в mitm-proxy; в protocol.handle пропуск — sessionUsesCupnetMitm.

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
 * Только MITM: не регистрируем protocol.handle — intercept в mitm-proxy (planMitmIntercept).
 */
function _syncProtocolHandlers(tabSession) {
    if (!tabSession) return;
    try { tabSession.protocol.unhandle('http'); } catch { /* ignore */ }
    try { tabSession.protocol.unhandle('https'); } catch { /* ignore */ }
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
 * Attaches intercept rules to a given Electron session (MITM path only; protocol.handle не используется).
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
 * Пересинхронизировать снимок правил на всех сессиях (protocol.handle снят, intercept в MITM).
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
    planMitmIntercept,
    finalizeMitmInterceptResponse,
    sessionUsesCupnetMitm,
    bypassInterceptMockBlockForSensitiveUrl,
    setTrafficMode,
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
