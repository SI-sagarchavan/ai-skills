# ai-skills

Portable **Agent Skills** shared across repos and harnesses:

| Harness | User skill root |
|---------|-----------------|
| [Grok](https://x.ai) CLI / TUI | `~/.grok/skills/` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `~/.claude/skills/` |
| [Cursor](https://cursor.com) | `~/.cursor/skills/` |
| Generic / other | `~/.agents/skills/` |

Skills use the common `SKILL.md` layout (YAML frontmatter + markdown procedure).
Procedures stay harness-agnostic (`git`, `gh`). Product policy stays in each
repo (`AGENTS.md`, `.ai-rules/`, PR templates).

---

## Skills in this repo

| Skill | Invoke | Purpose |
|-------|--------|---------|
| [`raise-pr`](./raise-pr/) | `/raise-pr`, “raise a PR”, “ship this” | Branch → commit → push → open PR using repo template; optional Sonar screenshot |

More skills can be added as top-level folders with a `SKILL.md`.

---

## Install (you or a teammate)

```bash
git clone <this-repo-url> ~/si/build/ai-skills   # or your preferred path
cd ~/si/build/ai-skills
./install.sh
```

What it does:

| Harness | Default install |
|---------|-----------------|
| Grok / Cursor / agents | Symlink → this clone (`git pull` stays live) |
| **Claude Code** | **Real copy** into `~/.claude/skills/` (more reliable than symlink) |

Options:

```bash
./install.sh --list           # dry-run
./install.sh grok claude      # only some harnesses
./install.sh --copy           # copy for every harness
./install.sh --symlink        # symlink for every harness
./uninstall.sh                # remove installs from this clone
```

### Claude Code not showing `/raise-pr`?

1. Re-run install: `./install.sh claude`
2. **Fully quit** Claude Code and open a **new** session (skills are watched, but a new top-level `skills` dir or first install may need restart).
3. Type **`/raise-pr`** (slash command = skill directory name). It may not appear as a settings toggle.
4. Confirm the file exists:
   ```bash
   ls -la ~/.claude/skills/raise-pr/SKILL.md
   head -10 ~/.claude/skills/raise-pr/SKILL.md
   ```
5. After every `git pull` of this repo, re-run `./install.sh claude` (copy mode does not auto-update).

### Grok without symlinks

```toml
# ~/.grok/config.toml
[skills]
paths = ["~/si/build/ai-skills"]
```

### Prerequisites for `raise-pr`

- `git`
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated: `gh auth login`
- Network access to your remote
- Optional (Sonar screenshot): Node 18+, first run of
  `raise-pr/scripts/capture-sonar-report.sh` installs Playwright Chromium via
  **public** npm (`registry.npmjs.org`). Set `SONAR_TOKEN` if your Sonar
  instance requires auth.

### Sonar screenshot helper (agent-automated)

The agent runs these on `/raise-pr` — you should not capture/paste by hand:

```bash
# From a product repo that has sonar-project.properties
./raise-pr/scripts/capture-sonar-report.sh --out /tmp/sonar.png
# Upload + emit <img> HTML for the PR body:
./raise-pr/scripts/attach-sonar-to-pr.sh /tmp/sonar.png
```

Upload strategies:

1. **`GITHUB_USER_SESSION` cookie set** → same `user-attachments/assets/…` URLs as pasting in the GitHub UI  
2. **Otherwise (default agent path)** → pre-release `raise-pr-media` asset URL (still embeds as `<img>` in the PR body)

Optional one-time setup for paste-identical URLs:

```bash
# Browser → DevTools → Application → Cookies → github.com → user_session value
export GITHUB_USER_SESSION='…'
# add to ~/.zshrc if you want it sticky (treat as a secret)
```

---

## How it works with product repos

```text
  ai-skills/raise-pr/SKILL.md     ← shared procedure (this repo)
            │
            ▼  installed to user harness dirs
  agent runs inside a product repo
            │
            ▼  discovers
  AGENTS.md / .ai-rules / commitlint / PR template
```

| Layer | Owner | Example |
|-------|--------|---------|
| Procedure | This repo | How to open a PR |
| Policy | Product repo | Base = `development`, types `feat\|fix\|bugfix` |
| Override (optional) | Product repo | `.agents/skills/raise-pr/` |

Repo-local skills usually **win** over user-global ones when both are named
`raise-pr`.

### Product override example

See [`examples/fanxp-override/`](./examples/fanxp-override/) for a
`wnm-fanxp-frontend`-style override (base `development`, strict commitlint,
Sonar notes).

---

## Adding a skill

1. Create `my-skill/SKILL.md` with frontmatter:

   ```markdown
   ---
   name: my-skill
   description: >
     What it does and when to use it. Include trigger phrases like /my-skill.
   ---

   # My skill
   ...
   ```

2. Keep steps portable (shell + common CLIs).
3. Run `./install.sh` again (or rely on `paths` if using Grok config).
4. Open a PR to this repo so the team can pull + reinstall.

---

## Team onboarding checklist

1. Clone this repo (or pull latest).
2. Run `./install.sh`.
3. `gh auth login` if needed.
4. In any product repo: say **raise a PR** or `/raise-pr`.
5. Optionally commit a thin override under `.agents/skills/raise-pr/` for
   product-specific gates.

---

## Layout

```text
ai-skills/
  README.md
  install.sh
  uninstall.sh
  raise-pr/
    SKILL.md
    references/
      policy-discovery.md
  examples/
    fanxp-override/
      SKILL.md
```

---

## License / ownership

Internal team tooling. Adjust remote URL and org name when publishing.
