# Simulation

The rules of the game, with no pictures. Everything here is plain TypeScript that runs the same in
the browser and in the tests. The 3D city ([src/city](../city)) draws what happens here; it does not
decide anything.

## What is here

City scale (a survivor, a city of people, a horde, a clock), all in metres, x east and y north:

| File            | What it does                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `grid.ts`       | A square grid of what covers each cell (building, road, water, tree, bridge)                           |
| `colliders.ts`  | Walls and round obstacles in a spatial hash; `moveCircle` slides along them; water and spawns          |
| `raycast.ts`    | Walk a ray through the walls: line of sight, and where a bullet stops                                  |
| `flow.ts`       | A walkability grid and a flow field, so a chaser walks around buildings to reach the survivor          |
| `spatial.ts`    | A flat grid index for "who is near here?" over thousands of moving points                              |
| `world.ts`      | What every game on a map shares (walls, walkable ground, buildings, places), "can someone stand here?" |
| `places.ts`     | Picks real buildings for jobs (radar, shelters, supplies, armory) from size, height, kind; the doors   |
| `player.ts`     | The survivor: walking, sprinting, stamina, aiming (one step at a time)                                 |
| `horde.ts`      | Thousands of zombies: eyes, ears and nose; wander, investigate, chase, attack; other targets           |
| `population.ts` | The city's people, counted per building (well, bitten, turned), and the outbreak inside each one       |
| `humans.ts`     | The few percent of people in the street, as individuals: stroll, flee, go indoors, get bitten, turn    |
| `game.ts`       | One game: two guns, noise, supplies, hunger, shelters, the outbreak, the clock, losing, events         |

`src/lib/rng.ts` is the seeded random number generator they all use.

## Rules for this folder

- **No DOM, no Vue, no Three.js, no `fetch`, no clocks, no `Math.random()`.** Time is an argument
  (`dt`, ideally 1/60 s). Randomness comes from a seeded `Rng`, so **the same seed and the same inputs
  replay the same game exactly.** The tests rely on it.
- **Plain data.** Plain objects and typed arrays, nothing with behaviour attached.
- **One exception to "never mutate":** the horde, the people in the street and the per-building counts
  (and the collision world's scratch space) are updated _in place_. Thousands of zombies in parallel
  typed arrays would otherwise mean thousands of copies per step, 60 times a second. `stepPlayer` still
  returns a new state; `stepGame`, `stepHorde` and `stepHumans` mutate the state you give them. That is
  stated at the top of each file.
- **Nothing inside a building.** A soak test plays minutes of a real game on the Tashkent map with
  thousands of zombies and people, and checks every one, every few seconds, with an _independent_
  point-in-polygon test that does not use the game's own grids.
- **A body never crosses a wall.** `moveCircle` is safe for a step shorter than the body's radius;
  `moveCircleLong` splits a longer one (everything far from the survivor is stepped four times as long
  and less often). Where two buildings leave a gap too narrow to walk through, a step that would carry a
  body across a wall is refused.

## How the city's people work

Nearly everyone is indoors at any moment, so people are **counted per building**, not simulated: how
many are well, how many are bitten and turning, how many have turned and are still inside. The total is
a real density times the area, shared between buildings by floor area and kind (`residentsOf`). Each
building has a door (`findDoor`, the same one a place uses) with some strength, bigger for bigger
buildings.

A few percent of each building's people are out in the street at the start, as individuals in
`humans.ts` (at most `GAME.streetPeople`). They are the only people with positions, so the cost does not
grow with the size of the city.

Once a second (`stepOutbreak`), inside every building that has anyone bitten or turned: the bitten turn
after about 14 s; the turned bite the well at a rate per second; some of the well run out into the
street; and once two have turned, or nobody is left to bite, the turned come out through the door as
zombies. Nobody is created or lost: well + bitten + turned stays what it was (apart from the zombies
you kill).

**It starts** in a few buildings with people in them, at least 350 m from you and far from each other,
so the first minutes are quiet.

**Zombies reach the people indoors through the doors.** A building's door is a target slot while anyone
well is behind it; a zombie that sees it walks up and strikes it. Damage wears the door down; once it
gives way every further blow bites one more person inside. A shelter's door is the same door, with more
strength (and the survivor may be behind it too).

## How a step runs

`stepGame(game, input, world, dt)`:

1. Move the survivor (`stepPlayer`), turning toward the aim point; zombies on them slow them down.
   Indoors (in a shelter) there is only reloading, resting and leaving.
2. Footsteps make noise: sprinting carries far, walking a little, standing still none.
3. Switch gun, reload, fire (hit-scan rays, blocked by walls; a shotgun fires eight) or swing the melee
   weapon when dry, shove, use a door (radar, shelter, shop, armory), pick up supplies.
4. Hunger: food drains; at zero the survivor starves and nothing heals.
5. Index where the zombies are, step the people in the street (`stepHumans`: look, flee, go in, stagger,
   turn), then fill the target slots (each person in the street, each door with someone well behind it).
6. Step the horde (`stepHorde`: each zombie thinks every 12th step, then moves, strikes or waits), and
   apply what zombies did: people bitten, doors battered or bitten through.
7. Once a second: the outbreak moves on inside every building, and the city is counted.
8. Check for death (health 0). Queue events for the renderer.

The horde's senses: a zombie sees you if you are in front of it, in range, with a clear line; smells you
from a few metres through walls; hears noises that reach it. It follows you only while it has a fresh
sign: break the line of sight and it heads for where it last saw you (not where you are now), and gives
up a couple of seconds after. Walkers are slower than a walking survivor, runners faster than a walk but
slower than a sprint, so stamina is the thing to manage.

A zombie can also go for something other than the survivor: a **target**. Targets are stable slots the
game fills each step (a person in the street, or a building's door with someone well behind it); a
zombie that sees or smells one walks straight at it and strikes it (with a short lunge, for someone
running away), and the damage is handed back to the game to apply. It stays on its target unless the
survivor turns up close. Hunting zombies still follow the survivor to a door they are hidden behind, but
only while the trail is warm: a zombie at the door gives up like any other once it has gone long enough
without a sign.

## Ideas for later

The world-scale outbreak (country by country, cities going dark on the globe) is not built. The city
outbreak above is its building block: when a city has fallen, the globe can dim its lights. It belongs
here too, keyed by country code (`ADM0_A3`), working on numbers per country and city and never on
geometry, and its output can become a map mode in `map/modes.ts` with no change to `src/globe`.
