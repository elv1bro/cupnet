#!/usr/bin/env bash
# Deploy CupNet mini to a loopback-only server (e.g. pink110) over SSH.
#
#   scripts/server/deploy.sh [--host USER@HOST] [--app-dir DIR] [--data-dir DIR]
#                            [--proxy-port N] [--ui-port N] [--upstream URL] [--yes]
#
# What it does, all over SSH (no inbound ports opened on the server):
#   1. cross-compiles the Linux worker if azuretls-go/bin/azuretls-worker-linux-amd64 is missing;
#   2. packs mini standalone (scripts/pack-mini.cjs --dir --no-node --all-platforms);
#   3. rsyncs the tree to <app-dir> on the server;
#   4. renders + installs the systemd unit (node resolved by absolute path on the server);
#   5. enables and (re)starts the cupnet-mini service;
#   6. writes <app-dir>/CONNECT.txt (the end-user SSH-tunnel + CA-trust instructions) and prints it.
#
# The server's root shell may be fish, so every remote command block is forced through bash.
set -euo pipefail

HOST="root@65.108.193.229"
APP_DIR="/opt/cupnet-mini"
DATA_DIR="/var/lib/cupnet-mini"
PROXY_PORT="8877"
UI_PORT="8878"
UPSTREAM=""
ASSUME_YES="0"

while [ $# -gt 0 ]; do
    case "$1" in
        --host)        HOST="$2"; shift 2 ;;
        --app-dir)     APP_DIR="$2"; shift 2 ;;
        --data-dir)    DATA_DIR="$2"; shift 2 ;;
        --proxy-port)  PROXY_PORT="$2"; shift 2 ;;
        --ui-port)     UI_PORT="$2"; shift 2 ;;
        --upstream)    UPSTREAM="$2"; shift 2 ;;
        --yes|-y)      ASSUME_YES="1"; shift ;;
        *) echo "deploy.sh: unknown option $1" >&2; exit 2 ;;
    esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PUBLIC_HOST="${HOST#*@}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

# 1. Linux worker (built on this machine; the server has no Go toolchain).
WORKER="$ROOT/azuretls-go/bin/azuretls-worker-linux-amd64"
if [ ! -f "$WORKER" ]; then
    say "Building Linux worker (azuretls-worker-linux-amd64)…"
    ( cd "$ROOT/azuretls-go" && GO111MODULE=on GOTOOLCHAIN=auto \
        GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o bin/azuretls-worker-linux-amd64 . )
fi
file "$WORKER" | grep -q 'ELF .*x86-64' || { echo "deploy.sh: $WORKER is not a Linux x86-64 binary" >&2; exit 1; }

# 2. Pack mini standalone (no bundled Node — the server already has Node >= 20 on disk).
say "Packing mini → $STAGE/cupnet-mini"
node "$ROOT/scripts/pack-mini.cjs" --dir --no-node --all-platforms --out "$STAGE" >/dev/null
test -f "$STAGE/cupnet-mini/app/azuretls-go/bin/azuretls-worker-linux-amd64"

say "About to deploy to $HOST"
echo "    app dir:    $APP_DIR"
echo "    data dir:   $DATA_DIR   (systemd StateDirectory)"
echo "    proxy port: $PROXY_PORT   ui port: $UI_PORT"
[ -n "$UPSTREAM" ] && echo "    upstream:   (set via env file, value not shown)"
if [ "$ASSUME_YES" != "1" ]; then
    printf 'Proceed with rsync + systemctl on the server? [y/N] '
    read -r REPLY
    case "$REPLY" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# 3. Resolve the server's node and prepare dirs.
say "Resolving Node on the server…"
NODE_BIN="$(ssh "$HOST" bash -lc 'command -v node || true')"
[ -n "$NODE_BIN" ] || { echo "deploy.sh: Node.js not found on $HOST (need >= 20)" >&2; exit 1; }
echo "    node: $NODE_BIN"
ssh "$HOST" bash -s <<EOF
set -e
mkdir -p "$APP_DIR"
EOF

# 4. Ship the tree.
say "Syncing to $HOST:$APP_DIR"
rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
    "$STAGE/cupnet-mini/" "$HOST:$APP_DIR/"
# rsync normalises modes; make launchers + workers executable again.
ssh "$HOST" bash -s <<EOF
set -e
chmod 0755 "$APP_DIR/cupnet-mini" || true
chmod 0755 "$APP_DIR"/app/azuretls-go/bin/azuretls-worker-* || true
EOF

# 5. Optional upstream env file (kept 0600; the value never appears in argv or logs).
if [ -n "$UPSTREAM" ]; then
    say "Installing upstream env file"
    ssh "$HOST" bash -s "$UPSTREAM" <<'EOF'
set -e
umask 077
printf 'CUPNET_MINI_UPSTREAM=%s\n' "$1" > /etc/cupnet-mini.env
EOF
fi

# 6. Render + install the systemd unit, then (re)start.
say "Installing systemd unit"
UNIT="$(sed \
    -e "s#@APPDIR@#$APP_DIR#g" \
    -e "s#@DATADIR@#$DATA_DIR#g" \
    -e "s#@NODE@#$NODE_BIN#g" \
    -e "s#@PROXY_PORT@#$PROXY_PORT#g" \
    -e "s#@UI_PORT@#$UI_PORT#g" \
    "$HERE/cupnet-mini.service.in")"
if [ -n "$UPSTREAM" ]; then
    UNIT="$(printf '%s\n' "$UNIT" | sed '/^\[Service\]/a EnvironmentFile=/etc/cupnet-mini.env')"
fi
printf '%s\n' "$UNIT" | ssh "$HOST" bash -s <<'EOF'
set -e
cat > /etc/systemd/system/cupnet-mini.service
systemctl daemon-reload
systemctl enable cupnet-mini >/dev/null 2>&1 || true
systemctl restart cupnet-mini
sleep 1
systemctl --no-pager --lines=0 status cupnet-mini | head -5 || true
EOF

# 7. Connection instructions, written on the server and printed here.
say "Writing $APP_DIR/CONNECT.txt"
ssh "$HOST" bash -s "$NODE_BIN" "$APP_DIR" "$DATA_DIR" "$PUBLIC_HOST" "$HOST" <<'EOF'
set -e
"$1" "$2/app/mini/cupnet-mini.js" connect --data "$3" --public-host "$4" --ssh-login "$5" > "$2/CONNECT.txt"
cat "$2/CONNECT.txt"
EOF

say "Done. Re-print instructions any time with:"
echo "    ssh $HOST cat $APP_DIR/CONNECT.txt"
