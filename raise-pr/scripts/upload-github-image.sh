#!/usr/bin/env bash
# Upload an image for embedding in a GitHub PR body.
#
# Outputs a single line: the image URL (for markdown / <img src>).
#
# Strategy (first success wins):
#   1) user-attachments/assets (same as paste-in-UI) when GITHUB_USER_SESSION is set
#   2) pre-release assets on tag "raise-pr-media" via gh API token (fully automated)
#
# Env:
#   GITHUB_USER_SESSION  optional browser cookie value for user-attachments flow
#   GH_TOKEN / gh auth    used for release-asset fallback and repo metadata
set -euo pipefail

PNG="${1:?Usage: upload-github-image.sh <png-path> [owner/repo]}"
REPO_SLUG="${2:-}"

if [[ ! -f "$PNG" ]]; then
  echo "File not found: $PNG" >&2
  exit 1
fi

if [[ -z "$REPO_SLUG" ]]; then
  REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi
OWNER="${REPO_SLUG%%/*}"
NAME="${REPO_SLUG#*/}"
SIZE=$(wc -c <"$PNG" | tr -d ' ')
BASENAME=$(basename "$PNG")
# unique name to avoid collisions on the shared media release
UNIQUE_NAME="sonar-$(date +%Y%m%d%H%M%S)-${RANDOM}.png"

# ─── Strategy 1: user-attachments (paste-equivalent) ─────────────────────────
upload_user_attachments() {
  local session="${GITHUB_USER_SESSION:-}"
  if [[ -z "$session" ]]; then
    return 1
  fi

  local repo_id
  repo_id=$(gh api "repos/${REPO_SLUG}" -q .id)

  local cookie="user_session=${session}; __Host-user_session_same_site=${session}"
  local html upload_token
  html=$(curl -fsS "https://github.com/${REPO_SLUG}" \
    -H "Cookie: ${cookie}" \
    -H "User-Agent: raise-pr-skill" \
    -H "Accept: text/html" 2>/dev/null) || return 1

  upload_token=$(printf '%s' "$html" | python3 -c '
import re,sys
m=re.search(r"\"uploadToken\":\"([^\"]+)\"", sys.stdin.read())
print(m.group(1) if m else "")
')
  if [[ -z "$upload_token" ]]; then
    echo "Could not extract uploadToken (cookie may be expired)" >&2
    return 1
  fi

  local policy
  policy=$(curl -fsS -X POST "https://github.com/upload/policies/assets" \
    -H "Cookie: ${cookie}" \
    -H "Accept: application/json" \
    -H "Origin: https://github.com" \
    -H "Referer: https://github.com/${REPO_SLUG}" \
    -H "X-Requested-With: XMLHttpRequest" \
    -H "User-Agent: raise-pr-skill" \
    -F "name=${UNIQUE_NAME}" \
    -F "size=${SIZE}" \
    -F "content_type=image/png" \
    -F "authenticity_token=${upload_token}" \
    -F "repository_id=${repo_id}" 2>/dev/null) || return 1

  python3 - "$policy" "$PNG" "$cookie" "$REPO_SLUG" <<'PY'
import json, sys, subprocess, os, tempfile

policy = json.loads(sys.argv[1])
png = sys.argv[2]
cookie = sys.argv[3]
repo = sys.argv[4]

upload_url = policy["upload_url"]
form = policy["form"]
asset_upload_url = policy["asset_upload_url"]
if not asset_upload_url.startswith("http"):
    asset_upload_url = "https://github.com" + asset_upload_url
finalize_token = policy["asset_upload_authenticity_token"]
href = policy["asset"]["href"]

# S3 multipart: form fields then file last
cmd = [
    "curl", "-fsS", "-X", "POST", upload_url,
    "-H", "Origin: https://github.com",
]
for k, v in form.items():
    cmd += ["-F", f"{k}={v}"]
cmd += ["-F", f"file=@{png};type=image/png"]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode != 0:
    sys.stderr.write(r.stderr or r.stdout or "S3 upload failed\n")
    sys.exit(1)

# Finalize
cmd2 = [
    "curl", "-fsS", "-X", "PUT", asset_upload_url,
    "-H", f"Cookie: {cookie}",
    "-H", "Accept: application/json",
    "-H", "Origin: https://github.com",
    "-H", f"Referer: https://github.com/{repo}",
    "-H", "X-Requested-With: XMLHttpRequest",
    "-H", "User-Agent: raise-pr-skill",
    "-F", f"authenticity_token={finalize_token}",
]
r2 = subprocess.run(cmd2, capture_output=True, text=True)
if r2.returncode != 0:
    sys.stderr.write(r2.stderr or r2.stdout or "finalize failed\n")
    sys.exit(1)

print(href)
PY
}

# ─── Strategy 2: pre-release asset (token-only, fully agentic) ───────────────
upload_release_asset() {
  local tag="raise-pr-media"
  # Ensure prerelease exists (idempotent)
  if ! gh release view "$tag" --repo "$REPO_SLUG" >/dev/null 2>&1; then
    gh release create "$tag" \
      --repo "$REPO_SLUG" \
      --prerelease \
      --title "raise-pr media" \
      --notes "Agent-managed screenshots for PR bodies (raise-pr skill). Safe to ignore." \
      >/dev/null 2>&1 || true
  fi

  local rel_id
  rel_id=$(gh api "repos/${REPO_SLUG}/releases/tags/${tag}" -q .id 2>/dev/null) || return 1

  local token
  token=$(gh auth token)

  local tmp_copy
  tmp_copy=$(mktemp "/tmp/${UNIQUE_NAME}")
  cp "$PNG" "$tmp_copy"

  local resp
  resp=$(curl -fsS -X POST \
    "https://uploads.github.com/repos/${REPO_SLUG}/releases/${rel_id}/assets?name=${UNIQUE_NAME}" \
    -H "Authorization: token ${token}" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/octet-stream" \
    -H "Content-Length: ${SIZE}" \
    --data-binary @"${tmp_copy}" 2>/dev/null) || {
    rm -f "$tmp_copy"
    return 1
  }
  rm -f "$tmp_copy"

  python3 -c 'import json,sys; print(json.load(sys.stdin)["browser_download_url"])' <<<"$resp"
}

URL=""
if URL=$(upload_user_attachments 2>/dev/null); then
  echo "Uploaded via user-attachments: $URL" >&2
elif URL=$(upload_release_asset 2>/dev/null); then
  echo "Uploaded via release asset (raise-pr-media): $URL" >&2
  echo "Tip: set GITHUB_USER_SESSION for paste-equivalent user-attachments URLs." >&2
else
  echo "All upload strategies failed" >&2
  exit 1
fi

printf '%s\n' "$URL"
