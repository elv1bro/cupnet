# CupNet mini

CupNet's MITM + AzureTLS Go worker without Electron. Real Google Chrome is launched through it;
everything Chrome sends goes out with the CupNet TLS/H2 fingerprint, and HTML responses can be
modified with `inject` rules.

```
Chrome ──CONNECT──▶ MITM 127.0.0.1:8877 ──▶ AzureTLS worker ──▶ (upstream proxy) ──▶ site
                       │
                       └▶ SessionLog (ring + sessions/<id>.jsonl) ◀── UI 127.0.0.1:8878
```

## Usage

```bash
npm run mini -- ca                      # CA path, SHA-256, SPKI, OS trust commands
npm run mini -- start --chrome          # proxy + UI, then launch Chrome
npm run mini -- start --url https://example.com --chrome
npm run mini -- chrome                  # another Chrome window (proxy must be running)
```

Options: `--data DIR` (default `~/.cupnet-mini`, or `CUPNET_MINI_DIR`), `--port 8877`,
`--ui-port 8878`, `--browser chrome_120`, `--upstream URL` (or `CUPNET_MINI_UPSTREAM`),
`--trust spki|system`, `--chrome-bin PATH`.

`scripts/run-mini.cjs` runs the CLI on Electron's Node (`ELECTRON_RUN_AS_NODE=1`) so
`better-sqlite3` loads on the ABI it was built for. The Go worker binary must exist in
`azuretls-go/bin/`.

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

## UI / API

`http://127.0.0.1:8878/`. The API requires the `X-CupNet-Token` header (the token is in
`<data>/ui-token`, and the UI page has it embedded). Requests with a non-loopback `Host` get 421,
which blocks DNS rebinding. Routes: `GET /api/status`, `GET /api/log`, `GET|POST /api/rules`,
`DELETE /api/rules/:id`, `POST /api/chrome`, `GET /api/sessions`, `GET /api/sessions/:id`,
`POST /api/sessions/:id/seal`, `GET /api/sessions/:id/key`, `GET /api/sessions/:id/sealed`.

## Data

`<data>/ca/` (CA key + cert), `cupnet-mini.db` (rules), `sessions/<sessionId>.jsonl` (one file per
run, everything as captured; bodies over 512 KB are truncated), `keys/`, `sealed/`,
`chrome-profile/`, `ui-token`. The directory is created with mode 0700.

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
