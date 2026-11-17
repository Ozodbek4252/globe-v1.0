# Simulation

The rules of the game, with no pictures. Everything here is plain TypeScript that runs the same in
the browser and in the tests. The 3D city ([src/city](../city)) draws what happens here; it does not
decide anything.

## What is here

City scale (a survivor, a horde, a clock), all in metres, x east and y north:

| File           | What it does                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `grid.ts`      | A square grid of what covers each cell (building, road, water, tree, bridge)                     |
| `colliders.ts` | Walls and round obstacles in a spatial hash; `moveCircle` slides along them; water and spawns    |
| `raycast.ts`   | Walk a ray through the walls: line of sight, and where a bullet stops                            |
| `flow.ts`      | A walkability grid and a flow field, so a chaser walks around buildings to reach the survivor    |
| `world.ts`     | What every game on a map shares (walls, walkable ground, places) and "can someone stand here?"   |
| `places.ts`    | Picks real buildings for jobs (radar, shelters, supplies, armory) from size, height, kind, name  |
| `player.ts`    | The survivor: walking, sprinting, stamina, aiming (one step at a time)                           |
| `horde.ts`     | Hundreds of zombies: eyes, ears and nose; wander, investigate, chase, attack; other targets      |
| `civilians.ts` | The people to save: hiding, following round buildings, sheltering, evacuation                    |
| `game.ts`      | One game: two guns, noise, supplies, waves, shelters, survivors, the clock, win and lose, events |

`src/lib/rng.ts` is the seeded random number generator they all use.

## Rules for this folder

- **No DOM, no Vue, no Three.js, no `fetch`, no clocks, no `Math.random()`.** Time is an argument
  (`dt`, ideally 1/60 s). Randomness comes from a seeded `Rng`, so **the same seed and the same inputs
  replay the same game exactly.** The tests rely on it.
- **Plain data.** Plain objects and typed arrays, nothing with behaviour attached.
- **One exception to "never mutate":** the horde (and the collision world's scratch space) is updated
  _in place_. A thousand zombies in parallel typed arrays would otherwise mean a thousand copies per
  step, 60 times a second. `stepPlayer` still returns a new state; `stepGame` and `stepHorde` mutate
  the state you give them. That is stated at the top of each file.
- **Nothing inside a building.** A soak test plays minutes of a real game on the Tashkent map with
  hundreds of zombies and checks every zombie, every few seconds, with an _independent_ point-in-polygon
  test that does not use the game's own grids.

## How a step runs

`stepGame(game, input, world, dt)`:

1. Move the survivor (`stepPlayer`), turning toward the aim point; zombies on them slow them down.
   Indoors (in a shelter) there is only reloading, resting and leaving.
2. Footsteps make noise: sprinting carries far, walking a little, standing still none.
3. Switch gun, reload, fire (hit-scan rays, blocked by walls; a shotgun fires eight), shove, use a door
   (radar, shelter, shop, armory), pick up supplies.
4. Survivors in hiding join when you come near; followers walk behind you.
5. Every so often a wave appears out of sight from the direction announced earlier; near the end the
   helicopter is heard, picks where to land, and everything comes.
6. Fill the target slots (each person in the open, each shelter door with someone behind it), step the
   horde (`stepHorde`: each zombie thinks every 12th step, then moves, strikes or waits), and apply what
   zombies did to people and doors. A door that gives way takes everyone behind it.
7. Check for death (health 0) and rescue (the clock; the helicopter takes the followers near it and
   everyone sheltered behind a door that held). Queue events for the renderer.

The horde's senses: a zombie sees you if you are in front of it, in range, with a clear line;
smells you from a few metres through walls; hears noises that reach it. It loses the trail after a few
seconds without a sign. Walkers are slower than a walking survivor, runners faster than a walk but
slower than a sprint, so stamina is the thing to manage.

A zombie can also go for something other than the survivor: a **target**. Targets are stable slots the
game fills each step (a person in the open, or a shelter's door with someone behind it); a zombie that
sees or smells one walks straight at it and strikes it, and the damage is handed back to the game to
apply. It stays on its target unless the survivor turns up close. Hunting zombies still follow the
survivor's trail to a door they are hidden behind, but only while the trail is warm: a zombie at the
door gives up like any other once it has gone long enough without a sign.

## Ideas for later

The world-scale outbreak (country by country, cities going dark on the globe) is not built. When it
is, it belongs here too, keyed by country code (`ADM0_A3`), working on numbers per country and city and
never on geometry, and its output can become a map mode in `map/modes.ts` with no change to `src/globe`.
