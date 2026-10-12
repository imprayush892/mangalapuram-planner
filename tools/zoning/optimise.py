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

OUT = os.environ.get("OUT") or os.path.join(REPO, "data", "processed", "zones_draft_model.geojson")
KMBR = yaml.safe_load(open(f"{REPO}/config/kmbr_rules.yaml", encoding="utf-8"))["table6_coverage_fsi"]
SQFT_AC = 43560.0
VP, TALL, LOW = view_analysis()
VPn = np.nan_to_num(VP) / max(1e-9, np.nanmax(VP))
TALLn = TALL / max(1e-9, TALL[USABLE].max())
LOWn = LOW / max(1e-9, LOW[USABLE].max())
SLOPEn = np.clip(np.nan_to_num(SLOPE) / 0.5, 0, 1)
_lv = LEVEL[USABLE]
LEVELn = np.clip((np.nan_to_num(LEVEL, nan=np.nanmax(_lv)) - _lv.min()) / max(1e-9, _lv.max() - _lv.min()), 0, 1)
# Owner 12 Oct: the premium land is the outlook (the hilltops) and the lake fronts; villas take it, never the school
# or senior living (they go to the low ground with no selling point of its own)
_lake_m = ndimage.distance_transform_edt(~LAKE_CELL) * G
LAKEFRONT = np.clip((120.0 - _lake_m) / 80.0, 0, 1)                                   # 1 within 40 m of a lake, 0 from 120 m
PREMn = np.maximum(np.maximum(VPn, LAKEFRONT), LEVELn)      # owner 12 Oct: the high ground is premium too
# how far into the site (from the parcel's edge): 0 at the edge, 1 from 120 m in
INTERIORn = np.clip(ndimage.distance_transform_edt(IN_SITE) * G / 120.0, 0, 1)
# The airport limit (planning_rules airport): the floors a tower can have on each cell, its top under the AAI line.
_air = RULES["airport"]
CAP_RL = _air["permissible_top_amsl_m"] - _air["tbm_amsl_m"] + _air["tbm_rl"]
FLOORS_CAP = np.floor((CAP_RL - _air["rooftop_allowance_m"] - np.nan_to_num(coarse(np.where(TERRAIN, DEM, np.nan), "max"), nan=999)) / 3.0)
TOWER_FLOORS = 20                                             # planning_rules apartments.max_floors
# a cell that cannot take a full-height tower costs a tower zone in proportion; one under 12 floors is not a tower site
TOWER_FIT = np.where(FLOORS_CAP >= 12, np.clip((TOWER_FLOORS - FLOORS_CAP) / TOWER_FLOORS, 0, 1) * 3.0, np.inf)
# the apartment towers: only where a full 20 floors fit (owner 12 Oct: a tower cut short leaves flats no tower holds)
APT_FIT = np.where(FLOORS_CAP >= TOWER_FLOORS, 0.0, np.inf)

# --------------------------------------------------------------------------------------------- land per use
FSI = {"residential": KMBR["A1_residential"]["fsi"][0], "office": KMBR["E_office"]["fsi"][0],
       "commercial": KMBR["F_commercial"]["fsi"][0], "school": KMBR["B_upto_higher_secondary"]["fsi"][0]}
# (component, use, phase, name, land in acres, how the land is sized)
# Apartment land over the bare FSI 3 land (tried 1.1, 12 Oct: no more flats, fewer villas)
APT_MARGIN = 1.0
# Owner 12 Oct: the towers closer together, on less land, the rest plotted villas: the apartments at FSI 3.8, under the
# 4.0 the owner accepted (planning_rules apartments.fsi_max; KMBR A1 with the Rs 5,000/m2 fee on the area over FSI 3),
# a margin for the airport line and the towers' spacing
APT_FSI = 0.95 * RULES["apartments"]["fsi_max"]
# the towers' own floor area a flat (the plans' towers: their plate over its flats, ~2,060-2,130 sq ft, more than the
# model's 1,842 = 1,602 saleable x 1.15), so the FSI is the plan's
APT_SFT_PER_FLAT = 2130
# Owner 12 Oct (later): the FSI is the township's, over the whole site, as in the earlier deck: a tower zone is its towers
# and the room they need, no more. A tower: the 16,500 sq ft footprint (aspect 2, about 55 x 28 m) with its 3 m setbacks,
# x TOWER_ROOM for the clear distance between towers, the stagger, the drive and the zone's irregular edge; 20 floors of 8 flats, so 160 flats a tower.
_plate = 16500 / 10.7639
_L, _D = (_plate * RULES["apartments"]["plate_aspect"]) ** 0.5, (_plate / RULES["apartments"]["plate_aspect"]) ** 0.5
CLUB_C14_AC = 1.25   # the apartment clubhouse (the model's 1.0 ac): room for it whichever way the roads run
TOWER_ROOM = float(os.environ.get("TOWER_ROOM", 3.0))   # x the footprint with its setbacks: the clear distance, the stagger, the drive, an irregular edge
TOWER_LOT_AC = (_L + 2 * RULES["apartments"]["setback_m"]) * (_D + 2 * RULES["apartments"]["setback_m"]) * TOWER_ROOM / AC
FLATS_PER_TOWER = 160


def tower_land(flats):
    import math
    return math.ceil(flats / FLATS_PER_TOWER) * TOWER_LOT_AC


def fsi_ac(bua, fsi):
    return bua / (fsi * SQFT_AC)


SENIOR_FSI = 1.35         # ASSUMPTION: senior living low-rise (G+3 to G+5, a quarter of the plot built on, gardens round it)
RETAIL_FSI = 2.0          # ASSUMPTION: a G+2 high street with its frontage and parking
COMPONENTS = [
    ("C12-1", "retail", 1, "RETAIL & F&B · PHASE 1", fsi_ac(0.4 * 90000, RETAIL_FSI), "40% of 90,000 sq ft at FSI 2.0 (G+2 high street)"),
    ("C16-1", "office", 1, "COMMERCIAL OFFICE · PHASE 1", fsi_ac(0.4 * 258750, FSI["office"]), "40% of 2,58,750 sq ft at KMBR's free FSI 3"),
    ("C12", "retail", 3, "RETAIL & F&B · PHASE 3", fsi_ac(0.6 * 90000, RETAIL_FSI), "60% of 90,000 sq ft at FSI 2.0"),
    ("C16", "office", 3, "COMMERCIAL OFFICE · PHASE 3", fsi_ac(0.6 * 258750, FSI["office"]), "60% of 2,58,750 sq ft at KMBR's free FSI 3"),
    ("C02", "apartments", 1, "APARTMENTS · PHASE 1", tower_land(93), "93 flats in 1 tower: the towers and their room (township FSI)"),
    ("C11", "apartments", 2, "APARTMENTS · PHASE 2", tower_land(234), "234 flats in 2 towers: the towers and their room (township FSI)"),
    ("C19", "apartments", 3, "APARTMENTS · PHASE 3", tower_land(304), "304 flats in 2 towers: the towers and their room (township FSI)"),
    ("C20", "apartments", 4, "APARTMENTS · PHASE 4", tower_land(304), "304 flats in 2 towers: the towers and their room (township FSI)"),
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
VILLA_TARGET_AC = float(os.environ.get("VILLA_AC", 34.5))   # gross villa land: ~360 villas at the plans' yield
# D7=1 (owner 12 Oct, least earthwork): the villas on the gentle land, the steep hill green; pins and areas as they are
D7 = os.environ.get("D7") == "1"
# D7 master 12 Oct, measured on zones_d7_26 end to end: earthwork + walls, Rs lakh an acre of villa land by its natural
# slope (2 m): <1:8, 1:8-1:5, 1:5-1:4, 1:4-1:3, 1:3-1:2, >1:2
D7_SLOPE_EDGES = [1 / 8, 1 / 5, 1 / 4, 1 / 3, 1 / 2]
D7_RS_LAKH_AC = [11, 35, 38, 91, 159, 221]
# the villas' cost is the premium as before plus D7_W x the cell's Rs; cells over D7_MAX_RS never villas (VILLA_AC then
# only an upper bound: the villa land is the gentle land the other uses leave); the towers' cost adds D7_WT on gentle land
D7_W = float(os.environ.get("D7_W", 1 / 15))                # villa cost per Rs lakh an acre (1:4-1:3 = 6, the premium <= 3.5)
# D7 master 12 Oct: D7_TOWERS moved C20 onto ground that holds one 20-floor tower (791 of 935 flats): off by default, the
# towers, senior, school and retail/office where the optimised zoning puts them
D7_TOWERS = D7 and os.environ.get("D7_TOWERS", "0") == "1"
D7_WT = float(os.environ.get("D7_WT", 8.0))
D7_MAX_RS = float(os.environ.get("D7_MAX_RS", 1e9))      # no villa on a cell dearer than this, Rs lakh an acre (none: with the towers kept the hill is all there is)
D7_BLOCK_AC = float(os.environ.get("D7_BLOCK_AC", 1.5))  # the smallest villa block (D7 master: fragments plot at 10/ac, blocks at 13)
D7_COMPACT = float(os.environ.get("D7_COMPACT", 1.0))   # the villa pieces' compactness (0.5 before): blocks, not strips
D7_CHUNK_AC = float(os.environ.get("D7_CHUNK_AC", 5.0))  # the largest villa block grown at once (14 before: one piece climbs the hill)
D7_OPEN = os.environ.get("D7_OPEN", "1") == "1"       # no villa strip one cell (20 m) across


def d7_rs_lakh_ac():
    """Per 20 m cell: the villas' earthwork and walls, Rs lakh an acre, from its 2 m slopes and the curve above."""
    g = np.where(TERRAIN & np.isfinite(GRAD), GRAD, np.nan)
    rs = np.where(np.isfinite(g), D7_RS_LAKH_AC[0], np.nan)
    for e, r in zip(D7_SLOPE_EDGES, D7_RS_LAKH_AC[1:]):
        rs = np.where(g > e, r, rs)
    return np.nan_to_num(coarse(rs), nan=D7_RS_LAKH_AC[-1])


D7_RS = d7_rs_lakh_ac() if D7 else None
VILLA_PHASE_SHARE = [0.15, 0.25, 0.30, 0.30]                 # the draft model's villa land by phase (Inputs D123-D126)
OPEN_MIN_AC = 0.10 * 73.0                                     # KMBR Rule 31(v): 10% of the layout as public open space

# --------------------------------------------------------------------------------------------- the grid graph
cells = [(j, i) for j in range(GNY) for i in range(GNX) if IN_SITE[j, i]]
idx = {c: n for n, c in enumerate(cells)}
NB = [(-1, 0), (1, 0), (0, -1), (0, 1)]
NB8 = NB + [(-1, -1), (-1, 1), (1, -1), (1, 1)]
# A step from a cell to its neighbour that crosses a fixed road (between their centres): a zone never grows across
# one (the land joins up round a road's end, so the pieces between the roads alone do not keep it on one side)
# ------------------------------------------------------------------ the water channel (owner 12 Oct)
# An open channel joins the north pond (RL 80) and the west lake (RL 72), down the low ground between them: the
# cheapest path on a 4 m grid where the cost of a step rises with the ground's level (so it keeps to the valley),
# smoothed. CHANNEL_W of water between planted banks (CHANNEL_BANK each side); the roads bridge it.
CHANNEL_W, CHANNEL_BANK = 6.0, 4.0
CHANNEL_FROM, CHANNEL_TO = (491.0, 477.0), (252.0, 255.0)


def _channel_line():
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra as _dij
    k = 2
    z = DEM[::k, ::k]
    okm = TERRAIN[::k, ::k] & np.isfinite(z)
    ny_, nx_ = z.shape
    xs = X0 + CELL * k * (np.arange(nx_) + 0.5)
    ys = Y0 + CELL * k * (np.arange(ny_) + 0.5)
    zl = np.where(okm, z, np.nan)
    zn = (zl - np.nanmin(zl)) / max(1e-9, np.nanmax(zl) - np.nanmin(zl))
    idx = -np.ones(z.shape, int)
    idx[okm] = np.arange(int(okm.sum()))
    rr, cc, ww = [], [], []
    for dj, di, d in ((0, 1, 1.0), (1, 0, 1.0), (1, 1, 2 ** 0.5), (1, -1, 2 ** 0.5)):
        sa = (slice(max(0, -dj), ny_ - max(0, dj)), slice(max(0, -di), nx_ - max(0, di)))
        sb = (slice(max(0, dj), ny_ + min(0, dj)), slice(max(0, di), nx_ + min(0, di)))
        a, b = idx[sa], idx[sb]
        ok = (a >= 0) & (b >= 0)
        w = d * (1.0 + 12.0 * (zn[sa] + zn[sb])[ok] / 2)
        rr += list(a[ok]); cc += list(b[ok]); ww += list(w)
    n_ = int(okm.sum())
    gph = coo_matrix((ww + ww, (rr + cc, cc + rr)), shape=(n_, n_)).tocsr()
    gx_, gy_ = np.meshgrid(xs, ys)
    lakes_k = LAKES[::k, ::k] & okm

    def near(pt):
        d = np.hypot(gx_ - pt[0], gy_ - pt[1])
        return idx[lakes_k & (d <= 40)]
    src, dst = near(CHANNEL_FROM), near(CHANNEL_TO)
    dist, pred, _ = _dij(gph, indices=src, min_only=True, return_predecessors=True)
    end = dst[int(np.argmin(dist[dst]))]
    path = [end]
    while pred[path[-1]] >= 0:
        path.append(pred[path[-1]])
    jj, ii = np.nonzero(okm)
    pts = [(xs[ii[q]], ys[jj[q]]) for q in path]
    line = LineString(pts).simplify(4.0)
    for _ in range(3):                                         # Chaikin: a gentle curve, not the grid's steps
        c = list(line.coords)
        out = [c[0]]
        for a_, b_ in zip(c[:-1], c[1:]):
            out += [(0.75 * a_[0] + 0.25 * b_[0], 0.75 * a_[1] + 0.25 * b_[1]), (0.25 * a_[0] + 0.75 * b_[0], 0.25 * a_[1] + 0.75 * b_[1])]
        out.append(c[-1])
        line = LineString(out)
    return line


CHANNEL = _channel_line()
CHANNEL_WATER = CHANNEL.buffer(CHANNEL_W / 2).difference(unary_union([shapely.geometry.shape(mapping(FIXED_ROADS))]))
CHANNEL_CORRIDOR = CHANNEL.buffer(CHANNEL_W / 2 + CHANNEL_BANK)
_road_lines = unary_union([f["line"] for f in FIXED] + [CHANNEL])
CROSS = {}
ROADLINE = np.zeros((GNY, GNX), bool)                      # cells a fixed road's centre line runs through
for _j in range(GNY):
    for _i in range(GNX):
        for _dj, _di in ((1, 0), (0, 1)):
            _a, _b = _j + _dj, _i + _di
            if _a < GNY and _b < GNX and IN_SITE[_j, _i] and IN_SITE[_a, _b]:
                if LineString([(GX[_i], GY[_j]), (GX[_b], GY[_a])]).intersects(_road_lines):
                    CROSS[(_j, _i, _a, _b)] = CROSS[(_a, _b, _j, _i)] = True
for _j in range(GNY):
    for _i in range(GNX):
        if IN_SITE[_j, _i] and box(GX[_i] - G / 2, GY[_j] - G / 2, GX[_i] + G / 2, GY[_j] + G / 2).intersects(_road_lines):
            ROADLINE[_j, _i] = True
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
_site_parts = PARCEL.difference(FIXED_ROADS.buffer(1)).difference(CHANNEL_CORRIDOR).buffer(0)
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
        _l, _n = ndimage.label(okm & (REGION == _r) & ~ROADLINE)
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
            if free(a, b) and REGION[a, b] == reg and (j, i, a, b) not in CROSS and (grow_ok is None or grow_ok[a, b]) and np.isfinite(cost[a, b]):
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
# Owner 12 Oct, marked on the plan: the school in the east lobe (blue circle), the Phase 3 towers on the ground west of
# the 18 m road (red circle, where the school was). Local metres; a zone starts within 60 m of its mark.
PIN = {"SCH": (812.0, 450.0), "C19": (240.0, 425.0), "C02": (385.0, 545.0)}   # C02: by the gate, east of the 18 m road (the west band villas)   # (owner, later: the school up to the lobe's tip)
# Owner 12 Oct, circled on the plan: the green path south of the west lake (by the drain, the senior clubhouse) stays
# green: no villas in it (local metres, read off the drawing)
KEEP_GREEN = ((250.0, 146.0), 66.0, 78.0)                     # centre, half-width, half-height
# and (owner) where the school stood in the east lobe, below it now: green
KEEP_GREEN_2 = ((812.0, 355.0), 70.0, 28.0)
def in_ellipse(e):
    (_kc, _kx, _ky) = e
    return ((GX[None, :] - _kc[0]) / _kx) ** 2 + ((GY[:, None] - _kc[1]) / _ky) ** 2 <= 1.0
# owner 12 Oct: the two Phase 3 towers side by side at the south end of the west strip (above the senior enclave, off
# the green path, north of the senior living), the strip north of them plotted villas; each tower with twice its footprint and setbacks about it
C19_PIN = (205.0, 330.0)
C19_OK = (GY[:, None] <= 420.0) & ~in_ellipse(KEEP_GREEN)
C19_PIECE_AC = TOWER_LOT_AC * 2.0 / TOWER_ROOM
MULTI_PIECE = set()                                       # zones allowed in more than one piece
SCHOOL_NORTH_OF = 380.0                                 # the school in the lobe's upper part, the green below it


def near(pt, r=60.0):
    return np.hypot(GX[None, :] - pt[0], GY[:, None] - pt[1]) <= r
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
# 1b the lake fronts are villas (owner 12 Oct: a lake-front villa sells best): the free land within 60 m of a lake,
# in pieces that make a villa block (1.5 ac and more), before the school, senior living or the towers can take it
RESERVE_LAKE_FRONTS = False   # tried 12 Oct: the rings round the ponds plot poorly; the premium penalty does the job
_front = (_lake_m <= 60) & USABLE & ~LAKE_CELL & (OWNER == "")
_lab, _n = ndimage.label(_front)
LAKE_VILLA_AC = 0.0
for _q in range(1, _n + 1):
    _pc = _lab == _q
    if RESERVE_LAKE_FRONTS and CELL_AC[_pc].sum() >= 1.5:
        OWNER[_pc] = "VG0"
        LAKE_VILLA_AC += float(CELL_AC[_pc].sum())
# 2 senior living (owner 12 Oct): on the low, secluded ground, never on the hilltops or a lake front (the premium
# land the villas take); low blocks that hide little of the villas' outlook; the Phase 1 block and the enclave's
# clubhouse beside the enclave, one place
_, use, ph, name, ac_, why = sizes["C07"]
senior_cost = inf + 2.5 * LEVELn + 4.0 * PREMn + 1.0 * LOWn + 0.6 * SLOPEn
got, area = grow("C07", ac_, senior_cost, compact=0.8)
report.append(("C07", area))
# owner 12 Oct: all the senior living together: the Phase 1 block and the clubhouse start against the enclave (south
# of the west strip, which the towers take; never on the green path by the west lake)
for comp in ("C04", "C15"):
    _beside = ndimage.binary_dilation(np.isin(OWNER, ["C07", "C04"]), iterations=1) & (OWNER == "")
    got, area = grow(comp, sizes[comp][4], senior_cost + 3.0 * ~_beside, seed_ok=_beside, grow_ok=(GY[:, None] <= 300.0) & ~in_ellipse(KEEP_GREEN), compact=0.8)
    report.append((comp, area))
# 2b the school: one campus on the flattest ground on a fixed road, off the premium land (owner 12 Oct: not on a lake
# front or a hilltop), low buildings
school_cost = inf + 1.6 * SLOPEn + 4.0 * PREMn + 2.0 * LEVELn + 0.5 * LOWn + 1.5 * np.abs(np.nan_to_num(RANK, nan=1.0) - 0.3)
# one campus, then the two stages: stage A the part nearer the gate
got, area = grow("SCH", sizes["C05"][4] + sizes["C13"][4], school_cost, seed_ok=near(PIN["SCH"], 40), grow_ok=near(PIN["SCH"], 110) & (GY[:, None] >= SCHOOL_NORTH_OF), compact=1.2)
_sch = sorted(got, key=lambda c: DIST[c])
_acc = 0.0
for c in _sch:
    OWNER[c] = "C05" if _acc < sizes["C05"][4] - 0.02 else "C13"
    _acc += CELL_AC[c]
report.append(("C05", float(CELL_AC[OWNER == "C05"].sum())))
report.append(("C13", float(CELL_AC[OWNER == "C13"].sum())))
# 3 apartment towers: where a 20-floor tower hides least of anyone's outlook, on ground with little of its own
for comp in ("C19", "C02", "C20", "C11"):                  # the owner's mark first, then Phase 1 by the gate
    _, use, ph, name, ac_, why = sizes[comp]
    # at the edge of the site, never among the villas (owner 12 Oct: the towers must not block the villas' views)
    cost = inf + 2.5 * TALLn + 0.8 * VPn + 2.5 * INTERIORn + 0.6 * SLOPEn + (3.0 if ph == 1 else 0.7) * phase_cost(ph) + APT_FIT
    if D7_TOWERS:
        # D7: a tower zone grades its footprints only (D3: Rs 0.4 Cr of walls on 9.8 ac, the villas Rs 24.8 Cr on 30):
        # the towers leave the gentle land to the villas, a stepped podium takes the slope
        cost = cost + D7_WT * (1.0 - np.clip((D7_RS - 38.0) / (159.0 - 38.0), 0, 1)) - 0.6 * SLOPEn
    # towers need land at least 60 m across (a plate, its podium and setbacks): the free land 30 m in from its edge
    _freem = np.vectorize(lambda j, i: free(j, i))(*np.indices((GNY, GNX)))
    thick = ndimage.distance_transform_edt(_freem) * G >= 30
    # the Phase 4 towers and the apartment clubhouse grow as one piece; the clubhouse is the part of it nearest the
    # gate, a compact block (a road may cross it and the clubhouse must still fit)
    want = ac_ + (CLUB_C14_AC if comp == "C20" else 0.0)
    try:
        if comp == "C19":
            # owner 12 Oct: the Phase 3 towers drawn together at the west edge, the land by the 18 m road plotted villas
            cost = cost + np.where(np.array([[MAIN.distance(shapely.geometry.Point(GX[i], GY[j])) for i in range(GNX)] for j in range(GNY)]) < 70, 4.0, 0.0)
            got, area = grow(comp, 2 * C19_PIECE_AC, cost, seed_ok=near(C19_PIN, 40), grow_ok=np.broadcast_to(C19_OK, (GNY, GNX)), compact=1.6)
            report.append((comp, area))
            continue
        got, area = grow(comp, want, cost, seed_ok=near(PIN[comp]) if comp in PIN else thick, compact=1.6)   # compact: towers fit either way the roads run
    except SystemExit:
        got, area = grow(comp, want, cost, compact=0.8)
    if comp == "C20":
        # the clubhouse: one compact block out of the towers' piece, grown from its cell nearest the gate
        _acc = 0.0
        _mine = set(got)
        _start = min(got, key=lambda c: DIST[c])
        _heap = [(0.0, _start)]
        _seen = {_start}
        while _heap and _acc < CLUB_C14_AC - 0.02:
            _, c = heapq.heappop(_heap)
            OWNER[c] = "C14"
            _acc += CELL_AC[c]
            for dj, di in NB:
                q = (c[0] + dj, c[1] + di)
                if q in _mine and q not in _seen:
                    _seen.add(q)
                    heapq.heappush(_heap, (float(np.hypot(q[0] - _start[0], q[1] - _start[1])), q))
        report.append(("C14", _acc))
        area -= _acc
    report.append((comp, area))
# 5 the villas: grown as a few large pieces from the ground with the widest outlook (not cell by cell, which leaves
# holes); the clubhouses come out of them next, so the villas are grown that much larger
CLUB_AC = sizes["C08"][4] + sizes["C10"][4]
villa_cost = inf - 1.5 * VPn - 1.0 * LAKEFRONT - 1.0 * LEVELn + 0.6 * SLOPEn
if D7:
    # D7: a cell costs its earthwork (D7_RS) over the premium, so the steep flanks are left to green (nothing graded)
    villa_cost = villa_cost + D7_W * D7_RS
    villa_cost = np.where(D7_RS > D7_MAX_RS, np.inf, villa_cost)       # near-prohibitive: never a cell this steep
for _e in (KEEP_GREEN, KEEP_GREEN_2):
    villa_cost = np.where(in_ellipse(_e), np.inf, villa_cost)
acc, k, chunk = LAKE_VILLA_AC, 0, (D7_CHUNK_AC if D7 else 14.0)
_blk = D7_BLOCK_AC if D7 else 1.0
while acc < VILLA_TARGET_AC + CLUB_AC - 0.3 and chunk >= _blk:
    k += 1
    try:
        got, area = grow(f"VG{k}", min(VILLA_TARGET_AC + CLUB_AC - acc, chunk), villa_cost, compact=(D7_COMPACT if D7 else 0.5))
    except SystemExit:                               # no free piece that big: a smaller one
        chunk = 0.7 * min(chunk, VILLA_TARGET_AC + CLUB_AC - acc)
        continue
    if area < _blk:                                  # too small to be a villa block (12 villas or so): open space
        for (j, i) in got:
            OWNER[j, i] = ""
        chunk = 0.7 * min(chunk, VILLA_TARGET_AC + CLUB_AC - acc)
        continue
    acc += area
    print(f"  villa piece VG{k}: {area:.2f} ac (chunk {chunk:.1f}), {acc:.2f} of {VILLA_TARGET_AC + CLUB_AC:.2f}") if os.environ.get("DEBUG_VILLAS") else None
OWNER[np.vectorize(lambda o: isinstance(o, str) and o.startswith("VG"))(OWNER)] = "VILLA"
# and the villa land extends into the free land beside it (cheapest first, never across a fixed road) until it holds
# the target: the strips too small for a villa block of their own join the block beside them
_heap = []
for (j, i) in zip(*np.nonzero(OWNER == "VILLA")):
    for dj, di in NB:
        a_, b_ = j + dj, i + di
        if free(a_, b_) and (j, i, a_, b_) not in CROSS and np.isfinite(villa_cost[a_, b_]):
            heapq.heappush(_heap, (villa_cost[a_, b_], a_, b_, j, i))
while acc < VILLA_TARGET_AC + CLUB_AC - 0.1 and _heap:
    _, a_, b_, j, i = heapq.heappop(_heap)
    if not free(a_, b_):
        continue
    OWNER[a_, b_] = "VILLA"
    acc += CELL_AC[a_, b_]
    for dj, di in NB:
        c_, d_ = a_ + dj, b_ + di
        if free(c_, d_) and (a_, b_, c_, d_) not in CROSS and np.isfinite(villa_cost[c_, d_]):
            heapq.heappush(_heap, (villa_cost[c_, d_], c_, d_, a_, b_))
# and any free piece of a villa block's size (0.8 ac and more, between the roads) left over, the best first, while the
# villas are short of their land (owner 12 Oct: the land the towers gave up is villas)
_freem = np.vectorize(lambda j, i: free(j, i))(*np.indices((GNY, GNX))) & np.isfinite(villa_cost)
_lab, _n = ndimage.label(_freem & ~ROADLINE)
_pieces = sorted(((float(villa_cost[_lab == q].mean()), q) for q in range(1, _n + 1)), key=lambda t: t[0])
for _c, q in _pieces:
    if acc >= VILLA_TARGET_AC + CLUB_AC - 0.1:
        break
    _a = float(CELL_AC[_lab == q].sum())
    if _a >= (_blk if D7 else 0.8):
        OWNER[_lab == q] = "VILLA"
        acc += _a
if D7:
    # D7 master 12 Oct: villa land in blocks that plot well: a strip one cell across, and a piece under D7_BLOCK_AC
    # (between the fixed roads), is green
    _v = OWNER == "VILLA"
    if D7_OPEN:
        _v = _v & ndimage.binary_opening(_v, structure=np.ones((2, 2), bool))
    for _r in range(1, REGION.max() + 1):
        _l, _n = ndimage.label(_v & (REGION == _r))
        for q in range(1, _n + 1):
            if CELL_AC[_l == q].sum() < D7_BLOCK_AC:
                _v[_l == q] = False
    OWNER[(OWNER == "VILLA") & ~_v] = ""
    print(f"  D7: villa land {float(CELL_AC[OWNER == 'VILLA'].sum()):.2f} ac in blocks") if os.environ.get("DEBUG_VILLAS") else None
# 6 the villa clubhouses at the middle of the villas: club 1 (Phase 1) among the nearest villas to the gate, club 2
# (Phase 3) at the middle of all of them, both on villa land with the least outlook there
villa = OWNER == "VILLA"
vr = np.where(villa, RANK, np.nan)
for comp, sel in (("C08", villa & (np.nan_to_num(vr, nan=9) <= np.nanquantile(vr, 0.18))), ("C10", villa)):
    ys, xs = np.nonzero(sel)
    cy, cx = ys.mean(), xs.mean()
    dist = np.hypot(np.arange(GNY)[:, None] - cy, np.arange(GNX)[None, :] - cx)
    cost = np.where(OWNER == "VILLA", 0.15 * dist + 0.8 * VPn - (D7_W * D7_RS if D7 else 0.0), np.inf)   # D7: on the villas' steepest land
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


SITE = PARCEL.difference(FIXED_ROADS).difference(CHANNEL_CORRIDOR).buffer(0)
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
    if key.startswith("V"):
        # a villa phase's piece too small for a row of villas (under 0.4 ac, cut off by a road) is open space
        g = unary_union([q for q in getattr(g, "geoms", [g]) if q.area >= 0.4 * AC]).buffer(0)
    if not key.startswith("V"):
        # One piece of land between the fixed roads (a cell's square can reach across a road its centre is clear of)
        _parts = sorted(getattr(_site_parts, "geoms", [_site_parts]), key=lambda q: -q.area)
        if key in MULTI_PIECE:                       # in pieces by design (each piece in its own land between the roads)
            g = g.intersection(unary_union([_parts[r - 1] for r in set(REGION[sel].tolist()) if r > 0])).buffer(0)
        else:
            _reg = int(np.bincount(REGION[sel]).argmax())
            g = g.intersection(_parts[_reg - 1]).buffer(0)
        # and one piece: a road crossing the zone (the loop's end) leaves the smaller side to the open space
        _pcs = [q for q in getattr(g, "geoms", [g]) if q.area >= 400]
        if len(_pcs) > 1 and key not in MULTI_PIECE:
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
if D7:
    # and drawn: a villa piece under D7_BLOCK_AC (a road cutting a block's corner off) is green
    _vu = unary_union([z["geom"] for z in Z if z["use"] == "villas"])
    _small = unary_union([q for q in getattr(_vu, "geoms", [_vu]) if q.area < D7_BLOCK_AC * AC] or [Polygon()])
    for z in Z:
        if z["use"] == "villas":
            z["geom"] = z["geom"].difference(_small).buffer(0)
    taken = taken.difference(_small).buffer(0)
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
    rc = g.area >= RULES["open_space"]["rc_min_m2"]
    Z.append(dict(component=f"OS-{n}", name=f"PUBLIC OPEN SPACE {n}" if rc else f"LANDSCAPE {n}", use="park", phase=ph, geom=g, target=None,
                  green="rc" if rc else "landscape",
                  why="public open space (RC): round the lakes and on the ground with the least outlook" if rc else "landscape: a strip no zone took, planted"))
for k, g in enumerate(sorted(getattr(lakes, "geoms", [lakes]), key=lambda q: -q.area), 1):
    if g.area < 200:
        continue
    c = g.centroid
    Z.append(dict(component=f"OS-W{k}", name=f"LAKE {k}", use="park", phase=1, geom=g, target=None, why="a lake kept (owner 12 Oct), counted as open space", water=True, green="lake"))
# the channel: its water (the roads bridge it, so not under them) and its planted banks
_cw = CHANNEL_WATER.intersection(PARCEL).difference(FIXED_ROADS).difference(lake_mask_poly).buffer(0)
_cb = CHANNEL_CORRIDOR.intersection(PARCEL).difference(FIXED_ROADS).difference(lake_mask_poly).difference(_cw).buffer(0)
Z.append(dict(component="OS-CH", name="WATER CHANNEL", use="park", phase=1, geom=_cw, target=None, water=True, green="lake",
              why=f"an open channel joining the north pond and the west lake (owner 12 Oct), {CHANNEL_W:.0f} m of water; the roads bridge it"))
Z.append(dict(component="OS-CB", name="CHANNEL BANKS", use="park", phase=1, geom=_cb, target=None, green="landscape",
              why=f"the channel's planted banks, {CHANNEL_BANK:.0f} m each side"))


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
            "geometry_confidence": "optimised", "why": z["why"], "pieces": len(polys), **({"water": True} if z.get("water") else {}), **({"green": z["green"]} if z.get("green") else {})}})
        print(f"{z['name'][:38]:38s} {z['phase']:5d} {ac:8.2f} {(z['target'] or 0):7.2f}  pieces {len(polys)}")
    by = {}
    for z in Z:
        by[z["use"]] = by.get(z["use"], 0) + z["geom"].area / AC
    print("by use:", {k: round(v, 2) for k, v in by.items()}, "| zones", round(sum(by.values()), 2), "ac; parcel", round(PARCEL.area / AC, 2),
          "; fixed roads", round(PARCEL.intersection(FIXED_ROADS).area / AC, 2))
    fc = {"type": "FeatureCollection", "name": "zones_draft_model", "note": "Optimised zoning (tools/zoning/optimise.py, owner 12 Oct 2026); local metres", "features": feats}
    json.dump(fc, open(OUT, "w", encoding="utf-8"))
    print("wrote", os.path.relpath(OUT, REPO))


# the score maps behind the zoning, for the deck's design-logic slides (DUMP=path.npz)
if os.environ.get("DUMP"):
    np.savez(os.environ["DUMP"], VPn=VPn, TALLn=TALLn, LOWn=LOWn, LAKEFRONT=LAKEFRONT, LEVEL=LEVEL, LEVELn=LEVELn, PREMn=PREMn,
             INTERIORn=INTERIORn, SLOPEn=SLOPEn, FLOORS_CAP=FLOORS_CAP, DIST=DIST, RANK=RANK, GX=GX, GY=GY, IN_SITE=IN_SITE, USABLE=USABLE,
             LAKE_CELL=LAKE_CELL)


if __name__ == "__main__":
    main()
