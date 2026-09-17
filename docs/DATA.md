# Data dictionary

## data/processed (use these in the app)
| File | Content | Notes |
| --- | --- | --- |
| site_origin.json | CRS, local origin, TBM | Local metres = UTM43N − origin |
| parcel.geojson | In-scope land: P1 47.37 ac; P2 26.17 ac (21.892 + 4.28 ac deed parcels, merged along shared line) | Total 73.544 ac = deed 73.54 |
| site_features.geojson | Existing road edges (RD), drain (DR), pond (POND), transformer (TF), well, TBM point | RD = edges of roads to retain & widen to 10 m |
| zones_client_registered.geojson | Client Zoning Plan zones registered to survey | label_area_ac, drawn_area_ac, in_scope_ac, geometry_confidence. PHASE 5 geometry not recovered. Commercial / batching / Project 1 boundaries approximate |
| zoning_registration.json | Transform Zoning CAD → UTM | Zoning plan is ~3.4% oversize, rotated ~1°; median fit 0.65 m |
| dem_2m.f32 + dem_2m.json | 460 × 345 float32 grid, 2 m cells, NaN = unsurveyed | From the parcel-clipped TIN |
| spot_levels.csv | 7,488 unique survey points: local, UTM, lon/lat, RL | Same points as the OBJ |
| contours_1m.geojson | 919 contour lines, RL 69–143, `major` every 5 m | |

## data/raw
- survey/: terrain TINs (OBJ, local coords, see header), 1 m contours DXF (UTM), survey QA report.
- cad/: Zoning_plan.dwg (AutoCAD 2018; model space = zone diagram near (24700..25610, −16420..−15650) in local CAD units; labels on layer `north`; zone fills are HATCH on `PLOT DIV`/`Layer1`; `PLOTS` layer = land-ownership parcels, NOT villa plots), Level_Datum-_TBM.dwg (AutoCAD 2010, UTM; layers BD boundary, RD roads, POND, WELL, TF, DR, Height/Point_ID/Coordinates texts = 17,794 labels, 8,675 unique positions).
- pdf/: Existing Roads (parcel labels 47 ac 36.810 c, 21 ac 89.200 c, 4 ac 28.000 c), Level Datum TBM plot, levels model plot.
- client/: Phasing_and_Cashflows_V4_06092026.xlsx (formulas hold units × sft), Planning Considerations sheet photos.
- regulation/: KMBR PDFs (text extracts in docs/kmbr_source).

## data/reference (images for humans)
- zoning_overlay.png — client zones over the parcel.
- zoning_plan_decoded_local_cad.png — the zoning DWG as decoded.
- mangalapuram_plot_suitability.png — fall across 11.4 × 14.2 m windows.
- mangalapuram_water_channels.png — D8 channels (local only).

## Known data issues
- Level datum is assumed (TBM 100.000), not MSL.
- ~12.9 ac of the parcel is unsurveyed (NaN in DEM); Google Earth levels may be added later, flag low-confidence.
- Survey QA: 4 rows rejected, duplicates collapsed; ids 4118/4119 disagree by 4.0 m (check).
- No boundary or levels for the deferred 26.4 ac.
