'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ERROR_PAGE_PATH = path.join(__dirname, '../../error-page.html');
const ERROR_PAGE_HREF = pathToFileURL(ERROR_PAGE_PATH).href;

// A-318: match only our own error-page file URL (optionally with a query/hash),
// not any remote URL that merely contains the substring 'error-page.html'.
// Case-insensitive so it still matches when the caller lower-cases the URL first.
function isTabErrorPageUrl(url) {
    const u = String(url || '');
    if (!/^file:/i.test(u)) return false;
    return u.split(/[?#]/)[0].toLowerCase() === ERROR_PAGE_HREF.toLowerCase();
}

function shouldSkipErrorPageForUrl(url) {
    const u = String(url || '').trim().toLowerCase();
    if (!u || u === 'about:blank') return true;
    if (isTabErrorPageUrl(u)) return true;
    if (u.startsWith('file://') && (u.includes('new-tab.html') || u.includes('settings.html') || u.includes('cupnet-guide.html'))) return true;
    if (u.startsWith('cupnet://') || u.startsWith('devtools:')) return true;
    return false;
}

function getTabDisplayUrl(tab) {
    if (tab?.displayUrlOverride) return tab.displayUrlOverride;
    const raw = tab?.url || tab?.view?.webContents?.getURL?.() || '';
    if (!raw || raw === 'about:blank') return '';
    if (raw.startsWith('file://') && raw.includes('new-tab.html')) return '';
    if (raw.startsWith('file://') && raw.includes('settings.html')) return 'cupnet://settings';
    if (raw.startsWith('file://') && raw.includes('cupnet-guide.html')) return 'cupnet://guide';
    return raw;
}

function buildTabErrorPageUrl({ url, statusCode, errorCode, errorDescription }) {
    const q = new URLSearchParams();
    if (url) q.set('url', url);
    if (statusCode != null && statusCode !== '') q.set('status', String(statusCode));
    if (errorCode != null && errorCode !== '') q.set('code', String(errorCode));
    if (errorDescription) q.set('desc', errorDescription);
    return `${pathToFileURL(ERROR_PAGE_PATH).href}?${q.toString()}`;
}

function loadTabErrorPage(webContents, tab, params) {
    if (!webContents || webContents.isDestroyed()) return false;
    const failedUrl = params?.url || tab?.lastMainFrameUrl || tab?.url || '';
    if (tab) {
        tab.displayUrlOverride = failedUrl;
        tab.isErrorPage = true;
        tab._loadingErrorPage = true;
    }
    const target = buildTabErrorPageUrl({
        url: failedUrl,
        statusCode: params?.statusCode,
        errorCode: params?.errorCode,
        errorDescription: params?.errorDescription,
    });
    webContents.loadURL(target).catch(() => {
        if (tab) tab._loadingErrorPage = false;
    });
    return true;
}

function clearTabErrorPageState(tab) {
    if (!tab) return;
    tab.displayUrlOverride = null;
    tab.isErrorPage = false;
    tab._loadingErrorPage = false;
    tab.lastMainFrameStatus = null;
    tab.lastMainFrameUrl = null;
}

function _headerVal(headers, name) {
    if (!headers) return '';
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    const v = key ? headers[key] : '';
    return Array.isArray(v) ? String(v[0] || '') : String(v || '');
}

function _cloneUploadBytes(uploadData) {
    if (!Array.isArray(uploadData)) return [];
    const out = [];
    for (const part of uploadData) {
        if (part?.bytes && Buffer.isBuffer(part.bytes)) {
            out.push(Buffer.from(part.bytes));
        }
    }
    return out;
}

/** @param {import('electron').UploadRawData[]} parts */
function buildLoadOptionsFromNavigationRetry(retry) {
    if (!retry || retry.method !== 'POST') return {};
    const opts = {};
    const chunks = Array.isArray(retry.postDataChunks) ? retry.postDataChunks : [];
    if (chunks.length) {
        opts.postData = chunks.map((bytes) => ({ type: 'rawData', bytes: Buffer.from(bytes) }));
    } else {
        opts.postData = [{ type: 'rawData', bytes: Buffer.alloc(0) }];
    }
    const lines = [];
    if (retry.contentType) lines.push(`Content-Type: ${retry.contentType}`);
    if (lines.length) opts.extraHeaders = lines.join('\r\n') + '\r\n';
    if (retry.referrer) opts.httpReferrer = retry.referrer;
    return opts;
}

function _failedNavigationTarget(tab) {
    const retry = tab?.pendingNavigationRetry;
    const fromRetry = retry?.url && !shouldSkipErrorPageForUrl(retry.url) ? retry.url : '';
    const fromOverride = tab?.displayUrlOverride && !shouldSkipErrorPageForUrl(tab.displayUrlOverride)
        ? tab.displayUrlOverride
        : '';
    const fromLast = tab?.lastMainFrameUrl && !shouldSkipErrorPageForUrl(tab.lastMainFrameUrl)
        ? tab.lastMainFrameUrl
        : '';
    return fromRetry || fromOverride || fromLast || '';
}

function isTabShowingErrorPage(tab) {
    if (!tab) return false;
    if (tab.isErrorPage) return true;
    try {
        const wc = tab.view?.webContents;
        if (wc && !wc.isDestroyed() && isTabErrorPageUrl(wc.getURL())) return true;
    } catch { /* ignore */ }
    return false;
}

/**
 * Reload the failed real URL (not error-page.html). Re-submits POST body when captured.
 * @returns {boolean} true when a failed navigation was retried
 */
function reloadFailedTabNavigation(tab) {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;

    const target = _failedNavigationTarget(tab);
    if (!target) return false;

    const retry = tab.pendingNavigationRetry;
    const loadOpts = (retry?.method === 'POST' && retry.url === target)
        ? buildLoadOptionsFromNavigationRetry(retry)
        : {};

    tab.displayUrlOverride = null;
    tab.isErrorPage = false;
    tab._loadingErrorPage = false;

    wc.loadURL(target, loadOpts).catch((err) => {
        const msg = err?.message || String(err);
        if (/\bERR_ABORTED\b|error code -3\b|aborted/i.test(msg)) return;
        console.warn(`[tab] retry failed navigation url=${target.slice(0, 120)}: ${msg}`);
    });
    return true;
}

/**
 * Toolbar / shortcut reload — retries failed navigation or falls back to webContents.reload().
 */
function reloadActiveTab(tab, { ignoreCache = false } = {}) {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;

    if (isTabShowingErrorPage(tab) || _failedNavigationTarget(tab)) {
        return reloadFailedTabNavigation(tab);
    }

    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
    return true;
}

function notePendingGetNavigation(tab, url) {
    if (!tab || shouldSkipErrorPageForUrl(url)) return;
    tab.pendingNavigationRetry = { url, method: 'GET' };
}

function attachMainFrameStatusTracker(tab) {
    if (!tab?.tabSession || !tab?.view?.webContents || tab._statusTrackerAttached) return;
    tab._statusTrackerAttached = true;
    const wcId = tab.view.webContents.id;

    try {
        tab.tabSession.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
            if (details.resourceType !== 'mainFrame') return;
            if (details.webContentsId != null && details.webContentsId !== wcId) return;
            tab.lastMainFrameStatus = details.statusCode;
            tab.lastMainFrameUrl = details.url;
        });
    } catch { /* ignore */ }

    // Do NOT register onBeforeRequest / onBeforeSendHeaders here — Electron allows only one
    // listener per session per event; tab-manager already owns those for traffic filters and
    // X-CupNet-Rid. Replacing them breaks navigation (missing requestHeaders) and MITM logging.
    // GET retry URL is captured via notePendingGetNavigation() on will-navigate.
}

function shouldShowHttpErrorPage(statusCode, url) {
    const code = Number(statusCode);
    if (!Number.isFinite(code) || code < 400) return false;
    return !shouldSkipErrorPageForUrl(url);
}

module.exports = {
    isTabErrorPageUrl,
    shouldSkipErrorPageForUrl,
    getTabDisplayUrl,
    buildTabErrorPageUrl,
    loadTabErrorPage,
    clearTabErrorPageState,
    attachMainFrameStatusTracker,
    shouldShowHttpErrorPage,
    buildLoadOptionsFromNavigationRetry,
    reloadFailedTabNavigation,
    reloadActiveTab,
    isTabShowingErrorPage,
    notePendingGetNavigation,
};
