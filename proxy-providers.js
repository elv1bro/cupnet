'use strict';

/**
 * Proxy provider registry — each provider defines countries, credential fields,
 * session/duration rules, and a custom buildTemplate() that outputs a CupNet URL template.
 *
 * Reserved profile variables (stored in proxy_profiles.variables JSON):
 *   __connectionMode  'provider' | 'manual'
 *   __provider        provider id
 *   __country         ISO country code
 *   __sessionMode     'rotating' | 'sticky'
 *   __durationMin     sticky session duration (minutes)
 *   __username        shared login (provider mode)
 *   __password        shared password (provider mode; also embedded in encrypted template)
 */

const PROXY_PROVIDER_ACCOUNTS_KEY = 'cupnet.proxy.providerAccounts';
const PROXY_PROVIDER_ACCOUNTS_V2_KEY = 'cupnet.proxy.providerAccounts.v2';

/** Pseudo-provider id for manual / own proxy URL profiles */
const CUSTOM_LINK_PROVIDER_ID = '__custom__';
const CUSTOM_LINK_PROVIDER_LABEL = 'Custom URL';

const PROXY_PROVIDER_OPTION_PREFIX = '__opt_';

const PROXY_PROVIDER_RESERVED_KEYS = new Set([
    '__connectionMode', '__provider', '__country', '__sessionMode',
    '__durationMin', '__accountId',
    // legacy — read-only fallback for old profiles
    '__username', '__password',
]);

const REGION_ORDER = [
    'Europe', 'Americas', 'Asia', 'Middle East', 'Africa', 'Oceania', 'Other',
];

function encUserPart(s) {
    return encodeURIComponent(String(s ?? ''));
}

function encPasswordForUrl(s) {
    return encodeURIComponent(String(s ?? ''));
}

function buildAuthProxyUrl(scheme, userPart, password, host, port) {
    return `${scheme}://${userPart}:${encPasswordForUrl(password)}@${host}:${port}`;
}

/** Strip provider-specific prefixes/suffixes when user pasted a full proxy username */
function normalizeProviderAccountUsername(provider, username) {
    let u = String(username || '').trim();
    if (!u || !provider) return u;
    switch (provider.id) {
    case 'oxylabs':
        u = u.replace(/^customer-/i, '');
        u = u.replace(/-cc-[a-z]{2}(?:-.*)?$/i, '');
        u = u.replace(/-sessid-.*$/i, '');
        u = u.replace(/-sesstime-.*$/i, '');
        break;
    case 'decodo':
        u = u.replace(/^user-/i, '');
        u = u.replace(/-country-[a-z]{2}(?:-.*)?$/i, '');
        break;
    case 'iproyal':
        u = u.replace(/_country-[a-z]{2}(?:_.*)?$/i, '');
        u = u.replace(/_session-.*$/i, '');
        break;
    default:
        break;
    }
    return u;
}

function maskProxySecret(secret) {
    const s = String(secret ?? '');
    if (!s) return '';
    if (s.length === 1) return '*';
    if (s.length === 2) return `${s[0]}*`;
    return `${s[0]}${'*'.repeat(s.length - 2)}${s[s.length - 1]}`;
}

/** Mask proxy URL password for logs/UI — keeps first and last password character */
function maskProxyUrlForDisplay(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
        const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
        const u = new URL(normalized);
        let user = u.username;
        try { user = decodeURIComponent(user); } catch { /* keep */ }
        let pass = u.password;
        if (pass) {
            try { pass = decodeURIComponent(pass); } catch { /* keep */ }
            pass = maskProxySecret(pass);
        }
        const auth = pass ? `${user}:${pass}` : user;
        return `${u.protocol}//${auth}@${u.host}`;
    } catch {
        return raw.replace(/:\/\/([^:@/]+):([^@/]+)@/, (_, user, pass) => {
            let decodedPass = pass;
            try { decodedPass = decodeURIComponent(pass); } catch { /* keep */ }
            return `://${user}:${maskProxySecret(decodedPass)}@`;
        });
    }
}

function loadDecodoEndpoints() {
    if (typeof window !== 'undefined' && window.cupnetDecodoEndpoints) {
        return window.cupnetDecodoEndpoints;
    }
    if (typeof require !== 'undefined') {
        try {
            return require('./decodo-endpoints.js');
        } catch {
            return {};
        }
    }
    return {};
}

const decodoEndpoints = loadDecodoEndpoints();
const importedDecodoCountries = decodoEndpoints.DECODO_COUNTRIES || [];
const decodoPortSegment = decodoEndpoints.decodoPortSegment || ((c, mode) => String(c?.portRotating ?? c?.port ?? 10000));

function buildNodemavenCountries() {
    const random = { code: 'random', name: 'Random', region: 'Other', host: 'gate.nodemaven.com', port: 8080 };
    const list = importedDecodoCountries
        .filter(c => c.code !== 'random' && c.code !== 'eu')
        .map(c => ({
            code: c.code,
            name: c.name,
            region: c.region,
            host: 'gate.nodemaven.com',
            port: 8080,
        }));
    return [random, ...list];
}

const NODEMAVEN_COUNTRIES = buildNodemavenCountries();

function nodemavenLocToken(s) {
    return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
}

function nodemavenGatewayHost(provider, gatewayId) {
    const gw = provider.gateways?.find(g => g.id === gatewayId);
    return gw?.host || provider.gatewayHost || 'gate.nodemaven.com';
}

function nodemavenFilterSegment(filter) {
    const f = String(filter || '').trim();
    if (!f || f === 'none') return '';
    if (f === 'speed-fast') return '-speed-fast';
    return `-filter-${f}`;
}

function nodemavenPort(protocol) {
    return protocol === 'socks5' ? 1080 : 8080;
}

function normalizeProviderOptions(provider, raw) {
    const fields = provider?.optionFields || [];
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const field of fields) {
        const key = field.key;
        let val = src[key];
        if (val == null || val === '') val = field.default ?? '';
        if (field.type === 'checkbox') {
            out[key] = val === true || val === 'true' || val === '1' ? 'true' : '';
        } else {
            out[key] = String(val ?? '').trim();
        }
    }
    return out;
}

function extractProviderOptionsFromVars(vars) {
    const out = {};
    for (const [k, v] of Object.entries(vars || {})) {
        if (k.startsWith(PROXY_PROVIDER_OPTION_PREFIX)) {
            out[k.slice(PROXY_PROVIDER_OPTION_PREFIX.length)] = v;
        }
    }
    return out;
}

function getProviderOptionFields(provider) {
    return provider?.optionFields ? provider.optionFields.slice() : [];
}

/** Top 10 popular ISO codes used for provider account smoke tests */
const PROVIDER_TEST_POPULAR = ['us', 'gb', 'de', 'fr', 'nl', 'pl', 'ru', 'in', 'jp', 'au'];

/** Minimum successful locations to treat provider account credentials as verified */
const PROVIDER_TEST_MIN_PASS = 2;

function getProviderTestCheckUrl(providerId) {
    return getProxyProviderById(providerId)?.testCheckUrl || 'https://ipinfo.io/json';
}

function getProviderTestMinPasses(providerId) {
    const provider = getProxyProviderById(providerId);
    return provider?.testMinPass ?? PROVIDER_TEST_MIN_PASS;
}

function getProviderTestCountryCodes(provider, count = 3) {
    if (!provider) return [];
    const pool = (provider.testCountries || PROVIDER_TEST_POPULAR)
        .filter(code => provider.countries.some(c => c.code === code));
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

function resolveProviderTemplateForTest(template, ephemeral = {}) {
    const sid = ephemeral.SID || (`cupnet${Math.floor(Math.random() * 1e10)}`);
    return String(template || '')
        .replace(/\{RAND:(\d+)-(\d+)\}/gi, (_, mn, mx) => {
            const min = parseInt(mn, 10);
            const max = parseInt(mx, 10);
            return String(Math.floor(Math.random() * (max - min + 1)) + min);
        })
        .replace(/\{SID\}/gi, sid);
}

function buildProviderAccountTestTemplate(providerId, opts) {
    const provider = getProxyProviderById(providerId);
    if (!provider) return '';
    const country = getProviderCountry(provider, opts?.countryCode);
    if (!country) return '';
    const testDefaults = provider.testDefaults || {};
    return buildProviderTemplate(providerId, {
        username: opts?.username,
        password: opts?.password,
        countryCode: opts?.countryCode,
        sessionMode: testDefaults.sessionMode || 'rotating',
        durationMin: testDefaults.durationMin ?? provider.duration?.default ?? 30,
        options: { ...(testDefaults.options || {}), ...(opts?.options || {}) },
    });
}

function planProviderAccountTests(providerId, count = 3) {
    const provider = getProxyProviderById(providerId);
    if (!provider) return [];
    return getProviderTestCountryCodes(provider, count).map(code => {
        const country = getProviderCountry(provider, code);
        return { code, name: country?.name || code.toUpperCase() };
    });
}

/** @typedef {{ code: string, name: string, region: string, host: string, portRotating: number, stickyMin: number, stickyMax: number }} ProviderCountry */

/** @type {Array<object>} */
const PROXY_PROVIDERS = [
    {
        id: 'decodo',
        name: 'Decodo',
        type: 'residential',
        scheme: 'http',
        fields: { username: true, password: true },
        session: { rotating: true, sticky: true },
        duration: { supported: true, min: 1, max: 1440, unit: 'min', default: 30 },
        defaultPort: 10000,
        countries: importedDecodoCountries,
        buildTemplate({ username, password, country, sessionMode, durationMin }) {
            const u = String(username || '').trim();
            const p = String(password || '').trim();
            const c = country || this.countries[0];
            const cc = c?.code || 'us';
            const host = c?.host || `${cc}.decodo.com`;
            const port = decodoPortSegment(c, sessionMode);
            let userPart = `user-${u}`;
            if (cc && cc !== 'random') userPart += `-country-${cc}`;
            if (sessionMode === 'sticky') {
                userPart += '-session-{SID}';
                const dur = Math.max(this.duration.min, Math.min(this.duration.max, Number(durationMin) || this.duration.default));
                userPart += `-sessionduration-${dur}`;
            }
            return buildAuthProxyUrl(this.scheme, userPart, p, host, port);
        },
    },
    {
        id: 'oxylabs',
        name: 'Oxylabs',
        type: 'residential',
        scheme: 'http',
        fields: { username: true, password: true },
        session: { rotating: true, sticky: true },
        duration: { supported: true, min: 1, max: 1440, unit: 'min', default: 30 },
        defaultPort: 7777,
        gatewayHost: 'pr.oxylabs.io',
        testCountries: ['us', 'gb', 'de', 'fr', 'nl'],
        testMinPass: 2,
        countries: [
            { code: 'us', name: 'United States', region: 'Americas', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'gb', name: 'United Kingdom', region: 'Europe', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'de', name: 'Germany', region: 'Europe', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'fr', name: 'France', region: 'Europe', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'nl', name: 'Netherlands', region: 'Europe', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'pl', name: 'Poland', region: 'Europe', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'ru', name: 'Russia', region: 'Europe', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'in', name: 'India', region: 'Asia', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'jp', name: 'Japan', region: 'Asia', host: 'pr.oxylabs.io', port: 7777 },
            { code: 'au', name: 'Australia', region: 'Oceania', host: 'pr.oxylabs.io', port: 7777 },
        ],
        buildTemplate({ username, password, country, sessionMode, durationMin }) {
            const u = normalizeProviderAccountUsername(this, username);
            const p = String(password || '').trim();
            const cc = (country?.code || 'us').toUpperCase();
            const host = country?.host || this.gatewayHost;
            const port = country?.port || this.defaultPort;
            let userPart = `customer-${u}-cc-${cc}`;
            if (sessionMode === 'sticky') {
                userPart += `-sessid-{SID}`;
                const dur = Math.max(this.duration.min, Math.min(this.duration.max, Number(durationMin) || this.duration.default));
                userPart += `-sesstime-${dur}`;
            }
            return buildAuthProxyUrl(this.scheme, userPart, p, host, port);
        },
    },
    {
        id: 'iproyal',
        name: 'IPRoyal',
        type: 'residential',
        scheme: 'http',
        fields: { username: true, password: true },
        session: { rotating: true, sticky: true },
        duration: { supported: true, min: 1, max: 1440, unit: 'min', default: 30 },
        defaultPort: 12321,
        gatewayHost: 'geo.iproyal.com',
        countries: [
            { code: 'us', name: 'United States', region: 'Americas', host: 'geo.iproyal.com', port: 12321 },
            { code: 'gb', name: 'United Kingdom', region: 'Europe', host: 'geo.iproyal.com', port: 12321 },
            { code: 'de', name: 'Germany', region: 'Europe', host: 'geo.iproyal.com', port: 12321 },
            { code: 'fr', name: 'France', region: 'Europe', host: 'geo.iproyal.com', port: 12321 },
            { code: 'pl', name: 'Poland', region: 'Europe', host: 'geo.iproyal.com', port: 12321 },
            { code: 'ru', name: 'Russia', region: 'Europe', host: 'geo.iproyal.com', port: 12321 },
            { code: 'in', name: 'India', region: 'Asia', host: 'geo.iproyal.com', port: 12321 },
            { code: 'jp', name: 'Japan', region: 'Asia', host: 'geo.iproyal.com', port: 12321 },
            { code: 'au', name: 'Australia', region: 'Oceania', host: 'geo.iproyal.com', port: 12321 },
        ],
        buildTemplate({ username, password, country, sessionMode, durationMin }) {
            const u = normalizeProviderAccountUsername(this, username);
            const p = String(password || '').trim();
            const cc = country?.code || 'us';
            const host = country?.host || this.gatewayHost;
            const port = country?.port || this.defaultPort;
            let userPart = `${u}_country-${cc}`;
            if (sessionMode === 'sticky') {
                userPart += `_session-{SID}`;
                const dur = Math.max(this.duration.min, Math.min(this.duration.max, Number(durationMin) || this.duration.default));
                userPart += `_lifetime-${dur}m`;
            }
            return buildAuthProxyUrl(this.scheme, userPart, p, host, port);
        },
    },
    {
        id: 'nodemaven',
        name: 'NodeMaven',
        type: 'residential',
        scheme: 'http',
        fields: { username: true, password: true },
        session: { rotating: true, sticky: true },
        duration: { supported: true, min: 1, max: 1440, unit: 'min', default: 30 },
        defaultPort: 8080,
        gatewayHost: 'gate.nodemaven.com',
        gateways: [
            { id: 'auto', label: 'Auto (nearest)', host: 'gate.nodemaven.com' },
            { id: 'eu', label: 'Europe', host: 'gate-eu.nodemaven.com' },
            { id: 'us', label: 'Americas', host: 'gate-us.nodemaven.com' },
            { id: 'sg', label: 'Singapore', host: 'gate-sg.nodemaven.com' },
            { id: 'ru', label: 'Russia', host: 'gate-ru.nodemaven.com' },
        ],
        countries: NODEMAVEN_COUNTRIES,
        optionFields: [
            {
                key: 'gateway',
                type: 'select',
                label: 'Gateway',
                default: 'auto',
                hint: 'Regional entry point. Auto picks the nearest server.',
                choices: [
                    { value: 'auto', label: 'Auto (gate.nodemaven.com)' },
                    { value: 'eu', label: 'Europe (gate-eu.nodemaven.com)' },
                    { value: 'us', label: 'Americas (gate-us.nodemaven.com)' },
                    { value: 'sg', label: 'Singapore (gate-sg.nodemaven.com)' },
                    { value: 'ru', label: 'Russia (gate-ru.nodemaven.com)' },
                ],
            },
            {
                key: 'protocol',
                type: 'select',
                label: 'Protocol',
                default: 'http',
                hint: 'HTTP: ports 8080–9080. SOCKS5: ports 1080–2080.',
                choices: [
                    { value: 'http', label: 'HTTP (port 8080)' },
                    { value: 'socks5', label: 'SOCKS5 (port 1080)' },
                ],
            },
            {
                key: 'region',
                type: 'text',
                label: 'Region',
                placeholder: 'e.g. new_york',
                default: '',
                optional: true,
                hint: 'Optional. Appended as -region-{name} (underscores, no spaces).',
            },
            {
                key: 'city',
                type: 'text',
                label: 'City',
                placeholder: 'e.g. brooklyn',
                default: '',
                optional: true,
                hint: 'Optional. Appended as -city-{name}.',
            },
            {
                key: 'isp',
                type: 'text',
                label: 'ISP',
                placeholder: 'e.g. spectrum',
                default: '',
                optional: true,
                hint: 'Optional. Appended as -isp-{name}.',
            },
            {
                key: 'filter',
                type: 'select',
                label: 'IP quality filter',
                default: 'medium',
                hint: 'Quality filter segment in username. Max pool = no filter segment.',
                choices: [
                    { value: 'medium', label: 'Quality (filter-medium)' },
                    { value: 'medium-speed-fast', label: 'Quality + Speed (filter-medium-speed-fast)' },
                    { value: 'speed-fast', label: 'Speed only (speed-fast)' },
                    { value: 'none', label: 'Max pool (no filter)' },
                ],
            },
            {
                key: 'ipv4',
                type: 'checkbox',
                label: 'IPv4 only',
                default: '',
                hint: 'Adds -ipv4-true to username (mixed IPv4/IPv6 by default).',
            },
        ],
        buildTemplate({ username, password, country, sessionMode, durationMin, options }) {
            const u = String(username || '').trim();
            const p = String(password || '').trim();
            const opts = normalizeProviderOptions(this, options);
            const cc = country?.code && country.code !== 'random' ? country.code : '';
            const host = nodemavenGatewayHost(this, opts.gateway);
            const port = nodemavenPort(opts.protocol);
            let userPart = u;
            if (cc) userPart += `-country-${cc}`;
            if (opts.region) userPart += `-region-${nodemavenLocToken(opts.region)}`;
            if (opts.city) userPart += `-city-${nodemavenLocToken(opts.city)}`;
            if (opts.isp) userPart += `-isp-${nodemavenLocToken(opts.isp)}`;
            if (sessionMode === 'sticky') {
                userPart += '-sid-{SID}';
                const dur = Math.max(this.duration.min, Math.min(this.duration.max, Number(durationMin) || this.duration.default));
                userPart += `-ttl-${dur}m`;
            }
            userPart += nodemavenFilterSegment(opts.filter);
            if (opts.ipv4 === 'true') userPart += '-ipv4-true';
            const scheme = opts.protocol === 'socks5' ? 'socks5' : this.scheme;
            return buildAuthProxyUrl(scheme, userPart, p, host, port);
        },
    },
];

function getProxyProviders() {
    return PROXY_PROVIDERS.slice();
}

function getProxyProviderById(id) {
    if (!id) return null;
    return PROXY_PROVIDERS.find(p => p.id === id) || null;
}

function getProviderCountry(provider, code) {
    if (!provider || !code) return null;
    const c = String(code).toLowerCase();
    return provider.countries.find(x => x.code === c) || null;
}

function groupCountriesByRegion(provider) {
    const groups = new Map();
    for (const c of provider.countries || []) {
        const region = c.region || 'Other';
        if (!groups.has(region)) groups.set(region, []);
        groups.get(region).push(c);
    }
    const ordered = [];
    for (const region of REGION_ORDER) {
        if (groups.has(region)) {
            ordered.push({ region, countries: groups.get(region).sort((a, b) => a.name.localeCompare(b.name)) });
            groups.delete(region);
        }
    }
    for (const [region, countries] of groups) {
        ordered.push({ region, countries: countries.sort((a, b) => a.name.localeCompare(b.name)) });
    }
    return ordered;
}

function isReservedProviderVar(key) {
    const k = String(key || '');
    return PROXY_PROVIDER_RESERVED_KEYS.has(k) || k.startsWith(PROXY_PROVIDER_OPTION_PREFIX);
}

function filterUserTemplateVars(vars) {
    const out = {};
    if (!vars || typeof vars !== 'object') return out;
    for (const [k, v] of Object.entries(vars)) {
        if (!isReservedProviderVar(k)) out[k] = v;
    }
    return out;
}

function buildProviderTemplate(providerId, opts) {
    const provider = getProxyProviderById(providerId);
    if (!provider || typeof provider.buildTemplate !== 'function') return '';
    const country = getProviderCountry(provider, opts.countryCode) || provider.countries[0];
    const options = normalizeProviderOptions(provider, opts.options || {});
    return provider.buildTemplate({
        username: opts.username,
        password: opts.password,
        country,
        sessionMode: opts.sessionMode || 'rotating',
        durationMin: opts.durationMin,
        options,
    });
}

function buildProviderVariables(providerId, opts) {
    const provider = getProxyProviderById(providerId);
    const durDefault = provider?.duration?.default ?? 30;
    const vars = {
        __connectionMode: 'provider',
        __provider: providerId,
        __accountId: String(opts.accountId || ''),
        __country: String(opts.countryCode || provider?.countries?.[0]?.code || '').toLowerCase(),
        __sessionMode: opts.sessionMode === 'sticky' ? 'sticky' : 'rotating',
        __durationMin: String(opts.durationMin != null ? opts.durationMin : durDefault),
    };
    const options = normalizeProviderOptions(provider, opts.options || {});
    for (const [k, v] of Object.entries(options)) {
        if (v !== '' && v != null) vars[`${PROXY_PROVIDER_OPTION_PREFIX}${k}`] = String(v);
    }
    return vars;
}

// ── Provider accounts (multiple per provider, stored in localStorage) ─────────

function _newAccountId() {
    return `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function _migrateLegacyAccountsV1() {
    if (typeof localStorage === 'undefined') return [];
    try {
        const raw = localStorage.getItem(PROXY_PROVIDER_ACCOUNTS_KEY);
        if (!raw) return [];
        const legacy = JSON.parse(raw);
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return [];
        const accounts = [];
        for (const [providerId, acc] of Object.entries(legacy)) {
            if (!acc?.username) continue;
            accounts.push({
                id: _newAccountId(),
                providerId,
                username: String(acc.username).trim(),
                password: String(acc.password ?? ''),
                updatedAt: acc.updatedAt || Date.now(),
            });
        }
        return accounts;
    } catch {
        return [];
    }
}

function loadProviderAccounts() {
    if (typeof localStorage === 'undefined') return [];
    try {
        const rawV2 = localStorage.getItem(PROXY_PROVIDER_ACCOUNTS_V2_KEY);
        if (rawV2) {
            const parsed = JSON.parse(rawV2);
            return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
        }
        const migrated = _migrateLegacyAccountsV1();
        if (migrated.length) saveProviderAccounts(migrated);
        return migrated;
    } catch {
        return [];
    }
}

function saveProviderAccounts(accounts) {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(PROXY_PROVIDER_ACCOUNTS_V2_KEY, JSON.stringify({ accounts: accounts || [] }));
    } catch { /* ignore quota */ }
}

function listProviderAccounts(providerId) {
    const all = loadProviderAccounts();
    if (!providerId) return all.slice();
    return all.filter(a => a.providerId === providerId);
}

function getProviderAccountEntry(accountId) {
    if (!accountId) return null;
    return loadProviderAccounts().find(a => a.id === accountId) || null;
}

/** @deprecated use getProviderAccountEntry */
function getProviderAccount(providerId) {
    const list = listProviderAccounts(providerId);
    return list[0] || null;
}

function addProviderAccount({ providerId, username, password }) {
    if (!providerId || !String(username || '').trim()) return null;
    const accounts = loadProviderAccounts();
    const entry = {
        id: _newAccountId(),
        providerId,
        username: String(username).trim(),
        password: String(password ?? ''),
        updatedAt: Date.now(),
    };
    accounts.push(entry);
    saveProviderAccounts(accounts);
    return entry;
}

function updateProviderAccount(accountId, { providerId, username, password }) {
    if (!accountId) return false;
    const accounts = loadProviderAccounts();
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return false;
    const cur = accounts[idx];
    accounts[idx] = {
        ...cur,
        providerId: providerId || cur.providerId,
        username: String(username ?? cur.username).trim(),
        password: password !== undefined ? String(password) : cur.password,
        updatedAt: Date.now(),
    };
    saveProviderAccounts(accounts);
    return true;
}

function setProviderAccount(providerId, { username, password }) {
    const existing = listProviderAccounts(providerId);
    if (existing.length === 1) {
        return updateProviderAccount(existing[0].id, { providerId, username, password });
    }
    if (existing.length === 0) {
        return !!addProviderAccount({ providerId, username, password });
    }
    const match = existing.find(a => a.username === String(username || '').trim());
    if (match) return updateProviderAccount(match.id, { providerId, username, password });
    return !!addProviderAccount({ providerId, username, password });
}

function deleteProviderAccount(accountIdOrProviderId) {
    if (!accountIdOrProviderId) return;
    let accounts = loadProviderAccounts();
    const byId = accounts.find(a => a.id === accountIdOrProviderId);
    if (byId) {
        accounts = accounts.filter(a => a.id !== accountIdOrProviderId);
    } else {
        accounts = accounts.filter(a => a.providerId !== accountIdOrProviderId);
    }
    saveProviderAccounts(accounts);
}

function listConfiguredProviderIds() {
    return [...new Set(loadProviderAccounts().map(a => a.providerId).filter(Boolean))];
}

/** Credentials: profile __accountId → saved account → legacy profile vars */
function resolveProviderCredentials(providerId, profileVars) {
    const vars = profileVars || {};
    const accountId = vars.__accountId;
    if (accountId) {
        const acc = getProviderAccountEntry(accountId);
        if (acc && (!providerId || acc.providerId === providerId)) {
            return { username: acc.username, password: acc.password, fromAccount: true, accountId: acc.id };
        }
    }
    if (providerId) {
        const list = listProviderAccounts(providerId);
        if (list.length === 1) {
            return { username: list[0].username, password: list[0].password, fromAccount: true, accountId: list[0].id };
        }
        if (vars.__username) {
            const match = list.find(a => a.username === vars.__username);
            if (match) {
                return { username: match.username, password: match.password, fromAccount: true, accountId: match.id };
            }
        }
    }
    return {
        username: vars.__username || '',
        password: vars.__password ?? '',
        fromAccount: false,
        accountId: '',
    };
}

function getProfileProviderMeta(variables) {
    const vars = variables || {};
    if (vars.__connectionMode === 'manual') {
        return {
            providerId: CUSTOM_LINK_PROVIDER_ID,
            providerName: CUSTOM_LINK_PROVIDER_LABEL,
            countryCode: '',
            countryName: '',
            sessionMode: '',
            durationMin: null,
        };
    }
    if (vars.__connectionMode !== 'provider' || !vars.__provider) return null;
    const provider = getProxyProviderById(vars.__provider);
    if (!provider) return null;
    const country = getProviderCountry(provider, vars.__country);
    return {
        providerId: provider.id,
        providerName: provider.name,
        countryCode: country?.code || vars.__country || '',
        countryName: country?.name || vars.__country || '',
        sessionMode: vars.__sessionMode || 'rotating',
        durationMin: vars.__durationMin,
    };
}

function suggestProfileName(providerId, countryCode, sessionMode) {
    const provider = getProxyProviderById(providerId);
    const country = getProviderCountry(provider, countryCode);
    const parts = [provider?.name || providerId];
    if (country) parts.push(country.name);
    if (sessionMode === 'sticky') parts.push('Sticky');
    return parts.join(' · ');
}

if (typeof window !== 'undefined') {
    window.cupnetProxyProviders = {
        PROXY_PROVIDER_ACCOUNTS_KEY,
        CUSTOM_LINK_PROVIDER_ID,
        CUSTOM_LINK_PROVIDER_LABEL,
        PROXY_PROVIDER_OPTION_PREFIX,
        PROXY_PROVIDER_RESERVED_KEYS,
        getProxyProviders,
        getProxyProviderById,
        getProviderCountry,
        getProviderOptionFields,
        normalizeProviderOptions,
        extractProviderOptionsFromVars,
        normalizeProviderAccountUsername,
        maskProxyUrlForDisplay,
        getProviderTestCountryCodes,
        getProviderTestCheckUrl,
        getProviderTestMinPasses,
        buildProviderAccountTestTemplate,
        resolveProviderTemplateForTest,
        planProviderAccountTests,
        PROVIDER_TEST_POPULAR,
        PROVIDER_TEST_MIN_PASS,
        groupCountriesByRegion,
        isReservedProviderVar,
        filterUserTemplateVars,
        buildProviderTemplate,
        buildProviderVariables,
        getProfileProviderMeta,
        suggestProfileName,
        loadProviderAccounts,
        listProviderAccounts,
        getProviderAccountEntry,
        getProviderAccount,
        addProviderAccount,
        updateProviderAccount,
        setProviderAccount,
        deleteProviderAccount,
        listConfiguredProviderIds,
        resolveProviderCredentials,
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PROXY_PROVIDER_ACCOUNTS_KEY,
        CUSTOM_LINK_PROVIDER_ID,
        CUSTOM_LINK_PROVIDER_LABEL,
        PROXY_PROVIDER_OPTION_PREFIX,
        PROXY_PROVIDER_RESERVED_KEYS,
        getProxyProviders,
        getProxyProviderById,
        getProviderCountry,
        getProviderOptionFields,
        normalizeProviderOptions,
        extractProviderOptionsFromVars,
        normalizeProviderAccountUsername,
        maskProxyUrlForDisplay,
        getProviderTestCountryCodes,
        getProviderTestCheckUrl,
        getProviderTestMinPasses,
        buildProviderAccountTestTemplate,
        resolveProviderTemplateForTest,
        planProviderAccountTests,
        PROVIDER_TEST_POPULAR,
        PROVIDER_TEST_MIN_PASS,
        groupCountriesByRegion,
        isReservedProviderVar,
        filterUserTemplateVars,
        buildProviderTemplate,
        buildProviderVariables,
        getProfileProviderMeta,
        suggestProfileName,
        loadProviderAccounts,
        listProviderAccounts,
        getProviderAccountEntry,
        getProviderAccount,
        addProviderAccount,
        updateProviderAccount,
        setProviderAccount,
        deleteProviderAccount,
        listConfiguredProviderIds,
        resolveProviderCredentials,
    };
}
