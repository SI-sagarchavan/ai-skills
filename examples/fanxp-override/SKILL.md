---
name: raise-pr
description: >
  FanXP frontend override for raise-pr. Use when working in wnm-fanxp-frontend
  (or repos that copy this override). Prefer this over the portable skill when
  present under the product repo's .grok/.claude/.cursor/.agents skills path.
---

# raise-pr override — wnm-fanxp-frontend

Follow the **portable** `raise-pr` skill from the `ai-skills` repo for the full
pipeline. Apply these product-specific constraints when they conflict:

## Product rules (read first)

- `.ai-rules/01-git-commit-rules.md`
- `.ai-rules/02-code-quality-sonarqube.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

## Hard overrides

| Setting | Value |
|---------|--------|
| Base branch | Always `development` |
| Protected | `main`, `development`, `staging` (+ skill defaults) |
| Branch names | Only `feat/<slug>`, `fix/<slug>`, `hotfix/<slug>` |
| Commit types | Only `feat`, `fix`, `bugfix` (commitlint). Map “chore” work → `fix` |
| PR body | Fill `.github/PULL_REQUEST_TEMPLATE.md` completely, including Sonar section |

## Sonar

Pre-push runs Sonar quality gate. On failure:

1. Fix open issues on **paths this PR touches** (e.g. cast/workflow).
2. Do not try to lift whole-repo coverage to 90% for an unrelated dep bump.
3. Document baseline vs our surface in the PR **SonarQube Report** section.
4. `--no-verify` only if the user authorized it this turn.

## Install this override into a product repo

```bash
# from product repo root
mkdir -p .agents/skills
cp -R /path/to/ai-skills/examples/fanxp-override .agents/skills/raise-pr
# optional mirrors for harnesses that only scan their vendor path:
mkdir -p .grok/skills .claude/skills .cursor/skills
ln -sfn "$(pwd)/.agents/skills/raise-pr" .grok/skills/raise-pr
ln -sfn "$(pwd)/.agents/skills/raise-pr" .claude/skills/raise-pr
ln -sfn "$(pwd)/.agents/skills/raise-pr" .cursor/skills/raise-pr
```

Repo-local skills override user-global skills when the harness supports priority.
