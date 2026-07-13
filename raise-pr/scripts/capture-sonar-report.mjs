#!/usr/bin/env node
/**
 * Capture a SonarQube project dashboard screenshot for PR bodies.
 *
 * Usage:
 *   node capture-sonar-report.mjs [--out PATH] [--url HOST] [--project KEY] [--token TOKEN]
 *
 * Env (optional):
 *   SONAR_HOST_URL, SONAR_TOKEN, SONAR_PROJECT_KEY
 *   Or reads sonar-project.properties from CWD / git root.
 *
 * Prints the absolute output path on success (stdout last line).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { out: null, url: null, project: null, token: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: capture-sonar-report.mjs [--out PATH] [--url HOST] [--project KEY] [--token TOKEN]`);
      process.exit(0);
    }
  }
  return out;
}

function findGitRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readSonarProperties(root) {
  const file = path.join(root, 'sonar-project.properties');
  if (!fs.existsSync(file)) return {};
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    props[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return props;
}

function loadEnvFile(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

async function main() {
  const args = parseArgs(process.argv);
  const startDir = process.env.RAISE_PR_CWD || process.cwd();
  const root = findGitRoot(startDir) || path.resolve(startDir);
  const props = readSonarProperties(root);
  const fileEnv = loadEnvFile(root);
  console.error(`Project root: ${root}`);

  const host = (
    args.url ||
    process.env.SONAR_HOST_URL ||
    fileEnv.SONAR_HOST_URL ||
    props['sonar.host.url'] ||
    'http://localhost:9000'
  ).replace(/\/$/, '');

  const project =
    args.project ||
    process.env.SONAR_PROJECT_KEY ||
    fileEnv.SONAR_PROJECT_KEY ||
    props['sonar.projectKey'];

  if (!project) {
    console.error(
      'No Sonar project key. Set SONAR_PROJECT_KEY, pass --project, or add sonar.projectKey to sonar-project.properties',
    );
    process.exit(2);
  }

  const token =
    args.token || process.env.SONAR_TOKEN || fileEnv.SONAR_TOKEN || '';

  const outPath = path.resolve(
    args.out ||
      path.join(
        process.env.TMPDIR || '/tmp',
        `sonar-report-${project.replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}.png`,
      ),
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Reachability check
  try {
    const statusUrl = `${host}/api/system/status`;
    const headers = {};
    if (token) {
      headers.Authorization = `Basic ${Buffer.from(`${token}:`).toString('base64')}`;
    }
    const res = await fetch(statusUrl, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error(`SonarQube not healthy at ${host} (HTTP ${res.status})`);
      process.exit(3);
    }
  } catch (e) {
    console.error(`SonarQube not reachable at ${host}: ${e.message}`);
    process.exit(3);
  }

  const dashboardUrl = `${host}/dashboard?id=${encodeURIComponent(project)}`;
  console.error(`Capturing ${dashboardUrl}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 2,
    });

    if (token) {
      // Token as Basic auth (user token, empty password) — common for Sonar
      await context.setExtraHTTPHeaders({
        Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
      });
    }

    const page = await context.newPage();
    await page.goto(dashboardUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // Dismiss login if we landed on login without token
    if (page.url().includes('/sessions/new') || (await page.locator('input[name="login"]').count()) > 0) {
      if (!token) {
        console.error('Sonar requires login. Set SONAR_TOKEN and retry.');
        process.exit(4);
      }
    }

    // Prefer Overall Code tab when present (matches common PR screenshots)
    try {
      const overall = page.getByRole('button', { name: /Overall Code/i }).or(
        page.getByRole('tab', { name: /Overall Code/i }),
      );
      if (await overall.count()) {
        await overall.first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
    } catch {
      /* ignore */
    }

    // Wait for quality gate or metrics to render
    await page
      .locator('text=/Quality Gate|Passed|Failed|Coverage|Security/i')
      .first()
      .waitFor({ timeout: 30000 })
      .catch(() => {});

    await page.waitForTimeout(1200);
    await page.screenshot({ path: outPath, fullPage: false });
    console.error(`Wrote ${outPath}`);
    console.log(outPath);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
