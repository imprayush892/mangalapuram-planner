"""A master plan as a clean DXF (owner 12 Oct, after his D6-revised.dxf): the road edges as the outlines of the land
between the roads, with 3 m rounded corners (no road polygons over each other); the green and the water as solid
fills; the plots thin and grey, the houses white; the buildings outlined in their use's colour; one title line. Zone
outlines and labels sit on layers that start off. AutoCAD R2000, local metres. Curves go out as polyline arcs (bulges).

    python tools/export/clean_dxf.py <plan.json> <out.dxf>      (plan.json from app/scripts/plan-dxf.mjs)
"""
import json, math, sys, unicodedata
import ezdxf
from ezdxf import zoom
from ezdxf.enums import TextEntityAlignment
from ezdxf.math import bulge_to_arc
from shapely.geometry import Polygon, LineString, Point, box
from shapely.ops import unary_union, linemerge
from shapely.validation import make_valid

FILLET = 3.0                       # the corner radius of the blocks (his drawing: 3 m)
GREEN_FILL, WATER_FILL = 64, 5     # his fills: ACI 64 (olive) and 5 (blue)
MIN_AREA = 5.0                     # fills and blocks smaller than this (m2) are slivers
GAP = 0.6                          # a fill this close to a road edge (2*GAP) is carried to it
USE_COLOUR = {"villas": 2, "apartments": 1, "senior": 6, "school": 5, "clubhouse": 4, "retail": 6, "office": 6}
LAYERS = [("SITE-BOUNDARY", 7), ("ROAD-EDGE", 7), ("ROAD-EXISTING", 2), ("WATER", 5), ("GREEN-RC", 64), ("GREEN-LANDSCAPE", 64),
          ("GREEN-IN-VILLAS", 64), ("PLOT", 250), ("VILLA-HOUSE", 7), ("TEXT-TITLE", 7), ("TEXT-ZONE", 7)]
LAYERS += [(f"BUILDING-{u.upper()}", c) for u, c in USE_COLOUR.items()] + [(f"ZONE-{u.upper()}", c) for u, c in USE_COLOUR.items()]
OFF = {"TEXT-ZONE"} | {f"ZONE-{u.upper()}" for u in USE_COLOUR}


ASCII = {"·": "-", "–": "-", "—": "-", "−": "-", "′": "'", "’": "'", "‘": "'", "″": '"',
         "“": '"', "”": '"', "₹": "Rs", "×": "x", "²": "2", "°": " deg", "→": "->", "…": "..."}


def ascii_(t):
    """plain ASCII (the host serves the file only if it decodes as UTF-8; R2000 text is cp1252)"""
    t = "".join(ASCII.get(c, c) for c in str(t))
    return unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode("ascii")


def mpoly(mp):
    out = []
    for poly in mp:
        if poly and len(poly[0]) >= 3:
            holes = [r for r in poly[1:] if len(r) >= 3 and Polygon(r).area >= 1]    # the parcel carries zero-area holes
            out.append(Polygon(poly[0], holes))
    return valid(unary_union([valid(p) for p in out])) if out else Polygon()


def valid(g):
    g = g if g.is_valid else make_valid(g)
    return unary_union(polys(g)) if g.geom_type == "GeometryCollection" else g


def polys(g):
    return [g] if g.geom_type == "Polygon" else [q for p in getattr(g, "geoms", []) for q in polys(p)]


def lines(g):
    return [g] if g.geom_type == "LineString" else [q for p in getattr(g, "geoms", []) for q in lines(p)]


def clean(g, eps=0.3):
    """drop the slivers: parts thinner than 2*eps, specks and spikes; mitre in and out keeps the corners and arcs"""
    g = valid(g).buffer(-eps, join_style=2, mitre_limit=10).buffer(eps, join_style=2, mitre_limit=2)     # spikes < 60 deg cut
    return unary_union([p for p in polys(valid(g)) if p.area >= MIN_AREA])


def bulged(pts, closed):
    """runs of vertices on one circle (within 1 cm, turning one way, <= 30 deg a step, chords within 1 cm of the
    arc) become one arc: [(x, y, bulge)]"""
    pts = [tuple(map(float, p)) for p in pts]
    if closed:
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        n = len(pts)
        turns = [abs(turn(pts[i - 1], pts[i], pts[(i + 1) % n])) for i in range(n)]
        k = max(range(n), key=lambda i: turns[i])         # start at the sharpest corner, so no arc straddles it
        pts = pts[k:] + pts[:k] + [pts[k]]
    n, out, i = len(pts), [], 0
    while i < n - 1:
        j, best = i + 2, None
        while j < n:
            arc = fit(pts, i, j)
            if not arc:
                break
            best, j = (j, arc), j + 1
        if best:
            j, sweep = best
            out.append((*pts[i], math.tan(sweep / 4)))
            i = j
        else:
            out.append((*pts[i], 0.0))
            i += 1
    if not closed:
        out.append((*pts[-1], 0.0))
    return out


def turn(a, b, c):
    t = math.atan2(c[1] - b[1], c[0] - b[0]) - math.atan2(b[1] - a[1], b[0] - a[0])
    return (t + math.pi) % (2 * math.pi) - math.pi


def fit(pts, i, j):
    a, m, b = pts[i], pts[(i + j) // 2], pts[j]
    d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]))
    if abs(d) < 1e-9:
        return None
    sa, sm, sb = a[0] ** 2 + a[1] ** 2, m[0] ** 2 + m[1] ** 2, b[0] ** 2 + b[1] ** 2
    cx = (sa * (m[1] - b[1]) + sm * (b[1] - a[1]) + sb * (a[1] - m[1])) / d
    cy = (sa * (b[0] - m[0]) + sm * (a[0] - b[0]) + sb * (m[0] - a[0])) / d
    r = math.hypot(a[0] - cx, a[1] - cy)
    if not 0.5 <= r <= 500:
        return None
    sweep, sign = 0.0, 0
    for k in range(i, j):
        p, q = pts[k], pts[k + 1]
        if abs(math.hypot(q[0] - cx, q[1] - cy) - r) > 0.01:
            return None
        t = math.atan2(q[1] - cy, q[0] - cx) - math.atan2(p[1] - cy, p[0] - cx)
        t = (t + math.pi) % (2 * math.pi) - math.pi
        if abs(t) < math.radians(0.5) or abs(t) > math.radians(30) or r * (1 - math.cos(t / 2)) > 0.01:
            return None
        if sign and (t > 0) != (sign > 0):
            return None
        sign, sweep = (1 if t > 0 else -1), sweep + t
    return sweep if abs(sweep) < math.radians(359) else None


def flatten(xyb, closed):
    """the points along a bulged ring or line, arcs at 2 deg"""
    out = []
    for k in range(len(xyb) if closed else len(xyb) - 1):
        (x0, y0, b), (x1, y1, _) = xyb[k], xyb[(k + 1) % len(xyb)]
        out.append((x0, y0))
        if b:
            c, a0, a1, r = bulge_to_arc((x0, y0), (x1, y1), b)
            sweep = (a1 - a0) % (2 * math.pi)
            n = max(2, int(math.degrees(sweep) / 2))
            ts = [a0 + sweep * i / n for i in range(1, n)]
            out += [(c[0] + r * math.cos(t), c[1] + r * math.sin(t)) for t in (ts if b > 0 else ts[::-1])]
    if not closed:
        out.append(tuple(xyb[-1][:2]))
    return out


def outline(p):
    """a polygon's rings with arcs, unless the arcs make it cross itself: then its plain vertices"""
    rings = [bulged(list(r.coords), True) for r in [p.exterior, *p.interiors]]
    fine = Polygon(flatten(rings[0], True), [flatten(r, True) for r in rings[1:]])
    coarse = Polygon([r[:2] for r in rings[0]], [[v[:2] for v in r] for r in rings[1:]])
    if fine.is_valid and coarse.is_valid:
        return rings
    return [[(*xy, 0.0) for xy in list(r.coords)[:-1]] for r in [p.exterior, *p.interiors]]


def surfaces(roads, parcel):
    """each road's surface, its ends that run into another road (or out of the site) squared off and carried
    through to it, so no round end bulges past the road it joins; the dead ends keep their round ends"""
    geoms = [mpoly(r["geom"]) for r in roads]
    outside = box(*parcel.buffer(200).bounds).difference(parcel)
    out = []
    for i, (r, g) in enumerate(zip(roads, geoms)):
        cl, w = r.get("centreline"), r.get("width")
        if not cl or not w or len(cl) < 2:
            out.append(g)
            continue
        target = unary_union([h for k, h in enumerate(geoms) if k != i] + [outside]).buffer(0.01)
        for end in (0, -1):
            p, q = cl[end], cl[1 if end == 0 else -2]
            t = (p[0] - q[0], p[1] - q[1])
            L = math.hypot(*t)
            if L < 1e-6 or target.distance(Point(p)) > w / 2 + 0.5:
                continue
            t, n = (t[0] / L, t[1] / L), (-t[1] / L, t[0] / L)
            beyond = Polygon([(p[0] + n[0] * w, p[1] + n[1] * w), (p[0] + n[0] * w + t[0] * w, p[1] + n[1] * w + t[1] * w),
                              (p[0] - n[0] * w + t[0] * w, p[1] - n[1] * w + t[1] * w), (p[0] - n[0] * w, p[1] - n[1] * w)])
            for s in [k * 0.25 for k in range(0, 81)]:
                c = (p[0] + t[0] * s, p[1] + t[1] * s)
                face = LineString([(c[0] + n[0] * w / 2, c[1] + n[1] * w / 2), (c[0] - n[0] * w / 2, c[1] - n[1] * w / 2)])
                if target.contains(face):
                    stub = Polygon([(p[0] + n[0] * w / 2, p[1] + n[1] * w / 2), (c[0] + n[0] * w / 2, c[1] + n[1] * w / 2),
                                    (c[0] - n[0] * w / 2, c[1] - n[1] * w / 2), (p[0] - n[0] * w / 2, p[1] - n[1] * w / 2)])
                    g = valid(g.difference(beyond).union(stub if s > 0 else Polygon()))
                    break
        out.append(g)
    return valid(unary_union(out))


def main(src, dst):
    D = json.load(open(src, encoding="utf-8"))
    doc = ezdxf.new("R2000", setup=True)
    doc.header["$INSUNITS"] = 6    # metres
    doc.header["$MEASUREMENT"] = 1
    for name, colour in LAYERS:
        lay = doc.layers.add(name, color=colour)
        if name in OFF:
            lay.off()
    msp = doc.modelspace()

    def ring(coords, layer, closed=True, arcs=False):
        pts = [(float(x), float(y)) for x, y in coords]
        if closed and len(pts) > 2 and pts[0] == pts[-1]:
            pts = pts[:-1]
        if len(pts) < 2:
            return
        if arcs:
            msp.add_lwpolyline(bulged(pts + [pts[0]] if closed else pts, closed), format="xyb", close=closed, dxfattribs={"layer": layer})
        else:
            msp.add_lwpolyline(pts, close=closed, dxfattribs={"layer": layer})

    def fill(g, layer, colour):
        for p in polys(g):
            q = p.simplify(0.005)
            rings = outline(q if q.is_valid and not q.is_empty else p)
            h = msp.add_hatch(color=colour, dxfattribs={"layer": layer})
            for k, r in enumerate(rings):
                h.paths.add_polyline_path(r, is_closed=True, flags=1 if k == 0 else 0)
                msp.add_lwpolyline(r, format="xyb", close=True, dxfattribs={"layer": layer})

    parcel = mpoly(D["parcel"])
    for p in polys(parcel):
        ring(p.exterior.coords, "SITE-BOUNDARY")
        for hole in p.interiors:
            ring(hole.coords, "SITE-BOUNDARY")
    # the existing roads: once each, joined up, and not where the site has built over them (as he cleaned it)
    seen, segs = set(), []
    for line in D["existing"]:
        pts = tuple((round(float(x), 3), round(float(y), 3)) for x, y in line)
        key = min(pts, pts[::-1])
        if len(pts) >= 2 and key not in seen:
            seen.add(key)
            segs.append(LineString(pts))
    inner = parcel.buffer(-0.5)
    segs = [s for s in segs if s.length > 0 and not inner.contains(s)]
    if segs:
        for ln in lines(linemerge(segs)):
            ring(list(ln.coords), "ROAD-EXISTING", closed=False)

    # the roads: one surface, and its edges drawn once, as the outline of the land between them, convex corners
    # rounded; the land outside the site joins in, so no edge runs along the boundary and no fillet sits on it
    roads = surfaces(D["roads"], parcel)
    land = box(*parcel.buffer(200).bounds).difference(roads)
    land = valid(land.buffer(-FILLET, join_style=2, mitre_limit=10).buffer(FILLET, join_style=1, quad_segs=16))
    land = unary_union([p for p in polys(land) if p.area >= 30])
    blocks = valid(land.intersection(parcel))
    edge = land.boundary.intersection(parcel).difference(parcel.boundary.buffer(0.3))
    merged = linemerge(lines(edge)) if not edge.is_empty else edge
    for ln in lines(merged):
        if ln.length >= 0.5:
            ln = ln.simplify(0.005)
            ring(list(ln.coords), "ROAD-EDGE", closed=ln.is_ring, arcs=True)

    # the water, then the green by kind, filled within the blocks, never over each other
    taken, parks, other = Polygon(), [], []
    for z in D["zones"]:
        g = mpoly(z["geom"]).intersection(parcel)
        if g.is_empty:
            continue
        if z["use"] != "park":
            other.append((z, g))
        elif z["water"] or z["green"] == "lake":
            parks.append((0, "WATER", WATER_FILL, g))
        else:
            layer = "GREEN-IN-VILLAS" if (z["within"] or z["green"] == "zone") else "GREEN-LANDSCAPE" if z["green"] == "landscape" else "GREEN-RC"
            parks.append((1, layer, GREEN_FILL, g))
    # a fill that stops short of a road (a gap under 2*GAP) is closed up to its edge, round the plots and buildings
    built = valid(unary_union([Polygon(q["ring"]).buffer(0) for q in D["plots"] if len(q["ring"]) >= 3] +
                              [Polygon(b["ring"]).buffer(0) for b in D["buildings"] if len(b["ring"]) >= 3]))
    for _, layer, colour, g in sorted(parks, key=lambda t: t[0]):
        g = valid(g)
        near = roads.intersection(box(*g.buffer(3 * GAP).bounds))
        shut = valid(unary_union([g, near]).buffer(GAP, join_style=2).buffer(-GAP, join_style=2))
        g = unary_union([g, shut.difference(built)])
        g = clean(g.intersection(blocks).difference(taken))
        if not g.is_empty:
            fill(g, layer, colour)
            taken = valid(unary_union([taken, g]))
    for z, g in other:
        layer = f"ZONE-{z['use'].upper()}" if z["use"] in USE_COLOUR else "ZONE-CLUBHOUSE"
        for p in polys(g):
            ring(p.exterior.coords, layer)
        c = g.representative_point()
        msp.add_text(ascii_(z["name"]), height=4, dxfattribs={"layer": "TEXT-ZONE"}).set_placement((c.x, c.y), align=TextEntityAlignment.MIDDLE_CENTER)

    for q in D["plots"]:
        p = Polygon(q["ring"]).buffer(0) if len(q["ring"]) >= 3 else Polygon()
        cut = valid(p.intersection(blocks)) if not p.is_empty else p
        if cut.geom_type == "Polygon" and 0 < p.area - cut.area < 0.05 * p.area:      # a corner plot takes the fillet
            msp.add_lwpolyline(outline(cut.simplify(0.005))[0], format="xyb", close=True, dxfattribs={"layer": "PLOT"})
        else:
            ring(q["ring"], "PLOT")
        if q.get("house"):
            ring(q["house"], "VILLA-HOUSE")
    for b in D["buildings"]:
        layer = f"BUILDING-{b['typology'].upper()}" if b["typology"] in USE_COLOUR else "BUILDING-CLUBHOUSE"
        ring(b["ring"], layer)

    x0, y0, x1, y1 = parcel.bounds
    msp.add_text(ascii_(D["title"]), height=6, dxfattribs={"layer": "TEXT-TITLE"}).set_placement((x0, y0 - 20))
    zoom.extents(msp, factor=1.05)
    doc.saveas(dst)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
