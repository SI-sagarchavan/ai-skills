# legacy-port

An Agent Skill (Claude Code, Codex, Cursor, Grok) that ports pages from the
legacy WAF club sites (`wm-si-wafjs3.0` / `wm-si-wafcss3.0`: PBKS, KKR, GT,
RR) to Surface fortress plugins. The ported widgets are:

- **React + Tailwind**, styled with the tenant's design tokens
  (`text-text_main_high`, `p-spacing_4`, `h3_bold` …);
- **fed by Cast workflows**, found or created through the Cast MCP;
- **verified visually** against the live site, within a tolerance.

The agent does the porting: data, markup, behaviour. Five scripts do the
mechanical parts:
- find the legacy code;
- read the live page's styling;
- map it to tokens;
- compare the plugin with the live page.

[SKILL.md](SKILL.md) is what the agent follows. [reference/](reference/)
holds the porting rules, the token system, the Cast flow and the tooling.

## Setup (once per machine)

1. Install the skill: `./install.sh` from the root of this repo. It installs
   to `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Codex, Cursor,
   other agents).
2. Install the scripts' dependencies. They come from public npm, so no
   CodeArtifact login is needed:

   ```bash
   cd ~/.claude/skills/legacy-port/scripts && npm install     # Claude Code copy
   cd ~/.agents/skills/legacy-port/scripts && npm install     # symlinked: installs into this clone
   ```

3. Have a Chromium for Playwright. Any one Playwright has already installed
   works; otherwise run `npx playwright-core install chromium` in `scripts/`.
4. Check out `wm-si-wafjs3.0` (and `wm-si-wafcss3.0`) near the renderer. For
   example, `~/si/waf/` next to `~/si/build/fanxp-web-renderer` is found
   automatically. Otherwise set `WAF_JS_REPO` / `WAF_CSS_REPO`.
5. In the renderer:
   - run `pnpm build` once (the token mapping uses `packages/utils/dist`);
   - set `DNS` in `apps/web/.env.local` to the tenant's Surface host, e.g.
     `DNS=https://pk.surface.fan-os.net/`;
   - run `pnpm dev`.
6. Connect the Cast MCP with the tenant's client header:
   [reference/cast.md](reference/cast.md#setup).

## Use

Start the agent in `fanxp-web-renderer` and run:

```
/legacy-port https://www.punjabkingsipl.in/<page> --prefix pbks
```

In Codex, mention the skill (`$legacy-port …`) or ask in plain words: "port
https://www.punjabkingsipl.in/<page> with the legacy-port skill".

The agent then:

1. lists the page's widgets, flagging the ones already ported;
2. finds or proposes the Cast workflow for each widget's data;
3. maps the legacy styling to tokens and proposes any missing tenant token
   values;
4. builds the plugin in `fortress/<tenant>-<widget>/`;
5. compares it with the live page until it passes: pixels at several widths
   and UI states, text and links, landmark elements, and a real
   click-through;
6. writes tests and a README, and tells you what to commit and set in admin.

It never commits, pushes, creates a Cast workflow or changes a tenant theme
without asking.

## The scripts on their own

Run them from the renderer checkout (`S=~/.claude/skills/legacy-port/scripts`):

| Command | Does |
|---|---|
| `node $S/inventory.mjs <url> --prefix pbks` | Lists the page's widgets, their legacy code, feeds and settings, and which are already ported |
| `node $S/extract-css.mjs fortress/<pluginId>` | Records the live page's CSS rules for the widget |
| `node $S/reference-css.mjs fortress/<pluginId>` | Writes `legacy.css` (the styling spec, never shipped); prints the fonts and the preview link |
| `node $S/tokens.mjs fortress/<pluginId>` | Maps legacy colours, spacing, radii and type to the tenant's tokens; writes `theme.css` |
| `node $S/compare.mjs fortress/<pluginId>` | Compares the plugin with the live widget; exits 1 on FAIL |

The last four read the plugin's `legacy-port.json`
([reference/tooling.md](reference/tooling.md)).

## Earlier ports

`fortress/pbks-points-table` and `fortress/pbks-stats-detail` were ported
with the first version of this skill. That version shipped the legacy markup
and generated CSS, verified pixel-exact. They keep working as they are.
`inventory.mjs` still recognises them as ported, and re-porting them to
Tailwind is a separate decision.
