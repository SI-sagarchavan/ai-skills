#!/usr/bin/env node
// Records the legacy CSS rules that style one widget, straight from Chromium's
// cascade (CDP CSS.getMatchedStylesForNode): every element under the widget
// root, at every extract width, in every configured UI state, with :hover
// forced on the configured elements. With `mobileMarkup`, a second pass loads
// the page with a phone User-Agent (the legacy server then renders its mobile
// markup) at the widths below `mobileBreakpoint`; rules from both passes are
// merged. Writes <workDir>/extract.json, which reference-css.mjs turns into the
// reference stylesheet (legacy.css).
//
//   node extract-css.mjs <plugin-dir>      (reads <plugin-dir>/legacy-port.json)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { launch, openLegacy, setState } from "./lib/browser.mjs";
import { loadPortConfig } from "./lib/config.mjs";

const { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 1) {
  console.error("Usage: node extract-css.mjs <plugin-dir>");
  process.exit(2);
}
const config = loadPortConfig(positionals[0]);
const ROOT = config.root;
const INHERITED = [
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "word-spacing",
  "direction",
  "cursor",
  "visibility",
  "-webkit-font-smoothing",
  "text-rendering",
];

const rules = new Map();
const inheritedByWidth = {};
const varsByWidth = {};
const widthByViewport = {};
let nodes = [];
let fontFaces = [];

/** Cascade order between stylesheets = document order of their <style>/<link>. */
async function sheetOrderFor(page, cdp) {
  await page.evaluate(() => {
    document
      .querySelectorAll('style, link[rel~="stylesheet"]')
      .forEach((el, i) => {
        el.dataset.lpOrder = String(i);
      });
  });
  const headers = [];
  cdp.on("CSS.styleSheetAdded", ({ header }) => headers.push(header));
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const order = new Map();
  for (const header of headers) {
    let index = Number.MAX_SAFE_INTEGER;
    if (header.ownerNode) {
      const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId: header.ownerNode,
      });
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration:
          "function () { return this.dataset.lpOrder ?? null; }",
        returnByValue: true,
      });
      if (result.value !== null) index = Number(result.value);
    }
    order.set(header.styleSheetId, index);
  }
  return order;
}

function record(sheetOrder, match, nodeIndex, pseudo) {
  const rule = match.rule;
  if (rule.origin !== "regular") return; // user-agent and injected sheets
  const media = (rule.media || []).map((m) => m.text).filter(Boolean);
  const start = rule.style.range
    ? rule.style.range.startLine * 1e6 + rule.style.range.startColumn
    : 0;
  const key = `${media.join("|")}::${rule.selectorList.text}::${rule.style.cssText}`;
  let entry = rules.get(key);
  if (!entry) {
    entry = {
      sheet: sheetOrder.get(rule.styleSheetId) ?? Number.MAX_SAFE_INTEGER,
      start,
      media,
      selectors: rule.selectorList.selectors.map((s) => s.text),
      cssText: rule.style.cssText,
      matched: new Set(),
      hits: [],
    };
    rules.set(key, entry);
  }
  for (const i of match.matchingSelectors) {
    entry.matched.add(i);
    entry.hits.push({ i, nodeIndex, pseudo: pseudo || null });
  }
}

async function extractPass(browser, { mobile, widths }) {
  const { context, page } = await openLegacy(browser, config, {
    width: widths[0],
    height: 1400,
    mobile,
  });
  if (!(await page.$(ROOT))) {
    throw new Error(
      `${ROOT} is not on ${config.legacyUrl} (JavaScript off${mobile ? ", phone User-Agent" : ""}).`,
    );
  }
  const cdp = await context.newCDPSession(page);
  const sheetOrder = await sheetOrderFor(page, cdp);

  // One DOM.getDocument per pass: every call re-issues node ids, which would
  // make ids from different queries incomparable. Class/style changes keep
  // the ids stable.
  const { root: documentNode } = await cdp.send("DOM.getDocument", {
    depth: -1,
  });
  const query = async (selector) => {
    const { nodeIds: ids } = await cdp.send("DOM.querySelectorAll", {
      nodeId: documentNode.nodeId,
      selector,
    });
    return ids;
  };
  const collectNode = async (nodeId, nodeIndex) => {
    const res = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
    for (const m of res.matchedCSSRules || [])
      record(sheetOrder, m, nodeIndex, null);
    for (const pe of res.pseudoElements || []) {
      for (const m of pe.matches || [])
        record(sheetOrder, m, nodeIndex, pe.pseudoType);
    }
  };
  const forceHover = async (indexOf, limitTo) => {
    for (const selector of config.hover) {
      const hovered = (await query(`${ROOT} ${selector}`)).filter(
        (id) => !limitTo || limitTo.has(id),
      );
      for (const id of hovered.slice(0, 2)) {
        await cdp.send("CSS.forcePseudoState", {
          nodeId: id,
          forcedPseudoClasses: ["hover"],
        });
        await collectNode(id, indexOf.get(id));
        await cdp.send("CSS.forcePseudoState", {
          nodeId: id,
          forcedPseudoClasses: [],
        });
      }
    }
  };
  // A state only changes the classes/styles of the elements it targets, so
  // only those, their descendants and their later siblings can match other
  // rules than in the default state.
  const affectedBy = async (state) => {
    const targets = [
      ...(state.addClass ?? []),
      ...(state.removeClass ?? []),
      ...(state.setStyle ?? []),
    ].map(({ selector }) => `${ROOT} ${selector}`.trim());
    if (!targets.length) return new Set();
    const selector = targets
      .flatMap((t) => [t, `${t} *`, `${t} ~ *`, `${t} ~ * *`])
      .join(", ");
    return new Set(await query(selector));
  };

  // Which rules match depends on the width only through media queries, so a
  // width whose media queries all evaluate as an earlier one's adds nothing.
  const mediaSignature = () =>
    page.evaluate(() => {
      const texts = new Set();
      const scan = (rule) => {
        if (rule.media) texts.add(rule.media.mediaText);
        if (rule.cssRules) for (const child of rule.cssRules) scan(child);
      };
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) scan(rule);
        } catch {
          // cross-origin sheet
        }
      }
      return [...texts]
        .sort((a, b) => a.localeCompare(b))
        .map((t) => (matchMedia(t).matches ? "1" : "0"))
        .join("");
    });
  const seenSignatures = new Set();

  for (const width of widths) {
    await page.setViewportSize({ width, height: 1400 });
    const signature = await mediaSignature();
    if (seenSignatures.has(signature)) {
      if (!mobile) await recordRootInfo(page, width);
      console.log(
        `  ${width}px${mobile ? " (phone UA)" : ""}: same media queries as an earlier width, skipped`,
      );
      continue;
    }
    seenSignatures.add(signature);
    // The element set is the same in every state; only classes/styles change.
    await setState(page, config, config.states[0]);
    const ids = await query(`${ROOT}, ${ROOT} *`);
    const indexOf = new Map(ids.map((id, i) => [id, i]));
    for (const [n, state] of config.states.entries()) {
      await setState(page, config, state);
      const affected = n === 0 ? null : await affectedBy(state);
      for (const id of ids) {
        if (!affected || affected.has(id))
          await collectNode(id, indexOf.get(id));
      }
      await forceHover(indexOf, affected);
    }
    await setState(page, config, config.states[0]);
    if (!mobile) await recordRootInfo(page, width);
    console.log(
      `  ${width}px${mobile ? " (phone UA)" : ""}: ${rules.size} rules so far`,
    );
  }
  if (!mobile) {
    nodes = await page.evaluate((root) => {
      const all = [
        document.querySelector(root),
        ...document.querySelectorAll(`${root} *`),
      ];
      return all.map((el, i) => ({
        i,
        tag: el.tagName.toLowerCase(),
        cls: [...el.classList],
        isRoot: i === 0,
      }));
    }, ROOT);
    fontFaces = await page.evaluate(() => {
      const out = [];
      for (const sheet of document.styleSheets) {
        let list;
        try {
          list = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of list) {
          if (rule.constructor.name === "CSSFontFaceRule")
            out.push(rule.cssText);
        }
      }
      return out;
    });
  }
  await context.close();
}

async function recordRootInfo(page, width) {
  const info = await rootInfo(page);
  inheritedByWidth[width] = info.base;
  varsByWidth[width] = info.vars;
  widthByViewport[width] = { width: info.width, left: info.left };
}

/** Inherited text style from the widget's parent, and every custom property, at the root. */
function rootInfo(page) {
  return page.evaluate(
    ({ root, inherited }) => {
      const el = document.querySelector(root);
      const parentStyle = getComputedStyle(el.parentElement);
      const base = Object.fromEntries(
        inherited.map((p) => [p, parentStyle.getPropertyValue(p)]),
      );
      const vars = {};
      const rootStyle = getComputedStyle(el);
      const scan = (rule) => {
        if (rule.style) {
          for (const name of rule.style) {
            if (name.startsWith("--"))
              vars[name] = rootStyle.getPropertyValue(name).trim();
          }
        }
        if (rule.cssRules) for (const child of rule.cssRules) scan(child);
      };
      for (const sheet of document.styleSheets) {
        let list;
        try {
          list = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of list) scan(rule);
      }
      const rect = el.getBoundingClientRect();
      return { base, width: rect.width, left: rect.left, vars };
    },
    { root: ROOT, inherited: INHERITED },
  );
}

const passes = [{ mobile: false, widths: config.extractViewports }];
if (config.mobileMarkup) {
  passes.push({
    mobile: true,
    widths: config.extractViewports.filter((w) => w < config.mobileBreakpoint),
  });
}

const browser = await launch();
try {
  for (const pass of passes) await extractPass(browser, pass);
} catch (error) {
  console.error(error.message);
  await browser.close();
  process.exit(1);
}
await browser.close();

const out = {
  url: config.legacyUrl,
  root: ROOT,
  viewports: config.extractViewports,
  states: config.states.map((s) => s.name),
  mobile: config.mobileMarkup,
  widthByViewport,
  inheritedByWidth,
  varsByWidth,
  nodes,
  fontFaces,
  rules: [...rules.values()]
    .map((r) => ({ ...r, matched: [...r.matched] }))
    .sort((a, b) => a.sheet - b.sheet || a.start - b.start),
};
mkdirSync(config.workDir, { recursive: true });
const file = path.join(config.workDir, "extract.json");
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(
  `extracted ${out.rules.length} rules, ${nodes.length} elements, ${fontFaces.length} @font-face -> ${file}`,
);
