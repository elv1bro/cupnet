#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const AzureTLSClient = require('../azuretls/azureTLS.js');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
        args[key] = val;
    }
    return args;
}

const args = parseArgs(process.argv);
const TARGET_URL = args.url || 'https://appointment.ivacbd.com/';
const TARGET_BASE = new URL(TARGET_URL).origin;
const DUMP_DIR = path.resolve(args.dump || path.join(__dirname, '..', '_debug'));
const TLS_PROFILE = args.browser || 'chrome';
const PROXY = args.proxy || process.env.IVAC_PROXY || process.env.HTTP_PROXY || '';

const CHROME_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
};

function ensureDumpDir() {
    if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

function writeText(name, content) {
    ensureDumpDir();
    fs.writeFileSync(path.join(DUMP_DIR, name), content, 'utf8');
}

function bodyToString(resp) {
    if (resp.body) return resp.body;
    if (resp.bodyBase64) {
        try { return Buffer.from(resp.bodyBase64, 'base64').toString('utf8'); } catch {}
    }
    return '';
}

function log(msg) {
    process.stdout.write(String(msg) + '\n');
}

function extractJsUrls(html) {
    const out = new Set();
    const srcMatches = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)];
    for (const m of srcMatches) out.add(m[1]);
    return [...out];
}

function extractApiEndpoints(jsCode) {
    const patterns = [
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
    const found = new Set();
    for (const p of patterns) {
        for (const m of jsCode.matchAll(p)) found.add(m[1]);
    }
    return [...found].sort();
}

function absolutize(base, maybeRel) {
    try { return new URL(maybeRel, base).toString(); } catch { return null; }
}

function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    return [v];
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

async function main() {
    ensureDumpDir();
    log(`[debug-ivac] target=${TARGET_URL}`);
    log(`[debug-ivac] base=${TARGET_BASE}`);
    log(`[debug-ivac] dump=${DUMP_DIR}`);
    log(`[debug-ivac] tls=${TLS_PROFILE}`);
    log(`[debug-ivac] proxy=${PROXY ? '(set)' : '(none)'}`);

    const client = new AzureTLSClient({
        browser: TLS_PROFILE,
        proxy: PROXY || null,
        timeout: 30000,
    });
    const startedAt = Date.now();
    const summary = {
        targetUrl: TARGET_URL,
        targetBase: TARGET_BASE,
        tlsProfile: TLS_PROFILE,
        proxySet: !!PROXY,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: 0,
        homepage: null,
        jsBundles: [],
        endpointCount: 0,
        endpointCategoryCounts: {},
        interestingHeaders: {},
        cloudflareDetected: false,
        nextActions: [],
    };

    try {
        log('[step1] fetching homepage');
        const home = await client.get(TARGET_URL, {
            headers: CHROME_HEADERS,
            maxRetries: 1,
        });

        const homeBody = bodyToString(home);
        writeText('01_homepage.html', homeBody || '');
        writeText('01_homepage.json', JSON.stringify({
            statusCode: home.statusCode,
            url: home.url || TARGET_URL,
            headers: home.headers || {},
            error: home.error || null,
            bodyLength: homeBody.length,
        }, null, 2));

        log(`[step1] status=${home.statusCode} bodyLen=${homeBody.length}`);
        const homeHeaders = home.headers || {};
        summary.homepage = {
            statusCode: home.statusCode,
            bodyLength: homeBody.length,
            url: home.url || TARGET_URL,
        };
        summary.cloudflareDetected = homeBody.toLowerCase().includes('just a moment')
            || !!homeHeaders['Cf-Ray']
            || !!homeHeaders['cf-ray'];
        summary.interestingHeaders = {
            server: asArray(homeHeaders.Server || homeHeaders.server)[0] || '',
            cfRay: asArray(homeHeaders['Cf-Ray'] || homeHeaders['cf-ray'])[0] || '',
            contentType: asArray(homeHeaders['Content-Type'] || homeHeaders['content-type'])[0] || '',
            setCookieCount: asArray(homeHeaders['Set-Cookie'] || homeHeaders['set-cookie']).length,
        };
        if (summary.cloudflareDetected) {
            log('[warn] cloudflare challenge detected');
        }

        const jsRefs = extractJsUrls(homeBody);
        log(`[step2] js refs=${jsRefs.length}`);
        const endpoints = new Set();

        for (let i = 0; i < jsRefs.length; i++) {
            const abs = absolutize(TARGET_BASE, jsRefs[i]);
            if (!abs || !/^https?:\/\//i.test(abs)) continue;
            log(`[step3.${i + 1}] fetch ${abs}`);

            try {
                const js = await client.get(abs, {
                    headers: {
                        ...CHROME_HEADERS,
                        'Accept': '*/*',
                        'Sec-Fetch-Dest': 'script',
                        'Referer': TARGET_BASE + '/',
                    },
                    maxRetries: 1,
                });
                const jsBody = bodyToString(js);
                writeText(`02_js_${i}.js`, jsBody || '');
                log(`  status=${js.statusCode} bodyLen=${jsBody.length}`);

                const found = extractApiEndpoints(jsBody);
                for (const e of found) endpoints.add(e);
                if (found.length) log(`  endpoints+${found.length}`);
                summary.jsBundles.push({
                    index: i,
                    url: abs,
                    statusCode: js.statusCode,
                    bodyLength: jsBody.length,
                    endpointHits: found.length,
                });
            } catch (e) {
                log(`  error=${e.message}`);
                summary.jsBundles.push({
                    index: i,
                    url: abs,
                    statusCode: 0,
                    bodyLength: 0,
                    endpointHits: 0,
                    error: e.message,
                });
            }
        }

        const list = [...endpoints].sort();
        writeText('endpoints.json', JSON.stringify(list, null, 2));
        summary.endpointCount = list.length;
        const catCounts = {};
        for (const ep of list) {
            const cat = classifyEndpoint(ep);
            catCounts[cat] = (catCounts[cat] || 0) + 1;
        }
        summary.endpointCategoryCounts = catCounts;

        summary.durationMs = Date.now() - startedAt;
        if (summary.homepage.statusCode >= 400) {
            summary.nextActions.push('Попробовать другой proxy profile/ротацию IP, затем повторить scout.');
        }
        if ((catCounts.auth || 0) > 0 || (catCounts.otp || 0) > 0) {
            summary.nextActions.push('Собрать сценарий auth/otp: signin -> otp/send -> otp/verify -> profile.');
        }
        if ((catCounts.booking || 0) > 0) {
            summary.nextActions.push('Собрать flow бронирования: mission -> booking-config -> time-slot -> reserveSlot.');
        }
        if ((catCounts.payment || 0) > 0) {
            summary.nextActions.push('Проверить payment flow: initiate -> confirm-payment -> invoice/download.');
        }
        writeText('summary.json', JSON.stringify(summary, null, 2));

        log(`[summary] endpoints=${list.length}`);
        for (const e of list) log(`  ${e}`);
        log(`[summary] jsBundles=${summary.jsBundles.length} durationMs=${summary.durationMs}`);
    } finally {
        try { client.close(); } catch {}
    }
}

main().catch((e) => {
    process.stderr.write(`[debug-ivac] fatal: ${e.message}\n`);
    process.exit(1);
});
