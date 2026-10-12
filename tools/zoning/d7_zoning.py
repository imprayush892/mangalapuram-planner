"""D7, least earthwork (owner 12 Oct 2026): the optimised zoning with the villas on the gentle land and the steep hill
green, at a few caps on how steep a villa cell may be; each measured for what its villa land costs to grade and drawn
over the slope.

  python tools/zoning/d7_zoning.py [outdir]     (default D:/New folder/_work/d7/zoning; D7_CAPS="120,140,150,165")

For each cap: optimise.py with D7=1 D7_MAX_RS=<cap> VILLA_AC=26 (an upper bound) OUT=<outdir>/zones_d7_<villa ac>.geojson;
the recommended cap (D7_FINAL, 150) is copied to zones_d7_final.geojson. Measured, on the 2 m grid:
  - the villa land by natural slope band (<1:8, 1:8-1:5, 1:5-1:4, 1:4-1:3, 1:3-1:2, >1:2) and its expected earthwork
    and walls by the D7 master's measured curve (Rs lakh an acre: 11, 35, 38, 91, 159, 221);
  - villas at the model's 12.5 an acre; the open space (parks, the lakes and the channel apart);
  - a map: every use coloured, the villa land outlined over the slope bands.
The D1 base and D3 are measured alike. data/processed is only read.
"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np
import shapely
from shapely.geometry import shape

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import warnings  # noqa: E402

warnings.simplefilter("ignore")
from site_grid import REPO, AC, NX, NY, X0, Y0, CELL, TERRAIN, LAKES, GRAD, PARCEL, FIXED_ROADS, mask_of  # noqa: E402

OUTDIR = sys.argv[1] if len(sys.argv) > 1 else "D:/New folder/_work/d7/zoning"
CAPS = [float(t) for t in os.environ.get("D7_CAPS", "120,140,150,165").split(",")]
FINAL_CAP = float(os.environ.get("D7_FINAL", 150))
VILLAS_PER_AC = 12.5                                   # the model's mix (D7 master)
BAND_EDGES = [1 / 8, 1 / 5, 1 / 4, 1 / 3, 1 / 2]
BAND_RS = [11, 35, 38, 91, 159, 221]                   # D7 master 12 Oct: earthwork + walls, Rs lakh an acre of villa land
BAND_NAMES = ["<1:8", "1:8-1:5", "1:5-1:4", "1:4-1:3", "1:3-1:2", ">1:2"]
BAND_COL = ["#F6F3EA", "#E6DCC0", "#D2B98A", "#C08552", "#94512F", "#5A2A1A"]


def measure(path):
    fc = json.load(open(path, encoding="utf-8"))
    by_use = {}
    for f in fc["features"]:
        p = f["properties"]
        by_use.setdefault("water" if p.get("water") else p["use"], []).append(shape(f["geometry"]))
    polys = {u: shapely.union_all(g) for u, g in by_use.items()}
    villa = mask_of(polys["villas"]) & TERRAIN
    g = GRAD[villa & np.isfinite(GRAD)]
    edges = [-1] + BAND_EDGES + [99]
    bands = [float(((g > edges[k]) & (g <= edges[k + 1])).sum() * CELL * CELL / AC) for k in range(len(BAND_RS))]
    m = dict(villa_ac=polys["villas"].area / AC, bands=bands, over_4_ac=sum(bands[3:]),
             rs_cr=sum(b * r for b, r in zip(bands, BAND_RS)) / 100, open_ac=polys["park"].area / AC,
             apt_ac=polys["apartments"].area / AC)
    m["villas"] = m["villa_ac"] * VILLAS_PER_AC
    return m, polys


def draw(polys, title, png):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap, BoundaryNorm
    from matplotlib.patches import Patch
    fig, ax = plt.subplots(figsize=(14, 10.5), dpi=90)
    sl = np.where(TERRAIN & ~LAKES, GRAD, np.nan)
    ax.imshow(sl, origin="lower", extent=(X0, X0 + NX * CELL, Y0, Y0 + NY * CELL), cmap=ListedColormap(BAND_COL),
              norm=BoundaryNorm([-1] + BAND_EDGES + [99], len(BAND_COL)), interpolation="nearest", zorder=1)
    col = {"retail": "#E58A3A", "office": "#C2553A", "apartments": "#7B5EA7", "senior": "#D07FB0", "school": "#E7C547",
           "clubhouse": "#5FC4B8", "park": "#3E8E4A", "water": "#2F7FA3"}

    def polys_of(g):
        return [p for p in getattr(g, "geoms", [g]) if p.geom_type == "Polygon"]
    for u, g in polys.items():
        if u == "villas":
            continue
        for p in polys_of(g):
            ax.fill(*p.exterior.xy, fc=col.get(u, "#999999"), ec="white", lw=0.5, alpha=0.35 if u == "park" else 0.85, zorder=3 if u == "park" else 4)
    for p in polys_of(polys["villas"]):          # the villa land: outlined, the slope read through it
        ax.fill(*p.exterior.xy, fc="#1F4E9A", ec="none", alpha=0.12, zorder=5)
        ax.plot(*p.exterior.xy, color="#1F4E9A", lw=1.8, zorder=6)
        for r in p.interiors:
            ax.plot(*r.xy, color="#1F4E9A", lw=1.0, zorder=6)
    for p in polys_of(FIXED_ROADS.intersection(PARCEL)):
        ax.fill(*p.exterior.xy, fc="#444444", ec="none", alpha=0.9, zorder=7)
    for p in polys_of(PARCEL):
        ax.plot(*p.exterior.xy, color="black", lw=1.0, zorder=8)
    hs = [Patch(fc=c, ec="#999999", label=f"slope {n}") for c, n in zip(BAND_COL, BAND_NAMES)]
    hs += [Patch(fc="#1F4E9A", alpha=0.3, ec="#1F4E9A", label="villa land")] + [Patch(fc=c, label=u) for u, c in col.items()]
    ax.legend(handles=hs, loc="lower left", fontsize=8, framealpha=0.9)
    b = PARCEL.bounds
    ax.set_xlim(b[0] - 10, b[2] + 10)
    ax.set_ylim(b[1] - 10, b[3] + 10)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(title, fontsize=10)
    fig.tight_layout()
    fig.savefig(png, facecolor="white")
    plt.close(fig)


def row(name, m):
    return (f"| {name} | {m['villa_ac']:.2f} | {m['villas']:.0f} | " + " | ".join(f"{b:.1f}" for b in m["bands"]) +
            f" | **{m['over_4_ac']:.1f}** | **{m['rs_cr']:.1f}** | {m['open_ac']:.2f} |")


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    runs = []
    for cap in CAPS:
        tmp = os.path.join(OUTDIR, f"_d7_cap{cap:g}.geojson")
        env = dict(os.environ, D7="1", D7_MAX_RS=str(cap), VILLA_AC=os.environ.get("VILLA_AC", "26"), OUT=tmp)
        r = subprocess.run([sys.executable, os.path.join(HERE, "optimise.py")], env=env, capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(r.stderr[-2000:])
        m, _ = measure(tmp)
        out = os.path.join(OUTDIR, f"zones_d7_{m['villa_ac']:.1f}.geojson")
        os.replace(tmp, out)
        runs.append((f"D7 cap {cap:g} (zones_d7_{m['villa_ac']:.1f})", out, cap))
        if cap == FINAL_CAP:
            shutil.copyfile(out, os.path.join(OUTDIR, "zones_d7_final.geojson"))
    refs = [("D1 base (zones_draft_model)", f"{REPO}/data/processed/zones_draft_model.geojson", None),
            ("D3 pockets (zones_draft_model_pockets)", f"{REPO}/data/processed/zones_draft_model_pockets.geojson", None)]
    res = {}
    for name, p, cap in refs + runs:
        m, polys = measure(p)
        res[name] = m
        if cap is not None:
            draw(polys, f"{name}: villa land {m['villa_ac']:.1f} ac (~{m['villas']:.0f} villas), {m['over_4_ac']:.1f} ac over 1:4, "
                 f"villa earthwork ~Rs {m['rs_cr']:.1f} Cr; open space {m['open_ac']:.1f} ac", p.replace(".geojson", ".png"))
            if cap == FINAL_CAP:
                shutil.copyfile(p.replace(".geojson", ".png"), os.path.join(OUTDIR, "zones_d7_final.png"))
    hdr = ("| zoning | villa land, ac | villas at 12.5/ac | " + " | ".join(f"{n}, ac" for n in BAND_NAMES) +
           " | over 1:4, ac | villa earthwork + walls, Rs Cr (curve) | open space, ac |\n|" + "---|" * 12)
    lines = [hdr] + [row(n, res[n]) for n, _, _ in refs + runs]
    print("\n".join(lines))
    json.dump(res, open(os.path.join(OUTDIR, "metrics.json"), "w"), indent=1)
    fin = next(res[n] for n, _, c in runs if c == FINAL_CAP)
    d3 = res[refs[1][0]]
    md = ["# D7 zoning, least earthwork (owner 12 Oct)", "",
          f"Recommended: **zones_d7_final.geojson** (cap {FINAL_CAP:g}): {fin['villa_ac']:.1f} ac of villa land, ~{fin['villas']:.0f} villas at "
          f"{VILLAS_PER_AC} an acre, {fin['over_4_ac']:.1f} ac over 1:4, villa earthwork + walls ~Rs {fin['rs_cr']:.1f} Cr on the D7 master's "
          f"curve (D3 Rs {d3['rs_cr']:.1f} Cr on the same curve, {100 * (1 - fin['rs_cr'] / d3['rs_cr']):.0f}% less); open space {fin['open_ac']:.1f} ac.", "",
          "D7=1 in optimise.py: villa cost = the premium + Rs lakh/ac / 15 (the curve on each 20 m cell's 2 m slopes); no villa on a cell "
          "over D7_MAX_RS (VILLA_AC then an upper bound: the villas take the gentle land the other uses leave); the towers C11/C20 (+C14) "
          "pay D7_WT on gentle land, so go up the hill (areas, 20 floors under the airport line, phases kept); the villa clubhouses on "
          "the villas' steepest land; villa blocks from 0.5 ac. Pins (C19, C02, school), senior, retail/office, KEEP_GREEN, lakes and "
          "channel as the base. No flag: byte-identical to data/processed/zones_draft_model.geojson.", ""] + lines + ["",
          "Maps: zones_d7_<ac>.png (uses coloured, the villa land outlined over the six slope bands)."]
    open(os.path.join(OUTDIR, "summary.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
    return res, lines


if __name__ == "__main__":
    main()
