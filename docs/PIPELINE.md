# Planning pipeline (owner workflow, 24-25 Sep 2026)

The analysis layers are worked out from the terrain up; the plan is then laid
**inside the client's zoning plan** (owner, 25 Sep): every use stays in the zone the
client drew for it, and the plan departs from a zone only where the water or the
terrain makes it, and then only to hand that ground to open space. The earlier
zone-by-zone engine stays available for comparison until it is retired.

Rules: `config/planning_rules.yaml` overrides `config/client_rules.yaml` where the two
speak to the same thing; everything else in the client rules stands, and KMBR is
checked on top. Values marked DEFAULT / ASSUMPTION / ESTIMATE there await the owner.

| Step | Layer | Rule | Status |
|---|---|---|---|
| 1 | Terrain | the 2 m DEM from `data/processed/terrain_mesh.obj`; modelled ground (no survey point within 5 m) flagged | built |
| 2 | Hydrology | 300 mm / 24 h planning storm, fill-and-spill + peak flow (`engine/terrain/hydrology.ts`), with a water balance: rain = loss + held + outflow, and the water at the peak by pond and by channel (area x mean depth = volume) | built |
| 3 | Waterlogging + safe zones | under ≥ 0.05 m of water at the storm's peak; channels narrower than 6 m (to the storm drains) and patches under 1,000 m² ignored so the land round them joins up (owner 25 Sep); the rest is safe | built |
| 4 | Public space | waterlogging + non-buildable slope + natural drains + land too narrow to plot | built |
| 5 | Slope | per cell against the 1:5 plot limit and the Rule 22 45° limit | built |
| 6 | Non-buildable | KMBR Rule 22(3): slope over 45° on the mesh or the raw survey TIN, less specks under 200 m² (owner 25 Sep: mesh noise, taken by plot cut and fill); flood-liable land; 22(4): natural drains kept clear | built |
| 7 | Plotable zones | safe, not Rule 22 ground, clear of drains, off the existing roads, reachable by a 15 m plot | built |
| 0 | Zones | the client's zoning plan (`zones_client_registered.geojson`) gives each zone its use (`zoning.uses`); PHASE 2 and 3 give land to apartments and villas, the rest to be decided (owner 25 Sep); the hospital zone is reserved; waterlogged, Rule 22 and drain ground in a zone goes to open space | built |
| 8 | Roads | existing roads fixed and checked against 1:8; primary roads (1:8) join every zone's buildable land to the network, preferring the gaps and edges between zones and kept out of the school, clubhouse and senior campuses; in the villa zones, streets along the contours at the spacing that fits the most plots (tertiary, 1:6) and cross streets every 8 plots (secondary, 1:7, left out over 30 m³/m of grading); drives to every building; roads that serve nothing are taken out and their land is green | built |
| 9 | Plot subdivision | villa plots on both sides of every road through villa land, sized by the option's villa category (below): about 1.5 deep per 1 wide, the shape with the most ground floor inside the yards; a shallower plot where the land runs out, down to the range's smallest | built |
| 10 | Plot slope | every plot's ground fitted with a plane; checked against 1:5 | built |
| 11 | Cut and fill | each plot's platform held to 1:5, balanced; level pads for senior, school, clubhouse, commercial and the batching plant; road profiles | built |
| 12 | Typologies | from the client zoning; golf (part of the clubhouse) on open ground no steeper than 1:8 in and within 50 m of the clubhouse zone, waterlogged land included | built |
| 13 | FSI + footprints | villas to the owner's sketch (28 Sep): a fixed BUA per category, ground floor up to 65%, first floor on its back and sides, a roof room for the rest; senior G+3, 6 units a floor; apartments ≤ FSI 3.0 on their zone, 4 flats a floor, ≤ 20 floors; school, clubhouse and commercial as wings at KMBR Table 6 coverage; the convention hall on its own or on a commercial block's ground floor | built |
| 14 | Placement | school, clubhouse, senior, commercial as one compact group each in their zone; towers on the lower ground, spread, staggered for views (within 100 m up or down the slope no tower hides over a third of another), 12 m apart, podiums following the ground, every top under the airport limit (140 m AMSL, AAI CCZM grid C9) | built |
| 15-16 | 3D and masterplan | terrain, hydrology, zones, blocks by use, roads by tier, plot outlines and cut/fill draped on the ground; villas, senior, towers on podiums, school, clubhouse, commercial and the batching plant as masses; the GLB export carries the same | built |

## Presentation mode (owner, 26 Sep)
**▶ Present** in the top bar reveals the pipeline one step at a time, in 3D (or 2D), each step adding
to the last: terrain, the planning storm, waterlogging, public space, slope, non-buildable land,
plotable land, the client's zoning, roads, then the villa plots, where the plan forks into the four
master plans (A1-B2, pick any; 1-4 on the keyboard). After that: cut and fill, uses and golf, the
towers, the other buildings, the villas in 3D, the full master plan. Next / Back, the arrow keys,
Page Up / Down (a clicker) or the space bar step; Esc ends and restores the screen. The four plans
are worked out in background workers as soon as presenting starts (the two sized to the count
take about a minute). Code: `state/presentStore.ts` (the steps), `ui/PresentBar.tsx`.
A hosted copy (`npm run build:deploy`) ships the four plans ready-made in `dist/data/plans`
(`scripts/present-plans.mjs`), each with a fingerprint of the rules and site files it was planned on;
the app uses one only when the fingerprint matches and no rule has been overridden, otherwise it plans
live (in a worker, or on the page where the host blocks workers).

## Master-plan options (owner, 25 and 28 Sep)
Two switches in `config/planning_rules.yaml` `options`, eight plans (`villas.categories`):

| Villa category (`villa_sizing`) | Plot, sq ft | BUA, sq ft (fixed) | Target | 1: roads to the ground | 2: north-south roads |
|---|---|---|---|---|---|
| A | 2,250-2,600 | 3,000 | the count the gross FSI allows | A1 | A2 |
| B (the client's plot size held) | 1,500-1,750 | 2,000; Package 1's 60 in Project 1 at 1,750 | 700 villas, 20 an acre | B1 | B2 |
| B_count (the client's 700 units held) | the largest that fits 700, in 860-1,750 (narrow, deep) | as B, G+2 where G+1 cannot hold it | 700 villas | B3 | B4 |
| C | standard 1,750-2,000 / premium 2,000-2,250 | 2,300 / 2,600 | the gross FSI's BUA | C1 | C2 |

Owner, 28 Sep: gross FSI 0.918 on the villa land (the client's E17/D17); plots 80% of the villa land and
roads 20%, 5% either way (reported, replacing the client's 50/30/20); the BUA stays fixed while the plot
flexes in its range with the terrain, so the net FSI rises on a smaller plot and the gross holds. The
plots are cut as large as the range allows while the target is still met (`runPlanSized`); C's premium
plots go in the premium zone or where the outlook is open, plot by plot. The house (owner's sketch): rear
1.5 m, sides at least 1.5 m, a front garden of at least KMBR Table 4's front yard (3.0 m), the ground
floor up to 65% of the plot, the first floor on its back and both sides with a balcony in front, and
what G+1 cannot hold in a room on the roof at the back (option a).

Shared by all six (owner, 25 Sep, revised):
- Apartments: six 16,500 sq ft towers, 1,000 flats shared equally (up to 20 floors, under the airport line):
  3 in the client's apartment zone (5.3 ac in the site), 2 on 4.0 ac and 1 on 2.7 ac carved from Phase 2
  and Phase 3 on their lower ground (programme 12 ac less 5.3). FSI up to 4 is acceptable.
  Each tower 20 floors x 10 flats. Phase 2's two towers stand on the owner's sites at the phase's west end
  (`apartments.tower_sites`), clear of the Phase 2 villas' outlook; the rest are scored on the share of the
  villas' view they hide (`apartments.villa_views`: first-floor lookouts every 10 m, 300 m out).
- Villas: the programme's 35 ac less the villa zones' 23.91 ac, split equally between Phase 2 and 3, by an
  existing road with the best outlook; option B sizes 700 villas to that land.
- The clubhouse zone's dry side, across the existing road, is senior living; the client's senior zone,
  all of it, joins the clubhouse as clubhouse, golf and public space.
- What is left of Phase 2 and 3 is to be decided with the client.

The web app's plan panel switches between the four options (the count options take about a minute).

## The basis: whose programme, on whose zoning (owner, 7 Oct)

`options.basis` in planning_rules.yaml picks what the plan is drawn on. `draft_model` (the default since 7 Oct):
the owner's draft financial model (config/programme_draft_model.yaml) on the zoning drawn for it
(data/processed/zones_draft_model.geojson, made by tools/zoning/draft_model.py from the analysis layers that
`node app/scripts/export-layers.mjs` writes), with the rules under `bases.draft_model` replacing the client-basis
values. Each draft zone carries its use, phase and component; the plan builds each zone to its own programme line and
reports one row per component. `client`: the client's cashflow V4 on the client's zoning plan (options A1-C2).
The app's options are D1 (roads to the ground) and D2 (north-south roads) on the draft model.

## What the plan does not do yet
- The hotel and the business hub have no zone in the client's zoning plan and are not placed.
- The airport limit uses an estimated TBM level (70.6 m AMSL from SRTM, about ±10 m) until the
  surveyor gives its MSL value; an AAI NOC is needed regardless.
- Cross streets are straight lines at a fixed angle per piece of land; one too costly to
  grade is left out (switchbacks could bring some back).
- Plots are rectangles along the roads; odd corners go to green rather than bespoke shapes.
- Setbacks are a flat inset (3 m, 6 m for towers); height-driven KMBR yards above 10 m and
  KMBR Rule 24(1) (height against street width) are listed, not yet applied.

Code: `app/src/engine/pipeline/` (grid masks in `mask.ts`, steps 1-7 in
`analysis.ts`, routing in `route.ts`, the plan in `plan.ts`), run in the web worker
(`runGeneration.ts` job `pipeline`); UI `app/src/ui/PlanningPanel.tsx`,
`WaterBalancePanel.tsx` and `PipelinePlanSection.tsx`; tests `pipeline.test.ts` and
`plan.test.ts`.
