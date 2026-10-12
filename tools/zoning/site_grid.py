"""The site on a coarse grid, for the zoning optimiser (tools/zoning/optimise.py, owner 12 Oct 2026).

Each 20 m cell carries what the allocation weighs: how much of it can be built on, its level and slope, the outlook
from it (view potential: the share of 72 directions in which ground at least 5 m lower is seen within 300 m from a
first-floor eye), its distance from the main gate along the ground and the roads, and what a tall or a low building
standing on it would hide of everyone else's outlook (view cost). The fixed roads (the client's 18 m road, the loop's
north side, the gate arm's road, the south road) and the three lakes come from config/planning_rules.yaml.

Inputs: data/processed (parcel, DEM), config/planning_rules.yaml, the analysis layers written by
`node app/scripts/export-layers.mjs` (tools/zoning/layers). Heavy parts are cached in tools/zoning/layers.
"""
import json
import os

import numpy as np
import yaml
from shapely.geometry import shape, LineString, Point, box
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
LAYERS = os.path.join(HERE, "layers")
AC = 4046.8564224

META = json.load(open(f"{REPO}/data/processed/dem_2m.json"))
NX, NY, X0, Y0, CELL = META["nx"], META["ny"], META["x0"], META["y0"], META["cell_m"]
DEM = np.fromfile(f"{REPO}/data/processed/dem_2m.f32", dtype="<f4").reshape(NY, NX)
XC = X0 + CELL * (np.arange(NX) + 0.5)
YC = Y0 + CELL * (np.arange(NY) + 0.5)


def layer(name):
    return np.fromfile(os.path.join(LAYERS, f"layer_{name}.u8"), dtype=np.uint8).reshape(NY, NX).astype(bool)


TERRAIN = layer("terrain")
LAKES = layer("waterlogging")             # the three lakes (planning_rules hydrology.keep_lakes)
NONBUILD = layer("nonBuildable")          # Rule 22 slope and natural drains
EXISTING = layer("existingRoads")
GRAD = np.fromfile(os.path.join(LAYERS, "gradient.f32"), dtype="<f4").reshape(NY, NX)

PARCEL = unary_union([shape(f["geometry"]).buffer(0) for f in json.load(open(f"{REPO}/data/processed/parcel.geojson"))["features"]
                      if f["properties"].get("status", "in_scope") == "in_scope"])
RULES = yaml.safe_load(open(f"{REPO}/config/planning_rules.yaml", encoding="utf-8"))
ROUTES = RULES["bases"]["draft_model"]["roads.owner_routes"]
WIDTHS = RULES["roads"]["width_m"]
FIXED = [dict(line=LineString(r["points"]), width=r.get("width_m", WIDTHS[r["tier"]]), why=r["why"]) for r in ROUTES]
FIXED_ROADS = unary_union([f["line"].buffer(f["width"] / 2, cap_style=2) for f in FIXED]).buffer(0)
MAIN = next(f["line"] for f in FIXED if f["width"] >= 18)                 # the client's 18 m road
GATE = (340.0, 662.0)                                                     # the main gate, on the Mangalapuram-Pothencode road


def mask_of(poly):
    """DEM cells whose centre lies in poly."""
    import shapely
    gx, gy = np.meshgrid(XC, YC)
    return shapely.contains_xy(poly, gx, gy) if not poly.is_empty else np.zeros((NY, NX), bool)


ROADMASK = mask_of(FIXED_ROADS) | EXISTING

# ----------------------------------------------------------------------------- the coarse grid
G = 20.0                                   # m
K = int(G / CELL)                          # DEM cells per grid side
GNX, GNY = int(np.ceil(NX / K)), int(np.ceil(NY / K))


def coarse(m, how="mean"):
    """A DEM-grid array summarised over each 20 m cell."""
    pad = np.full((GNY * K, GNX * K), np.nan if m.dtype.kind == "f" else 0, dtype=float)
    pad[:NY, :NX] = m
    blocks = pad.reshape(GNY, K, GNX, K)
    return np.nanmean(blocks, axis=(1, 3)) if how == "mean" else np.nanmax(blocks, axis=(1, 3))


GX = X0 + G * (np.arange(GNX) + 0.5)
GY = Y0 + G * (np.arange(GNY) + 0.5)
IN_SITE = coarse(TERRAIN.astype(float)) > 0.5
FREE = TERRAIN & ~LAKES & ~NONBUILD & ~ROADMASK
FREE_SHARE = coarse(FREE.astype(float))
USABLE = IN_SITE & (FREE_SHARE >= 0.6)                    # a cell a zone can take
CELL_AC = np.nan_to_num(FREE_SHARE) * G * G / AC           # its buildable land
LEVEL = coarse(np.where(TERRAIN, DEM, np.nan))
SLOPE = coarse(np.where(TERRAIN, GRAD, np.nan))
LAKE_CELL = coarse(LAKES.astype(float)) > 0.3
FRONT_MAIN = np.zeros((GNY, GNX), bool)                   # touches the 18 m road
FRONT_FIXED = np.zeros((GNY, GNX), bool)                  # touches any fixed road
ON_ROAD = np.zeros((GNY, GNX), bool)                      # a fixed road runs through it (5% of the cell or more)
for j in range(GNY):
    for i in range(GNX):
        if not IN_SITE[j, i]:
            continue
        c = box(GX[i] - G / 2, GY[j] - G / 2, GX[i] + G / 2, GY[j] + G / 2)
        FRONT_MAIN[j, i] = c.distance(MAIN) <= 9 + 4
        FRONT_FIXED[j, i] = c.distance(FIXED_ROADS) <= 4
        ON_ROAD[j, i] = c.intersection(FIXED_ROADS).area >= 0.05 * G * G


# ----------------------------------------------------------------------------- view potential and view cost
EYE, DROP, REACH, STEP = 4.5, 5.0, 300.0, 4.0
ANG = np.arange(72) * 2 * np.pi / 72
DS = np.arange(12.0, REACH + 1, STEP)
Z = np.where(TERRAIN, DEM, np.nan)


def _ray_cells(i0, j0):
    ii = (i0 + np.sin(ANG)[:, None] * DS[None, :] / CELL).astype(int)
    jj = (j0 + np.cos(ANG)[:, None] * DS[None, :] / CELL).astype(int)
    ok = (ii >= 0) & (jj >= 0) & (ii < NX) & (jj < NY)
    zz = np.full(ii.shape, np.nan)
    zz[ok] = Z[jj[ok], ii[ok]]
    return ii, jj, ok, zz


def view_analysis():
    """Per 20 m cell: view potential, and the outlook a tall (63 m, 20 floors) or low (13 m, G+3) building standing on
    it would hide from everyone (summed over all cells' views, each cell weighted by its own view potential)."""
    cache = os.path.join(LAYERS, "views_20m.npz")
    if os.path.exists(cache):
        d = np.load(cache)
        return d["vp"], d["tall"], d["low"]
    vp = np.full((GNY, GNX), np.nan)
    tall = np.zeros((GNY, GNX))
    low = np.zeros((GNY, GNX))
    for gj in range(GNY):
        for gi in range(GNX):
            if not IN_SITE[gj, gi]:
                continue
            i0, j0 = int((GX[gi] - X0) / CELL), int((GY[gj] - Y0) / CELL)
            z0 = Z[j0, i0]
            if not np.isfinite(z0):
                continue
            ii, jj, ok, zz = _ray_cells(i0, j0)
            ze = z0 + EYE
            angz = (zz - ze) / DS[None, :]
            angz = np.where(np.isfinite(angz), angz, -np.inf)
            horizon = np.maximum.accumulate(np.concatenate([np.full((72, 1), -np.inf), angz[:, :-1]], axis=1), axis=1)
            seen_low = (angz >= horizon) & (zz <= z0 - DROP)
            has = seen_low.any(axis=1)
            vp[gj, gi] = has.mean()
            if not has.any():
                continue
            # the farthest low ground seen in each direction: a building nearer than that, rising above the sightline
            # to it, hides it
            last = np.where(has, (seen_low * np.arange(len(DS))[None, :]).max(axis=1), -1)
            w = vp[gj, gi] / 72.0
            for d in np.nonzero(has)[0]:
                n = last[d]
                sl = (zz[d, n] - ze) / DS[n]                     # the sightline's slope to that ground
                line = ze + sl * DS[:n]                           # its height over the steps before it
                okd = ok[d, :n]
                zs = zz[d, :n]
                gi_s = ((X0 + CELL * (ii[d, :n] + 0.5) - X0) / G).astype(int)
                gj_s = ((Y0 + CELL * (jj[d, :n] + 0.5) - Y0) / G).astype(int)
                for H, acc in ((63.0, tall), (13.0, low)):
                    hit = okd & np.isfinite(zs) & (zs + H > line)
                    if hit.any():
                        cells = set(zip(gj_s[hit], gi_s[hit]))
                        for (a, b) in cells:
                            if 0 <= a < GNY and 0 <= b < GNX:
                                acc[a, b] += w
    np.savez(cache, vp=vp, tall=tall, low=low)
    return vp, tall, low


if __name__ == "__main__":
    import time
    t = time.time()
    vp, tall, low = view_analysis()
    print(f"grid {GNX} x {GNY}, usable cells {int(USABLE.sum())} ({float(CELL_AC[USABLE].sum()):.1f} ac); "
          f"view potential mean {np.nanmean(vp[USABLE]):.2f}; {time.time() - t:.0f} s")
