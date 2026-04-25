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
| `CUPNET_USE_GO_WORKER=1` | Optional explicit signal to use Go when a binary is present (default is already: use Go if `azuretls-go/bin/*` exists) |
| `CUPNET_USE_GO_WORKER=0` | Force Node `azure-tls-worker.js` (FFI) |
| `CUPNET_USE_NODE_WORKER=1` | Same as above |

If no Go binary is found, the app falls back to the Node worker (unchanged).

## FFI / optionalDependencies

The Node+FFI path (`azure-tls-worker.js`, `azuretls/lib/*.dylib`) is **kept** for `CUPNET_AZURETLS_IN_PROCESS=1` and when no Go binary is packaged. Removing `@2060.io/ffi-napi` etc. is deferred until in-process AzureTLS is dropped.

## Module

- `go.mod` pins `azuretls-client` v1.11.x (compatible with Go 1.24 toolchain in CI).
