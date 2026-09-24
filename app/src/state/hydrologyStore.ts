import { useMemo } from 'react';
import { create } from 'zustand';
import { dataBaseUrl } from './appBase';
import { useSite } from './store';
import { useRules } from './useRules';
import {
  developedRunoffCoeff,
  hydrologyParams,
  stormFor,
  stormRunoffCoeff,
  waterModelFor,
} from '../engine/terrain/hydrology';
import type { HydrologyParams, StormResult } from '../engine/terrain/hydrology';
import type { WaterModel } from '../engine/terrain/water';

/**
 * Hydrology state.
 *
 * The storm inputs are assumptions (config/assumptions.yaml `hydrology`),
 * edited like every other assumption and saved with a scenario. The storm is
 * simulated here, live, on the same model the 2D and 3D views draw from. The
 * offline report (tools/preprocess/hydrology_analysis.py) supplies the
 * catchment names and outlets and the design-storm figures the live model is
 * tested against; nothing shown is filled in from it when it is missing.
 */

export interface ReportCatchment {
  node_id: number;
  name: string;
  outlet_cell: number;
  outlet_xy_m: [number, number];
  catchment_area_ha: number;
  pond_area_ha: number;
  storage_capacity_m3: number;
}

export interface HydrologyReport {
  method: { min_catchment_area_ha: number; dem?: string };
  site_totals: {
    total_area_ha: number;
    total_sinks_m3: number;
    total_ponding_area_ha: number;
    max_sink_depth_m: number;
    ponds: number;
    hollows: number;
  };
  catchment_count: number;
  catchments: ReportCatchment[];
}

interface HydrologyState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  report: HydrologyReport | null;
  /** Designed retention, m³: `site` for the whole survey, or an outlet cell for one catchment. */
  retention: Record<string, number>;
  load: () => Promise<void>;
  setRetention: (key: string, m3: number) => void;
  clearRetention: () => void;
}

function isReport(data: unknown): data is HydrologyReport {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.site_totals === 'object' && d.site_totals !== null && Array.isArray(d.catchments);
}

export const useHydrology = create<HydrologyState>((set, get) => ({
  status: 'idle',
  error: null,
  report: null,
  retention: {},
  setRetention: (key, m3) => set((s) => ({ retention: { ...s.retention, [key]: Math.max(0, m3) } })),
  clearRetention: () => set({ retention: {} }),
  load: async () => {
    if (get().status === 'loading' || get().status === 'ready') return;
    set({ status: 'loading', error: null });
    try {
      const res = await fetch(`${dataBaseUrl()}/processed/hydrology_report.json`);
      if (!res.ok) throw new Error(`hydrology_report.json: HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!isReport(data)) {
        throw new Error('hydrology_report.json is not in the current format; re-run tools/preprocess/hydrology_analysis.py');
      }
      set({ report: data, status: 'ready' });
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/** The storm the views draw and the panel reports, with the model it ran on. */
export interface ActiveStorm {
  params: HydrologyParams;
  model: WaterModel;
  natural: StormResult;
  developed: StormResult;
  /** C for the storm, and whether it is the formula's or a fixed value. */
  naturalC: number;
  developedC: number;
  cFromFormula: boolean;
}

/**
 * The design storm as the assumptions stand now, simulated on the site DEM.
 * Null until the site and config have loaded, or when the config has no
 * hydrology block (that throws inside `hydrologyParams`, and is reported).
 */
export function useActiveStorm(): ActiveStorm | { error: string } | null {
  const site = useSite((s) => s.site);
  const rules = useRules();
  return useMemo(() => {
    if (!site || !rules) return null;
    let params: HydrologyParams;
    try {
      params = hydrologyParams(rules.assumptions);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    const model = waterModelFor(site.dem, site.features, params.pondingDepthM);
    const naturalC = stormRunoffCoeff(params, params.designStormMm);
    const developedC = developedRunoffCoeff(params, naturalC);
    return {
      params,
      model,
      natural: stormFor(site.dem, model, params, params.designStormMm, naturalC),
      developed: stormFor(site.dem, model, params, params.designStormMm, developedC),
      naturalC,
      developedC,
      cFromFormula: params.stormRunoffCoeff === null,
    };
  }, [site, rules]);
}

/** The storm result for the views, or null while loading or misconfigured. */
export function useStormForViews(): StormResult | null {
  const active = useActiveStorm();
  return active && 'natural' in active ? active.natural : null;
}
