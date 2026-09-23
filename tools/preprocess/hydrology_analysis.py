"""Terrain hydrology from the 2 m DEM: depressions, catchments and a water balance.

Writes data/processed/hydrology_report.json (and .xlsx when pandas is installed).
The app reads the JSON; the same rules live in app/src/engine/terrain/hydrology.ts
and the two must agree:

- A hollow holds water where the priority-flood level is >= PONDING_DEPTH_M above
  the ground. Shallower hollows are DEM noise on a 2 m grid.
- Flow runs on the FILLED surface. Cells on a filled flat drain to the cell that
  flooded them, so a depression routes through its spill point instead of
  splitting into one catchment per flat cell.
- Balance per storm: runoff = area x rain x C; ponded = min(storage, runoff);
  outflow = runoff - ponded. Rates are the 24 h mean, not an IDF peak.
"""
import argparse
import heapq
import json
import math
import os

import numpy as np

PONDING_DEPTH_M = 0.25

NEIGHBOURS = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]


def fetch_open_meteo_rainfall(lat, lon):
    """Mean annual and peak daily rainfall from the Open-Meteo archive, 2013-2023."""
    try:
        import requests

        url = (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={lat}&longitude={lon}&start_date=2013-01-01&end_date=2023-12-31"
            "&daily=precipitation_sum&timezone=auto"
        )
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        precip = np.array(response.json()["daily"]["precipitation_sum"], dtype=float)
        precip = precip[~np.isnan(precip)]
        years = len(precip) / 365.25
        return float(np.sum(precip) / years), float(np.max(precip))
    except Exception as e:  # noqa: BLE001 - any failure means "use the fallback"
        print(f"Warning: could not fetch from Open-Meteo ({e}). Using defaults.")
        return None, None


def load_dem(f32_path, json_path):
    with open(json_path, "r") as f:
        meta = json.load(f)
    dem = np.fromfile(f32_path, dtype=np.float32).reshape((meta["ny"], meta["nx"]))
    return dem, meta


def priority_flood(dem, nx, ny):
    """Fill level per cell, the cell that flooded it, and the pop order.

    Water escapes at the grid edge and at the edge of the surveyed ground. The
    pop order is a topological order of the flow graph: a cell is popped after
    the cell that flooded it and after every strictly lower neighbour.
    """
    filled = np.full((ny, nx), np.nan, dtype=np.float32)
    parent = np.full((ny, nx), -1, dtype=np.int64)
    seen = np.zeros((ny, nx), dtype=np.uint8)
    heap = []

    for j in range(ny):
        for i in range(nx):
            z = dem[j, i]
            if np.isnan(z):
                continue
            outlet = i == 0 or j == 0 or i == nx - 1 or j == ny - 1
            if not outlet:
                for di, dj in NEIGHBOURS:
                    if np.isnan(dem[j + dj, i + di]):
                        outlet = True
                        break
            if outlet:
                filled[j, i] = z
                seen[j, i] = 1
                heapq.heappush(heap, (float(z), j, i))

    order = []
    while heap:
        level, j, i = heapq.heappop(heap)
        order.append(j * nx + i)
        for di, dj in NEIGHBOURS:
            ni, nj = i + di, j + dj
            if not (0 <= ni < nx and 0 <= nj < ny):
                continue
            if seen[nj, ni]:
                continue
            nz = dem[nj, ni]
            if np.isnan(nz):
                continue
            seen[nj, ni] = 1
            filled[nj, ni] = max(nz, level)
            parent[nj, ni] = j * nx + i
            heapq.heappush(heap, (float(filled[nj, ni]), nj, ni))

    return filled, parent, order


def compute_hydrology(dem, filled, parent, order, nx, ny, cell_area):
    """Depression depth, receiver per cell and upslope area, all on the filled surface."""
    depression_depth = np.maximum(0, filled - dem)
    filled_flat = filled.reshape(-1)
    parent_flat = parent.reshape(-1)

    receiver = np.full(nx * ny, -1, dtype=np.int64)
    for k in order:
        i = k % nx
        j = k // nx
        z = filled_flat[k]
        best_drop = 0.0
        best = -1
        for di, dj in NEIGHBOURS:
            ni, nj = i + di, j + dj
            if not (0 <= ni < nx and 0 <= nj < ny):
                continue
            nz = filled_flat[nj * nx + ni]
            if np.isnan(nz):
                continue
            drop = (z - nz) / math.hypot(di, dj)
            if drop > best_drop:
                best_drop = drop
                best = nj * nx + ni
        # On a filled flat nothing is lower: drain to the cell that flooded us,
        # which leads to the spill point. Only boundary seeds have no parent.
        receiver[k] = best if best >= 0 else parent_flat[k]

    accumulation = np.zeros(nx * ny, dtype=np.float64)
    for k in order:
        accumulation[k] += cell_area
    for k in reversed(order):
        r = receiver[k]
        if r >= 0:
            accumulation[r] += accumulation[k]

    return depression_depth, accumulation.reshape((ny, nx)), receiver


def find_catchments(receiver, order, nx, ny):
    """Label every cell with the outlet it drains to. Outlets are cells with no receiver."""
    catchment = np.full(nx * ny, -1, dtype=np.int64)
    outlets = []
    for k in order:  # receivers are popped before the cells that drain to them
        r = receiver[k]
        if r < 0:
            catchment[k] = len(outlets)
            outlets.append(k)
        else:
            catchment[k] = catchment[r]
    return catchment.reshape((ny, nx)), outlets


def compass(dx, dy):
    names = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"]
    angle = math.degrees(math.atan2(dy, dx)) % 360
    return names[int((angle + 22.5) // 45) % 8]


def balance(area_m2, rain_mm, runoff_coeff, storage_m3):
    runoff = area_m2 * (rain_mm / 1000.0) * runoff_coeff
    ponded = min(storage_m3, runoff)
    return runoff, ponded, runoff - ponded


def main():
    parser = argparse.ArgumentParser(description="Terrain hydrology from the 2 m DEM")
    parser.add_argument("--dem", default="../../data/processed/dem_2m.f32")
    parser.add_argument("--meta", default="../../data/processed/dem_2m.json")
    parser.add_argument("--out-dir", default="../../data/processed")
    parser.add_argument("--config", type=str, help="Optional JSON with the climate parameters")
    parser.add_argument("--fetch-api", action="store_true", help="Fetch rainfall from Open-Meteo")
    parser.add_argument("--lat", type=float, default=8.6274167)
    parser.add_argument("--lon", type=float, default=76.8762222)
    # Fallbacks are the Open-Meteo archive values for the site, 2013-2023,
    # fetched 2026-09-23. Re-run with --fetch-api to refresh them.
    parser.add_argument("--rainfall", type=float, default=2497.0, help="Mean annual rainfall (mm)")
    parser.add_argument("--peak_rainfall", type=float, default=151.8, help="Peak daily rainfall (mm)")
    parser.add_argument("--runoff_natural", type=float, default=0.25)
    parser.add_argument("--runoff_developed", type=float, default=0.40)
    parser.add_argument("--min-area-ha", type=float, default=0.5, help="Smallest catchment reported")
    args = parser.parse_args()

    rainfall, peak_rainfall = args.rainfall, args.peak_rainfall
    r_nat, r_dev = args.runoff_natural, args.runoff_developed
    climate_source = "fallback (Open-Meteo archive 2013-2023, fetched 2026-09-23)"

    if args.config and os.path.exists(args.config):
        with open(args.config, "r") as f:
            cfg = json.load(f)
        rainfall = cfg.get("annual_rainfall_mm", rainfall)
        peak_rainfall = cfg.get("peak_daily_rainfall_mm", peak_rainfall)
        r_nat = cfg.get("runoff_coeff_natural", r_nat)
        r_dev = cfg.get("runoff_coeff_developed", r_dev)
        climate_source = f"config {args.config}"
        if cfg.get("fetch_api"):
            args.fetch_api = True

    if args.fetch_api:
        print(f"Fetching climate data for lat {args.lat}, lon {args.lon} from Open-Meteo...")
        api_annual, api_peak = fetch_open_meteo_rainfall(args.lat, args.lon)
        if api_annual is not None and api_peak is not None:
            rainfall, peak_rainfall = api_annual, api_peak
            climate_source = "Open-Meteo archive 2013-2023"
            print(f"Fetched -> annual {rainfall:.1f} mm, peak daily {peak_rainfall:.1f} mm")

    dem, meta = load_dem(args.dem, args.meta)
    nx, ny, cell = meta["nx"], meta["ny"], meta["cell_m"]
    cell_area = cell * cell
    x0, y0 = meta.get("x0", 0.0), meta.get("y0", 0.0)

    print("Priority flood...")
    filled, parent, order = priority_flood(dem, nx, ny)
    print("Flow directions, accumulation, depression depth...")
    dep_depth, accum, receiver = compute_hydrology(dem, filled, parent, order, nx, ny, cell_area)
    print("Catchments...")
    catchment, outlets = find_catchments(receiver, order, nx, ny)

    valid = ~np.isnan(dem)
    ponded_cells = dep_depth >= PONDING_DEPTH_M
    site_totals = {
        "total_area_ha": round(float(valid.sum() * cell_area / 1e4), 3),
        "total_sinks_m3": round(float(np.nansum(dep_depth) * cell_area), 1),
        "total_ponding_area_ha": round(float(ponded_cells.sum() * cell_area / 1e4), 3),
        "max_sink_depth_m": round(float(np.nanmax(dep_depth)), 3),
        "ponding_depth_m": PONDING_DEPTH_M,
    }

    n = len(outlets)
    flat_cat = catchment.reshape(-1)
    known = flat_cat >= 0
    areas = np.bincount(flat_cat[known], minlength=n) * cell_area
    storage = np.bincount(flat_cat[known], weights=dep_depth.reshape(-1)[known], minlength=n) * cell_area
    surface = np.bincount(flat_cat[known], weights=ponded_cells.reshape(-1)[known].astype(float), minlength=n) * cell_area

    jj, ii = np.nonzero(valid)
    cx = x0 + cell * (ii.mean() + 0.5)
    cy = y0 + cell * (jj.mean() + 0.5)

    major = [c for c in range(n) if areas[c] >= args.min_area_ha * 1e4]
    major.sort(key=lambda c: areas[c], reverse=True)

    catchments = []
    for rank, c in enumerate(major, start=1):
        k = outlets[c]
        ox = x0 + cell * (k % nx + 0.5)
        oy = y0 + cell * (k // nx + 0.5)
        area_m2 = float(areas[c])
        storage_m3 = float(storage[c])
        peak_runoff, peak_ponded, peak_out = balance(area_m2, peak_rainfall, r_nat, storage_m3)
        annual_runoff, _annual_ponded, annual_out = balance(area_m2, rainfall, r_nat, storage_m3)
        catchments.append(
            {
                "node_id": int(c),
                "name": f"Basin {rank} · drains {compass(ox - cx, oy - cy)}",
                "outlet_xy_m": [round(float(ox), 1), round(float(oy), 1)],
                "catchment_area_ha": round(area_m2 / 1e4, 3),
                "water_surface_ha": round(float(surface[c]) / 1e4, 3),
                "storage_capacity_m3": round(storage_m3, 1),
                "peak_runoff_m3": round(peak_runoff, 1),
                "peak_ponded_m3": round(peak_ponded, 1),
                "peak_outflow_m3": round(peak_out, 1),
                "annual_runoff_m3": round(annual_runoff, 1),
                "annual_outflow_m3": round(annual_out, 1),
            }
        )

    report = {
        "method": {
            "flow_surface": "priority-flood filled DEM, flats drain to the cell that flooded them",
            "ponding_depth_m": PONDING_DEPTH_M,
            "balance": "runoff = area x rain x C; ponded = min(storage, runoff); outflow = runoff - ponded",
            "climate_source": climate_source,
            "min_catchment_area_ha": args.min_area_ha,
        },
        "climate_params": {
            "annual_rainfall_mm": float(rainfall),
            "peak_daily_rainfall_mm": float(peak_rainfall),
            "runoff_coeff_natural": float(r_nat),
            "runoff_coeff_developed": float(r_dev),
        },
        "site_totals": site_totals,
        "catchment_count": n,
        "catchments": catchments,
    }

    print("\n================== HYDROLOGY REPORT ==================")
    print(json.dumps(site_totals, indent=2))
    print(f"{n} catchments, {len(catchments)} of {args.min_area_ha} ha or more, covering "
          f"{sum(c['catchment_area_ha'] for c in catchments):.2f} ha")
    for c in catchments[:10]:
        print(f"  {c['name']:<22} {c['catchment_area_ha']:6.3f} ha  storage {c['storage_capacity_m3']:8.1f} m3")

    out_json = os.path.join(args.out_dir, "hydrology_report.json")
    with open(out_json, "w") as f:
        json.dump(report, f, indent=2)
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
