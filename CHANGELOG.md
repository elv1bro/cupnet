# Changelog

All notable changes to CupNet are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and from 2.0.0 onward
the project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-11-05

First stable, SemVer-tracked release after the 2026 hardening cycle. The product
is branded **CupNet 2**, so this is `2.0.0`. Prior builds used a non-monotonic
date string (`27.06.2026-5`); see **Changed → Versioning** below.

### Added
- **Browser Identity manager** — custom Chrome `ClientHelloSpec` in the Go
  AzureTLS worker with JA4 parity to real Chrome, consolidated UA/TLS/HTTP2
  profiles, and per-identity surfacing in the UI.
- **Proxy Manager** with Simple and Advanced modes, per-session proxy
  resolution, and TLS/UA sync.
- **Omnibox** with integrated browsing history and suggestions.
- **Encrypted-note model** replacing the old credentials vault (see Removed).
- **MITM response streaming** (`CUPNET_MITM_STREAM`, on by default with a kill
  switch) and tunable worker concurrency (default 12, per-origin pools).
- **Incident bundle** export/import and HAR export with per-session egress
  metadata and a WebSocket sidecar.

### Changed
- **Versioning:** adopted strict SemVer and reset to `2.0.0`. Git tags are now
  `v<version>` (e.g. `v2.0.0`). A unit test guards the scheme so the repo cannot
  silently fall back to the date form. UI version surfaces (new-tab splash/logo,
  Settings → About) read `app.getVersion()`, so they track the real version.
- **Electron 34 → 44**, with the console/exception capture reworked to avoid the
  CDP `Runtime.enable` fingerprint leak (Activity Monitor).
- Fail-closed egress now holds across MITM restart, TLS passthrough and WS
  tunnels.
- HAR `log.creator.version` now reflects the running app version instead of a
  hard-coded literal.

### Fixed
- **macOS release corruption:** the x64 and arm64 DMGs shared one artifact name
  and overwrote each other. The mac `artifactName` now includes `${arch}`; a
  build-config test locks it in.
- Packaging hygiene: tests, docs, CI config, `.claude/`/`.cursor/`, Markdown,
  stray logs and Go **sources** are excluded from `app.asar` (the Go worker
  binary still ships via `extraResources`).
- No untrusted-site path reaches the real IP, proxy secrets or full cookie jar
  (2026-09 hardening).

### Removed
- The standalone credentials vault, superseded by the encrypted-note model and a
  single-profile gate.

### Security
- Privileged IPC routed through the trusted-sender guard; tab preload kept
  minimal; dependency and security cleanup across the tree.

[2.0.0]: https://github.com/elv1bro/cupnet/releases/tag/v2.0.0
