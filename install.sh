#!/usr/bin/env bash
# Install ai-skills into local harness skill directories via symlinks.
# Usage:
#   ./install.sh              # all known harnesses
#   ./install.sh grok claude  # subset
#   ./install.sh --copy       # copy instead of symlink (Windows-friendly)
#   ./install.sh --list       # show what would be installed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="symlink" # or copy
LIST_ONLY=0
HARNESSES=""

usage() {
  cat <<'EOF'
Install portable Agent Skills from this repo into harness skill roots.

Usage:
  ./install.sh [options] [harness...]

Harnesses (default: all):
  grok     ~/.grok/skills
  claude   ~/.claude/skills
  cursor   ~/.cursor/skills
  agents   ~/.agents/skills

Options:
  --copy     Copy skill dirs instead of symlinking
  --symlink  Symlink skill dirs (default)
  --list     Print plan only; do not install
  -h, --help Show this help

Also prints a Grok config.toml snippet so you can optionally use:
  [skills]
  paths = ["$ROOT"]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy) MODE="copy"; shift ;;
    --symlink) MODE="symlink"; shift ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    grok|claude|cursor|agents)
      HARNESSES="${HARNESSES} $1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${HARNESSES// }" ]]; then
  HARNESSES="grok claude cursor agents"
fi

harness_dir() {
  case "$1" in
    grok) echo "${HOME}/.grok/skills" ;;
    claude) echo "${HOME}/.claude/skills" ;;
    cursor) echo "${HOME}/.cursor/skills" ;;
    agents) echo "${HOME}/.agents/skills" ;;
    *) return 1 ;;
  esac
}

# Discover skill packages: top-level dirs with SKILL.md (skip examples/)
SKILL_DIRS=""
for candidate in "$ROOT"/*/; do
  [[ -d "$candidate" ]] || continue
  base="$(basename "$candidate")"
  [[ "$base" == "examples" ]] && continue
  [[ "$base" == ".git" ]] && continue
  if [[ -f "${candidate}SKILL.md" ]]; then
    SKILL_DIRS="${SKILL_DIRS} ${candidate%/}"
  fi
done

if [[ -z "${SKILL_DIRS// }" ]]; then
  echo "No skills found under $ROOT (expected <name>/SKILL.md)." >&2
  exit 1
fi

echo "ai-skills root: $ROOT"
echo "mode:           $MODE"
echo "skills:"
for s in $SKILL_DIRS; do
  echo "  - $(basename "$s")"
done
echo

install_one() {
  local harness="$1"
  local skill_src="$2"
  local name dest parent
  name="$(basename "$skill_src")"
  parent="$(harness_dir "$harness")"
  dest="${parent}/${name}"

  if [[ $LIST_ONLY -eq 1 ]]; then
    echo "[plan] $harness: $dest <- $skill_src"
    return 0
  fi

  mkdir -p "$parent"

  if [[ -L "$dest" ]]; then
    rm -f "$dest"
  elif [[ -d "$dest" ]]; then
    if [[ "$MODE" == "symlink" ]]; then
      echo "[skip] $dest exists as a real directory (not a symlink). Move it aside first." >&2
      return 1
    fi
    rm -rf "$dest"
  elif [[ -e "$dest" ]]; then
    rm -f "$dest"
  fi

  if [[ "$MODE" == "symlink" ]]; then
    ln -sfn "$skill_src" "$dest"
    echo "[ok]   $harness: linked $name -> $dest"
  else
    cp -R "$skill_src" "$dest"
    echo "[ok]   $harness: copied $name -> $dest"
  fi
}

failures=0
for h in $HARNESSES; do
  for s in $SKILL_DIRS; do
    if ! install_one "$h" "$s"; then
      failures=$((failures + 1))
    fi
  done
done

echo
echo "Grok optional config (~/.grok/config.toml) — load this repo without symlinks:"
cat <<EOF
[skills]
paths = ["$ROOT"]
EOF

echo
if [[ $LIST_ONLY -eq 1 ]]; then
  echo "List only; nothing installed."
elif [[ $failures -gt 0 ]]; then
  echo "Finished with $failures warning(s)."
  exit 1
else
  echo "Done. Restart or re-open your agent session if skills do not appear."
  echo "Verify: type /raise-pr (or open the skills menu) in Grok / Claude / Cursor."
fi
