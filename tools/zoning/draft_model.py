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


def cz(prefix):
    """A client zone (by name prefix), in scope and off the waterlogged ground."""
    return unary_union([g for n, g in CLIENT.items() if n.upper().startswith(prefix.upper())]).difference(WET).buffer(0)


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
# The entry road as planning_rules.yaml bases.draft_model roads.owner_routes draws it (primary, 10 m).
ENTRY = LineString([(340, 662), (334, 630), (331, 600), (329, 575), (326, 540), (325, 440), (329, 370), (332, 348)])
ENTRY_ROAD = ENTRY.buffer(5, cap_style=2)
EAST_OF_ENTRY = ENTRY.buffer(400, single_sided=True, cap_style=2)   # the line runs south: its left is east
RETAIL_DEPTH = 45                                              # one row of high-street blocks with its yards
retail_band = ENTRY.buffer(5 + RETAIL_DEPTH, single_sided=True, cap_style=2).difference(ENTRY_ROAD)
retail, _ = take(unary_union([COMM, P1V]).intersection(retail_band).intersection(above(380)), 1.5, "N")
COMM = COMM.difference(retail)
P1V = P1V.difference(retail)
comm_rest = COMM.intersection(below(575))                      # the gate wing west of the road stays open
strip = comm_rest.intersection(above(400)).intersection(below(560))
h_top, _ = take(strip, 5.0 - P4V.area / AC, "W")
comm_rest = comm_rest.difference(h_top)
add("C12", "RETAIL & F&B HIGH STREET", "retail", 3, 1.5, retail)
add("C06", "HOSPITAL", "hospital", 2, 5.0, unary_union([P4V, h_top]))      # NW lobe: on the main road, highway side
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
add("C09", "VILLAS · PHASE 2", "villas", 2, 4.985, v2)
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
# Villa clubhouse 2 and its mini-golf on the land west of the entry road, by the central lake.
ch2, _ = take(COMM.difference(ENTRY_ROAD).difference(EAST_OF_ENTRY).difference(h_top).intersection(below(575)), 1.2, "S")
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
KEPT = [piece_at(FREE, pt) for pt in ((470, 500), (309, 489), (274, 603), (828, 146))]
kept_ac = sum(g.area for g in KEPT) / AC
# The villa streets run on through the pockets (so each fronts a street): the pockets are drawn larger by the
# streets' share of the grid, 6.5 m of street to every 46.5 m (14%), so the open space net of them is the model's.
POCKET_STREETS = 0.14
pockets_net = OS_TARGET - kept_ac
pockets_ac = pockets_net / (1 - POCKET_STREETS)
# The villa land the pockets take is given back from the south land and the strip south of Phase 2.
strip = FREE.intersection(box(300, 150, 465, 190))
strip = max(getattr(strip, "geoms", [strip]), key=lambda g: g.area)
south_all = piece_at(FREE, (540, 130))
south, south_rim = take(south_all, pockets_ac - strip.area / AC, "N")
ZD["C09"]["geom"] = unary_union([ZD["C09"]["geom"], strip]).buffer(0)
ZD["C18"]["geom"] = unary_union([ZD["C18"]["geom"], south]).buffer(0)
# The pockets: Phase 2 gives back what the strip added (on its steep west edge by the west lake), Phase 3 its
# Rule 22 slope, Phase 4 the rest (its middle, and its south edge stepping down to the south pond).


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
g1 = carve("C09", box(0, 205, 5000, 285), strip.area / AC, "W")          # Phase 2's steep west edge, by the west lake
g2 = carve_disk("C17", (522, 245), 0.30)                                 # Phase 3's Rule 22 slope
rest = pockets_ac - (g1.area + g2.area) / AC
g3 = carve_disk("C18", (585, 215), rest / 2)                             # the middle of Phase 4
to_pond = nearest_points(ZD["C18"]["geom"], Point(560, 55))[0]
g4 = carve_disk("C18", (to_pond.x, to_pond.y), rest - g3.area / AC)      # Phase 4's south edge, down to the south pond
for i, (g, where) in enumerate(((g1, "by the west lake"), (g2, "Phase 3"), (g3, "Phase 4"), (g4, "to the south pond")), 1):
    Z.append(dict(component=f"OS-G{i}", name=f"GREEN POCKET {i} ({where})", use="park", phase=0, model_ac=round(g.area / AC, 3), geom=g.buffer(0), within="villas"))
for i, (g, where) in enumerate(zip(KEPT, ("NORTH POND", "GATE WEST WING", "NORTH-WEST CORNER", "SOUTH-EAST CORNER")), 1):
    Z.append(dict(component=f"OS-{i}", name=f"OPEN SPACE · {where}", use="park", phase=0, model_ac=round(g.area / AC, 3), geom=g.buffer(0)))
for c in ("C09", "C17", "C18"):
    ZD[c]["model_ac_note"] = "villa land after the open-space swap"
print(f"open space: kept {kept_ac:.2f} ac + pockets {pockets_ac:.2f} ac drawn ({pockets_net:.2f} ac net of streets) = {kept_ac + pockets_net:.2f} ac net (model {OS_TARGET}); "
      f"villa land {sum(ZD[c]['geom'].area for c in ('C03', 'C09', 'C17', 'C18')) / AC:.2f} ac (model 19.94); south rim left open {south_rim.area / AC:.2f} ac")

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
            **({"within": z["within"]} if z.get("within") else {})}})
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
    json.dump(fc, open(OUT, "w", encoding="utf-8"))
    print("wrote", os.path.relpath(OUT, REPO))


if __name__ == "__main__":
    main()
