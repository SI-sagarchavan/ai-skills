# Policy discovery cheat sheet

Agents following `raise-pr` should resolve configuration in this order.
Higher wins when sources conflict.

## 1. User message (this turn)

- Explicit base branch
- Explicit title / type
- Ticket key
- `--no-verify` / skip hooks authorization

## 2. Repo-local raise-pr override

Any of:

- `.agents/skills/raise-pr/SKILL.md`
- `.grok/skills/raise-pr/SKILL.md`
- `.claude/skills/raise-pr/SKILL.md`
- `.cursor/skills/raise-pr/SKILL.md`

Use for product-specific hard rules (e.g. only `feat|fix|bugfix`, always
base `development`).

## 3. Project rules

- `.ai-rules/**`
- `AGENTS.md` / `CLAUDE.md` / `.cursor/rules/**`

## 4. Tooling config

| Need | Look for |
|------|----------|
| Commit types | `commitlint.config.js`, `commitlint.config.cjs`, `commitlint.config.mjs`, `package.json#commitlint` |
| Branch name check | `scripts/check-branch-name.js`, husky `pre-push` |
| Default base | `gh repo view` default branch; rules mentioning `development` |
| PR template | `.github/PULL_REQUEST_TEMPLATE.md` (+ variants) |
| Sonar / quality | `sonar-project.properties`, `scripts/check-sonar*`, husky pre-push |

## 5. Portable defaults (this skill)

See main `SKILL.md` — protected branch set, `feat|fix|hotfix` prefixes,
Conventional Commits types, fallback PR body.
