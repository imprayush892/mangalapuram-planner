# CLAUDE.md — Mangalapuram Township Planner

You are building a **browser web app** for ONÈO's client: a site-driven planning tool for a 100-acre (73.54 ac in scope) mixed-use township at Mangalapuram, Thiruvananthapuram, Kerala. Everything you need is in this repository. The client has answered all blocking questions; **do not re-ask them** — open items are switches with defaults (docs/SPEC.md §11).

## When the user says "start building"
1. Read, in order: `docs/SPEC.md` (authoritative), `docs/DECISIONS.md`, `docs/DATA.md`, `config/*.yaml`, `tests/expected_values.yaml`. Skim `docs/PRD_link.md`.
2. Create the app in `app/` (Vite + React + TypeScript strict, per SPEC §9). Copy `data/processed/*` and `config/*` into `app/public/data/` at build time (script, not manual copies).
3. Work milestone by milestone (SPEC §10): M1 → M2 → M3 → M4 → M5 → M6. Commit after each milestone with a clear message.
4. For each milestone: write engine code as **pure TypeScript modules** under `app/src/engine/` with Vitest tests that assert the golden values in `tests/expected_values.yaml` (respect tolerances). Then wire UI.
5. At the end of each milestone, run `npm run test` and `npm run build`, fix failures, and print a short status: what works, test results, what's next, any assumption you added.
6. Keep going to the next milestone unless something truly blocks you. If blocked, stop and ask one precise question.

## Non-negotiable rules
- **Priority is Level 2 (inside-zone layouts): villa plots + internal roads, apartment tower sizing/placement.** Don't gold-plate Level 1 before M3/M4 work.
- **Never invent regulation values.** Read them from `config/kmbr_rules.yaml`. If a value is missing, check `docs/kmbr_source/*.txt`, add it to the YAML with `verified:` status and a clause reference.
- **Client rules govern the first cut; KMBR is checked on top.** Show both where they differ; compliance status uses the stricter.
- **All assumptions live in `config/assumptions.yaml`** and are editable in the UI. No magic numbers in engine code.
- **Coordinates are local metres** (see `data/processed/site_origin.json`); levels are RL on assumed TBM=100 datum. Use planar geometry only.
- **Deferred land (26.4 ac) and the hospital are out of the in-scope layout.** Keep a reserved hospital marker/zone; place nothing else on deferred land unless the user toggles it.
- Unsurveyed DEM cells are NaN — allow but flag as low-confidence; never fill silently.
- Every reported number must be traceable (data file, rule id, or assumption key). Put the source in tooltips/report rows.
- Units: store metres / m²; display m² and sft (1 m² = 10.7639 sft), acres (1 ac = 4046.8564 m²), cents (1 cent = 40.4686 m²).
- Engines run in Web Workers; one zone regenerates in < 10 s.

## Repository map
```
CLAUDE.md               this file
README.md               human quick-start
docs/SPEC.md            build spec (authoritative)
docs/DECISIONS.md       client decisions + interpretations
docs/DATA.md            data dictionary and known data issues
docs/PRD_link.md        link to the live PRD
docs/kmbr_source/       KMBR 2019 (to 2023) + 2025 amendment, text extracts
config/client_rules.yaml   client sizing & planning rules (govern)
config/kmbr_rules.yaml     KMBR tables as data (checked on top)
config/programme.yaml      programme lines from cashflow + decisions
config/assumptions.yaml    editable assumptions
data/processed/         app-ready geometry, DEM, levels, contours
data/raw/               original client files (do not modify)
data/reference/         images for orientation (overlay, suitability, drainage)
tests/expected_values.yaml golden numbers for engine tests
tools/preprocess/       Python pipeline that produced data/processed (DWG via LibreDWG)
```

## Definition of done (whole project)
For the 73.54 ac in scope, the app recommends what to build, how much, where and why for every use in the brief; generates 3 legal options per villa/senior and apartment zone; reports compliance with clause references and client-rule conflicts; reports the programme shortfall honestly; and exports DXF, XLSX, PDF/PNG and GLB that open cleanly.
