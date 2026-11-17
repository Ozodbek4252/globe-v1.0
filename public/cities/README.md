# City data

`*.json` here is map data extracted from **OpenStreetMap**.

Data © OpenStreetMap contributors, available under the
[Open Database Licence (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See <https://www.openstreetmap.org/copyright>.

These files are a derived database. If you redistribute or build on them, keep this notice,
credit OpenStreetMap, and share the data under the same licence. The game's own code is not affected.

| File            | Area                                                | Extracted  |
| --------------- | --------------------------------------------------- | ---------- |
| `tashkent.json` | 2 km x 2 km around the Tashkent TV Tower (Mirabad)  | 2026-11-16 |
| `paris.json`    | 1.6 km x 1.6 km around the Eiffel Tower             | 2026-11-17 |
| `tokyo.json`    | 1.6 km x 1.6 km around Tokyo Tower (Shiba)          | 2026-11-17 |
| `newyork.json`  | 1.4 km x 1.4 km around Times Square (Midtown)       | 2026-11-17 |
| `cairo.json`    | 1.6 km x 1.6 km around Tahrir Square                | 2026-11-17 |
| `london.json`   | 1.6 km x 1.6 km around Tower Bridge                 | 2026-11-17 |
| `sydney.json`   | 1.8 km x 1.8 km around Circular Quay                | 2026-11-17 |
| `oia.json`      | 1.2 km x 1.2 km around Oia, Santorini (a village)   | 2026-11-17 |

`index.json` is the list of places the game offers: for each, its name, country, where it is, the
people per square kilometre used to size the crowd (rough, from public figures for the district), and
a line for its card. A place needs a map file of the same name. Add one with `scripts/fetch-city.mjs`
(see the header of that file) and a line in `index.json`; the tests check that the two agree.

Regenerate with `scripts/fetch-city.mjs`.
