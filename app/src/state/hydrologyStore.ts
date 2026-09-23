import { create } from 'zustand';
import { dataBaseUrl } from './appBase';
import { stormBalance, stormScale } from '../engine/terrain/hydrology';
import type { ClimateParams, StormBalance } from '../engine/terrain/hydrology';

/**
 * The hydrology report written by tools/preprocess/hydrology_analysis.py.
 *
 * Everything shown comes from that file: the site totals and the catchments
 * are measured off the DEM by the script, and the balance is recomputed here
 * with the same arithmetic so the storm inputs can be edited live. Nothing is
 * filled in when the file is missing — the panel says so instead.
 */

export interface HydrologyNode {
  node_id: number;
  name: string;
  outlet_xy_m: [number, number];
  catchment_area_ha: number;
  water_surface_ha: number;
  storage_capacity_m3: number;
}

export interface SiteTotals {
  total_area_ha: number;
  total_sinks_m3: number;
  total_ponding_area_ha: number;
  max_sink_depth_m: number;
  ponding_depth_m: number;
}

export interface HydrologyReport {
  method?: { climate_source?: string; min_catchment_area_ha?: number };
  climate_params: ClimateParams;
  site_totals: SiteTotals;
  catchment_count: number;
  catchments: HydrologyNode[];
}

interface HydrologyState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  report: HydrologyReport | null;
  overrides: Record<string, number>;
  load: () => Promise<void>;
  setOverride: (key: string, value: number) => void;
  resetOverrides: () => void;
}

function isReport(data: unknown): data is HydrologyReport {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.climate_params === 'object' &&
    d.climate_params !== null &&
    typeof d.site_totals === 'object' &&
    d.site_totals !== null &&
    Array.isArray(d.catchments)
  );
}

export const useHydrology = create<HydrologyState>((set, get) => ({
  status: 'idle',
  error: null,
  report: null,
  overrides: {},
  setOverride: (key, value) => set((state) => ({ overrides: { ...state.overrides, [key]: value } })),
  resetOverrides: () => set({ overrides: {} }),
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

export interface ActiveCatchment extends HydrologyNode {
  designed_storage_m3: number;
  peak: StormBalance;
  annual: StormBalance;
}

export interface ActiveHydrology {
  baseline: ClimateParams;
  activeParams: ClimateParams;
  /** Runoff of the storm being looked at against the report's design storm. */
  scale: number;
  siteTotals: SiteTotals;
  sitePeak: StormBalance;
  siteDevelopedPeak: StormBalance;
  siteAnnual: StormBalance;
  catchments: ActiveCatchment[];
  catchmentCount: number;
  minCatchmentHa: number;
  designedSitePondM3: number;
  isEdited: boolean;
}

const HOURS_DAY = 24;
const HOURS_YEAR = 365 * 24;

export function useActiveHydrology(): ActiveHydrology | null {
  const { report, overrides } = useHydrology();
  if (!report) return null;

  const baseline = report.climate_params;
  const activeParams: ClimateParams = { ...baseline, ...overrides };
  const designedSitePondM3 = overrides['site_designed_pond'] ?? 0;
  const t = report.site_totals;

  const sitePeak = stormBalance(
    t.total_area_ha,
    activeParams.peak_daily_rainfall_mm,
    activeParams.runoff_coeff_natural,
    t.total_sinks_m3,
    designedSitePondM3,
    HOURS_DAY,
  );
  const siteDevelopedPeak = stormBalance(
    t.total_area_ha,
    activeParams.peak_daily_rainfall_mm,
    activeParams.runoff_coeff_developed,
    t.total_sinks_m3,
    designedSitePondM3,
    HOURS_DAY,
  );
  // One fill of the hollows over the year: what they hold beyond that
  // depends on evaporation and soakage nobody has measured here.
  const siteAnnual = stormBalance(
    t.total_area_ha,
    activeParams.annual_rainfall_mm,
    activeParams.runoff_coeff_natural,
    t.total_sinks_m3,
    designedSitePondM3,
    HOURS_YEAR,
  );

  const catchments = report.catchments.map((node) => {
    const designed_storage_m3 = overrides[`retention_${node.node_id}`] ?? 0;
    const peak = stormBalance(
      node.catchment_area_ha,
      activeParams.peak_daily_rainfall_mm,
      activeParams.runoff_coeff_natural,
      node.storage_capacity_m3,
      designed_storage_m3,
      HOURS_DAY,
    );
    const annual = stormBalance(
      node.catchment_area_ha,
      activeParams.annual_rainfall_mm,
      activeParams.runoff_coeff_natural,
      node.storage_capacity_m3,
      designed_storage_m3,
      HOURS_YEAR,
    );
    return { ...node, designed_storage_m3, peak, annual };
  });

  return {
    baseline,
    activeParams,
    scale: stormScale(activeParams, baseline),
    siteTotals: t,
    sitePeak,
    siteDevelopedPeak,
    siteAnnual,
    catchments,
    catchmentCount: report.catchment_count,
    minCatchmentHa: report.method?.min_catchment_area_ha ?? 0,
    designedSitePondM3,
    isEdited: Object.keys(overrides).length > 0,
  };
}
