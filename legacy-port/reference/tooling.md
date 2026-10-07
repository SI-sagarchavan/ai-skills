# Tooling

The scripts need Node 20 or later. Install them once with `npm install` in
`<skill>/scripts`.

Run them from the renderer checkout. They find the plugins repo by walking up
from the working directory (or from the plugin dir); `SURFACE_PLUGINS_DIR`
overrides it. Every script except `inventory.mjs` takes a plugin dir
(`fortress/<pluginId>`) and reads `<plugin-dir>/legacy-port.json`.

Work files go to `<os tmp>/legacy-port/<pluginId>/`; each script prints the
path.

| Script | What it does | Output |
|---|---|---|
| `inventory.mjs <url> [--prefix <tenant>] [--waf-js <path>]` | Lists the page's shell and body widgets, where each one's legacy code lives, its feeds and settings, and whether a plugin already ports it | `<tmp>/legacy-port/inventory/<host>-<slug>.json`, with a starter `legacy-port.json` per body widget |
| `extract-css.mjs <plugin-dir>` | Records every CSS rule Chromium applies to the widget (root and descendants, pseudo-elements included). It does so at each extract width, in each state, with `:hover` forced on the `hover` elements. The legacy page loads with JavaScript off and first-party requests only. | `extract.json` |
| `reference-css.mjs <plugin-dir>` | Builds the widget's legacy styling as one readable stylesheet: the spec for the Tailwind markup, never shipped. Then finds a working file for each font family. | `legacy.css`, `fonts.json`; prints the fonts and the preview URL |
| `tokens.mjs <plugin-dir> [--theme <id>] [--base <url>] [--dns <host>]` | Fetches the tenant's theme from the render API and merges `theme.proposed` over it. Then maps every colour (CIEDE2000), spacing, radius and font size in `legacy.css` to tokens, and builds the theme CSS with the renderer's own `genCssFromJson`. | `tokens.json`, `theme.css`, `tenant-fonts.json`; prints the mapping, unknown token names, the values to set on the tenant, and the tenant's fonts (legacy family -> tenant family, legacy icon glyph code -> tenant icon class and family) |
| `compare.mjs <plugin-dir> [--plugin-url <url>]` | Checks the plugin against the live widget with `theme.css` injected. It compares pixels within tolerance per width and state, visible text and links, landmarks, and the interaction steps. | `compare/report.json`, legacy/plugin/diff/side-by-side PNGs per width and state; exit code 1 on FAIL |

`tokens.mjs` reads `NEXT_PUBLIC_BASE_URL` (or `BASE_URL`), `DNS` and
`CLIENT_NAME` from the renderer's `apps/web/.env.local`. It imports
`packages/utils/dist/index.mjs`; run `pnpm build` in the renderer if that is
missing.

## legacy-port.json

Example: [../templates/legacy-port.example.json](../templates/legacy-port.example.json).

| Field | Required | Default | Meaning |
|---|---|---|---|
| `pluginId` | yes | | Plugin folder name; also the preview route id |
| `legacyUrl` | yes | | A live page that shows the widget |
| `root` | yes | | The legacy widget's root, as one class selector (`.waf-standings`). Check it in the live HTML with JavaScript off. |
| `pluginRoot` | | `[data-legacy-port="<pluginId>"]` | The plugin's root on the preview page |
| `widget` | | | Legacy component/template (`si-standings/widget-layout-01`); `inventory.mjs` uses it to spot widgets already ported |
| `states` | | `[{ "name": "default" }]` | UI states to extract and compare (see below). The first state is the default. |
| `hover` | | `[]` | Legacy selectors (relative to `root`) whose `:hover` rules to capture |
| `landmarks` | | `[]` | `{ name, legacy, plugin }` selector pairs (relative to each root; `""` is the root). Box, colours, font size, line height and weight are compared within tolerance. Add them on the elements a diff points at. |
| `tolerance` | | see below | How far the plugin may drift and still PASS |
| `theme` | | `{}` | `id`: the tenant theme (needed when the tenant has several); `proposed`: token values to add, as a partial theme ([tokens.md](tokens.md)) |
| `remScale` | | `0.625` | Legacy root font size ÷ 16px |
| `neutralize` | | `[]` | CSS added to both pages during compare, to hide page-level decoration behind the widget |
| `pageBackground` | | `#f4f4f4` | Body background for both pages during compare |
| `interaction` | | `[]` | Steps run on the plugin page at the widest compare width |
| `extractViewports` | | 360 to 1920 (9 widths) | Widths for extraction. A width whose media queries all evaluate as an earlier one's is skipped. Non-default states only re-check the elements they change, plus their descendants and later siblings. |
| `compareViewports` | | `[390, 768, 1366]` | Widths for comparison |
| `previewOrigin` | | `http://localhost:3000` | Where the local renderer runs |
| `registerFonts` | | `[]` | Legacy font families the user agreed to register in Font Manager because the tenant has no equivalent. Once `tokens.mjs` has read the tenant's fonts, compare loads only these legacy fonts on the plugin page (plus the tenant's own fonts). |
| `clientRendered` | | `false` | Set when the widget is drawn by a browser script (the inventory prints `mounted:`): the legacy page loads with **JavaScript on**, extraction and compare wait for `root`, and the widget's `setInterval` timers are frozen so a measurement never lands mid-render. First-party requests only, as always. |
| `mobileMarkup` | | `false` | Set when the legacy server renders different markup for phones. Extraction then also runs with `mobileUserAgent` below `mobileBreakpoint`, and compare adds `<width>px-phone` runs. |
| `mobileBreakpoint` | | `768` | Widths below it get the phone User-Agent pass |
| `mobileUserAgent` | | an iPhone Safari UA | The User-Agent for phone passes |

### States

Each state reaches the same look on both pages, by different means:

```json
{
  "name": "open",
  "addClass": [{ "selector": ".filter-v1", "className": "active" }],
  "plugin": [{ "click": "button[aria-haspopup]" }],
  "screenshot": { "legacy": ".filter-v1 .dropdown", "plugin": "[role=listbox]" }
}
```

- **Legacy side** (`addClass`, `removeClass`, `setStyle`): the classes and
  inline styles the Vue code changes, applied with JavaScript off. Selectors
  are relative to `root` and use legacy class names. `setStyle` entries are
  `{ selector, style }`, for panels shown with an inline `display`.
- **Plugin side** (`plugin`): interaction steps run on a fresh plugin page.
- **`screenshot`** (optional): captures that element instead of the root. It
  is one selector for both pages, or `{ legacy, plugin }`. Use it for fixed
  overlays, whose position follows the viewport, not the widget.

### Steps

Steps are used in `interaction` and in a state's `plugin` list. Selectors are
relative to `pluginRoot` and take any Playwright selector: CSS, `role=button[name="2025"]`, or `text=…`.

- `{ click, hasText?, waitForResponse? }`: clicks the first match (optionally
  filtered by text). If `waitForResponse` is set, it waits for a response
  whose URL contains it.
- `{ hover }`: hovers the first match.
- `{ expect: { selector, count | text | contains } }`: checks a match count,
  exact text, or contained text.

### Tolerance

| Key | Default | Meaning |
|---|---|---|
| `pixelRatio` | `0.01` | Share of a state's screenshot pixels allowed to differ |
| `pixelThreshold` | `0.1` | pixelmatch colour threshold per pixel (0 exact … 1 anything) |
| `sizePx` | `2` | Screenshot width/height difference |
| `boxPx` | `2` | Landmark position/size difference |
| `colorDeltaE` | `2.3` | Landmark colour difference (CIEDE2000; 2.3 ≈ just noticeable). Also the "near" cut-off in `tokens.mjs`. |
| `fontPx` | `0.5` | Landmark font-size / line-height difference |

## PASS criteria

All of these, at every compare width and state:
- **Content:** the same visible words in the same order, and the same link
  targets (path and query on the same origin).
- **Pixels:** the differing share is at most `pixelRatio`, and the sizes
  agree within `sizePx`.
- **Landmarks:** every pair within `boxPx`, `colorDeltaE` and `fontPx`, with
  the same font weight.
- **Steps:** every state step and interaction step passes.
- **Theme:** `theme.css` exists, meaning `tokens.mjs` ran.

Always report the exact numbers, not just PASS, and look at the side-by-side
PNGs: a difference that forms a shape is a bug even under the threshold.

## The local preview route

`http://localhost:3000/dev/plugins/<pluginId>` renders a plugin through the
renderer's own loader, executor and per-plugin stylesheet host.
- Settings are the manifest defaults.
- `?config=<json>` overrides settings.
- `?url=` sets the page path the plugin sees.
- `?device=mobile` sets `ctx.deviceType`. By default it follows the
  User-Agent, which the renderer's proxy turns into `x-device-type` in dev.
- `?font=<family>@<url>` loads a font through `/dev/font-proxy`.

The tenant is `DNS` in `apps/web/.env.local`. There is no page schema, so the
route has **no tenant theme**. Token classes render unstyled there until
compare injects `theme.css`. To look at a plugin in a browser yourself,
paste `theme.css` into a `<style>` with the devtools, or view the compare
PNGs. The route files are in `templates/dev-preview/` and return 404 outside
`next dev`.

The templates are copies of the renderer's files, kept for checkouts that
lack the route. When the route changes, refresh them from the renderer root:

```bash
cp "apps/web/app/dev/plugins/[pluginId]/page.tsx" <skill>/templates/dev-preview/page.tsx.txt
cp apps/web/app/dev/font-proxy/route.ts <skill>/templates/dev-preview/font-proxy-route.ts.txt
```

## Troubleshooting

- **No Chromium:** set `CHROME_PATH`, or run
  `npx playwright-core install chromium` in `scripts/`. Any recent Chromium
  works, because both pages of a comparison run in the same browser.
- **`<root> is not on <url>`:** the widget isn't rendered server-side with
  that class. Check the live HTML with JavaScript off and fix `root`. If the
  widget is empty with JavaScript off (an `si-waf-widget` mount that a script
  fills in; the inventory prints `mounted:`), set `"clientRendered": true`.
- **Icons render as empty boxes (or text in a fallback font) in the
  compare PNGs:** the plugin uses a font the tenant does not have, usually the
  legacy icon font. Use the tenant's icon font from the `tokens.mjs` output.
  The compare serves the tenant's `/static-assets/*`, so what you see is what
  Surface renders. Opened by hand, the local preview route has no
  `/static-assets/*` and always shows boxes.
- **`no tenant-fonts.json` warning from compare:** run `tokens.mjs` first;
  without it compare loads the legacy fonts, which hides a missing tenant font.
- **`[data-legacy-port=…] not found`:** the plugin root lacks the attribute,
  the plugin failed to render (see the dev server log), or `pluginRoot` is
  wrong.
- **Everything differs, colours missing:** `theme.css` is empty or absent.
  The tenant has no theme values and nothing is proposed, or
  `packages/utils/dist` is not built.
- **`Pick the tenant theme`:** the tenant has several themes; set
  `theme.id` to the page schema's `theme.main_theme`.
- **Text differs only in case:** `innerText` applies `text-transform`; the
  plugin is missing an `uppercase`/`capitalize` class, or has one too many.
- **Hangs when injecting CSS:** Playwright's `addStyleTag` never returns on a
  JavaScript-disabled page. The scripts insert `<style>` with `evaluate`;
  keep it that way.
- **Font file 403:** some legacy formats are blocked (PBKS
  `acuminpro-regular.woff2`). `reference-css` uses the first source that
  returns 200.
- **Fonts don't load on localhost:** the legacy font files have no CORS
  headers. The preview loads them through `/dev/font-proxy`.
- **`{"status":"error for assets"}`:** the renderer's proxy rejects any URL
  containing `static-assets/` or `/fonts/` unencoded. Keep font URLs
  percent-encoded in query strings; the scripts do.
- **zsh:** an unquoted glob with no match aborts the whole command
  (`rm -f dir/*.png` on an empty dir). Quote or guard globs.
- **Stale reports:** check a report's timestamp against the run's start
  before quoting it.
- **`pnpm dev` regenerates files:** its `predev` rewrites
  `apps/web/lib/plugin-loaders.generated.ts` and the plugin registries.
  Commit those only with the plugin they belong to.
