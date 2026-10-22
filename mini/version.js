'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CupNet mini — release identity.
//
// Single source of truth for the version string. It is surfaced in the /api/status
// payload (shown in the sidebar and on the Guide page), and stamped into HAR exports.
// Bump VERSION and RELEASED together when cutting a release.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  NAME: 'CupNet mini',
  VERSION: '0.1',
  RELEASED: '2026-10-22', // ISO date of this version
};
