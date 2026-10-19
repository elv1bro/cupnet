# Proxy Manager redesign + Browser Identity split — plan and progress

Owner request (2026-09-23): make the proxy manager lighter — a **Simple** mode
(provider account such as NodeMaven: user + password + country + what else is
needed) and an **Advanced** mode (static proxies, template variables, full
tuning). Move the **User-Agent / fingerprint choice out of the proxy manager**
into its own place, make the UA consistent **on the wire (headers) and in JS**,
and cover everything with tests.

Companion docs: [PROJECT_MAP.md](PROJECT_MAP.md) (architecture),
[AUDIT-2026-09.md](AUDIT-2026-09.md) (bug ids), [PRODUCTION_PLAN.md](PRODUCTION_PLAN.md).

---

## 1. Where we start (verified 2026-09-23)

> **Baseline changed on 2026-09-24 (big refactoring landed on `audit/2026-09-fixes`):** Electron 34.5.8 → **44.4.5**
> (Chromium 152 — corrected 2026-09-25, an earlier note said 146; `process.versions.chrome` drives the engine UA major), electron-builder 26, better-sqlite3 13, the legacy
> Node/ffi AzureTLS worker (`azure-tls-worker.js`, `azuretls/`) and IVAC Scout were **removed** — the Go worker is the only
> upstream client and `new MitmProxy(opts)` no longer takes `workerPath`. Everything below that mentions the legacy worker
> or Chromium 132 is historical; the identity work from phases 1–4 survived the refactoring (edits to committed files were
> swept into those commits, the rest is still uncommitted in the working tree).

- **Proxy Manager** (`proxy-manager.html` 1.5k lines + `proxy-manager-renderer.js` 2.3k lines, one flat
  script) has one editor with three tabs: Connection (provider / manual URL template), Identity
  (UA presets, timezone, language, TLS template, custom JA3, force HTTP/1.1) and Optimization
  (traffic blocking). Provider mode needs a "provider account" stored in **renderer localStorage in
  plaintext** (`cupnet.proxy.providerAccounts.v2`). No simple/advanced split exists anywhere.
- **UA / fingerprint** lives as columns on every proxy profile (`user_agent`, `timezone`, `language`,
  `tls_profile`, `tls_ja3_mode`, `tls_ja3_custom`, `force_http1`) and is applied only by proxy
  connect paths (`global-proxy-connect.js`, `quick-connect-ipc.js`, `set-tab-proxy`). The Direct
  entry stores identity in localStorage and never applies it (A-171). A TLS template click in the
  editor immediately changes the live MITM profile (A-170).
- **UA application is three unconnected layers** and none of them knows the chosen identity end to end:
  1. `session.setUserAgent` (partition-wide, reset to the engine UA on every `createTab` — new tabs
     lose the fingerprint);
  2. CDP `Emulation.setUserAgentOverride` **without** `userAgentMetadata` (A-301), only when the
     network-log debugger is attached;
  3. MITM `applyOutboundUserAgentToMitmHeaders` only sanitizes whatever Chromium sent
     (strips CupNet/Electron tokens). **`sec-ch-ua*` client hints are never rewritten**, so a
     Firefox UA goes out with Chromium client hints (A-191).
- Browser template data (UA per TLS template) was duplicated in 5 places (Go `profiles.go`,
  the legacy worker (removed 2026-09-24), `proxy-tls-ua-sync.js`, `proxy-manager-renderer.js`, `user-agent-utils.js`).
  Versions are already refreshed (Chrome 154 / Firefox 156 / Safari 27 / iOS 18_6 / Edge 153 / Opera 136).
- Tests: vitest units for providers / tls-ua-sync / profile-resolve / save-fail-closed; e2e for
  profile CRUD, TLS round-trip, user-agent (needs httpbin). **No local upstream proxy fixture, no
  local HTTPS echo fixture, no tests for fingerprint application, client hints or the Proxy Manager UI.**

## 2. Target design

### 2.1 Browser Identity (new concept, separate from proxies)

One **global identity** stored in `settings.identity`:

```jsonc
{
  "mode": "engine" | "template" | "custom",   // engine = today's behaviour (no override)
  "templateId": "chrome-win",                 // when mode=template
  "userAgent": "",                            // when mode=custom (free text)
  "tlsProfile": "chrome",                     // chrome|firefox|safari|ios|edge|opera (mirrored to settings.tlsProfile)
  "tlsJa3Mode": "template", "tlsJa3Custom": "", "forceHttp1": false,
  "timezone": "",                             // IANA or "" = system
  "language": ""                              // Accept-Language or "" = system
}
```

- **Catalog** `browser-identity-catalog.js` (dual-mode module, dependency-free, single source of truth
  for JS): templates `chrome-win | chrome-mac | chrome-linux | chrome-android | firefox-win | firefox-mac |
  safari-mac | ios-safari | edge-win | opera-win`. Each template = UA string + TLS profile + client-hint
  metadata (brands, platform, platformVersion, mobile, architecture, bitness, model) + `navigator.platform`.
  Helpers: `deriveClientHintsFromUserAgent(ua)` for custom UAs (Chromium family only; Firefox/Safari →
  `null`), `buildSecChUaHeaderValue(brands)`, `buildUserAgentMetadata(identity)` (CDP shape).
  `proxy-tls-ua-sync.js` and the Proxy Manager presets become thin views over the catalog.
- **Precedence** (resolved by `main-process/services/identity-service.js`):
  `per-tab proxy profile override` > `connected global proxy profile override` > `global identity` > `engine`.
  A proxy profile only overrides when its new column `identity_override = 1` (Advanced editor checkbox
  "Override browser identity while this proxy is connected"). Migration sets it to 1 for existing rows
  that carry any non-default identity field, so nothing changes for existing users.
- **Effective identity is applied in one function** (`identityService.applyEffective()`), replacing the
  scattered writes in global-proxy-connect / quick-connect / connect-direct / set-tab-proxy:
  1. **MITM (wire)** — `mitm.setIdentity(identity)` / `setTabUpstream({..., identity})`; `_doRequest`
     and the WebSocket path call `applyIdentityToOutboundHeaders(headers, orderedHeaders, identity)`
     (`identity-headers.js`): sets `User-Agent`; Chromium-family identity → rewrites `sec-ch-ua`,
     `sec-ch-ua-mobile`, `sec-ch-ua-platform` and every high-entropy `sec-ch-ua-*` **only if Chromium
     sent it** (never adds hints the page did not ask for); non-Chromium identity → removes all
     `sec-ch-ua*`; `Accept-Language` → identity language. Header order is preserved (in-place edit of
     `orderedHeaders`). Engine mode keeps today's sanitize-only behaviour. TLS profile / JA3 / forceHttp1
     go through `setBrowser` / new `setActiveJa3` / `setForceHttp1`.
  2. **Chromium / JS** — `session.setUserAgent(ua, lang)` for every tab partition **and for new tabs**
     (tab-manager asks `getIdentityForNewTab()` instead of resetting to the engine UA); when the CDP
     debugger is attached (it already is whenever a fingerprint is active),
     `Emulation.setUserAgentOverride` **with `userAgentMetadata`** (fixes `navigator.userAgentData`,
     `navigator.platform` and the hints Chromium itself emits), `Emulation.setTimezoneOverride`,
     `Emulation.setLocaleOverride`. Engine mode = no CDP for identity (no regression).
     Env `CUPNET_IDENTITY_CDP=0` disables the CDP layer (headers-only).
  3. `ctx.activeFingerprint` stays as a derived mirror `{user_agent, timezone, language}` for legacy
     readers (launch-profile export); broadcast `identity-changed` + `tls-profile-changed` (compat).
- **UI**: new trusted tool window `identity-manager.html` ("Browser Identity"): template grid, custom
  UA, timezone and language pickers, advanced TLS block (JA3, force HTTP/1.1), a live **"what the wire
  will send"** preview (UA, sec-ch-ua, sec-ch-ua-platform, Accept-Language) and the effective source
  ("overridden by proxy profile X"). Entry points: menu Tools → *Browser Identity…*, an identity chip in
  the Proxy Manager header, `open-identity-manager` IPC. `get/set-tls-profile` keep working (mapped to
  `identity.tlsProfile`) so existing e2e and the settings page do not break.
- IPC (`main-process/ipc/handlers/identity-ipc.js`, guarded by `guardIpcHandler`):
  `identity:get`, `identity:set`, `identity:list-templates`, `identity:preview`, `open-identity-manager`.

### 2.2 Proxy Manager: Simple vs Advanced

- A **Simple | Advanced** segmented toggle in the window header, persisted in ui-prefs
  (`proxyManager.editorMode`, default `simple`). `body[data-editor-mode]` + CSS `.adv-only` hide the
  advanced surface; a profile authored in manual/static mode opens in Advanced automatically.
- **Simple editor** = one card: Provider (NodeMaven / Decodo / Oxylabs / IPRoyal) → Username → Password →
  Country → Session (rotating / sticky + minutes) → Name (auto-suggested) → **Save / Test / Connect**.
  Credentials are typed inline (no "account" object needed): username is kept in `variables.__username`,
  the password lives only in the encrypted URL and is recovered through the trusted `get-proxy-profile-url`
  when the profile is reopened. Choosing a provider in a new profile pre-fills the credentials of the
  most recent profile of that provider. Nothing about identity/TLS/traffic is shown in Simple mode
  except a read-only "Browser identity: … · Change…" line.
- **Advanced editor** = today's editor plus:
  - **Static / bulk import**: paste one proxy per line (`scheme://user:pass@host:port`,
    `host:port:user:pass`, `user:pass@host:port`, `host:port`) → N profiles with a name prefix
    (parser `proxy-static-import.js`, unit-tested) or one profile with the rest as failover list.
  - Identity tab becomes **"Identity override"** (checkbox + the existing fields) and links to the
    Browser Identity window. The TLS template click no longer touches the live MITM (A-170).
  - The Direct entry loses its identity fields (identity is global now; fixes A-171 / A-282 in spirit).
- Pure form ↔ profile mapping moves to `proxy-manager-model.js` (dual-mode) so it is unit-testable
  without a DOM: `buildSimpleProfile(form)`, `simpleFormFromProfile(profile, decryptedUrl)`,
  `editorModeForProfile(profile)`, `suggestSimpleName(...)`.

### 2.3 Out of scope / deferred (tracked, not done here)

- Moving provider accounts from renderer localStorage into a safeStorage-backed main-process store
  (Simple mode no longer needs accounts, so this becomes an Advanced-only concern). Audit entry added.
- Auto-following timezone/language from the proxy egress country. Optional follow-up.
- Electron/Chromium engine upgrade (the Chromium 132 engine is still detectable through feature
  probing regardless of UA/hints) — PRODUCTION_PLAN 3.4.

## 3. Phases (each phase ships with its tests)

| # | Phase | Deliverables | Tests |
|---|---|---|---|
| 1 | **Identity catalog + wire headers** | `browser-identity-catalog.js`, `identity-headers.js`, MITM `setIdentity` / per-tab identity, `setActiveJa3`; `proxy-tls-ua-sync.js` re-based on the catalog | vitest: catalog invariants, hint derivation, header rewrite (order, add/remove rules, Accept-Language); integration: MITM + Go worker + local HTTPS echo verifying `User-Agent` and `sec-ch-ua*` on the wire (skips without the Go binary) |
| 2 | **Identity service + JS layer + window** | `identity-service.js`, settings key, `identity-ipc.js`, preload API, `cdp-network-logging` metadata, tab-manager new-tab hook, `identity-manager.html/.js`, menu entry, migration of connect/disconnect/quick-connect/connect-direct/set-tab-proxy to the service | vitest: precedence and application with fake mitm/tabs/settings; e2e: set identity → `navigator.userAgent`, `navigator.userAgentData.brands`, `navigator.platform`, `Intl` timezone, wire headers via local HTTPS echo; TLS round-trip still green |
| 3 | **Proxy Manager Simple / Advanced** | mode toggle + persisted pref, simple card, inline credentials, static import, identity-override checkbox, model extraction, `identity_override` column + migration | vitest: model mapping, static parser, provider compile for the 4 providers; e2e: toggle persists, simple NodeMaven profile saved with masked URL and `gate.nodemaven.com`, reopen shows simple form, bulk import creates N profiles |
| 4 | **Docs + audit + full run** | PROJECT_MAP (new subsystem + Proxy section), AUDIT statuses (A-170, A-171, A-191, A-282, A-289, A-290, A-291, A-301, A-304) and new ids, PRODUCTION_PLAN log | `npm run test:unit`, `npm run test:go`, targeted e2e specs |

## 4. Progress log

- 2026-09-23 — plan written.
- 2026-09-23 — **Phase 1 done**: `browser-identity-catalog.js`, `identity-headers.js`, MITM `setIdentity` / `setTabIdentity` / `setActiveJa3`, `proxy-tls-ua-sync.js` re-based on the catalog. Tests: `tests/unit/browser-identity-catalog.test.mjs`, `identity-headers.test.mjs`, `mitm-identity-wire.test.mjs` (real MITM + Go worker + local HTTPS echo).
- 2026-09-23 — **Phase 2 done**: `identity-service.js` (fingerprint-service.js deleted), `settings.identity` (+ `tlsProfile` mirror), `identity-ipc.js` (`identity:get/set/preview`, `open-identity-manager`, sync navigator patch for preload-view), `identity-manager.html/-renderer.js` + Tools menu (Cmd/Ctrl+Alt+I), tab-manager identity hooks, cdp-network-logging delegates Emulation to the service, connect/disconnect/quick-connect/connect-direct/set-tab-proxy/launch-profile paths migrated, `identity_override` column + migration. Findings while testing: Electron sends no `sec-ch-ua` at all (MITM now synthesizes the 3 low-entropy hints for Chromium identities) and Electron snapshots the session UA per WebContents (service also calls `webContents.setUserAgent`). Tests: `identity-service.test.mjs`, e2e `identity.e2e.spec.js` (7/7), regressions green.
- 2026-09-23 — **Phase 3 done**: Proxy Manager Simple | Advanced (ui-pref `proxyManager.editorMode`), inline provider credentials (username in `variables.__username`, password only inside the encrypted URL), credential prefill from the newest profile of the same provider, static list import (`proxy-static-import.js`), identity override tab, Direct without identity fields, A-170/A-352 fixes; pure logic in `proxy-manager-model.js`. Tests: `proxy-manager-model.test.mjs`, `proxy-static-import.test.mjs`, e2e `proxy-manager-ui.e2e.spec.js` (7/7).
- 2026-09-23 — **Phase 4 done**: PROJECT_MAP / AUDIT (A-170, A-171, A-191, A-282, A-290, A-301, A-304, A-352 fixed; A-289, A-291 partial; new A-393–A-396) / PRODUCTION_PLAN updated.

### Phase 5 (2026-09-24, after the Electron 44 / legacy-worker refactoring)

Plan corrections: the legacy-worker bullet is moot (worker deleted); the catalog drift test guards the Go file only, which
is now the single non-JS copy. Electron 44 keeps the engine UA at Chromium 152 (corrected 2026-09-25; not 146) while templates claim Chrome 154 — that is
intended (TLS ClientHello ≈ Chrome 13x anyway). Remaining work, in order:

| # | Item | Why | Deliverable / test |
|---|---|---|---|
| 5.1 | **Drop provider accounts** (A-393) | plaintext secrets in renderer localStorage; Simple mode already stores credentials inside the encrypted profile URL and prefills them from the newest profile of the same provider, so the account object is dead weight | remove the sidebar section, modal, `acc:` select entries and the account-test planner from `proxy-manager.html/-renderer.js` + `proxy-providers.js`; purge `cupnet.proxy.providerAccounts*` from localStorage on first open; keep `__accountId` reserved (old profiles) and `resolveProviderCredentials` legacy vars path; unit tests updated, e2e pm1 asserts no `acc:` options |
| 5.2 | **Engine-mode client hints** (A-396) | Electron sends none; real Chromium sends 3 low-entropy hints on every secure request and `navigator.userAgentData` already exposes the 2-brand Chromium list, so the wire and JS disagree | identity-service builds an "engine wire identity" (sanitized engine UA + 2-brand hints for the running Chromium major, host platform) — toggle `identity.engineHints` (default on); catalog `greasedBrandList` gets the 2-brand permutation; e2e asserts the synthesized `sec-ch-ua` equals `navigator.userAgentData.brands` of the running engine |
| 5.3 | **Follow proxy geo for timezone / language** | the Simple flow is "pick a country" — timezone and Accept-Language should follow automatically | `identity.followProxyGeo` (default off) + `geo-locale-defaults.js` (country → Accept-Language; timezone comes straight from the ipinfo result); identity-service `setGeoHint(geo)` layered between the profile override and the global settings; connect/disconnect wire it; Identity window checkbox + status; unit tests |
| 5.4 | Docs / audit / memory | | AUDIT A-393 → fixed, A-396 → fixed; PROJECT_MAP; this log |

Progress 2026-09-24: **5.0 baseline fixes** — Electron 44 e2e: `use-mock-keychain` under CUPNET_E2E (Keychain prompt blocked safeStorage), `getMainWindow()` e2e helper (onboarding window may come first), vitest worker crash from `omnibox-history.test.mjs` (better-sqlite3 built for Electron's ABI) → child-process probe + skip. **5.1 done** (accounts removed, localStorage purged on open). **5.2 done** (`getWireIdentity`, 2-brand grease permutation verified against Electron 34's Chromium 132 value, e2e id2 compares wire vs JS brands). **5.3 done** (`setGeoHint` wired into connect / disconnect / connect-direct / quick-connect; Identity window checkboxes + status line). **5.4 done**.

Progress 2026-09-25: **Simple screen rebuilt** after owner feedback ("Simple and Advanced look the same"): Simple is now a separate one-card editor (`#simple-editor`: provider chips, username/password, country, session, name, Save & Connect / Save / Test / Disconnect / Delete, Direct card, identity line); Advanced keeps the full editor. The old approach (hiding bits of the advanced form) is gone. **Identity self-check**: `cupnet://identity-check` page + MITM echo host `identity-check.cupnet` + "Verify in a tab" button; e2e id6b proves a custom `Chrome/153` UA is identical on the wire and in JS. Bug found by it: clearing the identity language left the old session Accept-Language in place (Electron never resets it) → identity-service now applies a locale-derived default (`defaultAcceptLanguage()`).

Progress 2026-09-25 (later): **"Browser ID" toolbar switch + fixes after owner testing.**
- Toolbar button `#identity-btn` ("Browser ID", badge `#identity-btn-current` with the short identity name, dot when
  non-engine) next to Cookies. The dropdown is a **native `Menu.popup`** (`identity:menu` → model + popup,
  `identity:menu-action` runs an entry: `{mode:'engine'}`, `{mode:'template',templateId}`, `{openManager:true|'custom'}`,
  `{check:true}`). Reason: the active tab is a WebContentsView painted above the shell HTML, so a DOM dropdown under the
  toolbar was invisible (the owner saw "nothing happens"); the e2e harness could still click it, hence the false green.
  Under `CUPNET_E2E=1` the handler returns the model without popping (e2e id6c/id6e drive `identityMenuAction`).
- "Custom User-Agent…" opens the Browser ID window already in Custom mode with the UA field focused
  (`open-identity-manager({mode})` → `createIdentityManagerWindow({mode})` → `#mode=custom` hash, or
  `identity-manager-command` when the window is already open). UI rename Browser Identity → **Browser ID** everywhere
  (window title, Tools menu, Proxy Manager labels, check page); code identifiers unchanged.
- Toolbar status kept the template list across `identity-changed` / `identity:set` (they carry no `templates`) — the menu
  lost its templates after the first switch (e2e id6c timeout).
- **New-tab CDP race fixed** (e2e id6b flake): a fresh tab started loading before `Emulation.setUserAgentOverride` — the
  logging path awaited `Network.enable` first, which only resolves once the renderer exists. Now
  `identity-service.applyToWebContents` attaches the debugger itself and queues all Emulation commands (no awaits in
  between) BEFORE `ensureCdpAttached`, and `tab-manager.createTab` starts the identity hook synchronously before the first
  `loadURL` (still never awaited). Probe: commands queued on a fresh WebContents are applied to the first document.
- `tests/unit/mitm-identity-wire.test.mjs`: request-integrity case — raw query characters (`| + / =`) and a binary POST
  body reach the origin byte-for-byte through MITM + Go worker (bot-protection validators embed such nonces).
- e2e id6d expectation fixed: an authenticated upstream is wrapped by the local proxy-chain anonymizer, so the
  identity-check echo reports a loopback hop on another port (never the credentials URL).
- Startup ordering bug from the concurrent omnibox/history session (`appCtx.modules.historyService` assigned before
  `createAppContext()` → unhandledRejection, no window on ANY profile) moved after `createAppContext()`.

Site check 2026-09-25 (owner request, appointment.blsspainrussia.ru via the owner's NodeMaven ES profile, sandboxed
userData copy): the login page is behind Qrator's bot protection (401 JS challenge → `/__qrator/validate` → 403 →
`/qrerror/403.html`). Result is the same 403 for the profile's Chrome/153 Windows identity, chrome-mac, custom
Chrome/153 macOS, es-ES + Europe/Madrid, engine mode, and a DevTools-style UA override. Everything on CupNet's side was
verified: egress ES, wire == JS (check page), byte-for-byte request integrity through MITM + Go worker (unit test).
Conclusion: the site's anti-bot layer rejects the embedded browser; not a CupNet identity/proxy defect. Working around a
third-party site's bot protection is out of scope for this project and was not pursued.

Progress 2026-09-25 (later): **JS fingerprint consistency patch** (`main-process/services/identity-consistency-script.js`).
Diagnosing the BLS/Qrator 403 showed our TLS+HTTP2 on the wire is clean Chrome, but the JS layer exposed two Electron
tells that contradict a spoofed identity: (1) `window.chrome` is an empty `{}` (real Chrome has app/csi/loadTimes/runtime),
(2) WebGL `UNMASKED_VENDOR/RENDERER` report the host GPU (Apple M2 Metal) even under a Windows UA. New module builds a
main-world IIFE injected by `preload-view.js` (via `identity-service.getNavigatorPatchScript`) that, for a Chromium-family
identity, fills `window.chrome` (functions report native source via a closure-scoped `Function.prototype.toString` shim, no
marker props leak) and — only when the claimed OS differs from the host — rewrites the two WebGL strings to a canonical GPU
for the claimed OS (Intel D3D11 for Windows, Mesa for Linux, Adreno for Android). Non-Chromium identities instead REMOVE
`window.chrome` and `navigator.userAgentData`. Engine mode fills `window.chrome` only (host GPU already consistent).
`cupnet://identity-check` gained `window.chrome` and `WebGL renderer` rows (the WebGL row flags a renderer that contradicts
the claimed OS). Tests: `tests/unit/identity-consistency-script.test.mjs` (vm-eval of the built script: window.chrome shape,
native toString, WebGL override per OS, non-Chromium removal); e2e id6b's `report.failed === []` now also exercises the patch
end-to-end (custom Windows UA on a mac host would fail the new WebGL-vs-UA row without the spoof). Verified live on the BLS
site: `window.chrome` now `[app,runtime,loadTimes,csi]` with native `loadTimes`, WebGL Intel-D3D11 under the Windows UA.

Outcome on appointment.blsspainrussia.ru (Qrator): STILL 403. Both Electron tells are gone, but `/__qrator/validate` keeps
rejecting — Qrator runs a deeper active challenge (JS proof-of-work + a ~50-field fingerprint payload + likely IP scoring)
that fingerprint consistency alone does not satisfy. The consistency patch is a genuine, always-on hardening win for other
sites; defeating this specific site's active bot-protection challenge is out of scope and was not pursued.

Progress 2026-09-25 (later): **Browser ID button now opens the window; identity name moved to the footer** (owner
feedback). The toolbar button `#identity-btn` shows only the label + a status dot (`#identity-btn-dot`) and, on click,
opens the Browser ID window directly — the native `Menu.popup` quick-switch was removed (identity switching lives in the
window). The active identity name is shown in the shell footer status bar (`#status-identity`, "ID: Chrome 154 · macOS",
click also opens the window). Removed: `identity:menu` / `identity:menu-action` IPC, `openIdentityMenu` / `identityMenuAction`
preload APIs, the `#identity-menu` DOM node and `.identity-menu*` / `.identity-current` CSS. e2e id6c/id6e rewritten to the
window-opening + footer behavior. All 11 identity e2e green.

Progress 2026-09-25 (later): **Fingerprint hardening round 2 — hardware fields + canvas/audio farbling**
(`identity-consistency-script.js`). Added to the main-world patch: (a) `navigator.deviceMemory` capped at 8 (real Chrome's
max; Electron leaked the raw host 16 — itself a tell) and `hardwareConcurrency` pinned to 8, both as native getters on
`Navigator.prototype` (applied to every Chromium identity, incl. engine); (b) Brave-style deterministic "farbling" of
canvas (`getImageData` / `toDataURL` / `toBlob`) and audio (`AnalyserNode.getFloatFrequencyData`,
`AudioBuffer.getChannelData`) using a seed derived from the identity (`seedFromString(userAgent)`) — the read-back hash is
STABLE for a given identity (a drifting fingerprint is itself a bot signal) but is not the host's raw hash, and differs
between identities. Farbling is applied only for a spoofing identity (template/custom), not engine mode. `toDataURL`/`toBlob`
route through an off-screen farbled copy so the original canvas is never mutated; `getChannelData` perturbs each buffer once
(WeakSet) so repeated reads stay identical. Perturbation is ±1 on ~0.5% of canvas bytes and ~1e-7 on audio — imperceptible,
no page breakage. `cupnet://identity-check` gained `deviceMemory/hardwareConcurrency` and `Canvas fingerprint` rows. Tests:
identity-consistency-script.test.mjs (13 cases: hardware getters, canvas determinism+seed-variance, toDataURL/toBlob no-throw,
audio stability). Verified live: Windows identity → deviceMemory 8, hardwareConcurrency 8, canvas stable, window.chrome.runtime
present. This is general engine hardening (helps on many sites); the hardest active challenges (Qrator PoW + IP scoring) are
still not guaranteed.

Progress 2026-09-25 (later): **Editing the identity while a proxy profile override is connected + auto-check**
(owner: "переподключение автоматом и сразу проверка / не выходит поменять useragent"). Problem: a connected proxy profile
with `identity_override=1` owns the effective identity, so changing the UA in the Browser ID window (which wrote the GLOBAL
identity) did nothing. Now: new IPC `identity:apply(patch,{autoCheck})` routes the edit to whatever governs the identity —
when `getSource()==='proxy-profile'` it persists the resolved identity onto the connected profile's columns
(`db.updateProxyProfileByIdAsync`) and re-applies it live via `setProxyOverride` (no manual reconnect), otherwise it writes
the global identity. Engine mode while overridden clears the profile's `identity_override` (falls back to global). The Browser
ID window now pre-fills its form from the *effective* identity when overridden (so you see/edit the profile's actual UA), keeps
the edited form after applying to a profile, and has a "Check after apply" toggle (default on) that opens/refreshes the
self-check tab — `identity:open-check` / the auto-check reuse ONE check tab (`identityCheckTabId`) instead of spawning a new
one each time. `getStatus` gained `proxyOverrideId`. e2e id6f covers it (connect an override profile → edit UA →
appliedTo=proxy-profile, effective + wire + JS + the persisted profile row all update, global untouched; engine clears the
override). preload `applyIdentity`.

Progress 2026-09-25 (later): **Clean separation — Proxy Manager = proxies only; identity = Browser ID only**
(owner: "прокси менеджер отвечает только за прокси, индитичность только через browserid"). Identity is now fully decoupled
from proxies: the whole **Identity tab** (per-profile UA / timezone / language / TLS templates / JA3 / force-HTTP1 /
`identity_override` checkbox / "Browser ID…" button) and the Simple-mode identity line were removed from the Proxy Manager
(`proxy-manager.html` + renderer). Connecting a proxy no longer changes identity: `global-proxy-connect.js` and
`quick-connect-ipc.js` always `setProxyOverride(null)`; `save-proxy-profile-full` writes no identity columns
(identity_override=0, UA/tz/lang null, tls_profile='chrome'). Identity is global and edited only in the Browser ID window;
the previous per-profile-override editing (id6f, identity:apply's proxy-profile branch, the window's formFromStatus override
branch) was reverted — `identity:apply` now always writes the global identity + optional auto-check. `followProxyGeo` (a
Browser ID opt-in that follows the proxy's egress country for timezone/language) stays — it is a Browser ID feature, not a
proxy setting. The identity-service `_proxyOverrideRow`/`setProxyOverride` machinery remains but is dormant for proxy
profiles (still used by per-tab launch/session profiles). e2e pm1/pm5 updated (identity tab asserted absent), id6f removed.

Progress 2026-09-25 (later): **Identity check can now verify THROUGH the proxy** (owner: "с прокси через file
проверить нельзя"). The self-check page proved wire==JS only against the local MITM echo (identity-check.cupnet), which the
MITM answers before egress — so it never actually went out through the upstream proxy, and its CSP (`connect-src 'self'
https://identity-check.cupnet`) blocked any external request. Added a "Through the proxy (real external request)" section:
CSP now also allows `https://httpbin.org https://ipinfo.io`; a button fetches httpbin.org/anything (echoes the received
headers + egress IP) and ipinfo.io/json (country/org) — these go tab→MITM→worker→upstream→site, the real path — and the
page shows the egress IP/country and the UA / sec-ch-ua / Accept-Language an external site actually received, with a verdict
comparing the received UA to navigator.userAgent. Verified live through a local upstream: httpbin echoed the rewritten
Chrome/154 macOS UA + sec-ch-ua and ipinfo returned the egress IP/country. The local (offline) check stays for wire==JS.
e2e id6b asserts the external section is present (its network call is not exercised in CI).

Progress 2026-09-25 (later): **Identity check completeness pass** (owner: "сделано не все, недоработки"). Two gaps
fixed on cupnet://identity-check: (1) the local WebGL row showed "JS only" instead of validating, because osFamilyOf could
not infer the OS from a GPU/driver string like "…Direct3D11…" — now it reads driver keywords (Direct3D→windows,
Metal/Apple M→macos, Adreno/Mali/OpenGL ES→android, Mesa/OpenGL→linux) so WebGL-vs-UA shows ✓/✗. (2) the "through the
proxy" section lacked the TLS fingerprint (the crux of bot detection) and a couple of Match cells only said "as received":
it now also fetches tls.peet.ws/api/all through the proxy and shows JA4 (with a Chrome-shape `t13d…h2` sanity check), JA3
hash and the HTTP/2 Akamai fingerprint, and it properly compares sec-ch-ua-platform and sec-ch-ua-mobile. CSP extended to
`https://tls.peet.ws`. Verified live through an upstream: JA4 `t13d1516h2_8daaf6152771_…`, Akamai `52d84b11…` (both standard
Chrome), all external rows ✓; local WebGL row now ✓ match.

Progress 2026-09-25 (later): **Fixed the "clientHints off breaks a Chrome identity" footgun** (owner: on a Mac
profile the check showed window.chrome absent + deviceMemory 16 + no sec-ch-ua/userAgentData for a chrome-mac identity).
Root cause: the identity had client hints turned OFF, and downstream code classified any hint-less identity as
non-Chromium — so it stripped window.chrome + navigator.userAgentData and skipped the deviceMemory cap, producing an
impossible "Chrome that isn't Chrome" (a strong bot signal). Real Chrome ALWAYS sends low-entropy sec-ch-ua and exposes
userAgentData, so client hints now follow the browser FAMILY, not a toggle: `resolveIdentity` derives clientHints from the
template/UA (populated for Chrome/Edge/Opera, null only for Firefox/Safari/iOS) and ignores the old `clientHints:false`
flag. The "Send client hints" checkbox was removed from the Browser ID window (it only produced an inconsistent identity).
Verified live: a chrome-mac identity that previously failed now shows consistent==true (sec-ch-ua + userAgentData present,
window.chrome filled, deviceMemory 8). Unit tests updated (a Chromium identity always carries hints + CDP metadata; a
non-Chromium one never does). Also made the external check resilient: httpbin/ipinfo/tls.peet.ws are fetched independently,
so an httpbin 502 no longer kills the whole external check — egress IP + UA + TLS still render from the others.

Progress 2026-09-27: **Proxy Manager UX — removed the confusing Simple/Advanced toggle** (owner: toggling
showed no visible difference — "как дурка"). The global mode switch is gone. The editor is now content-driven: a provider
profile opens the guided card (chips + creds + country + session); a manual / static / option-rich profile opens the full
form automatically (`openEditor` picks the mode from `editorModeForProfile`). A new profile opens the guided card, with an
explicit in-card link **"Have a proxy URL or a list to import? Open advanced editor →"** (`#se-advanced-new` →
`openNewEditor({advanced:true})`, no save prompt). Profile-manager chrome (import list, provider/country filters, MITM stats)
is no longer `.adv-only` — always available. `applyEditorMode`/`#editor-mode-seg`/the persisted `proxyManager.editorMode`
pref are gone; `setEditorMode` just flips the body class + provider select. e2e pm1/pm5/pm7 rewritten; all 7 proxy-manager-ui
tests pass; full vitest green.

### Deferred / follow-ups
- `azuretls-go/profiles.go` is the only remaining copy of the UA strings outside the catalog; `tests/unit/browser-identity-catalog.test.mjs` guards it.
- Chrome template major (154) vs Electron 44 engine (152; Chrome stable is 155 on 2026-09-25): consider deriving the Chrome template major from `process.versions.chrome + N` if the mismatch ever matters.
