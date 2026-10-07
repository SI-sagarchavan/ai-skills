#!/usr/bin/env node
// Maps the legacy widget's colours, spacing, radii and type sizes onto the
// tenant's design tokens, and writes the theme CSS the comparison injects.
//
//   - tenant tokens: the render API's master-layouts document for the tenant
//     in the renderer's apps/web/.env.local (NEXT_PUBLIC_BASE_URL, DNS), the
//     same document the renderer builds its token CSS from;
//   - effective theme: the tenant theme with legacy-port.json `theme.proposed`
//     merged over it (values the tenant does not have yet);
//   - every colour in <workDir>/legacy.css is matched to the nearest effective
//     colour token (CIEDE2000), with the properties it is used in;
//   - spacing, radius and font-size values are matched to the token scales.
// Writes <workDir>/tokens.json and <workDir>/theme.css (the renderer's own
// genCssFromJson over the effective theme).
//
//   node tokens.mjs <plugin-dir> [--theme <id>] [--base <render-api-url>] [--dns <host>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  COLOR_LITERAL,
  colorDistance,
  parseColor,
  toHex,
} from "./lib/color.mjs";
import { loadPortConfig } from "./lib/config.mjs";
import {
  legacyGlyphCodes,
  mapGlyphs,
  matchTypography,
  readTenantFonts,
} from "./lib/tenant-fonts.mjs";
import {
  rendererEnv,
  rendererRoot,
  requirePluginsRoot,
} from "./lib/paths.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    theme: { type: "string" },
    base: { type: "string" },
    dns: { type: "string" },
  },
});
if (positionals.length !== 1) {
  console.error(
    "Usage: node tokens.mjs <plugin-dir> [--theme <id>] [--base <render-api-url>] [--dns <host>]",
  );
  process.exit(2);
}
const config = loadPortConfig(positionals[0]);
const legacyFile = path.join(config.workDir, "legacy.css");
if (!existsSync(legacyFile)) {
  console.error(
    `No ${legacyFile} — run extract-css.mjs and reference-css.mjs first.`,
  );
  process.exit(1);
}
const pluginsRoot = requirePluginsRoot(config.pluginDir);
const renderer = rendererRoot(pluginsRoot);
const env = rendererEnv(pluginsRoot);
const BASE = (
  values.base ??
  env.NEXT_PUBLIC_BASE_URL ??
  env.BASE_URL ??
  ""
).replace(/\/+$/, "");
const DNS = (values.dns ?? env.DNS ?? "")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
if (!BASE || !DNS) {
  console.error(
    "Render API or tenant unknown: set NEXT_PUBLIC_BASE_URL and DNS in apps/web/.env.local, or pass --base and --dns.",
  );
  process.exit(1);
}

// ---- tenant tokens, the way the renderer and scripts/seed-redis.ts reach them ----
async function getJson(url) {
  const res = await fetch(url, { headers: { dns: DNS, hostname: DNS } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const json = await res.json();
  return json?.data ?? json;
}
const root = BASE.replace(/\/[^/]+\/web$/, "");
const client =
  (await getJson(`${root}/${env.CLIENT_NAME ?? "fanxp"}/web/gateway-config`))
    ?.client ?? env.CLIENT_NAME;
const mainConfig = await getJson(`${root}/${client}/web/main-config`);
const masterLayoutsApi = mainConfig?.master_layouts?.api;
if (!masterLayoutsApi) {
  console.error(`main-config for ${DNS} has no master_layouts.api`);
  process.exit(1);
}
const allThemes = (await getJson(masterLayoutsApi))?.tokens ?? {};
const themeIds = Object.keys(allThemes);
const themeId =
  values.theme ??
  config.theme.id ??
  (themeIds.length === 1 ? themeIds[0] : null);
if (!themeId || !allThemes[themeId]) {
  console.error(
    `Pick the tenant theme with --theme or legacy-port.json theme.id (a page schema's theme.main_theme). Themes on ${DNS}: ${themeIds.join(", ") || "(none)"}`,
  );
  process.exit(1);
}
const tenantTheme = allThemes[themeId];

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}
// Token names the design system defines (the renderer's sample theme), so a
// proposal can only fill existing names.
const catalogFile = path.join(renderer, "apps", "web", "theme.json");
const catalog = existsSync(catalogFile)
  ? JSON.parse(readFileSync(catalogFile, "utf8"))
  : {};
const known = (group, name) =>
  name in (catalog[group] ?? {}) || name in (tenantTheme[group] ?? {});
const rawProposed = config.theme.proposed ?? {};
const unknownProposals = [];
const proposed = {};
for (const [group, entries] of Object.entries(rawProposed)) {
  if (group === "color") {
    const light = {};
    for (const [name, value] of Object.entries(entries?.light ?? {})) {
      const exists =
        name in (catalog.color?.light ?? {}) ||
        name in (tenantTheme.color?.light ?? {});
      if (exists) light[name] = value;
      else unknownProposals.push(`color.light.${name}`);
    }
    proposed.color = { ...entries, light };
  } else if (isObject(entries) && (catalog[group] || tenantTheme[group])) {
    proposed[group] = {};
    for (const [name, value] of Object.entries(entries)) {
      if (known(group, name)) proposed[group][name] = value;
      else unknownProposals.push(`${group}.${name}`);
    }
  } else {
    proposed[group] = entries;
  }
}
const theme = merge(tenantTheme, proposed);
const tenantColors = tenantTheme.color?.light ?? {};
const tenantMissing = Object.entries(proposed.color?.light ?? {}).filter(
  ([n]) => !(n in tenantColors),
);
// Proposals that change a value the tenant already has: every page changes.
const tenantOverrides = Object.entries(proposed.color?.light ?? {}).filter(
  ([n, v]) =>
    n in tenantColors &&
    String(tenantColors[n]).toLowerCase() !== String(v).toLowerCase(),
);

// ---- legacy declarations ----
const css = readFileSync(legacyFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const decls = [...css.matchAll(/([-a-z]+)\s*:\s*([^;{}]+);/g)].map((m) => ({
  prop: m[1],
  value: m[2].trim(),
}));
const ROLE = [
  [/^color$/, "text"],
  [/^background/, "background"],
  [/^(border|outline)/, "border"],
  [/shadow$/, "shadow"],
  [/^(fill|stroke)$/, "icon"],
];
const roleOf = (prop) => ROLE.find(([re]) => re.test(prop))?.[1] ?? prop;
const toPx = (value) => {
  const m = String(value).match(/^(-?\d*\.?\d+)(px|rem)?$/);
  if (!m) return null;
  return m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
};

// ---- colours ----
const tokenColors = Object.entries(theme.color?.light ?? {})
  .map(([name, hex]) => ({ name, rgb: parseColor(String(hex)) }))
  .filter((t) => t.rgb);
const colors = new Map();
const colorKey = (rgb) =>
  `${toHex(rgb)}${rgb.a < 1 ? `/${+rgb.a.toFixed(3)}` : ""}`;
const countUse = (key, rgb, role, viaVar) => {
  const entry = colors.get(key) ?? { color: key, rgb, uses: {}, vars: [] };
  entry.uses[role] = (entry.uses[role] ?? 0) + 1;
  if (viaVar && !entry.vars.includes(viaVar)) entry.vars.push(viaVar);
  colors.set(key, entry);
};
// Legacy custom properties holding a colour: their uses count for the colour,
// under the property they are used in (`color: var(--primary)` is text).
const colorVars = new Map();
for (const { prop, value } of decls) {
  if (!prop.startsWith("--")) continue;
  const rgb = parseColor(value);
  if (rgb) colorVars.set(prop, rgb);
}
for (const { prop, value } of decls) {
  if (prop.startsWith("--")) continue;
  for (const [literal] of value.matchAll(COLOR_LITERAL)) {
    const rgb = parseColor(literal);
    if (rgb) countUse(colorKey(rgb), rgb, roleOf(prop), null);
  }
  for (const [, name] of value.matchAll(/var\((--[\w-]+)/g)) {
    const rgb = colorVars.get(name);
    if (rgb) countUse(colorKey(rgb), rgb, roleOf(prop), name);
  }
}
for (const [name, rgb] of colorVars) {
  const key = colorKey(rgb);
  if (!colors.has(key)) {
    colors.set(key, { color: key, rgb, uses: { unused: 1 }, vars: [name] });
  } else if (!colors.get(key).vars.includes(name)) {
    colors.get(key).vars.push(name);
  }
}
const colorReport = [...colors.values()]
  .map(({ color, rgb, uses, vars }) => {
    const nearest = tokenColors
      .map((t) => ({ token: t.name, deltaE: colorDistance(rgb, t.rgb) }))
      .sort((a, b) => a.deltaE - b.deltaE)
      .slice(0, 3)
      .map((t) => ({ ...t, deltaE: +t.deltaE.toFixed(2) }));
    const best = nearest[0];
    let match = "none";
    if (rgb.a === 0) match = "transparent";
    else if (best && best.deltaE < 0.5) match = "exact";
    else if (best && best.deltaE <= config.tolerance.colorDeltaE) match = "near";
    return {
      color,
      alpha: rgb.a,
      uses,
      legacyVars: vars,
      count: Object.values(uses).reduce((a, b) => a + b, 0),
      match,
      nearest,
    };
  })
  .sort((a, b) => b.count - a.count);

// ---- spacing, radius, type size ----
// Spacing and sizes often sit behind legacy custom properties (`var(--full-space)`).
const customValues = new Map(
  decls.filter((d) => d.prop.startsWith("--")).map((d) => [d.prop, d.value]),
);
const resolveVars = (value, depth = 0) =>
  depth > 5
    ? value
    : value.replace(/var\((--[\w-]+)[^)]*\)/g, (m, name) =>
        customValues.has(name)
          ? resolveVars(customValues.get(name), depth + 1)
          : m,
      );
function scaleReport(props, scale, label) {
  const tokens = Object.entries(scale ?? {})
    .map(([name, v]) => ({ name, px: Number(v) }))
    .filter((t) => Number.isFinite(t.px));
  const seen = new Map();
  for (const { prop, value } of decls) {
    if (!props.test(prop)) continue;
    for (const part of resolveVars(value).split(/\s+/)) {
      const px = toPx(part);
      if (px === null || px === 0) continue;
      const key = +px.toFixed(2);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([px, count]) => {
      const token = tokens.find((t) => Math.abs(t.px - Math.abs(px)) < 0.01);
      return {
        px,
        count,
        token: token?.name ?? null,
        // Tailwind v4 spacing takes any 0.25 step: 10px is p-2.5.
        tailwind: label === "spacing" && Number.isInteger(px) ? px / 4 : null,
      };
    });
}
const spacing = scaleReport(
  /^(padding|margin|gap|row-gap|column-gap)(-|$)/,
  theme.spacing,
  "spacing",
);
const radius = scaleReport(/radius$/, theme.radius, "radius");
const typeScale = Object.fromEntries(
  ["desktop", "tablet", "mobile"].map((device) => [
    device,
    Object.values(theme[`typography_${device}`] ?? {}).filter(
      (t) => t && Number.isFinite(Number(t.size)),
    ),
  ]),
);
const fontSizes = scaleReport(/^font-size$/, {}, "font-size").map((s) => ({
  ...s,
  typography: Object.fromEntries(
    Object.entries(typeScale).map(([device, list]) => [
      device,
      list
        .filter((t) => Math.abs(Number(t.size) - s.px) < 0.01)
        .map((t) => t.name),
    ]),
  ),
}));
const families = [
  ...new Set(
    decls
      .filter((d) => d.prop === "font-family")
      .map((d) => d.value.split(",")[0].trim().replace(/^["']|["']$/g, "")),
  ),
];

// ---- theme CSS, built by the renderer's own generator ----
const utilsDist = path.join(
  renderer,
  "packages",
  "utils",
  "dist",
  "index.mjs",
);
let themeCss = null;
if (existsSync(utilsDist)) {
  const { genCssFromJson } = await import(pathToFileURL(utilsDist).href);
  themeCss = genCssFromJson(theme, {
    disabledStates: false,
    hoverStates: false,
    responsive: false,
    isrenderer: true,
  });
  writeFileSync(path.join(config.workDir, "theme.css"), themeCss);
}

// ---- the tenant's own fonts (Font Manager): typography + SVG icon font ----
// Only `fonts.css` is read from the SDUI document.
let tenantFonts = null;
try {
  const sduiApi = mainConfig?.SDUI?.api;
  const sdui = sduiApi ? await getJson(sduiApi) : null;
  const hrefs = Array.isArray(sdui?.fonts?.css) ? sdui.fonts.css : [];
  tenantFonts = await readTenantFonts({ host: DNS, hrefs });
  writeFileSync(
    path.join(config.workDir, "tenant-fonts.json"),
    JSON.stringify(tenantFonts, null, 2),
  );
} catch (error) {
  console.warn(`tenant fonts not read: ${error.message}`);
}
const legacyCss = readFileSync(legacyFile, "utf8");
const glyphMap = tenantFonts
  ? mapGlyphs(legacyGlyphCodes(legacyCss), tenantFonts)
  : [];
const fontMap = tenantFonts
  ? families.map((legacy) => ({
      legacy,
      tenant: matchTypography(legacy, tenantFonts),
    }))
  : [];

const report = {
  tenant: DNS,
  themeId,
  themeName: tenantTheme.theme_name ?? null,
  tenantColorTokens: Object.keys(tenantTheme.color?.light ?? {}).length,
  proposedColorTokens: Object.keys(proposed.color?.light ?? {}).length,
  tenantMissing: Object.fromEntries(tenantMissing),
  tenantOverrides: Object.fromEntries(tenantOverrides),
  unknownProposals,
  colors: colorReport,
  spacing,
  radius,
  fontSizes,
  fontFamilies: families,
  tenantFonts: tenantFonts && {
    typography: tenantFonts.stylesheets
      .filter((s) => s.kind === "typography")
      .map((s) => ({ families: s.families, url: s.url })),
    icons: tenantFonts.stylesheets
      .filter((s) => s.kind === "icons")
      .map((s) => ({
        families: s.families,
        glyphs: Object.keys(s.glyphs ?? {}).length,
        url: s.url,
      })),
  },
  fontMap,
  glyphMap,
};
writeFileSync(
  path.join(config.workDir, "tokens.json"),
  JSON.stringify(report, null, 2),
);

// ---- summary ----
const usesText = (uses) =>
  Object.entries(uses)
    .map(([role, n]) => `${role}×${n}`)
    .join(" ");
console.log(
  `${DNS} theme "${report.themeName ?? themeId}" (${themeId}): ${report.tenantColorTokens} colour tokens on the tenant, ${report.proposedColorTokens} proposed in legacy-port.json`,
);
if (!report.tenantColorTokens && !report.proposedColorTokens) {
  console.log(
    "  the tenant theme has no colours yet: propose them in legacy-port.json theme.proposed (reference/tokens.md)",
  );
}
console.log(`\ncolours (${colorReport.length}):`);
for (const c of colorReport) {
  const best = c.nearest[0];
  const alpha = c.alpha > 0 && c.alpha < 1 ? ` alpha ${c.alpha}` : "";
  const target =
    c.match === "transparent"
      ? "transparent"
      : c.match === "none"
      ? `NO TOKEN${best ? ` (nearest ${best.token} ΔE ${best.deltaE})` : ""}`
        : `${best.token} (${c.match}, ΔE ${best.deltaE})${alpha}`;
  const via = c.legacyVars.length ? ` [${c.legacyVars.join(" ")}]` : "";
  console.log(
    `  ${c.color.padEnd(16)} ${usesText(c.uses).padEnd(28)} -> ${target}${via}`,
  );
}
const scaleLine = (list, fmt) =>
  list.length ? list.map(fmt).join(", ") : "(none)";
console.log(
  `\nspacing px: ${scaleLine(spacing, (s) => `${s.px}${s.token ? `=${s.token}` : s.tailwind !== null ? `=tw ${s.tailwind}` : "=arbitrary"}×${s.count}`)}`,
);
console.log(
  `radius px: ${scaleLine(radius, (s) => `${s.px}${s.token ? `=${s.token}` : "=arbitrary"}×${s.count}`)}`,
);
console.log(
  `font-size px: ${scaleLine(fontSizes, (s) => {
    const names = [...new Set(Object.values(s.typography).flat())];
    return `${s.px}${names.length ? `=${names.slice(0, 3).join("/")}` : ""}×${s.count}`;
  })}`,
);
console.log(`font families: ${families.join(", ") || "(none)"}`);
if (tenantFonts) {
  const typo = tenantFonts.stylesheets.filter((s) => s.kind === "typography");
  const icons = tenantFonts.stylesheets.filter((s) => s.kind === "icons");
  console.log(
    `\ntenant fonts (Font Manager, already on every page): ${
      [
        ...typo.map(
          (s) =>
            `${s.families.join("/")} (${[...new Set(s.faces.map((f) => f.weight))].sort().join(",")})`,
        ),
        ...icons.map(
          (s) =>
            `icon font "${s.families[0]}" (${Object.keys(s.glyphs ?? {}).length} glyphs)`,
        ),
      ].join("; ") || "(none found)"
    }`,
  );
  for (const { legacy, tenant } of fontMap) {
    console.log(
      tenant
        ? `  ${legacy} -> tenant "${tenant.family}" (${tenant.weights.join(",")})`
        : `  ${legacy} -> no tenant equivalent`,
    );
  }
  if (glyphMap.length) {
    console.log("\nlegacy icon glyphs -> the tenant's icon font:");
    for (const g of glyphMap) {
      console.log(
        g.classes.length
          ? `  \\${g.code} -> ${g.classes.join(" | ")}  (font-family "${g.family}")`
          : `  \\${g.code} -> NO GLYPH on the tenant's icon font`,
      );
    }
    console.log(
      "  Use the tenant's icon font (its classes, or its family with the same code point); never ship or register the legacy icon font (reference/porting-rules.md, Icons).",
    );
  }
} else {
  console.log(
    "\ntenant fonts unknown: check the main-config SDUI document before assuming a font must be registered.",
  );
}
if (unknownProposals.length) {
  console.log(
    `\nNOT existing token names (fix legacy-port.json theme.proposed): ${unknownProposals.join(", ")}`,
  );
}
if (tenantMissing.length) {
  console.log(
    `\nto set in the tenant theme before publishing (${tenantMissing.length}): ${tenantMissing.map(([n, v]) => `${n}=${v}`).join(", ")}`,
  );
}
if (tenantOverrides.length) {
  console.log(
    `\nCHANGES existing tenant values, affecting every page (${tenantOverrides.length}): ${tenantOverrides.map(([n, v]) => `${n} ${tenantColors[n]} -> ${v}`).join(", ")}`,
  );
}
console.log(
  themeCss
    ? `\ntheme CSS for compare: ${path.join(config.workDir, "theme.css")}`
    : `\n${utilsDist} not built: run pnpm build in the renderer, or compare runs without the tenant theme`,
);
console.log(`detail: ${path.join(config.workDir, "tokens.json")}`);
