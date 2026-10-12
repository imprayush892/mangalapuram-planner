"""Zoning for the draft financial model (Draft model.xlsx, owner 7 Oct 2026).

Writes data/processed/zones_draft_model.geojson: one zone per component of the model, sized to
the model's land (Inputs section 10, column G), placed on the site by the owner's rules:
  - outward from the main gate (north, on the Mangalapuram-Pothencode road): Phase 1 next to it,
    later phases further in;
  - the hospital on the main road, on the highway side (NH66 is at Mangalapuram, to the west);
    the office and the retail street on the main road too;
  - apartment towers where they hide the least of the villas' views (tools/zoning/views.py), on
    low ground under the airport limit;
  - no zone on waterlogged ground (it stays open space).
The zones are cut from the client's zones with straight lines, each to its exact acreage.

Inputs: the client's zones, the parcel, the DEM, and the analysis layers written by
`node app/scripts/export-layers.mjs` (to tools/zoning/layers).
Run:    python tools/zoning/draft_model.py            (writes the GeoJSON and a map)
"""
import json
import os
import sys

import numpy as np
import shapely
from shapely.geometry import box, Polygon, Point, shape, mapping, LineString
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
LAYERS = os.path.join(HERE, "layers")
OUT = os.path.join(REPO, "data", "processed", "zones_draft_model.geojson")
AC = 4046.8564224

META = json.load(open(f"{REPO}/data/processed/dem_2m.json"))
NX, NY, X0, Y0, CELL = META["nx"], META["ny"], META["x0"], META["y0"], META["cell_m"]
DEM = np.fromfile(f"{REPO}/data/processed/dem_2m.f32", dtype="<f4").reshape(NY, NX)
XC = X0 + CELL * (np.arange(NX) + 0.5)
YC = Y0 + CELL * (np.arange(NY) + 0.5)
EXTENT = (X0, X0 + NX * CELL, Y0, Y0 + NY * CELL)


def layer(name):
    return np.fromfile(os.path.join(LAYERS, f"layer_{name}.u8"), dtype=np.uint8).reshape(NY, NX).astype(bool)


def _fc(path):
    return json.load(open(path, encoding="utf-8"))["features"]


PARCEL = unary_union([shape(f["geometry"]).buffer(0) for f in _fc(f"{REPO}/data/processed/parcel.geojson") if f["properties"].get("status", "in_scope") == "in_scope"])
CLIENT = {f["properties"]["name"]: shape(f["geometry"]).buffer(0).intersection(PARCEL) for f in _fc(f"{REPO}/data/processed/zones_client_registered.geojson") if f.get("geometry")}


def mask_of(poly):
    """DEM cells whose centre lies in poly."""
    from matplotlib.path import Path
    gx, gy = np.meshgrid(XC, YC)
    pts = np.column_stack([gx.ravel(), gy.ravel()])
    m = np.zeros(NX * NY, bool)
    for p in (poly.geoms if hasattr(poly, "geoms") else [poly]):
        if p.is_empty or p.geom_type != "Polygon":
            continue
        inside = Path(np.asarray(p.exterior.coords)).contains_points(pts)
        for h in p.interiors:
            inside &= ~Path(np.asarray(h.coords)).contains_points(pts)
        m |= inside
    return m.reshape(NY, NX)


def mask_poly(m):
    """The cells of a mask as one polygon (2 m squares, merged)."""
    js, is_ = np.nonzero(m)
    return unary_union([box(X0 + CELL * i, Y0 + CELL * j, X0 + CELL * (i + 1), Y0 + CELL * (j + 1)) for j, i in zip(js, is_)]).buffer(0)


WET = mask_poly(layer("waterlogging")).buffer(2)


# Client 12 Oct (permanent roads): the client's 18 m N-S road runs dead straight down the commercial strip of the
# zoning plan, from the parcel's north edge to the strip's south end, and on along Project 2's south edge to the loop
# round Projects 2 and 3 (the road between the two parcels, the existing road up the batching strip, and the loop's
# north side along Project 3). The gate arm's road joins it at its top. As planning_rules.yaml bases.draft_model
# roads.owner_routes draws them.
MAIN = LineString([(287.6, 606), (295.6, 160)])                      # the strip's centreline, 18 m
MAIN_LINK = LineString([(295.6, 160), (300, 156), (366, 156)])        # to the road between the parcels
ARM = LineString([(340, 662), (334, 630), (331, 600), (318, 582), (289, 572)])
LOOP_TOP = LineString([(398, 398), (420, 414), (654, 414)])
FIXED_ROADS = unary_union([MAIN.buffer(9, cap_style=2), MAIN_LINK.buffer(5), ARM.buffer(5), LOOP_TOP.buffer(5)]).buffer(0)


def cz(prefix):
    """A client zone (by name prefix), in scope and off the waterlogged ground"""
    # (client 12 Oct) and off the fixed roads, so each zone is sized on land it can use
    return unary_union([g for n, g in CLIENT.items() if n.upper().startswith(prefix.upper())]).difference(WET).difference(FIXED_ROADS).buffer(0)


INF = 5000


def above(y): return box(-INF, y, INF, INF)
def below(y): return box(-INF, -INF, INF, y)


DIRS = {"N": (0, 1), "S": (0, -1), "E": (1, 0), "W": (-1, 0)}


def take(base, acres, side):
    """The part of `base` furthest toward `side` with the given area, and what is left."""
    dx, dy = DIRS[side]
    cs = shapely.get_coordinates(base)
    proj = cs[:, 0] * dx + cs[:, 1] * dy
    lo, hi = float(proj.min()), float(proj.max())
    piece = base
    for _ in range(60):
        t = (lo + hi) / 2
        hp = box(t, -INF, INF, INF) if (dx, dy) == (1, 0) else box(-INF, -INF, -t, INF) if (dx, dy) == (-1, 0) else box(-INF, t, INF, INF) if (dx, dy) == (0, 1) else box(-INF, -INF, INF, -t)
        piece = base.intersection(hp)
        if piece.area / AC > acres:
            lo = t
        else:
            hi = t
    return piece.buffer(0), base.difference(piece).buffer(0)


def take_disk(base, acres, centre):
    """A compact piece of `base` round `centre` with the given area, and what is left."""
    lo, hi = 1.0, 300.0
    piece = base
    for _ in range(50):
        r = (lo + hi) / 2
        piece = base.intersection(Point(centre).buffer(r))
        if piece.area / AC > acres:
            hi = r
        else:
            lo = r
    return piece.buffer(0), base.difference(piece).buffer(0)


COMM, P1V, P2V, APTZ = cz("COMMERCIAL"), cz("PROJECT - 1"), cz("PROJECT - 2"), cz("APARTMENTS")
P3V, P4V, SEN, CLUB, HOSP, SCH, PH2, PH3 = (cz(n) for n in ("PROJECT - 3", "PROJECT - 4", "SENIOR", "CLUBHOUSE", "HOSPITAL", "SCHOOL", "PHASE 2", "PHASE 3"))

# (component, name, use, phase, model acres (Inputs column G), geometry)
Z = []


def add(comp, name, use, phase, acres, g):
    Z.append(dict(component=comp, name=name, use=use, phase=phase, model_ac=acres, geom=g.buffer(0)))


# --- on the main road (Mangalapuram-Pothencode road, from NH66 at Mangalapuram), by the gate ---
# The entry road runs down the gate arm's west edge (planning_rules bases.draft_model roads.owner_routes);
# the retail street is the land east of it, from the gate south, one strip deep; the thin wing west of
# the road is left as the gate's open space.
from shapely.geometry import LineString
# The road the high street and the villas front: from the gate down the arm onto the client's road.
ENTRY = LineString(list(ARM.coords) + [MAIN.interpolate(MAIN.project(Point(289, 572))).coords[0], (295.6, 160)])
ENTRY_ROAD = FIXED_ROADS
EAST_OF_ENTRY = ENTRY.buffer(400, single_sided=True, cap_style=2)   # the line runs south: its left is east
RETAIL_DEPTH = 45                                              # one row of high-street blocks with its yards
COMM, P1V = COMM.difference(FIXED_ROADS).buffer(0), P1V.difference(FIXED_ROADS).buffer(0)
retail_band = ENTRY.buffer(9 + RETAIL_DEPTH, single_sided=True, cap_style=2).difference(ENTRY_ROAD)
retail, _ = take(unary_union([COMM, P1V]).intersection(retail_band).intersection(above(380)), 1.5, "N")
COMM = COMM.difference(retail)
P1V = P1V.difference(retail)
comm_rest = COMM.intersection(below(575))                      # the gate wing west of the road stays open
strip = comm_rest.intersection(above(400)).intersection(below(560))
h_top, _ = take(strip, 5.0 - P4V.area / AC, "W")
comm_rest = comm_rest.difference(h_top)
add("C12", "RETAIL & F&B HIGH STREET", "retail", 3, 1.5, retail)
# Owner 8 Oct: the hospital is built on the 26 ac deferred land, not in these 73 ac; its lobe (the NW lobe on the
# main road, highway side) becomes Phase 2 villa land.
HOSP_LOBE = unary_union([P4V, h_top]).buffer(0)
office, apt_ne = take(APTZ, 2.5, "N")
add("C16", "COMMERCIAL OFFICE", "office", 4, 2.5, office)
# --- Phase 1, next to the gate ---
P1V = P1V.intersection(EAST_OF_ENTRY).difference(ENTRY_ROAD)   # villas east of the entry road only, right up to it
ch1, p1_rest = take(P1V, 0.5, "S")
# Phase 1 villas (owner 7 Oct: 85% of the villa land in plots, so the villa zones are compact blocks): the
# north corner of Project 2, between the existing road and the entry road, with the top-west of Project 3
# beside it, one block. The scrap of Project 1 by the pond north of the existing road stays open space
# (a strip that ragged would lose a fifth of itself to the street pattern).
def _phase1(y):
    top = P2V.intersection(above(y))
    east, _ = take(P3V.intersection(above(y)), 2.991 - top.area / AC, "W")
    return top, east


# The line between Phase 1 and Phase 2: as far south as leaves Project 3 its Phase 3 villas (5.982 ac).
lo, hi = 250.0, 330.0
for _ in range(40):
    P1_TOP = (lo + hi) / 2
    if (P3V.area - _phase1(P1_TOP)[1].area) / AC < 5.982:
        hi = P1_TOP
    else:
        lo = P1_TOP
P1_TOP = lo
top_up, p1_east = _phase1(P1_TOP)
P2V = P2V.difference(top_up)
P3V = P3V.difference(p1_east).buffer(0)
add("C03", "VILLAS · PHASE 1", "villas", 1, 2.991, unary_union([top_up, p1_east]))
add("C08", "VILLA CLUBHOUSE 1", "clubhouse", 1, 0.5, ch1)
a1, apt_ne = take(apt_ne, 1.2, "E")                                          # few villa sight-lines cross the NE corner
add("C02", "APARTMENTS · PHASE 1", "apartments", 1, 1.2, a1)
west = unary_union([SEN, HOSP]).buffer(0)
s1, west = take(west, 1.0, "N")
add("C04", "SENIOR LIVING · PHASE 1", "senior", 1, 1.0, s1)
# --- Phase 2 ---
a2e, east = take(SCH, 3.0 - apt_ne.area / AC, "N")
add("C11", "APARTMENTS · PHASE 2", "apartments", 2, 3.0, unary_union([apt_ne, a2e]))
v2, p2_rest = take(P2V, 4.985, "N")
add("C09", "VILLAS · PHASE 2", "villas", 2, 4.985, unary_union([v2, HOSP_LOBE]))
club_n, club_rest = take(CLUB, 5.3 - west.area / AC, "N")
sch_c, sen2 = take_disk(unary_union([west, club_n]), 0.3, (215, 250))
add("C07", "SENIOR ENCLAVE · PHASE 2", "senior", 2, 5.0, sen2)
add("C15", "SENIOR CLUBHOUSE", "clubhouse", 2, 0.3, sch_c)
schA, ph3_rest = take(PH3, 2.5, "E")
add("C05", "SCHOOL · STAGE A", "school", 2, 2.5, schA)
# --- Phase 3 ---
v3, _ = take(P3V, 5.982, "W")
add("C17", "VILLAS · PHASE 3", "villas", 3, 5.982, v3)
add("C19", "APARTMENTS · PHASE 3", "apartments", 3, 3.9, east)              # the rest of the east lobe
# Villa clubhouse 2 and its mini-golf (client 12 Oct: its strip is the client's road): on the client's road, south of
# the high street, the frontage the old entry road and the gate's west wing leave between the road and the villas.
club_band = ENTRY.buffer(9 + 70, single_sided=True, cap_style=2).difference(ENTRY_ROAD)   # a clubhouse and its mini-golf: a deeper lot
ch2, _ = take(unary_union([COMM, P1V]).intersection(club_band).difference(retail).difference(ch1).intersection(above(330)), 1.2, "N")
P1V = P1V.difference(ch2).buffer(0)
add("C10", "VILLA CLUBHOUSE 2 + MINI-GOLF", "clubhouse", 3, 1.2, ch2)
schB, ph3_rest = take(ph3_rest, 1.5, "E")
add("C13", "SCHOOL · STAGE B", "school", 3, 1.5, schB)
# --- Phase 4, furthest from the gate ---
v4, ph2_rest = take(PH2, 5.982, "N")
add("C18", "VILLAS · PHASE 4", "villas", 4, 5.982, v4)
a4w, club_rest = take(club_rest, min(3.9, club_rest.area / AC), "W")          # the south-west low ground
south = unary_union([ph2_rest, ph3_rest]).buffer(0)
a4s, south = take(south, 3.9 - a4w.area / AC, "W")
add("C20", "APARTMENTS · PHASE 4", "apartments", 4, 3.9, unary_union([a4w, a4s]))
cha, south = take(south, 1.0, "W")
add("C14", "APARTMENT CLUBHOUSE", "clubhouse", 4, 1.0, cha)

# --- Open space (owner 7 Oct): the model's 8.3 ac of recreational open space (Inputs C38: 10% of the gross,
# the UDCPR minimum, + 1 ac), which the model does not place. KMBR Rule 31(v)-(vi): 10% of a layout of more than
# 0.5 ha, accessible like a plot, no piece under 2 Ares (200 m2) or narrower than 6 m. Counted on dry land only:
# the ponds and the ground the 300 mm storm floods stay open as well, but are not counted.
#   - kept as designated open space: the land by the north pond, the gate arm's west wing, the north-west corner
#     and the south-east corner, as the zoning leaves them;
#   - the land south of Phase 4 (and the strip south of Phase 2) becomes villa land, and the same area comes out
#     of the villa land as green pockets, a chain from the west lake through the villas to the south pond, put
#     where the villas lose least (Phase 2's steep west edge, Phase 3's Rule 22 slope) and in Phase 4, which gains.
OS_TARGET = 8.30
for _z in Z:
    _z["geom"] = _z["geom"].difference(FIXED_ROADS).buffer(0)
SOUTH_ROAD = LineString([(471, 11), (527, 28), (585, 30), (632, 37), (646, 57), (649, 72), (675, 87)]).buffer(6)
ZD = {z["component"]: z for z in Z}
VILLAS = unary_union([ZD[c]["geom"] for c in ("C03", "C09", "C17", "C18")])


def free_land():
    taken = unary_union([z["geom"] for z in Z])
    f = PARCEL.difference(taken).difference(WET).difference(ENTRY_ROAD.buffer(1)).difference(SOUTH_ROAD)
    # off the villas' north edge, where the trunk road to the apartments runs (14 m)
    f = f.difference(VILLAS.buffer(14).difference(VILLAS.buffer(-1)).intersection(above(400)))
    return f.buffer(-3).buffer(3).buffer(0)                    # KMBR 31(vi): 6 m wide at least


def piece_at(f, pt):
    return max((g for g in getattr(f, "geoms", [f]) if g.distance(Point(pt)) < 2), key=lambda g: g.area)


FREE = free_land()
# (Client 12 Oct: the gate's west wing is the client's road and the frontage on it; no park there.)
KEPT = [piece_at(FREE, pt) for pt in ((470, 500), (274, 603), (828, 146))]
kept_ac = sum(g.area for g in KEPT) / AC
# The villa streets run on through the pockets (so each fronts a street): the pockets are drawn larger by the
# streets' share of the grid, 6.5 m of street to every 46.5 m (14%), so the open space net of them is the model's.
POCKET_STREETS = 0.30   # owner 8 Oct: cross streets are back, so more of a pocket is street (measured ~30%)
# Owner 7 Oct (second pass): the land added stays villa land (the model's 320 villas need about 21-22 ac of it at
# the plots the ground allows), and the open space goes where a villa would sell least: little outlook (the view
# analysis, tools/zoning/views.py), steep slopes, the ponds' rims and the verges. Land with an outlook is villas.
strip = FREE.intersection(box(300, 150, 465, 190))
strip = max(getattr(strip, "geoms", [strip]), key=lambda g: g.area)
south_all = piece_at(FREE, (540, 130))
# Client 12 Oct: the 18 m road's link to the loop runs along this strip; what is left of it (under 0.3 ac) stays
# open ground, and the green pocket that matched it (11 m wide against the 18 m road, a street on it) is not drawn.
STRIP_KEPT = strip.area / AC >= 0.3
if STRIP_KEPT:
    ZD["C09"]["geom"] = unary_union([ZD["C09"]["geom"], strip]).buffer(0)
ZD["C18"]["geom"] = unary_union([ZD["C18"]["geom"], south_all]).buffer(0)
VILLAS = unary_union([ZD[c]["geom"] for c in ("C03", "C09", "C17", "C18")])
FREE2 = free_land()


def pieces_at(f, pts):
    out = []
    for pt in pts:
        near = [g for g in getattr(f, "geoms", [f]) if g.distance(Point(pt)) < 2 and g.area >= 200]
        if near:
            g = max(near, key=lambda q: q.area)
            if all(g.distance(o) > 0.01 or not g.equals(o) for o in out):
                out.append(g)
    return out


# Small parks on the land the zoning leaves, low in outlook and reached from a road: the south-west corner, beside
# the apartment clubhouse, and the south pond's banks.
EXTRA_AT = ((322, 63, 4), (461, 81, 4), (502, 36, 4), (607, 43, 4))
EXTRA = []
for x, y, ph in EXTRA_AT:
    got = pieces_at(FREE2, [(x, y)])
    if got and all(not got[0].equals(e) for e, _ in EXTRA):
        EXTRA.append((got[0], ph))
extra_ac = sum(g.area for g, _ in EXTRA) / AC


def carve(comp, region, acres, side):
    """A pocket of `acres` from the villa zone, at the given side of the region."""
    g = ZD[comp]["geom"]
    piece, _ = take(g.intersection(region), acres, side)
    ZD[comp]["geom"] = g.difference(piece).buffer(0)
    return piece


def carve_disk(comp, centre, acres):
    """A pocket squared to north round `centre` (the villa streets run north-south or east-west in both options,
    so a square pocket's edges fall along the rows instead of cutting across them)."""
    g = ZD[comp]["geom"]
    lo, hi = 1.0, 300.0
    piece = g
    for _ in range(50):
        r = (lo + hi) / 2
        piece = g.intersection(box(centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r))
        if piece.area / AC > acres:
            hi = r
        else:
            lo = r
    piece = piece.buffer(0)
    ZD[comp]["geom"] = g.difference(piece).buffer(0)
    return piece


from shapely.ops import nearest_points
# Green pockets, each on land the villas sell least on: Phase 2's steep west edge by the west lake (outlook 0.38
# against the phase's 0.44) and Phase 3's Rule 22 slope.
g1 = carve("C09", box(0, 205, 5000, 285), strip.area / AC, "W") if STRIP_KEPT else Polygon()
g2 = carve_disk("C17", (522, 245), 0.30)
# Owner 8 Oct: part of the ponds counts toward the 8.3 ac: a pond counts where a park gives it a landscaped edge
# (the north pond in its park, the south pond with a bank walk). The south pond's park is that bank, a strip of the
# Phase 4 villa land along the water, as wide as the open space still needs (6 m at least, KMBR Rule 31(vi)).
WATER = mask_poly(layer("waterlogging")).intersection(PARCEL).buffer(0)
north_pond = max((g for g in getattr(WATER.intersection(KEPT[0].buffer(6)), "geoms", [WATER.intersection(KEPT[0].buffer(6))])), key=lambda g: g.area)
north_pond = [g for g in getattr(WATER, "geoms", [WATER]) if g.intersects(north_pond)]
south_pond = [g for g in getattr(WATER, "geoms", [WATER]) if g.distance(Point(560, 55)) < 25]
taken_now = unary_union([z["geom"] for z in Z] + KEPT + [g for g, _ in EXTRA] + [g1, g2])
# Off the owner's south road, which runs along the south pond.
LAKES = [(unary_union(north_pond).difference(taken_now).difference(SOUTH_ROAD).buffer(0), "NORTH POND (WATER)", 1),
         (unary_union(south_pond).difference(taken_now).difference(SOUTH_ROAD).buffer(0), "SOUTH POND (WATER)", 4)]
lakes_ac = sum(g.area for g, _, _ in LAKES) / AC
# (Client 12 Oct: the fixed roads are already off the parks; no allowance for roads crossing them.)
need = OS_TARGET - kept_ac - extra_ac - lakes_ac - (g1.area + g2.area) / AC * (1 - POCKET_STREETS)
SOUTH_WATER = unary_union(south_pond)
bank = None
for w in [6 + 0.5 * k for k in range(0, 120)]:
    bank = ZD["C18"]["geom"].intersection(SOUTH_WATER.buffer(w + 3)).buffer(0)
    if bank.area / AC >= need:
        break
ZD["C18"]["geom"] = ZD["C18"]["geom"].difference(bank).buffer(0)
for i, (g, where, ph) in enumerate(((g1, "by the west lake", 2), (g2, "Phase 3 slope", 3)), 1):
    if g.is_empty:
        continue
    Z.append(dict(component=f"OS-G{i}", name=f"GREEN POCKET {i} ({where})", use="park", phase=ph, model_ac=round(g.area / AC, 3), geom=g.buffer(0), within="villas"))
Z.append(dict(component="OS-G3", name="SOUTH POND BANK WALK", use="park", phase=4, model_ac=round(bank.area / AC, 3), geom=bank))
for i, (g, where, ph) in zip((1, 3, 4), [(g, w, p) for g, w, p in zip(KEPT, ("NORTH POND", "NORTH-WEST CORNER", "SOUTH-EAST CORNER"), (1, 2, 2))]):
    Z.append(dict(component=f"OS-{i}", name=f"OPEN SPACE · {where}", use="park", phase=ph, model_ac=round(g.area / AC, 3), geom=g.buffer(0)))
for k, (g, ph) in enumerate(EXTRA, 5):
    Z.append(dict(component=f"OS-{k}", name=f"OPEN SPACE · POCKET PARK {k - 4}", use="park", phase=ph, model_ac=round(g.area / AC, 3), geom=g.buffer(0)))
for k, (g, where, ph) in enumerate(LAKES, 1):
    Z.append(dict(component=f"OS-W{k}", name=f"LAKE · {where}", use="park", phase=ph, model_ac=round(g.area / AC, 3), geom=g, water=True))
pockets_net = (g1.area + g2.area) / AC * (1 - POCKET_STREETS) + bank.area / AC
for c in ("C09", "C17", "C18"):
    ZD[c]["model_ac"] = round(ZD[c]["geom"].area / AC, 3)
print(f"open space: kept {kept_ac:.2f} + small parks {extra_ac:.2f} + ponds {lakes_ac:.2f} + pockets and bank {pockets_net:.2f} net "
      f"= {kept_ac + extra_ac + lakes_ac + pockets_net:.2f} ac (model {OS_TARGET}); "
      f"villa land {sum(ZD[c]['geom'].area for c in ('C03', 'C09', 'C17', 'C18')) / AC:.2f} ac (model 19.94)")


# --- Variant "green pockets" (owner 9 Oct, options D3/D4): two pieces of the designated open space become villas,
# the dry ground west of the north pond (between the entry road and the pond, Phase 1) and the west end of the south
# pond's bank walk (Phase 4), and the same open space comes back as small pocket gardens in the middle of the villa
# blocks, to break the long runs of villas. The open space stays the model's 8.3 ac.
GREEN_POCKETS = "--pockets" in sys.argv
# --- Variant "green chain" (owner 9 Oct, options D5/D6): the pockets become one continuous chain: each garden runs
# through its block from one street to the next, and the next block's garden starts across the street, so leaving one
# you walk into the next, lake to lake. The parks give the villas the same two pieces as for the pockets; the chain is
# open space on top (owner: "if the villa density goes down let it be", but not below 300 villas).
GREEN_CHAIN = "--chain" in sys.argv
if GREEN_POCKETS or GREEN_CHAIN:
    # python tools/zoning/draft_model.py --pockets|--chain <base plan.json> <out.geojson>: the gardens are snapped to
    # the base plan's plots (the plan with the same roads), so each one replaces whole plots of its rows.
    _i = sys.argv.index("--pockets" if GREEN_POCKETS else "--chain")
    BASE_PLAN = json.load(open(sys.argv[_i + 1], encoding="utf-8"))
    OUT = os.path.abspath(sys.argv[_i + 2])
    ZD = {z["component"]: z for z in Z}
    WET6 = WET.buffer(6)                                        # the ponds keep a 6 m green rim
    VZ = ("C03", "C09", "C17", "C18")
    BYNAME = {z["name"]: z for z in Z}
    # The pocket gardens where the owner's sketch puts them: two in the north-west lobe, five across the middle
    # block, two in the south-east block. Each is two plots side by side on one street (about 21 x 20 m), so the
    # rows either side stay whole and the garden fronts the street (KMBR Rule 31(vi)).
    CENTRES = [(232, 458), (228, 365), (387, 343), (346, 277), (433, 282), (516, 329), (569, 296), (543, 208), (500, 145)]
    plots = [(Polygon(q["ring"]), q) for q in BASE_PLAN["plots"]]
    used = set()
    gardens = []
    for c in (CENTRES if GREEN_POCKETS else []):
        pt = Point(c)
        cand = sorted((k for k in range(len(plots)) if k not in used), key=lambda k: plots[k][0].centroid.distance(pt))
        a0 = cand[0]
        pa, qa = plots[a0]
        # its neighbour in the row: same street, sharing a side
        nb = [k for k in cand[1:12] if plots[k][1]["roadId"] == qa["roadId"] and plots[k][0].buffer(0.3).intersection(pa.buffer(0.3)).area > 4]
        pick = [a0] + nb[:1]
        # KMBR Rule 31(vi): no piece of open space under 200 m2: a garden that falls short takes the next touching plot.
        for k in cand[1:16]:
            if sum(plots[q][0].area for q in pick) >= 200:
                break
            if k not in pick and any(plots[k][0].buffer(0.3).intersection(plots[q][0].buffer(0.3)).area > 4 for q in pick):
                pick.append(k)
        used.update(pick)
        g = unary_union([plots[k][0].buffer(0.25) for k in pick]).buffer(-0.25).buffer(0)
        zone = BYNAME.get(qa["zone"]) or ZD[min(VZ, key=lambda v: ZD[v]["geom"].distance(pt))]
        gardens.append((g, zone))
    if GREEN_CHAIN:
        # The chain's line: from the west lake east across the middle block, over the existing road and south through
        # the south-east block to the south pond's bank walk; and down the north-west lobe from its corner park to the
        # west lake. Each crosses the villa rows square, so a garden spans its block street to street. Every plot within
        # CHAIN_HALF of the line is garden (about two plots wide), and the gardens widen to a pocket at the beads.
        CHAIN = [LineString([(360, 352), (398, 343), (470, 336), (560, 318), (575, 295), (548, 212), (508, 150), (515, 105)]),
                 LineString([(258, 560), (237, 455), (233, 380), (275, 370)])]
        BEADS = [(237, 455), (398, 343), (500, 333), (575, 300), (528, 180)]
        CHAIN_HALF, BEAD_R = float(os.environ.get("CHAIN_HALF", 0)), float(os.environ.get("BEAD_R", 3))
        line = unary_union(CHAIN)
        pick = [k for k, (g, _) in enumerate(plots) if g.distance(line) <= CHAIN_HALF or min(g.distance(Point(b)) for b in BEADS) <= BEAD_R]
        merged = unary_union([plots[k][0].buffer(0.3) for k in pick]).buffer(-0.3).buffer(0)
        for g in getattr(merged, "geoms", [merged]):
            if g.area < 200:
                continue
            inside = [plots[k][1] for k in pick if plots[k][0].representative_point().within(g.buffer(0.5))]
            names = [q["zone"] for q in inside]
            zname = max(set(names), key=names.count) if names else None
            zone = BYNAME.get(zname) or ZD[min(VZ, key=lambda v: ZD[v]["geom"].distance(g))]
            gardens.append((g.buffer(0), zone))
        gardens.sort(key=lambda t: (-t[0].centroid.y, t[0].centroid.x))
        print(f"green chain: {len(pick)} plots of the base plan's {len(plots)} become garden ({len(plots) - len(pick)} left)")
    pocket_ac = sum(g.area for g, _ in gardens) / AC

    def _to_villas(park, region, villa):
        g = ZD[park]["geom"].intersection(region).difference(WET6).buffer(-3).buffer(3).buffer(0)
        ZD[park]["geom"] = ZD[park]["geom"].difference(g).buffer(0)
        ZD[villa]["geom"] = unary_union([ZD[villa]["geom"], g]).buffer(0)
        return g.area / AC

    # The parks give the villas about what the gardens take: the west end of the bank walk (to x = 500) and the dry
    # ground west of the north pond from the client's road to x = 408 (fixed, so the villa land's outline, and with it
    # the street grid, stays the same whichever plots the gardens are snapped to).
    # (Client 12 Oct: the bank walk's west end now stays park: giving it to the villas changed the south-east block's
    # outline enough to turn its grid and lose ten villas; the north pond's dry west side gives all of it instead.)
    _bank_x = float(os.environ.get("BANK_X", 0))
    moved = _to_villas("OS-G3", box(0, 0, _bank_x, 300), "C18") if _bank_x > 0 else 0.0
    lo = float(os.environ.get("OS1_X", 408))
    moved += _to_villas("OS-1", box(330, 380, lo, 520), "C03")
    for k, (g, zone) in enumerate(gardens, 1):
        for v in VZ:                                            # a plot may straddle a phase line
            ZD[v]["geom"] = ZD[v]["geom"].difference(g).buffer(0)
        tag, nm = ("OS-P", "POCKET GARDEN") if GREEN_POCKETS else ("OS-C", "GREEN CHAIN")
        Z.append(dict(component=f"{tag}{k}", name=f"{nm} {k}", use="park", phase=zone["phase"], model_ac=round(g.area / AC, 3), geom=g, within="villas", pocket="plots"))
    for c in VZ + ("OS-1", "OS-G3"):
        ZD[c]["model_ac"] = round(ZD[c]["geom"].area / AC, 3)
    print(f"{'green pockets' if GREEN_POCKETS else 'green chain'}: {moved:.2f} ac of park to villas (OS-1 to x {lo:.0f}); {len(gardens)} pocket gardens, {pocket_ac:.2f} ac; "
          f"villa land {sum(ZD[c]['geom'].area for c in VZ) / AC:.2f} ac")


def main():
    feats = []
    for z in Z:
        g = z["geom"]
        polys = [p for p in (g.geoms if hasattr(g, "geoms") else [g]) if p.geom_type == "Polygon" and p.area > 1]
        geom = mapping(shapely.MultiPolygon(polys))
        ac = g.area / AC
        feats.append({"type": "Feature", "geometry": geom, "properties": {
            "name": z["name"], "use": z["use"], "phase": z["phase"], "component": z["component"],
            "label_area_ac": z["model_ac"], "drawn_area_ac": round(ac, 3), "in_scope_ac": round(ac, 3), "geometry_confidence": "drawn",
            **({"within": z["within"]} if z.get("within") else {}), **({"water": True} if z.get("water") else {}),
            **({"pocket": z["pocket"]} if z.get("pocket") else {})}})
        flag = "" if abs(ac - z["model_ac"]) <= 0.05 else "   <-- off the model"
        print(f"{z['component']} P{z['phase']} {z['name']:30s} model {z['model_ac']:5.2f}  drawn {ac:5.2f}{flag}")
    used = unary_union([z["geom"] for z in Z])
    for i, a in enumerate(Z):
        for b in Z[i + 1:]:
            o = a["geom"].intersection(b["geom"]).area / AC
            if o > 0.005:
                sys.exit(f"overlap {a['component']} {b['component']}: {o:.3f} ac")
    print(f"zones {used.area / AC:.2f} ac (model 53.94); left for trunk roads and open space {PARCEL.difference(used).area / AC:.2f} ac (model 19.06)")
    fc = {"type": "FeatureCollection", "name": "zones_draft_model",
          "note": "Draft financial model zoning (tools/zoning/draft_model.py); local metres (site_origin.json)", "features": feats}
    fc["name"] = os.path.splitext(os.path.basename(OUT))[0]
    json.dump(fc, open(OUT, "w", encoding="utf-8"))
    print("wrote", os.path.relpath(OUT, REPO))


if __name__ == "__main__":
    main()
