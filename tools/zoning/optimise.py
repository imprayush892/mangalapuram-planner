"""Optimised zoning (owner 12 Oct 2026): where each use goes and how much land it takes, worked out from the site
rather than from the client's zoning plan or the draft model's land figures.

How much land: each use's built area at KMBR's free FSI (Table 6, config/kmbr_rules.yaml), or a stated minimum where
the use needs open ground (the school's play fields, the clubhouses); the villas take what is left, held to the owner's
density (at most 15 an acre, about 350-370 villas). Where: each use is grown as one compact piece on the 20 m grid
(site_grid.py) where it scores best:
  - retail and office front the client's 18 m road (owner 12 Oct, non-negotiable), 40% in Phase 1 by the gate and
    60% in Phase 3 further down it;
  - apartment towers and senior blocks where they hide least of the villas' outlook (view cost), on ground with
    little outlook of its own;
  - the school on the flattest ground on a fixed road;
  - the villas on the ground with the widest outlook; the phases run outward from the gate;
  - the public open space round the three lakes, on the ground with the least outlook, linked to them;
  - the clubhouses (open space too) at the middle of the villas they serve.
Writes data/processed/zones_draft_model.geojson (the plan's draft-model zoning) and a report.

Run: python tools/zoning/optimise.py   (after `node app/scripts/export-layers.mjs`)
"""
import heapq
import json
import os
import sys

import numpy as np
import shapely
import yaml
from scipy import ndimage
from scipy.sparse import lil_matrix
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import box, mapping, Polygon, MultiPolygon
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from site_grid import *  # noqa: E402,F401

OUT = os.path.join(REPO, "data", "processed", "zones_draft_model.geojson")
KMBR = yaml.safe_load(open(f"{REPO}/config/kmbr_rules.yaml", encoding="utf-8"))["table6_coverage_fsi"]
SQFT_AC = 43560.0
VP, TALL, LOW = view_analysis()
VPn = np.nan_to_num(VP) / max(1e-9, np.nanmax(VP))
TALLn = TALL / max(1e-9, TALL[USABLE].max())
LOWn = LOW / max(1e-9, LOW[USABLE].max())
SLOPEn = np.clip(np.nan_to_num(SLOPE) / 0.5, 0, 1)
# The airport limit (planning_rules airport): the floors a tower can have on each cell, its top under the AAI line.
_air = RULES["airport"]
CAP_RL = _air["permissible_top_amsl_m"] - _air["tbm_amsl_m"] + _air["tbm_rl"]
FLOORS_CAP = np.floor((CAP_RL - _air["rooftop_allowance_m"] - np.nan_to_num(coarse(np.where(TERRAIN, DEM, np.nan), "max"), nan=999)) / 3.0)
TOWER_FLOORS = 20                                             # planning_rules apartments.max_floors
# a cell that cannot take a full-height tower costs a tower zone in proportion; one under 12 floors is not a tower site
TOWER_FIT = np.where(FLOORS_CAP >= 12, np.clip((TOWER_FLOORS - FLOORS_CAP) / TOWER_FLOORS, 0, 1) * 3.0, np.inf)

# --------------------------------------------------------------------------------------------- land per use
FSI = {"residential": KMBR["A1_residential"]["fsi"][0], "office": KMBR["E_office"]["fsi"][0],
       "commercial": KMBR["F_commercial"]["fsi"][0], "school": KMBR["B_upto_higher_secondary"]["fsi"][0]}
# (component, use, phase, name, land in acres, how the land is sized)
def fsi_ac(bua, fsi):
    return bua / (fsi * SQFT_AC)


SENIOR_FSI = 1.35         # ASSUMPTION: senior living low-rise (G+3 to G+5, a quarter of the plot built on, gardens round it)
RETAIL_FSI = 2.0          # ASSUMPTION: a G+2 high street with its frontage and parking
COMPONENTS = [
    ("C12-1", "retail", 1, "RETAIL & F&B · PHASE 1", fsi_ac(0.4 * 90000, RETAIL_FSI), "40% of 90,000 sq ft at FSI 2.0 (G+2 high street)"),
    ("C16-1", "office", 1, "COMMERCIAL OFFICE · PHASE 1", fsi_ac(0.4 * 258750, FSI["office"]), "40% of 2,58,750 sq ft at KMBR's free FSI 3"),
    ("C12", "retail", 3, "RETAIL & F&B · PHASE 3", fsi_ac(0.6 * 90000, RETAIL_FSI), "60% of 90,000 sq ft at FSI 2.0"),
    ("C16", "office", 3, "COMMERCIAL OFFICE · PHASE 3", fsi_ac(0.6 * 258750, FSI["office"]), "60% of 2,58,750 sq ft at KMBR's free FSI 3"),
    ("C02", "apartments", 1, "APARTMENTS · PHASE 1", fsi_ac(171350, FSI["residential"]), "1,71,350 sq ft at KMBR's free FSI 3"),
    ("C11", "apartments", 2, "APARTMENTS · PHASE 2", fsi_ac(430790, FSI["residential"]), "4,30,790 sq ft at FSI 3"),
    ("C19", "apartments", 3, "APARTMENTS · PHASE 3", fsi_ac(559590, FSI["residential"]), "5,59,590 sq ft at FSI 3"),
    ("C20", "apartments", 4, "APARTMENTS · PHASE 4", fsi_ac(559590, FSI["residential"]), "5,59,590 sq ft at FSI 3"),
    ("C04", "senior", 1, "SENIOR LIVING · PHASE 1", fsi_ac(38400, SENIOR_FSI), "38,400 sq ft at FSI 1.35 (low-rise)"),
    ("C07", "senior", 2, "SENIOR ENCLAVE · PHASE 2", fsi_ac(192000, SENIOR_FSI), "1,92,000 sq ft at FSI 1.35 (low-rise)"),
    # ASSUMPTION: the school's buildings at KMBR's FSI 2.5 need 1.0 ac; a CBSE-affiliated senior school asks 2 ac of
    # land and the play fields about 1 ac more: 3.0 ac, split by built area between the two stages.
    ("C05", "school", 2, "SCHOOL · STAGE A", 3.0 * 70 / 110, "stage A's share of a 3.0 ac campus (CBSE 2 ac + play fields)"),
    ("C13", "school", 3, "SCHOOL · STAGE B", 3.0 * 40 / 110, "stage B's share of the 3.0 ac campus"),
    # The clubhouses are open space (owner 12 Oct): sized for the building, its lawns and (club 2) the mini-golf.
    ("C08", "clubhouse", 1, "VILLA CLUBHOUSE 1", 0.5, "the draft model's 0.5 ac"),
    ("C15", "clubhouse", 2, "SENIOR CLUBHOUSE", 0.3, "the draft model's 0.3 ac"),
    ("C10", "clubhouse", 3, "VILLA CLUBHOUSE 2 + MINI-GOLF", 1.2, "the draft model's 1.2 ac"),
    ("C14", "clubhouse", 4, "APARTMENT CLUBHOUSE", 1.0, "the draft model's 1.0 ac"),
]
VILLA_TARGET_AC = float(os.environ.get("VILLA_AC", 28.4))   # gross villa land: ~360 villas at the plans' yield
VILLA_PHASE_SHARE = [0.15, 0.25, 0.30, 0.30]                 # the draft model's villa land by phase (Inputs D123-D126)
OPEN_MIN_AC = 0.10 * 73.0                                     # KMBR Rule 31(v): 10% of the layout as public open space

# --------------------------------------------------------------------------------------------- the grid graph
cells = [(j, i) for j in range(GNY) for i in range(GNX) if IN_SITE[j, i]]
idx = {c: n for n, c in enumerate(cells)}
NB = [(-1, 0), (1, 0), (0, -1), (0, 1)]
NB8 = NB + [(-1, -1), (-1, 1), (1, -1), (1, 1)]
A = lil_matrix((len(cells), len(cells)))
ROADC = coarse(ROADMASK.astype(float)) > 0.2
for (j, i), n in idx.items():
    for dj, di in NB8:
        m = idx.get((j + dj, i + di))
        if m is None or LAKE_CELL[j + dj, i + di] or LAKE_CELL[j, i]:
            continue
        step = G * (1.414 if dj and di else 1.0)
        s = 0.5 * (np.nan_to_num(SLOPE[j, i]) + np.nan_to_num(SLOPE[j + dj, i + di]))
        A[n, m] = step * (0.35 if (ROADC[j, i] and ROADC[j + dj, i + di]) else 1.0 + 4.0 * s)
gj, gi = int((GATE[1] - Y0) / G), int((GATE[0] - X0) / G)
gate_n = min(idx.values(), key=lambda n: (cells[n][0] - gj) ** 2 + (cells[n][1] - gi) ** 2)
DIST = np.full((GNY, GNX), np.inf)
d = dijkstra(A.tocsr(), indices=gate_n)
for (j, i), n in idx.items():
    DIST[j, i] = d[n]
fin = np.isfinite(DIST) & USABLE
RANK = np.full((GNY, GNX), np.nan)
order = np.argsort(DIST[fin])
r = np.empty_like(order, dtype=float)
r[order] = np.linspace(0, 1, len(order))
RANK[fin] = r                                                 # 0 at the gate, 1 at the far end

# The pieces of the site the fixed roads and the public road between the parcels cut it into: a zone stays in one.
_site_parts = PARCEL.difference(FIXED_ROADS.buffer(1)).buffer(0)
REGION = np.zeros((GNY, GNX), int)
for _k, _g in enumerate(sorted(getattr(_site_parts, "geoms", [_site_parts]), key=lambda q: -q.area), 1):
    for (j, i) in cells:
        if REGION[j, i] == 0 and _g.contains(shapely.geometry.Point(GX[i], GY[j])):
            REGION[j, i] = _k
for (j, i) in cells:                                         # cells whose centre falls on a road: their nearest piece
    if REGION[j, i] == 0:
        pt = shapely.geometry.Point(GX[i], GY[j])
        parts = sorted(getattr(_site_parts, "geoms", [_site_parts]), key=lambda q: -q.area)
        REGION[j, i] = 1 + min(range(len(parts)), key=lambda q: parts[q].distance(pt))

# --------------------------------------------------------------------------------------------- allocation
OWNER = np.full((GNY, GNX), "", dtype=object)                 # the component each cell goes to
OWNER[LAKE_CELL & IN_SITE] = "LAKE"


def free(j, i):
    return 0 <= j < GNY and 0 <= i < GNX and USABLE[j, i] and OWNER[j, i] == ""


def grow(comp, target_ac, cost, seed_ok=None, grow_ok=None, compact=0.35):
    """Grow `comp` from its cheapest seed, adding the cheapest free neighbour (less a bonus for each side it shares
    with the piece) until it holds `target_ac`. One piece: never a cell that does not touch it."""
    okm = np.zeros((GNY, GNX), bool)
    for (j, i) in cells:
        okm[j, i] = free(j, i) and (grow_ok is None or grow_ok[j, i] or (seed_ok is not None and seed_ok[j, i])) and np.isfinite(cost[j, i])
    lab = np.zeros((GNY, GNX), int)
    _off = 0
    for _r in range(1, REGION.max() + 1):
        _l, _n = ndimage.label(okm & (REGION == _r))
        lab[_l > 0] = _l[_l > 0] + _off
        _off += _n
    room = ndimage.sum_labels(np.where(okm, CELL_AC, 0.0), lab, index=np.arange(lab.max() + 1))
    cand = [(cost[j, i], j, i) for (j, i) in cells if okm[j, i] and (seed_ok is None or seed_ok[j, i]) and room[lab[j, i]] >= target_ac * 0.95]
    if not cand:
        raise SystemExit(f"{comp}: nowhere to start")
    _, j0, i0 = min(cand)
    reg = REGION[j0, i0]
    got = [(j0, i0)]
    OWNER[j0, i0] = comp
    area = CELL_AC[j0, i0]
    heap = []

    def push(j, i):
        for dj, di in NB:
            a, b = j + dj, i + di
            if free(a, b) and REGION[a, b] == reg and (grow_ok is None or grow_ok[a, b]) and np.isfinite(cost[a, b]):
                shared = sum(1 for ej, ei in NB if 0 <= a + ej < GNY and 0 <= b + ei < GNX and OWNER[a + ej, b + ei] == comp)
                heapq.heappush(heap, (cost[a, b] - compact * shared, a, b))

    push(j0, i0)
    while area < target_ac - 0.02 and heap:
        _, a, b = heapq.heappop(heap)
        if not free(a, b):
            continue
        OWNER[a, b] = comp
        got.append((a, b))
        area += CELL_AC[a, b]
        push(a, b)
        # re-score the frontier for compactness
        heap = [(cost[x, y] - compact * sum(1 for ej, ei in NB if 0 <= x + ej < GNY and 0 <= y + ei < GNX and OWNER[x + ej, y + ei] == comp), x, y)
                for _, x, y in heap if free(x, y)]
        heapq.heapify(heap)
    return got, area


report = []
ARM_FRONT = coarse(mask_of(FIXED[2]["line"].buffer(14)).astype(float)) > 0
FRONT = FRONT_MAIN | ARM_FRONT
NEAR_MAIN = ndimage.binary_dilation(FRONT, iterations=2)
inf = np.where(USABLE, 0.0, np.inf)
phase_rank = {1: 0.08, 2: 0.35, 3: 0.6, 4: 0.85}


def phase_cost(p):
    return np.abs(np.nan_to_num(RANK, nan=1.0) - phase_rank[p])


sizes = {c[0]: c for c in COMPONENTS}
# 1 retail and office: on the client's 18 m road (or the gate arm's road into it); Phase 1 by the gate, Phase 3 below
for comp in ("C12-1", "C16-1"):
    _, use, ph, name, ac_, why = sizes[comp]
    cost = inf + np.nan_to_num(RANK, nan=1.0) + 0.3 * VPn + (0.5 * TOWER_FIT if use == "office" else 0)
    got, area = grow(comp, ac_, cost, seed_ok=FRONT, grow_ok=NEAR_MAIN, compact=0.4)
    report.append((comp, area))
for comp in ("C12", "C16"):
    _, use, ph, name, ac_, why = sizes[comp]
    cost = inf + 2.0 * np.abs(np.nan_to_num(RANK, nan=1.0) - 0.55) + 0.6 * VPn + 0.3 * SLOPEn
    got, area = grow(comp, ac_, cost, seed_ok=FRONT_MAIN, grow_ok=None, compact=0.6)
    report.append((comp, area))
# 2 the school: one campus on the flattest ground on a fixed road, little outlook, low buildings
school_cost = inf + 1.6 * SLOPEn + 0.8 * VPn + 0.5 * LOWn + 1.5 * np.abs(np.nan_to_num(RANK, nan=1.0) - 0.3)
got, area = grow("C05", sizes["C05"][4], school_cost, seed_ok=FRONT_FIXED, compact=0.8)
report.append(("C05", area))
got, area = grow("C13", sizes["C13"][4], school_cost + 3.0 * (ndimage.binary_dilation(OWNER == "C05", iterations=1) == 0), compact=0.8)
report.append(("C13", area))
# 3 apartment towers: where a 20-floor tower hides least of anyone's outlook, on ground with little of its own
for comp in ("C20", "C19", "C11", "C02"):
    _, use, ph, name, ac_, why = sizes[comp]
    cost = inf + 2.5 * TALLn + 0.8 * VPn + 0.6 * SLOPEn + 0.7 * phase_cost(ph) + TOWER_FIT
    got, area = grow(comp, ac_, cost, compact=0.8)
    report.append((comp, area))
# the apartment clubhouse next to the Phase 4 towers, before anything else can take the ground round them
got, area = grow("C14", 1.0, inf + 3.0 * (ndimage.binary_dilation(OWNER == "C20", iterations=1) == 0) + VPn, compact=0.8)
report.append(("C14", area))
# 4 senior living (G+3): where a low block hides least, next to the open ground (the enclave's clubhouse follows)
for comp in ("C07", "C04"):
    _, use, ph, name, ac_, why = sizes[comp]
    cost = inf + 2.0 * LOWn + 1.6 * VPn + 0.8 * SLOPEn + 0.6 * phase_cost(ph)
    got, area = grow(comp, ac_, cost, compact=0.8)
    report.append((comp, area))
got, area = grow("C15", 0.3, inf + 3.0 * (ndimage.binary_dilation(OWNER == "C07", iterations=1) == 0) + VPn, compact=0.8)
report.append(("C15", area))

# 5 the villas: grown as a few large pieces from the ground with the widest outlook (not cell by cell, which leaves
# holes); the clubhouses come out of them next, so the villas are grown that much larger
CLUB_AC = sizes["C08"][4] + sizes["C10"][4]
villa_cost = inf - 1.5 * VPn + 0.6 * SLOPEn
acc, k = 0.0, 0
while acc < VILLA_TARGET_AC + CLUB_AC - 0.3:
    k += 1
    try:
        got, area = grow(f"VG{k}", min(VILLA_TARGET_AC + CLUB_AC - acc, 14.0), villa_cost, compact=0.5)
    except SystemExit:
        break
    if area < 1.5:                                   # too small to be a villa block: open space
        for (j, i) in got:
            OWNER[j, i] = ""
        break
    acc += area
OWNER[np.vectorize(lambda o: isinstance(o, str) and o.startswith("VG"))(OWNER)] = "VILLA"
# 6 the villa clubhouses at the middle of the villas: club 1 (Phase 1) among the nearest villas to the gate, club 2
# (Phase 3) at the middle of all of them, both on villa land with the least outlook there
villa = OWNER == "VILLA"
vr = np.where(villa, RANK, np.nan)
for comp, sel in (("C08", villa & (np.nan_to_num(vr, nan=9) <= np.nanquantile(vr, 0.18))), ("C10", villa)):
    ys, xs = np.nonzero(sel)
    cy, cx = ys.mean(), xs.mean()
    dist = np.hypot(np.arange(GNY)[:, None] - cy, np.arange(GNX)[None, :] - cx)
    cost = np.where(OWNER == "VILLA", 0.15 * dist + 0.8 * VPn, np.inf)
    OWNER[OWNER == "VILLA"] = ""                       # grow on villa land
    # never across a fixed road (a clubhouse in one piece)
    got, area = grow(comp, sizes[comp][4], np.where(villa & ~ON_ROAD, cost, np.inf), compact=0.8)
    OWNER[(OWNER == "") & villa] = "VILLA"
    villa = OWNER == "VILLA"
    report.append((comp, area))
# 7 villa phases: bands outward from the gate (by the draft model's shares of the villa land), smoothed into blocks:
# a cell with few neighbours of its own phase takes its neighbours', and a piece under 0.8 ac joins the phase it
# shares most edge with
vmask = OWNER == "VILLA"
vs = sorted([(DIST[j, i], j, i) for (j, i) in zip(*np.nonzero(vmask))])
tot = sum(CELL_AC[j, i] for _, j, i in vs)
PH = np.zeros((GNY, GNX), int)
acc = 0.0
bounds = np.cumsum(VILLA_PHASE_SHARE) * tot
for _, j, i in vs:
    PH[j, i] = min(4, 1 + int(np.searchsorted(bounds, acc + 1e-9, side="right")))
    acc += CELL_AC[j, i]
for _ in range(4):
    NEW = PH.copy()
    for (j, i) in zip(*np.nonzero(vmask)):
        nb = [PH[j + dj, i + di] for dj, di in NB8 if 0 <= j + dj < GNY and 0 <= i + di < GNX and vmask[j + dj, i + di]]
        if nb and sum(1 for q in nb if q == PH[j, i]) < 3:
            NEW[j, i] = max(set(nb), key=nb.count)
    PH = NEW
for _ in range(3):
    for p in (1, 2, 3, 4):
        lab, n = ndimage.label(PH == p)
        for k in range(1, n + 1):
            piece = lab == k
            if CELL_AC[piece].sum() >= 0.8:
                continue
            ring = ndimage.binary_dilation(piece) & ~piece & vmask
            if ring.any():
                PH[piece] = np.bincount(PH[ring]).argmax()
for p in (1, 2, 3, 4):
    OWNER[(PH == p) & vmask] = f"V{p}"
# 8 public open space: every free cell left, round the lakes and on the ground with least outlook
OWNER[(OWNER == "") & USABLE] = "PARK"

# --------------------------------------------------------------------------------------------- tidy and draw
def cells_poly(sel):
    js, is_ = np.nonzero(sel)
    return unary_union([box(X0 + G * i, Y0 + G * j, X0 + G * (i + 1), Y0 + G * j + G) for j, i in zip(js, is_)]).buffer(0)


SITE = PARCEL.difference(FIXED_ROADS).buffer(0)
LAKE_POLY = shapely.geometry.shape({"type": "MultiPolygon", "coordinates": []}) if False else None
lake_mask_poly = unary_union([box(X0 + CELL * i, Y0 + CELL * j, X0 + CELL * (i + 1), Y0 + CELL * (j + 1)) for j, i in zip(*np.nonzero(LAKES))]).buffer(0)
NAMES = {c[0]: c for c in COMPONENTS}
VILLA_NAMES = {f"V{p}": (f"C{['03', '09', '17', '18'][p - 1]}", "villas", p, f"VILLAS · PHASE {p}") for p in (1, 2, 3, 4)}
Z = []
taken = Polygon()
for key in [c[0] for c in COMPONENTS] + list(VILLA_NAMES):
    sel = OWNER == key
    if not sel.any():
        continue
    g = cells_poly(sel).intersection(SITE).difference(lake_mask_poly).difference(taken).buffer(-1).buffer(1).buffer(0)
    if not key.startswith("V"):
        # One piece of land between the fixed roads (a cell's square can reach across a road its centre is clear of)
        _parts = sorted(getattr(_site_parts, "geoms", [_site_parts]), key=lambda q: -q.area)
        _reg = int(np.bincount(REGION[sel]).argmax())
        g = g.intersection(_parts[_reg - 1]).buffer(0)
        # and one piece: a road crossing the zone (the loop's end) leaves the smaller side to the open space
        _pcs = [q for q in getattr(g, "geoms", [g]) if q.area >= 400]
        if len(_pcs) > 1:
            g = max(_pcs, key=lambda q: q.area)
    g = unary_union([q for q in getattr(g, "geoms", [g]) if q.area >= 400]).buffer(0)   # no sliver under 0.1 ac
    taken = unary_union([taken, g])
    if key in NAMES:
        comp, use, ph, name, target, why = NAMES[key]
    else:
        comp, use, ph, name = VILLA_NAMES[key]
        target, why = None, "the free land with the widest outlook, outward from the gate by the draft model's phase shares"
    Z.append(dict(component=comp, name=name, use=use, phase=ph, geom=g, target=target, why=why))
# the public open space: the lakes and every piece of land no zone took (the lakes counted as open space, owner 12 Oct)
rest = SITE.difference(taken).buffer(0)
lakes = rest.intersection(lake_mask_poly).buffer(0)
parks = rest.difference(lake_mask_poly).buffer(-2).buffer(2).buffer(0)
n = 0
for g in sorted(getattr(parks, "geoms", [parks]), key=lambda q: -q.area):
    if g.area < 200:
        continue
    n += 1
    c = g.centroid
    ph = 1 + min(3, int(np.nan_to_num(RANK[min(GNY - 1, max(0, int((c.y - Y0) / G))), min(GNX - 1, max(0, int((c.x - X0) / G)))], nan=0.5) * 4))
    Z.append(dict(component=f"OS-{n}", name=f"PUBLIC OPEN SPACE {n}", use="park", phase=ph, geom=g, target=None, why="public open space: round the lakes and on the ground with the least outlook"))
for k, g in enumerate(sorted(getattr(lakes, "geoms", [lakes]), key=lambda q: -q.area), 1):
    if g.area < 200:
        continue
    c = g.centroid
    Z.append(dict(component=f"OS-W{k}", name=f"LAKE {k}", use="park", phase=1, geom=g, target=None, why="a lake kept (owner 12 Oct), counted as open space", water=True))


def main():
    feats = []
    print(f"{'zone':38s} {'phase':5s} {'land, ac':>8s} {'sized':>7s}")
    for z in Z:
        g = z["geom"]
        polys = [p for p in (g.geoms if hasattr(g, "geoms") else [g]) if p.geom_type == "Polygon" and p.area > 1]
        if not polys:
            continue
        ac = g.area / AC
        feats.append({"type": "Feature", "geometry": mapping(MultiPolygon(polys)), "properties": {
            "name": z["name"], "use": z["use"], "phase": z["phase"], "component": z["component"],
            "label_area_ac": round(z["target"] if z["target"] else ac, 3), "drawn_area_ac": round(ac, 3), "in_scope_ac": round(ac, 3),
            "geometry_confidence": "optimised", "why": z["why"], "pieces": len(polys), **({"water": True} if z.get("water") else {})}})
        print(f"{z['name'][:38]:38s} {z['phase']:5d} {ac:8.2f} {(z['target'] or 0):7.2f}  pieces {len(polys)}")
    by = {}
    for z in Z:
        by[z["use"]] = by.get(z["use"], 0) + z["geom"].area / AC
    print("by use:", {k: round(v, 2) for k, v in by.items()}, "| zones", round(sum(by.values()), 2), "ac; parcel", round(PARCEL.area / AC, 2),
          "; fixed roads", round(PARCEL.intersection(FIXED_ROADS).area / AC, 2))
    fc = {"type": "FeatureCollection", "name": "zones_draft_model", "note": "Optimised zoning (tools/zoning/optimise.py, owner 12 Oct 2026); local metres", "features": feats}
    json.dump(fc, open(OUT, "w", encoding="utf-8"))
    print("wrote", os.path.relpath(OUT, REPO))


if __name__ == "__main__":
    main()
