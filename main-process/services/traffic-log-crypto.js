'use strict';

const vaultSession = require('./vault-session-service.js');
const settingsStore = require('./settings-store.js');
const {
    encryptCredentialFieldWithKey,
    decryptCredentialFieldWithKey,
} = require('../../credentials-crypto.js');
const { redactHeaders, redactBody } = require('../../bundle-utils.js');

function _trafficMode() {
    try {
        const s = settingsStore.getCached() || settingsStore.loadSettings();
        const mode = String(s?.trafficLogEncryption || 'encrypt').toLowerCase();
        if (mode === 'off' || mode === 'redact' || mode === 'encrypt') return mode;
        return 'encrypt';
    } catch {
        return 'encrypt';
    }
}

function _rawMode() {
    try {
        const s = settingsStore.getCached() || settingsStore.loadSettings();
        return !!s?.trafficLogRawMode;
    } catch {
        return false;
    }
}

function _encText(text, key) {
    if (text == null || text === '') return { plain: null, enc: null, encrypted: false };
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    if (!key) return { plain: str, enc: null, encrypted: false };
    return { plain: null, enc: encryptCredentialFieldWithKey(str, key), encrypted: true };
}

function _decText(plain, enc, key) {
    if (plain != null && plain !== '') return plain;
    if (!enc || !Buffer.isBuffer(enc) || !key) return plain ?? null;
    try {
        return decryptCredentialFieldWithKey(enc, key);
    } catch {
        return null;
    }
}

function prepareRequestLogFields(entry) {
    const mode = _trafficMode();
    const raw = _rawMode();
    const key = vaultSession.getMasterKey();
    const report = { redactedFieldsCount: 0, fields: [] };
    let reqHeaders = entry.requestHeaders ?? entry.request_headers ?? null;
    let resHeaders = entry.responseHeaders ?? entry.response_headers ?? null;
    let reqBody = entry.requestBody ?? entry.request_body ?? null;
    let resBody = entry.responseBody ?? entry.response_body ?? null;

    if (typeof reqHeaders === 'string') {
        try { reqHeaders = JSON.parse(reqHeaders); } catch { /* keep string */ }
    }
    if (typeof resHeaders === 'string') {
        try { resHeaders = JSON.parse(resHeaders); } catch { /* keep string */ }
    }

    // Fail closed: if encryption is requested but the vault is locked (no key), we cannot
    // encrypt — fall back to redaction so sensitive headers/bodies never hit disk in plaintext.
    const encryptButLocked = mode === 'encrypt' && !key;
    if (!raw && (mode === 'redact' || encryptButLocked)) {
        const level = 'Balanced';
        if (reqHeaders && typeof reqHeaders === 'object') {
            reqHeaders = redactHeaders(reqHeaders, level, report, 'request_headers');
        }
        if (resHeaders && typeof resHeaders === 'object') {
            resHeaders = redactHeaders(resHeaders, level, report, 'response_headers');
        }
        reqBody = redactBody(reqBody, level, report, 'request_body');
        resBody = redactBody(resBody, level, report, 'response_body');
    }

    const stringifyHeaders = (h) => (h == null ? null : (typeof h === 'string' ? h : JSON.stringify(h)));

    if (mode === 'encrypt' && key && !raw) {
        const rh = _encText(stringifyHeaders(reqHeaders), key);
        const rs = _encText(stringifyHeaders(resHeaders), key);
        const rb = _encText(reqBody, key);
        const sb = _encText(resBody, key);
        return {
            request_headers: rh.plain,
            response_headers: rs.plain,
            request_body: rb.plain,
            response_body: sb.plain,
            request_headers_enc: rh.enc,
            response_headers_enc: rs.enc,
            request_body_enc: rb.enc,
            response_body_enc: sb.enc,
            log_encrypted: rh.encrypted || rs.encrypted || rb.encrypted || sb.encrypted ? 1 : 0,
        };
    }

    return {
        request_headers: stringifyHeaders(reqHeaders),
        response_headers: stringifyHeaders(resHeaders),
        request_body: reqBody != null ? String(reqBody) : null,
        response_body: resBody != null ? String(resBody) : null,
        request_headers_enc: null,
        response_headers_enc: null,
        request_body_enc: null,
        response_body_enc: null,
        log_encrypted: 0,
    };
}

function hydrateRequestLogRow(row) {
    if (!row || !row.log_encrypted) return row;
    const key = vaultSession.getMasterKey();
    if (!key) return { ...row, _locked: true };
    const out = { ...row };
    out.request_headers = _decText(row.request_headers, row.request_headers_enc, key)
        ?? row.request_headers;
    out.response_headers = _decText(row.response_headers, row.response_headers_enc, key)
        ?? row.response_headers;
    out.request_body = _decText(row.request_body, row.request_body_enc, key)
        ?? row.request_body;
    out.response_body = _decText(row.response_body, row.response_body_enc, key)
        ?? row.response_body;
    if (out.request_headers && typeof out.request_headers === 'string' && out.request_headers.startsWith('{')) {
        try { out.request_headers = JSON.parse(out.request_headers); } catch { /* keep */ }
    }
    if (out.response_headers && typeof out.response_headers === 'string' && out.response_headers.startsWith('{')) {
        try { out.response_headers = JSON.parse(out.response_headers); } catch { /* keep */ }
    }
    return out;
}

module.exports = {
    prepareRequestLogFields,
    hydrateRequestLogRow,
};
