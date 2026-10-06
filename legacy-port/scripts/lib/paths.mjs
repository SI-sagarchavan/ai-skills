// Locates the checkouts the scripts work on. The skill is installed outside
// the renderer, so nothing here is resolved relative to this file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const isPluginsRoot = (dir) =>
  existsSync(path.join(dir, "fortress")) &&
  existsSync(path.join(dir, "types", "context.ts"));

function* ancestors(start) {
  let dir = path.resolve(start);
  while (true) {
    yield dir;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** The plugins repo root (`<renderer>/apps/web/plugins`): SURFACE_PLUGINS_DIR, else found from the working directory. */
export function findPluginsRoot(start = process.cwd()) {
  if (process.env.SURFACE_PLUGINS_DIR) {
    return path.resolve(process.env.SURFACE_PLUGINS_DIR);
  }
  for (const dir of ancestors(start)) {
    if (isPluginsRoot(dir)) return dir;
    const nested = path.join(dir, "apps", "web", "plugins");
    if (isPluginsRoot(nested)) return nested;
  }
  return null;
}

export function requirePluginsRoot(start) {
  const root = findPluginsRoot(start);
  if (!root) {
    throw new Error(
      "Surface plugins repo not found: run from fanxp-web-renderer (or apps/web/plugins), or set SURFACE_PLUGINS_DIR.",
    );
  }
  return root;
}

/** `<renderer>/apps/web/plugins` -> `<renderer>`. */
export const rendererRoot = (pluginsRoot) =>
  path.resolve(pluginsRoot, "..", "..", "..");

/**
 * A sibling checkout such as wm-si-wafjs3.0: the env var, else `<name>` in any
 * ancestor of the start dirs or one folder below one (`~/si/waf/<name>`).
 */
export function findRepo(name, envVar, starts) {
  if (process.env[envVar]) return path.resolve(process.env[envVar]);
  for (const start of starts.filter(Boolean)) {
    for (const dir of ancestors(start)) {
      const direct = path.join(dir, name);
      if (existsSync(direct)) return direct;
      let children = [];
      try {
        children = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith(".")) continue;
        const nested = path.join(dir, child.name, name);
        if (existsSync(nested)) return nested;
      }
    }
  }
  return null;
}

/** KEY=value pairs from the renderer's apps/web/.env.local, falling back to .env. */
export function rendererEnv(pluginsRoot) {
  const env = {};
  for (const file of [".env", ".env.local"]) {
    const full = path.join(rendererRoot(pluginsRoot), "apps", "web", file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
