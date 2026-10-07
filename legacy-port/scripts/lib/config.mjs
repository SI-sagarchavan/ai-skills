// The per-widget port config: <plugin-dir>/legacy-port.json.
// See ../../reference/tooling.md for every field.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  extractViewports: [360, 414, 576, 768, 992, 1200, 1366, 1600, 1920],
  compareViewports: [390, 768, 1366],
  states: [{ name: "default" }],
  hover: [],
  landmarks: [],
  remScale: 0.625,
  neutralize: [],
  pageBackground: "#f4f4f4",
  interaction: [],
  previewOrigin: "http://localhost:3000",
  // The legacy server renders different markup for phones (it checks the
  // User-Agent). When true, extraction and comparison also run with
  // `mobileUserAgent` at every width below `mobileBreakpoint`.
  mobileMarkup: false,
  // The widget is drawn by a browser script, so the legacy page loads with JavaScript on.
  clientRendered: false,
  // Legacy font families the user agreed to register in Font Manager because the
  // tenant has no equivalent. Once tokens.mjs has read the tenant's own fonts,
  // compare loads ONLY these legacy fonts, so a plugin that leans on a legacy
  // family the tenant lacks fails the compare as it would on Surface.
  registerFonts: [],
  mobileBreakpoint: 768,
  mobileUserAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  theme: {},
};

// How far the Tailwind plugin may drift from the legacy widget and still PASS.
export const TOLERANCE = {
  // Share of a state's screenshot pixels allowed to differ (pixelmatch).
  pixelRatio: 0.01,
  // pixelmatch colour threshold (0 exact … 1 anything); 0.1 is its default.
  pixelThreshold: 0.1,
  // Screenshot width/height difference, px.
  sizePx: 2,
  // Landmark box position/size difference, px.
  boxPx: 2,
  // Landmark colour difference, CIEDE2000 (2.3 ≈ just noticeable).
  colorDeltaE: 2.3,
  // Landmark font-size / line-height difference, px.
  fontPx: 0.5,
};

export function loadPortConfig(pluginDir) {
  const dir = path.resolve(pluginDir);
  const file = path.join(dir, "legacy-port.json");
  if (!existsSync(file)) {
    throw new Error(
      `No legacy-port.json in ${dir}. Create one first (templates/legacy-port.example.json).`,
    );
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["pluginId", "legacyUrl", "root"]) {
    if (!raw[key]) throw new Error(`legacy-port.json: "${key}" is required`);
  }
  if (!/^\.[\w-]+$/.test(raw.root)) {
    throw new Error(
      `legacy-port.json: "root" must be one class selector, like ".waf-standings"`,
    );
  }
  const config = {
    ...DEFAULTS,
    pluginRoot: `[data-legacy-port="${raw.pluginId}"]`,
    ...raw,
    tolerance: { ...TOLERANCE, ...raw.tolerance },
  };
  return {
    ...config,
    pluginDir: dir,
    rootClass: config.root.slice(1),
    origin: new URL(config.legacyUrl).origin,
    workDir: path.join(os.tmpdir(), "legacy-port", config.pluginId),
  };
}

/** The local renderer route that renders one plugin (see templates/dev-preview). */
export function previewUrl(config, fonts = {}) {
  const params = Object.entries(fonts)
    .filter(([, font]) => font.url)
    .map(([family, font]) => {
      const spec = `${family}@${font.url}`;
      return `font=${encodeURIComponent(spec)}`;
    });
  const base = `${config.previewOrigin}/dev/plugins/${config.pluginId}`;
  return params.length ? `${base}?${params.join("&")}` : base;
}
