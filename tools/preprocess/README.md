# Preprocessing (Python, offline) — already run; outputs are in data/processed

The web app never reads DWG. Re-run this only if CAD or survey files change.

## 1. Build LibreDWG (DWG → JSON)
```bash
curl -L -o lr.tar.xz https://github.com/LibreDWG/libredwg/releases/download/0.13.3/libredwg-0.13.3.tar.xz
tar xf lr.tar.xz && cd libredwg-0.13.3
./configure --disable-bindings && make -j8 CFLAGS="-O0 -w"   # -O0 keeps build time sane
programs/dwgread -O JSON -o Zoning_plan.json ../data/raw/cad/Zoning_plan.dwg
programs/dwgread -O JSON -o Level_Datum-_TBM.json ../data/raw/cad/Level_Datum-_TBM.dwg
```
(`dwg2dxf` output from these files did not parse cleanly in ezdxf; use the JSON route.)

## 2. Flatten model space (expands INSERTs, hatches, texts)
```bash
pip install ezdxf shapely scipy pyproj matplotlib numpy
python render.py Zoning_plan.json zp_flat.json
python render.py Level_Datum-_TBM.json lv_flat.json
```

## 3. Register Zoning Plan to UTM, extract zones
```bash
python reg.py      # writes reg.json (similarity + scale fit of BD boundary onto zoning linework)
python zones.py    # writes zones.pkl (parcel from BD lines, zones from hatches + labels)
```
reg.py / zones.py expect lv_flat.json, zp_flat.json in the working directory.

## 4. Build app data
```bash
python build_processed.py <workdir> ../../data/processed
```
