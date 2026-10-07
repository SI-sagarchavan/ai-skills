#!/usr/bin/env node
// What is on a legacy WAF page, and where each widget's code lives.
//
//   node inventory.mjs <live-page-url> [--prefix pbks] [--waf-js <path>]
//
// Reads the page's own APIs (apiv3/gettemplatedata, apiv3/getclientinfo) and
// its server-rendered HTML, then for every widget — page body and site shell —
// reports its legacy component/template, root class, Vue file, PBKS-style
// parser entry, browser script, feed templates and whether a plugin already
// ports it. Writes the detail (each widget's legacy settings included) and a
// starter legacy-port.json per body widget to <tmp>/legacy-port/inventory/.
//
// From getclientinfo only the client id, the widget feed templates and the
// stylesheet list are read; nothing else from it is printed or saved.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { findPluginsRoot, findRepo } from "./lib/paths.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    prefix: { type: "string", default: "tenant" },
    "waf-js": { type: "string" },
  },
});
if (positionals.length !== 1) {
  console.error(
    "Usage: node inventory.mjs <live-page-url> [--prefix pbks] [--waf-js <path-to-wm-si-wafjs3.0>]",
  );
  process.exit(2);
}

const pageUrl = new URL(positionals[0]);
const origin = pageUrl.origin;
const slug = pageUrl.pathname.replace(/^\/+|\/+$/g, "");
const PLUGINS_ROOT = findPluginsRoot();
const WAF_JS = values["waf-js"]
  ? path.resolve(values["waf-js"])
  : findRepo("wm-si-wafjs3.0", "WAF_JS_REPO", [process.cwd(), PLUGINS_ROOT]);
const WAF_CSS = findRepo("wm-si-wafcss3.0", "WAF_CSS_REPO", [
  process.cwd(),
  PLUGINS_ROOT,
  WAF_JS,
]);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const templateData = await getJson(
  `${origin}/apiv3/gettemplatedata?url=${encodeURIComponent(slug)}`,
);
const content = templateData?.content;
if (!content) {
  console.error(`No template data for "${slug || "home"}" on ${origin}.`);
  process.exit(1);
}
const clientInfo =
  (await getJson(`${origin}/apiv3/getclientinfo`))?.content ?? {};
const clientId = String(clientInfo.clientid ?? "");
const widgetFeeds = clientInfo.feconfig?.widgets ?? {};
const stylesheets = clientInfo.staticfiles?.css ?? [];
const liveHtml = await (await fetch(pageUrl)).text();

// ---- legacy repo lookups ----
const normalise = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

function clientCode() {
  if (!WAF_JS) return null;
  const base = clientId.toLowerCase();
  const candidates = [
    base,
    base.replace(/_v\d+$/, ""),
    base.replace(/_v\d+$/, "").replace(/\d+$/, ""),
  ];
  return (
    candidates.find((c) => c && existsSync(path.join(WAF_JS, "clients", c))) ??
    null
  );
}
const CLIENT = clientCode();

function listFiles(dir, test, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, test, out);
    else if (test(full)) out.push(full);
  }
  return out;
}
const rel = (file) =>
  WAF_JS ? path.relative(path.dirname(WAF_JS), file) : file;

function vueFile(component, template) {
  if (!WAF_JS) return null;
  const dir = path.join(WAF_JS, "components", component);
  if (!existsSync(dir)) return null;
  const want = normalise(template);
  const match = readdirSync(dir).find(
    (f) => f.endsWith(".vue") && normalise(f.replace(/\.vue$/, "")) === want,
  );
  return match ? rel(path.join(dir, match)) : null;
}

function parserEntries(component) {
  if (!WAF_JS || !CLIENT) return [];
  const dir = path.join(WAF_JS, "sdk/model/clientComponents");
  const file = existsSync(dir)
    ? readdirSync(dir).find(
        (f) => f.toLowerCase() === `${CLIENT}componenttypeparser.js`,
      )
    : null;
  if (!file) return [];
  const lines = readFileSync(path.join(dir, file), "utf8").split("\n");
  const key = new RegExp(`^\\s*["']${component}\\d*["']\\s*:`);
  return lines.flatMap((line, i) =>
    key.test(line) ? [`${rel(path.join(dir, file))}:${i + 1}`] : [],
  );
}

function browserScripts(vue) {
  if (!vue || !CLIENT) return [];
  const needle = vue.split("/").slice(-3).join("/"); // components/<dir>/<file>.vue
  return listFiles(path.join(WAF_JS, "clients", CLIENT), (f) =>
    f.endsWith(".js"),
  )
    .filter((f) => readFileSync(f, "utf8").includes(needle))
    .map(rel);
}

// ---- plugins that already port a widget ----
const ported = listFiles(path.join(PLUGINS_ROOT ?? "", "fortress"), (f) =>
  f.endsWith(`${path.sep}legacy-port.json`),
).flatMap((file) => {
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    return [{ ...cfg, origin: new URL(cfg.legacyUrl).origin }];
  } catch {
    return [];
  }
});
function portStatus(widget) {
  const same = ported.find((p) => p.widget === widget && p.origin === origin);
  if (same) return `ported: ${same.pluginId}`;
  const other = ported.find((p) => p.widget === widget);
  if (other) {
    return `ported for ${new URL(other.legacyUrl).host} as ${other.pluginId} — reuse its markup/parser, re-extract CSS`;
  }
  return "new";
}

// ---- widgets a browser script mounts (no server-rendered markup) ----
// Some placeholders only hold `<div class="si-waf-widget" widget-id="si-xyz-01">`;
// the client's widgetConfig.json maps that id to a class, a script and its feeds.
function findKey(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  if (key in obj) return obj[key];
  for (const value of Object.values(obj)) {
    const hit = findKey(value, key);
    if (hit) return hit;
  }
  return null;
}
const widgetConfig = (() => {
  const file = WAF_JS && CLIENT && path.join(WAF_JS, "clients", CLIENT, "js", "widgetConfig.json");
  try {
    return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
})();

function placeholderHtml(id, allIds) {
  if (!id) return "";
  const at = liveHtml.indexOf(`id="${id}"`);
  if (at < 0) return "";
  const ends = allIds
    .filter((other) => other && other !== id)
    .map((other) => liveHtml.indexOf(`id="${other}"`, at + 1))
    .filter((i) => i > at);
  return liveHtml.slice(at, ends.length ? Math.min(...ends) : at + 20000);
}

function mountedWidget(id, allIds) {
  const tag = placeholderHtml(id, allIds).match(
    /<[a-z]+\b[^>]*\bwidget-id="([^"]+)"[^>]*>/,
  );
  if (!tag) return null;
  const widgetId = tag[1];
  const attr = (name) => tag[0].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
  const entry = findKey(widgetConfig?.widgets ?? widgetConfig, widgetId);
  const vue =
    entry?.className && CLIENT
      ? listFiles(path.join(WAF_JS, "clients", CLIENT), (f) =>
          f.endsWith(`${path.sep}${entry.className}.vue`),
        ).map(rel)[0] ?? null
      : null;
  return {
    widgetId,
    seriesId: attr("series-id"),
    teamId: attr("team-id"),
    className: entry?.className ?? null,
    script: entry?.fileName && CLIENT ? `clients/${CLIENT}/${entry.fileName}` : null,
    vue,
    apis: entry?.apis ?? null,
  };
}

// ---- the widgets ----
function placeholders(html) {
  return [
    ...html.matchAll(/<(?:section|div)\b[^>]*data-component="[^"]+"[^>]*>/g),
  ].map(([tag]) => ({
    id: tag.match(/\bid="([^"]+)"/)?.[1] ?? null,
    component: tag
      .match(/data-component="([^"]+)"/)[1]
      .toLowerCase()
      .replace(/\s+/g, ""),
    template: tag.match(/data-template="([^"]+)"/)?.[1] ?? "",
    mobile: tag.match(/data-mobile="([^"]+)"/)?.[1] ?? null,
  }));
}

/**
 * Root class of the server-rendered widget inside its own placeholder, e.g.
 * ".waf-standings" — searched only up to the next placeholder.
 */
function rootClass(id, allIds) {
  if (!id) return null;
  const at = liveHtml.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const ends = allIds
    .filter((other) => other && other !== id)
    .map((other) => liveHtml.indexOf(`id="${other}"`, at + 1))
    .filter((i) => i > at);
  const end = ends.length ? Math.min(...ends) : at + 20000;
  const m = liveHtml
    .slice(at, end)
    .match(/class="([^"]*\bwaf-component\b[^"]*)"/);
  const cls = m?.[1]
    .split(/\s+/)
    .find(
      (c) =>
        c &&
        c !== "waf-component" &&
        c !== "si-waf-widget" &&
        !/^widget-layout-?\d+$/.test(c),
    );
  return cls ? `.${cls}` : null;
}

const modulesById = new Map((content.module ?? []).map((m) => [m.selector, m]));
const body = placeholders(content.html ?? "").map((p) => ({
  ...p,
  area: "body",
}));
const shell = placeholders(content.masterhtml ?? "").map((p) => ({
  ...p,
  area: "shell",
}));
const allIds = [...shell, ...body].map((p) => p.id);
const seenPluginIds = new Set();
const widgets = [...shell, ...body].map((p, index) => {
  const module = p.id ? modulesById.get(p.id) : undefined;
  const widget = `${p.component}/${p.template.replaceAll("_", "-")}`;
  const vue = vueFile(p.component, p.template);
  const mounted = mountedWidget(p.id, allIds);
  let pluginId = `${values.prefix}-${mounted?.className ?? p.component.replace(/^si-/, "")}`;
  if (seenPluginIds.has(pluginId))
    pluginId = `${pluginId}-${normalise(p.template)}`;
  seenPluginIds.add(pluginId);
  const root = rootClass(p.id, allIds);
  return {
    index: index + 1,
    area: p.area,
    title: module?.display_title || module?.title || "",
    component: p.component,
    template: p.template,
    mobileTemplate: p.mobile,
    widget,
    root,
    mounted,
    status: portStatus(widget),
    legacy: {
      vue: mounted?.vue ?? vue,
      parser: parserEntries(p.component),
      browserScripts: browserScripts(vue),
      feeds: widgetFeeds[p.component] ?? null,
      stylesheets: stylesheets.filter((s) =>
        s.includes(p.component.replace(/^si-/, "")),
      ),
    },
    settings: module?.meta_info ?? null,
    suggestedConfig:
      p.area === "body"
        ? {
            pluginId,
            legacyUrl: pageUrl.href,
            root: root ?? (mounted?.className ? `.waf-${mounted.className}` : ".<root-class>"),
            ...(mounted ? { clientRendered: true } : {}),
            pluginRoot: `[data-legacy-port="${pluginId}"]`,
            widget,
            states: [{ name: "default" }],
            hover: [],
            interaction: [],
          }
        : null,
  };
});

// Grid/display keys every WAF widget carries; on screen only the rest is listed.
const STANDARD_SETTING =
  /^(xs|sm|md|lg|xl)_(col|row)$|_tag_attributes$|^dynamic_content_type_|^show_(date|author|category|item_icon|description|title|widget_title)$|^(loadmore_type|duplicate_content|showitem_icon_content|article_title_tag|article_description_tag|widget_title_tag|extraData)$/;

// ---- output ----
const outDir = path.join(os.tmpdir(), "legacy-port", "inventory");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(
  outDir,
  `${pageUrl.host}-${slug.replaceAll("/", "_") || "home"}.json`,
);
writeFileSync(
  outFile,
  JSON.stringify(
    {
      page: pageUrl.href,
      title: content.title ?? null,
      clientId,
      clientCode: CLIENT,
      wafJs: WAF_JS,
      wafCss: WAF_CSS,
      widgets,
    },
    null,
    2,
  ),
);

const clientNote = CLIENT ? ` (clients/${CLIENT})` : "";
console.log(
  `${pageUrl.href} — "${content.title ?? ""}" — client ${clientId || "?"}${clientNote}`,
);
if (!WAF_JS)
  console.log(
    "wm-si-wafjs3.0 not found: pass --waf-js <path> to locate sources.",
  );
console.log(
  WAF_CSS
    ? `legacy SCSS: ${WAF_CSS}`
    : "wm-si-wafcss3.0 not found (optional): set WAF_CSS_REPO to read the legacy SCSS.",
);
if (!PLUGINS_ROOT)
  console.log(
    "Surface plugins repo not found: run from fanxp-web-renderer or set SURFACE_PLUGINS_DIR; port status is unknown.",
  );
console.log("");
for (const w of widgets) {
  const title = w.title ? ` "${w.title}"` : "";
  console.log(
    `${String(w.index).padStart(2)}. [${w.area}] ${w.widget}${title} — root ${w.root ?? "?"} — ${w.status}`,
  );
  if (w.mounted) {
    console.log(
      `      mounted: ${w.mounted.widgetId} by a browser script — client-rendered (set "clientRendered": true)`,
    );
    if (w.mounted.script) console.log(`      script:  ${w.mounted.script}`);
    if (w.mounted.apis) console.log(`      apis:    ${JSON.stringify(w.mounted.apis)}`);
    const ids = [
      w.mounted.seriesId && `series-id=${w.mounted.seriesId}`,
      w.mounted.teamId && `team-id=${w.mounted.teamId}`,
    ].filter(Boolean);
    if (ids.length) console.log(`      mount:   ${ids.join(" ")}`);
  }
  if (w.legacy.vue) console.log(`      vue:     ${w.legacy.vue}`);
  for (const p of w.legacy.parser) console.log(`      parser:  ${p}`);
  for (const s of w.legacy.browserScripts) console.log(`      browser: ${s}`);
  if (w.legacy.feeds) {
    const feeds = JSON.stringify(w.legacy.feeds);
    const shown =
      feeds.length > 300 ? `${feeds.slice(0, 300)}… (full in the JSON)` : feeds;
    console.log(`      feeds:   ${shown}`);
  }
  if (w.settings) {
    const keys = Object.keys(w.settings);
    const specific = keys.filter((k) => !STANDARD_SETTING.test(k));
    const standard = keys.length - specific.length;
    console.log(
      `      settings: ${specific.join(", ") || "(none)"}${standard ? ` (+${standard} standard display keys)` : ""}`,
    );
  }
}
console.log(
  `\ndetail and starter legacy-port.json per body widget: ${outFile}`,
);
