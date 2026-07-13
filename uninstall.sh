#!/usr/bin/env bash
# Remove ai-skills symlinks/copies from harness skill roots.
# Only removes links that point into this repo, or copies named after our skills.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESSES="grok claude cursor agents"

harness_dir() {
  case "$1" in
    grok) echo "${HOME}/.grok/skills" ;;
    claude) echo "${HOME}/.claude/skills" ;;
    cursor) echo "${HOME}/.cursor/skills" ;;
    agents) echo "${HOME}/.agents/skills" ;;
  esac
}

SKILL_NAMES=""
for candidate in "$ROOT"/*/; do
  [[ -d "$candidate" ]] || continue
  base="$(basename "$candidate")"
  [[ "$base" == "examples" || "$base" == ".git" ]] && continue
  [[ -f "${candidate}SKILL.md" ]] || continue
  SKILL_NAMES="${SKILL_NAMES} $base"
done

for h in $HARNESSES; do
  parent="$(harness_dir "$h")"
  [[ -d "$parent" ]] || continue
  for name in $SKILL_NAMES; do
    dest="${parent}/${name}"
    if [[ -L "$dest" ]]; then
      target="$(readlink "$dest" || true)"
      case "$target" in
        "$ROOT"/*|"$ROOT")
          rm -f "$dest"
          echo "[rm]  $dest (symlink)"
          ;;
        *)
          echo "[skip] $dest -> $target (not this repo)"
          ;;
      esac
    elif [[ -d "$dest" ]]; then
      # Only remove if it looks like a copy we installed (has SKILL.md and same name)
      if [[ -f "${dest}/SKILL.md" ]]; then
        echo "[skip] $dest is a real directory — remove manually if desired"
      fi
    fi
  done
done

echo "Done."
