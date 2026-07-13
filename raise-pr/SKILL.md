---
name: raise-pr
description: "Open a pull request from current work (branch, commit, push, gh pr create). Use when the user runs /raise-pr or /pr, or says raise a PR, open a PR, create a PR, ship this, or push and PR."
user-invocable: true
argument-hint: "[ticket-or-notes]"
---

# Raise PR (portable, agentic)

You own the path from local work → open pull request. Run git/`gh` yourself.
Only stop for real blockers or explicit safety gates below.

This skill is **harness-agnostic**. Prefer shell (`git`, `gh`). Do not depend on
Grok-only, Claude-only, or Cursor-only APIs. If the host exposes a PR UI helper,
you may use it as long as the outcome matches this procedure.

## 0. Discover repo policy (always first)

Before inventing conventions, load what this repository already defines.

### Project instruction files (read if present)

Scan from repo root (and deeper dirs if relevant):

- `AGENTS.md`, `Agents.md`, `AGENT.md`
- `CLAUDE.md`, `Claude.md`, `CLAUDE.local.md`
- `.ai-rules/**` (especially git / commit / Sonar rules)
- `.grok/rules/**`, `.claude/rules/**`, `.cursor/rules/**`
- Repo-local skill overrides: `.agents/skills/raise-pr/`, `.grok/skills/raise-pr/`,
  `.claude/skills/raise-pr/`, `.cursor/skills/raise-pr/` — if present and more
  specific than this skill, **obey the override** for conflicting details.

### PR template (mandatory when present)

Locate the first file that exists:

1. `.github/PULL_REQUEST_TEMPLATE.md`
2. `.github/pull_request_template.md`
3. `.github/PULL_REQUEST_TEMPLATE/*.md` (default or first file)
4. `PULL_REQUEST_TEMPLATE.md` / `docs/pull_request_template.md`

**If a template exists, it is the only allowed PR body skeleton.**

- Keep every heading, horizontal rule, and Checklist **table structure** exactly.
- Only replace placeholder / italic guidance lines with real content.
- **Do not** invent alternate sections such as `## Summary`, `## Test plan`,
  or `## SonarQube note` unless those headings already appear in the template.
- Use `gh pr create|edit --body-file <filled-template.md>` (never a free-form body).

If **no** template exists, use the fallback body in §6 only.

### Base branch

Resolve in order:

1. User named a base this turn
2. Explicit override in project rules / raise-pr override skill
3. `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`
4. Prefer integration branch if it exists remotely and rules mention it:
   `development` → else `main` → else `master` → else default from `gh`

Call the result `BASE`.

### Protected branches (never push here)

Default set (always protect):

`main`, `master`, `development`, `staging`, `production`, `release`

Union with any protected names listed in project rules. Never
`git push origin HEAD:development` (or any protected name). Always push a
feature branch and open a PR into `BASE`.

### Branch name patterns

If project rules define patterns (e.g. `feat/`, `fix/`, `hotfix/`), use them.
Otherwise default:

- `feat/<slug>` — new capability
- `fix/<slug>` — bugfix, patch dep, small repair
- `hotfix/<slug>` — production emergency

If the repo already uses another prefix and pre-push enforces it, follow that.

### Commit message types

1. If `commitlint.config.*` (or package commitlint config) defines `type-enum`,
   **only** use those types.
2. Else if project rules list allowed types, use those.
3. Else Conventional Commits defaults: `feat`, `fix`, `docs`, `style`,
   `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Heuristics when choosing among allowed types:

- User-facing capability → `feat` (if allowed)
- Bug fix / patch dependency bump → `fix` (if allowed)
- If only `feat|fix|bugfix` are allowed, map “chore” work to `fix` unless it
  is clearly a `feat`

Never invent a type that commitlint will reject.

### Quality gates / Sonar / hooks

If the repo has pre-push hooks (husky, `scripts/check-sonar*`, coverage floors):

- Run the normal push path first (hooks on).
- On failure: fix issues **on paths touched by this PR** when reasonable.
- Do **not** try to clear entire-repo baseline debt for an unrelated change.
- Summarize: our surface vs repo baseline.
- `git push --no-verify` **only** if the user explicitly authorized skip this
  turn. Document it in the PR body.

---

## Hard rules

1. Never push to protected branches.
2. Never force-push without `--force-with-lease`, and only when the user asked
   to rebase/rewrite a PR branch they own.
3. Never amend published commits unless the user asks.
4. Never `--no-verify` / `--no-gpg-sign` unless the user explicitly authorized
   it this turn.
5. Never stage secrets (`.env`, key files, credentials, large binaries).
6. Do not open a duplicate PR for the same head → base if one is already open;
   update or report the existing URL instead.
7. Do not ask the user to run git/`gh` commands you can run yourself.

---

## Trigger modes

| User says | Behavior |
|-----------|----------|
| `/raise-pr`, `/pr`, “raise/open/create a PR”, “ship this” | Full pipeline |
| + ticket key / JIRA URL | Put in ticket field of body |
| + “--no-verify” / “skip hooks” / “bypass sonar” | Allow hook skip on push only |
| + title or type override | Prefer user wording when valid |
| Open PR already exists for head | Edit if stale; print URL |

---

## Autonomous pipeline

Execute in order. Use a task list when the flow has 3+ steps.

### 1. Preconditions

```bash
git rev-parse --is-inside-work-tree
git status -sb
git branch --show-current
gh auth status
```

If not a git repo, stop. If `gh` is missing or unauthenticated, stop and tell
the user to install GitHub CLI and run `gh auth login`.

### 2. Snapshot work

```bash
git status
git diff
git diff --cached
git log --oneline -10
git fetch origin "$BASE" 2>/dev/null || true
git log "origin/$BASE"..HEAD --oneline 2>/dev/null || git log "$BASE"..HEAD --oneline 2>/dev/null || true
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true
```

Classify:

- **A.** Uncommitted changes
- **B.** Commits not on `origin/$BASE` (or local `$BASE`)
- **C.** Clean and already pushed (maybe PR exists)

If nothing to ship, say so and stop.

### 3. Leave protected branches

If current branch is protected:

1. Infer type + slug from the change (§ Title & branch).
2. `git checkout -b <type>/<slug>` (commits come along if already made).
3. After a successful PR open, if local protected branch was only “ahead” with
   these same commits, optionally:
   ```bash
   git checkout "$BASE" && git reset --hard "origin/$BASE"
   git checkout <pr-branch>
   ```
   Only when safe (no unrelated local work on `$BASE`).

### 4. Normalize feature branch name

- Already `feat/*` | `fix/*` | `hotfix/*` (or repo-allowed pattern) → keep.
- Other non-protected name → `git branch -m <type>/<slug>` if needed.

### 5. Commit (if needed)

If there are uncommitted changes:

1. Stage relevant files only.
2. Prefer running the repo’s cheap validation if known (lint/tests for touched
   files). Do not invent a long CI matrix.
3. Commit with HEREDOC (never stack secrets into `-m` flags poorly):

```bash
git commit -m "$(cat <<'EOF'
fix: short imperative subject

EOF
)"
```

If `commit-msg` hook rejects the type, fix the message and retry. Do not
`--no-verify` the commit unless the user explicitly asked.

### 6. Title, slug, PR body

**Title**: one line, ideally `type: subject`, matching the primary commit.

**Slug**: lowercase kebab from subject, ~40 chars max
(e.g. `update-fanos-cast-3-5-4`).

#### 6a. Fill PR body from template (strict)

1. Copy the template file to a temp path, e.g. `/tmp/raise-pr-body-$$.md`.
2. Fill sections that exist in **this** template only:

| Template section (typical) | How to fill |
|----------------------------|-------------|
| `## Description` | 1–4 short bullets or 1–2 sentences from the **actual diff**. Remove italic placeholders like `_What does this PR do?_`. |
| `## JIRA Ticket` | User-provided key/URL, else `N/A`. |
| Checklist table | Set Status to `Yes` / `No` / `Partial` / `N/A` honestly; put reasons in the Reason column when not Yes. Keep the table markdown structure. |
| `## SonarQube Report` | See §6b (screenshot + short status). Never replace this section with a long prose “SonarQube note” outside the template. |

3. Example of a correctly filled fanxp-style body (structure must match template file):

```markdown
## Description
- Bumps `@fanos/cast` from `^3.5.3` to `^3.5.4`.
- Removes unused schema re-exports from the cast host adapter.

## JIRA Ticket
N/A

---

## Checklist

| Check | Status | Reason (if No) |
|---|---|---|
| Tested locally | Yes | |
| Linting passed | Yes | Via pre-commit hooks |
| No console logs left in code | Yes | |
| No commented-out code | Yes | |
| Environment variables documented | N/A | No env changes |

---

## SonarQube Report
![SonarQube report](<image-url-or-see-comment>)

Local quality gate: Passed (or Failed — summary one line). Screenshot attached.
```

4. **Forbidden** when a template exists: `## Summary`, `## Test plan`, free-form
   Sonar essays, or any heading not in the template.

#### 6b. SonarQube auto-screenshot

When the template has a Sonar section **or** the repo has Sonar (`sonar-project.properties` / pre-push sonar scripts), capture a dashboard screenshot:

```bash
# Skill-bundled helper (path relative to this skill directory)
SKILL_DIR="<dir containing this SKILL.md>"   # e.g. ${CLAUDE_SKILL_DIR} or resolved path
bash "$SKILL_DIR/scripts/capture-sonar-report.sh" --out /tmp/sonar-report-pr.png
```

The script:

- Reads `sonar.projectKey` / `sonar.host.url` from `sonar-project.properties`
- Uses `SONAR_HOST_URL` / `SONAR_TOKEN` / `SONAR_PROJECT_KEY` from env or `.env`
- Opens the project dashboard headlessly (Playwright) and writes a PNG

If capture fails (Sonar down, no browser deps): put a one-line status in the
Sonar section and note “screenshot unavailable: \<reason\>”. Do not invent
alternate PR sections.

**Attach the image to the PR** (GitHub cannot load local paths in the body):

After the PR number is known (create or existing):

```bash
# Secret gist keeps the PNG off the product repo; body can deep-link raw URL
GIST_URL=$(gh gist create --secret /tmp/sonar-report-pr.png -d "sonar-report PR $(date +%Y%m%d)" 2>/dev/null | tail -1)
# Prefer commenting the image so the Description stays template-clean:
gh pr comment "$PR_NUMBER" --body "### SonarQube Report (auto-capture)

![SonarQube]($(gh gist view \"$GIST_URL\" --raw 2>/dev/null | head -1 || echo \"$GIST_URL\"))

Local capture attached for reviewers."
```

If `gh gist create` fails, still post:

```bash
gh pr comment "$PR_NUMBER" --body "### SonarQube Report
Screenshot saved locally at \`/tmp/sonar-report-pr.png\` (upload manually if needed).
Quality gate: <Passed|Failed|unknown> — dashboard: <host>/dashboard?id=<key>"
```

In the **template** Sonar section, write briefly:

```markdown
## SonarQube Report
See PR comment **SonarQube Report (auto-capture)** for the dashboard screenshot.
Quality gate: <Passed|Failed>. Dashboard: <url>
```

#### 6c. Fallback body (only if no template file)

```markdown
## Description
- <what changed and why>

## JIRA Ticket
N/A

## Checklist
- Tested locally: Yes / No
- Linting passed: Yes / No

## SonarQube Report
<screenshot comment or status>
```

### 7. Push

```bash
git push -u origin HEAD
```

Pre-push may take several minutes (build, tests, Sonar). Wait; do not kill early.

On failure:

| Failure | Action |
|---------|--------|
| Branch name | Rename to allowed pattern; retry |
| Lint / tests / build | Fix, commit, retry |
| Sonar / coverage baseline | Fix issues on **touched paths** only; if still blocked by repo-wide baseline and user authorized skip → `git push --no-verify -u origin HEAD` and document; else stop and report |
| Auth / network | Report and stop |

### 8. Open or reuse PR

```bash
HEAD_BRANCH=$(git branch --show-current)
gh pr list --head "$HEAD_BRANCH" --base "$BASE" --state open --json number,url,title
gh pr view --json url,number,state,baseRefName,headRefName 2>/dev/null || true
```

Write the filled template to a file, then:

```bash
# Prefer body-file so structure is preserved exactly
gh pr create --base "$BASE" --title "<title>" --body-file /tmp/raise-pr-body.md
# or, if PR already open:
gh pr edit "$PR_NUMBER" --title "<title>" --body-file /tmp/raise-pr-body.md
```

Then run §6b attachment (`gh pr comment` + screenshot) if Sonar capture ran.

If an open PR exists for this head → `$BASE`: **edit body to match the
template** when the current body uses non-template sections (e.g. Summary /
Test plan only).

### 9. Final report (always)

```
PR #<n>: <title>
URL: <url>
Branch: <head> → <BASE>
Commits: <short list>
Hooks: full | --no-verify (user-authorized)
Policy sources: <which rules/template files were used>
Quality (our paths): clean | fixed N | N/A | baseline blocked
```

---

## Title & branch heuristics

| Change shape | Preferred type (if allowed) | Example branch |
|--------------|-----------------------------|----------------|
| New user-facing capability | `feat` | `feat/workflow-binding-strip` |
| Bug fix / patch dep | `fix` | `fix/update-cast-3-5-4` |
| Prod emergency | `hotfix` | `hotfix/login-crash` |

Subject: imperative mood; follow repo case rules if any.

---

## Anti-patterns

- Pushing commits onto a protected branch “for speed”
- Using disallowed commit types under commitlint
- Empty / boilerplate PR bodies that ignore the template
- **Inventing `## Summary` / `## Test plan` when `.github/PULL_REQUEST_TEMPLATE.md` exists**
- Asking the user to paste git commands you could run
- Silencing tests or weakening quality gates to land the PR
- Duplicate PRs for the same head branch
- Hardcoding one company’s base branch when discovery would work
- Committing Sonar screenshots into the product repo (use gist/comment instead)

---

## Harness notes

| Harness | Typical invoke |
|---------|----------------|
| Grok | `/raise-pr`, “raise a PR” |
| Claude Code | `/raise-pr` (if skill installed under `.claude/skills` or user skills) |
| Cursor | Agent chat: “raise a PR” / skill picker |
| Other Agent Skills hosts | Same `SKILL.md` under their skills root |

Install paths are documented in this repository’s root `README.md` and
`install.sh`.

---

## Optional follow-ups (only if user asks)

- Watch CI / address review comments (host-specific babysit skills if available)
- Graphite / stacked PRs only when the user works in stacks

## Example prompts

- `/raise-pr`
- `/raise-pr PROJ-1234`
- `raise a PR, skip hooks if sonar baseline blocks`
- `ship this to development`
