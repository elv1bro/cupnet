# azuretls-go-worker

Standalone **Go** process that implements the same **NDJSON stdin/stdout protocol** as [`azure-tls-worker.js`](../azure-tls-worker.js), using [`github.com/Noooste/azuretls-client`](https://github.com/Noooste/azuretls-client) directly (no Node `ffi-napi`).

## Why

Isolates the Go TLS/HTTP stack from the Electron/Node process to avoid FFI/runtime interaction issues (e.g. connection `EOF` on some hosts).

## Build

```bash
npm run build:go
# or
cd azuretls-go && ./build.sh
```

Requires **Go 1.24+** (toolchain auto-download is fine: `GOTOOLCHAIN=auto`). Outputs per-platform binaries under `azuretls-go/bin/`.

## Runtime

[`mitm-proxy.js`](../mitm-proxy.js) spawns the matching binary from `azuretls-go/bin/` or `resources/azuretls-go/bin/` when present.

| Variable | Effect |
|----------|--------|
| `CUPNET_TLS_CHROME_UPSTREAM_PRESET=1` | Kill switch: the `chrome` profile uses the azuretls-client Chrome preset instead of CupNet's own Chrome 153 ClientHello (see below) |
| `CUPNET_WORKER_FFI_CONCURRENCY`, `CUPNET_WORKER_CLIENT_CACHE_MAX`, `CUPNET_TIMEOUT_UPSTREAM_REQUEST_MS` | Pool / timeout limits (shared names with `network-policy.js`). Pools are per browser+proxy+ja3+tab+origin: the concurrency budget (default 12) is per origin, the cache max (default 512) caps idle pools |
| `CUPNET_WORKER_NO_WATCHDOG=1` | Do not exit when the parent process dies (tests) |

The Go worker is the only upstream TLS backend since 2026-09-24 (the Node/FFI worker was removed).

## TLS fingerprint

`profiles.go` → `chromeClientHelloSpec()` is the ClientHello for the `chrome` profile: the azuretls-client
Chrome preset plus the two things real Chrome 153 adds — the trust-anchor-IDs extension 51764 (payload
captured byte-for-byte from Chrome 153.0.8010.53) and a GREASE + ML-DSA-first `signature_algorithms`.
JA4 through the MITM equals real Chrome 153 (`t13d1517h2_8daaf6152771_cb7bf5808d99`). Verify with
`go test ./...` (offline), `CUPNET_GO_NET_TESTS=1 go test -run TestChromeSpecJA4Live ./...` (live) and
`node scripts/tls-fingerprint-compare.mjs` from the repo root. Re-capture the constants after every Chrome
major. Other profiles (edge/opera/firefox/safari/ios) still use the library presets.

## Module

- `go.mod` pins `azuretls-client` v1.13.2 and `utls` v1.3.20 (Go 1.24 toolchain in CI).
