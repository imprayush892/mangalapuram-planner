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
  Row 114      retail, 40% Phase 1 / 60% Phase 3 (owner 12 Oct): the model's one retail row, which its Costs block
               (rows 96-99) and the Retail Lease sheet read; no row is spare, so the 40% is timed in Costs G97:AT97
               (progress), G99:AT99 (approvals) and Retail Lease G10:AT10 (occupancy): built from quarter 3 over row
               114's quarters, let from its possession, the 60% on row 114's own timing; One-Page Summary F12 shows
               it in P1 and P3. All the retail land stays on row 114 (Phase 3), so the Summary sheet's by-phase
               lines carry the retail in Phase 3.
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
    ("D7", "Least earthwork · roads to the ground"),
]
# Owner 12 Oct (D7): ONLY=D3,D7 runs those options alone; PLAN_DIR reads <id>.json plans (the scratch tests' plain plan
# JSON) instead of app/prebuilt/plans; OUT_YAML writes there instead of config/financials_draft_model.yaml.
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]
OPTIONS = [o for o in OPTIONS if (o[0] in ONLY if ONLY else o[0] != "D7")]
PLAN_DIR = os.environ.get("PLAN_DIR")
# Inputs row of each component's land (column G); villas (rows 99, 106-108) are the model's plug, C40.
ROW = {"C01": 97, "C02": 98, "C08": 100, "C04": 101, "C05": 102, "C16-1": 103, "C15": 104, "C07": 105, "C10": 109,
       "C13": 110, "C11": 111, "C19": 112, "C20": 113, "C12": 114, "C14": 116, "C16": 115}
RETAIL_P1 = "C12-1"          # into row 114 with the rest of the retail (see above)
RETAIL_P1_START = 3          # retail Phase 1 built from quarter 3, as the office's. ASSUMPTION (owner to confirm).
VILLA_PHASE_ROW = {1: 99, 2: 106, 3: 107, 4: 108}
# Row 103 as the office's Phase 1 (40% of row 115's 2,25,000 sft saleable), priced and paid like row 115; built from
# quarter 3 with the Phase 1 launch, sold over 6 quarters (40% of the office's 14). ASSUMPTION: the timing (owner to confirm).
OFFICE_P1 = {"C103": "Commercial office (strata) - Phase 1, 40%", "D103": 1, "E103": "Commercial", "F103": "Y", "H103": 1,
             "I103": 90000, "K103": "Office", "L103": 1.15, "P103": 3, "Q103": 10, "U103": 7500, "V103": 3, "X103": 6,
             "Z103": "COMM", "AB103": 0.04}
# Row 115 as the office's Phase 3, 60%: built from quarter 10 with the Phase 3 villas, sold over 8 quarters (60% of 14).
OFFICE_P3 = {"C115": "Commercial office (strata) - Phase 3, 60%", "D115": 3, "I115": 135000, "P115": 10, "V115": 10, "X115": 8}


def retail_split():
    """Retail 40% Phase 1, 60% Phase 3 on row 114's formulas (as optionRun.ts retailSplit): cost, approvals, rent and
    commission are linear in the area, so this runs as two rows would."""
    r1 = f"({RETAIL_P1_START}+Inputs!$C$12)"
    s1 = f"({r1}+Inputs!$Q$114-1)"
    t1 = f"({s1}+Inputs!$C$60)"

    def prog(c, r, s):
        return f"IF({c}$4<{r},0,IF({c}$4>={s},1,(1-COS(PI()*({c}$4-{r}+1)/Inputs!$Q$114))/2))"

    def appr(c, r):
        return f"IF({c}$4={r},Inputs!$C$51*Inputs!$M$114/10^7*(1+Inputs!$C$10)*(1+Inputs!$C$54)^(({c}$4-1)/4),0)"

    def occ(c, t):
        return f"IF(OR({c}$4<{t},{c}$4>MIN(Inputs!$C$193,Inputs!$C$6)),0,MIN(Inputs!$C$189,Inputs!$C$189*({c}$4-{t}+1)/Inputs!$C$190))"

    def ph(n):
        return f'IF(COUNTIFS($Q$8:$Q$27,"Retail F&B",$R$8:$R$27,{n})>0,"P{n} ","")'

    out = {"C114": "Retail high street — primarily F&B (leased, not sold): 40% from Phase 1, 60% Phase 3",
           "One-Page Summary!F12": f'="P1 "&{ph(2)}&{ph(3)}&{ph(4)}'}  # the land card's phases: P1 with the rest
    for i in range(6, 46):  # columns G-AT, quarters 1-40
        c = chr(65 + i) if i < 26 else "A" + chr(65 + i - 26)
        out[f"Costs!{c}97"] = f"=0.6*{prog(c, 'Inputs!$R$114', 'Inputs!$S$114')}+0.4*{prog(c, r1, s1)}"
        out[f"Costs!{c}99"] = f"=0.6*{appr(c, 'Inputs!$R$114')}+0.4*{appr(c, r1)}"
        out[f"Retail Lease!{c}10"] = f"=0.6*{occ(c, 'Inputs!$T$114')}+0.4*{occ(c, t1)}"
    return out


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
    plan = json.load(open(f"{PLAN_DIR or REPO + '/app/prebuilt/plans'}/{oid}.json", encoding="utf-8"))
    plan = plan.get("plan", plan)
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
    # (owner 12 Oct: the FSI is the township's, over the whole site: no additional-FSI fee on the tower land)
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
    inputs["One-Page Summary!C15"] = "Hospital (not in this plan)"
    inputs.update(OFFICE_P1)
    inputs.update(OFFICE_P3)
    inputs.update(retail_split())
    cases.append({"id": oid, "inputs": inputs})
    g = L["green"]
    meta[oid] = {"label": label, "villas": nv, "villas_by_phase": [villas[k] for k in (1, 2, 3, 4)],
                 "villa_land_ac": round(villa_ac, 3), "villas_per_acre": round(nv / villa_ac, 2),
                 "open_space_ac": round(open_ac, 3), "roads_ac": round(roads_ac, 3), "parcel_ac": round(parcel, 3),
                 "plot_efficiency": round(plan["option"]["plottedShare"], 4),
                 "earthwork": plan.get("earthworkCost"),
                 "green_ac": {k: round(v / AC, 3) for k, v in g.items()}}

# SAVE_DIR=<folder> [ONLY=D2,D6]: save the model updated for each case as its own workbook (save_model.ps1), then stop
if os.environ.get("SAVE_DIR"):
    only = [x for x in os.environ.get("ONLY", "").split(",") if x]
    sel = [c for c in cases if not only or c["id"] in only]
    names = {c["id"]: f"Draft model - planning update {c['id']} (12 Oct 2026).xlsx" for c in sel}
    tmp = os.path.join(HERE, "_save.json")
    json.dump({"model": os.path.abspath(MODEL), "cases": sel, "dir": os.path.abspath(os.environ["SAVE_DIR"]), "names": names}, open(tmp, "w", encoding="utf-8"))
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(HERE, "save_model.ps1"), "-in", tmp],
                       capture_output=True, text=True)
    print(r.stdout.strip(), r.stderr.strip()[-2000:])
    os.remove(tmp)
    sys.exit(0 if "ERROR" not in r.stdout else 1)
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
    # section D: each product's saleable area and revenue by phase; Summary B80:H85: each phase's economics
    by_phase = []
    for row in range(44, 54):
        if not txt(c, f"C{row}"):
            continue
        by_phase.append({"product": txt(c, f"C{row}"), "area_sft": [round(num(c, f"{k}{row}") or 0) for k in "DEFG"],
                         "revenue_cr": [round(num(c, f"{k}{row}") or 0, 2) for k in "IJKL"], "row": row})
    phases = []
    for row in range(81, 85):
        v = [num(c, f"Summary!{k}{row}") or 0 for k in "CDEFGH"]
        phases.append({"phase": row - 80, "revenue_cr": round(v[0], 2), "construction_cr": round(v[1], 2), "land_infra_cr": round(v[2], 2),
                       "selling_cr": round(v[3], 2), "contribution_cr": round(v[4], 2), "margin": round(v[5], 4), "row": row})
    return {"source": "Draft model.xlsx · One-Page Summary", "land": land, "land_total_ac": round(num(c, "D20") or 0, 2),
            "funding": funding, "tickets": tickets, "tickets_average": avg, "tickets_note": txt(c, "C68"),
            "by_phase": by_phase, "phase_economics": phases, "phase_economics_source": "Summary B80:H85 (land & infra allocated)"}


def brief(inputs):
    """The inputs for the record: a row of formulas on another sheet (the retail split) as its range and first cell."""
    out, rows = {}, {}
    for k, v in inputs.items():
        m = re.fullmatch(r"(.+)!([A-Z]+)(\d+)", k)
        if m:
            rows.setdefault((m[1], m[3]), []).append((m[2], v))
        else:
            out[k] = v
    for (sh, r), cs in rows.items():
        out[f"{sh}!{cs[0][0]}{r}:{cs[-1][0]}{r}" if len(cs) > 1 else f"{sh}!{cs[0][0]}{r}"] = cs[0][1]
    return out


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
                      "(the hospital's, out of the plan) as the office's Phase 1 (40%), row 115 as its Phase 3 (60%); retail 40% Phase 1 / "
                      "60% Phase 3 on row 114's Costs G97:AT97, G99:AT99 and Retail Lease G10:AT10",
    "limitations": ["Retail: the 40% in Phase 1 is timed on the one retail row's formulas (built from quarter 3, let from its "
                    "possession); its land and the Summary sheet's by-phase lines stay with Phase 3. The Phase 1 start is an assumption.",
                    "Office: the Phase 1 and Phase 3 timing (start quarters 3 and 10, sold over 6 and 8 quarters) is an assumption."],
    "metrics": [{"key": k, "label": l, "cell": c, "unit": u, "better": b} for k, l, c, u, b in KEYS],
    "cases": {},
}
for c in ["model"] + [o[0] for o in OPTIONS]:
    e = {"label": "Draft model as given" if c == "model" else meta[c]["label"]}
    if c != "model":
        e.update({k: v for k, v in meta[c].items() if k != "label"})
        e["inputs"] = brief({k: (round(v, 6) if isinstance(v, float) else v) for k, v in next(x for x in cases if x["id"] == c)["inputs"].items()})
    e["values"] = {k: num(c, cell) for k, _, cell, _, _ in KEYS}
    e["text"] = {k: R[c][cell]["t"] for k, _, cell, _, _ in KEYS}
    e["summary"] = summary(c)
    doc["cases"][c] = e
    print(c, {k: e["text"][k] for k in ("units", "revenue_cr", "pat_cr", "project_irr", "promoter_irr")}, "land", e["summary"]["land_total_ac"])
dst = os.environ.get("OUT_YAML") or f"{REPO}/config/financials_draft_model.yaml"
with open(dst, "w", encoding="utf-8") as f:
    f.write("# The owner's draft financial model run on each master plan (tools/finance/run_model.py). Generated: do not edit.\n")
    yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False, width=140)
os.remove(tmp)
os.remove(out)
print("wrote", dst)
