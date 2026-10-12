#!/usr/bin/env bash
# Re-plan D1-D6 on the optimised zoning (owner 12 Oct): D1/D2, then the greens from them, then D3-D6, then the walk check.
set -e
R="D:/New folder/mangalapuram-planner"
W="D:/New folder/_work/draft"
P="$R/data/processed"
cd "$R/app"
node scripts/sync-data.mjs >/dev/null
ROADS=terrain,north_south SET="" npx vitest run src/engine/__tests__/_draft.test.ts >/dev/null
cp "$W/D1.json" "$W/base_D1.json"; cp "$W/D2.json" "$W/base_D2.json"
cd "$R"
python tools/zoning/greens.py pockets "$W/base_D1.json" "$P/zones_draft_model_pockets.geojson" | tail -1
python tools/zoning/greens.py pockets "$W/base_D2.json" "$P/zones_draft_model_pockets_ns.geojson" | tail -1
python tools/zoning/greens.py link "$W/base_D1.json" "$P/zones_draft_model_chain.geojson" | tail -1
python tools/zoning/greens.py link "$W/base_D2.json" "$P/zones_draft_model_chain_ns.geojson" | tail -1
cd "$R/app"
node scripts/sync-data.mjs >/dev/null
ROADS=terrain,north_south SET='options.draft_zoning="green_pockets"' npx vitest run src/engine/__tests__/_draft.test.ts >/dev/null
ROADS=terrain,north_south SET='options.draft_zoning="green_chain"' npx vitest run src/engine/__tests__/_draft.test.ts >/dev/null
cd "$R"
for d in "1 zones_draft_model" "2 zones_draft_model" "3 zones_draft_model_pockets" "4 zones_draft_model_pockets_ns" "5 zones_draft_model_chain" "6 zones_draft_model_chain_ns"; do
  set -- $d
  head -1 "$W/D$1.txt"
  grep -E "^  -- |LAND|GREEN" "$W/D$1.txt" || true
  python tools/zoning/greens.py check "$W/D$1.json" "$P/$2.geojson" | grep CHECK
done
echo DONE
