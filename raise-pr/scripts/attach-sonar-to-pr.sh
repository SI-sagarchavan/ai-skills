#!/usr/bin/env bash
# Capture is separate; this only uploads + prints body markdown for Sonar section.
# Prefer embedding in PR body (not a side comment).
#
# Usage:
#   attach-sonar-to-pr.sh <png-path> [owner/repo]
# Prints markdown/HTML fragment for ## SonarQube Report to stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PNG="${1:?PNG path required}"
REPO="${2:-}"

if [[ ! -f "$PNG" ]]; then
  echo "File not found: $PNG" >&2
  exit 1
fi

URL=$(bash "$SCRIPT_DIR/upload-github-image.sh" "$PNG" ${REPO:+"$REPO"})

# Match GitHub web paste style as closely as possible
cat <<EOF
<img width="947" height="802" alt="SonarQube report" src="${URL}" />
EOF
