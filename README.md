# Atlas Globe

An interactive 3D Earth in the browser. Drag to turn it, scroll or pinch to zoom, click countries to
select them. Nine map modes (physical, natural, political, continents, population, density, GDP per
person, income group, live day and night), a NASA night-lights layer, search, and a country card.

It is a Vite + TypeScript + Vue 3 app. The globe is drawn with Canvas 2D (d3-geo) plus a WebGL2
fragment shader for the night lights. It is the base for a world-scale outbreak strategy game; the
game itself is not part of this repo yet (see [src/sim](src/sim/README.md)).

## Run it

Everything runs in Docker, so nothing has to be installed on your machine except Docker. The
commands below work from any shell.

```bash
docker compose run --rm tools install     # first time, and whenever package.json changes
docker compose up dev                     # dev server at http://localhost:5173
```

Other tasks, each one a one-off container:

```bash
docker compose run --rm tools run test
docker compose run --rm tools run lint
docker compose run --rm tools run typecheck
docker compose run --rm tools run build
docker compose run --rm tools run format
```

On Windows, `./scripts/check.ps1` runs format, typecheck, lint, test and build in one go and prints a
line per step (`./scripts/check.ps1 test lint` for a subset).

The tasks above use a `node_modules` that lives in a Docker volume, which your editor cannot see. Without
it, VS Code reports errors such as "Cannot find type definition file for 'node'" and unresolved
imports. To fix that without installing anything on your machine, copy the dependencies into the
project folder (git-ignored) using Docker:

```powershell
./scripts/editor-deps.ps1     # then in VS Code: "TypeScript: Restart TS Server"
```

Re-run it after `package.json` or `package-lock.json` change. (If you have Node 22.12 or newer on the
host, a plain `npm install` does the same job; `.nvmrc` pins the version CI uses.)

If you already have Node, the plain commands work too: `npm install`, `npm run dev`.

### Scripts

| Script              | What it does                                                |
| ------------------- | ----------------------------------------------------------- |
| `npm run dev`       | Vite dev server with hot reload                             |
| `npm run build`     | Type-check with `vue-tsc`, then build to `dist/`            |
| `npm run preview`   | Serve the built `dist/` locally                             |
| `npm run typecheck` | `vue-tsc --noEmit` (strict, no `any`)                       |
| `npm run test`      | Vitest, once. `npm run test:watch` to keep it running       |
| `npm run lint`      | ESLint (type-aware, `no-explicit-any`) and a Prettier check |
| `npm run format`    | Prettier, writing changes                                   |

## Folder structure

```
public/
  img/            NASA Black Marble night-lights textures (13500x6750 and 8192x4096)
  data/           countries-110m, rivers, lakes, cities, countries-50m (JSON)
src/
  main.ts  App.vue            layout: sidebar plus globe stage
  composables/useGlobe.ts     the one place Vue meets the globe: small UI state, forwards actions
  globe/                      rendering and input, plain TypeScript, no Vue
    createGlobe.ts            canvases, render loop, the GlobeApi
    projection.ts  state.ts   view maths, flight, inertia, spin
    draw2d.ts  labels.ts      countries, borders, grid, selection, shading, labels
    lightsGL.ts  shaders/     WebGL2 night lights (GLSL kept as .glsl files)
    hitTest.ts  input.ts      picking, drag, pinch, wheel, keyboard
  map/                        what the map shows
    modes.ts                  the nine modes: colours, scales, legends, tooltips
    data.ts                   loaders, 110m/50m switching, bounding circles
    climate.ts  info.ts  search.ts  types.ts
  lib/                        sun position, formatters, sphere helpers, storage, url
  ui/                         Vue components (dropdown, legend, search, picks, card, ...)
  sim/                        placeholder for the future simulation (pure functions)
  styles/                     tokens.css, base.css
tests/                        Vitest
scripts/                      check.ps1 (runs the checks in Docker)
compose.yaml                  Docker tasks: dev, tools
```

Imports only point one way: `ui -> composables -> globe -> map -> lib`. `globe`, `map` and `lib` never
import Vue.

### The globe API

`createGlobe(host, { world, mode, layers })` returns a small object, so the UI never touches canvases:

```ts
setMode(id)           setLayer('labels' | 'grid' | 'cities' | 'lights' | 'spin', on)
selectCountry(code)   togglePick(code)    flyToCountry(code)
closeCard()           clearPicks()        zoomBy(factor)       resetView()
onHover(cb)           onPicksChange(cb)   onViewChange(cb)     onLightsStatus(cb)
destroy()
```

Countries are identified by their `ADM0_A3` code (`UZB`). Each `on*` returns an unsubscribe function.

### Data and reactivity

Geometry is big, so it never becomes reactive: the loaded `World` is wrapped in `markRaw` and held in a
`shallowRef`. Vue state is only small values (current mode, pick codes, hovered code, layer flags, the
view readout), and components receive plain props such as names and card text.

Every `fetch` and image path goes through `publicUrl()` in `src/lib/url.ts`.

## Deploy to GitHub Pages

The workflow in `.github/workflows/deploy.yml` lints, tests and builds on every pull request, and on
pushes to `main` it also publishes the build.

1. Push the repository to GitHub.
2. In the repository, open **Settings -> Pages -> Build and deployment** and set **Source** to
   **GitHub Actions**. This is a one-time setting; the workflow cannot change it.
3. Push to `main` (or run the workflow from the **Actions** tab). The site appears at
   `https://<user>.github.io/<repo>/`.

`vite.config.ts` sets `base: './'`, so the build uses relative URLs and works under any path: the
repo's Pages address, after a rename or fork, on a custom domain, or from `vite preview`, without the
repo name appearing anywhere. If you later add history-mode routing, switch `base` to the repo path
(`'/<repo>/'`), because relative URLs break on deep links.

## The original single-file app

This project started as one `index.html` with its JavaScript, CSS and data inline. Comments and test
names that say "legacy" mean that version. It is kept in git history, not in the tree:

- The original app: `git show ac482a7:index.html`.
- The script that extracted its embedded data into `public/data/`: `git show b190895:scripts/extract-data.mjs`.
- The headless-Chromium tooling used to check the rewrite against it (screenshot diffs, DOM and
  behaviour comparison): the `legacy/parity/` folder in commit `78a534b`.

The rewrite matched the original pixel for pixel in 31 of 33 comparison scenarios, with identical DOM
structure and behaviour. The two phone-width differences came from a layout bug in the original: its
stage could never shrink, because the canvas's pixel height acted as the grid row's minimum size.

## Data credits

- Countries, cities, rivers, lakes: [Natural Earth](https://www.naturalearthdata.com/) (public
  domain). Country figures are 2019 estimates.
- Night lights: [NASA Earth Observatory, Black Marble 2016](https://earthobservatory.nasa.gov/features/NightLights)
  (public domain).
