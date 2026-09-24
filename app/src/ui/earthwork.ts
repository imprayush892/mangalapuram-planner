import type { Dem } from '../engine/terrain/dem';
import type { RasterLayer } from './raster';

/** Cut red, fill blue, deeper = stronger; 0 = untouched ground, transparent. */
export function earthworkRaster(dem: Dem, delta: Float32Array): RasterLayer | null {
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(nx, ny);
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const d = delta[j * nx + i]!;
      if (Math.abs(d) < 0.05) continue;
      const p = ((ny - 1 - j) * nx + i) * 4;
      const t = Math.min(1, Math.abs(d) / 3);
      if (d < 0) {
        img.data[p] = 225;
        img.data[p + 1] = 70;
        img.data[p + 2] = 55;
      } else {
        img.data[p] = 60;
        img.data[p + 1] = 130;
        img.data[p + 2] = 230;
      }
      img.data[p + 3] = Math.round(90 + 150 * t);
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    canvas,
    x0,
    y0,
    widthM: nx * cell_m,
    heightM: ny * cell_m,
    legend: {
      label: 'Earthwork: cut red, fill blue',
      unit: 'm',
      stops: [
        { value: -3, colour: 'rgb(225,70,55)' },
        { value: 0, colour: 'rgba(0,0,0,0)' },
        { value: 3, colour: 'rgb(60,130,230)' },
      ],
    },
  };
}
