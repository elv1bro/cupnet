#!/bin/bash
# Run all CupNet unit tests.
# Usage: bash tests/run-all.sh

set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

PASS=0
FAIL=0

# Detect Electron binary for native-addon tests (arm64 on Apple Silicon)
ELECTRON_BIN="$DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -f "$ELECTRON_BIN" ]; then
    ELECTRON_BIN="$(which electron 2>/dev/null || true)"
fi

run_test() {
    local file="$1"
    local runner="${2:-node}"
    local name="$(basename "$file")"
    echo "──────────────────────────────────────────"
    echo "▶  $name  (${runner})"
    echo "──────────────────────────────────────────"
    if $runner "$file"; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        echo "✗ FAILED: $name"
    fi
}

run_test tests/test-utils.js
run_test tests/test-reliability-policy.js
run_test tests/test-proxy-resilience.js
run_test tests/test-traffic-mode-router.js
run_test tests/test-safe-catch.js
run_test tests/test-secrets-sanitization.js
run_test tests/test-mitm.js
run_test tests/test-interceptor.js
run_test tests/test-rules-engine.js
run_test tests/test-mitm-integration.js

if [ -f "$ELECTRON_BIN" ]; then
    run_test tests/test-db.js "env ELECTRON_RUN_AS_NODE=1 $ELECTRON_BIN"
else
    echo "⚠  Skipping db tests (Electron binary not found)"
    echo "   Install: npm install in cupnet2, then re-run"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
