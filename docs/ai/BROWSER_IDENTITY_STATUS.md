# Browser Identity — production-readiness status & handoff

Status of the Browser ID (browser-identity / fingerprint) subsystem of CupNet 2, what is implemented,
how to verify it, and the honest limitations. Written so another engineer/agent can continue the
**legitimate** work: keeping our real Chromium-based browser self-consistent and compatible with the
normal internet.

> **Scope boundary (read first).** This document is about making our browser *self-consistent and
> usable on the open web*. It is **not** a guide to defeating any site's anti-bot protection. Some
> vendors (e.g. Qrator) run an active JavaScript challenge (proof-of-work + tamper detection) that will
> challenge non-mainstream / instrumented browsers regardless of a clean fingerprint. Reverse-engineering
> or bypassing such a challenge is out of scope and must not be pursued here. For a specific site you
> need for real work, the correct path is the site owner's official API or an agreement with them — not
> circumventing their protection.

---

## 1. What the subsystem does

CupNet claims a chosen "browser identity" (which browser we look like) consistently on two layers:

- **Wire layer** (MITM → Go AzureTLS worker): rewrites `User-Agent`, `sec-ch-ua*`, `Accept-Language`;
  picks the TLS ClientHello / HTTP-2 profile. See `identity-headers.js`, `mitm-proxy.js`.
- **JS layer** (Chromium tab): CDP `Emulation.setUserAgentOverride` (UA + `userAgentMetadata` +
  timezone + locale), plus a main-world consistency patch injected before page scripts. See
  `main-process/services/identity-service.js`, `main-process/services/identity-consistency-script.js`,
  `preload-view.js`.

Identity is **global** and managed only in the **Browser ID** window (`identity-manager.html`). The
Proxy Manager manages proxies only — connecting a proxy never changes identity.

### Key files
| File | Role |
|---|---|
| `browser-identity-catalog.js` | Single source of truth: templates (UA + TLS + client hints + navigator.platform), resolveIdentity, describeIdentity. |
| `identity-headers.js` | Outbound header rewrite on the MITM path. |
| `main-process/services/identity-service.js` | The one writer: resolves the effective identity, applies to MITM + every tab (session UA, CDP emulation), exposes IPC status. |
| `main-process/services/identity-consistency-script.js` | Main-world patch (see §2). |
| `identity-check.html` / `identity-check-renderer.js` | `cupnet://identity-check` self-check page (see §3). |
| `identity-manager.html` / `identity-manager-renderer.js` | The Browser ID window: mode segment (engine / template / custom), form, Apply, "Verify in a tab", "Check after apply". |
| `main-process/ipc/handlers/identity-ipc.js` | `identity:get` / `identity:apply` / `identity:preview` / `open-identity-manager` / `identity:open-check`. |

---

## 2. Consistency patch (what is normalized)

`identity-consistency-script.js` builds a main-world IIFE injected before page scripts. For a
**Chromium-family** identity it makes the JS environment match a real Chrome:

- `window.chrome` populated with `loadTimes` / `csi` / `app` and **no** `runtime`, in the exact shape
  measured on Chrome 153 (2026-09-28): `loadTimes`/`csi` are bound functions (so the engine's own
  `toString` prints `function () { [native code] }` in every realm), name `""`, own keys
  `length,name,prototype`, constructible; values come from Navigation Timing (protocol from
  `nextHopProtocol`, never a constant `h2`). `chrome.app` methods are named, non-constructible, in
  Chrome's own-key order; `installState(cb)` answers asynchronously.
- The `Function.prototype.toString` shim (needed only for named fakes) is a method (no `prototype`),
  recognises fakes by source text so a toString from another realm still says native, and removes its
  own frame from the stack when the native method throws.
- The tab preload also runs in child frames (`nodeIntegrationInSubFrames`, Node stays off), so frames
  that load a document get the same patch. Known gap: an `about:blank` iframe created by script
  (`document.createElement('iframe')`) gets no preload — `iframe.contentWindow.chrome` is `{}` there.
- `screen.colorDepth` is genuine (headed Chrome 153 on this Mac reports 30; the earlier "24" came from
  headless Chrome). Pinned to 24 only for a template claiming another OS.
- `Notification.permission` / `permissions.query` are no longer patched: the session permission policy
  answers them natively (A-188) — "denied" until the user allows (Chrome says "prompt"; Electron's check
  handler is boolean).
- `navigator.languages`: engine mode keeps the engine's own list (`app.getLocale()` + OS preferred
  languages, e.g. `ru,ru-BY,en-BY,pl-BY`) in page, iframes and workers alike — Electron has no switch to
  change it for workers — and the wire Accept-Language is Chrome's expansion of that list
  (`chromeAcceptLanguageHeader`). An explicit identity language still overrides the page via CDP.
- Engine `sec-ch-ua-platform-version` is the real macOS version (`process.getSystemVersion()`).
- No page-visible `window.__cupnet*` marker globals (paste unlock no longer sets one).
- Template/custom identities only: `navigator.deviceMemory` capped at 8 and `hardwareConcurrency`
  pinned. **Engine mode keeps the genuine values** (owner decision 2026-09-27): Chrome 153 on the same
  Mac reports the real rounded RAM (e.g. 16), so a cap of 8 would itself differ from the installed Chrome.
  The identity-check page accepts any power of two in 0.25–64.
- WebGL `UNMASKED_VENDOR/RENDERER` rewritten to a GPU consistent with the claimed OS **only when the
  claimed OS differs from the host** (e.g. a Windows identity on a Mac).
- Deterministic per-identity canvas/audio perturbation ("farble"): stable for a given identity, not the
  host's raw hash (Brave-style). Only for spoofing identities, not engine mode.

For a **non-Chromium** identity (Firefox/Safari/iOS): removes `window.chrome` and
`navigator.userAgentData` (Chromium keeps exposing them).

**Client hints follow the browser family, not a toggle.** A Chromium identity always sends
`sec-ch-ua*` and exposes `navigator.userAgentData` (real Chrome always does); a hint-less Chrome is an
inconsistency and was a bug (fixed 2026-09-25).

**Engine mode presents as Google Chrome** (owner decision 2026-09-27, `identity.engineBrand`, default
`chrome`; `chromium` restores the old 2-brand Electron list). The wire `sec-ch-ua` and
`navigator.userAgentData` (via CDP `Emulation.setUserAgentOverride` + `userAgentMetadata`) both carry the
greased 3-brand list `Chromium` / `Google Chrome` / GREASE with the engine's real major and full version.

Disable the whole patch with `CUPNET_DISABLE_FINGERPRINT=1`.

---

## 3. How to verify (legitimate testing)

The goal of testing is **self-consistency** (wire == JS, no impossible combinations) and **compatibility
with normal sites**, NOT "did we get past vendor X".

### 3a. Built-in self-check — `cupnet://identity-check`
Open it from the Browser ID window ("Verify in a tab") or the toolbar. Two sections:

- **Local (offline):** compares what JavaScript sees against what the MITM puts on the wire
  (`https://identity-check.cupnet/echo`, answered locally). Every row should be ✓ / consistent.
  Checks: UA, `sec-ch-ua*`, Accept-Language vs `navigator.languages`, `window.chrome`,
  `deviceMemory`/`hardwareConcurrency`, canvas farble stability, WebGL renderer vs claimed OS, timezone.
- **Through the proxy (real external request):** "Check through the proxy" makes a real request via the
  connected proxy to public echoes (httpbin.org headers + egress IP, ipinfo.io country, tls.peet.ws
  JA3/JA4 + HTTP/2). Shows what a real site receives: egress IP/country, the received headers, and the
  TLS fingerprint. Use this to confirm the identity actually reaches an external site through the proxy.

A green self-check means the identity is internally consistent. That is the bar this subsystem targets.

### 3b. Third-party fingerprint viewers (manual)
Open these in a tab and confirm the values match the chosen identity and are internally consistent:
- Header/UA + client hints: any headers echo.
- TLS/HTTP-2: `tls.peet.ws`, `tls.browserleaks.com`.
- General surface: `browserleaks.com`, `amiunique.org` (for consistency, not for a "uniqueness score").

Reference measurement without Electron or a window: `node scripts/tls-fingerprint-compare.mjs [--template chrome-mac]`
drives the worker through a standalone MITM and a locally installed Chrome with `--headless=new`, both
against `tls.peet.ws/api/all`, and prints JA4 / JA4_r / HTTP-2 Akamai plus the extension, signature-scheme,
cipher and group differences (`--json` for machine-readable output, `--no-chrome` to skip the reference).

### 3c. Normal-site compatibility
The browser must render the ordinary web. Spot-check a range of real sites (news, e-commerce, login
forms, sites behind common CDNs). Cloudflare's standard managed challenge currently passes. This is the
"can a person use it" bar for production.

Automated (2026-09-25) in `tests/e2e/site-smoke.e2e.spec.js`: for each site in a default list (example.com,
Wikipedia, DuckDuckGo, GitHub login, Stack Overflow, npmjs, mozilla.org, BBC News) it asserts main-document
status < 400, no anti-bot interstitial / block page, text + links present, an instant scroll works, and the
primary text input takes focus and accepts inserted text. Runs with the shipping default (engine mode);
`CUPNET_SITE_SMOKE_TEMPLATE=<template id>` runs it under a template, `CUPNET_SITE_SMOKE_SITES` overrides
the list, `CUPNET_SKIP_EXTERNAL=1` skips it. **Not yet executed locally** (GUI e2e; the machine was in use) —
run it before merge or in CI.

### 3d. Automated tests
```bash
npm run test:unit                 # includes identity-consistency-script / identity-headers / identity-service / catalog
CUPNET_MITM_PORT=18877 CUPNET_SKIP_EXTERNAL=1 npx playwright test tests/e2e/identity.e2e.spec.js
CUPNET_MITM_PORT=18877 CUPNET_SKIP_EXTERNAL=1 npx playwright test tests/e2e/proxy-manager-ui.e2e.spec.js
CUPNET_MITM_PORT=18877 npx playwright test tests/e2e/site-smoke.e2e.spec.js   # §3c as a test (network)
```
Run e2e on a spare `CUPNET_MITM_PORT` so it does not collide with a running instance; kill leftover
`cupnet-e2e-*` Electron processes if `beforeAll` times out (they hold the port).

### Driving the app headlessly for a one-off check (pattern)
Playwright + Electron: `electron.launch({ args: ['.', '--user-data-dir=<temp>'], env: { CUPNET_E2E:'1', CUPNET_MITM_PORT:'188xx' } })`.
Main-process state is `globalThis.__cupnetAppContext` (reach it with `app.evaluate`, NOT the renderer).
Tab JS runs via `helpers.executeActiveTabJavaScript`. `app.evaluate` callbacks receive the electron
module object as their first arg (`({ app, BrowserWindow }) => …`), not `require`.

---

## 4. Known limitations (honest)

1. **Active anti-bot challenges are not passed, and that is out of scope.** Vendors like Qrator serve a
   JS challenge (proof-of-work + a large fingerprint payload + tamper detection). It challenges
   non-mainstream/instrumented browsers even with a clean, consistent fingerprint. Passing it would mean
   reverse-engineering and defeating the vendor's protection — do not do this. If a specific site is
   required for real work, get access through its owner (official API / agreement).
2. **TLS version vs UA — RESOLVED 2026-09-25 (option b).** The `chrome` TLS profile now uses our own
   `ClientHelloSpec` (`azuretls-go/profiles.go` → `chromeClientHelloSpec`, wired in
   `request.go` `createPooledSession`, replaced by `ApplyJa3` when a JA3 override is set): the
   azuretls preset plus the trust-anchor-IDs extension 51764 with the payload captured byte-for-byte
   from Chrome 153.0.8010.53 (186 bytes, a constant per Chrome version — it lists the Chrome Root
   Store anchors participating in TAI), and `signature_algorithms` = GREASE, mldsa44/65/87
   (0x0904–0x0906), then the classical list. A raw ClientHello capture also showed Chrome sends a
   GREASE signature scheme first, which `tls.peet.ws` filters out — utls does not re-GREASE sigalgs,
   so the worker draws one per ClientHello itself. Result through the MITM (`node
   scripts/tls-fingerprint-compare.mjs`, 2026-09-25): JA4 `t13d1517h2_8daaf6152771_cb7bf5808d99`
   == real Chrome 153, JA4_r identical, HTTP/2 identical, no cipher/extension/sigalg/group diff.
   Tests: `azuretls-go/profiles_clienthello_test.go` marshals the spec through utls offline and
   checks ciphers, the 17-extension set, the 51764 payload, sigalg order, groups, versions, key-share
   size, ALPN/ALPS/compress_certificate, per-connection shuffle + fresh GREASE, the session hook and
   the kill switch; `TestChromeSpecJA4Live` (opt-in `CUPNET_GO_NET_TESTS=1`) asserts the JA4 on
   tls.peet.ws. Kill switch: `CUPNET_TLS_CHROME_UPSTREAM_PRESET=1` (MITM passes `process.env` to the
   worker) restores the library preset — use it if a server ever selects an ML-DSA scheme for
   CertificateVerify, which utls cannot verify yet (real Chrome can; ML-DSA server certs are still
   rare). Edge/Opera/Firefox/Safari/iOS keep the library presets (not re-measured). Remaining drift:
   templates claim Chrome 154 while the shape is measured from 153 (the TAI list may change per
   version) — re-capture per the upgrade cadence. Rebuild the worker after this change
   (`npm run build:go:local`; both darwin binaries rebuilt 2026-09-25).
   **Measured 2026-09-25, before the fix** (headless real Chrome 153 vs our worker, both against `tls.peet.ws/api/all`):
   HTTP/2 Akamai fingerprint identical (`52d84b11…`), JA4_b cipher list identical (`8daaf6152771`),
   supported groups identical (X25519MLKEM768, X25519, P-256, P-384). Differences: real Chrome sends 17
   extensions vs our 16 (JA4 `t13d1517h2` vs `t13d1516h2`) — the extra one is `51764` (0xca34, TLS
   trust-anchor IDs) — and real Chrome lists three ML-DSA signature schemes first (`0x0904`, `0x0905`,
   `0x0906`), so JA4_c differs (`cb7bf5808d99` vs `d8a2da3f94cd`). Chrome randomizes extension order, so
   JA3 differs run to run for real Chrome too and is not a useful target. Reproduce with
   `node scripts/tls-fingerprint-compare.mjs` (§3b).
   `azuretls-client` v1.13.2 is the **latest published release** and its `GetLastChromeVersion` preset is
   annotated "Current Chrome version: 133", so a library bump could not close this. Options were: (a) wait
   for an upstream preset refresh; (b) our own `ClientHelloSpec`; (c) accept. **The owner chose (b) on
   2026-09-25 — implemented as described above.**
3. **Engine is Electron/Chromium.** Electron 44.4.5 (the latest release) = Chromium **152**
   (`process.versions.chrome`; earlier notes said 146 — corrected 2026-09-25); Chrome stable is **155**
   (2026-09-25), templates claim 154. Feature-probing can tell an Electron build from stable Chrome
   regardless of UA. Legitimate improvement: keep Electron current — policy in `PRODUCTION_PLAN.md`
   → "Electron/Chromium upgrade cadence" (monthly check, new major within 4 weeks, template refresh with
   every bump, test gate).
4. **The consistency patch overrides some native functions** (canvas/audio/WebGL/toString). These are
   only self-consistent within the top frame; a strict environment could still tell they are not native.
   `CUPNET_DISABLE_FINGERPRINT=1` turns the patch off if you want to A/B its effect on normal sites.

---

## 5. Legitimate next steps (for productionization)

Status 2026-09-25 (owner asked to continue this section):

- **Default identity for shipping — recommended: engine mode.** It is already the code default
  (`settings-store.js`: `mode: 'engine'`, `engineHints: true`, `followProxyGeo: false`) and the only mode
  with zero claimed-vs-real mismatch: real engine TLS, UA and 2-brand hints derived from
  `process.versions.chrome`, no JS patching of natives. Templates stay an opt-in for testing how a site
  treats another browser. **Awaiting owner confirmation.**
- **TLS preset vs template Chrome major** — **done 2026-09-25** (owner chose option b): custom
  `chromeClientHelloSpec` in the Go worker, JA4 identical to real Chrome 153 (§4 (2)). Re-capture the
  51764 payload / sigalgs with every Chrome major per the upgrade cadence.
- **Electron/Chromium upgrade cadence** — written as policy in `PRODUCTION_PLAN.md` ("Electron/Chromium
  upgrade cadence", 2026-09-25). Done.
- **Normal-site smoke coverage** — `tests/e2e/site-smoke.e2e.spec.js` added (§3c/§3d). Not yet executed
  locally (GUI); run before merge or in CI.
- Keep `cupnet://identity-check` as the canonical "is my identity consistent" tool; extend its rows as
  new fields are hardened.

---

_Last updated 2026-09-25. Companion docs: `PROXY_IDENTITY_REDESIGN.md` (change log), `PROJECT_MAP.md`
(architecture), `AUDIT-2026-09.md` (bug tracker)._
