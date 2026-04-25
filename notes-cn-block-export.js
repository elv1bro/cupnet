'use strict';

/**
 * CupNet Notes — plain-text/markdown export functions for custom blocks.
 * Shared between main process (Turndown rule) and renderer.
 */

function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
}

function formatHeaders(h) {
    if (!h) return '';
    if (typeof h === 'string') return h;
    if (Array.isArray(h)) {
        return h.map((x) => {
            if (typeof x === 'string') return x;
            if (x && x.name != null) return x.name + ': ' + (x.value ?? '');
            return String(x);
        }).join('\n');
    }
    if (typeof h === 'object') {
        return Object.entries(h).map(([k, v]) => k + ': ' + v).join('\n');
    }
    return String(h);
}

/* ── kind exporters ────────────────────────────────────────────────────── */

const exporters = {};

exporters.demo = function exportDemo(p) {
    return '=CHIP=====\n'
        + 'caption: ' + (p.caption || '') + '\n'
        + 'secret: ' + (p.secret || '') + '\n'
        + '=CHIP=====';
};

exporters.request = function exportRequest(p) {
    const lines = [
        '=REQ=====',
        (p.method || 'GET') + ' ' + (p.url || ''),
    ];
    if (p.status != null) lines.push('Status: ' + p.status + (p.statusText ? ' ' + p.statusText : ''));
    if (p.mimeType) lines.push('Content-Type: ' + p.mimeType);
    if (p.responseSize != null) lines.push('Size: ' + fmtBytes(p.responseSize));
    if (p.timing) lines.push('Timing: ' + p.timing + ' ms');
    if (p.protocol) lines.push('Protocol: ' + p.protocol);
    if (p.tlsVersion) lines.push('TLS: ' + p.tlsVersion);
    if (p.requestId != null) lines.push('Request-ID: ' + p.requestId);
    if (p.sessionId != null) lines.push('Session-ID: ' + p.sessionId);
    if (p.requestHeaders) {
        lines.push('');
        lines.push('[Request Headers]');
        lines.push(formatHeaders(p.requestHeaders));
    }
    if (p.responseHeaders) {
        lines.push('');
        lines.push('[Response Headers]');
        lines.push(formatHeaders(p.responseHeaders));
    }
    if (p.requestBody) {
        lines.push('');
        lines.push('[Request Body]');
        lines.push(p.requestBody);
    }
    if (p.responseBody) {
        lines.push('');
        lines.push('[Response Body]');
        lines.push(p.responseBody);
    }
    lines.push('=REQ=====');
    return lines.join('\n');
};

/* ── main entry ────────────────────────────────────────────────────────── */

function cnBlockExportText(payload) {
    if (!payload || !payload.kind) return '';
    const fn = exporters[payload.kind];
    if (fn) return fn(payload);
    return '=BLOCK(' + payload.kind + ')===\n' + JSON.stringify(payload, null, 2) + '\n=BLOCK===';
}

module.exports = { cnBlockExportText, exporters, formatHeaders, fmtBytes };
