# AzureTLS Go worker binaries

Place platform-specific binaries here (same names as in `build.sh`).

Build locally (current OS only, fast):

```bash
npm run build:go:local
```

All platforms (release):

```bash
cd azuretls-go
chmod +x build.sh
./build.sh
```

Or from the repo root: `npm run build:go`

CupNet prefers this worker over the Node+FFI `azure-tls-worker.js` when a matching binary exists. Disable with `CUPNET_USE_GO_WORKER=0` or force Node with `CUPNET_USE_NODE_WORKER=1`.
