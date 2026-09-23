'use strict';

const PROFILE_AVATAR_COLORS = [
    '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
    '#ec4899', '#f43f5e', '#ef4444', '#f59e0b',
    '#22c55e', '#14b8a6', '#06b6d4', '#64748b',
];

/** 1–2 letter initials for profile avatar badges. */
function profileInitials(name) {
    const raw = String(name || '').trim();
    if (!raw) return '?';
    const parts = raw.split(/[\s·\-_]+/).filter(Boolean);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    if (raw.length >= 2) return raw.slice(0, 2).toUpperCase();
    return raw[0].toUpperCase();
}

function normalizeAvatarColor(color) {
    const c = String(color || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
    return '#3b82f6';
}

/** Stable accent color from display name (when user has not picked one). */
function defaultColorForName(name) {
    const s = String(name || '').trim().toLowerCase();
    if (!s) return PROFILE_AVATAR_COLORS[0];
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return PROFILE_AVATAR_COLORS[h % PROFILE_AVATAR_COLORS.length];
}

module.exports = {
    PROFILE_AVATAR_COLORS,
    profileInitials,
    normalizeAvatarColor,
    defaultColorForName,
};
