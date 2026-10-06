// Chromium helpers shared by extract-css.mjs and compare.mjs.
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EXECUTABLES = new Set([
  "chrome-headless-shell",
  "chrome-headless-shell.exe",
  "Google Chrome for Testing",
  "Chromium",
  "chrome",
  "chrome.exe",
]);

function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH)
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  return path.join(os.homedir(), ".cache/ms-playwright");
}

function findExecutable(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isFile() && EXECUTABLES.has(name)) return full;
    if (stat.isDirectory()) {
      const found = findExecutable(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Newest Chromium already in the Playwright cache, whichever version installed it. */
function cachedChromium() {
  const cache = playwrightCache();
  if (!existsSync(cache)) return null;
  const dirs = readdirSync(cache)
    .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const dir of dirs) {
    const exe = findExecutable(path.join(cache, dir));
    if (exe) return exe;
  }
  return null;
}

/**
 * CHROME_PATH if set; else the Chromium this Playwright version expects; else
 * any Chromium in the Playwright cache. Both pages of a comparison always run
 * in the same browser, so the exact Chromium build does not matter.
 */
export async function launch() {
  if (process.env.CHROME_PATH) {
    return chromium.launch({ executablePath: process.env.CHROME_PATH });
  }
  try {
    return await chromium.launch();
  } catch (error) {
    const fallback = cachedChromium();
    if (!fallback) {
      throw new Error(
        `No Chromium found. From ${SCRIPTS_DIR} run: npx playwright-core install chromium\n${error.message}`,
      );
    }
    return chromium.launch({ executablePath: fallback });
  }
}

/**
 * Browser context options. `mobile` sends a phone User-Agent — the legacy
 * server (and the renderer, in dev) decide mobile markup from the UA alone.
 * Viewport emulation stays off so both pages lay out at exactly `width`.
 */
function contextOptions(config, { width, height, mobile }) {
  return {
    viewport: { width, height },
    deviceScaleFactor: 1,
    ...(mobile ? { userAgent: config.mobileUserAgent } : {}),
  };
}

/**
 * The live legacy page as its server rendered it: JavaScript off (the state
 * the widget CSS was written for before hydration) and first-party requests
 * only (no trackers, ads or third-party fonts).
 */
export async function openLegacy(
  browser,
  config,
  { width, height = 1200, mobile = false },
) {
  const context = await browser.newContext({
    ...contextOptions(config, { width, height, mobile }),
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith(`${config.origin}/`) || url.startsWith("data:")
      ? route.continue()
      : route.abort();
  });
  await page.goto(config.legacyUrl, { waitUntil: "load", timeout: 90_000 });
  return { context, page };
}

export async function openPlugin(
  browser,
  config,
  url,
  { width, height = 1200, mobile = false },
) {
  const context = await browser.newContext(
    contextOptions(config, { width, height, mobile }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(url, { waitUntil: "load", timeout: 90_000 });
  return { context, page };
}

/**
 * Inserts a <style> directly. Playwright's addStyleTag waits for an onload
 * that never fires when JavaScript is disabled, and hangs forever.
 */
export function addStyle(page, css) {
  return page.evaluate((text) => {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.append(style);
  }, css);
}

/** The same flat page background behind both widgets: page decoration is not the widget's. */
export function neutralise(page, config) {
  return addStyle(
    page,
    [
      ...config.neutralize,
      `body { background: ${config.pageBackground} !important; }`,
      // Next.js dev-mode overlay and badge (plugin page only; a no-op on legacy).
      "nextjs-portal, [data-next-badge-root], [data-nextjs-toast] { display: none !important; }",
    ].join("\n"),
  );
}

export async function fontsReady(page, timeoutMs = 20_000) {
  await Promise.race([
    page.evaluate(() => document.fonts.ready.then(() => true)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Puts the legacy widget in one UI state the way the legacy Vue code would: by
 * changing classes and inline styles. Every element under the root first gets
 * back the class and style it had when the page loaded, then the state's
 * `removeClass`, `addClass` and `setStyle` apply. Selectors are relative to
 * the root ("" is the root itself). The plugin page reaches the same state
 * through the state's `plugin` steps instead (compare.mjs).
 */
export function setState(page, config, state) {
  const ops = (list = []) =>
    list.map((op) => ({
      ...op,
      selector: `${config.root} ${op.selector}`.trim(),
    }));
  return page.evaluate(
    ({ root, add, remove, styles }) => {
      const restore = (el, name, saved) => {
        if (saved === null) el.removeAttribute(name);
        else el.setAttribute(name, saved);
      };
      for (const el of document.querySelectorAll(`${root}, ${root} *`)) {
        if ("__lpClass" in el) {
          restore(el, "class", el.__lpClass);
          restore(el, "style", el.__lpStyle);
        } else {
          el.__lpClass = el.getAttribute("class");
          el.__lpStyle = el.getAttribute("style");
        }
      }
      const each = (selector, fn) => {
        for (const el of document.querySelectorAll(selector)) fn(el);
      };
      for (const op of remove)
        each(op.selector, (el) => el.classList.remove(op.className));
      for (const op of add)
        each(op.selector, (el) => el.classList.add(op.className));
      for (const op of styles)
        each(op.selector, (el) => el.setAttribute("style", op.style));
    },
    {
      root: config.root,
      add: ops(state.addClass),
      remove: ops(state.removeClass),
      styles: ops(state.setStyle),
    },
  );
}
