# CupNet — Release 2.0.0 plan

Companion to [PRODUCTION_PLAN.md](PRODUCTION_PLAN.md) (the ordered path) and
[PROJECT_MAP.md](PROJECT_MAP.md) (architecture). This file is the concrete plan for
cutting the **2.0.0** release: the versioning decision, what must be green, the
release-blocking fixes, the tests that lock them in, and the release procedure.

Status legend: `[ ]` todo · `[x]` done · `[~]` deferred to a later release (with reason).

---

## 1. Versioning decision — adopt strict semver, reset to 2.0.0

**Problem (from PROJECT_MAP §version-scheme):** the version string is date-based
`27.06.2026-5` — not strict semver, non-monotonic (`27.6.2026 < 2026.4.1`), and
electron-builder normalizes it loosely so artifact names don't match the git tag.
The `-5` suffix even marks it as a *prerelease*.

**Decision:** switch to **strict [SemVer 2.0.0](https://semver.org/)** and reset the
number to **`2.0.0`**. Rationale:

- The product is already branded **CupNet 2** — a clean `2.0.0` matches the name and
  marks the first stable, semver-tracked release after the 2026 hardening work.
- Monotonic and tool-friendly: electron-builder, GitHub releases and auto-update
  manifests all expect semver; `2.0.0` round-trips through them unchanged.
- Going forward: `MAJOR.MINOR.PATCH`, git tag `v<version>` (e.g. `v2.0.0`), bump
  PATCH for fixes, MINOR for features, MAJOR for breaking UX/data changes.

A unit test (`tests/unit/version-semver.test.mjs`) guards the scheme so the repo can
never silently fall back to the non-monotonic date form.

---

## 2. Release gate (must be green before tagging)

Mirrors the PRODUCTION_PLAN release gate; this is the 2.0.0 cut's live status.

- [x] `npm run test:unit` (Vitest) green — 2026-11-05: 74 files / 682 tests.
- [x] `npm run test:go` (Go worker) green — 2026-11-05.
- [x] `npm test` (integration, `tests/run-all.sh`) green — 2026-11-05: 13/13 + test-db 43/43.
- [ ] `npm run test:e2e:smoke` green — deferred to PR CI (`pr-checks.yml`); GUI, not run locally.
- [x] No untrusted-site path reaches real IP / proxy secrets / full cookie jar — closed
      across the 2026-09 hardening (preload bridge gated to app `file:` pages, main-side
      sender guards, native fallback through the proxy, worker cookie jar off).
- [x] Fail-closed egress holds across MITM restart, TLS passthrough and WS tunnels
      (A-027/037/042/106).
- [x] Packaging excludes dev junk from `app.asar`; per-arch DMGs carry the matching
      Go worker. **← §3.2, §3.3 below, done + locked by `build-config.test.mjs`.**
- [x] UA/TLS/HTTP2 profiles refreshed and consolidated (Chrome 154/engine, custom
      ClientHelloSpec, JA4 == real Chrome 153).

---

## 3. Release-blocking fixes

### 3.1 Version bump → 2.0.0
- [x] `package.json` `version` → `2.0.0`; `package-lock.json` top-level + root-package
      `version` fields → `2.0.0`.
- All UI surfaces (new-tab splash + logo, Settings → About) read `app.getVersion()`,
  so they follow automatically.

### 3.2 macOS per-arch artifact naming (data-corruption of the release)
- **Bug (AUDIT A-, PROJECT_MAP §release):** `mac.artifactName` is
  `MacOS_CupNet-${version}.${ext}` while `mac.arch = [x64, arm64]`. Both arches emit the
  **same** filename, so whichever job finishes last overwrites the other. An Intel user
  can download the arm64 build (or vice-versa); MITM never starts and every tab fails.
- [x] Fix: include `${arch}` in the mac artifact name
  (`MacOS_CupNet-${version}-${arch}.${ext}`). A build-config test locks it in.

### 3.3 Packaging hygiene (`build.files`)
- `build.files` is `["**/*", …]` with only cache excludes, so tests, docs, CI config,
  Go sources, `.claude/`, Markdown and stray logs all ship inside `app.asar`.
- [x] Add conservative, runtime-safe negations: `tests/`, `docs/`, `.github/`,
      `.claude/`, `.cursor/`, root `*.md`, `**/*.log`, `_debug*`, scratch/session dumps,
      and the Go worker **sources** (`azuretls-go/*.go`, `go.mod`, `go.sum`) while keeping
      `azuretls-go/bin/`. No allowlist rewrite (that risks dropping a needed file) — just
      targeted excludes. A build-config test asserts the dev-junk globs are present.

### 3.4 HAR creator version consistency
- `har-exporter.js` hard-codes `creator { name: 'CupNet', version: '2.0' }`. Coincidentally
  right for this release, but it must track the app, not a literal.
- [x] Pass `app.getVersion()` through to the HAR creator version. A unit test asserts the
      exporter uses the supplied version, not a constant. (`buildHarCreator(appVersion,
      comment)` helper; `trace-har-ipc.js` threads `ctx.app.getVersion()` into both the
      streaming and in-memory exporters.)

---

## 4. Tests added for 2.0.0 (lock in the fixes)

- [x] `tests/unit/version-semver.test.mjs` — `package.json.version` is strict semver,
      is exactly `2.0.0` for this release, and matches `package-lock.json`.
- [x] `tests/unit/build-config.test.mjs` — `mac.artifactName` contains `${arch}`;
      win/linux names contain `${version}`; `build.files` carries the dev-junk excludes;
      `publish` is GitHub; Go worker binary ships via `extraResources`.
- [x] `tests/unit/har-creator-version.test.mjs` — `exportHar` stamps the passed
      `appVersion` into `log.creator.version` (not a hard-coded string) and does not leak
      `appVersion` into the DB filters.

---

## 5. Docs & changelog

- [ ] `CHANGELOG.md` — a real Keep-a-Changelog `2.0.0` entry summarizing the headline
      work: vault/credentials removal → encrypted-note model, single-profile gate,
      Browser Identity + Proxy Manager Simple/Advanced, Omnibox + browsing history,
      MITM response streaming + concurrency, fail-closed egress, Electron 34→44, custom
      Chrome ClientHelloSpec (JA4 parity), dependency/security cleanup.
- [ ] PROJECT_MAP.md: update the version-scheme and release-process notes to semver +
      fixed per-arch naming.
- [ ] PRODUCTION_PLAN.md: tick the now-satisfied release-gate boxes; add a progress-log
      entry for the 2.0.0 cut.
- [ ] Mark the per-arch artifact-naming finding fixed in AUDIT-2026-09.md.

---

## 6. Release procedure

1. All of §2 green; §3–§5 committed.
2. Bump committed on a branch; open PR → `pr-checks.yml` runs unit+integration+e2e.
3. Merge to `main`.
4. Push tag `v2.0.0` → `build-all.yml` builds mac (x64+arm64) / win / linux and creates a
   **draft** GitHub release with the installers + blockmaps.
5. Verify the draft has **all** expected artifacts (both mac arches now distinct), then
   publish manually.

---

## 7. Deferred to a later release (explicitly out of scope for 2.0.0)

These are upgrades/clean-ups that are **not** release-blocking and carry breakage risk;
doing them under a stable tag would be reckless. Tracked for 2.1+:

- [~] `vitest@^5`, Node 24 toolchain (`engines >=24`, `.nvmrc 24`, CI `node 24`) — current
      Vitest 2 + Node 22 are green; the bump is churn without a 2.0.0 benefit.
- [~] `proxy-chain@^3`, `archiver@^8` — ESM-only majors that need code changes.
- [~] The remaining low-severity AUDIT tail (polish items) and the medium items that need
      fresh tests written first (A-064/065 breakpoints, A-168/169 storage editor, A-178
      interceptor header reconcile, A-172 IPRoyal auth format).
- [~] Edge/Opera TLS presets (not re-measured); CI cross-platform `build:go`.
