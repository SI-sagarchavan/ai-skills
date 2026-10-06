#!/usr/bin/env node
// Turns <workDir>/extract.json into <workDir>/legacy.css: the widget's legacy
// styling as one readable stylesheet. It is the spec the Tailwind markup is
// written from — it is never shipped in the plugin.
//   - widget rules (anchored on the root class) keep their selectors; anything
//     left of the root (page context) is dropped;
//   - generic rules (Bootstrap reboot, the WAF reset, .waf-component …) are
//     scoped with :where(<root>);
//   - rem values are rescaled (legacy root is 62.5% = 10px, Surface's 16px);
//   - legacy custom properties and the inherited base text style go on the
//     widget root;
//   - earlier copies of a property the same rule sets again are dropped,
//     unless the later value is one older browsers may not support;
//   - rules keep their original cascade order, media queries included.
// Then finds a working file for each font family the widget uses and prints
// the Font Manager list and the local preview URL. tokens.mjs reads legacy.css.
//
//   node reference-css.mjs <plugin-dir>      (after extract-css.mjs)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadPortConfig, previewUrl } from "./lib/config.mjs";

const { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 1) {
  console.error("Usage: node reference-css.mjs <plugin-dir>");
  process.exit(2);
}
const config = loadPortConfig(positionals[0]);
const extractFile = path.join(config.workDir, "extract.json");
if (!existsSync(extractFile)) {
  console.error(
    `No ${extractFile} — run extract-css.mjs ${positionals[0]} first.`,
  );
  process.exit(1);
}
const input = JSON.parse(readFileSync(extractFile, "utf8"));
if (input.root !== config.root || input.url !== config.legacyUrl) {
  console.error(
    `${extractFile} was extracted for ${input.root} on ${input.url}; re-run extract-css.mjs.`,
  );
  process.exit(1);
}

const ROOT = config.rootClass;
const ROOT_RE = new RegExp(String.raw`\.${ROOT}(?![\w-])`);
const SCOPE = `:where(.${ROOT})`;

const rescaleRem = (text) =>
  text.replace(
    /(-?\d*\.?\d+)rem\b/g,
    (_, n) => `${+(Number(n) * config.remScale).toFixed(6)}rem`,
  );
// Icon-font glyphs (Private Use Area) as CSS escapes, so no pipeline mangles them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the range is "everything outside printable ASCII"
const NON_ASCII = /[^\x00-\x7e]/gu;
const escapeNonAscii = (text) =>
  text.replace(NON_ASCII, (c) => `\\${c.codePointAt(0).toString(16)} `);

const DEPTH_CHANGE = { "(": 1, "[": 1, ")": -1, "]": -1 };

/** Split a selector into top-level compounds and combinators. */
function tokenize(selector) {
  const tokens = [];
  let buf = "";
  let depth = 0;
  const flush = () => {
    if (buf.trim()) tokens.push({ type: "compound", text: buf.trim() });
    buf = "";
  };
  const combinator = (text) => {
    flush();
    const last = tokens.at(-1);
    if (text === " ") {
      if (last?.type === "compound") tokens.push({ type: "combinator", text });
    } else if (last?.text === " ") {
      last.text = text; // "a > b": the space before ">" is not a combinator
    } else {
      tokens.push({ type: "combinator", text });
    }
  };
  for (const ch of selector) {
    depth += DEPTH_CHANGE[ch] ?? 0;
    if (depth === 0 && ">+~".includes(ch)) combinator(ch);
    else if (depth === 0 && /\s/.test(ch)) combinator(" ");
    else buf += ch;
  }
  flush();
  while (tokens.at(-1)?.type === "combinator") tokens.pop();
  return tokens;
}
const join = (tokens) =>
  tokens
    .map((t) => {
      if (t.type !== "combinator") return t.text;
      return t.text === " " ? " " : ` ${t.text} `;
    })
    .join("");

/** `*::before` -> `*:where(.root)::before` (the pseudo-element stays last). */
function attachToRoot(selector) {
  const last = tokenize(selector).at(-1).text;
  const m = last.match(
    /^(.*?)(::?(?:before|after|placeholder|selection|marker))?$/,
  );
  return `${m[1] || "*"}${SCOPE}${m[2] || ""}`;
}

function scopeSelector(selector, hits) {
  if (ROOT_RE.test(selector)) {
    const tokens = tokenize(selector);
    const idx = tokens.findIndex(
      (t) => t.type === "compound" && ROOT_RE.test(t.text),
    );
    return [join(tokens.slice(idx))];
  }
  const out = [];
  if (hits.some((h) => h.nodeIndex > 0)) out.push(`${SCOPE} ${selector}`);
  if (hits.some((h) => h.nodeIndex === 0)) out.push(attachToRoot(selector));
  return out;
}

// A repeated property whose later value older browsers may not support is a
// deliberate fallback (`height: 100vh; height: 100dvh`) and stays.
const MODERN_VALUE =
  /-(webkit|moz|ms|o)-|\d(dvh|svh|lvh|dvw|svw|lvw)\b|color-mix\(|clamp\(/;
const dropped = [];
function dropOverridden(decls, selector) {
  const last = new Map(decls.map(([prop], i) => [prop, i]));
  return decls.filter(([prop, value], i) => {
    const keep =
      last.get(prop) === i || MODERN_VALUE.test(decls[last.get(prop)][1]);
    if (!keep) dropped.push(`${selector.split("\n")[0]} { ${prop}: ${value} }`);
    return keep;
  });
}

const ICON_FONT_NOTE =
  "  /* biome-ignore lint/a11y/useGenericFontNames: icon font; a generic fallback would draw the glyph as a box */";

// ---- rules ----
const blocks = [];
for (const rule of input.rules) {
  const selectors = [];
  for (const i of rule.matched) {
    const hits = rule.hits.filter((h) => h.i === i);
    for (const s of scopeSelector(rule.selectors[i], hits))
      selectors.push(s);
  }
  const selectorText = [...new Set(selectors)].join(",\n");
  const decls = escapeNonAscii(
    rescaleRem(rule.cssText.trim().replace(/;?\s*$/, "")),
  )
    .split(/;(?![^(]*\))/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const colon = d.indexOf(":");
      return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
    });
  const body = dropOverridden(decls, selectorText)
    .flatMap(([prop, value]) => [
      ...(prop === "font-family" && /icon/i.test(value)
        ? [ICON_FONT_NOTE]
        : []),
      `  ${prop}: ${value};`,
    ])
    .join("\n");
  blocks.push({
    media: rule.media.join(" and "),
    text: `${selectorText} {\n${body}\n}`,
  });
}

// ---- tokens: every custom property the rules use, transitively ----
const widths = input.viewports.map(String);
const vars = input.varsByWidth;
const used = new Set();
const queue = blocks.flatMap((b) =>
  [...b.text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]),
);
while (queue.length) {
  const name = queue.pop();
  if (used.has(name)) continue;
  used.add(name);
  for (const w of widths) {
    for (const m of String(vars[w][name] ?? "").matchAll(/var\((--[\w-]+)/g))
      queue.push(m[1]);
  }
}
const varying = [...used].filter(
  (n) => new Set(widths.map((w) => vars[w][n])).size > 1,
);

// ---- inherited base text style (from the widget's parent at the first width) ----
const base = input.inheritedByWidth[widths[0]];
const fontSizePx = Number.parseFloat(base["font-size"]);
const lineHeightPx = Number.parseFloat(base["line-height"]);
const baseDecls = [
  `color: ${base.color}`,
  `font-family: ${base["font-family"]}`,
  `font-size: ${+(fontSizePx / 16).toFixed(4)}rem`,
  `line-height: ${Number.isFinite(lineHeightPx) ? +(lineHeightPx / fontSizePx).toFixed(4) : "normal"}`,
  `font-weight: ${base["font-weight"]}`,
  `font-style: ${base["font-style"]}`,
  `letter-spacing: ${base["letter-spacing"]}`,
  `text-align: ${base["text-align"]}`,
  `text-transform: ${base["text-transform"]}`,
  `white-space: ${base["white-space"]}`,
  `word-spacing: ${base["word-spacing"]}`,
  `-webkit-font-smoothing: ${base["-webkit-font-smoothing"]}`,
];
// Tokens the rules use but no legacy stylesheet declares stay undeclared: on
// the live site those var() declarations fall back to the inherited/initial
// value, and they do the same here.
const declaredTokens = [...used].filter(
  (n) => vars[widths[0]][n] !== undefined && vars[widths[0]][n] !== "",
);
const undeclaredTokens = [...used].filter((n) => !declaredTokens.includes(n));
const tokenDecls = declaredTokens
  .sort((a, b) => a.localeCompare(b))
  .map((n) => `  ${n}: ${rescaleRem(vars[widths[0]][n])};`);

// ---- font families the stylesheet uses ----
const GENERIC = new Set([
  "inherit",
  "initial",
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "cursive",
  "fantasy",
]);
const families = new Set();
const addFamilies = (value) => {
  for (const name of value.split(",")) {
    const clean = name.trim().replace(/^["']|["']$/g, "");
    if (clean && !GENERIC.has(clean)) families.add(clean);
  }
};
for (const b of blocks) {
  for (const m of b.text.matchAll(/font-family:\s*([^;]+);/g))
    addFamilies(m[1]);
}
addFamilies(base["font-family"]);

// ---- emit ----
let css = `/*
 * ${config.pluginId}: legacy styling of ${config.widget ?? config.root}, the spec
 * for the plugin's Tailwind markup. Reference only — never ship this file.
 *
 * Chromium's own cascade for the widget on ${input.url}
 * at ${input.viewports.join("/")}px, states: ${input.states.join(", ")}, hover forced.
 * rem rescaled x${config.remScale} to Surface's 16px root. Legacy custom
 * properties and the inherited base text style sit on the root rule below.
 * Font families: ${[...families].join(", ")}.
 */

${SCOPE} {
${tokenDecls.join("\n")}
${baseDecls.map((d) => `  ${d};`).join("\n")}
}
`;
let openMedia = null;
for (const b of blocks) {
  if (b.media !== openMedia) {
    if (openMedia) css += "}\n";
    css += b.media ? `\n@media ${b.media} {\n` : "\n";
    openMedia = b.media || null;
  }
  css += `${b.media ? b.text.replace(/^/gm, "  ") : b.text}\n`;
}
if (openMedia) css += "}\n";
const outFile = path.join(config.workDir, "legacy.css");
writeFileSync(outFile, css);
formatWithRepoBiome(outFile, config.pluginDir);
const varyingNote = varying.length
  ? ` (differ by width: ${varying.join(", ")})`
  : "";
console.log(
  `wrote ${outFile}: ${blocks.length} rules, ${used.size} tokens${varyingNote}`,
);
if (undeclaredTokens.length) {
  console.log(
    `used but not declared by the legacy CSS (left as-is, falling back as on the live site): ${undeclaredTokens.join(", ")}`,
  );
}
if (dropped.length) {
  const droppedList = dropped.map((d) => `\n  ${d}`).join("");
  console.log(
    `dropped ${dropped.length} overridden declaration(s):${droppedList}`,
  );
}

/** Formatted with the renderer's Biome, so the spec reads like the repo's CSS. */
function formatWithRepoBiome(file, from) {
  let dir = from;
  while (true) {
    const biome = path.join(dir, "node_modules", ".bin", "biome");
    if (existsSync(biome)) {
      try {
        execFileSync(biome, ["format", "--write", file], { stdio: "ignore" });
      } catch {
        console.log(`(biome format failed on ${file}; left unformatted)`);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.log("(biome not found: legacy.css left unformatted)");
}

// ---- fonts: first source of each family that the live site actually serves ----
function fontSources(family) {
  const sources = [];
  for (const face of input.fontFaces) {
    const fam = face
      .match(/font-family:\s*([^;]+);/)?.[1]
      .trim()
      .replace(/^["']|["']$/g, "");
    if (fam !== family) continue;
    for (const m of face.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      sources.push(new URL(m[1], input.url).href);
    }
  }
  return [...new Set(sources)];
}

async function status(url) {
  try {
    const res = await fetch(url);
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

const fonts = {};
for (const family of families) {
  const tried = [];
  let url = null;
  for (const src of fontSources(family)) {
    const code = await status(src);
    tried.push({ url: src, status: code });
    if (code === 200) {
      url = src;
      break;
    }
  }
  fonts[family] = { url, tried };
}
writeFileSync(
  path.join(config.workDir, "fonts.json"),
  JSON.stringify(fonts, null, 2),
);
console.log("\nFonts to register in Font Manager:");
for (const [family, font] of Object.entries(fonts)) {
  const failed = font.tried
    .filter((t) => t.status !== 200)
    .map((t) => `${path.basename(new URL(t.url).pathname)} ${t.status}`);
  const skipped = failed.length ? `   (skipped: ${failed.join(", ")})` : "";
  console.log(`  ${family}: ${font.url ?? "NO WORKING SOURCE"}${skipped}`);
}
console.log(`\nPreview: ${previewUrl(config, fonts)}`);
