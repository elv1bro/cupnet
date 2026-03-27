'use strict';
/**
 * Скриншоты активной вкладки: rate limit, дедуп буфера, запись в БД, IPC в log viewer.
 */
function createScreenshotService({
    path,
    cupnetRoot,
    getTabManager,
    getIsWindowActive,
    getLastPointerByTabId,
    getIsLoggingEnabled,
    getCurrentSessionId,
    getDb,
    incrementLogEntryCount,
    broadcastLogEntryToViewers,
    getMainWindow,
    getTrackingSettings,
}) {
    let lastScreenshotBuffer = null;
    const screenshotCooldownByReason = new Map();
    let screenshotLimiterWindow = [];

    function isScreenshotReasonEnabled(reason, tracking) {
        switch (reason) {
            case 'click': return !!tracking.onUserClick;
            case 'page-load': return !!tracking.onPageLoadComplete;
            case 'network-pending': return !!tracking.onNetworkPendingChange;
            case 'mouse-activity': return !!tracking.onMouseActivity;
            case 'typing-end': return tracking.onTypingEnd !== false;
            case 'scroll-end': return !!tracking.onScrollEnd;
            case 'rule': return !!tracking.onRuleMatchScreenshot;
            default: return true;
        }
    }

    async function captureScreenshot(opts = {}) {
        try {
            const reasonRaw = typeof opts.reason === 'string' ? opts.reason : 'manual';
            const reason = reasonRaw.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'manual';
            const screenshotMeta = (opts.meta && typeof opts.meta === 'object') ? { ...opts.meta } : {};
            screenshotMeta.trigger = reason;

            if (!getIsWindowActive()) return { success: false, skipped: true, reason: 'inactive' };

            const tabManager = typeof getTabManager === 'function' ? getTabManager() : null;
            const activeTab = tabManager ? tabManager.getActiveTab() : null;
            if (!activeTab || activeTab.view.webContents.isDestroyed()) throw new Error('No active tab');
            const wc = activeTab.view.webContents;
            const lastPointer = typeof getLastPointerByTabId === 'function' ? getLastPointerByTabId() : null;

            if (reason === 'click' && !screenshotMeta.click && lastPointer) {
                const p = lastPointer.get(activeTab.id);
                if (p && Number.isFinite(p.xNorm) && Number.isFinite(p.yNorm) && (Date.now() - (p.ts || 0) < 15000)) {
                    screenshotMeta.click = {
                        xNorm: Math.max(0, Math.min(1, Number(p.xNorm))),
                        yNorm: Math.max(0, Math.min(1, Number(p.yNorm))),
                        ts: Number(p.ts) || Date.now(),
                    };
                }
            }

            const currentUrl = wc.getURL() || '';
            const newTabPath = path.join(cupnetRoot, 'new-tab.html').replace(/\\/g, '/');
            if (!currentUrl || currentUrl.startsWith('file://') && (
                currentUrl.includes('new-tab.html') || currentUrl === `file://${newTabPath}`
            )) {
                return { success: false, skipped: true, reason: 'home' };
            }

            const image = await wc.capturePage();
            const buffer = image.toPNG();

            if (lastScreenshotBuffer && buffer.equals(lastScreenshotBuffer)) {
                return { success: false, skipped: true, reason: 'duplicate' };
            }
            lastScreenshotBuffer = buffer;

            const isLoggingEnabled = typeof getIsLoggingEnabled === 'function' ? getIsLoggingEnabled() : false;
            const currentSessionId = typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : null;
            const db = typeof getDb === 'function' ? getDb() : null;

            if (isLoggingEnabled && currentSessionId && db) {
                const now = new Date();
                const ts = now.toTimeString().split(' ')[0].replace(/:/g, '-');
                const ms = now.getMilliseconds().toString().padStart(3, '0');
                const virtualPath = `autoscreen::/${reason}/${ts}.${ms}.png`;
                screenshotMeta.pageUrl = currentUrl;
                screenshotMeta.virtualPath = virtualPath;
                const b64 = buffer.toString('base64');
                const ssId = await db.insertScreenshotAsync(currentSessionId, activeTab.id, currentUrl, b64, screenshotMeta);
                if (typeof incrementLogEntryCount === 'function') incrementLogEntryCount();
                const entry = {
                    type: 'screenshot',
                    timestamp: Date.now(),
                    path: virtualPath,
                    url: currentUrl,
                    ssDbId: ssId,
                    tabId: activeTab.id,
                    session_id: currentSessionId,
                    created_at: now.toISOString(),
                    screenshotMeta,
                };
                broadcastLogEntryToViewers(entry);
            }
            const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('screenshot-taken');
            }
            return { success: true };
        } catch (err) {
            console.error('[Screenshot]', err.message);
            return { success: false, error: err.message };
        }
    }

    async function requestScreenshot({ reason = 'manual', force = false, meta = null, skipRateLimit = false } = {}) {
        const now = Date.now();
        const tracking = typeof getTrackingSettings === 'function' ? getTrackingSettings() : {};
        if (!force && !isScreenshotReasonEnabled(reason, tracking)) {
            return { success: false, skipped: true, reason: 'trigger_disabled' };
        }

        const key = String(reason || 'manual');
        const lastByReason = screenshotCooldownByReason.get(key) || 0;
        if (!force && !skipRateLimit && now - lastByReason < tracking.cooldownMs) {
            return { success: false, skipped: true, reason: 'cooldown' };
        }
        if (!skipRateLimit) screenshotCooldownByReason.set(key, now);

        if (!skipRateLimit) {
            screenshotLimiterWindow = screenshotLimiterWindow.filter(ts => now - ts < 60_000);
            if (!force && screenshotLimiterWindow.length >= tracking.maxPerMinute) {
                return { success: false, skipped: true, reason: 'rate_limit' };
            }
        }

        const res = await captureScreenshot({ reason, meta });
        if (res?.success && !skipRateLimit) screenshotLimiterWindow.push(now);
        return res;
    }

    return {
        captureScreenshot,
        requestScreenshot,
        isScreenshotReasonEnabled,
    };
}

module.exports = { createScreenshotService };
