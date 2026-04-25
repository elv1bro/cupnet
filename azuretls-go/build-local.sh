#!/usr/bin/env bash
# Build only the binary for the current OS/ARCH (matches mitm-proxy _goWorkerBinaryName).
# Use in CI and dev; use build.sh for release / all platforms.
set -euo pipefail
cd "$(dirname "$0")"
export GO111MODULE=on
export GOTOOLCHAIN="${GOTOOLCHAIN:-auto}"
mkdir -p bin
LDFLAGS='-s -w'
OS=$(go env GOOS)
ARCH=$(go env GOARCH)
NAME=""
case "$OS" in
  darwin) NAME="azuretls-worker-darwin-${ARCH}" ;;
  linux) NAME="azuretls-worker-linux-${ARCH}" ;;
  windows) NAME="azuretls-worker-win32-${ARCH}.exe" ;;
  *)
    echo "Unsupported GOOS=$OS" >&2
    exit 1
    ;;
esac
echo "Building local: $OS/$ARCH -> bin/$NAME"
go build -trimpath -ldflags="$LDFLAGS" -o "bin/$NAME" .
echo "Done."
