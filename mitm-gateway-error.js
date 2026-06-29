'use strict';

/**
 * Human-readable MITM 502 gateway error pages and short summaries for the shell UI.
 */

function _escHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {{ method?: string, headers?: Record<string, string>, path?: string }} req
 * @returns {boolean}
 */
function isLikelyDocumentNavigation(req) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const accept = String(req?.headers?.accept || req?.headers?.Accept || '').toLowerCase();
    if (accept.includes('text/html')) return true;
    const path = String(req?.path || '/').split('?')[0];
    return !/\.[a-z0-9]{2,8}$/i.test(path);
}

function _isLoopbackIp(ip) {
    const v = String(ip || '').trim().toLowerCase();
    return v === '127.0.0.1' || v === '::1' || v === 'localhost';
}

/** @param {string} hostname */
function _hostsFileMapsHostnameToLoopback(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host) return false;
    try {
        const fs = require('fs');
        const text = fs.readFileSync('/etc/hosts', 'utf8');
        for (const rawLine of text.split('\n')) {
            let line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const hash = line.indexOf('#');
            if (hash >= 0) line = line.slice(0, hash).trim();
            const parts = line.split(/\s+/).filter(Boolean);
            if (parts.length < 2) continue;
            const ip = parts[0].toLowerCase();
            if (!_isLoopbackIp(ip)) continue;
            for (let i = 1; i < parts.length; i++) {
                if (parts[i].toLowerCase() === host) return true;
            }
        }
    } catch {
        /* ignore — no permission or non-Unix */
    }
    return false;
}

function _dialTargetIp(errorMessage) {
    const msg = String(errorMessage || '');
    let m = msg.match(/dial tcp 127\.0\.0\.1:(\d+)/i);
    if (m) return { ip: '127.0.0.1', port: m[1] };
    m = msg.match(/dial tcp \[::1\]:(\d+)/i);
    if (m) return { ip: '::1', port: m[1] };
    m = msg.match(/dial tcp ([0-9.]+):(\d+)/i);
    if (m) return { ip: m[1], port: m[2] };
    return null;
}

/**
 * Resolve DNS override metadata for gateway errors (explicit MITM rule or inferred from dial target).
 * @param {{ url?: string, errorMessage?: string, dnsOverride?: { host?: string, ip?: string, rewriteHost?: string, inferred?: boolean } | null }} ctx
 * @returns {{ host?: string, ip?: string, rewriteHost?: string, inferred?: boolean } | null}
 */
function resolveMitmGatewayDnsContext(ctx) {
    const dns = ctx?.dnsOverride;
    if (dns?.host && dns?.ip) return dns;

    const msg = String(ctx?.errorMessage || '');
    const dial = _dialTargetIp(msg);
    if (!dial || !_isLoopbackIp(dial.ip)) return dns || null;

    let host = '';
    try {
        host = new URL(String(ctx?.url || '')).hostname.toLowerCase();
    } catch {
        host = '';
    }
    if (!host || _isLoopbackIp(host)) return dns || null;

    return {
        host,
        ip: dial.ip,
        inferred: true,
        fromEtcHosts: _hostsFileMapsHostnameToLoopback(host),
    };
}

/**
 * @param {{ url?: string, errorMessage?: string, dnsOverride?: { host?: string, ip?: string, rewriteHost?: string, inferred?: boolean } | null }} ctx
 * @returns {string}
 */
function summarizeMitmGatewayError(ctx) {
    const msg = String(ctx?.errorMessage || 'Upstream connection failed');
    const dns = resolveMitmGatewayDnsContext(ctx);
    if (dns?.host && dns?.ip) {
        const refused = /ECONNREFUSED|connection refused/i.test(msg);
        const targetsLoopback = _isLoopbackIp(dns.ip);
        const prefix = dns.inferred ? 'Traffic routed to localhost' : 'DNS override';
        if (refused && targetsLoopback) {
            return `${prefix}: ${dns.host} → ${dns.ip} — nothing listening (connection refused)`;
        }
        return `${prefix}: ${dns.host} → ${dns.ip}: ${msg}`;
    }
    if (/ECONNREFUSED|connection refused/i.test(msg)) {
        return `Connection refused — server not reachable`;
    }
    if (/ETIMEDOUT|timeout/i.test(msg)) {
        return `Connection timed out`;
    }
    if (/ENOTFOUND|no such host/i.test(msg)) {
        return `Host not found (DNS)`;
    }
    try {
        const u = new URL(String(ctx?.url || ''));
        return `${u.hostname}: ${msg}`;
    } catch {
        return msg;
    }
}

/**
 * @param {{ url?: string, errorMessage?: string, dnsOverride?: { host?: string, ip?: string, rewriteHost?: string } | null }} ctx
 * @returns {{ statusCode: number, headers: Record<string, string>, bodyBase64: string }}
 */
function buildMitmGatewayErrorResponse(ctx) {
    const url = String(ctx?.url || '');
    const errorMessage = String(ctx?.errorMessage || 'Upstream connection failed');
    const dns = resolveMitmGatewayDnsContext(ctx);
    const summary = summarizeMitmGatewayError({ url, errorMessage, dnsOverride: dns });
    const dial = _dialTargetIp(errorMessage);

    let hint = 'Check your proxy profile, upstream connectivity, and DNS Overrides in the DNS Manager toolbar button.';
    if (dns?.host && dns?.ip) {
        const refused = /ECONNREFUSED|connection refused/i.test(errorMessage);
        const loopback = _isLoopbackIp(dns.ip);
        const portNote = dial?.port && dial.port !== '443'
            ? ` Port <strong>${_escHtml(dial.port)}</strong> on localhost is not open.`
            : (refused && loopback ? ' Nothing is accepting HTTPS on port <strong>443</strong> on localhost.' : '');
        if (refused && loopback) {
            if (dns.fromEtcHosts) {
                hint = `Your system <strong>/etc/hosts</strong> maps <strong>${_escHtml(dns.host)}</strong> to `
                    + `<strong>${_escHtml(dns.ip)}</strong>.${portNote} `
                    + `CupNet DNS Manager rules are not required for this — edit <code>/etc/hosts</code> `
                    + `(comment out that line) so the domain resolves to the real origin server again. `
                    + `This entry is often left from local mock / dev setup.`;
            } else if (dns.inferred) {
                hint = `CupNet tried to reach the real server for <strong>${_escHtml(dns.host)}</strong>, `
                    + `but the connection went to <strong>${_escHtml(dns.ip)}</strong> instead.${portNote} `
                    + `This is almost always a <strong>DNS Override</strong> in CupNet (toolbar → <strong>DNS</strong>) `
                    + `or an entry in your system <code>/etc/hosts</code> pointing this domain to localhost. `
                    + `Disable that rule to load the live site.`;
            } else {
                hint = `DNS Override maps <strong>${_escHtml(dns.host)}</strong> to <strong>${_escHtml(dns.ip)}</strong>, `
                    + `but nothing is accepting HTTPS there.${portNote} `
                    + `Open toolbar → <strong>DNS</strong> and disable or fix this rule, `
                    + `or start the local mock service if you intentionally redirect to localhost.`;
            }
        } else {
            hint = `DNS Override maps <strong>${_escHtml(dns.host)}</strong> → <strong>${_escHtml(dns.ip)}</strong>. `
                + `Verify the target IP is correct and reachable from this machine.`;
        }
    } else if (/ECONNREFUSED|connection refused/i.test(errorMessage)) {
        hint = 'The upstream server refused the connection. If you use a proxy, check that it is running and the profile is valid.';
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CupNet — page failed to load</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 32px 20px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #e6edf3;
    display: flex; align-items: flex-start; justify-content: center;
  }
  .card {
    max-width: 640px; width: 100%;
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 24px 26px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
  }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #f85149; }
  .summary { margin: 0 0 16px; color: #8b949e; }
  .url {
    word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; padding: 10px 12px; margin-bottom: 16px; color: #58a6ff;
  }
  .detail {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; background: #21262d; border-radius: 6px;
    padding: 10px 12px; margin-bottom: 16px; color: #f0f6fc;
    white-space: pre-wrap; word-break: break-word;
  }
  .hint { margin: 0; color: #c9d1d9; line-height: 1.55; }
  .hint strong { color: #e6edf3; }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 600;
    background: #388bfd26; color: #58a6ff; border: 1px solid #388bfd66;
    border-radius: 999px; padding: 2px 10px; margin-bottom: 12px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">CupNet MITM · 502 Bad Gateway</div>
    <h1>Page failed to load</h1>
    <p class="summary">${_escHtml(summary)}</p>
    <div class="url">${_escHtml(url)}</div>
    <div class="detail">${_escHtml(errorMessage)}</div>
    <p class="hint">${hint}</p>
  </div>
</body>
</html>`;

    return {
        statusCode: 502,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        bodyBase64: Buffer.from(html, 'utf8').toString('base64'),
    };
}

module.exports = {
    isLikelyDocumentNavigation,
    resolveMitmGatewayDnsContext,
    summarizeMitmGatewayError,
    buildMitmGatewayErrorResponse,
};
