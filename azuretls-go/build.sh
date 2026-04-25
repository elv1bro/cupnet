#!/usr/bin/env bash
# Cross-compile the CupNet AzureTLS upstream worker (native Go, no Node FFI).
# Requires Go 1.24+ with modules (GOTOOLCHAIN=auto recommended).
set -euo pipefail
cd "$(dirname "$0")"
export GO111MODULE=on
export GOTOOLCHAIN="${GOTOOLCHAIN:-auto}"
mkdir -p bin
LDFLAGS='-s -w'
build_one() {
  local goos="$1" goarch="$2" out="$3"
  echo "Building $goos/$goarch -> $out"
  GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags="$LDFLAGS" -o "bin/$out" .
}

build_one darwin amd64 azuretls-worker-darwin-amd64
build_one darwin arm64 azuretls-worker-darwin-arm64
build_one linux amd64 azuretls-worker-linux-amd64
build_one linux arm64 azuretls-worker-linux-arm64
build_one windows amd64 azuretls-worker-win32-amd64.exe
echo "Done. Binaries in azuretls-go/bin/"
