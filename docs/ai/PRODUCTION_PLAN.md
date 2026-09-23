# CupNet — Path to production (2026-09)

Companion to [PROJECT_MAP.md](PROJECT_MAP.md) (architecture) and [AUDIT-2026-09.md](AUDIT-2026-09.md) (392 tracked findings). This file is the ordered plan: what to fix, what to upgrade, in what sequence, and why. Update the checkboxes as work lands.

Baseline: HEAD `48e1d46`; the working tree has large uncommitted security-hardening WIP (backup ref `refs/backup/pre-claude-audit-2026-09-23`). Local Node 20.19 (EOL), Electron 34.5.8 (EOL). Full versions research is in the audit run; the tables below are the actionable subset.

---

## Release gate (must be green before shipping)

- [ ] Vitest green in CI: fix the 6 `node:test` unit files so `vitest run` collects them (**A-*** test-infra).
- [ ] No untrusted-site path can reach real IP, proxy secrets, or the full cookie jar (critical cluster below).
- [ ] No data-loss on: vault master-password change, CV01→CV02 migration, encrypted-row export (HAR/bundle/session-copy/editor).
- [ ] Fail-closed egress actually holds across MITM restart, TLS passthrough, and WebSocket tunnels.
- [ ] `npm test`, `npm run test:go`, `npm run test:e2e:smoke` pass locally and on PR CI.
- [ ] Packaging excludes dev junk (session dumps, backups, `_debug*`) from `app.asar`; per-arch DMGs carry the matching Go worker + Node.
- [ ] Browser UA/TLS/HTTP2 profiles refreshed to current and consolidated into one source of truth.

---

## Phase 0 — Stabilize the WIP (do first; unblocks everything)

The uncommitted refactor left the app in a broken intermediate state. These are correctness/security regressions, not new features.

1. **Restore the in-tab pages the preload split broke.** Settings (and any other internal page loaded as a tab) lost its APIs when they were removed from `preload-view.js`. Either (a) route internal pages (`settings.html`, `new-tab.html`, etc.) through a dedicated internal preload that keeps the needed APIs and is gated to `file:` internal URLs, or (b) open Settings as a shell `BrowserWindow` with `preload.js` instead of as a tab. See AUDIT `settings`/`ipc-contract` findings.
2. **Close the tab-preload privilege leak (critical).** `preload-view.js` still exposes real-IP, proxy, ext-proxy and full-cookie IPC to every website in a tab. Gate each privileged channel with the trusted-sender guard, and for the few legitimately tab-callable channels (e.g. `new-tab.html` needs IP/proxy status) check `event.sender` URL is an internal `file:` page. See critical cluster.
3. **Fix the vault key-migration data-loss set (critical).** CV01→CV02 verify-blob upgrade must not change the session key mid-session; legacy CV01 fields must stay decryptable/be migrated before the password is dropped; `profile-complete-setup` must not overwrite an existing vault's verify blob without the old master password; `credentials-change-master` must re-key **all** encrypted columns atomically. Add a regression test that unlocks, writes, migrates, and reads back.
4. **Fix encrypted-row export/consumption.** Hydrate encrypted headers/bodies (and normalize header shape: hydrated rows are objects, but HAR/bundle/replay/editor JSON.parse them as strings) before HAR export, bundle export, "session from selection", request-editor prefill, and the redact fallback. See `data-logging`/`log-viewer` findings.
5. **Replace `window.prompt()` everywhere** (Electron has no prompt): request editor, cookie manager, credentials export/switch/delete/folder. One shared `<dialog>`-based `askText()` helper. See A-048.

## Phase 1 — Security hardening (correctness of the security model)

- [ ] **Fail-closed egress:** re-apply per-tab upstreams, JA3, forceHttp1 and the egress block after MITM restart; make TLS-passthrough and WebSocket tunnels honor the block and per-tab proxy; clear the MITM upstream on a failed profile switch. (`mitm-intercept`, `proxy` findings.)
- [ ] **Upstream TLS verification:** stop accepting every certificate. Validate the CupNet CA by fingerprint in `setCertificateVerifyProc`; use Chromium default verification for passthrough/non-proxied hosts; make the Go worker's `InsecureSkipVerify` opt-in per rule, not the default. Replace the `/CupNet MITM/` name match with an issuer-fingerprint check. (Confirm intent with the owner — for an interception tool some of this is by design, but the current blanket-accept is a real MITM risk when a third-party proxy is on the path.)
- [ ] **Native HTTPS fallback** must use the upstream proxy, not a direct connection (real-IP leak). (`mitm-proxy.js` fallback finding.)
- [ ] **Script/transform intercept rules = arbitrary code in the main process.** Require explicit confirmation on import/enable, show a clear "runs code" warning, and consider a stricter sandbox or an opt-in flag. (`request-interceptor.js`, `rules-ipc.js`.)
- [ ] **Renderer XSS:** escape server-controlled Content-Type / form.method / header names shown in the privileged log & analyzer windows; sanitize Quill HTML export. (`log-viewer`, `page-analyzer`, notes.)
- [ ] **WebRTC leak protection** is currently ineffective — revisit the policy and apply it to per-tab-proxy and recreated tabs.
- [ ] **Cookie IPC ownership checks** on remove/clear/consolidate; don't allow cross-site jar reads.
- [ ] **Packaging:** tighten `build.files` allowlist; per-arch artifact names + workers.

## Phase 2 — Correctness & data integrity

Work the AUDIT list by severity within each subsystem. Big rocks: X-CupNet-Rid tab attribution (per-session handler bound to the last tab), tab-error-page reload/400-heuristic replacing real pages, autofill/url_match using the now-empty plaintext login column, notes autosave re-binding to the old id, cookie consolidation not public-suffix-aware, Go worker Set-Cookie merging losing cookies, pool slot deadlock.

## Phase 3 — Dependency & platform upgrade

Order chosen to minimize native-rebuild churn (do the N-API bumps before the Electron bump).

| Step | Change | Notes |
|---|---|---|
| 3.1 | Low-risk bumps: `jsondiffpatch@^0.7.6`, `form-data@^4.0.6`, `tldts@^7.4.14`, `turndown@^7.2.4`, `@codemirror/*` latest, `@playwright/test@^1.63`, `monaco-editor@^0.56`; **remove `node-forge`** (unused; also clears CVEs) | clears most `npm audit` findings |
| 3.2 | `better-sqlite3@^13` (first **N-API** release — no more electron-rebuild/ABI mismatch), then `argon2@0.44.0` (keeps darwin-x64 prebuild; 0.45 drops it) | removes native-rebuild fragility |
| 3.3 | Node 24 toolchain: `.nvmrc` → `24`; engines → `">=24.15 <27"`; CI `node-version: '24'` (3 workflows); then `vitest@^5`, `node-gyp@^13`, `@electron/rebuild@^4`, `cross-env@^10` | vitest 5 needs Node ≥22.12 |
| 3.4 | **Electron 34 → 44** + `electron-builder@^26.16` | breaking-change checklist below |
| 3.5 | Go worker: `azuretls-client@v1.13.2` (drop-in), `go 1.26` + `toolchain go1.27.1`, CI `go-version: '1.27.x'` | fixes Firefox/Safari/iOS presets too |
| 3.6 | UA + client-hints refresh (fingerprints section) | after Electron bump so `process.versions.chrome` is current |
| 3.7 | ESM-only majors: `proxy-chain@^3` (after Electron 44's `require(esm)`), `archiver@^8` (`new ZipArchive(...)`) | code changes required |
| 3.8 | Drop the legacy ffi-napi Node worker path (`@2060.io/ffi-napi`, `ref-napi`, `ref-struct-di`, `azure-tls-worker.js`, `azuretls/azureTLS.js`) | Go worker is already the default |
| 3.9 | GitHub Actions: checkout/setup-node/setup-go → v7, cache → v6, upload-artifact → v7, download-artifact → v8, action-gh-release → v3 | 3 workflows |

### Electron 34→44 breaking-change checklist

- `clipboard.writeImage` removed in 44 → `screenshots-ipc.js:31`; clipboard writes return Promises → `misc-ipc.js:136`.
- Sync `safeStorage.*` deprecated (removed in 46) → migrate to `encryptStringAsync`/`decryptStringAsync` in `proxy-ipc.js`, `quick-connect-ipc.js`, `global-proxy-connect.js`, `proxy-profile-resolve.js`, `session-profile-proxy.js`.
- `console-message` positional args deprecated (35) → `cupnet-runtime.js:1386` use the Event object.
- Electron 42 no longer downloads its binary in postinstall → hardcoded `node_modules/electron/dist/...` paths break (`package.json` `test:db`, `scripts/debug-nav.mjs`, `scripts/debug-tab-nav.mjs`, CI `--ignore-scripts`); add `npx install-electron --no` or the equivalent.
- macOS floor: 44 = macOS 13+; add `build.mac.minimumSystemVersion: "13.0"`. No Windows ia32 in 44.
- Verify native prebuilds for ABI 149: better-sqlite3 13 (N-API ✓), argon2 (N-API ✓), ffi-napi (none — another reason to drop it).

## Phase 4 — CI, tests, hygiene

- [ ] Make `vitest run` collect all unit files (6 use `node:test`); keep a `node --test` lane for the ones that intentionally use it, or convert them.
- [ ] Add the missing `scripts/azuretls-*.js` referenced by `package.json` (`rebuild:azuretls*`, `smoke-azuretls-native`) or drop those scripts if the Go worker fully replaces them.
- [ ] Remove tracked dev junk from VCS: `_debug_eof_*.js`, `*.zip`, `*.bundle`, `img2.png`, `critical.log`, `.DS_Store`.
- [ ] Confirm `electron-app/app.js` is dead, then delete it (removes 5950 lines and a whole class of "which file is live" confusion).
- [ ] Keep `npm test` on PR CI (already added) and green.

---

## Fingerprints — target values & locations

Copied in 5 places (consolidate into one `browser-profiles.json`, `//go:embed` in Go): `azuretls-go/profiles.go`, `azure-tls-worker.js` (BROWSER_PROFILES), `proxy-tls-ua-sync.js`, `proxy-manager-renderer.js` (UA_PRESETS), `user-agent-utils.js`.

| Profile | Current | Target (2026-09) |
|---|---|---|
| Chrome | UA `Chrome/133`, H2 `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` | UA `Chrome/154` (or `152` to match Electron 44), H2 unchanged |
| Firefox | UA `rv:138 Firefox/138`, H2 `1:65536;4:131072;5:16384\|65536\|0\|m,p,s,a` **(wrong)** | UA `156`, H2 `1:65536;2:0;4:131072;5:16384\|12517377\|0\|m,p,a,s` |
| Safari | UA `Mac OS X 14_7_4 Version/18.3`, H2 `1:65536;4:4194304;6:65535\|10485760\|0\|m,s,a,p` **(old)** | UA `10_15_7 Version/27.0 Safari/605.1.15`, H2 `2:0;3:100;4:2097152;8:1;9:1\|10420225\|0\|m,s,a,p` |
| iOS | UA `iPhone OS 18_3 Version/18.3`, H2 = old Safari | UA `iPhone OS 18_6 Version/27.0 Mobile/15E148 Safari/604.1`, H2 `2:0;3:100;4:2097152;9:1\|10420225\|0\|m,s,a,p` |
| Edge | `Chrome/133 Edg/133` | `Chrome/153 Edg/153` |
| Opera | `Chrome/133 OPR/119` | `Chrome/152 OPR/136` |

Also: the Go worker always calls `ApplyHTTP2` with the repo string, overriding azuretls' built-in presets — after fixing the strings, or stop overriding for Firefox/Safari/iOS. Add `sec-ch-ua` / `userAgentMetadata` (brands, fullVersionList, platform, mobile) to `Emulation.setUserAgentOverride` (`cdp-network-logging.js:270`) and the session UA path — today the renderer sends Electron's native Chromium-132 client hints next to a UA claiming Chrome 133/120, which is inconsistent. Verify `sec-ch-ua` GREASE values and the iOS token (`18_6` vs `18_7`) on a live browser/device.

---

## Progress log

- 2026-09-23: Audit complete (486 verified findings → 392 deduplicated). Docs written.
- 2026-09-23: **Browser templates refreshed** to Chrome 154 / Firefox 156 / Safari 27 / iOS 27 / Edge 153 / Opera 136 across `azuretls-go/profiles.go`, `azure-tls-worker.js`, `proxy-tls-ua-sync.js`, `proxy-manager-renderer.js`, `user-agent-utils.js` (now derives Chrome major from `process.versions.chrome`), plus example/doc/placeholder. Fixed the wrong Firefox/Safari/iOS HTTP/2 fingerprints (partial A-062). Go worker rebuilt; Go tests green. Old UA strings kept in the replaceable set so saved profiles auto-upgrade. _Still open:_ `sec-ch-ua`/`userAgentMetadata` client hints, consolidate the 5 copies into one source of truth, stop `ApplyHTTP2` overriding azuretls presets.
- 2026-09-23: **CI unblocked** — swapped `node:test`→`vitest` in 6 unit files (A-058/A-388); `vitest run` now collects them (32 files / 179 tests green, was 25/140 with 7 failing files). +39 previously-dead tests now run.
- 2026-09-23: Fixed A-039 (API Scout `_cupnetRoot` ReferenceError) and A-051 (editing a disabled intercept rule silently re-enabled it). Full unit + integration + Go suites green.
- 2026-09-23: Fixed 4 self-contained non-WIP bugs — A-049 (Request Editor dropped a typed query on Enter), A-046 (Page Analyzer form.method XSS), A-059 (setUserAgent cleared Accept-Language), A-043 (notes autosave re-bound to old note on fast switch). Committed on branch audit/2026-09-fixes. WIP-entangled findings (preload-view leak, vault migration, encrypted-row exports, cert model) held pending the WIP/modules discussion.
- **Next up (needs owner direction — see the report):** Phase 0 WIP stabilization and the security cluster touch the uncommitted refactor; the Electron 34→44 upgrade is large. Confirm scope before those.
