#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CANDIDATES=(
  tab-manager.js
  mitm-proxy.js
  utils.js
  main-process/cupnet-runtime.js
  main-process/services/traffic-mode-service.js
  main-process/services/tab-error-page.js
  main-process/services/main-window.js
  main-process/services/global-proxy-connect.js
  main-process/services/proxy-service.js
  preload-view.js
  main-process/services/cdp-network-logging.js
)

cleanup() {
  pkill -f "Electron.*cupnet2" 2>/dev/null || true
  pkill -f azuretls-worker 2>/dev/null || true
  sleep 0.5
}

run_probe() {
  cleanup
  timeout 50 node scripts/debug-tab-nav.mjs 2>&1 | rg "RESULT:|FINAL_URL:|MITM_REQUESTS:" || true
  cleanup
}

echo "=== Baseline WIP ==="
run_probe
echo

TMPDIR_BISECT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BISECT"; cleanup' EXIT

for f in "${CANDIDATES[@]}"; do
  if ! git diff --quiet HEAD -- "$f" 2>/dev/null; then
    :
  else
    echo "SKIP (unchanged): $f"
    continue
  fi

  cp "$f" "$TMPDIR_BISECT/$(echo "$f" | tr '/' '_').wip"
  git show "HEAD:$f" > "$f"

  echo "=== Revert to HEAD: $f ==="
  OUT=$(run_probe)
  echo "$OUT"

  if echo "$OUT" | rg -q "RESULT: PASS"; then
    echo ">>> LIKELY CULPRIT: $f"
  fi

  cp "$TMPDIR_BISECT/$(echo "$f" | tr '/' '_').wip" "$f"
  echo
done

echo "=== Done ==="
