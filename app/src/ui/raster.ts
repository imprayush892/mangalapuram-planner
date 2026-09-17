import type { Dem } from '../engine/terrain/dem';
import type { RasterMode } from '../state/store';

export interface RasterLayer {
  canvas: HTMLCanvasElement;
  /** World extent the canvas covers. */
  x0: number;
  y0: number;
  widthM: number;
  heightM: number;
  legend: { label: string; stops: { value: number; colour: string }[]; unit: string } | null;
}

type Ramp = { stop: number; rgb: [number, number, number] }[];

const RL_RAMP: Ramp = [
  { stop: 0, rgb: [36, 78, 92] },
  { stop: 0.25, rgb: [58, 124, 110] },
  { stop: 0.5, rgb: [168, 178, 106] },
  { stop: 0.75, rgb: [196, 140, 86] },
  { stop: 1, rgb: [238, 231, 220] },
];

/** Green to red: readable as "gets harder to build on". */
const SLOPE_RAMP: Ramp = [
  { stop: 0, rgb: [104, 176, 122] },
  { stop: 0.3, rgb: [204, 200, 110] },
  { stop: 0.6, rgb: [223, 150, 80] },
  { stop: 1, rgb: [200, 74, 62] },
];

function sample(ramp: Ramp, t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 1; i < ramp.length; i++) {
    const a = ramp[i - 1]!;
    const b = ramp[i]!;
    if (clamped <= b.stop) {
      const f = (clamped - a.stop) / Math.max(1e-9, b.stop - a.stop);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
      ];
    }
  }
  return ramp[ramp.length - 1]!.rgb;
}

const rgbCss = ([r, g, b]: [number, number, number]): string => `rgb(${r},${g},${b})`;

/**
 * Builds a DEM-sized image for the chosen measure. DEM row 0 is the southern
 * row, so the image is written bottom-up to keep north at the top on screen.
 */
export function buildRaster(dem: Dem, mode: RasterMode, unbuildableSlopeDeg: number): RasterLayer | null {
  if (mode === 'none') return null;
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(nx, ny);

  const stats = dem.stats();
  const slope = mode === 'slope' || mode === 'buildable' ? dem.slopeGrid() : null;
  const fall = mode === 'fall' ? dem.windowFallGrid(11.4, 14.2, 0.75) : null;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      // flip vertically: DEM j=0 is south, image row 0 is north
      const p = ((ny - 1 - j) * nx + i) * 4;
      let rgb: [number, number, number] | null = null;
      let alpha = 205;

      if (mode === 'rl') {
        const v = dem.values[k]!;
        if (Number.isFinite(v)) rgb = sample(RL_RAMP, (v - stats.rlMin) / (stats.rlMax - stats.rlMin));
      } else if (mode === 'slope' && slope) {
        const s = slope[k]!;
        if (Number.isFinite(s)) rgb = sample(SLOPE_RAMP, s / 45);
      } else if (mode === 'buildable' && slope) {
        const s = slope[k]!;
        if (Number.isFinite(s)) {
          rgb = s > unbuildableSlopeDeg ? [200, 74, 62] : s > 20 ? [223, 180, 90] : [104, 176, 122];
          alpha = s > unbuildableSlopeDeg ? 220 : 150;
        }
      } else if (mode === 'fall' && fall) {
        const f = fall[k]!;
        if (Number.isFinite(f)) rgb = sample(SLOPE_RAMP, f / 4);
      }

      if (rgb) {
        img.data[p] = rgb[0];
        img.data[p + 1] = rgb[1];
        img.data[p + 2] = rgb[2];
        img.data[p + 3] = alpha;
      } else {
        img.data[p + 3] = 0; // unsurveyed stays transparent — never filled
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  const legend = buildLegend(mode, stats.rlMin, stats.rlMax, unbuildableSlopeDeg);
  return { canvas, x0, y0, widthM: nx * cell_m, heightM: ny * cell_m, legend };
}

function buildLegend(
  mode: RasterMode,
  rlMin: number,
  rlMax: number,
  unbuildable: number,
): RasterLayer['legend'] {
  if (mode === 'rl') {
    return {
      label: 'Level (RL, TBM = 100)',
      unit: 'm',
      stops: [0, 0.25, 0.5, 0.75, 1].map((t) => ({
        value: rlMin + (rlMax - rlMin) * t,
        colour: rgbCss(sample(RL_RAMP, t)),
      })),
    };
  }
  if (mode === 'slope') {
    return {
      label: 'Slope',
      unit: '°',
      stops: [0, 10, 20, 30, 45].map((v) => ({ value: v, colour: rgbCss(sample(SLOPE_RAMP, v / 45)) })),
    };
  }
  if (mode === 'fall') {
    return {
      label: 'Fall across an 11.4 × 14.2 m plot window',
      unit: 'm',
      stops: [0, 1, 2, 3, 4].map((v) => ({ value: v, colour: rgbCss(sample(SLOPE_RAMP, v / 4)) })),
    };
  }
  if (mode === 'buildable') {
    return {
      label: `Buildability (Rule 22: over ${unbuildable}° is unbuildable)`,
      unit: '°',
      stops: [
        { value: 0, colour: 'rgb(104,176,122)' },
        { value: 20, colour: 'rgb(223,180,90)' },
        { value: unbuildable, colour: 'rgb(200,74,62)' },
      ],
    };
  }
  return null;
}
