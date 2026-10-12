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

## 7 Oct 2026 · no building, plot or road on another (owner: "why are these blocks overlapping")

- Hospital blocks (1,161 m2), retail blocks (348 m2) and two school wings (206 m2) overlapped: the clear-distance
  test between wings measured corner to edge, and two blocks crossing like a plus sign have no corner inside the
  other. It now also tests whether their edges cross.
- A trunk road was drawn across a tower 5.6 m from its centreline: the routed line turns in short steps and a mitred
  corner throws a spike up to the full width. The plan's roads are drawn with round joins (`roadStrip`), the same
  half-width test the clearances use.
- Drives to buildings ran into their walls and through other buildings and plots. A drive now ends half its width
  and a metre off the wall, goes round every other building and keeps its half width (plus 2 m for the straightened
  line) off the villa plots. One drive serves a campus (school, hospital, clubhouse, senior enclave), to its nearest
  wing; each apartment tower keeps its own. A building's wings stand on one piece of land, no road between them.
- D1 and D2: no two buildings or plots overlap and no road crosses a plot or a building (tested).

## 7 Oct 2026 · the model's 8.3 ac of open space placed: kept parks and a green chain in the villas

- The model gives open space as an area only (Inputs C38: 10% of the gross, the UDCPR minimum, + 1 ac = 8.3 ac).
  It is now designated in the zoning as `park` zones (tools/zoning/draft_model.py), counted on dry land; ponds and
  the ground the 300 mm storm floods stay open too but are not counted. KMBR Rule 31(v)-(vi): 10% of the layout,
  reached like a plot, no piece under 200 m2 or 6 m wide (the kept parks front the site's roads; the streets run
  through the pockets). The Rule asks for one piece "as far as possible"; here it is eight, by the owner's design.
- Owner: the open space south of Phase 4 becomes villa land (with the strip south of Phase 2), and the same area
  comes out of the villa land as green pockets, a chain from the west lake through the villas to the south pond.
  Kept: north pond 2.21 ac, gate west wing 0.79, north-west corner 0.77, south-east corner 0.60. Pockets (drawn
  14% larger for the villa streets through them): by the west lake 0.55, Phase 3's Rule 22 slope 0.30, Phase 4
  1.86, to the south pond 1.86. Open space net of roads: 8.27 ac (D1), 8.28 ac (D2). Villa land stays 19.94 ac
  (Phase 3 gives its 0.30 ac slope; Phase 4 takes it).
- Pockets are squared to north (both options' streets run N-S or E-W); plots the 2 m grid lets reach into a pocket
  are trimmed off its exact edge (or taken out where they cannot be).
- Cost: the pockets take flat villa land, the land gained is the south hillside: D1 284 villas (was 290), D2 279
  (was 289); plots 79.3% / 78.6% of the villa land.

## 7 Oct 2026 · open space on the land that sells least; the villas keep the land added (owner)

- Owner: "why will I not put villas there": the green pocket in the middle of Phase 4 sat on land with more outlook
  (0.54 of directions) than the phase's average (0.47). The view analysis (first-floor eye, ground 5 m below seen
  within 300 m, as for the towers) now picks where the open space goes: Phase 2's steep west edge (0.38), Phase 3's
  Rule 22 slope, and the low bowl by the south pond (0.22), with small parks on leftover land reached from a road
  (south-west corner, by the apartment clubhouse, the pond's bank). Pocket 3 in Phase 4 is villas again.
- The land added south of Phase 4 and Phase 2 stays villa land: 20.90 ac (model 19.94). Open space stays the
  model's 8.3 ac net of roads (D1 8.37, D2 8.31).
- The township's 320 villas: a phase whose land holds more than its count makes up those short (reported).
- Result: D1 306 villas, D2 303 (were 284, 279); plots 80% of the villa land.

## 8 Oct 2026 · hospital off this land, ponds counted, the roads the plan wants (owner)

- The hospital is built on the 26 ac deferred land, not in these 73 ac (programme_draft_model.yaml C06 `deferred`;
  the plan reports it as such). Its 5 ac lobe (the NW lobe on the main road) is Phase 2 villa land.
- Part of the ponds counts toward the 8.3 ac: a pond where a park gives it a landscaped edge (the north pond in its
  park, 0.86 ac; the south pond with a bank walk, 0.47 ac), off the owner's south road. The south pond's park is a
  bank walk on the Phase 4 villa land along the water (1.89 ac), sized so the open space is 8.3 ac net of the
  roads that cross it (D1 8.45, D2 8.44). The 3.1 ac pond park is otherwise villas.
- Roads are not the model's (its 12% + 2 ac): cross streets through the villa rows again, a block about 170 m long
  (every 16 plots, at least 120 m apart; every 8 plots cut the terrain option's rows into wedges, 312 villas, 66%
  plotted); trunk roads may cross a built zone where that is the better line (villas cost 25 to cross, parks 400).
  Two options as before: D1 to the ground, D2 north-south (Vastu).
- The villa land (27.1 ac) is filled: every villa it holds is laid (`villas.categories.MIX.fill`). D1 351 villas,
  D2 381 (model 320); plots 74% / 78% of the villa land. By phase, Phases 2 and 4 hold more than their counts and
  Phases 1 (45 / 47 of 48) and 3 (72 / 80 of 96) fewer. New roads 8.2 ac (11.2%) / 7.7 ac (10.5%).

## 8 Oct 2026 · D1's cross streets square to the rows, within the gradient rule (owner)

- Road gradient rule: primary 1:8, secondary 1:7, tertiary 1:6 (planning_rules roads.max_gradient).
- D1 (to the ground) laid its cross streets slanting up the slope so they climbed at 1:7; a slanting street cut
  every row it crossed into wedges (D1 351 villas against D2's 381). Now (roads.cross_street_square_only) a cross
  street is square to the rows and only where the ground along it is within 1:7 over at least a block; on this
  ground none qualifies (the villa land's median slope is 20-36%), so D1's rows are joined at their ends instead.
- Both options: a villa street end that meets no other road gets a link to the roads round the block (at most
  80 m, 1:6): D1 12 links, D2 14; the streets left as cul-de-sacs (D1 1, D2 2) are within KMBR's 250 m.
- D1 373 villas, plots 76% of the villa land, cut 43,300 / fill 61,300 m3; D2 370 villas, 75%, cut 57,800 / fill
  75,200 m3. Roads 8.2 ac (11.2%) in both.

## 9 Oct 2026 · options D3 and D4: green pockets among the villas (owner)

- Two more options on the draft model, from the owner's sketch: part of the designated open space becomes villas
  (the dry ground west of the north pond, between the entry road and the pond, 0.8 ac, Phase 1; the west end of the
  south pond's bank walk, 0.3 ac, Phase 4; the ponds keep a 6 m green rim), and the same open space comes back as
  nine pocket gardens in the middle of the villa blocks (two in the north-west lobe, five across the middle block,
  two in the south-east block), to break the long runs of villas. The open space stays the model's 8.3 ac.
- Each garden is two whole plots side by side on one street (about 21 x 20 m, 0.09-0.13 ac), snapped to the plots of
  the plan with the same roads, so the rows either side stay whole and the garden fronts a street (KMBR Rule 31(vi)).
  Square gardens drawn without the rows (27 m) cost 35 villas: the street grid ran through them and trimmed the plots
  round them. The parks give a fixed piece (so the villa land's outline and its grid stay put), about what the
  gardens take back: open space net of roads D3 8.44 ac, D4 8.38 ac.
- Zoning: data/processed/zones_draft_model_pockets.geojson (D3, snapped to D3's own plots) and
  zones_draft_model_pockets_ns.geojson (D4), written by
  `python tools/zoning/draft_model.py --pockets <plan.json> <out.geojson>`, chosen with planning_rules
  options.draft_zoning: green_pockets. D3 lays the roads to the ground (as D1), D4 north-south (as D2).
- D3 364 villas (D1 373), cut 53,900 / fill 60,400 m3; D4 357 villas (D2 370), cut 57,900 / fill 75,500 m3.

## 9 Oct 2026 · walk mode; the financial model in the presentation (owner)

- 3D view: a Walk button puts the camera at eye height (1.7 m) on the drawn terrain, starting on the road nearest
  the view; W A S D or the arrows move (4 m/s, Shift 12 m/s), a drag looks round, Q / E turn, double-click the
  ground to jump there, Esc stops. The buildings and villas are solid; the walker stays on the surveyed ground.
- Presentation: from the fork on, a panel shows the owner's draft financial model run on the option on screen
  (profit, IRRs, revenue, cost, funding, units), each figure with its change against D1 (D1's against the model as
  given), and the four options side by side; M hides it. The figures are Excel's own: tools/finance/run_model.py
  puts each prebuilt plan's roads, plot efficiency, villa land and villas by phase (and no hospital) into the model
  in memory, recalculates, reads the One-Page Summary, and writes config/financials_draft_model.yaml. D1 PAT
  ₹364.9 Cr, IRR 20.9%; D2 362.5, 20.8%; D3 357.1, 20.4%; D4 350.6, 20.2% (model as given 380.6, 22.0%).

## 9 Oct 2026 · options D5 and D6: one continuous green chain (owner)

- The pocket gardens become one chain: each garden runs through its block from one street to the next and the next
  block's garden starts across the street (leave one, cross, enter the next), lake to lake: from the west lake east
  across the middle block, over the existing road and south through the south-east block to the south pond's bank
  walk; and down the north-west lobe from its corner park to the west lake. About two plots wide (whole plots within
  2 m of the line), widening to a pocket at five beads (within 11 m). The parks give the villas the same two pieces
  as for D3/D4; the chain is open space on top (owner: villas may fall, not below 300).
- The chain is snapped to the plots of a plan on the same villa outline without gardens (so it falls on whole plots):
  `CHAIN_HALF=-1 BEAD_R=-1 draft_model.py --chain ...` for that plan, then `draft_model.py --chain <it> <out>`.
- D5 (roads to the ground) 323 villas, open space 10.4 ac net of roads (chain 2.9 ac); D6 (north-south) 312 villas,
  10.8 ac (chain 3.4 ac). The financial model takes each plan's open space (Inputs C37): D5 PAT ₹321.7 Cr, project
  IRR 18.7%; D6 ₹312.1 Cr, 18.3%.

## 12 Oct 2026 · the client's permanent roads: the 18 m N-S road and the loop (client, via owner)

- New client requirement: the 18 m N-S road and the loop round Projects 2 and 3 are permanent roads. The 18 m road
  is the zoning plan's commercial strip (18 m wide, x 281-304): it runs dead straight from the parcel's north edge
  to the strip's south end (296, 160), and on along Project 2's south edge to the road between the two parcels.
  The loop is that road between the parcels (outside our land), the existing road up the batching strip, and its
  north side along Project 3, now a fixed primary (planning_rules bases.draft_model roads.owner_routes; an owner
  route may carry its own width, `width_m: 18`). The gate arm's road from the main gate joins the 18 m road at its
  top; the old entry road (x 325-340, through Project 1) is gone.
- Zoning (tools/zoning/draft_model.py): every zone off the fixed roads. The high street fronts the 18 m road at
  the top; villa clubhouse 2 and its mini-golf, whose land was the strip, move to the 18 m road's east side below
  the high street (with villa clubhouse 1); the gate's west-wing park is gone (it was the road and its frontage),
  the open space is made up at the south pond's bank walk. The small green pocket by the west lake is not drawn (what
  was left of it was an 11 m strip against the 18 m road). D3-D6: only the north pond's dry west side goes to the
  villas (to x = 408, about what the gardens take); the bank walk's west end stays park, as giving it turned the
  south-east block's grid and cost ten villas. A pocket garden under KMBR's 200 m2 takes the next touching plot.
- The loop's north side climbs 36 m in its 230 m (RL 78 to 114, 1:6.4 average) against the primary's 1:8: about
  19,700 m3 of cut on that road alone. The 18 m road crosses two steep banks (y 390-420, 210-240): 9,800 m3 cut,
  7,500 m3 fill.
- The green chain (D5/D6) is now one plot wide with small pockets (CHAIN_HALF 0, BEAD_R 3 m) to stay above 300 villas.
- Result (villas; cut / fill m3; PAT, project IRR from the draft model per plan): D1 359, 70k / 69k, ₹352.8 Cr, 20.3%;
  D2 357, 85k / 69k, ₹350.9 Cr, 20.3%; D3 341, 69k / 67k, ₹336.7 Cr, 19.5%; D4 345, 84k / 69k, ₹340.2 Cr, 19.8%;
  D5 316, 67k / 65k, ₹314.7 Cr, 18.5%; D6 321, 83k / 67k, ₹319.1 Cr, 18.7%. (Before the client's roads: D1 373, D2 370.)
- Re-plan order (each D3-D6 zoning is snapped to plots of a plan): D1/D2 on the base zoning; pockets from D1/D2, then
  from D3/D4's own plots; chain base (`CHAIN_HALF=-1 BEAD_R=-1 ... --chain`), then the chain on it; then
  `npm run build:deploy` and `python tools/finance/run_model.py`.

## 12 Oct 2026 · optimised zoning, three lakes, the green by kind, every number the plan's own (owner; branch optimised-zoning)

- No client zoning or area requirement now: the zones are allocated by tools/zoning/optimise.py on a 20 m grid
  (tools/zoning/site_grid.py). Land per use from the model's built area at KMBR's free FSI (residential and office 3;
  retail 2.0 and senior living 1.35, ASSUMPTIONS for low-rise; school 3 ac, ASSUMPTION). Retail and office are split
  40% Phase 1 / 60% Phase 3, all on the client's 18 m road (main-road access, non-negotiable). Towers and senior
  blocks go where they hide least of the villas' outlook (a viewshed: 72 directions, 300 m, from a first-floor eye)
  and where the airport line leaves at least 12 floors; the villas take the land with the widest outlook, in a few
  large pieces; the villa phases are bands outward from the gate; what is left is open space. No zone is a stray
  piece: each grows from a seed with room for all of it, in one piece of land between the fixed roads.
- Water is kept to three lakes (planning_rules hydrology.keep_lakes: the north pond, the south pond, the west lake);
  the four small patches (2.84 ac, 3,900 m3 at the peak) are drained and built on, and the lakes are dug 0.40 m
  deeper to hold that water. The lakes count as open space.
- The options (prebuilt.ts): D1/D2 optimised zoning (roads to the ground / north-south), 350-370 villas, never more
  than 15 an acre (planning_rules villas.max_per_acre, count_by_zoning). D3/D4 green pockets (tools/zoning/greens.py
  pockets): whole plots of D1/D2 turned to gardens, placed where one brings the most villas within 100 m, until none
  is further than 150 m walk from green (park, lake, clubhouse or pocket; the walk along the roads and through the
  parks). D5/D6 green link (greens.py link): a 10 m green corridor through the villa land, a Steiner tree joining the
  lakes, the villa clubs, the parks of 1 ac and more, and waypoints where the villa land is furthest from green; a
  pocket where a villa is still over 150 m. `greens.py check` measures the walk on a finished plan.
- The green, by the owner's kinds (plan.land.green): RC parks (from 0.25 ac, open_space.rc_min_m2, ASSUMPTION), the
  lakes, the green in the villas, the clubhouse zones, landscape (small parks, strips no zone took, the parcel's
  0.44 ac of unsurveyed edge), the grounds round the buildings (with their drives and parking). Every acre of the
  73.54 is counted once (plan.land); roads are those outside the zones and across the parks.
- Numbers: the hospital is out (no land, no figure; Excel row 103 carries the office's Phase 1); the villa rows ask
  "up to 15 an acre" instead of the old model's 48/80/96/96; apartments report the flats the towers hold. The model
  is run on each plan (tools/finance/run_model.py): C16 = 73.54 ac, every component's land from its zone, roads,
  open space, villas by phase and the villa mix from the plan. Retail 40% Phase 1 / 60% Phase 3 (owner 12 Oct, as
  the office): the model has one retail row (114, its Retail Lease sheet) and no spare row, so the 40% is timed on
  that row's Costs progress/approvals and Retail Lease occupancy formulas (built from quarter 3, ASSUMPTION; let from
  its possession); its land stays on row 114. The presentation's land, ticket and funding cards read the run of the
  option on screen.
- Result (villas; furthest walk to green; PAT, project IRR): D1 361, 213 m, ₹340.7 Cr, 20.6%; D2 351, 238 m,
  ₹331.1 Cr, 20.2%; D3 340, 108 m, ₹322.6 Cr, 19.8%; D4 341, 90 m, ₹322.2 Cr, 19.8%; D5 308, 126 m, ₹293.5 Cr, 18.3%;
  D6 300, 131 m, ₹286.0 Cr, 17.9%. The model as given: ₹380.6 Cr, 22.0% (with the hospital's ₹270 Cr sale, now out).
  Every option: 935 flats and 192 senior homes placed in full; 73.54 ac counted once.
- Re-plan order: `python tools/zoning/optimise.py`; plan D1/D2; `greens.py pockets|link <D1|D2 plan>` for D3-D6
  (all in tools/zoning/replan_all.sh; it needs the untracked scratch test app/src/engine/__tests__/_draft.test.ts); `npm run plans`; `python tools/finance/run_model.py`; `npm run build:deploy`.

## 12 Oct 2026 · the premium land is the villas'; the green by kind; pockets and the link reworked (owner)

- The hilltops (outlook) and the lake fronts are the premium land: the villas take them. Senior living goes to the
  low, secluded ground off them (optimise.py: level, outlook, lake front all count against it), the school too, as
  one campus split into its two stages (not by the west lake: a lake-front villa sells better). The towers stand at
  the edge of the site (never among the villas, so they block no villa's view) and only where the airport line leaves
  a full 20 floors; the apartment clubhouse is grown with the Phase 4 towers, a compact block beside them. No zone
  grows across a fixed road.
- Each kind of green its own colour on the map: RC parks (from 0.25 ac) deep green, the green in the villas lime,
  landscape strips sage, clubhouses teal, lakes blue.
- D3/D4: many small pocket gardens, a single plot each (two where a plot is under KMBR's 200 m2): every villa within
  50 m walk of green (owner: "as small as a badminton court, but many, so each villa feels surrounded by green").
- D5/D6: the link is a chain of pocket parks (26 m square, every 80 m) on a 10 m green path, routed through the middle
  of the villa land (a step costs less the further it is from the villa land's edge), joining the lakes, the villa
  clubs and the large parks.
- The green options start from a zoning with more villa land (33 ac pockets, 34.5 ac link; D1/D2 31.5 ac), so the
  gardens come out of the parks rather than the villa count; the engine leaves the steepest villas over a zoning's
  upper count green; a plot that reaches under another use's building is left out; villa streets' links stay off
  the other uses' land.
- Result (villas; furthest walk to green; PAT, project IRR): D1 358, 335 m, ₹339.5 Cr, 20.4%; D2 363, 307 m, ₹343.0 Cr,
  20.7%; D3 356, 47 m, ₹337.3 Cr, 20.3%; D4 354, 47 m, ₹336.8 Cr, 20.3%; D5 307, 123 m, ₹293.2 Cr, 18.3%; D6 315, 94 m,
  ₹300.8 Cr, 18.7%. All 935 flats and 192 senior homes placed in every option.

- (Same day, owner: "the school can't be on the peak") The high ground counts as premium as well (with the outlook
  and the lake fronts): the school goes to low ground (RL 79, the lowest fifth of the site) west of the 18 m road,
  the hilltop is villas. Result: D1 362 villas, ₹343.3 Cr, 20.5%; D2 364, ₹345.7 Cr, 20.7%; D3 351, ₹332.8 Cr, 20.1%;
  D4 366, ₹346.3 Cr, 20.7%; D5 319, ₹303.8 Cr, 18.7%; D6 332, ₹315.7 Cr, 19.3%. D3/D4 every villa within 48 m of green.

## 12 Oct 2026 · the owner's marks: school to the east lobe, Phase 3 towers west, a water channel, the link as drawn

- Marked on the plan (optimise.py PIN, local metres read off the drawing): the school in the east lobe (the rest of
  the lobe villas), the Phase 3 towers (C19) on the ground west of the 18 m road where the school was. The green
  path south of the west lake by the senior clubhouse stays green (KEEP_GREEN: no villas in it).
- An open water channel joins the north pond (RL 80) and the west lake (RL 72) down the low ground: 6 m of water
  between 4 m planted banks; the roads bridge it; the south pond stays as it is. Water counts as open space, the banks
  as landscape. (The hydrology analysis does not yet route the storm through it.)
- D5/D6: the link follows the owner's drawn line, from the park by the 18 m road east through the middle of the
  villas, over the existing road and south to the south pond, a 10 m green path with a round garden (15 m radius)
  at each loop the owner drew; a pocket where a villa would be over 150 m from green.
- D3/D4: 1.5 x the pockets the 50 m rule needs (more, closer pockets): every villa within 45 m of green.
- Every villa zone holds at most 15 villas an acre (the steepest over it are left green).
- DXF of each plan: `node app/scripts/plan-dxf.mjs exports/dxf` (layers: zones by use, RC / in-the-villas / landscape
  green, water, roads by tier, plots, houses, buildings by use, labels; local metres).
- Result (villas; furthest walk to green; PAT, project IRR): D1 358, 236 m, ₹338.8 Cr, 20.5%; D2 364, 199 m, ₹343.3 Cr,
  20.9%; D3 311, 41 m, ₹298.2 Cr, 18.5%; D4 331, 45 m, ₹314.1 Cr, 19.4%; D5 304, 138 m, ₹290.2 Cr, 18.1%; D6 316, 135 m,
  ₹300.1 Cr, 18.8%. All 935 flats and 192 senior homes placed in every option.

## 12 Oct 2026 · the clean app and the live model (owner; branch clean-app)

- The app is what the owner uses: the presentation (the analysis steps and the six master plans) with its cards and
  the financials, walk mode, 2D / 3D, the plan's stats, and the plans as DXF. The earlier planner's panels (rail,
  levers, solve bar, scenarios, zone editing, siting, compliance, report, export panel) are removed; the app opens in
  the presentation.
- The Model tab opens the owner's draft financial model (Draft model.xlsx) live: every sheet, every formula,
  recalculated in the browser (HyperFormula, GPL-3 licence key; IRR, TEXT with Excel's formats and MOD as Excel has
  them are added; INDEX on one row and INDEX(range, i, 0) are rewritten on the way in). All 24,658 formulas match
  Excel's saved values; each option's run matches tools/finance/run_model.py to the rupee. Any cell can be changed;
  the change runs through the model as given and through every option (their land, villas and office split put in as
  run_model.py does), and the presentation's financial figures are the live run. Edits stay in the browser; Download
  writes the workbook with them.
- The workbook is the owner's: it is not in the repository (which is public). sync-data copies it in from MODEL_XLSX
  or ~/Downloads/Draft model.xlsx, as base64 text (data/model/draft_model.xlsx.txt).
- No component codes are shown (C03, C16-1, OS-P12 ...): names only.
- (Same day, owner: "the hospital still shows 5 ac in Excel") The Model tab opened on the owner's file as given; it now
  opens with the masterplan on screen in it, and the file as given is labelled as before the masterplan. The plan now
  also sets the phases in words (Inputs C90-C93), the apartments' land by phase (C151, E154-E157), the villa mix and
  plot sizes phase by phase (D130-D145, F130-F145), and the summary's hospital row reads "not in this plan" (0 ac);
  tools/finance/run_model.py sets the same. Download writes the owner's own file with the option's masterplan and the
  edits in it (only those cells change; every style stays; Excel recalculates on opening): D1 opened in Excel gives
  PAT ₹338.9 Cr, project IRR 20.5%, 358 villas, 73.54 ac, as in the app.
- Retail stays one Phase 3 line (the workbook's Retail Lease and Costs sheets run off its one row). Bound: all of it in
  Phase 1 would add ₹5.0 Cr PAT and ₹46 Cr peak funding to D1 (project IRR -0.1 pt); the 40% the plan builds in Phase 1
  is about ₹2 Cr PAT and ₹18 Cr peak funding.

## 12 Oct 2026 · villas on the land the towers gave up; the school at the lobe's tip; earthwork priced (owner)

- The school goes up to the east lobe's tip, the land below it green. The towers stand closer, on less land: each
  tower zone is its flats x 2,130 sq ft (the plans' towers' own floor area a flat) at FSI 3.8, under the 4.0 the owner
  accepted (KMBR Table 6, A1: Rs 5,000/m2 on the floor area over FSI 3, Rs 7,500 over 4; in the model on each
  apartment row's construction rate, Inputs N98, N111-N113). The Phase 3 towers keep 70 m off the 18 m road, at the
  west edge. The land given up (by the 18 m road, the lake's west bank, the gate-side and Phase 4 tower land) is
  plotted villas; a free piece of 0.8 ac and more goes to villas while they are short of their land. The villa count
  may run to 420 (15 an acre still the limit).
- Earthwork at the owner's rates: excavation Rs 350/m3, backfill with the excavated earth Rs 300/m3, RCC retaining wall
  Rs 21,500/m3. Walls where the finished ground steps by more than 0.5 m between neighbouring 2 m cells (platform
  edges, plot to plot, road edges), up to 6 m high, concrete 0.38 H + 0.04 H^2 m3 a metre (ASSUMPTIONS, config/
  assumptions.yaml earthwork_costs); a taller step (deep road cut or fill) is a sloped bank, its earth in the cut and
  fill, its length reported. Into the model as Inputs G45 (Rs Cr), the infrastructure rate C45 = the model's 0.75 +
  G45 / gross acres, so it is spent and escalated as the infrastructure is.
- Result (villas; earthwork Rs Cr; PAT, project IRR): D1 372, 36.1, 305.4, 18.5%; D2 376, 36.6, 309.3, 18.7%;
  D3 335, 34.1, 273.6, 17.0%; D4 349, 36.4, 283.2, 17.5%; D5 315, 34.0, 256.7, 16.2%; D6 340, 36.3, 276.0, 17.2%.
  For D1: the earthwork Rs 39.5 Cr of PAT, the FSI fee Rs 6.7 Cr; the tighter towers and their villas +Rs 6 Cr net of
  the fee. About 18 km of walls an option (~14,000 m3), half of them at road edges: the road profiles are worth a
  civil engineer's look.

## 12 Oct 2026 (owner, marked on the plan): towers together, senior living together
- The two Phase 3 towers (C19, 304 flats) stand side by side in one block at the south end of the west strip, just
  north of the senior living and clear of the green path by the west lake; each tower has twice its footprint and
  setbacks about it (about 1 ac a tower). The strip north of them, and the land between the old split plots, is
  plotted villas. Township FSI is counted globally (no per-zone FSI), as in the earlier deck.
- All senior living is one place: the Phase 1 block (C04) and the senior clubhouse (C15) start against the enclave
  (C07), never on the green path.
- Tools: `tools/zoning/optimise.py` (C19_PIN / C19_OK / C19_PIECE_AC; the senior blocks seeded beside the enclave;
  MULTI_PIECE for zones allowed in pieces). Test: a villa phase under 5 ac may stray 0.2 from the plot mix (0.15 above).

## 12 Oct 2026 (owner): Vastu facings, D6's empty land green, clean DXF
- No villa entrance on the south (planning_rules villas.facing_forbidden_deg). North-south options (D2, D4, D6): the
  villa streets run north-south only, so plots face east or west (none south-east, south or south-west); roads to the
  ground (D1, D3, D5): any facing but south or south-west, the grid turned within that range to the angle whose
  streets climb least. A plot that would face a forbidden way is not laid (the draft model's plans only).
- Result: D1 377, D2 405, D3 330, D4 356, D5 301, D6 330 villas; none faces S or SW. D3 digs 37% less than D2
  (75k against 120k m3) but its earthwork is ₹37.2 Cr against ₹40.1 Cr: retaining walls between the terraces are
  ~85% of the cost on this slope whichever way the streets run (a strict least-climb angle did not lower it).
- The link options' villa land left without a villa or a street becomes green (greens.py fill; D6 2.2 ac, D5 3.2 ac).
- DXF (tools/export/clean_dxf.py, after the owner's D6-revised.dxf): road edges once, as the blocks' outlines with
  3 m fillets as arcs; green (ACI 64) and water (ACI 5) solid fills; plots grey, houses white, buildings by use; zone
  outlines and labels on layers that start off; R2000, ASCII.
