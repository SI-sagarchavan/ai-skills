#!/usr/bin/env node
/**
 * Capture SonarQube Overall Code quality-gate panel for PR bodies.
 *
 * Usage:
 *   node capture-sonar-report.mjs [--out PATH] [--url HOST] [--project KEY]
 *     [--token TOKEN] [--user USER] [--password PASS]
 *
 * Env / product-repo .env (never commit passwords into ai-skills):
 *   SONAR_HOST_URL, SONAR_PROJECT_KEY, SONAR_TOKEN
 *   SONAR_USER, SONAR_PASSWORD   ← form login (preferred for local Community)
 *   Also reads sonar-project.properties from git root.
 *
 * Prints the absolute output path on success (stdout last line).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    out: null,
    url: null,
    project: null,
    token: null,
    user: null,
    password: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: capture-sonar-report.mjs [--out PATH] [--url HOST] [--project KEY] [--token TOKEN] [--user USER] [--password PASS]',
      );
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

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).length > 0) return v;
  }
  return '';
}

async function isLoginPage(page) {
  const url = page.url();
  if (/\/sessions\/new|\/sessions\/login|\/account\/login/i.test(url)) return true;
  const login = page.locator(
    'input[name="login"], input#login, input[name="username"], input[type="password"]',
  );
  try {
    return (await login.count()) > 0 && (await page.getByText(/Welcome to SonarQube|Log in/i).count()) > 0;
  } catch {
    return (await login.count()) > 0;
  }
}

async function performFormLogin(page, host, user, password) {
  console.error(`Logging into SonarQube as ${user}…`);
  await page.goto(`${host}/sessions/new`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  // Sonar UI variants across versions
  const userInput = page
    .locator('input[name="login"], input#login, input[name="username"], input[autocomplete="username"]')
    .first();
  const passInput = page
    .locator('input[name="password"], input#password, input[type="password"]')
    .first();

  await userInput.waitFor({ state: 'visible', timeout: 15000 });
  await userInput.fill(user);
  await passInput.fill(password);

  const submit = page
    .locator(
      'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login")',
    )
    .first();
  await submit.click();

  // Wait until we leave the login form
  await page.waitForURL((u) => !/\/sessions\/new/i.test(u.href), {
    timeout: 30000,
  }).catch(() => {});

  await page.waitForTimeout(800);

  if (await isLoginPage(page)) {
    // Still on login — check for error banner
    const err = await page.locator('.alert, [role="alert"], .process-spinner').first().textContent().catch(() => '');
    throw new Error(
      `Sonar form login failed (still on login page). ${err ? `UI: ${err.trim()}` : 'Check SONAR_USER / SONAR_PASSWORD.'}`,
    );
  }
  console.error('Login OK');
}

async function openOverallCodeTab(page) {
  const candidates = [
    page.getByRole('button', { name: /^Overall Code$/i }),
    page.getByRole('tab', { name: /^Overall Code$/i }),
    page.locator('button, a, [role="tab"]').filter({ hasText: /^Overall Code$/i }),
  ];
  for (const loc of candidates) {
    try {
      if ((await loc.count()) > 0) {
        await loc.first().click({ timeout: 4000 });
        await page.waitForTimeout(1000);
        console.error('Selected Overall Code tab');
        return;
      }
    } catch {
      /* try next */
    }
  }
  console.error('Overall Code tab not found — capturing default view');
}

/**
 * Prefer the quality-gate overview card (Passed/Failed + Security/Reliability/…).
 * Falls back to a clipped viewport if selectors miss.
 */
async function screenshotQualityGatePanel(page, outPath) {
  // Wait for gate status
  await page
    .getByText(/Quality Gate|Passed|Failed|Error/i)
    .first()
    .waitFor({ timeout: 30000 });

  // Heuristic: panel that contains both "Quality Gate" and coverage/metrics
  const panelSelectors = [
    // Modern Sonar overview card
    '[class*="overview-panel"]',
    '[class*="QualityGate"]',
    '[data-test="overview-quality-gate"]',
    'div:has(> :text("Quality Gate"))',
    // Broader: main content card under Overall Code
    'main section',
    '[class*="page-main"] [class*="boxed"]',
    '[class*="overview"]',
  ];

  for (const sel of panelSelectors) {
    try {
      const loc = page.locator(sel).filter({ hasText: /Quality Gate/i }).first();
      if ((await loc.count()) === 0) continue;
      const box = await loc.boundingBox();
      if (!box || box.height < 120 || box.width < 200) continue;

      // Expand slightly so metrics row is included (Security / Coverage / etc.)
      await loc.screenshot({ path: outPath });
      // Verify we didn't capture a login form
      // (login wouldn't match Quality Gate filter, so OK)
      console.error(`Captured panel via selector: ${sel}`);
      return true;
    } catch {
      /* try next */
    }
  }

  // Fallback: crop center content (skip left nav) by full viewport clip
  const viewport = page.viewportSize() || { width: 1440, height: 1100 };
  await page.screenshot({
    path: outPath,
    clip: {
      x: 220,
      y: 80,
      width: Math.min(1000, viewport.width - 240),
      height: Math.min(720, viewport.height - 100),
    },
  });
  console.error('Captured clipped viewport fallback');
  return false;
}

async function assertNotLoginScreenshot(outPath) {
  // Cheap check: re-open is not possible; rely on pre-check.
  // Caller ensures we left login before screenshot.
  void outPath;
}

async function main() {
  const args = parseArgs(process.argv);
  const startDir = process.env.RAISE_PR_CWD || process.cwd();
  const root = findGitRoot(startDir) || path.resolve(startDir);
  const props = readSonarProperties(root);
  const fileEnv = loadEnvFile(root);
  console.error(`Project root: ${root}`);

  const host = firstDefined(
    args.url,
    process.env.SONAR_HOST_URL,
    fileEnv.SONAR_HOST_URL,
    props['sonar.host.url'],
    'http://localhost:9000',
  ).replace(/\/$/, '');

  const project = firstDefined(
    args.project,
    process.env.SONAR_PROJECT_KEY,
    fileEnv.SONAR_PROJECT_KEY,
    props['sonar.projectKey'],
  );

  if (!project) {
    console.error(
      'No Sonar project key. Set SONAR_PROJECT_KEY, pass --project, or add sonar.projectKey to sonar-project.properties',
    );
    process.exit(2);
  }

  const token = firstDefined(
    args.token,
    process.env.SONAR_TOKEN,
    fileEnv.SONAR_TOKEN,
  );
  const user = firstDefined(
    args.user,
    process.env.SONAR_USER,
    fileEnv.SONAR_USER,
    fileEnv.SONAR_LOGIN,
  );
  const password = firstDefined(
    args.password,
    process.env.SONAR_PASSWORD,
    fileEnv.SONAR_PASSWORD,
  );

  const outPath = path.resolve(
    args.out ||
      path.join(
        process.env.TMPDIR || '/tmp',
        `sonar-report-${project.replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}.png`,
      ),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Reachability
  try {
    const res = await fetch(`${host}/api/system/status`, {
      signal: AbortSignal.timeout(8000),
    });
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

    // Token basic auth helps some API-backed UIs; form login is still required for many Community installs
    if (token) {
      await context.setExtraHTTPHeaders({
        Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
      });
    }

    const page = await context.newPage();

    // Always try form login first when credentials exist (avoids empty/login shots)
    if (user && password) {
      await performFormLogin(page, host, user, password);
    }

    await page.goto(dashboardUrl, { waitUntil: 'networkidle', timeout: 60000 });

    if (await isLoginPage(page)) {
      if (user && password) {
        await performFormLogin(page, host, user, password);
        await page.goto(dashboardUrl, {
          waitUntil: 'networkidle',
          timeout: 60000,
        });
      } else if (!token) {
        console.error(
          'Sonar requires login. Set SONAR_USER + SONAR_PASSWORD (or SONAR_TOKEN) in env / product .env',
        );
        process.exit(4);
      } else {
        console.error(
          'Still on login page with SONAR_TOKEN only. Set SONAR_USER + SONAR_PASSWORD for form login.',
        );
        process.exit(4);
      }
    }

    if (await isLoginPage(page)) {
      console.error('Failed to authenticate — aborting to avoid login-page screenshot');
      process.exit(4);
    }

    await openOverallCodeTab(page);

    // Ensure metrics are present (not login marketing copy)
    const bad = await page.getByText(/Welcome to SonarQube|You are not authorized/i).count();
    if (bad > 0 && (await page.getByText(/Quality Gate/i).count()) === 0) {
      console.error('Dashboard did not load quality gate content — aborting');
      process.exit(5);
    }

    await page.waitForTimeout(500);
    await screenshotQualityGatePanel(page, outPath);
    await assertNotLoginScreenshot(outPath);

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
