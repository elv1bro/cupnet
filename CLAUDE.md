# CupNet 2 — agent guide

CupNet is a standalone Electron/Chromium browser for web-traffic analysis: real browser + embedded MITM proxy + Go AzureTLS fingerprint worker + SQLite logging + encrypted credentials vault + inspector windows.

**Read these first (in `docs/ai/`):**
- [`PROJECT_MAP.md`](docs/ai/PROJECT_MAP.md) — architecture, subsystems, boot/traffic flow, conventions, how to run/test.
- [`AUDIT-2026-09.md`](docs/ai/AUDIT-2026-09.md) — the tracked bug list (`A-###` ids). Update a finding's Status when you fix it and cite the id in the commit.
- [`PRODUCTION_PLAN.md`](docs/ai/PRODUCTION_PLAN.md) — ordered path to a production release (Phase 0 stabilize → security → correctness → upgrades → CI).

**Hard rules (also in `.cursor/rules/*.mdc`):**
- In `mitm` traffic mode never register `session.protocol.handle('http'|'https')` for interception — it moves traffic to the JS/fetch path, which Cloudflare/Turnstile can detect. Interception happens on the MITM path (`request-interceptor.js` `planMitmIntercept`/`finalizeMitmInterceptResponse`, called from `mitm-proxy.js`).
- Prefer implementing outbound HTTP behaviour in MITM, not in Chromium.
- All user-facing UI text, code, comments and docs in **English** — **except the `mini/` app, whose user-facing UI strings are in Russian** (labels, hints, buttons, placeholders, toasts, titles and the in-app Guide). In `mini/` everything else stays English: variable/function names, object keys, code, comments, `console.*`/logger text, API paths, CSS classes/ids, HTTP methods/headers, and tech proper nouns (CupNet, Chrome, MITM, DNS, JSON, TLS, WebSocket, HAR, curl, …).
- Add IPC via `main-process/ipc/handlers/*.js` (never `ipcMain.handle` in `cupnet-runtime.js`); privileged handlers must use the `ipc-trusted-sender.js` guard; keep `preload-view.js` (tab preload for untrusted sites) minimal.

**Baseline note:** the working tree has large uncommitted security-hardening WIP; a backup is in git ref `refs/backup/pre-claude-audit-2026-09-23`. Do not commit unless asked.

**Run / test:**
```bash
ELECTRON_RUN_AS_NODE= npm start
npm run test:unit        # Vitest (some cases need network)
npm run test:go          # Go worker
npm test                 # integration (test-db needs the Electron binary)
npm run test:e2e:smoke   # Playwright + Electron
```
