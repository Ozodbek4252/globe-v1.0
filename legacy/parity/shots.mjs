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
// A scenario marked `known` is expected to differ, for the stated reason. In the legacy page the
// canvas sits directly in <main>, so its pixel height (the height attribute) becomes the minimum
// size of the grid row: the stage can grow but never shrink. On a phone that stops the bottom sheet
// growing when its content does (after a pick it scrolls 31px of controls out of view) and rounds
// the stage up by a fraction of a pixel; on desktop it keeps the globe from fitting a window made
// shorter. The Vite build keeps the canvas out of layout, so it resizes correctly.
const LEGACY_RATCHET = 'legacy stage height never shrinks (canvas size feeds the grid row minimum)';
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
  { name: 'search-uzbekistan', type: ['#q', 'Uzbekistan'], press: ['#q', 'Enter'], wait: 2500 },
  { name: 'pick-one', click: [[0, 0]] },
  { name: 'pick-three', click: [[0, 0], [-120, 40], [150, -30]] },
  { name: 'hover-tip', hover: [0, 0] },
  { name: 'hover-tip-population', mode: 'population', hover: [-60, 30] },
  { name: 'zoom-buttons', clickSel: ['#zin', '#zin', '#zout'], wait: 2000 },
  { name: 'zoom-reset', keys: ['ArrowLeft', 'ArrowLeft', '='], clickSel: ['#zreset'], wait: 3000 },
  { name: 'dropdown-open', clickSel: ['#mode-btn'], wait: 600 },
  { name: 'phone-default', viewport: PHONE },
  { name: 'phone-pick', viewport: PHONE, click: [[0, 0]], known: LEGACY_RATCHET },
  { name: 'phone-dropdown-open', viewport: PHONE, clickSel: ['#mode-btn'], wait: 600 },
  { name: 'phone-daynight', viewport: PHONE, mode: 'daynight', wait: 3000, known: LEGACY_RATCHET },
  { name: 'phone-lights', viewport: PHONE, toggle: ['lights'], wait: 4000 },
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

// Web fonts load lazily, per weight and unicode subset, so "fonts.ready" can fire before the face
// a late-rendered piece of text needs has even been requested. That made screenshots race. Load every
// declared face explicitly and wait for them, so both pages are measured with the same fonts.
async function settleFonts(page) {
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((face) => face.load().catch(() => null)));
    await document.fonts.ready;
  });
}

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
  await settleFonts(page);
  await page.waitForTimeout(1200);

  await page.focus(CANVAS);
  for (const key of scenario.keys ?? []) await page.keyboard.press(key);
  for (const name of scenario.toggle ?? []) await page.click(`#t-${name}`);

  if (scenario.type) await page.fill(scenario.type[0], scenario.type[1]);
  if (scenario.press) await page.press(scenario.press[0], scenario.press[1]);

  const box = await page.locator(STAGE).boundingBox();
  for (const [dx, dy] of scenario.click ?? []) {
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await page.waitForTimeout(150);
  }
  for (const sel of scenario.clickSel ?? []) await page.click(sel);
  if (scenario.hover) {
    await page.mouse.move(box.x + box.width / 2 + scenario.hover[0], box.y + box.height / 2 + scenario.hover[1]);
  } else if (!(scenario.clickSel ?? []).includes('#mode-btn')) {
    await page.mouse.move(2, 2); // keep the pointer off the globe: no hover highlight or tooltip
  }
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

// ---------- DOM structure comparison (--mode dom) ----------
// Serialises ids, classes, roles, aria-*, tabindex, hidden and text for everything in .app, in
// document order, for each of a few UI states, and prints any line that differs.
async function domSnapshot(page) {
  return page.evaluate(() => {
    const KEEP = ['id', 'role', 'tabindex', 'type', 'for', 'list', 'placeholder', 'autocomplete'];
    const lines = [];
    const walk = (el, depth) => {
      if (['SCRIPT', 'STYLE'].includes(el.tagName)) return;
      // The new app wraps the canvases in .globe-host and creates them from script, so their
      // ids/hidden flags differ by design; compare everything around them instead.
      if (el.matches('canvas, .globe-host')) return;
      const bits = [el.tagName.toLowerCase()];
      for (const name of KEEP) if (el.hasAttribute(name)) bits.push(`${name}=${el.getAttribute(name)}`);
      for (const a of el.attributes) if (a.name.startsWith('aria-')) bits.push(`${a.name}=${a.value}`);
      if (el.hasAttribute('class')) bits.push('.' + [...el.classList].sort().join('.'));
      if (el.hasAttribute('hidden')) bits.push('[hidden]');
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ');
      lines.push(`${'  '.repeat(depth)}<${bits.join(' ')}>${own ? ' "' + own + '"' : ''}`);
      // Hidden elements: legacy leaves their old content in place, the Vue version clears it.
      // Nobody can see or hear it either way, so don't compare it (the #mode list is the exception:
      // its options exist while closed and are part of the structure).
      if (el.hasAttribute('hidden') && el.id !== 'modes') return;
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(document.querySelector('.app'), 0);
    walk(document.querySelector('#tip'), 0);
    return lines;
  });
}

const DOM_STATES = [
  { name: 'initial', run: async () => {} },
  {
    name: 'tip-shown',
    run: async (page) => {
      const box = await page.locator(STAGE).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'tip-hidden',
    run: async (page) => {
      await page.mouse.move(2, 2);
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'dropdown-open',
    run: async (page) => {
      await page.click('#mode-btn');
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'dropdown-arrow-down',
    run: async (page) => {
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
    },
  },
  {
    name: 'mode-chosen-gdp',
    run: async (page) => {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'layer-toggled',
    run: async (page) => {
      await page.click('#t-cities');
    },
  },
  {
    name: 'one-pick',
    run: async (page) => {
      const box = await page.locator(STAGE).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'two-picks',
    run: async (page) => {
      const box = await page.locator(STAGE).boundingBox();
      await page.mouse.click(box.x + box.width / 2 - 120, box.y + box.height / 2 + 40);
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'card-closed',
    run: async (page) => {
      await page.click('#card .x');
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'cleared',
    run: async (page) => {
      await page.click('#picks .clear');
      await page.waitForTimeout(200);
    },
  },
];

async function domRun(browser, url) {
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('atlas-mode', 'natural'));
  const page = await context.newPage();
  await page.clock.setFixedTime(FROZEN_TIME);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector(CANVAS, { timeout: 20000 });
  await settleFonts(page);
  await page.waitForTimeout(1200);
  const states = {};
  for (const state of DOM_STATES) {
    try {
      await state.run(page);
      states[state.name] = await domSnapshot(page);
    } catch (e) {
      states[state.name] = [`!! state failed: ${e.message.split('\n')[0]}`];
    }
  }
  await context.close();
  return states;
}

async function domMain(browser, legacyUrl, newUrl) {
  const legacy = await domRun(browser, legacyUrl);
  const next = await domRun(browser, newUrl);
  let total = 0;
  for (const state of DOM_STATES) {
    const a = legacy[state.name];
    const b = next[state.name];
    const diffs = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) diffs.push(`  legacy: ${a[i] ?? '(none)'}\n  new:    ${b[i] ?? '(none)'}`);
    }
    total += diffs.length;
    console.log(`${state.name.padEnd(22)} ${diffs.length ? diffs.length + ' differences' : 'identical'} (${a.length}/${b.length} nodes)`);
    for (const d of diffs.slice(0, 12)) console.log(d);
    if (diffs.length > 12) console.log(`  ... ${diffs.length - 12} more`);
  }
  console.log(`\ntotal DOM differences: ${total}`);
}

// ---------- behaviour comparison (--mode behavior) ----------
// Runs the same interactions on both pages and compares what they report (the coordinates readout,
// the picks list, localStorage, console errors). Each check returns a string; equal strings pass.
async function openFresh(browser, url, { reducedMotion = false, blockStorage = false, mode = 'natural' } = {}) {
  const context = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  if (blockStorage) {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
  } else {
    await context.addInitScript((m) => {
      // seed a known starting mode, but never overwrite a mode the page itself saved
      if (localStorage.getItem('atlas-mode') === null) localStorage.setItem('atlas-mode', m);
    }, mode);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.clock.setFixedTime(FROZEN_TIME);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector(CANVAS, { timeout: 20000 });
  await settleFonts(page);
  await page.waitForTimeout(800);
  return { context, page, errors };
}

const coords = (page) => page.locator('#coords').innerText();
const center = async (page) => {
  const b = await page.locator(STAGE).boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};

const BEHAVIOR_CHECKS = [
  {
    name: 'keyboard rotate and zoom',
    run: async ({ page }) => {
      await page.focus(CANVAS);
      for (const k of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowUp', 'ArrowUp', '=', '=', '-', 'ArrowRight'])
        await page.keyboard.press(k);
      return coords(page);
    },
  },
  {
    name: 'wheel zoom',
    run: async ({ page }) => {
      const [x, y] = await center(page);
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, -300);
      await page.mouse.wheel(0, -200);
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(200);
      return coords(page);
    },
  },
  {
    name: 'zoom limits (max and min)',
    run: async ({ page }) => {
      await page.focus(CANVAS);
      for (let i = 0; i < 20; i++) await page.keyboard.press('=');
      const max = await coords(page);
      for (let i = 0; i < 40; i++) await page.keyboard.press('-');
      return `${max} | ${await coords(page)}`;
    },
  },
  {
    name: 'latitude clamp at the poles',
    run: async ({ page }) => {
      await page.focus(CANVAS);
      for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
      const north = await coords(page);
      for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown');
      return `${north} | ${await coords(page)}`;
    },
  },
  {
    name: 'zoom buttons',
    run: async ({ page }) => {
      await page.click('#zin');
      await page.click('#zin');
      await page.click('#zout');
      return coords(page);
    },
  },
  {
    name: 'drag without coasting',
    run: async ({ page }) => {
      const [x, y] = await center(page);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 150, y + 60, { steps: 8 });
      await page.waitForTimeout(200); // resting before release cancels inertia
      await page.mouse.up();
      await page.waitForTimeout(300);
      return coords(page);
    },
  },
  {
    name: 'search flies to the country',
    run: async ({ page }) => {
      await page.fill('#q', 'Brazil');
      await page.press('#q', 'Enter');
      await page.waitForTimeout(1600);
      return `${await coords(page)} | ${await page.locator('#picks').innerText()}`;
    },
  },
  {
    name: 'search misses are ignored',
    run: async ({ page }) => {
      await page.fill('#q', 'Narnia');
      await page.press('#q', 'Enter');
      await page.waitForTimeout(300);
      return `${await coords(page)} | ${await page.locator('#picks').innerText()}`;
    },
  },
  {
    name: 'reduced motion jumps instead of flying',
    opts: { reducedMotion: true },
    run: async ({ page }) => {
      await page.fill('#q', 'Uzbekistan');
      await page.press('#q', 'Enter');
      await page.waitForTimeout(250); // an animated flight (1s) would still be under way
      return coords(page);
    },
  },
  {
    name: 'click picks, click again drops, Escape clears',
    run: async ({ page }) => {
      const [x, y] = await center(page);
      const log = [];
      await page.mouse.click(x, y);
      log.push(await page.locator('#picks').innerText());
      await page.mouse.click(x - 120, y + 40);
      log.push(await page.locator('#picks').innerText());
      await page.mouse.click(x, y); // drop the first one again
      log.push(await page.locator('#picks').innerText());
      await page.focus(CANVAS);
      await page.keyboard.press('Escape');
      log.push(await page.locator('#picks').innerText());
      return log.join(' || ');
    },
  },
  {
    name: 'chip click selects and card follows',
    run: async ({ page }) => {
      const [x, y] = await center(page);
      await page.mouse.click(x, y);
      await page.mouse.click(x - 120, y + 40);
      const second = await page.locator('#card h2').innerText();
      await page.locator('.chip .cn').first().click();
      await page.waitForTimeout(1300);
      return `${second} -> ${await page.locator('#card h2').innerText()} | ${await coords(page)}`;
    },
  },
  {
    name: 'card close keeps the picks',
    run: async ({ page }) => {
      const [x, y] = await center(page);
      await page.mouse.click(x, y);
      await page.click('#card .x');
      return `${await page.locator('#card').isVisible()} | ${await page.locator('#picks').innerText()}`;
    },
  },
  {
    name: 'reset view clears picks and returns home',
    run: async ({ page }) => {
      const [x, y] = await center(page);
      await page.mouse.click(x, y);
      await page.focus(CANVAS);
      await page.keyboard.press('ArrowLeft');
      await page.click('#zreset');
      await page.waitForTimeout(1500);
      return `${await coords(page)} | ${await page.locator('#picks').innerText()}`;
    },
  },
  {
    name: 'mode is saved and restored',
    run: async ({ page, url, context }) => {
      await page.click('#mode-btn');
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const saved = await page.evaluate(() => localStorage.getItem('atlas-mode'));
      const shown = await page.locator('#mode-btn .nm').innerText();
      const reloaded = await context.newPage();
      await reloaded.goto(url, { waitUntil: 'load' });
      await reloaded.waitForSelector(CANVAS);
      const restored = await reloaded.locator('#mode-btn .nm').innerText();
      return `saved=${saved} shown=${shown} restored=${restored}`;
    },
  },
  {
    name: 'works with localStorage blocked',
    opts: { blockStorage: true },
    run: async ({ page, errors }) => {
      await page.click('#mode-btn');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const shown = await page.locator('#mode-btn .nm').innerText();
      return `mode=${shown} errors=${errors.length}`;
    },
  },
  {
    name: 'dropdown keys: Home, End, Escape, Tab',
    run: async ({ page }) => {
      const log = [];
      const state = async () =>
        page.evaluate(() => `${document.querySelector('#mode-btn').getAttribute('aria-expanded')}/${document.querySelector('#modes').getAttribute('aria-activedescendant')}/${document.activeElement.id}`);
      await page.click('#mode-btn');
      log.push(await state());
      await page.keyboard.press('End');
      log.push(await state());
      await page.keyboard.press('Home');
      log.push(await state());
      await page.keyboard.press('ArrowUp');
      log.push(await state());
      await page.keyboard.press('Escape');
      log.push(await state());
      await page.keyboard.press('ArrowDown');
      log.push(await state());
      await page.keyboard.press('Tab');
      log.push(await state());
      return log.join(' ; ');
    },
  },
  {
    name: 'outside click closes the dropdown',
    run: async ({ page }) => {
      await page.click('#mode-btn');
      await page.mouse.click(700, 300);
      return page.locator('#mode-btn').getAttribute('aria-expanded');
    },
  },
];

async function behaviorMain(browser, legacyUrl, newUrl) {
  let diffs = 0;
  for (const check of BEHAVIOR_CHECKS) {
    const results = [];
    for (const url of [legacyUrl, newUrl]) {
      const session = await openFresh(browser, url, check.opts);
      try {
        results.push(String(await check.run({ ...session, url })));
      } catch (e) {
        results.push(`!! ${e.message.split('\n')[0]}`);
      }
      if (!results.at(-1).startsWith('!!') && session.errors.length && !check.opts?.blockStorage) {
        results[results.length - 1] += ` [console errors: ${session.errors.length}]`;
      }
      await session.context.close();
    }
    const same = results[0] === results[1];
    if (!same) diffs++;
    console.log(`${same ? 'same ' : 'DIFF '} ${check.name}`);
    console.log(`        ${results[0]}`);
    if (!same) console.log(`   new: ${results[1]}`);
  }
  console.log(`\nbehaviour differences: ${diffs} of ${BEHAVIOR_CHECKS.length}`);
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
if (arg('mode', 'shots') === 'dom') {
  await domMain(browser, legacyUrl, newUrl);
  await browser.close();
  server.close();
  process.exit(0);
}
if (arg('mode', 'shots') === 'behavior') {
  await behaviorMain(browser, legacyUrl, newUrl);
  await browser.close();
  server.close();
  process.exit(0);
}
const rows = [];
for (const scenario of list) {
  const legacy = await capture(browser, legacyUrl, scenario, 'legacy');
  const next = await capture(browser, newUrl, scenario, 'new');
  writeFileSync(join(OUT, `${scenario.name}.legacy.png`), legacy.stage);
  writeFileSync(join(OUT, `${scenario.name}.new.png`), next.stage);
  writeFileSync(join(OUT, `${scenario.name}.legacy.full.png`), legacy.full);
  writeFileSync(join(OUT, `${scenario.name}.new.full.png`), next.full);
  const d = diff(legacy.stage, next.stage);
  const f = diff(legacy.full, next.full);
  if (d.png) writeFileSync(join(OUT, `${scenario.name}.diff.png`), d.png);
  if (f.png) writeFileSync(join(OUT, `${scenario.name}.diff.full.png`), f.png);
  rows.push({ scenario: scenario.name, d, f, legacy, next });
  const show = (x) => x.sizeMismatch ?? `${x.count} px (${((x.count / x.total) * 100).toFixed(3)}%)`;
  console.log(
    `${scenario.name.padEnd(24)} stage: ${show(d).padEnd(18)} page: ${show(f).padEnd(18)}` +
      ` webgl2: ${legacy.webgl}/${next.webgl}` +
      ` console: legacy ${legacy.problems.length}, new ${next.problems.length}` +
      (scenario.known ? `\n    known difference: ${scenario.known}` : ''),
  );
  for (const p of next.problems) console.log(`    new    ! ${p}`);
  for (const p of legacy.problems) console.log(`    legacy ! ${p}`);
}

await browser.close();
server.close();
const ratio = (x) => (x.total ? x.count / x.total : 1);
console.log(
  `\nworst stage diff: ${(Math.max(...rows.map((r) => ratio(r.d))) * 100).toFixed(3)}%` +
    `   worst page diff: ${(Math.max(...rows.map((r) => ratio(r.f))) * 100).toFixed(3)}%` +
    `   (images in ${resolve(OUT)})`,
);
