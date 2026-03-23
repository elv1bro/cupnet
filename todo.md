# CupNet2 — Remaining Audit TODO

Remaining items from the deep code audit (Mar 2026).
Items marked ✅ were fixed in the first batch.

---

## 1. Critical Bugs

| # | Status | File | Issue | Risk |
|---|--------|------|-------|------|
| 1.1 | ⬜ | `mitm-proxy.js` | CA key stored in `os.tmpdir()` — shared across users, survives reboot on some OS, readable by other processes | Private key leak |
| 1.2 | ✅ | `mitm-proxy.js` | `buildHttpResponse` string concat corrupts binary bodies | Broken images/downloads |
| 1.3 | ✅ | `mitm-proxy.js` | `Buffer.concat` O(n²) + unbounded `inBuf` growth | OOM crash, CPU spike |

### 1.1 Fix plan
Generate CA into `app.getPath('userData')` with `0o600` permissions. Delete temp file on exit.

---

## 2. Security Risks

| # | Status | File | Issue | Risk |
|---|--------|------|-------|------|
| 2.1 | ⬜ | `db.js` | FTS5 `ftsSearch` — user input partially sanitized but FTS injection possible via special syntax | Data leak / crash |
| 2.2 | ⬜ | `db.js` | `updateRequest` uses template literal for column names (allowed list exists but pattern is fragile) | SQL injection if allowed list changes |
| 2.3 | ⬜ | `main.js` | `app.commandLine.appendSwitch('ignore-certificate-errors')` disables ALL TLS validation | MITM by third parties |
| 2.4 | ⬜ | `preload.js` | 30+ IPC channels exposed — some allow arbitrary session manipulation | Privilege escalation from renderer |
| 2.5 | ⬜ | `mitm-proxy.js` | `setCertificateVerifyProc(() => 0)` on all sessions — no fallback for non-MITM connections | Silent MITM acceptance |
| 2.6 | ⬜ | `request-interceptor.js` | `matchesPattern` compiles user-provided regex — no timeout/complexity limit | ReDoS |
| 2.7 | ⬜ | `db.js` | Proxy URLs encrypted with `safeStorage` but decryption key is per-OS-user, not per-app | Shared machine risk |
| 2.8 | ⬜ | `main.js` | Clipboard read/write exposed to renderer without origin check | Clipboard hijacking |

### Priority fixes:
- **2.1**: Sanitize FTS5 query — strip `NEAR`, `*`, `"` and other FTS5 operators; or use LIKE fallback.
- **2.3**: Scope `ignore-certificate-errors` only to MITM proxy connections (use `certificate-error` event with hostname filter instead of global switch).
- **2.6**: Add regex timeout via `new RegExp` in a try/catch with max pattern length limit (e.g. 500 chars).

---

## 3. Performance

| # | Status | File | Issue | Risk |
|---|--------|------|-------|------|
| 3.1 | ✅ | `request-interceptor.js` | `loadRules()` hits DB on every HTTP request | DB contention |
| 3.2 | ✅ | `har-exporter.js` | N+1 query — `getRequest(id)` called per row | Slow HAR export |
| 3.3 | ✅ | `main.js` | `loadSettings()` sync file I/O on every CDP event | Main thread blocking |
| 3.4 | ✅ | `quick-proxy-change.js` | `mousemove` fires IPC on every pixel | IPC flood |
| 3.5 | ✅ | `db.js` | Missing indexes on `ws_events.session_id`, `screenshots.session_id`, `trace_entries.session_id` | Slow queries |
| 3.6 | ✅ | `db.js` | Screenshots stored as base64 TEXT (33% larger than binary) | Wasted disk |
| 3.7 | ⬜ | `main.js` | `captureScreenshot` runs on a timer for all tabs — no check if tab is visible | Wasted CPU |
| 3.8 | ⬜ | `log-viewer-renderer.js` | Renders ALL log entries into DOM at once (no virtualization) | UI freeze on 10k+ entries |
| 3.9 | ⬜ | `main.js` | CDP `Network.getResponseBody` called synchronously per request — can block on large responses | Slow logging |

---

## 4. Reliability

| # | Status | File | Issue | Risk |
|---|--------|------|-------|------|
| 4.1 | ⬜ | `mitm-proxy.js` | Worker `stdin.write` can throw if pipe is broken — no try/catch | Unhandled exception crash |
| 4.2 | ✅ | `mitm-proxy.js` | `pending` Map grows indefinitely if worker never responds | Memory leak |
| 4.3 | ✅ | `mitm-proxy.js` | Worker restart is fixed 1s — no backoff on repeated crashes | CPU spin |
| 4.4 | ⬜ | `main.js` | `currentSessionId` race — multiple tabs can create sessions concurrently | Duplicate sessions |
| 4.5 | ✅ | `main.js` | `_seenRequestIds.clear()` drops ALL IDs — subsequent duplicates logged | Duplicate entries |
| 4.6 | ✅ | `tab-manager.js` | Misleading JSDoc on `isolateTab` (mentioned cookie copying that doesn't happen) | Developer confusion |
| 4.7 | ⬜ | `tab-manager.js` | `BrowserView` is deprecated in Electron 30+ — should migrate to `WebContentsView` | Future breakage |
| 4.8 | ⬜ | `main.js` | No graceful shutdown for MITM proxy server — connections may hang | Port stuck on restart |

---

## 5. Code Quality

| # | Status | File | Issue | Risk |
|---|--------|------|-------|------|
| 5.1 | ✅ | Multiple | 30+ silent `catch {}` blocks hiding errors | Invisible failures |
| 5.2 | ✅ | `main.js` | `ongoingWebsockets` not cleaned in stale timer | Memory leak |
| 5.3 | ✅ | `main.js` | `will-quit` handler was async but Electron doesn't await it | Cleanup not running |
| 5.4 | ✅ | Multiple | `esc()` missing quote escaping — XSS in attribute contexts | XSS in UI |
| 5.5 | ✅ | `db.js` | Prepared statements not reset on `close()` — crash if reused | Crash on DB reopen |
| 5.6 | ⬜ | `main.js` | `main.js` is 2500+ lines — should be split into modules | Hard to maintain |
| 5.7 | ⬜ | `main.js` | Event listeners registered inside `app.whenReady` — hard to test | Untestable code |
| 5.8 | ⬜ | Multiple | No TypeScript / JSDoc types — refactoring is error-prone | Regressions |
| 5.9 | ⬜ | `package.json` | No `engines` field — unclear Node.js version requirement | Version mismatch |
| 5.10 | ⬜ | Multiple | Duplicated utility functions (`esc`, `debounce`, `truncUrl`) across renderer files | Code duplication |

---

## 6. Architecture Improvements

| # | Priority | Description |
|---|----------|-------------|
| 6.1 | High | Split `main.js` into: `ipc-handlers.js`, `session-manager.js`, `screenshot-manager.js`, `cdp-logger.js` |
| 6.2 | High | Migrate from `BrowserView` to `WebContentsView` (Electron 30+) |
| 6.3 | Medium | Create shared `utils/html-escape.js` for `esc()`, `debounce()`, `truncUrl()` |
| 6.4 | Medium | Add IPC channel validation — whitelist allowed channels in preload, reject unknown |
| 6.5 | Low | Add integration tests for proxy connection / tab isolation flows |
| 6.6 | Low | Add CSP headers to all HTML pages (browser.html, proxy-manager.html, etc.) |

---

## 7. Dependency Issues

| # | Package | Issue | Action |
|---|---------|-------|--------|
| 7.1 | `proxy-chain` | Check for CVEs and update | `npm audit` |
| 7.2 | `better-sqlite3` | Ensure native build matches Electron version | Rebuild on Electron upgrade |
| 7.3 | `electron` | Current version may have known CVEs | Update to latest stable |
| 7.4 | All | No `package-lock.json` / `pnpm-lock.yaml` in git | Add lockfile |

---

## Notes

- Items 2.3 and 2.5 are intentional for MITM proxy functionality but should be scoped narrowly.
- Item 4.7 (BrowserView deprecation) is the largest refactor — plan 2-3 days.
- Item 6.1 (split main.js) can be done incrementally, one module at a time.
