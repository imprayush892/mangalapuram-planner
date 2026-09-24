"""Terrain hydrology from the 2 m DEM: hollows, catchments and the design storm.

    python hydrology_analysis.py            (needs numpy, pyyaml; pandas for the .xlsx)

Writes data/processed/hydrology_report.json (and .xlsx when pandas is installed).

Inputs all come from config/assumptions.yaml `hydrology`, which the app reads
too, and the model is the one in app/src/engine/terrain/hydrology.ts and
water.ts. app/src/engine/__tests__/hydrology.test.ts runs the app's model at
the design storm and checks it against this report, so the two cannot drift.

The model:

- Priority flood from the survey edge gives, per cell, the level water could
  escape at. A hollow is a connected patch below that level; its exit is the
  rim cell it was flooded from.
- Flow runs on the flooded surface: steepest descent, or on a flooded flat to
  the cell that flooded it, which leads to the spill.
- A storm is routed upslope-first. Each cell adds rain x C; every hollow holds
  what reaches it, filling from its lowest cell up, and passes on only what it
  cannot hold. Water is conserved: runoff = held + outflow.
- C for a storm is the CWC/RBF-16 coastal formula C = a (R F)^b, R in cm,
  unless the config fixes it.
- At the storm's peak, every channel cell gets a peak discharge (IMD
  short-duration rule over a Kirpich tc, on the runoff reaching it) and a
  Manning stage across a DEM cross-section; full ponds rise to the stage their
  exit runs at. Water depth at the peak = the deeper of the two.
"""
import argparse
import heapq
import json
import math
import os

import numpy as np
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
NEIGHBOURS = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]


def load_params(path):
    with open(path, encoding="utf-8") as f:
        h = yaml.safe_load(f)["hydrology"]
    required = ["annual_rainfall_mm", "design_storm_mm", "design_return_period_yr", "runoff_formula",
                "annual_runoff_coeff", "impervious_share_developed", "impervious_runoff_coeff",
                "ponding_depth_m", "standing_water_show_m", "channel_flow_lps"]
    missing = [k for k in required if h.get(k) is None]
    if missing:
        raise SystemExit(f"config/assumptions.yaml hydrology is missing {missing}")
    return h


def storm_runoff_coeff(p, rain_mm):
    if p.get("storm_runoff_coeff") is not None:
        return min(1.0, max(0.0, float(p["storm_runoff_coeff"])))
    f = p["runoff_formula"]
    return min(1.0, f["a"] * ((max(0.0, rain_mm) / 10.0) * f["area_reduction_factor"]) ** f["b"])


def developed_runoff_coeff(p, natural_c):
    s = min(1.0, max(0.0, p["impervious_share_developed"]))
    return s * p["impervious_runoff_coeff"] + (1 - s) * natural_c


def load_dem(out_dir):
    with open(os.path.join(out_dir, "dem_2m.json")) as f:
        meta = json.load(f)
    dem = np.fromfile(os.path.join(out_dir, "dem_2m.f32"), dtype="<f4").reshape(meta["ny"], meta["nx"])
    return dem.reshape(-1).astype(np.float64), meta


def build_model(z, nx, ny):
    """Flood levels, flow graph, catchments and hollows. Mirrors water.ts."""
    n = nx * ny
    finite = np.isfinite(z)
    filled = np.full(n, np.nan)
    parent = np.full(n, -1, dtype=np.int64)
    seen = np.zeros(n, dtype=bool)
    heap = []
    for k in np.flatnonzero(finite):
        i, j = k % nx, k // nx
        outlet = i == 0 or j == 0 or i == nx - 1 or j == ny - 1
        if not outlet:
            for di, dj in NEIGHBOURS:
                if not finite[(j + dj) * nx + i + di]:
                    outlet = True
                    break
        if outlet:
            filled[k] = z[k]
            seen[k] = True
            heapq.heappush(heap, (z[k], int(k)))
    order = []
    while heap:
        level, k = heapq.heappop(heap)
        order.append(k)
        i, j = k % nx, k // nx
        for di, dj in NEIGHBOURS:
            ni, nj = i + di, j + dj
            if not (0 <= ni < nx and 0 <= nj < ny):
                continue
            nk = nj * nx + ni
            if seen[nk] or not finite[nk]:
                continue
            seen[nk] = True
            filled[nk] = max(z[nk], level)
            parent[nk] = k
            heapq.heappush(heap, (filled[nk], nk))

    receiver = np.full(n, -1, dtype=np.int64)
    for k in order:
        i, j = k % nx, k // nx
        best_drop, best = 0.0, -1
        for di, dj in NEIGHBOURS:
            ni, nj = i + di, j + dj
            if not (0 <= ni < nx and 0 <= nj < ny):
                continue
            nk = nj * nx + ni
            if not finite[nk]:
                continue
            drop = (filled[k] - filled[nk]) / math.hypot(di, dj)
            if drop > best_drop:
                best_drop, best = drop, nk
        receiver[k] = best if best >= 0 else parent[k]

    catchment = np.full(n, -1, dtype=np.int64)
    outlets = []
    for k in order:
        r = receiver[k]
        if r < 0:
            catchment[k] = len(outlets)
            outlets.append(k)
        else:
            catchment[k] = catchment[r]

    depth = np.where(finite, filled - z, 0.0)
    rank = np.full(n, -1, dtype=np.int64)
    rank[np.array(order)] = np.arange(len(order))
    depression = np.full(n, -1, dtype=np.int64)
    deps = []
    for start in order:
        if depression[start] >= 0 or not depth[start] > 0:
            continue
        dep_id = len(deps)
        stack, cells = [start], []
        depression[start] = dep_id
        while stack:
            k = stack.pop()
            cells.append(k)
            i, j = k % nx, k // nx
            for di, dj in NEIGHBOURS:
                ni, nj = i + di, j + dj
                if not (0 <= ni < nx and 0 <= nj < ny):
                    continue
                nk = nj * nx + ni
                if depression[nk] >= 0 or not depth[nk] > 0:
                    continue
                depression[nk] = dep_id
                stack.append(nk)
        cells = np.array(cells)
        first = cells[np.argmin(rank[cells])]
        deps.append({
            "cells": cells,
            "spill": filled[start],
            "exit": int(parent[first]),
            "lowest": int(cells[np.argmin(z[cells])]),
            "max_depth": float(depth[cells].max()),
        })
    return {"z": z, "finite": finite, "filled": filled, "order": order, "receiver": receiver,
            "catchment": catchment, "outlets": outlets, "depth": depth,
            "depression": depression, "deps": deps}


def fill_depression(model, dep, volume, cell_area, water, nx, ny):
    """Mirrors fillDepression in hydrology.ts."""
    z = model["z"]
    if volume <= 0:
        return 0.0
    if volume >= dep["capacity"]:
        water[dep["cells"]] = np.maximum(0.0, dep["spill"] - z[dep["cells"]])
        return dep["capacity"]
    member = set(dep["cells"].tolist())
    heap = [(z[dep["lowest"]], dep["lowest"])]
    visited = {dep["lowest"]}
    flooded = []
    level = z[dep["lowest"]]
    used = 0.0
    while heap:
        zk, k = heapq.heappop(heap)
        if zk > level:
            needed = len(flooded) * (zk - level) * cell_area
            if used + needed >= volume:
                level += (volume - used) / (len(flooded) * cell_area)
                used = volume
                break
            used += needed
            level = zk
        else:
            needed = (level - zk) * cell_area
            if used + needed > volume:
                break
            used += needed
        flooded.append(k)
        i, j = k % nx, k // nx
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if di == 0 and dj == 0:
                    continue
                ni, nj = i + di, j + dj
                if not (0 <= ni < nx and 0 <= nj < ny):
                    continue
                nk = nj * nx + ni
                if nk in visited or nk not in member:
                    continue
                visited.add(nk)
                heapq.heappush(heap, (z[nk], nk))
    flooded = np.array(flooded, dtype=np.int64)
    water[flooded] = np.maximum(0.0, level - z[flooded])
    return volume


def simulate(model, p, rain_mm, c, cell_area, nx, ny, meta, paths):
    """Mirrors simulateStorm in hydrology.ts."""
    n = nx * ny
    own = max(0.0, rain_mm) / 1000.0 * max(0.0, c) * cell_area
    deps, depression, receiver = model["deps"], model["depression"], model["receiver"]
    exits_at = {}
    for d_id, d in enumerate(deps):
        exits_at.setdefault(d["exit"], []).append(d_id)
    flow = np.zeros(n)
    inflow = np.zeros(len(deps))
    held = np.zeros(len(deps))
    water = np.zeros(n)
    for k in reversed(model["order"]):
        flow[k] += own
        for d_id in exits_at.get(k, ()):
            stored = fill_depression(model, deps[d_id], inflow[d_id], cell_area, water, nx, ny)
            held[d_id] = stored
            flow[k] += inflow[d_id] - stored
        d = depression[k]
        if d >= 0:
            inflow[d] += flow[k]
            continue
        r = receiver[k]
        if r >= 0:
            flow[r] += flow[k]
    for d_id, d in enumerate(deps):
        spill = inflow[d_id] - held[d_id]
        if spill > 0:
            flow[d["cells"]] = spill

    real = np.array([d["max_depth"] >= p["ponding_depth_m"] for d in deps], dtype=bool)
    standing = np.zeros(n, dtype=bool)
    for d_id, d in enumerate(deps):
        if real[d_id]:
            cells = d["cells"]
            standing[cells] = water[cells] >= p["standing_water_show_m"]
    channel_m3 = p["channel_flow_lps"] / 1000.0 * 86400
    channel = (~standing) & (flow >= channel_m3)
    full = sum(1 for d_id, d in enumerate(deps) if real[d_id] and held[d_id] >= d["capacity"] * 0.999)

    cat = model["catchment"]
    counts = np.bincount(cat[cat >= 0], minlength=len(model["outlets"]))
    held_by = np.zeros(len(model["outlets"]))
    for d_id, d in enumerate(deps):
        c_id = cat[d["lowest"]]
        if c_id >= 0:
            held_by[c_id] += held[d_id]
    per = {}
    for c_id, outlet in enumerate(model["outlets"]):
        per[outlet] = {"area_m2": counts[c_id] * cell_area, "runoff_m3": counts[c_id] * own,
                       "held_m3": held_by[c_id], "outflow_m3": flow[outlet]}
    # the peak
    pk = p["peak_flow"]
    length, top = paths
    filled = model["filled"]
    peak_q = np.zeros(n)
    tc_min = np.zeros(n)
    ka, kb, kc = pk["kirpich"]["a"], pk["kirpich"]["b"], pk["kirpich"]["c"]
    cell = math.sqrt(cell_area)
    for k in np.flatnonzero(flow > 0):
        ln = max(cell, length[k])
        sl = max(pk["min_slope"], (top[k] - filled[k]) / ln)
        tc = max(pk["tc_min_minutes"], ka * ln ** kb * sl ** -kc)
        tc_min[k] = tc
        hours = min(24.0, tc / 60)
        peak_q[k] = flow[k] * (hours / 24) ** pk["short_duration_exponent"] / (hours * 3600)
    peak = water.copy()
    stage = np.full(n, np.nan)
    sec = Sections(model["z"], meta, pk)
    for k in np.flatnonzero(channel):
        r = receiver[k]
        if r < 0:
            continue
        stage[k] = sec.stage_at(int(k), int(r), float(peak_q[k]), filled)
    # height above nearest drainage, as in hydrology.ts
    drain = np.full(n, -1, dtype=np.int64)
    reach = pk["section_half_width_m"]
    zz = model["z"]
    for k in model["order"]:
        if channel[k] and math.isfinite(stage[k]):
            drain[k] = k
        else:
            r = receiver[k]
            if r >= 0:
                drain[k] = drain[r]
        d = drain[k]
        if d < 0:
            continue
        if cell * math.hypot(k % nx - d % nx, k // nx - d // nx) > reach:
            continue
        depth = stage[d] - zz[k]
        if depth > peak[k]:
            peak[k] = depth
    for d_id, d in enumerate(deps):
        if not real[d_id] or held[d_id] < d["capacity"] * 0.999:
            continue
        lvl = stage[d["exit"]]
        if lvl > d["spill"]:
            spread_pond(model["z"], d["cells"], d["spill"], lvl, filled, peak, nx, ny)
    peak_wet = peak >= p["standing_water_show_m"]
    best = max(model["outlets"], key=lambda o: peak_q[o])

    cells = len(model["order"])
    return {
        "peak_wet_area_m2": float(peak_wet.sum() * cell_area),
        "peak_outflow_m3s": float(peak_q[best]),
        "peak_outflow_tc_min": float(tc_min[best]),
        "rain_mm": rain_mm, "runoff_coeff": c,
        "rain_m3": max(0.0, rain_mm) / 1000.0 * cells * cell_area,
        "runoff_m3": cells * own, "held_m3": float(held.sum()),
        "outflow_m3": float(sum(flow[o] for o in model["outlets"])),
        "standing_area_m2": float(standing.sum() * cell_area),
        "channel_cells": int(channel.sum()),
        "ponds_full": full, "ponds_total": int(real.sum()),
        "per_catchment": per,
    }


def flow_paths(model, nx, cell):
    """Longest flow path length reaching each cell, and the level it starts at. Mirrors flowPathsFor."""
    n = len(model["z"])
    length = np.full(n, -1.0)
    top = np.full(n, np.nan)
    receiver, filled = model["receiver"], model["filled"]
    for k in reversed(model["order"]):
        if length[k] < 0:
            length[k] = 0.0
            top[k] = filled[k]
        r = receiver[k]
        if r < 0:
            continue
        di = (r % nx) - (k % nx)
        dj = (r // nx) - (k // nx)
        reach = length[k] + cell * math.hypot(di, dj)
        if reach > length[r]:
            length[r] = reach
            top[r] = top[k]
    return length, top


class Sections:
    """Manning stage across a DEM cross-section. Mirrors crossSections in hydrology.ts."""

    def __init__(self, z, meta, pk):
        self.z, self.nx, self.ny = z, meta["nx"], meta["ny"]
        self.x0, self.y0, self.cell = meta["x0"], meta["y0"], meta["cell_m"]
        self.pk = pk
        self.half = max(1, int(round(pk["section_half_width_m"])))

    def at(self, i, j):
        if i < 0 or j < 0 or i >= self.nx or j >= self.ny:
            return float("nan")
        return self.z[j * self.nx + i]

    def sample_bilinear(self, x, y):
        fx = (x - self.x0) / self.cell - 0.5
        fy = (y - self.y0) / self.cell - 0.5
        i, j = math.floor(fx), math.floor(fy)
        tx, ty = fx - i, fy - j
        v00, v10, v01, v11 = self.at(i, j), self.at(i + 1, j), self.at(i, j + 1), self.at(i + 1, j + 1)
        if not all(math.isfinite(v) for v in (v00, v10, v01, v11)):
            ci = math.floor((x - self.x0) / self.cell)
            cj = math.floor((y - self.y0) / self.cell)
            return self.at(ci, cj)
        return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty

    def stage_at(self, k, r, q, level):
        nx, half = self.nx, self.half
        i, j = k % nx, k // nx
        ri, rj = r % nx, r // nx
        ln = math.hypot(ri - i, rj - j)
        slope = max(self.pk["min_slope"], (level[k] - level[r]) / (self.cell * ln))
        px, py = -(rj - j) / ln, (ri - i) / ln
        cx, cy = self.x0 + self.cell * (i + 0.5), self.y0 + self.cell * (j + 0.5)
        count = 2 * half + 1
        xs = [cx + px * (s - half) for s in range(count)]
        ys = [cy + py * (s - half) for s in range(count)]
        zs = [self.sample_bilinear(xs[s], ys[s]) for s in range(count)]
        lo = hi = half
        while lo > 0 and math.isfinite(zs[lo - 1]):
            lo -= 1
        while hi < count - 1 and math.isfinite(zs[hi + 1]):
            hi += 1
        bed = zs[half]
        if not math.isfinite(bed) or not q > 0:
            return float("nan")
        sqrt_s = math.sqrt(slope)
        n_man = self.pk["manning_n"]

        def discharge(h):
            lvl = bed + h
            a = perim = 0.0
            s_ = half
            while s_ >= lo and zs[s_] < lvl:
                a += lvl - zs[s_]
                if s_ < half:
                    perim += math.hypot(1, zs[s_] - zs[s_ + 1])
                s_ -= 1
            s_ = half + 1
            while s_ <= hi and zs[s_] < lvl:
                a += lvl - zs[s_]
                perim += math.hypot(1, zs[s_] - zs[s_ - 1])
                s_ += 1
            perim = max(perim, 1.0)
            return a * (a / perim) ** (2 / 3) * sqrt_s / n_man

        low, high = 0.0, float(self.pk["max_depth_m"])
        if discharge(high) < q:
            low = high
        else:
            for _ in range(30):
                mid = (low + high) / 2
                if discharge(mid) < q:
                    low = mid
                else:
                    high = mid
        return bed + (low + high) / 2


def spread_pond(z, cells, spill, level, filled, paint, nx, ny):
    """Mirrors spreadPond: flood joined ground below `level` whose flood level is at or above the spill."""
    seen = set(int(k) for k in cells)
    stack = list(seen)
    while stack and len(seen) < 200_000:
        k = stack.pop()
        d = level - z[k]
        if d > paint[k]:
            paint[k] = d
        i, j = k % nx, k // nx
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if di == 0 and dj == 0:
                    continue
                ni, nj = i + di, j + dj
                if not (0 <= ni < nx and 0 <= nj < ny):
                    continue
                nk = nj * nx + ni
                if nk in seen or not z[nk] < level or not filled[nk] >= spill:
                    continue
                seen.add(nk)
                stack.append(nk)


def compass(dx, dy):
    names = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"]
    return names[int(((math.degrees(math.atan2(dy, dx)) % 360) + 22.5) // 45) % 8]


def r1(v):
    return round(float(v), 1)


def main():
    ap = argparse.ArgumentParser(description="Terrain hydrology from the 2 m DEM")
    ap.add_argument("--out-dir", default=os.path.join(REPO, "data", "processed"))
    ap.add_argument("--config", default=os.path.join(REPO, "config", "assumptions.yaml"))
    ap.add_argument("--min-area-ha", type=float, default=0.5, help="Smallest catchment listed")
    args = ap.parse_args()

    p = load_params(args.config)
    z, meta = load_dem(args.out_dir)
    nx, ny, cell = meta["nx"], meta["ny"], meta["cell_m"]
    cell_area = cell * cell
    x0, y0 = meta["x0"], meta["y0"]

    print("Priority flood, flow graph, hollows...")
    model = build_model(z, nx, ny)
    for d in model["deps"]:
        d["capacity"] = float(model["depth"][d["cells"]].sum() * cell_area)

    depth = model["depth"]
    valid = model["finite"]
    site_totals = {
        "total_area_ha": round(float(valid.sum() * cell_area / 1e4), 3),
        "total_sinks_m3": r1(depth[valid].sum() * cell_area),
        "total_ponding_area_ha": round(float((depth >= p["ponding_depth_m"]).sum() * cell_area / 1e4), 3),
        "max_sink_depth_m": round(float(depth[valid].max()), 3),
        "ponds": int(sum(1 for d in model["deps"] if d["max_depth"] >= p["ponding_depth_m"])),
        "hollows": len(model["deps"]),
    }

    storm_mm = float(p["design_storm_mm"])
    c_nat = storm_runoff_coeff(p, storm_mm)
    c_dev = developed_runoff_coeff(p, c_nat)
    print(f"Design storm {storm_mm} mm, C natural {c_nat:.3f}, developed {c_dev:.3f}...")
    paths = flow_paths(model, nx, cell)
    nat = simulate(model, p, storm_mm, c_nat, cell_area, nx, ny, meta, paths)
    dev = simulate(model, p, storm_mm, c_dev, cell_area, nx, ny, meta, paths)

    def summary(s):
        return {"rain_mm": s["rain_mm"], "runoff_coeff": round(s["runoff_coeff"], 4), "rain_m3": r1(s["rain_m3"]),
                "runoff_m3": r1(s["runoff_m3"]), "held_m3": r1(s["held_m3"]), "outflow_m3": r1(s["outflow_m3"]),
                "standing_water_ha": round(s["standing_area_m2"] / 1e4, 3),
                "under_water_at_peak_ha": round(s["peak_wet_area_m2"] / 1e4, 3),
                "peak_outflow_m3s": round(s["peak_outflow_m3s"], 3),
                "peak_outflow_tc_min": round(s["peak_outflow_tc_min"], 1),
                "ponds_full": s["ponds_full"],
                "ponds_total": s["ponds_total"]}

    finite_idx = np.flatnonzero(valid)
    cx = x0 + cell * ((finite_idx % nx).mean() + 0.5)
    cy = y0 + cell * ((finite_idx // nx).mean() + 0.5)
    cat = model["catchment"]
    pond_cells = depth >= p["ponding_depth_m"]
    cap_by = np.zeros(len(model["outlets"]))
    for d in model["deps"]:
        c_id = cat[d["lowest"]]
        if c_id >= 0:
            cap_by[c_id] += d["capacity"]
    pond_by = np.bincount(cat[cat >= 0], weights=pond_cells[cat >= 0].astype(float), minlength=len(model["outlets"]))

    listed = [(c_id, o) for c_id, o in enumerate(model["outlets"])
              if nat["per_catchment"][o]["area_m2"] >= args.min_area_ha * 1e4]
    listed.sort(key=lambda t: -nat["per_catchment"][t[1]]["area_m2"])
    catchments = []
    for rank, (c_id, o) in enumerate(listed, start=1):
        ox, oy = x0 + cell * (o % nx + 0.5), y0 + cell * (o // nx + 0.5)
        s = nat["per_catchment"][o]
        catchments.append({
            "node_id": int(c_id),
            "name": f"Basin {rank} · drains {compass(ox - cx, oy - cy)}",
            "outlet_cell": int(o),
            "outlet_xy_m": [r1(ox), r1(oy)],
            "catchment_area_ha": round(s["area_m2"] / 1e4, 3),
            "pond_area_ha": round(float(pond_by[c_id] * cell_area / 1e4), 3),
            "storage_capacity_m3": r1(cap_by[c_id]),
            "design_runoff_m3": r1(s["runoff_m3"]),
            "design_held_m3": r1(s["held_m3"]),
            "design_outflow_m3": r1(s["outflow_m3"]),
            "developed_outflow_m3": r1(dev["per_catchment"][o]["outflow_m3"]),
        })

    annual_runoff = site_totals["total_area_ha"] * 1e4 * p["annual_rainfall_mm"] / 1000 * p["annual_runoff_coeff"]
    report = {
        "method": {
            "model": "fill-and-spill on the priority-flood DEM; flats drain to the cell that flooded them",
            "runoff_coeff": "CWC/RBF-16 coastal C = a (R F)^b, R in cm, unless config fixes it",
            "config": "config/assumptions.yaml hydrology",
            "dem": meta.get("source"),
            "min_catchment_area_ha": args.min_area_ha,
            "peak": "IMD short-duration rule over a Kirpich tc gives each flow path its peak discharge; "
                    "Manning normal depth across a DEM cross-section; full ponds rise to their exit's stage",
            "limits": "volume balance over the storm plus steady normal depth at the peak: no pond seepage or "
                      "evaporation, no backwater, no culverts (none surveyed)",
        },
        "params": p,
        "site_totals": site_totals,
        "design_storm": {"return_period_yr": p["design_return_period_yr"], "natural": summary(nat),
                         "developed": summary(dev)},
        "annual": {"rainfall_mm": p["annual_rainfall_mm"], "runoff_coeff": p["annual_runoff_coeff"],
                   "runoff_m3": r1(annual_runoff),
                   "outflow_after_one_fill_m3": r1(max(0.0, annual_runoff - site_totals["total_sinks_m3"]))},
        "catchment_count": len(model["outlets"]),
        "catchments": catchments,
    }

    print(json.dumps(site_totals, indent=2))
    print(json.dumps(report["design_storm"], indent=2))
    print(f"{len(model['outlets'])} catchments; {len(catchments)} of {args.min_area_ha} ha or more:")
    for c in catchments:
        print(f"  {c['name']:<22} {c['catchment_area_ha']:6.2f} ha  holds {c['storage_capacity_m3']:7.1f} m3  "
              f"design held {c['design_held_m3']:7.1f}  out {c['design_outflow_m3']:8.1f} m3")

    out_json = os.path.join(args.out_dir, "hydrology_report.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nJSON report saved to {out_json}")
    try:
        import pandas as pd
        out_xlsx = os.path.join(args.out_dir, "hydrology_report.xlsx")
        pd.DataFrame(catchments).to_excel(out_xlsx, index=False)
        print(f"Excel report saved to {out_xlsx}")
    except Exception as e:  # noqa: BLE001
        print(f"Excel report skipped ({e}); the JSON is the record.")


if __name__ == "__main__":
    main()
