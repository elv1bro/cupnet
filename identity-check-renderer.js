'use strict';

/**
 * cupnet://identity-check — compares the JavaScript-visible identity of this tab with what the MITM
 * puts on the wire. The wire side comes from https://identity-check.cupnet/echo, a host served by the
 * MITM itself (mitm-proxy.js _buildIdentityCheckResponse) so the check is fully offline.
 */
const ECHO_URL = 'https://identity-check.cupnet/echo';

const root = document.getElementById('root');
const rowsEl = document.getElementById('rows');
const verdictEl = document.getElementById('verdict');
const jsonEl = document.getElementById('json');

function brandsToHeader(brands) {
    if (!Array.isArray(brands) || !brands.length) return null;
    return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

function unquote(v) {
    return v == null ? null : String(v).replace(/^"|"$/g, '');
}

function collectJs() {
    const uad = navigator.userAgentData || null;
    return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: Array.isArray(navigator.languages) ? navigator.languages.slice() : [navigator.language],
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffsetMin: new Date().getTimezoneOffset(),
        userAgentData: uad ? {
            brands: (uad.brands || []).map((b) => ({ brand: b.brand, version: b.version })),
            mobile: !!uad.mobile,
            platform: uad.platform || '',
        } : null,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: ('deviceMemory' in navigator) ? navigator.deviceMemory : null,
        webdriver: navigator.webdriver,
        canvasStable: (() => {
            try {
                const draw = () => { const c = document.createElement('canvas'); c.width = 160; c.height = 40; const x = c.getContext('2d'); x.textBaseline = 'top'; x.font = '14px Arial'; x.fillStyle = '#f60'; x.fillRect(1, 1, 100, 18); x.fillStyle = '#069'; x.fillText('CupNet id-check', 3, 3); return c.toDataURL(); };
                return draw() === draw(); // farbling is deterministic → two reads match
            } catch { return null; }
        })(),
        windowChrome: (() => {
            try {
                const c = window.chrome;
                if (!c || typeof c !== 'object') return { present: false, keys: [], hasRuntime: false };
                return { present: true, keys: Object.keys(c), hasRuntime: !!c.runtime, loadTimesNative: typeof c.loadTimes === 'function' && /\[native code\]/.test(Function.prototype.toString.call(c.loadTimes)) };
            } catch { return { present: false, keys: [], hasRuntime: false }; }
        })(),
        webglRenderer: (() => {
            try {
                const cv = document.createElement('canvas');
                const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
                if (!gl) return null;
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                return ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : null;
            } catch { return null; }
        })(),
    };
}

/** OS family implied by a UA / navigator.platform string, for the WebGL-vs-UA consistency check. */
function osFamilyOf(text) {
    const s = String(text || '');
    // GPU / graphics-driver keywords (WebGL renderer string) — these imply an OS.
    if (/Direct3D|\bD3D\d/i.test(s)) return 'windows';
    if (/Adreno|Mali|PowerVR|OpenGL ES/i.test(s)) return 'android';
    if (/\bMetal\b|Apple M\d|Apple GPU/i.test(s)) return 'macos';
    if (/Mesa|OpenGL \d/i.test(s)) return 'linux';
    // UA / navigator.platform keywords.
    if (/Windows|Win32|Win64/i.test(s)) return 'windows';
    if (/Android/i.test(s)) return 'android';
    if (/iPhone|iPad|iOS/i.test(s)) return 'ios';
    if (/Mac|Macintosh|MacIntel/i.test(s)) return 'macos';
    if (/Linux|X11/i.test(s)) return 'linux';
    return null;
}

async function fetchWire() {
    const res = await fetch(`${ECHO_URL}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`echo responded ${res.status}`);
    return res.json();
}

function row(key, jsVal, wireVal, status, note) {
    const tr = document.createElement('tr');
    const cls = status === true ? 'ok' : status === false ? 'bad' : 'na';
    const label = status === true ? '✓ match' : status === false ? '✗ differs' : (note || '—');
    tr.innerHTML = `<td class="k">${key}</td><td class="v">${esc(jsVal ?? '—')}</td><td class="v">${esc(wireVal ?? '—')}</td><td class="s ${cls}">${esc(label)}</td>`;
    rowsEl.appendChild(tr);
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function compare(js, wire) {
    const h = wire.headers || {};
    const checks = [];
    rowsEl.innerHTML = '';

    const wireUa = h['user-agent'] || null;
    const uaOk = !!wireUa && wireUa === js.userAgent;
    checks.push({ key: 'User-Agent', ok: uaOk });
    row('User-Agent', js.userAgent, wireUa, uaOk);

    const jsBrands = js.userAgentData ? brandsToHeader(js.userAgentData.brands) : null;
    const wireBrands = h['sec-ch-ua'] || null;
    let brandsOk;
    if (!jsBrands && !wireBrands) brandsOk = null;               // non-Chromium identity: none on either side
    else brandsOk = jsBrands === wireBrands;
    checks.push({ key: 'sec-ch-ua', ok: brandsOk !== false });
    row('sec-ch-ua (brands)', jsBrands, wireBrands, brandsOk, 'none on both sides');

    const jsPlat = js.userAgentData ? js.userAgentData.platform : null;
    const wirePlat = unquote(h['sec-ch-ua-platform']);
    const platOk = !jsPlat && !wirePlat ? null : jsPlat === wirePlat;
    checks.push({ key: 'sec-ch-ua-platform', ok: platOk !== false });
    row('sec-ch-ua-platform', jsPlat, wirePlat, platOk, 'none on both sides');

    const jsMobile = js.userAgentData ? (js.userAgentData.mobile ? '?1' : '?0') : null;
    const wireMobile = h['sec-ch-ua-mobile'] || null;
    const mobileOk = !jsMobile && !wireMobile ? null : jsMobile === wireMobile;
    checks.push({ key: 'sec-ch-ua-mobile', ok: mobileOk !== false });
    row('sec-ch-ua-mobile', jsMobile, wireMobile, mobileOk, 'none on both sides');

    const wireLang = h['accept-language'] || null;
    const wireCodes = wireLang ? wireLang.split(',').map((t) => t.split(';')[0].trim().toLowerCase()).filter(Boolean) : [];
    const jsCodes = js.languages.map((l) => String(l).toLowerCase());
    const langOk = wireLang ? JSON.stringify(wireCodes) === JSON.stringify(jsCodes) : null;
    checks.push({ key: 'language', ok: langOk !== false });
    row('Accept-Language / navigator.languages', js.languages.join(', '), wireLang, langOk, 'not sent');

    row('navigator.platform', js.platform, null, null, 'JS only');

    // window.chrome — Electron leaves it empty ({}); a page claiming to be Chrome expects app/runtime/loadTimes/csi.
    const wc = js.windowChrome || { present: false, keys: [], hasRuntime: false };
    const wcExpected = /Chrome|Chromium|Edg|OPR/i.test(js.userAgent) && !/Firefox|FxiOS/i.test(js.userAgent);
    const wcOk = wcExpected ? (wc.present && wc.hasRuntime) : !wc.present;
    checks.push({ key: 'window.chrome', ok: wcOk });
    row('window.chrome', wc.present ? `{${wc.keys.join(', ')}}${wc.hasRuntime ? '' : ' — no runtime'}` : 'absent', wcExpected ? 'Chrome expects app/runtime/loadTimes/csi' : 'non-Chromium expects none', wcOk, wcExpected ? 'must look like Chrome' : 'must be absent');

    // navigator hardware fields — real Chrome caps deviceMemory at 8; a raw host value (e.g. 16) is a tell.
    const dmOk = js.deviceMemory == null ? null : js.deviceMemory <= 8;
    checks.push({ key: 'deviceMemory', ok: dmOk !== false });
    row('navigator.deviceMemory / hardwareConcurrency', `${js.deviceMemory ?? '—'} GB · ${js.hardwareConcurrency ?? '—'} cores`, 'Chrome caps deviceMemory ≤ 8', dmOk, dmOk === false ? '> 8 leaks host RAM' : 'JS only');

    // Canvas fingerprint — farbled per identity (stable across reads, not the host's raw hash).
    row('Canvas fingerprint', js.canvasStable === true ? 'stable per identity (farbled)' : js.canvasStable === false ? 'unstable' : '—', null, js.canvasStable === false ? false : null, js.canvasStable === false ? 'must be stable' : 'JS only');

    // WebGL UNMASKED renderer must match the OS the UA/platform claims (Windows UA + Apple GPU = tell).
    const glr = js.webglRenderer;
    const glOsClaim = osFamilyOf(js.platform) || osFamilyOf(js.userAgent);
    const glOsActual = glr ? osFamilyOf(glr.renderer) : null;
    let glOk = null;
    if (glr && glOsClaim && glOsActual) glOk = glOsClaim === glOsActual;
    checks.push({ key: 'webgl', ok: glOk !== false });
    row('WebGL renderer', glr ? glr.renderer : null, glOsClaim ? `OS claimed: ${glOsClaim}` : null, glOk, glOk === false ? 'contradicts the UA' : 'JS only');
    row('Timezone (Intl)', `${js.timezone} (UTC${js.timezoneOffsetMin <= 0 ? '+' : '-'}${Math.abs(js.timezoneOffsetMin) / 60})`, wire.identity?.timezone || null, null, wire.identity?.timezone ? 'identity' : 'system');
    row('TLS / HTTP2 profile', null, `${wire.tls?.profile || '—'}${wire.tls?.customJa3 ? ' · custom JA3' : ''}${wire.tls?.forceHttp1 ? ' · HTTP/1.1 forced' : ''}`, null, 'wire only');
    row('Upstream proxy', null, wire.upstreamProxy || 'none (direct)', null, wire.egressBlocked ? 'EGRESS BLOCKED' : 'wire only');
    row('Identity source', null, wire.identity ? `${wire.identity.mode}${wire.identity.templateId ? ' · ' + wire.identity.templateId : ''}${wire.identity.engineSynthesized ? ' · engine hints synthesized' : ''}` : 'engine (sanitize only)', null, 'wire only');

    const failed = checks.filter((c) => !c.ok).map((c) => c.key);
    return { consistent: failed.length === 0, failed };
}

async function run() {
    root.dataset.state = 'loading';
    verdictEl.className = 'verdict busy';
    verdictEl.textContent = 'Checking…';
    const js = collectJs();
    let wire = null;
    let error = null;
    try {
        wire = await fetchWire();
    } catch (e) {
        error = e?.message || String(e);
    }
    let result = { consistent: false, failed: [] };
    if (wire) {
        result = compare(js, wire);
        verdictEl.className = `verdict ${result.consistent ? 'ok' : 'bad'}`;
        verdictEl.textContent = result.consistent
            ? '✓ Consistent — the wire and JavaScript describe the same browser.'
            : `✗ Mismatch in: ${result.failed.join(', ')}. Reload this page after changing the identity; if it persists, report it.`;
    } else {
        rowsEl.innerHTML = '';
        verdictEl.className = 'verdict bad';
        verdictEl.textContent = `Could not reach the MITM echo (${error}). Is the local MITM proxy running?`;
    }
    const report = { js, wire, ...result, error };
    jsonEl.textContent = JSON.stringify(report, null, 2);
    root.dataset.state = 'done';
}

document.getElementById('btn-recheck')?.addEventListener('click', () => run());
run();

// ── External verification: a real request THROUGH the proxy to public echoes ────────────────────
// The table above proves wire == JS against the local MITM echo (offline, never leaves the machine).
// This makes an actual outbound request through the connected proxy, so it shows what a real website
// receives: the egress IP/country and the headers after the identity rewrite. CSP allows only the two
// hosts below (identity-check.html connect-src).
const extRoot = document.getElementById('root');
const extVerdict = document.getElementById('external-verdict');
const extTable = document.getElementById('external-table');
const extRows = document.getElementById('external-rows');
const extHint = document.getElementById('external-hint');

function hget(obj, name) {
    if (!obj) return null;
    const want = String(name).toLowerCase();
    for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return obj[k];
    return null;
}

function extRow(key, got, jsVal, status, note) {
    const tr = document.createElement('tr');
    const cls = status === true ? 'ok' : status === false ? 'bad' : 'na';
    const label = status === true ? '✓ match' : status === false ? '✗ differs' : (note || '—');
    tr.innerHTML = `<td class="k">${key}</td><td class="v">${esc(got ?? '—')}</td><td class="v">${esc(jsVal ?? '—')}</td><td class="s ${cls}">${esc(label)}</td>`;
    extRows.appendChild(tr);
}

async function externalCheck() {
    const js = collectJs();
    extTable.style.display = 'none';
    extRows.innerHTML = '';
    extVerdict.style.display = 'block';
    extVerdict.className = 'verdict busy';
    extVerdict.textContent = 'Sending a real request through the proxy…';

    // Fetch the three echoes independently — any one failing (e.g. httpbin 502) still renders a partial result.
    let echo = null; let geo = null; let peet = null; const errs = [];
    try {
        // httpbin.org/anything echoes request headers and the egress IP (origin).
        const r = await fetch(`https://httpbin.org/anything?cupnet=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
        if (!r.ok) throw new Error(`httpbin ${r.status}`);
        echo = await r.json();
    } catch (e) { errs.push('headers: ' + (e?.message || e)); }
    try {
        const g = await fetch(`https://ipinfo.io/json?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
        if (g.ok) geo = await g.json();
    } catch (e) { errs.push('geo: ' + (e?.message || e)); }
    try {
        // tls.peet.ws computes the TLS ClientHello (JA3/JA4) + HTTP/2 (Akamai) fingerprint a real server sees.
        const t = await fetch(`https://tls.peet.ws/api/all?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
        if (t.ok) peet = await t.json();
    } catch (e) { errs.push('tls: ' + (e?.message || e)); }

    if (!echo && !geo && !peet) {
        extVerdict.className = 'verdict bad';
        extVerdict.textContent = `Could not reach any echo through the proxy (${errs.join('; ')}). If a proxy is connected, check it is up; if egress is blocked, the request is refused by design.`;
        try { const prev = JSON.parse(jsonEl.textContent || '{}'); jsonEl.textContent = JSON.stringify({ ...prev, external: { errors: errs } }, null, 2); } catch { /* ignore */ }
        return;
    }

    const h = (echo && echo.headers) || {};
    // Headers come from httpbin; if it is down, fall back to what the TLS service echoes (UA only).
    const gotUa = hget(h, 'user-agent') || (peet && peet.user_agent) || null;
    const gotBrands = hget(h, 'sec-ch-ua');
    const gotPlat = hget(h, 'sec-ch-ua-platform');
    const gotLang = hget(h, 'accept-language');
    const egressIp = (geo && geo.ip) || (echo && echo.origin) || (peet && peet.ip) || null;

    const gotMobile = hget(h, 'sec-ch-ua-mobile');
    const uaOk = !!gotUa && gotUa === js.userAgent;
    extRow('Egress IP', egressIp, null, null, geo ? `${geo.country || '?'}${geo.city ? ' · ' + geo.city : ''}` : 'via proxy');
    if (geo) extRow('Egress network', geo.org || null, null, null, geo.country || null);
    extRow('User-Agent', gotUa, js.userAgent, gotUa == null ? null : uaOk, gotUa == null ? 'no echo' : undefined);
    const jsBrands = js.userAgentData ? brandsToHeader(js.userAgentData.brands) : null;
    // sec-ch-ua / platform / mobile / language come from httpbin; if it is down show "httpbin down", not a false ✗.
    if (echo) {
        extRow('sec-ch-ua', gotBrands, jsBrands, gotBrands == null && jsBrands == null ? null : gotBrands === jsBrands);
        const jsPlat = js.userAgentData ? js.userAgentData.platform : null;
        const platGot = unquote(gotPlat);
        extRow('sec-ch-ua-platform', platGot, jsPlat, (platGot == null && jsPlat == null) ? null : platGot === jsPlat);
        const jsMobile = js.userAgentData ? (js.userAgentData.mobile ? '?1' : '?0') : null;
        extRow('sec-ch-ua-mobile', gotMobile, jsMobile, (gotMobile == null && jsMobile == null) ? null : gotMobile === jsMobile);
        const jsCodes = js.languages.map((l) => String(l).toLowerCase());
        const gotCodes = gotLang ? gotLang.split(',').map((t) => t.split(';')[0].trim().toLowerCase()).filter(Boolean) : [];
        extRow('Accept-Language', gotLang, js.languages.join(', '), gotLang ? JSON.stringify(gotCodes) === JSON.stringify(jsCodes) : null, gotLang ? undefined : 'not sent');
    } else {
        extRow('Request headers', null, null, null, 'httpbin.org unavailable — UA/IP/TLS still checked below');
    }
    const uaMismatch = gotUa != null && !uaOk;

    // TLS + HTTP/2 fingerprint as a real server computes it (the crux of bot detection).
    let tlsChromeLike = null;
    if (peet) {
        const tls = peet.tls || {};
        const ja4 = tls.ja4 || null;
        const ja3h = tls.ja3_hash || null;
        const akamai = (peet.http2 && (peet.http2.akamai_fingerprint_hash || peet.http2.akamai_fingerprint)) || null;
        const peetUa = peet.user_agent || null;
        // A modern Chrome ClientHello is TLS 1.3 with h2 → JA4 begins "t13d...h2". A rough sanity signal.
        tlsChromeLike = ja4 ? /^t13d\d+h2/.test(ja4) : null;
        extRow('TLS JA4', ja4, tlsChromeLike === true ? 'Chrome-shaped (t13d…h2)' : 'checked externally', tlsChromeLike, tlsChromeLike === false ? 'not Chrome-shaped' : 'wire only');
        extRow('TLS JA3 hash', ja3h, null, null, 'wire only');
        extRow('HTTP/2 (Akamai)', akamai, null, null, peet.http_version || 'wire only');
        if (peetUa && gotUa && peetUa !== gotUa) extRow('UA (TLS service)', peetUa, gotUa, false, 'differs from httpbin');
    } else {
        extRow('TLS / HTTP2 fingerprint', null, null, null, 'tls.peet.ws unreachable');
    }

    extTable.style.display = '';
    const ok = !uaMismatch && tlsChromeLike !== false;
    extVerdict.className = `verdict ${ok ? 'ok' : 'bad'}`;
    extVerdict.textContent = uaMismatch
        ? '✗ The external site saw a different User-Agent than JavaScript. Reload after changing the identity, then re-check.'
        : tlsChromeLike === false
            ? '⚠ The TLS fingerprint does not look like the claimed browser. The worker TLS profile may differ from the UA.'
            : `✓ A real site received your identity through the proxy. Egress IP ${egressIp || '—'}${geo && geo.country ? ' (' + geo.country + ')' : ''}${peet ? ' · TLS checked' : ''}${!echo ? ' · (httpbin down, headers skipped)' : ''}.`;
    try {
        const prev = JSON.parse(jsonEl.textContent || '{}');
        jsonEl.textContent = JSON.stringify({ ...prev, external: { egressIp, geo, headers: h, tls: peet ? peet.tls : null, http2: peet ? peet.http2 : null } }, null, 2);
    } catch { /* ignore */ }
}

document.getElementById('btn-external')?.addEventListener('click', () => externalCheck());
