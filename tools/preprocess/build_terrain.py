"""Rebuild the terrain products from the terrain mesh.

    python build_terrain.py <mesh.obj> [--yup] [--out ../../data/processed]

Writes, from one mesh:

  data/processed/terrain_mesh.obj  the mesh in the app's frame
      (local metres, X east, Y north, Z = RL), triangulated. The app ships this
      as its TIN (app/scripts/sync-data.mjs).
  data/processed/dem_2m.f32 / dem_2m.json            2 m grid, linear on the TIN
  data/processed/dem_2m_measured.u8                   1 where a survey point lies
      within MEASURED_RADIUS_M of the cell centre, else 0. The mesh covers ground
      the survey never reached; this keeps the app saying so.
  data/processed/contours_1m.geojson                  1 m contours of the mesh, so
      the plan draws the surface everything is computed on.
  data/processed/survey_slope_deg.f32                 slope of the raw SURVEY TIN facet
      under each cell centre (NaN where the survey TIN does not reach). The final
      mesh is smoothed and flattens the steepest faces; statutory slope limits
      (KMBR Rule 22) are checked against the survey as well, so ground the survey
      measured as too steep stays non-buildable.
  a terrain block for tests/expected_values.yaml, printed, to paste in.

spot_levels.csv is the survey itself and is not touched.

--yup: the mesh is a Rhino/OBJ Y-up export, i.e. file (x, y, z) = (E, RL, -N).
"""
import argparse
import csv
import json
import math
import os

import numpy as np
from matplotlib.tri import Triangulation, LinearTriInterpolator

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
E0, N0 = 706106.927, 953717.901
AC = 4046.8564224
# Survey points sit a median 3.1 m apart; a cell is measured when one lies
# within this distance of its centre, i.e. inside the survey's own spacing.
MEASURED_RADIUS_M = 5.0
CELL, X0, Y0, NX, NY = 2.0, 0.0, -10.0, 460, 345  # unchanged grid: x 0..920, y -10..680
SLOPE_EDGES = [0, 5, 10, 15, 20, 30, 45, 90]
FALL_EDGES = [0, 0.5, 1, 2, 3, math.inf]


def read_obj(path, yup):
    verts, faces = [], []
    with open(path) as f:
        for line in f:
            if line.startswith("v "):
                a = [float(t) for t in line.split()[1:4]]
                verts.append([a[0], -a[2], a[1]] if yup else a)
            elif line.startswith("f "):
                idx = [int(t.split("/")[0]) - 1 for t in line.split()[1:]]
                for t in range(1, len(idx) - 1):
                    faces.append([idx[0], idx[t], idx[t + 1]])
    return np.array(verts, dtype=float), np.array(faces, dtype=np.int64)


def facet_stats(V, F):
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    u, v = b - a, c - a
    n = np.cross(u, v)
    plan = 0.5 * np.abs(n[:, 2])
    surf = 0.5 * np.linalg.norm(n, axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        slope = np.degrees(np.arccos(np.clip(np.abs(n[:, 2]) / np.linalg.norm(n, axis=1), -1, 1)))
    return plan, surf, slope


def window_fall_bands(Z):
    """Same as Dem.windowFallGrid: 6 x 8 cells, 75% valid, max - min."""
    wx, wy = math.ceil(11.4 / CELL), math.ceil(14.2 / CELL)
    hx, hy = wx // 2, wy // 2
    ny, nx = Z.shape
    pad = np.full((ny + wy, nx + wx), np.nan)
    pad[hy:hy + ny, hx:hx + nx] = Z
    stack = np.stack([pad[dj:dj + ny, di:di + nx] for dj in range(wy) for di in range(wx)])
    count = np.isfinite(stack).sum(0)
    with np.errstate(all="ignore"):
        fall = np.nanmax(stack, 0) - np.nanmin(stack, 0)
    ok = np.isfinite(Z) & (count >= 0.75 * wx * wy)
    f = fall[ok]
    cell_ac = CELL * CELL / AC
    return [float(((f >= lo) & (f < hi)).sum() * cell_ac) for lo, hi in zip(FALL_EDGES[:-1], FALL_EDGES[1:])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mesh")
    ap.add_argument("--yup", action="store_true")
    ap.add_argument("--out", default=os.path.join(REPO, "data", "processed"))
    ap.add_argument("--survey-tin", default=os.path.join(REPO, "data", "raw", "survey", "mangalapuram_terrain_15_sept.obj"),
                    help="Raw survey TIN (Z up), for the survey slope grid")
    args = ap.parse_args()

    V, F = read_obj(args.mesh, args.yup)
    # Drop degenerate facets: they carry no area and break the interpolator.
    plan, surf, slope = facet_stats(V, F)
    keep = plan > 1e-9
    F = F[keep]
    plan, surf, slope = plan[keep], surf[keep], slope[keep]
    print(f"mesh: {len(V)} vertices, {len(F)} triangles, plan {plan.sum() / 1e4:.2f} ha, "
          f"RL {V[:, 2].min():.3f}..{V[:, 2].max():.3f}")

    # 1. the mesh in the app's frame
    mesh_out = os.path.join(args.out, "terrain_mesh.obj")
    with open(mesh_out, "w", newline="\n") as f:
        f.write("# Mangalapuram terrain - final mesh (kerala_site final_mesh.obj, Rhino export, 2026-09-24)\n")
        f.write("# Units metres. X=East Y=North Z=reduced level (RL, TBM = 100.000)\n")
        f.write(f"# Local origin UTM 43N (EPSG:32643): E {E0} N {N0}\n")
        f.write("# Converted from Rhino Y-up (x, RL, -N) and triangulated by tools/preprocess/build_terrain.py\n")
        f.write(f"# {len(V)} vertices, {len(F)} triangles. Vertices are the modeller's, not survey points:\n")
        f.write("#   the survey points are data/processed/spot_levels.csv\n")
        for x, y, z in V:
            f.write(f"v {x:.4f} {y:.4f} {z:.4f}\n")
        for a, b, c in F:
            f.write(f"f {a + 1} {b + 1} {c + 1}\n")
    print(f"wrote {mesh_out}")

    # 2. DEM
    tri = Triangulation(V[:, 0], V[:, 1], F)
    interp = LinearTriInterpolator(tri, V[:, 2])
    xs = X0 + CELL * (np.arange(NX) + 0.5)
    ys = Y0 + CELL * (np.arange(NY) + 0.5)
    X, Y = np.meshgrid(xs, ys)
    Z = interp(X, Y).filled(np.nan).astype("<f4")
    Z.tofile(os.path.join(args.out, "dem_2m.f32"))

    # 3. measured mask, from the survey points themselves
    pts = []
    with open(os.path.join(args.out, "spot_levels.csv")) as f:
        for row in csv.DictReader(f):
            pts.append((float(row["x_local"]), float(row["y_local"])))
    pts = np.array(pts)
    measured = np.zeros((NY, NX), dtype=np.uint8)
    r = int(math.ceil(MEASURED_RADIUS_M / CELL))
    pi = np.floor((pts[:, 0] - X0) / CELL).astype(int)
    pj = np.floor((pts[:, 1] - Y0) / CELL).astype(int)
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            ii, jj = pi + di, pj + dj
            ok = (ii >= 0) & (ii < NX) & (jj >= 0) & (jj < NY)
            ii, jj, p = ii[ok], jj[ok], pts[ok]
            cx = X0 + CELL * (ii + 0.5)
            cy = Y0 + CELL * (jj + 0.5)
            near = np.hypot(cx - p[:, 0], cy - p[:, 1]) <= MEASURED_RADIUS_M
            measured[jj[near], ii[near]] = 1
    measured &= np.isfinite(Z).astype(np.uint8)
    measured.tofile(os.path.join(args.out, "dem_2m_measured.u8"))
    valid = int(np.isfinite(Z).sum())
    n_meas = int(measured.sum())
    print(f"DEM: {valid} cells ({valid * 4 / 1e4:.2f} ha); measured {n_meas} ({n_meas * 4 / 1e4:.2f} ha), "
          f"mesh-only {valid - n_meas} ({(valid - n_meas) * 4 / 1e4:.2f} ha)")

    with open(os.path.join(args.out, "dem_2m.json"), "w") as f:
        json.dump({
            "format": "raw little-endian float32, row-major, row 0 = southernmost row (y0)",
            "nodata": "NaN (outside the mesh)",
            "cell_m": CELL, "x0": X0, "y0": Y0, "nx": NX, "ny": NY,
            "cell_centre": "x = x0 + cell*(i+0.5), y = y0 + cell*(j+0.5)",
            "coords": "local metres (see site_origin.json)",
            "source": "linear interpolation of terrain_mesh.obj (kerala_site final_mesh.obj, 2026-09-24)",
            "valid_cells": valid,
            "rl_min": float(np.nanmin(Z)), "rl_max": float(np.nanmax(Z)),
            "measured_mask": "dem_2m_measured.u8",
            "measured_note": f"uint8 per cell, 1 where a survey point (spot_levels.csv) lies within {MEASURED_RADIUS_M} m "
                             "of the cell centre. Elsewhere the level is the modeller's mesh, not a measurement.",
            "measured_cells": n_meas,
            "survey_slope": "survey_slope_deg.f32",
            "survey_slope_note": "float32 per cell, degrees: slope of the raw survey TIN facet under the cell centre "
                                 f"({os.path.basename(args.survey_tin)}); NaN outside the survey TIN.",
        }, f, indent=2)

    # 3b. slope of the raw survey, facet by facet, under each cell centre
    Vs, Fs = read_obj(args.survey_tin, False)
    plan_s, _surf_s, slope_s = facet_stats(Vs, Fs)
    keep_s = plan_s > 1e-9
    Fs, plan_s, slope_s = Fs[keep_s], plan_s[keep_s], slope_s[keep_s]
    finder = Triangulation(Vs[:, 0], Vs[:, 1], Fs).get_trifinder()
    face = finder(X, Y)
    S = np.where(face >= 0, slope_s[np.clip(face, 0, None)], np.nan).astype("<f4")
    S.tofile(os.path.join(args.out, "survey_slope_deg.f32"))
    over45_cells = int(np.nansum(S > 45))
    over45_facets_ac = float(plan_s[slope_s > 45].sum() / AC)
    print(f"survey TIN {len(Vs)} vertices, {len(Fs)} facets; over 45 deg: facets {over45_facets_ac:.2f} ac, "
          f"cells {over45_cells} ({over45_cells * CELL * CELL / AC:.2f} ac); mesh cells over 45 deg: "
          f"{int(np.nansum(np.degrees(np.arctan(np.hypot(*np.gradient(Z.astype(float), CELL)))) > 45))}")

    # 4. contours of the mesh
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    levels = np.arange(math.ceil(V[:, 2].min()), math.floor(V[:, 2].max()) + 1)
    cs = plt.tricontour(tri, V[:, 2], levels=levels)
    feats = []
    for lvl, segs in zip(cs.levels, cs.allsegs):
        for seg in segs:
            if len(seg) < 2:
                continue
            rl = int(round(lvl))
            feats.append({"type": "Feature", "properties": {"rl": rl, "major": rl % 5 == 0},
                          "geometry": {"type": "LineString",
                                       "coordinates": [[round(float(a), 2), round(float(b), 2)] for a, b in seg]}})
    with open(os.path.join(args.out, "contours_1m.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "name": "contours_1m",
                   "crs_note": "Coordinates are LOCAL metres: x = UTM43N(EPSG:32643) E - 706106.927, "
                               "y = N - 953717.901. Levels are RL on assumed datum TBM=100.000 (not MSL). "
                               "Contoured from terrain_mesh.obj.",
                   "features": feats}, f)
    print(f"contours: {len(feats)} lines")

    # 5. golden values for the tests
    top = int(np.argmax(V[:, 2]))
    bands = [float(plan[(slope >= lo) & (slope < hi)].sum() / AC) for lo, hi in zip(SLOPE_EDGES[:-1], SLOPE_EDGES[1:])]
    falls = window_fall_bands(Z)
    keys = ["0-5", "5-10", "10-15", "15-20", "20-30", "30-45", "45-90"]
    fkeys = ["<0.5", "0.5-1", "1-2", "2-3", ">3"]
    print("\n--- tests/expected_values.yaml terrain block ---")
    print("terrain_tin:")
    print("  source: \"data/processed/terrain_mesh.obj (tools/preprocess/build_terrain.py)\"")
    print(f"  vertices: {len(V)}")
    print(f"  faces: {len(F)}")
    print(f"  meshed_plan_area_ac: {{value: {plan.sum() / AC:.2f}, tol_pct: 0.5}}")
    print(f"  rl_min: {V[:, 2].min():.3f}")
    print(f"  rl_max: {V[:, 2].max():.3f}")
    print(f"  summit_utm: [{V[top, 0] + E0:.1f}, {V[top, 1] + N0:.1f}]")
    print("  facet_slope_bands_ac: {tol_pct: 2.0, values: {" + ", ".join(f'"{k}": {v:.2f}' for k, v in zip(keys, bands)) + "}}")
    print("  plot_window_fall_ac:   # 11.4 x 14.2 m window, fall = max-min, on the 2 m DEM")
    print("    note: \"recomputed from the final mesh DEM by build_terrain.py; tol 10%\"")
    print("    values: {" + ", ".join(f'"{k}": {v:.2f}' for k, v in zip(fkeys, falls)) + "}")
    print(f"  dem_valid_ac: {valid * CELL * CELL / AC:.2f}")
    print(f"  dem_measured_ac: {n_meas * CELL * CELL / AC:.2f}")
    print(f"  survey_over_45_ac: {{value: {over45_cells * CELL * CELL / AC:.2f}, tol_pct: 1.0}}   # cells under a survey TIN facet over 45 deg")


if __name__ == "__main__":
    main()
