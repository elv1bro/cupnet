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
`DELETE /api/rules/:id`, `POST /api/chrome`, `GET /api/sessions`.

## Data

`<data>/ca/` (CA key + cert), `cupnet-mini.db` (rules), `sessions/<id>.jsonl` (one file per run,
with bodies truncated), `chrome-profile/`, `ui-token`. The directory is created with mode 0700.
Session files hold cookies and auth headers in clear text, so treat them as secrets.
