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
