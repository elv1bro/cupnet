# CupNet mini

CupNet's MITM + AzureTLS Go worker without Electron. Real Google Chrome is launched through it;
everything Chrome sends goes out with the CupNet TLS/H2 fingerprint, and HTML responses can be
modified with `inject` rules.

```
Chrome ──CONNECT──▶ MITM 127.0.0.1:8877 ──▶ AzureTLS worker ──▶ (upstream proxy) ──▶ site
                       │
                       └▶ SessionLog (sessions/<id>.jsonl + in-memory index) ◀── UI 127.0.0.1:8878
```

## Usage

Plain Node ≥ 20. mini uses only Node built-ins, so it needs no `npm install`, no Electron and no
better-sqlite3. The Go worker binary must exist in `azuretls-go/bin/` (`npm run build:go:local`).

```bash
npm run mini -- start --window          # proxy + UI, and open the CupNet mini window
npm run mini -- start --window --chrome # … and launch the proxied Chrome as well
npm run mini -- start --url https://example.com --chrome
npm run mini -- window                  # another CupNet mini window (mini must be running)
npm run mini -- chrome                  # another proxied Chrome window (mini must be running)
npm run mini -- ca                      # CA path, SHA-256, SPKI, OS trust commands
```

The **CupNet mini window** is the UI in a Chrome app window (`--app=`), on its own unproxied
profile (`<data>/ui-profile`). It is not the proxied browser. `start --window` when mini is
already running just opens another window. The window's **Quit** button stops mini, the same as
Ctrl+C.

## Standalone app (separate from the Electron project)

```bash
npm run pack:mini                  # → dist/CupNet mini.app (macOS) or dist/cupnet-mini/
npm run pack:mini -- --dir         # plain folder on macOS too
npm run pack:mini -- --no-node     # don't bundle Node (uses `node` on PATH)
npm run pack:mini -- --all-platforms   # every worker binary in azuretls-go/bin
```

The pack holds only what mini requires, about 25 files found by walking `require()` from
`mini/cupnet-mini.js` (`db.js` is left out). It also holds the Go worker for this platform,
this Node binary in `runtime/`, and launchers: `cupnet-mini` / `cupnet-mini.cmd`. It doesn't
need the repo or node_modules. Double-clicking `CupNet mini.app` runs `start --window` and logs
to `<data>/mini.log`. The app has no Dock icon, so use the window's Quit button. The CLI inside
it: `"CupNet mini.app/Contents/Resources/cupnet-mini/cupnet-mini" start --chrome`. Data stays in
`~/.cupnet-mini` (or `CUPNET_MINI_DIR`), outside the bundle.

Options: `--data DIR` (default `~/.cupnet-mini`, or `CUPNET_MINI_DIR`), `--port 8877`,
`--ui-port 8878`, `--browser chrome_120`, `--upstream URL` (or `CUPNET_MINI_UPSTREAM`),
`--trust spki|system`, `--chrome-bin PATH`.

## Trust modes

- `spki` (default): Chrome gets `--ignore-certificate-errors-spki-list=<CA SPKI>` and its own
  `--user-data-dir`. Nothing is installed in the OS; only this Chrome profile trusts the CA.
  The MITM sends leaf + CA (`sendCaChain`) so Chrome can match the CA's SPKI in the chain.
- `system`: you install `ca/ca-cert.pem` into the OS trust store yourself (`npm run mini -- ca`
  prints the commands). Use it for tools other than the launched Chrome.

The profile sets `webrtc.ip_handling_policy=disable_non_proxied_udp` so WebRTC cannot leak
around the proxy.

## Inject rules

An intercept rule of type `inject` adds `<script>` tags to HTML document responses
(`Sec-Fetch-Dest: document|iframe|…`, `text/html`, 2xx). Params:
`{ "source": "...", "position": "head" | "body-end" }`.

- The body is edited as raw bytes, so any ASCII-compatible charset survives. Script sources are
  escaped to ASCII.
- Each tag gets a fresh nonce. The CSP (header and `<meta http-equiv>`) is patched to allow it,
  unless the policy already allows inline scripts via `'unsafe-inline'` without a nonce/hash.
- `Content-Encoding`, `Content-Length`, `ETag` and `Content-MD5` are dropped from the modified
  response. Inject rules buffer the response (no streaming for documents).

Pages can report back with a same-origin request:
`navigator.sendBeacon('/__cupnet/event', JSON.stringify({...}))`. The MITM answers it locally
(204) and never forwards it. The endpoint is write-only, and those requests are not logged as traffic.

## UI

`http://127.0.0.1:8878/`, or the CupNet mini window.

- **Traffic**: a live, virtualized table (only visible rows are in the DOM). It handles hundreds
  of thousands of entries: a saved 200k-entry, 120 MB session opens in under a second, and
  filtering takes about 15 ms.
  - The live session streams over `/api/log/stream`. Saved sessions are opened from the session
    picker.
  - Search syntax: words, `-exclude`, `status:4xx`, `method:post`, `type:fetch`,
    `mime:json`, `host:example`. There are also kind, method, type and status selects and
    Follow (auto-scroll). Keyboard: ↑/↓, Esc.
  - The detail pane has Headers, Request, Response and JSON views. Images, audio and video show a
    preview. Bodies over 2 MB show a preview with **Load full body**. Every body can be downloaded.
  - **HAR** exports the rows the current filter shows (the whole session when no filter is
    set). From the detail pane any request can go to Repeater, be copied as curl, or seed a
    Mock or Pause rule.
- **Proxies**: the upstream proxy manager.
  - Profiles come from a provider preset (decodo, …) or a custom template such as
    `http://user-{SID}:{PASSWORD}@host:{RAND:10001-10100}`.
    - `{SID}` and `{RAND:a-b}` are rolled once and pinned, giving a sticky exit. **New IP**
      re-rolls them.
    - User variables are `{NAME}`.
    - The password is stored encrypted in `proxies.json` with `proxies.key` and is never sent
      back to the UI (`•••`).
  - Supported schemes: http, https, socks4(a), socks5(h).
  - Features: **Test** and **Test all** (exit IP, country, latency through the AzureTLS worker),
    **Connect**, **Disconnect**, filters (provider, country, status, group, search) and bulk
    **Import** (one proxy per line, dry-run preview).
  - **Kill switch**: while no proxy is connected, nothing leaves directly. Chrome gets 502 and
    Repeater gets 409.
  - A profile pointing at mini's own proxy port is refused, because it would loop.
- **IP monitor**: checks the exit IP every 15 s (5 s to 1 h, or off) and keeps a history of
  every change.
  - Each check is one small HTTPS request through the current connection (direct, CLI
    upstream or the connected profile) on a fresh tunnel. The worker gets `forceHttp1` and
    `Connection: close`, so a rotating proxy shows its real rotation. The endpoints are ipify,
    then checkip.amazonaws.com, then icanhazip. The location comes from ipinfo, or ipwho as a
    fallback, once per new IP, through the same connection.
  - At 15 s this is about 5,760 tiny requests a day. The checks are not written to the
    traffic log.
  - Event types:
    - `start`: first IP of a run.
    - `switch`: you changed the connection.
    - `change`: the IP changed by itself.
    - `error`: first failed check of an outage. `recovered` is logged when checks work again.
    - `blocked`: the kill switch is on and no proxy is connected; checks are skipped.
    - `stop`: the app quit or the monitor was turned off.
  - Changes and switches carry `heldMs`, how long the previous IP lasted.
  - The page has the current IP with how long it has held, stat tiles, a timeline (1 h, 6 h,
    24 h, 7 d) with one colour per IP, and the history table with a filter, search and CSV export.
  - A `change` or `error` raises a toast unless the profile is rotating.
  - Events are also written to the session log as kind `ip`, which the Traffic kind select can
    show. Proxy URLs and credentials are never stored in the history.
- **Compare**: two requests side by side, from the same session or from different ones.
  - Ways to pick them:
    - Cmd/Ctrl-click a second row in Traffic.
    - **Pin as A**, then **Compare** in the detail pane.
    - Type `#seq` (or `session:seq`) for A and B.
    - **Previous same** compares an entry with the last earlier request to the same method and URL.
  - Sections: overview, query string, request headers (including a header **order** view, which
    shows moved headers), request cookies, request body, response headers, Set-Cookie and
    response body. A sticky row of chips jumps to each section and says whether it differs.
  - Changed values have the differing part highlighted.
  - Options: **Only differences**, and **Ignore volatile headers** (Date, ETag, tracing ids, …).
  - Body views: JSON bodies get a structural diff (path, old and new value) or a line diff. Form
    bodies get a field diff or a line diff. Anything else gets a line diff with collapsed
    unchanged runs. Binary bodies, and bodies over 8 MB, are compared by SHA-256.
  - The diff logic is in `compare-diff.js`, shared by the UI and the unit tests.
- **Cookies**: a cookie manager that works on the MITM path only. It needs no CDP, no extension
  and nothing in the page.
  - Tracking: `Set-Cookie` gives each cookie's attributes, and the `Cookie` request header shows
    what Chrome really sends. A cookie seen only in requests is marked *inferred*. Each cookie
    keeps a short value history, with set and sent counts.
  - Layout: sites on the left, a filterable table with a Live / Deleted / All filter, and a
    modal editor (name, value, domain or host-only, path, expiry, Secure, HttpOnly,
    Partitioned, SameSite).
  - **Changes for Chrome**: set, delete and clear-site operations are queued. Each one is
    injected into the next first-party response from a matching host, as `Set-Cookie` or as
    `Clear-Site-Data: "cookies"`, so the change lands in Chrome's own cookie store on the next
    page load. Pending operations expire after 1 h; **Open site** loads the site in the proxied
    Chrome.
  - **Wire rules** rewrite traffic and leave Chrome's store untouched:
    - `pin`: send a fixed value upstream, and add the cookie if Chrome has none.
    - `strip`: drop a cookie, or `*` for all of them, from requests.
    - `block`: drop matching `Set-Cookie` lines before Chrome sees them.
    Rules can be switched on and off, and count their hits.
  - Bulk actions: delete in Chrome, export or forget the selected cookies.
  - **Import** takes a JSON array (or `{"cookies": [...]}`, as browser cookie-editor extensions export) or Netscape `cookies.txt`, with a
    dry-run preview. **Export** writes JSON or Netscape for the selection, a site, or everything.
- **Repeater**: edit and resend any request (method, URL, headers, body) through the same worker
  and upstream. Import from curl; generate code as curl, fetch, axios, Python requests, Go or PHP.
  Each send is logged with type `repeater`. Cmd/Ctrl+Enter sends.
- **Rules**: a structured form per rule type (`inject`, `mock`, `block`, `modifyHeaders`,
  `script`, `pause`). A rule matches on URL pattern, methods, headers and body, and has a
  priority. Rules show hit counters.
- **Breakpoints**: a rule with **Pause** holds matching requests. Edit method, URL, headers and
  body, then **Forward** or **Block**.
- **Settings**: TLS profile (`--browser` overrides it for one run), TLS-passthrough domains, CORS
  bypass, force HTTP/1.1, IP monitor on/off and interval. Stored in `settings.json`.
- **Sessions**: open, download JSONL or HAR, seal.

## API

Every `/api/*` route needs the `X-CupNet-Token` header (`<data>/ui-token`). A non-loopback
`Host` gets 421, which blocks DNS rebinding. The window is opened with a one-time launch code
(`#c=…`, valid for 60 s). The page trades it via `POST /api/auth/exchange` with header
`X-CupNet-Code`, so the token never appears in Chrome's command line.

- `GET /api/status`
- `GET /api/log/stream?after=SEQ`: NDJSON summaries, the backlog first and then live entries.
  The connection stays open.
- `GET /api/log?session=ID&after=SEQ&limit=N`: summaries. Without `session`, the current session.
- `GET /api/log/:seq?session=ID`: the full entry. Bodies are cut to a 2 MB preview, and
  `*BodyTruncated` says whether they were.
- `GET /api/log/:seq/body/request|response?session=ID`: the raw body bytes. They are always
  served as `application/octet-stream` with `Content-Disposition: attachment` and
  `CSP: sandbox`. The original type is in `X-CupNet-Content-Type`.
- `GET|POST /api/rules`, `DELETE /api/rules/:id`
- Proxies:
  - `GET|POST /api/proxies`, `GET /api/proxies/providers`, `POST /api/proxies/preview`,
    `POST /api/proxies/import` (`{text, group, dryRun}`).
  - `POST /api/proxies/test` (`{ids}`, or all), `/disconnect`, `/kill-switch` (`{enabled}`),
    `/new-ip`.
  - `PUT|DELETE /api/proxies/:id`, `POST /api/proxies/:id/duplicate|test|connect|new-ip`.
  - `GET /api/egress[?force=1]`. While the IP monitor is on, `force=1` runs a monitor check.
- IP monitor:
  - `GET /api/ip-history?limit=N&after=ID`: `{state, events}`, newest first. `state.epoch`
    changes when the history is reloaded or cleared; refetch everything when it does.
  - `POST /api/ip-history/check`: check now.
  - `DELETE /api/ip-history`: clear the history.
  - `/api/status` carries the monitor summary as `ipWatch`.
- Cookies (every route returns the updated snapshot `{rev, epoch, cookies, pending, overrides, list, ops}`, where `overrides` here is the rule list):
  - `GET /api/cookies`; `DELETE /api/cookies` (`{ids}`, `{domain}` or `{all: true}`) forgets the
    tracked copies, and Chrome keeps them.
  - `POST /api/cookies/ops` (`{op: 'set', cookie}`, `{op: 'delete', ids | cookie}`,
    `{op: 'clear', domain}`, `{op: 'clear-done'}`); `DELETE /api/cookies/ops/:id` cancels a
    pending operation.
  - `POST /api/cookies/overrides`, `POST|DELETE /api/cookies/overrides/:id`: wire rules.
  - `POST /api/cookies/import` (`{text, dryRun}`), `GET /api/cookies/export?format=json|netscape&ids=…&domain=…`.
  - `/api/status` carries `cookies: {rev, epoch, cookies, pending, overrides}` (counts), so the UI reloads only on change.
- `GET|POST /api/settings`
- `POST /api/replay` (`{method, url, headers: [[k, v]], body}`). Only http(s) is accepted. It
  returns 409 while the kill switch blocks egress.
- `GET /api/breakpoints`, `POST /api/breakpoints/:id` (`{action: 'forward'|'block', method, url, headers, body}`)
- `POST /api/chrome`, `POST /api/window`, `POST /api/quit`
- Sessions:
  - `GET /api/sessions`, `GET /api/sessions/:id` (JSONL download).
  - `GET /api/sessions/:id/har[?seqs=1-20,25]`: requests only. Each entry has `_cupnetSeq`.
  - `POST /api/sessions/:id/seal`, `GET /api/sessions/:id/key`, `GET /api/sessions/:id/sealed`.

## Data

`<data>/` is created with mode 0700 and holds:

- `ca/`: CA key and cert.
- `rules.json`: intercept rules. Rules from an old `cupnet-mini.db` are imported once, if
  `node:sqlite` is available.
- `proxies.json` + `proxies.key`: proxy profiles, the active profile and the kill switch.
  Passwords are AES-256-GCM encrypted with the key file.
- `settings.json`: TLS profile, passthrough domains, CORS, force HTTP/1.1, `ipWatch`,
  `ipWatchSec`.
- `ip-history.jsonl`: the IP monitor history (mode 0600, append-only). The newest 5,000 events
  are kept, and the file is compacted on load.
- `cookies.json`: tracked cookies, wire rules and queued Chrome operations (mode 0600, because it
  holds cookie values). Up to 5,000 cookies, 20 history entries each.
- `sessions/<sessionId>.jsonl`: one file per run, one JSON line per entry.
- `keys/`, `sealed/`
- `chrome-profile/`: the proxied Chrome.
- `ui-profile/`: the CupNet mini window.
- `ui-token`, and `mini.log` when started from the .app.

Every request is written **in full**: headers, and request and response bodies, binary ones as
`__b64__:` base64, video and audio included. Nothing is truncated. The only limits are these
guards against a runaway response, both set before `start`:

- `CUPNET_LOG_BODY_MAX_BYTES`: the largest body kept in memory for the log. The default is
  256 MB.
- `CUPNET_LOG_MEDIA_BODIES=0`: skip video and audio bodies.

Each line begins with its summary fields (seq, ts, kind, method, url, status, type, duration,
mime, reqSize, resSize). Memory holds only those, plus each line's file offset. A saved session
is indexed by reading just the first 64 KB of each line, and entries are read back from the
file on demand.

## Sealed sessions (one key per session)

```bash
npm run mini -- seal SESSION_ID          # or --all
npm run mini -- open path/to/<id>.cupkey # decrypt to stdout (finds <id>.cupsess next to it or in sealed/)
```

- When a session starts it gets its own random 256-bit key: `keys/<id>.cupkey`.
  `id = sha256("cupnet-session-id:v1" ‖ key)[:16]` in hex. It depends only on the key, so it never
  changes while the session grows, and it reveals nothing about the key.
- `sealed/<id>.cupsess` is the session encrypted with AES-256-GCM. It is written in 1 MB frames,
  and each frame's AAD is `<id>:<index>`. Sealing again rewrites the same file. The session is
  sealed automatically on `stop`. The UI's Sessions tab has a **Seal** button that downloads both
  files.
- **The key file is the whole secret.** Whoever has `<id>.cupkey` can find `<id>.cupsess` (same
  name) and read everything. Without the key, the `.cupsess` is opaque, so it can sit on any
  static host.
- `mini/viewer.html` opens the session in the browser with WebCrypto, and nothing is uploaded. Host it with
  a `sealed/` folder next to it (or point it at one with `?base=URL`) and drop in only the
  `.cupkey`. Or open the page locally and drop in both files.
