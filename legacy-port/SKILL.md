---
name: legacy-port
description: 'Port a page or widget from the legacy WAF club sites (Vue, wm-si-wafjs3.0 / wm-si-wafcss3.0 — PBKS, KKR, GT, RR…) to Surface fortress plugins: React + Tailwind using the tenant design tokens, data from a Cast workflow found or created through the Cast MCP, verified visually against the live page. Use when asked to port, convert, migrate or replicate a legacy club-site page or widget, e.g. "port https://www.punjabkingsipl.in/fixtures" or "/legacy-port <url>".'
argument-hint: "<live-page-url> [widget]"
---

# Port a legacy WAF page to Surface plugins

A legacy page is a site shell (head, menu, breadcrumb, footer) plus body
widgets. Each widget becomes one self-contained fortress plugin,
`fortress/<tenant>-<widget>/`, written as React + Tailwind with the tenant's
design tokens, fed by a Cast workflow, and checked against the live widget.

`<skill>` below is the directory holding this SKILL.md; the scripts are in
`<skill>/scripts`. Run them from the renderer checkout (`fanxp-web-renderer`
or its `apps/web/plugins`); plugin dirs are relative to the plugins repo root.
Details: [reference/porting-rules.md](reference/porting-rules.md) (how to
port), [reference/tokens.md](reference/tokens.md) (Tailwind and the token
system), [reference/cast.md](reference/cast.md) (data through Cast),
[reference/direct-feed.md](reference/direct-feed.md) (data without Cast) and
[reference/tooling.md](reference/tooling.md) (scripts, `legacy-port.json`,
troubleshooting).

## Rules

- The renderer is multi-tenant. Never add tenant-named code, config, global
  CSS or theme values to it. Everything tenant-specific lives in the plugin
  or in the tenant's theme and Cast configuration.
- Style with the token utilities (`text-text_main_high`, `bg-core_neu_00`,
  `p-spacing_4`, `h3_bold` …). A raw hex, px or font value is allowed only
  where `tokens.mjs` found no token **and** the user agreed to it.
- Never ship the legacy stylesheet. `legacy.css` is the spec you read, not a
  file you copy.
- Fonts and icons come from the **tenant's own Font Manager** (typography
  families and an SVG icon font, both linked on every page). Never use the
  legacy site's font files, and in particular never its icon font
  (`waf-font-icon` and the like): the tenant does not register it, so the icons
  render as empty boxes on Surface. `tokens.mjs` prints the mapping
  ([reference/porting-rules.md](reference/porting-rules.md), Fonts and Icons).
- Never create or change a Cast workflow, or a tenant's theme, without the
  user's go-ahead: say what you will create and wait.
- Never write a tenant host, domain or CDN URL in a plugin. Feed URLs are
  built from `ctx.tenantId` and a configurable path; ids that change per
  tenant or page (series, team, client) are settings in the manifest.
- Never commit or push. Show the user what changed; they commit.
- `getclientinfo` contains credentials: read only the fields you need, never
  print or save the whole response.
- Report the scripts' numbers exactly. If a check fails or was skipped, say so.

## 0. Setup (once per machine)

```bash
cd <skill>/scripts && npm install
```

- Chromium: Playwright's own, else any Chromium in the Playwright cache. If
  none: `npx playwright-core install chromium` in the same directory.
- Legacy repos: `wm-si-wafjs3.0` (and `wm-si-wafcss3.0`) are found beside, or
  one folder below, any parent of the renderer; otherwise set `WAF_JS_REPO` /
  `WAF_CSS_REPO`.
- Renderer: `pnpm dev` running with `DNS` in `apps/web/.env.local` set to the
  tenant's Surface host, and `packages/utils/dist` built (`pnpm build` once).
  It needs the dev-only route `apps/web/app/dev/plugins/[pluginId]/page.tsx`
  and `apps/web/app/dev/font-proxy/route.ts`; if missing, copy them from
  `<skill>/templates/dev-preview/` (drop `.txt`) and ask before committing.
- Cast MCP (only when the data goes through Cast): the `cast` MCP server
  connected, with the tenant's client header
  ([reference/cast.md](reference/cast.md)). If its tools are missing or
  return 401, tell the user before starting step 2. If the user said "no
  Cast", skip this.

## 1. Inventory the page

```bash
node <skill>/scripts/inventory.mjs <live-page-url> --prefix <tenant>
```

It lists every shell and body widget: component/template, root class, Vue
file, client parser entry, browser script, feed templates, settings, and a
status:

- `ported: <plugin>` means the widget is already ported. Reuse it; it only
  needs placing on the page.
- `ported for <other site> as <plugin>` means a plugin exists for another
  site. Reuse its markup, parser and Cast workflow in a new tenant plugin,
  then redo steps 3–4 for this tenant.
- `new` means it needs porting.
- A `mounted:` line means the placeholder is an empty
  `<div class="si-waf-widget" widget-id="…">` that a browser script fills in
  (the inventory may list its component as `si-ads` or similar; the real
  widget is the `script:` / `vue:` it prints, found through the client's
  `widgetConfig.json`). Such a widget has **no server-rendered markup**: set
  `"clientRendered": true` in `legacy-port.json` so the scripts load the legacy
  page with JavaScript on. The `apis:` line is its legacy feed and `mount:` its
  `series-id` / `team-id` attributes, which become settings.

Show the user the list and propose an order: shell widgets first if not yet
ported, then body widgets by how many pages use them. Port one widget at a
time, end to end (steps 2–6), before the next.

## 2. Data

Ask which route if the user has not said. **No Cast** ("no cast", no workflow
available): follow [reference/direct-feed.md](reference/direct-feed.md): find
a maintained API for the data, else use the legacy production feed as a
configurable `api_url`, built from `ctx.tenantId`, with defaults in the
manifest; save a real response as `sample.json`; skip the Cast steps below.

**Through Cast:** follow [reference/cast.md](reference/cast.md):

1. From the inventory, read the widget's feed template, parser entry and
   settings. Fetch one real legacy feed response.
2. With the Cast MCP, find a workflow that already serves this data for the
   tenant. If there is none, propose one to the user (name, inputs, upstream,
   output shape), and create it once they agree.
3. Run it, save the response as `sample.json`, and check every field the
   legacy parser reads is there.

## 3. Map the styling to tokens

1. Create `fortress/<pluginId>/legacy-port.json` from the inventory's
   `suggestedConfig`. Confirm `root` in the live HTML with JavaScript off
   (for a `clientRendered` widget, on the page once the script has run), and
   list every visual `state` and `hover`.
2. Run:

   ```bash
   node <skill>/scripts/extract-css.mjs fortress/<pluginId>
   node <skill>/scripts/reference-css.mjs fortress/<pluginId>
   node <skill>/scripts/tokens.mjs fortress/<pluginId>
   ```

3. `tokens.mjs` maps every legacy colour, spacing, radius and font size to the
   tenant's tokens. When the tenant theme lacks values (often: new tenants
   start empty), propose them in `legacy-port.json` `theme.proposed` using
   existing token names only, re-run, and show the user the list it prints
   under "to set in the tenant theme". Agree with the user on anything still
   `NO TOKEN` before writing markup.
4. Read what `tokens.mjs` prints under "tenant fonts":
   - **Typography:** each legacy family is mapped to the tenant's family and
     weights (e.g. `acuminpro-bold` → "Acumin Pro" 700). Use the tenant's
     family; do not register the legacy files.
   - **Icons:** each legacy glyph code point (`\e85c`) is mapped to the tenant
     icon font's class (`icon_pk_plane`) and family (`pk`). Draw icons with the
     tenant's icon font. A glyph with `NO GLYPH` has no equivalent: tell the
     user and agree on an SVG or on registering the legacy glyph before
     writing markup.
   - A legacy family with no tenant equivalent may be registered only if the
     user agrees; then list it in `legacy-port.json` `registerFonts`, which is
     the only way the compare loads a legacy font.

## 4. Build the plugin

Follow [reference/porting-rules.md](reference/porting-rules.md) and
[reference/tokens.md](reference/tokens.md):

1. Layout: `manifest.json`, `index.ts`, `logic/` (types, config, parser,
   prepare), `ui/` (Component, Skeleton), `sample.json`, `README.md`,
   `legacy-port.json`.
2. Markup: semantic React that reproduces the Vue template's content,
   order and visual structure, styled with token utilities from
   `legacy.css` + `tokens.json`. Put `data-legacy-port="<pluginId>"` on the
   root element. Icons use the tenant's icon font from step 3.4.
3. Data: with Cast, `prepare` calls the workflow (`ctx.cast(args)`); without
   it, `prepare` fetches the configured feed through `ctx.networkManager` at
   `https://<ctx.tenantId><path>` ([direct-feed.md](reference/direct-feed.md)).
   Either way, port the legacy parser to shape the response into the view
   model.
4. Behaviour: port every interaction from the Vue methods and browser script.
5. Phones: fetch the live page with a phone and a desktop User-Agent. If the
   widget HTML differs, follow "Device-specific markup" in the porting rules.

## 5. Verify against the live page

For each non-default `state`, add the `plugin` steps that reach it, then:

```bash
node <skill>/scripts/compare.mjs fortress/<pluginId>
```

The plugin page loads the tenant's own fonts and icon font the way Surface
serves them, and no legacy font unless it is in `registerFonts`; so a missing
icon or a fallback font shows up here as pixel and landmark differences, and
is a bug in the plugin, not something to excuse with tolerance.

PASS needs, at every compare width and state:
- pixel difference within `tolerance.pixelRatio` (default 1%);
- sizes within `tolerance.sizePx`;
- identical visible text and links;
- every `landmarks` pair within tolerance;
- every interaction step ok.

Then **look at every `*-side-by-side.png`** yourself. A tolerance can hide a
missing icon or a wrong colour on a small element. Differences that form a
shape are bugs even under the threshold.

On FAIL:
- **Text or links differ:** fix the markup or the parser first. The pixel
  numbers mean nothing until the content matches.
- **Pixels or size:** read the diff PNG, add `landmarks` on the elements it
  points at, and re-run. The landmark lines say which box, colour or type
  value drifted. Fix the class, or the proposed token value.
- **State step or interaction failures:** fix the component behaviour.

Raise `tolerance` only for a reason you can name, such as font rasterising.
Write that reason in the README. Repeat until PASS.

## 6. Finish

1. Tests next to the code (vitest; plain assertions, since jest-dom matchers
   are not typed in `apps/web`):
   - the parser, using `sample.json`;
   - config;
   - `prepare` with a mocked `ctx.cast` (or `ctx.networkManager.get` for a
     direct feed, including the URL built from `ctx.tenantId`);
   - the component render and every interaction, including failures;
   - `index.ts`.

   From the renderer root:
   `NODE_ENV=test npx vitest run apps/web/plugins/fortress/<pluginId>`.
2. From the renderer root: `npx biome format --write` and `npx biome check`
   on the plugin dir; `npx tsc --noEmit -p apps/web/tsconfig.json` shows no
   errors in the plugin.
3. README:
   - description and data source (the Cast workflow id and inputs, or for a
     direct feed the source chosen, why, the URL template and each setting);
   - config table;
   - behaviour, with every deliberate difference from the legacy widget;
   - token notes (tokens added to the theme, and any raw values with the
     reason);
   - fonts table;
   - the exact compare numbers;
   - files.
4. Regenerate the registries: `pnpm generate:plugins` in `apps/web` (the dev
   server's `predev` also does it).
5. Report to the user:
   - what was built, the compare numbers, and the side-by-side PNG paths;
   - what to commit: the plugin dir, plus `ssr-skeletons.generated.tsx` if
     `freshData`;
   - the admin steps: set the proposed theme tokens on the tenant, register
     and enable the plugin, bind it on the page template with its settings
     (series, team, feed path) and its Cast workflow if it uses one, register
     in Font Manager only the fonts the tenant lacks (normally none; the
     `registerFonts` the user agreed to), set page-level styling in the
     builder, publish.
