# Planning pipeline (owner workflow, 2026-09-24)

Every planning decision is generated from the layer of analysis before it, never
placed by hand first and justified afterwards. This replaces the zone-first flow
(client zoning plan → siting → per-zone layouts) as the primary path. The old flow
stays available for comparison until it is retired.

Rules: `config/planning_rules.yaml` overrides `config/client_rules.yaml` where the two
speak to the same thing; everything else in the client rules stands, and KMBR is
checked on top.

| Step | Layer | Rule | Status |
|---|---|---|---|
| 1 | Terrain | the 2 m DEM from `data/processed/terrain_mesh.obj`; modelled ground (no survey point within 5 m) flagged | built |
| 2 | Hydrology | 300 mm / 24 h planning storm, fill-and-spill + peak flow (`engine/terrain/hydrology.ts`) | built |
| 3 | Waterlogging + safe zones | under ≥ 0.05 m of water at the storm's peak; the rest is safe | built |
| 4 | Public space | waterlogging + non-buildable slope + land too narrow to plot | built |
| 5 | Slope | per cell against the 1:5 plot limit and the Rule 22 45° limit | built |
| 6 | Non-buildable | KMBR Rule 22(3): slope over 45°, flood-liable land; 22(4): natural drains kept clear. (Owner 1:4 limit suspended 24 Sep, switchable in planning_rules.yaml) | built |
| 7 | Plotable zones | safe, not Rule 22 ground, clear of drains, off the existing roads, reachable by a 15 m plot | built |
| 8 | Roads | existing roads fixed; new roads primary 1:8, secondary 1:7, tertiary 1:6 | next |
| 9 | Plot subdivision | villa plots 2,700–3,000 sq ft (= built area, FSI 1.0), side ≥ 15 m, 1:1–1:2.5 | next |
| 10 | Plot slope | ≤ 1:5 per plot | next |
| 11 | Cut and fill | the least that brings each plot and road within limits | next |
| 12 | Typologies | senior living, villas, apartments, clubhouse, school | next |
| 13 | FSI + footprints | villas G 60% + F 40% of plot; senior G+3 min; apartments FSI ≤ 3.0 | next |
| 14 | Placement | senior buildings 12 m apart; setbacks and access checked | next |
| 15–16 | 3D and masterplan | every layer distinguishable from the building masses | layers 1–7 built |

Code: `app/src/engine/pipeline/` (grid masks in `mask.ts`, steps in `analysis.ts`),
panel `app/src/ui/PlanningPanel.tsx`, tests `app/src/engine/__tests__/pipeline.test.ts`.
