import type { AssetSource } from '../data/source';
import type { PlanResult } from '../pipeline/plan';

/**
 * The master plans worked out ahead of time, for a hosted copy of the app:
 * sizing a plan's villas can take a minute, longer on a tablet, and
 * a host may not start workers at all. Each file carries a fingerprint of the
 * rules and the site it was planned on; the app uses a file only when the
 * fingerprint matches what it has loaded, so a prebuilt plan is never stale.
 */

export type PresentOptionId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
export type PresentZoning = 'model' | 'green_pockets' | 'green_chain';

/**
 * The master plans on the owner's draft financial model (owner 7 Oct 2026: planning_rules.yaml
 * options.basis draft_model): its programme and zoning, its four villa plot types (MIX), by road
 * layout. The one list the panel, the presentation and the prebuild all read. (The client-basis
 * options A1-C2 of 28 Sep run with options.basis: client.)
 */
export const PRESENT_PLAN_OPTIONS: { id: PresentOptionId; sizing: 'A' | 'B' | 'B_count' | 'C' | 'MIX'; roads: 'terrain' | 'north_south'; zoning: PresentZoning; label: string }[] = [
  { id: 'D1', sizing: 'MIX', roads: 'terrain', zoning: 'model', label: 'Optimised zoning · roads to the ground' },
  { id: 'D2', sizing: 'MIX', roads: 'north_south', zoning: 'model', label: 'Optimised zoning · north–south roads (Vastu)' },
  // Owner 12 Oct: pocket gardens spread through the villas, none further than 150 m walk from green.
  { id: 'D3', sizing: 'MIX', roads: 'terrain', zoning: 'green_pockets', label: 'Green pockets · roads to the ground' },
  { id: 'D4', sizing: 'MIX', roads: 'north_south', zoning: 'green_pockets', label: 'Green pockets · north–south roads (Vastu)' },
  // Owner 12 Oct: a green link through the villas, joining the parks, lakes and clubs (11-12 villas an acre).
  { id: 'D5', sizing: 'MIX', roads: 'terrain', zoning: 'green_chain', label: 'Green link · roads to the ground' },
  { id: 'D6', sizing: 'MIX', roads: 'north_south', zoning: 'green_chain', label: 'Green link · north–south roads (Vastu)' },
];

/** The planning overrides that select an option. */
export function optionOverrides(o: { sizing: string; roads: string; zoning: PresentZoning }): Record<string, string> {
  return { 'options.villa_sizing': o.sizing, 'options.road_orientation': o.roads, 'options.draft_zoning': o.zoning };
}

/** What a plan depends on, relative to the data directory. */
export const FINGERPRINT_FILES = [
  'config/assumptions.yaml',
  'config/client_rules.yaml',
  'config/kmbr_rules.yaml',
  'config/planning_rules.yaml',
  'config/programme.yaml',
  'config/programme_draft_model.yaml',
  'processed/dem_2m.json',
  'processed/parcel.geojson',
  'processed/zones_client_registered.geojson',
  'processed/zones_draft_model.geojson',
  'processed/zones_draft_model_pockets.geojson',
  'processed/zones_draft_model_pockets_ns.geojson',
  'processed/zones_draft_model_chain.geojson',
  'processed/zones_draft_model_chain_ns.geojson',
  'processed/site_features.geojson',
];

/** FNV-1a over the files' text, line endings normalised. */
export async function dataFingerprint(src: AssetSource): Promise<string> {
  let h = 0x811c9dc5;
  for (const rel of FINGERPRINT_FILES) {
    const t = (await src.text(rel)).replace(/\r\n/g, '\n');
    for (let i = 0; i < t.length; i += 1) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface PrebuiltPlan {
  fingerprint: string;
  option: PresentOptionId;
  plan: Omit<PlanResult, 'earthwork' | 'roadMask'> & { earthwork: string; roadMask: string };
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodePlan(plan: PlanResult, option: PresentOptionId, fingerprint: string): PrebuiltPlan {
  return {
    fingerprint,
    option,
    plan: {
      ...plan,
      earthwork: toBase64(new Uint8Array(plan.earthwork.buffer, plan.earthwork.byteOffset, plan.earthwork.byteLength)),
      roadMask: toBase64(new Uint8Array(plan.roadMask.buffer, plan.roadMask.byteOffset, plan.roadMask.byteLength)),
    },
  };
}

export function decodePlan(p: PrebuiltPlan): PlanResult {
  const ew = fromBase64(p.plan.earthwork);
  return {
    ...p.plan,
    earthwork: new Float32Array(ew.buffer, ew.byteOffset, ew.byteLength / 4),
    roadMask: fromBase64(p.plan.roadMask),
  } as PlanResult;
}

/**
 * The prebuilt plans that match the data as loaded now; empty when there are
 * none, or when the rules or the site have changed since they were built.
 */
export async function loadPrebuiltPlans(src: AssetSource): Promise<Partial<Record<PresentOptionId, PlanResult>>> {
  const out: Partial<Record<PresentOptionId, PlanResult>> = {};
  let fingerprint: string;
  try {
    fingerprint = await dataFingerprint(src);
  } catch {
    return out;
  }
  await Promise.all(
    PRESENT_PLAN_OPTIONS.map(async (o) => {
      try {
        const p = await src.json<PrebuiltPlan>(`plans/${o.id}.json`);
        if (p.fingerprint === fingerprint && p.option === o.id) out[o.id] = decodePlan(p);
      } catch {
        // no prebuilt file for this option: it is planned live
      }
    }),
  );
  return out;
}
