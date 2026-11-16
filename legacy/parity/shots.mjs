// Takes the same screenshots of legacy/index.html and the new Vite build, then diffs them.
// Runs inside the Playwright container (see compose.yaml, service "parity").
//
//   docker compose run --rm parity node /opt/parity/shots.mjs [--scenarios a,b] [--new dist|dev]
//
// Output goes to .parity/ in the repo (git-ignored): <scenario>.legacy.png, .new.png, .diff.png
//
// Both pages get identical inputs: the same viewport, a frozen clock (for Day & night), the mode
// preselected through localStorage, and the same keyboard/mouse/click sequence.

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = '/app';
const OUT = join(ROOT, '.parity');
const PORT = 8123;
const FROZEN_TIME = new Date('2026-11-16T09:30:00Z');
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 400, height: 800 };

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

// ---------- scenarios ----------
// toggle: layer buttons to click once (#t-labels, #t-grid, #t-cities, #t-lights, #t-spin)
// keys:   pressed on the globe canvas ('=' zooms in by 1.25x, arrows rotate)
// click:  [dx, dy] from the stage centre; a click picks a country
const scenarios = [
  { name: 'natural-default' },
  { name: 'natural-zoom3', keys: Array(5).fill('=') },
  { name: 'natural-zoom6-borders', keys: Array(8).fill('='), wait: 3000 },
  { name: 'natural-pan', keys: ['ArrowLeft', 'ArrowLeft', 'ArrowUp', 'ArrowUp', 'ArrowUp'] },
  { name: 'natural-zoomed-out', keys: Array(3).fill('-') },
  ...[
    'physical',
    'political',
    'continents',
    'population',
    'density',
    'gdp',
    'income',
    'daynight',
  ].map((mode) => ({ name: `mode-${mode}`, mode })),
  { name: 'cities-zoom', mode: 'political', toggle: ['cities'], keys: Array(4).fill('=') },
  { name: 'no-labels-no-grid', toggle: ['labels', 'grid'] },
  { name: 'lights', toggle: ['lights'], wait: 5000 },
  { name: 'lights-zoom4', toggle: ['lights'], keys: Array(6).fill('='), wait: 5000 },
  { name: 'daynight-lights', mode: 'daynight', wait: 5000 },
  { name: 'pick-one', click: [[0, 0]] },
  { name: 'pick-three', click: [[0, 0], [-120, 40], [150, -30]] },
  { name: 'phone-default', viewport: PHONE },
  { name: 'phone-pick', viewport: PHONE, click: [[0, 0]] },
];

// ---------- static server for the repo root ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glsl': 'text/plain',
};
function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(PORT, () => ok(server)));
}

// ---------- driving a page ----------
const STAGE = '#stage';
const CANVAS = '#stage canvas[tabindex="0"]';

async function capture(browser, url, scenario, label) {
  const viewport = scenario.viewport ?? DESKTOP;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const mode = scenario.mode ?? 'natural';
  await context.addInitScript((m) => {
    try {
      localStorage.setItem('atlas-mode', m);
    } catch {
      /* ignore */
    }
  }, mode);
  const page = await context.newPage();
  await page.clock.setFixedTime(FROZEN_TIME);

  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector(CANVAS, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);

  await page.focus(CANVAS);
  for (const key of scenario.keys ?? []) await page.keyboard.press(key);
  for (const name of scenario.toggle ?? []) await page.click(`#t-${name}`);

  const box = await page.locator(STAGE).boundingBox();
  for (const [dx, dy] of scenario.click ?? []) {
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await page.waitForTimeout(150);
  }
  await page.mouse.move(2, 2); // keep the pointer off the globe: no hover highlight or tooltip
  await page.waitForTimeout(scenario.wait ?? 1500);

  const stage = await page.locator(STAGE).screenshot({ animations: 'disabled' });
  const full = await page.screenshot({ animations: 'disabled' });
  const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  await context.close();
  return { stage, full, problems, webgl, label };
}

function diff(a, b) {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) {
    return { sizeMismatch: `${A.width}x${A.height} vs ${B.width}x${B.height}` };
  }
  const D = new PNG({ width: A.width, height: A.height });
  const count = pixelmatch(A.data, B.data, D.data, A.width, A.height, {
    threshold: 0.1,
    includeAA: true,
  });
  return { count, total: A.width * A.height, png: PNG.sync.write(D) };
}

// ---------- main ----------
const wanted = arg('scenarios', '').split(',').filter(Boolean);
const list = wanted.length ? scenarios.filter((s) => wanted.includes(s.name)) : scenarios;
if (!list.length) {
  console.error(`No matching scenarios. Known: ${scenarios.map((s) => s.name).join(', ')}`);
  process.exit(2);
}
const newTarget = arg('new', 'dist');
const base = `http://localhost:${PORT}`;
const legacyUrl = `${base}/legacy/index.html`;
const newUrl = newTarget === 'dev' ? 'http://dev:5173/' : `${base}/dist/index.html`;

mkdirSync(OUT, { recursive: true });
const server = await serveRepo();
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

console.log(`legacy: ${legacyUrl}\nnew:    ${newUrl}\n`);
const rows = [];
for (const scenario of list) {
  const legacy = await capture(browser, legacyUrl, scenario, 'legacy');
  const next = await capture(browser, newUrl, scenario, 'new');
  writeFileSync(join(OUT, `${scenario.name}.legacy.png`), legacy.stage);
  writeFileSync(join(OUT, `${scenario.name}.new.png`), next.stage);
  writeFileSync(join(OUT, `${scenario.name}.legacy.full.png`), legacy.full);
  writeFileSync(join(OUT, `${scenario.name}.new.full.png`), next.full);
  const d = diff(legacy.stage, next.stage);
  if (d.png) writeFileSync(join(OUT, `${scenario.name}.diff.png`), d.png);
  rows.push({ scenario: scenario.name, d, legacy, next });
  const pct = d.total ? ((d.count / d.total) * 100).toFixed(3) : 'n/a';
  console.log(
    `${scenario.name.padEnd(24)} stage diff: ${d.sizeMismatch ?? `${d.count} px (${pct}%)`}` +
      `  webgl2: ${legacy.webgl}/${next.webgl}` +
      `  console: legacy ${legacy.problems.length}, new ${next.problems.length}`,
  );
  for (const p of next.problems) console.log(`    new    ! ${p}`);
  for (const p of legacy.problems) console.log(`    legacy ! ${p}`);
}

await browser.close();
server.close();
const worst = Math.max(...rows.map((r) => (r.d.total ? r.d.count / r.d.total : 1)));
console.log(`\nworst stage diff: ${(worst * 100).toFixed(3)}%  (images in ${resolve(OUT)})`);
