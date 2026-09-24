import type { Dem } from '../engine/terrain/dem';
import type { AnalysisResult, LayerId } from '../engine/pipeline/analysis';
import type { TerrainOverlay } from '../engine/export/glb';
import { LAYER_STYLE } from './planningStyle';

/**
 * What is draped on the 3D terrain: the terrain raster chosen in the Site panel
 * (level, slope, plot fall, buildability) underneath, and the visible planning
 * layers over it, with each outlined layer's rings. One pixel per DEM cell,
 * north up — the same image the 2D plan shows, so the two views agree.
 */
export function buildTerrainOverlay(
  dem: Dem,
  base: HTMLCanvasElement | null,
  analysis: AnalysisResult | null,
  visible: LayerId[],
): TerrainOverlay | null {
  const shown = analysis ? analysis.order.filter((id) => visible.includes(id)) : [];
  if (!base && shown.length === 0) return null;
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (base) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, 0, 0, nx, ny);
  }

  if (analysis && shown.length > 0) {
    const layer = document.createElement('canvas');
    layer.width = nx;
    layer.height = ny;
    const lctx = layer.getContext('2d');
    if (lctx) {
      const img = lctx.createImageData(nx, ny);
      const px = img.data;
      for (const id of shown) {
        const st = LAYER_STYLE[id];
        if (st.fill <= 0) continue;
        const mask = analysis.layers[id].mask;
        const a = st.fill;
        for (let j = 0; j < ny; j += 1) {
          for (let i = 0; i < nx; i += 1) {
            if (!mask[j * nx + i]) continue;
            // DEM row 0 is the southern row; image row 0 is north.
            const p = ((ny - 1 - j) * nx + i) * 4;
            const under = px[p + 3]! / 255;
            const out = a + under * (1 - a);
            for (let c = 0; c < 3; c += 1) {
              px[p + c] = Math.round((st.rgb[c]! * a + px[p + c]! * under * (1 - a)) / Math.max(out, 1e-6));
            }
            px[p + 3] = Math.round(out * 255);
          }
        }
      }
      lctx.putImageData(img, 0, 0);
      ctx.drawImage(layer, 0, 0);
    }
  }

  const outlines = analysis
    ? shown
        .filter((id) => LAYER_STYLE[id].outline > 0)
        .map((id) => {
          const [r, g, b] = LAYER_STYLE[id].rgb;
          return { rings: analysis.layers[id].geom.flat(), colour: (r << 16) | (g << 8) | b };
        })
    : [];

  return { image: canvas, x0, y0, widthM: nx * cell_m, heightM: ny * cell_m, outlines };
}
