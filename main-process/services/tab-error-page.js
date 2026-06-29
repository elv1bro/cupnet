'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ERROR_PAGE_PATH = path.join(__dirname, '../../error-page.html');

function isTabErrorPageUrl(url) {
    const u = String(url || '');
    return u.includes('error-page.html');
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
};
