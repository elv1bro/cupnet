'use strict';

/**
 * Browser identity catalog — the single JS source of truth for "what browser do we claim to be".
 *
 * A template ties together everything that must describe the SAME browser:
 *   - the User-Agent string (wire header + navigator.userAgent),
 *   - the TLS/HTTP2 profile name understood by the AzureTLS worker (azuretls-go/profiles.go),
 *   - UA client-hint metadata (sec-ch-ua*, navigator.userAgentData),
 *   - navigator.platform.
 *
 * Dual-mode module: CommonJS (main process, tests) and `window.cupnetBrowserIdentityCatalog`
 * (tool windows). Dependency-free on purpose.
 *
 * Version bumps: change the UA strings here, in azuretls-go/profiles.go (Go cannot import this
 * file); tests/unit/browser-identity-catalog.test.mjs guards drift
 * between this file and the worker profiles it can reach.
 */

const TLS_PROFILES = ['chrome', 'firefox', 'safari', 'ios', 'edge', 'opera'];

/** Chromium greased brand algorithm inputs (components/embedder_support/user_agent_utils.cc). */
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
const GREASE_ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/**
 * Build the greased brand list the way Chromium does for a given major version.
 * @param {number} chromiumMajor
 * @param {{ brand: string, version: string }|null} primary - e.g. Google Chrome / Microsoft Edge / Opera
 * @param {boolean} [full] - full-version strings instead of majors
 * @param {string} [fullVersion] - real full version (e.g. "152.0.7977.130") for the Chromium entry and a
 *        primary of the same major; real Chrome never reports "N.0.0.0" in fullVersionList
 * @returns {{ brand: string, version: string }[]}
 */
function greasedBrandList(chromiumMajor, primary, full = false, fullVersion = '') {
    const seed = Number(chromiumMajor) || 0;
    const greaseBrand = `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`;
    const greaseVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.length];
    const majorStr = String(seed);
    const grease = { brand: greaseBrand, version: full ? `${greaseVersion}.0.0.0` : greaseVersion };
    const realFull = fullVersion && String(fullVersion).split('.')[0] === majorStr ? String(fullVersion) : '';
    const fullOf = (major) => (realFull && String(major) === majorStr ? realFull : `${major}.0.0.0`);
    const chromium = { brand: 'Chromium', version: full ? fullOf(majorStr) : majorStr };
    if (!primary) {
        // Unbranded Chromium (Electron, Chromium builds): a 2-entry list, order = seed % 2.
        // Verified against Electron 34 (Chromium 132: "Not A(Brand";v="8", "Chromium";v="132").
        return seed % 2 === 0 ? [grease, chromium] : [chromium, grease];
    }
    const order = GREASE_ORDERS[seed % GREASE_ORDERS.length];
    const list = new Array(3);
    list[order[0]] = grease;
    list[order[1]] = chromium;
    list[order[2]] = { brand: primary.brand, version: full ? fullOf(primary.version) : primary.version };
    return list;
}

/** Node `process.platform` → sec-ch-ua-platform value of the real engine. */
function hostPlatformName(nodePlatform) {
    switch (String(nodePlatform || '')) {
        case 'darwin': return 'macOS';
        case 'win32': return 'Windows';
        case 'linux': return 'Linux';
        default: return 'Linux';
    }
}

/**
 * Client hints for engine mode, describing the running engine (its real Chromium version, OS, arch).
 * `branded` (the default, owner decision 2026-09-27) presents it as Google Chrome — the 3-brand list a
 * real Chrome of that version sends — instead of the unbranded 2-brand Chromium list, which marks the
 * client as "Chromium/Electron, not Chrome". The same hints drive navigator.userAgentData (CDP) so the
 * wire and JavaScript agree.
 * @param {{ chromiumMajor: number, nodePlatform?: string, arch?: string, branded?: boolean, fullVersion?: string }} o
 * @returns {ClientHints}
 */
function engineClientHints({ chromiumMajor, nodePlatform, arch, branded = false, fullVersion = '', platformVersion: hostPlatformVersion = '' } = {}) {
    const major = Number(chromiumMajor) || 0;
    const platform = hostPlatformName(nodePlatform);
    // The host's real OS version when known (Chrome on macOS reports the macOS version, e.g. "15.7.9");
    // otherwise a plausible default for the platform.
    const platformVersion = /^\d+(\.\d+){0,3}$/.test(String(hostPlatformVersion || ''))
        ? String(hostPlatformVersion).split('.').concat(['0', '0']).slice(0, 3).join('.')
        : platform === 'Windows' ? '15.0.0' : platform === 'macOS' ? '15.6.1' : '6.8.0';
    const architecture = String(arch || '') === 'arm64' ? 'arm' : 'x86';
    const primary = branded ? { brand: 'Google Chrome', version: String(major) } : null;
    return _hints({ chromiumMajor: major, primary, platform, platformVersion, architecture, bitness: '64', fullVersion });
}

/**
 * @typedef {object} ClientHints
 * @property {{brand:string,version:string}[]} brands
 * @property {{brand:string,version:string}[]} fullVersionList
 * @property {string} platform        - "Windows" | "macOS" | "Linux" | "Android" | "Chrome OS"
 * @property {string} platformVersion
 * @property {string} architecture    - "x86" | "arm" | ""
 * @property {string} bitness         - "64" | ""
 * @property {string} model
 * @property {boolean} mobile
 * @property {boolean} wow64
 * @property {string[]} formFactors
 */

function _hints({ chromiumMajor, primary, platform, platformVersion, architecture, bitness, model, mobile, fullVersion }) {
    return {
        brands: greasedBrandList(chromiumMajor, primary, false),
        fullVersionList: greasedBrandList(chromiumMajor, primary, true, fullVersion),
        platform,
        platformVersion,
        architecture: architecture || '',
        bitness: bitness || '',
        model: model || '',
        mobile: !!mobile,
        wow64: false,
        formFactors: [mobile ? 'Mobile' : 'Desktop'],
    };
}

/** Current pinned majors — keep in sync with azuretls-go/profiles.go. */
const VERSIONS = Object.freeze({
    chrome: 154,
    edgeChromium: 153,
    edge: 153,
    operaChromium: 152,
    opera: 136,
    firefox: 156,
    safari: '27.0',
    iosOs: '18_6',
    macOsUa: '10_15_7',
});

const UA = Object.freeze({
    chromeWin:     `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VERSIONS.chrome}.0.0.0 Safari/537.36`,
    chromeMac:     `Mozilla/5.0 (Macintosh; Intel Mac OS X ${VERSIONS.macOsUa}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VERSIONS.chrome}.0.0.0 Safari/537.36`,
    chromeLinux:   `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VERSIONS.chrome}.0.0.0 Safari/537.36`,
    chromeAndroid: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VERSIONS.chrome}.0.0.0 Mobile Safari/537.36`,
    firefoxWin:    `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${VERSIONS.firefox}.0) Gecko/20100101 Firefox/${VERSIONS.firefox}.0`,
    firefoxMac:    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${VERSIONS.firefox}.0) Gecko/20100101 Firefox/${VERSIONS.firefox}.0`,
    safariMac:     `Mozilla/5.0 (Macintosh; Intel Mac OS X ${VERSIONS.macOsUa}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${VERSIONS.safari} Safari/605.1.15`,
    iosSafari:     `Mozilla/5.0 (iPhone; CPU iPhone OS ${VERSIONS.iosOs} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${VERSIONS.safari} Mobile/15E148 Safari/604.1`,
    edgeWin:       `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VERSIONS.edgeChromium}.0.0.0 Safari/537.36 Edg/${VERSIONS.edge}.0.0.0`,
    operaWin:      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VERSIONS.operaChromium}.0.0.0 Safari/537.36 OPR/${VERSIONS.opera}.0.0.0`,
});

/**
 * @typedef {object} IdentityTemplate
 * @property {string} id
 * @property {string} label
 * @property {string} family      - chrome|firefox|safari|ios|edge|opera (UI grouping)
 * @property {string} os          - windows|macos|linux|android|ios
 * @property {string} tlsProfile  - AzureTLS worker profile name
 * @property {string} userAgent
 * @property {string} navigatorPlatform
 * @property {ClientHints|null} clientHints - null for non-Chromium (no sec-ch-ua at all)
 * @property {boolean} mobile
 */

/** @type {IdentityTemplate[]} */
const IDENTITY_TEMPLATES = [
    {
        id: 'chrome-win', label: 'Chrome · Windows', family: 'chrome', os: 'windows', tlsProfile: 'chrome',
        userAgent: UA.chromeWin, navigatorPlatform: 'Win32', mobile: false,
        clientHints: _hints({ chromiumMajor: VERSIONS.chrome, primary: { brand: 'Google Chrome', version: String(VERSIONS.chrome) },
            platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64' }),
    },
    {
        id: 'chrome-mac', label: 'Chrome · macOS', family: 'chrome', os: 'macos', tlsProfile: 'chrome',
        userAgent: UA.chromeMac, navigatorPlatform: 'MacIntel', mobile: false,
        clientHints: _hints({ chromiumMajor: VERSIONS.chrome, primary: { brand: 'Google Chrome', version: String(VERSIONS.chrome) },
            platform: 'macOS', platformVersion: '15.6.1', architecture: 'arm', bitness: '64' }),
    },
    {
        id: 'chrome-linux', label: 'Chrome · Linux', family: 'chrome', os: 'linux', tlsProfile: 'chrome',
        userAgent: UA.chromeLinux, navigatorPlatform: 'Linux x86_64', mobile: false,
        clientHints: _hints({ chromiumMajor: VERSIONS.chrome, primary: { brand: 'Google Chrome', version: String(VERSIONS.chrome) },
            platform: 'Linux', platformVersion: '6.8.0', architecture: 'x86', bitness: '64' }),
    },
    {
        id: 'chrome-android', label: 'Chrome · Android', family: 'chrome', os: 'android', tlsProfile: 'chrome',
        userAgent: UA.chromeAndroid, navigatorPlatform: 'Linux armv8l', mobile: true,
        clientHints: _hints({ chromiumMajor: VERSIONS.chrome, primary: { brand: 'Google Chrome', version: String(VERSIONS.chrome) },
            platform: 'Android', platformVersion: '15.0.0', architecture: '', bitness: '', model: 'Pixel 9', mobile: true }),
    },
    {
        id: 'firefox-win', label: 'Firefox · Windows', family: 'firefox', os: 'windows', tlsProfile: 'firefox',
        userAgent: UA.firefoxWin, navigatorPlatform: 'Win32', mobile: false, clientHints: null,
    },
    {
        id: 'firefox-mac', label: 'Firefox · macOS', family: 'firefox', os: 'macos', tlsProfile: 'firefox',
        userAgent: UA.firefoxMac, navigatorPlatform: 'MacIntel', mobile: false, clientHints: null,
    },
    {
        id: 'safari-mac', label: 'Safari · macOS', family: 'safari', os: 'macos', tlsProfile: 'safari',
        userAgent: UA.safariMac, navigatorPlatform: 'MacIntel', mobile: false, clientHints: null,
    },
    {
        id: 'ios-safari', label: 'Safari · iPhone', family: 'ios', os: 'ios', tlsProfile: 'ios',
        userAgent: UA.iosSafari, navigatorPlatform: 'iPhone', mobile: true, clientHints: null,
    },
    {
        id: 'edge-win', label: 'Edge · Windows', family: 'edge', os: 'windows', tlsProfile: 'edge',
        userAgent: UA.edgeWin, navigatorPlatform: 'Win32', mobile: false,
        clientHints: _hints({ chromiumMajor: VERSIONS.edgeChromium, primary: { brand: 'Microsoft Edge', version: String(VERSIONS.edge) },
            platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64' }),
    },
    {
        id: 'opera-win', label: 'Opera · Windows', family: 'opera', os: 'windows', tlsProfile: 'opera',
        userAgent: UA.operaWin, navigatorPlatform: 'Win32', mobile: false,
        clientHints: _hints({ chromiumMajor: VERSIONS.operaChromium, primary: { brand: 'Opera', version: String(VERSIONS.opera) },
            platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64' }),
    },
];

const _byId = new Map(IDENTITY_TEMPLATES.map((t) => [t.id, t]));

/** Default template per TLS profile (used by the legacy "TLS template → UA" sync). */
const DEFAULT_TEMPLATE_FOR_TLS = Object.freeze({
    chrome: 'chrome-win',
    firefox: 'firefox-win',
    safari: 'safari-mac',
    ios: 'ios-safari',
    edge: 'edge-win',
    opera: 'opera-win',
});

function listTemplates() {
    return IDENTITY_TEMPLATES.map((t) => ({ ...t, clientHints: t.clientHints ? { ...t.clientHints } : null }));
}

function getTemplate(id) {
    const t = _byId.get(String(id || ''));
    return t ? { ...t, clientHints: t.clientHints ? { ...t.clientHints } : null } : null;
}

function isValidTlsProfile(name) {
    return TLS_PROFILES.includes(String(name || ''));
}

/**
 * Best-effort client hints for a free-text User-Agent. Returns null for non-Chromium UAs
 * (Firefox, Safari, iOS — those browsers never send sec-ch-ua).
 * @param {string} ua
 * @returns {ClientHints|null}
 */
function deriveClientHintsFromUserAgent(ua) {
    const s = String(ua || '');
    if (!s) return null;
    if (/\bFirefox\/\d/i.test(s) || /\bFxiOS\//i.test(s)) return null;
    if (/\b(iPhone|iPad|iPod)\b/i.test(s)) return null;           // WebKit-only platform, no hints
    const chromeMatch = s.match(/\bChrom(?:e|ium)\/(\d+)/i);
    if (!chromeMatch) return null;
    const chromiumMajor = parseInt(chromeMatch[1], 10);
    let primary = { brand: 'Google Chrome', version: String(chromiumMajor) };
    const edge = s.match(/\bEdg(?:e|A|iOS)?\/(\d+)/);
    const opera = s.match(/\bOPR\/(\d+)/);
    if (edge) primary = { brand: 'Microsoft Edge', version: edge[1] };
    else if (opera) primary = { brand: 'Opera', version: opera[1] };

    let platform = 'Windows';
    let platformVersion = '15.0.0';
    let architecture = 'x86';
    let bitness = '64';
    let model = '';
    const mobile = /\bMobile\b/.test(s);
    if (/\bAndroid\b/i.test(s)) {
        platform = 'Android';
        platformVersion = '15.0.0';
        architecture = '';
        bitness = '';
        const m = s.match(/Android [\d.]+; ([^;)]+)\)/);
        model = m && m[1] && m[1] !== 'K' ? m[1].trim() : '';
    } else if (/\bCrOS\b/.test(s)) {
        platform = 'Chrome OS';
        platformVersion = '16093.0.0';
    } else if (/Macintosh|Mac OS X/i.test(s)) {
        platform = 'macOS';
        platformVersion = '15.6.1';
        architecture = 'arm';
    } else if (/\bLinux\b/i.test(s) || /\bX11\b/.test(s)) {
        platform = 'Linux';
        platformVersion = '6.8.0';
    }
    return _hints({ chromiumMajor, primary, platform, platformVersion, architecture, bitness, model, mobile });
}

/** navigator.platform for a UA string (used for custom UAs). */
function deriveNavigatorPlatformFromUserAgent(ua) {
    const s = String(ua || '');
    if (/\b(iPhone|iPod)\b/.test(s)) return 'iPhone';
    if (/\biPad\b/.test(s)) return 'iPad';
    if (/\bAndroid\b/i.test(s)) return 'Linux armv8l';
    if (/Macintosh|Mac OS X/i.test(s)) return 'MacIntel';
    if (/\bWindows\b/i.test(s)) return 'Win32';
    if (/\bLinux\b|\bX11\b/i.test(s)) return 'Linux x86_64';
    return 'Win32';
}

/** TLS profile guess for a free-text UA (custom identity without an explicit TLS choice). */
function deriveTlsProfileFromUserAgent(ua) {
    const s = String(ua || '');
    if (/\bFirefox\/\d/i.test(s)) return 'firefox';
    if (/\b(iPhone|iPad|iPod)\b/.test(s)) return 'ios';
    if (/\bEdg\/\d/.test(s)) return 'edge';
    if (/\bOPR\/\d/.test(s)) return 'opera';
    if (/\bChrom(?:e|ium)\/\d/i.test(s)) return 'chrome';
    if (/\bSafari\/\d/.test(s) && /\bVersion\/\d/.test(s)) return 'safari';
    return 'chrome';
}

/**
 * Accept-Language helpers. Electron's session.setUserAgent(ua, acceptLanguages) expects language
 * CODES ("ru,en-US,en") and adds the q-values itself; passing a full header doubles them
 * ("en-US;q=0.9;q=0.9"). The wire header is regenerated from the codes the way Chromium does
 * (first entry bare, then q=0.9, 0.8, … down to 0.1).
 */
function acceptLanguageCodes(value) {
    const out = [];
    for (const tok of String(value || '').split(',')) {
        const code = tok.split(';')[0].trim();
        if (!code) continue;
        if (!/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(code)) continue;
        if (!out.some((c) => c.toLowerCase() === code.toLowerCase())) out.push(code);
    }
    return out;
}

/**
 * Accept-Language exactly as Chrome builds it from a language list (net::HttpUtil::ExpandLanguageList +
 * GenerateAcceptLanguageHeader): after each run of same-base languages the base language is appended
 * if not already present, then q-values fall by 0.1 (min 0.1).
 * ["ru","ru-BY","en-BY","pl-BY"] → "ru,ru-BY;q=0.9,en-BY;q=0.8,en;q=0.7,pl-BY;q=0.6,pl;q=0.5"
 * ["ru-RU","ru","en-US","en"]    → "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7" (matches Chrome 153 on the wire)
 * @param {string[]} codes
 */
function chromeAcceptLanguageHeader(codes) {
    const list = acceptLanguageCodes((codes || []).join(','));
    const base = (c) => c.split('-')[0].toLowerCase();
    const out = [];
    const add = (c) => { if (!out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c); };
    list.forEach((c, i) => {
        add(c);
        if (i + 1 >= list.length || base(list[i + 1]) !== base(c)) add(base(c));
    });
    return formatAcceptLanguageHeader(out);
}

function formatAcceptLanguageHeader(codesOrValue) {
    const codes = Array.isArray(codesOrValue) ? codesOrValue.filter(Boolean) : acceptLanguageCodes(codesOrValue);
    if (!codes.length) return '';
    return codes.map((c, i) => (i === 0 ? c : `${c};q=${(Math.max(1, 10 - i) / 10).toFixed(1)}`)).join(',');
}

/** Structured-field list value: `"Chromium";v="154", "Google Chrome";v="154", ...` */
function buildBrandListHeaderValue(list) {
    return (list || []).map((b) => `"${String(b.brand).replace(/"/g, '')}";v="${String(b.version).replace(/"/g, '')}"`).join(', ');
}

/**
 * Wire header values for a ClientHints object (keys are lower-case header names).
 * @param {ClientHints|null} hints
 * @returns {Record<string,string>|null}
 */
function buildClientHintHeaders(hints) {
    if (!hints) return null;
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '')}"`;
    return {
        'sec-ch-ua': buildBrandListHeaderValue(hints.brands),
        'sec-ch-ua-mobile': hints.mobile ? '?1' : '?0',
        'sec-ch-ua-platform': q(hints.platform),
        'sec-ch-ua-platform-version': q(hints.platformVersion),
        'sec-ch-ua-arch': q(hints.architecture),
        'sec-ch-ua-bitness': q(hints.bitness),
        'sec-ch-ua-model': q(hints.model),
        'sec-ch-ua-full-version': q((hints.fullVersionList || []).find((b) => b.brand !== 'Chromium' && !/^Not/.test(b.brand))?.version
            || (hints.fullVersionList || [])[0]?.version || ''),
        'sec-ch-ua-full-version-list': buildBrandListHeaderValue(hints.fullVersionList),
        'sec-ch-ua-wow64': hints.wow64 ? '?1' : '?0',
        'sec-ch-ua-form-factors': (hints.formFactors || []).map(q).join(', '),
    };
}

/**
 * CDP `Emulation.setUserAgentOverride.userAgentMetadata` shape.
 * @param {ClientHints|null} hints
 */
function buildCdpUserAgentMetadata(hints) {
    if (!hints) return null;
    const primaryFull = (hints.fullVersionList || []).find((b) => b.brand !== 'Chromium' && !/^Not/.test(b.brand))
        || (hints.fullVersionList || [])[0];
    return {
        brands: (hints.brands || []).map((b) => ({ brand: b.brand, version: b.version })),
        fullVersionList: (hints.fullVersionList || []).map((b) => ({ brand: b.brand, version: b.version })),
        fullVersion: primaryFull ? primaryFull.version : '',
        platform: hints.platform,
        platformVersion: hints.platformVersion,
        architecture: hints.architecture || '',
        model: hints.model || '',
        mobile: !!hints.mobile,
        bitness: hints.bitness || '',
        wow64: !!hints.wow64,
    };
}

/**
 * @typedef {object} IdentitySettings
 * @property {'engine'|'template'|'custom'} mode
 * @property {string} [templateId]
 * @property {string} [userAgent]
 * @property {string} [tlsProfile]
 * @property {'template'|'custom'} [tlsJa3Mode]
 * @property {string} [tlsJa3Custom]
 * @property {boolean} [forceHttp1]
 * @property {string} [timezone]
 * @property {string} [language]
 */

/**
 * @typedef {object} ResolvedIdentity
 * @property {'engine'|'template'|'custom'} mode
 * @property {string|null} templateId
 * @property {string|null} userAgent       - null in engine mode
 * @property {ClientHints|null} clientHints
 * @property {string|null} navigatorPlatform
 * @property {string} tlsProfile
 * @property {string|null} ja3
 * @property {boolean} forceHttp1
 * @property {string|null} timezone
 * @property {string|null} language
 * @property {boolean} mobile
 */

function normalizeIdentitySettings(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const mode = ['engine', 'template', 'custom'].includes(o.mode) ? o.mode : 'engine';
    const templateId = _byId.has(String(o.templateId || '')) ? String(o.templateId) : 'chrome-win';
    const tlsProfile = isValidTlsProfile(o.tlsProfile) ? String(o.tlsProfile) : null;
    return {
        mode,
        templateId,
        userAgent: String(o.userAgent || '').trim().slice(0, 2048),
        tlsProfile,
        tlsJa3Mode: o.tlsJa3Mode === 'custom' ? 'custom' : 'template',
        tlsJa3Custom: String(o.tlsJa3Custom || '').trim().slice(0, 512),
        forceHttp1: !!o.forceHttp1,
        timezone: String(o.timezone || '').trim().slice(0, 64),
        language: String(o.language || '').trim().slice(0, 128),
        /** Engine mode: synthesize the real engine's low-entropy client hints on the wire (Electron sends none). */
        engineHints: o.engineHints !== false,
        /** Engine mode brand: 'chrome' (default) presents the engine as Google Chrome on the wire and in
         *  navigator.userAgentData; 'chromium' keeps the unbranded 2-brand list. */
        engineBrand: o.engineBrand === 'chromium' ? 'chromium' : 'chrome',
        /** Template / custom Chromium identities: send sec-ch-ua* + navigator.userAgentData (off = behave like a DevTools UA override: no hints, empty brands). */
        clientHints: o.clientHints !== false,
        /** Timezone + Accept-Language follow the connected proxy's egress country. */
        followProxyGeo: o.followProxyGeo === true,
    };
}

/**
 * Resolve identity settings into the concrete values every layer applies.
 * Engine mode still carries TLS/JA3/forceHttp1/timezone/language (they are independent of the UA).
 * @param {IdentitySettings|null|undefined} raw
 * @returns {ResolvedIdentity}
 */
function resolveIdentity(raw) {
    const s = normalizeIdentitySettings(raw);
    const ja3 = s.tlsJa3Mode === 'custom' && s.tlsJa3Custom ? s.tlsJa3Custom : null;
    const base = {
        mode: s.mode,
        templateId: null,
        userAgent: null,
        clientHints: null,
        navigatorPlatform: null,
        tlsProfile: s.tlsProfile || 'chrome',
        ja3,
        forceHttp1: s.forceHttp1,
        timezone: s.timezone || null,
        language: s.language || null,
        mobile: false,
    };
    if (s.mode === 'template') {
        const t = _byId.get(s.templateId);
        return {
            ...base,
            templateId: t.id,
            userAgent: t.userAgent,
            clientHints: t.clientHints ? { ...t.clientHints } : null, // Chromium ⟺ hints (always, like real Chrome)
            navigatorPlatform: t.navigatorPlatform,
            tlsProfile: s.tlsProfile || t.tlsProfile,
            mobile: !!t.mobile,
        };
    }
    if (s.mode === 'custom') {
        if (!s.userAgent) return { ...base, mode: 'engine' };
        return {
            ...base,
            userAgent: s.userAgent,
            clientHints: deriveClientHintsFromUserAgent(s.userAgent), // null only for non-Chromium UAs
            navigatorPlatform: deriveNavigatorPlatformFromUserAgent(s.userAgent),
            tlsProfile: s.tlsProfile || deriveTlsProfileFromUserAgent(s.userAgent),
            mobile: /\bMobile\b/.test(s.userAgent) || /\biPhone\b/.test(s.userAgent),
        };
    }
    return base;
}

/**
 * Build an override identity from a legacy proxy-profile row (user_agent/timezone/language/tls_*).
 * Missing fields fall back to `fallback` (the global resolved identity).
 * @param {object} row
 * @param {ResolvedIdentity} fallback
 * @returns {ResolvedIdentity}
 */
function resolveIdentityFromProfileRow(row, fallback) {
    const r = row || {};
    const ua = String(r.user_agent || '').trim();
    const custom = ua ? resolveIdentity({
        mode: 'custom',
        userAgent: ua,
        tlsProfile: isValidTlsProfile(r.tls_profile) ? r.tls_profile : undefined,
        tlsJa3Mode: r.tls_ja3_mode,
        tlsJa3Custom: r.tls_ja3_custom,
        forceHttp1: !!r.force_http1,
        timezone: r.timezone,
        language: r.language,
    }) : null;
    const fb = fallback || resolveIdentity(null);
    if (custom) {
        return {
            ...custom,
            timezone: custom.timezone || fb.timezone,
            language: custom.language || fb.language,
        };
    }
    return {
        ...fb,
        tlsProfile: isValidTlsProfile(r.tls_profile) ? r.tls_profile : fb.tlsProfile,
        ja3: r.tls_ja3_mode === 'custom' && r.tls_ja3_custom ? String(r.tls_ja3_custom) : fb.ja3,
        forceHttp1: r.force_http1 != null ? !!r.force_http1 : fb.forceHttp1,
        timezone: String(r.timezone || '').trim() || fb.timezone,
        language: String(r.language || '').trim() || fb.language,
    };
}

/** Human-readable one-liner for status chips: "Chrome 154 · Windows". */
function describeIdentity(resolved) {
    if (!resolved || resolved.mode === 'engine') return 'Engine default';
    const t = resolved.templateId ? _byId.get(resolved.templateId) : null;
    if (t) {
        const m = t.userAgent.match(/(?:Chrome|Firefox|Version|Edg|OPR)\/(\d+)/);
        const ver = t.id.startsWith('edge') ? t.userAgent.match(/Edg\/(\d+)/)?.[1]
            : t.id.startsWith('opera') ? t.userAgent.match(/OPR\/(\d+)/)?.[1]
            : m?.[1];
        return `${t.label.replace(' · ', ` ${ver || ''} · `)}`.replace(/\s+/g, ' ');
    }
    const ua = String(resolved.userAgent || '');
    return `Custom UA (${ua.slice(0, 40)}${ua.length > 40 ? '…' : ''})`;
}

const cupnetBrowserIdentityCatalog = {
    VERSIONS,
    UA,
    TLS_PROFILES,
    IDENTITY_TEMPLATES,
    DEFAULT_TEMPLATE_FOR_TLS,
    listTemplates,
    getTemplate,
    isValidTlsProfile,
    greasedBrandList,
    hostPlatformName,
    engineClientHints,
    deriveClientHintsFromUserAgent,
    deriveNavigatorPlatformFromUserAgent,
    deriveTlsProfileFromUserAgent,
    acceptLanguageCodes,
    formatAcceptLanguageHeader,
    chromeAcceptLanguageHeader,
    buildBrandListHeaderValue,
    buildClientHintHeaders,
    buildCdpUserAgentMetadata,
    normalizeIdentitySettings,
    resolveIdentity,
    resolveIdentityFromProfileRow,
    describeIdentity,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = cupnetBrowserIdentityCatalog;
}
if (typeof window !== 'undefined') {
    window.cupnetBrowserIdentityCatalog = cupnetBrowserIdentityCatalog;
}
