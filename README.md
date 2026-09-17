# Mangalapuram Township Planner

A browser web app that plans the 73.54 ac in scope at Mangalapuram
(Thiruvananthapuram, Kerala): what to build, how much, **where and why** — and,
above all, how each zone lays out on the real terrain.

## Run it

```bash
cd app && npm install && npm run dev
```

Node 20+ and npm. Python 3.11+ only if you want to re-run the preprocessing
(not needed to run or build the app).

```bash
npm run test        # engine tests against tests/expected_values.yaml
npm run build       # typecheck + production build
npm run typecheck
```

`npm run dev`, `build` and `test` all run `scripts/sync-data.mjs` first, which
copies `data/processed/`, `config/` and `tests/` into `app/public/data/`. That
folder is generated — never edit it by hand.

## What it does

**Site and terrain.** Loads the survey as delivered: the in-scope parcel, the
client zoning plan registered onto it, existing road edges, drains, 1 m contours
and the 2 m DEM. Slope, plot-window fall and buildability read off the terrain.
Unsurveyed ground stays unsurveyed — it is flagged low-confidence, never filled.

**Rules.** KMBR 2019 (amended to 17.01.2023) with the 2025 amendment, read from
`config/kmbr_rules.yaml` as data. The engine throws rather than inventing a
value that is missing. Client sizing rules govern the first cut; KMBR is checked
on top; where they differ both values are shown and the stricter one decides.

**Zone layouts (the priority).** Villa, phase and senior zones get plots, roads,
cul-de-sacs and open space generated on the terrain, three options each. The
apartment zone gets towers sized by the client method, placed to maximise the
distance between them on the flattest ground that keeps it. School, club,
commercial, hotel and business hub get a massing block at the Table 6 coverage
and FSI.

**Honest reporting.** The programme asks for 79.8 ac on 73.54 ac. The tool says
so, per use, and says what has to give.

**Exports.** DXF (layered, local metres or UTM), XLSX area statement, PNG and
PDF sheets with a title block, and GLB massing.

## Tabs

| Tab | What it holds |
| --- | --- |
| Site | Areas, terrain bands, layers, raster overlays, zone list |
| Programme | Every cashflow line, sized, with the land shortfall |
| Zone layout | Generate and compare three options for the selected zone |
| Rules | Design switches, client rules and assumptions, all editable |
| Compliance | Findings for the current layout, and client rules against KMBR |
| Report | The Level 1 loop, use by use, and scenario save/load |
| Exports | DXF, XLSX, PNG, PDF, GLB |

The 2D plan and the 3D terrain share the `2D plan` / `3D` toggle, top right.

## Changing the inputs

- New survey, Google Earth levels or a deferred-land boundary: add files under
  `data/raw/`, re-run `tools/preprocess` (see its README), then restart the app.
- Client rule changes: edit them in the Rules tab to try them, or change
  `config/client_rules.yaml` to make them the default — and log the change in
  `docs/DECISIONS.md`.
- Regulation values: `config/kmbr_rules.yaml`, with a clause reference and a
  `verified:` status. Never in code.

## Where things live

```
docs/SPEC.md              the build spec (authoritative)
docs/STATUS.md            what is built against the PRD, and what is next
docs/DECISIONS.md         client decisions and the interpretations made
docs/DATA.md              data dictionary and known data issues
config/*.yaml             rules, programme, assumptions
data/processed/           app-ready geometry, DEM, levels, contours
tests/expected_values.yaml golden numbers the engine tests assert
app/src/engine/           pure TypeScript: geometry, terrain, rules, generators, exports
app/src/ui/               2D plan, 3D view, panels
app/scripts/              data sync and headless smoke checks
```

## Standing caveats

- Levels are RL on an assumed datum, TBM = 100.000. The MSL offset is unknown,
  so outfall and utility connection design is out of scope.
- About 12.9 ac of the parcel is unsurveyed.
- The 26.4 ac of deferred land is out of scope and the hospital waits for it.
- An AAI NOC is required and the permissible height is unknown; the client cap
  of 20 floors / 70 m is used until it is known.
- The villa approval route (subdivision vs group housing) is set aside, so
  Rule 31 figures are reported and never block a layout.
