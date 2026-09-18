import type { MultiPoly, Pt } from '../engine/geom/types';
import type { SiteModel } from '../engine/site/loadSite';
import type { LayoutOption } from '../engine/generators/types';
import type { LayerFlags } from '../state/store';
import type { RasterLayer } from './raster';
import type { View } from './view';
import { niceScaleBar, worldToScreen } from './view';
import { fillMulti, label, strokePolyline, zoneColour } from './draw';
import { multiCentroid } from '../engine/geom/planar';
import { drawLayout } from './drawLayout';
import { drawCirculation } from './drawCirculation';
import type { CirculationRoad } from '../engine/masterplan/circulation';

/**
 * One drawing path for the plan, used by the interactive canvas and by the
 * PNG/PDF sheet export, so an exported sheet always matches what is on screen.
 */
export interface PlanScene {
  site: SiteModel;
  layers: LayerFlags;
  raster: RasterLayer | null;
  layouts: LayoutOption[];
  /**
   * The roads between the zones, from a master plan run. Drawn under the zone
   * layouts so an internal road meeting a collector reads as joining it.
   */
  circulation?: CirculationRoad[];
  /** Junction splay land from the same run, drawn under the roads. */
  splays?: MultiPoly;
  /** Points collected for the zone edit in progress. */
  editPending?: Pt[];
  editTool?: string;
  /** Zones picked for a merge. */
  editSelected?: string[];
  selectedZoneId: string | null;
  background: string;
  /**
   * Sheet exports render several times larger than the screen, so line widths,
   * text and chrome are multiplied by this rather than staying at screen sizes.
   */
  pen?: number;
  /** Sheets dim the raster so the linework on top of it still reads. */
  rasterOpacity?: number;
  /**
   * Colour per zone id, from the siting engine's allocation. Where a zone has
   * one, the plan shows the use the engine chose rather than the colour its
   * name in the client zoning plan implies — which is the whole point of
   * running the engine.
   */
  zoneColours?: Record<string, string>;
  /** Label per zone id, from the allocation. */
  zoneLabels?: Record<string, string>;
}

export function drawPlan(ctx: CanvasRenderingContext2D, view: View, scene: PlanScene): void {
  const { site, layers } = scene;
  const pen = scene.pen ?? 1;
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, view.width, view.height);

  if (scene.raster) {
    const topLeft = worldToScreen(view, [scene.raster.x0, scene.raster.y0 + scene.raster.heightM]);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = scene.rasterOpacity ?? 1;
    ctx.drawImage(
      scene.raster.canvas,
      topLeft[0],
      topLeft[1],
      scene.raster.widthM * view.scale,
      scene.raster.heightM * view.scale,
    );
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
  }

  if (layers.contours) {
    for (const c of site.contours) {
      if (layers.majorContoursOnly && !c.major) continue;
      strokePolyline(
        ctx,
        view,
        c.line,
        c.major ? 'rgba(146,168,178,0.55)' : 'rgba(120,140,150,0.25)',
        (c.major ? 1 : 0.6) * pen,
      );
    }
  }

  if (layers.zones) {
    for (const zone of site.zones) {
      if (zone.geom.length === 0) continue;
      const selected = zone.id === scene.selectedZoneId;
      const colour = scene.zoneColours?.[zone.id] ?? zoneColour(zone.name);
      fillMulti(
        ctx,
        view,
        zone.geom,
        selected ? `${colour}33` : `${colour}1a`,
        selected ? colour : `${colour}88`,
        (selected ? 2 : 1) * pen,
      );
    }
  }

  if (layers.layout) {
    if (scene.circulation && scene.circulation.length > 0) {
      drawCirculation(ctx, view, scene.circulation, pen, scene.splays);
    }
    for (const layout of scene.layouts) drawLayout(ctx, view, layout, pen);
  }

  if (layers.parcel) fillMulti(ctx, view, site.parcel, undefined, '#e6edf0', 1.6 * pen);

  if (layers.roads || layers.drains) {
    for (const f of site.features) {
      const isRoad = f.layer === 'RD';
      const isDrain = f.layer === 'DR';
      if (isRoad && !layers.roads) continue;
      if (isDrain && !layers.drains) continue;
      if (!isRoad && !isDrain) continue;
      for (const line of f.lines) {
        strokePolyline(
          ctx,
          view,
          line,
          isRoad ? 'rgba(230,180,85,0.85)' : 'rgba(110,190,230,0.8)',
          (isRoad ? 1.2 : 1) * pen,
        );
      }
    }
  }

  if (layers.points) {
    for (const f of site.features) {
      if (!f.point) continue;
      const [x, y] = worldToScreen(view, f.point);
      ctx.beginPath();
      ctx.arc(x, y, 4 * pen, 0, Math.PI * 2);
      ctx.fillStyle = f.layer === 'TBM' ? '#e6b455' : '#9db6e6';
      ctx.fill();
      if (view.scale > 0.35) {
        label(ctx, view, [f.point[0], f.point[1] + (8 * pen) / view.scale], f.layer, '#dfe7ea', undefined, pen);
      }
    }
  }

  if (layers.zoneLabels && view.scale > 0.18) {
    for (const zone of site.zones) {
      if (zone.geom.length === 0) continue;
      const c = multiCentroid(zone.geom);
      const colour = scene.zoneColours?.[zone.id] ?? zoneColour(zone.name);
      const name = scene.zoneLabels?.[zone.id] ?? zone.name;
      label(ctx, view, c, name, colour, '600 11px ui-sans-serif, system-ui, sans-serif', pen);
      label(
        ctx,
        view,
        [c[0], c[1] - (14 * pen) / view.scale],
        `${zone.computedInScopeAc.toFixed(2)} ac`,
        'rgba(223,231,234,0.75)',
        '10px ui-sans-serif, system-ui, sans-serif',
        pen,
      );
    }
  }

  drawEdit(ctx, view, scene, pen);
  drawScaleBar(ctx, view, pen);
  drawNorthArrow(ctx, view, pen);
}

/** The zone edit in progress: picked zones, the cut line, the ring being drawn. */
function drawEdit(ctx: CanvasRenderingContext2D, view: View, scene: PlanScene, pen: number): void {
  const accent = '#6fd3c7';

  if (scene.editSelected && scene.editSelected.length > 0) {
    for (const id of scene.editSelected) {
      const zone = scene.site.zones.find((z) => z.id === id);
      if (zone) fillMulti(ctx, view, zone.geom, 'rgba(111,211,199,0.22)', accent, 2 * pen);
    }
  }

  const pts = scene.editPending;
  if (!pts || pts.length === 0) return;

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = 1.5 * pen;
  ctx.setLineDash([6 * pen, 4 * pen]);

  if (pts.length >= 2) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [x, y] = worldToScreen(view, p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (scene.editTool === 'draw' && pts.length >= 3) ctx.closePath();
    ctx.stroke();
  }

  ctx.setLineDash([]);
  for (const p of pts) {
    const [x, y] = worldToScreen(view, p);
    ctx.beginPath();
    ctx.arc(x, y, 4 * pen, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawScaleBar(ctx: CanvasRenderingContext2D, view: View, scale = 1): void {
  const { metres, px } = niceScaleBar(view, 120 * scale);
  const x = view.width - px - 16 * scale;
  const y = view.height - 48 * scale;
  ctx.strokeStyle = 'rgba(223,231,234,0.85)';
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.moveTo(x, y - 4 * scale);
  ctx.lineTo(x, y + 4 * scale);
  ctx.moveTo(x + px, y - 4 * scale);
  ctx.lineTo(x + px, y + 4 * scale);
  ctx.stroke();
  ctx.fillStyle = 'rgba(223,231,234,0.85)';
  ctx.font = `${11 * scale}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(`${metres} m`, x + px / 2, y - 8 * scale);
}

export function drawNorthArrow(ctx: CanvasRenderingContext2D, view: View, scale = 1): void {
  const x = view.width - 28 * scale;
  const y = 92 * scale;
  ctx.strokeStyle = 'rgba(223,231,234,0.85)';
  ctx.fillStyle = 'rgba(223,231,234,0.85)';
  ctx.lineWidth = 1.5 * scale;
  ctx.beginPath();
  ctx.moveTo(x, y + 18 * scale);
  ctx.lineTo(x, y - 14 * scale);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 20 * scale);
  ctx.lineTo(x - 5 * scale, y - 8 * scale);
  ctx.lineTo(x + 5 * scale, y - 8 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.font = `${11 * scale}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('N', x, y + 30 * scale);
}

export interface TitleBlock {
  title: string;
  subtitle: string;
  rows: [string, string][];
  notes: string[];
}

/** Draws a title block down the right-hand edge of a sheet. */
export function drawTitleBlock(ctx: CanvasRenderingContext2D, width: number, height: number, tb: TitleBlock): number {
  const panelWidth = Math.round(width * 0.22);
  const x = width - panelWidth;
  ctx.fillStyle = '#161d21';
  ctx.fillRect(x, 0, panelWidth, height);
  ctx.strokeStyle = '#2c383e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();

  const pad = Math.round(panelWidth * 0.06);
  let y = pad * 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#dfe7ea';
  ctx.font = `600 ${Math.round(panelWidth * 0.062)}px ui-sans-serif, system-ui, sans-serif`;
  y = wrapText(ctx, tb.title, x + pad, y, panelWidth - pad * 2, Math.round(panelWidth * 0.075));

  ctx.fillStyle = '#8ea0a8';
  ctx.font = `${Math.round(panelWidth * 0.04)}px ui-sans-serif, system-ui, sans-serif`;
  y = wrapText(ctx, tb.subtitle, x + pad, y + pad, panelWidth - pad * 2, Math.round(panelWidth * 0.052)) + pad;

  const rowHeight = Math.round(panelWidth * 0.055);
  for (const [k, v] of tb.rows) {
    ctx.fillStyle = '#8ea0a8';
    ctx.fillText(k, x + pad, y);
    ctx.fillStyle = '#dfe7ea';
    ctx.textAlign = 'right';
    ctx.fillText(v, width - pad, y);
    ctx.textAlign = 'left';
    y += rowHeight;
  }

  y += pad;
  ctx.fillStyle = '#8ea0a8';
  ctx.font = `${Math.round(panelWidth * 0.036)}px ui-sans-serif, system-ui, sans-serif`;
  for (const note of tb.notes) {
    y = wrapText(ctx, note, x + pad, y, panelWidth - pad * 2, Math.round(panelWidth * 0.046)) + pad / 2;
  }
  return panelWidth;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const words = text.split(' ');
  let line = '';
  let cursor = y;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, cursor);
      cursor += lineHeight;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    ctx.fillText(line, x, cursor);
    cursor += lineHeight;
  }
  return cursor;
}
