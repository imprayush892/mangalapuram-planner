#!/usr/bin/env bash
# Re-plan D1-D6 on the optimised zoning (owner 12 Oct):
#   1 the zoning (optimise.py) and D1/D2 on it;
#   2 the green options' zonings: the same, with more villa land (POCKET_ / LINK_VILLA_AC) for the gardens to come out of,
#     and D3-D6 on it as their base plans;
#   3 the gardens (greens.py: pockets for D3/D4 from their base plans' plots, the link for D5/D6), D3-D6 again;
#   4 the walk to green on every plan.
# Needs the untracked scratch test app/src/engine/__tests__/_draft.test.ts and the layers from
# `node app/scripts/export-layers.mjs` (tools/zoning/layers).
set -e
R="D:/New folder/mangalapuram-planner"
W="D:/New folder/_work/draft"
P="$R/data/processed"
POCKET_VILLA_AC="${POCKET_VILLA_AC:-33}"     # D3/D4: the villa land the pockets come out of
LINK_VILLA_AC="${LINK_VILLA_AC:-34.5}"       # D5/D6: the link takes more, so more villa land to start from
plan() { (cd "$R/app" && node scripts/sync-data.mjs >/dev/null && ROADS=terrain,north_south SET="$1" npx vitest run src/engine/__tests__/_draft.test.ts >/dev/null); }
cd "$R"
python tools/zoning/optimise.py | tail -1
VILLA_AC="$POCKET_VILLA_AC" OUT="$W/zones_pocket_base.geojson" python tools/zoning/optimise.py | tail -1
VILLA_AC="$LINK_VILLA_AC" OUT="$W/zones_link_base.geojson" python tools/zoning/optimise.py | tail -1
for f in pockets pockets_ns; do cp "$W/zones_pocket_base.geojson" "$P/zones_draft_model_$f.geojson"; done
for f in chain chain_ns; do cp "$W/zones_link_base.geojson" "$P/zones_draft_model_$f.geojson"; done
plan ""
plan 'options.draft_zoning="green_pockets"'
cp "$W/D3.json" "$W/base_D3.json"; cp "$W/D4.json" "$W/base_D4.json"
plan 'options.draft_zoning="green_chain"'
cp "$W/D5.json" "$W/base_D5.json"; cp "$W/D6.json" "$W/base_D6.json"
BASE_ZONES="$W/zones_pocket_base.geojson" python tools/zoning/greens.py pockets "$W/base_D3.json" "$P/zones_draft_model_pockets.geojson" | tail -1
BASE_ZONES="$W/zones_pocket_base.geojson" python tools/zoning/greens.py pockets "$W/base_D4.json" "$P/zones_draft_model_pockets_ns.geojson" | tail -1
BASE_ZONES="$W/zones_link_base.geojson" python tools/zoning/greens.py link "$W/base_D5.json" "$P/zones_draft_model_chain.geojson" | tail -1
BASE_ZONES="$W/zones_link_base.geojson" python tools/zoning/greens.py link "$W/base_D6.json" "$P/zones_draft_model_chain_ns.geojson" | tail -1
plan 'options.draft_zoning="green_pockets"'
plan 'options.draft_zoning="green_chain"'
for d in "1 zones_draft_model" "2 zones_draft_model" "3 zones_draft_model_pockets" "4 zones_draft_model_pockets_ns" "5 zones_draft_model_chain" "6 zones_draft_model_chain_ns"; do
  set -- $d
  head -1 "$W/D$1.txt"
  grep -E "^  -- |LAND|GREEN " "$W/D$1.txt" || true
  python tools/zoning/greens.py check "$W/D$1.json" "$P/$2.geojson" | grep CHECK
done
echo DONE
