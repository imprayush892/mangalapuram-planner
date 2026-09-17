import type { MultiPoly, Pt } from '../geom/types';

export interface SiteOrigin {
  crs: string;
  local_origin_utm: [number, number];
  local_origin_wgs84: [number, number];
  site_reference_point_client: string;
  tbm: { rl: number; utm: [number, number]; local: [number, number]; note: string };
  units: string;
}

export interface ParcelPart {
  id: string;
  deedLabel: string;
  areaM2: number;
  areaAc: number;
  status: string;
  geom: MultiPoly;
}

export type GeometryConfidence = 'good' | 'approximate' | 'missing';

export interface Zone {
  id: string;
  name: string;
  /** As drawn in the client zoning plan, before clipping to the parcel. */
  drawnGeom: MultiPoly;
  /** Clipped to the in-scope parcel: what the layout engines work on. */
  geom: MultiPoly;
  labelAreaAc: number;
  drawnAreaAc: number;
  inScopeAc: number;
  computedInScopeAc: number;
  confidence: GeometryConfidence;
}

export interface SiteFeature {
  layer: 'RD' | 'DR' | 'POND' | 'TF' | 'WELL' | 'TBM' | string;
  kind: string;
  lines: Pt[][];
  point: Pt | null;
}

export interface ContourLine {
  rl: number;
  major: boolean;
  line: Pt[];
}

export interface ZoningRegistration {
  method: string;
  dx: number;
  dy: number;
  th: number;
  sc: number;
  cB: [number, number];
  scale_note: string;
  fit_error_m: { p25: number; median: number; p75: number; p90: number };
  missing: string;
}
