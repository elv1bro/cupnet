'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const { networkPolicy } = require('./network-policy');
const { safeCatch, sysLog } = require('./sys-log');
const { isDocumentRequest, injectScriptsIntoHtmlResponse } = require('./html-inject');
const mirrorRewrite = require('./mirror-rewrite');

/** Same-origin path served by the MITM itself (page beacons from injected scripts), never the origin. */
const CUPNET_LOCAL_PATH_PREFIX = '/__cupnet/';

/**
 * Optional: async (opts) => response|null for requests to `/__cupnet/*` on any origin. Only set by
 * hosts that serve that path (CupNet mini); without a handler those requests go to the origin as-is.
 */
let _localEndpointHandler = null;
function setLocalEndpointHandler(fn) {
    _localEndpointHandler = typeof fn === 'function' ? fn : null;
}

/**
 * Optional: (opts, matchUrl) => Array<{ source, position?, name?, connectSelf? }> — built-in scripts
 * for document loads, injected before any `inject` rule (CupNet mini page agent). Errors are ignored.
 */
let _documentScriptsProvider = null;
function setDocumentScriptsProvider(fn) {
    _documentScriptsProvider = typeof fn === 'function' ? fn : null;
}

/**
 * Optional: async (opts, rule, meta) => Promise<{ action?: 'forward'|'block', patch?: object }>
 * — breakpoint pause (see main-process / breakpoint.html).
 */
let _breakpointHandler = null;
function setBreakpointHandler(fn) {
    _breakpointHandler = typeof fn === 'function' ? fn : null;
}

/**
 * Optional: (entry) => void — receives one before/after record per `mirror` rule response so a host
 * (CupNet mini) can store an audit trail. Called fire-and-forget from finalize; errors are ignored.
 */
let _mirrorAuditSink = null;
function setMirrorAuditSink(fn) {
    _mirrorAuditSink = typeof fn === 'function' ? fn : null;
}

function applyBreakpointPatch(opts, patch) {
    if (!patch || typeof patch !== 'object') return;
    if (patch.url != null) opts.url = String(patch.url);
    if (patch.method != null) opts.method = String(patch.method);
    if (patch.headers && typeof patch.headers === 'object') {
        opts.headers = { ...(opts.headers || {}), ...patch.headers };
    }
    if (Array.isArray(patch.orderedHeaders)) {
        opts.orderedHeaders = patch.orderedHeaders.map((pair) => {
            if (!Array.isArray(pair) || pair.length < 2) return ['', ''];
            return [String(pair[0]), String(pair[1])];
        });
    }
    if (patch.bodyBase64 != null) {
        opts.bodyBase64 = String(patch.bodyBase64);
        opts.body = undefined;
    } else if (patch.body != null) {
        opts.body = patch.body;
        opts.bodyBase64 = undefined;
    }
    if (patch.interceptMatchUrl != null) opts.interceptMatchUrl = String(patch.interceptMatchUrl);
}

const INTERCEPT_SCRIPT_MS = Math.min(
    60_000,
    Math.max(50, Number(process.env.CUPNET_INTERCEPT_SCRIPT_MS || 400) || 400),
);

const MITM_POST_SCRIPT_AFTER = 'scriptAfter';
const MITM_POST_MIRROR = 'mirror';

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
        const rows = _ruleStore().getAllInterceptRules();
        const rules = rows.map(r => ({
            id: r.id,
            enabled: !!r.enabled,
            name: r.name,
            type: r.type,
            pattern: r.url_pattern,
        }));
        const enabledCount = rules.filter(r => r.enabled).length;
        const msg = `Intercept rules (${reason}): ${enabledCount} enabled / ${rules.length} total; MITM path (no protocol.handle)`;
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
    const msg = `Rule matched [${stage}] "${info.ruleName || '?'}" type=${info.type}`;
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

/**
 * Rule store: db.js (SQLite) by default, loaded lazily. CupNet mini injects a JSON-file store so the
 * MITM path runs on plain Node without Electron/better-sqlite3. A store implements
 * getAllInterceptRules(), incrementInterceptRuleHitAsync(id), setInterceptRuleErrorAsync(id, err).
 */
let _injectedRuleStore = null;
function _ruleStore() {
    return _injectedRuleStore || require('./db');
}
function setRuleStore(store) {
    _injectedRuleStore = store || null;
    _cachedRules = null;
    _cacheTime = 0;
}

let _cachedRules = null;
let _cacheTime = 0;
const RULES_CACHE_TTL = 3000;

function loadRules() {
    const now = Date.now();
    if (_cachedRules && (now - _cacheTime) < RULES_CACHE_TTL) return _cachedRules;
    try {
        _cachedRules = _ruleStore().getAllInterceptRules()
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

function _bumpRuleHit(rule) {
    if (rule && rule.id != null) {
        _ruleStore().incrementInterceptRuleHitAsync(rule.id).catch(() => {});
    }
}

function ruleMatchesMethod(rule, method) {
    const m = String(method || 'GET').toUpperCase();
    const rm = rule.method != null ? String(rule.method).trim() : '*';
    if (!rm || rm === '*') return true;
    return rm.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).includes(m);
}

function getHeaderMap(headers) {
    const h = headers && typeof headers === 'object' ? headers : {};
    return new Map(Object.entries(h).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
}

function ruleMatchesExtraConditions(rule, opts) {
    const p = rule.params || {};
    const mh = p.matchHeaders;
    if (Array.isArray(mh) && mh.length) {
        const hdrMap = getHeaderMap(opts.headers);
        for (const entry of mh) {
            if (!entry || typeof entry !== 'object') continue;
            const key = String(entry.key || '').toLowerCase();
            if (!key) continue;
            const op = String(entry.op || 'eq').toLowerCase();
            const val = entry.value != null ? String(entry.value) : '';
            const hv = hdrMap.get(key) || '';
            if (op === 'exists' || op === 'present') {
                if (!hdrMap.has(key)) return false;
            } else if (op === 'notexists' || op === 'absent') {
                if (hdrMap.has(key)) return false;
            } else if (op === 'contains') {
                if (!hv.includes(val)) return false;
            } else if (op === 'regex') {
                try {
                    if (!new RegExp(val, 'i').test(hv)) return false;
                } catch {
                    return false;
                }
            } else {
                if (hv !== val) return false;
            }
        }
    }
    const mb = p.matchBody;
    if (mb && typeof mb === 'object' && mb.value) {
        let bodyStr = '';
        if (opts.bodyBase64) {
            try {
                bodyStr = Buffer.from(String(opts.bodyBase64), 'base64').toString('utf8');
            } catch {
                bodyStr = '';
            }
        } else if (opts.body != null) {
            bodyStr = String(opts.body);
        }
        const mode = String(mb.mode || 'contains').toLowerCase();
        const needle = String(mb.value);
        if (mode === 'regex') {
            try {
                if (!new RegExp(needle).test(bodyStr)) return false;
            } catch {
                return false;
            }
        } else if (!bodyStr.includes(needle)) {
            return false;
        }
    }
    return true;
}

function mergeModifyHeadersParams(a, b) {
    if (!a) return b;
    if (!b) return a;
    const reqA = a.requestHeaders || {};
    const reqB = b.requestHeaders || {};
    const resA = a.responseHeaders || {};
    const resB = b.responseHeaders || {};
    const remReq = [...(a.removeRequestHeaders || []), ...(b.removeRequestHeaders || [])];
    const remRes = [...(a.removeResponseHeaders || []), ...(b.removeResponseHeaders || [])];
    return {
        requestHeaders: { ...reqA, ...reqB },
        responseHeaders: { ...resA, ...resB },
        removeRequestHeaders: remReq,
        removeResponseHeaders: remRes,
    };
}

function stopOnMatch(rule) {
    return rule.stop_on_match !== 0 && rule.stop_on_match !== false;
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
    if (!p) return { ok: false, error: 'URL pattern is empty' };
    if (p.includes('*')) {
        return {
            ok: false,
            error: 'With CUPNET_INTERCEPT_STRICT_URLS=1, * is not allowed. Use a prefix, e.g. https://api.example.com/v1/',
        };
    }
    if (p.toLowerCase() === '<all_urls>') return { ok: false, error: '<all_urls> is not allowed in strict mode' };
    if (/\s/.test(p)) return { ok: false, error: 'Remove spaces from the URL pattern' };
    if (!/^https?:\/\//i.test(p)) return { ok: false, error: 'Use an https:// or http:// URL' };
    let u;
    try {
        u = new URL(p);
    } catch {
        return { ok: false, error: 'Invalid URL' };
    }
    if (!u.hostname) return { ok: false, error: 'Host is required' };
    if (u.username || u.password) return { ok: false, error: 'Do not use user:password in the pattern' };
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

/**
 * A pattern with no scheme and no glob, e.g. "example.com" or "example.com/app", is a host[+path]
 * the user typed (the natural way to point a mirror at a site). Match it against the request's host
 * (any scheme/port) and, if given, a path prefix. Without this a bare host used to compile to the
 * regex /^example\.com$/ and match no full URL at all, so the rule silently never fired.
 */
function hostPatternMatches(pattern, url) {
    const p = String(pattern || '').trim().replace(/^\/+/, '');
    if (!p || p.includes('*')) return false;
    const slash = p.indexOf('/');
    let host = (slash === -1 ? p : p.slice(0, slash)).toLowerCase();
    const pathPrefix = slash === -1 ? '' : p.slice(slash);
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon); // drop an optional :port from the typed host
    host = host.replace(/\.$/, '');
    if (!host) return false;
    let req;
    try { req = new URL(url); } catch { return false; }
    if (req.hostname.toLowerCase().replace(/\.$/, '') !== host) return false;
    if (!pathPrefix || pathPrefix === '/') return true;
    const rp = req.pathname || '/';
    if (rp === pathPrefix) return true;
    if (pathPrefix.endsWith('/')) return rp.startsWith(pathPrefix);
    return rp.startsWith(`${pathPrefix}/`);
}

/** A bare host[/path] token: no glob, no scheme, and the first segment looks like a hostname. */
function isBareHostPattern(p) {
    if (!p || p.includes('*') || /:\/\//.test(p)) return false;
    const head = p.replace(/^\/+/, '').split('/')[0].split(':')[0];
    return head === 'localhost' || head.includes('.');
}

function ruleMatchesUrl(pattern, url) {
    if (isStrictInterceptMode()) return urlMatchesStrictPattern(pattern, url);
    const p = String(pattern || '').trim();
    // Plain https? URL without globs: match like strict prefix on origin+pathname (query/hash on the
    // request do not break the match). Regex-on-full-string mode used to require ^...$ on the entire
    // href, so ?culture=… blocked mocks for URLs copied from DevTools without *.
    if (/^https?:\/\//i.test(p) && !p.includes('*')) {
        return urlMatchesStrictPattern(p, url);
    }
    // Bare host ("example.com", "example.com/app") typed without a scheme → match by host (+ path).
    if (isBareHostPattern(p)) {
        return hostPatternMatches(p, url);
    }
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

/**
 * @param {string} source пользовательское тело, аргумент ctx
 * @param {object} ctx
 * @param {string} phaseLabel
 * @returns {string|null} сообщение об ошибке
 */
function runInterceptScriptPhase(source, ctx, phaseLabel) {
    const src = String(source || '').trim();
    if (!src) return null;
    const wrapped = `(function (ctx) {\n${src}\n})(ctx);`;
    const sandbox = {
        ctx,
        Buffer,
        TextDecoder: globalThis.TextDecoder,
        TextEncoder: globalThis.TextEncoder,
    };
    try {
        vm.runInNewContext(wrapped, sandbox, {
            timeout: INTERCEPT_SCRIPT_MS,
            filename: `cupnet-intercept-${phaseLabel}.js`,
            displayErrors: true,
        });
        return null;
    } catch (e) {
        return e.message || String(e);
    }
}

/**
 * @param {string} body
 * @param {string} label
 * @returns {string|null}
 */
function validateScriptSyntax(body, label) {
    const wrapped = `(function (ctx) {\n${body}\n})({});`;
    try {
        new vm.Script(wrapped, { filename: `cupnet-intercept-validate-${label}.js` });
        return null;
    } catch (e) {
        return e.message || String(e);
    }
}

/**
 * @param {object} sc
 * @param {object|null} dnsOverride
 */
function normalizeShortCircuitResponse(sc, dnsOverride) {
    if (!sc || typeof sc !== 'object') return null;
    const statusCode = Number(sc.statusCode) >= 100 ? Number(sc.statusCode) : 200;
    const headers = { ...(sc.headers || {}) };
    let bodyBase64 = sc.bodyBase64;
    if (bodyBase64 == null && sc.body != null) {
        bodyBase64 = Buffer.from(String(sc.body), 'utf8').toString('base64');
    }
    if (bodyBase64 == null) bodyBase64 = '';
    return {
        statusCode,
        headers,
        bodyBase64: String(bodyBase64),
        dnsOverride: dnsOverride || null,
    };
}

/**
 * MITM wire request is built from `orderedHeaders` only; script rules often mutate `ctx.headers`.
 * Append any header key present in `headers` but missing from the ordered list (case-insensitive).
 * @param {Record<string, string>} headers
 * @param {Array<[string, string]>|undefined} orderedHeaders
 * @returns {Array<[string, string]>}
 */
function mergeHeadersIntoOrdered(headers, orderedHeaders) {
    const h = headers && typeof headers === 'object' ? headers : {};
    const list = Array.isArray(orderedHeaders) ? orderedHeaders.map((pair) => [...pair]) : [];
    const seen = new Set(list.map(([k]) => String(k).toLowerCase()));
    for (const [k, v] of Object.entries(h)) {
        if (v == null) continue;
        const kl = String(k).toLowerCase();
        if (seen.has(kl)) continue;
        list.push([k, String(v)]);
        seen.add(kl);
    }
    return list;
}

function _applyBeforeCtxToMitmOpts(opts, beforeCtx) {
    opts.url = String(beforeCtx.url != null ? beforeCtx.url : opts.url || '');
    opts.method = String(beforeCtx.method != null ? beforeCtx.method : opts.method || 'GET');
    opts.headers = { ...(beforeCtx.headers || {}) };
    const oh = Array.isArray(beforeCtx.orderedHeaders)
        ? beforeCtx.orderedHeaders.map((pair) => [...pair])
        : undefined;
    opts.orderedHeaders = mergeHeadersIntoOrdered(opts.headers, oh);
    if (beforeCtx.bodyBase64 != null && String(beforeCtx.bodyBase64) !== '') {
        opts.bodyBase64 = String(beforeCtx.bodyBase64);
        opts.body = undefined;
    } else if (beforeCtx.body !== null && beforeCtx.body !== undefined) {
        opts.body = beforeCtx.body;
        opts.bodyBase64 = undefined;
    } else {
        opts.body = undefined;
        opts.bodyBase64 = undefined;
    }
}

/**
 * Прогон скриптов на тестовых данных (без сети).
 * @param {object} payload
 */
function runInterceptScriptSelfTest(payload) {
    const sampleUrl = payload?.sampleUrl || 'https://example.com/api/test';
    const method = payload?.sampleMethod || 'GET';
    const reqHeaders = payload?.sampleRequestHeaders && typeof payload.sampleRequestHeaders === 'object'
        ? { ...payload.sampleRequestHeaders }
        : { 'User-Agent': 'CupNetTest/1' };
    const orderedHeaders = Object.entries(reqHeaders).map(([k, v]) => [k, String(v)]);
    const beforeCtx = {
        url: sampleUrl,
        method,
        headers: { ...reqHeaders },
        orderedHeaders,
        body: payload?.sampleBody ?? null,
        bodyBase64: payload?.sampleBodyBase64 != null ? String(payload.sampleBodyBase64) : null,
        dnsOverride: null,
        tabId: null,
        requestId: 'test',
        shortCircuit: null,
    };
    const beforeSrc = String(payload?.beforeSource || '');
    const afterSrc = String(payload?.afterSource || '');
    const errB = runInterceptScriptPhase(beforeSrc, beforeCtx, 'before-selftest');
    if (errB) return { ok: false, error: `before MITM: ${errB}` };
    if (beforeCtx.shortCircuit) {
        const sc = normalizeShortCircuitResponse(beforeCtx.shortCircuit, null);
        if (!sc) return { ok: false, error: 'shortCircuit: invalid object' };
        return {
            ok: true,
            summary: `Short-circuit (no network): HTTP ${sc.statusCode}, ${Object.keys(sc.headers).length} header(s), bodyBase64 length ${sc.bodyBase64.length}`,
        };
    }
    const reqSnap = {
        url: String(beforeCtx.url),
        method: String(beforeCtx.method),
        headers: { ...(beforeCtx.headers || {}) },
        orderedHeaders: Array.isArray(beforeCtx.orderedHeaders)
            ? mapHeaderPairs(beforeCtx.orderedHeaders)
            : [],
    };
    const statusCode = payload?.sampleResponseStatus ?? 200;
    const respHeaders = payload?.sampleResponseHeaders && typeof payload.sampleResponseHeaders === 'object'
        ? { ...payload.sampleResponseHeaders }
        : { 'content-type': 'application/json' };
    let bodyB64 = '';
    if (payload?.sampleResponseBodyBase64) {
        bodyB64 = String(payload.sampleResponseBodyBase64);
    } else {
        const txt = payload?.sampleResponseBodyText != null ? String(payload.sampleResponseBodyText) : '{"test":true}';
        bodyB64 = Buffer.from(txt, 'utf8').toString('base64');
    }
    const afterCtx = {
        request: reqSnap,
        response: {
            statusCode,
            headers: { ...respHeaders },
            bodyBase64: bodyB64,
        },
    };
    const errA = runInterceptScriptPhase(afterSrc, afterCtx, 'after-selftest');
    if (errA) return { ok: false, error: `after response: ${errA}` };
    const outStatus = afterCtx.response.statusCode;
    const hk = Object.keys(afterCtx.response.headers || {}).length;
    const blen = String(afterCtx.response.bodyBase64 || '').length;
    return {
        ok: true,
        summary: `After \"before\": ${reqSnap.method} ${reqSnap.url}\nAfter \"after\": HTTP ${outStatus}, ${hk} header(s), bodyBase64 length ${blen}`,
    };
}

function mapHeaderPairs(arr) {
    return arr.map((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return [String(pair?.[0] ?? ''), String(pair?.[1] ?? '')];
        return [String(pair[0]), String(pair[1])];
    });
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
 * Mirror rule: point the outbound request at the upstream host. Rewrites opts.url (so the worker
 * fetches host A) and the Host / `:authority` headers to the upstream authority so the origin sees
 * its own host. The reverse path rewriting is done by mirror-rewrite.rewriteRequest.
 */
function _applyMirrorRequest(opts, upstream) {
    opts.url = upstream.url;
    const authority = upstream.port && upstream.port !== 443
        ? `${upstream.host}:${upstream.port}`
        : upstream.host;
    if (!opts.headers) opts.headers = {};
    for (const k of Object.keys(opts.headers)) {
        const low = k.toLowerCase();
        if (low === 'host' || low === ':authority') delete opts.headers[k];
    }
    opts.headers.Host = authority;
    if (Array.isArray(opts.orderedHeaders)) {
        let sawAuthority = false;
        opts.orderedHeaders = opts.orderedHeaders.map(([k, v]) => {
            const low = String(k).toLowerCase();
            if (low === ':authority') { sawAuthority = true; return [k, authority]; }
            if (low === 'host') return [k, authority];
            return [k, v];
        });
        // Keep HTTP/2's pseudo-authority consistent even if Chrome only sent a Host header.
        if (!sawAuthority && !opts.orderedHeaders.some(([k]) => String(k).toLowerCase() === 'host')) {
            opts.orderedHeaders.unshift(['Host', authority]);
        }
    }
}

/**
 * @param {object} opts — копия dnsAdjusted (headers/orderedHeaders можно мутировать).
 *   Если задан `interceptMatchUrl`, правила матчятся по нему (логический URL до DNS‑подмены host→IP).
 * @param {{ rulesOverride?: object[] }|undefined} planOptions
 * @returns {Promise<{ done: true, response: object, responseDelayMs?: number } | { done: false, opts: object, postProcess: object|null, responseDelayMs?: number }>}
 */
async function planMitmIntercept(opts, planOptions) {
    const wireUrl = String(opts.url || '');
    const matchUrl = String(opts.interceptMatchUrl || opts.url || '');
    const rules = (planOptions && Array.isArray(planOptions.rulesOverride))
        ? planOptions.rulesOverride
        : loadRules();
    if (_localEndpointHandler) {
        let pathname = '';
        try { pathname = new URL(wireUrl).pathname; } catch { /* not a URL */ }
        if (pathname.startsWith(CUPNET_LOCAL_PATH_PREFIX)) {
            let response = null;
            try {
                response = await _localEndpointHandler(opts);
            } catch (e) {
                safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.local_endpoint.failed', context: { url: wireUrl } }, e, 'warn');
                response = {
                    statusCode: 500,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    bodyBase64: Buffer.from('CupNet local endpoint error', 'utf8').toString('base64'),
                };
            }
            if (response) {
                return { done: true, response: { ...response, dnsOverride: opts.dnsOverride || null }, responseDelayMs: 0 };
            }
        }
    }
    let mergedModifyPost = null;
    let responseDelayMs = 0;
    /** `inject` rules matched so far; applied to the HTML response in finalize (see html-inject.js). */
    const injectScripts = [];
    if (_documentScriptsProvider && isDocumentRequest(opts.method, opts.headers)) {
        try {
            const extra = _documentScriptsProvider(opts, matchUrl);
            if (Array.isArray(extra)) injectScripts.push(...extra.filter((x) => x && x.source));
        } catch (e) {
            safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.document_scripts.failed', context: { url: matchUrl } }, e, 'warn');
        }
    }
    const withInject = (post) => (injectScripts.length
        ? { ...(post || { _responseDelayMs: responseDelayMs }), _inject: injectScripts }
        : post);
    for (const rule of rules) {
        if (!ruleMatchesUrl(rule.url_pattern, matchUrl)) continue;
        if (bypassInterceptMockBlockForSensitiveUrl(matchUrl)) continue;
        if (!ruleMatchesMethod(rule, opts.method)) continue;
        if (!ruleMatchesExtraConditions(rule, opts)) continue;

        let bpResult = null;
        if (rule.breakpoint_enabled && _breakpointHandler) {
            try {
                bpResult = await _breakpointHandler(opts, rule, { matchUrl, wireUrl });
            } catch (e) {
                safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.breakpoint.failed', context: { ruleName: rule.name } }, e, 'warn');
            }
        }
        if (bpResult && bpResult.action === 'block') {
            _bumpRuleHit(rule);
            _logRuleApplied('mitm', {
                type: 'block', ruleName: rule.name, url: matchUrl,
                tabId: null, detail: 'breakpoint',
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({ type: 'block', ruleName: rule.name, url: matchUrl, tabId: null });
                } catch (err) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'block', stage: 'mitm' } }, err);
                }
            }
            const dmsBp = Number(rule.delay_ms) || 0;
            let rdBp = 0;
            if (dmsBp > 0) rdBp = Math.max(rdBp, Math.min(60000, dmsBp));
            return {
                done: true,
                response: {
                    statusCode: 403,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    bodyBase64: Buffer.from('Blocked by CupNet (breakpoint)', 'utf8').toString('base64'),
                    dnsOverride: opts.dnsOverride || null,
                },
                responseDelayMs: rdBp,
            };
        }
        if (bpResult && bpResult.patch && typeof bpResult.patch === 'object') {
            applyBreakpointPatch(opts, bpResult.patch);
        }

        const dms = Number(rule.delay_ms) || 0;
        if (dms > 0) responseDelayMs = Math.max(responseDelayMs, Math.min(60000, dms));

        if (rule.type === 'block') {
            _bumpRuleHit(rule);
            _logRuleApplied('mitm', {
                type: 'block', ruleName: rule.name, url: matchUrl,
                tabId: null, detail: 'short-circuit',
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({ type: 'block', ruleName: rule.name, url: matchUrl, tabId: null });
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
                responseDelayMs,
            };
        }

        if (rule.type === 'mock') {
            _bumpRuleHit(rule);
            const mimeType = rule.params.mimeType || 'text/plain';
            const statusCode = rule.params.status || 200;
            let bodyBase64;
            let bodyPreview;
            const isFile = rule.params.mockSource === 'file';

            if (isFile) {
                const filePath = rule.params.mockFilePath || '';
                try {
                    const buf = fs.readFileSync(filePath);
                    bodyBase64 = buf.toString('base64');
                    bodyPreview = `[file: ${filePath}] ${(buf.length / 1024).toFixed(1)} KB`;
                } catch (fileErr) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.mock.file_read_failed', context: { filePath, ruleName: rule.name } }, fileErr, 'warn');
                    bodyBase64 = Buffer.from(`CupNet mock: file read error — ${fileErr.message}`, 'utf8').toString('base64');
                    bodyPreview = `[file error: ${fileErr.message}]`;
                }
            } else {
                const body = rule.params.body ?? '';
                bodyBase64 = Buffer.from(String(body), 'utf8').toString('base64');
                bodyPreview = typeof body === 'string' && body.length > 0
                    ? body.substring(0, 120) + (body.length > 120 ? '…' : '') : '(empty)';
            }

            _logRuleApplied('mitm', {
                type: 'mock', ruleName: rule.name, url: matchUrl,
                tabId: null, method: opts.method || 'GET',
                status: statusCode, detail: `${statusCode} ${mimeType}${isFile ? ' [file]' : ''}`,
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({
                        type: 'mock', ruleName: rule.name, url: matchUrl,
                        tabId: null, method: opts.method || 'GET',
                        status: statusCode, mimeType,
                        body: isFile ? `[file: ${rule.params.mockFilePath}]` : String(rule.params.body ?? ''),
                        detail: `${statusCode} ${mimeType}${isFile ? ' [file]' : ''}`, bodyPreview,
                        ruleId: rule.id,
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
                    bodyBase64,
                    dnsOverride: opts.dnsOverride || null,
                },
                responseDelayMs,
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
            _bumpRuleHit(rule);
            _logRuleApplied('mitm', {
                type: 'modifyHeaders', ruleName: rule.name, url: matchUrl,
                tabId: null, detail: detailStr,
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({ type: 'modifyHeaders', ruleName: rule.name, url: matchUrl, tabId: null, detail: detailStr, ruleId: rule.id });
                } catch (err) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'modifyHeaders', stage: 'mitm' } }, err);
                }
            }
            if (hasResp) mergedModifyPost = mergeModifyHeadersParams(mergedModifyPost, p);
            if (stopOnMatch(rule)) {
                return { done: false, opts, postProcess: withInject(mergedModifyPost), responseDelayMs };
            }
            continue;
        }

        if (rule.type === 'inject') {
            // Only document loads: matching a sub-resource would just disable streaming for nothing.
            if (!isDocumentRequest(opts.method, opts.headers)) continue;
            const p = rule.params || {};
            const source = String(p.source || '');
            if (!source.trim()) continue;
            const position = p.position === 'body-end' ? 'body-end' : 'head';
            injectScripts.push({ source, position, name: rule.name });
            const detailStr = `inject ${position} (${source.length} chars)`;
            _bumpRuleHit(rule);
            _logRuleApplied('mitm', {
                type: 'inject', ruleName: rule.name, url: matchUrl, tabId: null, detail: detailStr,
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({ type: 'inject', ruleName: rule.name, url: matchUrl, tabId: null, detail: detailStr, ruleId: rule.id });
                } catch (err) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'inject', stage: 'mitm' } }, err);
                }
            }
            if (stopOnMatch(rule)) {
                return { done: false, opts, postProcess: withInject(mergedModifyPost), responseDelayMs };
            }
            continue;
        }

        if (rule.type === 'mirror') {
            const m = mirrorRewrite.normalizeMirror(rule.params || {});
            if (!m.upstreamHost) continue; // misconfigured: nothing to mirror
            let clientHost = '';
            let clientPort = 443;
            try {
                const u = new URL(matchUrl);
                clientHost = (u.hostname || '').replace(/\.$/, '').toLowerCase();
                clientPort = Number(u.port) || (u.protocol === 'http:' ? 80 : 443);
            } catch { clientHost = mirrorRewrite.hostOnly(matchUrl); }
            const upstream = mirrorRewrite.rewriteRequest(
                { url: matchUrl, clientHost, clientPort }, m,
            );
            if (!upstream) continue;
            _applyMirrorRequest(opts, upstream);
            const postProcess = {
                _mitmPost: MITM_POST_MIRROR,
                mirror: m,
                clientHost,
                clientPort,
                clientUrl: upstream.path,
                ruleName: rule.name,
                ruleId: rule.id,
                method: opts.method || 'GET',
                _responseDelayMs: responseDelayMs,
            };
            const detailStr = `mirror ${clientHost} ⇐ ${m.upstreamHost}`;
            _bumpRuleHit(rule);
            _logRuleApplied('mitm', {
                type: 'mirror', ruleName: rule.name, url: matchUrl, tabId: null, detail: detailStr,
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({ type: 'mirror', ruleName: rule.name, url: matchUrl, tabId: null, detail: detailStr, ruleId: rule.id });
                } catch (err) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'mirror', stage: 'mitm' } }, err);
                }
            }
            // A mirror is a terminal transform; later rules would match the client host, not the upstream.
            return { done: false, opts, postProcess: withInject(postProcess), responseDelayMs };
        }

        if (rule.type === 'script') {
            const p = rule.params || {};
            const beforeSrc = String(p.beforeSource || '');
            const afterSrc = String(p.afterSource || '');
            const beforeCtx = {
                url: String(opts.url || ''),
                method: String(opts.method || 'GET'),
                headers: { ...(opts.headers || {}) },
                orderedHeaders: Array.isArray(opts.orderedHeaders)
                    ? mapHeaderPairs(opts.orderedHeaders)
                    : [],
                body: opts.body !== undefined && opts.body !== null ? opts.body : null,
                bodyBase64: opts.bodyBase64 != null ? String(opts.bodyBase64) : null,
                dnsOverride: opts.dnsOverride || null,
                tabId: opts.tabId != null ? opts.tabId : null,
                requestId: opts.requestId != null ? String(opts.requestId) : null,
                shortCircuit: null,
            };
            const errBefore = runInterceptScriptPhase(beforeSrc, beforeCtx, 'before');
            if (errBefore) {
                safeCatch(
                    { module: 'request-interceptor', eventCode: 'intercept.script.before_failed', context: { ruleName: rule.name, url: matchUrl } },
                    new Error(errBefore),
                    'warn',
                );
                if (rule.id != null) _ruleStore().setInterceptRuleErrorAsync(rule.id, errBefore).catch(() => {});
                continue;
            }
            if (rule.id != null) _ruleStore().setInterceptRuleErrorAsync(rule.id, null).catch(() => {});
            const sc = normalizeShortCircuitResponse(
                beforeCtx.shortCircuit,
                beforeCtx.dnsOverride != null ? beforeCtx.dnsOverride : opts.dnsOverride,
            );
            if (sc) {
                _bumpRuleHit(rule);
                _logRuleApplied('mitm', {
                    type: 'script', ruleName: rule.name, url: beforeCtx.url || wireUrl,
                    tabId: null, detail: 'shortCircuit',
                    status: sc.statusCode,
                });
                if (_onRuleMatch) {
                    try {
                        _onRuleMatch({
                            type: 'script', ruleName: rule.name, url: beforeCtx.url || wireUrl,
                            tabId: null, detail: 'shortCircuit', status: sc.statusCode,
                            ruleId: rule.id,
                        });
                    } catch (err) {
                        safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'script', stage: 'mitm' } }, err);
                    }
                }
                return { done: true, response: sc, postProcess: null, responseDelayMs };
            }
            _applyBeforeCtxToMitmOpts(opts, beforeCtx);
            const requestSnapshot = {
                url: String(opts.url || ''),
                method: String(opts.method || 'GET'),
                headers: { ...(opts.headers || {}) },
                orderedHeaders: Array.isArray(opts.orderedHeaders) ? mapHeaderPairs(opts.orderedHeaders) : [],
            };
            const hasAfter = String(afterSrc).trim().length > 0;
            const postProcess = hasAfter
                ? {
                    _mitmPost: MITM_POST_SCRIPT_AFTER,
                    afterSource: afterSrc,
                    ruleName: rule.name,
                    ruleId: rule.id,
                    requestSnapshot,
                    _responseDelayMs: responseDelayMs,
                }
                : null;
            const detailStr = hasAfter ? 'script forward + after' : 'script forward';
            _bumpRuleHit(rule);
            _logRuleApplied('mitm', {
                type: 'script', ruleName: rule.name, url: opts.url, tabId: null, detail: detailStr,
            });
            if (_onRuleMatch) {
                try {
                    _onRuleMatch({ type: 'script', ruleName: rule.name, url: opts.url, tabId: null, detail: detailStr, ruleId: rule.id });
                } catch (err) {
                    safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.callback.failed', context: { type: 'script', stage: 'mitm' } }, err);
                }
            }
            return { done: false, opts, postProcess: withInject(postProcess), responseDelayMs };
        }
    }
    return { done: false, opts, postProcess: withInject(mergedModifyPost), responseDelayMs };
}

/** Apply matched `inject` rules (ruleParams._inject) to an HTML response. */
function _applyInject(res, ruleParams) {
    const scripts = ruleParams && ruleParams._inject;
    if (!res || !Array.isArray(scripts) || !scripts.length) return res;
    try {
        // MITM buffered responses: AzureTLS already decoded the body; Content-Encoding is stale here.
        return injectScriptsIntoHtmlResponse(res, scripts, { bodyDecoded: true });
    } catch (e) {
        safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.inject.failed' }, e, 'warn');
        return res;
    }
}

/** Rewrite a mirror response (body + Location/Set-Cookie back to the client host) and emit an audit record. */
function _applyMirror(res, ruleParams) {
    const m = ruleParams && ruleParams.mirror;
    if (!m || !m.upstreamHost) return res;
    try {
        const beforeBuf = Buffer.from(res.bodyBase64 || '', 'base64');
        let contentType = '';
        for (const [k, v] of Object.entries(res.headers || {})) {
            if (String(k).toLowerCase() === 'content-type') { contentType = Array.isArray(v) ? v[0] : v; break; }
        }
        const out = mirrorRewrite.rewriteResponse(
            { statusCode: res.statusCode, headers: res.headers || {}, body: beforeBuf, contentType },
            m,
            { clientHost: ruleParams.clientHost, clientPort: ruleParams.clientPort, clientUrl: ruleParams.clientUrl },
        );
        if (_mirrorAuditSink) {
            try {
                _mirrorAuditSink({
                    ruleId: ruleParams.ruleId,
                    ruleName: ruleParams.ruleName,
                    method: ruleParams.method || 'GET',
                    clientHost: ruleParams.clientHost,
                    upstreamHost: m.upstreamHost,
                    clientUrl: ruleParams.clientUrl,
                    status: res.statusCode,
                    contentType,
                    hits: out.hits,
                    rewrote: out.rewrote,
                    before: beforeBuf,
                    after: out.body,
                    ts: Date.now(),
                });
            } catch (e) {
                safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.mirror.audit_failed', context: { ruleName: ruleParams.ruleName } }, e, 'warn');
            }
        }
        return { ...res, headers: out.headers, bodyBase64: out.body.toString('base64') };
    } catch (e) {
        safeCatch({ module: 'request-interceptor', eventCode: 'interceptor.mirror.failed', context: { ruleName: ruleParams.ruleName } }, e, 'warn');
        return res;
    }
}

function finalizeMitmInterceptResponse(res, ruleParams) {
    if (!res || !ruleParams) return res;
    if (ruleParams._mitmPost === MITM_POST_SCRIPT_AFTER) return res;
    if (ruleParams._mitmPost === MITM_POST_MIRROR) {
        return _applyInject(_applyMirror(res, ruleParams), ruleParams);
    }
    return _applyInject(_applyResponseHeaderEdits(res, ruleParams), ruleParams);
}

function _applyResponseHeaderEdits(res, ruleParams) {
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

/**
 * Пост-обработка ответа MITM (modifyHeaders и фаза «после» скрипта).
 * @param {object} res
 * @param {object|null} ruleParams
 */
async function finalizeMitmInterceptResponseAsync(res, ruleParams) {
    if (!res || !ruleParams) return res;
    if (ruleParams._mitmPost === MITM_POST_SCRIPT_AFTER) {
        const afterSrc = String(ruleParams.afterSource || '');
        if (!afterSrc.trim()) return _applyInject(res, ruleParams);
        const respHeaders = { ...(res.headers || {}) };
        const afterCtx = {
            request: ruleParams.requestSnapshot || {},
            response: {
                statusCode: res.statusCode,
                headers: respHeaders,
                bodyBase64: res.bodyBase64 || '',
            },
        };
        const err = runInterceptScriptPhase(afterSrc, afterCtx, 'after');
        if (err) {
            safeCatch(
                {
                    module: 'request-interceptor',
                    eventCode: 'intercept.script.after_failed',
                    context: { ruleName: ruleParams.ruleName },
                },
                new Error(err),
                'warn',
            );
            if (ruleParams.ruleId != null) _ruleStore().setInterceptRuleErrorAsync(ruleParams.ruleId, `after: ${err}`).catch(() => {});
            return _applyInject(res, ruleParams);
        }
        if (ruleParams.ruleId != null) _ruleStore().setInterceptRuleErrorAsync(ruleParams.ruleId, null).catch(() => {});
        let bodyBase64 = afterCtx.response.bodyBase64;
        if (afterCtx.response.body != null && afterCtx.response.body !== undefined) {
            bodyBase64 = Buffer.from(String(afterCtx.response.body), 'utf8').toString('base64');
        }
        return _applyInject({
            ...res,
            statusCode: Number(afterCtx.response.statusCode) || res.statusCode,
            headers: { ...(afterCtx.response.headers || {}) },
            bodyBase64: bodyBase64 != null ? String(bodyBase64) : (res.bodyBase64 || ''),
        }, ruleParams);
    }
    return finalizeMitmInterceptResponse(res, ruleParams);
}

/** Для IPC перед сохранением правила */
function validateInterceptRuleForSave(rule) {
    if (isStrictInterceptMode()) {
        const v = validateStrictInterceptUrlPattern(rule?.url_pattern);
        if (!v.ok) return v;
    }
    if (rule?.type === 'inject') {
        const p = parseParams(rule.params);
        const source = String(p.source || '');
        if (!source.trim()) return { ok: false, error: 'Provide the script to inject' };
        const err = validateScriptSyntax(source, 'inject');
        if (err) return { ok: false, error: `Inject script: ${err}` };
        if (p.position != null && p.position !== 'head' && p.position !== 'body-end') {
            return { ok: false, error: "Inject position must be 'head' or 'body-end'" };
        }
    }
    if (rule?.type === 'mirror') {
        const v = mirrorRewrite.validateMirrorParams(parseParams(rule.params));
        if (!v.ok) return v;
    }
    if (rule?.type === 'script') {
        const p = parseParams(rule.params);
        const before = String(p.beforeSource || '').trim();
        const after = String(p.afterSource || '').trim();
        if (!before && !after) {
            return { ok: false, error: 'Provide at least one script (before or after MITM)' };
        }
        const errB = validateScriptSyntax(before || 'void 0;', 'before');
        if (errB) return { ok: false, error: `Before MITM script: ${errB}` };
        const errA = validateScriptSyntax(after || 'void 0;', 'after');
        if (errA) return { ok: false, error: `After response script: ${errA}` };
    }
    return { ok: true };
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
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
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
    // The interceptor installs NO webRequest hooks (see note above: CF detects them), so we
    // must NOT clear onBeforeSendHeaders/onHeadersReceived here — that would strip the shared
    // session's X-CupNet-Rid injector (owned by tab-manager) while other tabs still use it,
    // breaking per-tab proxy attribution and MITM/CDP dedup. (A-179)
    // Only remove the protocol handlers this module may have registered.
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
    finalizeMitmInterceptResponseAsync,
    runInterceptScriptSelfTest,
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
    setBreakpointHandler,
    setLocalEndpointHandler,
    setDocumentScriptsProvider,
    setMirrorAuditSink,
    setRuleStore,
    CUPNET_LOCAL_PATH_PREFIX,
};
