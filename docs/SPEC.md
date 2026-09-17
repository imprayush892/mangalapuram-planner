# Mangalapuram Township Planner — Build Specification

Status: authoritative build spec, 17 Sep 2026. Where this file and the PRD differ, **this file wins**.
Live PRD (reference, human-facing): https://claude.ai/code/artifact/1941dd4e-3a91-4ca0-839f-8d79abe85bb0

## 1. What we are building

A browser web app that tells the developer, for the 73.54 ac in scope at Mangalapuram (Thiruvananthapuram), **what to build, how much, where and why**, and — most importantly — **lays out each zone**:

- villa plots and their internal road network;
- apartment towers: size, count, footprint, spacing and FSI use;
- parking, open space and circulation.

Every number shown must trace back to one of three things:

- a data file;
- a rule in `config/kmbr_rules.yaml` or `config/client_rules.yaml`;
- an editable assumption in `config/assumptions.yaml`.

It works at two levels:

1. **Level 1 — zoning.** Allocate uses to zones across the site. Start from the client Zoning Plan (`data/processed/zones_client_registered.geojson`). It is a *starting point* only; the user edits and regenerates it.
2. **Level 2 — intra-zone layout (PRIORITY).** Generate plots, roads, towers and open space inside each zone on the real terrain. Check the result against the client rules and KMBR, and feed the yields back to Level 1.

## 2. Hard facts about the site

- **Coordinates.** All processed geometry is in **local metres**: `x = UTM43N E − 706106.927`, `y = N − 953717.901` (EPSG:32643). See `data/processed/site_origin.json`.
- **Level datum.** Levels are RL on an **assumed datum: TBM = 100.000** at local (231.787, 630.257). The MSL offset is unknown, so outfall and utility connection design stays blocked until it is set.
- **Land in scope.** 73.54 ac (P1 47.37 ac; P2 26.17 ac, which is two deed parcels merged). This is one consolidated parcel.
- **Deferred land.** 26.4 ac, excluded. The hospital waits for it: keep a reserved hospital zone and place **no hospital** on the in-scope land.
- **Terrain.**
  - 60.68 ac of the parcel is surveyed; ~12.9 ac is not. Unsurveyed cells are NaN in `dem_2m.f32`.
  - Unsurveyed ground may later take Google Earth levels, tagged low-confidence.
  - Relief is RL 68.6 to 143.5, with the summit in the east-centre.
  - Slopes over 45° are unbuildable (Rule 22).
- **Drainage.** Channels are local only; the survey does not reach the watershed divides. Do not size culverts or retention.
- **Existing roads.** `site_features.geojson` layer RD (these are road *edges*). They are retained and widened to 10 m. There are no structures to retain.
- **Airport.** An AAI NOC is needed (the site is within 20 km of the airport) and the height limit is unknown. The client cap is **20 floors / 70 m**.

## 3. Programme (see `config/programme.yaml`)

The baseline comes from the cashflow workbook. Per-unit areas are **plinth** areas.

| Line | Units / BUA | Land |
| --- | --- | --- |
| Apartments | 100 + 900 flats at 1,500 sft plinth | 1.2 + 10.8 ac |
| Villas | 60 at 1,750 sft + 640 at 2,000 sft | 3 + 32 ac |
| Senior living (villa-style) | 32 + 160 units at 1,000 sft | 1 + 5 ac |
| School | 200,000 sft | 3.0 ac core campus / 6.0 ac developable / 10.3 ac zone |
| Hospital | 300,000 sft | 5 ac — **deferred** |
| Club + annex + mini golf | 50,000 sft | 8 ac |
| Commercial | 300,000 sft | 4 ac |
| Hotel (assumption) | 120 keys, 120,000 sft | 3 ac |
| Convention hall | 1,080 m² | Inside the hotel or commercial land |
| Business hub (assumption) | 100,000 sft | 1.5 ac |

- **Population:** target 4,000 now; the layouts must allow 6,300 at full build-out.
- **SBUA:**
  - villa and senior: plinth + 150 sft;
  - apartment: plinth × 1.22 × 1.08.
- **Known finding:** the programme needs more land than the 73.54 ac in scope. The tool must report the shortfall, not hide it.

## 4. Client sizing rules (govern the first cut — `config/client_rules.yaml`)

### 4.1 Villas and senior living (20/30/50)

1. Split the zone area into 20% roads, 30% open space and 50% saleable.
2. Unit plot area = saleable area ÷ units.
3. Plot aspect ratio (short:long) is between 1:1 and 1:2.5.
4. The minimum side is **18 m on the plot**, read as the long side (switchable to "both sides").
   - The minimum plot is therefore 18 × 7.2 = 129.6 m².
   - Allow a 3% tolerance (the client's own 126 m² example is 1:2.56).
5. If the unit plot is below the minimum, switch to **row housing**: group k units per plot (k = 2 first) until the plot area reaches the minimum.
6. Villa footprint (placeholder): a 1:2.5 rectangle covering 45% of the plot area. Check it against the setbacks and report.
7. Villa types:
   - **standard** (Projects 1, 2 and 4);
   - **premium** (Project 3: ridge and corner sites).

   Plot sizes for both come from 20/30/50.
8. Client roads: 18 m spine running strictly N–S, 10 m public roads, 6 m internal roads.
   - Cul-de-sac heads are at least 81 m² with no side under 9 m.
   - Inner turning radius is at least 3.5 m.
9. Client setbacks: front 2.0 m, rear 1.5 m, sides 1.0 m. Flag them against KMBR (front average 3.0 m, minimum 1.8 m).
10. Plots should face E, W or N; corner plots are premium.
11. Recreational space is ≥10% per cluster, at least 6 m wide.

### 4.2 Apartments

1. Total floor area = land × FSI, where FSI is 3 (free), 4 or 6 (with fees) from KMBR Table 6 A1.
2. At most 20 floors or 70 m.
3. Total footprint = floor area ÷ 20. It must fit within the **30–50% buildable share** of the land.
4. Core = 20% of the footprint; flats = 80% (a switch; the client note is ambiguous).
5. Flat bands (plinth, sft):
   - 2 BHK: 900–1,200
   - 3 BHK: 1,200–1,800
   - 4 BHK: 1,800–2,400
   - 5 BHK: 2,400–3,000
6. Mixes, per floor or per tower:
   - 2 + 3 BHK
   - 3 + 4 BHK
   - 4 + 5 BHK
   - any single type
7. Flats per floor: 4 to 6.
8. Plate = flats per floor × average flat ÷ 0.8.
9. Towers = ceil(total footprint ÷ plate).
10. Spacing:
    - Maximise the distance between towers; never less than **12 m**.
    - Only if the zone is too small may two towers join at 0 m, and only short side to short side or in an L.
    - A joined block must sit inside the zone offset **6 m** inward, or the KMBR height-driven yard if that is larger.

Golden numbers for these rules are in `tests/expected_values.yaml`.

## 5. KMBR checks (run on every layout — `config/kmbr_rules.yaml`)

- **Yards (Table 4).** Add 0.5 m per 3 m of height above 10 m, rounded up, until a yard reaches 16 m.
  - In a group of buildings, yards apply at the plot boundary.
  - Gaps between buildings: 2 m (up to 10 m high), 3 m (above 10 m), 5 m for high-rise, 1.5 m between villas up to 8 m high.
- **Coverage and FSI (Table 6).** Use the weighted FSI for groups of buildings and multiple occupancies.
- **Access widths.** Tables 7, 8 and 8A use the total floor area. A1 above 24,000 m² needs 8 m.
- **High-rise** (≥16 m, or more than 5 floors):
  - 5 m motorable fire lanes on two adjacent sides, one of them on the access side;
  - 5 m entry gate with 5 m headroom;
  - 2 staircases;
  - a stretcher lift if the building has more than 16 flats.
- **Parking.**
  - Table 9 (flats by floor area per unit), plus 15% visitor parking and two-wheeler space equal to 25% of the car-parking area.
  - Table 10 for other uses; senior living at 25% of the A2 rate.
  - Ramps no steeper than 1:7, 3.5 m one-way / 5.5 m two-way; aisles 4 m.
- **Circulation and daylight:**
  - travel distance ≤30 m (≤45 m if sprinklered);
  - habitable space ≤7.5 m from a window, so plate depth is about 14–20 m;
  - lift count per Rule 40.
- **Apartment recreation (Rule 43):** 6% of total floor area, with at least 35% of it at ground level.
- **Open space:** at least 50% of open space unpaved.
- **Podiums up to 16 m:** ground yards are sized for the podium height (minimum 3 m); full-height yards apply at the podium top. Use podiums to absorb slope.
- **Subdivision rules (Rule 31)** — report only; the client has set the approval route aside:
  - 125 m² minimum plot;
  - 7 m streets; cul-de-sacs 5 m if ≤250 m, 3 m if ≤75 m;
  - 10% recreation, in pieces ≥200 m² and ≥6 m wide;
  - junction splays 4 m / 10 m.
- **Approvals:** District Town Planner approval triggers per Table 11; AAI NOC.
- **Rule conflicts.** Where a client rule is looser than KMBR, show both values, apply the stricter one in compliance status, and never silently change the client's first cut.

## 6. Layout algorithms (Level 2)

### 6.1 Villa and senior zone generator

The inputs are the zone polygon, DEM, programme line(s), client rules and KMBR rules.

1. **Buildable area.**
   - Buildable = zone ∩ parcel, minus Rule 22 cells (slope over 45°), minus a user-drawn no-go area.
   - Unsurveyed (NaN) cells are allowed but flagged low-confidence.
2. **Budgets.**
   - roads = 20%, open space = 30%, saleable = 50% of the zone area;
   - unit plot area, row-housing grouping k, plot count;
   - plot size w × d with d ≥ 18 m and d/w ≤ 2.5 (d runs perpendicular to the road).
3. **Road direction candidates:**
   - (a) parallel to the contours (the dominant DEM aspect in the zone, ±15°);
   - (b) N–S roads, so plots face E and W;
   - (c) E–W roads, so plots face N.
4. **For each candidate:**
   1. Lay double-loaded road strips at pitch 2d + road width (6 m internal).
   2. Clip them to the zone.
   3. Add a perimeter or cross loop so every strip connects to a public road or the spine.
   4. Turn dead ends of 250 m or less into cul-de-sacs with a 9 × 9 m head.
5. **Plots.** Cut plot rows of depth d along both sides of each road into widths w.
   - Keep only plots fully inside the buildable area.
   - Tag corner plots.
6. **Open space.**
   - Fill it first from ground over 20°, drainage lines (D8 flow accumulation above a threshold) and slivers; top up to 30%.
   - Guarantee ≥10% per cluster in pieces ≥200 m² and ≥6 m wide, each with access.
7. **Iterate.** Adjust the road pitch, offset and angle until the actual shares come within ±2 points of 20/30/50 and the plot count is as close as possible to the target (never above it). Report any residual difference.
8. **Terrain per plot.**
   - Fall = max − min DEM value inside the plot.
   - Platform RL = median.
   - Compute cut and fill; classify the fall with the thresholds in `assumptions.yaml`.
   - Price terrace retaining walls between rows.
9. **Footprint.** Place the 45%, 1:2.5 rectangle inside the client setbacks and check it against the KMBR yards.
10. **Score** on:
    - yield vs target;
    - earthwork and retaining cost;
    - orientation (share of plots facing E, W or N);
    - road share;
    - open-space quality;
    - corner count.

    Keep the **best 3 options**.

### 6.2 Apartment zone generator

1. Size the scheme with the client method (§4.2) for the chosen FSI, mix and flats per floor: total footprint, plate and tower count.
2. **Plate geometry.** A rectangle with depth 14–20 m and length = plate ÷ depth.
   - Enforce travel distance (≤30 m, or ≤45 m if sprinklered) and daylight depth.
   - Plates above ~1,080 m² need two cores: flag them.
3. **Podium platforms.**
   - Terrace along the contours so the fall across each tower footprint is ≤3 m.
   - Podium height ≤16 m.
4. **Placement.**
   - Place the towers inside the zone offset by max(KMBR yard for their height, 6 m).
   - Maximise the minimum pairwise distance (≥12 m). A good method is farthest-point / repulsion optimisation over candidate positions on a grid, with the long axis parallel to the contours.
   - If it cannot fit, allow short-side or L joins inside the 6 m inward offset.
5. **Circulation.** Route an 8 m access road into the zone, 5 m fire lanes on two adjacent sides of each tower, and an entry gate.
6. **Parking.** Required cars from Table 9, plus 15% visitors, at 30 m² gross per car (assumption). Place it in podium or basement levels under the footprint and podium, and check the ramps.
7. **Checks:**
   - FSI and coverage;
   - Rule 43 recreation;
   - lifts per Rule 40;
   - high-rise rules;
   - the AAI cap if the user enters one.
8. Score and keep the **best 3**.

### 6.3 Other uses (v1: parcel-level blocks)

School, club, commercial, hotel, business hub:

- place a massing block at the Table 6 coverage and FSI inside the Table 4 yards;
- compute parking and access widths.

School siting: a 3.0 ac core campus inside the 6.0 ac developable area, inside the 10.3 ac zone. It needs its own gate on a public road and a slope of 8° or less.

## 7. Level 1 zoning

- **Load** the registered client zones; show `in_scope_ac` and `geometry_confidence`.
- **Edit.** The user can draw, split, merge and reassign uses. Siting hard constraints (PRD §5.2) veto invalid zones.
- **Loop.** Run the Level 2 generators per zone and compare yield with the programme. Resize or suggest (a) more towers, (b) denser plots, or (c) phasing into deferred land.
- **Siting score** per use (0–100): buildable area, earthwork, access and frontage, adjacency, view and elevation, drainage risk, phase order. Weights are editable.

## 8. App requirements

- **Views:**
  - 2D plan (parcel, deferred-land note, contours, slope and fall heatmaps, drainage, roads, zones, layouts);
  - 3D terrain + massing;
  - programme editor;
  - rules and assumptions editor (YAML-backed, editable in the UI, versioned per scenario);
  - compliance panel (pass/fail with clause references);
  - area statement.
- **Scenarios.** Save and load as JSON, with the full input snapshot.
- **Exports:**
  - DXF plan with layers per use / road / plot / open space / tower;
  - XLSX area statement (per plot, per tower, per zone, total: area, units, plinth, SBUA, UDS, FSI, coverage, parking, population);
  - PNG/PDF sheets;
  - GLB massing;
  - a cashflow-shaped XLSX of programme lines.
- **Performance:** regenerating one zone takes under 10 s (run the engines in Web Workers).
- **No backend in v1.** All data is static under `public/data`.

## 9. Recommended stack

- Vite + React + TypeScript (strict), Zustand for state, Tailwind for UI.
- **2D:** Canvas or SVG with a local-metre orthographic view (deck.gl `OrthographicView` or react-konva). No web-mercator map is needed.
- **3D:** three.js via @react-three/fiber and drei. Build the terrain mesh from `dem_2m.f32`.
- **Geometry (planar metres):** `clipper2-js` for offsets and booleans; `jsts` or `@turf/boolean-*` for predicates on local coordinates (turf's planar functions only).
- **Files:** `yaml` for config, SheetJS (`xlsx`) for Excel, `@tarikjabiri/dxf` (or equivalent) for DXF export.
- **Tests:** Vitest for engines against `tests/expected_values.yaml`; Playwright smoke test optional.
- **Preprocessing** stays in Python (`tools/preprocess`). The app never reads DWG.

## 10. Milestones

| # | Milestone | Scope | Done when |
| --- | --- | --- | --- |
| M1 | Scaffold + site model | App shell, data loading, 2D plan, layers, DEM, slope/fall maps, site stats | Golden site and terrain values pass |
| M2 | Rule engines | KMBR + client rules + programme sizing, SBUA, parking, yards, access | Golden kmbr / commercial / apartments / villa values pass; conflicts listed |
| M3 | Villa generator | §6.1 on PROJECT - 2 (7.77 ac), then any villa or senior zone | 3 options, each within ±2 pts of 20/30/50, all plots ≥ minimum, report complete |
| M4 | Tower generator | §6.2 on APARTMENTS zone and a user-drawn 10.8 ac zone | 3 options at 12 / 15 / 20 floors; ≥12 m spacing or legal joins; checks pass |
| M5 | Level 1 loop + scenarios | Zone editing, other uses, loop, shortfall report, save/load | Whole-site scenario runs end to end |
| M6 | Exports + 3D | DXF, XLSX, PNG/PDF, GLB, 3D view | Files open cleanly in AutoCAD, Excel and Rhino |

## 11. Open items (implement as switches with the listed default)

| Item | Default |
| --- | --- |
| Core / flats split | 20 / 80 |
| 18 m minimum applies to | long side (alternative: both sides) |
| KMBR front yard vs client 2.0 m | show both; compliance uses KMBR |
| FSI tier for apartments | 3 (alternatives: 4, 6) |
| Sprinklered towers | true |
| AAI height cap, TBM MSL offset | unset |
