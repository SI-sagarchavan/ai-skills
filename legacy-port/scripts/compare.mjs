#!/usr/bin/env node
// Compares the Tailwind plugin with the live legacy widget. The markup is not
// the legacy markup, so element-for-element checks do not apply; instead:
//   1. pixels — screenshots of both roots at each compare width and UI state,
//      pixelmatch at `tolerance.pixelThreshold`; PASS when the differing share
//      is at most `tolerance.pixelRatio` and the sizes agree within
//      `tolerance.sizePx`. A legacy | plugin side-by-side and a diff PNG each;
//   2. content — the visible text (word for word) and the link targets;
//   3. landmarks — optional legacy/plugin selector pairs whose box, colours
//      and type are checked within tolerance, to say *where* a drift is;
//   4. interaction — the configured steps, run on the plugin page.
// The tenant theme CSS from tokens.mjs is injected into the plugin page, so
// token classes render with the tenant's (and the proposed) values.
// Writes <workDir>/compare/report.json and the PNGs; exits 1 on FAIL.
//
//   node compare.mjs <plugin-dir> [--plugin-url <url>]
// The plugin URL defaults to the local renderer's /dev/plugins/<pluginId>
// route, with the fonts reference-css.mjs found.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  addStyle,
  fontsReady,
  launch,
  neutralise,
  openLegacy,
  openPlugin,
  setState,
} from "./lib/browser.mjs";
import { colorDistance, parseColor } from "./lib/color.mjs";
import { loadPortConfig, previewUrl } from "./lib/config.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "plugin-url": { type: "string" } },
});
if (positionals.length !== 1) {
  console.error("Usage: node compare.mjs <plugin-dir> [--plugin-url <url>]");
  process.exit(2);
}
const config = loadPortConfig(positionals[0]);
const TOL = config.tolerance;
const readWork = (name) => {
  const file = path.join(config.workDir, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const fonts = JSON.parse(readWork("fonts.json") ?? "{}");
const themeCss = readWork("theme.css");
// tokens.mjs records the tenant's own fonts. When known, the plugin page gets
// them the way Surface serves them, and only the legacy fonts the user agreed
// to register (`registerFonts`) are added on top, so compare reflects what
// the tenant will actually render.
const tenantFonts = JSON.parse(readWork("tenant-fonts.json") ?? "null");
config.tenantHost = tenantFonts?.host ?? null;
const pluginFonts = tenantFonts
  ? Object.fromEntries(
      Object.entries(fonts).filter(([family]) =>
        config.registerFonts.includes(family),
      ),
    )
  : fonts;
if (!tenantFonts) {
  console.warn(
    "no tenant-fonts.json: run tokens.mjs. Legacy fonts are loaded for the plugin, which a tenant without them will not do.",
  );
}
const PLUGIN_URL = values["plugin-url"] ?? previewUrl(config, pluginFonts);
const OUT = path.join(config.workDir, "compare");
mkdirSync(OUT, { recursive: true });
const LANDMARK_PROPS = [
  "color",
  "background-color",
  "border-bottom-color",
  "font-size",
  "font-weight",
  "line-height",
];

const t0 = Date.now();
const log = (msg) =>
  console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
setTimeout(
  () => {
    log("giving up after 15 minutes");
    process.exit(2);
  },
  15 * 60 * 1000,
).unref();

const browser = await launch();
const ROOT = { legacy: config.root, plugin: config.pluginRoot };

async function prepare(page, side) {
  if (side === "plugin" && themeCss) await addStyle(page, themeCss);
  await neutralise(page, config);
  await fontsReady(page);
  await page.waitForTimeout(300);
  if (!(await page.$(ROOT[side]))) {
    throw new Error(
      `${ROOT[side]} not found on ${page.url()}${side === "plugin" ? " — put it on the plugin's root element (legacy-port.json pluginRoot)" : ""}`,
    );
  }
}

/** Visible text as words, and link targets as path+query, of one root. */
const content = (page, side) =>
  page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    const words = root.innerText.split(/\s+/).filter(Boolean);
    const links = [...root.querySelectorAll("a[href]")]
      .filter((a) => a.getClientRects().length)
      .map((a) => {
        const url = new URL(a.getAttribute("href"), location.href);
        return url.origin === location.origin || a.getAttribute("href").startsWith("/")
          ? `${url.pathname}${url.search}`
          : url.href;
      });
    return { words, links };
  }, ROOT[side]);

function firstDifference(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return {
        index: i,
        legacy: a.slice(Math.max(0, i - 3), i + 4).join(" "),
        plugin: b.slice(Math.max(0, i - 3), i + 4).join(" "),
      };
    }
  }
  return null;
}

/** Box (relative to the root) and LANDMARK_PROPS of a landmark's first match. */
const probe = (page, side, selector) =>
  page.evaluate(
    ({ rootSelector, selector, props }) => {
      const root = document.querySelector(rootSelector);
      const el = selector ? root.querySelector(selector) : root;
      if (!el) return null;
      const o = root.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        box: [r.x - o.x, r.y - o.y, r.width, r.height].map(Math.round),
        css: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])),
      };
    },
    { rootSelector: ROOT[side], selector, props: LANDMARK_PROPS },
  );

function landmarkProblems(name, a, b) {
  if (!a || !b) {
    return [`${name}: ${a ? "plugin" : "legacy"} selector matches nothing`];
  }
  const out = [];
  const boxDelta = a.box.map((v, i) => Math.abs(v - b.box[i]));
  if (Math.max(...boxDelta) > TOL.boxPx) {
    out.push(`${name}: box [x,y,w,h] ${a.box} vs ${b.box}`);
  }
  for (const prop of ["color", "background-color", "border-bottom-color"]) {
    const ca = parseColor(a.css[prop]);
    const cb = parseColor(b.css[prop]);
    if (!ca || !cb) continue;
    if (ca.a === 0 && cb.a === 0) continue;
    const dE = colorDistance(ca, cb);
    if (dE > TOL.colorDeltaE || Math.abs(ca.a - cb.a) > 0.02) {
      out.push(
        `${name}: ${prop} ${a.css[prop]} vs ${b.css[prop]} (ΔE ${dE.toFixed(1)})`,
      );
    }
  }
  for (const prop of ["font-size", "line-height"]) {
    const pa = Number.parseFloat(a.css[prop]);
    const pb = Number.parseFloat(b.css[prop]);
    if (Number.isFinite(pa) && Number.isFinite(pb)) {
      if (Math.abs(pa - pb) > TOL.fontPx)
        out.push(`${name}: ${prop} ${a.css[prop]} vs ${b.css[prop]}`);
    } else if (a.css[prop] !== b.css[prop]) {
      out.push(`${name}: ${prop} ${a.css[prop]} vs ${b.css[prop]}`);
    }
  }
  if (a.css["font-weight"] !== b.css["font-weight"]) {
    out.push(
      `${name}: font-weight ${a.css["font-weight"]} vs ${b.css["font-weight"]}`,
    );
  }
  return out;
}

function diffPng(a, b, name) {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  const w = Math.max(A.width, B.width);
  const h = Math.max(A.height, B.height);
  const pad = (img) => {
    const out = new PNG({ width: w, height: h });
    out.data.fill(255);
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
    return out;
  };
  const pa = pad(A);
  const pb = pad(B);
  const diff = new PNG({ width: w, height: h });
  const changed = pixelmatch(pa.data, pb.data, diff.data, w, h, {
    threshold: TOL.pixelThreshold,
  });
  writeFileSync(path.join(OUT, `${name}-diff.png`), PNG.sync.write(diff));
  const sbs = new PNG({ width: w * 2 + 20, height: h });
  sbs.data.fill(255);
  PNG.bitblt(pa, sbs, 0, 0, w, h, 0, 0);
  PNG.bitblt(pb, sbs, 0, 0, w, h, w + 20, 0);
  writeFileSync(
    path.join(OUT, `${name}-side-by-side.png`),
    PNG.sync.write(sbs),
  );
  return {
    legacy: [A.width, A.height],
    plugin: [B.width, B.height],
    changed,
    total: w * h,
    ratio: +(changed / (w * h)).toFixed(5),
  };
}

// ---- steps: plugin-side states and the interaction ----
async function runStep(page, step) {
  const scoped = (selector) =>
    page.locator(config.pluginRoot).first().locator(selector);
  if (step.click) {
    let target = scoped(step.click);
    if (step.hasText) target = target.filter({ hasText: step.hasText });
    const response = step.waitForResponse
      ? page.waitForResponse((r) => r.url().includes(step.waitForResponse))
      : null;
    await target.first().click();
    if (response) {
      const res = await response;
      return {
        ok: res.ok(),
        detail: `${new URL(res.url()).pathname} -> ${res.status()}`,
      };
    }
    await page.waitForTimeout(200);
    return { ok: true, detail: "clicked" };
  }
  if (step.hover) {
    await scoped(step.hover).first().hover();
    await page.waitForTimeout(200);
    return { ok: true, detail: "hovered" };
  }
  if (step.expect) {
    const { selector, count, text, contains } = step.expect;
    const target = scoped(selector);
    if (count !== undefined) {
      const actual = await target.count();
      return {
        ok: actual === count,
        detail: `count ${actual} (want ${count})`,
      };
    }
    const actual = (await target.first().innerText())
      .replace(/\s+/g, " ")
      .trim();
    if (contains !== undefined) {
      return {
        ok: actual.includes(contains),
        detail: `text "${actual}" (want it to contain "${contains}")`,
      };
    }
    return {
      ok: actual === text,
      detail: `text "${actual}" (want "${text}")`,
    };
  }
  return { ok: false, detail: `unknown step ${JSON.stringify(step)}` };
}

async function runSteps(page, steps = []) {
  const results = [];
  for (const step of steps) {
    try {
      results.push({ step, ...(await runStep(page, step)) });
    } catch (error) {
      results.push({ step, ok: false, detail: String(error.message ?? error) });
    }
  }
  return results;
}

const screenshotTarget = (state, side) => {
  const pick =
    typeof state.screenshot === "string"
      ? state.screenshot
      : state.screenshot?.[side];
  return pick ? `${ROOT[side]} ${pick}` : ROOT[side];
};

const report = {
  legacyUrl: config.legacyUrl,
  pluginUrl: PLUGIN_URL,
  themeCss: Boolean(themeCss),
  tolerance: TOL,
  viewports: {},
};
// Desktop User-Agent at every compare width; with mobileMarkup, a phone
// User-Agent as well at the widths below the breakpoint ("390px-phone").
const runs = config.compareViewports.map((width) => ({
  width,
  mobile: false,
  label: `${width}px`,
}));
if (config.mobileMarkup) {
  for (const width of config.compareViewports) {
    if (width < config.mobileBreakpoint)
      runs.push({ width, mobile: true, label: `${width}px-phone` });
  }
}
/**
 * Font families the plugin draws text or icon glyphs with that no loaded font
 * face provides: the tenant does not register them (an icon font from the
 * legacy site, say), so Surface would fall back to a system font or draw the
 * browser's empty missing-glyph box. Checked on the first family of each
 * element that has text and each pseudo-element that has content.
 */
const missingFonts = (page, rootSelector) =>
  page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return [];
    const SYSTEM = new Set([
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "fantasy",
      "system-ui",
      "ui-sans-serif",
      "ui-serif",
      "ui-monospace",
      "-apple-system",
      "blinkmacsystemfont",
      "arial",
      "helvetica",
      "helvetica neue",
      "times new roman",
      "times",
      "courier new",
      "courier",
    ]);
    const used = new Map();
    const note = (cs) => {
      const family = cs.fontFamily
        .split(",")[0]
        .trim()
        .replace(/^["']|["']$/g, "");
      if (family && !SYSTEM.has(family.toLowerCase())) {
        used.set(family, (used.get(family) ?? 0) + 1);
      }
    };
    for (const el of [root, ...root.querySelectorAll("*")]) {
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && n.textContent.trim(),
      );
      if (hasText) note(getComputedStyle(el));
      for (const pseudo of ["::before", "::after"]) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content !== "none" && cs.content !== "normal") note(cs);
      }
    }
    const loaded = new Set(
      [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => f.family.replace(/^["']|["']$/g, "")),
    );
    return [...used]
      .filter(([family]) => !loaded.has(family))
      .map(([family, count]) => ({ family, count }));
  }, rootSelector);

for (const { width, mobile, label } of runs) {
  log(`${label}: opening both pages`);
  const legacy = await openLegacy(browser, config, { width, mobile });
  await prepare(legacy.page, "legacy");
  const plugin = await openPlugin(browser, config, PLUGIN_URL, {
    width,
    mobile,
  });
  await prepare(plugin.page, "plugin");
  const entry = { states: {} };

  // Content and landmarks in the default state, before any step runs.
  const L = await content(legacy.page, "legacy");
  const P = await content(plugin.page, "plugin");
  entry.content = {
    words: [L.words.length, P.words.length],
    textDiff: firstDifference(L.words, P.words),
    links: [L.links.length, P.links.length],
    linkDiff: firstDifference(L.links, P.links),
  };
  entry.missingFonts = await missingFonts(plugin.page, config.pluginRoot);
  entry.landmarks = [];
  for (const mark of config.landmarks) {
    const a = await probe(legacy.page, "legacy", mark.legacy);
    const b = await probe(plugin.page, "plugin", mark.plugin);
    entry.landmarks.push({
      name: mark.name,
      legacy: a,
      plugin: b,
      problems: landmarkProblems(mark.name, a, b),
    });
  }

  for (const [i, state] of config.states.entries()) {
    if (i > 0 && state.plugin?.length) {
      // A fresh plugin page per state: the steps assume the default state.
      await plugin.page.reload({ waitUntil: "load" });
      await prepare(plugin.page, "plugin");
    }
    await setState(legacy.page, config, state);
    const steps = await runSteps(plugin.page, state.plugin);
    await legacy.page.waitForTimeout(100);
    await plugin.page.waitForTimeout(100);
    const a = await legacy.page
      .locator(screenshotTarget(state, "legacy"))
      .first()
      .screenshot();
    const b = await plugin.page
      .locator(screenshotTarget(state, "plugin"))
      .first()
      .screenshot();
    const name = `${label}-${state.name}`;
    writeFileSync(path.join(OUT, `${name}-legacy.png`), a);
    writeFileSync(path.join(OUT, `${name}-plugin.png`), b);
    entry.states[state.name] = {
      ...diffPng(a, b, name),
      steps: steps.filter((s) => !s.ok),
    };
  }
  report.viewports[label] = entry;
  await legacy.context.close();
  await plugin.context.close();
}

if (config.interaction.length) {
  const width = Math.max(...config.compareViewports);
  log(`interaction at ${width}px`);
  const { context, page } = await openPlugin(browser, config, PLUGIN_URL, {
    width,
  });
  await prepare(page, "plugin");
  report.interaction = await runSteps(page, config.interaction);
  await page.waitForTimeout(300);
  await page
    .locator(config.pluginRoot)
    .first()
    .screenshot({ path: path.join(OUT, `${width}-after-interaction.png`) });
  await context.close();
}
await browser.close();

// ---- verdict ----
const problems = [];
if (!themeCss) {
  problems.push(
    "no theme.css: run tokens.mjs first, or token classes render unstyled",
  );
}
for (const [label, entry] of Object.entries(report.viewports)) {
  const { textDiff, linkDiff } = entry.content;
  if (textDiff) {
    problems.push(
      `${label}: text differs at word ${textDiff.index}: legacy "${textDiff.legacy}" vs plugin "${textDiff.plugin}"`,
    );
  }
  if (linkDiff) {
    problems.push(
      `${label}: links differ at ${linkDiff.index}: legacy ${linkDiff.legacy || "(none)"} vs plugin ${linkDiff.plugin || "(none)"}`,
    );
  }
  for (const mark of entry.landmarks) {
    for (const p of mark.problems) problems.push(`${label}: ${p}`);
  }
  for (const { family, count } of entry.missingFonts ?? []) {
    const message = `font "${family}" is used by the plugin (${count} places) but no loaded font face provides it: the tenant does not register it. Use the tenant's family or icon font (tokens.mjs lists them), or add it to registerFonts if the user agreed to register it`;
    if (!problems.includes(message)) problems.push(message);
  }
  for (const [state, px] of Object.entries(entry.states)) {
    const dw = Math.abs(px.legacy[0] - px.plugin[0]);
    const dh = Math.abs(px.legacy[1] - px.plugin[1]);
    if (Math.max(dw, dh) > TOL.sizePx) {
      problems.push(
        `${label} ${state}: size ${px.legacy.join("x")} vs ${px.plugin.join("x")}`,
      );
    }
    if (px.ratio > TOL.pixelRatio) {
      problems.push(
        `${label} ${state}: ${(px.ratio * 100).toFixed(2)}% of pixels differ (allowed ${(TOL.pixelRatio * 100).toFixed(2)}%)`,
      );
    }
    for (const s of px.steps) {
      problems.push(
        `${label} ${state}: state step ${JSON.stringify(s.step)}: ${s.detail}`,
      );
    }
  }
}
for (const s of report.interaction ?? []) {
  if (!s.ok)
    problems.push(`interaction ${JSON.stringify(s.step)}: ${s.detail}`);
}
report.verdict = problems.length ? "FAIL" : "PASS";
report.problems = problems;
writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

for (const [label, entry] of Object.entries(report.viewports)) {
  const px = Object.entries(entry.states)
    .map(
      ([state, r]) =>
        `${state} ${(r.ratio * 100).toFixed(2)}% (${r.changed}/${r.total} px, ${r.legacy.join("x")} vs ${r.plugin.join("x")})`,
    )
    .join(", ");
  const c = entry.content;
  const landmarkIssues = entry.landmarks.reduce(
    (n, m) => n + m.problems.length,
    0,
  );
  console.log(
    `${label}  ${px} | text: ${c.textDiff ? "DIFFERS" : "same"} (${c.words[0]} words) | links: ${c.linkDiff ? "DIFFER" : "same"} (${c.links[0]}) | landmarks: ${entry.landmarks.length ? `${landmarkIssues} issue(s)` : "none set"}`,
  );
}
for (const s of report.interaction ?? []) {
  console.log(
    `interaction ${s.ok ? "ok  " : "FAIL"} ${JSON.stringify(s.step)} — ${s.detail}`,
  );
}
const problemList = problems.map((p) => `\n  ${p}`).join("");
console.log(`\n${report.verdict}${problems.length ? ":" : ""}${problemList}`);
console.log(`report and side-by-side PNGs: ${OUT}`);
process.exit(problems.length ? 1 : 0);
