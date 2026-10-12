"""Green inside the villa land, for options D3-D6 (owner 12 Oct 2026), on the optimised zoning (tools/zoning/optimise.py).

  python tools/zoning/greens.py pockets <base plan.json> <out.geojson>   D3/D4
  python tools/zoning/greens.py link    <base plan.json> <out.geojson>   D5/D6

The base plan is the plan of D1 (terrain roads) or D2 (north-south roads) on the optimised zoning; the gardens are
whole plots of it, so each fronts a street (KMBR Rule 31(vi)) and the rows either side stay whole.

pockets: no villa further than 150 m walk from green (a park, a lake's bank, a clubhouse, or a pocket). The walk runs
  along the plan's roads and through the parks, from the plot's front. Pockets go one at a time where one reaches the
  most villas still out of reach (sparse, and so spread evenly); each is two or three plots on one street (about 0.1 ac).
link: one green link through the villas, joining every park, lake and villa clubhouse that touches the villa land:
  the shortest run of plots between them (a minimum spanning tree over the plots, a garden crossing its block street
  to street, the next across the street), so it branches through all the villa blocks rather than one diagonal.
"""
import json
import os
import sys

import numpy as np
import shapely
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import Polygon, MultiPolygon, shape, mapping, Point, LineString
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
AC = 4046.8564224
REACH = 150.0           # m walk to green (owner 12 Oct, D3/D4)
# The owner also asks for the green to be spread evenly across the villas: the pockets are placed to a closer reach,
# SPREAD, so each neighbourhood of villas gets its own (the 150 m rule is then met with room to spare).
SPREAD = float(os.environ.get("SPREAD", 100.0))
LINK_W = float(os.environ.get("LINK_W", 10.0))      # the link's width, m
LINK_GAP = float(os.environ.get("LINK_GAP", 85.0))  # waypoints until no villa land is further than this from green
LINK_PARK_AC = float(os.environ.get("LINK_PARK_AC", 1.0))   # the link joins the lakes, the villa clubs and parks this big
GREEN_MIN_M2 = 1000.0   # a park counts as green from 0.25 ac (a strip of landscape at the edge does not)
POCKET_M2 = 450.0       # a pocket garden: plots on one street until about 0.11 ac (KMBR's 200 m2 minimum met)
STEP = 2.0              # walk raster, m

mode, base_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
assert mode in ("pockets", "link", "check")   # check <plan.json> <zones.geojson>: the walk to green on a finished plan
BASE = json.load(open(base_path, encoding="utf-8"))
ZFC = json.load(open(out_path if mode == "check" else os.path.join(REPO, "data", "processed", "zones_draft_model.geojson"), encoding="utf-8"))
FEATS = ZFC["features"]
ZG = [shape(f["geometry"]).buffer(0) for f in FEATS]
PR = [f["properties"] for f in FEATS]
VILLA = [k for k, p in enumerate(PR) if p["use"] == "villas"]
GREEN = [k for k, p in enumerate(PR) if (p["use"] == "park" and (p.get("water") or p.get("within") or ZG[k].area >= GREEN_MIN_M2)) or p["use"] == "clubhouse"]

PLOTS = [Polygon(q["ring"]) for q in BASE["plots"]]
PQ = BASE["plots"]
N = len(PLOTS)


def mp(coords):
    return MultiPolygon([Polygon(r[0], r[1:]) for r in coords]).buffer(0)


ROADS = unary_union([mp(r["geom"]) for r in BASE["roads"]]).buffer(0.5)
PARCEL = unary_union([shape(f["geometry"]).buffer(0) for f in json.load(open(os.path.join(REPO, "data", "processed", "parcel.geojson"), encoding="utf-8"))["features"]
                      if f["properties"].get("status", "in_scope") == "in_scope"])
PARCEL_ROADS = PARCEL.difference(unary_union(ZG)).buffer(0)       # the land no zone takes: the fixed and existing roads
green_poly = unary_union([ZG[k] for k in GREEN]).buffer(0)
walk_poly = unary_union([ROADS, unary_union([ZG[k] for k in GREEN if not PR[k].get("water")])]).buffer(0)

# --- the walk raster
x0, y0, x1, y1 = walk_poly.bounds
nx, ny = int((x1 - x0) / STEP) + 2, int((y1 - y0) / STEP) + 2
gx, gy = np.meshgrid(x0 + STEP * (np.arange(nx) + 0.5), y0 + STEP * (np.arange(ny) + 0.5))
WALK = shapely.contains_xy(walk_poly.buffer(1.0), gx, gy)
idx = -np.ones((ny, nx), int)
idx[WALK] = np.arange(int(WALK.sum()))
rows, cols, w = [], [], []
for dj, di, d in ((0, 1, STEP), (1, 0, STEP), (1, 1, STEP * 2 ** 0.5), (1, -1, STEP * 2 ** 0.5)):
    a = idx[max(0, -dj):ny - max(0, dj), max(0, -di):nx - max(0, di)]
    b = idx[max(0, dj):ny + min(0, dj), max(0, di):nx + min(0, di)]
    ok = (a >= 0) & (b >= 0)
    rows += list(a[ok]); cols += list(b[ok]); w += [d] * int(ok.sum())
M = int(WALK.sum())
GRAPH = coo_matrix((w + w, (rows + cols, cols + rows)), shape=(M, M)).tocsr()
CELL_XY = np.column_stack([gx[WALK], gy[WALK]])


def nodes_near(geom, d):
    """Walk-raster nodes within d of geom."""
    near = shapely.contains_xy(geom.buffer(d), CELL_XY[:, 0], CELL_XY[:, 1])
    return np.nonzero(near)[0]


FRONT = [nodes_near(p, 3.0) for p in PLOTS]


def dist_from(geoms):
    src = np.unique(np.concatenate([nodes_near(g, 4.0) for g in geoms])) if geoms else np.array([], int)
    if len(src) == 0:
        return np.full(M, np.inf)
    return dijkstra(GRAPH, indices=src, min_only=True)


def plot_dist(dn):
    return np.array([dn[f].min() if len(f) else np.inf for f in FRONT])


base_d = plot_dist(dist_from([green_poly]))
print(f"{N} villas in the base plan; {int((base_d > REACH).sum())} further than {REACH:.0f} m walk from green "
      f"(farthest {np.nanmax(np.where(np.isfinite(base_d), base_d, np.nan)):.0f} m)")


def touching(a, b):
    return PLOTS[a].buffer(0.4).intersection(PLOTS[b].buffer(0.4)).area > 3


gardens = []           # lists of plot indices
# plot-to-plot walk distances within REACH, from each plot's front
PP = np.full((N, N), np.inf)
for a in range(N):
    if len(FRONT[a]):
        PP[a] = plot_dist(dijkstra(GRAPH, indices=FRONT[a], min_only=True, limit=REACH + 10))


def cover(cur, target, used, label):
    """Pockets, one at a time where one brings the most villas still further than target within it."""
    out_gardens = []
    while (cur > target).any():
        out = cur > target
        best, gain = None, 0
        for a in range(N):
            if a in used:
                continue
            g = int((out & (PP[a] <= target - 10)).sum())       # the garden's edge is the plot's front, less its own frontage
            if g > gain:
                best, gain = a, g
        if best is None:
            break
        pick = [best]
        for b in sorted(range(N), key=lambda b: PLOTS[b].centroid.distance(PLOTS[best].centroid))[1:10]:
            if sum(PLOTS[q].area for q in pick) >= POCKET_M2 or len(pick) >= 3:
                break
            if b not in used and PQ[b]["roadId"] == PQ[best]["roadId"] and any(touching(b, q) for q in pick):
                pick.append(b)
        used.update(pick)
        out_gardens.append(pick)
        for q in pick:
            cur = np.minimum(cur, PP[q] + 10)
        cur[pick] = 0
        print(f"  {label} {len(out_gardens)}: {len(pick)} plots by {PQ[best]['roadId']}, brings {gain} villas within {target:.0f} m")
    return out_gardens


if mode == "check":
    far = int((base_d > REACH).sum())
    print(f"CHECK {os.path.basename(base_path)}: {N} villas; walk to green mean {base_d.mean():.0f} m, farthest {base_d.max():.0f} m; "
          f"{far} over {REACH:.0f} m; within {SPREAD:.0f} m: {int((base_d <= SPREAD).sum())}")
    json.dump({"villas": N, "meanM": round(float(base_d.mean()), 1), "maxM": round(float(base_d.max()), 1), "over150": far},
              open(base_path.replace(".json", "_walk.json"), "w"))
    sys.exit(0)
if mode == "pockets":
    gardens = cover(base_d.copy(), SPREAD, set(), "pocket")
else:
    # The link as a corridor, LINK_W wide, drawn through the villa land (the plan lays its plots round it, the streets
    # running on through, owner 7 Oct): a tree joining the greens that touch the villa land (the lakes, the villa clubs,
    # parks from LINK_PARK_AC) and waypoints in the villa land furthest from any green, added until no villa land is
    # further than LINK_GAP (straight line) from green or a waypoint; each next branch is the cheapest path from the
    # tree so far to the nearest terminal not yet on it (a Steiner tree, Prim's way).
    R = 4.0
    villa_poly = unary_union([ZG[k] for k in VILLA]).buffer(0)
    vx0, vy0, vx1, vy1 = villa_poly.buffer(30).bounds
    rnx, rny = int((vx1 - vx0) / R) + 1, int((vy1 - vy0) / R) + 1
    rx, ry = np.meshgrid(vx0 + R * (np.arange(rnx) + 0.5), vy0 + R * (np.arange(rny) + 0.5))
    VIL = shapely.contains_xy(villa_poly.buffer(-LINK_W / 2), rx, ry)
    # the link may cross a street, an existing road or a park on the way (at three times the cost of villa land)
    other = unary_union([ROADS.buffer(2), walk_poly, unary_union([ZG[k] for k in GREEN if not PR[k].get("water")])])
    other = unary_union([other, PARCEL_ROADS]).buffer(0)
    PASS = VIL | shapely.contains_xy(other, rx, ry)
    ridx = -np.ones((rny, rnx), int)
    ridx[PASS] = np.arange(int(PASS.sum()))
    rr, cc, ww = [], [], []
    for dj, di, d in ((0, 1, R), (1, 0, R), (1, 1, R * 2 ** 0.5), (1, -1, R * 2 ** 0.5)):
        sa = (slice(max(0, -dj), rny - max(0, dj)), slice(max(0, -di), rnx - max(0, di)))
        sb = (slice(max(0, dj), rny + min(0, dj)), slice(max(0, di), rnx + min(0, di)))
        a, b = ridx[sa], ridx[sb]
        ok = (a >= 0) & (b >= 0)
        both = (VIL[sa] & VIL[sb])[ok]
        rr += list(a[ok]); cc += list(b[ok]); ww += list(np.where(both, d, 3 * d))
    RM = int(PASS.sum())
    RG = coo_matrix((ww + ww, (rr + cc, cc + rr)), shape=(RM, RM)).tocsr()
    RXY = np.column_stack([rx[PASS], ry[PASS]])
    ONVIL = VIL[PASS]
    terminals = []
    for k in GREEN:
        p = PR[k]
        if p["use"] == "clubhouse" and not p["name"].startswith("VILLA"):
            continue
        if p["use"] == "park" and not p.get("water") and ZG[k].area < LINK_PARK_AC * AC:
            continue
        near = np.nonzero(shapely.contains_xy(ZG[k].buffer(LINK_W / 2 + 6), RXY[:, 0], RXY[:, 1]) & ONVIL)[0]
        if len(near):
            terminals.append((p["name"], near))
    # waypoints: the villa land furthest from green, then furthest from green and the waypoints so far
    vcells = np.nonzero(ONVIL)[0]
    dd = np.array([green_poly.distance(Point(*RXY[q])) for q in vcells])
    nway = 0
    while dd.max() > LINK_GAP:
        q = int(np.argmax(dd))
        nway += 1
        dd = np.minimum(dd, np.hypot(*(RXY[vcells] - RXY[vcells[q]]).T))
        terminals.append((f"waypoint {nway}", np.array([vcells[q]])))
    print(f"  terminals: {len(terminals)} ({nway} waypoints)")
    tree_nodes = set(terminals[0][1].tolist())
    joined = {0}
    PATHS = []
    while len(joined) < len(terminals):
        d, pr, _ = dijkstra(RG, indices=np.array(sorted(tree_nodes)), min_only=True, return_predecessors=True)
        best, bd, bq = None, np.inf, None
        for t, (_, cells) in enumerate(terminals):
            if t in joined:
                continue
            q = cells[int(np.argmin(d[cells]))]
            if d[q] < bd:
                best, bd, bq = t, d[q], q
        if best is None or not np.isfinite(bd):
            print("  unreachable:", [terminals[t][0] for t in range(len(terminals)) if t not in joined])
            break
        path = [int(bq)]
        while pr[path[-1]] >= 0:
            path.append(int(pr[path[-1]]))
        joined.add(best)
        tree_nodes.update(path)
        tree_nodes.update(terminals[best][1].tolist())
        if len(path) > 1:
            PATHS.append(LineString(RXY[path]).simplify(R * 1.5))
        print(f"  + {terminals[best][0]}: {bd:.0f} m")
    corridor = unary_union([ln.buffer(LINK_W / 2, cap_style=1, join_style=2) for ln in PATHS]).intersection(villa_poly)
    corridor = corridor.buffer(-1).buffer(1).buffer(0)
    gardens = [q for q in getattr(corridor, "geoms", [corridor]) if q.area >= 200]
    print(f"green link: {sum(q.area for q in gardens) / AC:.2f} ac in {len(gardens)} pieces, {sum(ln.length for ln in PATHS):.0f} m of line")
    # a pocket on the link where a villa would still be over 150 m walk from green
    on_link = {a for a in range(N) if PLOTS[a].intersection(corridor).area >= 0.3 * PLOTS[a].area}
    cur = plot_dist(dist_from([green_poly, corridor]))
    cur[list(on_link)] = 0
    gardens += cover(cur, REACH, set(on_link), "pocket")

# --- the zoning: villa land less the gardens; each garden a park inside the villas
gpolys = []
for item in gardens:
    g = unary_union([PLOTS[q].buffer(0.3) for q in item]).buffer(-0.3).buffer(0) if isinstance(item, list) else item
    if g.area >= 200:
        gpolys.append(g)
allg = unary_union(gpolys).buffer(0)
VILLA0 = {k: ZG[k] for k in VILLA}
for k in VILLA:
    ZG[k] = ZG[k].difference(allg).buffer(0)
out = []
for k, f in enumerate(FEATS):
    if k in VILLA:
        f = dict(f, geometry=mapping(ZG[k]), properties=dict(f["properties"], drawn_area_ac=round(ZG[k].area / AC, 3),
                                                             in_scope_ac=round(ZG[k].area / AC, 3), label_area_ac=round(ZG[k].area / AC, 3)))
    out.append(f)
tag, nm = ("OS-P", "POCKET GARDEN") if mode == "pockets" else ("OS-L", "GREEN LINK")
gpolys.sort(key=lambda g: (-g.centroid.y, g.centroid.x))
for n, g in enumerate(gpolys, 1):
    k = max(VILLA, key=lambda k: VILLA0[k].intersection(g).area)
    polys = [p for p in getattr(g, "geoms", [g]) if p.area > 1]
    out.append({"type": "Feature", "geometry": mapping(MultiPolygon(polys)), "properties": {
        "name": f"{nm} {n}", "use": "park", "phase": PR[k]["phase"], "component": f"{tag}{n}", "label_area_ac": round(g.area / AC, 3),
        "drawn_area_ac": round(g.area / AC, 3), "in_scope_ac": round(g.area / AC, 3), "geometry_confidence": "optimised",
        "within": "villas", "pocket": "plots" if mode == "pockets" else "corridor", "green": "zone",
        "why": "green inside the villa land: " + ("a pocket so no villa is over 150 m walk from green" if mode == "pockets" else "the green link joining the parks, lakes and clubs through the villas"),
        "pieces": len(polys)}})

# check against the base plan's plots: the walk from every villa left to green, the gardens included
left = [a for a in range(N) if PLOTS[a].intersection(allg).area < 0.3 * PLOTS[a].area]
d_after = plot_dist(dist_from([green_poly, allg]))
far = [a for a in left if d_after[a] > REACH]
print(f"walk to green: mean {np.mean([d_after[a] for a in left]):.0f} m; within {SPREAD:.0f} m: {sum(d_after[a] <= SPREAD for a in left)} of {len(left)}")
print(f"{len(gpolys)} gardens, {allg.area / AC:.2f} ac; about {len(left)} of the base plan's {N} villas left; "
      f"{len(far)} further than {REACH:.0f} m (farthest {max(d_after[a] for a in left):.0f} m); villa land {sum(ZG[k].area for k in VILLA) / AC:.2f} ac")
json.dump(dict(ZFC, name=os.path.splitext(os.path.basename(out_path))[0], features=out), open(out_path, "w", encoding="utf-8"))
print("wrote", os.path.relpath(out_path, REPO))
