import type { MultiPoly, Poly, Pt, Ring } from '../geom/types';
import { openRing } from '../geom/planar';

export interface GeoJsonFeature<P = Record<string, unknown>> {
  type: 'Feature';
  properties: P;
  geometry: GeoJsonGeometry | null;
}

export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

export interface GeoJsonFeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  name?: string;
  crs_note?: string;
  features: GeoJsonFeature<P>[];
}

const toRing = (coords: number[][]): Ring =>
  openRing(coords.map((c) => [c[0] ?? 0, c[1] ?? 0] as Pt));

const toPoly = (coords: number[][][]): Poly => coords.map(toRing).filter((r) => r.length >= 3);

/** Any polygonal geometry becomes a MultiPoly; anything else becomes []. */
export function geometryToMulti(geom: GeoJsonGeometry | null): MultiPoly {
  if (!geom) return [];
  if (geom.type === 'Polygon') {
    const poly = toPoly(geom.coordinates);
    return poly.length ? [poly] : [];
  }
  if (geom.type === 'MultiPolygon') return geom.coordinates.map(toPoly).filter((p) => p.length > 0);
  return [];
}

export function geometryToLines(geom: GeoJsonGeometry | null): Pt[][] {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates.map((c) => [c[0] ?? 0, c[1] ?? 0] as Pt)];
  if (geom.type === 'MultiLineString')
    return geom.coordinates.map((line) => line.map((c) => [c[0] ?? 0, c[1] ?? 0] as Pt));
  return [];
}

export function geometryToPoint(geom: GeoJsonGeometry | null): Pt | null {
  if (!geom || geom.type !== 'Point') return null;
  return [geom.coordinates[0] ?? 0, geom.coordinates[1] ?? 0];
}
