// The tenant's own fonts: the typography and SVG icon font stylesheets its
// Font Manager publishes (the renderer links them from main-config's
// SDUI document, `fonts.css`). A port uses these, not the legacy site's font
// files, so the plugin looks right on Surface without anything being
// registered.

const normalise = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

// "acuminpro-bold" / "Acumin Pro" -> "acuminpro": strip the weight words a
// legacy site bakes into a family name.
export const familyStem = (name) =>
  normalise(name).replace(
    /(extrabold|semibold|extralight|bold|medium|regular|light|black|thin|italic)$/,
    "",
  );

const WEIGHTS = { normal: 400, regular: 400, bold: 700 };
const weightOf = (value) =>
  WEIGHTS[value?.trim().toLowerCase()] ?? (Number(value) || 400);

/** Faces (family + weight) declared by a stylesheet. */
export function parseFaces(css) {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].flatMap(([, body]) => {
    const family = body
      .match(/font-family:\s*['"]?([^;'"]+)['"]?\s*;/)?.[1]
      ?.trim();
    if (!family) return [];
    return [
      {
        family,
        weight: weightOf(body.match(/font-weight:\s*([^;]+);/)?.[1]),
      },
    ];
  });
}

/** `.icon_pk_plane:before { content: '\e85c' }` -> { e85c: ["icon_pk_plane"] } */
export function parseGlyphs(css) {
  const glyphs = {};
  for (const [, cls, code] of css.matchAll(
    /\.(icon_[\w-]+):before\s*\{\s*content:\s*['"]\\([0-9a-fA-F]+)['"]/g,
  )) {
    (glyphs[code.toLowerCase()] ??= []).push(cls);
  }
  return glyphs;
}

/**
 * Fetches every font stylesheet the tenant publishes.
 * `hrefs` are the entries of the SDUI document's `fonts.css`.
 */
export async function readTenantFonts({ host, hrefs }) {
  const stylesheets = [];
  for (const href of hrefs) {
    const url = /^https?:/.test(href) ? href : `https://${host}${href}`;
    let css = "";
    try {
      const res = await fetch(url);
      if (res.ok) css = await res.text();
    } catch {
      // reported as an empty stylesheet below
    }
    const isIcons = /\/fonts\/icons\//.test(url);
    const faces = parseFaces(css);
    stylesheets.push({
      url,
      kind: isIcons ? "icons" : "typography",
      faces,
      families: [...new Set(faces.map((f) => f.family))],
      glyphs: isIcons ? parseGlyphs(css) : undefined,
      empty: !css,
    });
  }
  return { host, stylesheets };
}

/** Private-use code points (icon-font glyphs) a legacy stylesheet writes as `content`. */
export function legacyGlyphCodes(css) {
  return [
    ...new Set(
      [...css.matchAll(/content:\s*["']\\([ef][0-9a-fA-F]{3})/g)].map(([, c]) =>
        c.toLowerCase(),
      ),
    ),
  ];
}

/**
 * Where each legacy glyph lives on the tenant. The classes are what plugins on
 * other tenants use (`icon_<tenant>_…`); the family is for `font-family`.
 */
export function mapGlyphs(codes, tenantFonts) {
  const icons = tenantFonts.stylesheets.filter((s) => s.kind === "icons");
  return codes.map((code) => {
    for (const sheet of icons) {
      const classes = sheet.glyphs?.[code];
      if (classes?.length) {
        return { code, classes, family: sheet.families[0] ?? null };
      }
    }
    return { code, classes: [], family: null };
  });
}

/** Tenant typography family whose name matches a legacy family, if any. */
export function matchTypography(legacyFamily, tenantFonts) {
  const stem = familyStem(legacyFamily);
  for (const sheet of tenantFonts.stylesheets) {
    if (sheet.kind !== "typography") continue;
    const hit = sheet.families.find((f) => familyStem(f) === stem);
    if (hit) {
      const weights = sheet.faces
        .filter((f) => f.family === hit)
        .map((f) => f.weight);
      return { family: hit, weights: [...new Set(weights)].sort() };
    }
  }
  return null;
}
