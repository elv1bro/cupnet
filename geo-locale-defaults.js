'use strict';

/**
 * Country → locale defaults used when the browser identity follows the proxy egress country
 * (identity.followProxyGeo). The timezone itself comes from the IP/geo lookup (ipinfo `timezone`);
 * this table only supplies a sensible Accept-Language for the country plus a fallback timezone for
 * lookups that return no zone.
 *
 * Dual-mode, dependency-free. Unit tests: tests/unit/geo-locale-defaults.test.mjs
 */

/** ISO-3166 alpha-2 → { language (Accept-Language), timezone (fallback IANA zone) } */
const GEO_LOCALE_DEFAULTS = Object.freeze({
    us: { language: 'en-US,en;q=0.9', timezone: 'America/New_York' },
    ca: { language: 'en-CA,en;q=0.9,fr;q=0.8', timezone: 'America/Toronto' },
    mx: { language: 'es-MX,es;q=0.9,en;q=0.8', timezone: 'America/Mexico_City' },
    br: { language: 'pt-BR,pt;q=0.9,en;q=0.8', timezone: 'America/Sao_Paulo' },
    ar: { language: 'es-AR,es;q=0.9,en;q=0.8', timezone: 'America/Argentina/Buenos_Aires' },
    cl: { language: 'es-CL,es;q=0.9,en;q=0.8', timezone: 'America/Santiago' },
    co: { language: 'es-CO,es;q=0.9,en;q=0.8', timezone: 'America/Bogota' },
    pe: { language: 'es-PE,es;q=0.9,en;q=0.8', timezone: 'America/Lima' },
    gb: { language: 'en-GB,en;q=0.9', timezone: 'Europe/London' },
    ie: { language: 'en-IE,en;q=0.9', timezone: 'Europe/Dublin' },
    pt: { language: 'pt-PT,pt;q=0.9,en;q=0.8', timezone: 'Europe/Lisbon' },
    es: { language: 'es-ES,es;q=0.9,en;q=0.8', timezone: 'Europe/Madrid' },
    fr: { language: 'fr-FR,fr;q=0.9,en;q=0.8', timezone: 'Europe/Paris' },
    be: { language: 'nl-BE,nl;q=0.9,fr;q=0.8,en;q=0.7', timezone: 'Europe/Brussels' },
    nl: { language: 'nl-NL,nl;q=0.9,en;q=0.8', timezone: 'Europe/Amsterdam' },
    lu: { language: 'fr-LU,fr;q=0.9,de;q=0.8,en;q=0.7', timezone: 'Europe/Luxembourg' },
    de: { language: 'de-DE,de;q=0.9,en;q=0.8', timezone: 'Europe/Berlin' },
    at: { language: 'de-AT,de;q=0.9,en;q=0.8', timezone: 'Europe/Vienna' },
    ch: { language: 'de-CH,de;q=0.9,fr;q=0.8,en;q=0.7', timezone: 'Europe/Zurich' },
    it: { language: 'it-IT,it;q=0.9,en;q=0.8', timezone: 'Europe/Rome' },
    dk: { language: 'da-DK,da;q=0.9,en;q=0.8', timezone: 'Europe/Copenhagen' },
    se: { language: 'sv-SE,sv;q=0.9,en;q=0.8', timezone: 'Europe/Stockholm' },
    no: { language: 'nb-NO,nb;q=0.9,en;q=0.8', timezone: 'Europe/Oslo' },
    fi: { language: 'fi-FI,fi;q=0.9,en;q=0.8', timezone: 'Europe/Helsinki' },
    is: { language: 'is-IS,is;q=0.9,en;q=0.8', timezone: 'Atlantic/Reykjavik' },
    pl: { language: 'pl-PL,pl;q=0.9,en;q=0.8', timezone: 'Europe/Warsaw' },
    cz: { language: 'cs-CZ,cs;q=0.9,en;q=0.8', timezone: 'Europe/Prague' },
    sk: { language: 'sk-SK,sk;q=0.9,en;q=0.8', timezone: 'Europe/Bratislava' },
    hu: { language: 'hu-HU,hu;q=0.9,en;q=0.8', timezone: 'Europe/Budapest' },
    ro: { language: 'ro-RO,ro;q=0.9,en;q=0.8', timezone: 'Europe/Bucharest' },
    bg: { language: 'bg-BG,bg;q=0.9,en;q=0.8', timezone: 'Europe/Sofia' },
    gr: { language: 'el-GR,el;q=0.9,en;q=0.8', timezone: 'Europe/Athens' },
    hr: { language: 'hr-HR,hr;q=0.9,en;q=0.8', timezone: 'Europe/Zagreb' },
    si: { language: 'sl-SI,sl;q=0.9,en;q=0.8', timezone: 'Europe/Ljubljana' },
    rs: { language: 'sr-RS,sr;q=0.9,en;q=0.8', timezone: 'Europe/Belgrade' },
    ua: { language: 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7', timezone: 'Europe/Kyiv' },
    by: { language: 'ru-BY,ru;q=0.9,be;q=0.8,en;q=0.7', timezone: 'Europe/Minsk' },
    md: { language: 'ro-MD,ro;q=0.9,ru;q=0.8,en;q=0.7', timezone: 'Europe/Chisinau' },
    ru: { language: 'ru-RU,ru;q=0.9,en;q=0.8', timezone: 'Europe/Moscow' },
    lt: { language: 'lt-LT,lt;q=0.9,en;q=0.8', timezone: 'Europe/Vilnius' },
    lv: { language: 'lv-LV,lv;q=0.9,en;q=0.8', timezone: 'Europe/Riga' },
    ee: { language: 'et-EE,et;q=0.9,en;q=0.8', timezone: 'Europe/Tallinn' },
    tr: { language: 'tr-TR,tr;q=0.9,en;q=0.8', timezone: 'Europe/Istanbul' },
    ge: { language: 'ka-GE,ka;q=0.9,en;q=0.8', timezone: 'Asia/Tbilisi' },
    am: { language: 'hy-AM,hy;q=0.9,ru;q=0.8,en;q=0.7', timezone: 'Asia/Yerevan' },
    az: { language: 'az-AZ,az;q=0.9,ru;q=0.8,en;q=0.7', timezone: 'Asia/Baku' },
    kz: { language: 'ru-KZ,ru;q=0.9,kk;q=0.8,en;q=0.7', timezone: 'Asia/Almaty' },
    uz: { language: 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7', timezone: 'Asia/Tashkent' },
    il: { language: 'he-IL,he;q=0.9,en;q=0.8', timezone: 'Asia/Jerusalem' },
    ae: { language: 'ar-AE,ar;q=0.9,en;q=0.8', timezone: 'Asia/Dubai' },
    sa: { language: 'ar-SA,ar;q=0.9,en;q=0.8', timezone: 'Asia/Riyadh' },
    eg: { language: 'ar-EG,ar;q=0.9,en;q=0.8', timezone: 'Africa/Cairo' },
    ma: { language: 'fr-MA,fr;q=0.9,ar;q=0.8,en;q=0.7', timezone: 'Africa/Casablanca' },
    ng: { language: 'en-NG,en;q=0.9', timezone: 'Africa/Lagos' },
    ke: { language: 'en-KE,en;q=0.9,sw;q=0.8', timezone: 'Africa/Nairobi' },
    za: { language: 'en-ZA,en;q=0.9', timezone: 'Africa/Johannesburg' },
    in: { language: 'en-IN,en;q=0.9,hi;q=0.8', timezone: 'Asia/Kolkata' },
    pk: { language: 'en-PK,en;q=0.9,ur;q=0.8', timezone: 'Asia/Karachi' },
    bd: { language: 'bn-BD,bn;q=0.9,en;q=0.8', timezone: 'Asia/Dhaka' },
    lk: { language: 'si-LK,si;q=0.9,en;q=0.8', timezone: 'Asia/Colombo' },
    th: { language: 'th-TH,th;q=0.9,en;q=0.8', timezone: 'Asia/Bangkok' },
    vn: { language: 'vi-VN,vi;q=0.9,en;q=0.8', timezone: 'Asia/Ho_Chi_Minh' },
    my: { language: 'ms-MY,ms;q=0.9,en;q=0.8', timezone: 'Asia/Kuala_Lumpur' },
    sg: { language: 'en-SG,en;q=0.9,zh;q=0.8', timezone: 'Asia/Singapore' },
    id: { language: 'id-ID,id;q=0.9,en;q=0.8', timezone: 'Asia/Jakarta' },
    ph: { language: 'en-PH,en;q=0.9,fil;q=0.8', timezone: 'Asia/Manila' },
    hk: { language: 'zh-HK,zh;q=0.9,en;q=0.8', timezone: 'Asia/Hong_Kong' },
    tw: { language: 'zh-TW,zh;q=0.9,en;q=0.8', timezone: 'Asia/Taipei' },
    cn: { language: 'zh-CN,zh;q=0.9,en;q=0.8', timezone: 'Asia/Shanghai' },
    kr: { language: 'ko-KR,ko;q=0.9,en;q=0.8', timezone: 'Asia/Seoul' },
    jp: { language: 'ja-JP,ja;q=0.9,en;q=0.8', timezone: 'Asia/Tokyo' },
    au: { language: 'en-AU,en;q=0.9', timezone: 'Australia/Sydney' },
    nz: { language: 'en-NZ,en;q=0.9', timezone: 'Pacific/Auckland' },
});

const FALLBACK_LANGUAGE = 'en-US,en;q=0.9';

/**
 * @param {string} countryCode - ISO-2 (any case)
 * @returns {{ language: string, timezone: string|null, known: boolean }}
 */
function localeDefaultsForCountry(countryCode) {
    const cc = String(countryCode || '').trim().toLowerCase();
    const row = cc ? GEO_LOCALE_DEFAULTS[cc] : null;
    if (!row) return { language: FALLBACK_LANGUAGE, timezone: null, known: false };
    return { language: row.language, timezone: row.timezone, known: true };
}

/**
 * Derive the identity locale hint from an IP/geo lookup result ({ country, timezone }).
 * The lookup's own timezone wins over the table fallback.
 * @param {{ country?: string, timezone?: string }|null} geo
 * @returns {{ country: string, timezone: string|null, language: string|null }|null}
 */
function geoHintFromLookup(geo) {
    if (!geo || typeof geo !== 'object') return null;
    const country = String(geo.country || '').trim().toLowerCase();
    const defaults = localeDefaultsForCountry(country);
    const tz = String(geo.timezone || '').trim() || defaults.timezone;
    if (!country && !tz) return null;
    return {
        country,
        timezone: tz || null,
        language: country ? defaults.language : null,
    };
}

const cupnetGeoLocaleDefaults = { GEO_LOCALE_DEFAULTS, FALLBACK_LANGUAGE, localeDefaultsForCountry, geoHintFromLookup };

if (typeof module !== 'undefined' && module.exports) module.exports = cupnetGeoLocaleDefaults;
if (typeof window !== 'undefined') window.cupnetGeoLocaleDefaults = cupnetGeoLocaleDefaults;
