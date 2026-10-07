# Client decision log

## 15 Sep 2026 — client email
1. Proceed with the available site area and levels ("Site Area and Survey Levels – 15-09-2026"). Use Google Earth for the clouded (unsurveyed) areas; corrections later after physical survey.
2. The 26.4 ac balance area is outside the current survey — leave it out of scope until further advice.
3. "Zoning Plan" CAD = the drawing discussed at the office.
4. "Existing Roads" — blue lines are roads to be retained at 10 m width.
5. No existing structures/properties to retain.
6. Treat all land as one contiguous consolidated parcel.
7. "Level Datum – TBM" is the level reference.
8. Regulations: KMBR 2019 (amended to 17.01.2023) + LSGD KMBR Amendment 2025 (29.10.2025).
9. Villas SBUA = plinth + 150 sft amenity share; apartments SBUA = plinth + 22% + 8% amenities (~150 sft); UDS: recreation 4–10%, roads ~10%.
10. Stage payment plans referenced (not received).

## 17 Sep 2026 — answers to PRD questions
- KMBR is the rulebook (not KPBR).
- Hotel and business hub: add using educated assumptions → 120 keys / 120,000 sft; 100,000 sft offices.
- School: 3.0 ac core campus, 6.0 ac developable (school + support amenity + infra), 10.3 ac total zone — all valid.
- Hospital: wait for the deferred land.
- Population: 4,000 current target; ~6,300 final capacity.
- Zoning Plan: starting point only; zoning must follow project parameters. **Main priority is the plan inside each zone** (villa placement, internal roads, apartment sizing, FSI use, min/max footprints, placement, circulation).
- TBM MSL value, AAI height, Zoning Plan PDF, stage payment plans: not available.
- Villa approval route (subdivision vs group housing): not a concern for now.
- Apartment unit mix: yes — bands 2/3/4/5 BHK as below.
- Tower height: 20 floors / 70 m.
- Cashflow per-unit areas are plinth areas.
- Senior living: villa-style plots.
- Sizing method (client):
  - Villa & senior: 20% roads / 30% open / 50% saleable; plot area = saleable ÷ units; ratio 1:1 to 1:2.5; min plot side 18 **m** (applies to the plot, not the villa; plots are made first).
  - If unit plot is ~63 m² → row housing → plots ~2× (126 m²).
  - Villa footprint for now: 1:2.5 rectangle, 45% of plot area.
  - Plot sizes for standard + premium villa types come from 20/30/50 (confirmed).
  - Apartments: 30–50% of land buildable; floor area = land × FSI; max 20 floors / 70 m; footprint = floor area ÷ 20; 20% core; flats in bands (PLINTH): 2BHK 900–1200, 3BHK 1200–1800, 4BHK 1800–2400, 5BHK 2400–3000 sft; mixes 2+3, 3+4, 4+5 or single; 4–6 flats per floor → number of towers; towers as far apart as possible, ≥12 m; if site too small, may join at 0 m only on short sides or in L, joined building within site offset 6 m inward.
- Platform: **web app**, built in Claude Code from this package.

## Interpretations made by Claude (confirm when convenient)
- "Remaining 20%" read as 80% of footprint for flats (core 20%).
- 18 m minimum read as the plot's long side (from the 126 m² example); a both-sides reading gives a 324 m² minimum plot.
- Apartment SBUA = plinth × 1.22 × 1.08.

### Added while building the app (17 Sep 2026)
Each of these is a switch or an editable assumption, not a silent decision.

1. **Minimum plot area carries the aspect tolerance.** The client's own worked
   example (63 m² per unit → ~126 m² row-housing plots) sits just under the
   129.6 m² that 18 m at 1:2.5 gives, at 1:2.56. The 3% tolerance the client
   states for the aspect ratio is therefore applied to the minimum plot area as
   well, or their example would be rejected by their own rule.
2. **Plot dimensions.** Under the long-side reading the long side is held at the
   18 m minimum until the plot is big enough that the short side would exceed
   it, after which the rectangle simply grows. This reproduces the golden
   dimensions exactly and stays continuous for larger plots.
3. **Cross roads inside villa zones.** Double-loaded strips at 2 × depth + road
   width give a road share of about 14%, not the 20% the client budgets. The
   generator adds cross roads to make up the difference, which also gives every
   strip a second connection. The residual difference is reported.
4. **Tower footprint at fewer than 20 floors.** The client's rule divides the
   floor area by the literal 20 of their floor cap. A scheme actually built at
   12 or 15 floors needs the footprint divided by the floors it has, or a third
   of the FSI goes unused. The 20-floor case is unchanged, so the golden values
   still hold.
5. **Tower count rounding.** `towers = ceil(footprint / plate)` would put more
   floor area on the site than the FSI allows. The footprint is spread evenly
   over that many towers instead, so the FSI lands exactly on the chosen tier
   and every tower is the same size. The client's plate is reported as the
   maximum.
6. **Spacing has no middle ground.** The client says never less than 12 m, and a
   0 m join only where the zone is too small. A 7 m gap satisfies neither rule
   and breaches the KMBR 5 m minimum, so the generator either keeps 12 m or
   joins short side to short side; a join is never allowed to crowd a third
   tower, and every join is flagged.
7. **Plate depth.** KMBR Rule 41 puts habitable space within 7.5 m of an
   opening. A double-loaded plate can therefore be twice that plus the corridor,
   which is not habitable. **New assumption: `corridor_width_m: 2.0`.**
8. **Where a zone cannot hold its programme line**, the tool places what fits and
   reports the shortfall (towers short, sft short, units short) rather than
   drawing something illegal or returning nothing.
9. **Difficult ground is a warning, never a compliance failure.** No rule is
   breached by a steep plot; the cost is reported through the fall classes, cut,
   fill and retaining face.
10. **Buildable ground is tested on a 2 m raster eroded by one cell**, so a plot
    or tower cannot overhang the zone boundary or a Rule 22 face by a
    rasterisation sliver.

### Added while building the siting engine (18 Sep 2026)

11. **An untestable constraint is reported, never passed.** Four PRD constraints
    cannot be judged from the data held — the step-free senior route, the AAI
    height limit, the hospital's ambulance entry, the STP's true low point. They
    are carried through as `unevaluable` and printed in every rationale card. A
    veto engine that quietly waves through what it cannot measure is worse than
    no veto engine.
12. **Allocation is score tempered by need and fit, not score alone.** Greedy
    allocation on score gave villas everything and left apartments, school and
    commercial with no land at all. The score is multiplied by how much land the
    use still needs and how well the zone fits it, and a use with nothing yet
    gets a 1.6× boost. **New file: `config/siting_rules.yaml`**, weights editable
    in the UI.
13. **A use can score higher and still lose**, because it needed less land or
    fitted the zone worse. Both the score and the deciding priority are reported
    on the allocation and on its runner-up, so the reversal is explained rather
    than hidden.
14. **Zones are allocated whole.** The client's zones are the unit of siting;
    surplus land in an oversized zone is reported, not silently split. Splitting
    is zone editing (Phase 8).
15. **Deferred lines never compete for in-scope land.** The hospital is pinned to
    its reserved zone by name match and removed from the demand the in-scope
    zones are scored against.
16. **Where the zoning itself cannot serve the programme, say so.** The 13 zones
    total 69.86 of 73.54 ac and the two smallest are 1.51 and 0.42 ac, while four
    uses need 1.5–4 ac each. That is a structural limit of the client's zoning
    plan, not an engine failure, and is reported as a structural note on the
    alternative.
17. **Adjacency is a straight-line distance with a detour factor**
    (`walk_detour_factor: 1.35`), not a routed walk. The PRD's 300 m
    senior–hospital rule is scored on that basis and the approximation is stated.

### Added while building the master plan (18 Sep 2026)

18. **Circulation is laid before the zones, not after.** The 18 m spine drawn
    after the plots ran straight through them. The roads between the zones are
    generated first and handed to every zone generator as no-go ground.
19. **A collector's width is the KMBR access width its zone's occupancy
    requires.** The client's road table fixes the spine at 18 m and the retained
    public roads at 10 m but names no collector tier, and a width invented here
    would be a magic number. The Table 7/8 access width is a rule and is
    traceable.
20. **Collectors are routed on terrain, not drawn straight.** The step cost is
    the step length plus a penalty on the climb, so a collector contours around
    a slope the way a built road would; Rule 22 ground is impassable. **New
    assumption: `route_grade_penalty_m: 12`.** A traced collector becomes a
    source for the next zone, so the network branches.
21. **The spine's alignment is the client's, its position is ours.** The rule
    gives north–south with zero angular tolerance, so the only free choice is
    the easting; it is placed where the longest usable north–south run serves
    the most zone land. A notch in the boundary up to 40 m is bridged, because
    a road bridges a notch; a longer gap ends the line.
22. **A block use is a campus, not a slab.** School, club, hotel, commercial and
    business hub are laid as bars whose depth is Rule 41 daylight on both sides
    plus the corridor, whose length is twice the Rule 36 travel distance (a bar
    with a stair at each end), and whose spacing is the Rule 26 gap. Every
    dimension is read from a rule rather than chosen.
23. **A campus is checked as a whole, and its worst bar decides its terrain.**
    Coverage, FSI and yield are summed over the campus; the hardest block sets
    the fall finding, because a campus is only as buildable as its worst piece.
24. **A use spread over several zones splits its programme by area.** Two villa
    zones of 9 and 5 acres carry the unit counts their land supports, rather than
    each trying to hold the whole programme line.

### Added while closing the gaps against the documentation (18 Sep 2026)

25. **The client's three villa rules cannot all hold.** The 20/30/50 land split,
    20 units per acre (cashflow C17) and a 1,750–2,000 sft villa are stated
    independently and never checked against each other. At the client's own 45%
    footprint placeholder each dwelling gets 491 sft of footprint, so a 2,000 sft
    villa needs 4.1 floors, and at G+1 it needs 92% of the plot covered against
    the KMBR A1 limit of 65%. The tool reports this as a failure with the
    arithmetic rather than drawing the placeholder and reporting success. Which
    of the three moves is the client's call. **New assumption: `villa_floors: 2`**
    (G+1, PRD §5A.2), which is what makes the delivered plinth computable.
26. **A premium corner plot grows to the widest the client's own aspect band
    allows**, not to an invented factor. The band's minimum of 1:1 is the
    ceiling; the ground, the cross roads and the neighbouring columns are the
    limits.
27. **Where the client and KMBR both set a recreation minimum width, the
    stricter applies**, which is the project's standing rule and was not being
    followed: the KMBR figure was used and the client's ignored.
28. **A stub road may not be laid over a plot.** The road network is not
    completed by driving over a villa. Where the only line to the network would
    take one, no stub is laid and the zone is reported as unreached.
29. **Unsurveyed ground carries no road gradient.** A NaN sample is counted and
    reported, never treated as level: a road over unsurveyed land reporting 0%
    would be the worst kind of false pass.
30. **A zone edit is an operation, not edited geometry.** Edits replay on the
    client's zoning plan every run, so the worker and the main thread cannot
    disagree about what the plan is now, and any edit can be undone singly. A
    piece under 200 m² is a sliver from a bad cut, not a parcel.

### Added while building the super goal (18 Sep 2026)

31. **Three objectives, one engine.** Space, terrain and water are not modes.
    Every place the engine chooses — which use goes in which zone, which road
    grid to lay, where to route a collector, whether ground is buildable —
    derives its weights from one normalised goal, so a slider re-aims the whole
    plan coherently instead of switching it. Setting an objective to zero never
    disables a rule; KMBR and the client rules still apply.
32. **Earthwork is one objective, not two.** Contour-parallel roads give flat
    streets and plots that run down the slope; fall-line roads give the
    opposite. Scored separately they split the terrain weight and fight, and the
    winning grid is an artefact of the split. Plot fall and street grade now go
    into one number, because what is being minimised is the total cut and fill.
33. **A score clipped at zero is no score.** Mean plot fall is over 3 m almost
    everywhere here, so `100 − fall/3 × 100` gave every candidate zero and the
    terrain objective could not tell them apart. The curves now fall away
    without saturating.
34. **Cut and fill cannot steer a search that has not placed anything yet.**
    They are only known once the plots exist, so a search scored on them scores
    every candidate the same. Earthwork is steered on mean plot fall and street
    grade, both of which are measurable in the pass that already visits every
    cell, and which the cut and fill follow from.
35. **Which plots to keep follows the goal.** When a grid offers more plots than
    the programme wants, space keeps the most complete, terrain the flattest,
    water the driest. Before, completeness decided it and the goal could pick a
    different grid but never a flatter plot within one.
36. **A local minimum is not a pond.** A 2 m survey has 465 of them and almost
    all are noise; treating each as standing water marked 58 of 73.5 ac as wet.
    Ponding is now measured by depression DEPTH from a priority flood — how far
    below its spill level the ground lies — which gives 1.35 ac.
    **New assumption: `ponding_depth_m: 0.25`.**
37. **A setback belongs to a watercourse, not to every rill.** Buffering each
    1,000 m² flow path by 33 m would take most of a hilly site out of use. The
    no-build buffer is measured from the major network only
    (**`major_upslope_cells: 2000`**); minor rills still count towards wetness,
    which is what scoring cares about.
38. **Water-led means water comes out first.** The buffer and the ponding ground
    are removed from the buildable area BEFORE anything is laid out, not drawn
    over the plan afterwards.

### Added while closing the survey holes (18 Sep 2026)

39. **The survey's holes are filled, and never silently.** 13.47 ac of the
    73.54 ac parcel — 275 separate holes, the largest 4.6 ac and 137 m across —
    carried no level, so the mesh broke and the 3D view showed an island. The
    measured DEM is left byte-identical; the filled surface is a companion that
    records per cell whether the level was surveyed, harvested or interpolated,
    and how far it sits from real data. Every figure that depends on ground
    level still reports it.
40. **Real data first.** 913 cells that the TIN never covered do have a spot
    level or a contour vertex on them. Those are measurements the DEM was
    throwing away; they are harvested before anything is interpolated, and they
    count as measured ground.
41. **Laplace on the residual over a fitted trend, not on the levels.** A plain
    Laplace membrane is right for a hole ringed by measured ground and wrong for
    one that runs out to the edge of the survey: with no boundary on the open
    side it goes flat, and it did — **12,126 cells of dead level ground at
    0.00°, against 12.09° in the measured terrain.** Each hole now gets a plane
    fitted by least squares to the ground around it, carrying the hillside's own
    slope across the gap, and the membrane solves only what is left over. Deep
    fill now reads 10.77°: gentler than measured, as an interpolation should be,
    but still a hillside.
42. **A plane needs more than three points.** Fewer than eight, or points lying
    on a line, fall back to a flat trend — a line of readings fixes no slope
    across itself and guessing one would be inventing terrain.
43. **Interpolated ground is shaded.** The 3D mesh tints each vertex by its
    distance from a real reading, so a continuous mesh cannot be mistaken for a
    complete survey.

## 25 Sep 2026 — owner, on the pipeline plan
- Follow the client's zoning plan; deviate only where hydrology or terrain require it, no major changes.
- All flooded land is open space; part of it can be the golf course, which belongs to the clubhouse; no golf on steep land.
- Small waterlogged fragments are ignored so the land round them joins into one usable piece.
- Specks of a few tens of cells over 45 degrees are ignored (buildable).
- One consolidated school campus; no road through it.
- Streets that serve nothing go; their land is green.
- Apartment towers must not stand behind one another; spread them over the zone, on the lower ground (airport limit).
- Plots on both sides of every road; two villa plot types: 2,500-3,000 sq ft (main) and 2,000-2,500 sq ft (fill-in).
- Place the commercial and convention zone and the batching plant.
- Water: report pond areas and depths, channel widths and depths, and the volumes, so they can be checked against each other.
- Apartments: 12 ac and 1,000 flats in three places: 3 towers in the client's apartment zone, 2 on 4.0 ac from Phase 2,
  1 on 2.7 ac from Phase 3; each tower a 16,500 sq ft block of 20 floors, 10 flats a floor (airport line permitting).
  FSI up to 4 is acceptable.
- Villas: 700 on 35 ac including Phase 2 and 3; the 11.09 ac above the villa zones' 23.91 ac is split equally between
  Phase 2 and 3, by an existing road with good views. The rest of each phase is to be decided with the client.
- Hotel and business hub: expected on the land not yet acquired, not in Phase 2 or 3.
- Villas sell on their views; towers must not block them. Owner's sketch: both Phase 2 towers at the west end of the
  phase's apartment land, one above the other; the lower one crosses the zone's edge onto unzoned ground (0.32 ac
  taken); the middle site, in front of the Phase 2 villas, is dropped. Elsewhere towers are scored on the share of the
  villas' view they hide (`apartments.villa_views`).

## 28 Sep 2026 — owner, on the villas
- The earlier count options (about 1,000-1,200 sq ft plots at FSI 1) were wrong: B follows the client's cashflow exactly
  (Outflow B9/B17, C9/C17, E9/E17): 700 villas on 35 ac, 2,000 sq ft BUA (Package 1's 60 at 1,750). Only the road
  layout changes between B1 and B2.
- The client's 50/30/20 villa land split is dropped: villa land is 80% plots and 20% roads, 5% either way.
- Gross FSI on the villa land stays at the client's 0.918 (E17/D17). Each type's BUA is fixed; its plot flexes within a
  range with the terrain, so the net FSI rises on a smaller plot and the gross holds.
- Plot ranges: B 1,500-1,750; A 2,250-2,600 (BUA 3,000, the cap); new category C with two types, 1,750-2,000
  (BUA 2,300) and 2,000-2,250 (BUA 2,600), placed by terrain and sales, no fixed share. C carries the client's premium
  segment, which the earlier options did not.
- Package 1 sits in the zoning plan's Project 1 (the zoning plan names no packages).
- The house (owner's sketch): rear setback 1.5 m fixed; sides at least 1.5 m; the rest in front is garden; ground
  floor 0.65 of the plot, first floor 0.5, set on the back and both sides of the ground floor so it has a balcony in
  front; a bigger first floor grows toward the road. KMBR Table 4's front yard (3.0 m average) holds the garden's depth.
- Where G+1 inside those yards cannot reach the BUA (true of every B plot), a partial second floor, a room on the roof,
  takes the rest (option a); the first floor may be as big as the ground floor.
- Two more options, B3 and B4: B1/B2 hold the client's plot size, B3/B4 hold the client's 700 units. B3/B4 are the
  earlier count layouts (the largest plot that fits 700, narrow and deep) on the new house rules: the same BUA, reached
  with a second floor (G+2), a front garden, a first-floor balcony that the first floor can grow into; the owner's 1.5 m
  setbacks are set aside for these small plots and KMBR Table 4's yards govern (the small-plot row up to 125 m² of plot
  and 200 m² of BUA). Gross FSI stays at the client's (about 0.91 on 35 ac).
- The deck reports the client's cashflow numbers in every option (owner): villa land 35 ac and villa BUA 13,85,000 sq ft
  (Outflow E9 + E17), gross FSI 0.91; only the count and size of the villas change. Villa massing adds floors up to a
  full G+2 and stops there; shortfalls against the Excel are not shown (the massing is broad-brush).
- The south primary road follows the owner's sketch along the parcel's south edge (roads.owner_routes) instead of
  crossing the Phase 3 apartment zone: the zone was fixed, and with the road at its edge the Phase 3 tower fits in every
  option (A1 lost it before).

## 7 Oct 2026 · the owner's draft financial model becomes the basis

- The plan is drawn on the owner's "Draft model.xlsx" (planning_rules.yaml `options.basis: draft_model`): 73 ac,
  its 20 components (config/programme_draft_model.yaml, each figure cited to its Inputs cell), four phases. The client's
  cashflow V4 and zoning plan stay available as `options.basis: client`.
- A new zoning was drawn for it (tools/zoning/draft_model.py -> data/processed/zones_draft_model.geojson): one zone per
  component at the model's land, cut from the client's zones, none on waterlogged ground:
  - phases run outward from the main gate (north, on the Mangalapuram-Pothencode road);
  - the hospital (5 ac) stays on the site, on the main road on the highway side (NH66 is at Mangalapuram, ~3 km
    south-west): the north-west lobe; the office and the retail street are on the main road too;
  - apartment towers go where they hide the least of the villas' views (first-floor sight-lines from every villa,
    tools/zoning): the north-east corner, the east lobe and the south-west low ground.
- The client's 18 m N-S entry road from the main gate is an owner road on this basis, along the gate arm's west
  edge; the retail street is the strip east of it.
- Villas: the model's four plot types (1,800 / 2,250 / 2,500 / 2,800 sq ft; villas 2,000-2,700 sq ft) in its mix
  (20/40/30/10%), each villa zone at its component's count (48 / 80 / 96 / 96). Plots are the model's sizes, not ranges.
- The model sells 85% of the villa land as plots (Inputs C41). The test fits plot about 50-60% of it (188 and 222 of
  320 villas): roads, slope and the zones' shapes take the rest. Either the villa land or the count needs revisiting
  in the model.
- Hospital, retail and office are blocks to their construction area, coverage from KMBR Table 6 (C, F, E). Floors
  are assumptions (hospital up to 8, retail up to G+4 on its narrow strip, office up to 12). A senior zone that holds
  too few G+3 blocks lets them rise to G+5 (ASSUMPTION).

## 7 Oct 2026 · villas toward the model's 85% (owner: "if the model assumes 85% then it has to be 85%")

- Plots stay rectangles; at the ends and edges of rows a plot may be four-sided (owner 7 Oct). Every plot is checked
  to be a true quadrilateral (convex, each side at least 1 m) and within 0.84-2.0 x its type's area.
- One street grid runs across villa zones that touch (each plot belongs to the zone it stands in), turned every
  degree within 30 degrees of the contours (D1) or within the Vastu tolerance (D2, and only among the directions
  whose streets climb no more than a quarter over the gentlest: an east-west street up the hill cut 20,000 m3).
- Plot fronts sit on the road edge; back-to-back rows meet; plots may front the site's existing roads at their
  edge (these come as road edges, not centrelines); a plot whose back meets a slanting edge takes the wedge.
- Zoning (owner chose "square up the villa zones"): Phase 1 villas are one block, the north corner of Project 2 with
  the top-west of Project 3, instead of a ragged strip north of the existing road (now open space by the pond);
  the line between Phases 1 and 2 is set so Phase 3 keeps its 5.982 ac. The entry road ends on the existing road
  instead of running into the Phase 2 villas.
- Result: plots on 78% (D1, 285 villas) and 79% (D2, 286 villas) of the villa land; streets 12-13%, trunk roads 1-2%.
  The remaining 7-8% is fixed geometry: the existing road and the out-of-scope strip run diagonally along Phases
  1, 3 and 4, a Rule 22 slope sits in Phase 3, and trunk roads to the school and the east apartments cross Phase 4.

## 7 Oct 2026 · road strips at their full width

- `bufferPolyline(line, width)` (app/src/engine/geom/offset.ts) returned a strip half as wide as asked: Clipper2
  halves the delta for open paths and the function also passed width / 2. It now gives the full width, and the
  plan's `stripAlong` (the earlier workaround) is folded into it. Centreline callers now draw their roads at full
  width: the tower access road, the villa generator's streets and cross roads, the masterplan spine and zone access
  roads, and the junction stubs.
- The site's existing roads come as their surveyed edges (SPEC: "these are road edges"), about 6 m apart, kept
  and widened to 10 m. Buffering each edge by the full width would claim 5 m beyond each edge (a 16 m road), so
  they go through `roadFromEdge`, which keeps their geometry as it was: a quarter of the width either side of
  each edge, about 11 m in all (analysis existing-roads layer, plan existing-roads raster, masterplan public roads).
- What moved: the masterplan's road area 41,360 -> 47,931 m2 and villa plots 346 -> 342 (wider junction stubs and
  access roads take four plots); the tower generator's access road area rises (P-2 apartments, 7 towers: 3,112 ->
  3,773 m2). The villa generator's road area was already measured from its raster at full width, so its figures
  do not change; only its drawn road shapes do. The draft-model D1/D2 plans already used full-width roads and do
  not change. Golden values in tests/expected_values.yaml are unaffected.

## 7 Oct 2026 · villas settle at about 81% of the villa land; apartments report the model's units

- Owner: "80-81% is workable". Plots cover 80.7% (D1, 290 villas) and 81.3% (D2, 289 villas) of the villa land.
- Trunk roads keep out of the villa zones (draft basis `roads.zone_interior_cost` villas 400): the road to the
  Phase 3 apartments no longer crosses the Phase 4 villas. Apartment zones are costed like the other built uses (25)
  so a villa link does not cut a tower's zone in two.
- A plot over a zone's count is shared by its row neighbours (they widen, still rectangles) instead of being left
  empty. A villa street runs on into land that tapers while one side still holds a shallow plot.
- Where a row meets the fixed edge of the land, a pocket no plot took joins the plot beside it if the two make one
  convex plot of four or five sides within the growth limit (owner: five sides allowed there).
- A row-end plot's house sits in its widest rectangle; where even that cannot reach its villa's BUA, the plot takes
  the largest villa of the mix its house can hold. 1-2 nearly triangular plots per option remain short.
- Apartments (owner): the airport limit on the towers is not the plan's to fix, so the apartment lines report the
  model's units (935) as met; the massing shows the towers held under the 140 m AMSL limit. The web app's
  metrics panel shows the plan's own figures on this basis (flats, villa land in plots, land by use from the
  draft zones) instead of the earlier engine's client-programme figures.
- Fixed: plots could overlap (about 1,200-2,000 m2 in all, D1/D2). The plots' overlap test took a repeated corner
  as an edge and found a false gap, so a slanted back that kept one corner could run into the plot behind it; and
  the pocket pass took only its own zone's plots off, though one grid runs across zones. Both fixed; the plot index
  also files a long plot under every cell it covers. The plots' reported share now matches their drawn land:
  80.8% (D1) and 81.4% (D2). The test checks that no two plots overlap.
