#!/usr/bin/env bash
# Install ai-skills into local harness skill directories.
#
# Claude Code is more reliable with a real directory copy than a symlink
# (symlinks work per docs, but some setups skip or fail to list them).
# Grok/Cursor/agents default to symlink so `git pull` stays live.
#
# Usage:
#   ./install.sh              # all known harnesses
#   ./install.sh grok claude  # subset
#   ./install.sh --copy       # force copy for every harness
#   ./install.sh --symlink    # force symlink for every harness
#   ./install.sh --list       # dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="auto" # auto | copy | symlink
LIST_ONLY=0
HARNESSES=""

usage() {
  cat <<'EOF'
Install portable Agent Skills from this repo into harness skill roots.

Usage:
  ./install.sh [options] [harness...]

Harnesses (default: all):
  grok     ~/.grok/skills      (default: symlink)
  claude   $CLAUDE_CONFIG_DIR/skills, else ~/.claude/skills (default: copy)
  cursor   ~/.cursor/skills    (default: symlink)
  agents   ~/.agents/skills    (default: symlink; Codex reads this)

Options:
  --copy     Copy skill dirs for all selected harnesses
  --symlink  Symlink skill dirs for all selected harnesses
  --list     Print plan only; do not install
  -h, --help Show this help

After install, restart Claude Code / Codex (or start a new session) and type:
  /raise-pr   or   /legacy-port <url>

Optional Grok config (load this repo without symlinks):
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
    claude) echo "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skills" ;;
    cursor) echo "${HOME}/.cursor/skills" ;;
    agents) echo "${HOME}/.agents/skills" ;;
    *) return 1 ;;
  esac
}

# Per-harness install mode when MODE=auto
mode_for() {
  local harness="$1"
  if [[ "$MODE" == "copy" || "$MODE" == "symlink" ]]; then
    echo "$MODE"
    return
  fi
  case "$harness" in
    claude) echo "copy" ;;
    *) echo "symlink" ;;
  esac
}

SKILL_DIRS=""
for candidate in "$ROOT"/*/; do
  [[ -d "$candidate" ]] || continue
  base="$(basename "$candidate")"
  [[ "$base" == "examples" || "$base" == ".git" ]] && continue
  if [[ -f "${candidate}SKILL.md" ]]; then
    SKILL_DIRS="${SKILL_DIRS} ${candidate%/}"
  fi
done

if [[ -z "${SKILL_DIRS// }" ]]; then
  echo "No skills found under $ROOT (expected <name>/SKILL.md)." >&2
  exit 1
fi

echo "ai-skills root: $ROOT"
echo "global mode:    $MODE (claude defaults to copy when auto)"
echo "skills:"
for s in $SKILL_DIRS; do
  echo "  - $(basename "$s")"
done
echo

install_one() {
  local harness="$1"
  local skill_src="$2"
  local name dest parent how
  name="$(basename "$skill_src")"
  parent="$(harness_dir "$harness")"
  dest="${parent}/${name}"
  how="$(mode_for "$harness")"

  if [[ $LIST_ONLY -eq 1 ]]; then
    echo "[plan] $harness ($how): $dest <- $skill_src"
    return 0
  fi

  mkdir -p "$parent"

  # Clear previous install (symlink or directory)
  if [[ -L "$dest" ]]; then
    rm -f "$dest"
  elif [[ -d "$dest" ]]; then
    rm -rf "$dest"
  elif [[ -e "$dest" ]]; then
    rm -f "$dest"
  fi

  if [[ "$how" == "symlink" ]]; then
    ln -sfn "$skill_src" "$dest"
    echo "[ok]   $harness: linked $name -> $dest"
  else
    # Prefer rsync for clean refresh; fall back to cp
    if command -v rsync >/dev/null 2>&1; then
      mkdir -p "$dest"
      rsync -a --delete "$skill_src"/ "$dest"/
    else
      cp -R "$skill_src" "$dest"
    fi
    echo "[ok]   $harness: copied $name -> $dest"
  fi

  if [[ ! -f "$dest/SKILL.md" ]]; then
    echo "[err]  $dest/SKILL.md missing after install" >&2
    return 1
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
echo "Verify Claude Code:"
echo "  1. Fully quit Claude Code (not just the tab)"
echo "  2. Open a project and type:  /raise-pr"
echo "  3. Or open the skills menu with /skills if available"
echo
echo "Files:"
for h in $HARNESSES; do
  parent="$(harness_dir "$h")"
  for s in $SKILL_DIRS; do
    name="$(basename "$s")"
    dest="${parent}/${name}"
    if [[ -e "$dest" ]]; then
      if [[ -L "$dest" ]]; then
        echo "  $dest -> $(readlink "$dest")"
      else
        echo "  $dest  (directory, SKILL.md present: $([[ -f $dest/SKILL.md ]] && echo yes || echo no))"
      fi
    fi
  done
done

echo
echo "Grok optional config (~/.grok/config.toml):"
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
  echo "Done. Re-run ./install.sh after git pull (especially for Claude copy mode)."
fi
