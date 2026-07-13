#!/usr/bin/env bash
# Attach a Sonar screenshot (and short status) to a GitHub PR comment.
# Usage: attach-sonar-to-pr.sh <pr-number> <png-path> [repo]
#
# Image hosting order:
#   1. Temporary public host (0x0.st) — works for PNG; URL expires later
#   2. Fallback text-only comment with local path + dashboard link
set -euo pipefail

PR_NUMBER="${1:?PR number required}"
PNG="${2:?PNG path required}"
REPO="${3:-}"

if [[ ! -f "$PNG" ]]; then
  echo "File not found: $PNG" >&2
  exit 1
fi

REPO_ARGS=()
if [[ -n "$REPO" ]]; then
  REPO_ARGS=(--repo "$REPO")
fi

IMAGE_MD=""
# Prefer a short-lived anonymous host so PNG renders in GitHub markdown
# (gh gist create rejects binary files on current CLI versions).
if command -v curl >/dev/null 2>&1; then
  UPLOAD_URL=$(curl -fsS -F "file=@${PNG}" https://0x0.st 2>/dev/null || true)
  if [[ -n "${UPLOAD_URL:-}" && "$UPLOAD_URL" == https://* ]]; then
    IMAGE_MD="![SonarQube dashboard](${UPLOAD_URL})"
    echo "Uploaded screenshot: $UPLOAD_URL" >&2
  fi
fi

BODY=$(cat <<EOF
### SonarQube Report (auto-capture)

${IMAGE_MD:-_Screenshot could not be uploaded automatically. Local file: \`${PNG}\` (drag into this comment if needed)._}

Quality gate screenshot captured from the local SonarQube dashboard.
EOF
)

gh pr comment "$PR_NUMBER" "${REPO_ARGS[@]}" --body "$BODY"
echo "Commented on PR #$PR_NUMBER"
