'use strict';

/**
 * CupNet Session Profile — portable tab bootstrap (proxy, cookies, URL, storage, post-load JS).
 * Pure helpers (no Electron). See docs/session-profile.md.
 */

const FORMAT_ID = 'cupnet-session';
const LAUNCH_FORMAT_ID = 'cupnet-launch';
const CURRENT_VERSION = 1;
const MAX_COOKIES = 5000;
const MAX_SCRIPT_LEN = 256 * 1024;
const MAX_STORAGE_KEYS = 500;

/**
 * @param {unknown} raw
 * @returns {{ ok: true, profile: NormalizedSessionProfile } | { ok: false, error: string }}
 */
/**
 * Parse cupnet-session or cupnet-launch JSON.
 * Launch profiles may omit navigate.url (apply proxy/cookies/fingerprint only).
 * @param {unknown} raw
 * @returns {{ ok: true, profile: NormalizedSessionProfile } | { ok: false, error: string }}
 */
function parseLaunchProfile(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            return { ok: false, error: `Invalid JSON: ${e.message}` };
        }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ok: false, error: 'Profile file must be a JSON object' };
    }
    const o = /** @type {Record<string, unknown>} */ (obj);
    const format = o.format ? String(o.format) : FORMAT_ID;
    if (format !== FORMAT_ID && format !== LAUNCH_FORMAT_ID) {
        return { ok: false, error: `Unknown format "${format}" (expected "${FORMAT_ID}" or "${LAUNCH_FORMAT_ID}")` };
    }
    const version = Number(o.version ?? CURRENT_VERSION);
    if (!Number.isFinite(version) || version < 1 || version > CURRENT_VERSION) {
        return { ok: false, error: `Unsupported version ${o.version}` };
    }

    const navigate = format === LAUNCH_FORMAT_ID
        ? _normalizeNavigateOptional(o)
        : _normalizeNavigate(o);
    if (!navigate.ok) return navigate;

    const cookies = _normalizeCookies(o.cookies);
    if (!cookies.ok) return cookies;

    const runAfterLoad = _normalizeRunAfterLoad(o.runAfterLoad);
    if (!runAfterLoad.ok) return runAfterLoad;

    const storage = _normalizeStorageSafe(o.storage);
    if (!storage.ok) return storage;

    if (format === LAUNCH_FORMAT_ID && !_hasLaunchActions(o, navigate.value)) {
        return { ok: false, error: 'Launch profile needs at least one of: proxy, cookies, fingerprint, navigate.url, storage, runAfterLoad, dnsOverrides' };
    }

    const profile = {
        format,
        version: CURRENT_VERSION,
        name: _str(o.name, 256) || 'Unnamed session',
        description: _str(o.description, 4096),
        tab: _normalizeTab(o.tab),
        navigate: navigate.value,
        proxy: _normalizeProxy(o.proxy),
        fingerprint: _normalizeFingerprint(o.fingerprint),
        cookies: cookies.value,
        storage: storage.value,
        dnsOverrides: _normalizeDnsOverrides(o.dnsOverrides),
        persistDnsOverrides: !!o.persistDnsOverrides,
        clearCookiesBeforeLoad: !!o.clearCookiesBeforeLoad,
        clearStorageBeforeLoad: !!o.clearStorageBeforeLoad,
        runAfterLoad: runAfterLoad.value,
        logging: {
            recording: o.logging && typeof o.logging === 'object' && o.logging.recording != null
                ? !!/** @type {{ recording?: boolean }} */ (o.logging).recording
                : null,
        },
    };

    return { ok: true, profile };
}

/** @param {unknown} raw */
function parseSessionProfile(raw) {
    const parsed = parseLaunchProfile(raw);
    if (!parsed.ok) return parsed;
    if (!parsed.profile.navigate?.url) {
        return { ok: false, error: 'Missing navigate.url (or top-level url)' };
    }
    return parsed;
}

/** @param {NormalizedSessionProfile} profile */
function summarizeSessionProfile(profile) {
    const parts = [];
    parts.push(profile.name);
    if (profile.navigate?.url) parts.push(`URL: ${profile.navigate.url}`);
    else parts.push('no navigation');
    if (profile.proxy?.profileId) parts.push(`Proxy profile #${profile.proxy.profileId}`);
    else if (profile.proxy?.template) parts.push('Proxy: global (last_session_proxy)');
    if (profile.cookies.length) parts.push(`${profile.cookies.length} cookie(s)`);
    if (profile.tab.isolated) parts.push('isolated tab');
    if (profile.runAfterLoad?.script) parts.push('post-load script');
    return parts.join(' · ');
}

function _str(v, max) {
    if (v == null) return '';
    return String(v).trim().slice(0, max);
}

function _normalizeNavigateCore(o, requireUrl) {
    const nav = o.navigate && typeof o.navigate === 'object' && !Array.isArray(o.navigate)
        ? /** @type {Record<string, unknown>} */ (o.navigate)
        : {};
    const url = _str(nav.url ?? o.url, 8192);
    if (!url) {
        if (requireUrl) {
            return { ok: false, error: 'Missing navigate.url (or top-level url)' };
        }
        const timeoutMs = _clampInt(nav.timeoutMs ?? o.navigateTimeoutMs, 5000, 300000, 120000);
        return {
            ok: true,
            value: { url: '', timeoutMs, waitUntil: 'load' },
        };
    }
    if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: 'navigate.url must be absolute (https://…)' };
    }
    try {
        new URL(url);
    } catch {
        return { ok: false, error: 'navigate.url is not a valid URL' };
    }
    const timeoutMs = _clampInt(nav.timeoutMs ?? o.navigateTimeoutMs, 5000, 300000, 120000);
    return {
        ok: true,
        value: { url, timeoutMs, waitUntil: 'load' },
    };
}

function _normalizeNavigate(o) {
    return _normalizeNavigateCore(o, true);
}

function _normalizeNavigateOptional(o) {
    return _normalizeNavigateCore(o, false);
}

function _hasLaunchActions(o, navigate) {
    if (navigate?.url) return true;
    if (o.proxy && typeof o.proxy === 'object') return true;
    if (Array.isArray(o.cookies) && o.cookies.length) return true;
    if (o.fingerprint && typeof o.fingerprint === 'object') return true;
    if (o.runAfterLoad) return true;
    if (Array.isArray(o.dnsOverrides) && o.dnsOverrides.length) return true;
    if (o.storage && typeof o.storage === 'object') {
        const s = /** @type {Record<string, unknown>} */ (o.storage);
        if (s.localStorage && typeof s.localStorage === 'object' && Object.keys(s.localStorage).length) return true;
        if (s.sessionStorage && typeof s.sessionStorage === 'object' && Object.keys(s.sessionStorage).length) return true;
    }
    return false;
}

function _normalizeTab(tabRaw) {
    const t = tabRaw && typeof tabRaw === 'object' && !Array.isArray(tabRaw)
        ? /** @type {Record<string, unknown>} */ (tabRaw)
        : {};
    return {
        newTab: t.newTab !== false,
        isolated: !!t.isolated,
        cookieGroupId: t.cookieGroupId != null ? Number(t.cookieGroupId) : null,
        cookieGroupName: _str(t.cookieGroupName, 128) || null,
    };
}

function _normalizeProxy(proxyRaw) {
    if (!proxyRaw || typeof proxyRaw !== 'object' || Array.isArray(proxyRaw)) return null;
    const p = /** @type {Record<string, unknown>} */ (proxyRaw);
    const profileId = p.profileId != null ? Number(p.profileId) : null;
    const template = _str(p.template, 4096) || null;
    const profileName = _str(p.profileName, 256) || null;
    if (!profileId && !template) return null;
    const variables = p.variables && typeof p.variables === 'object' && !Array.isArray(p.variables)
        ? { .../** @type {Record<string, string>} */ (p.variables) }
        : {};
    return {
        profileId: Number.isFinite(profileId) ? profileId : null,
        profileName,
        template,
        variables,
        tlsProfile: _str(p.tlsProfile ?? p.browser, 64) || null,
        ja3: _str(p.ja3, 512) || null,
    };
}

function _normalizeFingerprint(fpRaw) {
    if (!fpRaw || typeof fpRaw !== 'object' || Array.isArray(fpRaw)) return null;
    const f = /** @type {Record<string, unknown>} */ (fpRaw);
    const ua = _str(f.userAgent ?? f.user_agent, 2048) || null;
    const language = _str(f.language, 64) || null;
    const timezone = _str(f.timezone, 64) || null;
    if (!ua && !language && !timezone) return null;
    return { userAgent: ua, language, timezone };
}

function _normalizeCookies(raw) {
    if (raw == null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return { ok: false, error: 'cookies must be an array' };
    if (raw.length > MAX_COOKIES) {
        return { ok: false, error: `Too many cookies (max ${MAX_COOKIES})` };
    }
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!c || typeof c !== 'object') return { ok: false, error: `cookies[${i}] must be an object` };
        const row = /** @type {Record<string, unknown>} */ (c);
        const name = _str(row.name, 512);
        const value = String(row.value ?? '');
        const domain = _str(row.domain, 512);
        if (!name || !domain) return { ok: false, error: `cookies[${i}] needs name and domain` };
        const path = _str(row.path, 512) || '/';
        const host = domain.replace(/^\./, '');
        // Handoff JSON often sets secure:false; HTTPS sites still need Secure cookies + https:// URL.
        let secure = row.secure !== false;
        if (row.secure === false) secure = true;
        let url = row.url ? _str(row.url, 8192) : '';
        if (!url) url = `https://${host}${path}`;
        else if (row.secure === false && /^http:\/\//i.test(url)) {
            url = url.replace(/^http:\/\//i, 'https://');
        }
        out.push({
            url,
            name,
            value,
            domain,
            path,
            secure,
            httpOnly: !!row.httpOnly,
            sameSite: _str(row.sameSite, 32) || undefined,
            expirationDate: row.expirationDate != null ? Number(row.expirationDate) : undefined,
        });
    }
    return { ok: true, value: out };
}

function _normalizeStorageSafe(storageRaw) {
    try {
        return { ok: true, value: _normalizeStorage(storageRaw) };
    } catch (e) {
        return { ok: false, error: e?.message || 'Invalid storage' };
    }
}

function _normalizeStorage(storageRaw) {
    if (!storageRaw || typeof storageRaw !== 'object' || Array.isArray(storageRaw)) {
        return { localStorage: {}, sessionStorage: {} };
    }
    const s = /** @type {Record<string, unknown>} */ (storageRaw);
    return {
        localStorage: _normalizeStorageMap(s.localStorage, 'localStorage'),
        sessionStorage: _normalizeStorageMap(s.sessionStorage, 'sessionStorage'),
    };
}

function _normalizeStorageMap(raw, label) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const keys = Object.keys(raw);
    if (keys.length > MAX_STORAGE_KEYS) {
        throw new Error(`${label}: too many keys (max ${MAX_STORAGE_KEYS})`);
    }
    const out = {};
    for (const k of keys) {
        out[String(k).slice(0, 512)] = String(raw[k]).slice(0, 8192);
    }
    return out;
}

function _normalizeDnsOverrides(raw) {
    if (!raw) return [];
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 100).map((row) => {
        const r = row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row) : {};
        return {
            host: _str(r.host, 512),
            ip: _str(r.ip, 64),
            enabled: r.enabled !== false,
            rewrite_host: _str(r.rewrite_host, 512),
        };
    }).filter((r) => r.host);
}

function _normalizeRunAfterLoad(raw) {
    if (raw == null) return { ok: true, value: null };
    if (typeof raw === 'string') {
        const script = raw.trim();
        if (!script) return { ok: true, value: null };
        if (script.length > MAX_SCRIPT_LEN) return { ok: false, error: 'runAfterLoad script too long' };
        return { ok: true, value: { script, delayMs: 0, timeoutMs: 30000 } };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'runAfterLoad must be a string or object' };
    }
    const r = /** @type {Record<string, unknown>} */ (raw);
    const script = _str(r.script, MAX_SCRIPT_LEN);
    if (!script) return { ok: true, value: null };
    return {
        ok: true,
        value: {
            script,
            delayMs: _clampInt(r.delayMs, 0, 60000, 0),
            timeoutMs: _clampInt(r.timeoutMs, 1000, 120000, 30000),
        },
    };
}

function _clampInt(v, min, max, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

module.exports = {
    FORMAT_ID,
    LAUNCH_FORMAT_ID,
    CURRENT_VERSION,
    parseSessionProfile,
    parseLaunchProfile,
    summarizeSessionProfile,
};
