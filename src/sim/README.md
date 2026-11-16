# Simulation (placeholder)

The world-scale outbreak simulation will live here. Nothing is implemented yet.

## Rules for this folder

- **Pure functions only.** No DOM, no Vue, no `fetch`, no `Date.now()`, no `Math.random()`.
  Anything that needs time or randomness takes it as an argument, so a run can be replayed and tested.
- **Plain data in, plain data out.** State is a serialisable object; `step(state, dt, inputs)`
  returns the next state without mutating the old one.
- **Keyed by country code** (`ADM0_A3`, e.g. `UZB`). The globe and the UI already use these codes.
- **No geometry.** The simulation never needs polygons. It works on numbers per country (and per
  city), and the renderer maps those numbers to colours.

## How it plugs into the rest of the app

```
map/data.ts  ──►  sim/ (pure)  ──►  map/modes.ts   (new modes: "Infection", "Cities lit", ...)
 countries,          step()          fill(c) = colour for a country, from sim state
 cities, pop
```

- **Input data** is already loaded into `World`: country population, GDP and income group,
  neighbours can be derived from the 110m geometry once, at load, and cached as adjacency lists.
  `world.cities` has a population for every city (232 of them, 199 flagged as capitals).
- **Output** is a map of `code -> number` per tick. A new entry in `map/modes.ts` turns it into a
  fill colour and a legend, with no change to `src/globe` (it already takes a `fill` function).
- **Cities going dark** is the Lights layer driven by sim state: the shader would take a per-city
  "lit" value instead of reading only the static NASA texture. That is a change to
  `globe/lightsGL.ts` and its shader, and the shader's content-hash test will need updating then.
- **The game loop** (ticks, speed, pause) belongs in a composable next to `useGlobe`, not here.

## Suggested first steps

1. `types.ts`: `SimState` (per-country susceptible/infected/dead, per-city lit flag), `SimInputs`.
2. `seed.ts`: a small seeded PRNG so runs are reproducible.
3. `step.ts`: one tick of spread within a country and between neighbouring countries.
4. Tests in `tests/` first: determinism (same seed, same result), conservation of people, and
   that spread only follows adjacency or declared routes.
