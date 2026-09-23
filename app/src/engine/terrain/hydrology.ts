import type { Dem } from './dem';
import type { SiteFeature } from '../site/types';
import { buildWaterModel } from './water';
import type { WaterModel } from './water';

/**
 * The one set of hydrology rules the app uses.
 *
 * The panel's numbers, the 2D raster, the 3D terrain tint, the flow lines and
 * the particles all read from here, so what is drawn is what is reported. The
 * same rules are in tools/preprocess/hydrology_analysis.py, which writes the
 * report the panel loads; change one and change the other.
 */

/** A hollow shallower than this is DEM noise on a 2 m grid, not a pond. */
export const PONDING_DEPTH_M = 0.25;

/** Upslope cells before a flow path is a channel, at the report's design storm. */
export const CHANNEL_UPSLOPE_CELLS = 250;

export interface ClimateParams {
  annual_rainfall_mm: number;
  peak_daily_rainfall_mm: number;
  runoff_coeff_natural: number;
  runoff_coeff_developed: number;
}

/**
 * How much bigger the storm being looked at is than the report's design
 * storm, as a runoff ratio. 1 is the design storm itself.
 */
export function stormScale(active: ClimateParams, baseline: ClimateParams): number {
  const rain = active.peak_daily_rainfall_mm / Math.max(1, baseline.peak_daily_rainfall_mm);
  const c = active.runoff_coeff_natural / Math.max(0.01, baseline.runoff_coeff_natural);
  return Math.max(0.01, rain * c);
}

/**
 * Upslope cells before a flow path is drawn as carrying water. A bigger storm
 * puts flow in smaller gullies, so the threshold falls as the storm grows.
 * Every view uses this, so the network is the same in 2D and 3D.
 */
export function channelThresholdCells(scale: number): number {
  return Math.min(5000, Math.max(12, Math.round(CHANNEL_UPSLOPE_CELLS / scale)));
}

export interface StormBalance {
  /** Rain falling on the area, m³. */
  rain_m3: number;
  /** The share that soaks in: rain × (1 − C), m³. */
  infiltrated_m3: number;
  /** Surface runoff: rain × C, m³. */
  runoff_m3: number;
  /** Natural hollows plus any designed retention, m³. */
  storage_m3: number;
  /** Runoff held back, never more than the storage or the runoff, m³. */
  ponded_m3: number;
  /** Runoff that leaves: runoff − ponded, m³. */
  outflow_m3: number;
  storage_fill_pct: number;
  /** Runoff spread evenly over the duration, m³/s. A mean, not an IDF peak. */
  mean_runoff_rate_m3s: number;
  mean_outflow_rate_m3s: number;
}

/**
 * A plain runoff-coefficient balance for one storm. The same arithmetic as the
 * preprocessing script: nothing is added for surcharge or repeat fills, because
 * there is no measured basis for either.
 */
export function stormBalance(
  areaHa: number,
  rainMm: number,
  runoffCoeff: number,
  naturalStorageM3: number,
  designedStorageM3: number,
  durationHours: number,
): StormBalance {
  const rain_m3 = areaHa * 10000 * (rainMm / 1000);
  const runoff_m3 = rain_m3 * runoffCoeff;
  const storage_m3 = naturalStorageM3 + designedStorageM3;
  const ponded_m3 = Math.min(storage_m3, runoff_m3);
  const outflow_m3 = runoff_m3 - ponded_m3;
  const seconds = durationHours * 3600;
  return {
    rain_m3,
    infiltrated_m3: rain_m3 - runoff_m3,
    runoff_m3,
    storage_m3,
    ponded_m3,
    outflow_m3,
    storage_fill_pct: storage_m3 > 0 ? (ponded_m3 / storage_m3) * 100 : 0,
    mean_runoff_rate_m3s: runoff_m3 / seconds,
    mean_outflow_rate_m3s: outflow_m3 / seconds,
  };
}

const cache = new WeakMap<Dem, { features: SiteFeature[]; model: WaterModel }>();

/**
 * The water model for a site, built once. The raster, the 3D tint, the flow
 * lines and the particles all ask for it, and it takes a moment on 160k cells.
 */
export function waterModelFor(dem: Dem, features: SiteFeature[]): WaterModel {
  const hit = cache.get(dem);
  if (hit && hit.features === features) return hit.model;
  const model = buildWaterModel({
    dem,
    minUpslopeCells: CHANNEL_UPSLOPE_CELLS,
    features,
    pondingDepthM: PONDING_DEPTH_M,
  });
  cache.set(dem, { features, model });
  return model;
}
