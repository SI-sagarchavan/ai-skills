#!/usr/bin/env bash
# Wrapper: ensure playwright deps, then capture Sonar dashboard screenshot.
# Run from the product repo (or any cwd that has sonar-project.properties up-tree).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Preserve caller cwd so sonar-project.properties is discovered in the product repo
export RAISE_PR_CWD="${RAISE_PR_CWD:-$(pwd)}"

ensure_playwright() {
  if [[ -d "$SCRIPT_DIR/node_modules/playwright" ]]; then
    return 0
  fi
  echo "Installing playwright (public npm registry)..." >&2
  (
    cd "$SCRIPT_DIR"
    npm install --registry https://registry.npmjs.org/ --no-fund --no-audit playwright@1.49.1 >&2
    npx playwright install chromium >&2
  )
}

ensure_playwright
cd "$RAISE_PR_CWD"
exec node "$SCRIPT_DIR/capture-sonar-report.mjs" "$@"
