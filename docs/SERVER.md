# CupNet mini — server deployment (loopback + SSH tunnel)

CupNet mini runs headless on a Linux server for a few trusted users. **Nothing is
exposed on the network:** the MITM proxy and the control UI both bind to `127.0.0.1`
only (`mitm-proxy.js`, `mini/ui-server.js`). Each user reaches the proxy by
forwarding its port over their own SSH connection and pointing a browser at their
local `127.0.0.1`. No proxy password, no public listener, no reverse proxy.

```
  user's browser ──▶ 127.0.0.1:8877 ──[ ssh -L tunnel ]──▶ server 127.0.0.1:8877
                                                             │ CupNet mini MITM
                                                             ▼ AzureTLS Go worker
                                                      (optional upstream proxy) ──▶ origin
```

Target reference host: **pink110** (`root@65.108.193.229`, Ubuntu 22.04, x86-64,
Node ≥ 22 already installed, no Go toolchain).

## What gets deployed

`scripts/server/deploy.sh` ships a self-contained tree built by
`scripts/pack-mini.cjs` — mini uses only Node built-ins, so there is **no
`npm ci`, no `node_modules`, and no Electron** on the server. The tree contains:

- `app/` — the exact files mini requires (static `require()` walk from
  `mini/cupnet-mini.js`), plus `mini/` assets and the Go worker binaries under
  `app/azuretls-go/bin/` (the Linux worker is `azuretls-worker-linux-amd64`).
- `cupnet-mini`, `cupnet-mini.cmd` — CLI launchers (unused by systemd; the unit
  calls `node` directly).

Node is **not** bundled (`--no-node`) because the packed tree is built on a Mac;
the server uses its own `node` on disk, resolved by absolute path at deploy time.

## Deploy / update

Run from a checkout on a machine that has Go (to cross-compile the Linux worker)
and SSH access to the server:

```bash
scripts/server/deploy.sh --host root@65.108.193.229
```

Options: `--app-dir` (default `/opt/cupnet-mini`), `--data-dir` (default
`/var/lib/cupnet-mini`, the systemd `StateDirectory`), `--proxy-port` (`8877`),
`--ui-port` (`8878`), `--upstream URL` (NodeMaven etc.; written to a `0600`
`/etc/cupnet-mini.env` so it never appears in `argv` or logs), and `--yes` to skip
the confirmation prompt. The script builds the worker if missing, packs, rsyncs,
renders and installs the systemd unit, (re)starts the service, and writes
`<app-dir>/CONNECT.txt`. Re-running it is the upgrade path (`rsync --delete`).

## systemd

`scripts/server/cupnet-mini.service.in` is the template; deploy renders it to
`/etc/systemd/system/cupnet-mini.service`. It runs under a transient
`DynamicUser` with `StateDirectory=cupnet-mini`, `ProtectSystem=strict`,
`ProtectHome`, `PrivateTmp`, and `NoNewPrivileges`. There are no `IPAddress*`
filters: the proxy needs outbound network, and the loopback-only guarantee comes
from the bind address in code, not from systemd.

```bash
systemctl status cupnet-mini
journalctl -u cupnet-mini -n 50 --no-pager      # the UI: line holds the tokenised URL
systemctl restart cupnet-mini
```

## How a user connects

Give each user the output of `cupnet-mini connect` (also saved as
`<app-dir>/CONNECT.txt`):

```bash
ssh root@65.108.193.229 cat /opt/cupnet-mini/CONNECT.txt
```

It walks them through four steps:

1. **Proxy tunnel** — `ssh -N -L 8877:127.0.0.1:8877 root@<host>` (keep it open).
2. **Point the browser at the proxy** — `127.0.0.1:8877` for HTTP and HTTPS, or
   launch a throwaway Chrome profile with `--proxy-server=127.0.0.1:8877`.
3. **Trust the CupNet CA once** — `scp` `ca/ca-cert.pem` from the server, verify
   the printed SHA-256, then install it (macOS `security add-trusted-cert`, Linux
   `update-ca-certificates`, Windows `certutil -addstore -f Root`, or Firefox's
   certificate import). Without this, HTTPS pages fail the certificate check.
4. **Admin only** — the control UI over its own tunnel,
   `ssh -N -L 8878:127.0.0.1:8878 root@<host>`, then open the tokenised
   `http://127.0.0.1:8878/#t=…` URL from `journalctl -u cupnet-mini`.

The UI token lives in `<data-dir>/ui-token` and every API request is checked
against it; the proxy CA private key lives in `<data-dir>/ca/`. Both stay on the
server, reachable only over the SSH tunnels above.

## Ops notes

- **Upgrade:** re-run `deploy.sh`; it re-syncs and restarts.
- **Logs / sessions / rules:** under `<data-dir>` (`/var/lib/cupnet-mini`).
- **Stop:** `systemctl stop cupnet-mini` — mini seals the current session on
  `SIGTERM` before exiting.
- **Worker binary:** if the service logs "Go worker not found", the Linux worker
  did not ship; rebuild with `GOOS=linux GOARCH=amd64` under `azuretls-go/` and
  redeploy.
