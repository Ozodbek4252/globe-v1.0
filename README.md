# Atlas Globe

An interactive 3D Earth in the browser. Drag to turn it, scroll or pinch to zoom, click countries to
select them. Nine map modes (physical, natural, political, continents, population, density, GDP per
person, income group, live day and night), a NASA night-lights layer, search, and a country card.

It is a Vite + TypeScript + Vue 3 app. The globe is drawn with Canvas 2D (d3-geo) plus a WebGL2
fragment shader for the night lights. It is the base for an outbreak survival game, and the first
playable piece is in: press **Enter Tashkent** to drop from the globe into a 3D city built from real
OpenStreetMap buildings, with a horde of zombies in it. You steer one survivor with a pistol and have
to stay alive until the rescue helicopter lands (see [The 3D city](#the-3d-city) and
[The game](#the-game)). The rules live in [src/sim](src/sim/README.md).

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
  cities/         3D city maps from OpenStreetMap (tashkent.json), with their licence notice
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
  city/                       the 3D city (Three.js), plain TypeScript, no Vue
    osm.ts  types.ts          OpenStreetMap to the compact CityData format (pure, tested)
    geometry.ts  palette.ts   footprints to meshes: walls, roofs, roads, parks, water, towers
    trees.ts  lamps.ts        deterministic trees and street lamps; occupancy.ts for placement
    sunlight.ts  sky.ts       the real sun at Tashkent, sky colours, sky dome
    textures.ts               facades with lit windows, road markings, ground grain
    cameraRig.ts  followYaw.ts  the camera maths, and which side the follow camera starts on
    character.ts  cutaway.ts  the survivor's low-poly body and walk cycle; see-through occluders
    zombies.ts  people.ts     the horde and the survivors, each as instanced meshes (walk cycle in the shader)
    effects.ts                tracers, flashes, blood, noise rings, the aim reticle
    pickups.ts  helicopter.ts supply crates; the rescue helicopter
    placeMarkers.ts           the outline, light column and door ring on buildings with a job
    placeStyle.ts             their colours (no Three.js, so the HUD can use them)
    bearings.ts               compass words and screen directions (pure, tested)
    createCity.ts  load.ts    builds the scene and runs it; loads public/cities/<id>.json
  lib/                        sun position, formatters, sphere helpers, storage, url, hash, rng
  ui/                         Vue components (dropdown, legend, search, picks, card, CityView, GameHud, RadarScope...)
  sim/                        pure, seeded game rules: colliders, raycast, flow field, player, horde,
                              places, civilians, game. See src/sim/README.md
  styles/                     tokens.css, base.css
tests/                        Vitest
scripts/                      check.ps1, editor-deps.ps1, fetch-city.mjs (OpenStreetMap extractor)
compose.yaml                  Docker tasks: dev, tools
```

Imports only point one way: `ui -> composables -> globe | city -> map -> lib`. `globe`, `city`, `map`
and `lib` never import Vue, and `city` and `globe` do not import each other.

## The 3D city

**Enter Tashkent** in the sidebar (or open `/#city`) loads a 2 km by 2 km district around the Tashkent
TV Tower: about 3,800 real building footprints, roads, canals, parks and 500 mapped trees, plus
generated trees and street lamps. Three.js and the city code download only when you press the button,
so the globe page stays light.

- **The survivor:** you start on the street beside the TV tower and walk with `W A S D` (up the
  screen is forward). `Shift` runs until you are out of breath; the stamina bar refills after a pause.
  Walls, trees, lamp posts and water are solid; you slide along them, and bridges let you cross canals.
  Buildings and trees that stand between the camera and the survivor dissolve so you never lose them.
  At night a flashlight comes on by itself (`L` to override).
- **Camera:** it follows the survivor from the side with the clearest view. `Q E` or right-drag turn
  it, the wheel zooms, `H` recentres. `V` switches to a free camera (`W A S D` or drag pan it, `R F`
  tilt, `T` jumps to the TV tower), and `V` again returns to the survivor.
- **Other keys:** `P` or `Esc` pauses (a menu offers resume, start again, back to the globe), `F2`
  shows a performance panel. The game also pauses by itself when the window loses focus.
- **Time of day:** a slider sets the real sun position over Tashkent (a fixed autumn date). Windows and
  street lamps light up as it gets dark.
- **Deep links:** `/?hour=17.4&view=x,y,yaw,pitch,distance&player=x,y&camera=free#city` opens at a
  given time, camera placement and survivor position (metres east and north of the centre, degrees,
  metres). All parts are optional; `view` alone starts in the free camera. Game options are in
  [The game](#the-game).

- **Heights:** OpenStreetMap tags a height for only about 5% of Tashkent's buildings, so the rest are
  estimated from the kind of building and its footprint. The estimate is deterministic.

## The game

Survive until the helicopter lands. The clock is five minutes. Save as many people as you can on the way.

**Fighting**

- **Aim and fire:** the mouse aims (the survivor turns to face it), holding the left button fires.
  The pistol has 15 rounds a magazine and 45 in reserve; `R` reloads (it also reloads by itself when
  empty). Bullets stop at walls. A zombie takes two pistol hits, a runner one.
- **Shove:** `Space` knocks back and stuns whatever is in front of you (every 1.6 seconds).
- **Noise matters.** Zombies see in front of them and smell very close, but they also _hear_: a pistol
  shot carries about 60 m, sprinting about 16 m, walking about 5 m, standing still none. Rings on the
  ground show how far each sound went. Zombies that lose you give up after a few seconds.
- **Speed matters.** Walkers are slower than you walking. Runners are faster than a walk but slower
  than a sprint. Sprinting is loud and tires you out; zombies hanging on slow you down.
- **Waves:** a band appears out of sight every 40 seconds, bigger each time, already on your trail. In
  the last 14 seconds the helicopter is heard and every zombie in earshot comes for you.

**Buildings with jobs.** A few real buildings are marked with a glowing outline and a column of light,
each in a colour for its job. Stand at the ring on the street in front and press `F`:

- **Radar** (blue, a few hundred metres off): power it up and a scope appears showing the horde, the
  buildings and the people, with the direction and countdown of the next wave on its rim.
- **Shelters** (teal): go inside to hide, heal to full and reload. You cannot move or shoot, and nothing
  can see or hear you, so ordinary pursuers give up after a few seconds. But zombies already on your
  trail, which means every wave, keep coming to the door and batter it. When it gives way you are thrown
  out hurt, the shelter is lost for good, and everyone behind it with you. A door with people inside
  draws zombies even when you are not there. Hiding in the nearest shelter all game does not win.
- **Supplies** (amber: shops and clinics): search once for ammunition or health.
- **Armory** (orange): a shotgun. `1` and `2` switch guns; each keeps its own ammunition. Eight pellets in
  a wide cone: it kills close up, is weak at range and useless past 16 m, is slow to fire and to
  reload, and is louder than the pistol (75 m).

**Survivors.** About ten people hide around the map, each with a green ring. Walk up to one and they
follow you, a little slower than you walk and well behind when you sprint. Zombies go for them too, and
hiding ones can be found by zombies that wander past. Take them into a shelter with you and they stay
inside (leaving, you leave them), or keep them with you and bring them to the helicopter. At the end it
takes the followers near it and everyone safe behind a door that held. The final card counts them.

**Seeing it all.** From the free camera, or zoomed out, every zombie also shows as a red dot (brighter
when hunting). Ground supplies (ammunition crates, first-aid kits) have their own light columns, and
health comes back a little by itself but only up to 60, only after a quiet spell.

Game options go on the link, all optional: `&seed=123` replays the same game (same zombies, supplies,
survivors and waves), `&rescue=60` sets the clock in seconds, `&zombies=0` removes the zombies in the
streets at the start (the number is groups; default 70), `&people=0` removes the survivors (default 10),
`&waves=0` switches the waves off. `&debug=1` puts the scene on `window.__city.debug` with levers for
staging scenes (spawn zombies, call survivors, jump the clock, teleport).

To make another city (or redo this one), run the extractor in Docker; it writes
`public/cities/<id>.json` and prints what it found:

```bash
docker compose run --rm --entrypoint node tools scripts/fetch-city.mjs \
  --id tashkent --name "Tashkent" --lat 41.3457 --lon 69.2848 --half 1000
```

It queries the public Overpass servers, which are sometimes busy; the script retries across servers.
The map data is licensed under the ODbL, see [public/cities/README.md](public/cities/README.md).

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
- 3D city: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
  [Open Database Licence](https://opendatacommons.org/licenses/odbl/1-0/). Credited in the city view.
- 3D rendering: [Three.js](https://threejs.org/) (MIT) and [earcut](https://github.com/mapbox/earcut) (ISC).
