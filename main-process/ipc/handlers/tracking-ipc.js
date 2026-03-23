'use strict';

/**
 * Mouse / pointer / click / typing / scroll → renderer.
 * @param {object} ctx
 */
function registerTrackingIpc(ctx) {
    // ── Mouse activity ───────────────────────────────────────────────────────
    ctx.ipcMain.on('report-mouse-activity', () => { ctx.lastMouseMoveTime = Date.now(); });
    ctx.ipcMain.on('report-tab-pointer', (event, payload) => {
        try {
            const tabId = ctx._wcIdToTabId.get(event.sender.id);
            if (!tabId || !payload || typeof payload !== 'object') return;
            const xNorm = Number(payload.xNorm);
            const yNorm = Number(payload.yNorm);
            if (!Number.isFinite(xNorm) || !Number.isFinite(yNorm)) return;
            ctx._lastPointerByTabId.set(tabId, {
                xNorm: Math.max(0, Math.min(1, xNorm)),
                yNorm: Math.max(0, Math.min(1, yNorm)),
                ts: Number(payload.ts) || Date.now(),
            });
        } catch (err) {
            ctx.safeCatch({ module: 'main', eventCode: 'tracking.payload.invalid', context: { event: 'report-tab-pointer' } }, err, 'info');
        }
    });
    ctx.ipcMain.on('report-tab-click', (event, payload) => {
        try {
            const tabId = ctx._wcIdToTabId.get(event.sender.id);
            if (!tabId || !payload || typeof payload !== 'object') return;
            if (!ctx.tabManager || ctx.tabManager.getActiveTabId() !== tabId) return;
            const xNorm = Number(payload.xNorm);
            const yNorm = Number(payload.yNorm);
            if (!Number.isFinite(xNorm) || !Number.isFinite(yNorm)) return;
            const click = {
                xNorm: Math.max(0, Math.min(1, xNorm)),
                yNorm: Math.max(0, Math.min(1, yNorm)),
                ts: Number(payload.ts) || Date.now(),
            };
            ctx._lastPointerByTabId.set(tabId, click);
            ctx.requestScreenshot({
                reason: 'click',
                skipRateLimit: true,
                meta: {
                    tabId,
                    click,
                    button: Number.isFinite(Number(payload.button)) ? Number(payload.button) : 0,
                },
            }).catch((err) => {
                ctx.safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'click', tabId } }, err, 'info');
            });
        } catch (err) {
            ctx.safeCatch({ module: 'main', eventCode: 'tracking.payload.invalid', context: { event: 'report-tab-click' } }, err, 'info');
        }
    });
    ctx.ipcMain.on('report-tab-typing-end', (event, payload) => {
        try {
            const tabId = ctx._wcIdToTabId.get(event.sender.id);
            if (!tabId || !payload || typeof payload !== 'object') return;
            if (!ctx.tabManager || ctx.tabManager.getActiveTabId() !== tabId) return;
            const xNorm = Number(payload.xNorm);
            const yNorm = Number(payload.yNorm);
            const click = {
                xNorm: Number.isFinite(xNorm) ? Math.max(0, Math.min(1, xNorm)) : 0.5,
                yNorm: Number.isFinite(yNorm) ? Math.max(0, Math.min(1, yNorm)) : 0.5,
                ts: Number(payload.ts) || Date.now(),
            };
            ctx._lastPointerByTabId.set(tabId, click);
            ctx.requestScreenshot({
                reason: 'typing-end',
                skipRateLimit: true,
                meta: { tabId, click },
            }).catch((err) => {
                ctx.safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'typing-end', tabId } }, err, 'info');
            });
        } catch (err) {
            ctx.safeCatch({ module: 'main', eventCode: 'tracking.payload.invalid', context: { event: 'report-tab-typing-end' } }, err, 'info');
        }
    });
    ctx.ipcMain.on('report-tab-scroll-end', (event, payload) => {
        try {
            const tabId = ctx._wcIdToTabId.get(event.sender.id);
            if (!tabId || !payload || typeof payload !== 'object') return;
            if (!ctx.tabManager || ctx.tabManager.getActiveTabId() !== tabId) return;
            const xNorm = Number(payload.xNorm);
            const yNorm = Number(payload.yNorm);
            const click = {
                xNorm: Number.isFinite(xNorm) ? Math.max(0, Math.min(1, xNorm)) : 0.5,
                yNorm: Number.isFinite(yNorm) ? Math.max(0, Math.min(1, yNorm)) : 0.5,
                ts: Number(payload.ts) || Date.now(),
            };
            ctx._lastPointerByTabId.set(tabId, click);
            ctx.requestScreenshot({
                reason: 'scroll-end',
                skipRateLimit: true,
                meta: { tabId, click },
            }).catch((err) => {
                ctx.safeCatch({ module: 'main', eventCode: 'screenshot.capture.failed', context: { reason: 'scroll-end', tabId } }, err, 'info');
            });
        } catch (err) {
            ctx.safeCatch({ module: 'main', eventCode: 'tracking.payload.invalid', context: { event: 'report-tab-scroll-end' } }, err, 'info');
        }
    });
}

module.exports = { registerTrackingIpc };
