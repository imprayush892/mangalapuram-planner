# How the villa and tower footprints are derived

Written so the arithmetic can be checked line by line against
`config/client_rules.yaml`, `config/programme.yaml`, `config/kmbr_rules.yaml`
and `config/assumptions.yaml`. Every step names the rule it reads. Nothing here
is a number chosen by the tool; where a value is an interpretation it is marked
**INTERPRETATION** and recorded in `docs/DECISIONS.md`.

---

## 1. Villa plots and footprints

Code: `engine/rules/client.ts` (`sizeVillaPlots`, `plotDims`, `villaDelivery`),
`engine/generators/villa.ts`.

### Step 1 — split the land

    roads      20%   client_rules.villa_and_senior_land_split.roads
    open space 30%   .open_space
    saleable   50%   .saleable

Applied to the zone's in-scope area, not the drawn area.

### Step 2 — unit plot area

    unit_plot_area = saleable_area / units        client_rules.villa_plots.unit_plot_area

`units` comes from the programme: **20 units per acre**, which is the cashflow's
own figure (`programme.yaml` note: sheet C17 = 640/20), times the zone's acreage.

### Step 3 — the minimum plot

    min_side = 18 m                 client_rules.villa_plots.min_side_m
    aspect_max = 2.5                .aspect_ratio.max
    min_side_applies_to = long_side .min_side_applies_to   ← INTERPRETATION, switchable

Under the long-side reading:

    min_plot_area = 18 × (18 / 2.5) = 129.6 m²    (.min_plot_area_m2_derived confirms it)

The client's own worked example — 63 m² per unit becoming ~126 m² row-housing
plots — sits at 1:2.56, just under 129.6. So the stated aspect tolerance is
applied to the minimum area as well, or their example fails their own rule:

    tolerance = 3%                  .aspect_tolerance
    min_plot_with_tolerance = 129.6 × 0.97 = 125.7 m²

**INTERPRETATION 1** in DECISIONS.md.

### Step 4 — row housing

    while unit_plot_area × k < min_plot_with_tolerance: k += 1
    plot_area = unit_plot_area × k
    plots     = floor(units / k)

This is the client's rule verbatim
(`client_rules.villa_plots.row_housing.rule`, k starting at 2 in their example).

### Step 5 — plot dimensions

Long-side reading: the long side is held at 18 m until the plot is big enough
that the short side would exceed it, after which the rectangle simply grows.

    depth = max(18, plot_area / 18)
    width = plot_area / depth

**INTERPRETATION 2**. It reproduces the golden dimensions exactly and stays
continuous for larger plots.

### Step 6 — the villa footprint

    footprint_area   = plot_area × 0.45     client_rules.villa_plots.footprint_placeholder.share_of_plot_area
    footprint_aspect = 2.5                  .aspect_ratio
    footprint_width  = sqrt(footprint_area / 2.5)
    footprint_depth  = footprint_width × 2.5

It is placed inside the client setbacks (front 2.0, rear 1.5, side 1.0 —
`setbacks_client`), and the KMBR Table 4 yard is then checked on top
(`kmbrYardOk`). The client's own sheet calls this a **placeholder**: "client
will decide villa footprint later".

### Worked example — PROJECT ‑ 2 (VILLAS), 7.77 ac

    land           31,444 m²
    saleable       15,722 m²   (50%)
    units          155         (7.77 × 20)
    unit plot      101.4 m²
    grouping       2           (101.4 < 125.7, 202.9 ≥ 125.7)
    plot           202.9 m²  =  11.27 × 18.00 m   (aspect 1:1.60)
    plots          77
    footprint      91.3 m² per plot  (45%)

### The conflict this exposes

`villaDelivery` divides the plot footprint by the grouping to get what **one
dwelling** actually receives:

    footprint per dwelling = 91.3 / 2 = 45.6 m² = 491 sft

The programme states the villa size directly:

    pkg1_villas     60 units,  plinth_sft 1750, land 3.0 ac
    balance_villas 640 units,  plinth_sft 2000, land 32.0 ac

and `client_rules.villa_plots.types.standard.plinth_sft: [1750, 2000]` confirms
it. At `villa_floors: 2` (G+1, PRD §5A.2, held in `assumptions.yaml`):

    delivered = 491 × 2 = 982 sft   against 1,750–2,000 sft asked for

To reach 2,000 sft on that footprint needs **4.1 floors**, which is not a villa.
To reach it at G+1 needs **92% of the plot covered**, against the client's own
45% placeholder and the **KMBR A1 coverage limit of 65%**
(`table6.A1_residential.coverage`).

**The three rules cannot all hold: the 20/30/50 land split, 20 units per acre,
and a 1,750–2,000 sft villa.** One of the three has to move. The tool reports
this as a failing finding (`villa.type_plinth`) on every villa zone rather than
drawing the placeholder footprint and reporting success. Which one moves is the
client's call, not the tool's — the three obvious levers are density (fewer
units per acre), the land split (more than 50% saleable), or the villa size.

### Corner plots

`client_rules.plot_orientation.corner_plots: premium` — "larger/optimised, never
at the cost of road widths or setbacks". A corner plot sits at the end of a run,
so the frontage beyond it carries no other plot and it can grow there without
taking anything from a neighbour, a road or a setback. The ceiling is the
client's own aspect band: a plot at 1:1 is as square as the rule allows, so

    max_corner_width = depth / aspect_ratio.min = 18 / 1.0 = 18 m

Growth stops at unusable ground, at a cross road, and at any column another plot
holds or another corner has already claimed. No new number is invented.

---

## 2. Apartment towers

Code: `engine/rules/client.ts` (`sizeApartments`), `engine/generators/tower.ts`.

### Step 1 — total floor area

    total_floor_area = land × FSI          client_rules.apartments.total_floor_area

FSI comes from **KMBR Table 6**, A1 residential: 3 free, 4 or 6 with fees
(`kmbr_rules.table6.A1_residential.fsi`). The tier is a UI switch.

### Step 2 — total footprint

    total_footprint = total_floor_area / floors     client_rules.apartments.total_footprint

The client's rule divides by the literal 20 of their floor cap
(`apartments.max_floors: 20`). **INTERPRETATION 4**: a scheme actually built at
12 or 15 floors divides by the floors it has, or a third of the FSI goes unused.
The 20-floor case is unchanged, so the golden values still hold.

### Step 3 — the plate

    plate = flats_per_floor × avg_unit_plinth / flats_share_of_footprint
                                            client_rules.apartments.plate

with

    flats_per_floor          4–6        .flats_per_floor  (UI switch, default 4)
    avg_unit_plinth          midpoint of the chosen mix, .unit_bands_plinth_sft
                             2BHK 900–1200, 3BHK 1200–1800, 4BHK 1800–2400, 5BHK 2400–3000
    flats_share_of_footprint 0.80       .flats_share_of_footprint
    core_share_of_footprint  0.20       .core_share_of_footprint

The client's note says "remaining 20%", which the config records as an open item;
the tool treats flats as 80% and the core as 20%, switchable.

### Step 4 — tower count

    towers = ceil(total_footprint / plate)   client_rules.apartments.towers

**INTERPRETATION 5**: `ceil` alone would put more floor area on the site than the
FSI allows, so the footprint is then spread evenly over that many towers —

    built_plate = total_footprint / towers

— and the client's `plate` is reported as the **maximum**. The FSI then lands
exactly on the chosen tier and every tower is the same size.

### Step 5 — the plate's shape

Depth is not chosen; it comes from **KMBR Rule 41**: habitable space must be
within 7.5 m of an opening (`rule41_daylight_max_depth_from_opening_m`). A
double-loaded plate is therefore twice that plus the corridor, which is not
habitable:

    max_depth = 7.5 × 2 + corridor_width_m (2.0)  = 17.0 m
    length    = built_plate / depth

**INTERPRETATION 7**; `corridor_width_m` is the assumption this introduced.

### Step 6 — spacing and placement

    min_clear     12 m       client_rules.apartments.spacing.min_clear_m  (stricter than KMBR Ch.XVII's 5 m)
    strategy      maximise_distance    .spacing.strategy
    joining       0 m gap, only when the zone is too small to keep 12 m
                  .spacing.joining, configurations short_side_to_short_side or L

**INTERPRETATION 6**: there is no middle ground. A 7 m gap satisfies neither the
client's 12 m nor a join, and breaches the KMBR 5 m minimum, so the generator
either keeps 12 m or joins short side to short side at 0 m. A join is never
allowed to crowd a third tower, and every join is flagged.

Placement is farthest-point on the flattest ground, with a penalty of 8 m of
notional distance per metre of fall across the tower footprint, so towers avoid
steep ground where the zone allows it.

### Step 7 — checked on top

    buildable_share_of_land  30–50%    client_rules.apartments.buildable_share_of_land
    coverage                 65%       kmbr table6.A1_residential.coverage
    max_floors / max_height  20 / 70 m client_rules.apartments
    yards                    KMBR Table 4 with the Rule 26 height increment, 16 m cap
    fire lanes, gate, stairs, stretcher lift   KMBR Chapter XVII where high rise
    parking                  KMBR Table 9
    lifts                    KMBR Rule 40
    travel distance          KMBR Rule 36 (drives the two-core flag)

### Flats

    flats = round((flats_share × total_footprint) / avg_unit_plinth × floors)

and in the master plan the reported flats come from the towers **actually
placed**, not from the sizing, so a zone that cannot hold every tower reports
the shortfall rather than the intention.

---

## 3. Other buildings (school, club, hotel, commercial, business hub)

Code: `engine/generators/block.ts`.

Each use is laid as a **campus of bars**, every dimension read from a rule:

    depth   Rule 41 daylight both sides + corridor            = 17 m
    length  2 × Rule 36 travel distance (unsprinklered)       = 110 m
    gap     Rule 26 gap between buildings (≤10 m tall)        = 2 m
    yards   KMBR Table 4 for the occupancy
    floors  min(FSI tier ÷ footprint, plinth ÷ footprint), never past the FSI
    coverage KMBR Table 6 for the occupancy

Bars are placed longest-first on the flattest ground left; the shortfall is
reported where the ground will not take the whole plinth.

---

## 4. What is still a placeholder, and what it would take to replace it

| Item | Today | To replace it |
| --- | --- | --- |
| Villa footprint | 45% of the plot, 1:2.5, from the client's own placeholder | The client's villa plan or a plinth target per type; the tool already computes what any target implies (`villaDelivery`) |
| Villa floors | `villa_floors: 2` assumption (G+1, PRD) | A confirmed villa section |
| Premium villa type | Corner plots widen within the aspect band | A separate premium plot size and a rule for where premium goes |
| Plot catalogue | One plot size per zone, from 20/30/50 | PRD §5A.2's 3/4/5/6-cent catalogue and a mix rule |
| Tower plate library | Computed from the client formula | The 340–1,080 m² plate library in the PRD |
| Parking | Counted and area-sized, never drawn | Bay, aisle and ramp geometry (KMBR Rule 29) |
