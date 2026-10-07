# Porting rules

How to turn one legacy WAF widget into a Surface fortress plugin built with
React, Tailwind and the tenant's tokens. Existing plugins that use token
utilities in TSX: `fortress/etpl-top-ticker`, `fortress/etpl-teams`,
`fortress/etpl-player-stats`. The data side follows `fortress/listing-filter`
(Cast workflow refetches).

## Where the legacy code is

| What | Where |
|---|---|
| Widgets on a page, with settings | `<origin>/apiv3/gettemplatedata?url=<slug>`: `content.module[]` (settings in `meta_info`), `content.html` (body placeholders), `content.masterhtml` (shell placeholders) |
| Client id, feed templates | `<origin>/apiv3/getclientinfo`: `content.clientid`, `content.feconfig.widgets.<component>`. Read only these; the response also holds credentials. |
| Markup and component logic | `wm-si-wafjs3.0/components/<component>/<template>.vue` (file names vary: `widget-layout-01.vue`, `kxip01-widget-layout-01.vue`, `kxip01_widget_layout01.vue`) |
| Data shaping for the client | `wm-si-wafjs3.0/sdk/model/clientComponents/<client>ComponentTypeParser.js`, entry keyed by component (`"si-standings": …`), plus helpers in `sdk/WidgetLibrary/clientServerCommon.js` |
| Feed URL building | the client's API replacer (e.g. `kxipApiReplacer`) — `{{BASE_URL}}`, `{{LANG}}`, `{{SERIESID}}` … |
| Browser behaviour | `wm-si-wafjs3.0/clients/<client>/js/<widget>.js` (season switches, polling, …) |
| Styling source | `wm-si-wafcss3.0/projects/<project>/` SCSS: read it for variable names and intent. The values come from the live page (`legacy.css`), which is what users see. |

`inventory.mjs` finds all of these for a page.

## Plugin layout

```
fortress/<pluginId>/
  manifest.json         pluginId, name, description (name the legacy widget),
                        owner fanxp-run-team, category FORTRESS,
                        scope { type: TEMPLATE, operation: REPLACE },
                        freshData (true when the data changes over time),
                        execution, configSchema
  index.ts              FortressPlugin subclass: prepare() delegates to
                        logic/prepare; execute() returns
                        { type: "replace", component: (props) =>
                          createElement(Component, { data: prepared, loading: props.loading }) }
  logic/types.ts        workflow and view-model types: the contract between prepare and the UI
  logic/config.ts       readConfig(ctx.config): snake_case settings -> typed config;
                        defaults come from manifest.configSchema (undefined
                        keys dropped before the merge)
  logic/parse-*.ts      the legacy parser, ported to the Cast response
  logic/prepare.ts      ctx.cast() and parse; or, without Cast,
                        ctx.networkManager.get(https://<ctx.tenantId><path>)
                        and parse (direct-feed.md)
  ui/Component.tsx      "use client"; `loading || !data` renders the Skeleton
  ui/Skeleton.tsx       same layout and token classes as the component, aria-busy
  sample.json           one real Cast workflow response, the test fixture
  legacy-port.json      port config for the scripts
  README.md
  *.test.ts(x)          next to the code they test
```

There is no generated stylesheet. A small `ui/Component.css` is allowed for
what Tailwind cannot express (see [tokens.md](tokens.md)).

## Settings (`configSchema`)

- Every legacy `meta_info` key that changes rendering becomes a setting:
  snake_case name, default = the live value. Types: String, Integer, Boolean,
  Enum (`options: [{ value, option }]`), MultiEnum, JSON.
- Settings that change the request become Cast workflow inputs; name the
  mapping in the README.
- `readConfig` accepts JSON settings parsed or as JSON strings, drops invalid
  entries, validates enums against an allowlist (e.g. title tags), and falls
  back to the live defaults.

## Data

See [cast.md](cast.md) (Cast) or [direct-feed.md](direct-feed.md) (no Cast:
`ctx.networkManager`, tenant-built URL, configurable path). In short:

- `prepare` calls `ctx.cast(args)`. Browser refetches go through
  `ctx.callWorkflow`, passed to the component. Without Cast it fetches the
  configured feed from `https://<ctx.tenantId><path>` and the component
  refetches the same URL.
- No tenant host is written in the plugin; series, team and client ids are
  manifest settings, never read from the page URL.
- Port the parser faithfully, including the aliases and quirks the markup
  relies on. Test it with `sample.json` and every response shape it handles.
- On failure: `ctx.telemetry.captureException`, then return a model that
  still renders. `prepare` never throws.
- Refetches:
  - ignore responses for a selection the user has already left (use a
    request counter);
  - keep the current view on failure;
  - let the user retry.

## Markup

The target is the same widget **to the user**, not the same DOM.

- **Keep:**
  - content and order;
  - static text, including spacing inside text (`Name (Q)` keeps its
    space);
  - link targets;
  - image sources and alt text;
  - the visual structure: rows, columns, groups.

  `v-if` becomes a condition, `v-for` a `map` with stable keys, and a
  `:class` a computed class list.
- **Change:** use semantic elements where the legacy markup used `div`s for
  them:
  - `button` for clickable toggles;
  - `table`/`thead`/`tbody` for tabular data;
  - `nav`/`ul` for lists of links;
  - headings at the level the `*_title_tag` setting says.

  Drop wrapper elements that only existed to hang legacy CSS on.
- **Classes:** token utilities and Tailwind only, per [tokens.md](tokens.md).
  No legacy class names, except the `extra_class` setting on the root, which
  builders use.
- **Root:** `data-legacy-port="<pluginId>"` on the outermost element (compare
  finds the plugin by it).
- **Accessibility:**
  - `aria-expanded`/`aria-controls` on toggles;
  - Escape closes overlays;
  - visible focus (`focus-visible:` ring using a token colour through
    `[hsl(var(--…))]`).
- Images: `<img>` with
  `{/* biome-ignore lint/performance/noImgElement: tenant-hosted asset */}`.

## Device-specific markup

Some legacy widgets render different markup for phones (the server checks
the User-Agent). Fetch the live page with a phone and a desktop User-Agent
and compare the widget HTML. If it differs:

- Prefer one responsive component with breakpoint classes.
- If the structure really differs, render from `ctx.deviceType === "mobile"`
  (set `isMobile` in `prepare`), and set `mobileMarkup: true` in
  `legacy-port.json` so extraction and compare cover the phone markup.
- Tell the user that the renderer's page path does not yet pass the device
  into plugin contexts (`apps/web/lib/resolve-page-plugins.ts`), so on
  Surface phones get the desktop markup until it does. The dev route passes
  it.

## Behaviour

- Port every interaction from the Vue methods and the browser script:
  toggles, filters, refetches, close-on-outside-click, polling.
- Keep legacy behaviour, quirks included. Fix a legacy bug only when the fix
  is invisible in normal use (e.g. an error path), and list it under
  "deliberate differences" in the README.

## Styling

- Write classes from `legacy.css` (the widget's real cascade at every width
  and state) and `tokens.json` (what each value maps to). Read the legacy
  media queries, `:hover` rules and state classes, and express them as
  Tailwind breakpoints, `hover:` and React state.
- Tailwind's preflight is global on Surface and the plugin is written for it:
  don't undo it. Where the legacy look relied on a browser default that
  preflight resets (inline images, list bullets, button colours), set it
  explicitly.
- Page-level styling (body background, decorative `::before` images, page
  container padding) is not the widget's. Neutralise it in
  `legacy-port.json` for the comparison, and tell the user to set it in the
  builder (page or layout). Note it in the README.
- **Fonts come from the tenant.** Every Surface page already links the
  tenant's Font Manager stylesheets: its typography families and its SVG icon
  font. `tokens.mjs` reads them (the `tenant fonts` block and
  `tenant-fonts.json`) and maps each legacy family to the tenant's family and
  weights.
  - Use the tenant's family (through the typography tokens, or
    `font-['<Family>']`). Do not copy the legacy font files, and do not ask for
    them to be registered.
  - A legacy family the tenant has no equivalent for may be registered only
    with the user's agreement; list it in `legacy-port.json`
    `registerFonts`. The compare loads no other legacy font, so a plugin
    that depends on one fails it, as it would on Surface.
  - `reference-css.mjs` still lists the legacy files; they are reference only.
  - The compare page gets `/static-assets/*` from the tenant host, the way the
    edge serves it. The local preview route (`/dev/plugins/<id>`) does not, so
    opened by hand it shows system fonts and empty icon boxes; that is the
    preview, not the plugin. Either use the compare PNGs or proxy
    `/static-assets/*` to the tenant.
- **Typography tokens in practice.** The theme's `.body_*` / `.h*` classes are
  unlayered CSS, so a Tailwind variant (`min-[769px]:…`) cannot override them
  in the TSX. For a size that changes at a legacy breakpoint, write
  `font: var(--<token>)` in `Component.css` (the theme publishes each token's
  shorthand variable) and switch it in a media query. A `font` shorthand resets
  line-height; tenant line-heights are often not the legacy 1.5 / 1.2 and
  every row moves by the difference, so pin the legacy line-height after the
  `font` declaration and keep size, weight and family tokens.
- The compare also checks computed font weight. Legacy sites often have one
  family per weight (`acuminpro-bold` at weight 400); the tenant has one
  family with real weights (`Acumin Pro` at 700). The glyphs match but the
  landmark weight does not, so put landmarks on containers (blocks, rows,
  cells) and leave bold text to the pixel diff.

## Icons

Legacy widgets draw icons from the legacy site's icon font through
`::before` / `::after` private-use code points (`content: "\e814"`). The
tenant publishes its own SVG icon font, usually with the same code points
(`tokens.mjs` prints each one as `\e85c -> icon_pk_plane (font-family "pk")`).

- **Use the tenant's icon font.** Two ways, both used on other tenants'
  plugins:
  - the tenant's classes (`icon_<tenant>_<name>`), the most common;
  - the tenant's family with the same code point in the plugin's own CSS
    (`font-family: "pk"`), which keeps the legacy layout: the tenant class
    rules add their own width and margins to the glyph.
- The family name differs per tenant and is not always the tenant's name (one
  tenant's icon font is the font tool's default, `fontello`). Take it from
  `tokens.mjs`, never guess it.
- **Never** reference the legacy icon font (`waf-font-icon`, ...) in a plugin
  and never ask for it to be registered: the tenant does not have it, and
  every icon renders as the browser's missing-glyph box (an empty square).
- A glyph with no match on the tenant's icon font needs the user's decision
  (an inline SVG, or registering the legacy glyph through `registerFonts`).
- Plain letters used as icons (the "i" of an info icon) are ordinary text and
  need no icon font.
- The legacy content area is the viewport minus 15px each side; the dev
  preview route reproduces that.

## Tests

- vitest with `@testing-library/react`. Use plain assertions
  (`getAttribute`, `classList`, `textContent`); jest-dom matchers are not
  typed in `apps/web`.
- **Parser:** `sample.json`, each response shape, junk input.
- **Config:** defaults, JSON-string settings, invalid entries, enum
  validation.
- **prepare:** a mocked context (`tenantId`, `cast` or
  `networkManager.get`, `telemetry`) covering success (and, for a direct
  feed, the URL built from `tenantId`, including a scheme-carrying one),
  failure (renderable model plus `captureException`) and missing or
  `undefined` config.
- **Component:** the content, every interaction, failure and retry, and
  out-of-order responses.
- **index.ts:** the `pluginId`, and that `execute` returns `replace` and
  passes `loading` through.
- Run from the renderer root:
  `NODE_ENV=test npx vitest run apps/web/plugins/fortress/<pluginId>`.

## Quality

- Biome uses `apps/web/biome.json` (80 columns; React and Next rule domains).
  From the renderer root, run `npx biome format --write <plugin-dir>` then
  `npx biome check <plugin-dir>`.
- Types: `npx tsc --noEmit -p apps/web/tsconfig.json` shows no errors in the
  plugin; errors elsewhere already exist.
- The pre-push Sonar gate flags nested template literals, sorts without a
  compare function and high cognitive complexity. Long class lists are fine;
  build conditional ones with a small helper rather than nested templates.

## Freshness

`freshData: true` registers the plugin's server-side skeleton.
- On a template marked `is_csr`, the browser loads the data fresh through the
  widget API.
- Without `is_csr`, the data is part of the page HTML, which the edge caches
  for a year (`s-maxage=31536000`).

For data that changes (standings, fixtures, live scores), say so in the
README.

## README sections

- **Description:** the legacy widget and its live URL.
- **Data source:** the Cast workflow id, its inputs, and the setting → input
  map; or, for a direct feed, the source chosen and why, the URL template,
  and each setting.
- **Config:** a table of the settings.
- **Behaviour:** including the deliberate differences.
- **Styling:**
  - the tokens used;
  - the tokens proposed for the tenant;
  - any raw values, each with its reason;
  - page-level notes;
  - fonts: which tenant families and icon font the plugin uses, and any
    legacy family agreed for registration (`registerFonts`).
- **Verification:** the exact compare numbers, the tolerance, and the reason
  for any tolerance raised.
- **Files.**

## Shipping (tell the user; never do it yourself)

1. In the plugins submodule, commit `fortress/<pluginId>/`, plus
   `ssr-skeletons.generated.tsx` for `freshData` plugins.
2. Bump the submodule in the renderer and deploy.
3. In admin:
   - set the proposed theme tokens on the tenant's theme;
   - publish the Cast workflow;
   - register the plugin and enable it for the tenant;
   - bind the plugin and the workflow on the page's template (TEMPLATE /
     REPLACE);
   - register in Font Manager only the fonts the tenant lacks (normally none);
   - set page-level styling in the builder;
   - publish.
