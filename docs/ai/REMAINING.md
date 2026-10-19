# Remaining work (as of 2026-09-28, after the follow-through pass)

## Done in this pass

- Activity Monitor stack traces: `STORAGE_ACTIVITY_SCRIPT` restored (`main-process/services/storage-activity.js`). The e2e still needs a GUI run.
- A-027: MITM start/restart is single-flight (`main-process/services/mitm-lifecycle.js`).
- A-037: proxy status payload includes `egressBlocked` / `egressBlockReason`; the toolbar pill, status bar, and new-tab widget show **Blocked**.
- Main-side IPC sender guards on the privileged channels (cookies, direct IP, proxy connect/profiles, ext-proxy, tab proxy/isolate, navigate-to, ui prefs). Trusted shell windows and internal `file:` pages are allowed; website tabs are rejected.
- `get-direct-ip` is single-flight with a 20s timeout.
- Script-created `about:blank` iframes get `window.chrome` (`loadTimes` / `csi` / `app`) when the parent identity patch runs.
- omni-3 (Cmd+K) shows the window with `showInactive()` before the shortcut, so quiet e2e can deliver `before-input-event`.

## qrator.net

- The installed app the user runs (`~/Desktop/CupNet.app`) still fails. Session 2026-09-28 09:49Z: `GET /` 401, `POST /__qrator/validate` **403**, then `GET /qrerror/403.html` 403. That package does not contain the share polyfill, permission rewrite, or Privacy Sandbox flags.
- A separate launch of this working tree (fresh profile, `CUPNET_E2E=1`) got `POST /__qrator/validate` **200** and the real homepage. That result does not apply to the Desktop build.

## Differences from Google Chrome 153 (same machine)

Closed in this pass:

- `navigator.share` / `navigator.canShare` are present. `share()` rejects `AbortError` (Electron has no share sheet).
- Shared Storage / Protected Audience are off unless `CUPNET_PRIVACY_SANDBOX=1` (`disable-features` in `runtime-early-flags.js`). Live check: `window.sharedStorage` is `undefined`.
- Undecided `permissions.query` reports `prompt` and `Notification.permission` reports `default`. A recorded denial stays `denied`. The check handler still returns false until the user allows (A-188).
- Window chrome: toolbar 48px, macOS `hiddenInset`. Live `outerHeight - innerHeight` is 143px (was 183; Chrome is 87). The status bar (26px) and tab strip remain.

Still engine or OS:

- No "Google …" network speech-synthesis voices. Those are a Google Chrome network service, not a flag.
- No Widevine. The CDM in Google Chrome is signed for that binary; official Electron 44 has no Widevine API.
- Engine is Chromium 152 (Electron 44.4.5, current release). `HTMLCameraElement` / `local-network-access` and the UA major stay on 152 until Electron ships 153.
- `navigator.languages` stays the OS list (`ru, ru-BY, en-BY, pl-BY`) so page, iframe, worker, and the Accept-Language wire match. The compared Chrome profile's `ru-RU, ru, en-US, en` is that profile's setting, not the OS list.

## Security / correctness

- External Proxy: loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) skips Basic auth. Any other address still needs the login and password. The listener stays on `127.0.0.1`.

## Tests

- `tests/e2e/activity-monitor.e2e.spec.js` — script is restored; not re-run here (needs the Electron GUI).
- `tests/e2e/captcha-demo-detection.e2e.spec.js` — Playwright Chromium 153 (build 1243) is installed. The spec itself was not run (it hits public 2Captcha demos).
- `tests/e2e/omnibox.e2e.spec.js` omni-3 — showInactive added; not re-run here (needs the Electron GUI).
