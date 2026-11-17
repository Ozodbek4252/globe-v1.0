# Simulation

The rules of the game, with no pictures. Everything here is plain TypeScript that runs the same in
the browser and in the tests. The 3D city ([src/city](../city)) draws what happens here; it does not
decide anything.

## What is here

City scale (a survivor, a horde, a clock), all in metres, x east and y north:

| File           | What it does                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------- |
| `grid.ts`      | A square grid of what covers each cell (building, road, water, tree, bridge)                  |
| `colliders.ts` | Walls and round obstacles in a spatial hash; `moveCircle` slides along them; water and spawns |
| `raycast.ts`   | Walk a ray through the walls: line of sight, and where a bullet stops                         |
| `flow.ts`      | A walkability grid and a flow field, so a chaser walks around buildings to reach the survivor |
| `player.ts`    | The survivor: walking, sprinting, stamina, aiming (one step at a time)                        |
| `horde.ts`     | Hundreds of zombies: eyes, ears and nose; wander, investigate, chase, attack                  |
| `game.ts`      | One game: the pistol, noise, supplies, waves, the rescue clock, win and lose, an event queue  |

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
2. Footsteps make noise: sprinting carries far, walking a little, standing still none.
3. Reload, fire (a hit-scan ray, blocked by walls, one zombie hit), shove, pick up supplies.
4. Every so often a wave appears out of sight; near the end the helicopter is heard and everything comes.
5. Step the horde (`stepHorde`): each zombie thinks every 12th step, then moves, strikes or waits.
6. Check for death (health 0) and rescue (the clock). Queue events for the renderer.

The horde's senses: a zombie sees you if you are in front of it, in range, with a clear line;
smells you from a few metres through walls; hears noises that reach it. It loses the trail after a few
seconds without a sign. Walkers are slower than a walking survivor, runners faster than a walk but
slower than a sprint, so stamina is the thing to manage.

## Ideas for later

The world-scale outbreak (country by country, cities going dark on the globe) is not built. When it
is, it belongs here too, keyed by country code (`ADM0_A3`), working on numbers per country and city and
never on geometry, and its output can become a map mode in `map/modes.ts` with no change to `src/globe`.
