'use strict';

/**
 * Server half of the CupNet mini page analyzer. The page agent (mini/page-agent.js) scans the live DOM;
 * this adds what only the MITM knows: the document's response headers (security audit), the cookies the
 * jar tracked for the host, and an endpoint scout over the page's scripts taken from the session log
 * (optionally fetched through the AzureTLS worker when they were not logged).
 */

const { buildEndpointReport, MAX_SCRIPT_CHARS } = require('../main-process/services/page-analyzer-endpoint-scan');
const { takeInjectOriginals } = require('../html-inject');

const MAX_SCRIPTS = 60;
const MAX_FETCH = 25;
const FETCH_TIMEOUT_MS = 15000;
/** The agent's own tag in a logged HTML document (html-inject.js layout; the escaped source never contains "</script"). */
const AGENT_RULE_NAME = 'CupNet page agent';
const AGENT_TAG_RE = /<script nonce="([^"]+)" data-cupnet data-cupnet-rule="CupNet page agent">[\s\S]*?<\/script>/;

function _hv(h, name) {
    if (!h) return '';
    const k = Object.keys(h).find((x) => x.toLowerCase() === name);
    if (!k) return '';
    const v = h[k];
    return Array.isArray(v) ? v.join(', ') : String(v ?? '');
}

function _noHash(u) {
    const s = String(u || '');
    const i = s.indexOf('#');
    return i >= 0 ? s.slice(0, i) : s;
}

/**
 * Remove the page agent's tag from a logged HTML body and undo its CSP changes (headers and <meta>),
 * so the log shows the page as the site sent it (plus any user inject rules) instead of 50 KB of agent
 * per document.
 * @returns {{ body: string, headers: object }|null} null when the body has no agent tag
 */
function stripAgentFromLoggedDocument(body, headers) {
    if (typeof body !== 'string' || body.length < 60 || !body.includes(AGENT_RULE_NAME)) return null;
    const m = AGENT_TAG_RE.exec(body);
    if (!m) return null;
    let out = body.slice(0, m.index) + body.slice(m.index + m[0].length);
    // The same nonce also allows any user inject rule scripts: keep it then.
    if (out.includes(`nonce="${m[1]}"`)) return { body: out, headers };
    const h = { ...headers };
    const orig = takeInjectOriginals(m[1]);
    if (orig) {
        for (const [patched, original] of orig.metas) out = out.split(patched).join(original);
        for (const [k, v] of Object.entries(orig.headers)) {
            const key = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase()) || k;
            h[key] = v;
        }
        return { body: out, headers: h };
    }
    // Injected too long ago to be remembered: at least drop our nonce.
    const token = ` 'nonce-${m[1]}'`;
    for (const k of Object.keys(h)) {
        const l = k.toLowerCase();
        if (l !== 'content-security-policy' && l !== 'content-security-policy-report-only') continue;
        h[k] = Array.isArray(h[k]) ? h[k].map((v) => String(v).split(token).join('')) : String(h[k]).split(token).join('');
    }
    return { body: out, headers: h };
}

function _directives(policy) {
    const m = new Map();
    for (const part of String(policy || '').split(';')) {
        const t = part.trim().split(/\s+/).filter(Boolean);
        if (t[0] && !m.has(t[0].toLowerCase())) m.set(t[0].toLowerCase(), t.slice(1));
    }
    return m;
}

/**
 * Security-header audit of a document response.
 * @param {object} headers - response headers
 * @param {{ https?: boolean }} [o]
 * @returns {Array<{ name: string, status: 'good'|'warn'|'bad'|'info', value: string, note: string }>}
 */
function auditSecurityHeaders(headers, o = {}) {
    const out = [];
    const add = (name, status, value, note) => out.push({ name, status, value: String(value || '').slice(0, 2000), note });
    const https = o.https !== false;

    const csp = _hv(headers, 'content-security-policy');
    const cspRo = _hv(headers, 'content-security-policy-report-only');
    const cspNote = (pol) => {
        const d = _directives(pol);
        const script = d.get('script-src') || d.get('default-src') || null;
        const issues = [];
        if (!script) issues.push('no script-src / default-src: scripts are unrestricted');
        else {
            const low = script.map((s) => s.toLowerCase());
            const strict = low.some((s) => /^'(nonce|sha\d{3})-/.test(s) || s === "'strict-dynamic'");
            if (low.includes("'unsafe-inline'") && !strict) issues.push("'unsafe-inline' scripts");
            if (low.includes("'unsafe-eval'")) issues.push("'unsafe-eval'");
            if (low.some((s) => s === '*' || s === 'https:' || s === 'http:' || s === 'data:')) issues.push('wildcard script sources');
        }
        if (!d.has('object-src') && !(d.get('default-src') || []).some((s) => s === "'none'")) issues.push('no object-src');
        if (!d.has('base-uri')) issues.push('no base-uri');
        return issues;
    };
    if (csp) {
        const issues = cspNote(csp);
        add('Content-Security-Policy', issues.length ? 'warn' : 'good', csp, issues.length ? issues.join('; ') : 'Restrictive policy');
    } else {
        add('Content-Security-Policy', cspRo ? 'warn' : 'bad', '', cspRo ? 'Only a report-only policy (not enforced)' : 'Missing');
    }
    if (cspRo) add('Content-Security-Policy-Report-Only', 'info', cspRo, 'Violations are reported, not blocked');

    const hsts = _hv(headers, 'strict-transport-security');
    if (!https) add('Strict-Transport-Security', 'info', hsts, 'Plain HTTP page');
    else if (!hsts) add('Strict-Transport-Security', 'bad', '', 'Missing: first visits can be downgraded to HTTP');
    else {
        const age = Number((/max-age=(\d+)/i.exec(hsts) || [])[1] || 0);
        add('Strict-Transport-Security', age >= 15552000 ? 'good' : 'warn', hsts,
            age >= 15552000 ? `max-age ${Math.round(age / 86400)} days${/includesubdomains/i.test(hsts) ? ', subdomains' : ''}${/preload/i.test(hsts) ? ', preload' : ''}` : `max-age is short (${age} s)`);
    }

    const xfo = _hv(headers, 'x-frame-options');
    const fa = csp ? _directives(csp).get('frame-ancestors') : null;
    if (fa) add('Clickjacking (frame-ancestors)', fa.includes('*') ? 'warn' : 'good', `frame-ancestors ${fa.join(' ')}`, fa.includes('*') ? 'Any site can frame the page' : 'Framing restricted by CSP');
    else if (xfo) add('Clickjacking (X-Frame-Options)', /^(deny|sameorigin)$/i.test(xfo.trim()) ? 'good' : 'warn', xfo, 'Framing restricted');
    else add('Clickjacking', 'warn', '', 'No X-Frame-Options or frame-ancestors: the page can be framed');

    const xcto = _hv(headers, 'x-content-type-options');
    add('X-Content-Type-Options', /nosniff/i.test(xcto) ? 'good' : 'warn', xcto, /nosniff/i.test(xcto) ? 'MIME sniffing off' : 'Missing nosniff');

    const rp = _hv(headers, 'referrer-policy');
    if (!rp) add('Referrer-Policy', 'info', '', 'Not set (browser default strict-origin-when-cross-origin)');
    else add('Referrer-Policy', /unsafe-url|no-referrer-when-downgrade/i.test(rp) ? 'warn' : 'good', rp, /unsafe-url/i.test(rp) ? 'Full URLs leak to other sites' : 'Set');

    const pp = _hv(headers, 'permissions-policy');
    add('Permissions-Policy', pp ? 'good' : 'info', pp, pp ? 'Set' : 'Not set');

    const coop = _hv(headers, 'cross-origin-opener-policy');
    const coep = _hv(headers, 'cross-origin-embedder-policy');
    const corp = _hv(headers, 'cross-origin-resource-policy');
    add('Cross-Origin-Opener-Policy', coop ? 'good' : 'info', coop, coop ? 'Set' : 'Not set');
    if (coep) add('Cross-Origin-Embedder-Policy', 'good', coep, /require-corp|credentialless/i.test(coep) && /same-origin/i.test(coop) ? 'Cross-origin isolated' : 'Set');
    if (corp) add('Cross-Origin-Resource-Policy', 'good', corp, 'Set');

    for (const [name, note] of [['server', 'Server software'], ['x-powered-by', 'Discloses the framework'], ['x-aspnet-version', 'Discloses the framework']]) {
        const v = _hv(headers, name);
        if (v) add(name.replace(/(^|-)\w/g, (c) => c.toUpperCase()), name === 'server' && !/\d/.test(v) ? 'info' : 'warn', v, /\d/.test(v) ? `${note} and its version` : note);
    }
    const cdn = [['cf-ray', 'Cloudflare'], ['x-amz-cf-id', 'Amazon CloudFront'], ['x-served-by', 'Fastly'], ['x-akamai-transformed', 'Akamai'], ['x-qrator-request-id', 'Qrator'], ['x-iinfo', 'Imperva'], ['x-datadome', 'DataDome'], ['x-sucuri-id', 'Sucuri']]
        .filter(([h]) => _hv(headers, h)).map(([, n]) => n);
    if (cdn.length) add('CDN / WAF', 'info', cdn.join(', '), 'From response headers');
    return out;
}

/** Latest logged document response for `url` (summary + full entry), or null. */
function findDocumentEntry(log, url) {
    if (!log) return null;
    const want = _noHash(url);
    const items = log.index.items;
    let fallback = null;
    for (let i = items.length - 1; i >= 0 && i >= items.length - 20000; i--) {
        const s = items[i];
        if (s.kind !== 'request' || _noHash(s.url) !== want) continue;
        if (/html/i.test(s.mime || '')) return log.get(s.seq);
        if (!fallback) fallback = s;
    }
    return fallback ? log.get(fallback.seq) : null;
}

/** Latest logged body for each of `urls` (Map url → { body, status, seq }). */
function findLoggedBodies(log, urls) {
    const want = new Set(urls);
    const found = new Map();
    if (!log || !want.size) return found;
    const items = log.index.items;
    for (let i = items.length - 1; i >= 0 && found.size < want.size; i--) {
        const s = items[i];
        if (s.kind !== 'request' || !want.has(s.url) || found.has(s.url)) continue;
        if (!(s.status >= 200 && s.status < 300)) continue;
        const e = log.get(s.seq);
        let body = e && e.responseBody;
        if (typeof body !== 'string') continue;
        if (body.startsWith('__b64__:')) {
            try { body = Buffer.from(body.slice(8), 'base64').toString('utf8'); } catch { continue; }
        }
        found.set(s.url, { body, status: s.status, seq: s.seq });
    }
    return found;
}

/** Server-side stack the document response headers reveal (the page agent only sees the DOM). */
const HEADER_TECH = [
    ['cf-ray', 'Cloudflare'], ['x-amz-cf-id', 'Amazon CloudFront'], ['x-served-by', 'Fastly', /cache-/i], ['x-fastly-request-id', 'Fastly'],
    ['x-akamai-transformed', 'Akamai'], ['akamai-grn', 'Akamai'], ['x-vercel-id', 'Vercel'], ['x-nf-request-id', 'Netlify'],
    ['x-github-request-id', 'GitHub Pages'], ['x-qrator-request-id', 'Qrator'], ['x-ddos-protection', 'DDoS-Guard'], ['x-sucuri-id', 'Sucuri'],
    ['x-iinfo', 'Imperva Incapsula'], ['x-datadome', 'DataDome'], ['x-drupal-cache', 'Drupal'], ['x-shopify-stage', 'Shopify'],
    ['x-wix-request-id', 'Wix'], ['x-aspnet-version', 'ASP.NET'], ['x-litespeed-cache', 'LiteSpeed Cache'], ['x-varnish', 'Varnish'],
];
function techFromHeaders(headers) {
    const hv = (name) => { const k = Object.keys(headers).find((x) => x.toLowerCase() === name); const v = k ? headers[k] : ''; return String(Array.isArray(v) ? v[0] : v ?? '').trim(); };
    const out = [];
    // "nginx/1.25.3", "Apache/2.4.57 (Ubuntu)", "Express 4.18", "PHP/8.2.1" → name + version
    const split = (v) => { const m = /^([A-Za-z][\w .-]*?)(?:[/ ]v?(\d[\w.-]*))?(?:\s|$)/.exec(v); return m ? [m[1].trim(), m[2] || ''] : [v, '']; };
    for (const h of ['server', 'x-powered-by']) {
        const v = hv(h);
        if (!v) continue;
        for (const part of v.split(/,\s*/).slice(0, 3)) { const [name, version] = split(part); if (name) out.push({ name: name.slice(0, 40), version: version.slice(0, 40), from: h }); }
    }
    for (const [h, name, re] of HEADER_TECH) { const v = hv(h); if (v && (!re || re.test(v))) out.push({ name, version: '', from: h }); }
    const sc = Object.keys(headers).filter((x) => x.toLowerCase() === 'set-cookie').flatMap((k) => [].concat(headers[k])).join('\n');
    if (/__cf_bm|cf_clearance/i.test(sc)) out.push({ name: 'Cloudflare Bot Management', version: '', from: 'set-cookie' });
    return out;
}
function mergeTech(a, b) {
    const seen = new Set(a.map((t) => t.name.toLowerCase()));
    return [...a, ...b.filter((t) => !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()))];
}

/**
 * Combine the agent's report with server-side data.
 * @param {object} report - agent analyze report { forms, captcha, meta, endpoints, extra }
 * @param {{ page: object, log: object, cookies: object[], fetchScript?: (url: string) => Promise<{ statusCode: number, body: string, error?: string }>, fetchMissing?: boolean }} o
 */
async function enrichReport(report, o) {
    const r = { ...report };
    const page = o.page;
    let host = '';
    try { host = new URL(page.url).hostname; } catch { /* about:blank */ }

    const doc = findDocumentEntry(o.log, page.url);
    r.document = doc ? {
        seq: doc.seq, status: doc.status, mime: doc.mime, duration: doc.duration, resSize: doc.resSize, ts: doc.ts,
        headers: doc.responseHeaders || {},
    } : null;
    r.security = doc ? auditSecurityHeaders(doc.responseHeaders || {}, { https: /^https:/i.test(page.url) }) : null;
    if (doc) r.extra = { ...(r.extra || {}), tech: mergeTech((r.extra && r.extra.tech) || [], techFromHeaders(doc.responseHeaders || {})) };

    const cookieNames = new Set((report.extra && report.extra.cookieNames) || []);
    r.cookies = (o.cookies || [])
        .filter((c) => host && (c.hostOnly ? c.domain === host : (host === c.domain || host.endsWith(`.${c.domain}`))))
        .map((c) => ({
            id: c.id, name: c.name, value: c.value, domain: c.domain, path: c.path, hostOnly: !!c.hostOnly,
            expires: c.expires ?? null, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || '',
            partitioned: !!c.partitioned, inJs: cookieNames.has(c.name),
        }));

    const ep = report.endpoints;
    if (ep && !ep.error) {
        const urls = (ep.scriptUrls || []).slice(0, MAX_SCRIPTS);
        const logged = findLoggedBodies(o.log, urls);
        const externalScripts = [];
        const missing = [];
        for (const url of urls) {
            const f = logged.get(url);
            if (f) externalScripts.push({ url, body: f.body.slice(0, MAX_SCRIPT_CHARS), statusCode: f.status, source: 'log' });
            else missing.push(url);
        }
        let fetched = 0;
        if (o.fetchMissing && o.fetchScript) {
            const batch = missing.splice(0, MAX_FETCH);
            const res = await Promise.all(batch.map((url) => Promise.race([
                o.fetchScript(url),
                new Promise((resolve) => setTimeout(() => resolve({ statusCode: 0, body: '', error: 'timeout' }), FETCH_TIMEOUT_MS)),
            ]).catch((e) => ({ statusCode: 0, body: '', error: e?.message || String(e) }))));
            batch.forEach((url, i) => {
                const x = res[i];
                if (x.body && x.statusCode >= 200 && x.statusCode < 300) fetched++;
                else missing.push(url);
                externalScripts.push({ url, body: String(x.body || '').slice(0, MAX_SCRIPT_CHARS), statusCode: x.statusCode, error: x.error || null, source: 'fetched' });
            });
        }
        const rep = buildEndpointReport({
            pageUrl: ep.pageUrl, statusHint: ep.statusHint, inlineScripts: ep.inlineScripts || [],
            externalScripts: externalScripts.filter((s) => s.body), perfNames: (ep.perfNames || []).filter((n) => !String(n).includes('/__cupnet/')),
        });
        r.endpoints = {
            ...rep,
            scriptUrls: ep.scriptUrls || [],
            inlineCount: (ep.inlineScripts || []).length,
            fromLog: externalScripts.filter((s) => s.source === 'log').length,
            fetched,
            missing,
        };
    }
    return r;
}

module.exports = { auditSecurityHeaders, techFromHeaders, stripAgentFromLoggedDocument, findDocumentEntry, findLoggedBodies, enrichReport, AGENT_RULE_NAME };
