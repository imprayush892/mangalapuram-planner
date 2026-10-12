"""The owner's draft financial model, re-run for each master plan (owner 9 Oct 2026; every input the plan's own, 12 Oct).

For every option the presentation offers (app/prebuilt/plans/D*.json, `npm run plans`), the plan's land and villas go
into a copy of the model in memory, Excel recalculates, and the One-Page Summary is read back; the workbook itself is
never saved. From the plan's land account (plan.land, app/src/engine/pipeline/plan.ts), on the Inputs sheet:
  C16          gross land: the parcel's 73.54 ac (the model's note: "enter the exact surveyed area")
  G97-G116     each component's land: its zone's (the apartments' G98, G111-G113 over their formulas)
  C33, C35     roads and infrastructure: the roads outside the zones and across the parks (C35, the + 2 ac, 0)
  C37          additional open space: so the model's open space (10% + C37) is the plan's (RC, lakes, the green
               in the villas, the small parks and strips); clubhouse land stays with the clubhouses (G100 etc.)
  C40          villa land (the model's plug) then equals the plan's villa zones
  C41          villa plot efficiency: the plan's plots / villa land
  D123-D126    villa land by phase (shares): the villa zones
  H99, H106-H108  villas by phase: the plan's plots;  D130-D133  the villa mix: the plan's plot types
  Row 103      the hospital's row (out of the plan, owner 12 Oct) carries the office's Phase 1, 40% (owner 12 Oct:
               retail and office 40% in Phase 1, 60% in Phase 3); row 115 is the office's Phase 3, 60%
  Row 114      retail: the model has one retail row, tied to its Retail Lease sheet; it stays one Phase 3 line with
               all the retail land (LIMITATION: the 40% built in Phase 1 is not timed earlier in the model)
Writes config/financials_draft_model.yaml, which the presentation reads (ui/PresentFinance.tsx, ui/PresentFigures.tsx).

Run: python tools/finance/run_model.py ["C:/path/Draft model.xlsx"]   (Windows, Excel installed)
"""
import json
import os
import re
import subprocess
import sys
import datetime

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MODEL = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/Draft model.xlsx")
AC = 4046.8564224
# The option list, as app/src/engine/present/prebuilt.ts has it.
OPTIONS = [
    ("D1", "Optimised zoning · roads to the ground"),
    ("D2", "Optimised zoning · north–south roads (Vastu)"),
    ("D3", "Green pockets · roads to the ground"),
    ("D4", "Green pockets · north–south roads (Vastu)"),
    ("D5", "Green link · roads to the ground"),
    ("D6", "Green link · north–south roads (Vastu)"),
]
# Inputs row of each component's land (column G); villas (rows 99, 106-108) are the model's plug, C40.
ROW = {"C01": 97, "C02": 98, "C08": 100, "C04": 101, "C05": 102, "C16-1": 103, "C15": 104, "C07": 105, "C10": 109,
       "C13": 110, "C11": 111, "C19": 112, "C20": 113, "C12": 114, "C14": 116, "C16": 115}
RETAIL_P1 = "C12-1"          # into row 114 with the rest of the retail (see above)
VILLA_PHASE_ROW = {1: 99, 2: 106, 3: 107, 4: 108}
# Row 103 as the office's Phase 1 (40% of row 115's 2,25,000 sft saleable), priced and paid like row 115; built from
# quarter 3 with the Phase 1 launch, sold over 6 quarters (40% of the office's 14). ASSUMPTION: the timing (owner to confirm).
OFFICE_P1 = {"C103": "Commercial office (strata) - Phase 1, 40%", "D103": 1, "E103": "Commercial", "F103": "Y", "H103": 1,
             "I103": 90000, "K103": "Office", "L103": 1.15, "P103": 3, "Q103": 10, "U103": 7500, "V103": 3, "X103": 6,
             "Z103": "COMM", "AB103": 0.04}
# Row 115 as the office's Phase 3, 60%: built from quarter 10 with the Phase 3 villas, sold over 8 quarters (60% of 14).
OFFICE_P3 = {"C115": "Commercial office (strata) - Phase 3, 60%", "D115": 3, "I115": 135000, "P115": 10, "V115": 10, "X115": 8}
TYPES = ["1,800 sq ft plot", "2,250 sq ft plot", "2,500 sq ft plot", "2,800 sq ft plot"]
APT_ROWS = {"C02": "E154", "C11": "E155", "C19": "E156", "C20": "E157"}
PHRASE = {"C08": "villa clubhouse 1", "C10": "villa clubhouse 2 (mini-golf)", "C04": "32 senior-living units", "C07": "senior enclave (160 units)",
          "C15": "senior clubhouse", "C05": "school stage A", "C13": "school stage B", "C12-1": "retail / F&B high street (40%)",
          "C12": "retail / F&B high street (60%)", "C16-1": "offices (40%)", "C16": "offices (60%)", "C14": "apartment clubhouse"}

# the model's own infrastructure rate (Inputs C45, Rs Cr a gross acre): the earthwork goes on top of it
import openpyxl  # noqa: E402
INFRA_BASE = float(openpyxl.load_workbook(MODEL, read_only=True)["Inputs"]["C45"].value or 0.75)

cases = [{"id": "model", "inputs": {}}]
meta = {}
for oid, label in OPTIONS:
    plan = json.load(open(f"{REPO}/app/prebuilt/plans/{oid}.json", encoding="utf-8"))["plan"]
    L = plan["land"]
    parcel = L["parcelM2"] / AC
    comp = {}
    vland = {k: 0.0 for k in (1, 2, 3, 4)}
    for z in L["zones"]:
        c, a = z.get("component"), z["areaM2"] / AC
        if z["use"] == "villas":
            vland[z.get("phase") or 1] += a
        elif c:
            comp[c] = comp.get(c, 0.0) + a
    comp["C12"] = comp.get("C12", 0.0) + comp.pop(RETAIL_P1, 0.0)
    villa_ac = sum(vland.values())
    open_ac = L["openSpaceM2"] / AC
    roads_ac = L["roadsM2"] / AC
    others = sum(comp.get(c, 0.0) for c in ROW)
    gap = parcel - (villa_ac + open_ac + roads_ac + others)
    assert abs(gap) < 0.02, f"{oid}: the land account does not add up ({gap:.3f} ac)"
    phase_of = {z["name"]: z.get("phase") or 1 for z in plan["zones"]}
    villas = {k: 0 for k in (1, 2, 3, 4)}
    for q in plan["plots"]:
        villas[phase_of.get(q["zone"], 1)] += 1
    nv = len(plan["plots"])
    mix = [sum(1 for q in plan["plots"] if q["kind"] == t) / nv for t in TYPES]
    inputs = {"C16": parcel, "C33": roads_ac / parcel, "C35": 0, "C37": open_ac - 0.10 * parcel, "C41": plan["option"]["plottedShare"],
              "D123": vland[1] / villa_ac, "D124": vland[2] / villa_ac, "D125": vland[3] / villa_ac,
              "D126": 1 - (vland[1] + vland[2] + vland[3]) / villa_ac,
              "H99": villas[1], "H106": villas[2], "H107": villas[3], "H108": villas[4]}
    for c, r in ROW.items():
        inputs[f"G{r}"] = comp.get(c, 0.0)
    # (as app/src/engine/finance/optionRun.ts) the apartments' land by phase, the plots as cut, the phases in words
    for c, a in APT_ROWS.items():
        inputs[a] = comp.get(c, 0.0)
    inputs["C151"] = sum(comp.get(c, 0.0) for c in APT_ROWS)
    # KMBR Table 6 (A1) fee on the apartments' floor area over FSI 3 (Rs 5,000/m2) and over 4 (Rs 7,500/m2), on each
    # apartment row's construction rate (as app/src/engine/finance/optionRun.ts)
    for r in (98, 111, 112, 113):
        inputs[f"N{r}"] = (f"=INDEX('Construction Cost'!$C$19:$K$19,MATCH(K{r},'Construction Cost'!$C$4:$K$4,0))"
                           f"+IFERROR((MAX(0,M{r}-3*G{r}*43560)*5000+MAX(0,M{r}-4*G{r}*43560)*2500)/10.7639/M{r},0)")
    for ph in (1, 2, 3, 4):
        in_ph = [q for q in plan["plots"] if phase_of.get(q["zone"], 1) == ph]
        for i, t in enumerate(TYPES):
            row = 130 + 4 * (ph - 1) + i
            ps = [q for q in in_ph if q["kind"] == t]
            inputs[f"D{row}"] = len(ps) / len(in_ph) if in_ph else mix[i]
            if ps:
                inputs[f"F{row}"] = round(sum(q["areaM2"] for q in ps) / len(ps) * 10.7639)
    by_phase = {1: [], 2: [], 3: [], 4: []}
    for z in L["zones"]:
        ph = z.get("phase") or 1
        if z["use"] == "apartments":
            by_phase[ph].append(f"apartments (phase {ph})")
        elif z["use"] == "villas":
            by_phase[ph].append(f"villas (phase {ph})")
        elif z.get("component") in PHRASE:
            by_phase[ph].append(PHRASE[z["component"]])
    by_phase[1].append("sales office")
    # owner 12 Oct: the earthwork at the owner's rates (plan.earthworkCost), into the infrastructure as G45
    ew = plan.get("earthworkCost")
    if ew:
        inputs["F45"] = "Earthwork & retaining walls, this plan (Rs Cr)"
        inputs["G45"] = ew["rs"]["total"] / 1e7
        inputs["C45"] = f"={INFRA_BASE}+G45/C16"
    for ph in (1, 2, 3, 4):
        items = list(dict.fromkeys(by_phase[ph]))
        inputs[f"C{89 + ph}"] = ("Launch: " if ph == 1 else "") + ", ".join(items)
    inputs.update(OFFICE_P1)
    inputs.update(OFFICE_P3)
    cases.append({"id": oid, "inputs": inputs})
    g = L["green"]
    meta[oid] = {"label": label, "villas": nv, "villas_by_phase": [villas[k] for k in (1, 2, 3, 4)],
                 "villa_land_ac": round(villa_ac, 3), "villas_per_acre": round(nv / villa_ac, 2),
                 "open_space_ac": round(open_ac, 3), "roads_ac": round(roads_ac, 3), "parcel_ac": round(parcel, 3),
                 "plot_efficiency": round(plan["option"]["plottedShare"], 4),
                 "earthwork": plan.get("earthworkCost"),
                 "green_ac": {k: round(v / AC, 3) for k, v in g.items()}}

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


def txt(c, cell):
    return (R[c][cell]["t"] or "").strip()


def summary(c):
    """The One-Page Summary's sections A, B and E, as the presentation's cards read them."""
    land = []
    for row in range(9, 20):
        acres = num(c, f"D{row}") or 0.0
        land.append({"use": txt(c, f"C{row}"), "acres": round(acres, 3), "share": round(num(c, f"E{row}") or 0.0, 4),
                     "phases": [int(p) for p in re.findall(r"P(\d)", txt(c, f"F{row}"))], "cell": f"D{row}"})
    funding = []
    for row in range(8, 18):
        cell = f"K{row}"
        lab = txt(c, f"H{row}")
        v = num(c, cell)
        if row in (8, 9, 10, 12) and v is not None:
            funding.append({"label": lab, "value": round(v, 2), "unit": "₹ Cr", "cell": cell})
        elif row == 16 and v is not None:
            funding.append({"label": lab, "value": round(v * 100, 1), "unit": "%", "cell": cell})
        else:
            funding.append({"label": lab, "text": txt(c, cell), "cell": cell})
    tickets = []
    for row in range(58, 67):
        if not txt(c, f"C{row}"):
            continue
        f = num(c, f"F{row}")
        ph = txt(c, f"L{row}").replace("-", "–")
        tickets.append({"comp": txt(c, f"B{row}"), "typology": txt(c, f"C{row}"), "units": int(num(c, f"D{row}") or 0),
                        "size_sft": round(num(c, f"E{row}") or 0), "plot_or_carpet_sft": round(f) if f else None,
                        "base_rate": round(num(c, f"G{row}") or 0), "base_ticket_lakh": round(num(c, f"H{row}") or 0, 1),
                        "realised_rate": round(num(c, f"I{row}") or 0), "ticket_lakh": round(num(c, f"J{row}") or 0, 1),
                        "revenue_cr": round(num(c, f"K{row}") or 0, 1), "phases": ph if ph.startswith("P") else ph,
                        "share_of_res_revenue": round(num(c, f"M{row}") or 0, 4), "row": row})
    avg = {"units": int(num(c, "D67") or 0), "size_sft": round(num(c, "E67") or 0), "ticket_lakh": round(num(c, "J67") or 0, 1),
           "revenue_cr": round(num(c, "K67") or 0, 1), "row": 67}
    return {"source": "Draft model.xlsx · One-Page Summary", "land": land, "land_total_ac": round(num(c, "D20") or 0, 2),
            "funding": funding, "tickets": tickets, "tickets_average": avg, "tickets_note": txt(c, "C68")}


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
    "inputs_changed": "Inputs C16 (gross land), G97-G116 (each component's land), C33, C35 (roads), C37 (open space), C41 (villa plot "
                      "efficiency), D123-D126 (villa land by phase), H99, H106-H108 (villas by phase), D130-D133 (villa mix); row 103 "
                      "(the hospital's, out of the plan) as the office's Phase 1 (40%), row 115 as its Phase 3 (60%)",
    "limitations": ["Retail: the model has one retail row (tied to its Retail Lease sheet), so all the retail runs as Phase 3; "
                    "the 40% the plan builds in Phase 1 is not timed earlier in the model.",
                    "Office: the Phase 1 and Phase 3 timing (start quarters 3 and 10, sold over 6 and 8 quarters) is an assumption."],
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
    e["summary"] = summary(c)
    doc["cases"][c] = e
    print(c, {k: e["text"][k] for k in ("units", "revenue_cr", "pat_cr", "project_irr", "promoter_irr")}, "land", e["summary"]["land_total_ac"])
dst = f"{REPO}/config/financials_draft_model.yaml"
with open(dst, "w", encoding="utf-8") as f:
    f.write("# The owner's draft financial model run on each master plan (tools/finance/run_model.py). Generated: do not edit.\n")
    yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False, width=140)
os.remove(tmp)
os.remove(out)
print("wrote", os.path.relpath(dst, REPO))
