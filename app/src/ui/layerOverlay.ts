import type { Dem } from '../engine/terrain/dem';
import type { AnalysisResult, LayerId } from '../engine/pipeline/analysis';
import type { TerrainOverlay } from '../engine/export/glb';
import { LAYER_STYLE, TIER_RGB, TYPOLOGY_RGB } from './planningStyle';
import type { PlanResult } from '../engine/pipeline/plan';
import type { PlanLayer } from '../state/planningStore';
import type { MultiPoly, Ring } from '../engine/geom/types';

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
  plan: PlanResult | null = null,
  planVisible: PlanLayer[] = [],
): TerrainOverlay | null {
  const shown = analysis ? analysis.order.filter((id) => visible.includes(id)) : [];
  const showPlan = (l: PlanLayer): boolean => !!plan && planVisible.includes(l);
  if (!base && shown.length === 0 && !plan) return null;
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

  // Steps 8-16 on the ground: block tints, road corridors, cut and fill.
  if (plan) {
    const toPx = (p: readonly [number, number]): [number, number] => [(p[0] - x0) / cell_m, ny - (p[1] - y0) / cell_m];
    const fillGeom = (mp: MultiPoly, style: string): void => {
      ctx.beginPath();
      for (const poly of mp) {
        for (const ring of poly) {
          ring.forEach((p, i) => {
            const [px, py] = toPx(p);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.closePath();
        }
      }
      ctx.fillStyle = style;
      ctx.fill('evenodd');
    };
    if (showPlan('blocks')) {
      for (const b of plan.blocks) {
        const [r, g, bl] = TYPOLOGY_RGB[b.typology];
        fillGeom(b.geom, `rgba(${r},${g},${bl},0.3)`);
      }
    }
    if (showPlan('earthwork')) {
      const img = ctx.getImageData(0, 0, nx, ny);
      for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
          const d = plan.earthwork[j * nx + i]!;
          if (Math.abs(d) < 0.05) continue;
          const p = ((ny - 1 - j) * nx + i) * 4;
          const t = Math.min(1, Math.abs(d) / 3);
          const a = 0.35 + 0.5 * t;
          const rgb = d < 0 ? [225, 70, 55] : [60, 130, 230];
          for (let c = 0; c < 3; c += 1) img.data[p + c] = Math.round(rgb[c]! * a + img.data[p + c]! * (1 - a));
          img.data[p + 3] = Math.max(img.data[p + 3]!, Math.round(255 * a));
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    if (showPlan('roads')) {
      for (const r of plan.roads) {
        const [cr, cg, cb] = TIER_RGB[r.tier];
        fillGeom(r.geom, `rgba(${cr},${cg},${cb},0.9)`);
      }
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
  if (plan && showPlan('plots')) {
    outlines.push({ rings: plan.plots.map((p) => p.ring as Ring), colour: 0xf5f5f0 });
  }
  if (plan && showPlan('blocks')) {
    for (const b of plan.blocks) {
      const [r, g, bl] = TYPOLOGY_RGB[b.typology];
      outlines.push({ rings: b.geom.flat(), colour: (r << 16) | (g << 8) | bl });
    }
  }

  return { image: canvas, x0, y0, widthM: nx * cell_m, heightM: ny * cell_m, outlines };
}
