import type { LayerId } from '../engine/pipeline/analysis';

/**
 * How each planning layer is drawn, in 2D and on the 3D terrain. Zones are
 * drawn as tinted ground with a crisp outline, never as solids, so they stay
 * distinct from the building masses that later steps stand on them.
 */
export interface LayerStyle {
  /** RGB, 0-255. */
  rgb: [number, number, number];
  /** Fill opacity, 0-1. 0 = outline only. */
  fill: number;
  /** Outline width in screen pixels; 0 = none. */
  outline: number;
  dashed?: boolean;
}

export const LAYER_STYLE: Record<LayerId, LayerStyle> = {
  terrain: { rgb: [200, 210, 215], fill: 0, outline: 1 },
  flowPaths: { rgb: [90, 185, 255], fill: 0.7, outline: 0 },
  waterlogging: { rgb: [40, 125, 220], fill: 0.6, outline: 1 },
  safe: { rgb: [150, 210, 160], fill: 0, outline: 1.2, dashed: true },
  publicSpace: { rgb: [95, 180, 100], fill: 0.22, outline: 1.6 },
  moderateSlope: { rgb: [228, 176, 75], fill: 0.45, outline: 0 },
  nonBuildable: { rgb: [200, 85, 63], fill: 0.5, outline: 1 },
  drains: { rgb: [120, 225, 255], fill: 0.9, outline: 0 },
  existingRoads: { rgb: [220, 224, 228], fill: 0.85, outline: 0 },
  residual: { rgb: [150, 195, 110], fill: 0.35, outline: 0 },
  plotable: { rgb: [242, 206, 96], fill: 0.3, outline: 2 },
};

/** What a new viewer sees first: the answer (plotable land) and the two reasons for the rest. */
export const DEFAULT_VISIBLE: LayerId[] = ['waterlogging', 'nonBuildable', 'drains', 'plotable'];

export const rgba = ([r, g, b]: [number, number, number], a: number): string => `rgba(${r},${g},${b},${a})`;

/** Steps 8-16: block uses and road tiers. */
export const TYPOLOGY_RGB: Record<import('../engine/pipeline/plan').Typology, [number, number, number]> = {
  villas: [242, 206, 96],
  senior: [190, 140, 220],
  apartments: [225, 110, 105],
  school: [110, 165, 225],
  clubhouse: [120, 200, 125],
  golf: [70, 160, 80],
  commercial: [225, 130, 190],
  batching: [165, 135, 100],
  reserved: [200, 200, 200],
  future: [226, 221, 208],
  open: [150, 160, 165],
};

export const TYPOLOGY_LABEL: Record<import('../engine/pipeline/plan').Typology, string> = {
  villas: 'Villas',
  senior: 'Senior living',
  apartments: 'Apartments',
  school: 'School',
  clubhouse: 'Clubhouse',
  golf: 'Golf (clubhouse)',
  commercial: 'Commercial and convention',
  batching: 'Batching plant yard',
  reserved: 'Reserved (hospital)',
  future: 'To be decided with client',
  open: 'Open space',
};

export const TIER_RGB: Record<import('../engine/pipeline/plan').RoadTier, [number, number, number]> = {
  existing: [235, 235, 235],
  primary: [230, 80, 60],
  secondary: [240, 160, 60],
  tertiary: [205, 205, 205],
};
