"""The owner's draft financial model, re-run for each master plan (owner 9 Oct 2026).

For every option the presentation offers (app/prebuilt/plans/D*.json, `npm run plans`), the plan's land and villas go
into a copy of the model in memory, Excel recalculates, and the One-Page Summary is read back; the workbook itself is
never saved. The inputs are the ones the D1 update of 8 Oct changed (docs/DECISIONS.md):
  Inputs C37  additional open space: so the model's open space (10% of 73 ac + C37) is the plan's: the model's 8.3 ac,
              plus the gardens a zoning adds and less the park land it gives the villas (D5/D6's green chain)
  Inputs C33  roads and infrastructure, share of 73 ac: what the plan leaves of the 73 ac after the open space, the
              other components' 29.0 ac and the villa land   (C35, the + 2 ac, set to 0)
  Inputs C41  villa plot efficiency: the plan's plots / villa land
  Inputs D123-D126  villa land by phase (shares): the villa zones of the plan's zoning
  Inputs H99, H106-H108  villas by phase: the plan's plots
  Inputs G103, H103  the hospital: none on these 73 ac (owner 8 Oct)
Writes config/financials_draft_model.yaml, which the presentation reads (ui/PresentFinance.tsx).

Run: python tools/finance/run_model.py ["C:/path/Draft model.xlsx"]   (Windows, Excel installed)
"""
import json
import os
import subprocess
import sys
import datetime

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MODEL = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/Draft model.xlsx")
AC = 4046.8564224
TOTAL_AC, OPEN_AC = 73.0, 8.3
ZONING = {"model": "zones_draft_model.geojson", "green_pockets": "zones_draft_model_pockets.geojson", "green_chain": "zones_draft_model_chain.geojson"}
ZONING_NS = {"model": "zones_draft_model.geojson", "green_pockets": "zones_draft_model_pockets_ns.geojson", "green_chain": "zones_draft_model_chain_ns.geojson"}
# The option list, as app/src/engine/present/prebuilt.ts has it.
OPTIONS = [
    ("D1", "terrain", "model", "Draft model · roads to the ground"),
    ("D2", "north_south", "model", "Draft model · north–south roads (Vastu)"),
    ("D3", "terrain", "green_pockets", "Green pockets · roads to the ground"),
    ("D4", "north_south", "green_pockets", "Green pockets · north–south roads (Vastu)"),
    ("D5", "terrain", "green_chain", "Green chain · roads to the ground"),
    ("D6", "north_south", "green_chain", "Green chain · north–south roads (Vastu)"),
]
prog = yaml.safe_load(open(f"{REPO}/config/programme_draft_model.yaml", encoding="utf-8"))


def park_ac(zfile):
    return sum(f["properties"]["drawn_area_ac"] for f in json.load(open(f"{REPO}/data/processed/{zfile}", encoding="utf-8"))["features"]
               if f["properties"]["use"] == "park")


MODEL_PARK = park_ac(ZONING["model"])
other_ac = sum(l.get("land_ac", 0) for l in prog["lines"] if l["use"] != "villas" and not l.get("deferred"))

cases = [{"id": "model", "inputs": {}}]
meta = {}
for oid, roads, zoning, label in OPTIONS:
    plan = json.load(open(f"{REPO}/app/prebuilt/plans/{oid}.json", encoding="utf-8"))["plan"]
    zfile = (ZONING_NS if roads == "north_south" else ZONING)[zoning]
    zones = json.load(open(f"{REPO}/data/processed/{zfile}", encoding="utf-8"))["features"]
    vland = {k: 0.0 for k in (1, 2, 3, 4)}
    for f in zones:
        if f["properties"]["use"] == "villas":
            vland[f["properties"]["phase"]] += f["properties"]["label_area_ac"]
    land = sum(vland.values())
    phase_of = {z["name"]: z.get("phase") or 1 for z in plan["zones"]}
    villas = {k: 0 for k in (1, 2, 3, 4)}
    for q in plan["plots"]:
        villas[phase_of.get(q["zone"], 1)] += 1
    open_ac = OPEN_AC + park_ac(zfile) - MODEL_PARK
    roads_ac = TOTAL_AC - open_ac - other_ac - land
    inputs = {
        "C33": roads_ac / TOTAL_AC, "C35": 0, "C37": open_ac - TOTAL_AC * 0.10, "C41": plan["option"]["plottedShare"],
        "D123": vland[1] / land, "D124": vland[2] / land, "D125": vland[3] / land, "D126": 1 - (vland[1] + vland[2] + vland[3]) / land,
        "H99": villas[1], "H106": villas[2], "H107": villas[3], "H108": villas[4], "G103": 0, "H103": 0,
    }
    cases.append({"id": oid, "inputs": inputs})
    meta[oid] = {"label": label, "villas": len(plan["plots"]), "villas_by_phase": [villas[k] for k in (1, 2, 3, 4)],
                 "villa_land_ac": round(land, 3), "open_space_ac": round(open_ac, 3), "roads_ac": round(roads_ac, 3), "plot_efficiency": round(plan["option"]["plottedShare"], 4)}

tmp = os.path.join(HERE, "_cases.json")
out = os.path.join(HERE, "_results.json")
json.dump({"model": os.path.abspath(MODEL), "cases": cases}, open(tmp, "w", encoding="utf-8"))
r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(HERE, "run_model.ps1"), "-in", tmp, "-out", out],
                   capture_output=True, text=True)
print(r.stdout.strip(), r.stderr.strip()[-2000:])
if not r.stdout.strip().startswith("ok"):
    sys.exit(1)
R = json.load(open(out, encoding="utf-8-sig"))


def num(c, cell):
    v = R[c][cell]["v"]
    try:
        return round(float(v), 6)
    except (TypeError, ValueError):
        return None


KEYS = [  # (key, label, cell, unit, better)
    ("units", "Residential units", "D5", "count", "up"),
    ("saleable_lakh_sft", "Saleable area", "E5", "lakh sft", "up"),
    ("revenue_cr", "Total revenue", "F5", "₹ Cr", "up"),
    ("cost_cr", "Total cost", "G5", "₹ Cr", "down"),
    ("pbt_cr", "Profit before tax", "H5", "₹ Cr", "up"),
    ("pat_cr", "Profit after tax", "I5", "₹ Cr", "up"),
    ("pat_margin", "PAT margin", "J5", "%", "up"),
    ("project_irr", "Project IRR (pre-tax)", "K5", "%", "up"),
    ("promoter_irr", "Promoter IRR", "L5", "%", "up"),
    ("peak_funding_cr", "Peak funding need", "M5", "₹ Cr", "down"),
    ("promoter_money_cr", "Promoter money needed", "N5", "₹ Cr", "down"),
    ("peak_loan_cr", "Peak construction loan", "K10", "₹ Cr", "down"),
    ("interest_cr", "Interest & fees", "K12", "₹ Cr", "down"),
    ("villa_units", "Villas", "E25", "count", "up"),
    ("villa_revenue_cr", "Villa revenue", "J25", "₹ Cr", "up"),
    ("villa_margin", "Villa margin", "M25", "%", "up"),
]
doc = {
    "source": "Draft model.xlsx (owner, 7 Oct 2026), re-run for each plan by tools/finance/run_model.py; the workbook is not changed",
    "run": datetime.date.today().isoformat(),
    "inputs_changed": "Inputs C33, C35 (roads), C37 (open space), C41 (villa plot efficiency), D123-D126 (villa land by phase), H99, H106-H108 (villas by phase), G103, H103 (hospital: none on these 73 ac)",
    "metrics": [{"key": k, "label": l, "cell": c, "unit": u, "better": b} for k, l, c, u, b in KEYS],
    "cases": {},
}
for c in ["model"] + [o[0] for o in OPTIONS]:
    e = {"label": "Draft model as given" if c == "model" else meta[c]["label"]}
    if c != "model":
        e.update({k: v for k, v in meta[c].items() if k != "label"})
        e["inputs"] = {k: (round(v, 6) if isinstance(v, float) else v) for k, v in next(x for x in cases if x["id"] == c)["inputs"].items()}
    e["values"] = {k: num(c, cell) for k, _, cell, _, _ in KEYS}
    e["text"] = {k: R[c][cell]["t"] for k, _, cell, _, _ in KEYS}
    doc["cases"][c] = e
    print(c, {k: e["text"][k] for k in ("units", "revenue_cr", "pat_cr", "project_irr", "promoter_irr")})
dst = f"{REPO}/config/financials_draft_model.yaml"
with open(dst, "w", encoding="utf-8") as f:
    f.write("# The owner's draft financial model run on each master plan (tools/finance/run_model.py). Generated: do not edit.\n")
    yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False, width=140)
os.remove(tmp)
os.remove(out)
print("wrote", os.path.relpath(dst, REPO))
