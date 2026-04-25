'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'window-state.json';

function _filePath(app) {
    return path.join(app.getPath('userData'), FILE);
}

function loadAll(app) {
    try {
        const raw = fs.readFileSync(_filePath(app), 'utf8');
        const o = JSON.parse(raw);
        return typeof o === 'object' && o ? o : {};
    } catch {
        return {};
    }
}

function saveAll(app, data) {
    try {
        fs.writeFileSync(_filePath(app), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.warn('[window-state] save failed:', e?.message || e);
    }
}

/**
 * @param {string} key
 * @param {import('electron').App} app
 * @param {object} defaults — { width, height, minWidth?, minHeight? }
 */
function getWindowBounds(key, app, defaults = {}) {
    const all = loadAll(app);
    const b = all[key];
    if (!b || typeof b !== 'object') return { ...defaults };
    return {
        ...defaults,
        x: Number.isFinite(b.x) ? b.x : defaults.x,
        y: Number.isFinite(b.y) ? b.y : defaults.y,
        width: Number.isFinite(b.width) && b.width > 0 ? b.width : defaults.width,
        height: Number.isFinite(b.height) && b.height > 0 ? b.height : defaults.height,
        isMaximized: typeof b.isMaximized === 'boolean' ? b.isMaximized : !!defaults.isMaximized,
    };
}

/**
 * @param {string} key
 * @param {import('electron').App} app
 * @param {import('electron').BrowserWindow} win
 */
function saveWindowBounds(key, app, win) {
    if (!win || win.isDestroyed()) return;
    try {
        const all = loadAll(app);
        const bounds = win.getBounds();
        all[key] = {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            isMaximized: win.isMaximized(),
        };
        saveAll(app, all);
    } catch (e) {
        console.warn('[window-state] saveWindowBounds failed:', e?.message || e);
    }
}

/**
 * Clamp window position/size to visible area (best-effort).
 */
function sanitizeBounds(bounds, display) {
    const w = bounds.width || 800;
    const h = bounds.height || 600;
    let x = bounds.x;
    let y = bounds.y;
    const dw = display?.bounds?.width || 1920;
    const dh = display?.bounds?.height || 1080;
    const dx = display?.bounds?.x || 0;
    const dy = display?.bounds?.y || 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { x: dx + 40, y: dy + 40, width: w, height: h };
    }
    if (x + w < dx + 20 || x > dx + dw - 20 || y + h < dy + 20 || y > dy + dh - 20) {
        return { x: dx + 40, y: dy + 40, width: w, height: h };
    }
    return { x, y, width: w, height: h };
}

module.exports = {
    getWindowBounds,
    saveWindowBounds,
    sanitizeBounds,
};
