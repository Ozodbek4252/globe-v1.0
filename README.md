# Atlas Globe

An interactive 3D Earth in the browser. Drag to turn it, scroll or pinch to zoom, click countries to
select them. Nine map modes (physical, natural, political, continents, population, density, GDP per
person, income group, live day and night), a NASA night-lights layer, search, and a country card.

It is a Vite + TypeScript + Vue 3 app. The globe is drawn with Canvas 2D (d3-geo) plus a WebGL2
fragment shader for the night lights. It is the base for an outbreak survival game, and the first
playable piece is in: click a gold pin on the globe (or pick a place in the sidebar) and press **Play
here** to drop into a 3D city built from real OpenStreetMap buildings and full of its people, where an
outbreak has just begun. There are eight places, from Manhattan to a village on Santorini. You steer one
survivor with a pistol and have to stay alive as long as you can: there is no rescue and no cure. When
you die the city goes on and the next survivor steps into it; when not a soul is left in it, the place
has fallen, and its lights go out on the globe (see [The world](#the-world), [The 3D
city](#the-3d-city) and [The game](#the-game)). The rules live in [src/sim](src/sim/README.md).

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
  cities/         the places to play: index.json (the list) and one OpenStreetMap map each
                  (tashkent, paris, tokyo, newyork, cairo, london, sydney, oia), with their licence notice
src/
  main.ts  App.vue            layout: sidebar plus globe stage; opens the city
  composables/useGlobe.ts     the one place Vue meets the globe: small UI state, forwards actions
  composables/usePlay.ts      the places to play and what happened in each (kept in localStorage)
  globe/                      rendering and input, plain TypeScript, no Vue
    createGlobe.ts            canvases, render loop, the GlobeApi
    projection.ts  state.ts   view maths, flight, inertia, spin
    draw2d.ts  labels.ts      countries, borders, grid, selection, shading, labels
    lightsGL.ts  shaders/     WebGL2 night lights (GLSL kept as .glsl files)
    markers.ts                the pins, their hit test, and the darkness over fallen places
    hitTest.ts  input.ts      picking, drag, pinch, wheel, keyboard
  map/                        what the map shows
    modes.ts                  the nine modes: colours, scales, legends, tooltips
    data.ts                   loaders, 110m/50m switching, bounding circles
    playable.ts               the list of places, and the record of what became of each (pure, tested)
    climate.ts  info.ts  search.ts  types.ts
  city/                       the 3D city (Three.js), plain TypeScript, no Vue
    osm.ts  types.ts          OpenStreetMap to the compact CityData format (pure, tested)
    geometry.ts  palette.ts   footprints to meshes: walls, roofs, roads, parks, water, towers
    trees.ts  lamps.ts        deterministic trees and street lamps; occupancy.ts for placement
    sunlight.ts  sky.ts       the real sun over the place (its latitude, longitude and time zone), sky colours
    textures.ts               facades with lit windows, road markings, ground grain
    cameraRig.ts  followYaw.ts  the camera maths, and which side the follow camera starts on
    character.ts  cutaway.ts  the survivor's low-poly body and walk cycle; see-through occluders
    zombies.ts  people.ts     the horde and the people in the street, instanced meshes (walk cycle in the shader)
    effects.ts                tracers, flashes, blood, noise rings, the aim reticle
    pickups.ts                supply crates: ammunition, first aid, food
    placeMarkers.ts           the outline, light column and door ring on buildings with a job
    placeStyle.ts             their colours (no Three.js, so the HUD can use them)
    bearings.ts               compass words and screen directions (pure, tested)
    createCity.ts  load.ts    builds the scene and runs it; loads public/cities/<id>.json
  lib/                        sun position, formatters, sphere helpers, storage, url, hash, rng
  ui/                         Vue components (dropdown, legend, search, picks, card, CityView, GameHud, RadarScope...)
  sim/                        pure, seeded game rules: colliders, raycast, flow field, player, horde,
                              places, population, humans, game. See src/sim/README.md
  styles/                     tokens.css, base.css
tests/                        Vitest
scripts/                      check.ps1, editor-deps.ps1, fetch-city.mjs (OpenStreetMap extractor)
compose.yaml                  Docker tasks: dev, tools
```

Imports only point one way: `ui -> composables -> globe | city -> map -> lib`. `globe`, `city`, `map`
and `lib` never import Vue, and `city` and `globe` do not import each other.

## The world

The places you can play are gold pins on the globe, and buttons in the sidebar. Click one (the globe
turns to it) and its card shows how many people live there, the longest you have lasted, and **Play
here**. Tashkent is the whole city: 313,000 buildings cut into 1 km tiles that the game loads around
you as you go (a note under the clock says when the next part is being built). The outbreak goes on in
the parts you are not in, and the horde and the people come with you across the seams; the city's
numbers at the top count everything the game has seen. The other places are a real district each, a square 1.2 to 1.8 km across: Paris around
the Eiffel Tower, Tokyo Tower and Shiba, Midtown Manhattan, downtown Cairo, London at Tower Bridge,
Sydney's Circular Quay, and Oia, a village on Santorini. A crowd is sized from
each place's own density of people (a rough public figure, in `public/cities/index.json`).

**The wheel joins the two views.** Zoom into a pin as far as the globe goes and keep going, and you
drop into that place; in the city, zoom out as far as the camera goes (1.8 km up) and keep going, and
it asks whether you want the globe (so a wheel that runs on does not throw you out). It is a hand-off,
not one continuous zoom: the globe and the city are two different pictures.

**Your game is saved as you play.** Every five seconds, and whenever you look away or leave, the whole
game (every zombie, every person, every door, the clock) is written to this browser's storage. Close
the tab, come back tomorrow, open the place again: it is exactly where you left it, paused, with the
horde where it stood. The card and the list say **in play** with the time so far, and the button says
**Continue**. A city you leave for the globe also stays alive in memory, so going straight back is
instant.

**Dying does not end the city.** The outbreak goes on without you. **Next survivor** puts a fresh person
at the start with a full pack, as far from the dead as the street allows, in the city exactly as it was:
the horde where it stood, the clock where it got to, the doors that were broken still broken, the shops
already searched still empty (ground supplies are laid out again). Your score is each survivor's own
time. **New city** throws the whole place away and starts the outbreak over.

**A place falls when nobody is left in it.** Dying does not end a city (the next survivor steps into
it, see [The game](#the-game)); the city ends when not one of its people is left well or turning, here
or in the parts of a big city that are not loaded. Then the game there is over and its save is thrown
away, its pin turns into a red cross, and with the **Lights** layer on, a patch of darkness spreads over
its glow on the globe. It stays dark, with the longest you lasted, until you **Try again** there (a new
outbreak, which lights it up). What happened is kept in this browser (`localStorage`).

## The 3D city

A place loads as a 3D district: its real building footprints, roads, water, parks and mapped trees, plus
generated trees and street lamps (Tashkent, 3 km across, has about 9,000 buildings; a village a few hundred). Three.js
and the city code download only when you press **Play here**, so the globe page stays light. The
address holds the place: `/#city=paris` opens Paris directly (a bare `#city` is Tashkent, as it always
was).

- **The survivor:** you start on the street beside the tallest tower (or the middle of the map) and
  walk with `W A S D` (up the screen is forward). `Shift` runs until you are out of breath; the stamina bar refills after a pause.
  Walls, trees, lamp posts and water are solid; you slide along them, and bridges let you cross canals.
  Buildings and trees that stand between the camera and the survivor dissolve so you never lose them.
  At night a flashlight comes on by itself (`L` to override).
- **Camera:** it follows the survivor from the side with the clearest view. `Q E` or right-drag turn
  it, the wheel zooms, `H` recentres. `V` switches to a free camera (`W A S D` or drag pan it, `R F`
  tilt, `T` jumps to the landmark), and `V` again returns to the survivor.
- **Other keys:** `P` or `Esc` pauses (a menu offers resume, start again, back to the globe), `F2`
  shows a performance panel. The game also pauses by itself when the window loses focus.
- **Time of day:** the day goes by as you play, an hour for every minute (a whole day in 24 minutes),
  with the real sun over the place on a fixed autumn date. A game starts at 8 in the morning; windows
  and street lamps light up as it gets dark. The clock in the corner shows the time; add `&cycle=0` to
  the address to stop it, and the slider then sets the hour by hand.
- **Deep links:** `/?hour=17.4&view=x,y,yaw,pitch,distance&player=x,y&camera=free#city=paris` opens at a
  given time, camera placement and survivor position (metres east and north of the centre, degrees,
  metres). All parts are optional; `view` alone starts in the free camera. Game options are in
  [The game](#the-game).

- **Heights:** OpenStreetMap tags a height for only about 5% of Tashkent's buildings (more elsewhere), so the rest are
  estimated from the kind of building and its footprint. The estimate is deterministic.

## The game

Stay alive as long as you can. There is no rescue and no cure: the outbreak is the whole story, and
the clock at the top of the screen counts how long you have lasted.

**The city is full of people.** Tens of thousands of them (about 69,000 in the 9 km² of Tashkent), worked out from the real density of the place
(7,700 per square kilometre in Tashkent) and shared between the real buildings by size, height and kind: a tall
block of flats holds hundreds, a house a handful, a shed nobody. Nearly everyone is indoors; the rest
are out in the street as individuals (drawn as dots from high up) who stroll about, run from zombies
and gunfire (they notice a zombie a street away, about 40 m, and zombies notice them from 30 and chase
them; a walker cannot catch someone running in the open, a runner can), and make for the nearest door.
The newly turned set off down the street rather than crowding the door they came out of, so the
outbreak spreads through the district. How many are out follows the hour: a few percent in the
small hours, over a tenth in the morning rush and the evening. People leave their buildings and go home
again through the day, and the more of the city has turned, the more of them stay in.

**Night is worse.** When the sun goes down (a note under the clock says so) the dead are more active
and more aggressive: they roam further and rest less, hear and smell further and rouse each other from
further off, hunt a quarter faster, strike sooner and hit a quarter harder, and the infection spreads
faster inside the buildings. A walker is still slower than you walking, and a runner than your sprint,
but the margin is thin. The nights last about twelve hours; be somewhere safe before dark.

**The outbreak spreads from person to person.** It starts in a few buildings far from you, with no
zombies in the street at first, so the first minutes are quiet. Inside a building the turned bite the
well, the bitten turn after about fourteen seconds, and once enough have turned they come out as
zombies (some run for the street first). In the street a zombie that reaches someone bites them: they
stagger on, sickly green, for seven seconds and then turn. Zombies also batter the doors of buildings
with people behind them; when a door gives way they get in. Everything you see is a person who was
somebody: the number of people still well (and bitten, and turned) is on the screen.

**Hide and they lose you.** A zombie follows you only while it has a fresh sign: break the line of
sight and it heads for where it last saw you, and gives up a couple of seconds after that. Hiding
behind a door works, but it does not win the game.

**Fighting**

- **Aim and fire:** the mouse aims (the survivor turns to face it), holding the left button fires.
  The pistol has 15 rounds a magazine and 45 in reserve; `R` reloads (it also reloads by itself when
  empty). Bullets stop at walls. A zombie takes two pistol hits, a runner one.
- **Out of ammunition?** Click anyway and you swing whatever you can lay hands on: slower and shorter
  than a gun, three blows to fell a walker. Zombies you kill sometimes drop ammunition, food or first aid
  (they were people once).
- **Shove:** `Space` knocks back and stuns whatever is in front of you (every 1.6 seconds).
- **Noise matters.** Zombies see in front of them and smell very close, but they also _hear_: a pistol
  shot carries about 60 m, sprinting about 16 m, walking about 5 m, standing still none. Rings on the
  ground show how far each sound went. Gunfire also sends the people in the street running.
- **Speed matters.** You walk at 3.4 m/s and sprint at 7.6 for about fourteen seconds; the stamina bar
  refills after a pause. Walkers (2.3 m/s) are slower than you walking; runners (5.2) are faster than
  a walk but slower than a sprint; at night both are a quarter faster. The people of the city stroll at
  about 1.25 and run at about 4.1, so a walker never catches them in the open and a runner always does.
  Zombies hanging on slow you down, and they never stand in each other's space: a crowd spreads out.
- **Cars.** Cars stand parked along the real roads (a few dozen in view, each with some fuel in the
  tank). Walk up to one and press `F` to get in; then `W` is the pedal, `S` the brake (and reverse,
  once stopped), `A` and `D` the wheel, as in any driving game (a car turns only while it rolls);
  `F` gets you out. On a road it does
  nearly 80 km/h, off one about 30; it slides along walls and never crosses one, and a hard crash
  costs the car (and above about 32 km/h, you) something. Zombies in the way are run down, which
  wears the car a little each time. Inside, most of a blow lands on the bodywork instead of you, until
  the car is wrecked. The engine is loud (up to 60 m at speed), so a drive brings the horde; the tank
  runs down (a full one lasts about seven minutes flat out), and an empty or wrecked car is left where
  it stands. Cars stay where you leave them, through saves, through the window moving across a big
  city, and for the next survivor.

**Staying fed.** Hunger drains steadily; at zero you starve and nothing heals. Food crates and first aid
lie about the streets, shops and clinics have more, and kills sometimes drop some.

**Buildings with jobs.** A few real buildings are marked with a glowing outline and a column of light,
each in a colour for its job. Stand at the ring on the street in front and press `F`:

- **Radar** (blue, a few hundred metres off): power it up and a scope appears showing the horde and the
  buildings.
- **Shelters** (teal): go inside to hide, heal to full and reload. You cannot move or shoot, and nothing
  can see or hear you, so ordinary pursuers give up after a few seconds. But zombies already on your
  trail keep coming to the door and batter it. When it gives way you are thrown out hurt and the
  shelter is lost for good. Hunger keeps going indoors, so hiding all game does not work either.
- **Supplies** (amber: shops and clinics): search once for ammunition, health or food.
- **Armory** (orange): a shotgun. `1` and `2` switch guns; each keeps its own ammunition. Eight pellets in
  a wide cone: it kills close up, is weak at range and useless past 16 m, is slow to fire and to
  reload, and is louder than the pistol (75 m).

**Seeing it all.** From the free camera, or zoomed out, every zombie also shows as a red dot and every
person in the street as a pale one; the radar scope shows the horde around you. Ground supplies have
their own light columns, and health comes back a little by itself but only up to 60, only after a quiet
spell.

Game options go on the link, all optional: `&seed=123` replays the same game (same outbreak, zombies
and supplies), `&patients=3` is how many buildings the outbreak begins in (0 for a calm city),
`&density=7700` is people per square kilometre (default: the place's own), `&zombies=0` adds groups of zombies in the streets at
the start, `&hour=22` is the hour the game starts at and `&cycle=0` stops the day where it is.
`&debug=1` puts the scene on `window.__city.debug` with levers for staging scenes (spawn zombies, put
a crowd in the street, start an outbreak next to you, set the clock, teleport).

To make another place (or redo one), run the extractor in Docker; it writes
`public/cities/<id>.json` and prints what it found:

```bash
docker compose run --rm --entrypoint node tools scripts/fetch-city.mjs \
  --id tashkent --name "Tashkent" --lat 41.3457 --lon 69.2848 --half 1000
```

It queries the public Overpass servers, which are sometimes busy; the script retries across servers.
Then add the place to `public/cities/index.json` (name, country, where, people per km², a line for its
card) and to the table in `public/cities/README.md`; the tests check that the list, the map files and the
notice agree, and play a minute of the game on every map. The map data is licensed under the ODbL, see
[public/cities/README.md](public/cities/README.md).

### The globe API

`createGlobe(host, { world, mode, layers })` returns a small object, so the UI never touches canvases:

```ts
setMode(id)           setLayer('labels' | 'grid' | 'cities' | 'lights' | 'spin', on)
selectCountry(code)   togglePick(code)    flyToCountry(code)
closeCard()           clearPicks()        zoomBy(factor)       resetView()
onHover(cb)           onPicksChange(cb)   onViewChange(cb)     onLightsStatus(cb)
setMarkers(pins)      setChosenMarker(id) flyToPoint(lat, lon)  onMarkerClick(cb)  onZoomIntoMarker(cb)
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
