import type { AssetSource } from '../data/source';
import { geometryToLines, geometryToMulti, geometryToPoint } from '../data/geojson';
import type { GeoJsonFeatureCollection } from '../data/geojson';
import { Dem, demFromBuffer } from '../terrain/dem';
import type { DemMeta } from '../terrain/dem';
import { Tin, parseObj } from '../terrain/tin';
import { intersect, union } from '../geom/boolean';
import { multiPolyArea } from '../geom/planar';
import { m2ToAcres } from '../units';
import type {
  ContourLine,
  GeometryConfidence,
  ParcelPart,
  SiteFeature,
  SiteOrigin,
  Zone,
  ZoningRegistration,
} from './types';
import type { MultiPoly } from '../geom/types';

export interface SiteModel {
  origin: SiteOrigin;
  registration: ZoningRegistration;
  parcelParts: ParcelPart[];
  /** Union of all in-scope parcel parts: the boundary every layout lives in. */
  parcel: MultiPoly;
  parcelAreaM2: number;
  parcelAreaAc: number;
  zones: Zone[];
  features: SiteFeature[];
  contours: ContourLine[];
  dem: Dem;
  /** Present when the TIN has been loaded; the DEM alone is enough to plan. */
  tin: Tin | null;
}

interface ParcelProps {
  id: string;
  deed_label: string;
  area_m2: number;
  area_ac: number;
  status: string;
}

interface ZoneProps {
  name: string;
  label_area_ac: number;
  drawn_area_ac: number;
  in_scope_ac: number;
  geometry_confidence: GeometryConfidence;
}

interface FeatureProps {
  layer: string;
  kind: string;
}

interface ContourProps {
  rl: number;
  major: boolean;
}

export interface LoadSiteOptions {
  /** The TIN is ~420 kB; skip it where only the DEM is needed. */
  withTin?: boolean;
}

export async function loadSite(src: AssetSource, opts: LoadSiteOptions = {}): Promise<SiteModel> {
  const [origin, registration, parcelFc, zonesFc, featuresFc, contoursFc, demMeta] = await Promise.all([
    src.json<SiteOrigin>('processed/site_origin.json'),
    src.json<ZoningRegistration>('processed/zoning_registration.json'),
    src.json<GeoJsonFeatureCollection<ParcelProps>>('processed/parcel.geojson'),
    src.json<GeoJsonFeatureCollection<ZoneProps>>('processed/zones_client_registered.geojson'),
    src.json<GeoJsonFeatureCollection<FeatureProps>>('processed/site_features.geojson'),
    src.json<GeoJsonFeatureCollection<ContourProps>>('processed/contours_1m.geojson'),
    src.json<DemMeta>('processed/dem_2m.json'),
  ]);

  const demBuffer = await src.binary('processed/dem_2m.f32');
  const dem = demFromBuffer(demMeta, demBuffer);

  let tin: Tin | null = null;
  if (opts.withTin) tin = parseObj(await src.text('terrain/terrain_tin.obj'));

  const parcelParts: ParcelPart[] = parcelFc.features.map((f) => ({
    id: f.properties.id,
    deedLabel: f.properties.deed_label,
    areaM2: f.properties.area_m2,
    areaAc: f.properties.area_ac,
    status: f.properties.status,
    geom: geometryToMulti(f.geometry),
  }));

  const parcel = union(...parcelParts.filter((p) => p.status === 'in_scope').map((p) => p.geom));
  const parcelAreaM2 = multiPolyArea(parcel);

  const zones: Zone[] = zonesFc.features.map((f, i) => {
    const drawnGeom = geometryToMulti(f.geometry);
    const geom = intersect(drawnGeom, parcel);
    return {
      id: slug(f.properties.name, i),
      name: f.properties.name,
      drawnGeom,
      geom,
      labelAreaAc: f.properties.label_area_ac,
      drawnAreaAc: f.properties.drawn_area_ac,
      inScopeAc: f.properties.in_scope_ac,
      computedInScopeAc: m2ToAcres(multiPolyArea(geom)),
      confidence: f.properties.geometry_confidence,
    };
  });

  const features: SiteFeature[] = featuresFc.features.map((f) => ({
    layer: f.properties.layer,
    kind: f.properties.kind,
    lines: geometryToLines(f.geometry),
    point: geometryToPoint(f.geometry),
  }));

  const contours: ContourLine[] = contoursFc.features.flatMap((f) =>
    geometryToLines(f.geometry).map((line) => ({
      rl: f.properties.rl,
      major: Boolean(f.properties.major),
      line,
    })),
  );

  return {
    origin,
    registration,
    parcelParts,
    parcel,
    parcelAreaM2,
    parcelAreaAc: m2ToAcres(parcelAreaM2),
    zones,
    features,
    contours,
    dem,
    tin,
  };
}

function slug(name: string, index: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base || `zone-${index}`;
}

/** Local metres -> UTM 43N easting/northing. */
export function localToUtm(origin: SiteOrigin, x: number, y: number): [number, number] {
  return [x + origin.local_origin_utm[0], y + origin.local_origin_utm[1]];
}
