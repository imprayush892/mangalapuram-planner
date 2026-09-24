# Planning pipeline (owner workflow, 2026-09-24)

Every planning decision is generated from the layer of analysis before it, never
placed by hand first and justified afterwards. This replaces the zone-first flow
(client zoning plan → siting → per-zone layouts) as the primary path. The old flow
stays available for comparison until it is retired.

Rules: `config/planning_rules.yaml` overrides `config/client_rules.yaml` where the two
speak to the same thing; everything else in the client rules stands, and KMBR is
checked on top. Values marked DEFAULT / ASSUMPTION there await the owner.

| Step | Layer | Rule | Status |
|---|---|---|---|
| 1 | Terrain | the 2 m DEM from `data/processed/terrain_mesh.obj`; modelled ground (no survey point within 5 m) flagged | built |
| 2 | Hydrology | 300 mm / 24 h planning storm, fill-and-spill + peak flow (`engine/terrain/hydrology.ts`) | built |
| 3 | Waterlogging + safe zones | under ≥ 0.05 m of water at the storm's peak; the rest is safe | built |
| 4 | Public space | waterlogging + non-buildable slope + natural drains + land too narrow to plot | built |
| 5 | Slope | per cell against the 1:5 plot limit and the Rule 22 45° limit | built |
| 6 | Non-buildable | KMBR Rule 22(3): slope over 45° on the mesh or the raw survey TIN, flood-liable land; 22(4): natural drains kept clear. (Owner 1:4 limit suspended 24 Sep, switchable in planning_rules.yaml) | built |
| 7 | Plotable zones | safe, not Rule 22 ground, clear of drains, off the existing roads, reachable by a 15 m plot | built |
| 8 | Roads | existing roads fixed and checked against 1:8; primary roads (1:8) join every plotable zone to the network by least-cost routes; in each zone a contour-aligned grid: villa streets along the contours (tertiary, 1:6) and cross streets every 8 plots (secondary, 1:7) climbing at the angle whose rise is the limit, left out where grading them would cost over 30 m³ a metre. A grade-limited profile gives each road its cut and fill | built |
| 12 | Typologies | grid blocks grouped and given a use in `typology_priority` order: school (gentlest block with primary frontage, grown to the campus), clubhouse (beside the largest public space, central), senior (gentle, near the clubhouse), apartments (undulating ground), villas (the rest). A group grows only until its buildings fit; blocks no building needs go back to the villas | built |
| 9 | Plot subdivision | villa plots 15 × 17.7 m = 2,850 sq ft (FSI 1.0: plot = built area) along the villa streets and the road frontage; side ≥ 15 m, aspect 1:1.2 | built |
| 10 | Plot slope | every plot's ground fitted with a plane; checked against 1:5 | built |
| 11 | Cut and fill | each plot's platform held to 1:5, balanced; level pads for senior, school and clubhouse; road profiles | built |
| 13 | FSI + footprints | villas G 60% + F 40% of the plot (the plot's shape scaled); senior G+3, 6 units a floor, worked back from the programme's units; apartments ≤ FSI 3.0 per parcel, 4 flats a floor, ≤ 20 floors; school and clubhouse as wings at KMBR Table 6 coverage | built |
| 14 | Placement | flattest ground first; senior 12 m apart; towers max(12 m, KMBR) apart on podiums that follow the ground (no platform cut) | built |
| 15–16 | 3D and masterplan | terrain (the delivered mesh), hydrology, zones, blocks by use, roads by tier, plot outlines and cut/fill draped on the ground; villas, senior, towers on podiums, school and clubhouse as masses; the GLB export carries the same | built |

Order note: step 12 (typology) is settled per block before step 9 cuts villa plots,
because a plot's size depends on what it is for.

## What the plan does not do yet
- Commercial, hotel, business hub and the (deferred) hospital are not placed.
- Cross streets are straight lines at a fixed angle per zone. One whose grading to
  1:7 would move more than `roads.cross_street_max_earthwork_m3_per_m` (30 m³/m) is
  left out and its blocks merge (5 streets, ~60,000 m³, on this site); switchback
  alignment could bring some of them back.
- Plot rows are cut on the grid only; odd corners of blocks go to open space rather
  than to bespoke plot shapes.
- Setbacks are checked as a flat inset (3 m, 6 m for towers); height-driven KMBR
  yards above 10 m are listed, not yet applied.

Code: `app/src/engine/pipeline/` (grid masks in `mask.ts`, steps 1–7 in
`analysis.ts`, routing in `route.ts`, steps 8–16 in `plan.ts`), run in the web worker
(`runGeneration.ts` job `pipeline`); UI `app/src/ui/PlanningPanel.tsx` and
`PipelinePlanSection.tsx`; tests `pipeline.test.ts` and `plan.test.ts`.
