#!/usr/bin/env bash
# Build a markdown SonarQube report from the REST API (no screenshots, no releases).
#
# Prints markdown for the ## SonarQube Report section to stdout.
#
# Env (optional overrides; otherwise read sonar-project.properties / .env):
#   SONAR_HOST_URL / SONAR_TOKEN / SONAR_USER+SONAR_PASSWORD / SONAR_PROJECT_KEY
#
# Exit 0 always when it can print something useful; exit 1 only on hard config miss
# so callers can fall back to a one-line note.
set -euo pipefail

ROOT="${1:-.}"
ROOT="$(cd "$ROOT" && pwd)"

# ─── Load .env safely ─────────────────────────────────────────────────────────
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    # shellcheck disable=SC2163
    export "$line" 2>/dev/null || true
  done < "$ROOT/.env"
fi

PROPS="$ROOT/sonar-project.properties"
prop() {
  local key="$1"
  [[ -f "$PROPS" ]] || return 0
  grep -E "^${key}=" "$PROPS" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true
}

HOST="${SONAR_HOST_URL:-$(prop sonar.host.url)}"
HOST="${HOST:-http://localhost:9000}"
HOST="${HOST%/}"
PROJECT_KEY="${SONAR_PROJECT_KEY:-$(prop sonar.projectKey)}"

if [[ -z "$PROJECT_KEY" ]]; then
  echo "Sonar report unavailable: sonar.projectKey not set." >&2
  exit 1
fi

auth_args=()
if [[ -n "${SONAR_TOKEN:-}" ]]; then
  auth_args=(-u "${SONAR_TOKEN}:")
elif [[ -n "${SONAR_USER:-}" && -n "${SONAR_PASSWORD:-}" ]]; then
  auth_args=(-u "${SONAR_USER}:${SONAR_PASSWORD}")
else
  echo "Sonar report unavailable: set SONAR_TOKEN or SONAR_USER+SONAR_PASSWORD." >&2
  exit 1
fi

api() {
  local path="$1"
  curl -sf --max-time 20 "${auth_args[@]}" "${HOST}${path}"
}

# ─── Quality gate ─────────────────────────────────────────────────────────────
gate_json="$(api "/api/qualitygates/project_status?projectKey=$(printf %s "$PROJECT_KEY" | jq -sRr @uri)" 2>/dev/null || true)"
if [[ -z "$gate_json" ]]; then
  echo "Sonar report unavailable: could not reach ${HOST} or auth failed." >&2
  exit 1
fi

gate_status="$(echo "$gate_json" | jq -r '.projectStatus.status // "UNKNOWN"')"
gate_icon="❓"
case "$gate_status" in
  OK) gate_icon="✅" ;;
  ERROR) gate_icon="❌" ;;
  WARN) gate_icon="⚠️" ;;
esac

# ─── Measures (overall + new code) ─────────────────────────────────────────────
METRICS="coverage,lines_to_cover,duplicated_lines_density,security_hotspots,new_violations,new_bugs,new_vulnerabilities,new_code_smells,new_coverage,new_duplicated_lines_density"
meas_json="$(api "/api/measures/component?component=$(printf %s "$PROJECT_KEY" | jq -sRr @uri)&metricKeys=${METRICS}" 2>/dev/null || echo '{}')"

measure_value() {
  local key="$1"
  echo "$meas_json" | jq -r --arg k "$key" '
    (.component.measures // [])
    | map(select(.metric == $k))
    | first
    | if . == null then empty
      elif ($k | startswith("new_")) then (.period.value // .value // empty)
      else (.value // empty)
      end
  ' 2>/dev/null || true
}

fmt_pct() {
  local v="${1:-}"
  if [[ -z "$v" || "$v" == "null" ]]; then echo "—"; else printf '%.2f%%' "$v"; fi
}

fmt_num() {
  local v="${1:-}"
  if [[ -z "$v" || "$v" == "null" ]]; then echo "—"; else echo "$v"; fi
}

cov="$(measure_value coverage)"
lines="$(measure_value lines_to_cover)"
dup="$(measure_value duplicated_lines_density)"
hotspots="$(measure_value security_hotspots)"
new_viol="$(measure_value new_violations)"
new_bugs="$(measure_value new_bugs)"
new_vulns="$(measure_value new_vulnerabilities)"
new_smells="$(measure_value new_code_smells)"
new_cov="$(measure_value new_coverage)"
new_dup="$(measure_value new_duplicated_lines_density)"

# Prefer TO_REVIEW hotspot count when available
hotspots_tr="$(api "/api/hotspots/search?projectKey=$(printf %s "$PROJECT_KEY" | jq -sRr @uri)&status=TO_REVIEW&ps=1" 2>/dev/null | jq -r '.paging.total // empty' 2>/dev/null || true)"
if [[ -n "$hotspots_tr" ]]; then hotspots="$hotspots_tr"; fi

# ─── Gate conditions table ────────────────────────────────────────────────────
cond_rows="$(echo "$gate_json" | jq -r '
  (.projectStatus.conditions // [])
  | if length == 0 then empty else
      .[] |
      (if .status == "OK" then "✅" elif .status == "ERROR" then "❌" else "⚠️" end) as $i |
      "| `\(.metricKey)` | \(.actualValue // "—") | \(.comparator // "") \(.errorThreshold // "—") | \($i) \(.status) |"
    end
' 2>/dev/null || true)"

# ─── New-code open issues (cap list) ───────────────────────────────────────────
issues_json="$(api "/api/issues/search?componentKeys=$(printf %s "$PROJECT_KEY" | jq -sRr @uri)&inNewCodePeriod=true&resolved=false&ps=10&s=SEVERITY&asc=false" 2>/dev/null || echo '{}')"
issues_total="$(echo "$issues_json" | jq -r '.paging.total // 0')"
issue_rows="$(echo "$issues_json" | jq -r '
  (.issues // [])
  | .[]
  | (.component | split(":") | .[-1]) as $file
  | (.line // "—") as $line
  | (.severity // .impacts[0].severity // "?") as $sev
  | "| \($sev) | `\($file)` | \($line) | \(.rule // "") | \(.message // "" | gsub("\\|"; "\\\\|") | .[0:120]) |"
' 2>/dev/null || true)"

# ─── Emit markdown ─────────────────────────────────────────────────────────────
cat <<EOF
**Project:** \`${PROJECT_KEY}\`  
**Quality gate:** ${gate_icon} **${gate_status}**  
**Host:** local Sonar (API snapshot — no dashboard screenshot)

### New code

| Metric | Value |
|---|---|
| Violations | $(fmt_num "$new_viol") |
| Bugs | $(fmt_num "$new_bugs") |
| Vulnerabilities | $(fmt_num "$new_vulns") |
| Code smells | $(fmt_num "$new_smells") |
| Coverage | $(fmt_pct "$new_cov") |
| Duplication | $(fmt_pct "$new_dup") |

### Overall

| Metric | Value |
|---|---|
| Coverage | $(fmt_pct "$cov") |
| Lines to cover | $(fmt_num "$lines") |
| Duplication | $(fmt_pct "$dup") |
| Security hotspots (TO_REVIEW) | $(fmt_num "$hotspots") |
EOF

if [[ -n "$cond_rows" ]]; then
  cat <<EOF

### Quality gate conditions

| Metric | Actual | Threshold | Status |
|---|---|---|---|
${cond_rows}
EOF
fi

if [[ "${issues_total}" != "0" && -n "$issue_rows" ]]; then
  cat <<EOF

### Open new-code issues (${issues_total})

| Severity | File | Line | Rule | Message |
|---|---|---|---|---|
${issue_rows}
EOF
  if [[ "$(echo "$issues_total" | tr -d ' ')" -gt 10 ]]; then
    echo ""
    echo "_Showing first 10 of ${issues_total} issues._"
  fi
fi

echo ""
echo "_Generated from SonarQube API — no image upload / release assets._"
