import type { AssetSource } from '../data/source';
import type { PlanResult } from '../pipeline/plan';

/**
 * The eight master plans worked out ahead of time, for a hosted copy of the app:
 * sizing a plan's villas can take a minute, longer on a tablet, and
 * a host may not start workers at all. Each file carries a fingerprint of the
 * rules and the site it was planned on; the app uses a file only when the
 * fingerprint matches what it has loaded, so a prebuilt plan is never stale.
 */

export type PresentOptionId = 'A1' | 'A2' | 'B1' | 'B2' | 'B3' | 'B4' | 'C1' | 'C2';

/**
 * The eight master plans (owner 25 and 28 Sep): villa category (planning_rules.yaml
 * villas.categories) by road layout. The one list the panel, the presentation
 * and the prebuild all read.
 */
export const PRESENT_PLAN_OPTIONS: { id: PresentOptionId; sizing: 'A' | 'B' | 'B_count' | 'C'; roads: 'terrain' | 'north_south'; label: string }[] = [
  { id: 'A1', sizing: 'A', roads: 'terrain', label: 'Large villas · roads to the ground' },
  { id: 'A2', sizing: 'A', roads: 'north_south', label: 'Large villas · north–south roads' },
  { id: 'B1', sizing: 'B', roads: 'terrain', label: 'Client plot size held · roads to the ground' },
  { id: 'B2', sizing: 'B', roads: 'north_south', label: 'Client plot size held · north–south roads' },
  { id: 'B3', sizing: 'B_count', roads: 'terrain', label: 'Client 700 units held (G+2) · roads to the ground' },
  { id: 'B4', sizing: 'B_count', roads: 'north_south', label: 'Client 700 units held (G+2) · north–south roads' },
  { id: 'C1', sizing: 'C', roads: 'terrain', label: 'Standard and premium · roads to the ground' },
  { id: 'C2', sizing: 'C', roads: 'north_south', label: 'Standard and premium · north–south roads' },
];

/** What a plan depends on, relative to the data directory. */
export const FINGERPRINT_FILES = [
  'config/assumptions.yaml',
  'config/client_rules.yaml',
  'config/kmbr_rules.yaml',
  'config/planning_rules.yaml',
  'config/programme.yaml',
  'processed/dem_2m.json',
  'processed/parcel.geojson',
  'processed/zones_client_registered.geojson',
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
