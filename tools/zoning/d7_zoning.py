"""D7, least earthwork (owner 12 Oct 2026): the optimised zoning with the villas on the gentlest land the other uses leave
and the steepest green, measured for what its villa land costs to grade and drawn over the slope.

  python tools/zoning/d7_zoning.py [outdir]     (default D:/New folder/_work/d7/zoning)

Writes <outdir>/zones_d7_base.geojson (optimise.py with D7=1 VILLA_AC=30: the base the master plans, then greens.py
pockets on it) and two with less of the hill (D7_MAX_RS 180, 165) for comparison, each with a map, and summary.md with:
  - the villa land by natural slope band (<1:8, 1:8-1:5, 1:5-1:4, 1:4-1:3, 1:3-1:2, >1:2) and its expected earthwork
    and walls by the D7 master's measured curve (Rs lakh an acre: 11, 35, 38, 91, 159, 221);
  - villas at the model's 12.5 an acre; the open space (parks, the lakes and the channel apart); the villa blocks and
    how many are under 1.5 ac; the towers, senior, school and retail/office checked against the optimised zoning.
The D1 base and D3 are measured alike. data/processed is only read.
"""
import json
import os
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
VILLAS_PER_AC = 12.5                                   # the model's mix (D7 master)
BAND_EDGES = [1 / 8, 1 / 5, 1 / 4, 1 / 3, 1 / 2]
BAND_RS = [11, 35, 38, 91, 159, 221]                   # D7 master 12 Oct: earthwork + walls, Rs lakh an acre of villa land
BAND_NAMES = ["<1:8", "1:8-1:5", "1:5-1:4", "1:4-1:3", "1:3-1:2", ">1:2"]
BAND_COL = ["#F6F3EA", "#E6DCC0", "#D2B98A", "#C08552", "#94512F", "#5A2A1A"]
# (name, env): the base, and two with less villa land on the hill (no villa on a cell dearer than the cap, Rs lakh/ac)
VARIANTS = [("base", {}), ("base_cap180", {"D7_MAX_RS": "180"}), ("base_cap165", {"D7_MAX_RS": "165"})]
PINNED = ("apartments", "senior", "school", "retail", "office")
FRAGMENT_AC = 1.5


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
    pcs = [q.area / AC for q in getattr(polys["villas"], "geoms", [polys["villas"]])]
    m = dict(villa_ac=polys["villas"].area / AC, bands=bands, over_4_ac=sum(bands[3:]),
             rs_cr=sum(b * r for b, r in zip(bands, BAND_RS)) / 100, open_ac=polys["park"].area / AC,
             apt_ac=polys["apartments"].area / AC, pieces=sorted((round(x, 2) for x in pcs), reverse=True),
             fragments=sum(1 for x in pcs if x < FRAGMENT_AC))
    m["villas"] = m["villa_ac"] * VILLAS_PER_AC
    return m, polys


def pinned_diff(path):
    """The towers, the apartment and senior clubhouses, senior, school and retail/office against the optimised zoning:
    the largest area (m2) any of them differs by."""
    def get(p):
        return {f["properties"]["component"]: shape(f["geometry"]) for f in json.load(open(p, encoding="utf-8"))["features"]
                if f["properties"]["use"] in PINNED or f["properties"]["component"] in ("C14", "C15")}
    a, b = get(f"{REPO}/data/processed/zones_draft_model.geojson"), get(path)
    return max(a[k].symmetric_difference(b.get(k, shapely.Polygon())).area for k in a)


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
    blocks = ", ".join(f"{x:.1f}" for x in m["pieces"][:6]) + (" ..." if len(m["pieces"]) > 6 else "")
    return (f"| {name} | {m['villa_ac']:.2f} | {m['villas']:.0f} | " + " | ".join(f"{b:.1f}" for b in m["bands"]) +
            f" | **{m['over_4_ac']:.1f}** | **{m['rs_cr']:.1f}** | {m['open_ac']:.2f} | {blocks} | {m['fragments']} |")


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    runs = []
    for name, extra in VARIANTS:
        out = os.path.join(OUTDIR, f"zones_d7_{name}.geojson")
        env = dict(os.environ, D7="1", VILLA_AC=os.environ.get("VILLA_AC", "30"), OUT=out, **extra)
        r = subprocess.run([sys.executable, os.path.join(HERE, "optimise.py")], env=env, capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(r.stderr[-2000:])
        runs.append((f"D7 {name} (zones_d7_{name})", out, name))
    refs = [("D1 base (zones_draft_model)", f"{REPO}/data/processed/zones_draft_model.geojson", None),
            ("D3 pockets (zones_draft_model_pockets)", f"{REPO}/data/processed/zones_draft_model_pockets.geojson", None)]
    res = {}
    for name, p, tag in refs + runs:
        m, polys = measure(p)
        m["pinned_diff_m2"] = pinned_diff(p)
        res[name] = m
        if tag is not None:
            draw(polys, f"{name}: villa land {m['villa_ac']:.1f} ac in {len(m['pieces'])} blocks, {m['over_4_ac']:.1f} ac over 1:4, "
                 f"villa earthwork ~Rs {m['rs_cr']:.1f} Cr; open space {m['open_ac']:.1f} ac", p.replace(".geojson", ".png"))
    hdr = ("| zoning | villa land, ac | villas at 12.5/ac | " + " | ".join(f"{n}, ac" for n in BAND_NAMES) +
           " | over 1:4, ac | villa earthwork + walls, Rs Cr (curve) | open space, ac | villa blocks, ac | blocks under 1.5 ac |\n|" + "---|" * 14)
    lines = [hdr] + [row(n, res[n]) for n, _, _ in refs + runs]
    print("\n".join(lines))
    json.dump(res, open(os.path.join(OUTDIR, "metrics.json"), "w"), indent=1)
    b_, d3 = res[runs[0][0]], res[refs[1][0]]
    md = ["# D7 base zoning, least earthwork (owner 12 Oct)", "",
          f"**zones_d7_base.geojson**: {b_['villa_ac']:.1f} ac of villa land in {len(b_['pieces'])} blocks "
          f"({', '.join(f'{x:.1f}' for x in b_['pieces'])} ac; {b_['fragments']} under {FRAGMENT_AC} ac), ~{b_['villas']:.0f} villas at "
          f"{VILLAS_PER_AC} an acre, {b_['over_4_ac']:.1f} ac over 1:4, villa earthwork + walls ~Rs {b_['rs_cr']:.1f} Cr on the D7 master's "
          f"curve (D3 Rs {d3['rs_cr']:.1f} Cr); open space {b_['open_ac']:.1f} ac; no pockets yet.", "",
          f"Towers (C02, C11, C19, C20), the apartment and senior clubhouses, senior, school and retail/office as in "
          f"data/processed/zones_draft_model.geojson (largest difference {b_['pinned_diff_m2']:.0f} m2). D7=1 in optimise.py: villa cost = the "
          "premium + Rs lakh/ac / 15 (the curve on each 20 m cell's 2 m slopes), villa blocks grown 5 ac at a time, compact; a villa strip "
          "one cell (20 m) across and a block under 1.5 ac are green; the villa clubhouses on the villas' steepest land. "
          "No flag: byte-identical to data/processed/zones_draft_model.geojson.", "",
          "With the towers on the low ground (the airport line), the land left to the villas is the hill: the zoning's saving is the "
          "steepest edges and the fragments left green, not the hill avoided. zones_d7_final (towers moved) is superseded.", ""] + lines + [
          "", "Maps: zones_d7_<name>.png (uses coloured, the villa land outlined over the six slope bands)."]
    open(os.path.join(OUTDIR, "summary.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
    return res, lines


if __name__ == "__main__":
    main()
