'use strict';

/**
 * Proxy Manager — pure form/profile logic shared by the renderer and unit tests (no DOM).
 *
 *   - editor modes: 'simple' (provider + credentials + country + session) vs 'advanced' (everything);
 *   - credential recovery from a decrypted proxy URL / template;
 *   - Simple-mode form → profile payload for `save-proxy-profile-full`;
 *   - helpers for prefilling credentials from an existing profile of the same provider.
 *
 * Dual-mode module (CommonJS + window.cupnetProxyManagerModel), dependency-free: the provider
 * registry (`proxy-providers.js`) is passed in as `pp` where needed.
 * Unit tests: tests/unit/proxy-manager-model.test.mjs
 */

const EDITOR_MODES = ['simple', 'advanced'];
const EDITOR_MODE_PREF_KEY = 'proxyManager.editorMode';
const DEFAULT_EDITOR_MODE = 'simple';

function normalizeEditorMode(mode) {
    return EDITOR_MODES.includes(mode) ? mode : DEFAULT_EDITOR_MODE;
}

/**
 * Which editor mode a profile needs. Provider-authored profiles fit Simple; manual URL templates,
 * fallback lists, non-default provider option fields or identity overrides need Advanced.
 * @param {object|null} profile - row from get-proxy-profiles (variables parsed)
 * @param {string} preferredMode
 * @param {object} [pp] - proxy-providers module; when given, provider options equal to the
 *                        provider defaults do not force Advanced (e.g. NodeMaven's default filter)
 */
function editorModeForProfile(profile, preferredMode, pp) {
    const pref = normalizeEditorMode(preferredMode);
    if (pref === 'advanced' || !profile) return pref;
    const v = profile.variables && typeof profile.variables === 'object' ? profile.variables : {};
    if (v.__connectionMode !== 'provider' || !v.__provider) return 'advanced';
    const optKeys = Object.keys(v).filter((k) => k.startsWith('__opt_'));
    if (optKeys.length) {
        const provider = pp?.getProxyProviderById?.(v.__provider) || null;
        const defaults = provider && pp?.normalizeProviderOptions ? (pp.normalizeProviderOptions(provider, {}) || {}) : null;
        if (!defaults) return 'advanced';
        for (const k of optKeys) {
            const name = k.slice('__opt_'.length);
            if (String(v[k] ?? '') !== String(defaults[name] ?? '')) return 'advanced';
        }
    }
    if (v.FALLBACK_PROXIES || v.fallback_proxies || v.fallbackProxies) return 'advanced';
    if (profile.identity_override) return 'advanced';
    return 'simple';
}

/**
 * Username / password out of a proxy URL or template (placeholders like {SID} / {RAND:a-b} allowed).
 * @param {string} url
 * @returns {{ username: string, password: string }}
 */
function extractCredentialsFromUrl(url) {
    const s = String(url || '').trim();
    const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/@]*)@/i);
    if (!m) return { username: '', password: '' };
    const cred = m[1];
    const c = cred.indexOf(':');
    const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
    return {
        username: dec(c >= 0 ? cred.slice(0, c) : cred),
        password: dec(c >= 0 ? cred.slice(c + 1) : ''),
    };
}

/**
 * Provider account username as typed (before provider-specific suffixes) from a profile:
 * `variables.__username` first, else the URL username (which may carry -country-… suffixes).
 */
function profileUsername(profile, decryptedUrl) {
    const v = profile?.variables && typeof profile.variables === 'object' ? profile.variables : {};
    if (v.__username) return String(v.__username);
    return extractCredentialsFromUrl(decryptedUrl).username;
}

/**
 * Validate the Simple form.
 * @param {{ name?: string, providerId?: string, username?: string, password?: string, countryCode?: string, sessionMode?: string, durationMin?: number|string }} form
 * @returns {string[]} errors (empty = valid)
 */
function validateSimpleForm(form) {
    const f = form || {};
    const errors = [];
    if (!String(f.providerId || '').trim()) errors.push('Select a provider');
    if (!String(f.username || '').trim()) errors.push('Username is required');
    if (!String(f.password || '')) errors.push('Password is required');
    if (!String(f.countryCode || '').trim()) errors.push('Select a country');
    if (f.sessionMode === 'sticky') {
        const d = Number(f.durationMin);
        if (!Number.isFinite(d) || d < 1 || d > 1440) errors.push('Sticky duration must be 1–1440 minutes');
    }
    return errors;
}

/**
 * Simple form → payload for `save-proxy-profile-full` (identity untouched, no fallback list).
 * @param {object} pp - proxy-providers module (buildProviderTemplate / buildProviderVariables / suggestProfileName)
 * @param {object} form - see validateSimpleForm; plus optional `id`, `name`, `notes`
 */
function buildSimpleProfile(pp, form) {
    const f = form || {};
    const errors = validateSimpleForm(f);
    if (errors.length) return { errors };
    const sessionMode = f.sessionMode === 'sticky' ? 'sticky' : 'rotating';
    const durationMin = f.durationMin != null && f.durationMin !== '' ? Number(f.durationMin) : undefined;
    const template = pp.buildProviderTemplate(f.providerId, {
        countryCode: f.countryCode,
        sessionMode,
        durationMin,
        username: String(f.username).trim(),
        password: String(f.password),
        options: {},
    });
    if (!template) return { errors: ['Provider could not build a proxy URL'] };
    const variables = pp.buildProviderVariables(f.providerId, {
        countryCode: f.countryCode,
        sessionMode,
        durationMin,
        accountId: '',
        options: {},
    });
    variables.__username = String(f.username).trim();
    const name = String(f.name || '').trim() || pp.suggestProfileName(f.providerId, f.countryCode, sessionMode);
    return {
        profile: {
            id: f.id || undefined,
            name,
            template,
            variables,
            notes: String(f.notes || ''),
            country: String(f.countryCode || '').toLowerCase(),
            traffic_mode: 'mitm',
            user_agent: null, timezone: null, language: null,
            tls_profile: 'chrome', tls_ja3_mode: 'template', tls_ja3_custom: null, force_http1: 0,
            identity_override: 0,
        },
    };
}

/**
 * Most recently created profile of the same provider that carries a username — used to prefill
 * credentials when creating another profile for that provider.
 * @param {Array<object>} profiles
 * @param {string} providerId
 */
function findCredentialSourceProfile(profiles, providerId) {
    const list = (profiles || []).filter((p) => {
        const v = p?.variables && typeof p.variables === 'object' ? p.variables : {};
        return v.__connectionMode === 'provider' && v.__provider === providerId && v.__username;
    });
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (Number(b.id) || 0) - (Number(a.id) || 0));
    return list[0] || null;
}

/** Read-only description for the Simple editor's identity line. */
function describeIdentityForSimple(status) {
    const eff = status?.effective;
    if (!eff) return 'Browser ID: —';
    const src = status.source === 'proxy-profile' ? ' (overridden by the connected proxy profile)' : '';
    return `Browser ID: ${eff.description || '—'}${src}`;
}

const cupnetProxyManagerModel = {
    EDITOR_MODES,
    EDITOR_MODE_PREF_KEY,
    DEFAULT_EDITOR_MODE,
    normalizeEditorMode,
    editorModeForProfile,
    extractCredentialsFromUrl,
    profileUsername,
    validateSimpleForm,
    buildSimpleProfile,
    findCredentialSourceProfile,
    describeIdentityForSimple,
};

if (typeof module !== 'undefined' && module.exports) module.exports = cupnetProxyManagerModel;
if (typeof window !== 'undefined') window.cupnetProxyManagerModel = cupnetProxyManagerModel;
