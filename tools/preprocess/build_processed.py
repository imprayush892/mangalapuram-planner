"""Builds data/processed/* from the raw survey + CAD flattening outputs.
Inputs (produced earlier by render.py / reg.py / zones.py from LibreDWG JSON):
  lv_flat.json (Level_Datum DWG flattened), zp_flat.json (Zoning plan flattened),
  reg.json (zoning->UTM similarity transform), zones.pkl (registered zones + parcel)
Run: python build_processed.py <workdir_with_those_files> <out_dir>
"""
import json, sys, pickle, math, csv, os
import numpy as np
from shapely.geometry import mapping, Polygon, LineString, Point
from shapely.ops import unary_union
from pyproj import Transformer
import ezdxf
from matplotlib.tri import Triangulation, LinearTriInterpolator

W, OUT = sys.argv[1], sys.argv[2]
RAW = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'raw', 'survey')
os.makedirs(OUT, exist_ok=True)
E0, N0 = 706106.927, 953717.901
tf = Transformer.from_crs(32643, 4326, always_xy=True)
AC = 4046.8564224

def loc(g):  # UTM geometry -> local
    from shapely.affinity import translate
    return translate(g, -E0, -N0)

def fc(features, name):
    return {"type": "FeatureCollection", "name": name,
            "crs_note": "Coordinates are LOCAL metres: x = UTM43N(EPSG:32643) E - 706106.927, y = N - 953717.901. Levels are RL on assumed datum TBM=100.000 (not MSL).",
            "features": features}

def feat(g, **p): return {"type": "Feature", "properties": p, "geometry": mapping(loc(g))}

lv = json.load(open(f'{W}/lv_flat.json'))
parcel, zones = pickle.load(open(f'{W}/zones.pkl', 'rb'))
# zones.pkl parcel pieces are interiors of 0.6 m-buffered BD lines; grow back to the line centre
parcel = unary_union([p.buffer(0.6, join_style=2) for p in parcel.geoms])
R = json.load(open(f'{W}/reg.json'))

# origin / datum
json.dump({"crs": "EPSG:32643 (WGS84 / UTM 43N)", "local_origin_utm": [E0, N0],
           "local_origin_wgs84": list(tf.transform(E0, N0)),
           "site_reference_point_client": "8°37'38.7\"N 76°52'34.4\"E",
           "tbm": {"rl": 100.0, "utm": [706338.714, 954348.158], "local": [706338.714 - E0, 954348.158 - N0],
                   "note": "All survey RLs are relative to this TBM (assumed 100.000). MSL offset unknown."},
           "units": "metres"}, open(f'{OUT}/site_origin.json', 'w'), indent=2)

# parcel
labels = {0: "47 ac 36.810 cents", 1: "21 ac 89.200 cents + 4 ac 28.000 cents (share a boundary, merged)"}
# client treats all land as one contiguous consolidated parcel (client point 6)
pieces = sorted(parcel.geoms, key=lambda p: -p.area)
F = [feat(p, id=f"P{i+1}", deed_label=labels[i], area_m2=round(p.area, 1), area_ac=round(p.area / AC, 3),
          status="in_scope") for i, p in enumerate(pieces)]
json.dump(fc(F, "parcel_in_scope"), open(f'{OUT}/parcel.geojson', 'w'))

# roads / features
F = []
for o in lv:
    if o[0] != 'pl' or len(o[2]) < 2: continue
    L = o[1]
    if L in ('RD', 'DR', 'POND', 'TF', 'WELL'):
        g = LineString(o[2])
        F.append(feat(g, layer=L, kind={'RD': 'existing_road_edge', 'DR': 'drain', 'POND': 'pond_edge',
                                        'TF': 'transformer', 'WELL': 'well'}[L]))
F.append(feat(Point(706338.714, 954348.158), layer='TBM', kind='tbm', rl=100.0))
F.append(feat(Point(706800.19, 953919.66), layer='WELL', kind='well_label'))
F.append(feat(Point(706515.12, 954383.10), layer='TF', kind='transformer_label'))
json.dump(fc(F, "site_features"), open(f'{OUT}/site_features.geojson', 'w'))

# zones (client Zoning Plan, registered)
approx = {'COMMERCIAL & CONVENTION CENTRE', 'BATCHING PLANT', 'PROJECT - 1 (VILLAS)'}
F = []
for t, z in zones.items():
    g = z['geom']
    if g.is_empty: continue
    F.append(feat(g, name=t, label_area_ac=float(z['label_area'].split('-')[1].split('ACRE')[0]),
                  drawn_area_ac=round(g.area / AC, 2), in_scope_ac=round(g.intersection(parcel).area / AC, 2),
                  geometry_confidence='approximate' if t in approx else 'good'))
json.dump(fc(F, "client_zoning_plan_registered"), open(f'{OUT}/zones_client_registered.geojson', 'w'))
json.dump({"method": "similarity fit of Level_Datum BD boundary onto Zoning_plan linework (ICP-style, Nelder-Mead)",
           "zoning_to_utm": "utm = R(-th) @ ((p - [dx,dy]) / sc) + cB",
           **R, "scale_note": "Zoning Plan is drawn ~3.4 pct oversize (sc=%.4f), rotated %.2f deg" % (R["sc"], math.degrees(R["th"])),
           "fit_error_m": {"p25": 0.37, "median": 0.65, "p75": 1.01, "p90": 2.21},
           "missing": "PHASE 5 hatch not recovered; commercial/batching/project-1 split approximate (±1 ac)"},
          open(f'{OUT}/zoning_registration.json', 'w'), indent=2)

# terrain: spot levels + DEM
V = []; Fc = []
for l in open(f'{RAW}/mangalapuram_terrain_15_sept.obj'):
    if l.startswith('v '): V.append(list(map(float, l.split()[1:4])))
    elif l.startswith('f '): Fc.append([int(t.split('/')[0]) - 1 for t in l.split()[1:]])
V = np.array(V); Fc = np.array(Fc)
with open(f'{OUT}/spot_levels.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['x_local', 'y_local', 'utm_e', 'utm_n', 'lon', 'lat', 'rl'])
    for x, y, z in V:
        lon, lat = tf.transform(x + E0, y + N0)
        w.writerow([f'{x:.3f}', f'{y:.3f}', f'{x+E0:.3f}', f'{y+N0:.3f}', f'{lon:.7f}', f'{lat:.7f}', f'{z:.3f}'])
tri = Triangulation(V[:, 0], V[:, 1], Fc)
interp = LinearTriInterpolator(tri, V[:, 2])
cell = 2.0
x0, y0 = 0.0, -10.0; nx, ny = 460, 345  # covers x 0..920, y -10..680
xs = x0 + cell * (np.arange(nx) + 0.5); ys = y0 + cell * (np.arange(ny) + 0.5)
X, Y = np.meshgrid(xs, ys)
Z = interp(X, Y).filled(np.nan).astype('<f4')
Z.tofile(f'{OUT}/dem_2m.f32')
json.dump({"format": "raw little-endian float32, row-major, row 0 = southernmost row (y0)", "nodata": "NaN (unsurveyed)",
           "cell_m": cell, "x0": x0, "y0": y0, "nx": nx, "ny": ny,
           "cell_centre": "x = x0 + cell*(i+0.5), y = y0 + cell*(j+0.5)", "coords": "local metres (see site_origin.json)",
           "source": "linear interpolation of mangalapuram_terrain_15_sept.obj (parcel-clipped TIN)",
           "valid_cells": int(np.isfinite(Z).sum()), "rl_min": float(np.nanmin(Z)), "rl_max": float(np.nanmax(Z))},
          open(f'{OUT}/dem_2m.json', 'w'), indent=2)

# contours
d = ezdxf.readfile(f'{RAW}/mangalapuram_contours_1m.dxf')
F = []
for e in d.modelspace():
    try:
        pts = [(v.dxf.location.x - E0, v.dxf.location.y - N0) for v in e.vertices]
    except Exception:
        continue
    if len(pts) > 1:
        rl = int(e.dxf.layer.split('_')[1])
        F.append({"type": "Feature", "properties": {"rl": rl, "major": rl % 5 == 0},
                  "geometry": {"type": "LineString", "coordinates": [[round(a, 2), round(b, 2)] for a, b in pts]}})
json.dump(fc(F, "contours_1m"), open(f'{OUT}/contours_1m.geojson', 'w'))
print('done', len(V), 'pts', int(np.isfinite(Z).sum()), 'dem cells', len(F), 'contours')
