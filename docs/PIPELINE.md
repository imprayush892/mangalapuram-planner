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
| 0 | Zones | the client's zoning plan (`zones_client_registered.geojson`) gives each zone its use (`zoning.uses`); PHASE 2 and 3 take villas (DEFAULT); the hospital zone is reserved; waterlogged, Rule 22 and drain ground in a zone goes to open space | built |
| 8 | Roads | existing roads fixed and checked against 1:8; primary roads (1:8) join every zone's buildable land to the network, preferring the gaps and edges between zones and kept out of the school, clubhouse and senior campuses; in the villa zones, streets along the contours at the spacing that fits the most plots (tertiary, 1:6) and cross streets every 8 plots (secondary, 1:7, left out over 30 m³/m of grading); drives to every building; roads that serve nothing are taken out and their land is green | built |
| 9 | Plot subdivision | villa plots on both sides of every road through villa land: standard 2,500-3,000 sq ft first (15 m wide), compact 2,000-2,500 where a standard one will not fit (15 x 15 m = 2,422 sq ft with the 15 m minimum side) | built |
| 10 | Plot slope | every plot's ground fitted with a plane; checked against 1:5 | built |
| 11 | Cut and fill | each plot's platform held to 1:5, balanced; level pads for senior, school, clubhouse, commercial and the batching plant; road profiles | built |
| 12 | Typologies | from the client zoning; golf (part of the clubhouse) on open ground no steeper than 1:8 in and within 50 m of the clubhouse zone, waterlogged land included | built |
| 13 | FSI + footprints | villas G 60% + F 40% of the plot; senior G+3, 6 units a floor; apartments ≤ FSI 3.0 on their zone, 4 flats a floor, ≤ 20 floors; school, clubhouse and commercial as wings at KMBR Table 6 coverage; the convention hall on its own or on a commercial block's ground floor | built |
| 14 | Placement | school, clubhouse, senior, commercial as one compact group each in their zone; towers on the lower ground, spread, staggered for views (within 100 m up or down the slope no tower hides over a third of another), 12 m apart, podiums following the ground, every top under the airport limit (140 m AMSL, AAI CCZM grid C9) | built |
| 15-16 | 3D and masterplan | terrain, hydrology, zones, blocks by use, roads by tier, plot outlines and cut/fill draped on the ground; villas, senior, towers on podiums, school, clubhouse, commercial and the batching plant as masses; the GLB export carries the same | built |

## Master-plan options (owner, 25 Sep)
Two switches in `config/planning_rules.yaml` `options`, four plans:

| | Roads to the ground (`road_orientation: terrain`) | North-south roads (`north_south`) |
|---|---|---|
| Plot rules (`villa_sizing: rules`) | A1: 2,500-3,000 + 2,000-2,500 sq ft plots, least cut and fill | A2: the same plots; primary and secondary within 10 deg of north-south, a cardinal grid |
| Plots to the count (`count`) | B1: the villa zones carry the programme's 20 an acre (23.91 ac, 478 villas); the plot is the largest that fits (`runPlanToCount`) | B2: the same count on a north-south grid |

Shared by all four: the client zoning with three owner moves (three of six 16,500 sq ft towers on the clubhouse zone's dry side across the existing road; the senior zone's flood land and leftover slivers to the clubhouse as golf and public space, senior living in one piece; Phase 2 and 3 held as future phases).

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
