'use strict';

/**
 * Логика Endpoint Scout: те же эвристики, что в page-analyzer-injected-scripts,
 * но вызывается из main после загрузки скриптов через session.fetch (без CORS в renderer).
 */

const MAX_SCRIPT_CHARS = 4_000_000;

const PATH_PATTERNS = [
    /["'`](\/api\/[^"'`\s]+)["'`]/g,
    /["'`](\/auth[^"'`\s]*)["'`]/g,
    /["'`](\/login[^"'`\s]*)["'`]/g,
    /["'`](\/otp[^"'`\s]*)["'`]/g,
    /["'`](\/verify[^"'`\s]*)["'`]/g,
    /["'`](\/user[^"'`\s]*)["'`]/g,
    /["'`](\/appointment[^"'`\s]*)["'`]/g,
    /["'`](\/slot[^"'`\s]*)["'`]/g,
    /["'`](\/queue[^"'`\s]*)["'`]/g,
    /["'`](\/applicant[^"'`\s]*)["'`]/g,
    /fetch\(["'`]([^"'`]+)["'`]/g,
    /axios\.[a-z]+\(["'`]([^"'`]+)["'`]/g,
    /\.post\(["'`]([^"'`]+)["'`]/g,
    /\.get\(["'`]([^"'`]+)["'`]/g,
    /["'`]((?:https?:\/\/[^"'`\s]+)?\/[^"'`\s]*(?:api|auth|otp|appointment|slot|queue|user|profile|invoice|payment|verify|login)[^"'`\s]*)["'`]/gi,
];

const LINE_PATTERNS = [
    /["'`](\/api\/[^"'`\s]+)["'`]/g,
    /["'`](\/auth[^"'`\s]*)["'`]/g,
    /["'`](\/login[^"'`\s]*)["'`]/g,
    /["'`](\/otp[^"'`\s]*)["'`]/g,
    /["'`](\/verify[^"'`\s]*)["'`]/g,
    /["'`](\/user[^"'`\s]*)["'`]/g,
    /["'`](\/appointment[^"'`\s]*)["'`]/g,
    /["'`](\/slot[^"'`\s]*)["'`]/g,
    /["'`](\/queue[^"'`\s]*)["'`]/g,
    /["'`](\/applicant[^"'`\s]*)["'`]/g,
    /fetch\(["'`]([^"'`]+)["'`]/g,
    /axios\.[a-z]+\(["'`]([^"'`]+)["'`]/g,
    /\.post\(["'`]([^"'`]+)["'`]/g,
    /\.get\(["'`]([^"'`]+)["'`]/g,
];

function extractApiEndpoints(jsCode) {
    const patterns = PATH_PATTERNS;
    const found = new Set();
    const src = String(jsCode || '');
    const normalized = src.replace(/\\\//g, '/').replace(/\\u002f/gi, '/');
    const variants = [src, normalized];
    for (let v = 0; v < variants.length; v++) {
        const code = variants[v];
        for (let i = 0; i < patterns.length; i++) {
            const p = patterns[i];
            p.lastIndex = 0;
            let m;
            while ((m = p.exec(code)) !== null) found.add(m[1]);
        }
    }
    return Array.from(found);
}

function classifyEndpoint(ep) {
    const s = String(ep || '').toLowerCase();
    if (s.includes('/auth') || s.includes('/signin') || s.includes('/signup') || s.includes('/login')) return 'auth';
    if (s.includes('/otp') || s.includes('verifyotp') || s.includes('phone-otp')) return 'otp';
    if (s.includes('/slot') || s.includes('/appointment') || s.includes('/reserve')) return 'booking';
    if (s.includes('/payment') || s.includes('/invoice') || s.includes('/tran_')) return 'payment';
    if (s.includes('/profile') || s.includes('/user')) return 'profile';
    if (s.startsWith('/')) return 'api-path';
    return 'other';
}

function isLikelyApiEndpoint(ep) {
    if (!ep) return false;
    let s = String(ep).trim();
    if (!s) return false;
    let l = s.toLowerCase();
    if (l.startsWith('/assets/')) return false;
    if (l.startsWith('/cdn-cgi/')) return false;
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|map|woff2?|ttf|eot)(\?|$)/i.test(l)) return false;
    if (l.startsWith('http://') || l.startsWith('https://')) {
        try { l = new URL(l).pathname.toLowerCase(); } catch { /* ignore */ }
    }
    if (/^\/(api|auth|otp|appointment|slot|queue|user|profile|invoice|payment|file|forgot-password|verify|login)\b/.test(l)) return true;
    if (/\/(api|auth|otp|appointment|slot|queue|invoice|payment|verify|login)\b/.test(l)) return true;
    if (/\$\{[^}]+\}/.test(s)) return true;
    return false;
}

function extractObjectKeysFromText(txt) {
    const s = String(txt || '');
    if (!s) return [];
    const m = s.match(/\{([^{}]{1,900})\}/);
    if (!m) return [];
    const body = m[1];
    const keys = [];
    const parts = body.split(',');
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i].trim();
        const km = p.match(/["'`]?(?:[A-Za-z_$][A-Za-z0-9_$-]*)["'`]?\s*:/);
        if (!km) continue;
        const key = km[0].replace(/[:\s"'`]/g, '');
        if (key && key.length < 60 && keys.indexOf(key) === -1) keys.push(key);
    }
    return keys.slice(0, 20);
}

/**
 * @param {{
 *   pageUrl?: string,
 *   statusHint?: string,
 *   inlineScripts?: string[],
 *   externalScripts?: { url: string, body: string, statusCode: number, error?: string }[],
 *   perfNames?: string[],
 *   startedAt?: number
 * }} opts
 */
function buildEndpointReport(opts) {
    const started = opts.startedAt != null ? opts.startedAt : Date.now();
    const inlineScripts = opts.inlineScripts || [];
    const externalScripts = opts.externalScripts || [];
    const perfNames = opts.perfNames || [];

    const r = {
        pageUrl: opts.pageUrl || '',
        statusHint: opts.statusHint || 'ok',
        scriptUrls: externalScripts.map(x => x.url),
        scannedScripts: [],
        endpoints: [],
        endpointsDetailed: [],
        categoryCounts: {},
        durationMs: 0,
    };

    const endpointSet = new Set();
    const endpointSources = {};
    const endpointHits = {};
    const endpointMeta = {};

    function addEndpoint(ep, source, line, preview) {
        if (!ep) return;
        endpointSet.add(ep);
        if (!endpointSources[ep]) endpointSources[ep] = new Set();
        if (source) endpointSources[ep].add(source);
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        if (!endpointHits[ep]) endpointHits[ep] = [];
        if (source || line || preview) {
            const key = `${source || ''}|${line || 0}|${preview || ''}`;
            const exists = endpointHits[ep].some(h =>
                `${h.source || ''}|${h.line || 0}|${h.preview || ''}` === key
            );
            if (!exists) {
                endpointHits[ep].push({
                    source: source || '',
                    line: line || 0,
                    preview: (preview || '').slice(0, 220),
                });
            }
        }
    }

    function addMethod(ep, method) {
        if (!ep || !method) return;
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        endpointMeta[ep].methods.add(String(method).toUpperCase());
    }

    function addPayloadKeys(ep, keys) {
        if (!ep || !keys || !keys.length) return;
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        for (let i = 0; i < keys.length; i++) endpointMeta[ep].payloadKeys.add(keys[i]);
    }

    function scanCodeByLines(code, sourceLabel) {
        const lines = String(code || '').split(/\r?\n/);
        for (let li = 0; li < lines.length; li++) {
            const lineText = lines[li];
            for (let pi = 0; pi < LINE_PATTERNS.length; pi++) {
                const re = LINE_PATTERNS[pi];
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(lineText)) !== null) {
                    addEndpoint(m[1], sourceLabel, li + 1, lineText.trim());
                    if (pi <= 9) {
                        // path literal
                    } else if (pi === 10) {
                        const mm = lineText.match(/method\s*:\s*["'`]([A-Za-z]+)["'`]/i);
                        addMethod(m[1], mm ? mm[1] : 'GET');
                        const km1 = lineText.match(/body\s*:\s*JSON\.stringify\((\{[^)]*\})\)/i);
                        if (km1) addPayloadKeys(m[1], extractObjectKeysFromText(km1[1]));
                    } else if (pi === 11 || pi === 12) {
                        addMethod(m[1], 'POST');
                        const km2 = lineText.match(/post\([^,]+,\s*(\{[^)]*\})/i);
                        if (km2) addPayloadKeys(m[1], extractObjectKeysFromText(km2[1]));
                    } else if (pi === 13) {
                        addMethod(m[1], 'GET');
                    }
                }
            }
        }
    }

    function addEndpointHitFromText(ep, sourceLabel, text) {
        const src = String(sourceLabel || '');
        const t = String(text || '');
        let idx = t.indexOf(ep);
        if (idx < 0) idx = t.toLowerCase().indexOf(String(ep || '').toLowerCase());
        if (idx < 0) {
            addEndpoint(ep, src, 1, '');
            return;
        }
        const before = t.slice(0, idx);
        const line = before.split(/\r?\n/).length;
        const from = Math.max(0, idx - 90);
        const to = Math.min(t.length, idx + Math.max(40, String(ep || '').length + 90));
        const preview = t.slice(from, to).replace(/\s+/g, ' ').trim();
        addEndpoint(ep, src, line, preview);
    }

    function processOneScript(code, sourceLabel, statusCode, err) {
        const safe = code.length > MAX_SCRIPT_CHARS ? code.slice(0, MAX_SCRIPT_CHARS) : code;
        const eps = extractApiEndpoints(safe);
        for (let j = 0; j < eps.length; j++) {
            addEndpoint(eps[j], sourceLabel);
            addEndpointHitFromText(eps[j], sourceLabel, safe);
        }
        scanCodeByLines(safe, sourceLabel);
        r.scannedScripts.push({
            url: sourceLabel,
            statusCode: statusCode || 0,
            bodyLength: safe.length,
            endpointHits: eps.length,
            ...(err ? { error: err } : {}),
        });
    }

    for (let i = 0; i < inlineScripts.length; i++) {
        processOneScript(inlineScripts[i] || '', '(inline)', 200);
    }

    for (let k = 0; k < externalScripts.length; k++) {
        const ex = externalScripts[k];
        const u = ex.url || '';
        const body = ex.body || '';
        const st = ex.statusCode || 0;
        const er = ex.error;
        processOneScript(body, u, st, er);
    }

    for (let p = 0; p < perfNames.length; p++) {
        const nm = String(perfNames[p] || '');
        if (!nm) continue;
        const low = nm.toLowerCase();
        if (low.includes('/api/') || low.includes('/auth') || low.includes('/otp') || low.includes('/appointment') || low.includes('/slot')) {
            try {
                const path = new URL(nm).pathname;
                if (path) addEndpoint(path, 'performance', 1, nm);
            } catch { /* ignore */ }
        }
    }

    let rawEndpoints = Array.from(endpointSet);
    r.endpoints = rawEndpoints.filter(isLikelyApiEndpoint).sort();
    if (!r.endpoints.length && rawEndpoints.length) {
        r.endpoints = rawEndpoints.filter(ep => {
            const s = String(ep || '').toLowerCase();
            if (!s) return false;
            if (s.startsWith('/assets/') || s.startsWith('/cdn-cgi/')) return false;
            if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|map|woff2?|ttf|eot)(\?|$)/i.test(s)) return false;
            return s.includes('/') || s.includes('http://') || s.includes('https://');
        }).sort();
    }

    r.endpointsDetailed = r.endpoints.map(ep => {
        const srcs = endpointSources[ep] ? Array.from(endpointSources[ep]) : [];
        const hits = endpointHits[ep] ? endpointHits[ep].slice(0, 5) : [];
        const methods = endpointMeta[ep] ? Array.from(endpointMeta[ep].methods) : [];
        const payloadKeys = endpointMeta[ep] ? Array.from(endpointMeta[ep].payloadKeys) : [];
        return { path: ep, sources: srcs, hits, methods, payloadKeys };
    });

    for (let q = 0; q < r.endpoints.length; q++) {
        const cat = classifyEndpoint(r.endpoints[q]);
        r.categoryCounts[cat] = (r.categoryCounts[cat] || 0) + 1;
    }

    r.durationMs = Date.now() - started;
    return r;
}

module.exports = {
    extractApiEndpoints,
    classifyEndpoint,
    isLikelyApiEndpoint,
    buildEndpointReport,
    MAX_SCRIPT_CHARS,
};
