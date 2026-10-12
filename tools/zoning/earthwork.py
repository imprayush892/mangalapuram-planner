"""Where a plan's earthwork money goes (owner 12 Oct, D7): the engine's own measure (plan.ts earthworkCost), split.

  python tools/zoning/earthwork.py <plan.json> <earthwork.f32> <roadmask.u8> <terrain.u8> <zones.geojson> [map.png]

Replays the engine's wall rule on the 2 m grid (a step in the finished ground over wall_min_step_m between neighbouring
cells, one of them touched, up to wall_max_height_m; taller is a bank) and splits cut, fill and walls by what owns the
cells either side (plot platform, road, building, untouched ground), by height band, by zone and phase, and by whether
the ground itself already steps that much (a slope over 1:4 steps 0.5 m in 2 m: the rule walls it wherever it is
touched). With map.png: the walls drawn by height over the plan.
"""
import json
import os
import sys

import numpy as np
from matplotlib.path import Path

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
AC = 4046.8564224


def yaml_num(path, key, default):
    """A number from config/assumptions.yaml earthwork_costs (plain text: no YAML dependency)."""
    for line in open(os.path.join(REPO, "config", "assumptions.yaml"), encoding="utf-8"):
        s = line.split("#")[0].strip()
        if s.startswith(key + ":"):
            v = s.split(":", 1)[1].strip()
            return json.loads(v) if v.startswith("[") else float(v)
    return default


def load(plan_p, ew_p, rm_p, terr_p, zones_p):
    meta = json.load(open(os.path.join(REPO, "data", "processed", "dem_2m.json")))
    nx, ny, cell, x0, y0 = meta["nx"], meta["ny"], meta["cell_m"], meta["x0"], meta["y0"]
    dem = np.fromfile(os.path.join(REPO, "data", "processed", "dem_2m.f32"), dtype="<f4").reshape(ny, nx)
    delta = np.fromfile(ew_p, dtype="<f4").reshape(ny, nx)
    road = np.fromfile(rm_p, dtype=np.uint8).reshape(ny, nx) > 0
    terr = np.fromfile(terr_p, dtype=np.uint8).reshape(ny, nx) > 0
    plan = json.load(open(plan_p, encoding="utf-8"))
    zfc = json.load(open(zones_p, encoding="utf-8"))
    xs = x0 + cell * (np.arange(nx) + 0.5)
    ys = y0 + cell * (np.arange(ny) + 0.5)
    X, Y = np.meshgrid(xs, ys)
    pts = np.column_stack([X.ravel(), Y.ravel()])

    def raster(rings):
        m = np.zeros(nx * ny, bool)
        for r in rings:
            r = np.asarray(r)
            lo, hi = r.min(0) - 2, r.max(0) + 2
            sel = np.where((pts[:, 0] >= lo[0]) & (pts[:, 0] <= hi[0]) & (pts[:, 1] >= lo[1]) & (pts[:, 1] <= hi[1]))[0]
            if len(sel):
                m[sel[Path(r).contains_points(pts[sel])]] = True
        return m.reshape(ny, nx)

    plot = raster([p["ring"] for p in plan["plots"]])
    bld = raster([b["ring"] for b in plan["buildings"]] + [b["podium"]["ring"] for b in plan["buildings"] if b.get("podium")])
    # owner of a cell: building, plot, road, else untouched (0) or other (graded ground no plan item names)
    own = np.full((ny, nx), "ground", dtype=object)
    own[road] = "road"
    own[plot] = "plot"
    own[bld] = "building"
    own[(delta == 0) & ~road & ~plot & ~bld] = "ground"
    zone_id = np.full((ny, nx), -1, int)
    zinfo = []
    for f in zfc["features"]:
        if not f.get("geometry"):
            continue
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        m = np.zeros((ny, nx), bool)
        for poly in polys:
            outer = raster([poly[0]])
            for hole in poly[1:]:
                outer &= ~raster([hole])
            m |= outer
        zinfo.append(f["properties"])
        zone_id[m & (zone_id < 0)] = len(zinfo) - 1
    return dict(nx=nx, ny=ny, cell=cell, x0=x0, y0=y0, dem=dem, delta=delta, road=road, terr=terr, plan=plan, own=own,
                zone_id=zone_id, zinfo=zinfo, plot=plot, bld=bld)


def walls(S):
    dem, delta, terr, cell = S["dem"], S["delta"], S["terr"], S["cell"]
    a, b = yaml_num(None, "wall_concrete_m3_per_m", [0.38, 0.04])
    min_step = yaml_num(None, "wall_min_step_m", 0.5)
    max_wall = yaml_num(None, "wall_max_height_m", 6.0)
    fin = dem + delta
    out = []
    for axis in (1, 0):
        A = (slice(None), slice(0, -1)) if axis == 1 else (slice(0, -1), slice(None))
        B = (slice(None), slice(1, None)) if axis == 1 else (slice(1, None), slice(None))
        ok = terr[A] & terr[B] & ~((delta[A] == 0) & (delta[B] == 0)) & np.isfinite(fin[A]) & np.isfinite(fin[B])
        h = np.abs(fin[A] - fin[B])
        nat = np.abs(dem[A] - dem[B])
        jj, ii = np.nonzero(ok & (h > min_step))
        for j, i in zip(jj, ii):
            j2, i2 = (j, i + 1) if axis == 1 else (j + 1, i)
            hh = float(h[j, i])
            out.append((j, i, j2, i2, hh, float(nat[j, i]), axis))
    rs_m3 = yaml_num(None, "rcc_wall_rs_per_m3", 21500)
    rows = []
    for (j, i, j2, i2, hh, nat, axis) in out:
        bank = hh > max_wall
        vol = 0.0 if bank else cell * (a * hh + b * hh * hh)
        rows.append(dict(j=j, i=i, j2=j2, i2=i2, h=hh, nat=nat, bank=bank, vol=vol, rs=vol * rs_m3, axis=axis))
    return rows


def report(S, rows, label):
    own, zone_id, zinfo, cell, delta = S["own"], S["zone_id"], S["zinfo"], S["cell"], S["delta"]
    exc = yaml_num(None, "excavation_rs_per_m3", 350)
    bf = yaml_num(None, "backfill_rs_per_m3", 300)
    ca = cell * cell
    cut = float(-delta[delta < 0].sum() * ca)
    fill = float(delta[delta > 0].sum() * ca)
    W = [r for r in rows if not r["bank"]]
    tot_w = sum(r["rs"] for r in W)
    total = cut * exc + min(cut, fill) * bf + tot_w
    print(f"== {label}: cut {cut:,.0f} m3, fill {fill:,.0f} m3, walls {len(W) * cell:,.0f} m / {sum(r['vol'] for r in W):,.0f} m3, "
          f"banks {sum(1 for r in rows if r['bank']) * cell:,.0f} m; Rs {total / 1e7:.2f} Cr (excavation {cut * exc / 1e7:.2f}, "
          f"backfill {min(cut, fill) * bf / 1e7:.2f}, walls {tot_w / 1e7:.2f})")
    # cut and fill by owner
    print("  cut / fill by owner (m3):", ", ".join(
        f"{k} {float(-delta[(own == k) & (delta < 0)].sum() * ca):,.0f}/{float(delta[(own == k) & (delta > 0)].sum() * ca):,.0f}"
        for k in ("plot", "road", "building", "ground")))

    def table(keyf, title):
        acc = {}
        for r in W:
            k = keyf(r)
            e = acc.setdefault(k, [0.0, 0.0, 0.0])
            e[0] += cell
            e[1] += r["vol"]
            e[2] += r["rs"]
        print(f"  walls by {title}:")
        for k, (L, V, R) in sorted(acc.items(), key=lambda kv: -kv[1][2]):
            print(f"    {str(k):44s} {L:8,.0f} m {V:7,.0f} m3  Rs {R / 1e7:6.2f} Cr  {100 * R / max(tot_w, 1):5.1f}%")

    def pair(r):
        a, b = own[r["j"], r["i"]], own[r["j2"], r["i2"]]
        return " / ".join(sorted((a, b)))

    def band(r):
        h = r["h"]
        for lo, hi in ((0.5, 1), (1, 2), (2, 3), (3, 4), (4, 6.01)):
            if h <= hi:
                return f"{lo}-{hi if hi < 6 else 6} m"
        return ">6"

    def zone(r):
        z = zone_id[r["j"], r["i"]]
        if z < 0:
            z = zone_id[r["j2"], r["i2"]]
        return (zinfo[z].get("use", "?") + " ph" + str(zinfo[z].get("phase", "-"))) if z >= 0 else "outside zones (roads)"

    def phase(r):
        z = zone_id[r["j"], r["i"]]
        if z < 0:
            z = zone_id[r["j2"], r["i2"]]
        return f"phase {zinfo[z].get('phase', '-')}" if z >= 0 else "outside zones (roads)"

    table(pair, "what meets what")
    table(band, "height")
    table(lambda r: "ground already steps > 0.5 m (slope > 1:4)" if r["nat"] > 0.5 else "made by the grading", "cause")
    table(zone, "zone use")
    table(phase, "phase")
    return dict(cut=cut, fill=fill, wall_m=len(W) * cell, wall_m3=sum(r["vol"] for r in W), rs=total, rs_walls=tot_w)


def draw(S, rows, out_png, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    dem, cell, x0, y0 = S["dem"], S["cell"], S["x0"], S["y0"]
    gy, gx = np.gradient(np.nan_to_num(dem, nan=np.nanmean(dem)), cell)
    shade = np.clip(0.75 - 0.6 * (gx * -0.7 + gy * 0.7), 0, 1)
    shade[~S["terr"]] = np.nan
    fig, ax = plt.subplots(figsize=(15, 11.5), dpi=130)
    ext = (x0, x0 + cell * S["nx"], y0, y0 + cell * S["ny"])
    ax.imshow(shade, origin="lower", extent=ext, cmap="gray", vmin=0, vmax=1.2, alpha=0.55)
    d = np.ma.masked_where((S["delta"] == 0) | ~S["terr"], S["delta"])
    im = ax.imshow(d, origin="lower", extent=ext, cmap="RdBu_r", vmin=-4, vmax=4, alpha=0.75)
    for p in S["plan"]["plots"]:
        r = np.asarray(p["ring"] + [p["ring"][0]])
        ax.plot(r[:, 0], r[:, 1], lw=0.25, color="#333")
    for b in S["plan"]["buildings"]:
        r = np.asarray(b["ring"] + [b["ring"][0]])
        ax.plot(r[:, 0], r[:, 1], lw=0.6, color="k")
    segs, cols = [], []
    cmap = plt.get_cmap("YlOrRd")
    for r in rows:
        if r["bank"]:
            continue
        j, i, axis = r["j"], r["i"], r["axis"]
        if axis == 1:   # wall on the vertical edge between (i, j) and (i+1, j)
            x = x0 + cell * (i + 1)
            segs.append([(x, y0 + cell * j), (x, y0 + cell * (j + 1))])
        else:
            y = y0 + cell * (j + 1)
            segs.append([(x0 + cell * i, y), (x0 + cell * (i + 1), y)])
        cols.append(cmap(min(1.0, 0.25 + r["h"] / 6)))
    ax.add_collection(LineCollection(segs, colors=cols, linewidths=1.6))
    ax.set_xlim(ext[0], ext[1])
    ax.set_ylim(ext[2], ext[3])
    ax.set_aspect("equal")
    ax.set_title(title, fontsize=11)
    cb = fig.colorbar(im, ax=ax, shrink=0.6, pad=0.01)
    cb.set_label("earthwork, m (+ fill, - cut)")
    sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(0, 6))
    cb2 = fig.colorbar(sm, ax=ax, shrink=0.6, pad=0.04)
    cb2.set_label("retaining wall height, m (lines)")
    fig.tight_layout()
    fig.savefig(out_png)


if __name__ == "__main__":
    S = load(*sys.argv[1:6])
    rows = walls(S)
    label = os.path.basename(sys.argv[1]).replace(".json", "")
    r = report(S, rows, label)
    if len(sys.argv) > 6:
        draw(S, rows, sys.argv[6], f"{label}: cut/fill and retaining walls - Rs {r['rs'] / 1e7:.1f} Cr "
                                     f"({r['wall_m'] / 1000:.1f} km of wall, {r['wall_m3']:,.0f} m3 RCC; cut {r['cut']:,.0f} m3, fill {r['fill']:,.0f} m3)")
